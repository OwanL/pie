import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { diffJsonValues, isJsonSafeValue, type JsonSafeValue } from '../shared/json-structural-patch.js';
import {
  isLiveSubagentDetailAddress,
  type DetailCursor,
  type DetailPageRef,
  type LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import {
  DETAIL_PAGE_ENVELOPE_SLACK_BYTES,
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

export type WorkerLiveDetailEmitSettlement =
  | { status: 'sent' }
  | { status: 'rejected'; retryable: boolean }
  | { status: 'failed' };

export interface WorkerLiveDetailStoreOptions {
  emit(frame: DetailStreamBody, onSettled?: (settlement: WorkerLiveDetailEmitSettlement) => void): boolean;
  /** Called after a detail-lane frame settles, when a previously rejected page
   * may be admitted without growing the bounded transport backlog. */
  onDrain?: (listener: () => void) => () => void;
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

interface BaselineDelivery {
  revision: number;
  pageCount: number;
  nextPageIndex: number;
  /** The cursor owns a stable canonical snapshot, either in accounted memory
   * or in a private per-subscription OS-temp spool. It never reads the mutable
   * producer object after canonicalization. */
  snapshot: SerializedSnapshot;
  cursor: DetailPageCursor;
  /** Bytes charged against the global in-memory retention budget. Spools have
   * zero memory charge. */
  memoryBytes: number;
  pendingPage?: DetailBaselinePage;
  inFlight?: 'start' | 'page';
}

interface PendingTerminal {
  revision: number;
  durableRef: LazyDetailRef;
}

/** Serialized authority for the last delivered state of a subscription whose
 *  canonical value cannot be retained as parsed in-memory state. Oversized
 *  content spools with zero memory charge, so a live transcript above the
 *  retention budget keeps emitting cheap structural deltas against the stable
 *  baseline the receiver already holds instead of rebasing on every update. */
interface DeliveredDiffAuthority {
  snapshot: SerializedSnapshot;
  /** Bytes charged against the global in-memory retention budget. Spools have
   * zero memory charge. */
  memoryBytes: number;
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
  rebaseRevision?: number;
  rebaseReason?: 'gap' | 'backpressure' | 'evicted';
  baseline?: BaselineDelivery;
  deliveredDiff?: DeliveredDiffAuthority;
  pendingTerminal?: PendingTerminal;
  touchedAt: number;
}

interface CanonicalDetail {
  value: JsonSafeValue;
  serialized: string;
  bytes: number;
  fingerprint?: string;
}

interface SerializedSnapshot {
  readonly memoryBytes: number;
  openReader(): CodePointReader;
  cleanup(): void;
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
  private readonly progressiveDelivery: boolean;
  private readonly removeDrainListener?: () => void;
  private drainScheduled = false;
  private disposed = false;

  constructor(private readonly options: WorkerLiveDetailStoreOptions) {
    this.budgets = validateBudgets({ ...DEFAULT_WORKER_LIVE_DETAIL_BUDGETS, ...options.budgets });
    this.progressiveDelivery = options.onDrain !== undefined;
    this.removeDrainListener = options.onDrain?.(() => this.scheduleDrain());
  }

  observe(observation: LiveDetailRootObservation): void {
    if (this.disposed) return;
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
      if (subscription.rootKey !== key) continue;
      if (subscription.baseline) {
        if (subscription.baseline.revision !== source.revision) {
          // The baseline is an immutable snapshot of the source that was
          // subscribed to. Let that snapshot drain before asking the host to
          // rebase; otherwise a busy producer can invalidate every first page
          // and keep the detail permanently in the loading state.
          this.requireRebase(subscription, source.revision, 'gap');
        }
        continue;
      }
      if (subscription.needsRebase) continue;
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
    if (this.disposed) return;
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
    const pages = this.progressiveDelivery
      ? undefined
      : segmentCanonicalDetail(canonical.serialized, source.revision, address, maxPageBytes);
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
    if (!this.progressiveDelivery) this.retainCanonical(subscription, canonical);
    if (this.progressiveDelivery) {
      try {
        subscription.baseline = this.createBaselineDelivery(subscription, canonical, source.revision, address, maxPageBytes);
      } catch {
        this.dropSubscription(subscriptionId);
        this.error(requestId, subscriptionId, 'INTERNAL_ERROR', 'The live detail baseline could not be retained.', true);
        return;
      }
    }
    const firstPage = subscription.baseline?.pendingPage ?? pages?.[0];
    const startFrame: DetailStreamBody = {
      kind: 'detail.start', requestId, subscriptionId, address: cloneAddress(address), source: 'live',
      baselineRevision: source.revision, pageCount: subscription.baseline?.pageCount ?? pages!.length, totalBytes: canonical.bytes,
      totalCodePoints: firstPage?.payload.totalCodePoints ?? 0,
    };
    if (this.progressiveDelivery) {
      if (!this.options.emit(startFrame, (settlement) => this.handleBaselineStartSettlement(subscription, settlement))) {
        this.dropSubscription(subscriptionId);
      }
      return;
    }
    if (!this.options.emit(startFrame)) {
      this.dropSubscription(subscriptionId);
      return;
    }
    for (const page of pages!) {
      if (!this.options.emit({ kind: 'detail.page', subscriptionId, ...page })) {
        this.requireRebase(subscription, source.revision, 'backpressure');
        break;
      }
    }
  }

  unsubscribe(requestId: string, subscriptionId: string): void {
    if (this.disposed) return;
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
    if (this.disposed) return;
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
      this.failSubscription(subscriptionId, requestId, 'NOT_FOUND', 'The detail page source no longer exists.', true);
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
    if (this.disposed) return;
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
      if (this.progressiveDelivery && subscription.baseline) {
        subscription.pendingTerminal = { revision, durableRef };
        if (!subscription.baseline.inFlight) this.finishPendingTerminal(subscription);
      } else {
        try {
          this.options.emit({ kind: 'detail.terminal', subscriptionId: subscription.subscriptionId, revision, durableRef });
        } finally {
          this.dropSubscription(subscription.subscriptionId);
        }
      }
    }
    this.sources.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.removeDrainListener?.();
    for (const subscriptionId of [...this.subscriptions.keys()]) this.dropSubscription(subscriptionId);
    this.sources.clear();
    this.canonicalBytes = 0;
  }

  debugState(): { sources: number; subscriptions: number; canonicalBytes: number } {
    return { sources: this.sources.size, subscriptions: this.subscriptions.size, canonicalBytes: this.canonicalBytes };
  }

  private handleBaselineStartSettlement(
    subscription: SubscriptionRecord,
    settlement: WorkerLiveDetailEmitSettlement,
  ): void {
    if (this.subscriptions.get(subscription.subscriptionId) !== subscription || !subscription.baseline) return;
    if (subscription.baseline.inFlight !== 'start') return;
    subscription.baseline.inFlight = undefined;
    if (settlement.status !== 'sent') {
      this.dropSubscription(subscription.subscriptionId);
      return;
    }
    queueMicrotask(() => {
      if (this.subscriptions.get(subscription.subscriptionId) !== subscription) return;
      if (subscription.pendingTerminal) this.finishPendingTerminal(subscription);
      else this.pumpBaseline(subscription);
    });
  }

  private handleBaselinePageSettlement(
    subscription: SubscriptionRecord,
    settlement: WorkerLiveDetailEmitSettlement,
  ): void {
    const current = this.subscriptions.get(subscription.subscriptionId);
    const baseline = subscription.baseline;
    if (current !== subscription || !baseline || baseline.inFlight !== 'page') return;
    baseline.inFlight = undefined;
    if (settlement.status === 'failed' || (settlement.status === 'rejected' && !settlement.retryable)) {
      this.dropSubscription(subscription.subscriptionId);
      return;
    }
    if (settlement.status !== 'sent') return;
    if (subscription.pendingTerminal) {
      this.finishPendingTerminal(subscription);
      return;
    }
    // A newer source revision may have requested a rebase while this baseline
    // was in flight. The original baseline still owns the delivery order and
    // must finish before that rebase is flushed.
    baseline.nextPageIndex += 1;
    baseline.pendingPage = undefined;
    if (baseline.nextPageIndex >= baseline.pageCount) {
      this.completeBaseline(subscription);
      return;
    }
    queueMicrotask(() => this.pumpBaseline(subscription));
  }

  private pumpBaseline(subscription: SubscriptionRecord): void {
    if (this.disposed || this.subscriptions.get(subscription.subscriptionId) !== subscription) return;
    const baseline = subscription.baseline;
    if (!baseline || baseline.inFlight) return;
    if (subscription.pendingTerminal) {
      this.finishPendingTerminal(subscription);
      return;
    }
    if (baseline.nextPageIndex >= baseline.pageCount) {
      this.completeBaseline(subscription);
      return;
    }
    let page: DetailBaselinePage | undefined;
    try {
      page = baseline.pendingPage ?? baseline.cursor.nextPage();
    } catch {
      this.failSubscription(subscription.subscriptionId, undefined, 'INTERNAL_ERROR', 'The live detail baseline could not be read.', true);
      return;
    }
    if (!page || page.ref.pageIndex !== baseline.nextPageIndex) {
      // The cursor is bounded and deterministic. A mismatch means the source
      // snapshot was not immutable, so do not emit a page that could never be
      // assembled by the receiver.
      this.requireRebase(subscription, baseline.revision, 'gap');
      return;
    }
    baseline.pendingPage = page;
    baseline.inFlight = 'page';
    const accepted = this.options.emit({ kind: 'detail.page', subscriptionId: subscription.subscriptionId, ...page },
      (settlement) => this.handleBaselinePageSettlement(subscription, settlement));
    if (!accepted && this.subscriptions.get(subscription.subscriptionId) === subscription
      && subscription.baseline === baseline && baseline.inFlight === 'page') {
      // A bounded capacity rejection has no settlement callback to wait on.
      // The writer's detail-drain listener will retry this one retained page.
      baseline.inFlight = undefined;
    }
  }

  private completeBaseline(subscription: SubscriptionRecord): void {
    const baseline = subscription.baseline;
    if (!baseline) return;
    let complete = false;
    try {
      complete = baseline.cursor.isComplete();
    } catch {
      this.failSubscription(subscription.subscriptionId, undefined, 'INTERNAL_ERROR', 'The live detail baseline could not be verified.', true);
      return;
    }
    if (!complete) {
      // The retained snapshot was incomplete or unreadable. Do not silently
      // complete a manifest whose totals or content do not match its baseline.
      this.releaseBaseline(subscription);
      this.requireRebase(subscription, baseline.revision, 'gap');
      this.flushRebase(subscription);
      return;
    }
    const source = this.sources.get(subscription.rootKey);
    if (!source) {
      this.releaseBaseline(subscription);
      this.requireRebase(subscription, baseline.revision, 'evicted');
      this.flushRebase(subscription);
      return;
    }
    if (subscription.needsRebase || source.revision !== baseline.revision) {
      // A source update raced the immutable baseline. Deliver the deferred
      // change as one structural delta against the just-delivered snapshot so
      // the receiver keeps its stable live baseline; a rebase is the bounded
      // fallback when the delta path cannot represent the update.
      if (this.completeBaselineWithDelta(subscription, baseline, source)) return;
      this.releaseBaseline(subscription);
      if (!subscription.needsRebase) this.requireRebase(subscription, source.revision, 'gap');
      this.flushRebase(subscription);
      return;
    }
    // Stable completion: no update raced the immutable baseline. Retain the
    // content as the delta authority for later updates; an oversized value
    // keeps the delivered snapshot as a zero-memory spool authority rather
    // than invalidating the baseline the receiver just assembled.
    let canonical: CanonicalDetail | undefined;
    try {
      canonical = canonicalizeTarget(source.details, subscription.address);
    } catch {
      this.failSubscription(subscription.subscriptionId, undefined, 'INTERNAL_ERROR', 'The current live detail could not be canonicalized.', true);
      return;
    }
    if (!canonical) {
      this.releaseBaseline(subscription);
      this.requireRebase(subscription, source.revision, 'gap');
      this.flushRebase(subscription);
      return;
    }
    subscription.totalBytes = canonical.bytes;
    subscription.sourceFingerprint = canonical.fingerprint;
    subscription.touchedAt = Date.now();
    if (canonical.bytes <= this.budgets.maxCanonicalBytes) {
      this.releaseBaseline(subscription);
      this.retainCanonical(subscription, canonical);
      return;
    }
    this.transferBaselineToDiffAuthority(subscription, baseline);
  }

  /** Deliver the updates that raced the just-completed baseline as one ordered
   *  structural delta against the delivered snapshot. Returns false when the
   *  delta path cannot represent the update (unreadable snapshot, oversized
   *  delta, or a rejected emission); the caller then flushes a rebase. */
  private completeBaselineWithDelta(
    subscription: SubscriptionRecord,
    baseline: BaselineDelivery,
    source: SourceRecord,
  ): boolean {
    let canonical: CanonicalDetail | undefined;
    try {
      canonical = canonicalizeTarget(source.details, subscription.address);
    } catch {
      return false;
    }
    if (!canonical) return false;
    let previous: JsonSafeValue | undefined;
    try {
      previous = this.readSerializedSnapshot(baseline.snapshot);
    } catch {
      return false;
    }
    if (!previous || !isJsonSafeValue(previous)) return false;
    let operations;
    try {
      operations = diffJsonValues(previous, canonical.value);
    } catch {
      return false;
    }
    if (operations.length > 0) {
      const deltaBytes = Buffer.byteLength(JSON.stringify(operations), 'utf8');
      if (deltaBytes > this.budgets.maxDeltaBytes) return false;
      const emitted = this.options.emit({
        kind: 'detail.delta', subscriptionId: subscription.subscriptionId,
        baseRevision: subscription.revision, revision: source.revision, operations,
      });
      if (!emitted) return false;
      subscription.revision = source.revision;
    }
    subscription.needsRebase = false;
    subscription.rebaseRevision = undefined;
    subscription.rebaseReason = undefined;
    subscription.sourceFingerprint = canonical.fingerprint;
    subscription.totalBytes = canonical.bytes;
    subscription.touchedAt = Date.now();
    if (canonical.bytes <= this.budgets.maxCanonicalBytes) {
      this.releaseBaseline(subscription);
      this.retainCanonical(subscription, canonical);
      return true;
    }
    try {
      this.transferBaselineToDiffAuthority(subscription, baseline, canonical);
    } catch {
      // The delivered authority must never go stale: without a fresh spool the
      // next delta would compute against content the receiver already passed.
      this.releaseBaseline(subscription);
      this.releaseDeliveredDiffAuthority(subscription);
      this.requireRebase(subscription, source.revision, 'evicted');
      this.flushRebase(subscription);
    }
    return true;
  }

  /** Replace the just-delivered baseline snapshot with the zero-memory spool
   *  authority for the delivered-plus-delta state. Spools never charge the
   *  global canonical budget, so memory bounds are unchanged. */
  private transferBaselineToDiffAuthority(
    subscription: SubscriptionRecord,
    baseline: BaselineDelivery,
    canonical?: CanonicalDetail,
  ): void {
    const replacement = canonical ? createSpoolSnapshot(canonical.serialized) : undefined;
    subscription.baseline = undefined;
    try {
      baseline.cursor.close();
    } finally {
      // With a replacement the delivered snapshot is stale and released;
      // without one the delivered snapshot itself continues as the authority.
      if (replacement) baseline.snapshot.cleanup();
    }
    let transferredBytes = 0;
    if (replacement) {
      this.canonicalBytes -= baseline.memoryBytes;
    } else {
      transferredBytes = baseline.memoryBytes;
    }
    baseline.memoryBytes = 0;
    const previous = subscription.deliveredDiff;
    subscription.deliveredDiff = replacement
      ? { snapshot: replacement, memoryBytes: replacement.memoryBytes }
      : { snapshot: baseline.snapshot, memoryBytes: transferredBytes };
    if (previous) this.releaseDeliveredDiff(previous);
  }

  private releaseDeliveredDiff(diff: DeliveredDiffAuthority): void {
    this.canonicalBytes -= diff.memoryBytes;
    diff.memoryBytes = 0;
    diff.snapshot.cleanup();
  }

  private releaseDeliveredDiffAuthority(subscription: SubscriptionRecord): void {
    const diff = subscription.deliveredDiff;
    if (!diff) return;
    subscription.deliveredDiff = undefined;
    this.releaseDeliveredDiff(diff);
  }

  private readSerializedSnapshot(snapshot: SerializedSnapshot): JsonSafeValue {
    const reader = snapshot.openReader();
    try {
      const parts: string[] = [];
      for (;;) {
        const read = reader.read(64 * 1024);
        if (read.count === 0) break;
        parts.push(read.text);
      }
      return JSON.parse(parts.join('')) as JsonSafeValue;
    } finally {
      reader.close();
    }
  }

  private finishPendingTerminal(subscription: SubscriptionRecord): void {
    const terminal = subscription.pendingTerminal;
    if (!terminal || subscription.baseline?.inFlight) return;
    subscription.pendingTerminal = undefined;
    this.releaseBaseline(subscription);
    try {
      this.options.emit({
        kind: 'detail.terminal', subscriptionId: subscription.subscriptionId,
        revision: terminal.revision, durableRef: terminal.durableRef,
      });
    } finally {
      this.dropSubscription(subscription.subscriptionId);
    }
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      for (const subscription of this.subscriptions.values()) this.pumpBaseline(subscription);
    });
  }

  private createBaselineDelivery(
    subscription: SubscriptionRecord,
    canonical: CanonicalDetail,
    revision: number,
    address: LiveSubagentDetailAddress,
    maxPageBytes: number,
  ): BaselineDelivery {
    const snapshot = this.createSerializedSnapshot(subscription, canonical.serialized, canonical.bytes);
    const totalCodePoints = countCodePoints(canonical.serialized);
    const segmentId = detailSegmentId(address, revision);
    try {
      // Count pages from the stable snapshot with one bounded page in memory.
      // The second reader is the actual delivery cursor; neither path rebuilds
      // normalized JSON or consults the mutable producer object.
      const countCursor = new DetailPageCursor(
        snapshot.openReader(), revision, maxPageBytes, segmentId,
        canonical.bytes, totalCodePoints, 1,
      );
      let pageCount = 0;
      try {
        while (countCursor.nextPage()) pageCount += 1;
      } finally {
        countCursor.close();
      }
      const cursor = new DetailPageCursor(
        snapshot.openReader(), revision, maxPageBytes, segmentId,
        canonical.bytes, totalCodePoints, pageCount,
        createHash('sha256').update(canonical.serialized).digest('hex'),
      );
      try {
        const pendingPage = cursor.nextPage();
        if (!pendingPage || pageCount === 0) {
          throw new Error('Detail baseline cursor could not produce its first page.');
        }
        return {
          revision,
          pageCount,
          nextPageIndex: 0,
          snapshot,
          cursor,
          memoryBytes: snapshot.memoryBytes,
          pendingPage,
          inFlight: 'start',
        };
      } catch (error) {
        cursor.close();
        throw error;
      }
    } catch (error) {
      snapshot.cleanup();
      throw error;
    }
  }

  private createSerializedSnapshot(
    subscription: SubscriptionRecord,
    serialized: string,
    bytes: number,
  ): SerializedSnapshot {
    if (bytes <= this.budgets.maxCanonicalBytes) {
      while (this.canonicalBytes + bytes > this.budgets.maxCanonicalBytes) {
        const victim = [...this.subscriptions.values()]
          .filter((candidate) => candidate !== subscription && candidate.canonical)
          .sort((left, right) => left.touchedAt - right.touchedAt)[0];
        if (!victim) break;
        this.canonicalBytes -= victim.canonicalBytes;
        victim.canonical = undefined;
        victim.canonicalBytes = 0;
        this.requireRebase(victim, victim.revision, 'evicted');
      }
      if (this.canonicalBytes + bytes <= this.budgets.maxCanonicalBytes) {
        this.canonicalBytes += bytes;
        return createMemorySnapshot(serialized, bytes);
      }
    }
    return createSpoolSnapshot(serialized);
  }

  private releaseBaseline(subscription: SubscriptionRecord): void {
    const baseline = subscription.baseline;
    if (!baseline) return;
    subscription.baseline = undefined;
    try {
      baseline.cursor.close();
    } finally {
      try {
        baseline.snapshot.cleanup();
      } finally {
        this.canonicalBytes -= baseline.memoryBytes;
        baseline.memoryBytes = 0;
      }
    }
  }

  private failSubscription(
    subscriptionId: string,
    requestId: string | undefined,
    code: 'INVALID_ADDRESS' | 'NOT_LIVE_ADDRESSABLE' | 'NOT_FOUND' | 'STALE_CURSOR' | 'SUBSCRIPTION_CONFLICT' | 'UNAVAILABLE' | 'INTERNAL_ERROR',
    message: string,
    retryable: boolean,
  ): void {
    this.dropSubscription(subscriptionId);
    this.error(requestId, subscriptionId, code, message, retryable);
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
      this.emitDeliveredDelta(subscription, source, canonical);
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

  /** Oversized subscription update: diff against the last delivered state,
   *  which is retained as a spool-backed (zero memory charge) authority, so a
   *  live transcript never starves in a rebase loop merely because its
   *  canonical value exceeds the retention budget. A rebase stays the bounded
   *  fallback when the delta cannot represent the update. */
  private emitDeliveredDelta(
    subscription: SubscriptionRecord,
    source: SourceRecord,
    canonical: CanonicalDetail,
  ): void {
    const diff = subscription.deliveredDiff;
    if (!diff) {
      this.requireRebase(subscription, source.revision, 'evicted');
      return;
    }
    let previous: JsonSafeValue | undefined;
    try {
      previous = this.readSerializedSnapshot(diff.snapshot);
    } catch {
      previous = undefined;
    }
    if (!previous || !isJsonSafeValue(previous)) {
      this.releaseDeliveredDiffAuthority(subscription);
      this.requireRebase(subscription, source.revision, 'evicted');
      this.flushRebase(subscription);
      return;
    }
    let operations;
    try {
      operations = diffJsonValues(previous, canonical.value);
    } catch {
      this.requireRebase(subscription, source.revision, 'backpressure');
      this.flushRebase(subscription);
      return;
    }
    if (operations.length > 0) {
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
      this.rotateDeliveredDiff(subscription, source, canonical);
      return;
    }
    subscription.sourceFingerprint = canonical.fingerprint;
  }

  /** Rotate the diff authority after a delivered delta so the next update
   *  computes against the state the receiver now holds. Oversized content
   *  spools with zero memory charge; shrinking into the retention budget
   *  returns to the parsed in-memory canonical window. */
  private rotateDeliveredDiff(
    subscription: SubscriptionRecord,
    source: SourceRecord,
    canonical: CanonicalDetail,
  ): void {
    if (canonical.bytes <= this.budgets.maxCanonicalBytes) {
      this.retainCanonical(subscription, canonical);
      if (subscription.canonical) return;
    }
    let snapshot: SerializedSnapshot;
    try {
      snapshot = createSpoolSnapshot(canonical.serialized);
    } catch {
      this.releaseDeliveredDiffAuthority(subscription);
      this.requireRebase(subscription, source.revision, 'evicted');
      this.flushRebase(subscription);
      return;
    }
    const previous = subscription.deliveredDiff;
    subscription.deliveredDiff = { snapshot, memoryBytes: snapshot.memoryBytes };
    if (previous) this.releaseDeliveredDiff(previous);
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
      this.releaseDeliveredDiffAuthority(subscription);
    }
  }

  private requireRebase(subscription: SubscriptionRecord, revision: number, reason: 'gap' | 'backpressure' | 'evicted'): void {
    if (subscription.needsRebase) {
      if (revision > (subscription.rebaseRevision ?? subscription.revision)) {
        subscription.rebaseRevision = revision;
      }
      return;
    }
    subscription.needsRebase = true;
    subscription.rebaseRevision = revision;
    subscription.rebaseReason = reason;
    // A baseline is an immutable stream in progress. Keep it intact and emit
    // the rebase only after its final page settles, not merely after the first
    // page that happened to be in flight when the source changed.
    if (subscription.baseline) return;
    this.flushRebase(subscription);
  }

  private flushRebase(subscription: SubscriptionRecord): void {
    if (!subscription.needsRebase || subscription.baseline?.inFlight) return;
    this.releaseBaseline(subscription);
    this.options.emit({
      kind: 'detail.rebase', subscriptionId: subscription.subscriptionId,
      currentRevision: subscription.rebaseRevision ?? subscription.revision,
      reason: subscription.rebaseReason ?? 'gap',
    });
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
    this.releaseBaseline(existing);
    this.releaseDeliveredDiffAuthority(existing);
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
  return segmentDetailPagesShared(serialized, revision, maxPageBytes, detailSegmentId(address, revision));
}

export function reassembleDetailPages(pages: readonly DetailBaselinePage[]): JsonSafeValue {
  // Re-exported shared reassembly: exact order/contiguity/checksum verification
  // plus JSON-safe decoding.
  return reassembleDetailPagesShared(pages);
}

interface CodePointRead {
  text: string;
  count: number;
}

interface CodePointReader {
  read(maxCodePoints: number): CodePointRead;
  unread(text: string): void;
  close(): void;
}

function createMemorySnapshot(serialized: string, bytes: number): SerializedSnapshot {
  return {
    memoryBytes: bytes,
    openReader: () => new StringCodePointReader(serialized),
    cleanup: () => undefined,
  };
}

function createSpoolSnapshot(serialized: string): SerializedSnapshot {
  const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pie-live-detail-'));
  const filePath = path.join(directory, 'snapshot.json');
  let cleaned = false;
  try {
    fsSync.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    fsSync.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    memoryBytes: 0,
    openReader: () => new FileCodePointReader(filePath),
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      fsSync.rmSync(directory, { recursive: true, force: true });
    },
  };
}

class StringCodePointReader implements CodePointReader {
  private index = 0;
  private pending = '';

  constructor(private readonly source: string) {}

  read(maxCodePoints: number): CodePointRead {
    const points: string[] = [];
    while (points.length < maxCodePoints) {
      let point: string | undefined;
      if (this.pending.length > 0) {
        const codePoint = this.pending.codePointAt(0)!;
        point = String.fromCodePoint(codePoint);
        this.pending = this.pending.slice(point.length);
      } else if (this.index < this.source.length) {
        const codePoint = this.source.codePointAt(this.index)!;
        point = String.fromCodePoint(codePoint);
        this.index += point.length;
      } else {
        break;
      }
      points.push(point);
    }
    return { text: points.join(''), count: points.length };
  }

  unread(text: string): void {
    if (text.length > 0) this.pending = text + this.pending;
  }

  close(): void { /* memory-backed */ }
}

class FileCodePointReader implements CodePointReader {
  private readonly descriptor: number;
  private readonly chunk = Buffer.allocUnsafe(64 * 1024);
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private pendingCount = 0;
  private eof = false;
  private closed = false;

  constructor(private readonly filePath: string) {
    this.descriptor = fsSync.openSync(filePath, 'r');
  }

  read(maxCodePoints: number): CodePointRead {
    while (this.pendingCount < maxCodePoints && !this.eof) this.readChunk();
    const result = takeCodePoints(this.pending, maxCodePoints);
    this.pending = this.pending.slice(result.text.length);
    this.pendingCount -= result.count;
    return result;
  }

  unread(text: string): void {
    if (text.length === 0) return;
    this.pending = text + this.pending;
    this.pendingCount += countCodePoints(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fsSync.closeSync(this.descriptor);
  }

  private readChunk(): void {
    const bytesRead = fsSync.readSync(this.descriptor, this.chunk, 0, this.chunk.length, null);
    if (bytesRead === 0) {
      this.append(this.decoder.end());
      this.eof = true;
      return;
    }
    this.append(this.decoder.write(this.chunk.subarray(0, bytesRead)));
  }

  private append(text: string): void {
    if (text.length === 0) return;
    this.pending += text;
    this.pendingCount += countCodePoints(text);
  }
}

function takeCodePoints(value: string, maxCodePoints: number): CodePointRead {
  if (maxCodePoints <= 0 || value.length === 0) return { text: '', count: 0 };
  let end = 0;
  let count = 0;
  while (end < value.length && count < maxCodePoints) {
    const codePoint = value.codePointAt(end)!;
    end += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: value.slice(0, end), count };
}

class DetailPageCursor {
  private pageIndex = 0;
  private byteIndex = 0;
  private codePointIndex = 0;
  private readonly maxPageBytes: number;

  constructor(
    private readonly reader: CodePointReader,
    private readonly revision: number,
    requestedPageBytes: number,
    private readonly segmentId: string,
    private readonly totalBytes: number,
    private readonly totalCodePoints: number,
    private readonly pageCount: number,
    private readonly expectedHash?: string,
  ) {
    this.maxPageBytes = Math.max(MIN_DETAIL_PAGE_BYTES, requestedPageBytes);
  }

  nextPage(): DetailBaselinePage | undefined {
    if (this.codePointIndex >= this.totalCodePoints) return undefined;
    const read = this.reader.read(Math.max(1, this.maxPageBytes - DETAIL_PAGE_ENVELOPE_SLACK_BYTES));
    if (read.count === 0) return undefined;
    let text = read.text;
    let count = read.count;
    let page = this.makePage(text, count);
    while (page.payloadBytes > this.maxPageBytes && count > 1) {
      const nextCount = Math.max(1, Math.floor(count / 2));
      const prefix = takeCodePoints(text, nextCount).text;
      this.reader.unread(text.slice(prefix.length));
      text = prefix;
      count = nextCount;
      page = this.makePage(text, count);
    }
    if (page.payloadBytes > this.maxPageBytes) {
      throw new Error(`Detail page budget ${this.maxPageBytes} cannot encode one Unicode code point.`);
    }
    this.pageIndex += 1;
    this.byteIndex = page.payload.endByte;
    this.codePointIndex = page.payload.endCodePoint;
    this.hash?.update(text);
    return page;
  }

  isComplete(): boolean {
    if (this.pageIndex !== this.pageCount
      || this.byteIndex !== this.totalBytes
      || this.codePointIndex !== this.totalCodePoints) return false;
    const trailing = this.reader.read(1);
    if (trailing.count !== 0) {
      this.reader.unread(trailing.text);
      return false;
    }
    return !this.expectedHash || this.hash!.digest('hex') === this.expectedHash;
  }

  close(): void { this.reader.close(); }

  private readonly hash = this.expectedHash ? createHash('sha256') : undefined;

  private makePage(text: string, codePointCount: number): DetailBaselinePage {
    const payload = {
      kind: 'json-segment' as const,
      encoding: 'utf8-json' as const,
      segmentId: this.segmentId,
      semanticPath: [] as readonly (string | number)[],
      startByte: this.byteIndex,
      endByte: this.byteIndex + Buffer.byteLength(text, 'utf8'),
      totalBytes: this.totalBytes,
      startCodePoint: this.codePointIndex,
      endCodePoint: this.codePointIndex + codePointCount,
      totalCodePoints: this.totalCodePoints,
      text,
    };
    return {
      ref: { baselineRevision: this.revision, pageIndex: this.pageIndex, pageCount: this.pageCount },
      payload,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    };
  }
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
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
  return {
    value: normalized,
    serialized,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    fingerprint,
  };
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
function detailSegmentId(address: LiveSubagentDetailAddress, revision: number): string {
  return createHash('sha256').update(addressKey(address)).update(':').update(String(revision)).digest('hex').slice(0, 32);
}
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
