/**
 * `Command` discriminated union type spine.
 *
 * Commands are intents originating from the webview (user actions) or other
 * inputs that the host must process. Each command carries a `corrId` for
 * optimistic-update reconciliation and, where applicable, an
 * explicit `sessionPath` (the session-routing invariant — no implicit
 * "viewed session" fallback). This file is the future replacement for the
 * action-shaped variants of `WebviewToHostMessage`; today, no code consumes
 * these types yet.
 */

import type { ComposerInput, ComposerInputDraft, SessionSummary, UserContentPart, ExtensionUIResponsePayload, PruningMode, RendererCommandContext } from '../../shared/protocol';
import type { SessionOperationSource } from './operation-types.js';
import type { LiveSubagentDetailAddress, DetailCursor, DetailPageRef } from '../../shared/protocol/subagent-detail';

import type { ModelSettings, ChatPrefs } from '../../shared/protocol';

/** Common fields on every command. */
export interface CommandBase {
  corrId: string;
}

/** Send a new user message. */
export interface SendCommand extends CommandBase {
  kind: 'Send';
  /** Stable mutation identity; distinct from corrId/localId/requestId/turnId. */
  operationId?: string;
  /** Transport attempt for this logical operation; production ingress starts at 1. */
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
  sessionPath: string;
  /** Raw user text (sent to backend). */
  text: string;
  /** Materialized composer inputs to send with the message. */
  inputs: ComposerInput[];
  /** Composed text (text + input annotations) for the optimistic transcript entry. */
  composedText: string;
  /** Pre-generated local ID for the optimistic message. */
  localId: string;
  /** User content parts for rich rendering of the optimistic message. */
  userParts?: UserContentPart[];
  /** Snapshot of the session summary before optimistic name change (null if no change). */
  previousSummary: SessionSummary | null;
  /** Prior pruning mode to restore after a "retry without pruning" send
   * commits/fails. The reducer retains this intent and includes it only on the
   * terminal/commit cleanup effect; the runner executes but does not own it. */
  priorPruningMode?: PruningMode;
  /** Host-side tag for synthetic (non-user-typed) sends. NOT forwarded to
   *  the backend `message.send` RPC (the SDK persists user messages without
   *  this metadata). */
  customType?: string;
  /** Structured details for a synthetic send, keyed by `customType`. */
  customDetails?: unknown;
  /** Explicit timestamp for deterministic optimistic message ordering. */
  timestamp: number;
}

/** Edit an existing message (truncates the transcript after it). */
export interface EditCommand extends CommandBase {
  kind: 'Edit';
  /** Stable compound-mutation identity, assigned once at trusted ingress. */
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
  sessionPath: string;
  messageId: string;
  /** Raw user text (sent to backend). */
  text: string;
  /** Materialized composer inputs to send with the edited message. */
  inputs: ComposerInput[];
  /** Composed text (text + input annotations) for the optimistic transcript entry. */
  composedText: string;
  /** Pre-generated local ID for the optimistic replacement message. */
  localId: string;
  /** User content parts for rich rendering of the optimistic replacement message. */
  userParts?: UserContentPart[];
  /** Explicit timestamp for deterministic optimistic message ordering. */
  timestamp: number;
}

/** Replace one message that is still waiting in the steering/follow-up queue.
 * Unlike Edit, this does not truncate or interrupt the active turn. */
export interface EditQueuedCommand extends CommandBase {
  kind: 'EditQueued';
  sessionPath: string;
  messageId: string;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  userParts?: UserContentPart[];
}

/** Resume an interrupted assistant turn without adding a user message. */
export interface ContinueCommand extends CommandBase {
  kind: 'Continue';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
}

/** Interrupt the in-flight assistant turn for a session. */
export interface InterruptCommand extends CommandBase {
  kind: 'Interrupt';
  /** Stable stop identity, assigned once at trusted ingress. */
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
  sessionPath: string;
}

/** Manually summarize older conversation history to free context. */
export interface CompactCommand extends CommandBase {
  kind: 'Compact';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
}

/** Clear all queued follow-up (steering) messages for a session. Removes the
 *  optimistic 'queued' transcript messages and asks the backend to drop them
 *  from the SDK follow-up queue so they will not run later. Does NOT interrupt
 *  the current turn. */
export interface ClearQueueCommand extends CommandBase {
  kind: 'ClearQueue';
  sessionPath: string;
}

/** Truncate the transcript after a given message. */
export interface TruncateAfterCommand extends CommandBase {
  kind: 'TruncateAfter';
  sessionPath: string;
  messageId: string;
}

/** Open an existing session (becomes active). */
export interface OpenSessionCommand extends CommandBase {
  kind: 'OpenSession';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  causalParentOperationId?: string | null;
  backendGeneration?: number;
  /** Pre-built placeholder summary (modifiedAt set host-side); inserted by the
   *  reducer iff the session isn't already summarized. null when the session
   *  already has a summary (no placeholder needed). Mirrors CreateSession's
   *  placeholderSummary — the impure Date.now can't live in the reducer. */
  placeholderSummary: SessionSummary | null;
  /** Selection token minted by `beginSelectionRequest` BEFORE this Command is
   *  dispatched — it must snapshot the previous active path before the reducer
   *  optimistically activates the opened tab, so failure recovery can restore
   *  it. Flowed through to the runner for the backend session.open RPC. */
  selectionToken: string;
}

/** Create a brand-new session and open it. */
export interface CreateSessionCommand extends CommandBase {
  kind: 'CreateSession';
  /** Host-allocated pending session path. Generated host-side (counter +
   *  Date.now/Math.random — impure) before this Command is dispatched, since
   *  the pending-path counter can't live in the pure reducer. */
  sessionPath: string;
  /** Workspace cwd for the new session (passed to the backend). */
  cwd: string;
  /** Pre-built placeholder summary (modifiedAt already set host-side). */
  placeholderSummary: SessionSummary;
  /** Selection token minted by `beginSelectionRequest` BEFORE this Command is
   *  dispatched — it must snapshot the previous active path before the reducer
   *  optimistically activates the pending tab, so failure recovery can restore
   *  it. Flowed through to the runner for the backend session.create RPC. */
  selectionToken: string;
  /** Stable host-generated identity reused when the local create waiter is
   *  retried. Optional for compatibility with older internal callers. */
  operationId?: string;
  /** Attempt fence for a retried create operation. */
  operationAttempt?: number;
  /** Trusted, serializable initiating identity retained by the operation registry. */
  operationSource?: SessionOperationSource;
  /** Causal parent when another operation initiated this create. */
  causalParentOperationId?: string | null;
  /** Backend generation whose ledger owns this operationId. */
  backendGeneration?: number;
}

/** Persist the tab order / active tab / pinned tabs to globalState. */
export interface PersistTabsCommand extends CommandBase {
  kind: 'PersistTabs';
  /** Correlates lifecycle-owned persistence to its reducer operation. */
  operationId?: string;
  backendGeneration?: number;
  /** Omitted for the ordinary/initial tab-persistence acknowledgement. */
  acknowledgementKey?: 'privacy-marker-removal';
  openTabPaths: string[];
  activeSessionPath: string | null;
  /** Pinned tab paths, persisted alongside open tabs. */
  pinnedTabPaths: string[];
  /** Pinned-session groups, persisted alongside pinned tabs. */
  pinnedTabGroups: string[][];
  /** Persist only the supplied session-scoped privacy markers. */
  privateSessionPaths?: string[];
}

/** Add a composer input draft (file attachment) to a session. */
export interface AddComposerInputCommand extends CommandBase {
  kind: 'AddComposerInput';
  sessionPath: string;
  input: ComposerInputDraft;
}

/** Remove a composer input draft from a session. */
export interface RemoveComposerInputCommand extends CommandBase {
  kind: 'RemoveComposerInput';
  sessionPath: string;
  inputId: string;
}

export interface SetComposerDraftCommand extends CommandBase {
  kind: 'SetComposerDraft';
  sessionPath: string;
  text: string;
}

export interface SetEditingMessageCommand extends CommandBase {
  kind: 'SetEditingMessage';
  sessionPath: string;
  messageId: string | null;
}

export interface DismissNoticeCommand extends CommandBase {
  kind: 'DismissNotice';
}

export interface RespondExtensionUICommand extends CommandBase {
  kind: 'RespondExtensionUI';
  sessionPath: string;
  /** The specific request being responded to. */
  requestId: string;
  approved: boolean;
  response: ExtensionUIResponsePayload;
}

/** Attach filesystem path(s) as composer inputs to a session. The reducer owns
 *  the append (creates `filesystemPathRef` inputs with IDs from `corrId`, checks
 *  duplicates, appends to `pendingComposerInputsBySession`); the host-side entry
 *  (`service.addFilesystemPaths`) resolves the target session (possibly creating
 *  a new one via `createNewSession()`) + cleans the paths BEFORE dispatching this
 *  Command. No Effect or runner side effect — there is no backend RPC for this
 *  op (purely a composer-input mutation). */
export interface AddFilesystemPathsCommand extends CommandBase {
  kind: 'AddFilesystemPaths';
  /** The resolved target session path (never undefined — the host-side entry
   *  resolves it, possibly via `createNewSession()`, before dispatching). */
  sessionPath: string;
  paths: string[];
  source: 'picker' | 'drop';
}

export interface LoadOlderTranscriptCommand extends CommandBase {
  kind: 'LoadOlderTranscript';
  sessionPath: string;
}

export interface LoadNewerTranscriptCommand extends CommandBase {
  kind: 'LoadNewerTranscript';
  sessionPath: string;
}

export interface JumpToLatestTranscriptCommand extends CommandBase {
  kind: 'JumpToLatestTranscript';
  sessionPath: string;
}

export interface StartNewTaskCommand extends CommandBase {
  kind: 'StartNewTask';
  sessionPath: string;
}

export interface ContinueTaskCommand extends CommandBase {
  kind: 'ContinueTask';
  sessionPath: string;
}

export interface OpenFileInEditorCommand extends CommandBase {
  kind: 'OpenFileInEditor';
  sessionPath: string;
  filePath: string;
}

export interface OpenFileCommand extends CommandBase {
  kind: 'OpenFile';
  path: string;
}

export interface SetPruningSettingsCommand extends CommandBase {
  kind: 'SetPruningSettings';
  settings: Partial<import('../../shared/protocol').PruningSettings>;
}

export interface SetToolResultPruningSettingsCommand extends CommandBase {
  kind: 'SetToolResultPruningSettings';
  settings: Partial<import('../../shared/protocol').ToolResultPruningSettings>;
}

export interface SetSessionTitlesSettingsCommand extends CommandBase {
  kind: 'SetSessionTitlesSettings';
  settings: Partial<import('../../shared/protocol').SessionTitlesSettings>;
}

export interface SetFileChangesExpandedCommand extends CommandBase {
  kind: 'SetFileChangesExpanded';
  sessionPath: string;
  expanded: boolean;
}

/** Mark a changed file as read or unread for a session. Read files sort to the
 *  bottom of the changed-file list and render darkened. Set `read: true` to mark
 *  read (also the effect of viewing a file/diff, dispatched alongside the
 *  OpenFileDiff/OpenFileInEditor commands); `read: false` to restore unread
 *  (the right-click "Mark as unread" action). Pure state mutation — no Effect,
 *  no backend RPC. A subsequent tool-call modification of the same path clears
 *  its read state (email-like) inside `handleFileChangesUpdated`. */
export interface SetFileReadCommand extends CommandBase {
  kind: 'SetFileRead';
  sessionPath: string;
  filePath: string;
  read: boolean;
}

/** Set the complete disabled-entry set for a session's system prompts. The
 *  backend is the source of truth: it persists the set, rewrites the SDK base
 *  prompt, and re-emits `session.opened` (which flows back through the reducer
 *  to update `systemPromptsBySession` with fresh `disabled` flags). The
 *  reducer emits only the RPC effect — no optimistic host state. */
export interface SetSystemPromptTogglesCommand extends CommandBase {
  kind: 'SetSystemPromptToggles';
  sessionPath: string;
  disabledEntries: string[];
}

// ─── Detail subscription commands ───────────────────────────────────
// The webview owns `detailKey`; the EffectRunner mints the `subscriptionId`
// and the session service owns the subscription lifecycle. The reducer stores
// nothing: these commands only emit side-effect records, keeping pages and
// stream state out of `ArchState`.

export interface DetailSubscribeCommand extends CommandBase {
  kind: 'DetailSubscribe';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  address: LiveSubagentDetailAddress;
  cursor?: DetailCursor;
  /** Trusted renderer identity (browser server plan §5.4): the complete
   *  ownership key is `{hostInstanceId, viewGeneration, rendererId,
   *  rendererGeneration, detailKey}`. Never client-supplied. */
  rendererId?: string;
  rendererGeneration?: number;
}

export interface DetailUnsubscribeCommand extends CommandBase {
  kind: 'DetailUnsubscribe';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  reason: 'collapse' | 'unmount' | 'session-change';
  rendererId?: string;
  rendererGeneration?: number;
}

export interface DetailFetchPagesCommand extends CommandBase {
  kind: 'DetailFetchPages';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  ref: DetailPageRef;
  rendererId?: string;
  rendererGeneration?: number;
}

export type Command =
  | SendCommand
  | ContinueCommand
  | EditCommand
  | EditQueuedCommand
  | InterruptCommand
  | CompactCommand
  | ClearQueueCommand
  | TruncateAfterCommand
  | OpenSessionCommand
  | CreateSessionCommand
  | PersistTabsCommand
  | AddComposerInputCommand
  | RemoveComposerInputCommand
  | SetComposerDraftCommand
  | SetModelCommand
  | HydrateModelCommand
  | SetPrefsCommand
  | McpListRequestedCommand
  | McpSetServerEnabledCommand
  | McpSetServerEnabledForSessionCommand
  | SetPrivacyModeCommand
  | SelectSessionCommand
  | CloseTabCommand
  | OpenFileDiffCommand
  | RevertFileCommand
  | CloseSessionCommand
  | RestartBackendCommand
  | SetEditingMessageCommand
  | DismissNoticeCommand
  | RespondExtensionUICommand
  | AddFilesystemPathsCommand
  | LoadOlderTranscriptCommand
  | LoadNewerTranscriptCommand
  | JumpToLatestTranscriptCommand
  | StartNewTaskCommand
  | ContinueTaskCommand
  | OpenFileInEditorCommand
  | OpenFileCommand
  | SetPruningSettingsCommand
  | SetToolResultPruningSettingsCommand
  | SetSessionTitlesSettingsCommand
  | DuplicateSessionCommand
  | MoveSessionTabCommand
  | MovePinnedItemCommand
  | TogglePinTabCommand
  | PinAndMergePinnedTabCommand
  | GroupPinnedTabCommand
  | MergePinnedGroupsCommand
  | UngroupPinnedTabCommand
  | DissolvePinnedGroupCommand
  | UnpinPinnedGroupCommand
  | SetFileChangesExpandedCommand
  | SetFileReadCommand
  | SetSystemPromptTogglesCommand
  | DetailSubscribeCommand
  | DetailUnsubscribeCommand
  | DetailFetchPagesCommand;
export interface SetModelCommand extends CommandBase {
  kind: 'SetModel';
  sessionPath: string;
  modelSettings: ModelSettings;
  /** Trusted initiating renderer (browser server plan §9): the M2
   *  source-aware confirmation seam routes browser-initiated switches through
   *  an inline confirm in the initiating renderer instead of an invisible
   *  desktop modal. Never client-supplied. */
  source?: RendererCommandContext;
  /** Host-only replay marker for a deferred choice whose image-removal modal
   * was already confirmed before the backend/session target became writable. */
  clearImagesConfirmed?: boolean;
  /** Host-only replay marker. Bypasses the ordinary no-op shortcut because a
   * deferred per-session choice still requires a durable settings.set write. */
  deferredReplay?: boolean;
}

/** Hydrate a session's model state from the backend (read-only refresh). */
export interface HydrateModelCommand extends CommandBase {
  kind: 'HydrateModel';
  sessionPath: string;
}

export interface SetPrefsCommand extends CommandBase {
  kind: 'SetPrefs';
  prefs: Partial<ChatPrefs>;
}

/** Refresh `state.settings.mcpServers` from the backend's effective MCP
 *  config (re-reads the adapter config files). */
export interface McpListRequestedCommand extends CommandBase {
  kind: 'McpListRequested';
}

/** Persist a per-server `disabled` override into `.pi/mcp.json` via the
 *  backend (adapter's own writer). Applies on the next session reload /
 *  backend restart; the response event sets `mcpPendingApply`. */
export interface McpSetServerEnabledCommand extends CommandBase {
  kind: 'McpSetServerEnabled';
  name: string;
  enabled: boolean;
}

/** Toggle one MCP server for exactly one session (host-side state + a
 *  session-scoped config artifact; the backend recycles that session's
 *  worker when idle so the adapter applies it on the next session start).
 *  The global `.pi/mcp.json` layer is never touched — global server
 *  controls live in Settings → MCP. */
export interface McpSetServerEnabledForSessionCommand extends CommandBase {
  kind: 'McpSetServerEnabledForSession';
  sessionPath: string;
  name: string;
  enabled: boolean;
}

/** Toggle host-only privacy mode for one session. */
export interface SetPrivacyModeCommand extends CommandBase {
  kind: 'SetPrivacyMode';
  sessionPath: string;
  enabled: boolean;
  /** Startup hydration updates host state without rewriting stale retry
   *  markers before their backend forget operation runs. */
  persist?: boolean;
}

export interface SelectSessionCommand extends CommandBase {
  kind: 'SelectSession';
  sessionPath: string;
}

export interface CloseTabCommand extends CommandBase {
  kind: 'CloseTab';
  sessionPath: string;
}

export interface OpenFileDiffCommand extends CommandBase {
  kind: 'OpenFileDiff';
  sessionPath: string;
  filePath: string;
  status: 'modified' | 'created' | 'deleted';
}

export interface RevertFileCommand extends CommandBase {
  kind: 'RevertFile';
  sessionPath: string;
  filePath: string;
  /** Trusted initiating renderer (browser server plan §9): destructive
   *   reverts from a browser source confirm inline in that renderer first.
   *   Never client-supplied. */
  source?: RendererCommandContext;
}

export interface CloseSessionCommand extends CommandBase {
  kind: 'CloseSession';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  causalParentOperationId?: string | null;
  backendGeneration?: number;
  /** Outbox closure retries must re-run idempotent cleanup/persistence even
   *  when an earlier optimistic command already hid the tab. */
  ensureClosed?: boolean;
  /** True when this close originates from a V2 review closure outbox action
   *  (closeReviewed/closeSelf). The durable reason is retained separately
   *  from the host-owned intentional-hide intent. */
  reviewClosure?: boolean;
}

/** Duplicate an existing session into a new pending tab. Mirrors
 *  `CreateSession`'s host-built placeholder + selection token, but targets a
 *  COPY of a source session (backend `session.duplicate` RPC) and inserts the
 *  new tab adjacent to the source (`insertAfter` semantics). */
export interface RestartBackendCommand extends CommandBase {
  kind: 'RestartBackend';
  operationId: string;
  operationSource: SessionOperationSource;
  causalParentOperationId?: string | null;
  backendGeneration: number;
}

export interface DuplicateSessionCommand extends CommandBase {
  kind: 'DuplicateSession';
  /** Host-allocated pending session path for the COPY (the new tab). Generated
   *  host-side (counter + Date.now/Math.random — impure) before this Command is
   *  dispatched, since the pending-path counter can't live in the pure reducer. */
  sessionPath: string;
  /** The source session being duplicated (backend `session.duplicate` RPC
   *  target). Also used by the reducer to insert the copy tab adjacent to the
   *  source (`insertAfter`). */
  sourceSessionPath: string;
  /** Pre-built placeholder summary (modifiedAt set host-side;
   *  name = "${source.name} (copy)", messageCount = source.messageCount). */
  placeholderSummary: SessionSummary;
  /** Selection token minted by `beginSelectionRequest` BEFORE this Command is
   *  dispatched — it must snapshot the previous active path before the reducer
   *  optimistically activates the copy tab, so failure recovery can restore it.
   *  Flowed through to the runner for the backend `session.duplicate` RPC. */
  selectionToken: string;
  /** Stable host-generated identity reused when the local duplicate waiter is
   *  retried. Optional for compatibility with older internal callers. */
  operationId?: string;
  /** Attempt fence for a retried duplicate operation. */
  operationAttempt?: number;
  /** Trusted, serializable initiating identity retained by the operation registry. */
  operationSource?: SessionOperationSource;
  /** Causal parent when another operation initiated this duplicate. */
  causalParentOperationId?: string | null;
  /** Backend generation whose ledger owns this operationId. */
  backendGeneration?: number;
}

export interface MoveSessionTabCommand extends CommandBase {
  kind: 'MoveSessionTab';
  sessionPath: string | undefined;
  fromIndex: number;
  toIndex: number;
}

/** Toggle whether a tab is pinned (browser-style: pinned tabs cluster at the
 *  far left and render as icon-only chips). Pure state mutation — the reducer
 *  reorders `openTabPaths` to keep pinned tabs as the leading prefix and emits
 *  a `PersistTabs` effect. No backend RPC. */
export interface TogglePinTabCommand extends CommandBase {
  kind: 'TogglePinTab';
  sessionPath: string;
}

/** Pin an unpinned tab and merge it into the leftmost pinned-strip item (the
 *  leftmost standalone pinned tab starts a group with it; the leftmost group
 *  absorbs it). Pure state mutation + `PersistTabs` effect; no backend RPC.
 *  A no-op when the tab is pending, not open, or already pinned. */
export interface PinAndMergePinnedTabCommand extends CommandBase {
  kind: 'PinAndMergePinnedTab';
  sessionPath: string;
}

/** Group a pinned tab with a target (Discord-style "drag onto"). `sourcePath`
 *  is the dragged pinned tab; `targetPath` is any member of the target group
 *  (or a standalone pinned tab to start a new group with). The source leaves
 *  its old group (dissolving it below 2) and joins the target's group. Pure
 *  state mutation + `PersistTabs` effect; no backend RPC. */
export interface GroupPinnedTabCommand extends CommandBase {
  kind: 'GroupPinnedTab';
  sourcePath: string;
  targetPath: string;
}

/** Merge two pinned groups (Discord-style "drag group chip onto group chip"):
 *  target members then source members form one group. `sourcePath` /
 *  `targetPath` are any member of their group. Pure state mutation +
 *  `PersistTabs` effect; no backend RPC. */
export interface MergePinnedGroupsCommand extends CommandBase {
  kind: 'MergePinnedGroups';
  sourcePath: string;
  targetPath: string;
}

/** Remove a pinned tab from its group and reposition it as a standalone pinned
 *  tab at `toItemIndex` (item-space, relative to the pinned strip after the
 *  source is removed). The old group dissolves below 2. Used when a dropdown
 *  member is dragged to a pinned-strip gap. Pure state mutation +
 *  `PersistTabs` effect; no backend RPC. */
export interface UngroupPinnedTabCommand extends CommandBase {
  kind: 'UngroupPinnedTab';
  sourcePath: string;
  toItemIndex: number;
}

/** Reorder a pinned item (standalone chip or group block) horizontally within
 *  the pinned strip. `sourcePath` is any member of the moved item; `toItemIndex`
 *  is the target gap in item-space (after the source item is removed). Group
 *  membership is unchanged — a group block moves as a unit. Pure state
 *  mutation + `PersistTabs` effect; no backend RPC. */
export interface MovePinnedItemCommand extends CommandBase {
  kind: 'MovePinnedItem';
  sourcePath: string;
  toItemIndex: number;
}

/** Dissolve one pinned group while preserving all member pinned status and
 * flat order. Pure state mutation + `PersistTabs`; no backend RPC. */
export interface DissolvePinnedGroupCommand extends CommandBase {
  kind: 'DissolvePinnedGroup';
  sourcePath: string;
}

/** Unpin all members of one pinned group while leaving their sessions open.
 * Pure state mutation + `PersistTabs`; no backend RPC. */
export interface UnpinPinnedGroupCommand extends CommandBase {
  kind: 'UnpinPinnedGroup';
  sourcePath: string;
}
