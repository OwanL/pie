import {
  LIVE_PIPELINE_LIMITS,
  LIVE_PIPELINE_PROTOCOL_VERSION,
  isToolPreview,
  type LivePipelineState,
  type LiveToolPhase,
  type LiveTurnCheckpoint,
  type LiveTurnPhase,
} from '../../../shared/live-pipeline-protocol.js';
import { isThinkingLevel } from '../../../shared/thinking-level.js';
import { isRecord } from '../../../shared/type-guards.js';
import { incrementLiveRevision, pendingOwnerKey, terminalAttemptKey } from './model.js';

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
  const checkpointByteLimit = checkpoint.terminal
    ? LIVE_PIPELINE_LIMITS.terminalCheckpointBytes
    : LIVE_PIPELINE_LIMITS.checkpointBytes;
  if (encodedBytes > checkpointByteLimit
    || encodedBytes > checkpoint.checkpointBytes
    || checkpoint.turn.checkpointBytes !== checkpoint.checkpointBytes) {
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

  // Terminalization is authoritative. A checkpoint RPC may have captured its
  // active snapshot before the terminal envelope was reduced, then settle
  // afterward. Never let that delayed response revive an attempt whose
  // tombstone already prevents further semantic events from advancing it.
  if (current.terminalAttempts[terminalAttemptKey(checkpoint.turnId, checkpoint.attemptId)]) {
    return { classification: 'stale', state: current };
  }

  const existing = current.turnsBySession[checkpoint.sessionPath];
  if (existing) {
    if (existing.turnId !== checkpoint.turnId || existing.attemptId !== checkpoint.attemptId) {
      return { classification: 'mismatch', state: current };
    }
    // A repair may race semantic events that advanced the owner after the
    // checkpoint was captured. Comparing only with the last checkpoint base
    // would accept that older snapshot and regress already-applied text/tools.
    // Equality remains valid: observation.rejected deliberately consumes a
    // sequence and is repaired by a checkpoint at that same sequence.
    if (checkpoint.checkpointSeq < existing.seq) {
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
    const existingTool = current.toolsByExecutionId[tool.executionId];
    const sameExistingTool = existingTool?.turnId === tool.turnId && existingTool.attemptId === tool.attemptId
      ? existingTool
      : undefined;
    const immutableInput = isLiveCompactedValue(tool.immutableInput)
      && sameExistingTool
      && !isLiveCompactedValue(sameExistingTool.immutableInput)
      ? sameExistingTool.immutableInput
      : tool.immutableInput;
    const preserveExistingTerminal = tool.terminal
      && isLiveCompactedValue(tool.terminal.result)
      && sameExistingTool?.terminal?.durableEntryId === tool.terminal.durableEntryId
      && !isLiveCompactedValue(sameExistingTool.terminal.result);
    tools[tool.executionId] = {
      ...tool,
      immutableInput,
      terminal: preserveExistingTerminal
        ? { ...tool.terminal!, result: sameExistingTool!.terminal!.result }
        : tool.terminal,
    };
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
    || !isNonNegativeSafeInteger(value.checkpointBytes)
    || value.checkpointBytes > LIVE_PIPELINE_LIMITS.terminalCheckpointBytes
    || !isLiveTurnPhase(value.phase)
    || !isLiveTurnPhase(value.turn.phase)
    || value.phase !== value.turn.phase
    || typeof value.turn.sessionPath !== 'string'
    || typeof value.turn.turnId !== 'string'
    || typeof value.turn.attemptId !== 'string'
    || typeof value.turn.requestId !== 'string'
    || typeof value.turn.canonicalMessageId !== 'string'
    || (value.turn.modelId !== undefined && typeof value.turn.modelId !== 'string')
    || (value.turn.provider !== undefined && typeof value.turn.provider !== 'string')
    || (value.turn.thinkingLevel !== undefined && !isThinkingLevel(value.turn.thinkingLevel))
    || !Number.isSafeInteger(value.turn.seq)
    || !Number.isSafeInteger(value.turn.checkpointSeq)
    || !isNonNegativeSafeInteger(value.turn.textBytes)
    || !isNonNegativeSafeInteger(value.turn.reasoningBytes)
    || !isNonNegativeSafeInteger(value.turn.aggregatePreviewBytes)
    || !isNonNegativeSafeInteger(value.turn.checkpointBytes)
    || !isRecord(value.turn.toolDraftsByCallId)
    || !isNonNegativeSafeInteger(value.turn.aggregateToolDraftBytes)
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
  if (!Object.entries(value.turn.toolDraftsByCallId).every(([toolCallId, draft]) =>
    isRecord(draft)
      && typeof draft.toolCallId === 'string' && draft.toolCallId === toolCallId && toolCallId.length > 0
      && typeof draft.name === 'string' && draft.name.length > 0
      && typeof draft.argumentsJson === 'string'
      && (draft.phase === 'drafting' || draft.phase === 'ready'))) return false;
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
    && (tool.progressRevision === undefined
      || (Number.isSafeInteger(tool.progressRevision) && (tool.progressRevision as number) >= 0))
    && isNonNegativeSafeInteger(tool.previewBytes)
    && (tool.preview === undefined || isToolPreview(tool.preview))
    && isLiveToolPhase(tool.phase)
    && (tool.executionEnd === undefined
      || (isRecord(tool.executionEnd)
        && (tool.executionEnd.status === 'completed' || tool.executionEnd.status === 'failed')
        && optionalFiniteNumber(tool.executionEnd.durationMs)))
    && (tool.terminal === undefined
      || (isRecord(tool.terminal)
        && typeof tool.terminal.durableEntryId === 'string'
        && isNonNegativeSafeInteger(tool.terminal.resultBytes)
        && optionalFiniteNumber(tool.terminal.durationMs)
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validateCheckpointPayload(checkpoint: LiveTurnCheckpoint): 'valid' | 'oversize' | 'malformed' {
  if (checkpoint.pendingExtensionUiRequestIds.length > LIVE_PIPELINE_LIMITS.extensionUiRequests
    || checkpoint.turn.pendingExtensionUiRequestIds.length > LIVE_PIPELINE_LIMITS.extensionUiRequests) {
    return 'oversize';
  }
  let aggregateToolDraftBytes = 0;
  for (const [toolCallId, draft] of Object.entries(checkpoint.turn.toolDraftsByCallId)) {
    if (toolDraftByteLength(draft) > LIVE_PIPELINE_LIMITS.toolDraftBytes) return 'oversize';
    if (toolCallId !== draft.toolCallId
      || !checkpoint.turn.parts.some((part) => part.kind === 'tool' && part.toolCallId === toolCallId)) return 'malformed';
    aggregateToolDraftBytes += toolDraftByteLength(draft);
  }
  if (aggregateToolDraftBytes > LIVE_PIPELINE_LIMITS.toolDraftAggregateBytes) return 'oversize';
  if (checkpoint.turn.aggregateToolDraftBytes !== aggregateToolDraftBytes) return 'malformed';

  let textBytes = 0;
  let reasoningBytes = 0;
  for (const part of checkpoint.turn.parts) {
    if (part.kind === 'text') textBytes += Buffer.byteLength(part.text, 'utf8');
    else if (part.kind === 'reasoning') reasoningBytes += Buffer.byteLength(part.text, 'utf8');
  }
  if (textBytes > LIVE_PIPELINE_LIMITS.textPartBytes
    || reasoningBytes > LIVE_PIPELINE_LIMITS.reasoningPartBytes) return 'oversize';
  if (checkpoint.turn.textBytes !== textBytes
    || checkpoint.turn.reasoningBytes !== reasoningBytes) return 'malformed';

  const executionIds = new Set<string>();
  let previewBytes = 0;
  for (const tool of checkpoint.tools) {
    if (executionIds.has(tool.executionId)
      || tool.turnId !== checkpoint.turnId
      || tool.attemptId !== checkpoint.attemptId
      || !checkpoint.turn.toolExecutionIds.includes(tool.executionId)) return 'malformed';
    executionIds.add(tool.executionId);
    const inputBytes = jsonByteLength(tool.immutableInput);
    const terminalBytes = jsonByteLength(tool.terminal?.result);
    const toolPreviewBytes = jsonByteLength(tool.preview);
    previewBytes += toolPreviewBytes;
    if (tool.previewBytes !== toolPreviewBytes
      || (tool.terminal && tool.terminal.resultBytes !== terminalBytes)) return 'malformed';
    if (inputBytes > LIVE_PIPELINE_LIMITS.toolInputBytes
      || toolPreviewBytes > LIVE_PIPELINE_LIMITS.previewBytes
      || terminalBytes > LIVE_PIPELINE_LIMITS.previewBytes) return 'oversize';
    if (tool.terminal && !tool.terminal.durableEntryId) return 'malformed';
    if (tool.executionEnd && tool.terminal
      && (tool.executionEnd.status !== tool.terminal.status
        || tool.executionEnd.durationMs !== tool.terminal.durationMs)) return 'malformed';
  }
  if (checkpoint.turn.toolExecutionIds.length !== executionIds.size) return 'malformed';
  if (previewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes) return 'oversize';
  if (checkpoint.turn.aggregatePreviewBytes !== previewBytes) return 'malformed';
  if (checkpoint.terminal && !checkpoint.terminal.durableEntryId) return 'malformed';
  return 'valid';
}

function isLiveCompactedValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { liveCompacted?: unknown }).liveCompacted === true;
}

function toolDraftByteLength(draft: { toolCallId: string; name: string; argumentsJson: string; phase: string }): number {
  return Buffer.byteLength(
    JSON.stringify({ toolCallId: draft.toolCallId, name: draft.name, argumentsJson: draft.argumentsJson, phase: draft.phase }),
    'utf8',
  );
}

function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}
