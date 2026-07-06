import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { ProxyService, type ProxyStartOptions } from '../backend/proxy-service';
import { resolveChatPrefs, buildProxyProviderEntry, deriveApiKeyEnv } from '../../shared/protocol';
import type { ChatPrefs, PruningSettings, ToolResultPruningSettings, ProxySettings, ProxySettingsUpdate, ProxyProviderAddInput, ThinkingLevel, TranscriptMode, DeferredTriggerView } from '../../shared/protocol';
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
import {
  loadPersistedProxySettings,
  saveProxySettings,
  type ProxySettingsStorage,
} from './proxy-settings-persistence';
import { readProxySettings, writeProxySettings } from './proxy-settings';
import { writeProxyEnvKey, loadProxyEnvIntoProcess } from './proxy-env';
import { NOOP_RUN_OBSERVER, type RunObserver } from '../stats-service';
import { SessionServiceEvents } from './events';
import { SessionMessageActions } from './message-actions';
import { SessionServiceState } from './state';
import { DeferredTriggerRegistry } from '../deferred-triggers/registry';
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
const TOOL_RESULT_PRUNING_STORAGE_KEY = 'toolResultPruningSettings';
const PROXY_STORAGE_KEY = 'proxySettings';

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
      bashWarmupTimeoutMs: merged.bashWarmupTimeoutMs,
      bashAcquireTimeoutMs: merged.bashAcquireTimeoutMs,
      bashDefaultTimeout: merged.bashDefaultTimeout,
      subagentBuckets: merged.subagentBuckets,
      subagentNestedAllowedBuckets: merged.subagentNestedAllowedBuckets,
    }).catch((error) => {
      appendPieLog('warn', 'prefs', 'runtimePrefs.set failed', { error: toErrorMessage(error) });
    });
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

  /** Record the running proxy + its start options so later edits can restart it. */
  setProxyRuntime(proxy: ProxyService, options: ProxyStartOptions): void {
    this.proxyService = proxy;
    this.proxyStartOptions = options;
    // Bug 5 observability: when a config restart kills an in-flight proxied
    // stream, surface a structured NoticeShown so the user can tell "proxy
    // restarted under me" vs "provider cut" vs "proxy throttled". The hook
    // fires synchronously from ProxyService.stop() BEFORE the kill.
    proxy.onInFlightInterrupted = (payload) => {
      this.dispatchArch({
        kind: 'NoticeShown',
        notice: `${payload.message} (pid ${payload.pid}). The next turn will use the restarted proxy.`,
      });
      appendPieLog('warn', 'proxy-restart', 'in-flight proxied stream interrupted by proxy restart', {
        code: payload.code,
        pid: payload.pid,
      });
    };
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
    await this.regenerateProxyConfigAndRestart();
  }

  /** Add a new proxied provider from the proxy settings "Add Provider" form.
   *  The reducer already applied the provider entry optimistically; this method
   *  does the deterministic wiring the host owns:
   *    1. derive `apiKeyEnv` + store the key safely in `proxy/.env` + `process.env`
   *    2. write `proxy.providers.<name>` to settings.json (empty modelListOrder,
   *       `<name>-shared` model-info id — "pending" until the add-provider skill
   *       adds the models.yaml catalog)
   *    3. run sync-models (tolerant of pending providers) + restart the proxy
   *  On any failure, reload proxy settings from disk + dispatch
   *  ProxySettingsChanged to revert the optimistic entry (no phantom provider).
   *  The model CATALOG (models.yaml) is added separately via the add-provider skill. */
  async addProxyProvider(input: ProxyProviderAddInput): Promise<void> {
    const name = input.name.trim().toLowerCase();
    const entry = buildProxyProviderEntry(input);
    if (!entry) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Add provider: could not build a config entry for "${name}".` });
      await this.revertProxySettingsFromDisk();
      return;
    }
    const apiKeyEnv = deriveApiKeyEnv(name);
    if (!apiKeyEnv) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Add provider: could not derive an API key env var for "${name}".` });
      await this.revertProxySettingsFromDisk();
      return;
    }

    // 1. Store the key safely (proxy/.env is gitignored; never written to
    //    settings.json/models.yaml) + set process.env so the proxy child
    //    inherits it on the restart below.
    try {
      await writeProxyEnvKey(apiKeyEnv, input.apiKey);
    } catch (err) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Add provider: failed to store the API key for "${name}" in proxy/.env: ${toErrorMessage(err)}` });
      await this.revertProxySettingsFromDisk();
      return;
    }

    // 2. Write the proxy.providers.<name> entry to settings.json.
    try {
      await writeProxySettings({ providers: { [name]: entry } });
    } catch (err) {
      this.dispatchArch({ kind: 'NoticeShown', notice: `Add provider: failed to write the proxy config for "${name}": ${toErrorMessage(err)}` });
      await this.revertProxySettingsFromDisk();
      return;
    }

    // 3. Regenerate litellm_config.yaml (sync-models tolerates the pending
    //    provider — it has no models.yaml catalog entry yet, so it contributes
    //    no routes) + restart the proxy so the new env + config take effect.
    await this.regenerateProxyConfigAndRestart();

    this.dispatchArch({
      kind: 'NoticeShown',
      notice:
        `Provider "${name}" added to the proxy config. Models aren't wired yet — ` +
        `run the add-provider skill (or /skill:add-provider) to add the models.yaml ` +
        `catalog + populate its model list so the provider routes traffic.`,
    });
  }

  /** Reload proxy settings from disk and dispatch ProxySettingsChanged to
   *  revert the reducer's optimistic state to disk truth. Used by
   *  addProxyProvider on failure so a failed add leaves no phantom provider. */
  private async revertProxySettingsFromDisk(): Promise<void> {
    try {
      const disk = await readProxySettings();
      this.dispatchArch({ kind: 'ProxySettingsChanged', proxySettings: disk });
    } catch (err) {
      appendPieLog('warn', 'proxy-settings', 'failed to revert proxy settings from disk after add failure', { error: toErrorMessage(err) });
    }
  }

  /** Regenerate proxy/litellm_config.yaml from settings.json via sync-models
   *  and restart the LiteLLM proxy so the new config takes effect. Shared by
   *  setProxySettings (field edits) + addProxyProvider (new provider). On a
   *  sync/restart failure, dispatch a NoticeShown (the persisted config is
   *  left intact — the user can fix it and retry, or reload the window). */
  private async regenerateProxyConfigAndRestart(): Promise<void> {
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