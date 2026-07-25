import {
  LIVE_PIPELINE_LIMITS,
  type LiveLifecycleWatermark,
  type LiveToolRecord,
  type LiveTurnCheckpoint,
  type LiveTurnPhase,
  type RejectedObservationReason,
  type ToolPreview,
  type TurnSemanticEnvelope,
} from '../shared/live-pipeline-protocol.js';
import type { ChatMessage } from '../shared/protocol/messages.js';
import type { ThinkingLevel } from '../shared/protocol/models.js';
import {
  diffJsonValues,
  isJsonSafeValue,
  type JsonSafeValue,
} from '../shared/json-structural-patch.js';
import { compactDurableMessageDetails } from '../shared/lazy-details.js';
import { normalizeToolProgress } from './tool-progress-normalizer.js';

export interface BackendLiveTurnIdentity {
  protocolVersion: number;
  sessionPath: string;
  requestId: string;
  turnId: string;
  attemptId: string;
  canonicalMessageId: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  startedAt: number;
}

export type BackendSemanticCandidate =
  | { kind: 'turn.started' }
  | { kind: 'turn.phase'; phase: Exclude<LiveTurnPhase, 'reconciling_gap'>; inactivityBudgetMs?: number }
  | { kind: 'turn.text'; delta: string }
  | { kind: 'turn.reasoning'; delta: string }
  | { kind: 'turn.toolDraft'; toolCallId: string; name: string; argumentsJson: string }
  | { kind: 'turn.extensionUi'; uiRequestId: string; action: 'opened' | 'closed' }
  | { kind: 'tool.started'; executionId: string; parentExecutionId: string | null; rootExecutionId: string; toolCallId: string; name: string; input: unknown; startedAt: number; parallelGroupId?: string }
  | { kind: 'tool.progress'; executionId: string; preview: ToolPreview }
  | { kind: 'tool.terminal'; executionId: string; status: 'completed' | 'failed'; result: unknown; durationMs?: number; durableEntryId: string }
  | { kind: 'turn.terminal'; terminalKind: 'completed' | 'interrupted' | 'error'; userInitiated?: boolean; reason?: string; durableMessage: ChatMessage; durableEntryId: string };

const MAX_LIVE_TOOL_INPUT_BYTES = LIVE_PIPELINE_LIMITS.toolInputBytes;
const MAX_LIVE_TOOL_INPUT_PREVIEW_BYTES = 2 * 1024;
// Preserve at least the complete detail window that the former total-count cap
// allowed, then compact only older durability-confirmed payloads.
const RETAINED_SETTLED_TOOL_DETAILS = 64;
const COMPACTED_LIVE_INPUT = { liveCompacted: true, detail: 'Durability-confirmed tool input omitted from repair checkpoints.' } as const;
const COMPACTED_LIVE_RESULT = { kind: 'generic', summary: 'Durability-confirmed tool result omitted from repair checkpoints.', liveCompacted: true } as const;

export class BackendLiveTurnAccumulator {
  private seq = 0;
  private turn: LiveTurnCheckpoint['turn'];
  private readonly tools: Record<string, LiveToolRecord> = {};
  private terminal?: ChatMessage;
  private watermark?: LiveLifecycleWatermark;
  private readonly settledExecutionIds: string[] = [];
  private readonly previewBytesByExecutionId = new Map<string, number>();
  private aggregatePreviewBytes = 0;
  private textBytes = 0;
  private reasoningBytes = 0;

  constructor(private readonly identity: BackendLiveTurnIdentity) {
    this.turn = {
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      requestId: identity.requestId,
      sessionPath: identity.sessionPath,
      canonicalMessageId: identity.canonicalMessageId,
      modelId: identity.modelId,
      thinkingLevel: identity.thinkingLevel,
      seq: 0,
      checkpointSeq: 0,
      phase: 'queued',
      startedAt: identity.startedAt,
      phaseSince: identity.startedAt,
      lastSemanticProgressAt: identity.startedAt,
      parts: [],
      textBytes: 0,
      reasoningBytes: 0,
      aggregatePreviewBytes: 0,
      toolExecutionIds: [],
      pendingExtensionUiRequestIds: [],
    };
  }

  get attemptId(): string {
    return this.identity.attemptId;
  }

  get currentSeq(): number {
    return this.seq;
  }

  observe(candidate: Exclude<BackendSemanticCandidate, { kind: 'tool.progress' }>, occurredAt: number): TurnSemanticEnvelope;
  observe(candidate: Extract<BackendSemanticCandidate, { kind: 'tool.progress' }>, occurredAt: number): TurnSemanticEnvelope | undefined;
  observe(candidate: BackendSemanticCandidate, occurredAt: number): TurnSemanticEnvelope | undefined;
  observe(candidate: BackendSemanticCandidate, occurredAt: number): TurnSemanticEnvelope | undefined {
    if (candidate.kind === 'tool.progress') return this.observeToolProgress(candidate, occurredAt);
    const seq = ++this.seq;
    const base = { ...this.base(seq, occurredAt) };
    let envelope: TurnSemanticEnvelope;
    switch (candidate.kind) {
      case 'turn.started':
        envelope = {
          ...base,
          kind: 'turn.started',
          canonicalMessageId: this.identity.canonicalMessageId,
          modelId: this.identity.modelId,
          thinkingLevel: this.identity.thinkingLevel,
          startedAt: this.identity.startedAt,
        };
        this.turn = { ...this.turn, seq, checkpointSeq: seq, phase: 'preparing', phaseSince: occurredAt, lastSemanticProgressAt: occurredAt };
        break;
      case 'turn.phase':
        envelope = { ...base, ...candidate };
        this.turn = { ...this.turn, seq, checkpointSeq: seq, phase: candidate.phase, phaseSince: occurredAt, inactivityBudgetMs: candidate.inactivityBudgetMs };
        break;
      case 'turn.text':
      case 'turn.reasoning': {
        const limit = candidate.kind === 'turn.text' ? LIVE_PIPELINE_LIMITS.textPartBytes : LIVE_PIPELINE_LIMITS.reasoningPartBytes;
        const deltaBytes = Buffer.byteLength(candidate.delta, 'utf8');
        const aggregateBytes = candidate.kind === 'turn.text'
          ? this.textBytes + deltaBytes
          : this.reasoningBytes + deltaBytes;
        if (aggregateBytes > limit) return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        envelope = { ...base, ...candidate };
        const partKind = candidate.kind === 'turn.text' ? 'text' as const : 'reasoning' as const;
        const parts = [...this.turn.parts];
        const last = parts.at(-1);
        const combined = last?.kind === partKind ? last.text + candidate.delta : candidate.delta;
        if (Buffer.byteLength(combined, 'utf8') > limit) return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        if (last?.kind === partKind) parts[parts.length - 1] = { ...last, text: combined };
        else parts.push({ kind: partKind, text: candidate.delta });
        if (candidate.kind === 'turn.text') this.textBytes = aggregateBytes;
        else this.reasoningBytes = aggregateBytes;
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          phase: 'streaming',
          phaseSince: this.turn.phase === 'streaming' ? this.turn.phaseSince : occurredAt,
          lastSemanticProgressAt: occurredAt,
          parts,
          textBytes: this.textBytes,
          reasoningBytes: this.reasoningBytes,
        };
        break;
      }
      case 'turn.toolDraft': {
        const previous = this.turn.draftingToolCall?.toolCallId === candidate.toolCallId
          ? this.turn.draftingToolCall.argumentsJson
          : '';
        const argumentsJson = previous + candidate.argumentsJson;
        if (Buffer.byteLength(argumentsJson, 'utf8') > LIVE_PIPELINE_LIMITS.toolDraftBytes) return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        envelope = { ...base, kind: candidate.kind, draft: { toolCallId: candidate.toolCallId, name: candidate.name, argumentsJson } };
        this.turn = { ...this.turn, seq, checkpointSeq: seq, draftingToolCall: envelope.draft, lastSemanticProgressAt: occurredAt };
        break;
      }
      case 'turn.extensionUi': {
        if (candidate.action === 'opened'
          && !this.turn.pendingExtensionUiRequestIds.includes(candidate.uiRequestId)
          && this.turn.pendingExtensionUiRequestIds.length >= LIVE_PIPELINE_LIMITS.extensionUiRequests) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate };
        const pending = candidate.action === 'opened'
          ? this.turn.pendingExtensionUiRequestIds.includes(candidate.uiRequestId)
            ? this.turn.pendingExtensionUiRequestIds
            : [...this.turn.pendingExtensionUiRequestIds, candidate.uiRequestId]
          : this.turn.pendingExtensionUiRequestIds.filter((id) => id !== candidate.uiRequestId);
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          phase: candidate.action === 'opened' ? 'waiting_input' : 'running_tool',
          phaseSince: occurredAt,
          pendingExtensionUiRequestIds: pending,
        };
        break;
      }
      case 'tool.started': {
        if (this.tools[candidate.executionId]) return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        // Tool inputs can contain whole prompts, generated schemas, or cyclic
        // extension-owned values. Live state only needs enough immutable input
        // to render the running card; the durability-confirmed transcript owns
        // the full payload. Bound each input before aggregate accounting so a
        // long subagent/tool turn cannot turn every later start into a rejected
        // observation and a checkpoint-repair storm.
        const input = normalizeLiveToolInput(candidate.input);
        if (jsonByteLength(input) > LIVE_PIPELINE_LIMITS.toolInputBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate, input };
        this.tools[candidate.executionId] = {
          executionId: candidate.executionId,
          parentExecutionId: candidate.parentExecutionId,
          rootExecutionId: candidate.rootExecutionId,
          turnId: this.identity.turnId,
          transcriptToolCallId: candidate.toolCallId,
          attemptId: this.identity.attemptId,
          seq,
          phase: 'running',
          name: candidate.name,
          immutableInput: input,
          parallelGroupId: candidate.parallelGroupId,
          startedAt: candidate.startedAt,
          phaseSince: occurredAt,
          lastProgressAt: occurredAt,
          previewBytes: 0,
        };
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          phase: 'running_tool',
          phaseSince: occurredAt,
          lastSemanticProgressAt: occurredAt,
          draftingToolCall: undefined,
          parts: this.turn.parts.some((part) => part.kind === 'tool' && part.toolCallId === candidate.toolCallId)
            ? this.turn.parts
            : [...this.turn.parts, { kind: 'tool', toolCallId: candidate.toolCallId }],
          toolExecutionIds: [...this.turn.toolExecutionIds, candidate.executionId],
        };
        break;
      }
      case 'tool.terminal': {
        const tool = this.tools[candidate.executionId];
        if (!tool) return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
        if (!candidate.durableEntryId) return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        const boundedResult = normalizeLiveToolTerminalResult(tool.name, candidate.result);
        const resultBytes = jsonByteLength(boundedResult);
        if (resultBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate, result: boundedResult, resultBytes };
        const previousPreviewBytes = this.previewBytesByExecutionId.get(candidate.executionId) ?? 0;
        if (previousPreviewBytes > 0) {
          this.aggregatePreviewBytes -= previousPreviewBytes;
          this.previewBytesByExecutionId.delete(candidate.executionId);
        }
        this.tools[candidate.executionId] = {
          ...tool,
          seq,
          preview: undefined,
          previewBytes: 0,
          terminal: {
            status: candidate.status,
            result: boundedResult,
            resultBytes,
            durationMs: candidate.durationMs,
            durableEntryId: candidate.durableEntryId,
          },
        };
        if (!tool.terminal) this.settledExecutionIds.push(candidate.executionId);
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          lastSemanticProgressAt: occurredAt,
          aggregatePreviewBytes: this.aggregatePreviewBytes,
        };
        this.compactSettledToolHistory();
        break;
      }
      case 'turn.terminal': {
        if (!candidate.durableEntryId || candidate.durableMessage.durableEntryId !== candidate.durableEntryId) {
          return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        }
        const durableMessage = compactDurableMessageDetails(candidate.durableMessage, this.identity.sessionPath);
        envelope = { ...base, ...candidate, durableMessage };
        this.terminal = durableMessage;
        this.turn = { ...this.turn, seq, checkpointSeq: seq, lastSemanticProgressAt: occurredAt };
        this.watermark = {
          sessionPath: this.identity.sessionPath,
          requestId: this.identity.requestId,
          turnId: this.identity.turnId,
          attemptId: this.identity.attemptId,
          finalSeq: seq,
          terminalKind: candidate.terminalKind,
        };
        break;
      }
    }
    return envelope;
  }

  reject(reason: RejectedObservationReason, occurredAt: number): TurnSemanticEnvelope {
    const seq = ++this.seq;
    return this.replaceWithRejected(seq, occurredAt, reason);
  }

  checkpoint(): LiveTurnCheckpoint {
    const terminalTurn = this.terminal
      ? {
          ...this.turn,
          parts: [],
          textBytes: 0,
          reasoningBytes: 0,
          toolExecutionIds: [...this.turn.toolExecutionIds],
          pendingExtensionUiRequestIds: [],
          draftingToolCall: undefined,
        }
      : this.turn;
    return {
      protocolVersion: this.identity.protocolVersion,
      sessionPath: this.identity.sessionPath,
      turnId: this.identity.turnId,
      attemptId: this.identity.attemptId,
      checkpointSeq: this.seq,
      phase: this.turn.phase,
      turn: {
        ...terminalTurn,
        seq: this.seq,
        checkpointSeq: this.seq,
        parts: [...terminalTurn.parts],
        toolExecutionIds: [...terminalTurn.toolExecutionIds],
        pendingExtensionUiRequestIds: [...terminalTurn.pendingExtensionUiRequestIds],
      },
      tools: Object.values(this.tools).map((tool) => ({ ...tool })),
      pendingExtensionUiRequestIds: this.terminal ? [] : [...this.turn.pendingExtensionUiRequestIds],
      terminal: this.terminal,
    };
  }

  lifecycleWatermark(): LiveLifecycleWatermark | undefined {
    return this.watermark ? { ...this.watermark } : undefined;
  }

  private observeToolProgress(
    candidate: Extract<BackendSemanticCandidate, { kind: 'tool.progress' }>,
    occurredAt: number,
  ): TurnSemanticEnvelope | undefined {
    const tool = this.tools[candidate.executionId];
    if (!tool) {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
    }
    if (tool.terminal) {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
    }
    if (!isJsonSafeValue(candidate.preview)) {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
    }

    const previous = tool.preview;
    const operations = previous
      ? diffJsonValues(previous as JsonSafeValue, candidate.preview as JsonSafeValue)
      : [];
    if (previous && operations.length === 0) return undefined;

    const seq = ++this.seq;
    const baseSeq = seq - 1;
    const candidatePreviewBytes = jsonByteLength(candidate.preview);
    const previousPreviewBytes = this.previewBytesByExecutionId.get(candidate.executionId) ?? 0;
    const aggregatePreviewBytes = this.aggregatePreviewBytes - previousPreviewBytes + candidatePreviewBytes;
    if (aggregatePreviewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes) {
      return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
    }

    const baseProgressRevision = tool.progressRevision ?? 0;
    const progressRevision = baseProgressRevision + 1;
    const snapshotUpdate = { kind: 'snapshot' as const, preview: candidate.preview };
    const patchUpdate = { kind: 'patch' as const, operations };
    // candidatePreviewBytes was already measured for aggregate accounting; do
    // not serialize the multi-megabyte snapshot a second time merely to choose
    // the wire form. The small constant covers the snapshot wrapper syntax.
    const update = previous && jsonByteLength(patchUpdate) < candidatePreviewBytes + 32
      ? patchUpdate
      : snapshotUpdate;
    const envelope: TurnSemanticEnvelope = {
      ...this.base(seq, occurredAt),
      kind: 'tool.progress',
      executionId: candidate.executionId,
      baseSeq,
      baseProgressRevision,
      progressRevision,
      previewBytes: candidatePreviewBytes,
      aggregatePreviewBytes,
      update,
    };
    this.tools[candidate.executionId] = {
      ...tool,
      seq,
      preview: candidate.preview,
      previewBytes: candidatePreviewBytes,
      progressRevision,
      lastProgressAt: occurredAt,
    };
    this.previewBytesByExecutionId.set(candidate.executionId, candidatePreviewBytes);
    this.aggregatePreviewBytes = aggregatePreviewBytes;
    this.turn = {
      ...this.turn,
      seq,
      checkpointSeq: seq,
      lastSemanticProgressAt: occurredAt,
      aggregatePreviewBytes,
    };
    return envelope;
  }

  private compactSettledToolHistory(): void {
    const compactIndex = this.settledExecutionIds.length - RETAINED_SETTLED_TOOL_DETAILS - 1;
    if (compactIndex < 0) return;
    const executionId = this.settledExecutionIds[compactIndex];
    const tool = executionId ? this.tools[executionId] : undefined;
    if (!tool?.terminal || isLiveCompactedValue(tool.terminal.result)) return;
    this.tools[tool.executionId] = {
      ...tool,
      immutableInput: COMPACTED_LIVE_INPUT,
      preview: undefined,
      terminal: { ...tool.terminal, result: COMPACTED_LIVE_RESULT },
    };
  }

  private replaceWithRejected(seq: number, occurredAt: number, reason: RejectedObservationReason): TurnSemanticEnvelope {
    this.turn = { ...this.turn, seq, checkpointSeq: seq };
    return { ...this.base(seq, occurredAt), kind: 'observation.rejected', reason };
  }

  private base(seq: number, occurredAt: number) {
    return {
      protocolVersion: this.identity.protocolVersion,
      sessionPath: this.identity.sessionPath,
      requestId: this.identity.requestId,
      turnId: this.identity.turnId,
      attemptId: this.identity.attemptId,
      seq,
      occurredAt,
    };
  }
}

function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function isLiveCompactedValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { liveCompacted?: unknown }).liveCompacted === true;
}

function normalizeLiveToolTerminalResult(toolName: string, value: unknown): unknown {
  // ask_user has a dedicated completed-state renderer that needs the selected
  // answer from the real terminal payload. Its progress preview describes the
  // unanswered prompt and must not replace that result while the turn remains
  // live. Other tools retain their existing bounded preview normalization.
  if (toolName.trim().toLowerCase() !== 'ask_user') {
    return normalizeToolProgress(toolName, value);
  }
  const serialized = stringifyLiveJsonSafe(value, '[Unserializable ask_user result]');
  try { return JSON.parse(serialized) as unknown; }
  catch { return '[Unserializable ask_user result]'; }
}

function stringifyLiveJsonSafe(value: unknown, fallback: string): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function' || typeof item === 'symbol') return `[${typeof item}]`;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) ?? 'null';
  } catch {
    return JSON.stringify(fallback);
  }
}

function normalizeLiveToolInput(value: unknown): unknown {
  const serialized = stringifyLiveJsonSafe(value, '[Unserializable tool input]');
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  if (originalBytes <= MAX_LIVE_TOOL_INPUT_BYTES) {
    try { return JSON.parse(serialized) as unknown; }
    catch { return '[Unserializable tool input]'; }
  }
  const preview = Buffer.from(serialized, 'utf8')
    .subarray(0, MAX_LIVE_TOOL_INPUT_PREVIEW_BYTES)
    .toString('utf8');
  return {
    liveInputTruncated: true,
    originalBytes,
    preview,
  };
}

export class LiveTurnCheckpointRegistry {
  private readonly active: Record<string, BackendLiveTurnAccumulator> = {};
  private readonly terminal: Record<string, { accumulator: BackendLiveTurnAccumulator; expiresAt: number }> = {};

  setActive(sessionPath: string, accumulator: BackendLiveTurnAccumulator): void { this.active[sessionPath] = accumulator; }
  get(sessionPath: string, now: number): BackendLiveTurnAccumulator | undefined {
    this.prune(now);
    return this.active[sessionPath] ?? this.terminal[sessionPath]?.accumulator;
  }
  retainTerminal(sessionPath: string, expiresAt: number): void {
    const accumulator = this.active[sessionPath];
    if (!accumulator) return;
    delete this.active[sessionPath];
    this.terminal[sessionPath] = { accumulator, expiresAt };
  }
  clear(sessionPath: string): void { delete this.active[sessionPath]; delete this.terminal[sessionPath]; }
  prune(now: number): void { for (const [key, value] of Object.entries(this.terminal)) if (value.expiresAt <= now) delete this.terminal[key]; }
}
