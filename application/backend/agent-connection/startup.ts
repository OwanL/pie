import * as path from 'node:path';
import { statSync } from 'node:fs';

import { BackendClient } from './client';
import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../conversation-state/restored-session-plan';
import { normalizeStoredSnoozes } from '../conversation-state/session-snooze.js';
import { readStoredOpenTabPath, normalizeStoredTabPaths, normalizeStoredPinnedTabGroups } from '../../lib/session-tabs/tab-behavior.js';
import type { BackendLaunchPaths } from '../../lib/platform-contracts/session-platform.js';
import { buildRuntimePrefsPayload } from '../../lib/protocol/index.js';
import type { ChatPrefs, SessionSummary } from '../../lib/protocol/index.js';
import type { SessionServiceEvents } from '../session-actions/events';
import { PRIVATE_SESSION_PATHS_STORAGE_KEY } from '../session-actions/state';
import type { SessionServiceState } from '../session-actions/state';
import { buildRestoredSessionSummaries } from '../conversation-state/restored-session-summaries';
import { bootLog } from '../../../lib/structured-logging/pie-logger';
import { toErrorMessage } from '../../../lib/structured-logging/error-message';
import { appendPieLog } from '../../../lib/structured-logging/pie-logger';
import { publishBackendReady } from './backend-ready';
import { seedHistoryCompactionEnvironment } from '../session-actions/runtime-prefs-bootstrap';
import type { AnalyticsBackendContext } from '../../../analytics/authority/backend-analytics-context.js';
import type { AnalyticsBackendDescriptor } from '../../../analytics/authority/activation.js';
import type { ArchState } from '../conversation-state/arch-state';
import type { Event } from '../conversation-state/events';
import type { SessionHostPlatform } from '../../lib/platform-contracts/session-platform.js';

const PREFS_STORAGE_KEY = 'chatPrefs';

function finishStartupTiming(stage: string, started: number, outcome: 'success' | 'failure'): void {
  try {
    appendPieLog('info', 'startup', 'DEBUG-startup-preflight', {
      stage, durationMs: performance.now() - started, outcome,
    });
  } catch { /* Diagnostics must never replace a startup error. */ }
}

/** Drop restored paths only when the filesystem confirms they are not files
 * or are absent (ENOENT/ENOTDIR). Sharing violations and other transient stat
 * errors retain the tab; an unavailable stat must not destroy session state. */
function isSessionPathRestorable(sessionPath: string): boolean {
  try {
    return statSync(sessionPath).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    bootLog('session-startup', 'restore.statUnavailable', {
      sessionPath,
      error: toErrorMessage(error),
    });
    return true;
  }
}

interface StartupSessionService {
  loadPruningSettings(): Promise<void>;
  loadToolResultPruningSettings(): Promise<void>;
  loadSessionTitlesSettings(): Promise<void>;
  schedulePrivateSessionCleanup(storedPrivatePaths: readonly string[], restoredTabPaths: readonly string[]): void;
}

interface StartSessionBackendOptions {
  platform: SessionHostPlatform;
  backend: BackendClient;
  scheduleRender: () => void;
  events: SessionServiceEvents;
  state: SessionServiceState;
  service: StartupSessionService;
  openSession: (sessionPath: string) => void;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  /** Snapshot the host's canonical activation at each backend spawn. */
  getAnalyticsBackendDescriptor?: () => AnalyticsBackendDescriptor | undefined;
  getAnalyticsBackendContext?: () => AnalyticsBackendContext | undefined;
}

function resolveWorkspaceCwd(platform: SessionHostPlatform): string {
  return platform.getWorkspaceCwd();
}

function applyStoredPrefs(options: StartSessionBackendOptions): void {
  const storedPrefs = options.platform.storage.get<Partial<ChatPrefs>>(PREFS_STORAGE_KEY);
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

async function loadSessionTitlesSettingsFromService(options: StartSessionBackendOptions): Promise<void> {
  await options.service.loadSessionTitlesSettings();
}

function computeRestorePlan(options: StartSessionBackendOptions) {
  const snapshot = options.platform.storage.get<{
    openTabPaths: unknown[]; activeSessionPath?: string; pinnedTabPaths: unknown[]; pinnedTabGroups: unknown;
    snoozedBySession: unknown;
  }>('sessionSnoozeTabSnapshot');
  const storedRawTabs = snapshot?.openTabPaths ?? options.platform.storage.get<unknown[]>('openTabPaths') ?? [];
  const storedSnoozePaths = Object.keys(normalizeStoredSnoozes(snapshot?.snoozedBySession, () => true));
  const restoredSnoozes = normalizeStoredSnoozes(snapshot?.snoozedBySession, isSessionPathRestorable);
  const storedPrivate = (options.platform.storage.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY) ?? [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  // Filter definitively absent paths for every restored tab, while preserving
  // tabs across transient restart/file-lock failures. Private cleanup still
  // receives the original markers and the post-reducer open tabs below.
  const { rawTabs, openTabPaths: restoredTabs, droppedPaths } = filterRestorableStoredTabs(
    storedRawTabs.filter((tab) => !storedSnoozePaths.includes(readStoredOpenTabPath(tab) ?? '')),
    isSessionPathRestorable,
  );
  const preferredStartupPath = snapshot ? snapshot.activeSessionPath ?? null : options.platform.storage.get<string>('activeSessionPath') ?? null;
  // Pinned tabs are stored as a path list (no name enrichment). Normalize
  // defensively (accept legacy string/{path} forms, drop pending/dupes), then
  // drop any pinned path that didn't survive the open-tab restore so the
  // pinned ⊆ openTabPaths invariant holds.
  const storedRawPinned = snapshot?.pinnedTabPaths ?? options.platform.storage.get<unknown[]>('pinnedTabPaths') ?? [];
  const storedPinned = normalizeStoredTabPaths(storedRawPinned);
  const restoredPinnedTabs = storedPinned.filter((p) => restoredTabs.includes(p));
  // Pinned groups are stored as nested path arrays. Normalize defensively
  // (drop non-array/non-string/pending/dup entries); the reducer reconciles
  // them against the restored pinned tabs (drops invalid members, dissolves
  // <2, restores contiguity) when OpenTabsChanged is dispatched.
  const storedRawGroups = snapshot?.pinnedTabGroups ?? options.platform.storage.get<unknown>('pinnedTabGroups');
  const storedGroups = normalizeStoredPinnedTabGroups(storedRawGroups);
  const restoredPrivate = storedPrivate.filter((sessionPath) => restoredTabs.includes(sessionPath) || !!restoredSnoozes[sessionPath]);
  const restoredSessionPlan = buildRestoredSessionPlan(restoredTabs, preferredStartupPath);
  const { startupPath: restoredStartupPath, preloadPaths } = restoredSessionPlan;
  return {
    storedSnoozePaths,
    restoredSnoozes,
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
    storedPrivate,
    restoredPrivate,
  };
}

function applyRestoredTabPaths(options: StartSessionBackendOptions, restoredTabs: string[], restoredPinnedTabs: string[], restoredGroups: string[][], restoredPrivate: string[]): void {
  options.dispatchArch({ kind: 'OpenTabsChanged', openTabPaths: restoredTabs, pinnedTabPaths: restoredPinnedTabs, pinnedTabGroups: restoredGroups });
  for (const sessionPath of restoredPrivate) {
    options.dispatchArch({
      kind: 'Command',
      cmd: { kind: 'SetPrivacyMode', corrId: `privacy:${Date.now()}:${sessionPath}`, sessionPath, enabled: true, persist: false },
    });
  }
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
    void Promise.resolve(options.platform.storage.update('openTabPaths', rawTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for openTabPaths', { error: toErrorMessage(error) });
    });
    void Promise.resolve(options.platform.storage.update('activeSessionPath', restoredStartupPath ?? undefined)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for activeSessionPath', { error: toErrorMessage(error) });
    });
  }
  if (pinnedChanged) {
    void Promise.resolve(options.platform.storage.update('pinnedTabPaths', reconciledPinnedTabs)).catch((error) => {
      appendPieLog('warn', 'startup', 'globalState.update failed for pinnedTabPaths', { error: toErrorMessage(error) });
    });
  }
  if (groupsChanged) {
    void Promise.resolve(options.platform.storage.update('pinnedTabGroups', reconciledGroups)).catch((error) => {
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

async function resolveRuntimePaths(options: StartSessionBackendOptions): Promise<BackendLaunchPaths | null> {
  const started = performance.now();
  let outcome: 'success' | 'failure' = 'failure';
  try {
    const paths = await options.platform.backendStartup.resolveBackendLaunchPaths();
    outcome = 'success';
    return paths;
  } catch (err) {
    options.dispatchArch({ kind: 'NoticeShown', notice:
      `pie setup error: ${toErrorMessage(err)}. ` +
        'Set pie.nodePath to a usable Node executable and ensure this generation contains a matching out/pi-runtime artifact. ' +
        'A verified development artifact requires PIE_DEVELOPMENT_PI_RUNTIME and PIE_ALLOW_DEVELOPMENT_RUNTIME=1.',
    });
    return null;
  } finally {
    finishStartupTiming('resolve-launch-paths', started, outcome);
  }
}



async function startBackendWithLogging(
  options: StartSessionBackendOptions,
  nodePath: string,
  sdkPath: string,
  sourceArtifactDescriptor: BackendLaunchPaths['sourceArtifactDescriptor'],
  sdkRuntimeSelection: BackendLaunchPaths['sdkRuntimeSelection'],
  backendPath: string,
  workspaceCwd: string,
  restoredStartupPath: string | null,
): Promise<boolean> {
  const spawnStart = performance.now();
  try {
    bootLog('session-startup', 'backend.starting', {
      backendPath,
      cwd: workspaceCwd,
      nodePath,
      restoredStartupPath,
    });
    appendPieLog('info', 'session-startup', 'backend.start.requested', {
      restoredStartupPath,
      cwd: workspaceCwd,
    });
    await options.backend.start({
      nodePath,
      sdkPath,
      ...(sourceArtifactDescriptor ? { sourceArtifactDescriptor } : {}),
      ...(sdkRuntimeSelection ? { sdkRuntimeSelection } : {}),
      backendPath,
      cwd: workspaceCwd,
      analyticsActivation: options.getAnalyticsBackendDescriptor?.(),
      analyticsContext: options.getAnalyticsBackendContext?.(),
    });
    const durationMs = Math.max(0, Math.round(performance.now() - spawnStart));
    bootLog('session-startup', 'backend.started', {
      restoredStartupPath,
      durationMs,
    });
    appendPieLog('info', 'session-startup', 'backend.ready', {
      restoredStartupPath,
      durationMs,
    });
    return true;
  } catch (err) {
    appendPieLog('warn', 'session-startup', 'backend.start.failed', {
      restoredStartupPath,
      durationMs: Math.max(0, Math.round(performance.now() - spawnStart)),
      error: toErrorMessage(err),
    });
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
  backendArgs: {
    nodePath: string;
    sdkPath: string;
    sourceArtifactDescriptor?: BackendLaunchPaths['sourceArtifactDescriptor'];
    sdkRuntimeSelection?: BackendLaunchPaths['sdkRuntimeSelection'];
    backendPath: string;
    cwd: string;
    restoredStartupPath: string | null;
  },
): Promise<{ started: boolean }> {
  const started = await startBackendWithLogging(
    options,
    backendArgs.nodePath,
    backendArgs.sdkPath,
    backendArgs.sourceArtifactDescriptor,
    backendArgs.sdkRuntimeSelection,
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

  const workspaceCwd = resolveWorkspaceCwd(options.platform);
  const { dispatchArch } = options;

  dispatchArch({ kind: 'WorkspaceCwdChanged', workspaceCwd });

  try {
    // The startup settings services can read/write PI_CODING_AGENT_DIR, so
    // establish the isolated profile before any settings or session work.
    options.platform.backendStartup.prepareDevelopmentEnvironment();
  } catch (error) {
    dispatchArch({ kind: 'NoticeShown', notice: `pie setup error: ${toErrorMessage(error)}` });
    options.scheduleRender();
    return;
  }

  applyStoredPrefs(options);
  // Settings families are independent and may each hit settings.json plus
  // VS Code globalState. Keep them on the same cold-start critical-path step
  // instead of paying their I/O latency serially before the backend can spawn.
  const settingsStarted = performance.now();
  let settingsOutcome: 'success' | 'failure' = 'failure';
  try {
    await Promise.all([
      loadPruningSettingsFromService(options),
      loadToolResultPruningSettingsFromService(options),
      loadSessionTitlesSettingsFromService(options),
    ]);
    settingsOutcome = 'success';
  } finally {
    finishStartupTiming('parallel-settings', settingsStarted, settingsOutcome);
  }

  const restoreStarted = performance.now();
  let restoreOutcome: 'success' | 'failure' = 'failure';
  const { restoredStartupPath, preloadPaths, storedPrivate, storedSnoozePaths, restoredSnoozes } = (() => {
    try {
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
        storedPrivate,
        restoredPrivate,
        restoredSnoozes,
        storedSnoozePaths,
      } = computeRestorePlan(options);

      applyRestoredTabPaths(options, restoredTabs, restoredPinnedTabs, storedGroups, restoredPrivate);

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

      const cachedSessions = buildRestoredSessionSummaries(
        [...rawTabs, ...Object.values(restoredSnoozes)],
        [...new Set([...restoredTabs, ...Object.keys(restoredSnoozes)])], workspaceCwd, new Date().toISOString(),
      );
      if (cachedSessions.length > 0) {
        dispatchArch({ kind: 'SessionSummariesReplaced', summaries: cachedSessions });
      }

      if (restoredStartupPath) {
        dispatchArch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: `select:${Date.now()}`, sessionPath: restoredStartupPath } });
      }

      dispatchArch({ kind: 'SessionSnoozesRestored', entries: restoredSnoozes, now: Date.now() });

      bootLogRestorePrepared(restoredStartupPath, cachedSessions.length, droppedPaths.length, restoredTabs.length, preloadPaths.length);
      restoreOutcome = 'success';
      return { restoredStartupPath, preloadPaths, storedPrivate, storedSnoozePaths, restoredSnoozes };
    } finally {
      finishStartupTiming('restore-preparation', restoreStarted, restoreOutcome);
    }
  })();

  const paths = await resolveRuntimePaths(options);
  if (!paths) {
    options.scheduleRender();
    return;
  }
  const { nodePath, sdkPath, sourceArtifactDescriptor, sdkRuntimeSelection } = paths;

  const backendPath = path.join(options.platform.getRuntimeOutputDirectory(), 'backend.js');
  options.platform.backendStartup.prepareBackendEnvironment((notice) => {
    dispatchArch({ kind: 'NoticeShown', notice });
  });
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
    { nodePath, sdkPath, sourceArtifactDescriptor, sdkRuntimeSelection, backendPath, cwd: workspaceCwd, restoredStartupPath },
  );
  if (!started) {
    options.events.detach();
    options.scheduleRender();
    return;
  }

  // The backend client's spawn generation is the source of truth for every
  // coordinator/worker/detail fence. Setup failures can advance host lifecycle
  // state without spawning, so reconcile only after readiness succeeds.
  const acknowledgedGeneration = typeof (options.backend as BackendClient & { getGeneration?: () => number }).getGeneration === 'function'
    ? options.backend.getGeneration()
    : options.state.getBackendGeneration();
  options.state.adoptBackendGeneration(acknowledgedGeneration);

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
    isRestoredSessionOpen: (sessionPath) => options.getArchState().sessions.openTabPaths.includes(sessionPath),
    restoredStartupPath,
    preloadPaths,
  });

  bootLog('session-startup', 'publishBackendReady.done', {
    restoreError: restoreError?.message ?? null,
  });

  bootLogBackendReadyDispatched(options);

  // Stale private markers are cleanup work, not a readiness prerequisite.
  // Use the post-reducer tab set after restore, not the pre-open plan: a
  // definitively missing path is removed before planning, while a path that
  // only became unavailable during startup is cleaned up only if failure
  // recovery really removed it. The service owns bounded, deduplicated,
  // generation-safe background requests and marker persistence.
  options.service.schedulePrivateSessionCleanup(
    storedPrivate,
    [...options.getArchState().sessions.openTabPaths, ...storedSnoozePaths],
  );

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

  // Expired snoozes return as background tabs, even when no foreground tab
  // survived the restart. Do not let first-session fallback select them.
  if (Object.keys(restoredSnoozes).length > 0) return;
  await listAndOpenFirstSession(options);
}
