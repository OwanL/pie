import type { ThinkingLevel, AssistantUsage } from './models.js';
import type { PruningDetails } from './settings.js';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: 'running' | 'completed' | 'failed';
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
  text: string;
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
  role: 'user' | 'assistant' | 'system';
  createdAt: string;
  markdown: string;
  /** Ordered user content blocks when the message contains structured user input (e.g. pasted images). */
  userParts?: UserContentPart[];
  /** Ordered assistant content blocks as emitted by the agent. */
  parts?: ChatMessagePart[];
  /** Accumulated reasoning/thinking content (only present on assistant messages from reasoning models). */
  thinking?: string;
  /** Live-only tool-call draft; replaced by the authoritative call at message_end. */
  draftingToolCall?: DraftingToolCall;
  /** Model id used for this assistant response, when the backend can determine it. */
  modelId?: string;
  /** Reasoning/thinking level used for this assistant response, when available. */
  thinkingLevel?: ThinkingLevel;
  status: 'streaming' | 'completed' | 'interrupted' | 'error' | 'queued';
  /** Human-readable error detail when status is 'error'. */
  errorDetail?: string;
  toolCalls?: ToolCall[];
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
  /** Token accounting reported by the provider for this assistant turn, when available. */
  usage?: AssistantUsage;
  /** Custom message type from a pi extension (e.g. 'pruning-result'). Present on system messages mapped from custom_message entries. */
  customType?: string;
  /** Structured details from a custom_message entry, when provided by the source extension. Typed per customType. */
  customDetails?: CustomMessageDetails;
}

/** Details for a `deferred-trigger` custom user message (the wake-up text the
 *  host injects to resume a deferred session). Carries the human-readable fire
 *  reason so the webview can badge the bubble without re-parsing the text. */
export interface DeferredTriggerDetails {
  reason: string;
}

/**
 * Discriminated detail payloads keyed by `customType`.
 * Fallback `unknown` covers future extension types that haven't been typed yet.
 */
export type CustomMessageDetails = PruningDetails | DeferredTriggerDetails | unknown;

