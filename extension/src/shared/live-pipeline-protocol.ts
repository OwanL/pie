import type { ChatMessage, ToolCall } from './protocol/messages.js';

/** Transient live-pipeline protocol. Nothing in this file is a durable event log. */
export const LIVE_PIPELINE_PROTOCOL_VERSION = 4;

export const LIVE_PIPELINE_LIMITS = {
  textPartBytes: 512 * 1024,
  reasoningPartBytes: 512 * 1024,
  toolDraftBytes: 64 * 1024,
  previewBytes: 32 * 1024,
  toolPreviewAggregateBytes: 192 * 1024,
  toolInputAggregateBytes: 192 * 1024,
  toolTerminalAggregateBytes: 512 * 1024,
  checkpointBytes: 2 * 1024 * 1024,
  checkpointTools: 64,
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
  | { kind: 'subagent'; mode: 'single' | 'parallel' | 'chain'; children: SubagentChildPreview[]; omittedChildren: number }
  | { kind: 'question'; promptSummary: string; optionCount: number }
  | { kind: 'generic'; summary: string };

export interface SubagentChildPreview {
  id: string;
  phase: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  agent?: string;
  task?: string;
  summary?: string;
  exitCode?: number;
  model?: string;
  provider?: string;
  activityDetail?: string;
  activitySince?: number;
  lastProgressAt?: number;
  inactivityBudgetMs?: number;
  streaming?: boolean;
  streamingText?: string;
  streamingReasoning?: string;
  runningTools?: string[];
}

export type LiveAssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; toolCallId: string };

export interface LiveToolCallDraft {
  toolCallId: string;
  name: string;
  argumentsJson: string;
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
  sessionPath: string;
  canonicalMessageId: string;
  seq: number;
  checkpointSeq: number;
  phase: LiveTurnPhase;
  startedAt: number;
  phaseSince: number;
  lastSemanticProgressAt: number;
  inactivityBudgetMs?: number;
  parts: LiveAssistantPart[];
  draftingToolCall?: LiveToolCallDraft;
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
  /** Present only after the SDK durable toolResult append is confirmed. */
  terminal?: {
    status: 'completed' | 'failed';
    result: unknown;
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
  turnId: string;
  attemptId: string;
  seq: number;
  occurredAt: number;
}

export type TurnSemanticEnvelope =
  | (SemanticEnvelopeBase & {
      kind: 'turn.started';
      canonicalMessageId: string;
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
  | (SemanticEnvelopeBase & { kind: 'tool.progress'; executionId: string; preview: ToolPreview })
  | (SemanticEnvelopeBase & {
      kind: 'tool.terminal';
      executionId: string;
      status: 'completed' | 'failed';
      result: unknown;
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
    || typeof value.turnId !== 'string'
    || typeof value.attemptId !== 'string'
    || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
    || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)
    || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'turn.started': return typeof value.canonicalMessageId === 'string' && isFiniteNumber(value.startedAt);
    case 'turn.phase': return isLiveTurnPhase(value.phase) && value.phase !== 'reconciling_gap' && optionalFiniteNumber(value.inactivityBudgetMs);
    case 'turn.text': case 'turn.reasoning': return typeof value.delta === 'string';
    case 'turn.toolDraft': return isRecord(value.draft) && typeof value.draft.toolCallId === 'string' && typeof value.draft.name === 'string' && typeof value.draft.argumentsJson === 'string';
    case 'turn.extensionUi': return typeof value.uiRequestId === 'string' && (value.action === 'opened' || value.action === 'closed');
    case 'tool.started': return typeof value.executionId === 'string' && (value.parentExecutionId === null || typeof value.parentExecutionId === 'string') && typeof value.rootExecutionId === 'string' && typeof value.toolCallId === 'string' && typeof value.name === 'string' && isFiniteNumber(value.startedAt) && (value.parallelGroupId === undefined || typeof value.parallelGroupId === 'string');
    case 'tool.progress': return typeof value.executionId === 'string' && isToolPreview(value.preview);
    case 'tool.terminal': return typeof value.executionId === 'string' && (value.status === 'completed' || value.status === 'failed') && typeof value.durableEntryId === 'string' && value.durableEntryId.length > 0 && optionalFiniteNumber(value.durationMs);
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

export function isToolPreview(value: unknown): value is ToolPreview {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text': return typeof value.tail === 'string' && isFiniteNumber(value.omittedChars);
    case 'command': return typeof value.commandSummary === 'string' && (value.outputTail === undefined || typeof value.outputTail === 'string') && isFiniteNumber(value.omittedChars);
    case 'subagent': return Array.isArray(value.children) && isFiniteNumber(value.omittedChildren);
    case 'question': return typeof value.promptSummary === 'string' && isFiniteNumber(value.optionCount);
    case 'generic': return typeof value.summary === 'string';
    default: return false;
  }
}

function isLiveTurnPhase(value: unknown): value is LiveTurnPhase {
  return ['queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool', 'waiting_input', 'retry_wait', 'aborting', 'reconciling_gap'].includes(String(value));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function optionalFiniteNumber(value: unknown): boolean { return value === undefined || isFiniteNumber(value); }
