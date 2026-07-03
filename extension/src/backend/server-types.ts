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
}

export interface SessionPromptState {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

export type SessionContextCreationReason = 'new' | 'resume';
