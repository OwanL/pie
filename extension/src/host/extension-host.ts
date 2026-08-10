import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { EMPTY_DIFF_SCHEME, EmptyDiffContentProvider, FileDiffService } from './core/file-diff-service';
import { MessageRouter } from './core/message-router';

import {
  buildWorkspaceAnalyticsId,
  getDataOutcomesRootPath,
  getDefaultRunAnalyticsExportPath,
} from './run-analytics/storage';
import { BackendClient } from './backend/client';
import {
  requestWindowAttention,
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from './sidebar/completion-notification';
import { type RunAnalyticsExportPayload } from './run-analytics/query';
import { SidebarViewProvider } from './sidebar/provider';
import { SessionService } from './session-service';
import { TokenRateService } from './token-rate-service';
import { AggregateStatsService } from './aggregate-stats-service';
import { EMPTY_PROVIDER_GATE_STATS, type ProviderGateStats } from '../shared/protocol/aggregate-stats';
import { OPEN_TABS_STORAGE_KEY, ACTIVE_SESSION_STORAGE_KEY, PINNED_TABS_STORAGE_KEY, PINNED_TAB_GROUPS_STORAGE_KEY, PRIVATE_SESSION_PATHS_STORAGE_KEY } from './session-service/state';
import { StatsService } from './stats-service';
import { toErrorMessage } from './util/error-message';
import type { WebviewToHostMessage, ViewState, SessionSummary } from '../shared/protocol';
import { EffectRunner } from './core/effect-runner';
import { dispatch } from './core/dispatch';
import { initialArchState, type ArchState } from './core/reducer';
import type { Event } from './core/events';
import { selectViewState } from './core/projection';
import { auditLog, bootLog } from './util/audit';
import { getDiagPath, isStreamDiagEnabled, setStreamDiagEnabled } from './util/stream-telemetry';
import {
  disposeLivePipelineTrace,
  getLivePipelineTraceHealth,
  getLivePipelineTracePath,
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
  setLivePipelineTraceEnabled,
} from './util/live-pipeline-trace-runtime';
import {
  getPieLogDir,
  getPieLogPath,
  getLogLevel,
  LOG_LEVELS,
  parseLogLevel,
  setLogLevel,
} from './util/pie-logger';
import { deriveSessionNameFromText } from '../shared/session-name';
import { isPendingTabPath } from '../shared/tab-behavior';
import { appendPieLog } from './util/pie-log';


export const SIDEBAR_VIEW_TYPE = 'pie.sessionsView';

const NO_WORKSPACE_ANALYTICS_ID_KEY = 'pie.analytics.noWorkspaceId';

function getWorkspaceAnalyticsId(context: vscode.ExtensionContext): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceFile = vscode.workspace.workspaceFile;

  if (workspaceFolders?.length || workspaceFile) {
    return buildWorkspaceAnalyticsId({
      workspaceFolders,
      workspaceFile,
      noWorkspaceId: 'workspace',
    });
  }

  const existingNoWorkspaceId = context.workspaceState.get<string>(NO_WORKSPACE_ANALYTICS_ID_KEY)?.trim();
  const noWorkspaceId = existingNoWorkspaceId || crypto.randomUUID();

  if (!existingNoWorkspaceId) {
    void context.workspaceState.update(NO_WORKSPACE_ANALYTICS_ID_KEY, noWorkspaceId).then(undefined, (err) =>
      appendPieLog('warn', 'globalState', 'update failed', {
        key: NO_WORKSPACE_ANALYTICS_ID_KEY,
        error: toErrorMessage(err),
      })
    );
  }

  return buildWorkspaceAnalyticsId({
    workspaceFolders,
    workspaceFile,
    noWorkspaceId,
  });
}

function getLegacyWorkspaceAnalyticsIds(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders?.length) {
    return [
      workspaceFolders
        .map((folder) => folder.uri.toString())
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    ];
  }

  return [vscode.workspace.name ?? 'no-workspace'];
}

export class PieExtension implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly sidebarProvider: SidebarViewProvider;
  private readonly tokenRateService: TokenRateService;
  private readonly aggregateStatsService: AggregateStatsService;
  private readonly statsService: StatsService;
  private readonly service: SessionService;
  private shutdownPromise: Promise<void> | null = null;
  private statusBarUpdateScheduled = false;

  private readonly messageRouter: MessageRouter;

  // Phase 3: CQRS architecture spine
  private archState: ArchState = initialArchState;
  private readonly effectRunner: EffectRunner;
  private readonly fileDiffService: FileDiffService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
  ) {
    const dataOutcomesRootPath = getDataOutcomesRootPath(
      process.env.PI_CODING_AGENT_DIR,
      context.globalStorageUri.fsPath,
    );

    this.statsService = new StatsService({
      dataOutcomesRootPath,
      legacyUsageDataRootPath: context.globalStorageUri.fsPath,
      workspaceId: getWorkspaceAnalyticsId(context),
      legacyWorkspaceIds: getLegacyWorkspaceAnalyticsIds(),
      scheduleRender: () => this.scheduleRender(),
      getExperimentAssignment: () => this.getExperimentAssignment(),
      getArchState: () => this.archState,
      dispatchArchEvent: (event) => this.dispatchArchEvent(event),
    });

    this.service = new SessionService(
      context,
      backend,
      () => this.scheduleRender(),
      (message) => this.sidebarProvider.postImperative(message),
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
    );

    this.tokenRateService = new TokenRateService({
      getArchState: () => this.archState,
      onActiveRateChanged: () => this.sidebarProvider.scheduleState(),
      onRatesTick: () => this.aggregateStatsService.refreshLive(),
    });

    this.aggregateStatsService = new AggregateStatsService({
      getArchState: () => this.archState,
      statsService: this.statsService,
      tokenRateService: this.tokenRateService,
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR?.trim() || null,
      fetchProviderGateStats: () => this.backend
        .request<ProviderGateStats>('provider_gate.metrics', undefined, { timeoutMs: 2000 })
        .catch(() => EMPTY_PROVIDER_GATE_STATS),
      onChanged: () => this.sidebarProvider.scheduleState(),
    });

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => this.buildViewState(),
      (message) => {
        void this.handleWebviewMessage(message);
      },
      () => this.archState.sessions.runningSessionPaths.length,
    );

    this.fileDiffService = new FileDiffService(() => this.archState);

    this.messageRouter = new MessageRouter(
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      this.service,
      this.sidebarProvider,
      () => this.scheduleRender(),
      deriveSessionNameFromText,
      isPendingTabPath,
    );

    this.effectRunner = new EffectRunner({
      backend: this.backend,
      // Prepass-aware send-timer budget (Brief B follow-up): when the user sets
      // an explicit `prepassTimeoutSec`, budget for it + first-token headroom so
      // a long-but-legitimate prepass never trips a spurious `PreflightFailed`
      // (which would roll back the user message — promoted still present — and
      // orphan a late `MessageStarted` reply). Falls back to the 120s default
      // when `prepassTimeoutSec` is unset/invalid (SDK default, presumed < 120s).
      // Read fresh each send so a runtime settings change takes effect.
      getSendTimerTimeoutMs: (sessionPath: string) => {
        const p = this.archState.settings.pruningSettings.prepassTimeoutSec;
        const HEADROOM_SEC = 30;
        // FP-C3: real per-provider queueWaitSeconds headroom. A send whose
        // provider is saturated spends up to `queueWaitSeconds` queued for a
        // concurrency slot BEFORE its prepass even begins; that wait is inside
        // this timer's window (the clock starts at issue, before the slot is
        // acquired). Use the real configured value from aggregateStats.providerGate
        // (polled from the backend's ProviderGate), falling back to a
        // conservative 30s when unavailable (fail-safe — never under-size the
        // headroom and trip a spurious PreflightFailed mid-queue).
        const QUEUE_WAIT_HEADROOM_MS = this.resolveQueueWaitHeadroomMs(sessionPath);
        return typeof p === 'number' && Number.isFinite(p) && p > 0
          ? (p + HEADROOM_SEC) * 1000 + QUEUE_WAIT_HEADROOM_MS
          : 120_000 + QUEUE_WAIT_HEADROOM_MS;
      },
      // Metric-gated re-arm for the model-start send-timer: when the in-flight
      // request's provider is legitimately QUEUED waiting for a concurrency
      // slot (or PAUSED by the circuit breaker), the model-start timer (whose
      // clock starts at issue, before the slot is acquired) would otherwise
      // fire a false-positive PreflightFailed. `getProviderGateMetrics` reads
      // the live signal (cached in AggregateStats.providerGate, polled from the
      // backend's ProviderGate); `resolveSessionProvider` resolves the
      // request's provider via the session's model → available-models table
      // (mirroring host/core/model-capability.ts). Both optional + fail-open:
      // the runner fires as today if either is absent or yields no match.
      getProviderGateMetrics: () => this.aggregateStatsService.getAggregateStats().providerGate,
      resolveSessionProvider: (sessionPath: string) => this.resolveSessionProvider(sessionPath),
      queues: this.service.queues,
      tabs: {
        // PersistTabs: write openTabPaths + activeSessionPath to globalState,
        // matching SessionServiceState.saveOpenTabs() exactly (same storage
        // keys, same JSON shape). Uses the effect's args (a snapshot of the
        // post-reorder state) rather than re-reading the service's internal
        // state; session names are looked up from the current archState solely
        // to enrich the persisted { path, name } objects.
        persistTabs: async (openTabPaths, activeSessionPath, pinnedTabPaths, pinnedTabGroups, privateSessionPaths) => {
          const sessions = this.archState.sessions.sessions;
          const tabObjects = openTabPaths
            .filter((p) => !isPendingTabPath(p))
            .map((p) => {
              const session = sessions.find((s) => s.path === p);
              return session ? { path: p, name: session.name } : { path: p };
            });
          const persistedActiveSessionPath =
            activeSessionPath
            && !isPendingTabPath(activeSessionPath)
            && openTabPaths.includes(activeSessionPath)
              ? activeSessionPath
              : undefined;
          // Pinned tabs are path-only (no name enrichment needed) and filtered
          // to drop any pending path that slipped through (a pending tab can
          // be pinned while it resolves — never persist the transient path).
          const persistedPinnedTabPaths = pinnedTabPaths.filter((p) => !isPendingTabPath(p));
          // Pinned groups persist as nested path arrays, filtered to drop any
          // pending-member group (a pending tab can be a group member while it
          // resolves). Groups with only pending members collapse to empty and
          // are dropped.
          const persistedPinnedTabGroups = pinnedTabGroups
            .map((group) => group.filter((p) => !isPendingTabPath(p)))
            .filter((group) => group.length > 0);
          try {
            await Promise.all([
              context.globalState.update(OPEN_TABS_STORAGE_KEY, tabObjects),
              context.globalState.update(ACTIVE_SESSION_STORAGE_KEY, persistedActiveSessionPath),
              context.globalState.update(PINNED_TABS_STORAGE_KEY, persistedPinnedTabPaths),
              context.globalState.update(PINNED_TAB_GROUPS_STORAGE_KEY, persistedPinnedTabGroups),
              context.globalState.update(
                PRIVATE_SESSION_PATHS_STORAGE_KEY,
                (privateSessionPaths ?? Object.entries(this.archState.sessions.privacyModeBySession)
                  .filter(([, enabled]) => enabled)
                  .map(([sessionPath]) => sessionPath))
                  .filter((sessionPath) => !isPendingTabPath(sessionPath)),
              ),
            ]);
          } catch (err) {
            appendPieLog('warn', 'globalState', 'tab persistence failed', {
              error: toErrorMessage(err),
            });
            throw err;
          }

          // Push only after durable tab persistence succeeds. The correlated
          // PersistTabsResult is also the closure outbox's authoritative hide
          // completion signal for running sessions.
          this.pushOpenTabsRegistry();
        },
      },
      log: {
        log: (level, message, data) => {
          if (level === 'info') {
            // `auditLog` already writes through the unified pie logger when
            // runtime auditing is enabled. Writing via `appendPieLog` as well
            // duplicated every effect breadcrumb and doubled synchronous disk
            // I/O precisely when a recovery/checkpoint loop was busiest.
            auditLog('arch-effect-runner', message, (data as Record<string, unknown>) ?? {});
          } else {
            appendPieLog(level, 'arch-effect-runner', message, data);
          }
        },
      },
      postImperative: {
        postImperative: (message) => this.sidebarProvider.postImperative(message as import('../shared/protocol').HostToWebviewMessage),
      },
      modal: {
        // ShowModelSwitchConfirm: a modal VS Code warning dialog. The reducer
        // owns the question text + confirm button label; the runner is a thin
        // executor. Resolves to the chosen label or undefined if dismissed.
        showWarningModal: (message, confirmChoice) =>
          vscode.window.showWarningMessage(message, { modal: true }, confirmChoice),
      },
      fileDiffService: this.fileDiffService,
      service: this.service,
      statsService: this.statsService,
      dispatch: (event) => this.dispatchArchEvent(event),
      dispatchCommand: (event) => this.dispatchArchEvent(event),
      dispatchEvent: (event) => this.dispatchArchEvent(event),
    });

    this.statusBar.command = 'pie.openChat';
    this.statusBar.show();
  }

  /** Resolve the provider name for a session's in-flight request from its
   *  provider/model pair. A bare model-id fallback is retained only for legacy
   *  summaries that predate provider persistence. Shared by the FP-C2a
   *  model-start re-arm gate and FP-C3 queue-wait headroom. */
  private resolveSessionProvider(sessionPath: string): string | undefined {
    const archState = this.archState;
    const session = archState.sessions.sessions.find((item) => item.path === sessionPath);
    const modelId = session?.modelId ?? archState.settings.modelSettings?.defaultModel;
    const provider = session?.provider ?? archState.settings.modelSettings?.defaultProvider;
    if (!modelId) return undefined;
    const directModels = archState.settings.availableModelsBySession[sessionPath] ?? [];
    const fallbackModels = Object.values(archState.settings.availableModelsBySession).flatMap((models) => models);
    const models = [...directModels, ...fallbackModels];
    return provider
      ? models.find((model) => model.id === modelId && model.provider === provider)?.provider
      : models.find((model) => model.id === modelId)?.provider;
  }

  /** FP-C3: resolve the real per-provider `queueWaitSeconds` headroom for a
   *  send's provider, read from the live `aggregateStats.providerGate`
   *  (polled from the backend's `ProviderGate`). Falls back to a conservative
   *  30s default when the gate is disabled, the provider can't be resolved, no
   *  matching provider metric exists, or the configured value is 0/unbounded —
   *  fail-safe so the send-timer never under-sizes the headroom and trips a
   *  spurious `PreflightFailed` mid-queue. */
  private resolveQueueWaitHeadroomMs(sessionPath: string): number {
    const DEFAULT_HEADROOM_MS = 30_000;
    const providerGate = this.aggregateStatsService.getAggregateStats().providerGate;
    if (!providerGate.enabled) return DEFAULT_HEADROOM_MS;
    const provider = this.resolveSessionProvider(sessionPath);
    if (!provider) return DEFAULT_HEADROOM_MS;
    const metric = providerGate.providers.find((p) => p.provider === provider);
    const queueWaitSeconds = metric?.queueWaitSeconds;
    if (typeof queueWaitSeconds !== 'number' || queueWaitSeconds <= 0) return DEFAULT_HEADROOM_MS;
    return queueWaitSeconds * 1000;
  }

  /** Seed privacy markers before analytics/aggregate services start. This
   * prevents a cold-start aggregate read from briefly exposing runs belonging
   * to private sessions while session tabs are still being restored. */
  private hydratePrivacyMarkers(): void {
    const paths = this.context.globalState.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY) ?? [];
    for (const sessionPath of paths) {
      if (typeof sessionPath !== 'string' || !sessionPath) continue;
      this.dispatchArchEvent({
        kind: 'Command',
        cmd: { kind: 'SetPrivacyMode', corrId: `privacy-start:${Date.now()}:${sessionPath}`, sessionPath, enabled: true, persist: false },
      });
    }
  }

  async start(): Promise<void> {
    this.updateStatusBar('Starting');
    this.hydratePrivacyMarkers();
    this.tokenRateService.start();
    this.aggregateStatsService.start();
    await this.statsService.start();
    await this.service.start();
    // Push the restored open-tab summaries to the backend so the
    // `session_review` tool's listOpen works immediately after startup
    // (persistTabs only fires on tab changes, not on cold-start restore).
    this.pushOpenTabsRegistry();
  }

  async restart(): Promise<void> {
    this.updateStatusBar('Starting');
    await this.service.restart();
    this.pushOpenTabsRegistry();
  }

  /** Push the currently-open tab summaries to the backend (`openTabs.set`) so
   *  the `session_review` tool can list "currently open" sessions (true host
   *  tab state) without a host→tool bridge. Called from `persistTabs` (on tab
   *  changes) and once after backend start/restart (startup gap). The
   *  summaries already carry canonical V2 review state merged from the sidecar. */
  private pushOpenTabsRegistry(): void {
    const sessions = this.archState.sessions.sessions;
    const pinned = this.archState.sessions.pinnedTabPaths;
    const running = this.archState.sessions.runningSessionPaths;
    const tabs = this.archState.sessions.openTabPaths
      .filter((p) => !isPendingTabPath(p))
      .map((p) => {
        const s = sessions.find((entry) => entry.path === p);
        return s ? { ...s, pinned: pinned.includes(p), isRunning: running.includes(p) } : undefined;
      })
      .filter((s): s is SessionSummary & { pinned: boolean; isRunning: boolean } => !!s);
    void this.backend
      .request('openTabs.set', { tabs }, { timeoutMs: 5000 })
      .catch((err) =>
        appendPieLog('warn', 'openTabs', 'openTabs.set failed', { error: toErrorMessage(err) })
      );
  }



  /**
   * Phase 3: dispatch an event through the arch reducer and execute resulting effects.
   * This is the single point where the new CQRS spine integrates with the extension.
   */
  private dispatchArchEvent(event: Event): void {
    const traceStartedAt = isLivePipelineTraceEnabled() ? performance.now() : 0;
    // Pre-reducer side effects for specific event types.
    if (event.kind === 'SendResult' && event.ok && event.requestId) {
      this.service.bindRequestSessionPath(event.requestId, event.sessionPath);
    }
    if (event.kind === 'CloseSessionResult' || event.kind === 'PersistTabsResult') {
      this.service.handleReviewClosureEffectResult(event);
    }

    const result = dispatch(this.archState, event);
    this.archState = result.state;
    if (isLivePipelineTraceEnabled()) {
      const trace = eventTraceMetadata(event);
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.reducer.applied',
        kind: 'success',
        identifiers: trace.identifiers,
        eventSeq: trace.eventSeq,
        durationMs: Math.max(0, performance.now() - traceStartedAt),
      });
    }
    for (const effect of result.effects) {
      this.effectRunner.run(effect);
    }
    this.scheduleRender();
  }

  register(): void {
    this.context.subscriptions.push(
      this.backend,
      this.service,
      this.statusBar,
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_DIFF_SCHEME, new EmptyDiffContentProvider()),
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_TYPE, this.sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('pie.openChat', () => {
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.dumpDebugState', async () => {
        const dumpPath = await this.dumpDebugState();
        const open = 'Open File';
        const reveal = 'Reveal in Folder';
        const choice = await vscode.window.showInformationMessage(
          `pie debug state written: ${dumpPath}`,
          open,
          reveal,
        );
        if (choice === open) {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dumpPath));
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (err) {
            void vscode.window.showErrorMessage(`Failed to open debug state: ${toErrorMessage(err)}`);
          }
        } else if (choice === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dumpPath));
        }
        return dumpPath;
      }),
      vscode.commands.registerCommand('pie.toggleStreamDiag', () => {
        const next = setStreamDiagEnabled(!isStreamDiagEnabled());
        setLivePipelineTraceEnabled(next);
        void this.backend.request('diagnostics.livePipeline.setEnabled', { enabled: next }, { timeoutMs: 5_000 }).catch(() => undefined);
        const health = getLivePipelineTraceHealth();
        void vscode.window.showInformationMessage(
          `pie stream diagnostics: ${next ? 'ON' : 'OFF'} — aggregate: ${getDiagPath()} — pipeline: ${getLivePipelineTracePath()} — health e/s/d/u ${health.emitted}/${health.sampled}/${health.dropped}/${health.unflushed}`,
        );
      }),
      vscode.commands.registerCommand('pie.setLogLevel', async () => {
        const current = getLogLevel();
        const items = LOG_LEVELS.map((level) => ({
          label: level,
          description: level === current ? '$(check) current' : undefined,
          picked: level === current,
          level,
        }));
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: `Select pie log verbosity (current: ${current})`,
          title: 'pie: Set Log Level',
        });
        if (!pick) {
          return;
        }
        setLogLevel(pick.level);
        // Persist the choice so it survives reloads.
        await vscode.workspace
          .getConfiguration('pie')
          .update('logLevel', pick.level, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          `pie log level: ${pick.level} — persistent log: ${getPieLogPath()}`,
        );
      }),
      vscode.commands.registerCommand('pie.openLogFile', async () => {
        const logPath = getPieLogPath();
        const rotated = `${logPath}.1`;
        let target = logPath;
        try {
          await fs.access(logPath);
        } catch {
          // Active log missing (nothing written yet) — fall back to the
          // rotated backup so the command still shows something useful.
          try {
            await fs.access(rotated);
            target = rotated;
          } catch {
            void vscode.window.showWarningMessage(
              `pie log file does not exist yet. Path: ${logPath}`,
            );
            return;
          }
        }
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to open pie log: ${toErrorMessage(err)}`,
          );
        }
      }),
      vscode.commands.registerCommand('pie.revealLogFolder', async () => {
        const dir = getPieLogDir();
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {
          // mkdir failures are non-fatal; reveal may still succeed.
        }
        const uri = vscode.Uri.file(dir);
        try {
          await vscode.commands.executeCommand('revealFileInOS', uri);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to reveal pie log folder: ${toErrorMessage(err)} (${dir})`,
          );
        }
      }),
      vscode.commands.registerCommand('pie.newSession', async () => {
        this.service.createNewSession();
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.restartBackend', async () => {
        await this.restart();
      }),
      vscode.commands.registerCommand('pie.exportRunAnalytics', async (
        target?: vscode.Uri | string,
      ) => {
        return await this.exportRunAnalytics(target);
      }),
      vscode.commands.registerCommand('pie.attachFiles', async (
        resource?: vscode.Uri,
        resources?: vscode.Uri[],
      ) => {
        const uris = [
          ...(Array.isArray(resources) ? resources : []),
          ...(resource ? [resource] : []),
        ];
        await this.attachFiles(uris, 'picker');
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pie.experimentAssignment')) {
          this.statsService.onExperimentAssignmentChanged(this.getExperimentAssignment());
        }
        if (event.affectsConfiguration('pie.logLevel')) {
          const configured = vscode.workspace
            .getConfiguration('pie')
            .get<string>('logLevel', 'info');
          setLogLevel(parseLogLevel(configured, 'info'));
        }
      }),
    );
  }

  private getExperimentAssignment(): string | null {
    const configured = vscode.workspace
      .getConfiguration('pie')
      .get<string>('experimentAssignment', '')
      .trim();
    return configured.length > 0 ? configured : null;
  }

  private async attachFiles(
    uris: vscode.Uri[],
    source: 'picker' | 'drop' = 'picker',
  ): Promise<void> {
    const targets = this.service.normalizeAttachUris(uris);
    if (targets.length === 0) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Attach to pie',
        title: 'Attach file path(s) to pie',
      });
      if (!picked || picked.length === 0) return;
      await this.attachFiles(picked, 'picker');
      return;
    }

    this.sidebarProvider.reveal();
    await this.service.addFilesystemPaths(
      undefined,
      targets.map((uri) => uri.fsPath),
      source,
    );
  }

  private async exportRunAnalytics(
    target?: vscode.Uri | string,
  ): Promise<RunAnalyticsExportPayload | undefined> {
    const shouldNotify = !target;
    const resolvedTarget = typeof target === 'string'
      ? vscode.Uri.file(target)
      : target ?? await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(getDefaultRunAnalyticsExportPath(
          process.env.PI_CODING_AGENT_DIR,
          this.context.globalStorageUri.fsPath,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        )),
        filters: {
          JSON: ['json'],
        },
        saveLabel: 'Export Run Analytics',
        title: 'Export pie run analytics',
      });

    if (!resolvedTarget) {
      return undefined;
    }

    try {
      const payload = await this.statsService.exportRunAnalytics(resolvedTarget.fsPath);
      if (shouldNotify) {
        void vscode.window.showInformationMessage(
          `pie: Exported run analytics to ${resolvedTarget.fsPath}`,
        );
      }
      return payload;
    } catch (error) {
      const message = toErrorMessage(error);
      if (shouldNotify) {
        void vscode.window.showErrorMessage(`pie: Failed to export run analytics: ${message}`);
      }
      throw error;
    }
  }

  private async dumpDebugState(): Promise<string> {
    const dumpPath = path.join(this.context.globalStorageUri.fsPath, 'pie-debug-state.json');
    const payload = {
      capturedAt: new Date().toISOString(),
      sidebar: this.sidebarProvider.getDebugState(),
      viewState: this.buildViewState(),
    };

    await fs.mkdir(path.dirname(dumpPath), { recursive: true });
    await fs.writeFile(dumpPath, JSON.stringify(payload, null, 2), 'utf8');
    return dumpPath;
  }

  /**
   * Project the CQRS `ArchState` into the `ViewState` consumed by the webview,
   * then merge in the host-side token-rate measurements for every running
   * session. The rate map is measured continuously by `TokenRateService`
   * (including for sessions that are not the active/selected tab); merging it
   * here keeps `selectViewState` itself pure (no service reads inside the
   * pure projection).
   */
  private buildViewState(): ViewState {
    const traceStartedAt = isLivePipelineTraceEnabled() ? performance.now() : 0;
    // Spread (do NOT mutate) so the memoized projection returned by
    // selectViewState is never corrupted: `tokenRateBySession` is host-side
    // and varies every tick independently of the cached signature, so override
    // it on a fresh top-level object while every other slice keeps its
    // (cached, structurally-shared) reference. This preserves the webview's
    // pickStable / memo barriers — unchanged slices stay referentially stable
    // across posts.
    const projected = selectViewState(this.archState);
    const viewState: ViewState = {
      ...projected,
      tokenRateBySession: this.tokenRateService.getRates(),
      aggregateStats: this.aggregateStatsService.getAggregateStats(),
    };
    if (isLivePipelineTraceEnabled()) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.projection.completed',
        kind: 'success',
        identifiers: viewState.activeSession?.path ? { session: viewState.activeSession.path } : undefined,
        durationMs: Math.max(0, performance.now() - traceStartedAt),
        transcriptCount: viewState.transcript.length,
      });
    }
    return viewState;
  }

  private scheduleRender(): void {
    // Read ArchState fields directly instead of paying for a full ViewState
    // projection on every event — these bootLog/status-bar fields are all
    // available on ArchState without the (now-memoized, but still non-trivial)
    // projection that selectViewState would run. scheduleRender fires once per
    // backend event, so this was previously 2 full projections per delta.
    const activeSessionPath = this.archState.sessions.activeSessionPath ?? null;
    bootLog('extension-host', 'render.schedule', {
      activeSessionPath,
      backendReady: this.archState.settings.backendReady,
      notice: this.archState.settings.notice,
      openTabCount: this.archState.sessions.openTabPaths.length,
      transcriptLoaded: activeSessionPath
        ? Object.prototype.hasOwnProperty.call(this.archState.transcript.windowBySession, activeSessionPath)
        : false,
    });
    this.sidebarProvider.scheduleState();
    if (this.statusBarUpdateScheduled) {
      return;
    }
    this.statusBarUpdateScheduled = true;
    queueMicrotask(() => {
      this.statusBarUpdateScheduled = false;
      this.updateStatusBar(
        this.archState.settings.notice
          ? 'Error'
          : this.archState.sessions.runningSessionPaths.length > 0
            ? 'Thinking'
            : 'Idle',
      );
    });
  }

  /** Count tool calls with status 'running' across every loaded transcript.
   *  Gives a rough system-load signal for the status bar: each running tool
   *  call (including an in-flight subagent invocation, which is itself a
   *  running tool call on the parent session) is one unit of concurrent work.
   *  Only loaded sessions are scanned, so the count is a lower bound when
   *  background sessions aren't pinned/open — acceptable for a load glance. */
  private countActiveToolCalls(): number {
    const { bySession } = this.archState.transcript;
    let count = 0;
    for (const messages of Object.values(bySession)) {
      if (!messages) continue;
      for (const message of messages) {
        // `toolCalls` is the canonical flat array kept in sync with the
        // structured `parts` by `upsertAssistantToolCall`; prefer it and only
        // fall back to `parts` for messages that never got the array populated.
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const tc of message.toolCalls) {
            if (tc.status === 'running') count++;
          }
        } else if (message.parts) {
          for (const part of message.parts) {
            if (part.kind === 'toolCall' && part.toolCall.status === 'running') count++;
          }
        }
      }
    }
    return count;
  }

  private updateStatusBar(state: 'Starting' | 'Idle' | 'Thinking' | 'Error'): void {
    const runningCount = this.archState.sessions.runningSessionPaths.length;
    const activeToolCount = this.countActiveToolCalls();
    const notice = this.archState.settings.notice;

    let text: string;
    if (state === 'Thinking') {
      const sessionPart = runningCount > 1 ? `${runningCount} Running` : 'Running';
      text = activeToolCount > 0
        ? `pie: ${sessionPart} \u00b7 ${activeToolCount} tool${activeToolCount === 1 ? '' : 's'}`
        : `pie: ${sessionPart}`;
    } else if (state === 'Error') {
      text = 'pie: Error';
    } else if (state === 'Starting') {
      text = 'pie: Starting';
    } else {
      text = 'pie: Idle';
    }

    this.statusBar.text = text;

    // Build a tooltip that surfaces the load breakdown when running, then
    // falls through to the backend notice (if any) or the default prompt.
    const tooltipLines: string[] = [];
    if (state === 'Thinking') {
      tooltipLines.push(
        `${runningCount} running session${runningCount === 1 ? '' : 's'} \u00b7 ${activeToolCount} active tool call${activeToolCount === 1 ? '' : 's'}`,
      );
    }
    tooltipLines.push(notice ?? 'Open pie chat');
    this.statusBar.tooltip = tooltipLines.join('\n');
  }

  private handleSessionCompleted(_event: SessionCompletionEvent): void {
    const suppressNotifications = this.archState.settings.prefs.suppressCompletionNotifications;
    const windowFocused = vscode.window.state.focused;

    if (!shouldShowCompletionNotification({
      suppressNotifications,
      windowFocused,
    })) {
      return;
    }

    const volume = this.archState.settings.prefs.completionSoundVolume;
    if (volume > 0) {
      // Pair the completion chime with the window-flash alert. Fire-and-
      // forget: a dropped delivery (webview hidden/not ready) is acceptable.
      // The webview warms its AudioContext on the first user click so this
      // plays from the non-gesture postMessage context.
      this.sidebarProvider.postImperative({
        type: 'playCompletionSound',
        volume,
      });
    }

    requestWindowAttention(
      vscode.env.appName,
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name,
    );
  }



  /** Thin wrapper delegating to {@link MessageRouter.handle}. */
  private async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    await this.messageRouter.handle(msg);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async () => {
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / sidebar provider after dispose.
      this.effectRunner.dispose();
      this.tokenRateService.dispose();
      this.aggregateStatsService.dispose();

      await this.statsService.shutdown();
      this.service.dispose();
      this.sidebarProvider.dispose();
      this.backend.dispose();
      await disposeLivePipelineTrace();
      this.statusBar.dispose();
    })();

    await this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
  }
}

function eventTraceMetadata(event: Event): {
  identifiers?: { session?: string; request?: string; turn?: string; attempt?: string; message?: string; tool?: string };
  eventSeq?: number;
} {
  const value = event as unknown as Record<string, unknown>;
  const cmd = value.cmd && typeof value.cmd === 'object' ? value.cmd as Record<string, unknown> : undefined;
  const source = cmd ?? value;
  const identifiers = {
    ...(typeof source.sessionPath === 'string' ? { session: source.sessionPath } : {}),
    ...(typeof source.requestId === 'string' ? { request: source.requestId } : {}),
    ...(typeof source.turnId === 'string' ? { turn: source.turnId } : {}),
    ...(typeof source.attemptId === 'string' ? { attempt: source.attemptId } : {}),
    ...(typeof source.messageId === 'string' ? { message: source.messageId } : {}),
    ...(typeof source.toolCallId === 'string' ? { tool: source.toolCallId } : {}),
  };
  return {
    identifiers: Object.keys(identifiers).length > 0 ? identifiers : undefined,
    eventSeq: typeof source.seq === 'number' && Number.isSafeInteger(source.seq) && source.seq >= 0
      ? source.seq
      : undefined,
  };
}
