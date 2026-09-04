import { createHash } from 'node:crypto';

import type {
  BackendDetailFence,
  CoordinatorToHostDetailMessage,
  DetailCursor,
  DetailPageRef,
  LiveSubagentDetailAddress,
} from '../../shared/protocol/subagent-detail';
import {
  isCoordinatorToHostDetailMessage,
  isLiveSubagentDetailAddress,
} from '../../shared/protocol/subagent-detail';
import type { HostDetailRoute, HostToWebviewMessage, LazyDetailRef } from '../../shared/protocol';
import type { PostImperative } from './types';
import type { RequestOptions } from '../../shared/request-tracker';
import { redactRendererErrorText } from '../../shared/renderer-error-redaction.js';

/** Minimal backend surface: BackendClient satisfies it structurally. */
export interface DetailBackendLike {
  request<TResult = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<TResult>;
}

export const DETAIL_SUBSCRIPTION_MAX_ACTIVE = 32;
export const DETAIL_TOMBSTONE_MAX = 64;
export const DETAIL_TOMBSTONE_TTL_MS = 60_000;
const DETAIL_ATTEMPT_WATERMARK_MAX = DETAIL_TOMBSTONE_MAX * 2;
export const DEFAULT_DETAIL_PAGE_BYTES = 128 * 1024;

export interface DetailSubscriptionServiceOptions {
  backend: DetailBackendLike;
  postImperative: PostImperative;
  /** Stable identity of this extension host (the webview detects a counter
   *  reset via `hostInstanceId` + `hostGeneration` on every imperative). */
  getHostInstanceId: () => string;
  /** Current webview view generation; a reload increments it and invalidates
   *  every subscription opened by the replaced document. */
  getViewGeneration: () => number;
  /** Current backend generation used to fence `BackendDetailFence`. */
  getBackendGeneration: () => number;
  /** Multi-renderer authority. When supplied, replaces the legacy sidebar-only
   * view-generation check with the exact renderer ownership tuple. */
  isRendererOwnerCurrent?: (rendererId: string, viewGeneration: number, rendererGeneration: number) => boolean;
  /** Injectable clock for tombstone/terminal-record expiry (tests). */
  now?: () => number;
  /** Page budget offered to the coordinator on subscribe; clamped there. */
  maxPageBytes?: number;
}

interface SubscriptionOwner {
  subscriptionId: string;
  detailKey: string;
  viewGeneration: number;
  /** Trusted renderer identity (browser server plan §5.4). */
  rendererId: string;
  rendererGeneration: number;
  detailAttempt: number;
  address: LiveSubagentDetailAddress;
  state: 'subscribing' | 'active' | 'rebasing' | 'terminal';
  fence?: BackendDetailFence;
  revision: number;
  baselineRevision: number;
  pageCount: number;
  createdAt: number;
}

interface SubscriptionTombstone {
  subscriptionId: string;
  detailKey: string;
  viewGeneration: number;
  rendererId: string;
  rendererGeneration: number;
  expiresAt: number;
}

interface DetailAttemptWatermark {
  detailAttempt: number;
  expiresAt: number;
}

/** Compact durable handoff retained after `detail.terminal`. It carries only
 *  the durable ref + ownership metadata — never pages — so a later re-expand
 *  of the same key can be answered from the durable transcript without a
 *  worker round-trip. */
interface TerminalDetailRecord {
  detailKey: string;
  viewGeneration: number;
  rendererId: string;
  rendererGeneration: number;
  address: LiveSubagentDetailAddress;
  durableRef: LazyDetailRef;
  revision: number;
  recordedAt: number;
}

function cloneAddress(address: LiveSubagentDetailAddress): LiveSubagentDetailAddress {
  return { ...address, lineage: address.lineage.map((identity) => ({ ...identity })) };
}

/** The complete browser-server ownership key (browser server plan §5.4):
 *  `{hostInstanceId, viewGeneration, rendererId, rendererGeneration,
 *  detailKey, detailAttempt}`. `hostInstanceId` is fixed per service instance;
 *  the stable-key fields are encoded here and the current attempt is stored on
 *  the owner so stale pre-start traffic cannot settle its replacement. */
function ownerKey(viewGeneration: number, rendererId: string, rendererGeneration: number, detailKey: string): string {
  return `${viewGeneration}\u0000${rendererId}\u0000${rendererGeneration}\u0000${detailKey}`;
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

/**
 * Host-owned detail subscription registry. It owns:
 *
 * - exactly one active subscription record per `{viewGeneration, detailKey}`
 *   (the host instance is fixed per `hostInstanceId`, which every imperative
 *   carries), with `detailAttempt` plus the exact address/backend/worker fence
 *   owner recorded before
 *   any stream content is forwarded;
 * - bounded tombstones that absorb late start/page/delta/terminal/error
 *   traffic after unsubscribe/terminal/error so it can never recreate UI;
 * - durable fallback/refetch: a terminal handoff keeps only its compact
 *   `durableRef`, and a later subscribe for the same key is answered from
 *   `session.loadDetail` without a worker round-trip.
 *
 * It never holds detail pages or deltas and never writes ArchState/ViewState.
 */
export class DetailSubscriptionService {
  private readonly subscriptions = new Map<string, SubscriptionOwner>();
  private readonly tombstones = new Map<string, SubscriptionTombstone>();
  private readonly terminalRecords = new Map<string, TerminalDetailRecord>();
  /** Latest renderer-minted attempt accepted for each stable owner key. This
   *  survives owner teardown, closing the pre-start window where a delayed
   *  subscribe could otherwise recreate the owner it belonged to. */
  private readonly attemptWatermarks = new Map<string, DetailAttemptWatermark>();
  private readonly durableAnswersInFlight = new Set<string>();
  private readonly now: () => number;
  private readonly maxPageBytes: number;
  private hostGeneration = 0;

  constructor(private readonly options: DetailSubscriptionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_DETAIL_PAGE_BYTES;
  }

  /** Bump the host generation and drop every owner/tombstone/terminal record.
   *  Called on backend restart and host dispose: a new backend has a new
   *  coordinator generation, so no stream can continue across the boundary. */
  reset(): void {
    this.hostGeneration += 1;
    this.subscriptions.clear();
    this.tombstones.clear();
    this.terminalRecords.clear();
    this.attemptWatermarks.clear();
    this.durableAnswersInFlight.clear();
  }

  /** Renderer reload/disconnect teardown: release every backend slot owned by
   * the invalidated document generation, including compact durable handoffs. */
  unsubscribeRenderer(rendererId: string, rendererGeneration: number): void {
    for (const owner of [...this.subscriptions.values()]) {
      if (owner.rendererId !== rendererId || owner.rendererGeneration !== rendererGeneration) continue;
      this.dropOwner(owner, true);
      void this.notifyBackendUnsubscribe(owner, 'host-dispose');
    }
    for (const [key, record] of this.terminalRecords) {
      if (record.rendererId === rendererId && record.rendererGeneration === rendererGeneration) {
        this.terminalRecords.delete(key);
      }
    }
  }

  getDebugState(): { subscriptions: number; tombstones: number; terminalRecords: number; hostGeneration: number } {
    return {
      subscriptions: this.subscriptions.size,
      tombstones: this.tombstones.size,
      terminalRecords: this.terminalRecords.size,
      hostGeneration: this.hostGeneration,
    };
  }

  /** Subscribe a renderer-owned key. `subscriptionId` is minted by the
   *  EffectRunner; the host records the exact owner before forwarding content.
   *  Terminal keys are answered durably; duplicate active keys are idempotent;
   *  stale owners (rebasing/error/terminal) are replaced with a fresh
   *  subscription. */
  subscribe(
    subscriptionId: string,
    viewGeneration: number,
    detailKey: string,
    address: LiveSubagentDetailAddress,
    cursor?: DetailCursor,
    rendererId?: string,
    rendererGeneration?: number,
    detailAttempt = 1,
  ): void {
    const ownerRendererId = rendererId ?? '';
    const ownerRendererGeneration = rendererGeneration ?? 0;
    if (!Number.isSafeInteger(detailAttempt) || detailAttempt <= 0) return;
    const key = ownerKey(viewGeneration, ownerRendererId, ownerRendererGeneration, detailKey);
    const existing = this.subscriptions.get(key);
    // The live owner itself is an unexpiring watermark. The bounded retired
    // ledger may expire, but that must never let an older delayed command
    // replace a long-running current stream.
    if (existing && detailAttempt <= existing.detailAttempt) return;
    const attemptDisposition = this.observeDetailAttempt(key, detailAttempt);
    if (attemptDisposition !== 'fresh') {
      // One renderer attempt denotes one owner even if command re-delivery
      // caused the host to mint a second subscription id. Once that attempt
      // has retired, it must never recreate itself before receiving start.
      return;
    }
    let predecessorClosed: Promise<void> | undefined;
    if (existing) {
      this.dropOwner(existing, true);
      predecessorClosed = this.notifyBackendUnsubscribe(existing, 'rebase');
    }
    if (!isLiveSubagentDetailAddress(address)) {
      this.postError(subscriptionId, viewGeneration, ownerRendererId, ownerRendererGeneration, detailKey, 'INVALID_ADDRESS', 'The detail address is invalid.', false, detailAttempt);
      return;
    }
    this.pruneTerminalRecords();
    const terminal = this.terminalRecords.get(key);
    if (terminal) {
      if (!sameAddress(terminal.address, address)) {
        this.postError(subscriptionId, viewGeneration, ownerRendererId, ownerRendererGeneration, detailKey, 'INVALID_ADDRESS', 'The address changed after the detail became durable.', false, detailAttempt);
        return;
      }
      this.subscribeDurably(subscriptionId, terminal, detailAttempt, predecessorClosed);
      return;
    }
    if (this.subscriptions.size >= DETAIL_SUBSCRIPTION_MAX_ACTIVE) {
      this.postError(subscriptionId, viewGeneration, ownerRendererId, ownerRendererGeneration, detailKey, 'UNAVAILABLE', 'The host detail subscription budget is full.', true, detailAttempt);
      return;
    }
    const owner: SubscriptionOwner = {
      subscriptionId,
      detailKey,
      viewGeneration,
      rendererId: ownerRendererId,
      rendererGeneration: ownerRendererGeneration,
      detailAttempt,
      address: cloneAddress(address),
      state: 'subscribing',
      revision: 0,
      baselineRevision: 0,
      pageCount: 0,
      createdAt: this.now(),
    };
    this.subscriptions.set(key, owner);
    void (async () => {
      await predecessorClosed;
      if (this.subscriptions.get(key) !== owner) return;
      await this.options.backend.request('detail.subscribe', {
        subscriptionId,
        address,
        ...(cursor !== undefined ? { cursor } : {}),
        maxPageBytes: this.maxPageBytes,
      }, { timeoutMs: 30_000 });
    })().catch((error) => {
      if (this.subscriptions.get(key) !== owner) return;
      this.dropOwner(owner, false);
      this.postError(
        subscriptionId,
        viewGeneration,
        ownerRendererId,
        ownerRendererGeneration,
        detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
        owner.detailAttempt,
      );
    });
  }

  /** Collapse/unmount/session-change: immediately discard the owner (the
   *  webview already discarded its heavy key store), leave a bounded tombstone
   *  until acknowledgement/expiry, and notify the backend best-effort. */
  unsubscribe(
    viewGeneration: number,
    detailKey: string,
    reason: 'collapse' | 'unmount' | 'session-change',
    rendererId?: string,
    rendererGeneration?: number,
    detailAttempt?: number,
  ): void {
    const key = ownerKey(viewGeneration, rendererId ?? '', rendererGeneration ?? 0, detailKey);
    const owner = this.subscriptions.get(key);
    const requestedAttempt = detailAttempt ?? owner?.detailAttempt;
    if (requestedAttempt === undefined || (owner && requestedAttempt < owner.detailAttempt)) return;
    const attemptDisposition = this.observeDetailAttempt(key, requestedAttempt);
    if (attemptDisposition === 'stale' || !owner || owner.detailAttempt > requestedAttempt) return;
    this.dropOwner(owner, true);
    this.notifyBackendUnsubscribe(
      owner,
      reason === 'session-change' ? 'session-change' : 'collapse',
    );
  }

  private notifyBackendUnsubscribe(
    owner: SubscriptionOwner,
    reason: 'collapse' | 'rebase' | 'session-change' | 'host-dispose',
  ): Promise<void> {
    return this.options.backend.request('detail.unsubscribe', {
      subscriptionId: owner.subscriptionId,
      reason,
    }, { timeoutMs: 15_000 }).then(() => undefined, () => undefined);
  }

  /** Refetch an evicted/offscreen page of an active baseline. The owner's
   *  exact address/subscription are used; a stale or mismatched manifest is a
   *  dropped request (the coordinator rebases first). */
  fetchPages(
    viewGeneration: number,
    detailKey: string,
    ref: DetailPageRef,
    rendererId?: string,
    rendererGeneration?: number,
    detailAttempt?: number,
  ): void {
    const key = ownerKey(viewGeneration, rendererId ?? '', rendererGeneration ?? 0, detailKey);
    const owner = this.subscriptions.get(key);
    if (!owner || (detailAttempt !== undefined && owner.detailAttempt !== detailAttempt)
      || owner.state !== 'active' || owner.fence === undefined) return;
    if (ref.baselineRevision !== owner.baselineRevision || ref.pageCount !== owner.pageCount || ref.pageIndex >= owner.pageCount) return;
    void this.options.backend.request('detail.fetch', {
      subscriptionId: owner.subscriptionId,
      address: owner.address,
      ref,
      maxPageBytes: this.maxPageBytes,
    }, { timeoutMs: 30_000 }).catch((error) => {
      if (this.subscriptions.get(key) !== owner) return;
      this.dropOwner(owner, false);
      this.postError(
        owner.subscriptionId,
        owner.viewGeneration,
        owner.rendererId,
        owner.rendererGeneration,
        owner.detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
        owner.detailAttempt,
      );
    });
  }

  /** Route one of the six coordinator→host detail variants to its renderer
   *  owner. Unknown/tombstoned/generation-stale traffic is dropped and can
   *  never recreate UI. */
  handleStream(message: CoordinatorToHostDetailMessage): void {
    if (!isCoordinatorToHostDetailMessage(message)) return;
    const owner = this.findOwner(message.subscriptionId);
    if (!owner) return; // unknown, or tombstoned (already closed) traffic
    const rendererOwnerCurrent = this.options.isRendererOwnerCurrent
      ? this.options.isRendererOwnerCurrent(owner.rendererId, owner.viewGeneration, owner.rendererGeneration)
      : owner.viewGeneration === this.options.getViewGeneration();
    if (!rendererOwnerCurrent) {
      this.dropOwner(owner, true);
      void this.notifyBackendUnsubscribe(owner, 'host-dispose');
      return;
    }
    if (message.fence.backendGeneration !== this.options.getBackendGeneration()) {
      // A backend generation change invalidates the stream. The coordinator
      // that minted this fence no longer exists; drop and close rather than
      // forwarding a stale-route message.
      this.dropOwner(owner, false);
      return;
    }
    const fence = message.fence;
    switch (message.kind) {
      case 'detail.start': {
        if (owner.state !== 'subscribing' || !sameAddress(owner.address, message.address)) {
          this.dropOwner(owner, false);
          return;
        }
        owner.state = 'active';
        owner.fence = { ...fence };
        owner.revision = message.baselineRevision;
        owner.baselineRevision = message.baselineRevision;
        owner.pageCount = message.pageCount;
        this.postImperative({ type: 'detail.start', ...this.route(owner), ...message });
        return;
      }
      case 'detail.page': {
        if (owner.state !== 'active' || !this.matchesFence(owner, fence)
          || message.ref.baselineRevision !== owner.baselineRevision
          || message.ref.pageCount !== owner.pageCount
          || message.ref.pageIndex >= owner.pageCount
          || message.payloadBytes !== byteLengthOf(JSON.stringify(message.payload))
          || message.checksum !== sha256(JSON.stringify(message.payload))) {
          return;
        }
        this.postImperative({ type: 'detail.page', ...this.route(owner), ...message });
        return;
      }
      case 'detail.delta': {
        if (owner.state !== 'active' || !this.matchesFence(owner, fence)) return;
        if (message.baseRevision !== owner.revision) {
          // A gap the coordinator did not catch: transition explicitly instead
          // of applying an out-of-order patch.
          owner.state = 'rebasing';
          owner.revision = message.baseRevision;
          this.postImperative({
            type: 'detail.rebase', ...this.route(owner), currentRevision: message.baseRevision, reason: 'gap',
          });
          return;
        }
        owner.revision = message.revision;
        this.postImperative({ type: 'detail.delta', ...this.route(owner), ...message });
        return;
      }
      case 'detail.rebase': {
        if (!this.matchesFence(owner, fence)) return;
        owner.state = 'rebasing';
        owner.revision = message.currentRevision;
        this.postImperative({ type: 'detail.rebase', ...this.route(owner), ...message });
        return;
      }
      case 'detail.terminal': {
        if (!this.matchesFence(owner, fence)) return;
        owner.state = 'terminal';
        owner.revision = message.revision;
        const record: TerminalDetailRecord = {
          detailKey: owner.detailKey,
          viewGeneration: owner.viewGeneration,
          rendererId: owner.rendererId,
          rendererGeneration: owner.rendererGeneration,
          address: cloneAddress(owner.address),
          durableRef: message.durableRef,
          revision: message.revision,
          recordedAt: this.now(),
        };
        this.terminalRecords.set(ownerKey(owner.viewGeneration, owner.rendererId, owner.rendererGeneration, owner.detailKey), record);
        this.postImperative({ type: 'detail.terminal', ...this.route(owner), ...message });
        this.dropOwner(owner, false);
        this.pruneTerminalRecords();
        return;
      }
      case 'detail.error': {
        if (owner.fence === undefined) {
          // Live lookup may fall back to the durable authority and fail before
          // either source emits detail.start. The subscription id plus current
          // backend generation already identifies the pending owner; bind the
          // error's fence so the only terminal signal reaches the renderer.
          if (owner.state !== 'subscribing') return;
          owner.fence = { ...fence };
        } else if (!this.matchesFence(owner, fence)) {
          return;
        }
        this.postImperative({
          type: 'detail.error',
          ...this.route(owner),
          ...message,
          message: redactRendererErrorText(message.message),
        });
        this.dropOwner(owner, false);
        return;
      }
    }
  }

  // ─── Durable fallback/refetch ──────────────────────────────────────────────

  /** Answer a re-expanded terminal key through the coordinator's paged durable
   *  authority. The host mints the subscription owner and sends `detail.subscribe`
   *  (no cursor: the durable baseline is complete), and the backend streams
   *  exact pages directly from the durable JSONL ending with a terminal handoff.
   *  No single response ever exceeds the transport budget, and the owner's
   *  stream is routed through the same fence/state machine as a live stream. */
  private subscribeDurably(
    subscriptionId: string,
    terminal: TerminalDetailRecord,
    detailAttempt: number,
    predecessorClosed?: Promise<void>,
  ): void {
    const key = ownerKey(terminal.viewGeneration, terminal.rendererId, terminal.rendererGeneration, terminal.detailKey);
    const existing = this.subscriptions.get(key);
    if (existing) {
      if (existing.subscriptionId === subscriptionId
        && (existing.state === 'subscribing' || existing.state === 'active')
        && sameAddress(existing.address, terminal.address)) {
        return; // re-delivery of the exact durable owner is idempotent
      }
      // A fresh renderer attempt supersedes the stream it retired locally.
      // Release the old durable/worker slot before binding the new id.
      this.dropOwner(existing, true);
      const existingClosed = this.notifyBackendUnsubscribe(existing, 'rebase');
      predecessorClosed = predecessorClosed
        ? Promise.all([predecessorClosed, existingClosed]).then(() => undefined)
        : existingClosed;
    }
    if (this.subscriptions.size >= DETAIL_SUBSCRIPTION_MAX_ACTIVE) {
      this.postError(
        subscriptionId,
        terminal.viewGeneration,
        terminal.rendererId,
        terminal.rendererGeneration,
        terminal.detailKey,
        'UNAVAILABLE',
        'The host detail subscription budget is full.',
        true,
        detailAttempt,
      );
      return;
    }
    this.durableAnswersInFlight.add(key);
    const owner: SubscriptionOwner = {
      subscriptionId,
      detailKey: terminal.detailKey,
      viewGeneration: terminal.viewGeneration,
      rendererId: terminal.rendererId,
      rendererGeneration: terminal.rendererGeneration,
      detailAttempt,
      address: cloneAddress(terminal.address),
      state: 'subscribing',
      revision: 0,
      baselineRevision: 0,
      pageCount: 0,
      createdAt: this.now(),
    };
    this.subscriptions.set(key, owner);
    void (async () => {
      await predecessorClosed;
      if (this.subscriptions.get(key) !== owner) return;
      await this.options.backend.request('detail.subscribe', {
        subscriptionId,
        address: terminal.address,
        maxPageBytes: this.maxPageBytes,
      }, { timeoutMs: 30_000 });
    })().catch((error) => {
      if (this.subscriptions.get(key) !== owner) return;
      this.dropOwner(owner, false);
      this.postError(
        subscriptionId,
        terminal.viewGeneration,
        terminal.rendererId,
        terminal.rendererGeneration,
        terminal.detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
        owner.detailAttempt,
      );
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private findOwner(subscriptionId: string): SubscriptionOwner | undefined {
    const owner = [...this.subscriptions.values()].find((candidate) => candidate.subscriptionId === subscriptionId);
    if (owner) return owner;
    return undefined;
  }

  private matchesFence(owner: SubscriptionOwner, fence: BackendDetailFence): boolean {
    const recorded = owner.fence;
    return recorded !== undefined
      && recorded.backendGeneration === fence.backendGeneration
      && recorded.coordinatorGeneration === fence.coordinatorGeneration
      && recorded.workerId === fence.workerId
      && recorded.workerGeneration === fence.workerGeneration;
  }

  /** Remove an owner and (when `tombstone`) leave a bounded tombstone that
   *  absorbs late traffic for its subscription. Clearing the durable-answer
   *  guard here lets a later re-expand re-subscribe through the durable
   *  authority once the previous stream is fully closed. */
  private dropOwner(owner: SubscriptionOwner, tombstone: boolean): void {
    const key = ownerKey(owner.viewGeneration, owner.rendererId, owner.rendererGeneration, owner.detailKey);
    if (this.subscriptions.get(key) === owner) this.subscriptions.delete(key);
    this.durableAnswersInFlight.delete(key);
    if (tombstone) this.addTombstone(owner.subscriptionId, owner.viewGeneration, owner.rendererId, owner.rendererGeneration, owner.detailKey);
  }

  private addTombstone(subscriptionId: string, viewGeneration: number, rendererId: string, rendererGeneration: number, detailKey: string): void {
    const now = this.now();
    for (const [existingKey, existing] of this.tombstones) {
      if (existing.expiresAt <= now) this.tombstones.delete(existingKey);
    }
    this.tombstones.set(subscriptionId, {
      subscriptionId,
      viewGeneration,
      rendererId,
      rendererGeneration,
      detailKey,
      expiresAt: now + DETAIL_TOMBSTONE_TTL_MS,
    });
    while (this.tombstones.size > DETAIL_TOMBSTONE_MAX) {
      const oldestKey = this.tombstones.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.tombstones.delete(oldestKey);
    }
  }

  private pruneTerminalRecords(): void {
    const now = this.now();
    for (const [key, record] of this.terminalRecords) {
      if (record.recordedAt + DETAIL_TOMBSTONE_TTL_MS <= now) this.terminalRecords.delete(key);
    }
    while (this.terminalRecords.size > DETAIL_TOMBSTONE_MAX) {
      const oldestKey = this.terminalRecords.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.terminalRecords.delete(oldestKey);
    }
  }

  private observeDetailAttempt(key: string, detailAttempt: number): 'fresh' | 'same' | 'stale' {
    const now = this.now();
    for (const [recordedKey, watermark] of this.attemptWatermarks) {
      if (watermark.expiresAt <= now) this.attemptWatermarks.delete(recordedKey);
    }
    const current = this.attemptWatermarks.get(key);
    if (current) {
      if (detailAttempt < current.detailAttempt) return 'stale';
      if (detailAttempt === current.detailAttempt) return 'same';
    }
    this.attemptWatermarks.delete(key);
    this.attemptWatermarks.set(key, {
      detailAttempt,
      expiresAt: now + DETAIL_TOMBSTONE_TTL_MS,
    });
    while (this.attemptWatermarks.size > DETAIL_ATTEMPT_WATERMARK_MAX) {
      const inactiveKey = [...this.attemptWatermarks.keys()].find((candidate) => !this.subscriptions.has(candidate));
      const oldestKey = inactiveKey ?? this.attemptWatermarks.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.attemptWatermarks.delete(oldestKey);
    }
    return 'fresh';
  }

  private route(owner: SubscriptionOwner): HostDetailRoute {
    const fence = owner.fence;
    return {
      hostInstanceId: this.options.getHostInstanceId(),
      hostGeneration: this.hostGeneration,
      viewGeneration: owner.viewGeneration,
      rendererId: owner.rendererId,
      rendererGeneration: owner.rendererGeneration,
      backendGeneration: fence?.backendGeneration ?? this.options.getBackendGeneration(),
      coordinatorGeneration: fence?.coordinatorGeneration ?? this.options.getBackendGeneration(),
      ...(fence?.workerId !== undefined && fence.workerGeneration !== undefined
        ? { workerId: fence.workerId, workerGeneration: fence.workerGeneration }
        : {}),
      detailKey: owner.detailKey,
      detailAttempt: owner.detailAttempt,
      subscriptionId: owner.subscriptionId,
    };
  }

  private postImperative(message: HostToWebviewMessage): void {
    this.options.postImperative(message);
  }

  private postError(
    subscriptionId: string,
    viewGeneration: number,
    rendererId: string,
    rendererGeneration: number,
    detailKey: string,
    code: 'INVALID_ADDRESS' | 'NOT_LIVE_ADDRESSABLE' | 'NOT_FOUND' | 'STALE_CURSOR' | 'CHECKSUM_MISMATCH' | 'SUBSCRIPTION_CONFLICT' | 'UNAVAILABLE' | 'INTERNAL_ERROR',
    message: string,
    retryable: boolean,
    detailAttempt = 1,
  ): void {
    const route: HostDetailRoute = {
      hostInstanceId: this.options.getHostInstanceId(),
      hostGeneration: this.hostGeneration,
      viewGeneration,
      rendererId,
      rendererGeneration,
      backendGeneration: this.options.getBackendGeneration(),
      coordinatorGeneration: this.options.getBackendGeneration(),
      detailKey,
      detailAttempt,
      subscriptionId,
    };
    this.options.postImperative({
      type: 'detail.error',
      ...route,
      code,
      message: redactRendererErrorText(message),
      retryable,
    });
  }

  private mapRpcErrorToCode(error: unknown): 'INVALID_ADDRESS' | 'NOT_FOUND' | 'UNAVAILABLE' {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
    if (code === 'INVALID_PARAMS') return 'INVALID_ADDRESS';
    if (code === 'SESSION_NOT_FOUND' || code === 'NOT_FOUND') return 'NOT_FOUND';
    return 'UNAVAILABLE';
  }
}

function byteLengthOf(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
