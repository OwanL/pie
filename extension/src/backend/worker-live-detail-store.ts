import { createHash } from 'node:crypto';

import { diffJsonValues, isJsonSafeValue, type JsonSafeValue } from '../shared/json-structural-patch.js';
import {
  isLiveSubagentDetailAddress,
  type DetailCursor,
  type DetailPageRef,
  type LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import {
  MIN_DETAIL_PAGE_BYTES,
  reassembleDetailPages as reassembleDetailPagesShared,
  segmentDetailPages as segmentDetailPagesShared,
  type DetailSegmentPage,
} from '../shared/detail-segmentation.js';
import type { LazyDetailRef } from '../shared/protocol/messages.js';
import type { WorkerToCoordinatorFrameBody } from './worker-protocol.js';

export const DEFAULT_LIVE_DETAIL_PAGE_BYTES = 128 * 1024;
export const MIN_LIVE_DETAIL_PAGE_BYTES = 512;
export const MAX_LIVE_DETAIL_PAGE_BYTES = 192 * 1024;

export interface WorkerLiveDetailStoreBudgets {
  maxSources: number;
  maxSubscriptions: number;
  maxCanonicalBytes: number;
  maxDeltaBytes: number;
  maxPageBytes: number;
}

export const DEFAULT_WORKER_LIVE_DETAIL_BUDGETS: WorkerLiveDetailStoreBudgets = {
  maxSources: 128,
  maxSubscriptions: 32,
  maxCanonicalBytes: 16 * 1024 * 1024,
  maxDeltaBytes: 256 * 1024,
  maxPageBytes: MAX_LIVE_DETAIL_PAGE_BYTES,
};

type DetailStreamBody = Extract<WorkerToCoordinatorFrameBody, {
  kind: 'detail.start' | 'detail.page' | 'detail.delta' | 'detail.rebase' | 'detail.terminal' | 'detail.error' | 'detail.unsubscribed';
}>;

export interface WorkerLiveDetailStoreOptions {
  emit(frame: DetailStreamBody): boolean;
  budgets?: Partial<WorkerLiveDetailStoreBudgets>;
}

export interface LiveDetailRootObservation {
  sessionPath: string;
  turnId: string;
  rootToolCallId: string;
  rootAttemptId: string;
  details: unknown;
}

interface SourceRecord extends Omit<LiveDetailRootObservation, 'details'> {
  details: unknown;
  revision: number;
  observedAt: number;
}

interface SubscriptionRecord {
  subscriptionId: string;
  address: LiveSubagentDetailAddress;
  rootKey: string;
  revision: number;
  maxPageBytes: number;
  canonical?: JsonSafeValue;
  canonicalBytes: number;
  totalBytes: number;
  sourceFingerprint?: string;
  needsRebase: boolean;
  touchedAt: number;
}

interface CanonicalDetail {
  value: JsonSafeValue;
  serialized: string;
  bytes: number;
  fingerprint?: string;
}

export type DetailBaselinePage = DetailSegmentPage;

/**
 * Worker-owned demand-driven canonical store. Source updates are retained only
 * as bounded references until an explicit subscription exists; with zero
 * subscribers it performs no recursive traversal, normalization, diff, page,
 * checksum, or stream work.
 */
export class WorkerLiveDetailStore {
  private readonly budgets: WorkerLiveDetailStoreBudgets;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private canonicalBytes = 0;

  constructor(private readonly options: WorkerLiveDetailStoreOptions) {
    this.budgets = validateBudgets({ ...DEFAULT_WORKER_LIVE_DETAIL_BUDGETS, ...options.budgets });
  }

  observe(observation: LiveDetailRootObservation): void {
    const key = rootKey(observation);
    const previous = this.sources.get(key);
    const source: SourceRecord = {
      ...observation,
      revision: (previous?.revision ?? 0) + 1,
      observedAt: Date.now(),
    };
    this.sources.delete(key);
    this.sources.set(key, source);
    this.evictSources();

    // This loop is empty in the collapsed/no-subscriber case. Importantly, the
    // raw recursive object above has not been inspected or serialized.
    for (const subscription of this.subscriptions.values()) {
      if (subscription.rootKey !== key || subscription.needsRebase) continue;
      this.updateSubscription(subscription, source);
    }
  }

  subscribe(
    requestId: string,
    subscriptionId: string,
    address: LiveSubagentDetailAddress,
    cursor: DetailCursor | undefined,
    requestedPageBytes: number,
  ): void {
    if (!isLiveSubagentDetailAddress(address)) {
      this.error(requestId, subscriptionId, 'INVALID_ADDRESS', 'The detail address is invalid.', false);
      return;
    }
    if (this.subscriptions.has(subscriptionId)) {
      this.error(requestId, subscriptionId, 'SUBSCRIPTION_CONFLICT', 'The subscription identity is already owned.', false);
      return;
    }
    if (this.subscriptions.size >= this.budgets.maxSubscriptions) {
      this.error(requestId, subscriptionId, 'UNAVAILABLE', 'The worker detail subscription budget is full.', true);
      return;
    }
    const key = rootKey(address);
    const source = this.sources.get(key);
    if (!source) {
      this.error(requestId, subscriptionId, 'NOT_FOUND', 'No live detail source owns this address.', true);
      return;
    }
    if (cursor && cursor.revision > source.revision) {
      this.error(requestId, subscriptionId, 'STALE_CURSOR', 'The cursor is ahead of the worker detail revision.', true);
      return;
    }
    const canonical = canonicalizeTarget(source.details, address);
    if (!canonical) {
      this.error(requestId, subscriptionId, 'NOT_LIVE_ADDRESSABLE', 'The producer identity does not resolve to live detail.', false);
      return;
    }
    const maxPageBytes = clampPageBytes(requestedPageBytes, this.budgets.maxPageBytes);
    const subscription: SubscriptionRecord = {
      subscriptionId,
      address: cloneAddress(address),
      rootKey: key,
      revision: source.revision,
      maxPageBytes,
      canonicalBytes: 0,
      totalBytes: canonical.bytes,
      sourceFingerprint: canonical.fingerprint,
      needsRebase: false,
      touchedAt: Date.now(),
    };
    this.subscriptions.set(subscriptionId, subscription);
    this.retainCanonical(subscription, canonical);
    const pages = segmentCanonicalDetail(canonical.serialized, source.revision, address, maxPageBytes);
    if (!this.options.emit({
      kind: 'detail.start', requestId, subscriptionId, address: cloneAddress(address), source: 'live',
      baselineRevision: source.revision, pageCount: pages.length, totalBytes: canonical.bytes,
    })) {
      this.dropSubscription(subscriptionId);
      return;
    }
    for (const page of pages) {
      if (!this.options.emit({ kind: 'detail.page', subscriptionId, ...page })) {
        this.requireRebase(subscription, source.revision, 'backpressure');
        break;
      }
    }
  }

  unsubscribe(requestId: string, subscriptionId: string): void {
    this.dropSubscription(subscriptionId);
    this.options.emit({ kind: 'detail.unsubscribed', requestId, subscriptionId });
  }

  fetch(
    requestId: string,
    subscriptionId: string,
    address: LiveSubagentDetailAddress,
    ref: DetailPageRef,
    requestedPageBytes: number,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || !sameAddress(subscription.address, address)) {
      this.error(requestId, subscriptionId, 'SUBSCRIPTION_CONFLICT', 'The detail page owner does not match this subscription.', false);
      return;
    }
    const source = this.sources.get(subscription.rootKey);
    if (!source) {
      this.requireRebase(subscription, subscription.revision, 'evicted');
      return;
    }
    if (source.revision !== ref.baselineRevision || subscription.revision !== ref.baselineRevision) {
      this.requireRebase(subscription, source.revision, 'gap');
      return;
    }
    const canonical = canonicalizeTarget(source.details, address);
    if (!canonical) {
      this.error(requestId, subscriptionId, 'NOT_FOUND', 'The detail page source no longer exists.', true);
      return;
    }
    const pageBytes = clampPageBytes(requestedPageBytes, Math.min(subscription.maxPageBytes, this.budgets.maxPageBytes));
    const pages = segmentCanonicalDetail(canonical.serialized, source.revision, address, pageBytes);
    if (ref.pageCount !== pages.length || ref.pageIndex >= pages.length) {
      this.requireRebase(subscription, source.revision, 'gap');
      return;
    }
    this.options.emit({ kind: 'detail.page', requestId, subscriptionId, ...pages[ref.pageIndex]! });
  }

  terminal(root: Omit<LiveDetailRootObservation, 'details'>, durableEntryId: string): void {
    const key = rootKey(root);
    const source = this.sources.get(key);
    const revision = source?.revision ?? 0;
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.rootKey !== key) continue;
      const durableRef: LazyDetailRef = {
        key: `durable:subagent:${root.sessionPath}:${durableEntryId}:${root.rootToolCallId}`,
        kind: 'tool-result',
        source: 'durable',
        sessionPath: root.sessionPath,
        messageId: durableEntryId,
        toolCallId: root.rootToolCallId,
        sourceRevision: revision,
        sizeBytes: subscription.totalBytes,
        summary: `Subagent detail (${subscription.address.lineage.length} lineage levels)`,
        childCount: 1,
        available: true,
      };
      this.options.emit({ kind: 'detail.terminal', subscriptionId: subscription.subscriptionId, revision, durableRef });
      this.dropSubscription(subscription.subscriptionId);
    }
    this.sources.delete(key);
  }

  dispose(): void {
    this.sources.clear();
    this.subscriptions.clear();
    this.canonicalBytes = 0;
  }

  debugState(): { sources: number; subscriptions: number; canonicalBytes: number } {
    return { sources: this.sources.size, subscriptions: this.subscriptions.size, canonicalBytes: this.canonicalBytes };
  }

  private updateSubscription(subscription: SubscriptionRecord, source: SourceRecord): void {
    const canonical = canonicalizeTarget(source.details, subscription.address);
    if (!canonical) {
      this.error(undefined, subscription.subscriptionId, 'NOT_FOUND', 'The live detail target disappeared.', true);
      this.dropSubscription(subscription.subscriptionId);
      return;
    }
    if (canonical.fingerprint && canonical.fingerprint === subscription.sourceFingerprint) return;
    if (!subscription.canonical) {
      this.requireRebase(subscription, source.revision, 'evicted');
      return;
    }
    const operations = diffJsonValues(subscription.canonical, canonical.value);
    if (operations.length === 0) {
      subscription.sourceFingerprint = canonical.fingerprint;
      return;
    }
    const deltaBytes = Buffer.byteLength(JSON.stringify(operations), 'utf8');
    if (deltaBytes > this.budgets.maxDeltaBytes) {
      this.requireRebase(subscription, source.revision, 'backpressure');
      return;
    }
    const emitted = this.options.emit({
      kind: 'detail.delta', subscriptionId: subscription.subscriptionId,
      baseRevision: subscription.revision, revision: source.revision, operations,
    });
    if (!emitted) {
      this.requireRebase(subscription, source.revision, 'backpressure');
      return;
    }
    subscription.revision = source.revision;
    subscription.sourceFingerprint = canonical.fingerprint;
    subscription.totalBytes = canonical.bytes;
    subscription.touchedAt = Date.now();
    this.retainCanonical(subscription, canonical);
  }

  private retainCanonical(subscription: SubscriptionRecord, canonical: CanonicalDetail): void {
    this.canonicalBytes -= subscription.canonicalBytes;
    subscription.canonical = undefined;
    subscription.canonicalBytes = 0;
    if (canonical.bytes > this.budgets.maxCanonicalBytes) return;
    while (this.canonicalBytes + canonical.bytes > this.budgets.maxCanonicalBytes) {
      const victim = [...this.subscriptions.values()]
        .filter((candidate) => candidate !== subscription && candidate.canonical)
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (!victim) break;
      this.canonicalBytes -= victim.canonicalBytes;
      victim.canonical = undefined;
      victim.canonicalBytes = 0;
      this.requireRebase(victim, victim.revision, 'evicted');
    }
    if (this.canonicalBytes + canonical.bytes <= this.budgets.maxCanonicalBytes) {
      subscription.canonical = canonical.value;
      subscription.canonicalBytes = canonical.bytes;
      this.canonicalBytes += canonical.bytes;
    }
  }

  private requireRebase(subscription: SubscriptionRecord, revision: number, reason: 'gap' | 'backpressure' | 'evicted'): void {
    if (subscription.needsRebase) return;
    subscription.needsRebase = true;
    this.options.emit({ kind: 'detail.rebase', subscriptionId: subscription.subscriptionId, currentRevision: revision, reason });
  }

  private error(requestId: string | undefined, subscriptionId: string, code: 'INVALID_ADDRESS' | 'NOT_LIVE_ADDRESSABLE' | 'NOT_FOUND' | 'STALE_CURSOR' | 'SUBSCRIPTION_CONFLICT' | 'UNAVAILABLE' | 'INTERNAL_ERROR', message: string, retryable: boolean): void {
    this.options.emit({ kind: 'detail.error', ...(requestId ? { requestId } : {}), subscriptionId, code, message, retryable });
  }

  private evictSources(): void {
    while (this.sources.size > this.budgets.maxSources) {
      const oldest = this.sources.keys().next().value as string | undefined;
      if (!oldest) return;
      this.sources.delete(oldest);
      for (const subscription of this.subscriptions.values()) {
        if (subscription.rootKey === oldest) this.requireRebase(subscription, subscription.revision, 'evicted');
      }
    }
  }

  private dropSubscription(subscriptionId: string): void {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) return;
    this.canonicalBytes -= existing.canonicalBytes;
    this.subscriptions.delete(subscriptionId);
  }
}

export function segmentCanonicalDetail(
  serialized: string,
  revision: number,
  address: LiveSubagentDetailAddress,
  requestedPageBytes: number,
): DetailBaselinePage[] {
  const maxPageBytes = Math.max(MIN_DETAIL_PAGE_BYTES, requestedPageBytes);
  // Stable segment identity for the same address/revision so a page re-fetch
  // always yields the exact same segment id.
  const segmentId = createHash('sha256').update(addressKey(address)).update(':').update(String(revision)).digest('hex').slice(0, 32);
  return segmentDetailPagesShared(serialized, revision, maxPageBytes, segmentId);
}

export function reassembleDetailPages(pages: readonly DetailBaselinePage[]): JsonSafeValue {
  // Re-exported shared reassembly: exact order/contiguity/checksum verification
  // plus JSON-safe decoding.
  return reassembleDetailPagesShared(pages);
}

function canonicalizeTarget(details: unknown, address: LiveSubagentDetailAddress): CanonicalDetail | undefined {
  const target = findAddressableTarget(details, address);
  if (!target) return undefined;
  const normalized = normalizeJson(target);
  if (!isJsonSafeValue(normalized)) return undefined;
  const serialized = JSON.stringify(normalized);
  const result = target as Record<string, unknown>;
  const generation = Number.isSafeInteger(result.progressGeneration) ? result.progressGeneration : undefined;
  const fingerprint = typeof result.attemptId === 'string' && generation !== undefined
    ? `${result.attemptId}:${generation}` : undefined;
  return { value: normalized, serialized, bytes: Buffer.byteLength(serialized, 'utf8'), fingerprint };
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
    for (const key of ['details', 'results', 'messages', 'content', 'result', 'children']) {
      if (record[key] !== undefined) stack.push(record[key]);
    }
  }
  return undefined;
}

function sameLineage(value: unknown, expected: LiveSubagentDetailAddress['lineage']): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const actual = entry as Record<string, unknown>;
    const identity = expected[index]!;
    return actual.childId === identity.childId && actual.spawningToolCallId === identity.spawningToolCallId
      && actual.attemptId === identity.attemptId;
  });
}

function normalizeJson(value: unknown): JsonSafeValue {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): JsonSafeValue => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null;
    if (typeof candidate === 'bigint') return `${candidate}n`;
    if (typeof candidate === 'undefined' || typeof candidate === 'function' || typeof candidate === 'symbol') return null;
    if (typeof candidate !== 'object' || depth > 64 || seen.has(candidate)) return '[Circular]';
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map((entry) => visit(entry, depth + 1));
      const output: Record<string, JsonSafeValue> = {};
      for (const key of Object.keys(candidate)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
        let entry: unknown;
        try { entry = (candidate as Record<string, unknown>)[key]; } catch { entry = '[unserializable]'; }
        if (entry !== undefined) output[key] = visit(entry, depth + 1);
      }
      return output;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

function rootKey(root: Pick<LiveDetailRootObservation, 'sessionPath' | 'turnId' | 'rootToolCallId' | 'rootAttemptId'>): string {
  return JSON.stringify([root.sessionPath, root.turnId, root.rootToolCallId, root.rootAttemptId]);
}
function addressKey(address: LiveSubagentDetailAddress): string { return JSON.stringify(address); }
function sameAddress(left: LiveSubagentDetailAddress, right: LiveSubagentDetailAddress): boolean { return addressKey(left) === addressKey(right); }
function cloneAddress(address: LiveSubagentDetailAddress): LiveSubagentDetailAddress {
  return { ...address, lineage: address.lineage.map((identity) => ({ ...identity })) };
}
function clampPageBytes(requested: number, maximum: number): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) return Math.min(DEFAULT_LIVE_DETAIL_PAGE_BYTES, maximum);
  return Math.max(MIN_LIVE_DETAIL_PAGE_BYTES, Math.min(requested, maximum, MAX_LIVE_DETAIL_PAGE_BYTES));
}
function validateBudgets(value: WorkerLiveDetailStoreBudgets): WorkerLiveDetailStoreBudgets {
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Worker live detail budget ${key} must be a positive safe integer.`);
  }
  if (value.maxPageBytes < MIN_LIVE_DETAIL_PAGE_BYTES || value.maxPageBytes > MAX_LIVE_DETAIL_PAGE_BYTES) {
    throw new Error('Worker live detail page budget is outside the private frame envelope range.');
  }
  return value;
}
