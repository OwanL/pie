/**
 * Phase 2 type spine — `Command` discriminated union.
 *
 * Commands are intents originating from the webview (user actions) or other
 * inputs that the host must process. Each command carries a `corrId` for
 * optimistic-update reconciliation (Phase 4) and, where applicable, an
 * explicit `sessionPath` (the Phase 1 session-routing invariant — no implicit
 * "viewed session" fallback). This file is the future replacement for the
 * action-shaped variants of `WebviewToHostMessage`; today, no code consumes
 * these types yet.
 */

import type { ComposerInput, ComposerInputDraft, SessionSummary, UserContentPart, ExtensionUIResponsePayload, PruningMode } from '../../shared/protocol';

import type { ModelSettings, ChatPrefs } from '../../shared/protocol';

/** Common fields on every command. */
export interface CommandBase {
  corrId: string;
}

/** Send a new user message. */
export interface SendCommand extends CommandBase {
  kind: 'Send';
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
  /** Brief H: prior pruning mode to restore after a "retry without pruning" send
   *  commits/fails. Set ONLY by `retrySend` with `disablePruning` (captured
   *  before the host disables pruning); absent on a normal send. Restored by the
   *  EffectRunner when the in-flight send resolves (commit / fire / pre-ack
   *  failure) so pruning returns to the user's prior mode for the next turn. */
  priorPruningMode?: PruningMode;
  /** Host-side tag for synthetic (non-user-typed) sends. Currently set only
   *  by the deferred-trigger registry's wake-up dispatch to `'deferred-trigger'`
   *  so the webview can visually differentiate the auto-resume message from a
   *  typed user message. NOT forwarded to the backend `message.send` RPC (the
   *  SDK persists user messages without this metadata); on transcript reload
   *  `mapUserMessage` re-derives the tag from the stable text prefix. */
  customType?: string;
  /** Structured details for a synthetic send, keyed by `customType`. */
  customDetails?: unknown;
  /** Explicit timestamp for deterministic optimistic message ordering. */
  timestamp: number;
}

/** Edit an existing message (truncates the transcript after it). */
export interface EditCommand extends CommandBase {
  kind: 'Edit';
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

/** Interrupt the in-flight assistant turn for a session. */
export interface InterruptCommand extends CommandBase {
  kind: 'Interrupt';
  sessionPath: string;
}

/** Manually summarize older conversation history to free context. */
export interface CompactCommand extends CommandBase {
  kind: 'Compact';
  sessionPath: string;
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
}

/** Persist the tab order / active tab / pinned tabs to globalState. */
export interface PersistTabsCommand extends CommandBase {
  kind: 'PersistTabs';
  openTabPaths: string[];
  activeSessionPath: string | null;
  /** Pinned tab paths, persisted alongside open tabs. */
  pinnedTabPaths: string[];
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

export type Command =
  | SendCommand
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
  | SelectSessionCommand
  | CloseTabCommand
  | OpenFileDiffCommand
  | RevertFileCommand
  | CloseSessionCommand
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
  | DuplicateSessionCommand
  | MoveSessionTabCommand
  | TogglePinTabCommand
  | SetFileChangesExpandedCommand
  | SetFileReadCommand
  | SetSystemPromptTogglesCommand;
export interface SetModelCommand extends CommandBase {
  kind: 'SetModel';
  sessionPath: string;
  modelSettings: ModelSettings;
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
}

export interface CloseSessionCommand extends CommandBase {
  kind: 'CloseSession';
  sessionPath: string;
  /** Outbox closure retries must re-run idempotent cleanup/persistence even
   *  when an earlier optimistic command already hid the tab. */
  ensureClosed?: boolean;
}

/** Duplicate an existing session into a new pending tab. Mirrors
 *  `CreateSession`'s host-built placeholder + selection token, but targets a
 *  COPY of a source session (backend `session.duplicate` RPC) and inserts the
 *  new tab adjacent to the source (`insertAfter` semantics). */
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
