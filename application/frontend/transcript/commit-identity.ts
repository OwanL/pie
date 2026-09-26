/**
 * Bounded, revision-independent identities for transcript commit acknowledgement.
 *
 * These values deliberately describe rendered transcript inputs rather than the
 * DOM. A caller builds an expected identity from host state and a displayed
 * identity from renderer-owned mount state; equality is safe only when both
 * identities are complete and the active leaf is actually mounted.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** The default keeps all identity work below the loaded transcript-window cap. */
export const TRANSCRIPT_COMMIT_IDENTITY_DEFAULT_BOUNDS = Object.freeze({
  textSampleChars: 192,
  structureRows: 256,
  liveTools: 256,
  terminalTools: 256,
});

export interface TranscriptCommitIdentityBounds {
  /** Maximum UTF-16 code units sampled from each region of a text value. */
  textSampleChars?: number;
  /** Maximum transcript rows inspected while creating the structure identity. */
  structureRows?: number;
  /** Maximum live tool executions inspected while creating the tool identity. */
  liveTools?: number;
  /** Maximum terminal tool revisions inspected while creating the tool identity. */
  terminalTools?: number;
}

interface ResolvedTranscriptCommitIdentityBounds {
  textSampleChars: number;
  structureRows: number;
  liveTools: number;
  terminalTools: number;
}

export interface BoundedTextIdentity {
  length: number;
  /** Non-cryptographic checksum of bounded head/middle/tail samples. */
  hash: string;
}

/**
 * A bounded collection checksum. `complete: false` is intentionally not
 * comparable: the unvisited suffix could differ, so it must not acknowledge a
 * commit. `totalCount` and `traversedCount` make that condition observable.
 */
export interface BoundedCommitAggregate {
  totalCount: number;
  traversedCount: number;
  complete: boolean;
  hash: string;
}

export interface TranscriptWindowIdentityInput {
  totalCount: number;
  loadedStart: number;
  loadedEnd: number;
  hasOlder: boolean;
  hasNewer: boolean;
  isPartial: boolean;
  hasUserMessages: boolean;
}

export type TranscriptWindowIdentity = TranscriptWindowIdentityInput;

/** Structure only: text, reasoning, and tool-result content belong elsewhere. */
export interface TranscriptStructureRowInput {
  messageId: string;
  role: string;
  status: string;
  partCount: number;
  toolCallCount: number;
  hasThinking: boolean;
  hasDraftingToolCall: boolean;
}

export interface TranscriptStructureIdentity {
  window: TranscriptWindowIdentity;
  rows: BoundedCommitAggregate;
}

/** The phase is intentionally extensible without changing the commit protocol. */
export type LiveToolPhase = string;

/** Live tool state is identified by execution, retry attempt, event sequence, and phase. */
export interface LiveToolExecutionIdentityInput {
  messageId: string;
  toolCallId: string;
  executionId: string;
  attempt: number;
  seq: number;
  phase: LiveToolPhase;
}

/** Terminal output stays bounded by a host-owned revision, never by result payload bytes. */
export interface TerminalToolRevisionIdentityInput {
  messageId: string;
  toolCallId: string;
  status: 'completed' | 'failed';
  revision: number;
}

export interface TranscriptToolIdentity {
  live: BoundedCommitAggregate;
  terminal: BoundedCommitAggregate;
}

export interface ExpectedActiveTranscriptContentInput {
  text: string;
  reasoning?: string;
}

export interface ActiveTranscriptContentIdentity {
  text: BoundedTextIdentity;
  reasoning: BoundedTextIdentity;
}

/** The leaf exists and its text/reasoning DOM is mounted. */
export interface MountedTranscriptLeafPolicy {
  kind: 'mounted';
}

/** The virtualizer deliberately has no DOM for this leaf. */
export interface OffscreenTranscriptLeafPolicy {
  kind: 'offscreen';
}

/** A summary is mounted, but the collapsed leaf content is intentionally absent. */
export interface CollapsedTranscriptLeafPolicy {
  kind: 'collapsed';
  collapsed: 'reasoning' | 'tool' | 'message';
}

/** The host/surface deliberately has no leaf DOM (including lazy host loading). */
export interface UnmountedTranscriptLeafPolicy {
  kind: 'unmounted';
  reason: 'lazy-host' | 'inactive-session' | 'not-loaded';
}

export type TranscriptLeafDisplayPolicy =
  | MountedTranscriptLeafPolicy
  | OffscreenTranscriptLeafPolicy
  | CollapsedTranscriptLeafPolicy
  | UnmountedTranscriptLeafPolicy;

/** Only the mounted variant can carry a claim about displayed text. */
export type DisplayedActiveTranscriptLeaf =
  | ({ policy: MountedTranscriptLeafPolicy } & ExpectedActiveTranscriptContentInput)
  | { policy: Exclude<TranscriptLeafDisplayPolicy, MountedTranscriptLeafPolicy> };

/**
 * Generation changes on every lazy TranscriptHost mount. A lazy host can never
 * acknowledge a displayed transcript, even if it previously mounted.
 */
export type TranscriptHostMountState =
  | { kind: 'lazy'; generation: number }
  | { kind: 'mounted'; generation: number };

export interface TranscriptCommitIdentityInput {
  window: TranscriptWindowIdentityInput;
  structureRows: readonly TranscriptStructureRowInput[];
  liveTools: readonly LiveToolExecutionIdentityInput[];
  terminalTools: readonly TerminalToolRevisionIdentityInput[];
  host: TranscriptHostMountState;
  bounds?: TranscriptCommitIdentityBounds;
}

export interface ExpectedTranscriptCommitIdentity extends TranscriptStructureIdentity {
  kind: 'expected';
  active: ActiveTranscriptContentIdentity;
  tools: TranscriptToolIdentity;
  host: TranscriptHostMountState;
}

export interface DisplayedTranscriptCommitIdentity extends TranscriptStructureIdentity {
  kind: 'displayed';
  active: { policy: TranscriptLeafDisplayPolicy; content: ActiveTranscriptContentIdentity | null };
  tools: TranscriptToolIdentity;
  host: TranscriptHostMountState;
}

export type TranscriptCommitIdentity = ExpectedTranscriptCommitIdentity | DisplayedTranscriptCommitIdentity;

/** Create the initial state before a lazy TranscriptHost module has mounted. */
export function createLazyTranscriptHostMount(generation = 0): TranscriptHostMountState {
  assertNonNegativeInteger('generation', generation);
  return { kind: 'lazy', generation };
}

/** Mark a lazy TranscriptHost as mounted, advancing its generation exactly once. */
export function mountTranscriptHost(previous: TranscriptHostMountState): TranscriptHostMountState {
  return { kind: 'mounted', generation: previous.generation + 1 };
}

/** Retain the generation while a mounted host is absent or loading again. */
export function unmountTranscriptHost(previous: TranscriptHostMountState): TranscriptHostMountState {
  return { kind: 'lazy', generation: previous.generation };
}

/** Hash text without traversing more than head + middle + tail sample budgets. */
export function boundedTextIdentity(value: string, sampleChars: number = TRANSCRIPT_COMMIT_IDENTITY_DEFAULT_BOUNDS.textSampleChars): BoundedTextIdentity {
  assertNonNegativeInteger('sampleChars', sampleChars);
  const sample = boundedTextSample(value, sampleChars);
  return { length: value.length, hash: hashString(`${value.length}\u0000${sample}`) };
}

export function equalBoundedTextIdentity(left: BoundedTextIdentity, right: BoundedTextIdentity): boolean {
  return left.length === right.length && left.hash === right.hash;
}

export function createTranscriptWindowIdentity(input: TranscriptWindowIdentityInput): TranscriptWindowIdentity {
  assertNonNegativeInteger('totalCount', input.totalCount);
  assertNonNegativeInteger('loadedStart', input.loadedStart);
  assertNonNegativeInteger('loadedEnd', input.loadedEnd);
  if (input.loadedStart > input.loadedEnd || input.loadedEnd > input.totalCount) {
    throw new RangeError('Transcript window must satisfy 0 <= loadedStart <= loadedEnd <= totalCount');
  }
  return {
    totalCount: input.totalCount,
    loadedStart: input.loadedStart,
    loadedEnd: input.loadedEnd,
    hasOlder: input.hasOlder,
    hasNewer: input.hasNewer,
    isPartial: input.isPartial,
    hasUserMessages: input.hasUserMessages,
  };
}

export function createTranscriptStructureIdentity(
  window: TranscriptWindowIdentityInput,
  rows: readonly TranscriptStructureRowInput[],
  maxRows: number = TRANSCRIPT_COMMIT_IDENTITY_DEFAULT_BOUNDS.structureRows,
): TranscriptStructureIdentity {
  return {
    window: createTranscriptWindowIdentity(window),
    rows: aggregateTranscriptCommitIdentity(rows, maxRows, (row) => JSON.stringify([
      row.messageId,
      row.role,
      row.status,
      row.partCount,
      row.toolCallCount,
      row.hasThinking,
      row.hasDraftingToolCall,
    ])),
  };
}

export function createTranscriptToolIdentity(
  liveTools: readonly LiveToolExecutionIdentityInput[],
  terminalTools: readonly TerminalToolRevisionIdentityInput[],
  bounds: Pick<ResolvedTranscriptCommitIdentityBounds, 'liveTools' | 'terminalTools'> = TRANSCRIPT_COMMIT_IDENTITY_DEFAULT_BOUNDS,
): TranscriptToolIdentity {
  return {
    live: aggregateTranscriptCommitIdentity(liveTools, bounds.liveTools, (tool) => JSON.stringify([
      tool.messageId,
      tool.toolCallId,
      tool.executionId,
      tool.attempt,
      tool.seq,
      tool.phase,
    ])),
    terminal: aggregateTranscriptCommitIdentity(terminalTools, bounds.terminalTools, (tool) => JSON.stringify([
      tool.messageId,
      tool.toolCallId,
      tool.status,
      tool.revision,
    ])),
  };
}

/**
 * Aggregate at most `maxItems` values. The serializer is called at most that
 * many times; callers can assert this property in tests without a DOM.
 */
export function aggregateTranscriptCommitIdentity<T>(
  values: readonly T[],
  maxItems: number,
  serialize: (value: T, index: number) => string,
): BoundedCommitAggregate {
  assertNonNegativeInteger('maxItems', maxItems);
  const traversedCount = Math.min(values.length, maxItems);
  let hash = FNV_OFFSET;
  hash = hashInto(hash, `${values.length}\u0000${traversedCount}\u0000`);
  for (let index = 0; index < traversedCount; index += 1) {
    hash = hashInto(hash, `${index}\u0000${serialize(values[index]!, index)}\u0000`);
  }
  return {
    totalCount: values.length,
    traversedCount,
    complete: traversedCount === values.length,
    hash: hashToString(hash),
  };
}

export function equalBoundedCommitAggregate(left: BoundedCommitAggregate, right: BoundedCommitAggregate): boolean {
  return left.complete
    && right.complete
    && left.totalCount === right.totalCount
    && left.traversedCount === right.traversedCount
    && left.hash === right.hash;
}

export function createExpectedTranscriptCommitIdentity(
  input: TranscriptCommitIdentityInput & { active: ExpectedActiveTranscriptContentInput },
): ExpectedTranscriptCommitIdentity {
  const bounds = resolveBounds(input.bounds);
  const structure = createTranscriptStructureIdentity(input.window, input.structureRows, bounds.structureRows);
  return {
    kind: 'expected',
    ...structure,
    active: activeContentIdentity(input.active, bounds.textSampleChars),
    tools: createTranscriptToolIdentity(input.liveTools, input.terminalTools, bounds),
    host: normalizeHostMount(input.host),
  };
}

export function createDisplayedTranscriptCommitIdentity(
  input: TranscriptCommitIdentityInput & { active: DisplayedActiveTranscriptLeaf },
): DisplayedTranscriptCommitIdentity {
  const bounds = resolveBounds(input.bounds);
  const host = normalizeHostMount(input.host);
  const policy = input.active.policy;
  if (isMountedDisplayedActiveLeaf(input.active) && host.kind !== 'mounted') {
    throw new Error('A lazy TranscriptHost cannot claim mounted displayed content');
  }
  const structure = createTranscriptStructureIdentity(input.window, input.structureRows, bounds.structureRows);
  return {
    kind: 'displayed',
    ...structure,
    active: {
      policy,
      content: isMountedDisplayedActiveLeaf(input.active)
        ? activeContentIdentity(input.active, bounds.textSampleChars)
        : null,
    },
    tools: createTranscriptToolIdentity(input.liveTools, input.terminalTools, bounds),
    host,
  };
}

/**
 * A displayed identity only matches an expected identity when all bounded
 * traversals completed, both hosts are the same mounted generation, and the
 * active leaf owns mounted text/reasoning content.
 */
export function equalTranscriptCommitIdentity(
  expected: ExpectedTranscriptCommitIdentity,
  displayed: DisplayedTranscriptCommitIdentity,
): boolean {
  if (expected.host.kind !== 'mounted' || displayed.host.kind !== 'mounted'
    || expected.host.generation !== displayed.host.generation
    || displayed.active.policy.kind !== 'mounted'
    || displayed.active.content === null) {
    return false;
  }

  return equalWindowIdentity(expected.window, displayed.window)
    && equalBoundedCommitAggregate(expected.rows, displayed.rows)
    && equalBoundedTextIdentity(expected.active.text, displayed.active.content.text)
    && equalBoundedTextIdentity(expected.active.reasoning, displayed.active.content.reasoning)
    && equalBoundedCommitAggregate(expected.tools.live, displayed.tools.live)
    && equalBoundedCommitAggregate(expected.tools.terminal, displayed.tools.terminal);
}

function isMountedDisplayedActiveLeaf(value: DisplayedActiveTranscriptLeaf): value is { policy: MountedTranscriptLeafPolicy } & ExpectedActiveTranscriptContentInput {
  return value.policy.kind === 'mounted';
}

function activeContentIdentity(input: ExpectedActiveTranscriptContentInput, sampleChars: number): ActiveTranscriptContentIdentity {
  return {
    text: boundedTextIdentity(input.text, sampleChars),
    reasoning: boundedTextIdentity(input.reasoning ?? '', sampleChars),
  };
}

function resolveBounds(bounds: TranscriptCommitIdentityBounds | undefined): ResolvedTranscriptCommitIdentityBounds {
  const resolved = {
    ...TRANSCRIPT_COMMIT_IDENTITY_DEFAULT_BOUNDS,
    ...bounds,
  };
  assertNonNegativeInteger('textSampleChars', resolved.textSampleChars);
  assertNonNegativeInteger('structureRows', resolved.structureRows);
  assertNonNegativeInteger('liveTools', resolved.liveTools);
  assertNonNegativeInteger('terminalTools', resolved.terminalTools);
  return resolved;
}

function normalizeHostMount(host: TranscriptHostMountState): TranscriptHostMountState {
  assertNonNegativeInteger('host.generation', host.generation);
  return host.kind === 'mounted'
    ? { kind: 'mounted', generation: host.generation }
    : { kind: 'lazy', generation: host.generation };
}

function equalWindowIdentity(left: TranscriptWindowIdentity, right: TranscriptWindowIdentity): boolean {
  return left.totalCount === right.totalCount
    && left.loadedStart === right.loadedStart
    && left.loadedEnd === right.loadedEnd
    && left.hasOlder === right.hasOlder
    && left.hasNewer === right.hasNewer
    && left.isPartial === right.isPartial
    && left.hasUserMessages === right.hasUserMessages;
}

function boundedTextSample(value: string, sampleChars: number): string {
  if (value.length <= sampleChars * 3) return value;
  const middleStart = Math.max(0, Math.floor(value.length / 2) - Math.floor(sampleChars / 2));
  return [
    value.slice(0, sampleChars),
    value.slice(middleStart, middleStart + sampleChars),
    value.slice(-sampleChars),
  ].join('\u0000');
}

function hashString(value: string): string {
  return hashToString(hashInto(FNV_OFFSET, value));
}

function hashInto(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, FNV_PRIME);
  }
  return next;
}

function hashToString(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
