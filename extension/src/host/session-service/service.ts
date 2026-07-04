import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { ProxyService, type ProxyStartOptions } from '../backend/proxy-service';
import { resolveChatPrefs } from '../../shared/protocol';
import type { ChatPrefs, PruningSettings, ProxySettings, ProxySettingsUpdate, ThinkingLevel, TranscriptMode } from '../../shared/protocol';
import {
  loadPersistedPruningSettings,
  savePruningSettings,
  type PruningSettingsStorage,
} from './pruning-settings-persistence';
import {
  loadPersistedProxySettings,
  saveProxySettings,
  type ProxySettingsStorage,
} from './proxy-settings-persistence';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { startSessionBackend } from './startup';
import { toErrorMessage } from '../util/error-message';
import { setRuntimeAuditLogEnabled } from '../util/audit';
import { appendPieLog } from '../util/pie-log';
import { SessionTabActions } from './tab-actions';
import type { OnSessionCompleted, PostImperative, ScheduleRender } from './types';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';

const PREFS_STORAGE_KEY = 'chatPrefs';
const PRUNING_STORAGE_KEY = 'pruningSettings';
const PROXY_STORAGE_KEY = 'proxySettings';

/**
 * Owns the PI backend process lifecycle and wires backend events to the
 * arch state. All session commands (create, open, close, send, interrupt, etc.) go
 * through this service.
 */
export class SessionService implements vscode.Disposable {
  private readonly state: SessionServiceState;
  private readonly events: SessionServiceEvents;
  private readonly tabs: SessionTabActions;
  private readonly messages: SessionMessageActions;
  private readonly getArchState: () => ArchState;
  private readonly dispatchArch: (event: Event) => void;
  /** The running LiteLLM proxy + the options it was started with, set by
   *  startup once `proxy.start()` succeeds so later edits can restart it. */
  private proxyService?: ProxyService;
  private proxyStartOptions?: ProxyStartOptions;

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
    this.events = new SessionServiceEvents({
      context,
      scheduleRender,
      onSessionCompleted,
      runObserver,
      state: this.state,
      dispatchArch,
      getArchState,
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
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel): void {
    this.runObserver.onModelConfigChanged(sessionPath, modelId, thinkingLevel);
  }

  async hydrateModelState(sessionPath: string): Promise<void> {
    await this.messages.hydrateModelState(sessionPath);
  }

  normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
    return this.messages.normalizeAttachUris(uris);
  }

  setPrefs(prefs: Partial<ChatPrefs>): void {
    const current = this.getArchState().settings.prefs;
    const deepMerged: Partial<ChatPrefs> = {
      ...prefs,
      ...(prefs.extensionToggles && {
        extensionToggles: { ...current.extensionToggles, ...prefs.extensionToggles },
      }),
      ...(prefs.providerToggles && {
        providerToggles: { ...current.providerToggles, ...prefs.providerToggles },
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
    void Promise.resolve(this.context.globalState.update(PREFS_STORAGE_KEY, merged)).catch((error) => {
      appendPieLog('warn', 'prefs', 'globalState.update failed for prefs', { error: toErrorMessage(error) });
    });
    void this.backend.request('runtimePrefs.set', {
      providerToggles: merged.providerToggles,
      extensionToggles: merged.extensionToggles,
      subagentAlwaysParentModel: merged.subagentAlwaysParentModel,
      subagentMaxDepth: merged.subagentMaxDepth,
      subagentMaxTreeSessions: merged.subagentMaxTreeSessions,
      subagentMaxInflight: merged.subagentMaxInflight,
      subagentMaxConcurrency: merged.subagentMaxConcurrency,
      subagentMaxParallelTasks: merged.subagentMaxParallelTasks,
      bashWarmPoolSize: merged.bashWarmPoolSize,
      bashFastPath: merged.bashFastPath,
      bashShellPath: merged.bashShellPath,
      subagentBuckets: merged.subagentBuckets,
      subagentNestedAllowedBuckets: merged.subagentNestedAllowedBuckets,
    }).catch((error) => {
      appendPieLog('warn', 'prefs', 'runtimePrefs.set failed', { error: toErrorMessage(error) });
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

  /** Record the running proxy + its start options so later edits can restart it. */
  setProxyRuntime(proxy: ProxyService, options: ProxyStartOptions): void {
    this.proxyService = proxy;
    this.proxyStartOptions = options;
  }

  /** Persist a partial proxy-settings update to settings.json, regenerate the
   *  litellm_config.yaml via sync-models, and restart the proxy so the new
   *  config takes effect. Mirrors `setPruningSettings` (optimistic — the
   *  reducer already applied the update; do NOT re-dispatch
   *  ProxySettingsChanged on the SET path). */
  async setProxySettings(updates: ProxySettingsUpdate): Promise<void> {
    const storage = this.createProxySettingsStorage();
    await saveProxySettings(
      storage,
      // SET path: the reducer already applied the update optimistically, so
      // do not re-dispatch ProxySettingsChanged (avoids a lost-update flicker
      // under rapid sequential changes). Persistence still writes-or-mirrors
      // and notifies on disk failure.
      undefined,
      () => this.getArchState().settings.proxySettings,
      updates,
      (message) => this.dispatchArch({ kind: 'NoticeShown', notice: message }),
    );

    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) {
      // No agent dir = no proxy config to regenerate; nothing to restart.
      return;
    }

    // Regenerate litellm_config.yaml from the updated settings.json proxy block.
    const nodePath = vscode.workspace.getConfiguration('pie').get<string>('nodePath', '') || 'node';
    const syncScript = path.join(agentDir, 'scripts', 'sync-models.mjs');
    const result = cp.spawnSync(nodePath, [syncScript], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      const stderr = (result.stderr || result.stdout || '').trim().slice(-800);
      this.dispatchArch({
        kind: 'NoticeShown',
        notice: `Failed to regenerate the proxy config (sync-models): ${stderr || 'exited non-zero'}. The proxy was not restarted.`,
      });
      return;
    }

    // Restart the proxy so the new config is loaded. LiteLLM has no /reload
    // endpoint, so a full stop+start is required. A failure here surfaces a
    // notice but leaves the persisted config intact (the user can fix it and
    // retry, or reload the window).
    if (this.proxyService && this.proxyStartOptions) {
      try {
        await this.proxyService.restart(this.proxyStartOptions);
      } catch (err) {
        this.dispatchArch({
          kind: 'NoticeShown',
          notice: `Proxy config regenerated, but the LiteLLM proxy failed to restart: ${toErrorMessage(err)}. Reload the window to retry.`,
        });
        appendPieLog('warn', 'proxy-settings', 'proxy restart failed after settings update', { error: toErrorMessage(err) });
      }
    }
  }

  async loadProxySettings(): Promise<void> {
    const storage = this.createProxySettingsStorage();
    await loadPersistedProxySettings(
      storage,
      (settings) => this.dispatchArch({ kind: 'ProxySettingsChanged', proxySettings: settings }),
    );
  }

  private createProxySettingsStorage(): ProxySettingsStorage {
    return {
      get: () => this.context.globalState.get<ProxySettings>(PROXY_STORAGE_KEY),
      update: (value) => this.context.globalState.update(PROXY_STORAGE_KEY, value),
    };
  }
}