import * as path from 'node:path';
import { readFileSync } from 'node:fs';

import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../core/restored-session-plan';
import { normalizeStoredTabPaths, normalizeStoredPinnedTabGroups } from '../../shared/tab-behavior';
import { createCommandExecutor } from '../../shared/exec-command';

import {
  minimumNodeVersionFromEngine,
  resolveCompatibleNodePath,
  resolveNodePath,
  resolveSdkPath,
} from '../../shared/runtime-resolution';
import { resolveAgentDir } from '../../shared/agent-dir-resolution';
import { buildRuntimePrefsPayload } from '../../shared/protocol';
import type { ChatPrefs, SessionSummary } from '../../shared/protocol';
import { SessionService } from './service';
import { SessionServiceEvents } from './events';
import { SessionServiceState } from './state';
import { buildRestoredSessionSummaries } from '../core/restored-session-summaries';
import { bootLog } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';
import { publishBackendReady } from './backend-ready';
import { seedHistoryCompactionEnvironment } from './runtime-prefs-bootstrap';
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

async function loadToolResultPruningSettingsFromService(options: StartSessionBackendOptions): Promise<void> {
  await options.service.loadToolResultPruningSettings();
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
  // Pinned groups are stored as nested path arrays. Normalize defensively
  // (drop non-array/non-string/pending/dup entries); the reducer reconciles
  // them against the restored pinned tabs (drops invalid members, dissolves
  // <2, restores contiguity) when OpenTabsChanged is dispatched.
  const storedRawGroups = options.context.globalState.get<unknown>('pinnedTabGroups');
  const storedGroups = normalizeStoredPinnedTabGroups(storedRawGroups);
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
    storedGroups,
  };
}

function applyRestoredTabPaths(options: StartSessionBackendOptions, restoredTabs: string[], restoredPinnedTabs: string[], restoredGroups: string[][]): void {
  options.dispatchArch({ kind: 'OpenTabsChanged', openTabPaths: restoredTabs, pinnedTabPaths: restoredPinnedTabs, pinnedTabGroups: restoredGroups });
}

function persistIfTabStateChanged(
  options: StartSessionBackendOptions,
  storedRawTabs: unknown[],
  rawTabs: unknown[],
  preferredStartupPath: string | null,
  restoredStartupPath: string | null,
  storedPinned: string[],
  reconciledPinnedTabs: string[],
  storedGroups: string[][],
  reconciledGroups: string[][],
): void {
  const tabsChanged =
    rawTabs.length !== storedRawTabs.length
    || preferredStartupPath !== (restoredStartupPath ?? undefined);
  const pinnedChanged =
    reconciledPinnedTabs.length !== storedPinned.length
    || reconciledPinnedTabs.some((p, i) => p !== storedPinned[i]);
  const groupsChanged =
    reconciledGroups.length !== storedGroups.length
    || reconciledGroups.some((g, i) =>
      g.length !== storedGroups[i].length || g.some((m, j) => m !== storedGroups[i][j]));
  if (tabsChanged) {
    void Promise.resolve(options.context.globalState.update('openTabPaths', rawTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for openTabPaths', { error: toErrorMessage(error) });
    });
    void Promise.resolve(options.context.globalState.update('activeSessionPath', restoredStartupPath ?? undefined)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for activeSessionPath', { error: toErrorMessage(error) });
    });
  }
  if (pinnedChanged) {
    void Promise.resolve(options.context.globalState.update('pinnedTabPaths', reconciledPinnedTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for pinnedTabPaths', { error: toErrorMessage(error) });
    });
  }
  if (groupsChanged) {
    void Promise.resolve(options.context.globalState.update('pinnedTabGroups', reconciledGroups)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for pinnedTabGroups', { error: toErrorMessage(error) });
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

    const exec = createCommandExecutor();
    const sdkPath = await resolveSdkPath({
      configuredPath: configuredSdkPath,
      cachedPath: cachedSdkPath,
      localCandidatePath,
      env: process.env as NodeJS.ProcessEnv,
      exec,
    });
    const sdkPackage = JSON.parse(
      readFileSync(path.join(sdkPath, 'package.json'), 'utf8'),
    ) as { engines?: { node?: unknown } };
    const sdkNodeEngine = typeof sdkPackage.engines?.node === 'string'
      ? sdkPackage.engines.node
      : undefined;
    const minimumNodeVersion = minimumNodeVersionFromEngine(sdkNodeEngine);
    const nodePath = minimumNodeVersion
      ? await resolveCompatibleNodePath({
          configuredPath: configuredNodePath,
          env: process.env as NodeJS.ProcessEnv,
          exec,
          minimumVersion: minimumNodeVersion,
        })
      : resolveNodePath({
          configuredPath: configuredNodePath,
          env: process.env as NodeJS.ProcessEnv,
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
      nodePath,
      restoredStartupPath,
    });
    const spawnStart = Date.now();
    await options.backend.start({ nodePath, sdkPath, backendPath, cwd: workspaceCwd });
    bootLog('session-startup', 'backend.started', {
      restoredStartupPath,
      durationMs: Date.now() - spawnStart,
    });
    return true;
  } catch (err) {
    // Dispatch BackendReadyChanged{ready:false} so the UI reflects the failed
    // state — without this, the sidebar can stay stuck at "loading sessions"
    // because no ready/false signal is ever sent when spawn fails.
    options.dispatchArch({ kind: 'BackendReadyChanged', ready: false });
    options.dispatchArch({ kind: 'NoticeShown', notice: `Failed to start PI backend: ${toErrorMessage(err)}` });
    bootLog('session-startup', 'backend.startFailed', {
      message: toErrorMessage(err),
    });
    return false;
  }
}

/** Spawn the backend and await readiness. Concurrency limiting is now
 *  handled by the host-side ProviderGate (provider-gate.ts), which wraps
 *  globalThis.fetch at BackendServer.start() time. */
export async function spawnBackend(
  options: StartSessionBackendOptions,
  backendArgs: { nodePath: string; sdkPath: string; backendPath: string; cwd: string; restoredStartupPath: string | null },
): Promise<{ started: boolean }> {
  const started = await startBackendWithLogging(
    options,
    backendArgs.nodePath,
    backendArgs.sdkPath,
    backendArgs.backendPath,
    backendArgs.cwd,
    backendArgs.restoredStartupPath,
  );
  if (!started) {
    await options.backend.stop().catch(() => undefined);
  }
  return { started };
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
    // Cold SDK/session restoration can keep the backend event loop busy well
    // beyond the normal 5s live-settings budget. Wait for the authoritative
    // startup snapshot instead of proceeding with runtime defaults after a
    // false timeout; the payload is idempotent and must precede session open.
    await options.backend.request(
      'runtimePrefs.set',
      buildRuntimePrefsPayload(archState.settings.prefs),
      { timeoutMs: 60_000 },
    );
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
  // Both settings families are independent and may each hit settings.json plus
  // VS Code globalState. Keep them on the same cold-start critical-path step
  // instead of paying their I/O latency serially before the backend can spawn.
  await Promise.all([
    loadPruningSettingsFromService(options),
    loadToolResultPruningSettingsFromService(options),
  ]);

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
    storedGroups,
  } = computeRestorePlan(options);

  applyRestoredTabPaths(options, restoredTabs, restoredPinnedTabs, storedGroups);

  // The reducer reconciles pinned tabs + groups against the restored open
  // tabs (drops invalid members, dissolves <2, restores group contiguity).
  // Persist the reconciled values so globalState matches archState exactly.
  const reconciled = options.getArchState().sessions;
  persistIfTabStateChanged(
    options,
    storedRawTabs,
    rawTabs,
    preferredStartupPath,
    restoredStartupPath,
    storedPinned,
    reconciled.pinnedTabPaths,
    storedGroups,
    reconciled.pinnedTabGroups,
  );

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
  // The child inherits this before SDK load, closing the startup window where
  // automatic compaction could otherwise use pi's native defaults while the
  // runtimePrefs.set snapshot waits behind cold session restoration.
  seedHistoryCompactionEnvironment(options.getArchState().settings.prefs);

  // Attach the backend event handlers BEFORE spawning so that events emitted
  // immediately after backend.ready (e.g. session.opened) are not lost. This
  // was lost during proxy removal and caused all backend events to be silently
  // dropped — sessions could be created on the backend but the host never
  // received session.opened, leaving tabs stuck at "Loading conversation".
  options.events.attach(options.backend);

  // Spawn the backend and await readiness. Concurrency limiting is handled
  // by the host-side ProviderGate (provider-gate.ts) installed at
  // BackendServer.start() time — no separate proxy process needed.
  const { started } = await spawnBackend(
    options,
    { nodePath, sdkPath, backendPath, cwd: workspaceCwd, restoredStartupPath },
  );
  if (!started) {
    options.events.detach();
    options.scheduleRender();
    return;
  }

  await sendRuntimePrefsWithLogging(options, restoredStartupPath);

  bootLog('session-startup', 'publishBackendReady.calling', {
    restoredStartupPath,
    preloadPathsCount: preloadPaths.length,
  });
  const restoreError = publishBackendReady({
    dispatchArch,
    scheduleRender: options.scheduleRender,
    openSession: options.openSession,
    preloadSessions: (sessionPaths) => options.state.preloadSessions(sessionPaths),
    restoredStartupPath,
    preloadPaths,
  });

  bootLog('session-startup', 'publishBackendReady.done', {
    restoreError: restoreError?.message ?? null,
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
