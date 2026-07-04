import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { ProxyService } from '../backend/proxy-service';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../core/restored-session-plan';
import { normalizeStoredTabPaths } from '../../shared/tab-behavior';
import { createCommandExecutor } from '../../shared/exec-command';

import { resolveNodePath, resolveSdkPath } from '../../shared/runtime-resolution';
import { resolveAgentDir } from '../../shared/agent-dir-resolution';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionService } from './service';
import { SessionServiceEvents } from './events';
import { readProxySettings } from './proxy-settings';
import { ensureProxyMasterKey, PROXY_MASTER_KEY_ENV } from './proxy-master-key';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from '../core/restored-session-summaries';
import { bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';
import { publishBackendReady } from './backend-ready';
import type { ArchState } from '../core/arch-state';
import type { Event } from '../core/events';

const PREFS_STORAGE_KEY = 'chatPrefs';
const SDK_PATH_CACHE_KEY = 'resolvedSdkPath';

interface StartSessionBackendOptions {
  context: vscode.ExtensionContext;
  backend: BackendClient;
  scheduleRender: () => void;
  events: SessionServiceEvents;
  state: SessionServiceState;
  service: SessionService;
  openSession: (sessionPath: string) => void;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
}

function resolveWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function applyStoredPrefs(options: StartSessionBackendOptions): void {
  const storedPrefs = options.context.globalState.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
  if (storedPrefs) {
    // The SetPrefs Command reduces to a SetPrefsRpc effect; service.setPrefs
    // (the effect handler) resolves and persists the merged prefs. No separate
    // globalState write is needed here.
    options.dispatchArch({ kind: 'Command', cmd: { kind: 'SetPrefs', corrId: `prefs:${Date.now()}`, prefs: storedPrefs } });
  }
}

async function loadPruningSettingsFromService(options: StartSessionBackendOptions): Promise<void> {
  await options.service.loadPruningSettings();
}

function computeRestorePlan(options: StartSessionBackendOptions) {
  const storedRawTabs = options.context.globalState.get<unknown[]>('openTabPaths') ?? [];
  // Skip fs.existsSync checks during restore — session files may be temporarily
  // inaccessible during rapid extension host restarts (Windows file locks, race
  // conditions). Missing sessions are handled gracefully when the backend tries
  // to open them. Dropping tabs here permanently destroys saved tab state.
  const { rawTabs, openTabPaths: restoredTabs, droppedPaths } = filterRestorableStoredTabs(
    storedRawTabs,
    () => true,
  );
  const preferredStartupPath = options.context.globalState.get<string>('activeSessionPath') ?? null;
  // Pinned tabs are stored as a path list (no name enrichment). Normalize
  // defensively (accept legacy string/{path} forms, drop pending/dupes), then
  // drop any pinned path that didn't survive the open-tab restore so the
  // pinned ⊆ openTabPaths invariant holds.
  const storedRawPinned = options.context.globalState.get<unknown[]>('pinnedTabPaths') ?? [];
  const storedPinned = normalizeStoredTabPaths(storedRawPinned);
  const restoredPinnedTabs = storedPinned.filter((p) => restoredTabs.includes(p));
  const restoredSessionPlan = buildRestoredSessionPlan(restoredTabs, preferredStartupPath);
  const { startupPath: restoredStartupPath, preloadPaths } = restoredSessionPlan;
  return {
    storedRawTabs,
    rawTabs,
    restoredTabs,
    droppedPaths,
    preferredStartupPath,
    restoredStartupPath,
    preloadPaths,
    storedPinned,
    restoredPinnedTabs,
  };
}

function applyRestoredTabPaths(options: StartSessionBackendOptions, restoredTabs: string[], restoredPinnedTabs: string[]): void {
  options.dispatchArch({ kind: 'OpenTabsChanged', openTabPaths: restoredTabs, pinnedTabPaths: restoredPinnedTabs });
}

function persistIfTabStateChanged(
  options: StartSessionBackendOptions,
  storedRawTabs: unknown[],
  rawTabs: unknown[],
  preferredStartupPath: string | null,
  restoredStartupPath: string | null,
  storedPinned: string[],
  restoredPinnedTabs: string[],
): void {
  const tabsChanged =
    rawTabs.length !== storedRawTabs.length
    || preferredStartupPath !== (restoredStartupPath ?? undefined);
  const pinnedChanged =
    restoredPinnedTabs.length !== storedPinned.length
    || restoredPinnedTabs.some((p, i) => p !== storedPinned[i]);
  if (tabsChanged) {
    void Promise.resolve(options.context.globalState.update('openTabPaths', rawTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for openTabPaths', { error: toErrorMessage(error) });
    });
    void Promise.resolve(options.context.globalState.update('activeSessionPath', restoredStartupPath ?? undefined)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for activeSessionPath', { error: toErrorMessage(error) });
    });
  }
  if (pinnedChanged) {
    void Promise.resolve(options.context.globalState.update('pinnedTabPaths', restoredPinnedTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for pinnedTabPaths', { error: toErrorMessage(error) });
    });
  }
}

function bootLogRestorePrepared(
  restoredStartupPath: string | null,
  cachedSessionCount: number,
  droppedTabCount: number,
  openTabCount: number,
  preloadCount: number,
): void {
  bootLog('session-startup', 'restore.prepared', {
    activeSessionPath: restoredStartupPath,
    cachedSessionCount,
    droppedTabCount,
    openTabCount,
    preloadCount,
  });
}

/**
 * Read the build-generated `out/sdk-local-path.json` pointing at the SDK
 * pinned in this checkout's `node_modules`. Returns undefined when the
 * manifest is absent (e.g. build not yet run, or the SDK isn't installed
 * locally), so resolution falls back to the extensionPath-relative candidate
 * then the globalState cache and `npm root -g`.
 */
function readSdkLocalManifest(context: vscode.ExtensionContext): string | undefined {
  const manifestPath = context.asAbsolutePath(path.join('out', 'sdk-local-path.json'));
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sdkPath?: unknown };
    const sdkPath = typeof parsed.sdkPath === 'string' ? parsed.sdkPath.trim() : '';
    return sdkPath || undefined;
  } catch {
    return undefined;
  }
}

async function resolveAndCacheRuntimePaths(options: StartSessionBackendOptions): Promise<{ nodePath: string; sdkPath: string } | null> {
  try {
    const config = vscode.workspace.getConfiguration('pie');
    const rootConfig = vscode.workspace.getConfiguration();
    const configuredNodePath =
      config.get<string>('nodePath')?.trim()
      || rootConfig.get<string>('piAssistant.nodePath')?.trim()
      || undefined;
    const configuredSdkPath =
      config.get<string>('sdkPath')?.trim()
      || rootConfig.get<string>('piAssistant.sdkPath')?.trim()
      || undefined;
    const envSdkPath = process.env.PI_SDK_PATH?.trim() || undefined;
    // Portable default: the SDK pinned as an extension `dependency` in this
    // checkout's node_modules. The build writes out/sdk-local-path.json with
    // the absolute source node_modules path (regenerated per-machine, never
    // committed), so the synced install can still find the lockfile-pinned SDK
    // in the source tree. In Extension Development Host (extensionPath IS the
    // source dir) the extensionPath-relative candidate works directly.
    const localCandidatePath = readSdkLocalManifest(options.context)
      ?? path.join(
        options.context.extensionPath,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
      );
    const shouldUseSdkCache = !configuredSdkPath && !envSdkPath;
    const cachedSdkPath = shouldUseSdkCache
      ? options.context.globalState.get<string>(SDK_PATH_CACHE_KEY)
      : undefined;

    const nodePath = resolveNodePath({
      configuredPath: configuredNodePath,
      env: process.env as NodeJS.ProcessEnv,
    });
    const sdkPath = await resolveSdkPath({
      configuredPath: configuredSdkPath,
      cachedPath: cachedSdkPath,
      localCandidatePath,
      env: process.env as NodeJS.ProcessEnv,
      exec: createCommandExecutor(),
    });
    // Only persist the resolved path when we actually had to discover it via
    // the cache/npm-root fallback. The local candidate is re-discovered
    // cheaply on every start and would go stale if the repo is relocated.
    if (shouldUseSdkCache && sdkPath !== localCandidatePath) {
      void Promise.resolve(options.context.globalState.update(SDK_PATH_CACHE_KEY, sdkPath)).catch((error) => {
        appendPieLog('warn', 'startup', 'globalState.update failed for resolvedSdkPath', { error: toErrorMessage(error) });
      });
    }
    return { nodePath, sdkPath };
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice:
      `pie setup error: ${toErrorMessage(err)}. ` +
        'Set pie.nodePath and pie.sdkPath in settings.',
    });
    return null;
  }
}

function setupInTreeAuthEnv(): void {
  const allowInTreeAuth = vscode.workspace.getConfiguration('pie').get<boolean>('allowInTreeAuth', false);
  if (allowInTreeAuth) {
    process.env.PIE_ALLOW_IN_TREE_AUTH = '1';
  } else {
    delete process.env.PIE_ALLOW_IN_TREE_AUTH;
  }
}

/**
 * Ensure PI_CODING_AGENT_DIR is set in process.env before the backend is
 * spawned. The backend inherits process.env and the pi SDK uses
 * PI_CODING_AGENT_DIR to resolve `getAgentDir()` — which controls where
 * settings.json, models.json, and auth.json are read from.
 *
 * Candidates (pie.agentDir setting, PI_CODING_AGENT_DIR env var, and the
 * dir above the extension package) are VALIDATED: a dir is only trusted if
 * it actually contains settings.json. This is what makes the recurring
 * "custom provider missing" failure self-healing: a STALE pie.agentDir
 * pointing at a path from another machine (or after a repo relocation) used
 * to silently overwrite a correct PI_CODING_AGENT_DIR env var, leaving the
 * backend to read models.json from a non-existent dir — so custom providers
 * (defined ONLY in models.json, never built-in) vanished with no
 * error. Now stale candidates are rejected (logged) and resolution falls
 * through to a valid dir instead of clobbering a good env var.
 *
 * `extensionPath` is the loaded extension's install dir; its parent is the
 * repo root in the standard checkout layout, used as a last-resort fallback
 * so pie works even when both the setting and the env var are missing/stale.
 */
function setupAgentDirEnv(options: StartSessionBackendOptions): void {
  const configuredAgentDir = vscode.workspace.getConfiguration('pie').get<string>('agentDir', '').trim();
  const result = resolveAgentDir({
    configuredAgentDir,
    envAgentDir: process.env.PI_CODING_AGENT_DIR,
    extensionPath: options.context.extensionPath,
  });

  if (result.agentDir) {
    process.env.PI_CODING_AGENT_DIR = result.agentDir;
  } else {
    // No candidate validated. Clear any stale value so the backend doesn't
    // read a non-existent dir; the pi SDK will fall back to ~/.pi/agent.
    delete process.env.PI_CODING_AGENT_DIR;
    const tried = result.rejections
      .map((r) => `${r.source}="${r.candidate}" (${r.reason})`)
      .join('; ');
    appendPieLog('warn', 'startup', 'no valid agent dir found', {
      tried: tried || 'none',
      note: 'Custom providers will be unavailable. Set pie.agentDir to the directory containing settings.json and models.json.',
    });
    return;
  }

  // Surface stale-setting recovery so the user understands WHY providers were
  // missing and can fix the persisted setting (rather than relying on the
  // env-var fallback indefinitely). The notice is only shown when the setting
  // was set but a DIFFERENT source actually resolved — i.e. the setting is stale.
  const settingRejected = result.rejections.some((r) => r.source === 'setting');
  if (settingRejected && result.source !== 'setting') {
    const sourceLabel =
      result.source === 'env' ? 'the PI_CODING_AGENT_DIR env var'
      : result.source === 'extension-relative' ? 'the extension\'s parent dir'
      : 'a fallback';
    options.dispatchArch({
      kind: 'NoticeShown',
      notice:
        `pie.agentDir points to a path that no longer exists${configuredAgentDir ? ` (${configuredAgentDir})` : ''}. ` +
        `Recovering using ${sourceLabel} (${result.agentDir}). Set pie.agentDir to this path, or re-run the installer, to clear this warning.`,
    });
  }
}

async function startBackendWithLogging(
  options: StartSessionBackendOptions,
  nodePath: string,
  sdkPath: string,
  backendPath: string,
  workspaceCwd: string,
  restoredStartupPath: string | null,
): Promise<boolean> {
  try {
    bootLog('session-startup', 'backend.starting', {
      backendPath,
      cwd: workspaceCwd,
      restoredStartupPath,
    });
    await options.backend.start({ nodePath, sdkPath, backendPath, cwd: workspaceCwd });
    bootLog('session-startup', 'backend.started', {
      restoredStartupPath,
    });
    return true;
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice: `Failed to start PI backend: ${toErrorMessage(err)}` });
    bootLog('session-startup', 'backend.startFailed', {
      message: toErrorMessage(err),
    });
    return false;
  }
}

/**
 * Start the local LiteLLM proxy (pie/proxy/) before the PI backend, so any
 * provider whose `baseUrl` in models.json points at 127.0.0.1:proxyPort is
 * already reachable when the backend issues its first request. This enforces
 * per-provider concurrency limits centrally — see
 * docs/AGENT-HARNESS-IMPROVEMENTS.md §1–§3 and proxy/README.md.
 *
 * FAILED-LOUD policy: if `pie.useProxy` is on and the proxy can't become
 * ready, dispatch a `NoticeShown` and return false so the caller skips the
 * backend start. There is NO silent fallback to direct routing — by design —
 * because models.json would point at a dead port and every proxied request
 * would hang/429 opaquely. The user fixes the proxy (UI notice explains how)
 * and reloads the window; direct providers (Copilot/Ollama) remain usable
 * only if the user turns `pie.useProxy` off.
 *
 * Skipped entirely (returns true) when `pie.useProxy` is false, so users who
 * opt out of the proxy are unaffected.
 */
async function startProxyWithLogging(options: StartSessionBackendOptions): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('pie');
  const useProxy = config.get<boolean>('useProxy', true);
  if (!useProxy) {
    bootLog('session-startup', 'proxy.skipped', { reason: 'pie.useProxy=false' });
    return true;
  }

  // The proxy lives in `proxy/` under the resolved agentDir (the pie repo root
  // that setupAgentDirEnv just wrote to process.env.PI_CODING_AGENT_DIR).
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    options.dispatchArch({
      kind: 'NoticeShown',
      notice:
        'pie.useProxy is on but no agent dir is resolved (PI_CODING_AGENT_DIR unset). ' +
        'The LiteLLM proxy at pie/proxy/ cannot be located. Set pie.agentDir, or turn pie.useProxy off to bypass.',
    });
    return false;
  }

  const proxyDir = path.join(agentDir, 'proxy');
  const configPath = path.join(proxyDir, 'litellm_config.yaml');
  const port = config.get<number>('proxyPort', 4000);
  const host = '127.0.0.1';

  // LiteLLM is DB-less, so the backend's Authorization MUST match the proxy
  // `master_key`. The master key is a pie-owned LOCAL gate (the proxy binds
  // 127.0.0.1) — auto-generated + persisted on first run, and DECOUPLED from
  // any provider's upstream key, so multiple proxied providers each with their
  // own upstream key all auth to the proxy with this one value. Set it in
  // process.env before spawning the proxy + backend (both inherit it).
  const masterKey = await ensureProxyMasterKey(options.context.secrets);
  process.env[PROXY_MASTER_KEY_ENV] = masterKey;

  // Each configured proxied provider needs its upstream key env var set (litellm
  // sends `os.environ/<apiKeyEnv>` to the upstream). Fail loud listing any that
  // are missing rather than boot a proxy that will 401 every request to them.
  const proxySettings = await readProxySettings();
  const missingProviderEnvs = Object.entries(proxySettings.providers)
    .map(([name, p]) => ({ name, env: p.apiKeyEnv, set: !!process.env[p.apiKeyEnv] }))
    .filter((p) => !p.set);
  if (missingProviderEnvs.length > 0) {
    const listing = missingProviderEnvs.map((p) => `${p.env} (provider "${p.name}")`).join(', ');
    options.dispatchArch({
      kind: 'NoticeShown',
      notice:
        `pie.useProxy is on but these provider API key env vars are not set: ${listing}. ` +
        'The LiteLLM proxy needs each proxied provider\'s upstream key to route to it. ' +
        'Set them and reload, remove the providers from the proxy config, ' +
        'or turn pie.useProxy off to route providers direct (no concurrency limit).',
    });
    return false;
  }

  try {
    bootLog('session-startup', 'proxy.starting', { proxyDir, port });
    const proxy = new ProxyService();
    // Owned by the extension context so the proxy child is killed on shutdown.
    options.context.subscriptions.push(proxy);
    const startOptions = { proxyDir, configPath, port, host };
    await proxy.start(startOptions);
    // Record the running proxy + its start options so later edits can restart it.
    options.service.setProxyRuntime(proxy, startOptions);
    bootLog('session-startup', 'proxy.started', { port });
    // The proxied-provider apiKey in models.json is `$PIE_PROXY_MASTER_KEY`
    // (the local gate pie just set), which the backend resolves from the
    // inherited environment. Each provider's UPSTREAM key is sent by litellm
    // (api_key: os.environ/<apiKeyEnv> in litellm_config.yaml), not by pi.
    return true;
  } catch (err) {
    options.dispatchArch({
      kind: 'NoticeShown',
      notice:
        `Failed to start the LiteLLM proxy: ${toErrorMessage(err)}. ` +
        'Proxied providers will be unavailable until this is fixed. Run `npm run proxy` in a terminal to see the error, ' +
        'or turn off pie.useProxy in settings to route providers direct (no concurrency limit).',
    });
    bootLog('session-startup', 'proxy.startFailed', { message: toErrorMessage(err) });
    return false;
  }
}

async function sendRuntimePrefsWithLogging(
  options: StartSessionBackendOptions,
  restoredStartupPath: string | null,
): Promise<void> {
  try {
    const archState = options.getArchState();
    bootLog('session-startup', 'runtimePrefs.set.requested', {
      backendReady: archState.settings.backendReady,
      restoredStartupPath,
    });
    await options.backend.request('runtimePrefs.set', {
      providerToggles: archState.settings.prefs.providerToggles,
      extensionToggles: archState.settings.prefs.extensionToggles,
      subagentAlwaysParentModel: archState.settings.prefs.subagentAlwaysParentModel,
      subagentMaxDepth: archState.settings.prefs.subagentMaxDepth,
      subagentMaxTreeSessions: archState.settings.prefs.subagentMaxTreeSessions,
      subagentMaxInflight: archState.settings.prefs.subagentMaxInflight,
      subagentMaxConcurrency: archState.settings.prefs.subagentMaxConcurrency,
      subagentMaxParallelTasks: archState.settings.prefs.subagentMaxParallelTasks,
      bashWarmPoolSize: archState.settings.prefs.bashWarmPoolSize,
      bashFastPath: archState.settings.prefs.bashFastPath,
      bashShellPath: archState.settings.prefs.bashShellPath,
      subagentBuckets: archState.settings.prefs.subagentBuckets,
      subagentNestedAllowedBuckets: archState.settings.prefs.subagentNestedAllowedBuckets,
    });
    bootLog('session-startup', 'runtimePrefs.set.completed', {
      backendReady: options.getArchState().settings.backendReady,
      restoredStartupPath,
    });
  } catch {
    bootLog('session-startup', 'runtimePrefs.set.failed', {
      backendReady: options.getArchState().settings.backendReady,
      restoredStartupPath,
    });
    appendPieLog('warn', 'startup', 'runtimePrefs.set failed during startup', {
      backendReady: options.getArchState().settings.backendReady,
      restoredStartupPath,
    });
  }
}

function bootLogBackendReadyDispatched(options: StartSessionBackendOptions): void {
  bootLog('session-startup', 'backend.readyDispatched', {
    activeSessionPath: options.getArchState().sessions.activeSessionPath,
    backendReady: options.getArchState().settings.backendReady,
    notice: options.getArchState().settings.notice,
    openTabCount: options.getArchState().sessions.openTabPaths.length,
  });
}

async function listAndOpenFirstSession(options: StartSessionBackendOptions): Promise<void> {
  try {
    const sessions = await options.backend.request<SessionSummary[]>('session.list');
    options.dispatchArch({ kind: 'SessionSummariesReplaced', summaries: sessions });
    options.scheduleRender();

    const toOpen = sessions[0]?.path;
    if (toOpen) {
      options.openSession(toOpen);
    }
  } catch (err) {
    bootLog('session-startup', 'listAndOpenFirstSession.failed', { error: toErrorMessage(err) });
    appendPieLog('warn', 'startup', 'session.list failed during startup restore', { error: toErrorMessage(err) });
  }
}

export async function startSessionBackend(options: StartSessionBackendOptions): Promise<void> {
  options.state.resetRuntimeState();

  const workspaceCwd = resolveWorkspaceCwd();
  const { dispatchArch } = options;

  dispatchArch({ kind: 'WorkspaceCwdChanged', workspaceCwd });

  applyStoredPrefs(options);
  await loadPruningSettingsFromService(options);
  await options.service.loadProxySettings();

  const {
    storedRawTabs,
    rawTabs,
    restoredTabs,
    droppedPaths,
    preferredStartupPath,
    restoredStartupPath,
    preloadPaths,
    storedPinned,
    restoredPinnedTabs,
  } = computeRestorePlan(options);

  applyRestoredTabPaths(options, restoredTabs, restoredPinnedTabs);
  persistIfTabStateChanged(options, storedRawTabs, rawTabs, preferredStartupPath, restoredStartupPath, storedPinned, restoredPinnedTabs);

  const cachedSessions = buildRestoredSessionSummaries(rawTabs, restoredTabs, workspaceCwd, new Date().toISOString());
  if (cachedSessions.length > 0) {
    dispatchArch({ kind: 'SessionSummariesReplaced', summaries: cachedSessions });
  }

  if (restoredStartupPath) {
    dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: restoredStartupPath } });
  }

  bootLogRestorePrepared(restoredStartupPath, cachedSessions.length, droppedPaths.length, restoredTabs.length, preloadPaths.length);

  const paths = await resolveAndCacheRuntimePaths(options);
  if (!paths) {
    options.scheduleRender();
    return;
  }
  const { nodePath, sdkPath } = paths;

  const backendPath = path.join(options.context.extensionPath, 'out', 'backend.js');
  setupAgentDirEnv(options);
  setupInTreeAuthEnv();

  // Start the LiteLLM proxy before the backend so proxied providers
  // are reachable on the first request. Fails loud — see startProxyWithLogging.
  const proxyReady = await startProxyWithLogging(options);
  if (!proxyReady) {
    options.scheduleRender();
    return;
  }

  options.events.attach(options.backend);

  const started = await startBackendWithLogging(options, nodePath, sdkPath, backendPath, workspaceCwd, restoredStartupPath);
  if (!started) {
    options.events.detach();
    options.scheduleRender();
    return;
  }

  await sendRuntimePrefsWithLogging(options, restoredStartupPath);

  const restoreError = publishBackendReady({
    dispatchArch,
    scheduleRender: options.scheduleRender,
    openSession: options.openSession,
    preloadSessions: (sessionPaths) => options.state.preloadSessions(sessionPaths),
    restoredStartupPath,
    preloadPaths,
  });

  bootLogBackendReadyDispatched(options);

  if (restoreError) {
    bootLog('session-startup', 'restore.failed', {
      activeSessionPath: restoredStartupPath,
      message: restoreError.message,
    });
    return;
  }

  if (restoredStartupPath) {
    bootLog('session-startup', 'restore.openRequested', {
      activeSessionPath: restoredStartupPath,
      preloadCount: preloadPaths.length,
    });
    return;
  }

  await listAndOpenFirstSession(options);
}
