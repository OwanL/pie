import type { ThinkingLevel, AssistantUsage } from './models.js';
import type { PruningDetails } from './settings.js';

export type LazyDetailKind = 'tool-result' | 'reasoning';

export interface LazyDetailRef {
  key: string;
  kind: LazyDetailKind;
  source: 'durable' | 'live';
  sessionPath: string;
  messageId: string;
  toolCallId?: string;
  executionId?: string;
  partIndex?: number;
  /** Source revision used to reject a late live-detail response. */
  sourceRevision?: number;
  sizeBytes: number;
  summary: string;
  childCount?: number;
  lineCount?: number;
  available: boolean;
}

export interface DetailRequest {
  sessionPath: string;
  ref: LazyDetailRef;
}

export type DetailResult =
  | { sessionPath: string; key: string; status: 'loaded'; value: unknown; sizeBytes: number }
  | { sessionPath: string; key: string; status: 'failure' | 'unavailable' | 'stale'; message: string };

export type ToolCallStatus = 'drafting' | 'ready' | 'running' | 'completed' | 'failed';

export type ToolCallPhase =
  | 'drafting'
  | 'ready'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_input'
  | 'retry_wait'
  | 'aborting'
  | 'completed'
  | 'failed';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Raw provider-emitted argument JSON for a provisional call. This may be
   * incomplete while `status` is `drafting`; `input` is not a parsed authority. */
  argumentsText?: string;
  result?: unknown;
  /** Compact retrieval identity when a large result is omitted from snapshots. */
  detailRef?: LazyDetailRef;
  status: ToolCallStatus;
  /** Epoch milliseconds when the backend began executing this tool call. */
  startedAt?: number;
  /** Wall-clock execution time in milliseconds, set when the call resolves. */
  durationMs?: number;
  /**
   * Identifier of the parallel batch this tool call belongs to. Every tool
   * call is stamped with a batch id when it starts: it either joins the batch
   * of an already-running sibling on the same assistant message, or starts a
   * new batch. A batch with more than one member renders with the parallel
   * indentation strip in the transcript; a solo/sequential call (a batch of
   * size one) renders as before. Forward-assigned at `tool.started` and
   * carried through message-end replacement, so the grouping is stable for the
   * life of the in-memory session. It is NOT reconstructed when a session is
   * reloaded from disk (the persisted SDK session has no batch metadata), so
   * historical sessions render without the strip.
   */
  parallelGroupId?: string;
  /** Host-only live execution identity used by transcript commit evidence. */
  executionId?: string;
  /** Host-only sequenced lifecycle revision used by transcript commit evidence. */
  seq?: number;
  /** Host-only live/provisional phase used by transcript commit evidence. */
  phase?: ToolCallPhase;
  /** Stable SDK session entry containing this terminal result. */
  durableEntryId?: string;
}

export interface FilesystemPathComposerInput {
  id: string;
  kind: 'filesystemPathRef';
  path: string;
  name: string;
  source: 'picker' | 'drop';
}

export interface ImageBlobComposerInput {
  id: string;
  kind: 'imageBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  width?: number;
  height?: number;
  source: 'paste' | 'drop';
}

export interface FileBlobComposerInput {
  id: string;
  kind: 'fileBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  source: 'paste' | 'drop';
}

export type ComposerInput =
  | FilesystemPathComposerInput
  | ImageBlobComposerInput
  | FileBlobComposerInput;

export type ComposerInputDraft =
  | Omit<FilesystemPathComposerInput, 'id'>
  | Omit<ImageBlobComposerInput, 'id'>
  | Omit<FileBlobComposerInput, 'id'>;

export interface UserContentTextPart {
  kind: 'text';
  text: string;
}

export interface UserContentImagePart {
  kind: 'image';
  mimeType: string;
  dataBase64: string;
  name?: string;
  width?: number;
  height?: number;
}

export type UserContentPart = UserContentTextPart | UserContentImagePart;

export interface ChatMessageTextPart {
  kind: 'text';
  text: string;
}

export interface ChatMessageReasoningPart {
  kind: 'reasoning';
  /** Short summary when detailRef is present; otherwise the complete text. */
  text: string;
  detailRef?: LazyDetailRef;
}

export interface ChatMessageToolCallPart {
  kind: 'toolCall';
  toolCall: ToolCall;
}

/** Transient provider output while a tool call's JSON arguments are streaming. */
export interface DraftingToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export type ChatMessagePart =
  | ChatMessageTextPart
  | ChatMessageReasoningPart
  | ChatMessageToolCallPart;

export interface ChatMessage {
  id: string;
  /**
   * Host-projected identity used only to preserve UI render and scroll
   * continuity when a live assistant row hands off to a durable message whose
   * authoritative `id` differs. It is non-authoritative and must never be used
   * for editing, detail retrieval, commit evidence, or protocol ownership.
   */
  renderIdentity?: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: string;
  markdown: string;
  /** Ordered user content blocks when the message contains structured user input (e.g. pasted images). */
  userParts?: UserContentPart[];
  /** Ordered assistant content blocks as emitted by the agent. */
  parts?: ChatMessagePart[];
  /** Accumulated reasoning/thinking content (only present on assistant messages from reasoning models). */
  thinking?: string;
  /** Retrieval identity when legacy `thinking` was compacted. */
  thinkingDetailRef?: LazyDetailRef;
  /** Live-only tool-call draft; replaced by the authoritative call at message_end. */
  draftingToolCall?: DraftingToolCall;
  /** Model id used for this assistant response, when the backend can determine it. */
  modelId?: string;
  /** Provider that served this response; disambiguates model ids shared across providers. */
  provider?: string;
  /** Reasoning/thinking level used for this assistant response, when available. */
  thinkingLevel?: ThinkingLevel;
  status: 'streaming' | 'completed' | 'interrupted' | 'error' | 'queued';
  /** Human-readable error detail when status is 'error'. */
  errorDetail?: string;
  /**
   * Flat compatibility mirror of tool-call parts. Backend transcript transport
   * may omit `result` here when the matching ordered `parts` entry already
   * carries it; the host restores the mirror after receipt without losing any
   * transcript detail.
   */
  toolCalls?: ToolCall[];
  /**
   * Host-owned monotonic revision for live tool-call state on this message.
   * Incremented for every ToolCall event so render acknowledgements can detect
   * arbitrary partial-result/status updates in O(1), without hashing complete
   * tool results or scanning every tool call on each streaming snapshot.
   */
  toolStateRevision?: number;
  /** How long the response took to complete, in milliseconds. Only set on finished assistant messages. */
  durationMs?: number;
  /**
   * Turn latency: wall-clock time from the previous tool call finishing (or the
   * prompt being sent, for the first turn) to the model's first reply token, in
   * milliseconds. Undefined when not measurable (e.g. no preceding boundary, or
   * the turn produced no content delta). Equals `overheadMs` + `providerLatencyMs`.
   */
  turnLatencyMs?: number;
  /**
   * Portion of turn latency incurred on our side: the gap from the previous
   * tool finishing to the SDK emitting `turn_start` (serial inter-turn work —
   * turn teardown, `prepareNextTurn`, extension hooks). Undefined when
   * `turn_start` was not observed for this turn.
   */
  overheadMs?: number;
  /**
   * Portion of turn latency incurred waiting for the provider: from `turn_start`
   * to the first reply token (request preparation + network + provider TTFT).
   * Undefined when not measurable.
   */
  providerLatencyMs?: number;
  /** Provider-gate permit wait across correlated attempts for this turn. Zero
   * is an observed immediate grant; undefined means unavailable. */
  providerQueueMs?: number;
  /** Number of correlated provider attempts included in `providerQueueMs`. */
  providerQueueAttemptCount?: number;
  /** Token accounting reported by the provider for this assistant turn, when available. */
  usage?: AssistantUsage;
  /** Custom message type from a pi extension (e.g. 'pruning-result'). Present on system messages mapped from custom_message entries. */
  customType?: string;
  /** Structured details from a custom_message entry, when provided by the source extension. Typed per customType. */
  customDetails?: CustomMessageDetails;
  /** Stable SDK session entry for a durability-confirmed terminal message. */
  durableEntryId?: string;
}

/** Custom-type tag for the durable compaction-metrics sidecar entry appended
 *  to the SDK SessionManager branch after a successful compaction. The sidecar
 *  is a non-context `custom` entry (produced by `appendCustomEntry`) — it never
 *  participates in LLM context and never renders as its own transcript row.
 *  On transcript reload, the backend scans sidecars with this tag and attaches
 *  the typed {@link CompactionSummaryDetails} payload to the matching
 *  `compaction-summary` ChatMessage so the metrics survive reload without
 *  editing the SDK or node_modules. */
export const COMPACTION_METRICS_CUSTOM_TYPE = 'pie.compaction-metrics';

/** Durable metrics for a history-compaction LLM call, attached to a
 *  `compaction-summary` ChatMessage via the {@link COMPACTION_METRICS_CUSTOM_TYPE}
 *  SessionManager sidecar. All numeric fields are optional so malformed or
 *  legacy sidecars (written before a field existed, or by a future version with
 *  a different shape) degrade gracefully — the UI shows whichever metrics are
 *  computable. */
export interface CompactionSummaryDetails {
  /** Why compaction ran: `'manual' | 'threshold' | 'overflow'`. May be empty
   *  for a malformed/legacy sidecar. */
  reason: string;
  /** Token count of the prompt footprint just before compaction. */
  tokensBefore?: number;
  /** SDK estimate of the prompt footprint after compaction. */
  estimatedTokensAfter?: number;
  /** Wall-clock duration of the compaction LLM call, in milliseconds.
   *  Absent when the start time was not observed (e.g. a backend restart
   *  between `compaction_start` and `compaction_end`). */
  durationMs?: number;
  /** Model id used for the compaction LLM call, when available. */
  modelId?: string;
  /** Provider that served the compaction LLM call, when available. */
  provider?: string;
  /** Thinking level used for the compaction LLM call, when available. */
  thinkingLevel?: string;
}

/**
 * Discriminated detail payloads keyed by `customType`.
 * Fallback `unknown` covers future extension types that haven't been typed yet.
 */
export type CustomMessageDetails =
  | PruningDetails
  | CompactionSummaryDetails
  | unknown;

