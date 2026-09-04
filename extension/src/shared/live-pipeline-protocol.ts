import type { ChatMessage, ToolCall } from './protocol/messages.js';
import type { ThinkingLevel } from './protocol/models.js';
import type { LiveSubagentDetailAddress, SubagentChildIdentity } from './protocol/subagent-detail.js';
import { isThinkingLevel } from './thinking-level.js';
import {
  DEFAULT_JSON_PATCH_LIMITS,
  isJsonSafeValue,
  type JsonStructuralPatchOperation,
} from './json-structural-patch.js';

/** Transient live-pipeline protocol. Nothing in this file is a durable event log. */
export const LIVE_PIPELINE_PROTOCOL_VERSION = 7;

export const LIVE_PIPELINE_LIMITS = {
  textPartBytes: 512 * 1024,
  reasoningPartBytes: 512 * 1024,
  toolDraftBytes: 64 * 1024,
  toolDraftAggregateBytes: 2 * 1024 * 1024,
  toolInputBytes: 3 * 1024,
  // Subagent previews carry the complete recursively renderable child transcript.
  // Generic tool normalizers remain independently tail-bounded; this larger
  // ceiling exists so transparency is not traded away for transport size.
  previewBytes: 30 * 1024 * 1024,
  toolPreviewAggregateBytes: 30 * 1024 * 1024,
  // Recovery checkpoints carry the backend's complete assembled live state.
  // The canonical aggregate includes JSON escaping and the entire structural
  // envelope; 2 MiB remains for the JSON-RPC response under the shared 32 MiB
  // record ceiling.
  checkpointBytes: 30 * 1024 * 1024,
  terminalCheckpointBytes: 30 * 1024 * 1024,
  pendingOwnerEvents: 64,
  pendingOwnerBytes: 2 * 1024 * 1024,
  extensionUiRequests: 32,
  queuedMessageCorrelations: 256,
  terminalTombstones: 128,
} as const;

export type LiveTurnPhase =
  | 'queued'
  | 'preparing'
  | 'waiting_provider'
  | 'streaming'
  | 'running_tool'
  | 'waiting_input'
  | 'retry_wait'
  | 'aborting'
  | 'reconciling_gap';

export type LiveToolPhase =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_input'
  | 'retry_wait'
  | 'aborting';

export type ToolPreview =
  | { kind: 'text'; tail: string; omittedChars: number }
  | { kind: 'command'; commandSummary: string; outputTail?: string; omittedChars: number }
  | {
      kind: 'subagent';
      mode: 'single' | 'parallel' | 'chain';
      children: SubagentChildPreview[];
      omittedChildren: number;
      /** Compact terminal-only accounting sideband. Nested transcripts stay
       * out of the live/UI payload while every recursive child remains billed. */
      billing?: SubagentBillingEntry[];
    }
  | { kind: 'question'; promptSummary: string; optionCount: number }
  | { kind: 'generic'; summary: string };

export interface SubagentChildPreview {
  id: string;
  childId?: string;
  attemptId?: string;
  lineage?: readonly SubagentChildIdentity[];
  /** False for synthesized legacy display identity. Such cards may render
   * durable history but cannot own a live subscription. */
  liveAddressable?: boolean;
  detailAddress?: LiveSubagentDetailAddress;
  phase: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  agent?: string;
  task?: string;
  /** Parent-context mode requested for this child handoff. */
  parentUserContextMode?: 'latest' | 'all';
  /** Exact bounded parent-context packet inserted into the child prompt. */
  parentUserContext?: string;
  summary?: string;
  exitCode?: number;
  model?: string;
  selectedModel?: string;
  provider?: string;
  thinkingLevel?: string;
  activityDetail?: string;
  activitySince?: number;
  startedAt?: number;
  completedAt?: number;
  lastProgressAt?: number;
  inactivityBudgetMs?: number;
  streaming?: boolean;
  streamingText?: string;
  streamingReasoning?: string;
  /** Cumulative estimated output tokens produced by this child and its nested
   * descendants. Kept separately from render content so live-rate measurement
   * stays monotonic without repeatedly tokenizing the complete transcript. */
  cumulativeOutputTokens?: number;
  runningTools?: string[];
  /** Compatibility-only field for old durable/checkpoint parsing. New ordinary
   * live producers always omit it. */
  messages?: unknown[];
  finalOutput?: string;
  transcriptCompacted?: boolean;
  contextWindow?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens?: number;
    cost?: number;
    turns?: number;
  };
  selectionPool?: string[];
  retryCount?: number;
  stopReason?: string;
  errorMessage?: string;
  stderr?: string;
}

export interface SubagentBillingUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: number;
}

export interface SubagentBillingAttempt {
  attemptId: string;
  model?: string;
  provider?: string;
  usage?: SubagentBillingUsage;
  providerResponseObserved?: boolean;
  outcome?: 'success' | 'failure' | 'aborted';
  startedAt?: number;
  completedAt?: number;
}

export interface SubagentBillingInvocation extends SubagentBillingAttempt {
  invocationId: string;
}

export interface SubagentBillingEntry {
  /** Stable recursive position within the terminal subagent result. */
  path: string;
  model?: string;
  selectedModel?: string;
  provider?: string;
  /** Epoch milliseconds of the latest observed child provider response. */
  occurredAt?: number;
  usage?: SubagentBillingUsage;
  attempts?: SubagentBillingAttempt[];
  invocations?: SubagentBillingInvocation[];
  /** Observable responses omitted from bounded transport; consumers emit one
   * explicit gap settlement per omitted response. */
  omittedInvocationCount?: number;
}

export type LiveAssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; toolCallId: string };

export interface LiveToolCallDraft {
  toolCallId: string;
  name: string;
  /** Provider-emitted JSON text. It may be incomplete while drafting and must
   * not be parsed as authoritative tool input. */
  argumentsJson: string;
  phase: 'drafting' | 'ready';
}

export interface ToolBlocker {
  kind: 'provider' | 'input' | 'retry' | 'abort';
  detail?: string;
}

export interface GapReconciliationState {
  expectedSeq: number;
  observedSeq: number;
  attempts: number;
  status: 'requested' | 'failed' | 'unrecovered_protocol_fault';
}

export interface LiveTurnRecord {
  turnId: string;
  attemptId: string;
  requestId: string;
  /** Stable mutation identity; distinct from request/turn/attempt IDs. */
  operationId?: string;
  sessionPath: string;
  canonicalMessageId: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  seq: number;
  checkpointSeq: number;
  phase: LiveTurnPhase;
  startedAt: number;
  phaseSince: number;
  lastSemanticProgressAt: number;
  inactivityBudgetMs?: number;
  parts: LiveAssistantPart[];
  /** Cached UTF-8 bytes by streamed part kind; maintained incrementally. */
  textBytes: number;
  reasoningBytes: number;
  /** Cached aggregate of active tool preview JSON bytes for this turn. */
  aggregatePreviewBytes: number;
  /** Backend-calculated conservative UTF-8 bytes for the complete active
   * recovery checkpoint after the latest accepted semantic observation. */
  checkpointBytes: number;
  /** Ordered multi-tool drafts keyed by stable provider tool-call ID. */
  toolDraftsByCallId: Record<string, LiveToolCallDraft>;
  /** Cached aggregate UTF-8 bytes of draft IDs, names, and raw arguments. */
  aggregateToolDraftBytes: number;
  toolExecutionIds: string[];
  pendingExtensionUiRequestIds: string[];
  reconciliation?: GapReconciliationState;
}

export interface LiveToolRecord {
  executionId: string;
  parentExecutionId: string | null;
  rootExecutionId: string;
  turnId: string;
  transcriptToolCallId: string;
  attemptId: string;
  seq: number;
  phase: LiveToolPhase;
  name: string;
  immutableInput: unknown;
  parallelGroupId?: string;
  startedAt: number;
  phaseSince: number;
  lastProgressAt: number;
  inactivityBudgetMs?: number;
  detail?: string;
  blocker?: ToolBlocker;
  preview?: ToolPreview;
  /** Cached JSON byte count of preview; zero after terminal settlement. */
  previewBytes: number;
  /** Monotonic revision of the assembled preview, independent of turn seq. */
  progressRevision?: number;
  /** Transient SDK execution boundary. This changes render lifecycle only; it
   * is not durability evidence and must not enter settled/restart state. */
  executionEnd?: {
    status: 'completed' | 'failed';
    durationMs?: number;
  };
  /** Present only after the SDK durable toolResult append is confirmed. */
  terminal?: {
    status: 'completed' | 'failed';
    result: unknown;
    resultBytes: number;
    durationMs?: number;
    durableEntryId: string;
  };
}

export interface TerminalAttemptTombstone {
  sessionPath: string;
  turnId: string;
  attemptId: string;
  finalSeq: number;
  terminalKind: 'completed' | 'interrupted' | 'error';
  expiresAt: number;
}

export interface LivePipelineState {
  turnsBySession: Record<string, LiveTurnRecord>;
  toolsByExecutionId: Record<string, LiveToolRecord>;
  pendingOwnerEvents: Record<string, TurnSemanticEnvelope[]>;
  terminalAttempts: Record<string, TerminalAttemptTombstone>;
  revisionBySession: Record<string, number>;
}

export interface SemanticEnvelopeBase {
  protocolVersion: number;
  sessionPath: string;
  requestId: string;
  /** Stable message.send mutation identity, when initiated by a current host. */
  operationId?: string;
  turnId: string;
  attemptId: string;
  seq: number;
  occurredAt: number;
  /** Canonical conservative bytes of the complete active checkpoint after this
   * observation. Progress consumers trust this instead of reserializing the
   * reconstructed preview. */
  checkpointBytes: number;
}

export type TurnSemanticEnvelope =
  | (SemanticEnvelopeBase & {
      kind: 'turn.started';
      canonicalMessageId: string;
      modelId?: string;
      provider?: string;
      thinkingLevel?: ThinkingLevel;
      startedAt: number;
    })
  | (SemanticEnvelopeBase & { kind: 'turn.phase'; phase: Exclude<LiveTurnPhase, 'reconciling_gap'>; inactivityBudgetMs?: number })
  | (SemanticEnvelopeBase & { kind: 'turn.text'; delta: string })
  | (SemanticEnvelopeBase & { kind: 'turn.reasoning'; delta: string })
  | (SemanticEnvelopeBase & { kind: 'turn.toolDraft'; draft: LiveToolCallDraft })
  | (SemanticEnvelopeBase & { kind: 'turn.extensionUi'; uiRequestId: string; action: 'opened' | 'closed' })
  | (SemanticEnvelopeBase & {
      kind: 'tool.started';
      executionId: string;
      parentExecutionId: string | null;
      rootExecutionId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      startedAt: number;
      parallelGroupId?: string;
    })
  | (SemanticEnvelopeBase & {
      kind: 'tool.progress';
      executionId: string;
      /** Turn sequence on which this replaceable progress range is based. */
      baseSeq: number;
      baseProgressRevision: number;
      progressRevision: number;
      /** Backend-calculated canonical preview bytes after this update. */
      previewBytes: number;
      /** Backend-calculated aggregate active-preview bytes after this update. */
      aggregatePreviewBytes: number;
      update:
        | { kind: 'snapshot'; preview: ToolPreview; operations?: JsonStructuralPatchOperation[] }
        | { kind: 'patch'; operations: JsonStructuralPatchOperation[] };
    })
  | (SemanticEnvelopeBase & {
      kind: 'tool.executionEnded';
      executionId: string;
      status: 'completed' | 'failed';
      durationMs?: number;
    })
  | (SemanticEnvelopeBase & {
      kind: 'tool.terminal';
      executionId: string;
      status: 'completed' | 'failed';
      result: unknown;
      resultBytes?: number;
      durationMs?: number;
      durableEntryId: string;
    })
  | (SemanticEnvelopeBase & { kind: 'observation.rejected'; reason: RejectedObservationReason })
  | (SemanticEnvelopeBase & {
      kind: 'turn.terminal';
      terminalKind: 'completed' | 'interrupted' | 'error';
      userInitiated?: boolean;
      reason?: string;
      durableMessage: ChatMessage;
      durableEntryId: string;
    });

export type RejectedObservationReason =
  | 'unsupported_observation'
  | 'malformed_observation'
  | 'malformed_payload'
  | 'owner_missing'
  | 'payload_oversize';

export type BoundedToolCheckpoint = LiveToolRecord;

export interface LiveTurnCheckpoint {
  protocolVersion: number;
  sessionPath: string;
  turnId: string;
  attemptId: string;
  checkpointSeq: number;
  phase: LiveTurnPhase;
  /** Cached conservative byte ceiling for this serialized checkpoint. */
  checkpointBytes: number;
  turn: LiveTurnRecord;
  tools: BoundedToolCheckpoint[];
  pendingExtensionUiRequestIds: string[];
  terminal?: ChatMessage;
}

export interface LiveLifecycleWatermark {
  sessionPath: string;
  requestId: string;
  turnId: string;
  attemptId: string;
  finalSeq: number;
  terminalKind: 'completed' | 'interrupted' | 'error';
}

export interface TranscriptView {
  messages: ChatMessage[];
  activeTurn: ChatMessage | null;
  liveTools: ToolCall[];
}

export function isTurnSemanticEnvelope(value: unknown): value is TurnSemanticEnvelope {
  if (!isRecord(value)
    || value.protocolVersion !== LIVE_PIPELINE_PROTOCOL_VERSION
    || typeof value.sessionPath !== 'string'
    || typeof value.requestId !== 'string'
    || (value.operationId !== undefined && typeof value.operationId !== 'string')
    || typeof value.turnId !== 'string'
    || typeof value.attemptId !== 'string'
    || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
    || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)
    || !optionalNonNegativeSafeInteger(value.checkpointBytes)
    || value.checkpointBytes === undefined
    || (value.checkpointBytes as number) > LIVE_PIPELINE_LIMITS.checkpointBytes
    || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'turn.started': return typeof value.canonicalMessageId === 'string'
      && (value.modelId === undefined || typeof value.modelId === 'string')
      && (value.provider === undefined || typeof value.provider === 'string')
      && (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel))
      && isFiniteNumber(value.startedAt);
    case 'turn.phase': return isLiveTurnPhase(value.phase) && value.phase !== 'reconciling_gap' && optionalFiniteNumber(value.inactivityBudgetMs);
    case 'turn.text': case 'turn.reasoning': return typeof value.delta === 'string';
    case 'turn.toolDraft': return isRecord(value.draft)
      && typeof value.draft.toolCallId === 'string' && value.draft.toolCallId.length > 0
      && typeof value.draft.name === 'string' && value.draft.name.length > 0
      && typeof value.draft.argumentsJson === 'string'
      && (value.draft.phase === 'drafting' || value.draft.phase === 'ready');
    case 'turn.extensionUi': return typeof value.uiRequestId === 'string' && (value.action === 'opened' || value.action === 'closed');
    case 'tool.started': return typeof value.executionId === 'string' && (value.parentExecutionId === null || typeof value.parentExecutionId === 'string') && typeof value.rootExecutionId === 'string' && typeof value.toolCallId === 'string' && typeof value.name === 'string' && isFiniteNumber(value.startedAt) && (value.parallelGroupId === undefined || typeof value.parallelGroupId === 'string');
    case 'tool.progress': return typeof value.executionId === 'string'
      && Number.isSafeInteger(value.baseSeq) && (value.baseSeq as number) >= 1
      && Number.isSafeInteger(value.baseProgressRevision) && (value.baseProgressRevision as number) >= 0
      && Number.isSafeInteger(value.progressRevision) && (value.progressRevision as number) > (value.baseProgressRevision as number)
      && isNonNegativeSafeInteger(value.previewBytes)
      && isNonNegativeSafeInteger(value.aggregatePreviewBytes)
      && (value.seq as number) - (value.baseSeq as number)
        === (value.progressRevision as number) - (value.baseProgressRevision as number)
      && isToolProgressUpdate(value.update);
    case 'tool.executionEnded': return typeof value.executionId === 'string'
      && (value.status === 'completed' || value.status === 'failed')
      && optionalFiniteNumber(value.durationMs);
    case 'tool.terminal': return typeof value.executionId === 'string'
      && (value.status === 'completed' || value.status === 'failed')
      && typeof value.durableEntryId === 'string' && value.durableEntryId.length > 0
      && optionalNonNegativeSafeInteger(value.resultBytes)
      && optionalFiniteNumber(value.durationMs);
    case 'observation.rejected': return ['unsupported_observation', 'malformed_observation', 'malformed_payload', 'owner_missing', 'payload_oversize'].includes(String(value.reason));
    case 'turn.terminal': return ['completed', 'interrupted', 'error'].includes(String(value.terminalKind))
      && (value.userInitiated === undefined || typeof value.userInitiated === 'boolean')
      && (value.reason === undefined || typeof value.reason === 'string')
      && typeof value.durableEntryId === 'string' && value.durableEntryId.length > 0
      && isRecord(value.durableMessage) && value.durableMessage.durableEntryId === value.durableEntryId;
    default: return false;
  }
}

export function isLiveLifecycleWatermark(value: unknown): value is LiveLifecycleWatermark {
  return isRecord(value)
    && typeof value.sessionPath === 'string'
    && typeof value.requestId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.attemptId === 'string'
    && Number.isSafeInteger(value.finalSeq) && (value.finalSeq as number) >= 1
    && ['completed', 'interrupted', 'error'].includes(String(value.terminalKind));
}

function isToolProgressUpdate(value: unknown): boolean {
  if (!isRecord(value) || (value.kind !== 'snapshot' && value.kind !== 'patch')) return false;
  if (value.kind === 'snapshot' && (!isToolPreview(value.preview) || !isJsonSafeValue(value.preview))) return false;
  if (!Array.isArray(value.operations) || value.operations.length > DEFAULT_JSON_PATCH_LIMITS.maxOperations) {
    return value.kind === 'snapshot' && value.operations === undefined;
  }
  return value.operations.every(isJsonPatchOperation);
}

function isJsonPatchOperation(value: unknown): value is JsonStructuralPatchOperation {
  if (!isRecord(value) || !Array.isArray(value.path)
    || value.path.length > DEFAULT_JSON_PATCH_LIMITS.maxPathSegments
    || !value.path.every((segment) => (typeof segment === 'string'
      && !['__proto__', 'prototype', 'constructor'].includes(segment))
      || (Number.isSafeInteger(segment) && (segment as number) >= 0))) return false;
  if (value.op === 'delete') return true;
  if (value.op === 'appendString') return typeof value.value === 'string';
  if (value.op === 'appendArray') return Array.isArray(value.value)
    && value.value.every((entry) => isJsonSafeValue(entry));
  return value.op === 'set' && isJsonSafeValue(value.value);
}

export function isToolPreview(value: unknown): value is ToolPreview {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text': return typeof value.tail === 'string' && isFiniteNumber(value.omittedChars);
    case 'command': return typeof value.commandSummary === 'string' && (value.outputTail === undefined || typeof value.outputTail === 'string') && isFiniteNumber(value.omittedChars);
    case 'subagent': return Array.isArray(value.children)
      && isFiniteNumber(value.omittedChildren)
      && (value.billing === undefined || (Array.isArray(value.billing) && value.billing.every(isSubagentBillingEntry)));
    case 'question': return typeof value.promptSummary === 'string' && isFiniteNumber(value.optionCount);
    case 'generic': return typeof value.summary === 'string';
    default: return false;
  }
}

function isSubagentBillingUsage(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNumber(value.input)
    && isFiniteNumber(value.output)
    && isFiniteNumber(value.cacheRead)
    && isFiniteNumber(value.cacheWrite)
    && optionalFiniteNumber(value.totalTokens)
    && (value.cost === undefined || isFiniteNumber(value.cost));
}

function isSubagentBillingAttempt(value: unknown, requireInvocationId = false): boolean {
  return isRecord(value)
    && typeof value.attemptId === 'string'
    && (!requireInvocationId || typeof value.invocationId === 'string')
    && (value.model === undefined || typeof value.model === 'string')
    && (value.provider === undefined || typeof value.provider === 'string')
    && (value.usage === undefined || isSubagentBillingUsage(value.usage))
    && (value.providerResponseObserved === undefined || typeof value.providerResponseObserved === 'boolean')
    && (value.outcome === undefined || value.outcome === 'success' || value.outcome === 'failure' || value.outcome === 'aborted')
    && optionalFiniteNumber(value.startedAt)
    && optionalFiniteNumber(value.completedAt);
}

function isSubagentBillingEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.path !== 'string'
    || (value.usage !== undefined && !isSubagentBillingUsage(value.usage))) return false;
  if (value.model !== undefined && typeof value.model !== 'string') return false;
  if (value.selectedModel !== undefined && typeof value.selectedModel !== 'string') return false;
  if (value.provider !== undefined && typeof value.provider !== 'string') return false;
  if (value.occurredAt !== undefined && !isFiniteNumber(value.occurredAt)) return false;
  return (value.attempts === undefined || (Array.isArray(value.attempts)
    && value.attempts.every((attempt) => isSubagentBillingAttempt(attempt))))
    && (value.invocations === undefined || (Array.isArray(value.invocations)
      && value.invocations.every((invocation) => isSubagentBillingAttempt(invocation, true))))
    && (value.omittedInvocationCount === undefined || isNonNegativeSafeInteger(value.omittedInvocationCount));
}

function isLiveTurnPhase(value: unknown): value is LiveTurnPhase {
  return ['queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool', 'waiting_input', 'retry_wait', 'aborting', 'reconciling_gap'].includes(String(value));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function optionalFiniteNumber(value: unknown): boolean { return value === undefined || isFiniteNumber(value); }
function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function optionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeSafeInteger(value);
}
