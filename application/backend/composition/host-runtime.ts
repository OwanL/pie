import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { FileDiffService } from '../file-changes/file-diff-service.js';
import { MessageRouter } from '../conversation-state/message-router.js';
import { DictationService } from '../dictation/service.js';

import { getDataOutcomesRootPath } from '../../../analytics/legacy/run-analytics/storage.js';
import type { BackendClient } from '../agent-connection/client.js';
import type {
  BrowserServerLifecycleEvent,
  BrowserServerService,
} from '../../lib/platform-contracts/browser-server-seam.js';
import {
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from './completion-attention.js';
import { compactRendererViewState } from '../../lib/renderer-delivery/renderer-view-state.js';
import type { BrowserServerViewState } from '../../lib/protocol/webview.js';
import { SessionService } from '../session-actions/service.js';
import type { HostRuntimePlatform, HostRuntimeHooks } from '../../lib/platform-contracts/platform.js';
import { TokenRateService } from '../analytics-views/token-rate-service.js';
import { AggregateStatsService } from '../analytics-views/aggregate-stats-service.js';
import { EMPTY_PROVIDER_GATE_STATS, type ProviderGateStats } from '../../../analytics/contracts/aggregate-stats.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
} from '../../../analytics/authority/storage-cutoff-authorization.js';
import {
  OPEN_TABS_STORAGE_KEY,
  ACTIVE_SESSION_STORAGE_KEY,
  PINNED_TABS_STORAGE_KEY,
  PINNED_TAB_GROUPS_STORAGE_KEY,
  PRIVATE_SESSION_PATHS_STORAGE_KEY,
} from '../session-actions/state.js';
import { StatsService, type StatsServicePort } from '../analytics-views/index.js';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../../analytics/queries/query-entry.js';
import { resolvePieDataPaths } from '../../../lib/data-root/pie-data-root.js';
import { toErrorMessage } from '../../../lib/structured-logging/error-message.js';
import { PIE_BUILD_ID } from '../../../lib/build-identity.js';
import {
  type HostToWebviewMessage,
  type RendererCommandContext,
  type WebviewToHostMessage,
  type ViewState,
} from '../../lib/protocol/index.js';
import { EffectRunner } from '../conversation-state/effects/effect-runner.js';
import { dispatch } from '../conversation-state/dispatch.js';
import { initialArchState, type ArchState } from '../conversation-state/reducer.js';
import type { Event } from '../conversation-state/events.js';
import type { SessionOperationSource } from '../conversation-state/operation-types.js';
import { operationAndIncidentTraceEvents } from '../conversation-state/operation-incident-tracing.js';
import { projectCanonicalActivityViews, selectViewState } from '../conversation-state/projections/projection.js';
import { auditLog, bootLog } from '../../../lib/structured-logging/pie-logger.js';
import {
  disposeLivePipelineTrace,
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
} from '../../lib/live-pipeline-trace-runtime.js';
import { deriveSessionNameFromText } from '../../../harness/session-storage/metadata/session-name.js';
import { isPendingTabPath } from '../../../lib/session-path.js';
import { appendPieLog } from '../../../lib/structured-logging/pie-logger.js';
import { HostLiveMembershipSync } from '../agent-connection/live-session-membership.js';
import { CanonicalAnalyticsCapture } from '../../../analytics/capture/canonical-capture.js';
import { resolveCanonicalCaptureNamespace } from '../../../analytics/recording/capture-namespace.js';
import {
  AnalyticsRuntime,
  type AnalyticsRuntimePort,
} from './analytics-runtime.js';
import { HostAnalyticsTransport } from '../../../analytics/capture/analytics-transport.js';
import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../analytics/contracts/contracts.js';
import { AnalyticsHandoffControl } from '../../../analytics/authority/analytics-handoff-control.js';
import { createAnalyticsHostWriterFence } from '../../../analytics/authority/analytics-all-host-handoff.js';
import { createAnalyticsHostControlledRestart } from './controlled-restart-driver.js';
import {
  discoverAnalyticsHostWriters,
  type RuntimeGenerationIdentity,
} from '../../../analytics/authority/analytics-handoff-discovery.js';
import { readProcessCensus } from '../../../analytics/authority/process-census.js';
import { recoverStaleAnalyticsHosts } from '../../../analytics/authority/analytics-host-recovery.js';
import { createPerBootAnalyticsHandoffKey } from '../../../analytics/contracts/host-status-messages.js';
import { createSessionLifecycleWriterAdmission } from '../../../analytics/authority/session-lifecycle-writer-store.js';
import {
  SessionLifecycleStore,
  storageCutoffRootCapability,
} from '../../../harness/session-storage/lifecycle/session-lifecycle-store.js';

/** Keep the renderer surface aligned with the StatsService eager displayed
 * session bound; omitted session paths remain lazy/unknown rather than making
 * a full session catalogue part of every ViewState snapshot. */
const MAX_CANONICAL_ACTIVITY_VIEW_SESSIONS = 32;

// Local call/await boundaries only: these can overlap activation and other
// startup timings and must not be summed as exclusive attribution.
function finishPreBackendTiming(stage: string, started: number, outcome: 'success' | 'failure'): void {
  try {
    appendPieLog('info', 'startup', 'DEBUG-startup-preflight', {
      stage, durationMs: performance.now() - started, outcome,
    });
  } catch { /* Diagnostics must never replace a startup error. */ }
}

/**
 * Platform-neutral application composition and lifecycle for the pie host.
 *
 * Owns the CQRS spine (arch state, reducer dispatch, the single effect
 * runner), the session service, browser-server lifecycle, the analytics
 * authority seams (runtime, transport, handoff), and backend start/restart/shutdown
 * lifecycle — with the exact ordering, source identity, and analytics
 * activation/handoff behavior of the previous VS Code composition. Host
 * environment differences (window notifications, editor opens, workspace
 * identity, renderer surface) are injected through the narrow
 * {@link HostRuntimePlatform} adapters; nothing here may import `vscode`.
 *
 * The VS Code extension class (`extension-host.ts`) stays the adapter that
 * owns the status bar, registered commands, and the sidebar provider, and
 * delegates composition/lifecycle to this runtime. There is exactly one host
 * implementation: this class.
 */
export class HostRuntime {
  /** Embedded PI backend process lifecycle. Owned by the composition root
   *  (VS Code supplies the editor-version option; a Node adapter omits it). */
  readonly backend: BackendClient;
  /** Session command queue + backend event wiring. */
  readonly service: SessionService;
  /** Loopback browser server. Started in
   *  `start()` after the host can build a valid initial `ViewState`, stopped
   *  in `shutdown()` before the service/backend order. The field is the
   *  host-neutral {@link BrowserServerService} seam; only the concrete host
   *  adapters name and construct the `BrowserServer` implementation. */
  readonly browserServer: BrowserServerService;
  /** Canonical/legacy analytics accounting authority seam. */
  readonly statsService: StatsServicePort;
  /** Ordered host→coordinator live-membership projection bridge. */
  readonly liveMembershipSync: HostLiveMembershipSync;

  private startupPromise: Promise<void> | null = null;
  private shutdownRequested = false;
  private dictationPrewarmRequested = false;
  private shutdownPromise: Promise<void> | null = null;
  /** Coalesce command-palette, notice-action, and browser requests that can
   * arrive before the first restart projection disables renderer controls. */
  private restartPromise: Promise<void> | null = null;
  private restartOperationId: string | null = null;
  private restartResolve: (() => void) | null = null;
  private restartReject: ((error: Error) => void) | null = null;
  private browserServerLanChangePromise: Promise<void> | null = null;
  private browserServerLanChange: {
    pending: boolean;
    requested: boolean | null;
    /** Requested listener start/stop value while an enabled change is the
     *  pending change; null while any other change (or none) is pending. */
    requestedEnabled: boolean | null;
    error: string | null;
  } = { pending: false, requested: null, requestedEnabled: null, error: null };
  private statusBarUpdateScheduled = false;

  private readonly messageRouter: MessageRouter;

  // CQRS architecture spine
  private archState: ArchState = initialArchState;
  private readonly effectRunner: EffectRunner;
  private readonly fileDiffService: FileDiffService;
  /** Owns the canonical recorder/query helpers. */
  private readonly analyticsRuntime: AnalyticsRuntimePort;
  /** Owns worker/subagent/MCP capture ingress under canonical authority. */
  private readonly analyticsTransport?: HostAnalyticsTransport;
  /** Registers this host for future authenticated all-host handoff discovery.
   * The control endpoint reports incomplete inventory until runtime leases and
   * backend process evidence are reconciled by a separate producer. */
  private readonly analyticsHandoffRegistry?: SessionLifecycleStore;
  private readonly analyticsHandoffControl?: AnalyticsHandoffControl;

  constructor(
    private readonly platform: HostRuntimePlatform,
    backend: BackendClient,
    hooks: HostRuntimeHooks = {},
  ) {
    this.backend = backend;
    this.hooks = hooks;
    const dataOutcomesRootPath = getDataOutcomesRootPath(
      process.env.PI_CODING_AGENT_DIR,
      this.platform.legacyUsageDataRootPath,
    );

    // Canonical-only source mode resolves exactly one data root.
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
    this.dictationService = new DictationService({
      resolveLaunch: () => this.platform.backendStartup.resolveBackendLaunchPaths(),
      helperScript: path.join(this.platform.getRuntimeOutputDirectory(), 'dictation-helper.js'),
      cacheDirectory: path.join(dataPaths.cacheDir, 'speech-models'),
    });
    const analyticsWorkspaceId = this.platform.getWorkspaceAnalyticsId();
    const analyticsProcessGeneration = crypto.randomUUID();
    let backendWriterFenceStarted = false;
    let backendWriterFenceComplete = false;
    let backendWriterFencePromise: Promise<void> | undefined;
    let analyticsWriterFenceStarted = false;
    let analyticsWriterFenceComplete = false;
    let analyticsWriterFencePromise: Promise<void> | undefined;

    const analyticsHandoffRegistry = new SessionLifecycleStore(
      path.join(dataPaths.stateDir, 'session-lifecycle.sqlite'),
    );
    const canonicalContext = Object.freeze({
      mode: 'canonical-only' as const,
      generationId: resolveCanonicalCaptureNamespace(canonicalAnalyticsDatabasePath(dataPaths.analyticsDir)),
      buildId: PIE_BUILD_ID,
      workspaceId: analyticsWorkspaceId,
      hostInstanceId: analyticsProcessGeneration,
    });
    const runtimeIdentity: RuntimeGenerationIdentity | undefined = this.platform.getRuntimeIdentity();
    // The environment override is an explicit launch-channel capability. A
    // normal host boot creates a fresh in-memory key so an old boot's signed
    // requests cannot be replayed; the key is never persisted or returned by
    // the status endpoint. Until a trusted controller receives that key from
    // the launch channel, this endpoint is host-local evidence only and does
    // not constitute an all-host handoff capability.
    const analyticsHandoffKey = process.env.PIE_ANALYTICS_HANDOFF_KEY?.trim()
      || createPerBootAnalyticsHandoffKey();
    const activeAnalyticsGenerationId = canonicalContext.generationId;
    const successorCapabilities = (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE
        ? [storageCutoffRootCapability(dataPaths.sessionsDir)]
        : []);
    const analyticsHostIdentity = {
      hostInstanceId: analyticsProcessGeneration,
      workspaceId: analyticsWorkspaceId,
      generationId: analyticsProcessGeneration,
      buildId: PIE_BUILD_ID,
      processId: process.pid,
      capabilities: [
        'host-discovery',
        'host-status',
        ...successorCapabilities,
      ],
    };
    const recoverAnalyticsHosts = async (): Promise<void> => {
      await recoverStaleAnalyticsHosts({
        registry: analyticsHandoffRegistry,
        workspaceId: analyticsWorkspaceId,
        readProcessCensus,
        now: Date.now,
        log: (level, message, data) => appendPieLog(level, 'analytics-handoff', message, data),
      });
    };
    const analyticsWriterAdmission = createSessionLifecycleWriterAdmission(
      analyticsHandoffRegistry,
      analyticsHostIdentity,
    );
    const analyticsWriterFence = createAnalyticsHostWriterFence({
      identity: analyticsHostIdentity,
      activeWriterCount: () => (backendWriterFenceStarted && !backendWriterFenceComplete ? 1 : 0)
        + (analyticsWriterFenceStarted && !analyticsWriterFenceComplete ? 1 : 0),
      revokeAdmission: (request) => {
        if (backendWriterFenceStarted || analyticsWriterFenceStarted) return;
        backendWriterFenceStarted = true;
        analyticsWriterFenceStarted = true;
        backendWriterFencePromise = this.backend.request('analytics.writerFence', {
          workspaceId: request.workspaceId,
          operationId: request.operationId,
          purpose: request.purpose,
          fenceEpoch: request.fenceEpoch,
          timeoutMs: 9_000,
        }, { timeoutMs: 9_000 }).then((result: unknown) => {
          if (!result || typeof result !== 'object' || Array.isArray(result)
            || (result as { admissionRevoked?: unknown }).admissionRevoked !== true
            || (result as { writersDrained?: unknown }).writersDrained !== true
            || (result as { activeWriterCount?: unknown }).activeWriterCount !== 0) {
            throw new Error('Backend returned an invalid authenticated writer-fence acknowledgement.');
          }
          backendWriterFenceComplete = true;
        });
        analyticsWriterFencePromise = fenceAnalyticsWriters
          ? fenceAnalyticsWriters(9_000).then((activeWriterCount) => {
            if (activeWriterCount !== 0) {
              throw new Error('Canonical recorder returned a nonzero active writer count after fencing.');
            }
            analyticsWriterFenceComplete = true;
          })
          : Promise.reject(new Error('Canonical analytics writer fence is not wired.'));
      },
      isAdmissionRevoked: () => backendWriterFenceStarted && backendWriterFenceComplete
        && analyticsWriterFenceStarted && analyticsWriterFenceComplete,
      waitForIdle: async () => {
        if (backendWriterFencePromise) await backendWriterFencePromise;
        if (analyticsWriterFencePromise) await analyticsWriterFencePromise;
        return 0;
      },
    });
    const analyticsHandoffControl = new AnalyticsHandoffControl({
      registry: analyticsHandoffRegistry,
      identity: analyticsHostIdentity,
      writerFence: analyticsWriterFence,
      restart: createAnalyticsHostControlledRestart({
        stateDir: dataPaths.stateDir,
        identity: analyticsHostIdentity,
        performRestart: () => {
          // Reload the window so the extension host is reconstructed and can
          // consume the durable successor handoff record. Hot exit preserves
          // unsaved work, and admission remains fenced until fresh evidence
          // proves that the successor loaded and registered.
          try {
            this.platform.reloadWindow();
          } catch (error) {
            appendPieLog('error', 'controlled-restart', 'host window reload command failed', {
              error: toErrorMessage(error),
            });
          }
        },
      }),
      recoverStaleHosts: recoverAnalyticsHosts,
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
          runtimeRootPath: path.join(this.platform.extensionPath, 'pie-runtime'),
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
    // Under canonical authority the capture requires a generation id and fact,
    // detail and lifecycle sinks, and throws without them. Those sinks come from
    // the canonical helpers, which only exist once AnalyticsRuntime.start() has
    // succeeded, so the runtime is created here and started in start() below.
    const analyticsRuntime = new AnalyticsRuntime({
      stateDir: dataPaths.stateDir,
      analyticsDir: dataPaths.analyticsDir,
      recorderWorkerScript: path.join(this.platform.getRuntimeOutputDirectory(), 'analytics-recorder-worker.js'),
      queryWorkerScript: path.join(this.platform.getRuntimeOutputDirectory(), 'analytics-query-worker.js'),
      buildId: PIE_BUILD_ID,
      canonicalContext,
      workspaceId: analyticsWorkspaceId,
      processGeneration: analyticsProcessGeneration,
      writerAdmission: analyticsWriterAdmission,
      onError: (error, stage) => {
        appendPieLog('error', 'analytics', `canonical analytics ${stage} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const fenceAnalyticsWriters = (timeoutMs: number) => analyticsRuntime.fenceWriters(timeoutMs);
    // Under canonical authority the capture requires fact, detail and lifecycle
    // sinks. This holder forwards to the recorder after runtime readiness and
    // rejects capture before then. Rejection never redirects data to the legacy
    // store, while the primary session/backend harness can still start if the
    // optional analytics helpers are unavailable.
    const runtimeSinks = {
      preflightDetail: (value: unknown) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical detail sink is not ready; helpers are unavailable.');
        sink.preflightDetail(value);
      },
      submit: (observation: AnalyticsObservation<object>) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical capture sink is not ready; helpers are unavailable.');
        return sink.submit(observation);
      },
      submitTracked: (
        observation: AnalyticsObservation<object>,
        onDisposition: (disposition: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical capture sink is not ready; helpers are unavailable.');
        sink.submitTracked(observation, onDisposition);
      },
      submitDetail: (capture: AnalyticsDetailCapture) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical detail sink is not ready; helpers are unavailable.');
        return sink.submitDetail(capture);
      },
      bindPendingCreate: (
        pendingOperationId: string,
        rootSessionId: string,
        sourceKey: string,
        timestampMs: number | string | bigint,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical lifecycle sink is not ready; helpers are unavailable.');
        return sink.bindPendingCreate(pendingOperationId, rootSessionId, sourceKey, timestampMs);
      },
      deleteSession: (
        rootSessionId: string,
        sourceKey: string,
        timestampMs: number | string | bigint,
        pendingOperationId?: string,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical lifecycle sink is not ready; helpers are unavailable.');
        return sink.deleteSession(rootSessionId, sourceKey, timestampMs, pendingOperationId);
      },
    };
    const analyticsTransport = new HostAnalyticsTransport({
          generationId: canonicalContext.generationId,
          buildId: canonicalContext.buildId,
          workspaceId: canonicalContext.workspaceId,
          backend,
          recorder: {
            submitTracked: (observation, onDisposition) => {
              const sink = analyticsRuntime.sink;
              if (!sink) throw new Error('Canonical capture sink is not ready; helpers are unavailable.');
              sink.submitTracked(observation, onDisposition);
            },
            submitTrackedDetail: (capture, onDisposition) => {
              const sink = analyticsRuntime.sink;
              if (!sink) throw new Error('Canonical detail sink is not ready; helpers are unavailable.');
              sink.submitTrackedDetail(capture, onDisposition);
            },
          },
          onError: (error) => appendPieLog('warn', 'analytics', 'worker analytics ingress rejected', {
            error: error.message,
          }),
        });
    const analyticsCapture = new CanonicalAnalyticsCapture({
      authority: 'canonical',
      generationId: canonicalContext.generationId,
      workspaceId: analyticsWorkspaceId,
      buildId: PIE_BUILD_ID,
      processGeneration: analyticsProcessGeneration,
      sink: runtimeSinks, detailSink: runtimeSinks, lifecycleSink: runtimeSinks,
    });

    // P5 durable read model: path-only resolution until a consumer queries it
    // (one disposable helper fork per query). The canonical data root shares
    // the backend's explicit-failure resolution; queries against an absent
    // database fail explicitly instead of falling back to legacy stores.
    // Construction is unconditional; StatsService withholds the model unless
    // canonical authority is active, so no consumer can read it early.
    const analyticsReadModel = new CanonicalAnalyticsReadModel({
      databasePath: canonicalAnalyticsDatabasePath(dataPaths.analyticsDir),
      workerScript: path.join(this.platform.getRuntimeOutputDirectory(), 'analytics-query-worker.js'),
      beforeProviderAggregateRead: (request) => analyticsRuntime.prepareProviderDailyProjection(request),
    });

    const statsService = new StatsService({
      dataOutcomesRootPath,
      legacyUsageDataRootPath: this.platform.legacyUsageDataRootPath,
      // Second workspace-identity read: matches the previous composition,
      // which read the (lazily-persisted) no-workspace id twice.
      workspaceId: this.platform.getWorkspaceAnalyticsId(),
      legacyWorkspaceIds: this.platform.getLegacyWorkspaceAnalyticsIds(),
      scheduleRender: () => this.scheduleRender(),
      getExperimentAssignment: () => this.platform.getExperimentAssignment(),
      getArchState: () => this.archState,
      dispatchArchEvent: (event) => this.dispatchArchEvent(event),
      getAgentDir: () => process.env.PI_CODING_AGENT_DIR?.trim() || null,
      analyticsCapture,
      analyticsReadModel,
    });

    this.analyticsRuntime = analyticsRuntime;
    this.analyticsTransport = analyticsTransport;
    this.analyticsHandoffRegistry = analyticsHandoffRegistry;
    this.analyticsHandoffControl = analyticsHandoffControl;
    this.statsService = statsService;

    this.service = new SessionService(
      this.platform,
      backend,
      () => this.scheduleRender(),
      (message) => {
        if (message.type.startsWith('detail.') && 'rendererId' in message) {
          this.platform.renderer.postImperativeToRenderer(message.rendererId, message);
          return;
        }
        this.platform.renderer.postImperative(message);
      },
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      (event) => {
        this.handleSessionCompleted(event);
      },
      this.statsService,
      {
        getHostInstanceId: () => this.platform.renderer.getHostInstanceId(),
        getViewGeneration: () => this.platform.renderer.getViewGeneration(),
        isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
          this.platform.renderer.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration)
          || this.browserServer.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration),
      },
      () => undefined,
      () => this.handleQuestionRequested(),
      // Preserve canonical-only backend mode even when optional helpers fail.
      () => this.analyticsRuntime.getCanonicalContext() ?? canonicalContext,
    );

    this.liveMembershipSync = new HostLiveMembershipSync(this.archState, {
      // `session.liveMembership` travels on the same ordered FIFO request
      // channel as every later host mutation, so a close reservation — and
      // the typed accepted ack — always precedes any admission-relevant
      // mutation written afterwards.
      request: (params) => this.backend
        .request('session.liveMembership', params, { timeoutMs: 5000 })
        .catch((error) => {
          appendPieLog('warn', 'session', 'host live-membership sync rejected', {
            error: toErrorMessage(error),
          });
          throw error;
        }),
      getBackendGeneration: () => this.service.getBackendGeneration(),
      log: (message) => appendPieLog('warn', 'session', message),
    }, {
      getWorkingTime: (sessionPath) => this.statsService.getWorkingTimeBySession()[sessionPath],
      getSessionUsage: (sessionPath) => this.statsService.getSessionUsage(sessionPath),
      getOpenRuns: () => this.statsService.getOpenRuns(),
    });

    this.tokenRateService = new TokenRateService({
      getArchState: () => this.archState,
      onActiveRateChanged: () => this.platform.renderer.scheduleState(),
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
      onChanged: () => this.platform.renderer.scheduleState(),
      analyticsTimeZone: analyticsRuntime.analyticsTimeZone,
    });

    this.fileDiffService = new FileDiffService(
      () => this.archState,
      {
        getWorkspaceCwd: () => this.platform.getWorkspaceFolderPath(),
        showWarning: (message) => { this.platform.notifications.showWarningMessage(message); },
      },
    );

    this.messageRouter = new MessageRouter(
      (event) => this.dispatchArchEvent(event),
      () => this.archState,
      this.service,
      // The renderer surface satisfies the router's narrow SidebarProviderLike
      // seam; optional renderer-scoped members stay optional exactly as before.
      {
        reveal: () => this.platform.renderer.reveal(),
        postState: () => this.platform.renderer.postState(),
        postSelectionState: () => this.platform.renderer.postSelectionState?.(),
        requestState: (rendererId) => this.platform.renderer.requestState?.(rendererId),
        getViewGeneration: () => this.platform.renderer.getViewGeneration(),
        postImperative: (msg) => this.platform.renderer.postImperative(msg),
        postImperativeToRenderer: (rendererId, msg) =>
          this.platform.renderer.postImperativeToRenderer(rendererId, msg),
        isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
          this.platform.renderer.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration)
          || this.browserServer.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration),
      },
      () => this.scheduleRender(),
      deriveSessionNameFromText,
      isPendingTabPath,
      {
        openFilePicker: () => this.platform.editor.openFilePicker({
          openLabel: 'Attach',
          title: 'Attach file path(s) to message',
        }),
        openSettings: () => this.platform.editor.openSettings(),
        restartBackend: async (source) => {
          await this.restart(source);
        },
        showLogs: () => this.platform.showLogs?.(),
        setBrowserServerLanEnabled: (enabled) => this.setBrowserServerLanEnabled(enabled),
        setBrowserServerEnabled: (enabled) => this.setBrowserServerEnabled(enabled),
        performImageAction: this.platform.editor.performImageAction
          ? (request) => this.platform.editor.performImageAction!(request)
          : undefined,
        prepareLocalFileOpen: this.platform.editor.prepareLocalFileOpen
          ? (request) => this.platform.editor.prepareLocalFileOpen!(request)
          : undefined,
        previewImageFile: (request) => this.platform.editor.previewImageFile
          ? this.platform.editor.previewImageFile(request.path, request)
          : Promise.resolve(undefined),
      },
    );

    this.browserServer = this.platform.createBrowserServer({
      hostInstanceId: this.platform.renderer.getHostInstanceId(),
      getSettings: () => this.platform.getBrowserServerSettings(),
      getViewState: () => this.buildViewState(),
      getRunningSessionCount: () => this.archState.sessions.runningSessionPaths.length,
      routeMessage: (msg, context) => this.messageRouter.handle(msg, context),
      onRendererInvalidated: (rendererId, rendererGeneration) => this.invalidateRenderer(rendererId, rendererGeneration),
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
        // PersistTabs: write openTabPaths + activeSessionPath to platform
        // storage, matching SessionServiceState.saveOpenTabs() exactly (same
        // storage keys, same JSON shape). Uses the effect's args (a snapshot
        // of the post-reorder state) rather than re-reading the service's
        // internal state; session names are looked up from the current
        // archState solely to enrich the persisted { path, name } objects.
        persistTabs: async (openTabPaths, activeSessionPath, pinnedTabPaths, pinnedTabGroups, privateSessionPaths, snoozedBySession) => {
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
          const storedPrivateSessionPaths = this.platform.storage.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY)
            ?.filter((sessionPath): sessionPath is string => typeof sessionPath === 'string' && sessionPath.length > 0)
            ?? [];
          const persistedPrivateSessionPaths = (privateSessionPaths ?? [
            ...new Set([...storedPrivateSessionPaths, ...activePrivateSessionPaths]),
          ]).filter((sessionPath) => !isPendingTabPath(sessionPath));
          try {
            // A single storage value commits snoozes together with their tab
            // snapshot. Legacy mirrors may fail without losing a waking tab.
            if (snoozedBySession !== undefined) await this.platform.storage.update('sessionSnoozeTabSnapshot', {
              openTabPaths: tabObjects, activeSessionPath: persistedActiveSessionPath,
              pinnedTabPaths: persistedPinnedTabPaths, pinnedTabGroups: persistedPinnedTabGroups,
              snoozedBySession,
            });
            await Promise.all([
              this.platform.storage.update(OPEN_TABS_STORAGE_KEY, tabObjects),
              this.platform.storage.update(ACTIVE_SESSION_STORAGE_KEY, persistedActiveSessionPath),
              this.platform.storage.update(PINNED_TABS_STORAGE_KEY, persistedPinnedTabPaths),
              this.platform.storage.update(PINNED_TAB_GROUPS_STORAGE_KEY, persistedPinnedTabGroups),
              this.platform.storage.update(PRIVATE_SESSION_PATHS_STORAGE_KEY, persistedPrivateSessionPaths),
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
        postImperative: (message) => this.platform.renderer.postImperative(message as HostToWebviewMessage),
      },
      modal: {
        // ShowModelSwitchConfirm: a modal host warning dialog. The reducer
        // owns the question text + confirm button label; the runner is a thin
        // executor. Resolves to the chosen label or undefined if dismissed.
        showWarningModal: (message, confirmChoice) =>
          this.platform.notifications.showModalConfirm(message, confirmChoice),
      },
      // Source-aware confirmation seam: a BROWSER source confirms
      // inline in ITS OWN renderer through the browser server; the host modal
      // is never shown for a browser source, and disconnect cancels.
      // The sidebar (VS Code) source path is unchanged (native modal).
      inlineConfirm: (request) =>
        this.browserServer.requestInlineConfirm(request.rendererId, {
          kind: request.kind,
          ...(request.sessionPath !== undefined ? { sessionPath: request.sessionPath } : {}),
          message: request.message,
          confirmChoice: request.confirmChoice,
        }),
      fileDiffService: this.fileDiffService,
      fileDiffViewer: this.platform.createFileDiffViewer(this.fileDiffService),
      openFile: {
        openFile: async (filePath, options) => {
          await this.platform.editor.openFileInEditor(filePath, options);
        },
      },
      service: this.service,
      getProviderManagementState: () => this.archState.providerManagement,
      dictation: this.dictationService,
      isDictationOwnerCurrent: (id) => !this.shutdownRequested && this.archState.dictation.recordingId === id && this.archState.dictation.capture !== null,
      statsService: this.statsService,
      dispatch: (event) => this.dispatchArchEvent(event),
      dispatchCommand: (event) => this.dispatchArchEvent(event),
      dispatchEvent: (event) => this.dispatchArchEvent(event),
    });
    // Availability is host-owned initial state, not a runtime event: dispatching
    // here schedules every renderer surface before standalone has wired its
    // facade. Seed the pure state directly so the first snapshot is correct.
    this.archState = {
      ...this.archState,
      dictation: {
        ...this.archState.dictation,
        available: process.platform === 'win32' && process.arch === 'x64',
      },
    };
  }

  private readonly dictationService: DictationService;
  private readonly hooks: HostRuntimeHooks;
  private readonly tokenRateService: TokenRateService;
  private readonly aggregateStatsService: AggregateStatsService;

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
    const paths = this.platform.storage.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY) ?? [];
    for (const sessionPath of paths) {
      if (typeof sessionPath !== 'string' || !sessionPath) continue;
      this.dispatchArchEvent({
        kind: 'Command',
        cmd: { kind: 'SetPrivacyMode', corrId: `privacy-start:${Date.now()}:${sessionPath}`, sessionPath, enabled: true, persist: false },
      });
    }
  }

  start(): Promise<void> {
    if (this.shutdownRequested) return Promise.reject(new Error('Pie host is shutting down.'));
    if (!this.startupPromise) this.startupPromise = this.startInternal();
    return this.startupPromise;
  }

  private async startInternal(): Promise<void> {
    this.reportStatus('Starting');
    const handoffStarted = performance.now();
    let handoffOutcome: 'success' | 'failure' = 'failure';
    try {
      await this.analyticsHandoffControl?.start();
      handoffOutcome = 'success';
    } finally {
      finishPreBackendTiming('analytics-handoff-start', handoffStarted, handoffOutcome);
    }
    if (this.shutdownRequested) return;
    // Try canonical analytics before services can produce captures. A failed
    // analytics helper must not take down Pie's primary session/backend
    // harness; its capture closures remain fail-closed and never write to the
    // legacy authority. Keep startup evidence tied to a successful readiness
    // probe so a degraded host cannot claim canonical readiness.
    const analyticsStarted = performance.now();
    try {
      let analyticsOutcome: 'success' | 'failure' = 'failure';
      try {
        await this.analyticsRuntime.start();
        analyticsOutcome = 'success';
      } finally {
        // Excludes loaded-generation recording and the degraded-start warning.
        finishPreBackendTiming('analytics-runtime-start', analyticsStarted, analyticsOutcome);
      }
      if (this.shutdownRequested) return;

    } catch (error) {
      if (this.shutdownRequested) return;
      const message = toErrorMessage(error);
      appendPieLog('warn', 'extension', 'analytics unavailable; continuing Pie startup without canonical capture', {
        error: message,
      });
      this.platform.notifications.showWarningMessage(
        'Pie started, but analytics is unavailable for this window. New analytics capture is paused; see Output > pie for the startup error.',
      );
    }
    const privacyStarted = performance.now();
    let privacyOutcome: 'success' | 'failure' = 'failure';
    try {
      this.hydratePrivacyMarkers();
      privacyOutcome = 'success';
    } finally {
      finishPreBackendTiming('privacy-marker-initialization', privacyStarted, privacyOutcome);
    }
    // Includes synchronous rate/aggregate starts and the awaited stats start;
    // excludes their later background work and session-service startup.
    const statsStarted = performance.now();
    let statsOutcome: 'success' | 'failure' = 'failure';
    try {
      this.tokenRateService.start();
      this.aggregateStatsService.start();
      await this.statsService.start();
      statsOutcome = 'success';
    } finally {
      finishPreBackendTiming('host-stats-start', statsStarted, statsOutcome);
    }
    if (this.shutdownRequested) return;
    await this.service.start();
    if (this.shutdownRequested) return;
    // Start the browser server only after the host can build a
    // valid initial `ViewState`. Backend readiness is a field in that state;
    // the HTTP shell does not wait for provider/backend startup.
    await this.browserServer.start();
    if (this.shutdownRequested) return;
    // A helper-issued nonce requests terminal cutover evidence. Write it only
    // after the complete host readiness sequence, including the browser
    // endpoint, has succeeded; ordinary boots remain marker-only.

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
      this.reportStatus('Starting');
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
   * This is the single point where the CQRS spine integrates with the host.
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
    if (!stateBefore.settings.backendReady && this.archState.settings.backendReady) {
      // Startup selections that queued model hydration before backend.ready
      // ("Backend is not running" seam) must hydrate on the ready transition
      // instead of being swallowed.
      this.service.flushDeferredModelHydrations();
    }
    if (!stateBefore.settings.backendReady && this.archState.settings.backendReady
      && !this.dictationPrewarmRequested && this.archState.dictation.available && !this.shutdownRequested) {
      this.dictationPrewarmRequested = true;
      void Promise.resolve().then(() => {
        if (!this.shutdownRequested) return this.dictationService.prewarm();
      }).catch(() => { /* Optional background preparation never changes host readiness. */ });
    }
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
    // Ordered live-membership sync: the coordinator receives the host's tab
    // and close-reservation state before any effect from this transition runs
    // (close acknowledgements, stop/interrupt, persistence notifications). A
    // UI close therefore closes coordinator-side execution admission before
    // the close's own host-side work begins.
    this.liveMembershipSync.afterDispatch(this.archState);
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

  /**
   * Project the CQRS `ArchState` into the `ViewState` consumed by the webview,
   * then merge in the host-side token-rate measurements for every running
   * session. The rate map is measured continuously by `TokenRateService`
   * (including for sessions that are not the active/selected tab); merging it
   * here keeps `selectViewState` itself pure (no service reads inside the
   * pure projection).
   */
  buildViewState(): ViewState {
    const traceEnabled = isLivePipelineTraceEnabled();
    const traceStartedAt = traceEnabled ? performance.now() : 0;
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
    // Canonical analytics are optional at the protocol boundary. The host seam
    // gates legacy authority and reads only the existing bounded cache
    // accessors; invalidated/private entries therefore stay explicit
    // unknown/null snapshots.
    const canonicalSessionPaths = [
      projected.activeSession?.path,
      ...projected.runningSessionPaths,
      ...projected.openTabPaths,
    ].filter((sessionPath): sessionPath is string => Boolean(sessionPath))
      .filter((sessionPath) => !isPendingTabPath(sessionPath));
    const canonicalActivityViews = projectCanonicalActivityViews(
      this.statsService,
      canonicalSessionPaths,
      MAX_CANONICAL_ACTIVITY_VIEW_SESSIONS,
    );
    const viewState: ViewState = {
      ...projected,
      ...canonicalActivityViews,
      browserServer: this.projectBrowserServerViewState(),
      imageActionCapabilities: {
        copy: !!this.platform.editor.performImageAction && this.platform.editor.imageActionCapabilities?.copy === true,
        openInBrowser: !!this.platform.editor.performImageAction && this.platform.editor.imageActionCapabilities?.openInBrowser === true,
        reveal: !!this.platform.editor.performImageAction && this.platform.editor.imageActionCapabilities?.reveal === true,
      },
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
    if (traceEnabled) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.projection.completed',
        kind: 'success',
        identifiers: viewState.activeSession?.path ? { session: viewState.activeSession.path } : undefined,
        durationMs: Math.max(0, performance.now() - traceStartedAt),
        transcriptCount: viewState.transcript.length,
      });
    }
    const compactionStartedAt = traceEnabled ? performance.now() : 0;
    const rendererViewState = compactRendererViewState(viewState);
    if (traceEnabled) {
      recordLivePipelineTrace({
        process: 'host',
        stage: 'host.renderer.compacted',
        kind: 'success',
        identifiers: viewState.activeSession?.path ? { session: viewState.activeSession.path } : undefined,
        durationMs: Math.max(0, performance.now() - compactionStartedAt),
        transcriptCount: rendererViewState.transcript.length,
      });
    }
    return rendererViewState;
  }

  private projectBrowserServerViewState(): BrowserServerViewState {
    const actual = this.browserServer.getState();
    return {
      running: actual.running,
      localUrl: actual.url,
      port: actual.port,
      clientCount: actual.clientCount,
      lanEnabled: actual.lanEnabled,
      configuredLanEnabled: this.platform.getBrowserServerSettings().allowLan,
      lanUrls: [...actual.lanUrls],
      changePending: this.browserServerLanChange.pending,
      pendingLanEnabled: this.browserServerLanChange.requested,
      changeError: this.browserServerLanChange.error,
      configuredEnabled: this.platform.getBrowserServerSettings().enabled,
      pendingEnabled: this.browserServerLanChange.requestedEnabled,
      serverToggleAvailable: this.platform.supportsBrowserServerToggle === true
        && this.platform.setBrowserServerEnabled !== undefined,
    };
  }

  /** Serialize network-setting changes through the one shared browser server.
   *  The persisted preference is the authority; the posted state separately
   *  reports the actual listener state if rebinding fails. */
  private setBrowserServerLanEnabled(enabled: boolean): Promise<void> {
    return this.enqueueBrowserServerChange(() => this.applyBrowserServerLanEnabled(enabled));
  }

  /** Start/stop the shared localhost listener per the persisted
   *  `pie.browserServer.enabled` preference. The VS Code sidebar keeps the
   *  host alive, so the listener may stop; standalone compositions never
   *  expose the switch and their platform seam rejects the request. */
  private setBrowserServerEnabled(enabled: boolean): Promise<void> {
    return this.enqueueBrowserServerChange(() => this.applyBrowserServerEnabled(enabled));
  }

  private enqueueBrowserServerChange(run: () => Promise<void>): Promise<void> {
    const previous = this.browserServerLanChangePromise ?? Promise.resolve();
    const operation = previous.then(run);
    this.browserServerLanChangePromise = operation;
    void operation.then(
      () => { if (this.browserServerLanChangePromise === operation) this.browserServerLanChangePromise = null; },
      () => { if (this.browserServerLanChangePromise === operation) this.browserServerLanChangePromise = null; },
    );
    return operation;
  }

  /** The report origin's address policy is tied to the browser-server
   *  instance: prepared local-file-open capabilities must never outlive a
   *  server stop or LAN restart (idle expiry and host shutdown disposes
   *  separately). A failed dispose never blocks the listener change. */
  private async closeLocalFileOpenReports(): Promise<void> {
    try { await this.platform.editor.disposeLocalFileOpen?.(); } catch (error) {
      appendPieLog('warn', 'local-file-open', 'dispose failed', { error: toErrorMessage(error) });
    }
  }

  private async applyBrowserServerLanEnabled(enabled: boolean): Promise<void> {
    this.browserServerLanChange = { pending: true, requested: enabled, requestedEnabled: null, error: null };
    this.scheduleRender();
    try {
      const previousSettings = this.platform.getBrowserServerSettings();
      const previousState = this.browserServer.getState();
      await this.platform.setBrowserServerLanEnabled(enabled);
      // The LAN preference is a saved intent only: when the listener is
      // disabled it must never implicitly start the server.
      if (previousSettings.enabled
        && (previousSettings.allowLan !== enabled || !previousState.running)) {
        if (previousState.running) {
          await this.browserServer.stop();
          await this.closeLocalFileOpenReports();
        }
        const outcome = await this.browserServer.start();
        if (outcome.kind === 'failed') {
          throw new Error(outcome.reason);
        }
      }
      this.browserServerLanChange = { pending: false, requested: null, requestedEnabled: null, error: null };
    } catch (error) {
      const detail = toErrorMessage(error);
      appendPieLog('error', 'browser-server', 'LAN setting apply failed', { enabled, error: detail });
      this.browserServerLanChange = {
        pending: false,
        requested: null,
        requestedEnabled: null,
        error: 'Could not apply the network setting. Check the Pie log for details.',
      };
    }
    this.scheduleRender();
  }

  /** Apply the persisted listener start/stop preference. Persistence failure
   *  never claims an apply; a failed bind reports actual state through the
   *  separate server-state fields without silently clearing the preference. */
  private async applyBrowserServerEnabled(enabled: boolean): Promise<void> {
    this.browserServerLanChange = { pending: true, requested: null, requestedEnabled: enabled, error: null };
    this.scheduleRender();
    try {
      const setBrowserServerEnabled = this.platform.setBrowserServerEnabled;
      if (!setBrowserServerEnabled) {
        throw new Error('This pie host cannot start or stop the browser listener.');
      }
      await setBrowserServerEnabled.call(this.platform, enabled);
      const previousState = this.browserServer.getState();
      if (enabled && !previousState.running) {
        const outcome = await this.browserServer.start();
        if (outcome.kind === 'failed') {
          throw new Error(outcome.reason);
        }
      } else if (!enabled && previousState.running) {
        await this.browserServer.stop();
        await this.closeLocalFileOpenReports();
      }
      this.browserServerLanChange = { pending: false, requested: null, requestedEnabled: null, error: null };
    } catch (error) {
      const detail = toErrorMessage(error);
      appendPieLog('error', 'browser-server', 'Listener setting apply failed', { enabled, error: detail });
      this.browserServerLanChange = {
        pending: false,
        requested: null,
        requestedEnabled: null,
        error: 'Could not apply the browser server setting. Check the Pie log for details.',
      };
    }
    this.scheduleRender();
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
    this.platform.renderer.scheduleState();
    this.browserServer.scheduleState();
    if (this.statusBarUpdateScheduled) {
      return;
    }
    this.statusBarUpdateScheduled = true;
    queueMicrotask(() => {
      this.statusBarUpdateScheduled = false;
      this.reportStatus(
        this.archState.settings.notice
          ? 'Error'
          : this.archState.sessions.runningSessionPaths.length > 0
            ? 'Thinking'
            : 'Idle',
      );
    });
  }

  private reportStatus(state: 'Starting' | 'Idle' | 'Thinking' | 'Error'): void {
    this.hooks.onStatusChange?.(state);
  }

  /** Current projected running-session count (sidebar/browser scheduling). */
  getRunningSessionCount(): number {
    return this.archState.sessions.runningSessionPaths.length;
  }

  /** Read-only access to the current CQRS state for host shell affordances
   *  (status bar text, debug dumps). */
  getArchState(): ArchState {
    return this.archState;
  }

  /** Route an inbound renderer message through the message router. */
  invalidateRenderer(rendererId: string, rendererGeneration: number): void {
    this.service.unsubscribeRendererDetails(rendererId, rendererGeneration);
    this.dispatchArchEvent({ kind: 'DictationRendererInvalidated', rendererId, rendererGeneration });
  }

  async handleWebviewMessage(msg: WebviewToHostMessage, context?: RendererCommandContext): Promise<void> {
    await this.messageRouter.handle(msg, context);
  }

  /** Config-backed experiment assignment changed (host config listener). */
  notifyExperimentAssignmentChanged(): void {
    this.statsService.onExperimentAssignmentChanged(this.platform.getExperimentAssignment());
  }

  /** Lifecycle sink: successful fallback binds are info-log-only;
   *  only a terminal bind/start failure produces a user notice. */
  private handleBrowserServerLifecycle(event: BrowserServerLifecycleEvent): void {
    switch (event.kind) {
      case 'started':
        appendPieLog('info', 'browser-server', 'started', { url: event.url, preferred: event.preferred });
        this.reportBrowserServerUrls(event.url, event.lanEnabled, event.lanUrls);
        break;
      case 'fallback':
        // Informational: the preferred port was busy; the ACTUAL url is
        // recorded and reported by the commands. No bind-failure notice.
        appendPieLog('info', 'browser-server', 'fallback-port', { url: event.url });
        this.reportBrowserServerUrls(event.url, event.lanEnabled, event.lanUrls);
        break;
      case 'bind-failed':
        appendPieLog('error', 'browser-server', 'bind-failed', {
          port: event.port,
          requirePreferredPort: event.requirePreferredPort,
          error: event.error,
        });
        this.platform.notifications.showErrorMessage(
          `pie browser server failed to start on port ${event.port}: ${event.error}`,
        );
        break;
      case 'restarted':
        appendPieLog('info', 'browser-server', 'restarted', { url: event.url });
        break;
      case 'stopped':
        appendPieLog('info', 'browser-server', 'stopped', { reason: event.reason });
        break;
      case 'client-connected':
        appendPieLog('info', 'browser-server', 'client-connected', { rendererId: event.rendererId });
        this.platform.renderer.scheduleState();
        this.browserServer.scheduleState();
        break;
      case 'client-closed':
        appendPieLog('info', 'browser-server', 'client-closed', {
          rendererId: event.rendererId,
          code: event.code,
          reason: event.reason,
        });
        this.platform.renderer.scheduleState();
        this.browserServer.scheduleState();
        break;
    }
  }

  private reportBrowserServerUrls(localUrl: string, lanEnabled: boolean, lanUrls: readonly string[]): void {
    appendPieLog('info', 'browser-server', 'available-urls', { localUrl, lanEnabled, lanUrls: [...lanUrls] });
    if (!lanEnabled) return;
    const lanList = lanUrls.length > 0
      ? lanUrls.map((url) => `  ${url}`).join('\n')
      : '  No private IPv4 LAN interface was detected.';
    this.platform.notifications.showWarningMessage(
      `Trusted LAN access is enabled without authentication or TLS. Anyone who can reach these URLs can use Pie to execute commands and read or modify files. Enable it only on a trusted network; public/internet access is unsupported.\nLocal: ${localUrl}\nLAN:\n${lanList}`,
    );
  }

  private handleSessionCompleted(_event: SessionCompletionEvent): void {
    const suppressNotifications = this.archState.settings.prefs.suppressCompletionNotifications;
    const windowFocused = this.platform.notifications.isWindowFocused();

    const volume = this.archState.settings.prefs.completionSoundVolume;
    if (!suppressNotifications && volume > 0) {
      this.broadcastNotificationSound({ type: 'playCompletionSound', volume });
    }

    if (!shouldShowCompletionNotification({
      suppressNotifications,
      windowFocused,
    })) {
      return;
    }

    this.platform.requestWindowAttention();
  }

  private handleQuestionRequested(): void {
    const volume = this.archState.settings.prefs.completionSoundVolume;
    if (volume > 0) {
      this.broadcastNotificationSound({ type: 'playQuestionSound', volume });
    }
  }

  private broadcastNotificationSound(message: HostToWebviewMessage): void {
    this.platform.renderer.postImperative(message);
    // VS Code has an independent sidebar renderer. Standalone's renderer
    // facade already broadcasts through the browser hub, so don't double-send.
    if (this.platform.supportsBrowserServerToggle === true) {
      this.browserServer.postImperative(message);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownRequested = true;
    this.shutdownPromise = (async () => {
      // Startup can still own writer admissions or be awaiting process census.
      // Fence later startup phases and drain the current phase before closing
      // its dependencies. Never mark stopped while a late startup can write.
      await this.startupPromise?.catch(() => undefined);
      // Stop accepting authenticated handoff requests before host producers
      // drain. The registry retains this identity as stopping evidence: the
      // endpoint closing is not proof that backend/recorder writers drained,
      // and is never interpreted as proof that every writer was discovered.
      await this.analyticsHandoffControl?.stop();
      // Stop the browser server FIRST — stop accepting
      // HTTP/upgrades, close tracked WebSocket clients, close/await the HTTP
      // server, dispose browser renderer sessions/hub — then continue the
      // existing service/backend shutdown order. Closing the port releases it
      // for the next host window immediately.
      this.browserServer.dispose();
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / renderer after dispose.
      this.effectRunner.dispose();
      // Ephemeral local-file-open capabilities are host-owned: dispose them
      // here (idle expiry is the normal path) rather than outliving shutdown.
      await this.closeLocalFileOpenReports();
      // Drain local microphone/model ownership before allowing runtime collection.
      // A failed drain must not prevent the other owned services from cleaning up.
      let dictationShutdownError: unknown;
      try { await this.dictationService.shutdown(); } catch (error) { dictationShutdownError = error; }
      this.tokenRateService.dispose();
      this.aggregateStatsService.dispose();

      // Stop host-side producers first. Keep backend analytics ingress open
      // while the backend workers perform their bounded writer drain; closing
      // it here would drop facts that the workers have already admitted.
      await this.statsService.shutdown();
      // Closing stdin fences the coordinator and all worker producers. Keep the
      // host transport receiving until the backend has confirmed exit so
      // admitted worker facts can reach the recorder. Its final shutdown then
      // fences late ingress and records any ACKs that could not return before
      // coordinator exit; this is not an all-host durability claim.
      try {
        await this.backend.stop();
      } finally {
        await this.analyticsTransport?.shutdown();
      }
      this.backend.dispose();
      await this.analyticsRuntime.stop();
      await this.analyticsHandoffControl?.markStopped();
      this.analyticsTransport?.dispose();
      this.analyticsHandoffRegistry?.close();
      this.service.dispose();
      await disposeLivePipelineTrace();
      // Coordinator exit still permits stop/manual restart, but forced or
      // unknown descendant teardown must not release immutable runtime files.
      // Report only after other owned teardown, including analytics, finishes.
      if (dictationShutdownError || !this.dictationService.isLifetimeTeardownConfirmed()) {
        throw new Error('Dictation runtime lifetime teardown is unconfirmed; generation lease must be retained.');
      }
      if (!this.backend.isRuntimeLifetimeTeardownConfirmed()) {
        throw new Error('Backend runtime lifetime teardown is unconfirmed; generation lease must be retained.');
      }
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