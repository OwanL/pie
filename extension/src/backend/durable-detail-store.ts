import { createHash } from 'node:crypto';

import { isJsonSafeValue } from '../shared/json-structural-patch.js';
import type { LazyDetailRef } from '../shared/protocol/messages.js';
import type {
  BackendDetailFence,
  CoordinatorToHostDetailMessage,
  DetailErrorCode,
  LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import {
  MAX_DETAIL_PAGE_BYTES,
  MIN_DETAIL_PAGE_BYTES,
  segmentDetailPages,
} from '../shared/detail-segmentation.js';
import type { ChatMessage, ToolCall } from '../shared/protocol/messages.js';

export const DEFAULT_DURABLE_DETAIL_PAGE_BYTES = 128 * 1024;
export const MIN_DURABLE_DETAIL_PAGE_BYTES = MIN_DETAIL_PAGE_BYTES;
export const MAX_DURABLE_DETAIL_PAGE_BYTES = MAX_DETAIL_PAGE_BYTES;

export interface DurableDetailStoreBudgets {
  maxSources: number;
  maxSubscriptions: number;
  maxCanonicalBytes: number;
  maxPageBytes: number;
}

export const DEFAULT_DURABLE_DETAIL_BUDGETS: DurableDetailStoreBudgets = {
  maxSources: 32,
  maxSubscriptions: 32,
  maxCanonicalBytes: 64 * 1024 * 1024,
  maxPageBytes: MAX_DURABLE_DETAIL_PAGE_BYTES,
};

/** A resolved durable detail target: the exact tool result (or reasoning body)
 *  addressed by the subscription, plus its stable durable identity. */
export interface ResolvedDurableDetail {
  value: unknown;
  sizeBytes: number;
  messageId: string;
  toolCallId: string;
  kind: 'tool-result' | 'reasoning';
}

export type ResolveDurableDetail = (
  sessionPath: string,
  address: LiveSubagentDetailAddress,
  durableRef?: LazyDetailRef,
) => Promise<ResolvedDurableDetail>;

export type DurableDetailResolutionStatus = 'resolved' | 'not-found' | 'not-addressable';

export interface DurableDetailResolution {
  status: DurableDetailResolutionStatus;
  value?: unknown;
  sizeBytes?: number;
  messageId?: string;
  toolCallId?: string;
  message: string;
}

/** Pure resolution of a live detail address against a durable transcript
 *  projection. The tool call `id` is the stable bridge between the live
 *  pipeline address (`rootToolCallId`) and the durable JSONL; the final child
 *  record is located by producer lineage. Legacy durable results without
 *  producer identity are explicitly not addressable. */
export function resolveDurableDetailFromTranscript(
  transcript: readonly ChatMessage[],
  sessionPath: string,
  address: LiveSubagentDetailAddress,
  durableRef?: LazyDetailRef,
): DurableDetailResolution {
  let message: ChatMessage | undefined;
  const toolCallId = durableRef?.toolCallId ?? address.rootToolCallId;
  if (durableRef && durableRef.kind === 'tool-result') {
    message = transcript.find((candidate) => candidate.id === durableRef.messageId);
    if (!message) {
      return { status: 'not-found', message: `The durable message is no longer available: ${durableRef.messageId}` };
    }
  } else {
    message = transcript.find((candidate) => hasToolCall(candidate, address.rootToolCallId));
    if (!message) {
      return { status: 'not-found', message: `No durable tool call owns ${address.rootToolCallId}.` };
    }
  }
  const tool = findToolCall(message, toolCallId);
  if (!tool || tool.result === undefined) {
    return { status: 'not-found', message: `The durable tool result is no longer available: ${toolCallId}` };
  }
  const value = findAddressableTarget(tool.result, address);
  if (!value) {
    return { status: 'not-addressable', message: 'The durable detail is not producer-addressable.' };
  }
  let sizeBytes: number;
  try {
    sizeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return { status: 'not-addressable', message: 'The durable detail is not JSON-safe.' };
  }
  return { status: 'resolved', value, sizeBytes, messageId: message.id, toolCallId, message: '' };
}

function hasToolCall(message: ChatMessage, toolCallId: string): boolean {
  if (message.toolCalls?.some((candidate) => candidate.id === toolCallId)) return true;
  return !!message.parts?.some((part) => part.kind === 'toolCall' && part.toolCall.id === toolCallId);
}

function findToolCall(message: ChatMessage, toolCallId: string): ToolCall | undefined {
  const fromParts = message.parts
    ?.filter((part): part is Extract<NonNullable<ChatMessage['parts']>[number], { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall)
    .find((candidate) => candidate.id === toolCallId);
  if (fromParts) return fromParts;
  return message.toolCalls?.find((candidate) => candidate.id === toolCallId);
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

interface SourceRecord {
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  revision: number;
  kind: 'tool-result' | 'reasoning';
  serialized: string;
  bytes: number;
  durableRef: LazyDetailRef;
  touchedAt: number;
}

interface SubscriptionRecord {
  subscriptionId: string;
  sessionPath: string;
  address: LiveSubagentDetailAddress;
  fence: BackendDetailFence;
  state: 'active' | 'terminal';
  baselineRevision: number;
  pageCount: number;
  maxPageBytes: number;
  sourceKey: string;
  durableRef: LazyDetailRef;
  totalBytes: number;
}

export interface DurableDetailStoreOptions {
  resolve: ResolveDurableDetail;
  /** Returns false to signal stream backpressure; the store then closes the
   *  subscription instead of enqueueing an unbounded history. */
  emit(message: CoordinatorToHostDetailMessage): boolean;
  budgets?: Partial<DurableDetailStoreBudgets>;
}

/**
 * Coordinator-owned durable paged detail authority. It serves `detail.subscribe`
 * / `detail.fetch` for terminal/cold subagent detail directly from the durable
 * JSONL (via the injected resolver) without ever producing one >30 MiB
 * response: the canonical value is segmented into exact, UTF-8-safe,
 * checksummed pages that ride the six `detail.stream` events, and only a
 * bounded cache of resolved sources is retained.
 */
export class DurableDetailStore {
  private readonly budgets: DurableDetailStoreBudgets;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private canonicalBytes = 0;

  constructor(private readonly options: DurableDetailStoreOptions) {
    this.budgets = validateBudgets({ ...DEFAULT_DURABLE_DETAIL_BUDGETS, ...options.budgets });
  }

  /** Resolve the durable source and stream start + ordered pages + terminal.
   *  The correlated RPC settles `{accepted:true}`; failures ride the stream as
   *  `detail.error` so the host surfaces them without a second report. */
  async subscribe(
    requestId: string,
    subscriptionId: string,
    address: LiveSubagentDetailAddress,
    requestedPageBytes: number,
    fence: BackendDetailFence,
  ): Promise<void> {
    if (this.subscriptions.has(subscriptionId)) {
      this.error(subscriptionId, 'SUBSCRIPTION_CONFLICT', 'The durable detail subscription identity is already owned.', false, fence);
      return;
    }
    // Supersede any prior subscription for the same durable address before the
    // budget check so a terminal baseline being re-expanded (after page loss)
    // frees its own slot. This mirrors the worker store's terminal lifecycle:
    // subscriptions outlive the handoff so evicted pages stay refetchable
    // until the next subscribe/unsubscribe for the same source.
    const supersedeKey = addressKey(address);
    for (const [existingId, existing] of this.subscriptions) {
      if (addressKey(existing.address) === supersedeKey) this.subscriptions.delete(existingId);
    }
    if (this.subscriptions.size >= this.budgets.maxSubscriptions) {
      this.error(subscriptionId, 'UNAVAILABLE', 'The durable detail subscription budget is full.', true, fence);
      return;
    }
    const resolved = await this.resolve(address, undefined, subscriptionId, fence);
    if (!resolved) return;
    const serialized = canonicalSerialization(resolved.value);
    if (serialized === undefined) {
      this.error(subscriptionId, 'INTERNAL_ERROR', 'The durable detail could not be canonicalized.', true, fence);
      return;
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const revision = stableRevision(resolved.messageId, resolved.toolCallId);
    const sourceKey = sourceKeyOf(address.sessionPath, resolved.messageId, resolved.toolCallId);
    const durableRef: LazyDetailRef = {
      key: `durable:subagent:${address.sessionPath}:${resolved.messageId}:${resolved.toolCallId}`,
      kind: 'tool-result',
      source: 'durable',
      sessionPath: address.sessionPath,
      messageId: resolved.messageId,
      toolCallId: resolved.toolCallId,
      sizeBytes: bytes,
      summary: `Subagent detail (${address.lineage.length} lineage level${address.lineage.length === 1 ? '' : 's'})`,
      childCount: 1,
      available: true,
    };
    this.retainSource(sourceKey, {
      sessionPath: address.sessionPath,
      messageId: resolved.messageId,
      toolCallId: resolved.toolCallId,
      revision,
      kind: resolved.kind,
      serialized,
      bytes,
      durableRef,
      touchedAt: Date.now(),
    });
    const subscription: SubscriptionRecord = {
      subscriptionId,
      sessionPath: address.sessionPath,
      address: cloneAddress(address),
      fence,
      state: 'active',
      baselineRevision: revision,
      pageCount: 0,
      maxPageBytes: clampPageBytes(requestedPageBytes, this.budgets.maxPageBytes),
      sourceKey,
      durableRef,
      totalBytes: bytes,
    };
    this.subscriptions.set(subscriptionId, subscription);
    const pages = segmentDetailPages(
      serialized,
      revision,
      subscription.maxPageBytes,
      stableSegmentId(sourceKey, revision, bytes),
    );
    subscription.pageCount = pages.length;
    if (!this.options.emit({
      kind: 'detail.start', subscriptionId, address: cloneAddress(address), source: 'durable',
      baselineRevision: revision, pageCount: pages.length, totalBytes: bytes,
      totalCodePoints: pages[0]?.payload.totalCodePoints ?? 0, fence,
    })) {
      this.drop(subscriptionId);
      return;
    }
    for (const page of pages) {
      if (!this.options.emit({ kind: 'detail.page', subscriptionId, ...page, fence })) {
        this.error(subscriptionId, 'UNAVAILABLE', 'The durable detail stream could not be delivered.', true, fence);
        this.drop(subscriptionId);
        return;
      }
    }
    this.options.emit({ kind: 'detail.terminal', subscriptionId, revision, durableRef, fence });
    // Keep the subscription (state `terminal`) so evicted-page refetches are
    // exact until the host unsubscribes or a fresh subscribe supersedes it.
  }

  /** Re-emit one exact page of an active durable baseline. The source is
   *  re-resolved by its durable identity so evicted pages stay exact; a
   *  manifest mismatch is an explicit error rather than a plausible page. */
  async fetch(
    requestId: string,
    subscriptionId: string,
    address: LiveSubagentDetailAddress,
    ref: import('../shared/protocol/subagent-detail.js').DetailPageRef,
    requestedPageBytes: number,
    fence: BackendDetailFence,
  ): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || (subscription.state !== 'active' && subscription.state !== 'terminal')
      || !sameAddress(subscription.address, address)) {
      this.error(subscriptionId, 'SUBSCRIPTION_CONFLICT', 'The durable detail page owner does not match this subscription.', false, fence);
      return;
    }
    if (ref.baselineRevision !== subscription.baselineRevision || ref.pageCount !== subscription.pageCount
      || ref.pageIndex >= subscription.pageCount) {
      this.error(subscriptionId, 'NOT_FOUND', 'The requested page is not part of the active durable baseline manifest.', false, fence);
      return;
    }
    const source = await this.sourceFor(subscription, fence);
    if (!source) {
      this.error(subscriptionId, 'NOT_FOUND', 'The durable detail source could not be re-read; re-subscribe for a fresh baseline.', true, fence);
      return;
    }
    const pageBytes = clampPageBytes(requestedPageBytes, subscription.maxPageBytes);
    const pages = segmentDetailPages(
      source.serialized,
      subscription.baselineRevision,
      pageBytes,
      stableSegmentId(subscription.sourceKey, subscription.baselineRevision, source.bytes),
    );
    if (ref.pageCount !== pages.length) {
      this.error(subscriptionId, 'NOT_FOUND', 'The durable baseline manifest changed; re-subscribe for a fresh baseline.', true, fence);
      return;
    }
    if (!this.options.emit({ kind: 'detail.page', subscriptionId, ...pages[ref.pageIndex]!, fence })) {
      this.error(subscriptionId, 'UNAVAILABLE', 'The durable detail page could not be delivered.', true, fence);
    }
  }

  unsubscribe(requestId: string, subscriptionId: string): void {
    this.drop(subscriptionId);
  }

  owns(subscriptionId: string): boolean {
    return this.subscriptions.has(subscriptionId);
  }

  dispose(): void {
    this.sources.clear();
    this.subscriptions.clear();
    this.canonicalBytes = 0;
  }

  debugState(): { sources: number; subscriptions: number; canonicalBytes: number } {
    return { sources: this.sources.size, subscriptions: this.subscriptions.size, canonicalBytes: this.canonicalBytes };
  }

  private async resolve(
    address: LiveSubagentDetailAddress,
    durableRef: LazyDetailRef | undefined,
    subscriptionId: string,
    fence: BackendDetailFence,
  ): Promise<ResolvedDurableDetail | undefined> {
    let resolved: ResolvedDurableDetail;
    try {
      resolved = await this.options.resolve(address.sessionPath, address, durableRef);
    } catch (error) {
      const code: DetailErrorCode = error instanceof DurableDetailNotFoundError ? 'NOT_FOUND'
        : error instanceof DurableDetailNotAddressableError ? 'NOT_LIVE_ADDRESSABLE'
          : 'UNAVAILABLE';
      this.error(subscriptionId, code, error instanceof Error ? error.message : String(error), code === 'UNAVAILABLE', fence);
      return undefined;
    }
    if (resolved.sizeBytes > Number.MAX_SAFE_INTEGER) {
      this.error(subscriptionId, 'INTERNAL_ERROR', 'The durable detail size is not representable.', false, fence);
      return undefined;
    }
    return resolved;
  }

  private async sourceFor(subscription: SubscriptionRecord, fence: BackendDetailFence): Promise<SourceRecord | undefined> {
    const cached = this.sources.get(subscription.sourceKey);
    if (cached) {
      cached.touchedAt = Date.now();
      return cached;
    }
    const resolved = await this.resolve(subscription.address, subscription.durableRef, subscription.subscriptionId, fence);
    if (!resolved || resolved.messageId !== subscription.durableRef.messageId
      || resolved.toolCallId !== subscription.durableRef.toolCallId) {
      return undefined;
    }
    const serialized = canonicalSerialization(resolved.value);
    if (serialized === undefined) return undefined;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes !== subscription.totalBytes) return undefined;
    const source: SourceRecord = {
      sessionPath: subscription.sessionPath,
      messageId: resolved.messageId,
      toolCallId: resolved.toolCallId,
      revision: subscription.baselineRevision,
      kind: resolved.kind,
      serialized,
      bytes,
      durableRef: subscription.durableRef,
      touchedAt: Date.now(),
    };
    this.retainSource(subscription.sourceKey, source);
    return source;
  }

  private retainSource(sourceKey: string, source: SourceRecord): void {
    const existing = this.sources.get(sourceKey);
    if (existing) {
      this.canonicalBytes -= existing.bytes;
      this.sources.delete(sourceKey);
    }
    while (this.sources.size > 0 && (this.sources.size >= this.budgets.maxSources
      || this.canonicalBytes + source.bytes > this.budgets.maxCanonicalBytes)) {
      const victimKey = this.sources.keys().next().value as string | undefined;
      if (!victimKey) break;
      const victim = this.sources.get(victimKey)!;
      this.canonicalBytes -= victim.bytes;
      this.sources.delete(victimKey);
    }
    this.sources.set(sourceKey, source);
    this.canonicalBytes += source.bytes;
  }

  private drop(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  private error(
    subscriptionId: string,
    code: DetailErrorCode,
    message: string,
    retryable: boolean,
    fence: BackendDetailFence,
  ): void {
    // The coordinator→host variant carries no requestId; the correlated RPC
    // already settled `{accepted:true}` and the stream error is the single
    // failure signal.
    this.options.emit({ kind: 'detail.error', subscriptionId, code, message, retryable, fence });
  }
}

export class DurableDetailNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableDetailNotFoundError';
  }
}

export class DurableDetailNotAddressableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableDetailNotAddressableError';
  }
}

function canonicalSerialization(value: unknown): string | undefined {
  try {
    const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;
    if (!isJsonSafeValue(roundTripped)) return undefined;
    return JSON.stringify(roundTripped);
  } catch {
    return undefined;
  }
}

function stableRevision(messageId: string, toolCallId: string): number {
  return createHash('sha256').update(messageId).update('\0').update(toolCallId).digest().readUInt32BE(0);
}

function stableSegmentId(sourceKey: string, revision: number, totalBytes: number): string {
  return createHash('sha256').update(sourceKey).update(':').update(String(revision))
    .update(':').update(String(totalBytes)).digest('hex').slice(0, 32);
}

function sourceKeyOf(sessionPath: string, messageId: string, toolCallId: string): string {
  return `${sessionPath}\u0000${messageId}\u0000${toolCallId}`;
}

function addressKey(address: LiveSubagentDetailAddress): string {
  return JSON.stringify([address.sessionPath, address.rootToolCallId, address.lineage]);
}

function clampPageBytes(requested: number, maximum: number): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) return Math.min(DEFAULT_DURABLE_DETAIL_PAGE_BYTES, maximum);
  return Math.max(MIN_DURABLE_DETAIL_PAGE_BYTES, Math.min(requested, maximum, MAX_DURABLE_DETAIL_PAGE_BYTES));
}

function validateBudgets(value: DurableDetailStoreBudgets): DurableDetailStoreBudgets {
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Durable detail budget ${key} must be a positive safe integer.`);
    }
  }
  if (value.maxPageBytes < MIN_DURABLE_DETAIL_PAGE_BYTES || value.maxPageBytes > MAX_DURABLE_DETAIL_PAGE_BYTES) {
    throw new Error('Durable detail page budget is outside the envelope range.');
  }
  return value;
}

function cloneAddress(address: LiveSubagentDetailAddress): LiveSubagentDetailAddress {
  return { ...address, lineage: address.lineage.map((identity) => ({ ...identity })) };
}

function sameAddress(left: LiveSubagentDetailAddress, right: LiveSubagentDetailAddress): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
