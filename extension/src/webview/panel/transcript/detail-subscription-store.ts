/**
 * Phase 5 webview page-backed detail subscription store.
 *
 * The webview owns the demand side of the closed subagent detail protocol:
 *
 * - collapsed cards never subscribe (bounded compact preview only);
 * - explicit/auto expansion sends exactly one `detail.subscribe` carrying the
 *   current viewGeneration/detailKey/address;
 * - collapse immediately discards heavy pages/value/measurements and sends
 *   `detail.unsubscribe` (even while the close animation is still running);
 * - re-expansion before the first acknowledgement mints a new owner attempt;
 *   frames bound to a retired subscription are ignored;
 * - baseline pages/deltas/rebases/terminal/error are explicit states, stored
 *   key-scoped so one page/delta re-renders only its expanded subtree;
 * - pages are cached in a bounded global + per-subscription LRU with visible
 *   pinning; evicted ranges are re-fetched through `detail.fetchPages` when
 *   the renderer demands them (the assembled value survives page eviction;
 *   both are dropped on rebase/error/collapse).
 *
 * The complete serialized detail is never retained: pages are the transport
 * cache, and the renderable value is a derived cache assembled lazily.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { applyJsonPatch, isJsonSafeValue, type JsonSafeValue, type JsonStructuralPatchOperation } from '../../../shared/json-structural-patch';
import type {
  DetailChecksum,
  DetailCursor,
  DetailErrorCode,
  DetailPagePayload,
  DetailPageRef,
  LiveSubagentDetailAddress,
} from '../../../shared/protocol/subagent-detail';
import type { HostDetailRoute, LazyDetailRef, WebviewToHostMessage } from '../../../shared/protocol';

// ─── Budgets (test-injectable) ───────────────────────────────────────────────

export const DETAIL_PAGE_LRU_MAX_PAGES = 96;
export const DETAIL_PAGE_LRU_MAX_BYTES = 64 * 1024 * 1024;
export const DETAIL_PER_SUBSCRIPTION_MAX_PAGES = 32;
export const DETAIL_SUBSCRIPTION_TOMBSTONE_MAX = 64;
export const DETAIL_CURSOR_MAX_KEYS = 128;

export interface DetailStoreBudgets {
  maxGlobalPages: number;
  maxGlobalBytes: number;
  maxPagesPerSubscription: number;
}

const DEFAULT_BUDGETS: DetailStoreBudgets = {
  maxGlobalPages: DETAIL_PAGE_LRU_MAX_PAGES,
  maxGlobalBytes: DETAIL_PAGE_LRU_MAX_BYTES,
  maxPagesPerSubscription: DETAIL_PER_SUBSCRIPTION_MAX_PAGES,
};

let budgets: DetailStoreBudgets = { ...DEFAULT_BUDGETS };

export function setDetailStoreBudgets(partial: Partial<DetailStoreBudgets>): void {
  budgets = { ...budgets, ...partial };
}

export function resetDetailStoreBudgets(): void {
  budgets = { ...DEFAULT_BUDGETS };
}

// ─── Store context (set by use-host-sync on every snapshot) ─────────────────

interface DetailStoreContext {
  hostInstanceId: string;
  viewGeneration: number;
  /** Trusted renderer identity learned from the latest state envelope
   *  (browser server plan §5.4): the bound route of every subscription must
   *  carry THIS renderer, so a browser renderer's stream can never settle or
   *  reach another renderer. */
  rendererId: string;
  rendererGeneration: number;
  postMessage?: (message: WebviewToHostMessage) => void;
}

const EMPTY_CONTEXT: DetailStoreContext = { hostInstanceId: '', viewGeneration: 0, rendererId: '', rendererGeneration: 0 };
let context: DetailStoreContext = { ...EMPTY_CONTEXT };

export function getDetailStoreContext(): { hostInstanceId: string; viewGeneration: number; rendererId: string; rendererGeneration: number } {
  return {
    hostInstanceId: context.hostInstanceId,
    viewGeneration: context.viewGeneration,
    rendererId: context.rendererId,
    rendererGeneration: context.rendererGeneration,
  };
}

export function setDetailStoreContext(
  next: {
    hostInstanceId: string;
    viewGeneration: number;
    rendererId: string;
    rendererGeneration: number;
    postMessage: (message: WebviewToHostMessage) => void;
  },
): void {
  const viewChanged = next.viewGeneration !== context.viewGeneration;
  context = { ...next };
  if (viewChanged && records.size > 0) {
    // A view generation change invalidates renderer ownership of every open
    // subscription (normally only happens across a webview reload, which also
    // resets this module — this is defensive).
    for (const record of [...records.values()]) discardRecord(record, false);
    records.clear();
  }
}

// ─── Per-key subscription records ────────────────────────────────────────────

export type DetailSubscriptionPhase = 'subscribing' | 'active' | 'rebasing' | 'terminal' | 'error';

export type DetailSubscriptionStatus =
  | 'idle' // no open subscription for this key
  | 'subscribing' // subscribe sent; awaiting detail.start
  | 'loading' // start received; baseline pages/value not ready
  | 'active' // renderable value ready (live)
  | 'rebasing' // baseline discarded; re-subscribing
  | 'terminal' // durable terminal handoff; value (if any) is exact/durable
  | 'error';

export interface DetailSubscriptionError {
  code: DetailErrorCode;
  message: string;
  retryable: boolean;
}

export interface DetailSubscriptionHandle {
  status: DetailSubscriptionStatus;
  /** Renderable canonical child record (assembled from pages + deltas), when
   *  the status is `active` or `terminal`. Never the concatenated serialized
   *  detail. */
  value: unknown;
  error: DetailSubscriptionError | null;
  durableRef: LazyDetailRef | null;
  retry: () => void;
}

interface StoredDetailPage {
  ref: DetailPageRef;
  payload: DetailPagePayload;
  payloadBytes: number;
  checksum: DetailChecksum;
}

interface DetailSubscriptionRecord {
  detailKey: string;
  viewGeneration: number;
  address: LiveSubagentDetailAddress;
  attempt: number;
  phase: DetailSubscriptionPhase;
  /** Bound on the first `detail.start`; every later imperative must match. */
  route: HostDetailRoute | null;
  baselineRevision: number;
  pageCount: number;
  totalBytes: number;
  totalCodePoints: number;
  revision: number;
  /** Page indexes currently cached in the global LRU. */
  pageIndexes: Set<number>;
  /** Page indexes evicted before assembly (or never delivered). */
  missingIndexes: Set<number>;
  /** Page indexes rejected on delivery (checksum/byte validation). */
  corruptIndexes: Set<number>;
  /** Derived renderable value; dropped on eviction pressure/rebase/error. */
  value: unknown;
  valueBytes: number;
  error: DetailSubscriptionError | null;
  durableRef: LazyDetailRef | null;
  visible: boolean;
}

const records = new Map<string, DetailSubscriptionRecord>();
/** Global page LRU. Map insertion order IS the recency order: touching a page
 *  deletes + re-inserts it. */
const pages = new Map<string, StoredDetailPage>();
/** Subscription ids retired by this webview (rebase/replace/collapse). A
 *  `detail.start` bound to a retired id can never bind a new attempt. */
const tombstonedSubscriptionIds = new Set<string>();
/** Cheap per-key cursor metadata that survives collapse (re-expansion sends it
 *  back with the next subscribe). Never holds pages or values. */
const cursorByKey = new Map<string, DetailCursor>();
const subscribersByKey = new Map<string, Set<() => void>>();
/** In-flight page refetch keys (`detail.fetchPages` already sent). */
const fetchInFlight = new Set<string>();

function pageKey(detailKey: string, baselineRevision: number, pageIndex: number): string {
  return `${detailKey}\u0000${baselineRevision}\u0000${pageIndex}`;
}

function sameAddress(left: LiveSubagentDetailAddress, right: LiveSubagentDetailAddress): boolean {
  return left.sessionPath === right.sessionPath
    && left.turnId === right.turnId
    && left.rootToolCallId === right.rootToolCallId
    && left.rootAttemptId === right.rootAttemptId
    && left.lineage.length === right.lineage.length
    && left.lineage.every((identity, index) => {
      const expected = right.lineage[index];
      return expected !== undefined
        && identity.childId === expected.childId
        && identity.spawningToolCallId === expected.spawningToolCallId
        && identity.attemptId === expected.attemptId;
    });
}

function cloneAddress(address: LiveSubagentDetailAddress): LiveSubagentDetailAddress {
  return { ...address, lineage: address.lineage.map((identity) => ({ ...identity })) };
}

function notifyKey(detailKey: string): void {
  for (const subscriber of subscribersByKey.get(detailKey) ?? []) subscriber();
}

function touchRecord(record: DetailSubscriptionRecord): void {
  records.delete(record.detailKey);
  records.set(record.detailKey, record);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function openDetailSubscription(options: {
  detailKey: string;
  address: LiveSubagentDetailAddress;
  cursor?: DetailCursor;
}): void {
  if (!context.postMessage) return;
  if (context.viewGeneration === 0) return; // no snapshot yet; the hook retries
  const { detailKey, address } = options;
  const existing = records.get(detailKey);
  if (existing) {
    if (existing.viewGeneration === context.viewGeneration
      && (existing.phase === 'subscribing' || existing.phase === 'active'
        || (existing.phase === 'terminal' && existing.value !== null))
      && sameAddress(existing.address, address)) {
      touchRecord(existing);
      return; // idempotent re-expansion of the same owner
    }
    // Address changed, the view generation advanced, or the owner is
    // rebasing/errored: replace it. The retired subscription id can never
    // bind the fresh attempt.
    retireAndDiscard(existing);
  }
  const record: DetailSubscriptionRecord = {
    detailKey,
    viewGeneration: context.viewGeneration,
    address: cloneAddress(address),
    attempt: (existing?.attempt ?? 0) + 1,
    phase: 'subscribing',
    route: null,
    baselineRevision: 0,
    pageCount: 0,
    totalBytes: 0,
    totalCodePoints: 0,
    revision: 0,
    pageIndexes: new Set(),
    missingIndexes: new Set(),
    corruptIndexes: new Set(),
    value: null,
    valueBytes: 0,
    error: null,
    durableRef: null,
    visible: true,
  };
  records.set(detailKey, record);
  const cursor = options.cursor ?? cursorByKey.get(detailKey);
  context.postMessage({
    type: 'detail.subscribe',
    viewGeneration: record.viewGeneration,
    detailKey,
    address: cloneAddress(address),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  notifyKey(detailKey);
}

export function closeDetailSubscription(detailKey: string, reason: 'collapse' | 'unmount' | 'session-change'): void {
  const record = records.get(detailKey);
  const hadRecord = record !== undefined;
  if (record) {
    retireAndDiscard(record);
    records.delete(detailKey);
  }
  if (hadRecord && context.postMessage) {
    // The owner was created under the record's view generation; a later
    // generation would not find it host-side. Posting only when a record
    // existed keeps close idempotent (collapse + unmount both fire).
    context.postMessage({
      type: 'detail.unsubscribe',
      viewGeneration: record?.viewGeneration ?? context.viewGeneration,
      detailKey,
      reason,
    });
  }
  notifyKey(detailKey);
}

export function setDetailVisible(detailKey: string, visible: boolean): void {
  const record = records.get(detailKey);
  if (!record || record.visible === visible) return;
  record.visible = visible;
  touchRecord(record);
}

/** Host/backend restart (hostChanged): drop every subscription, page, value,
 *  tombstone, and cursor. Late frames can never recreate UI. */
export function clearDetailSubscriptionStore(): void {
  for (const record of [...records.values()]) discardRecord(record, false);
  records.clear();
  pages.clear();
  tombstonedSubscriptionIds.clear();
  cursorByKey.clear();
  fetchInFlight.clear();
  notifyAll();
}

export function getDetailStoreDebugState(): {
  records: number;
  pages: number;
  pageBytes: number;
  valueBytes: number;
  tombstones: number;
  cursors: number;
} {
  let pageBytes = 0;
  for (const page of pages.values()) pageBytes += page.payloadBytes;
  let valueBytes = 0;
  for (const record of records.values()) valueBytes += record.valueBytes;
  return {
    records: records.size,
    pages: pages.size,
    pageBytes,
    valueBytes,
    tombstones: tombstonedSubscriptionIds.size,
    cursors: cursorByKey.size,
  };
}

// ─── Imperative stream handling ──────────────────────────────────────────────

export type DetailStreamMessage = HostDetailRoute & (
  | { type: 'detail.start'; address: LiveSubagentDetailAddress; source: 'live' | 'durable'; baselineRevision: number; pageCount: number; totalBytes: number; totalCodePoints: number }
  | { type: 'detail.page'; ref: DetailPageRef; payload: DetailPagePayload; payloadBytes: number; checksum: DetailChecksum }
  | { type: 'detail.delta'; baseRevision: number; revision: number; operations: JsonStructuralPatchOperation[] }
  | { type: 'detail.rebase'; currentRevision: number; reason: string }
  | { type: 'detail.terminal'; revision: number; durableRef: LazyDetailRef }
  | { type: 'detail.error'; code: DetailErrorCode; message: string; retryable: boolean }
);

export function receiveDetailImperative(message: DetailStreamMessage): void {
  const record = records.get(message.detailKey);
  if (!record) return; // unknown or already-collapsed key
  if (record.viewGeneration !== message.viewGeneration) return;
  if (context.hostInstanceId && message.hostInstanceId !== context.hostInstanceId) return;
  // A `detail.start` binds the owner; stream content (page/delta/rebase/
  // terminal) must match the bound route exactly. `detail.error` may arrive
  // before the start (subscribe rejection): its case checks the tombstone
  // set and the bound route when one exists.
  if (message.type !== 'detail.start' && message.type !== 'detail.error') {
    if (!record.route) return;
    if (!routeMatches(record.route, message)) return;
  }
  switch (message.type) {
    case 'detail.start': {
      if (record.phase !== 'subscribing') return;
      if (tombstonedSubscriptionIds.has(message.subscriptionId)) return;
      if (!sameAddress(record.address, message.address)) return;
      if (message.baselineRevision < record.revision) return;
      record.phase = 'active';
      record.route = {
        hostInstanceId: message.hostInstanceId,
        hostGeneration: message.hostGeneration,
        viewGeneration: message.viewGeneration,
        rendererId: message.rendererId,
        rendererGeneration: message.rendererGeneration,
        backendGeneration: message.backendGeneration,
        coordinatorGeneration: message.coordinatorGeneration,
        ...(message.workerId !== undefined && message.workerGeneration !== undefined
          ? { workerId: message.workerId, workerGeneration: message.workerGeneration }
          : {}),
        detailKey: message.detailKey,
        subscriptionId: message.subscriptionId,
      };
      record.baselineRevision = message.baselineRevision;
      record.pageCount = message.pageCount;
      record.totalBytes = message.totalBytes;
      record.totalCodePoints = message.totalCodePoints;
      record.revision = message.baselineRevision;
      record.error = null;
      // A fresh baseline invalidates any pages of a previous baseline.
      discardPages(record);
      record.missingIndexes.clear();
      record.corruptIndexes.clear();
      record.value = null;
      record.valueBytes = 0;
      recordCursor(record, message.baselineRevision);
      touchRecord(record);
      notifyKey(record.detailKey);
      return;
    }
    case 'detail.page': {
      if (record.phase !== 'active' && record.phase !== 'terminal') return;
      const { ref, payload, payloadBytes, checksum } = message;
      if (ref.baselineRevision !== record.baselineRevision
        || ref.pageCount !== record.pageCount
        || ref.pageIndex >= record.pageCount) return;
      const serializedPayload = JSON.stringify(payload);
      if (payloadBytes !== utf8Bytes(serializedPayload)) {
        record.corruptIndexes.add(ref.pageIndex);
        return;
      }
      if (checksum !== sha256Hex(serializedPayload)) {
        record.corruptIndexes.add(ref.pageIndex);
        return;
      }
      const key = pageKey(record.detailKey, ref.baselineRevision, ref.pageIndex);
      pages.set(key, { ref, payload, payloadBytes, checksum });
      record.pageIndexes.add(ref.pageIndex);
      record.missingIndexes.delete(ref.pageIndex);
      fetchInFlight.delete(key);
      touchRecord(record);
      enforceBounds();
      notifyKey(record.detailKey);
      return;
    }
    case 'detail.delta': {
      if (record.phase !== 'active') return;
      if (message.baseRevision !== record.revision) {
        startRebase(record, 'gap', true);
        return;
      }
      if (!record.value) {
        // Deltas arrive strictly after the baseline pages (FIFO transport).
        // If the value was never assembled (eviction), a fresh baseline is
        // cheaper than replaying the delta against reassembled pages.
        startRebase(record, 'gap', true);
        return;
      }
      const applied = applyJsonPatch(record.value as JsonSafeValue, message.operations);
      if (!applied.ok) {
        startRebase(record, 'gap', true);
        return;
      }
      record.value = applied.value;
      record.revision = message.revision;
      touchRecord(record);
      notifyKey(record.detailKey);
      return;
    }
    case 'detail.rebase': {
      if (record.phase !== 'active') return;
      startRebase(record, 'rebase', true);
      return;
    }
    case 'detail.terminal': {
      if (record.phase !== 'active') return;
      record.phase = 'terminal';
      record.durableRef = message.durableRef;
      record.revision = message.revision;
      recordCursor(record, message.revision);
      touchRecord(record);
      if (record.value === null && !ensureRecordValue(record)) {
        // The live baseline never assembled (page eviction pressure or lost
        // pages). The terminal owner is closed host-side, so page refetch is
        // impossible; re-subscribe and let the host answer from the durable
        // transcript.
        retireAndDiscard(record);
        openDetailSubscription({ detailKey: record.detailKey, address: record.address });
        return;
      }
      notifyKey(record.detailKey);
      return;
    }
    case 'detail.error': {
      if (record.phase === 'error' || record.phase === 'terminal') return;
      if (tombstonedSubscriptionIds.has(message.subscriptionId)) return;
      if (record.route && message.subscriptionId !== record.route.subscriptionId) return;
      record.phase = 'error';
      record.error = { code: message.code, message: message.message, retryable: message.retryable };
      retireAndDiscard(record);
      touchRecord(record);
      notifyKey(record.detailKey);
      return;
    }
  }
}

function routeMatches(route: HostDetailRoute, message: HostDetailRoute): boolean {
  return route.subscriptionId === message.subscriptionId
    && route.hostGeneration === message.hostGeneration
    && route.rendererId === message.rendererId
    && route.rendererGeneration === message.rendererGeneration
    && route.backendGeneration === message.backendGeneration
    && route.coordinatorGeneration === message.coordinatorGeneration
    && route.workerId === message.workerId
    && route.workerGeneration === message.workerGeneration;
}

function startRebase(record: DetailSubscriptionRecord, reason: string, notify: boolean): void {
  retireAndDiscard(record);
  record.phase = 'rebasing';
  touchRecord(record);
  if (notify) notifyKey(record.detailKey);
  openDetailSubscription({ detailKey: record.detailKey, address: record.address });
}

/** Assemble the record's value without dispatching fetches or rebasing. */
function ensureRecordValue(record: DetailSubscriptionRecord): boolean {
  if (record.value !== null) return true;
  if (record.missingIndexes.size > 0 || record.corruptIndexes.size > 0) return false;
  if (record.pageIndexes.size < record.pageCount) return false;
  const value = assembleRecordValue(record);
  if (value === undefined) return false;
  record.value = value;
  record.valueBytes = record.totalBytes;
  return true;
}

function retireAndDiscard(record: DetailSubscriptionRecord): void {
  if (record.route) tombstoneSubscriptionId(record.route.subscriptionId);
  record.route = null;
  discardPages(record);
  discardValue(record);
}

function discardPages(record: DetailSubscriptionRecord): void {
  for (const index of record.pageIndexes) {
    pages.delete(pageKey(record.detailKey, record.baselineRevision, index));
  }
  record.pageIndexes.clear();
  record.missingIndexes.clear();
  record.corruptIndexes.clear();
}

function discardValue(record: DetailSubscriptionRecord): void {
  record.value = null;
  record.valueBytes = 0;
}

function discardRecord(record: DetailSubscriptionRecord, tombstone: boolean): void {
  if (tombstone && record.route) tombstoneSubscriptionId(record.route.subscriptionId);
  discardPages(record);
  discardValue(record);
}

function tombstoneSubscriptionId(subscriptionId: string): void {
  tombstonedSubscriptionIds.add(subscriptionId);
  if (tombstonedSubscriptionIds.size > DETAIL_SUBSCRIPTION_TOMBSTONE_MAX) {
    const oldest = tombstonedSubscriptionIds.values().next().value;
    if (oldest !== undefined) tombstonedSubscriptionIds.delete(oldest);
  }
}

function recordCursor(record: DetailSubscriptionRecord, revision: number): void {
  cursorByKey.set(record.detailKey, { revision });
  if (cursorByKey.size > DETAIL_CURSOR_MAX_KEYS) {
    const oldest = cursorByKey.keys().next().value;
    if (oldest !== undefined) cursorByKey.delete(oldest);
  }
}

// ─── Bounded page LRU with visible pinning ──────────────────────────────────

function totalPageBytes(): number {
  let total = 0;
  for (const page of pages.values()) total += page.payloadBytes;
  return total;
}

/** Enforce the global and per-subscription page bounds. Eviction order:
 *  1. pages of non-visible records (never needed — collapse discards them);
 *  2. pages of visible records whose value is already assembled (pages are
 *     only the transport cache then);
 *  3. pages of visible records still assembling (needed for the value; only
 *     evicted under hard pressure, then re-fetched on demand).
 * Within each class the oldest page (Map head) is evicted first. Values count
 * toward the global byte budget and are dropped (oldest record first) only
 * when no page eviction can satisfy it. */
function enforceBounds(): void {
  let evicted = true;
  while (evicted) {
    evicted = false;
    if (pages.size > budgets.maxGlobalPages || totalPageBytes() > budgets.maxGlobalBytes) {
      const victimKey = findEvictionVictim(null);
      if (victimKey !== undefined) {
        evictPage(victimKey);
        evicted = true;
        continue;
      }
    }
    for (const record of records.values()) {
      if (record.pageIndexes.size <= budgets.maxPagesPerSubscription) continue;
      const victimKey = findEvictionVictim(record.detailKey);
      if (victimKey !== undefined) {
        evictPage(victimKey);
        evicted = true;
        break;
      }
    }
  }
  let valueBytes = 0;
  for (const record of records.values()) valueBytes += record.valueBytes;
  while (pages.size + records.size > 0 && totalPageBytes() + valueBytes > budgets.maxGlobalBytes) {
    const victimKey = findEvictionVictim(null);
    if (victimKey === undefined) break;
    evictPage(victimKey);
  }
}

function findEvictionVictim(onlyDetailKey: string | null): string | undefined {
  // Classes 1–2 win on the first (oldest) match; class 3 (visible, still
  // assembling) is the fallback under hard pressure.
  let assemblingFallback: string | undefined;
  for (const key of pages.keys()) {
    if (onlyDetailKey !== null && !key.startsWith(`${onlyDetailKey}\u0000`)) continue;
    const record = records.get(recordKeyOfPageKey(key));
    if (!record) return key;
    if (!record.visible) return key;
    if (record.value !== null) return key;
    if (assemblingFallback === undefined) assemblingFallback = key;
  }
  return assemblingFallback;
}

function recordKeyOfPageKey(key: string): string {
  const firstSeparator = key.indexOf('\u0000');
  return firstSeparator === -1 ? key : key.slice(0, firstSeparator);
}

function evictPage(key: string): void {
  const page = pages.get(key);
  if (!page) return;
  pages.delete(key);
  const record = records.get(recordKeyOfPageKey(key));
  if (!record) return;
  record.pageIndexes.delete(page.ref.pageIndex);
  record.missingIndexes.add(page.ref.pageIndex);
  // The assembled value stays the render source while the record lives;
  // evicted pages are only needed again after a rebase invalidates it. For
  // records still assembling, the next value demand refetches the page.
}

// ─── Value assembly (never retained as serialized text) ─────────────────────

export function resolveDetailTarget(
  value: unknown,
  address: LiveSubagentDetailAddress,
): Record<string, unknown> | undefined {
  const found = findAddressableTarget(value, address);
  if (found) return found;
  if (isDirectChildRecord(value, address)) return value as Record<string, unknown>;
  return undefined;
}

function isDirectChildRecord(value: unknown, address: LiveSubagentDetailAddress): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.agent !== 'string' || !Array.isArray(record.messages)) return false;
  return sameLineage(record.lineage, address.lineage);
}

function findAddressableTarget(root: unknown, address: LiveSubagentDetailAddress): Record<string, unknown> | undefined {
  const stack: unknown[] = [root];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0 && nodes < 250_000) {
    const value = stack.pop();
    nodes += 1;
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.liveAddressable === true && sameLineage(record.lineage, address.lineage)) return record;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return undefined;
}

function sameLineage(value: unknown, expected: LiveSubagentDetailAddress['lineage']): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const actual = entry as Record<string, unknown>;
    const identity = expected[index];
    if (!identity) return false;
    return actual.childId === identity.childId
      && actual.spawningToolCallId === identity.spawningToolCallId
      && actual.attemptId === identity.attemptId;
  });
}

/** Assemble + validate the complete baseline (contiguity, byte ranges,
 *  checksums, total bytes), JSON-parse it, and canonicalize the addressable
 *  child record. Returns `undefined` on any validation failure. */
function assembleRecordValue(record: DetailSubscriptionRecord): unknown {
  const chunks: string[] = [];
  let nextByte = 0;
  let nextCodePoint = 0;
  let lastPage: StoredDetailPage | undefined;
  for (let index = 0; index < record.pageCount; index += 1) {
    const page = pages.get(pageKey(record.detailKey, record.baselineRevision, index));
    if (!page) return undefined;
    lastPage = page;
    if (page.ref.pageIndex !== index || page.ref.pageCount !== record.pageCount
      || page.payload.startByte !== nextByte
      || page.payload.startCodePoint !== nextCodePoint
      || page.payload.totalBytes !== record.totalBytes
      || page.payload.totalCodePoints !== record.totalCodePoints) {
      return undefined;
    }
    const serializedPayload = JSON.stringify(page.payload);
    if (page.payloadBytes !== utf8Bytes(serializedPayload)
      || page.checksum !== sha256Hex(serializedPayload)) {
      return undefined;
    }
    chunks.push(page.payload.text);
    nextByte = page.payload.endByte;
    nextCodePoint = page.payload.endCodePoint;
  }
  const text = chunks.join('');
  if (nextByte !== record.totalBytes || utf8Bytes(text) !== record.totalBytes
    || nextCodePoint !== [...text].length
    || lastPage === undefined
    || lastPage.payload.endByte !== lastPage.payload.totalBytes
    || lastPage.payload.endCodePoint !== lastPage.payload.totalCodePoints) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonSafeValue(parsed)) return undefined;
  const target = resolveDetailTarget(parsed, record.address);
  if (!target) return undefined;
  record.valueBytes = record.totalBytes;
  return target;
}

/** Render-time value demand. Assembles when all pages are present; otherwise
 *  dispatches `detail.fetchPages` for evicted pages (deduplicated) and
 *  returns `undefined` (the renderer shows the explicit loading state). */
export function demandDetailValue(detailKey: string): { status: 'ready'; value: unknown } | { status: 'pending' } {
  const record = records.get(detailKey);
  if (!record) return { status: 'pending' };
  if (record.value !== null) return { status: 'ready', value: record.value };
  if (record.phase !== 'active') return { status: 'pending' };
  if (record.missingIndexes.size > 0) {
    dispatchMissingPageFetches(record);
    return { status: 'pending' };
  }
  if (record.corruptIndexes.size > 0) {
    // Delivered pages failed validation: the stream itself is corrupt and
    // cannot be repaired by refetching individual pages.
    startRebase(record, 'gap', false);
    return { status: 'pending' };
  }
  if (record.pageIndexes.size < record.pageCount) {
    // Baseline still in transport (no eviction, no corruption).
    return { status: 'pending' };
  }
  const value = assembleRecordValue(record);
  if (value === undefined) {
    // The assembled baseline failed contiguity/checksum validation. The demand
    // runs inside the hook's render: the phase change is visible to the
    // current render, so no extra notification is needed.
    startRebase(record, 'gap', false);
    return { status: 'pending' };
  }
  record.value = value;
  touchRecord(record);
  enforceBounds();
  return { status: 'ready', value };
}

function dispatchMissingPageFetches(record: DetailSubscriptionRecord): void {
  if (!context.postMessage || record.phase !== 'active') return;
  for (const pageIndex of record.missingIndexes) {
    const key = pageKey(record.detailKey, record.baselineRevision, pageIndex);
    if (fetchInFlight.has(key)) continue;
    if (fetchInFlight.size >= budgets.maxGlobalPages * 4) break;
    fetchInFlight.add(key);
    context.postMessage({
      type: 'detail.fetchPages',
      viewGeneration: record.viewGeneration,
      detailKey: record.detailKey,
      ref: { baselineRevision: record.baselineRevision, pageIndex, pageCount: record.pageCount },
    });
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useDetailSubscription(options: {
  detailKey: string;
  address: LiveSubagentDetailAddress | undefined;
  expanded: boolean;
}): DetailSubscriptionHandle {
  const [, setVersion] = useState(0);
  const contextViewGeneration = context.viewGeneration;
  const addressKey = options.address ? JSON.stringify(options.address) : undefined;
  const detailKey = options.detailKey;

  useEffect(() => {
    if (options.expanded && options.address && contextViewGeneration > 0) {
      openDetailSubscription({ detailKey, address: options.address });
    } else if (!options.expanded) {
      closeDetailSubscription(detailKey, 'collapse');
    }
  }, [options.expanded, detailKey, addressKey, contextViewGeneration]);

  useEffect(() => {
    setDetailVisible(detailKey, options.expanded && !!options.address);
  }, [options.expanded, detailKey, addressKey]);

  useEffect(() => {
    const subscriber = () => setVersion((value) => value + 1);
    const subscribers = subscribersByKey.get(detailKey) ?? new Set<() => void>();
    subscribers.add(subscriber);
    subscribersByKey.set(detailKey, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) subscribersByKey.delete(detailKey);
    };
  }, [detailKey]);

  // Unmount (virtualization eviction, session switch, close-animation end):
  // discard the heavy key store and notify the host. Idempotent when the
  // collapse path already closed the subscription.
  useEffect(() => () => {
    closeDetailSubscription(detailKey, 'unmount');
  }, [detailKey]);

  // Retry after an explicit error: the host dropped the errored owner, so a
  // fresh subscribe mints a new owner and a new subscription id. If the key
  // became terminal in the meantime, the host answers from the durable
  // transcript.
  const addressRef = useRef(options.address);
  addressRef.current = options.address;
  const retry = useCallback(() => {
    if (contextViewGeneration === 0) return;
    const address = addressRef.current;
    if (!address) return;
    openDetailSubscription({ detailKey, address });
  }, [detailKey, addressKey, contextViewGeneration]);

  const record = records.get(detailKey);
  let status: DetailSubscriptionStatus = 'idle';
  let value: unknown = null;
  let error: DetailSubscriptionError | null = null;
  let durableRef: LazyDetailRef | null = null;
  if (record) {
    if (record.phase === 'subscribing') status = 'subscribing';
    else if (record.phase === 'rebasing') status = 'rebasing';
    else if (record.phase === 'error') {
      status = 'error';
      error = record.error;
    } else if (record.phase === 'terminal') {
      durableRef = record.durableRef;
      if (record.value !== null) {
        status = 'terminal';
        value = record.value;
      } else {
        status = 'loading';
      }
    } else {
      // active
      const demanded = demandDetailValue(detailKey);
      if (demanded.status === 'ready') {
        status = 'active';
        value = demanded.value;
      } else {
        status = 'loading';
      }
    }
  }

  return { status, value, error, durableRef, retry };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function notifyAll(): void {
  for (const subscribers of subscribersByKey.values()) {
    for (const subscriber of subscribers) subscriber();
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Synchronous FIPS-180-4 SHA-256 (dependency-free; the webview cannot import
 *  node:crypto). Used to verify detail page checksums before a baseline is
 *  committed. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 8) >> 6 << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotateRight = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotateRight(w[t - 15]!, 7) ^ rotateRight(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotateRight(w[t - 2]!, 17) ^ rotateRight(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[t]! + w[t]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  return H.map((word) => word.toString(16).padStart(8, '0')).join('');
}
