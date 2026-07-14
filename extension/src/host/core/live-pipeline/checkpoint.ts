import {
  LIVE_PIPELINE_LIMITS,
  LIVE_PIPELINE_PROTOCOL_VERSION,
  type LivePipelineState,
  type LiveToolPhase,
  type LiveTurnCheckpoint,
  type LiveTurnPhase,
} from '../../../shared/live-pipeline-protocol.js';
import { incrementLiveRevision, pendingOwnerKey } from './model.js';

export type CheckpointApplyResult =
  | { classification: 'applied'; state: LivePipelineState }
  | { classification: 'stale'; state: LivePipelineState }
  | { classification: 'mismatch' | 'oversize' | 'malformed'; state: LivePipelineState };

/** Authoritatively replace one transient attempt from a bounded checkpoint. */
export function applyLiveTurnCheckpoint(
  current: LivePipelineState,
  checkpoint: LiveTurnCheckpoint,
): CheckpointApplyResult {
  if (!isCheckpointShape(checkpoint)) return { classification: 'malformed', state: current };
  let encodedBytes: number;
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');
  } catch {
    return { classification: 'malformed', state: current };
  }
  if (encodedBytes > LIVE_PIPELINE_LIMITS.checkpointBytes
    || checkpoint.tools.length > LIVE_PIPELINE_LIMITS.checkpointTools) {
    return { classification: 'oversize', state: current };
  }
  if (checkpoint.protocolVersion !== LIVE_PIPELINE_PROTOCOL_VERSION
    || !Number.isSafeInteger(checkpoint.checkpointSeq)
    || checkpoint.checkpointSeq < 0
    || checkpoint.turn.sessionPath !== checkpoint.sessionPath
    || checkpoint.turn.turnId !== checkpoint.turnId
    || checkpoint.turn.attemptId !== checkpoint.attemptId
    || checkpoint.turn.seq !== checkpoint.checkpointSeq) {
    return { classification: 'malformed', state: current };
  }
  const bounds = validateCheckpointPayload(checkpoint);
  if (bounds !== 'valid') return { classification: bounds, state: current };

  const existing = current.turnsBySession[checkpoint.sessionPath];
  if (existing) {
    if (existing.turnId !== checkpoint.turnId || existing.attemptId !== checkpoint.attemptId) {
      return { classification: 'mismatch', state: current };
    }
    if (checkpoint.checkpointSeq < existing.checkpointSeq) {
      return { classification: 'stale', state: current };
    }
  }

  const tools = { ...current.toolsByExecutionId };
  if (existing) {
    for (const executionId of existing.toolExecutionIds) delete tools[executionId];
  }
  for (const tool of checkpoint.tools) {
    if (tool.turnId !== checkpoint.turnId || tool.attemptId !== checkpoint.attemptId) {
      return { classification: 'malformed', state: current };
    }
    tools[tool.executionId] = tool;
  }

  const key = pendingOwnerKey(checkpoint.turnId, checkpoint.attemptId);
  const newerPending = (current.pendingOwnerEvents[key] ?? [])
    .filter((event) => event.seq > checkpoint.checkpointSeq)
    .sort((left, right) => left.seq - right.seq);
  const pendingOwnerEvents = { ...current.pendingOwnerEvents };
  if (newerPending.length > 0) pendingOwnerEvents[key] = newerPending;
  else delete pendingOwnerEvents[key];

  const turn = {
    ...checkpoint.turn,
    phase: checkpoint.phase,
    checkpointSeq: checkpoint.checkpointSeq,
    pendingExtensionUiRequestIds: [...checkpoint.pendingExtensionUiRequestIds],
    reconciliation: undefined,
  };
  let state: LivePipelineState = {
    ...current,
    turnsBySession: { ...current.turnsBySession, [checkpoint.sessionPath]: turn },
    toolsByExecutionId: tools,
    pendingOwnerEvents,
  };
  state = incrementLiveRevision(state, checkpoint.sessionPath);
  return { classification: 'applied', state };
}

function isCheckpointShape(value: unknown): value is LiveTurnCheckpoint {
  if (!isRecord(value)
    || !isRecord(value.turn)
    || !Array.isArray(value.tools)
    || !Array.isArray(value.pendingExtensionUiRequestIds)
    || !value.pendingExtensionUiRequestIds.every((id) => typeof id === 'string')
    || !Array.isArray(value.turn.parts)
    || !Array.isArray(value.turn.toolExecutionIds)
    || !value.turn.toolExecutionIds.every((id) => typeof id === 'string')
    || !Array.isArray(value.turn.pendingExtensionUiRequestIds)
    || !value.turn.pendingExtensionUiRequestIds.every((id) => typeof id === 'string')
    || typeof value.protocolVersion !== 'number'
    || typeof value.sessionPath !== 'string'
    || typeof value.turnId !== 'string'
    || typeof value.attemptId !== 'string'
    || typeof value.checkpointSeq !== 'number'
    || !isLiveTurnPhase(value.phase)
    || !isLiveTurnPhase(value.turn.phase)
    || value.phase !== value.turn.phase
    || typeof value.turn.sessionPath !== 'string'
    || typeof value.turn.turnId !== 'string'
    || typeof value.turn.attemptId !== 'string'
    || typeof value.turn.requestId !== 'string'
    || typeof value.turn.canonicalMessageId !== 'string'
    || !Number.isSafeInteger(value.turn.seq)
    || !Number.isSafeInteger(value.turn.checkpointSeq)
    || value.turn.checkpointSeq !== value.checkpointSeq
    || typeof value.turn.startedAt !== 'number'
    || !Number.isFinite(value.turn.startedAt)
    || typeof value.turn.phaseSince !== 'number'
    || !Number.isFinite(value.turn.phaseSince)
    || typeof value.turn.lastSemanticProgressAt !== 'number'
    || !Number.isFinite(value.turn.lastSemanticProgressAt)) return false;
  if (!value.turn.parts.every((part) => isRecord(part)
    && (part.kind === 'tool'
      ? typeof part.toolCallId === 'string'
      : (part.kind === 'text' || part.kind === 'reasoning') && typeof part.text === 'string'))) return false;
  if (value.turn.draftingToolCall !== undefined
    && (!isRecord(value.turn.draftingToolCall)
      || typeof value.turn.draftingToolCall.toolCallId !== 'string'
      || typeof value.turn.draftingToolCall.name !== 'string'
      || typeof value.turn.draftingToolCall.argumentsJson !== 'string')) return false;
  if (!value.tools.every((tool) => isRecord(tool)
    && typeof tool.executionId === 'string'
    && (tool.parentExecutionId === null || typeof tool.parentExecutionId === 'string')
    && typeof tool.rootExecutionId === 'string'
    && typeof tool.turnId === 'string'
    && typeof tool.transcriptToolCallId === 'string'
    && typeof tool.attemptId === 'string'
    && Number.isSafeInteger(tool.seq)
    && typeof tool.name === 'string'
    && (tool.parallelGroupId === undefined || typeof tool.parallelGroupId === 'string')
    && typeof tool.startedAt === 'number'
    && Number.isFinite(tool.startedAt)
    && typeof tool.phaseSince === 'number'
    && Number.isFinite(tool.phaseSince)
    && typeof tool.lastProgressAt === 'number'
    && Number.isFinite(tool.lastProgressAt)
    && isLiveToolPhase(tool.phase)
    && (tool.terminal === undefined
      || (isRecord(tool.terminal)
        && typeof tool.terminal.durableEntryId === 'string'
        && (tool.terminal.status === 'completed' || tool.terminal.status === 'failed'))))) return false;
  if (value.terminal !== undefined
    && (!isRecord(value.terminal)
      || typeof value.terminal.id !== 'string'
      || value.terminal.role !== 'assistant'
      || typeof value.terminal.createdAt !== 'string'
      || typeof value.terminal.markdown !== 'string'
      || (value.terminal.status !== 'completed'
        && value.terminal.status !== 'interrupted'
        && value.terminal.status !== 'error')
      || typeof value.terminal.durableEntryId !== 'string')) return false;
  return true;
}

const LIVE_TURN_PHASES: ReadonlySet<LiveTurnPhase> = new Set([
  'queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool',
  'waiting_input', 'retry_wait', 'aborting', 'reconciling_gap',
]);
const LIVE_TOOL_PHASES: ReadonlySet<LiveToolPhase> = new Set([
  'queued', 'preparing', 'running', 'waiting_input', 'retry_wait', 'aborting',
]);

function isLiveTurnPhase(value: unknown): value is LiveTurnPhase {
  return typeof value === 'string' && LIVE_TURN_PHASES.has(value as LiveTurnPhase);
}

function isLiveToolPhase(value: unknown): value is LiveToolPhase {
  return typeof value === 'string' && LIVE_TOOL_PHASES.has(value as LiveToolPhase);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCheckpointPayload(checkpoint: LiveTurnCheckpoint): 'valid' | 'oversize' | 'malformed' {
  if (checkpoint.pendingExtensionUiRequestIds.length > LIVE_PIPELINE_LIMITS.extensionUiRequests
    || checkpoint.turn.pendingExtensionUiRequestIds.length > LIVE_PIPELINE_LIMITS.extensionUiRequests
    || (checkpoint.turn.draftingToolCall
      && Buffer.byteLength(checkpoint.turn.draftingToolCall.argumentsJson, 'utf8') > LIVE_PIPELINE_LIMITS.toolDraftBytes)) {
    return 'oversize';
  }
  let textBytes = 0;
  let reasoningBytes = 0;
  for (const part of checkpoint.turn.parts) {
    if (part.kind === 'text') textBytes += Buffer.byteLength(part.text, 'utf8');
    else if (part.kind === 'reasoning') reasoningBytes += Buffer.byteLength(part.text, 'utf8');
  }
  if (textBytes > LIVE_PIPELINE_LIMITS.textPartBytes
    || reasoningBytes > LIVE_PIPELINE_LIMITS.reasoningPartBytes) return 'oversize';

  const executionIds = new Set<string>();
  let inputBytes = 0;
  let previewBytes = 0;
  let terminalBytes = 0;
  for (const tool of checkpoint.tools) {
    if (executionIds.has(tool.executionId)
      || tool.turnId !== checkpoint.turnId
      || tool.attemptId !== checkpoint.attemptId
      || !checkpoint.turn.toolExecutionIds.includes(tool.executionId)) return 'malformed';
    executionIds.add(tool.executionId);
    inputBytes += jsonByteLength(tool.immutableInput);
    previewBytes += jsonByteLength(tool.preview);
    terminalBytes += jsonByteLength(tool.terminal?.result);
    if (tool.preview && jsonByteLength(tool.preview) > LIVE_PIPELINE_LIMITS.previewBytes) return 'oversize';
    if (tool.terminal && !tool.terminal.durableEntryId) return 'malformed';
  }
  if (checkpoint.turn.toolExecutionIds.length !== executionIds.size
    || inputBytes > LIVE_PIPELINE_LIMITS.toolInputAggregateBytes
    || previewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes
    || terminalBytes > LIVE_PIPELINE_LIMITS.toolTerminalAggregateBytes) return 'oversize';
  if (checkpoint.terminal && !checkpoint.terminal.durableEntryId) return 'malformed';
  return 'valid';
}

function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}
