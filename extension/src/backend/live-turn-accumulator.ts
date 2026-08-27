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
import { getSubagentBillingEntries } from '../shared/subagent-result.js';
import { normalizeToolProgress, type ToolProgressRecursiveCounters } from './tool-progress-normalizer.js';
import {
  isBackendLivePipelineTraceEnabled,
  recordBackendLivePipelineTrace,
  recordPhase5DetailAvailability,
} from './live-pipeline-trace-runtime';

export interface ToolProgressMeasurement {
  outcome: 'changed' | 'duplicate';
  /** The normalized ToolPreview is not the SDK source payload. The backend has
   * no producer serialization counter for that source boundary. */
  sourcePayloadBytes?: number;
  producedPayloadBytes?: number;
  availabilityReason?: 'source_preview_not_serialized_at_producer_boundary';
  revision?: number;
  counters?: ToolProgressRecursiveCounters;
}

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
  | { kind: 'turn.toolDraft'; action: 'start'; toolCallId: string; name: string }
  | { kind: 'turn.toolDraft'; action: 'delta'; toolCallId: string; name: string; argumentsJsonDelta: string }
  | { kind: 'turn.toolDraft'; action: 'end'; toolCallId: string; name: string; argumentsJson: string }
  | { kind: 'turn.extensionUi'; uiRequestId: string; action: 'opened' | 'closed' }
  | { kind: 'tool.started'; executionId: string; parentExecutionId: string | null; rootExecutionId: string; toolCallId: string; name: string; input: unknown; startedAt: number; parallelGroupId?: string }
  | { kind: 'tool.progress'; executionId: string; preview: ToolPreview; recursiveCounters?: ToolProgressRecursiveCounters }
  | { kind: 'tool.executionEnded'; executionId: string; status: 'completed' | 'failed'; durationMs?: number }
  | { kind: 'tool.terminal'; executionId: string; status: 'completed' | 'failed'; result: unknown; durationMs?: number; durableEntryId: string }
  | { kind: 'turn.terminal'; terminalKind: 'completed' | 'interrupted' | 'error'; userInitiated?: boolean; reason?: string; durableMessage: ChatMessage; durableEntryId: string };

const MAX_LIVE_TOOL_INPUT_BYTES = LIVE_PIPELINE_LIMITS.toolInputBytes;
const MAX_LIVE_TOOL_INPUT_PREVIEW_BYTES = 2 * 1024;
// Preserve at least the complete detail window that the former total-count cap
// allowed, then compact only older durability-confirmed payloads.
const RETAINED_SETTLED_TOOL_DETAILS = 64;
const COMPACTED_LIVE_INPUT = { liveCompacted: true, detail: 'Durability-confirmed tool input omitted from repair checkpoints.' } as const;
const COMPACTED_LIVE_RESULT = { kind: 'generic', summary: 'Durability-confirmed tool result omitted from repair checkpoints.', liveCompacted: true } as const;
const CHECKPOINT_BYTE_METADATA_PLACEHOLDER = 99_999_999;
/* Sequence values grow while an accepted payload remains resident. Reserve
 * their maximum JSON width up front so even a rejected next observation
 * (9→10, 99→100, …) cannot push the retained checkpoint over its ceiling. */
const CHECKPOINT_SEQUENCE_PLACEHOLDER = Number.MAX_SAFE_INTEGER;
const EXECUTION_END_CHECKPOINT_PLACEHOLDER = {
  status: 'completed' as const,
  durationMs: Number.MAX_VALUE,
};
const JSON_NULL_BYTES = 4;
const JSON_ARRAY_EMPTY_BYTES = 2;
let serializationSample = 0;

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
  /** Exact/conservative serialized-byte components. Large previews are measured
   * once when normalized and are never stringified again by this accounting. */
  private readonly toolCheckpointBytesByExecutionId = new Map<string, number>();
  private aggregateToolCheckpointBytes = 0;
  private partsCheckpointBytes = 2;
  private draftsCheckpointBytes = 2;
  private toolExecutionIdsCheckpointBytes = 2;
  private pendingUiCheckpointBytes = 2;
  private lastProgressMeasurement?: ToolProgressMeasurement;

  constructor(
    private readonly identity: BackendLiveTurnIdentity,
    private readonly observeProgressMeasurement?: (measurement: ToolProgressMeasurement) => void,
  ) {
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
      checkpointBytes: 0,
      toolDraftsByCallId: {},
      aggregateToolDraftBytes: 0,
      toolExecutionIds: [],
      pendingExtensionUiRequestIds: [],
    };
    this.turn = { ...this.turn, checkpointBytes: this.estimateActiveCheckpointBytes(this.turn) };
  }

  get turnId(): string {
    return this.identity.turnId;
  }

  get attemptId(): string {
    return this.identity.attemptId;
  }

  get currentSeq(): number {
    return this.seq;
  }

  observe(candidate: Exclude<BackendSemanticCandidate, { kind: 'tool.progress' | 'turn.toolDraft' }>, occurredAt: number): TurnSemanticEnvelope;
  observe(candidate: Extract<BackendSemanticCandidate, { kind: 'tool.progress' | 'turn.toolDraft' }>, occurredAt: number): TurnSemanticEnvelope | undefined;
  observe(candidate: BackendSemanticCandidate, occurredAt: number): TurnSemanticEnvelope | undefined;
  observe(candidate: BackendSemanticCandidate, occurredAt: number): TurnSemanticEnvelope | undefined {
    if (candidate.kind === 'tool.progress') return this.observeToolProgress(candidate, occurredAt);
    if (candidate.kind === 'turn.toolDraft' && this.turn.phase === 'aborting') {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
    }
    if (candidate.kind === 'turn.toolDraft'
      && Object.values(this.tools).some((tool) => tool.transcriptToolCallId === candidate.toolCallId)) {
      // Provider boundary replay after execution promotion is idempotent. It
      // must not recreate a transient draft or consume a semantic sequence.
      return undefined;
    }
    if (candidate.kind === 'tool.executionEnded') {
      const tool = this.tools[candidate.executionId];
      if (tool?.terminal) {
        const seq = ++this.seq;
        return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
      }
      if (tool?.executionEnd) {
        if (tool.executionEnd.status === candidate.status
          && tool.executionEnd.durationMs === candidate.durationMs) return undefined;
        const seq = ++this.seq;
        return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
      }
    }
    if (candidate.kind === 'tool.terminal') {
      const previousTerminal = this.tools[candidate.executionId]?.terminal;
      if (previousTerminal) {
        // Durability-confirmed completion is a tombstone. A repeated SDK
        // boundary is a no-op; a conflicting completion is rejected without
        // producing another terminal event.
        if (previousTerminal.durableEntryId === candidate.durableEntryId) return undefined;
        const seq = ++this.seq;
        return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
      }
    }
    if (candidate.kind === 'turn.terminal' && this.terminal) {
      if (this.terminal.durableEntryId === candidate.durableEntryId) return undefined;
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
    }
    const seq = ++this.seq;
    const previousTurn = this.turn;
    const candidateExecutionId = 'executionId' in candidate ? candidate.executionId : undefined;
    const previousTool = candidateExecutionId ? this.tools[candidateExecutionId] : undefined;
    const previousAggregatePreviewBytes = this.aggregatePreviewBytes;
    const previousTextBytes = this.textBytes;
    const previousReasoningBytes = this.reasoningBytes;
    const previousExecutionPreviewBytes = candidateExecutionId
      ? this.previewBytesByExecutionId.get(candidateExecutionId)
      : undefined;
    const settledLength = this.settledExecutionIds.length;
    const previousTerminal = this.terminal;
    const previousWatermark = this.watermark;
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
        const previous = ownRecordValue(this.turn.toolDraftsByCallId, candidate.toolCallId);
        let draft: LiveTurnCheckpoint['turn']['toolDraftsByCallId'][string];
        if (candidate.action === 'start') {
          if (previous && previous.name !== candidate.name) {
            return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
          }
          // Duplicate starts are idempotent and never reset accumulated JSON or
          // demote a ready draft.
          draft = previous ?? {
            toolCallId: candidate.toolCallId,
            name: candidate.name,
            argumentsJson: '',
            phase: 'drafting',
          };
        } else if (candidate.action === 'delta') {
          if (!previous || previous.phase !== 'drafting' || previous.name !== candidate.name) {
            return this.replaceWithRejected(seq, occurredAt, previous ? 'malformed_observation' : 'owner_missing');
          }
          draft = { ...previous, argumentsJson: previous.argumentsJson + candidate.argumentsJsonDelta };
        } else {
          if (!previous || previous.name !== candidate.name) {
            return this.replaceWithRejected(seq, occurredAt, previous ? 'malformed_payload' : 'owner_missing');
          }
          if (previous.phase === 'ready' && previous.argumentsJson !== candidate.argumentsJson) {
            return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
          }
          draft = { ...previous, argumentsJson: candidate.argumentsJson, phase: 'ready' };
        }
        if (toolDraftByteLength(draft) > LIVE_PIPELINE_LIMITS.toolDraftBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        const aggregateToolDraftBytes = this.turn.aggregateToolDraftBytes
          - (previous ? toolDraftByteLength(previous) : 0)
          + toolDraftByteLength(draft);
        if (aggregateToolDraftBytes > LIVE_PIPELINE_LIMITS.toolDraftAggregateBytes) {
          return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
        }
        envelope = { ...base, kind: candidate.kind, draft };
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          phase: 'streaming',
          phaseSince: this.turn.phase === 'streaming' ? this.turn.phaseSince : occurredAt,
          lastSemanticProgressAt: occurredAt,
          toolDraftsByCallId: { ...this.turn.toolDraftsByCallId, [draft.toolCallId]: draft },
          aggregateToolDraftBytes,
          parts: previous || this.turn.parts.some((part) => part.kind === 'tool' && part.toolCallId === draft.toolCallId)
            ? this.turn.parts
            : [...this.turn.parts, { kind: 'tool', toolCallId: draft.toolCallId }],
        };
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
        if (this.turn.phase === 'aborting') return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        if (this.tools[candidate.executionId]) return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        if (Object.values(this.tools).some((tool) => tool.transcriptToolCallId === candidate.toolCallId)) {
          return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        }
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
        this.setTool({
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
        });
        const promotedDraft = ownRecordValue(this.turn.toolDraftsByCallId, candidate.toolCallId);
        const toolDraftsByCallId = { ...this.turn.toolDraftsByCallId };
        delete toolDraftsByCallId[candidate.toolCallId];
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          phase: 'running_tool',
          phaseSince: occurredAt,
          lastSemanticProgressAt: occurredAt,
          toolDraftsByCallId,
          aggregateToolDraftBytes: this.turn.aggregateToolDraftBytes
            - (promotedDraft ? toolDraftByteLength(promotedDraft) : 0),
          parts: this.turn.parts.some((part) => part.kind === 'tool' && part.toolCallId === candidate.toolCallId)
            ? this.turn.parts
            : [...this.turn.parts, { kind: 'tool', toolCallId: candidate.toolCallId }],
          toolExecutionIds: [...this.turn.toolExecutionIds, candidate.executionId],
        };
        break;
      }
      case 'tool.executionEnded': {
        const tool = this.tools[candidate.executionId];
        if (!tool) return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
        if (tool.executionEnd || tool.terminal) {
          return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        }
        envelope = { ...base, ...candidate };
        this.setTool({
          ...tool,
          seq,
          lastProgressAt: occurredAt,
          executionEnd: {
            status: candidate.status,
            durationMs: candidate.durationMs,
          },
        });
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          lastSemanticProgressAt: occurredAt,
        };
        break;
      }
      case 'tool.terminal': {
        const tool = this.tools[candidate.executionId];
        if (!tool) return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
        if (!candidate.durableEntryId) return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        if (tool.terminal) return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
        if (tool.executionEnd
          && (tool.executionEnd.status !== candidate.status
            || tool.executionEnd.durationMs !== candidate.durationMs)) {
          return this.replaceWithRejected(seq, occurredAt, 'malformed_payload');
        }
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
        this.setTool({
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
        });
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
        this.turn = {
          ...this.turn,
          seq,
          checkpointSeq: seq,
          lastSemanticProgressAt: occurredAt,
          toolDraftsByCallId: {},
          aggregateToolDraftBytes: 0,
        };
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
    this.refreshTurnCollectionAccounting(previousTurn, this.turn);
    let checkpointBytes = this.estimateActiveCheckpointBytes(this.turn);
    if (!this.terminal && checkpointBytes > LIVE_PIPELINE_LIMITS.checkpointBytes) {
      checkpointBytes = this.compactSettledToolsUntilFits(this.turn);
    }
    // Terminal checkpoints are low-frequency and include the compact durable
    // message, so verify that body once. If it crosses the ceiling, compact
    // oldest durability-confirmed details before rejecting terminalization.
    if (this.terminal) checkpointBytes = this.compactSettledToolsForTerminalCheckpoint(checkpointBytes);
    const checkpointLimit = this.terminal
      ? LIVE_PIPELINE_LIMITS.terminalCheckpointBytes
      : LIVE_PIPELINE_LIMITS.checkpointBytes;
    if (checkpointBytes > checkpointLimit) {
      this.turn = previousTurn;
      this.terminal = previousTerminal;
      this.watermark = previousWatermark;
      this.rebuildTurnCollectionAccounting(previousTurn);
      if (candidateExecutionId) {
        if (previousTool) this.setTool(previousTool);
        else this.deleteTool(candidateExecutionId);
      }
      this.settledExecutionIds.length = settledLength;
      this.aggregatePreviewBytes = previousAggregatePreviewBytes;
      this.textBytes = previousTextBytes;
      this.reasoningBytes = previousReasoningBytes;
      if (candidateExecutionId) {
        if (previousExecutionPreviewBytes === undefined) this.previewBytesByExecutionId.delete(candidateExecutionId);
        else this.previewBytesByExecutionId.set(candidateExecutionId, previousExecutionPreviewBytes);
      }
      return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
    }
    this.turn = { ...this.turn, checkpointBytes };
    return { ...envelope, checkpointBytes };
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
          toolDraftsByCallId: {},
          aggregateToolDraftBytes: 0,
        }
      : this.turn;
    return {
      protocolVersion: this.identity.protocolVersion,
      sessionPath: this.identity.sessionPath,
      turnId: this.identity.turnId,
      attemptId: this.identity.attemptId,
      checkpointSeq: this.seq,
      phase: this.turn.phase,
      checkpointBytes: this.turn.checkpointBytes,
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

  /** Durable identity of the accepted terminal, when one exists. This is a
   * cheap dedupe seam for SDK message_end handling; it does not materialize a
   * checkpoint or inspect recursive terminal detail. */
  terminalDurableEntryId(): string | undefined {
    return this.terminal?.durableEntryId;
  }

  private observeToolProgress(
    candidate: Extract<BackendSemanticCandidate, { kind: 'tool.progress' }>,
    occurredAt: number,
  ): TurnSemanticEnvelope | undefined {
    const startedAt = performance.now();
    const result = this.observeToolProgressMeasured(candidate, occurredAt);
    if (this.lastProgressMeasurement) this.observeProgressMeasurement?.({ ...this.lastProgressMeasurement });
    const toolName = this.tools[candidate.executionId]?.name.trim().toLowerCase();
    if (isBackendLivePipelineTraceEnabled() && toolName === 'subagent') {
      recordPhase5DetailAvailability();
      const metadata = result as (TurnSemanticEnvelope & { previewBytes?: number; progressRevision?: number }) | undefined;
      const traceKind = metadata?.kind === 'observation.rejected' ? 'rejected' : result ? 'success' : 'false';
      const measurement = this.lastProgressMeasurement;
      const identifiers = {
        session: this.identity.sessionPath,
        request: this.identity.requestId,
        turn: this.identity.turnId,
        attempt: this.identity.attemptId,
        tool: candidate.executionId,
      };
      if (measurement) {
        recordBackendLivePipelineTrace({
          stage: 'backend.subagent',
          kind: traceKind,
          phase: 'measure',
          outcome: measurement.outcome,
          payloadClass: 'source',
          sourcePayloadBytes: measurement.sourcePayloadBytes,
          availabilityReason: measurement.sourcePayloadBytes === undefined
            ? measurement.availabilityReason
            : undefined,
          childCount: measurement.counters?.childCount,
          messageCount: measurement.counters?.messageCount,
          maxRecursiveDepth: measurement.counters?.maxRecursiveDepth,
          identifiers,
          revision: measurement.revision,
          processRole: 'coordinator',
          pid: process.pid,
        });
      }
      const currentTool = this.tools[candidate.executionId];
      recordBackendLivePipelineTrace({
        stage: 'backend.subagent',
        kind: traceKind,
        phase: 'diff',
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: measurement?.outcome,
        payloadClass: measurement?.producedPayloadBytes === undefined ? undefined : 'compact',
        producedPayloadBytes: measurement?.producedPayloadBytes,
        childCount: measurement?.counters?.childCount,
        messageCount: measurement?.counters?.messageCount,
        maxRecursiveDepth: measurement?.counters?.maxRecursiveDepth,
        identifiers,
        snapshotBytes: metadata?.previewBytes,
        checkpointSeq: typeof metadata?.seq === 'number' ? metadata.seq : undefined,
        revision: measurement?.revision ?? currentTool?.progressRevision,
        toolStateRevision: measurement?.revision ?? currentTool?.progressRevision,
        eventSeq: typeof metadata?.seq === 'number' ? metadata.seq : undefined,
        processRole: 'coordinator',
        pid: process.pid,
      });
    }
    return result;
  }

  private observeToolProgressMeasured(
    candidate: Extract<BackendSemanticCandidate, { kind: 'tool.progress' }>,
    occurredAt: number,
  ): TurnSemanticEnvelope | undefined {
    this.lastProgressMeasurement = undefined;
    if (this.turn.phase === 'aborting') {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'malformed_observation');
    }
    const tool = this.tools[candidate.executionId];
    if (!tool) {
      const seq = ++this.seq;
      return this.replaceWithRejected(seq, occurredAt, 'owner_missing');
    }
    if (tool.executionEnd || tool.terminal) {
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
    const previousPreviewBytes = this.previewBytesByExecutionId.get(candidate.executionId) ?? 0;
    if (previous && operations.length === 0) {
      // Both values are JSON-safe and structurally equal. Object key order may
      // differ, but that cannot change UTF-8 byte length, so the retained exact
      // preview counter is also exact for this duplicate source update.
      this.lastProgressMeasurement = {
        outcome: 'duplicate',
        availabilityReason: 'source_preview_not_serialized_at_producer_boundary',
        revision: tool.progressRevision ?? 0,
        counters: candidate.recursiveCounters?.available === false ? undefined : candidate.recursiveCounters,
      };
      return undefined;
    }

    const seq = ++this.seq;
    const baseSeq = seq - 1;
    const candidatePreviewBytes = jsonByteLength(candidate.preview);
    this.lastProgressMeasurement = {
      outcome: 'changed',
      availabilityReason: 'source_preview_not_serialized_at_producer_boundary',
      counters: candidate.recursiveCounters?.available === false ? undefined : candidate.recursiveCounters,
    };
    const aggregatePreviewBytes = this.aggregatePreviewBytes - previousPreviewBytes + candidatePreviewBytes;
    if (aggregatePreviewBytes > LIVE_PIPELINE_LIMITS.toolPreviewAggregateBytes) {
      return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
    }

    const baseProgressRevision = tool.progressRevision ?? 0;
    const progressRevision = baseProgressRevision + 1;
    if (this.lastProgressMeasurement) this.lastProgressMeasurement.revision = progressRevision;
    const snapshotUpdate = { kind: 'snapshot' as const, preview: candidate.preview };
    const patchUpdate = { kind: 'patch' as const, operations };
    const snapshotUpdateBytes = jsonByteLength({ kind: 'snapshot', preview: null }) - JSON_NULL_BYTES + candidatePreviewBytes;
    const patchUpdateBytes = previous ? jsonByteLength(patchUpdate) : Number.POSITIVE_INFINITY;
    // Reuse the preview and patch counters already required by aggregate
    // accounting and wire-form selection. Only the tiny snapshot wrapper is
    // serialized here; the recursive preview is not stringified again.
    const update = previous && patchUpdateBytes < snapshotUpdateBytes
      ? patchUpdate
      : snapshotUpdate;
    const updateBytes = update === patchUpdate ? patchUpdateBytes : snapshotUpdateBytes;
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
    const nextTool: LiveToolRecord = {
      ...tool,
      seq,
      preview: candidate.preview,
      previewBytes: candidatePreviewBytes,
      progressRevision,
      lastProgressAt: occurredAt,
    };
    const nextTurn = {
      ...this.turn,
      seq,
      checkpointSeq: seq,
      lastSemanticProgressAt: occurredAt,
      aggregatePreviewBytes,
    };
    let previousToolCheckpointBytes = this.toolCheckpointBytesByExecutionId.get(candidate.executionId) ?? 0;
    const nextToolCheckpointBytes = estimateToolCheckpointBytes(nextTool);
    let nextAggregateToolCheckpointBytes = this.aggregateToolCheckpointBytes
      - previousToolCheckpointBytes + nextToolCheckpointBytes;
    let checkpointBytes = this.estimateActiveCheckpointBytes(nextTurn, nextAggregateToolCheckpointBytes);
    if (checkpointBytes > LIVE_PIPELINE_LIMITS.checkpointBytes) {
      this.compactSettledToolsUntilFits(nextTurn, candidate.executionId, nextToolCheckpointBytes);
      previousToolCheckpointBytes = this.toolCheckpointBytesByExecutionId.get(candidate.executionId) ?? 0;
      nextAggregateToolCheckpointBytes = this.aggregateToolCheckpointBytes
        - previousToolCheckpointBytes + nextToolCheckpointBytes;
      checkpointBytes = this.estimateActiveCheckpointBytes(nextTurn, nextAggregateToolCheckpointBytes);
    }
    if (checkpointBytes > LIVE_PIPELINE_LIMITS.checkpointBytes) {
      return this.replaceWithRejected(seq, occurredAt, 'payload_oversize');
    }
    this.setTool(nextTool);
    this.previewBytesByExecutionId.set(candidate.executionId, candidatePreviewBytes);
    this.aggregatePreviewBytes = aggregatePreviewBytes;
    this.turn = { ...nextTurn, checkpointBytes };
    const producedEnvelope = { ...envelope, checkpointBytes };
    const envelopeSkeletonBytes = jsonByteLength({ ...producedEnvelope, update: null });
    if (this.lastProgressMeasurement) {
      this.lastProgressMeasurement.producedPayloadBytes = envelopeSkeletonBytes - JSON_NULL_BYTES + updateBytes;
    }
    return producedEnvelope;
  }

  private compactSettledToolHistory(): void {
    const compactIndex = this.settledExecutionIds.length - RETAINED_SETTLED_TOOL_DETAILS - 1;
    if (compactIndex < 0) return;
    const executionId = this.settledExecutionIds[compactIndex];
    const tool = executionId ? this.tools[executionId] : undefined;
    if (!tool?.terminal || isLiveCompactedValue(tool.terminal.result)) return;
    this.setTool({
      ...tool,
      immutableInput: COMPACTED_LIVE_INPUT,
      preview: undefined,
      terminal: {
        ...tool.terminal,
        result: COMPACTED_LIVE_RESULT,
        resultBytes: jsonByteLength(COMPACTED_LIVE_RESULT),
      },
    });
  }

  private compactSettledToolsForTerminalCheckpoint(activeEstimate: number): number {
    // The small reserve covers the two cached byte fields changing width when
    // the final conservative total is stored.
    let checkpointBytes = Math.max(activeEstimate, jsonByteLength(this.checkpoint()) + 32);
    for (const executionId of this.settledExecutionIds) {
      if (checkpointBytes <= LIVE_PIPELINE_LIMITS.terminalCheckpointBytes) break;
      const tool = this.tools[executionId];
      if (!tool?.terminal || isLiveCompactedValue(tool.terminal.result)) continue;
      this.setTool({
        ...tool,
        immutableInput: COMPACTED_LIVE_INPUT,
        preview: undefined,
        previewBytes: 0,
        terminal: {
          ...tool.terminal,
          result: COMPACTED_LIVE_RESULT,
          resultBytes: jsonByteLength(COMPACTED_LIVE_RESULT),
        },
      });
      checkpointBytes = Math.max(
        this.estimateActiveCheckpointBytes(this.turn),
        jsonByteLength(this.checkpoint()) + 32,
      );
    }
    return checkpointBytes;
  }

  private compactSettledToolsUntilFits(
    turn: LiveTurnCheckpoint['turn'],
    replacementExecutionId?: string,
    replacementToolBytes?: number,
  ): number {
    let checkpointBytes = this.estimateWithToolReplacement(turn, replacementExecutionId, replacementToolBytes);
    for (const executionId of this.settledExecutionIds) {
      if (checkpointBytes <= LIVE_PIPELINE_LIMITS.checkpointBytes) break;
      const tool = this.tools[executionId];
      if (!tool?.terminal || isLiveCompactedValue(tool.terminal.result)) continue;
      this.setTool({
        ...tool,
        immutableInput: COMPACTED_LIVE_INPUT,
        preview: undefined,
        previewBytes: 0,
        terminal: {
          ...tool.terminal,
          result: COMPACTED_LIVE_RESULT,
          resultBytes: jsonByteLength(COMPACTED_LIVE_RESULT),
        },
      });
      checkpointBytes = this.estimateWithToolReplacement(turn, replacementExecutionId, replacementToolBytes);
    }
    return checkpointBytes;
  }

  private estimateWithToolReplacement(
    turn: LiveTurnCheckpoint['turn'],
    executionId?: string,
    replacementBytes?: number,
  ): number {
    if (!executionId || replacementBytes === undefined) return this.estimateActiveCheckpointBytes(turn);
    const previousBytes = this.toolCheckpointBytesByExecutionId.get(executionId) ?? 0;
    return this.estimateActiveCheckpointBytes(
      turn,
      this.aggregateToolCheckpointBytes - previousBytes + replacementBytes,
    );
  }

  private setTool(tool: LiveToolRecord): void {
    const previousBytes = this.toolCheckpointBytesByExecutionId.get(tool.executionId) ?? 0;
    const nextBytes = estimateToolCheckpointBytes(tool);
    this.tools[tool.executionId] = tool;
    this.toolCheckpointBytesByExecutionId.set(tool.executionId, nextBytes);
    this.aggregateToolCheckpointBytes += nextBytes - previousBytes;
  }

  private deleteTool(executionId: string): void {
    const previousBytes = this.toolCheckpointBytesByExecutionId.get(executionId) ?? 0;
    delete this.tools[executionId];
    this.toolCheckpointBytesByExecutionId.delete(executionId);
    this.aggregateToolCheckpointBytes -= previousBytes;
  }

  private refreshTurnCollectionAccounting(previous: LiveTurnCheckpoint['turn'], next: LiveTurnCheckpoint['turn']): void {
    if (previous.parts !== next.parts) {
      this.partsCheckpointBytes = updatedPartsByteLength(previous.parts, next.parts, this.partsCheckpointBytes);
    }
    if (previous.toolDraftsByCallId !== next.toolDraftsByCallId) {
      this.draftsCheckpointBytes = updatedRecordByteLength(
        previous.toolDraftsByCallId,
        next.toolDraftsByCallId,
        this.draftsCheckpointBytes,
      );
    }
    if (previous.toolExecutionIds !== next.toolExecutionIds) {
      this.toolExecutionIdsCheckpointBytes = updatedStringArrayByteLength(
        previous.toolExecutionIds,
        next.toolExecutionIds,
        this.toolExecutionIdsCheckpointBytes,
      );
    }
    if (previous.pendingExtensionUiRequestIds !== next.pendingExtensionUiRequestIds) {
      this.pendingUiCheckpointBytes = jsonByteLength(next.pendingExtensionUiRequestIds);
    }
  }

  private rebuildTurnCollectionAccounting(turn: LiveTurnCheckpoint['turn']): void {
    this.partsCheckpointBytes = livePartsByteLength(turn.parts);
    this.draftsCheckpointBytes = recordByteLength(turn.toolDraftsByCallId);
    this.toolExecutionIdsCheckpointBytes = jsonByteLength(turn.toolExecutionIds);
    this.pendingUiCheckpointBytes = jsonByteLength(turn.pendingExtensionUiRequestIds);
  }

  private estimateActiveCheckpointBytes(
    turn: LiveTurnCheckpoint['turn'],
    aggregateToolCheckpointBytes = this.aggregateToolCheckpointBytes,
  ): number {
    const turnSkeleton = {
      ...turn,
      seq: CHECKPOINT_SEQUENCE_PLACEHOLDER,
      checkpointSeq: CHECKPOINT_SEQUENCE_PLACEHOLDER,
      checkpointBytes: CHECKPOINT_BYTE_METADATA_PLACEHOLDER,
      parts: null,
      toolDraftsByCallId: null,
      toolExecutionIds: null,
      pendingExtensionUiRequestIds: null,
    };
    const turnBytes = jsonByteLength(turnSkeleton)
      - (4 * JSON_NULL_BYTES)
      + this.partsCheckpointBytes
      + this.draftsCheckpointBytes
      + this.toolExecutionIdsCheckpointBytes
      + this.pendingUiCheckpointBytes;
    const toolCount = this.toolCheckpointBytesByExecutionId.size;
    const toolsBytes = JSON_ARRAY_EMPTY_BYTES
      + aggregateToolCheckpointBytes
      + Math.max(0, toolCount - 1);
    const checkpointSkeleton = {
      protocolVersion: this.identity.protocolVersion,
      sessionPath: this.identity.sessionPath,
      turnId: this.identity.turnId,
      attemptId: this.identity.attemptId,
      checkpointSeq: CHECKPOINT_SEQUENCE_PLACEHOLDER,
      phase: turn.phase,
      checkpointBytes: CHECKPOINT_BYTE_METADATA_PLACEHOLDER,
      turn: null,
      tools: null,
      pendingExtensionUiRequestIds: null,
    };
    return jsonByteLength(checkpointSkeleton)
      - (3 * JSON_NULL_BYTES)
      + turnBytes
      + toolsBytes
      + this.pendingUiCheckpointBytes;
  }

  private replaceWithRejected(seq: number, occurredAt: number, reason: RejectedObservationReason): TurnSemanticEnvelope {
    const next = { ...this.turn, seq, checkpointSeq: seq };
    const checkpointBytes = this.estimateActiveCheckpointBytes(next);
    this.turn = { ...next, checkpointBytes };
    return { ...this.base(seq, occurredAt), checkpointBytes, kind: 'observation.rejected', reason };
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
      checkpointBytes: this.turn.checkpointBytes,
    };
  }
}

function estimateToolCheckpointBytes(tool: LiveToolRecord): number {
  const skeleton = {
    ...tool,
    // An active tool will advance at least once more at execution end. Reserve
    // both sequence-width growth and the largest ordinary execution-end shape
    // so an already-accepted near-limit preview can still stop cleanly.
    seq: tool.terminal ? tool.seq : CHECKPOINT_SEQUENCE_PLACEHOLDER,
    immutableInput: null,
    preview: tool.preview === undefined ? undefined : null,
    executionEnd: tool.executionEnd
      ?? (tool.terminal ? undefined : EXECUTION_END_CHECKPOINT_PLACEHOLDER),
    terminal: tool.terminal
      ? { ...tool.terminal, result: null }
      : undefined,
  };
  return jsonByteLength(skeleton)
    - JSON_NULL_BYTES
    + jsonByteLength(tool.immutableInput)
    + (tool.preview === undefined ? 0 : tool.previewBytes - JSON_NULL_BYTES)
    + (tool.terminal ? tool.terminal.resultBytes - JSON_NULL_BYTES : 0);
}

function livePartsByteLength(parts: LiveTurnCheckpoint['turn']['parts']): number {
  if (parts.length === 0) return JSON_ARRAY_EMPTY_BYTES;
  return JSON_ARRAY_EMPTY_BYTES
    + parts.reduce((total, part) => total + jsonByteLength(part), 0)
    + parts.length - 1;
}

function updatedPartsByteLength(
  previous: LiveTurnCheckpoint['turn']['parts'],
  next: LiveTurnCheckpoint['turn']['parts'],
  currentBytes: number,
): number {
  if (next.length === previous.length + 1
    && previous.every((part, index) => part === next[index])) {
    return currentBytes + (previous.length > 0 ? 1 : 0) + jsonByteLength(next[next.length - 1]);
  }
  if (next.length === previous.length && next.length > 0
    && previous.slice(0, -1).every((part, index) => part === next[index])) {
    const previousLast = previous[previous.length - 1];
    const nextLast = next[next.length - 1];
    if (previousLast && nextLast
      && previousLast.kind === nextLast.kind
      && (previousLast.kind === 'text' || previousLast.kind === 'reasoning')
      && (nextLast.kind === 'text' || nextLast.kind === 'reasoning')
      && nextLast.text.startsWith(previousLast.text)) {
      // Encoding each appended fragment independently is conservative when a
      // surrogate pair happens to be split across semantic observations.
      return currentBytes + jsonStringContentByteLength(nextLast.text.slice(previousLast.text.length));
    }
  }
  return livePartsByteLength(next);
}

function updatedRecordByteLength<T>(
  previous: Record<string, T>,
  next: Record<string, T>,
  currentBytes: number,
): number {
  const changed = Object.keys(next).filter((key) => ownRecordValue(previous, key) !== ownRecordValue(next, key));
  const removed = Object.keys(previous).filter((key) => !Object.prototype.hasOwnProperty.call(next, key));
  if (changed.length === 1 && removed.length === 0) {
    const key = changed[0]!;
    const previousValue = ownRecordValue(previous, key);
    const nextValue = ownRecordValue(next, key);
    if (nextValue === undefined) return jsonByteLength(next);
    if (previousValue !== undefined) {
      return currentBytes - jsonByteLength(previousValue) + jsonByteLength(nextValue);
    }
    const entryBytes = jsonByteLength(key) + 1 + jsonByteLength(nextValue);
    return currentBytes + (Object.keys(previous).length > 0 ? 1 : 0) + entryBytes;
  }
  if (changed.length === 0 && removed.length === 1) return jsonByteLength(next);
  return jsonByteLength(next);
}

function updatedStringArrayByteLength(previous: string[], next: string[], currentBytes: number): number {
  if (next.length === previous.length + 1
    && previous.every((value, index) => value === next[index])) {
    return currentBytes + (previous.length > 0 ? 1 : 0) + jsonByteLength(next[next.length - 1]);
  }
  return jsonByteLength(next);
}

function jsonStringContentByteLength(value: string): number {
  return jsonByteLength(value) - 2;
}

function recordByteLength(record: Record<string, unknown>): number {
  return jsonByteLength(record);
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
  const startedAt = performance.now();
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (isBackendLivePipelineTraceEnabled() && (serializationSample++ & 15) === 0) {
      recordBackendLivePipelineTrace({
        stage: 'backend.mapped',
        kind: 'observation',
        phase: 'serialize',
        durationMs: Math.max(0, performance.now() - startedAt),
        producedPayloadBytes: bytes,
        processRole: 'coordinator',
        pid: process.pid,
      });
    }
    return bytes;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isLiveCompactedValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { liveCompacted?: unknown }).liveCompacted === true;
}

function normalizeLiveToolTerminalResult(toolName: string, value: unknown): unknown {
  const terminalTransportMarker = typeof value === 'object' && value !== null
    ? (value as { $toolResult?: unknown }).$toolResult
    : undefined;
  const transportBounded = terminalTransportMarker === 'truncated'
    || terminalTransportMarker === 'unserializable'
    || terminalTransportMarker === 'detail-available';
  // ask_user has a dedicated completed-state renderer that needs the selected
  // answer from the real terminal payload. Explicit terminal transport markers
  // must also survive normalization; turning one into a plausible empty
  // subagent preview would hide that the complete value lives only durably.
  if (toolName.trim().toLowerCase() !== 'ask_user' && !transportBounded) {
    const normalized = normalizeToolProgress(toolName, value);
    if (normalized.kind !== 'subagent') return normalized;
    const billing = getSubagentBillingEntries(value);
    return billing.length > 0 ? { ...normalized, billing } : normalized;
  }
  const fallback = transportBounded ? '[Unserializable bounded tool result]' : '[Unserializable ask_user result]';
  const serialized = stringifyLiveJsonSafe(value, fallback);
  try { return JSON.parse(serialized) as unknown; }
  catch { return fallback; }
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
