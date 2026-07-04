import type { ThinkingLevel, ModelSettings, ModelInfo, ContextWindowUsage } from './models.js';
import type { ChatMessage, ToolCall } from './messages.js';

/** Agent-assigned task-completion classification for a session review.
 *  - `fully`: the session's task was completed.
 *  - `partial`: work was done but the task is not fully resolved.
 *  - `setback`: the session left things worse than it found them (regression /
 *    failed approach that should be revisited). */
export type SessionCompletion = 'fully' | 'partial' | 'setback';

/** An agent review record persisted in the session-review sidecar
 *  (`<data>/session-reviews/reviews.jsonl`). Append-only JSONL keyed by
 *  `sessionPath`; the latest record per path wins. Owned by the
 *  `session_review` tool (the sole writer); the backend reads + watches it to
 *  merge `done`/`rating`/`completion`/`reviewReason`/`evaluatedAt`/
 *  `reviewerBuckets`/`reviewerCount` back into `SessionSummary` (the SDK owns
 *  the session JSONL and exposes no append path to pie, so the review lives in
 *  a sidecar). */
export interface SessionReview {
  sessionPath: string;
  done: boolean;
  rating: number;
  completion: SessionCompletion;
  reason: string;
  evaluatedAt: string;
  /** Sub-agent buckets whose judgments fed the rating (e.g. ['medium','small'])
   *  — captures the multi-reviewer process so agent reviews can be
   *  distinguished from single-shot/user outcomes in analytics. Optional for
   *  backward compat; older records have no field. */
  reviewerBuckets?: string[];
  /** Number of sub-agent reviewers that fed the rating. Optional for backward
   *  compat; older records have no field. */
  reviewerCount?: number;
}

export interface SessionSummary {
  path: string;
  name: string;
  cwd: string;
  modifiedAt: string;
  messageCount: number;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * True when `name` is a backend-generated placeholder (not a user-meaningful
   * label). Lets the host preserve a real local name on top of placeholder
   * refreshes without resorting to string-content heuristics.
   */
  isPlaceholder?: boolean;
  /** Agent review: whether the session's task is marked done. Merged from the
   *  session-review sidecar by the backend; preserved across backend list
   *  refreshes by `mergeSessionSummaryPreservingLocalName`. */
  done?: boolean;
  /** Agent review: 1–5 quality rating. */
  rating?: number;
  /** Agent review: task-completion classification. */
  completion?: SessionCompletion;
  /** Agent review: free-text reason for the rating/completion. */
  reviewReason?: string;
  /** ISO timestamp of the most recent review. */
  evaluatedAt?: string;
  /** Agent review: sub-agent buckets whose judgments fed the rating (e.g.
   *  ['medium','small']) — captures the multi-reviewer process so agent
   *  reviews can be distinguished from single-shot/user outcomes in analytics. */
  reviewerBuckets?: string[];
  /** Agent review: number of sub-agent reviewers that fed the rating. */
  reviewerCount?: number;
}

export type TranscriptPageDirection = 'older' | 'newer' | 'latest';

/**
 * Metadata describing the currently loaded transcript window inside the full
 * display transcript for a session.
 */
export interface TranscriptWindow {
  /** Total display-message rows currently available in the backend cache. */
  totalCount: number;
  /** Inclusive start index (0-based) of the loaded window in the full transcript. */
  loadedStart: number;
  /** Exclusive end index of the loaded window in the full transcript. */
  loadedEnd: number;
  /** True when there are undisplayed older rows before `loadedStart`. */
  hasOlder: boolean;
  /** True when there are undisplayed newer rows after `loadedEnd`. */
  hasNewer: boolean;
  /** True when the loaded window is only a subset of the full transcript. */
  isPartial: boolean;
  /** True when the full transcript contains at least one user message. */
  hasUserMessages: boolean;
}

export interface TranscriptPagePayload {
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
}

export type SystemPromptSource = 'provider' | 'harness' | 'user';

export type SystemPromptAvailability = 'available' | 'missing' | 'hidden' | 'unknown';

export interface SystemPromptEntry {
  source: SystemPromptSource;
  title: string;
  text: string;
  summary: string;
  availability: SystemPromptAvailability;
  /** Full path or extra detail shown on hover when the title is shortened. */
  tooltip?: string;
}

export interface SessionContextFileFactor {
  path: string;
  hash: string;
}

export interface SessionToolSnippetFactor {
  toolId: string;
  hash: string;
}

export interface SessionSkillFactor {
  name: string;
  contentHash: string | null;
  sourceHash: string | null;
  disableModelInvocation: boolean;
  lastModifiedAt: string | null;
}

export interface SessionAnalyticsFactors {
  promptFamily: string | null;
  promptHash: string | null;
  /** ISO timestamp when the prompt factors were captured (session open time). */
  promptCapturedAt: string | null;
  harnessPromptHash: string | null;
  customPromptHash: string | null;
  appendSystemPromptHash: string | null;
  promptGuidelineHashes: string[];
  contextFiles: SessionContextFileFactor[];
  selectedToolIds: string[];
  toolSnippetHashes: SessionToolSnippetFactor[];
  toolSetHash: string | null;
  skills: SessionSkillFactor[];
  skillSetHash: string | null;
  /** Names of extensions active during this run (e.g. 'subagent', 'safeguard'). */
  activeExtensions: string[];
}

export interface BackendReadyPayload {
  sdkPath: string;
  agentDir: string;
  /** Version string of the loaded `@mariozechner/pi-coding-agent` SDK. */
  sdkVersion: string;
  /** Wire protocol version. Must match `PROTOCOL_VERSION` in the host. */
  protocolVersion: number;
  /** Resolved path to the auth.json file used by the backend. */
  authPath?: string;
}

export interface SessionOpenedPayload {
  session: SessionSummary;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  selectionToken?: string;
  /** When true, `transcript`/`transcriptWindow` are NOT authoritative — the
   *  host already holds the loaded transcript and must keep its existing
   *  `bySession`/`windowBySession` entries. The backend omits the (potentially
   *  multi-MB) tail window in this case, shipping only metadata (busy,
   *  contextUsage, modelSettings, availableModels, session summary). Set only
   *  in response to a `session.open` whose `transcript` param was `'skip'`. */
  transcriptSkipped?: boolean;
  systemPrompts?: SystemPromptEntry[];
  analyticsFactors?: SessionAnalyticsFactors;
  modelSettings?: ModelSettings;
  availableModels?: ModelInfo[];
  contextUsage?: ContextWindowUsage;
}

/** How much transcript the host wants in a `session.open` response.
 *  - `'tail'` (default): ship the tail window (full content) — used on first
 *    load and whenever the host needs the authoritative snapshot.
 *  - `'skip'`: omit the transcript; the host already has it loaded. The
 *    backend sets `transcriptSkipped: true` on the `session.opened` payload. */
export type TranscriptMode = 'tail' | 'skip';

export interface SessionListChangedPayload {
  sessions: SessionSummary[];
  activeSessionPath?: string;
}

export interface MessageStartedPayload {
  requestId: string;
  messageId: string;
  sessionPath: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface MessageDeltaPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  delta: string;
}

export interface MessageThinkingPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  thinking: string;
}

export interface ToolStartedPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  /** Epoch milliseconds when the backend began executing the tool call. */
  startedAt: number;
}

export interface ToolFinishedPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  result: unknown;
  status: Extract<ToolCall['status'], 'completed' | 'failed'>;
  /** Wall-clock execution time in milliseconds for this tool call. */
  durationMs?: number;
}

export interface CustomMessagePayload {
  requestId: string;
  sessionPath: string;
  message: ChatMessage;
}

export interface ToolProgressPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  /** Partial result from onUpdate callback — same shape as the final result. */
  partialResult: unknown;
}

export interface MessageFinishedPayload {
  requestId: string;
  sessionPath: string;
  message: ChatMessage;
}

export interface MessageAbortedPayload {
  requestId: string;
  sessionPath: string;
  messageId?: string;
  /** True when the interruption came from an explicit user action (e.g. Stop). */
  userInitiated?: boolean;
  /** Plain-language reason shown to the user for unexpected interruptions. */
  reason?: string;
}

export interface BusyChangedPayload {
  sessionPath: string;
  busy: boolean;
  /**
   * Monotonic per-session sequence number. The host drops out-of-order events
   * for a session (e.g. a stale `busy=false` arriving after an optimistic set).
   */
  seq?: number;
}

export interface ContextUsageChangedPayload {
  sessionPath: string;
  contextUsage: ContextWindowUsage | null;
}

export interface ErrorPayload {
  code: string;
  message: string;
  requestId?: string;
}

/** Post-ack, pre-commit prepass failure payload. Emitted by the backend when
 *  `message.send` has already early-acked (the prompt was queued) but the
 *  pruning prepass then fails. Carries `requestId` (not the host `corrId` —
 *  the backend never sees it); the host reducer resolves `corrId` from
 *  `pending.promoted`. See `docs/STATE_CONTRACT.md` § Optimistic
 *  Reconciliation "Two failure windows for send". */
export interface PreflightFailedPayload {
  requestId: string;
  sessionPath: string;
  error: string;
}

export type FileChangeKind = 'created' | 'modified' | 'deleted';

export interface FileChangeEntry {
  path: string;
  kind: FileChangeKind;
  toolCallId: string;
  messageId: string;
  description: string;
  timestamp: string;
  additions?: number;
  deletions?: number;
}

