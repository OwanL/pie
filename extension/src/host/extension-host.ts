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
import { BrowserServer } from './browser-server/browser-server';
import { runtimeRendererSelection, runtimeOutputDirectory } from './runtime-location';
import { compactRendererViewState } from './renderers/renderer-view-state';
import { readBrowserServerSettings } from './browser-server/settings';
import type { BrowserServerLifecycleEvent } from './browser-server/types';
import { SessionService } from './session-service';
import { TokenRateService } from './token-rate-service';
import { AggregateStatsService } from './aggregate-stats-service';
import { EMPTY_PROVIDER_GATE_STATS, type ProviderGateStats } from '../shared/protocol/aggregate-stats';
import { OPEN_TABS_STORAGE_KEY, ACTIVE_SESSION_STORAGE_KEY, PINNED_TABS_STORAGE_KEY, PINNED_TAB_GROUPS_STORAGE_KEY, PRIVATE_SESSION_PATHS_STORAGE_KEY } from './session-service/state';
import { DisabledStatsService, StatsService, type StatsServicePort } from './stats-service';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../analytics/query-entry.js';
import { resolvePieDataPaths } from '../../../shared/pie-data-root.js';
import { toErrorMessage } from './util/error-message';
import { PIE_BUILD_ID, type WebviewToHostMessage, type ViewState } from '../shared/protocol';
import { EffectRunner } from './core/effect-runner';
import { dispatch } from './core/dispatch';
import { initialArchState, type ArchState } from './core/reducer';
import type { Event } from './core/events';
import type { SessionOperationSource } from './core/operation-types.js';
import { operationAndIncidentTraceEvents } from './core/operation-incident-tracing.js';
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
import { CanonicalAnalyticsCapture } from '../analytics/canonical-capture.js';
import { ActivationStore } from '../analytics/activation-store.js';
import {
  AnalyticsRuntime,
  DisabledAnalyticsRuntime,
  type AnalyticsRuntimePort,
} from './analytics-runtime.js';
import { HostAnalyticsTransport } from './analytics-transport.js';
import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../shared/analytics/contracts.js';
import { AnalyticsHandoffControl } from './analytics-handoff-control.js';
import {
  discoverAnalyticsHostWriters,
  type RuntimeGenerationIdentity,
} from './analytics-handoff-discovery.js';
import { createPerBootAnalyticsHandoffKey } from '../../../shared/analytics/handoff.js';
import { SessionLifecycleStore } from '../backend/session-lifecycle-store.js';
import { isFreshLegacyActivationState, resolveAnalyticsPolicy } from './analytics-policy.js';


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

function getPieRuntimeIdentity(context: vscode.ExtensionContext): RuntimeGenerationIdentity | undefined {
  const packageJson = context.extension?.packageJSON as Record<string, unknown> | undefined;
  if (!packageJson) return undefined;
  const publisher = packageJson.publisher;
  const name = packageJson.name;
  const version = packageJson.version;
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string'
    || publisher.length === 0 || name.length === 0 || version.length === 0) {
    return undefined;
  }
  return { publisher, name, version };
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
  private readonly statsService: StatsServicePort;
  private readonly service: SessionService;
  private shutdownPromise: Promise<void> | null = null;
  /** Coalesce command-palette, notice-action, and browser requests that can
   * arrive before the first restart projection disables renderer controls. */
  private restartPromise: Promise<void> | null = null;
  private restartOperationId: string | null = null;
  private restartResolve: (() => void) | null = null;
  private restartReject: ((error: Error) => void) | null = null;
  private statusBarUpdateScheduled = false;

  private readonly messageRouter: MessageRouter;

  // CQRS architecture spine
  private archState: ArchState = initialArchState;
  private readonly effectRunner: EffectRunner;
  private readonly fileDiffService: FileDiffService;
  /** M2: loopback browser server (browser server plan §6/§7). Owned here;
   *  started in `start()` after the host can build a valid initial
   *  `ViewState`, stopped in `shutdown()` before the service/backend order. */
  private readonly browserServer: BrowserServer;
  /** Owns the canonical recorder/query helpers once an activation is recorded.
   * Dormant under legacy authority: start() spawns nothing. */
  private readonly analyticsRuntime: AnalyticsRuntimePort;
  /** Owns worker/subagent/MCP capture ingress under canonical authority. */
  private readonly analyticsTransport?: HostAnalyticsTransport;
  /** Registers this host for future authenticated all-host handoff discovery.
   * The control endpoint reports incomplete inventory until runtime leases and
   * backend process evidence are reconciled by a separate producer. */
  private readonly analyticsHandoffRegistry?: SessionLifecycleStore;
  private readonly analyticsHandoffControl?: AnalyticsHandoffControl;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendClient,
  ) {
    const dataOutcomesRootPath = getDataOutcomesRootPath(
      process.env.PI_CODING_AGENT_DIR,
      context.globalStorageUri.fsPath,
    );

    // Normal boots construct the producer seams below and read authority from
    // the validated activation manifest rather than hardcoding it. The
    // process-local total-disabled rehearsal takes the separate branch below
    // before any analytics storage/helper/control object is constructed.
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
    const analyticsPolicy = resolveAnalyticsPolicy();
    const analyticsDisabled = analyticsPolicy === 'total-disabled';
    const analyticsWorkspaceId = analyticsDisabled ? 'analytics-disabled' : getWorkspaceAnalyticsId(context);
    const analyticsProcessGeneration = crypto.randomUUID();
    let analyticsRuntime: AnalyticsRuntimePort;
    let analyticsTransport: HostAnalyticsTransport | undefined;
    let analyticsHandoffRegistry: SessionLifecycleStore | undefined;
    let analyticsHandoffControl: AnalyticsHandoffControl | undefined;
    let statsService: StatsServicePort;

    if (analyticsDisabled) {
      // The rehearsal is valid only from a fresh legacy state. In particular,
      // do not suppress an active/candidate authority and call that disabled.
      const activation = new ActivationStore({ stateDir: dataPaths.stateDir }).read();
      if (!isFreshLegacyActivationState(activation)) {
        throw new Error('Total analytics-disabled rehearsal requires a fresh legacy activation state.');
      }
      analyticsRuntime = new DisabledAnalyticsRuntime();
      statsService = new DisabledStatsService();
    } else {
      analyticsHandoffRegistry = new SessionLifecycleStore(
        path.join(dataPaths.stateDir, 'session-lifecycle.sqlite'),
      );
      const activation = new ActivationStore({ stateDir: dataPaths.stateDir }).read();
      const runtimeIdentity = getPieRuntimeIdentity(context);
      // The environment override is an explicit launch-channel capability. A
      // normal host boot creates a fresh in-memory key so an old boot's signed
      // requests cannot be replayed; the key is never persisted or returned by
      // the status endpoint. Until a trusted controller receives that key from
      // the launch channel, this endpoint is host-local evidence only and does
      // not constitute an all-host handoff capability.
      const analyticsHandoffKey = process.env.PIE_ANALYTICS_HANDOFF_KEY?.trim()
        || createPerBootAnalyticsHandoffKey();
      const activeAnalyticsGenerationId = activation.authority === 'canonical'
        ? activation.manifest?.activeGeneration?.identity.generationId
        : undefined;
      analyticsHandoffControl = new AnalyticsHandoffControl({
        registry: analyticsHandoffRegistry,
        identity: {
          hostInstanceId: analyticsProcessGeneration,
          workspaceId: analyticsWorkspaceId,
          generationId: analyticsProcessGeneration,
          buildId: PIE_BUILD_ID,
          processId: process.pid,
          capabilities: ['host-discovery', 'host-status'],
        },
        key: analyticsHandoffKey,
        readInventory: async () => {
          if (!runtimeIdentity) {
            return {
              kind: 'registered-hosts-only',
              complete: false,
              reason: 'runtime-generation-and-process-reconciliation-incomplete',
              observedAtMs: Date.now(),
              registeredHostCount: 0,
              reconciledHostCount: 0,
              reasonCodes: ['runtime-identity-unavailable'],
            };
          }
          const discovery = await discoverAnalyticsHostWriters({
            workspaceId: analyticsWorkspaceId,
            registry: analyticsHandoffRegistry!,
            runtimeRootPath: path.join(context.extensionPath, 'pie-runtime'),
            runtimeIdentity,
            ...(activeAnalyticsGenerationId ? { analyticsGenerationId: activeAnalyticsGenerationId } : {}),
          });
          return {
            kind: 'registered-hosts-only',
            complete: false,
            reason: discovery.complete
              ? 'runtime-generation-and-process-reconciliation-unwired'
              : 'runtime-generation-and-process-reconciliation-incomplete',
            observedAtMs: discovery.observedAtMs,
            registeredHostCount: discovery.hosts.length,
            reconciledHostCount: discovery.hosts.filter(({ status }) => status === 'reconciled').length,
            reasonCodes: [...new Set(discovery.reasons.map(({ code }) => code))].slice(0, 32),
          };
        },
        onError: (error, stage) => appendPieLog('warn', 'analytics-handoff', stage, { error: error.message }),
      });
      const canonicalActive = activation.authority === 'canonical'
        && activation.manifest?.activeGeneration !== undefined
        && activation.manifest?.activeGeneration !== null
        && activation.sha256 !== null;
      // This is the sole descriptor snapshot shared by host capture, helper
      // startup, backend construction, and loaded-generation evidence. The
      // runtime rechecks the on-disk snapshot before readiness and refuses a
      // transition observed during startup.
      const activationDescriptor = canonicalActive
        ? Object.freeze({
            generationId: activation.manifest!.activeGeneration!.identity.generationId,
            buildId: activation.manifest!.activeGeneration!.identity.buildId,
            manifestRevision: activation.manifest!.revision,
            manifestSha256: activation.sha256!,
            workspaceId: analyticsWorkspaceId,
            hostInstanceId: analyticsProcessGeneration,
          })
        : undefined;
      // Under canonical authority the capture requires a generation id and fact,
      // detail and lifecycle sinks, and throws without them. Those sinks come from
      // the canonical helpers, which only exist once AnalyticsRuntime.start() has
      // succeeded, so the runtime is created here and started in start() below.
      const analyticsRuntimeImpl = new AnalyticsRuntime({
        stateDir: dataPaths.stateDir,
        analyticsDir: dataPaths.analyticsDir,
        recorderWorkerScript: path.join(runtimeOutputDirectory(context), 'analytics-recorder-worker.js'),
        queryWorkerScript: path.join(runtimeOutputDirectory(context), 'analytics-query-worker.js'),
        buildId: PIE_BUILD_ID,
        workspaceId: analyticsWorkspaceId,
        processGeneration: analyticsProcessGeneration,
        activationSnapshot: activation,
        restartNonce: process.env.PIE_ANALYTICS_RESTART_NONCE?.trim() || null,
        onError: (error, stage) => {
          appendPieLog('error', 'analytics', `canonical analytics ${stage} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      analyticsRuntime = analyticsRuntimeImpl;
      // Under canonical authority the capture requires fact, detail and lifecycle
      // sinks, and throws without them. Those sinks are the canonical recorder,
      // which only exists after AnalyticsRuntime.start() succeeds. This holder is
      // therefore the sink now: it forwards once the runtime has attached the real
      // recorder and throws before that, so a record can never be silently dropped
      // if a producer runs before the helpers are ready.
      const runtimeSinks = {
        preflightDetail: (value: unknown) => {
          const sink = analyticsRuntimeImpl.sink;
          if (!sink) throw new Error('Canonical detail sink is not ready; activation has not completed.');
          sink.preflightDetail(value);
        },
        submit: (observation: AnalyticsObservation<object>) => {
          const sink = analyticsRuntimeImpl.sink;
          if (!sink) throw new Error('Canonical capture sink is not ready; activation has not completed.');
          return sink.submit(observation);
        },
        submitDetail: (capture: AnalyticsDetailCapture) => {
          const sink = analyticsRuntimeImpl.sink;
          if (!sink) throw new Error('Canonical detail sink is not ready; activation has not completed.');
          return sink.submitDetail(capture);
        },
        bindPendingCreate: (
          pendingOperationId: string,
          rootSessionId: string,
          sourceKey: string,
          timestampMs: number | string | bigint,
        ) => {
          const sink = analyticsRuntimeImpl.sink;
          if (!sink) throw new Error('Canonical lifecycle sink is not ready; activation has not completed.');
          return sink.bindPendingCreate(pendingOperationId, rootSessionId, sourceKey, timestampMs);
        },
        deleteSession: (
          rootSessionId: string,
          sourceKey: string,
          timestampMs: number | string | bigint,
          pendingOperationId?: string,
        ) => {
          const sink = analyticsRuntimeImpl.sink;
          if (!sink) throw new Error('Canonical lifecycle sink is not ready; activation has not completed.');
          return sink.deleteSession(rootSessionId, sourceKey, timestampMs, pendingOperationId);
        },
      };
      analyticsTransport = canonicalActive
        ? new HostAnalyticsTransport({
            generationId: activationDescriptor!.generationId,
            buildId: activationDescriptor!.buildId,
            workspaceId: activationDescriptor!.workspaceId,
            backend,
            recorder: {
              submitTracked: (observation, onDisposition) => {
                const sink = analyticsRuntimeImpl.sink;
                if (!sink) throw new Error('Canonical capture sink is not ready; activation has not completed.');
                sink.submitTracked(observation, onDisposition);
              },
              submitTrackedDetail: (capture, onDisposition) => {
                const sink = analyticsRuntimeImpl.sink;
                if (!sink) throw new Error('Canonical detail sink is not ready; activation has not completed.');
                sink.submitTrackedDetail(capture, onDisposition);
              },
            },
            onError: (error) => appendPieLog('warn', 'analytics', 'worker analytics ingress rejected', {
              error: error.message,
            }),
          })
        : undefined;
      const analyticsCapture = new CanonicalAnalyticsCapture({
        authority: canonicalActive ? 'canonical' : 'legacy',
        ...(canonicalActive
          ? { generationId: activationDescriptor!.generationId }
          : {}),
        workspaceId: analyticsWorkspaceId,
        buildId: PIE_BUILD_ID,
        processGeneration: analyticsProcessGeneration,
        ...(canonicalActive
          ? { sink: runtimeSinks, detailSink: runtimeSinks, lifecycleSink: runtimeSinks }
          : {}),
      });

      // P5 durable read model: path-only resolution until a consumer queries it
      // (one disposable helper fork per query). The canonical data root shares
      // the backend's explicit-failure resolution; queries against an absent
      // database fail explicitly instead of falling back to legacy stores.
      // Construction is unconditional; StatsService withholds the model unless
      // canonical authority is active, so no consumer can read it early.
      const analyticsReadModel = new CanonicalAnalyticsReadModel({
        databasePath: canonicalAnalyticsDatabasePath(dataPaths.analyticsDir),
        workerScript: path.join(runtimeOutputDirectory(context), 'analytics-query-worker.js'),
        beforeProviderAggregateRead: (request) => analyticsRuntimeImpl.prepareProviderDailyProjection(request),
      });

      statsService = new StatsService({
        dataOutcomesRootPath,
        legacyUsageDataRootPath: context.globalStorageUri.fsPath,
        workspaceId: getWorkspaceAnalyticsId(context),
        legacyWorkspaceIds: getLegacyWorkspaceAnalyticsIds(),
        scheduleRender: () => this.scheduleRender(),
        getExperimentAssignment: () => this.getExperimentAssignment(),
        getArchState: () => this.archState,
        dispatchArchEvent: (event) => this.dispatchArchEvent(event),
        getAgentDir: () => process.env.PI_CODING_AGENT_DIR?.trim() || null,
        analyticsCapture,
        analyticsReadModel,
      });
    }

    this.analyticsRuntime = analyticsRuntime;
    this.analyticsTransport = analyticsTransport;
    this.analyticsHandoffRegistry = analyticsHandoffRegistry;
    this.analyticsHandoffControl = analyticsHandoffControl;
    this.statsService = statsService;

    this.service = new SessionService(
      context,
      backend,
      () => this.scheduleRender(),
      (message) => {
        if (message.type.startsWith('detail.') && 'rendererId' in message) {
          this.sidebarProvider.postImperativeToRenderer(message.rendererId, message);
          return;
        }
        this.sidebarProvider.postImperative(message);
      },
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
      {
        getHostInstanceId: () => this.sidebarProvider.getHostInstanceId(),
        getViewGeneration: () => this.sidebarProvider.getViewGeneration(),
        isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
          this.sidebarProvider.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration)
          || this.browserServer.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration),
      },
      () => this.analyticsRuntime.backendDescriptor(),
    );

    this.tokenRateService = new TokenRateService({
      getArchState: () => this.archState,
      onActiveRateChanged: () => this.sidebarProvider.scheduleState(),
      onRatesTick: analyticsDisabled ? undefined : () => this.aggregateStatsService.refreshLive(),
    });

    this.aggregateStatsService = new AggregateStatsService({
      getArchState: () => this.archState,
      statsService: this.statsService,
      enabled: !analyticsDisabled,
      tokenRateService: this.tokenRateService,
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR?.trim() || null,
      fetchProviderGateStats: () => this.backend
        .request<ProviderGateStats>('provider_gate.metrics', undefined, { timeoutMs: 2000 })
        .catch(() => EMPTY_PROVIDER_GATE_STATS),
      onChanged: () => this.sidebarProvider.scheduleState(),
      analyticsTimeZone: analyticsRuntime.analyticsTimeZone,
    });

    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => this.buildViewState(),
      (message) => {
        void this.handleWebviewMessage(message);
      },
      () => this.archState.sessions.runningSessionPaths.length,
      {
        // Renderer-scoped handshake snapshots for browser sockets: the
        // router answers a browser `ready`/`refreshState` in THAT renderer.
        onForeignRequestState: (rendererId) => this.browserServer.requestState(rendererId),
        // Renderer-scoped imperatives (browser server plan §4.4): lazy-detail
        // responses answer the INITIATING browser renderer.
        onForeignPostImperative: (rendererId, message) => this.browserServer.postImperative(message, rendererId),
        onRendererInvalidated: (rendererId, rendererGeneration) =>
          this.service.unsubscribeRendererDetails(rendererId, rendererGeneration),
      },
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

    this.browserServer = new BrowserServer({
      hostInstanceId: this.sidebarProvider.getHostInstanceId(),
      getSettings: () => readBrowserServerSettings(),
      getViewState: () => this.buildViewState(),
      getRunningSessionCount: () => this.archState.sessions.runningSessionPaths.length,
      routeMessage: (msg, context) => this.messageRouter.handle(msg, context),
      onRendererInvalidated: (rendererId, rendererGeneration) =>
        this.service.unsubscribeRendererDetails(rendererId, rendererGeneration),
      assetDir: path.join(context.extensionPath, 'out', 'webview', 'panel'),
      rendererSelection: runtimeRendererSelection(context),
      iconPath: path.join(context.extensionPath, 'media', 'icon.svg'),
      titleSuffix: vscode.workspace.name ?? undefined,
      onLifecycle: (event) => this.handleBrowserServerLifecycle(event),
    });

    this.effectRunner = new EffectRunner({
      backend: this.backend,
      // Prepass-aware send-timer budget: when the user sets
      // an explicit `prepassTimeoutSec`, budget for it + bounded wait headroom
      // so a long-but-legitimate prepass never trips a spurious watchdog fire
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
        // headroom and trip a spurious watchdog fire mid-queue).
        const QUEUE_WAIT_HEADROOM_MS = this.resolveQueueWaitHeadroomMs(sessionPath);
        return typeof p === 'number' && Number.isFinite(p) && p > 0
          ? (p + HEADROOM_SEC) * 1000 + QUEUE_WAIT_HEADROOM_MS
          : 120_000 + QUEUE_WAIT_HEADROOM_MS;
      },
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
          const activePrivateSessionPaths = Object.entries(this.archState.sessions.privacyModeBySession)
            .filter(([, enabled]) => enabled)
            .map(([sessionPath]) => sessionPath);
          // An omitted privateSessionPaths argument is an ordinary tab
          // checkpoint, not an instruction to discard stale markers that a
          // background startup cleanup has not successfully removed yet.
          // Explicit privacy/close commands still pass an authoritative list.
          const storedPrivateSessionPaths = context.globalState.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY)
            ?.filter((sessionPath): sessionPath is string => typeof sessionPath === 'string' && sessionPath.length > 0)
            ?? [];
          const persistedPrivateSessionPaths = (privateSessionPaths ?? [
            ...new Set([...storedPrivateSessionPaths, ...activePrivateSessionPaths]),
          ]).filter((sessionPath) => !isPendingTabPath(sessionPath));
          try {
            await Promise.all([
              context.globalState.update(OPEN_TABS_STORAGE_KEY, tabObjects),
              context.globalState.update(ACTIVE_SESSION_STORAGE_KEY, persistedActiveSessionPath),
              context.globalState.update(PINNED_TABS_STORAGE_KEY, persistedPinnedTabPaths),
              context.globalState.update(PINNED_TAB_GROUPS_STORAGE_KEY, persistedPinnedTabGroups),
              context.globalState.update(PRIVATE_SESSION_PATHS_STORAGE_KEY, persistedPrivateSessionPaths),
            ]);
          } catch (err) {
            appendPieLog('warn', 'globalState', 'tab persistence failed', {
              error: toErrorMessage(err),
            });
            throw err;
          }

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
      // M2 source-aware confirmation seam (§9): a BROWSER source confirms
      // inline in ITS OWN renderer through the browser server; the VS Code
      // modal is never shown for a browser source, and disconnect cancels.
      // The sidebar (VS Code) source path is unchanged (native modal).
      inlineConfirm: (request) =>
        this.browserServer.requestInlineConfirm(request.rendererId, {
          kind: request.kind,
          ...(request.sessionPath !== undefined ? { sessionPath: request.sessionPath } : {}),
          message: request.message,
          confirmChoice: request.confirmChoice,
        }),
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
   *  summaries that predate provider persistence. Used by the FP-C3
   *  queue-wait headroom resolver. */
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
   *  send's provider, read from the live coordinator authority metric. The
   *  authority normalizes a configured zero to its 300s safety maximum. Falls
   *  back to a conservative 30s only when policy state is unavailable. */
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
    await this.analyticsHandoffControl?.start();
    this.hydratePrivacyMarkers();
    this.tokenRateService.start();
    this.aggregateStatsService.start();
    // Start canonical helpers before any capture can be produced. Under legacy
    // authority this spawns nothing and returns the legacy readiness snapshot;
    // under an active manifest it spawns the recorder and proves the read path
    // with a disposable query. A failure here throws before the services start,
    // so the host fails closed rather than capturing into an authority it cannot
    // read back.
    await this.analyticsRuntime.start();
    // Record that this process actually reached canonical readiness, so
    // post-restart evidence can distinguish "the manifest records a generation"
    // from "a host loaded and passed readiness for it".
    this.analyticsRuntime.recordLoadedGeneration();
    await this.statsService.start();
    await this.service.start();
    // M2 (§7.2): start the browser server only after the host can build a
    // valid initial `ViewState`. Backend readiness is a field in that state;
    // the HTTP shell does not wait for provider/backend startup.
    await this.browserServer.start();
  }

  async restart(source: SessionOperationSource = { kind: 'host' }): Promise<void> {
    if (!this.restartPromise) {
      const operationId = crypto.randomUUID();
      this.restartOperationId = operationId;
      const operation = new Promise<void>((resolve, reject) => {
        this.restartResolve = resolve;
        this.restartReject = reject;
      });
      const tracked = operation.finally(() => {
        if (this.restartPromise === tracked) this.restartPromise = null;
        this.restartOperationId = null;
        this.restartResolve = null;
        this.restartReject = null;
      });
      this.restartPromise = tracked;
      this.updateStatusBar('Starting');
      this.dispatchArchEvent({
        kind: 'Command',
        cmd: {
          kind: 'RestartBackend',
          corrId: `restart:${operationId}`,
          operationId,
          operationSource: source,
          backendGeneration: this.service.getBackendGeneration(),
        },
      });
    }
    await this.restartPromise;
  }

  /**
   * Dispatch an event through the arch reducer and execute resulting effects.
   * This is the single point where the CQRS spine integrates with the extension.
   */
  private dispatchArchEvent(event: Event): void {
    const traceEnabled = isLivePipelineTraceEnabled();
    const traceStartedAt = traceEnabled ? performance.now() : 0;
    const stateBefore = this.archState;
    // Pre-reducer side effects for specific event types.
    if ((event.kind === 'SendResult' || event.kind === 'ContinueResult')
        && event.ok && event.requestId) {
      this.service.bindRequestSessionPath(event.requestId, event.sessionPath);
    }
    if (event.kind === 'SendResult') {
      this.service.notifyDeferredTriggerSendResult(event.corrId, event.ok, event.error);
    }
    if (event.kind === 'BackendReadyWatchdogFired') {
      // These queued sends never crossed the backend boundary and are about to
      // be dropped by the reducer, so any deferred-trigger claims are
      // definitively retryable rather than ambiguously retained.
      for (const entry of Object.values(this.archState.pending.backendReadyQueueBySession).flat()) {
        this.service.notifyDeferredTriggerSendResult(
          entry.corrId,
          false,
          'backend readiness timed out; delivery remains retryable',
        );
      }
    }
    const result = dispatch(this.archState, event);
    this.archState = result.state;
    if (traceEnabled) {
      const trace = eventTraceMetadata(event);
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.reducer.applied',
        kind: 'success',
        identifiers: trace.identifiers,
        eventSeq: trace.eventSeq,
        durationMs: Math.max(0, performance.now() - traceStartedAt),
      });
      for (const semanticTrace of operationAndIncidentTraceEvents(stateBefore, this.archState, event)) {
        recordLivePipelineTrace(semanticTrace);
      }
    }
    for (const effect of result.effects) {
      this.effectRunner.run(effect);
    }
    if (event.kind === 'BackendRestartResult' && event.operationId === this.restartOperationId) {
      if (event.ok) {
        this.restartResolve?.();
      } else {
        this.restartReject?.(new Error(event.error ?? 'Backend restart failed'));
      }
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
      vscode.commands.registerCommand('pie.openInBrowser', () => this.openBrowserUrl()),
      vscode.commands.registerCommand('pie.copyBrowserUrl', () => this.copyBrowserUrl()),
      vscode.commands.registerCommand('pie.restartBrowserServer', () => this.restartBrowserServer()),
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
      vscode.commands.registerCommand('pie.restartBackend', async (source?: SessionOperationSource) => {
        await this.restart(source);
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
    const cachedAggregateStats = this.aggregateStatsService.getAggregateStats();
    const runningSessionCount = new Set(this.archState.sessions.runningSessionPaths).size;
    const openTabCount = this.archState.sessions.openTabPaths.length;
    const aggregateStats = cachedAggregateStats.runningSessionCount === runningSessionCount
      && cachedAggregateStats.openTabCount === openTabCount
      ? cachedAggregateStats
      : { ...cachedAggregateStats, runningSessionCount, openTabCount };
    const viewState: ViewState = {
      ...projected,
      // Transcript-derived usage is migration-only. The live and recovered UI
      // always receives the host-owned immutable invocation-ledger projection.
      sessionUsage: projected.activeSession
        ? this.statsService.getSessionUsage(projected.activeSession.path)
        : null,
      tokenRateBySession: this.tokenRateService.getRates(),
      workingTimeBySession: this.statsService.getWorkingTimeBySession(),
      aggregateStats,
      // Active deferred triggers are owned by the `DeferredTriggerRegistry`
      // (host-side, not in ArchState) — merged here like `aggregateStats` /
      // `tokenRateBySession` so the pure projection stays service-free.
      deferredTriggers: this.service.getDeferredTriggers(),
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
    return compactRendererViewState(viewState);
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
    this.browserServer.scheduleState();
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

  // ─── Browser server commands (§12.3) ────────────────────────────────────

  /** `pie: Open in Browser` — open the ACTUAL URL of this host's server. */
  private async openBrowserUrl(): Promise<void> {
    const state = this.browserServer.getState();
    if (!state.running || state.url === null) {
      void vscode.window.showWarningMessage('The pie browser server is not running. Enable `pie.browserServer.enabled` and restart the extension window.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(state.url));
  }

  /** `pie: Copy Browser URL` — copy the ACTUAL served URL. */
  private async copyBrowserUrl(): Promise<void> {
    const state = this.browserServer.getState();
    if (!state.running || state.url === null) {
      void vscode.window.showWarningMessage('The pie browser server is not running. Enable `pie.browserServer.enabled` and restart the extension window.');
      return;
    }
    await vscode.env.clipboard.writeText(state.url);
    void vscode.window.showInformationMessage(`pie browser URL copied: ${state.url}`);
  }

  /** `pie: Restart Browser Server` — stop + re-read settings + rebind. */
  private async restartBrowserServer(): Promise<void> {
    const before = this.browserServer.getState();
    await this.browserServer.stop();
    const outcome = await this.browserServer.start();
    if (outcome.kind === 'started') {
      void vscode.window.showInformationMessage(
        `pie browser server restarted${before.url === outcome.url ? '' : ` — ${outcome.url}`}`,
      );
      return;
    }
    if (outcome.kind === 'disabled') {
      void vscode.window.showWarningMessage('pie browser server is disabled (`pie.browserServer.enabled`).');
      return;
    }
    void vscode.window.showErrorMessage(`pie browser server failed to start: ${outcome.reason}`);
  }

  /** Lifecycle sink (§6.2): successful fallback binds are info-log-only;
   *  only a terminal bind/start failure produces a user notice. */
  private handleBrowserServerLifecycle(event: BrowserServerLifecycleEvent): void {
    switch (event.kind) {
      case 'started':
        appendPieLog('info', 'browser-server', 'started', { url: event.url, preferred: event.preferred });
        break;
      case 'fallback':
        // Informational: the preferred port was busy; the ACTUAL url is
        // recorded and reported by the commands. No user notice.
        appendPieLog('info', 'browser-server', 'fallback-port', { url: event.url });
        break;
      case 'bind-failed':
        appendPieLog('error', 'browser-server', 'bind-failed', {
          port: event.port,
          requirePreferredPort: event.requirePreferredPort,
          error: event.error,
        });
        void vscode.window.showErrorMessage(`pie browser server failed to start on port ${event.port}: ${event.error}`);
        break;
      case 'restarted':
        appendPieLog('info', 'browser-server', 'restarted', { url: event.url });
        break;
      case 'stopped':
        appendPieLog('info', 'browser-server', 'stopped', { reason: event.reason });
        break;
      case 'client-connected':
        appendPieLog('info', 'browser-server', 'client-connected', { rendererId: event.rendererId });
        break;
      case 'client-closed':
        appendPieLog('info', 'browser-server', 'client-closed', {
          rendererId: event.rendererId,
          code: event.code,
          reason: event.reason,
        });
        break;
    }
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
      // Stop accepting authenticated handoff requests before host producers
      // drain. The registry retains this identity as stopping evidence: the
      // endpoint closing is not proof that backend/recorder writers drained,
      // and is never interpreted as proof that every writer was discovered.
      await this.analyticsHandoffControl?.stop();
      // M2 (§7.4): stop the browser server FIRST — stop accepting
      // HTTP/upgrades, close tracked WebSocket clients, close/await the HTTP
      // server, dispose browser renderer sessions/hub — then continue the
      // existing service/backend shutdown order. Closing the port releases it
      // for the next VS Code window immediately.
      this.browserServer.dispose();
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / sidebar provider after dispose.
      this.effectRunner.dispose();
      this.tokenRateService.dispose();
      this.aggregateStatsService.dispose();

      // Stop host-side producers first. The transport then fences new backend
      // ingress and gives partial detail assemblies a bounded terminal
      // rejection while the backend channel is still available.
      await this.statsService.shutdown();
      await this.analyticsTransport?.shutdown();
      // Closing stdin fences the coordinator and all worker producers. Keep the
      // recorder alive until the backend has confirmed exit so accepted queue
      // work still drains without allowing late backend traffic into a torn
      // down transport. Release the backend client's event/lease ownership
      // immediately after its process confirms exit; host-local analytics
      // teardown below does not use this client because ingress is fenced and
      // acknowledgments were settled above.
      await this.backend.stop();
      this.backend.dispose();
      await this.analyticsRuntime.stop();
      this.analyticsTransport?.dispose();
      this.analyticsHandoffRegistry?.close();
      this.service.dispose();
      this.sidebarProvider.dispose();
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
