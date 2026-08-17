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

/** Minimal backend surface: BackendClient satisfies it structurally. */
export interface DetailBackendLike {
  request<TResult = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<TResult>;
}

export const DETAIL_SUBSCRIPTION_MAX_ACTIVE = 32;
export const DETAIL_TOMBSTONE_MAX = 64;
export const DETAIL_TOMBSTONE_TTL_MS = 60_000;
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
  /** Injectable clock for tombstone/terminal-record expiry (tests). */
  now?: () => number;
  /** Page budget offered to the coordinator on subscribe; clamped there. */
  maxPageBytes?: number;
}

interface SubscriptionOwner {
  subscriptionId: string;
  detailKey: string;
  viewGeneration: number;
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
  expiresAt: number;
}

/** Compact durable handoff retained after `detail.terminal`. It carries only
 *  the durable ref + ownership metadata — never pages — so a later re-expand
 *  of the same key can be answered from the durable transcript without a
 *  worker round-trip. */
interface TerminalDetailRecord {
  detailKey: string;
  viewGeneration: number;
  address: LiveSubagentDetailAddress;
  durableRef: LazyDetailRef;
  revision: number;
  recordedAt: number;
}

function ownerKey(viewGeneration: number, detailKey: string): string {
  return `${viewGeneration}\u0000${detailKey}`;
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

/**
 * Host-owned Phase 5 detail subscription registry. It owns:
 *
 * - exactly one active subscription record per `{viewGeneration, detailKey}`
 *   (the host instance is fixed per `hostInstanceId`, which every imperative
 *   carries) with the exact address/backend/worker fence owner recorded before
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
    this.durableAnswersInFlight.clear();
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
  ): void {
    if (!isLiveSubagentDetailAddress(address)) {
      this.postError(subscriptionId, viewGeneration, detailKey, 'INVALID_ADDRESS', 'The detail address is invalid.', false);
      return;
    }
    const key = ownerKey(viewGeneration, detailKey);
    const terminal = this.terminalRecords.get(key);
    if (terminal) {
      if (this.durableAnswersInFlight.has(key)) return;
      if (!sameAddress(terminal.address, address)) {
        this.postError(subscriptionId, viewGeneration, detailKey, 'INVALID_ADDRESS', 'The address changed after the detail became durable.', false);
        return;
      }
      this.subscribeDurably(subscriptionId, terminal);
      return;
    }
    const existing = this.subscriptions.get(key);
    if (existing) {
      if ((existing.state === 'subscribing' || existing.state === 'active')
        && sameAddress(existing.address, address)) {
        // Idempotent re-subscribe for the same owner; the existing stream
        // already covers this key.
        return;
      }
      // Rebase/address replacement creates a fresh owner, but the old worker
      // subscription must also be closed. A tombstone alone protects the host;
      // it does not release the worker's bounded subscription slot.
      this.dropOwner(existing, true);
      this.notifyBackendUnsubscribe(existing, 'rebase');
    }
    if (this.subscriptions.size >= DETAIL_SUBSCRIPTION_MAX_ACTIVE) {
      this.postError(subscriptionId, viewGeneration, detailKey, 'UNAVAILABLE', 'The host detail subscription budget is full.', true);
      return;
    }
    const owner: SubscriptionOwner = {
      subscriptionId,
      detailKey,
      viewGeneration,
      address: cloneAddress(address),
      state: 'subscribing',
      revision: 0,
      baselineRevision: 0,
      pageCount: 0,
      createdAt: this.now(),
    };
    this.subscriptions.set(key, owner);
    void this.options.backend.request('detail.subscribe', {
      subscriptionId,
      address,
      ...(cursor !== undefined ? { cursor } : {}),
      maxPageBytes: this.maxPageBytes,
    }, { timeoutMs: 30_000 }).catch((error) => {
      if (this.subscriptions.get(key) !== owner) return;
      this.dropOwner(owner, false);
      this.postError(
        subscriptionId,
        viewGeneration,
        detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
      );
    });
  }

  /** Collapse/unmount/session-change: immediately discard the owner (the
   *  webview already discarded its heavy key store), leave a bounded tombstone
   *  until acknowledgement/expiry, and notify the backend best-effort. */
  unsubscribe(viewGeneration: number, detailKey: string, reason: 'collapse' | 'unmount' | 'session-change'): void {
    const key = ownerKey(viewGeneration, detailKey);
    const owner = this.subscriptions.get(key);
    if (!owner) return;
    this.dropOwner(owner, true);
    this.notifyBackendUnsubscribe(
      owner,
      reason === 'session-change' ? 'session-change' : 'collapse',
    );
  }

  private notifyBackendUnsubscribe(
    owner: SubscriptionOwner,
    reason: 'collapse' | 'rebase' | 'session-change' | 'host-dispose',
  ): void {
    void this.options.backend.request('detail.unsubscribe', {
      subscriptionId: owner.subscriptionId,
      reason,
    }, { timeoutMs: 15_000 }).catch(() => undefined);
  }

  /** Refetch an evicted/offscreen page of an active baseline. The owner's
   *  exact address/subscription are used; a stale or mismatched manifest is a
   *  dropped request (the coordinator rebases first). */
  fetchPages(viewGeneration: number, detailKey: string, ref: DetailPageRef): void {
    const key = ownerKey(viewGeneration, detailKey);
    const owner = this.subscriptions.get(key);
    if (!owner || owner.state !== 'active' || owner.fence === undefined) return;
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
        owner.detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
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
    if (owner.viewGeneration !== this.options.getViewGeneration()) {
      this.dropOwner(owner, false);
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
          address: cloneAddress(owner.address),
          durableRef: message.durableRef,
          revision: message.revision,
          recordedAt: this.now(),
        };
        this.terminalRecords.set(ownerKey(owner.viewGeneration, owner.detailKey), record);
        this.postImperative({ type: 'detail.terminal', ...this.route(owner), ...message });
        this.dropOwner(owner, false);
        this.pruneTerminalRecords();
        return;
      }
      case 'detail.error': {
        if (!this.matchesFence(owner, fence)) return;
        this.postImperative({ type: 'detail.error', ...this.route(owner), ...message });
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
  private subscribeDurably(subscriptionId: string, terminal: TerminalDetailRecord): void {
    const key = ownerKey(terminal.viewGeneration, terminal.detailKey);
    const existing = this.subscriptions.get(key);
    if (existing && (existing.state === 'subscribing' || existing.state === 'active')
      && sameAddress(existing.address, terminal.address)) {
      return; // the durable stream already covers this key
    }
    if (this.durableAnswersInFlight.has(key)) return;
    this.durableAnswersInFlight.add(key);
    const owner: SubscriptionOwner = {
      subscriptionId,
      detailKey: terminal.detailKey,
      viewGeneration: terminal.viewGeneration,
      address: cloneAddress(terminal.address),
      state: 'subscribing',
      revision: 0,
      baselineRevision: 0,
      pageCount: 0,
      createdAt: this.now(),
    };
    this.subscriptions.set(key, owner);
    void this.options.backend.request('detail.subscribe', {
      subscriptionId,
      address: terminal.address,
      maxPageBytes: this.maxPageBytes,
    }, { timeoutMs: 30_000 }).catch((error) => {
      if (this.subscriptions.get(key) !== owner) return;
      this.dropOwner(owner, false);
      this.postError(
        subscriptionId,
        terminal.viewGeneration,
        terminal.detailKey,
        this.mapRpcErrorToCode(error),
        error instanceof Error ? error.message : String(error),
        true,
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
    const key = ownerKey(owner.viewGeneration, owner.detailKey);
    if (this.subscriptions.get(key) === owner) this.subscriptions.delete(key);
    this.durableAnswersInFlight.delete(key);
    if (tombstone) this.addTombstone(owner.subscriptionId, owner.viewGeneration, owner.detailKey);
  }

  private addTombstone(subscriptionId: string, viewGeneration: number, detailKey: string): void {
    const now = this.now();
    for (const [existingKey, existing] of this.tombstones) {
      if (existing.expiresAt <= now) this.tombstones.delete(existingKey);
    }
    this.tombstones.set(subscriptionId, {
      subscriptionId,
      viewGeneration,
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
  }

  private route(owner: SubscriptionOwner): HostDetailRoute {
    const fence = owner.fence;
    return {
      hostInstanceId: this.options.getHostInstanceId(),
      hostGeneration: this.hostGeneration,
      viewGeneration: owner.viewGeneration,
      backendGeneration: fence?.backendGeneration ?? this.options.getBackendGeneration(),
      coordinatorGeneration: fence?.coordinatorGeneration ?? this.options.getBackendGeneration(),
      ...(fence?.workerId !== undefined && fence.workerGeneration !== undefined
        ? { workerId: fence.workerId, workerGeneration: fence.workerGeneration }
        : {}),
      detailKey: owner.detailKey,
      subscriptionId: owner.subscriptionId,
    };
  }

  private postImperative(message: HostToWebviewMessage): void {
    this.options.postImperative(message);
  }

  private postError(
    subscriptionId: string,
    viewGeneration: number,
    detailKey: string,
    code: 'INVALID_ADDRESS' | 'NOT_LIVE_ADDRESSABLE' | 'NOT_FOUND' | 'STALE_CURSOR' | 'CHECKSUM_MISMATCH' | 'SUBSCRIPTION_CONFLICT' | 'UNAVAILABLE' | 'INTERNAL_ERROR',
    message: string,
    retryable: boolean,
  ): void {
    const route: HostDetailRoute = {
      hostInstanceId: this.options.getHostInstanceId(),
      hostGeneration: this.hostGeneration,
      viewGeneration,
      backendGeneration: this.options.getBackendGeneration(),
      coordinatorGeneration: this.options.getBackendGeneration(),
      detailKey,
      subscriptionId,
    };
    this.options.postImperative({ type: 'detail.error', ...route, code, message, retryable });
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
