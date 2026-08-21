import type { ThinkingLevel, ModelSettings, ModelInfo, ContextWindowUsage } from './models.js';
import type { ComposerInput, ComposerInputDraft, ChatMessage, DetailResult, LazyDetailRef } from './messages.js';
import type { SessionSummary, TranscriptWindow, SystemPromptEntry, FileChangeEntry, RetryStatus } from './sessions.js';
import type { ExtensionInfo, PruningResult, PruningSettings, ToolResultPruningSettings, PruningCatalog, ChatPrefs, ActiveRunSummary } from './settings.js';
import type { AggregateStats } from './aggregate-stats.js';
import type { LiveTurnPhase } from '../live-pipeline-protocol.js';
import type { DeferredTriggerView } from './deferred-triggers.js';
import type { TokenRateIndicatorState } from '../token-rate.js';
import type { NoticeKind } from '../error-mapping.js';
import type {
  DetailChecksum,
  DetailCursor,
  DetailErrorCode,
  DetailPagePayload,
  DetailPageRef,
  DetailRebaseReason,
  LiveSubagentDetailAddress,
} from './subagent-detail.js';
import type { JsonStructuralPatchOperation } from '../json-structural-patch.js';

/** Most recent completed history compaction for a session, surfaced as a
 *  transient "Compacted · freed N tokens" chip. Host-owned; cleared after a
 *  bounded TTL (`ClearLastCompaction` effect) so the chip does not linger. */
export interface LastCompactionSummary {
  /** Epoch milliseconds when the compaction LLM call finished. */
  at: number;
  /** Prompt tokens before compaction, when the SDK reported them. */
  tokensBefore?: number;
  /** Post-compaction token estimate, when the SDK reported it. */
  estimatedTokensAfter?: number;
}

/** Labels a human-verification question about a reviewed session. The owning
 * request's `sessionPath` remains the reviewer session; these fields never
 * participate in prompt routing. */
export interface ReviewHumanVerificationMetadata {
  purpose: 'review_human_verification';
  targetSessionId: string;
  targetSessionPath: string;
  criterionId: string;
  domain: string;
  expectedObservation: string;
}

// ─── Multi-renderer identity (browser server) ───────────────────────────────
//
// The host may serve the same UI to several renderer surfaces (the VS Code
// sidebar and, later, loopback-served browsers). `hostInstanceId` is the
// SHARED extension-host incarnation; `rendererId`/`rendererGeneration` are
// per-renderer delivery identity, never trusted from an unauthenticated
// payload. Envelope revisions are scoped per renderer.

/** Renderer surface kind. */
export type RendererKind = 'vscode' | 'browser';

/** Trusted source context supplied by the transport when routing a validated
 *  message. Never taken from browser JSON. */
export interface RendererCommandContext {
  rendererId: string;
  kind: RendererKind;
  rendererGeneration: number;
  /** Browser-only: command-level rejection reporting (browser server plan
   *  §5.2). The router invokes this when a schema-valid command fails
   *  command-level validation (e.g. the session is no longer open) so the
   *  browser command gate records exactly one `rejected` decision + ack.
   *  Set per routing call by the gate; absent for the trusted sidebar. */
  onBrowserCommandRejected?(type: string, reason: string): void;
}

/** Base fields shared by all extension UI request variants. */
export interface ExtensionUIRequestBase {
  id: string;
  sessionPath: string;
  extensionId?: string;
  /** When set, links this request to a subagent tool call in the parent session. */
  subagentCallId?: string;
  /** When set, links this request to the running tool call that issued it (main-agent ask_user, etc.). */
  toolCallId?: string;
  /** Optional dialog timeout in milliseconds. The webview shows a countdown and auto-cancels. */
  timeout?: number;
  /** Review display/audit metadata; never changes `sessionPath` routing. */
  reviewMeta?: ReviewHumanVerificationMetadata;
}

/** A pending extension UI request (backend → host → webview). */
export type ExtensionUIRequestPayload =
  | (ExtensionUIRequestBase & { method: 'confirm'; title: string; message: string })
  | (ExtensionUIRequestBase & { method: 'select'; title: string; options: string[]; allowCustom?: boolean })
  | (ExtensionUIRequestBase & { method: 'input'; title: string; placeholder?: string })
  | (ExtensionUIRequestBase & { method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' });

/** Response from the webview (webview → host → backend). */
export interface ExtensionUIResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface RenderEvidenceBase {
  /** Host snapshot revision this evidence describes. */
  revision: number;
  /** Host-owned view generation; stale generations are telemetry-only. */
  viewGeneration: number;
}

/** The webview validated and accepted a strictly newer state envelope. */
export interface StateReceivedPayload extends RenderEvidenceBase {
  snapshotBytes: number;
}

/** The outer application tree committed the accepted revision. */
export interface AppCommittedPayload extends RenderEvidenceBase {
  surface: 'app' | 'loading' | 'empty' | 'transcript-suspense' | 'transcript';
}

/**
 * The transcript subtree committed the expected bounded identity. The identity
 * is derived from committed leaf metadata; it is never copied from a wrapper
 * attribute or obtained by scanning complete DOM text.
 */
export interface TranscriptCommittedPayload extends RenderEvidenceBase {
  identity: string;
  mountGeneration: number;
  evidence: 'displayed' | 'offscreen' | 'no-transcript';
}

/** Metadata-only explanation when the transcript cannot yet prove a target. */
export interface TranscriptCommitBlockedPayload extends RenderEvidenceBase {
  reason: 'window_mismatch' | 'structure_mismatch' | 'leaf_missing' | 'leaf_mismatch';
}

/** An rAF after transcript commit observed the same identity. */
export interface PaintObservedPayload extends TranscriptCommittedPayload {
  latencyMs: number;
}

/** Typed and sanitized renderer failure evidence. No arbitrary error body. */
export interface RenderFailurePayload {
  viewGeneration: number;
  revision: number | null;
  surface: 'app' | 'transcript' | 'transcript-suspense' | 'unknown';
  classification: 'component_error' | 'uncaught_error' | 'unhandled_rejection' | 'unknown';
}

// ─── Public subagent detail subscription protocol (Phase 5) ──────────────────
//
// Explicit expansion subscribes to the complete child transcript through a
// closed key-scoped subscription. The webview owns `detailKey` (opaque,
// identifies the expanded card); the host owns the subscription lifecycle:
// exactly one active subscription per `{viewGeneration, detailKey}`, minted
// subscription IDs, exact generation/address owners, and bounded tombstones.
// Detail pages/deltas never enter `ViewState`; they cross only as the six
// imperative stream variants below.

/** Host-minted identity carried on every host→webview detail imperative. A
 *  generation change (host, view, backend, or worker) invalidates the stream;
 *  the webview drops any imperative whose route does not match the key-scoped
 *  subscription it opened. Since browser-server M2 (protocol v6) the route
 *  also carries the trusted renderer identity (`rendererId`/
 *  `rendererGeneration`, never client-supplied): a browser renderer's
 *  subscription can never be settled or streamed to another renderer, even
 *  with matching numeric revisions. The complete ownership key is
 *  `{hostInstanceId, viewGeneration, rendererId, rendererGeneration,
 *  detailKey}`. */
export interface HostDetailRoute {
  hostInstanceId: string;
  hostGeneration: number;
  viewGeneration: number;
  /** Trusted renderer session (browser server plan §5.4). */
  rendererId: string;
  /** Trusted reload/reconnect fence for that renderer. */
  rendererGeneration: number;
  backendGeneration: number;
  coordinatorGeneration: number;
  workerId?: string;
  workerGeneration?: number;
  detailKey: string;
  subscriptionId: string;
}

/** The full view state sent from the extension host to the webview. */
/** Host-owned submitted content used to reopen an inline editor after an edit rollback. */
export interface InlineEditDraft {
  messageId: string;
  text: string;
  inputs: ComposerInput[];
}

/** One configured MCP server as surfaced to the webview. `disabled` is the
 *  EFFECTIVE state after merging all config scopes (a server can be disabled
 *  by a lower-precedence file, which the host's enable action must override
 *  with an explicit `false`). */
export interface McpServerInfo {
  name: string;
  disabled: boolean;
}

export interface ViewState {
  sessions: SessionSummary[];
  openTabPaths: string[];
  /** Pinned tab paths (browser-style: pinned tabs cluster at the left). */
  pinnedTabPaths: string[];
  /** Pinned-session groups (Discord-style clustering). Each inner array is an
   *  unnamed group of pinned tab paths in insertion order; any member path
   *  identifies its group. Persisted across restarts. */
  pinnedTabGroups: string[][];
  runningSessionPaths: string[];
  /** Session paths whose running turn is in the 'starting model' phase —
   *  pruning already succeeded but the model has not yet started streaming
   *  (the post-pruning, pre-commit window, which includes concurrency-limit /
   *  rate-limit waits). The tab bar renders a muted dot for these instead of
   *  the bright pulsing running dot, so an intended wait is visually distinct
   *  from active streaming. Derived host-side from `prepassBySession` (phase
   *  'succeeded' while a promoted op exists). */
  startingModelSessionPaths: string[];
  /** Session paths currently running a history-compaction (`/compact`) LLM
   *  call. Compaction emits no `message_start`/`message_end`, so this is the
   *  only signal the UI has to show a live "Compacting…" indicator instead of
   *  a generic busy/thinking state. Always a subset of `runningSessionPaths`
   *  (the backend re-arms busy while compacting). */
  compactingSessionPaths: string[];
  /** Most recent completed compaction per session, or null when the session
   *  has not compacted since the host started (or the entry expired). The
   *  webview renders a transient "Compacted · freed N tokens" chip from this;
   *  the host clears the entry after a bounded TTL via `ClearLastCompaction`.
   *  Absent entry = no recent compaction. */
  lastCompactionBySession: Record<string, LastCompactionSummary | null>;
  /** Whether the active session is ephemeral. Private sessions do not collect
   *  run analytics and are removed from disk when closed. */
  privacyMode?: boolean;
  unreadFinishedSessionPaths: string[];
  activeSession: SessionSummary | null;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  /** Whole-branch billable usage; unlike `transcript`, this is never windowed. */
  sessionUsage?: import('./sessions.js').SessionUsageSnapshot | null;
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
  /**
   * Aggregate usage stats across ALL sessions (cost per provider, daily spend,
   * token totals, generation throughput), computed host-side by
   * `AggregateStatsService` and merged in `PieExtension.buildViewState` (the
   * pure projection sets an empty placeholder — it must not read services or
   * disk). The webview renders this as a thin strip above the tab row. The
   * host keeps the cached object reference stable between recomputes so the
   * webview's `memo()` barriers hold across snapshot posts.
   */
  aggregateStats: AggregateStats;
  /** Persisted composer draft text for the active session. */
  draftText: string;
  busy: boolean;
  /** Live auto-retry status for the active session, or null when no retry is
   *  in flight. Surfaced as a "Retrying N of M…" chip with a Cancel button in
   *  the composer. Independent of `busy` (the SDK emits mid-retry `agent_end`
 *  with `willRetry`, which the backend now gates on, so `busy` stays true
 *  throughout a retry; this field is the authoritative retry signal). */
  retryStatus: RetryStatus | null;
  /** Host-owned producer/tool phase for the active turn. */
  liveTurnPhase: LiveTurnPhase | null;
  notice: string | null;
  /** Failure category for the current notice, or null when the notice is a
   *  plain info/warning string (or there is no notice). Set ONLY at the Brief H
   *  error sites (send/edit/prepass failures) alongside a plain-language
   *  `notice`; the webview renders recovery action buttons for known kinds
   *  (see `noticeActionsFor`). `null` everywhere else so non-error notices keep
   *  their existing string-only rendering. Invariant: `noticeKind` is non-null
   *  only when `notice` is an H-category error message. */
  noticeKind?: NoticeKind | null;
  /** Full diagnostic string behind the short `notice` summary, or null. The
   *  host redacts credentials at the webview boundary while retaining useful
   *  context such as internal `req-NN` correlation ids. Cleared alongside
   *  `notice` on dismiss/replace. */
  noticeRaw?: string | null;
  /** True once the backend process has started and emitted `backend.ready`. */
  backendReady: boolean;
  workspaceCwd: string | null;
  systemPrompts: SystemPromptEntry[];
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  /** Freshness of the active session's picker catalog. */
  availableModelsStatus: 'provisional' | 'loading' | 'authoritative';
  contextUsage: ContextWindowUsage | null;
  prefs: ChatPrefs;
  /** Configured MCP servers with their effective disabled state, discovered
   *  host-side from the adapter's config files (`~/.config/mcp/mcp.json`,
   *  `<agent dir>/mcp.json`, `.mcp.json`, `.pi/mcp.json`, …). The host fetches
   *  this on demand (menu/tab open) and after every toggle; the webview is
   *  passive. Empty array while unknown (no servers configured or not yet
   *  fetched). */
  mcpServers: McpServerInfo[];
  /** Discovery state of `mcpServers`: 'loading' while a fetch is in flight
   *  (or before the first fetch), 'error' after a failed fetch (cached rows
   *  stay visible), 'ok' after a successful fetch. Absent on legacy hosts —
   *  treat as 'ok'. */
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  /** True after a per-server toggle wrote a config override that the adapter
   *  has not re-read yet (applies on the next session reload / backend
   *  restart). Preserved by list reads and no-op toggles; cleared when the
   *  backend restarts. */
  mcpPendingApply: boolean;
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
  /** Current tool-result pruning configuration from settings.json. */
  toolResultPruningSettings: ToolResultPruningSettings;
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
  /** Submitted inline-edit content to seed a reopened editor after rollback. */
  editingDraft?: InlineEditDraft | null;
  /** Pending extension UI requests keyed by session path, then by request ID. */
  pendingExtensionUIRequestsBySession: Record<string, Record<string, ExtensionUIRequestPayload>>;
  /** First pending extension UI request for the active session, or null (for bottom-bar prompt). */
  pendingExtensionUIRequest: ExtensionUIRequestPayload | null;
  /** Currently-active (registered, not yet fired/cancelled) deferred triggers
   *  across ALL sessions, projected host-side from the `DeferredTriggerRegistry`.
   *  The webview renders a waiting-trigger segment in the bottom status strip
   *  (with a cancel affordance) and greys out the mark-done / close-tab actions
   *  for sessions that own a pending trigger. Empty array when none are active. */
  deferredTriggers: DeferredTriggerView[];
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
      /** Shared extension-host incarnation (same value for every renderer). */
      hostInstanceId: string;
      /** Host-assigned renderer session id (browser server plan §5.1). */
      rendererId: string;
      /** Reload/reconnect fence for this renderer (browser server plan §5.1). */
      rendererGeneration: number;
      /** Invalidates settlements and evidence from a replaced/reloaded view. */
      viewGeneration: number;
      revision: number;
      /** Bounded host-owned identity expected from committed transcript leaves. */
      expectedTranscriptIdentity: string;
      /** UTF-8 JSON bytes measured by the host when diagnostics are enabled; 0 otherwise. */
      snapshotBytes: number;
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
      type: 'detailResult';
      result: DetailResult;
    }
  // ── Phase 5 subagent detail stream. The six variants below are the ONLY
  //    stream content; subscribe/unsubscribe/fetchPages acknowledgements are
  //    correlated control responses and never carry pages. Each message
  //    carries the full `HostDetailRoute` so a stale or cross-key message can
  //    never be applied to the wrong expanded subtree. ──
  | (HostDetailRoute & {
      type: 'detail.start';
      address: LiveSubagentDetailAddress;
      source: 'live' | 'durable';
      baselineRevision: number;
      pageCount: number;
      totalBytes: number;
    })
  | (HostDetailRoute & {
      type: 'detail.page';
      ref: DetailPageRef;
      payload: DetailPagePayload;
      payloadBytes: number;
      checksum: DetailChecksum;
    })
  | (HostDetailRoute & {
      type: 'detail.delta';
      baseRevision: number;
      revision: number;
      operations: JsonStructuralPatchOperation[];
    })
  | (HostDetailRoute & {
      type: 'detail.rebase';
      currentRevision: number;
      reason: DetailRebaseReason;
    })
  | (HostDetailRoute & {
      type: 'detail.terminal';
      revision: number;
      durableRef: LazyDetailRef;
    })
  | (HostDetailRoute & {
      type: 'detail.error';
      code: DetailErrorCode;
      message: string;
      retryable: boolean;
    })
  | {
      /** Posted by the host when a session completes under the completion-
       *  notification policy (paired with the window-flash alert). Fire-and-
       *  forget: a dropped delivery (e.g. webview not ready) does not force a
       *  state re-post. The webview's AudioContext warmup lets this play from
       *  the non-gesture postMessage context. */
      type: 'playCompletionSound';
      volume: number;
    }
  // ── Browser-server transport (Milestone 2). The four variants below are
  //    browser-only host→renderer traffic; the VS Code sidebar never receives
  //    them. ──
  | {
      /** First message on an accepted browser WebSocket. The browser replaces
       *  its in-memory identity from this before sending `ready`; the host
       *  still treats the socket registration — not echoed JSON fields — as
       *  the trusted source. A reconnect therefore cannot retain a stale DOM
       *  generation. `viewGeneration` is the live fence (v6): the browser has
       *  no HTML-stamped generation (the page is stable across socket
       *  reconnects), so it must learn the current fence from the hello and
       *  stamp it onto `ready`/`refreshState`/`requestSnapshot`.
       */
      type: 'rendererHello';
      protocolVersion: number;
      hostInstanceId: string;
      rendererId: string;
      rendererGeneration: number;
      viewGeneration: number;
      assetVersion: string;
    }
  | {
      /** Exactly one host-side decision per schema-valid browser application
       *  command that reached routing. `accepted` = entered the
       *  reducer/effect path; `rejected` = command-level validation or
       *  routing failed, with a typed reason. The exactly-once property is
       *  about the host decision and emission, not network delivery. */
      type: 'commandAck';
      clientCommandId: string;
      decision: 'accepted' | 'rejected';
      reason?: string;
    }
  | {
      /** Status answer for a browser `commandStatusRequest` after reconnect
       *  or reload. The host consults its bounded command-decision ledger and
       *  never executes the command as part of reconciliation. */
      type: 'commandStatus';
      clientCommandId: string;
      decision: 'accepted' | 'rejected' | 'unknown';
    }
  | {
      /** Transient targeted feedback for the initiating renderer (e.g.
       *  “Opened in VS Code”). Not the global notice triple in `ArchState`;
       *  it is renderer feedback only and disappears on the next snapshot. */
      type: 'rendererNotice';
      message: string;
      kind?: 'info' | 'warning' | 'error';
    }
  | {
      /** Source-aware inline confirmation (browser server plan §2.2/§9,
       *  protocol v6). Host-owned: the host posts this targeted imperative to
       *  the initiating renderer and proceeds only on that renderer's explicit
       *  `inlineConfirmResponse`. The VS Code sidebar never receives it (its
       *  adapter keeps using native modals); a browser-initiated model switch
       *  or destructive `revertFile` never falls back to an invisible desktop
       *  modal. If the renderer disconnects, the pending confirmation
       *  cancels/rejects host-side. */
      type: 'inlineConfirm';
      confirmId: string;
      kind: 'model-switch' | 'destructive-revert';
      sessionPath?: string;
      message: string;
      confirmChoice: string;
    };

type WithViewGeneration<T> = T extends unknown ? T & { viewGeneration?: number; clientCommandId?: string } : never;

/** Messages the webview can send back to the host. Every renderer-originated
 * message may carry the host-stamped generation so current controls remain
 * usable during a reload while stale documents are rejected safely. */
export type WebviewToHostMessage = WithViewGeneration<WebviewToHostMessagePayload>;

type WebviewToHostMessagePayload =
  | { type: 'ready'; assetVersion?: string; viewGeneration?: number }
  | { type: 'refreshState'; assetVersion?: string; viewGeneration?: number }
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
      viewGeneration?: number;
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
  | { type: 'editMessage'; sessionPath: string; messageId: string; text: string; inputs?: ComposerInput[]; localId?: string; queued?: boolean }
  | { type: 'interrupt'; sessionPath: string }
  | { type: 'compact'; sessionPath: string }
  | { type: 'clearQueue'; sessionPath: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionPath: string }
  | { type: 'closeSession'; sessionPath: string; interactionId?: string }
  | { type: 'requestDetail'; sessionPath: string; ref: LazyDetailRef }
  // ── Phase 5: demand-driven subagent detail. `viewGeneration` and `detailKey`
  //    are required (not the optional wrapper field): the host records the
  //    exact renderer owner before forwarding any stream content. The host
  //    mints the `subscriptionId`; the webview learns it from `detail.start`.
  //    Generic one-shot tool/reasoning details keep using `requestDetail`. ──
  | {
      type: 'detail.subscribe';
      viewGeneration: number;
      detailKey: string;
      address: LiveSubagentDetailAddress;
      cursor?: DetailCursor;
    }
  | {
      type: 'detail.unsubscribe';
      viewGeneration: number;
      detailKey: string;
      reason: 'collapse' | 'unmount' | 'session-change';
    }
  | {
      type: 'detail.fetchPages';
      viewGeneration: number;
      detailKey: string;
      ref: DetailPageRef;
    }
  | { type: 'duplicateSession'; sessionPath: string }
  | { type: 'retryCreateOperation'; operationId: string }
  | { type: 'moveSessionTab'; sessionPath?: string; fromIndex: number; toIndex: number }
  | { type: 'togglePinTab'; sessionPath: string }
  | { type: 'groupPinnedTab'; sourcePath: string; targetPath: string }
  | { type: 'mergePinnedGroups'; sourcePath: string; targetPath: string }
  | { type: 'ungroupPinnedTab'; sourcePath: string; toItemIndex: number }
  | { type: 'movePinnedItem'; sourcePath: string; toItemIndex: number }
  | { type: 'loadOlderTranscript'; sessionPath?: string }
  | { type: 'loadNewerTranscript'; sessionPath?: string }
  | { type: 'jumpToLatestTranscript'; sessionPath?: string }
  | { type: 'startNewTask'; sessionPath: string }
  | { type: 'continueTask'; sessionPath: string }
  | {
      type: 'setModel';
      sessionPath?: string;
      defaultModel: string;
      defaultProvider?: string;
      defaultThinkingLevel: ThinkingLevel;
    }
  | { type: 'setPrefs'; prefs: Partial<ChatPrefs> }
  /** Ask the host to re-read the effective MCP server config and refresh
   *  `ViewState.mcpServers`. Sent when an MCP surface opens so the list is
   *  fresh; the host surfaces the in-flight/error state via
   *  `ViewState.mcpServersStatus` and responses arrive through the normal
   *  snapshot flow. */
  | { type: 'mcpListRequested' }
  /** Persist a per-server `disabled` override into `.pi/mcp.json` (the
   *  adapter's own mechanism — never touches server credentials). Takes
   *  effect on the next session reload / backend restart; the host surfaces
   *  that via `ViewState.mcpPendingApply` until the adapter re-reads the
   *  config. */
  | { type: 'mcpSetServerEnabled'; name: string; enabled: boolean }
  /** Toggle the active session's ephemeral/privacy mode. The setting is host
   *  state only and is deliberately not persisted. */
  | { type: 'setPrivacyMode'; sessionPath: string; enabled: boolean }
  | { type: 'setPruningSettings'; settings: Partial<PruningSettings> }
  | { type: 'setToolResultPruningSettings'; settings: Partial<ToolResultPruningSettings> }
  | { type: 'startEdit'; sessionPath: string; messageId: string }
  | { type: 'cancelEdit'; sessionPath: string }
  | { type: 'dismissNotice' }
  | { type: 'openFileDiff'; sessionPath: string; filePath: string }
  | { type: 'openFileInEditor'; sessionPath: string; filePath: string }
  | { type: 'revertFile'; sessionPath: string; filePath: string }
  | { type: 'setFileRead'; sessionPath: string; filePath: string; read: boolean }
  | {
      /** Set the complete disabled-entry set for a session's system prompts.
       *  An entry id in `disabledEntries` is toggled OFF (removed from the
       *  prompt sent to the model and hidden from the transcript). An empty
       *  array re-enables everything. The backend is the source of truth and
       *  re-emits `session.opened` with updated `disabled` flags. */
      type: 'setSystemPromptToggles';
      sessionPath: string;
      disabledEntries: string[];
    }
  | { type: 'stateReceived'; payload: StateReceivedPayload }
  | { type: 'appCommitted'; payload: AppCommittedPayload }
  | { type: 'transcriptCommitted'; payload: TranscriptCommittedPayload }
  | { type: 'transcriptCommitBlocked'; payload: TranscriptCommitBlockedPayload }
  | { type: 'paintObserved'; payload: PaintObservedPayload }
  | { type: 'renderFailure'; payload: RenderFailurePayload }
  // ── Browser-server lifecycle (Milestone 2). Validated like all other
  //    inbound messages; `rendererFocusChanged` is mandatory because
  //    completion-attention arbitration depends on it. ──
  | { type: 'rendererVisibilityChanged'; visible: boolean }
  | { type: 'rendererFocusChanged'; focused: boolean }
  | {
      /** Bounded read-only status query for a sent-but-unacknowledged
       *  command after reconnect/reload. Never re-executes the command. */
      type: 'commandStatusRequest';
      clientCommandId: string;
    }
  | {
      /** Explicit response to a host-owned `inlineConfirm` imperative
       *  (protocol v6). Browser-only: the host proceeds with the stashed
       *  model-switch/revert intent only on `confirmed === true` from the
       *  initiating renderer; disconnect cancels. */
      type: 'inlineConfirmResponse';
      confirmId: string;
      confirmed: boolean;
    }
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
    }
  | {
      /** Cancel a deferred trigger registered for `sessionPath`. When
       *  `triggerId` is omitted, cancels ALL active triggers for that session
       *  (mirrors the `defer_trigger` tool's `cancel` action with no
       *  `triggerId`). The host appends a `cancel` op to the sidecar and
       *  updates its in-memory set; the next snapshot reflects the removal. */
      type: 'cancelDeferredTrigger';
      sessionPath: string;
      triggerId?: string;
    }

  // ── H4: webview → host log routing. The webview cannot import host
  //    utilities, so it forwards diagnostic logs (render errors, unhandled
  //    rejections, file-drop parse failures) to the host, which routes them
  //    through `appendPieLog` → the pie OutputChannel / pie.log (durable +
  //    visible without opening devtools). `level` is restricted to warn/error
  //    (the webview logger's levels). ──
  | { type: 'log'; level: 'warn' | 'error'; scope: string; message: string; data?: unknown };

