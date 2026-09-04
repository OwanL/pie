import type { ThinkingLevel, ModelSettings, ModelInfo, ContextWindowUsage, InitialContextEstimate } from './models.js';
import type { ChatMessage, ToolCall } from './messages.js';
import type { LiveTurnCheckpoint, ToolPreview } from '../live-pipeline-protocol.js';
import type { SessionUsageSnapshot } from '../session-usage.js';
import { SESSION_SNAPSHOT_TOO_LARGE_CODE } from './core.js';
export type { SessionUsageSnapshot } from '../session-usage.js';
import type {
  SessionAnalyticsFactors,
  SessionContextFileFactor,
  SessionSkillFactor,
  SessionToolSnippetFactor,
} from '../../../../shared/run-analytics-contracts.js';

export type {
  SessionAnalyticsFactors,
  SessionContextFileFactor,
  SessionSkillFactor,
  SessionToolSnippetFactor,
};

/** Filename of the append-only closure-action outbox beside reviews.jsonl. */
export const REVIEW_CLOSURE_ACTIONS_FILE = 'closure-actions.jsonl';

export type ClosureActionKind = 'closeReviewed' | 'closeSelf';
export type ClosureActionStatus = 'pending' | 'succeeded' | 'failed' | 'retrying';

/** Explicit tab-closure action. Latest record per actionId is its current
 *  outbox state; closure actions never live in reviews.jsonl. */
export interface ClosureAction {
  actionId: string;
  kind: ClosureActionKind;
  targetSessionId: string;
  targetSessionPath?: string;
  reviewId?: string;
  status: ClosureActionStatus;
  attempts: number;
  lastError?: string;
  requestedAt: string;
  settledAt?: string;
}

export interface SessionSummary {
  path: string;
  name: string;
  cwd: string;
  modifiedAt: string;
  messageCount: number;
  modelId?: string;
  /** Provider serving `modelId`; distinguishes IDs shared by multiple providers. */
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * True when `name` is a backend-generated placeholder (not a user-meaningful
   * label). Lets the host preserve a real local name on top of placeholder
   * refreshes without resorting to string-content heuristics.
   */
  isPlaceholder?: boolean;
  /** Host-only lifecycle hint for a create/duplicate tab. It is omitted once
   * the durable session is resolved. */
  creationState?: 'pending' | 'delayed';
  /** Host-only retry identity for a pending/delayed create operation. */
  createOperationId?: string;
  /** Stable ID from the session JSONL header. Falls back to the normalized
   *  path hash only when the header is missing or malformed. */
  sessionId?: string;
  identityFallback?: boolean;
  /** True when a canonical V2 production review exists. */
  reviewed?: boolean;
  /** Canonical V2 production review identity. */
  reviewId?: string;
  reviewedAt?: string;
  /** Current explicit closure-action outbox records targeting this session.
   *  The host drains only pending/retrying actions. */
  closureActions?: ClosureAction[];
  /** True when this tab is pinned (browser-style pinned tab). Populated by
   *  the host when pushing open-tab summaries so the `session_review` tool's
   *  listOpen can show which tabs are pinned and skip them during review. */
  pinned?: boolean;
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
  /** Stable identifier used to toggle this entry on/off per session. Entries
   *  built by `buildSessionSystemPrompts` always carry an `id`; legacy/test
   *  fixtures may omit it (the webview falls back to `title`). */
  id?: string;
  /** True when the user has toggled this entry off for the session. A disabled
   *  entry is stripped from the system prompt sent to the model AND hidden from
   *  the transcript display. Absent/`false` = enabled. */
  disabled?: boolean;
  /** False for display-only entries that pi cannot strip from the sent prompt
   *  and the user therefore cannot toggle. The provider card is the canonical
   *  case: the provider's own system prompt is injected server-side and is
   *  outside pi's control, so "turning it off" is impossible. Such entries are
   *  always shown in the transcript (never hidden) and never render a checkbox
   *  in the toggle menu. Absent/`true` = toggleable. */
  toggleable?: boolean;
}

export interface BackendReadyPayload {
  sdkPath: string;
  agentDir: string;
  /** Host-authoritative backend process generation. Optional only for legacy peers. */
  backendGeneration?: number;
  /** Version string of the loaded `@mariozechner/pi-coding-agent` SDK. */
  sdkVersion: string;
  /** Wire protocol version. Must match `PROTOCOL_VERSION` in the host. */
  protocolVersion: number;
  /** Resolved path to the auth.json file used by the backend. */
  authPath?: string;
}

export type SessionPrimaryOperationKind =
  | 'session.create'
  | 'session.duplicate'
  | 'message.send'
  | 'message.edit'
  | 'message.interrupt'
  | 'message.continue'
  | 'message.compact';
export type SessionPrimaryOperationPhase = 'awaiting-acceptance' | 'awaiting-commit' | 'ambiguous';
export type SessionOperationRecoveryAction = 'retry' | 'restart-backend' | 'reconcile' | null;

/** Compact projection of reducer-owned operation truth. The backend continues
 * to own billable activity; it does not originate this host-only projection. */
export type SessionPrimaryOperation = Record<string, string | number | boolean | null> & {
  operationId: string;
  kind: SessionPrimaryOperationKind;
  phase: SessionPrimaryOperationPhase;
  attempt: number;
  committed: boolean;
  recovery: SessionOperationRecoveryAction;
};

export interface SessionCapabilities {
  /** True while provider, retry, compaction, queued continuation, bash/tool, or
   * another backend-exposed billable window can still run automatically. */
  billableActivity: boolean;
  canContinue: boolean;
  canInterrupt: boolean;
  canCompact: boolean;
  /** Current non-terminal reducer-owned operation, when one controls the path. */
  primaryOperation?: SessionPrimaryOperation;
}

export interface SessionOpenedPayload {
  session: SessionSummary;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  busy: boolean;
  /** Backend-classified capabilities from the complete live/durable session,
   * independent of the bounded transcript window transported to the host. */
  capabilities?: SessionCapabilities;
  /** Whether the backend has materialized the execution runtime for this
   * session. Cold durable browsing explicitly reports false; hot snapshots
   * report true. Omission is accepted only for legacy peers and means ready. */
  runtimeReady?: boolean;
  /** True while the session is running a history-compaction LLM call
   *  (`isStreaming`/`activeRequest` are both false then, so `busy` alone
   *  cannot distinguish compaction from idle). Lets the host restore the
   *  "Compacting…" indicator when a session is opened mid-compaction. */
  isCompacting?: boolean;
  /** Atomic recovery snapshot for a busy session. A tab open must not depend
   * on the host having received every earlier streaming event: this checkpoint
   * reconstructs the complete in-progress assistant/tool turn. When absent,
   * the backend keeps the durable assistant tail visible as a fail-safe. */
  liveTurnCheckpoint?: LiveTurnCheckpoint;
  /** Bounded identity retained when transport fitting must omit an oversized
   * live checkpoint. It lets a host with no prior LiveTurnRecord request the
   * exact in-memory checkpoint instead of depending on stale local identity. */
  liveTurnRecoveryIdentity?: {
    turnId: string;
    attemptId: string;
  };
  /** The full lossless transcript snapshot could not fit even after whole-row
   * culling. This event is metadata-only: a host with a loaded window preserves
   * it, while a cold host keeps the explicit empty/gapped window and surfaces
   * the bounded notice. The durable transcript is never byte-truncated. */
  snapshotUnavailable?: {
    code: typeof SESSION_SNAPSHOT_TOO_LARGE_CODE;
    message: string;
  };
  selectionToken?: string;
  /** SDK-driven runtime replacement source. The host atomically rekeys the
   * selected/open tab from this released source to `session.path`; this is not
   * a create/duplicate operation identity or a reusable selection token. */
  replacesSessionPath?: string;
  /** Host-generated create-operation identity (additive optional). When a
   *  `session.create`/`session.duplicate` carried an `operationId`, the
   *  resulting `session.opened` echoes it so the host can reconcile a late
   *  success with the exact operation across retries. Absent for legacy
   *  peers and for `session.opened` events that are not create/duplicate
   *  publications. */
  operationId?: string;
  /** Attempt that produced this publication; pairs with operationId so host
   * request-start fences remain exact across timed-out retries. */
  operationAttempt?: number;
  /** When true, `transcript`/`transcriptWindow` are NOT authoritative — the
   *  host already holds the loaded transcript and must keep its existing
   *  `bySession`/`windowBySession` entries. The backend omits the (potentially
   *  multi-MB) tail window in this case, shipping only metadata (busy,
   *  contextUsage, modelSettings, availableModels, session summary). Set only
   *  in response to a `session.open` whose `transcript` param was `'skip'`. */
  transcriptSkipped?: boolean;
  systemPrompts?: SystemPromptEntry[];
  /** Cold-session confirmation for a system-prompt toggle write. A cold
   * coordinator has no runtime prompt catalog to rebuild, so it returns the
   * authoritative disabled-id set and the host applies it to the prompt entries
   * it already owns. A later hot snapshot replaces those entries normally. */
  systemPromptDisabledEntries?: string[];
  analyticsFactors?: SessionAnalyticsFactors;
  modelSettings?: ModelSettings;
  availableModels?: ModelInfo[];
  contextUsage?: ContextWindowUsage;
  /** Fresh all-configured initial catalog estimate for an empty cold session.
   * Omitted on helper failure/timeout and on every hot runtime snapshot. */
  initialContextEstimate?: InitialContextEstimate;
  /** Complete durable billable usage for the branch, independent of the loaded transcript window. */
  sessionUsage?: SessionUsageSnapshot;
}

/** How much transcript the host wants in a `session.open` response.
 *  - `'tail'` (default): ship the tail window (full content) — used on first
 *    load and whenever the host needs the authoritative snapshot.
 *  - `'skip'`: omit the transcript; the host already has it loaded. The
 *    backend sets `transcriptSkipped: true` on the `session.opened` payload. */
export type TranscriptMode = 'tail' | 'skip';

/** Progress of the coordinator's derived session-history catalog. `processed`
 * counts transcript files whose current fingerprint has reached a durable
 * conclusion (including invalid files that intentionally produce no row). */
export interface SessionCatalogProgress {
  complete: boolean;
  processed: number;
  /** Known canonical transcript count. Omitted while the fast durable snapshot
   * is shown ahead of the first background inventory walk. */
  total?: number;
}

export interface SessionListChangedPayload {
  sessions: SessionSummary[];
  activeSessionPath?: string;
  /** Optional for compatibility with older backends. When absent, the
   * received list is treated as complete. */
  sessionCatalogProgress?: SessionCatalogProgress;
}

export interface MessageStartedPayload {
  requestId: string;
  operationId?: string;
  operationAttempt?: number;
  messageId: string;
  sessionPath: string;
  modelId?: string;
  provider?: string;
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

export interface MessageToolCallDeltaPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  name: string;
  delta: string;
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
  /** Stable grouping for concurrently-running sibling calls. */
  parallelGroupId?: string;
}

export interface ToolFinishedPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  /** Authoritative tool metadata, repeated from tool.started so terminal
   *  analytics do not depend on the owner message remaining loaded. */
  name?: string;
  input?: unknown;
  result: unknown;
  status: Extract<ToolCall['status'], 'completed' | 'failed'>;
  /** Backend execution start, repeated so interval analytics do not depend on
   * an in-memory/transcript tool.started record surviving until terminal. */
  startedAt?: number;
  /** Wall-clock execution time in milliseconds for this tool call. */
  durationMs?: number;
  /** Stable grouping for concurrently-running sibling calls. */
  parallelGroupId?: string;
  /** Stable SDK toolResult session entry; present only after persistence. */
  durableEntryId?: string;
  /** Full-result side-effect channel; canonical live state already terminalized. */
  canonicalLive?: boolean;
}

export interface CustomMessagePayload {
  requestId: string;
  operationId?: string;
  sessionPath: string;
  message: ChatMessage;
}

export interface ToolProgressPayload {
  requestId: string;
  sessionPath: string;
  messageId: string;
  toolCallId: string;
  /** Typed bounded rendering preview; never a raw SDK onUpdate value. */
  preview: ToolPreview;
}

export interface MessageFinishedPayload {
  requestId: string;
  operationId?: string;
  operationAttempt?: number;
  sessionPath: string;
  message: ChatMessage;
}

export interface MessageAbortedPayload {
  requestId: string;
  operationId?: string;
  operationAttempt?: number;
  sessionPath: string;
  messageId?: string;
  /** Optimistic queued-user identity when cancellation occurs before delivery. */
  localId?: string;
  /** Explicit terminal settlement when a continuation is cancelled,
   * superseded, or fails before Pi creates a matching assistant turn. */
  outcome?: 'cancelled' | 'superseded' | 'failed';
  /** True when the interruption came from an explicit user action (e.g. Stop). */
  userInitiated?: boolean;
  /** Plain-language reason shown to the user for unexpected interruptions. */
  reason?: string;
}

export interface AgentSettledPayload {
  sessionPath: string;
  capabilities: SessionCapabilities;
}

export interface BusyChangedPayload {
  sessionPath: string;
  busy: boolean;
  capabilities?: SessionCapabilities;
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
  operationId?: string;
  sessionPath: string;
  error: string;
}

/** Steering delivery signal. Emitted by the backend when the agent loop
 *  injects a queued steering user message into the current turn (the SDK emits
 *  `message_start` with `role: 'user'` for each injected queued message —
 *  delivered after the in-flight tool calls finish, before the next LLM call).
 *  The host uses this to promote its optimistic 'queued' transcript message to
 *  'completed'. Carries the user-visible text for observability; the host
 *  promotes the EARLIEST 'queued' message (FIFO order — the SDK drains the
 *  queue one message at a time in enqueue order), so text is not used for
 *  matching (the SDK may have expanded skill/template commands). */
export interface QueuedDeliveredPayload {
  sessionPath: string;
  text: string;
  operationId?: string;
  /** Host-side optimistic message ID of the delivered queued message, when the
   *  backend can correlate it (handoff §F: queued-message liveness). The backend
   *  mirrors the SDK's FIFO steering/followUp drain order in a per-session
   *  `queuedLocalIds` queue (pushed on `steer()`/`followUp()` success, shifted on
   *  each user-role `message_start`); the shifted `localId` flows back here so the
   *  host reducer can promote the *exact* optimistic 'queued' message truthfully
   *  instead of guessing by FIFO order. Absent for a legacy host that did not send
   *  a `localId` in `message.send`, or when the backend's queue was emptied
   *  (clear/interrupt race) before the SDK drained — the host then falls back to
   *  FIFO matching (the earliest remaining 'queued' message). */
  localId?: string;
}

/** Live auto-retry status for a session's in-flight turn. The SDK retries
 *  transient provider errors (overloaded / rate-limit / 5xx / transport) with
 *  exponential backoff; this records the attempt currently sleeping/retrying
 *  so the webview can surface "Retrying 2 of 3…" with a Cancel affordance.
 *  Driven by the SDK's `auto_retry_start` / `auto_retry_end` events. */
export interface RetryStatus {
  /** 1-based retry attempt number (1 = first retry after the initial failure). */
  attempt: number;
  /** Max retry attempts configured (`retry.maxRetries`). */
  maxAttempts: number;
  /** Backoff delay (ms) the SDK is sleeping before this attempt. */
  delayMs: number;
  /** Verbatim provider error that triggered the retry (e.g. "429 Too Many Requests"). */
  errorMessage: string;
}

/** Emitted by the backend when the SDK begins an auto-retry attempt (after a
 *  transient error), just before the exponential-backoff sleep. The webview
 *  surfaces this as a "Retrying N of M…" status chip with a Cancel button. */
export interface RetryStartedPayload {
  sessionPath: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  /** Backend request identity; present on timing-aware backends. */
  requestId?: string;
  /** Stable request+retry-attempt source key for analytics deduplication. */
  retryId?: string;
  /** Epoch milliseconds when the SDK scheduled this retry. */
  startedAt?: number;
}

/** Emitted by the backend when an auto-retry attempt concludes — on success
 *  (the retried turn produced a non-error assistant message), on final failure
 *  (retries exhausted), or on cancellation (`session.abort()` aborted the
 *  retry sleep). Clears the retry status chip. */
export interface RetryEndedPayload {
  sessionPath: string;
  success: boolean;
  attempt: number;
  finalError?: string;
}

/** Analytics-only terminal timing for one retry attempt. Emitted when another
 * attempt supersedes it or the retry episode ends. */
export interface RetryMeasuredPayload {
  sessionPath: string;
  requestId: string;
  retryId: string;
  /** Observed scheduling→provider-attempt delay; absent for ungated providers. */
  measuredDelayMs?: number;
  /** Observed scheduling→attempt terminal/superseding boundary. */
  durationMs: number;
}

/** Emitted by the backend when a history-compaction (`/compact`) LLM call
 *  starts. The host uses it to surface a live "Compacting…" indicator (the
 *  SDK emits no `message_start`/`message_end` for compaction, so without this
 *  event the session would read as idle or generically busy). */
export interface CompactionStartedPayload {
  sessionPath: string;
  /** Present for a host-requested manual compaction. */
  operationId?: string;
  operationAttempt?: number;
}

/** Why history compaction was requested. This mirrors the SDK's
 *  `compaction_end.reason` field. */
export type CompactionReason = 'manual' | 'threshold' | 'overflow';

/** Explicit terminal result for one history-compaction LLM call. */
export type CompactionOutcome = 'succeeded' | 'failed' | 'aborted';

/** Emitted by the backend when a history-compaction (`/compact`) LLM call
 *  finishes. Compaction emits no `message_start`/`message_end`, so this event is
 *  the only signal the host has to count it against the run. The outcome is
 *  derived from the SDK's `result` and `aborted` fields. When the compaction
 *  produced a result, the payload also carries the token metrics so the UI can
 *  report how much context was freed. */
export interface CompactionPayload {
  sessionPath: string;
  /** Present for a host-requested manual compaction. */
  operationId?: string;
  operationAttempt?: number;
  /** SDK reason (`manual`, `threshold`, or `overflow`), when reported. */
  reason?: CompactionReason;
  /** Explicit terminal outcome for this compaction attempt. */
  outcome: CompactionOutcome;
  /** Epoch milliseconds when the compaction LLM call finished. */
  occurredAt?: number;
  /** Prompt tokens before compaction (from the SDK result). */
  tokensBefore?: number;
  /** Post-compaction token estimate (from the SDK result). */
  estimatedTokensAfter?: number;
}

/** Settlement evidence from one observable SDK LLM response. Optional token
 * fields plus instrumentationGap represent providers that omit usage. */
export interface AuxiliaryLlmUsagePayload {
  sessionPath: string;
  kind: 'assistant_message' | 'history_compaction' | 'branch_summary' | 'session_title' | 'other';
  sourceId: string;
  occurredAt: string;
  modelId?: string;
  provider?: string;
  parentOperationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  providerTotalTokens?: number;
  reportedCostUsd?: number;
  durationMs?: number;
  startedAt?: string;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  instrumentationGap?: boolean;
  instrumentationGapReason?: string;
}

/** Operational (non-fatal) backend condition that the user should be made
 *  aware of without it being a hard request failure. Emitted by two backend
 *  watchdogs:
 *  - `INTERRUPT_ABORT_STUCK` (request-handler.ts interrupt-abort watchdog):
 *    `session.abort()` invoked by `message.interrupt` did not settle within
 *    the watchdog window; `activeRequest` was force-cleared so the session is
 *    not permanently blocked. The side effects (clear + busy=false) are
 *    already wired — only the notice was lost before this channel was wired.
 *  - `RETRY_STUCK` (session-event-handler.ts willRetry watchdog): a retry's
 *    backoff did not complete within `delayMs + grace`; emitted alongside a
 *    `retry.stuck` event carrying the structured timing detail.
 *
 *  The host surfaces this as a non-blocking `operational-error` notice
 *  (recovery action: show-logs). When `detail` is present, the short message
 *  remains readable while the credential-redacted diagnostic is available
 *  behind the notice's More control. It does NOT roll back optimistic state
 *  or abort a turn — the watchdogs already performed their side effects. */
export interface OperationalErrorPayload {
  /** Identity of this asynchronous incident, distinct from any RPC response. */
  incidentId?: string;
  /** Stable machine code (e.g. `INTERRUPT_ABORT_STUCK`, `RETRY_STUCK`). */
  code: string;
  /** Plain-language message safe to surface to the user. */
  message: string;
  /** Actionable backend diagnostic; may include the last provider error. */
  detail?: string;
  sessionPath: string;
  requestId?: string;
}

/** Emitted by the backend's willRetry watchdog when a retry's backoff did not
 *  complete within `delayMs + graceMs` (the provider may be down mid-backoff,
 *  or an extension hook blocked the retry). Fires alongside an
 *  `operational-error` (code `RETRY_STUCK`) which carries the user-facing
 *  message. The host relies on that companion event for reporting and does not
 *  dispatch a second reducer event, avoiding duplicate notices. */
export interface RetryStuckPayload {
  sessionPath: string;
  /** SDK-reported backoff delay (ms) the retry was sleeping. */
  delayMs: number;
  /** Grace (ms) added on top of `delayMs` before the watchdog declared stuck. */
  graceMs: number;
  requestId?: string;
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
