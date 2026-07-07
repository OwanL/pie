import type { ContextWindowUsage, ThinkingLevel } from '../shared/protocol';
import type { DisplayTranscriptCache } from './transcript-window';
import type { ExtensionUIBridge } from './extension-ui-bridge';
import type { SdkBuildSystemPromptOptions, SdkRuntime, SdkSession } from './sdk';

export interface ActiveRequest {
  id: string;
  messageIndex: number;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  currentMessageId?: string;
  lastAssistantMessageId?: string;
  currentMessageStartedAt?: number;
  customMessageIndex?: number;
  /** Epoch ms when each in-flight tool call began, keyed by toolCallId. */
  toolStartTimes?: Map<string, number>;
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
}

export interface SessionContext {
  runtime: SdkRuntime;
  session: SdkSession;
  sessionPath: string;
  unsubscribe: () => void;
  activeRequest?: ActiveRequest;
  /** Per-session monotonic counter for `busy.changed` events. */
  busySeq: number;
  lastContextUsage?: ContextWindowUsage | null;
  displayTranscriptCache?: DisplayTranscriptCache;
  /** UI bridge for extension UI requests within this session. */
  uiBridge?: ExtensionUIBridge;
  /** Entry ids the user has toggled off for this session (persists across
   *  reopens via the sidecar store). Applied to both the display entries and
   *  the `_baseSystemPrompt` sent to the model. */
  systemPromptDisabledEntries?: string[];
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
}

export interface SessionPromptState {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

export type SessionContextCreationReason = 'new' | 'resume';
