import type { ChatMessage, ContextWindowUsage, ThinkingLevel, ToolFinishedPayload } from '../shared/protocol';
import type { DisplayTranscriptCache } from './transcript-window';
import type { ExtensionUIBridge } from './extension-ui-bridge';
import type { SdkBuildSystemPromptOptions, SdkRuntime, SdkSession } from './sdk';
import type { SessionManagerFence } from './session-manager-fence';
import type { BackendLiveTurnAccumulator } from './live-turn-accumulator';
import type { ProviderIncident } from './provider-incident';

export interface ActiveRequest {
  id: string;
  messageIndex: number;
  modelId?: string;
  /** Provider selected when this request started. */
  provider?: string;
  /** The prompt was dispatched as an extension command (`/name ...`). */
  extensionCommand?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Monotonic SDK turn identity used to keep provider-attempt timing attached
   * to the turn that initiated it, even when a stale attempt settles later. */
  providerTurnSequence?: number;
  /** Correlated provider-gate queue rollups keyed by providerTurnSequence. */
  providerQueueByTurn?: Map<number, { durationMs: number; attemptCount: number }>;
  /** Exact attempt currently between admission and its first body chunk. */
  providerNetworkPendingAttemptId?: string;
  providerNetworkPending?: boolean;
  /** Auto-retry attempt currently being measured. */
  retryTiming?: {
    retryId: string;
    attempt: number;
    startedAt: number;
    scheduledDelayMs: number;
    providerAttemptStartedAt?: number;
  };
  currentMessageId?: string;
  lastAssistantMessageId?: string;
  currentMessageStartedAt?: number;
  customMessageIndex?: number;
  /** Stable session-entry id of the pruning-result already forwarded live. */
  emittedPruningResultEntryId?: string;
  /** Epoch ms when each in-flight tool call began, keyed by toolCallId. */
  toolStartTimes?: Map<string, number>;
  /** Host-render grouping assigned before semantic tool publication. */
  toolParallelGroupByCallId?: Map<string, string>;
  /** Tool name/input captured at execution start. Repeated on tool.finished so
   *  the host never has to recover analytics metadata from a transcript window. */
  toolStartMetadata?: Map<string, { name: string; input: unknown }>;
  /** Terminal candidates withheld until the SDK publishes the persisted
   * toolResult message_end with its stable sessionEntryId. */
  pendingDurableToolTerminals?: Map<string, ToolFinishedPayload>;
  /** Once true, this request no longer rescans the SDK branch for the single
   *  pruning-result entry on every agentic turn. */
  pruningResultLookupComplete?: boolean;
  /**
   * Epoch ms when the current turn-latency window opened: the last
   * `tool_execution_end` (overwritten per tool so the most recent wins), or the
   * prompt-send time for the first turn. Anchors `overheadMs` / `turnLatencyMs`.
   */
  turnBoundaryAt?: number;
  /**
   * Epoch ms when the SDK emitted `turn_start` for the current turn — the start
   * of serial inter-turn work giving way to the provider request. Anchors the
   * overhead / provider-latency split.
   */
  turnStartedAt?: number;
  /**
   * Epoch ms when the provider's first content delta (text or thinking) arrived
   * for the current assistant message. Reset on each assistant `message_start`.
   */
  providerFirstDeltaAt?: number;
  /**
   * Most recent provider/retry error observed during this request. Used to
   * enrich generic terminal stream errors so the UI can show a root cause
   * (for example upstream 429/account suspension) instead of only a parser
   * symptom.
   */
  lastRetryErrorMessage?: string;
  /** Last provider error retained until actual semantic output arrives. Unlike
   * `lastRetryErrorMessage`, this survives a retry's next `message_start` so a
   * subsequent silent timeout can still explain the failed attempt. */
  lastProviderErrorForDiagnostics?: string;
  /** Most specific transport/HTTP incident observed below the SDK. The SDK
   * may reduce this to "Connection error."; session events use this record to
   * preserve the real status, quota reset, and provider in the UI. */
  latestProviderIncident?: ProviderIncident;
  /** Notice identities already emitted for this request, preventing SDK-level
   * retries of one response from flooding the user with duplicate notices. */
  providerIncidentNoticeKeys?: Set<string>;
  /** Bounded settlement watchdog for terminal quota exhaustion. */
  quotaSettlementTimer?: ReturnType<typeof setTimeout>;
  /** A durability-confirmed assistant segment that ended in tool use. When a
   * queued user message is injected after those tools settle, this candidate
   * closes the current UI reply before a fresh live accumulator is created for
   * the assistant output that follows the queued user row. */
  pendingQueuedBoundaryTerminal?: {
    durableMessage: ChatMessage;
    durableEntryId: string;
    reason?: string;
  };
  /** Error message_end is observed before agent_end reveals whether the SDK
   * will retry. Hold the terminal candidate until willRetry=false so a
   * transient attempt cannot tombstone the still-running live turn. */
  pendingErrorTerminal?: {
    durableMessage: ChatMessage;
    durableEntryId: string;
    reason?: string;
  };
  aborted: boolean;
  /** Backend pre-commit safety-net timer (see `PROMPT_TIMEOUT_MS` in
   *  `request-handler.ts`). Armed at `message.send` dispatch; MUST be cleared
   *  at the commit point (first `message_start`) so a healthy multi-turn
   *  agentic run is never aborted mid-stream. Without this clear, the timer
   *  acts as a whole-run ceiling (only cleared on `session.prompt()`
   *  `.finally`), killing any run exceeding `PROMPT_TIMEOUT_MS` even while it
   *  is actively streaming. Cleared in `session-event-handler.ts` on the first
   *  `message_start`, and defensively in `clearActiveRequest`. */
  promptSafetyTimer?: ReturnType<typeof setTimeout>;
  /** In-memory sequenced authority for the current live turn. Never persisted. */
  liveTurnAccumulator?: BackendLiveTurnAccumulator;
  /** Provider semantic inactivity lease; raw HTTP chunks never renew it. */
  semanticLeaseTimer?: ReturnType<typeof setTimeout>;
  semanticLeaseGeneration?: number;
}

export interface SessionContext {
  runtime: SdkRuntime;
  session: SdkSession;
  sessionPath: string;
  /** Monotonic runtime/session binding generation. Async callbacks that belong
   * to a previous SDK session must not publish into a replacement binding,
   * including a self-reopen that keeps the same path. */
  sessionOwnershipEpoch?: number;
  unsubscribe: () => void;
  activeRequest?: ActiveRequest;
  /** Per-session monotonic counter for `busy.changed` events. */
  busySeq: number;
  lastContextUsage?: ContextWindowUsage | null;
  /** SDK estimate of the compacted prompt footprint. Retained until the next
   * assistant usage provides an authoritative measured footprint. */
  postCompactionEstimatedTokens?: number;
  /** Epoch ms when the current history-compaction LLM call began, captured at
   *  `compaction_start` so `compaction_end` can compute `durationMs` for the
   *  `pie.compaction-metrics` sidecar. Cleared on `compaction_end`. Absent
   *  when the backend (re)started mid-compaction, in which case the sidecar is
   *  still appended but omits `durationMs`. */
  compactionStartedAt?: number;
  displayTranscriptCache?: DisplayTranscriptCache;
  /** UI bridge for extension UI requests within this session. */
  uiBridge?: ExtensionUIBridge;
  /** Entry ids the user has toggled off for this session (persists across
   *  reopens via the sidecar store). Applied to both the display entries and
   *  the `_baseSystemPrompt` sent to the model. */
  systemPromptDisabledEntries?: string[];
  /** Active tool set captured when the Tools prompt entry is switched off, so
   * re-enabling it restores provider-visible schemas and executions. */
  systemPromptToolsBeforeDisable?: string[];
  /** Whether ask_user was active when autonomous mode removed it. Used to make
   * disabling autonomous mode an exact restoration rather than enabling a tool
   * that another owner had already hidden. */
  autonomousModeAskUserWasActive?: boolean;
  /** Active MCP tool names captured when the MCP pref was turned off, so
   * re-enabling it restores exactly what was removed (including tools the
   * adapter re-registered while the pref was off). */
  mcpToolsWereActive?: string[];
  /** Bug 6 watchdog: armed on `agent_end willRetry:true`, re-armed on
   *  `auto_retry_start` (delayMs + grace), cleared on `auto_retry_end` /
   *  `agent_end willRetry:false`. If it elapses, emits `operational-error` +
   *  `retry.stuck` so a retry that never completes (provider dies mid-backoff,
   *  extension hook blocks the retry) is observable and recoverable instead of
   *  the session sitting in willRetry forever. */
  willRetryWatchdogTimer?: ReturnType<typeof setTimeout>;
  /** The clear function returned by {@link armWillRetryWatchdog}. Stored on
   *  the context so `auto_retry_end` / `agent_end willRetry:false` can clear it
   *  without re-implementing the timer lookup. */
  willRetryWatchdogClear?: () => void;
  /** Handoff §F: per-session FIFO queue of host-side optimistic `localId`s for
   *  steering/followUp messages that have been queued but not yet delivered.
   *  Pushed on successful `steer()`/`followUp()` in `handleMessageSend`; shifted
   *  on each user-role `message_start` so the backend can correlate delivery
   *  back to the exact optimistic message. Cleared on interrupt/clearQueue.
   *  Absent/empty → fall back to FIFO matching in the host reducer. */
  queuedLocalIds?: string[];
  /** A public extension-command send that has not crossed an agent
   *  message_start. Retained separately so a replacement can terminalize the
   *  early-ack request even if source abort events clear activeRequest first. */
  pendingExtensionCommand?: {
    requestId: string;
    session: SdkSession;
    sessionPath: string;
    sessionOwnershipEpoch: number;
  };
  /** Short-lived in-memory terminal checkpoint retained for host gap repair. */
  terminalLiveTurn?: { accumulator: BackendLiveTurnAccumulator; expiresAt: number };
  /** Replacement runtime created after provider abort teardown failed. */
  recoveryPromise?: Promise<SessionContext>;
  /** This runtime was locally terminalized and must ignore subsequent SDK events. */
  retired?: boolean;
  /**
   * Fence controller for this runtime's SessionManager. Invalidated
   * synchronously on retirement/replacement/shutdown so the retired runtime
   * cannot generate further persisted session entries.
   */
  sessionManagerFence?: SessionManagerFence;
}

export interface SessionPromptState {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
  /** SDK extension runner. Used read-only to report the extensions that were
   * actually loaded instead of inferring them from the prunable tool list. */
  _extensionRunner?: { getExtensionPaths?: () => string[] };
  /** SDK-internal synchronous rebuild used after active tools or extension
   * resources change. Pie wraps it so picker exclusions survive rebuilds. */
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
  /** Unfiltered snapshot of the SDK's `_baseSystemPromptOptions`, captured
   *  before `applySystemPromptTogglesToBasePrompt` filters them for the model
   *  prompt. The display entry list (picker + transcript) is rebuilt from this
   *  so disabled option-driven entries (context files, skills, append) stay
   *  present and re-toggleable instead of disappearing once filtered out of the
   *  live options. Refreshed only when the live options are at least as
   *  complete as the snapshot. */
  _originalSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

export type SessionContextCreationReason = 'new' | 'resume';
