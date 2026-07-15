import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { resolveChatPrefs, buildRuntimePrefsPayload } from '../../shared/protocol';
import type { ChatPrefs, PruningSettings, ToolResultPruningSettings, ThinkingLevel, TranscriptMode, DeferredTriggerView } from '../../shared/protocol';
import {
  loadPersistedPruningSettings,
  savePruningSettings,
  type PruningSettingsStorage,
} from './pruning-settings-persistence';
import {
  loadPersistedToolResultPruningSettings,
  saveToolResultPruningSettings,
  type ToolResultPruningSettingsStorage,
} from './tool-result-pruning-settings-persistence';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { DeferredTriggerRegistry } from '../deferred-triggers/registry';
import { startSessionBackend } from './startup';
import { setRuntimeAuditLogEnabled } from '../util/audit';
import { SessionTabActions } from './tab-actions';
import type { OnSessionCompleted, PostImperative, ScheduleRender } from './types';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

const PREFS_STORAGE_KEY = 'chatPrefs';
const PRUNING_STORAGE_KEY = 'pruningSettings';
const TOOL_RESULT_PRUNING_STORAGE_KEY = 'toolResultPruningSettings';

/**
 * Owns the PI backend process lifecycle and wires backend events to the
 * arch state. All session commands (create, open, close, send, interrupt, etc.) go
 * through this service.
 */
export class SessionService implements vscode.Disposable {
  private readonly state: SessionServiceState;
  private readonly events: SessionServiceEvents;
  /** Deferred-trigger registry: resumes a session when a registered condition
   *  (session finished / timer / user input) fires. Backend-independent —
   *  survives `restart()` so pending triggers persist across backend restarts. */
  private readonly triggers: DeferredTriggerRegistry;
  private readonly tabs: SessionTabActions;
  private readonly messages: SessionMessageActions;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
    private readonly scheduleRender: ScheduleRender,
    postImperative: PostImperative,
    dispatchArch: (event: Event) => void,
    getArchState: () => ArchState,
    onSessionCompleted?: OnSessionCompleted,
    private readonly runObserver: RunObserver = NOOP_RUN_OBSERVER,
  ) {
    this.getArchState = getArchState;
    this.dispatchArch = dispatchArch;

    this.state = new SessionServiceState(context, backend, scheduleRender, getArchState, dispatchArch);
    this.triggers = new DeferredTriggerRegistry({ getArchState, dispatchArch, scheduleRender });
    this.events = new SessionServiceEvents({
      context,
      scheduleRender,
      onSessionCompleted,
      runObserver,
      state: this.state,
      dispatchArch,
      getArchState,
      triggers: this.triggers,
    });
    this.tabs = new SessionTabActions({
      context,
      scheduleRender,
      runObserver,
      state: this.state,
      getArchState,
      dispatchArch,
    });
    this.messages = new SessionMessageActions({
      context,
      backend,
      scheduleRender,
      state: this.state,
      createNewSession: () => this.tabs.createNewSession(),
      getArchState,
      dispatchArch,
    });
    this.state.setPreloadedSessionOpenedHandler((payload) => {
      this.events.applySessionOpened(payload);
    });
  }

  async start(): Promise<void> {
    // Start the deferred-trigger registry (sidecar watcher). Idempotent — safe
    // across `restart()`. Done here (not the constructor) so constructing a
    // SessionService in unit tests without `start()` doesn't arm an fs.watch
    // that would keep the test process alive.
    this.triggers.start();
    await startSessionBackend({
      context: this.context,
      backend: this.backend,
      scheduleRender: this.scheduleRender,
      events: this.events,
      state: this.state,
      service: this,
      openSession: (sessionPath) => this.tabs.openSession(sessionPath),
      getArchState: this.getArchState,
      dispatchArch: this.dispatchArch,
    });
  }

  /** Notify deferred triggers that the user sent a message in `sessionPath`
   *  (webview Send path). Fires any `user_input` trigger registered for it. */
  notifyUserInput(sessionPath: string): void {
    this.triggers.onUserInput(sessionPath);
  }

  /** Snapshot of all currently-active deferred triggers (across every
   *  session), projected into `ViewState.deferredTriggers` by
   *  `PieExtension.buildViewState`. */
  getDeferredTriggers(): DeferredTriggerView[] {
    return this.triggers.getActiveTriggers();
  }

  /** Cancel a deferred trigger (or all for `sessionPath` when `triggerId` is
   *  omitted). Invoked by the webview's status-strip cancel affordance. */
  cancelDeferredTrigger(sessionPath: string, triggerId?: string): void {
    this.triggers.cancel(sessionPath, triggerId);
  }

  /** Expose queue routing for the Phase 3 EffectRunner. */
  get queues(): { enqueueLifecycle: SessionServiceState['enqueueLifecycle']; enqueueSessionOperation: SessionServiceState['enqueueSessionOperation'] } {
    return {
      enqueueLifecycle: (task) => this.state.enqueueLifecycle(task),
      enqueueSessionOperation: (sessionPath, task) => this.state.enqueueSessionOperation(sessionPath, task),
    };
  }

  /** Expose completion-notification suppression for interrupt (Phase 3). */
  suppressNextCompletionNotificationFor(sessionPath: string): void {
    this.state.suppressNextCompletionNotificationFor(sessionPath);
  }

  /** Bind a backend request ID to a session path (Phase 4). */
  bindRequestSessionPath(requestId: string, sessionPath: string): void {
    this.state.bindRequestSessionPath(requestId, sessionPath);
  }

  /** Bump the data epoch for a session (Phase 4, pre-send/edit). */
  bumpSessionDataEpoch(sessionPath: string): void {
    this.state.bumpSessionDataEpoch(sessionPath);
  }

  async restart(): Promise<void> {
    this.events.detach();
    await this.backend.stop();
    this.state.resetRuntimeState();
    this.dispatchArch({ kind: 'RunningSessionsChanged', sessionPaths: [] });
    this.dispatchArch({ kind: 'BackendReadyChanged', ready: false });
    this.dispatchArch({ kind: 'NoticeShown', notice: null });
    this.scheduleRender();
    await this.start();
  }

  dispose(): void {
    this.events.detach();
    this.triggers.dispose();
  }

  createNewSession(): string {
    return this.tabs.createNewSession();
  }

  /** Effect-side delegate: recover from a failed/timed-out selection by
   *  finishing the request and dispatching the reducer transitions that undo
   *  the optimistic tab setup. */
  handleSelectionFailure(selectionToken: string, notice: string): void {
    this.state.handleSelectionFailure(selectionToken, notice);
  }

  getOpenTranscriptMode(sessionPath: string): TranscriptMode {
    const arch = this.getArchState();
    const loaded = arch.transcript.windowBySession[sessionPath] !== undefined;
    const running = arch.sessions.runningSessionPaths.includes(sessionPath);
    return loaded && !running ? 'skip' : 'tail';
  }

  openSession(sessionPath: string): void {
    this.tabs.openSession(sessionPath);
  }

  async closeSession(sessionPath: string, nextPath: string | null): Promise<void> {
    await this.tabs.closeSession(sessionPath, nextPath);
  }

  duplicateSession(sessionPath: string): void {
    this.tabs.duplicateSession(sessionPath);
  }

  async addFilesystemPaths(
    requestedSessionPath: string | undefined,
    paths: string[],
    source: 'picker' | 'drop',
  ): Promise<void> {
    await this.messages.addFilesystemPaths(requestedSessionPath, paths, source);
  }

  async loadOlderTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadOlderTranscript(sessionPath);
  }

  async loadNewerTranscript(sessionPath?: string): Promise<void> {
    await this.messages.loadNewerTranscript(sessionPath);
  }

  async jumpToLatestTranscript(sessionPath?: string): Promise<void> {
    await this.messages.jumpToLatestTranscript(sessionPath);
  }

  /** Effect-side delegate for the run-analytics observer. The reducer owns
   *  the ArchState model-switch transitions; the EffectRunner calls this on
   *  `SetModelRpc` success to record the (disk-persisting) model-config
   *  change in run analytics. */
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel, provider?: string): void {
    this.runObserver.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    await this.messages.hydrateModelState(sessionPath);
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return this.messages.normalizeAttachUris(uris);
  }

  async setPrefs(prefs: Partial<ChatPrefs>): Promise<void> {
    const current = this.getArchState().settings.prefs;
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && {
        extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles },
      }),
      ...(prefs.providerToggles && {
        providerToggles: { ...current.providerToggles, ...prefs.providerToggles },
      }),
      ...(prefs.subagentProviderDefaults && {
        subagentProviderDefaults: {
          ...current.subagentProviderDefaults,
          ...prefs.subagentProviderDefaults,
        },
      }),
      ...(prefs.subagentProviderTogglesBySession && {
        subagentProviderTogglesBySession: {
          ...current.subagentProviderTogglesBySession,
          ...prefs.subagentProviderTogglesBySession,
        },
      }),
    };
    const merged = resolveChatPrefs({ ...current, ...deepMerged });
    // Apply the runtime-audit-log toggle to the audit module so emit decisions
    // take effect immediately on live updates AND on cold-start restore (which
    // also routes through this method via the SetPrefs → SetPrefsRpc pipeline).
    setRuntimeAuditLogEnabled(merged.runtimeAuditLog);
    // NOTE: This method is the *effect handler* for SetPrefsRpc. The caller
    // (webview message router or startup restore) already dispatched a SetPrefs
    // Command through the reducer, which updated ArchState — including the
    // unread-finished-sessions clear when suppressCompletionNotifications is
    // set (that transition now lives in the reducer's SetPrefs handler). Do
    // NOT dispatch another SetPrefs Command here — that would recurse through
    // the reducer → EffectRunner → service.setPrefs → Command → ... and
    // overflow the stack.
    await Promise.resolve(this.context.globalState.update(PREFS_STORAGE_KEY, merged));

    // Cold-start restore intentionally reduces preferences before the backend
    // is spawned. Persist them now, then let startup's authoritative full
    // runtimePrefs.set apply them after readiness. For a live backend, await
    // the RPC so the EffectRunner can report a real failure instead of
    // acknowledging a provider toggle that never took effect.
    if (this.getArchState().settings.backendReady) {
      await this.backend.request('runtimePrefs.set', buildRuntimePrefsPayload(merged));
    }
  }

  /** Push the complete disabled-entry set for a session's system prompts to the
   *  backend (`systemPromptToggles.set`). The backend persists the set to a
   *  sidecar, rewrites the SDK base prompt, and re-emits `session.opened` —
   *  that re-emit (not this call's result) updates the host's
   *  `systemPromptsBySession` with fresh `disabled` flags. */
  async setSystemPromptToggles(sessionPath: string, disabledEntries: readonly string[]): Promise<void> {
    await this.backend.request('systemPromptToggles.set', {
      sessionPath,
      disabledEntries: [...disabledEntries],
    });
  }

  async setPruningSettings(updates: Partial<PruningSettings>): Promise<void> {
    const storage = this.createPruningSettingsStorage();
    await savePruningSettings(
      storage,
      // SET path: the reducer already applied the update optimistically, so do
      // not re-dispatch PruningSettingsChanged (avoids a lost-update flicker
      // under rapid sequential changes). Persistence still writes-or-mirrors and
      // notifies on disk failure. The LOAD path keeps its own dispatch.
      undefined,
      () => this.getArchState().settings.pruningSettings,
      updates,
      (message) => this.dispatchArch({ kind: 'NoticeShown', notice: message }),
    );
  }

  async loadPruningSettings(): Promise<void> {
    const storage = this.createPruningSettingsStorage();
    await loadPersistedPruningSettings(
      storage,
      (settings) => this.dispatchArch({ kind: 'PruningSettingsChanged', pruningSettings: settings }),
    );
  }

  private createPruningSettingsStorage(): PruningSettingsStorage {
    return {
      get: () => this.context.globalState.get<PruningSettings>(PRUNING_STORAGE_KEY),
      update: (value) => this.context.globalState.update(PRUNING_STORAGE_KEY, value),
    };
  }

  async setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void> {
    const storage = this.createToolResultPruningSettingsStorage();
    await saveToolResultPruningSettings(
      storage,
      // SET path: the reducer already applied the update optimistically, so do
      // not re-dispatch ToolResultPruningSettingsChanged (avoids a lost-update
      // flicker under rapid sequential changes). Persistence still writes-or-
      // mirrors and notifies on disk failure. The LOAD path keeps its own dispatch.
      undefined,
      () => this.getArchState().settings.toolResultPruningSettings,
      updates,
      (message) => this.dispatchArch({ kind: 'NoticeShown', notice: message }),
    );
  }

  async loadToolResultPruningSettings(): Promise<void> {
    const storage = this.createToolResultPruningSettingsStorage();
    await loadPersistedToolResultPruningSettings(
      storage,
      (settings) => this.dispatchArch({ kind: 'ToolResultPruningSettingsChanged', toolResultPruningSettings: settings }),
    );
  }

  private createToolResultPruningSettingsStorage(): ToolResultPruningSettingsStorage {
    return {
      get: () => this.context.globalState.get<ToolResultPruningSettings>(TOOL_RESULT_PRUNING_STORAGE_KEY),
      update: (value) => this.context.globalState.update(TOOL_RESULT_PRUNING_STORAGE_KEY, value),
    };
  }
}
