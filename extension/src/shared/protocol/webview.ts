import type { ThinkingLevel, ModelSettings, ModelInfo, ContextWindowUsage } from './models.js';
import type { ComposerInput, ComposerInputDraft, ChatMessage } from './messages.js';
import type { SessionSummary, TranscriptWindow, SystemPromptEntry, FileChangeEntry } from './sessions.js';
import type { ExtensionInfo, PruningResult, PruningSettings, ProxySettings, ProxySettingsUpdate, PruningCatalog, ChatPrefs, ActiveRunSummary, RunOutcome } from './settings.js';
import type { TokenRateIndicatorState } from '../token-rate.js';
import type { NoticeKind } from '../error-mapping.js';

/** Base fields shared by all extension UI request variants. */
export interface ExtensionUIRequestBase {
  id: string;
  sessionPath: string;
  extensionId?: string;
  /** When set, links this request to a subagent tool call in the parent session. */
  subagentCallId?: string;
  /** When set, links this request to the running tool call that issued it (main-agent ask_user, etc.). */
  toolCallId?: string;
}

/** A pending extension UI request (backend → host → webview). */
export type ExtensionUIRequestPayload =
  | (ExtensionUIRequestBase & { method: 'confirm'; title: string; message: string })
  | (ExtensionUIRequestBase & { method: 'select'; title: string; options: string[] })
  | (ExtensionUIRequestBase & { method: 'input'; title: string; placeholder?: string })
  | (ExtensionUIRequestBase & { method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' });

/** Response from the webview (webview → host → backend). */
export interface ExtensionUIResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface StateAppliedPayload {
  revision: number;
  backendReady: boolean;
  transcriptLoaded: boolean;
  openTabCount: number;
  transcriptCount: number;
  systemPromptCount: number;
  domTranscriptLoaderPresent: boolean;
  domTabsConnectingPresent: boolean;
}

/** The full view state sent from the extension host to the webview. */
export interface ViewState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  /** Pinned tab paths (browser-style: pinned tabs cluster at the left). */
  pinnedTabPaths: string[];
  runningSessionPaths: string[];
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  /** True once the active session's initial transcript snapshot has been received. */
  transcriptLoaded: boolean;
  /** Host-owned pending inputs for the active session. */
  pendingComposerInputs: ComposerInput[];
  /** Most recent run summary for the active session, including recently completed runs. */
  activeRunSummary: ActiveRunSummary | null;
  /** Per-session run summaries used for tab affordances and context menus. */
  runSummariesBySession: Record<string, ActiveRunSummary | null>;
  /**
   * Per-session live token-rate indicator state, measured host-side for every
   * running session (including ones that are not the active/selected tab) so
   * the average keeps collecting while a session is in the background. The
   * webview displays `tokenRateBySession[activeSession.path]`. Sessions
   * without an entry fall back to the idle state.
   */
  tokenRateBySession: Record<string, TokenRateIndicatorState>;
  /** Persisted composer draft text for the active session. */
  draftText: string;
  busy: boolean;
  notice: string | null;
  /** Failure category for the current notice, or null when the notice is a
   *  plain info/warning string (or there is no notice). Set ONLY at the Brief H
   *  error sites (send/edit/prepass failures) alongside a plain-language
   *  `notice`; the webview renders recovery action buttons for known kinds
   *  (see `noticeActionsFor`). `null` everywhere else so non-error notices keep
   *  their existing string-only rendering. Invariant: `noticeKind` is non-null
   *  only when `notice` is an H-category error message. */
  noticeKind?: NoticeKind | null;
  /** Raw, unredacted full error string behind the short `notice` summary, or
   *  null. The webview renders a "show more" affordance that reveals this
   *  verbatim (including internal `req-NN` correlation ids) for debugging.
   *  Cleared alongside `notice` on dismiss/replace. */
  noticeRaw?: string | null;
  /** True once the backend process has started and emitted `backend.ready`. */
  backendReady: boolean;
  workspaceCwd: string | null;
  systemPrompts: SystemPromptEntry[];
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  prefs: ChatPrefs;
  /** Extensions discovered from the backend (tools + hooks). */
  availableExtensions: ExtensionInfo[];
  /** File changes tracked from tool calls in the active session. */
  fileChanges: FileChangeEntry[];
  /** Whether the file-changes rail drawer is expanded for the active session. */
  fileChangesExpanded: boolean;
  /**
   * Paths of changed files the user has marked as read for the active session
   * (host state — see STATE_CONTRACT § Webview-Local State). Read files sort to
   * the bottom of the list and render darkened; viewing a file/diff adds the
   * path here, and a new tool-call modification removes it (email-like). A path
   * may appear here even if it's no longer in `fileChanges` (stale entries are
   * harmless — the webview intersects with the change list).
   */
  readFilePaths: string[];
  /** Pruning result extracted from transcript (skill-pruner extension). */
  pruningResult: PruningResult | null;
  /** Current pruning configuration from settings.json. */
  pruningSettings: PruningSettings;
  /** Current LiteLLM proxy configuration from settings.json (`proxy` block). */
  proxySettings: ProxySettings;
  /** Active pruning choices surfaced to the composer/settings UI. */
  pruningCatalog: PruningCatalog;
  /** Pruning prepass phase for the active session (Brief F). Driven host-side
   *  from the send lifecycle (`pending.promoted` = running, pruning-result
   *  `CustomMessage` = succeeded, `PreflightFailed` = failed, commit-point
   *  `MessageStarted` = idle) — the webview stays passive (host ViewState).
   *  `idle` when no prepass is in flight for the active session. */
  prepassPhase: 'idle' | 'running' | 'succeeded' | 'failed';
  /** Wall-clock start time (ms epoch) of the active session's in-flight
   *  prepass, read from the promoted op's `startedAt` (captured from the Send
   *  command timestamp — pure, no reducer Date.now()). `null` when no prepass
   *  is running (idle/failed). The webview ticks the elapsed display locally
   *  from this (allowlisted animation/telemetry state). */
  prepassStartedAt: number | null;
  /** Prepass LLM latency (ms) for the post-hoc summary hint. `undefined`
   *  when not yet known (the pruning-result `CustomMessage` carries it). */
  prepassLatencyMs?: number | null;
  /** Message ID currently being edited, or null. */
  editingMessageId: string | null;
  /** Whether the run-outcome dialog is open. */
  showOutcomeDialog: boolean;
  /** Pending extension UI requests keyed by session path, then by request ID. */
  pendingExtensionUIRequestsBySession: Record<string, Record<string, ExtensionUIRequestPayload>>;
  /** First pending extension UI request for the active session, or null (for bottom-bar prompt). */
  pendingExtensionUIRequest: ExtensionUIRequestPayload | null;
}

// ─── Host ↔ webview envelopes ────────────────────────────────────────────────

/**
 * Envelope sent from the extension host to the webview. Both messages carry
 * `hostInstanceId` so the webview can detect a host-side counter reset (e.g.
 * the view is re-resolved) and rebase its `lastRevision` rather than entering
 * a perpetual gap-detection loop.
 */
export type HostToWebviewMessage =
  | {
      type: 'state';
      protocolVersion: number;
      hostInstanceId: string;
      revision: number;
      state: ViewState;
    }
  | {
      type: 'sendRejected';
      sessionPath: string;
      text: string;
      /** Local ID of the rejected optimistic message, so the webview can
       * remove it from its local overlay. */
      localId?: string;
      /** Composer inputs captured at Send command time, so the webview can
       * restore the pasted/dropped attachments to the composer for a retry
       * (no data loss). Populated on both rollback paths: pre-ack
       * `SendResult{ok:false}` (from `pending.ops[corrId].inputs`) and
       * post-ack `PreflightFailed` (from `pending.promoted[corrId].inputs`).
       * The host also restores `pendingComposerInputsBySession` host-side
       * in the same transition; this payload lets the webview restore the
       * composer immediately, without waiting for the debounced snapshot. */
      inputs?: ComposerInput[];
    }
  | {
      /** Posted by the host when a session completes under the completion-
       *  notification policy (paired with the window-flash alert). Fire-and-
       *  forget: a dropped delivery (e.g. webview not ready) does not force a
       *  state re-post. The webview's AudioContext warmup lets this play from
       *  the non-gesture postMessage context. */
      type: 'playCompletionSound';
      volume: number;
    };

/** Messages the webview can send back to the host. */
export type WebviewToHostMessage =
  | { type: 'ready'; assetVersion?: string }
  | { type: 'refreshState'; assetVersion?: string }
  | {
      /**
       * Request a state snapshot. When `sessionPath` is provided the host MAY
       * respond with a snapshot scoped to that session; when omitted the host
       * responds with a global snapshot (all sessions + global state). Today the
       * host always responds with a global snapshot; the optional field is wired
       * through so per-session snapshot recovery can land without a protocol bump.
       */
      type: 'requestSnapshot';
      assetVersion?: string;
      sessionPath?: string;
    }
  | { type: 'openFilePicker' }
  | { type: 'openFile'; path: string }
  | { type: 'addComposerInput'; sessionPath: string; input: ComposerInputDraft }
  | { type: 'removeComposerInput'; sessionPath: string; inputId: string }
  | { type: 'setComposerDraft'; sessionPath: string; text: string }
  | {
      type: 'send';
      sessionPath: string;
      text: string;
      /** Optional local ID generated by the webview for optimistic display.
       * When provided, the host uses this as the optimistic message id,
       * allowing the webview to correlate its local preview with the
       * host-confirmed message. */
      localId?: string;
    }
  | { type: 'editMessage'; sessionPath: string; messageId: string; text: string; localId?: string }
  | { type: 'interrupt'; sessionPath: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionPath: string }
  | { type: 'closeSession'; sessionPath: string }
  | { type: 'duplicateSession'; sessionPath: string }
  | { type: 'moveSessionTab'; sessionPath?: string; fromIndex: number; toIndex: number }
  | { type: 'togglePinTab'; sessionPath: string }
  | { type: 'loadOlderTranscript'; sessionPath?: string }
  | { type: 'loadNewerTranscript'; sessionPath?: string }
  | { type: 'jumpToLatestTranscript'; sessionPath?: string }
  | { type: 'recordOutcome'; sessionPath: string; outcome: RunOutcome }
  | { type: 'startNewTask'; sessionPath: string }
  | { type: 'continueTask'; sessionPath: string }
  | {
      type: 'setModel';
      sessionPath?: string;
      defaultModel: string;
      defaultThinkingLevel: ThinkingLevel;
    }
  | { type: 'setPrefs'; prefs: Partial<ChatPrefs> }
  | { type: 'setPruningSettings'; settings: Partial<PruningSettings> }
  | { type: 'setProxySettings'; settings: ProxySettingsUpdate }
  | { type: 'startEdit'; sessionPath: string; messageId: string }
  | { type: 'cancelEdit'; sessionPath: string }
  | { type: 'dismissNotice' }
  | { type: 'openOutcomeDialog'; sessionPath: string }
  | { type: 'closeOutcomeDialog'; sessionPath: string }
  | { type: 'openFileDiff'; sessionPath: string; filePath: string }
  | { type: 'openFileInEditor'; sessionPath: string; filePath: string }
  | { type: 'revertFile'; sessionPath: string; filePath: string }
  | { type: 'setFileRead'; sessionPath: string; filePath: string; read: boolean }
  | { type: 'stateApplied'; payload: StateAppliedPayload }
  | { type: 'extensionUiResponse'; sessionPath: string; response: ExtensionUIResponsePayload }
  | { type: 'setFileChangesExpanded'; sessionPath: string; expanded: boolean }
  // ── Brief H: recovery actions surfaced from an error notice. The host owns
  //    the side effects (open settings/logs, restart backend, retry the send
  //    — optionally disabling pruning first so the slow prepass is skipped).
  //    These carry no reducer event (pure side effects), mirroring
  //    `openFilePicker` / `openFile`. ──
  | { type: 'showLogs' }
  | { type: 'openSettings' }
  | { type: 'restartBackend' }
  | {
      /** Re-send the draft text (the composer draft was restored on rollback
       *  via `sendRejected`, and host-side `pendingComposerInputsBySession`
       *  was restored too — the host's `onSend` picks the inputs up). When
       *  `disablePruning` is set, the host disables pruning (`mode: 'off'`)
       *  BEFORE re-sending so the slow prepass is skipped — atomically, on
       *  the host, to avoid a race where the send's prepass reads stale
       *  settings. */
      type: 'retrySend';
      sessionPath: string;
      text: string;
      localId: string;
      disablePruning?: boolean;
    };

