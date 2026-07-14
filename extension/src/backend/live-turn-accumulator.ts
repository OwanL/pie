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
import { normalizeToolProgress } from './tool-progress-normalizer.js';

export interface BackendLiveTurnIdentity {
  protocolVersion: number;
  sessionPath: string;
  requestId: string;
  turnId: string;
  attemptId: string;
  canonicalMessageId: string;
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

const MAX_LIVE_TOOL_INPUT_BYTES = 3 * 1024;
const MAX_LIVE_TOOL_INPUT_PREVIEW_BYTES = 2 * 1024;

export class BackendLiveTurnAccumulator {
  private seq = 0;
  private turn: LiveTurnCheckpoint['turn'];
  private readonly tools: Record<string, LiveToolRecord> = {};
  private terminal?: ChatMessage;
  private watermark?: LiveLifecycleWatermark;
  private textBytes = 0;
  private reasoningBytes = 0;

  constructor(private readonly identity: BackendLiveTurnIdentity) {
    this.turn = {
      turnId: identity.turnId,
      attemptId: identity.attemptId,
      requestId: identity.requestId,
      sessionPath: identity.sessionPath,
      canonicalMessageId: identity.canonicalMessageId,
      seq: 0,
      checkpointSeq: 0,
      phase: 'queued',
      startedAt: identity.startedAt,
      phaseSince: identity.startedAt,
      lastSemanticProgressAt: identity.startedAt,
      parts: [],
      toolExecutionIds: [],
      pendingExtensionUiRequestIds: [],
    };
  }

  observe(candidate: BackendSemanticCandidate, occurredAt: number): TurnSemanticEnvelope {
    const seq = ++this.seq;
    const base = { ...this.base(seq, occurredAt) };
    let envelope: TurnSemanticEnvelope;
    switch (candidate.kind) {
      case 'turn.started':
        envelope = { ...base, kind: 'turn.started', canonicalMessageId: this.identity.canonicalMessageId, startedAt: this.identity.startedAt };
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
        this.turn = { ...this.turn, seq, checkpointSeq: seq, phase: 'streaming', phaseSince: this.turn.phase === 'streaming' ? this.turn.phaseSince : occurredAt, lastSemanticProgressAt: occurredAt, parts };
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
        if (this.turn.toolExecutionIds.length >= LIVE_PIPELINE_LIMITS.checkpointTools) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        // Tool inputs can contain whole prompts, generated schemas, or cyclic
        // extension-owned values. Live state only needs enough immutable input
        // to render the running card; the durability-confirmed transcript owns
        // the full payload. Bound each input before aggregate accounting so a
        // long subagent/tool turn cannot turn every later start into a rejected
        // observation and a checkpoint-repair storm.
        const input = normalizeLiveToolInput(candidate.input);
        const aggregateInputBytes = Object.values(this.tools).reduce(
          (total, tool) => total + jsonByteLength(tool.immutableInput),
          jsonByteLength(input),
        );
        if (aggregateInputBytes > LIVE_PIPELINE_LIMITS.toolInputAggregateBytes) {
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
      case 'tool.progress': {
        const tool = this.tools[candidate.executionId];
        if (!tool) return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
        const aggregatePreviewBytes = Object.values(this.tools).reduce((total, entry) =>
          total + (entry.executionId === candidate.executionId
            ? jsonByteLength(candidate.preview)
            : jsonByteLength(entry.preview)),
        0);
        if (aggregatePreviewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate };
        this.tools[candidate.executionId] = { ...tool, seq, preview: candidate.preview, lastProgressAt: occurredAt };
        this.turn = { ...this.turn, seq, checkpointSeq: seq, lastSemanticProgressAt: occurredAt };
        break;
      }
      case 'tool.terminal': {
        const tool = this.tools[candidate.executionId];
        if (!tool) return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
        if (!candidate.durableEntryId) return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        const boundedResult = normalizeToolProgress(tool.name, candidate.result);
        const aggregateTerminalBytes = Object.values(this.tools).reduce((total, entry) =>
          total + (entry.executionId === candidate.executionId
            ? jsonByteLength(boundedResult)
            : jsonByteLength(entry.terminal?.result)),
        0);
        if (aggregateTerminalBytes > LIVE_PIPELINE_LIMITS.toolTerminalAggregateBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate, result: boundedResult };
        this.tools[candidate.executionId] = {
          ...tool,
          seq,
          preview: undefined,
          terminal: {
            status: candidate.status,
            result: boundedResult,
            durationMs: candidate.durationMs,
            durableEntryId: candidate.durableEntryId,
          },
        };
        this.turn = { ...this.turn, seq, checkpointSeq: seq, lastSemanticProgressAt: occurredAt };
        break;
      }
      case 'turn.terminal':
        if (!candidate.durableEntryId || candidate.durableMessage.durableEntryId !== candidate.durableEntryId) {
          return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        }
        if (!isJsonWithin(candidate.durableMessage, LIVE_PIPELINE_LIMITS.checkpointBytes / 2)) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, ...candidate };
        this.terminal = candidate.durableMessage;
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

function isJsonWithin(value: unknown, maxBytes: number): boolean {
  return jsonByteLength(value) <= maxBytes;
}

function normalizeLiveToolInput(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function' || typeof item === 'symbol') return `[${typeof item}]`;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) ?? 'null';
  } catch {
    serialized = '"[Unserializable tool input]"';
  }
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
