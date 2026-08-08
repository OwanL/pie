import {
  LIVE_PIPELINE_LIMITS,
  isToolPreview,
  type LivePipelineState,
  type LiveTurnPhase,
  type ToolPreview,
  type TurnSemanticEnvelope,
} from '../../../shared/live-pipeline-protocol.js';
import { applyJsonPatch, type JsonSafeValue } from '../../../shared/json-structural-patch.js';
import { incrementLiveRevision, pendingOwnerKey, pruneExpiredTerminalAttempts, terminalAttemptKey } from './model.js';
import { reconcileDurableTerminalToolMetadata } from './terminal-reconciliation.js';

export type LiveTransitionResult =
  | { classification: 'applied'; state: LivePipelineState }
  | { classification: 'committed'; state: LivePipelineState; terminal: Extract<TurnSemanticEnvelope, { kind: 'turn.terminal' }>['durableMessage'] }
  | { classification: 'duplicate_or_late'; state: LivePipelineState }
  | { classification: 'gap'; state: LivePipelineState; expectedSeq: number; observedSeq: number }
  | { classification: 'owner_pending'; state: LivePipelineState }
  | { classification: 'invalid'; state: LivePipelineState; reason: string };

const LEGAL_PHASES: Record<LiveTurnPhase, readonly LiveTurnPhase[]> = {
  queued: ['preparing', 'waiting_provider', 'aborting', 'reconciling_gap'],
  preparing: ['queued', 'waiting_provider', 'streaming', 'running_tool', 'retry_wait', 'aborting', 'reconciling_gap'],
  waiting_provider: ['streaming', 'retry_wait', 'aborting', 'reconciling_gap'],
  streaming: ['running_tool', 'waiting_provider', 'retry_wait', 'aborting', 'reconciling_gap'],
  running_tool: ['preparing', 'streaming', 'waiting_provider', 'waiting_input', 'retry_wait', 'aborting', 'reconciling_gap'],
  waiting_input: ['running_tool', 'streaming', 'aborting', 'reconciling_gap'],
  retry_wait: ['waiting_provider', 'streaming', 'running_tool', 'aborting', 'reconciling_gap'],
  aborting: ['reconciling_gap'],
  reconciling_gap: ['queued', 'preparing', 'waiting_provider', 'streaming', 'running_tool', 'waiting_input', 'retry_wait', 'aborting'],
};

export function isLegalLiveTurnPhaseTransition(from: LiveTurnPhase, to: LiveTurnPhase): boolean {
  return from === to || LEGAL_PHASES[from].includes(to);
}

/** Pure transient transition engine. Effects supply timestamps, IDs and checkpoint I/O. */
export function applyLiveSemanticEnvelope(
  current: LivePipelineState,
  event: TurnSemanticEnvelope,
  tombstoneExpiresAt: number,
): LiveTransitionResult {
  if (!Number.isSafeInteger(event.checkpointBytes)
    || event.checkpointBytes < 0
    || event.checkpointBytes > LIVE_PIPELINE_LIMITS.checkpointBytes) {
    return { classification: 'invalid', state: current, reason: 'canonical checkpoint capacity exceeded' };
  }
  const tombstoneKey = terminalAttemptKey(event.turnId, event.attemptId);
  if (current.terminalAttempts[tombstoneKey]) {
    return { classification: 'duplicate_or_late', state: current };
  }

  let owner = current.turnsBySession[event.sessionPath];
  if (event.kind === 'turn.started') {
    if (event.seq !== 1) return gapWithoutOwner(current, event);
    if (owner) {
      if (owner.turnId === event.turnId && owner.attemptId === event.attemptId) {
        return { classification: 'duplicate_or_late', state: current };
      }
      return { classification: 'invalid', state: current, reason: 'session already owns an active turn' };
    }
    const turn = {
      turnId: event.turnId,
      attemptId: event.attemptId,
      requestId: event.requestId,
      sessionPath: event.sessionPath,
      canonicalMessageId: event.canonicalMessageId,
      modelId: event.modelId,
      thinkingLevel: event.thinkingLevel,
      seq: event.seq,
      checkpointSeq: 0,
      phase: 'preparing' as const,
      startedAt: event.startedAt,
      phaseSince: event.occurredAt,
      lastSemanticProgressAt: event.occurredAt,
      parts: [],
      textBytes: 0,
      reasoningBytes: 0,
      aggregatePreviewBytes: 0,
      checkpointBytes: event.checkpointBytes,
      toolDraftsByCallId: {},
      aggregateToolDraftBytes: 0,
      toolExecutionIds: [],
      pendingExtensionUiRequestIds: [],
    };
    let state: LivePipelineState = {
      ...current,
      turnsBySession: { ...current.turnsBySession, [event.sessionPath]: turn },
    };
    state = incrementLiveRevision(state, event.sessionPath);
    return { classification: 'applied', state };
  }

  if (!owner || owner.turnId !== event.turnId || owner.attemptId !== event.attemptId) {
    return queueOwnerPending(current, event);
  }
  if (event.seq <= owner.seq) return { classification: 'duplicate_or_late', state: current };
  const expectedBaseSeq = owner.seq;
  if (event.kind === 'tool.progress') {
    if (event.baseSeq !== expectedBaseSeq
      || event.seq <= event.baseSeq
      || event.seq - event.baseSeq !== event.progressRevision - event.baseProgressRevision) {
      return enterGap(current, owner, event);
    }
  } else if (event.seq !== owner.seq + 1) return enterGap(current, owner, event);

  owner = { ...owner, checkpointBytes: event.checkpointBytes };

  if (event.kind === 'observation.rejected') {
    const state = withTurn(current, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: 'reconciling_gap',
      phaseSince: event.occurredAt,
      reconciliation: {
        expectedSeq: event.seq,
        observedSeq: event.seq,
        attempts: 0,
        status: 'requested',
      },
    });
    return { classification: 'gap', state, expectedSeq: event.seq, observedSeq: event.seq };
  }

  if (event.kind === 'turn.phase') {
    if (!isLegalLiveTurnPhaseTransition(owner.phase, event.phase)) {
      return { classification: 'invalid', state: current, reason: `illegal phase transition ${owner.phase}->${event.phase}` };
    }
    return appliedTurn(current, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: event.phase,
      phaseSince: event.occurredAt,
      inactivityBudgetMs: event.inactivityBudgetMs,
    });
  }

  if (event.kind === 'turn.text' || event.kind === 'turn.reasoning') {
    if (owner.phase === 'aborting') return { classification: 'invalid', state: current, reason: 'progress after aborting' };
    const byteLimit = event.kind === 'turn.text'
      ? LIVE_PIPELINE_LIMITS.textPartBytes
      : LIVE_PIPELINE_LIMITS.reasoningPartBytes;
    const partKind = event.kind === 'turn.text' ? 'text' as const : 'reasoning' as const;
    const aggregateBytes = (partKind === 'text' ? owner.textBytes : owner.reasoningBytes)
      + Buffer.byteLength(event.delta, 'utf8');
    if (aggregateBytes > byteLimit) {
      return { classification: 'invalid', state: current, reason: 'aggregate part kind exceeds live byte limit' };
    }
    const parts = [...owner.parts];
    const last = parts.at(-1);
    if (last?.kind === partKind) {
      parts[parts.length - 1] = { ...last, text: last.text + event.delta };
    } else {
      parts.push({ kind: partKind, text: event.delta });
    }
    return appliedTurn(current, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: 'streaming',
      phaseSince: owner.phase === 'streaming' ? owner.phaseSince : event.occurredAt,
      lastSemanticProgressAt: event.occurredAt,
      parts,
      textBytes: partKind === 'text' ? aggregateBytes : owner.textBytes,
      reasoningBytes: partKind === 'reasoning' ? aggregateBytes : owner.reasoningBytes,
    });
  }

  if (event.kind === 'turn.toolDraft') {
    if (owner.phase === 'aborting') {
      return { classification: 'invalid', state: current, reason: 'tool draft progress after aborting' };
    }
    const alreadyPromoted = owner.toolExecutionIds.some((executionId) =>
      current.toolsByExecutionId[executionId]?.transcriptToolCallId === event.draft.toolCallId,
    );
    if (alreadyPromoted) {
      // A provider boundary replay after execution promotion advances the
      // observed sequence but cannot recreate the removed transient draft.
      return appliedTurn(current, event.sessionPath, { ...owner, seq: event.seq });
    }
    const previous = ownRecordValue(owner.toolDraftsByCallId, event.draft.toolCallId);
    if ((!previous && event.draft.phase !== 'drafting')
      || (previous && previous.name !== event.draft.name)
      || (previous?.phase === 'ready'
        && (event.draft.phase !== 'ready' || previous.argumentsJson !== event.draft.argumentsJson))
      || (previous?.phase === 'drafting' && event.draft.phase === 'drafting'
        && !event.draft.argumentsJson.startsWith(previous.argumentsJson))) {
      return { classification: 'invalid', state: current, reason: 'invalid tool draft lifecycle' };
    }
    if (toolDraftByteLength(event.draft) > LIVE_PIPELINE_LIMITS.toolDraftBytes) {
      return { classification: 'invalid', state: current, reason: 'tool draft exceeds live byte limit' };
    }
    const aggregateToolDraftBytes = owner.aggregateToolDraftBytes
      - (previous ? toolDraftByteLength(previous) : 0)
      + toolDraftByteLength(event.draft);
    if (aggregateToolDraftBytes > LIVE_PIPELINE_LIMITS.toolDraftAggregateBytes) {
      return { classification: 'invalid', state: current, reason: 'aggregate tool drafts exceed live byte limit' };
    }
    return appliedTurn(current, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: 'streaming',
      phaseSince: owner.phase === 'streaming' ? owner.phaseSince : event.occurredAt,
      lastSemanticProgressAt: event.occurredAt,
      toolDraftsByCallId: { ...owner.toolDraftsByCallId, [event.draft.toolCallId]: event.draft },
      aggregateToolDraftBytes,
      parts: previous || owner.parts.some((part) => part.kind === 'tool' && part.toolCallId === event.draft.toolCallId)
        ? owner.parts
        : [...owner.parts, { kind: 'tool', toolCallId: event.draft.toolCallId }],
    });
  }

  if (event.kind === 'turn.extensionUi') {
    if (event.action === 'opened'
      && !owner.pendingExtensionUiRequestIds.includes(event.uiRequestId)
      && owner.pendingExtensionUiRequestIds.length >= LIVE_PIPELINE_LIMITS.extensionUiRequests) {
      return { classification: 'invalid', state: current, reason: 'extension UI request capacity exceeded' };
    }
    const pending = event.action === 'opened'
      ? owner.pendingExtensionUiRequestIds.includes(event.uiRequestId)
        ? owner.pendingExtensionUiRequestIds
        : [...owner.pendingExtensionUiRequestIds, event.uiRequestId]
      : owner.pendingExtensionUiRequestIds.filter((id) => id !== event.uiRequestId);
    return appliedTurn(current, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: event.action === 'opened' ? 'waiting_input' : 'running_tool',
      phaseSince: event.occurredAt,
      pendingExtensionUiRequestIds: pending,
    });
  }

  if (event.kind === 'tool.started') {
    if (owner.phase === 'aborting') {
      return { classification: 'invalid', state: current, reason: 'tool start after aborting' };
    }
    if (jsonByteLength(event.input) > LIVE_PIPELINE_LIMITS.toolInputBytes) {
      return { classification: 'invalid', state: current, reason: 'tool input exceeds live byte limit' };
    }
    if (current.toolsByExecutionId[event.executionId]) {
      return { classification: 'invalid', state: current, reason: 'execution id already exists' };
    }
    const duplicateCallId = owner.toolExecutionIds.some((executionId) =>
      current.toolsByExecutionId[executionId]?.transcriptToolCallId === event.toolCallId,
    );
    if (duplicateCallId) {
      return { classification: 'invalid', state: current, reason: 'tool call id already belongs to a live execution' };
    }
    const tool = {
      executionId: event.executionId,
      parentExecutionId: event.parentExecutionId,
      rootExecutionId: event.rootExecutionId,
      turnId: event.turnId,
      transcriptToolCallId: event.toolCallId,
      attemptId: event.attemptId,
      seq: event.seq,
      phase: 'running' as const,
      name: event.name,
      immutableInput: event.input,
      parallelGroupId: event.parallelGroupId,
      startedAt: event.startedAt,
      phaseSince: event.occurredAt,
      lastProgressAt: event.occurredAt,
      previewBytes: 0,
    };
    let state: LivePipelineState = {
      ...current,
      toolsByExecutionId: { ...current.toolsByExecutionId, [event.executionId]: tool },
    };
    const promotedDraft = ownRecordValue(owner.toolDraftsByCallId, event.toolCallId);
    const toolDraftsByCallId = { ...owner.toolDraftsByCallId };
    delete toolDraftsByCallId[event.toolCallId];
    state = withTurn(state, event.sessionPath, {
      ...owner,
      seq: event.seq,
      phase: 'running_tool',
      phaseSince: event.occurredAt,
      lastSemanticProgressAt: event.occurredAt,
      toolDraftsByCallId,
      aggregateToolDraftBytes: owner.aggregateToolDraftBytes
        - (promotedDraft ? toolDraftByteLength(promotedDraft) : 0),
      parts: owner.parts.some((part) => part.kind === 'tool' && part.toolCallId === event.toolCallId)
        ? owner.parts
        : [...owner.parts, { kind: 'tool', toolCallId: event.toolCallId }],
      toolExecutionIds: [...owner.toolExecutionIds, event.executionId],
    });
    return { classification: 'applied', state };
  }

  if (event.kind === 'tool.progress') {
    if (owner.phase === 'aborting') {
      return { classification: 'invalid', state: current, reason: 'tool progress after aborting' };
    }
    const tool = current.toolsByExecutionId[event.executionId];
    if (!tool || tool.turnId !== owner.turnId || tool.attemptId !== owner.attemptId) {
      return queueOwnerPending(current, event);
    }
    if (tool.terminal) {
      return { classification: 'invalid', state: current, reason: 'progress after terminal tool' };
    }
    if ((tool.progressRevision ?? 0) !== event.baseProgressRevision) {
      return enterGap(current, owner, event);
    }
    let preview: ToolPreview;
    if (event.update.kind === 'snapshot') {
      preview = event.update.preview;
      if (event.update.operations?.length) {
        const patched = applyJsonPatch(preview as JsonSafeValue, event.update.operations);
        if (!patched.ok || !isToolPreview(patched.value)) {
          return { classification: 'invalid', state: current, reason: 'invalid progress snapshot patch' };
        }
        preview = patched.value;
      }
    } else {
      if (!tool.preview) return enterGap(current, owner, event);
      const patched = applyJsonPatch(tool.preview as JsonSafeValue, event.update.operations);
      if (!patched.ok || !isToolPreview(patched.value)) {
        return { classification: 'invalid', state: current, reason: 'invalid progress patch' };
      }
      preview = patched.value;
    }
    // Protocol v6 requires backend-measured canonical counters. Trust that
    // same-process metadata so a tiny structural append never stringifies the
    // reconstructed multi-MiB value merely to enforce capacity.
    const previewBytes = event.previewBytes;
    const aggregatePreviewBytes = owner.aggregatePreviewBytes - tool.previewBytes + previewBytes;
    if (previewBytes > LIVE_PIPELINE_LIMITS.previewBytes
      || aggregatePreviewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes
      || event.aggregatePreviewBytes !== aggregatePreviewBytes) {
      return { classification: 'invalid', state: current, reason: 'aggregate tool preview capacity exceeded' };
    }
    const state = withTurn({
      ...current,
      toolsByExecutionId: {
        ...current.toolsByExecutionId,
        [event.executionId]: {
          ...tool,
          seq: event.seq,
          preview,
          previewBytes,
          progressRevision: event.progressRevision,
          lastProgressAt: event.occurredAt,
        },
      },
    }, event.sessionPath, {
      ...owner,
      seq: event.seq,
      lastSemanticProgressAt: event.occurredAt,
      aggregatePreviewBytes,
    });
    return { classification: 'applied', state };
  }

  if (event.kind === 'tool.terminal') {
    const tool = current.toolsByExecutionId[event.executionId];
    if (!tool || tool.turnId !== owner.turnId || tool.attemptId !== owner.attemptId) {
      return queueOwnerPending(current, event);
    }
    if (!event.durableEntryId) return { classification: 'invalid', state: current, reason: 'terminal tool lacks durable evidence' };
    const resultBytes = event.resultBytes ?? jsonByteLength(event.result);
    if (resultBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
      return { classification: 'invalid', state: current, reason: 'terminal tool result exceeds live byte limit' };
    }
    const state = withTurn({
      ...current,
      toolsByExecutionId: {
        ...current.toolsByExecutionId,
        [event.executionId]: {
          ...tool,
          seq: event.seq,
          preview: undefined,
          previewBytes: 0,
          terminal: {
            status: event.status,
            result: event.result,
            resultBytes,
            durationMs: event.durationMs,
            durableEntryId: event.durableEntryId,
          },
        },
      },
    }, event.sessionPath, {
      ...owner,
      seq: event.seq,
      lastSemanticProgressAt: event.occurredAt,
      aggregatePreviewBytes: owner.aggregatePreviewBytes - tool.previewBytes,
    });
    return { classification: 'applied', state };
  }

  if (!event.durableEntryId || event.durableMessage.durableEntryId !== event.durableEntryId) {
    return { classification: 'invalid', state: current, reason: 'terminal turn lacks matching durable evidence' };
  }
  const tools = { ...current.toolsByExecutionId };
  for (const executionId of owner.toolExecutionIds) delete tools[executionId];
  const turns = { ...current.turnsBySession };
  delete turns[event.sessionPath];
  const pending = { ...current.pendingOwnerEvents };
  delete pending[pendingOwnerKey(event.turnId, event.attemptId)];
  const terminalAttempts = pruneExpiredTerminalAttempts({
    ...current.terminalAttempts,
    [tombstoneKey]: {
      sessionPath: event.sessionPath,
      turnId: event.turnId,
      attemptId: event.attemptId,
      finalSeq: event.seq,
      terminalKind: event.terminalKind,
      expiresAt: tombstoneExpiresAt,
    },
  }, event.occurredAt, LIVE_PIPELINE_LIMITS.terminalTombstones);
  const liveTools = owner.toolExecutionIds
    .map((executionId) => current.toolsByExecutionId[executionId])
    .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
  const terminal = reconcileDurableTerminalToolMetadata(event.durableMessage, owner, liveTools);
  let state: LivePipelineState = { ...current, turnsBySession: turns, toolsByExecutionId: tools, pendingOwnerEvents: pending, terminalAttempts };
  state = incrementLiveRevision(state, event.sessionPath);
  return { classification: 'committed', state, terminal };
}

function appliedTurn(state: LivePipelineState, sessionPath: string, turn: LivePipelineState['turnsBySession'][string]): LiveTransitionResult {
  return { classification: 'applied', state: withTurn(state, sessionPath, turn) };
}

function withTurn(state: LivePipelineState, sessionPath: string, turn: LivePipelineState['turnsBySession'][string]): LivePipelineState {
  return incrementLiveRevision({ ...state, turnsBySession: { ...state.turnsBySession, [sessionPath]: turn } }, sessionPath);
}

function gapWithoutOwner(state: LivePipelineState, event: TurnSemanticEnvelope): LiveTransitionResult {
  return { classification: 'gap', state, expectedSeq: 1, observedSeq: event.seq };
}

function enterGap(state: LivePipelineState, owner: LivePipelineState['turnsBySession'][string], event: TurnSemanticEnvelope): LiveTransitionResult {
  const expectedSeq = owner.seq + 1;
  const key = pendingOwnerKey(event.turnId, event.attemptId);
  const queued = state.pendingOwnerEvents[key] ?? [];
  const canQueue = pendingEventCount(state) < LIVE_PIPELINE_LIMITS.pendingOwnerEvents
    && pendingEventBytes(state) + jsonByteLength(event) <= LIVE_PIPELINE_LIMITS.pendingOwnerBytes;
  const pendingOwnerEvents = canQueue
    ? { ...state.pendingOwnerEvents, [key]: [...queued, event] }
    : state.pendingOwnerEvents;
  const next = withTurn({ ...state, pendingOwnerEvents }, event.sessionPath, {
    ...owner,
    phase: 'reconciling_gap',
    phaseSince: event.occurredAt,
    reconciliation: { expectedSeq, observedSeq: event.seq, attempts: 0, status: 'requested' },
  });
  return { classification: 'gap', state: next, expectedSeq, observedSeq: event.seq };
}

function ownRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
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

function pendingEventCount(state: LivePipelineState): number {
  return Object.values(state.pendingOwnerEvents).reduce((total, events) => total + events.length, 0);
}

function pendingEventBytes(state: LivePipelineState): number {
  return Object.values(state.pendingOwnerEvents).reduce((total, events) =>
    total + events.reduce((eventTotal, event) => eventTotal + jsonByteLength(event), 0),
  0);
}

function queueOwnerPending(state: LivePipelineState, event: TurnSemanticEnvelope): LiveTransitionResult {
  const key = pendingOwnerKey(event.turnId, event.attemptId);
  const queued = state.pendingOwnerEvents[key] ?? [];
  if (pendingEventCount(state) >= LIVE_PIPELINE_LIMITS.pendingOwnerEvents
    || pendingEventBytes(state) + jsonByteLength(event) > LIVE_PIPELINE_LIMITS.pendingOwnerBytes) {
    return { classification: 'invalid', state, reason: 'pending owner event capacity exceeded' };
  }
  const bounded = [...queued, event];
  return {
    classification: 'owner_pending',
    state: { ...state, pendingOwnerEvents: { ...state.pendingOwnerEvents, [key]: bounded } },
  };
}
