import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { FileDiffService } from '../core/file-diff-service';
import { MessageRouter } from '../core/message-router';

import { getDataOutcomesRootPath } from '../run-analytics/storage';
import type { BackendClient } from '../backend/client';
import {
  shouldShowCompletionNotification,
  type SessionCompletionEvent,
} from '../sidebar/completion-notification';
import { BrowserServer } from '../browser-server/browser-server';
import { compactRendererViewState } from '../renderers/renderer-view-state';
import type { BrowserServerLifecycleEvent } from '../browser-server/types';
import type { BrowserServerViewState } from '../../shared/protocol/webview';
import { SessionService } from '../session-service';
import type { HostRuntimePlatform, HostRuntimeHooks } from './platform';
import { TokenRateService } from '../token-rate-service';
import { AggregateStatsService } from '../aggregate-stats-service';
import { EMPTY_PROVIDER_GATE_STATS, type ProviderGateStats } from '../../shared/protocol/aggregate-stats';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
} from '../../shared/storage-cutoff-authorization';
import {
  OPEN_TABS_STORAGE_KEY,
  ACTIVE_SESSION_STORAGE_KEY,
  PINNED_TABS_STORAGE_KEY,
  PINNED_TAB_GROUPS_STORAGE_KEY,
  PRIVATE_SESSION_PATHS_STORAGE_KEY,
} from '../session-service/state';
import { StatsService, type StatsServicePort } from '../stats-service';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../analytics/query-entry.js';
import { resolvePieDataPaths } from '../../../../shared/pie-data-root.js';
import { toErrorMessage } from '../util/error-message';
import { PIE_BUILD_ID, type WebviewToHostMessage, type ViewState } from '../../shared/protocol';
import { EffectRunner } from '../core/effect-runner';
import { dispatch } from '../core/dispatch';
import { initialArchState, type ArchState } from '../core/reducer';
import type { Event } from '../core/events';
import type { SessionOperationSource } from '../core/operation-types.js';
import { operationAndIncidentTraceEvents } from '../core/operation-incident-tracing.js';
import { projectCanonicalActivityViews, selectViewState } from '../core/projection';
import { auditLog, bootLog } from '../util/audit';
import {
  disposeLivePipelineTrace,
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
} from '../util/live-pipeline-trace-runtime';
import { deriveSessionNameFromText } from '../../shared/session-name';
import { isPendingTabPath } from '../../shared/tab-behavior';
import { appendPieLog } from '../util/pie-log';
import { CanonicalAnalyticsCapture } from '../../analytics/canonical-capture.js';
import { ActivationStore } from '../../analytics/activation-store.js';
import {
  AnalyticsRuntime,
  type AnalyticsRuntimePort,
} from '../analytics-runtime.js';
import { HostAnalyticsTransport } from '../analytics-transport.js';
import type { AnalyticsDetailCapture, AnalyticsObservation } from '../../../../shared/analytics/contracts.js';
import { AnalyticsHandoffControl } from '../analytics-handoff-control.js';
import { createAnalyticsHostWriterFence } from '../analytics-all-host-handoff.js';
import {
  claimPendingControlledRestart,
  createAnalyticsHostControlledRestart,
} from '../analytics-controlled-restart.js';
import {
  discoverAnalyticsHostWriters,
  type RuntimeGenerationIdentity,
} from '../analytics-handoff-discovery.js';
import { readProcessCensus } from '../analytics-process-census.js';
import { createPerBootAnalyticsHandoffKey } from '../../../../shared/analytics/host-status-messages.js';
import {
  createSessionLifecycleWriterAdmission,
  SessionLifecycleStore,
  storageCutoffRootCapability,
} from '../../backend/session-lifecycle-store.js';

/** Keep the renderer surface aligned with the StatsService eager displayed
 * session bound; omitted session paths remain lazy/unknown rather than making
 * a full session catalogue part of every ViewState snapshot. */
const MAX_CANONICAL_ACTIVITY_VIEW_SESSIONS = 32;

/**
 * Platform-neutral application composition and lifecycle for the pie host.
 *
 * Owns the CQRS spine (arch state, reducer dispatch, the single effect
 * runner), the session service, the browser server, the analytics authority
 * seams (runtime, transport, handoff), and the backend start/restart/shutdown
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
  /** Loopback browser server (browser server plan §6/§7). Started in
   *  `start()` after the host can build a valid initial `ViewState`, stopped
   *  in `shutdown()` before the service/backend order. */
  readonly browserServer: BrowserServer;
  /** Canonical/legacy analytics accounting authority seam. */
  readonly statsService: StatsServicePort;

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

    // Normal boots construct the producer seams below and read authority from
    // the validated activation manifest rather than hardcoding it.
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: process.env.PI_CODING_AGENT_DIR,
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
    const activation = new ActivationStore({ stateDir: dataPaths.stateDir }).read();
    // Each controlled request has its own durable slot and fresh successor
    // key. A successor boot claims exactly one slot before registering its
    // new identity; the owner later correlates that slot's evidence path to
    // the actual host identity rather than assuming identity reuse.
    const pendingControlledRestart = claimPendingControlledRestart(dataPaths.stateDir);
    const envRestartNonce = process.env.PIE_ANALYTICS_RESTART_NONCE?.trim() || null;
    const envRestartReceiptPath = process.env.PIE_ANALYTICS_TERMINAL_RESTART_RECEIPT_PATH?.trim();
    const usesEnvironmentRestartEvidence = pendingControlledRestart === undefined
      && (envRestartNonce !== null || envRestartReceiptPath !== undefined);
    const runtimeIdentity: RuntimeGenerationIdentity | undefined = this.platform.getRuntimeIdentity();
    // The environment override is an explicit launch-channel capability. A
    // normal host boot creates a fresh in-memory key so an old boot's signed
    // requests cannot be replayed; the key is never persisted or returned by
    // the status endpoint. Until a trusted controller receives that key from
    // the launch channel, this endpoint is host-local evidence only and does
    // not constitute an all-host handoff capability.
    const analyticsHandoffKey = pendingControlledRestart?.successorHandoffKey
      || process.env.PIE_ANALYTICS_HANDOFF_KEY?.trim()
      || createPerBootAnalyticsHandoffKey();
    const activeAnalyticsGenerationId = activation.authority === 'canonical'
      ? activation.manifest?.activeGeneration?.identity.generationId
      : undefined;
    const successorCapabilities = pendingControlledRestart?.successorCapabilities
      ?? (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] === STORAGE_CUTOFF_AUTHORIZATION_VALUE
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
    const recoverStaleAnalyticsHosts = async (): Promise<void> => {
      const processCensus = await readProcessCensus();
      if (!processCensus.complete) {
        appendPieLog('warn', 'analytics-handoff', 'stale-host recovery skipped; process census is incomplete', {
          reasonCodes: processCensus.reasons.map(({ code }) => code).slice(0, 16),
        });
        return;
      }
      const processById = new Map(processCensus.processes.map((entry) => [entry.processId, entry] as const));
      const recorderWorkers = processCensus.processes.filter(
        (entry) => entry.analyticsRecorderWorkerParentProcessId !== undefined,
      );
      let recoveredCount = 0;
      let cursor: string | undefined;
      while (true) {
        const page = analyticsHandoffRegistry.listAnalyticsHosts(analyticsWorkspaceId, {
          ...(cursor ? { cursor } : {}),
        });
        for (const host of page.hosts) {
          if (host.state === 'stopped') continue;
          const process = processById.get(host.processId);
          let registeredAtMs: bigint;
          try {
            registeredAtMs = BigInt(host.registeredAtMs);
          } catch {
            // Invalid lifecycle timestamps are not enough evidence to retire a
            // writer identity. Leave it in the census for explicit repair.
            continue;
          }
          const sameHostProcessIsLive = process !== undefined
            && (process.processCreatedAtMs === null
              || BigInt(process.processCreatedAtMs) <= registeredAtMs + 2_000n);
          const backendMayStillWrite = processCensus.backendOwners.some((owner) =>
            owner.hostProcessId === host.processId
            && (!owner.analyticsHostInstanceId || owner.analyticsHostInstanceId === host.hostInstanceId));
          // A recorder child may still be completing an admitted SQLite write
          // after its extension-host parent exits. Compare both process birth
          // times so PID reuse cannot confuse an old child with a new host.
          const recorderWorkerMayStillWrite = recorderWorkers.some((worker) => {
            if (worker.analyticsRecorderWorkerParentProcessId !== host.processId) return false;
            if (!process) return true;
            if (process.processCreatedAtMs === null || worker.processCreatedAtMs === null) return true;
            return worker.processCreatedAtMs < process.processCreatedAtMs;
          });
          if (sameHostProcessIsLive || backendMayStillWrite || recorderWorkerMayStillWrite) continue;
          try {
            analyticsHandoffRegistry.recoverAnalyticsHostAfterProcessExit({
              hostInstanceId: host.hostInstanceId,
              workspaceId: host.workspaceId,
              generationId: host.generationId,
              buildId: host.buildId,
              processId: host.processId,
            }, Date.now());
            recoveredCount += 1;
          } catch (error) {
            appendPieLog('warn', 'analytics-handoff', 'stale host could not be retired', {
              state: host.state,
              error: toErrorMessage(error),
            });
          }
        }
        if (!page.truncated || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      if (recoveredCount > 0) appendPieLog('info', 'analytics-handoff', 'retired stale writer hosts', { count: recoveredCount });
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
      recoverStaleHosts: recoverStaleAnalyticsHosts,
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
    const analyticsRuntime = new AnalyticsRuntime({
      stateDir: dataPaths.stateDir,
      analyticsDir: dataPaths.analyticsDir,
      recorderWorkerScript: path.join(this.platform.getRuntimeOutputDirectory(), 'analytics-recorder-worker.js'),
      queryWorkerScript: path.join(this.platform.getRuntimeOutputDirectory(), 'analytics-query-worker.js'),
      buildId: PIE_BUILD_ID,
      // The manifest identity is the qualification's coordinated build id; the
      // loaded marker above is the candidate space. Binding a source-equivalence
      // receipt makes those legitimately differ, so the startup check compares
      // in the manifest's space whenever a canonical generation is active.
      ...(canonicalActive ? { manifestBuildId: activationDescriptor!.buildId } : {}),
      workspaceId: analyticsWorkspaceId,
      processGeneration: analyticsProcessGeneration,
      activationSnapshot: activation,
      restartNonce: pendingControlledRestart?.restartNonce
        ?? (usesEnvironmentRestartEvidence ? envRestartNonce : null),
      terminalRestartReceiptPath: pendingControlledRestart?.terminalRestartReceiptPath
        ?? (usesEnvironmentRestartEvidence ? envRestartReceiptPath : undefined),
      loadedGenerationPath: pendingControlledRestart?.loadedGenerationPath,
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
        if (!sink) throw new Error('Canonical detail sink is not ready; activation has not completed.');
        sink.preflightDetail(value);
      },
      submit: (observation: AnalyticsObservation<object>) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical capture sink is not ready; activation has not completed.');
        return sink.submit(observation);
      },
      submitTracked: (
        observation: AnalyticsObservation<object>,
        onDisposition: (disposition: { status: 'durable' } | { status: 'rejected'; code: string; message: string }) => void,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical capture sink is not ready; activation has not completed.');
        sink.submitTracked(observation, onDisposition);
      },
      submitDetail: (capture: AnalyticsDetailCapture) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical detail sink is not ready; activation has not completed.');
        return sink.submitDetail(capture);
      },
      bindPendingCreate: (
        pendingOperationId: string,
        rootSessionId: string,
        sourceKey: string,
        timestampMs: number | string | bigint,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical lifecycle sink is not ready; activation has not completed.');
        return sink.bindPendingCreate(pendingOperationId, rootSessionId, sourceKey, timestampMs);
      },
      deleteSession: (
        rootSessionId: string,
        sourceKey: string,
        timestampMs: number | string | bigint,
        pendingOperationId?: string,
      ) => {
        const sink = analyticsRuntime.sink;
        if (!sink) throw new Error('Canonical lifecycle sink is not ready; activation has not completed.');
        return sink.deleteSession(rootSessionId, sourceKey, timestampMs, pendingOperationId);
      },
    };
    const analyticsTransport = canonicalActive
      ? new HostAnalyticsTransport({
          generationId: activationDescriptor!.generationId,
          buildId: activationDescriptor!.buildId,
          workspaceId: activationDescriptor!.workspaceId,
          backend,
          recorder: {
            submitTracked: (observation, onDisposition) => {
              const sink = analyticsRuntime.sink;
              if (!sink) throw new Error('Canonical capture sink is not ready; activation has not completed.');
              sink.submitTracked(observation, onDisposition);
            },
            submitTrackedDetail: (capture, onDisposition) => {
              const sink = analyticsRuntime.sink;
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
      () => this.analyticsRuntime.backendDescriptor(),
    );

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
        postImperative: (msg) => this.platform.renderer.postImperative(msg),
        postImperativeToRenderer: (rendererId, msg) =>
          this.platform.renderer.postImperativeToRenderer(rendererId, msg),
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
        setBrowserServerLanEnabled: (enabled) => this.setBrowserServerLanEnabled(enabled),
        setBrowserServerEnabled: (enabled) => this.setBrowserServerEnabled(enabled),
      },
    );

    this.browserServer = new BrowserServer({
      hostInstanceId: this.platform.renderer.getHostInstanceId(),
      getSettings: () => this.platform.getBrowserServerSettings(),
      getViewState: () => this.buildViewState(),
      getRunningSessionCount: () => this.archState.sessions.runningSessionPaths.length,
      routeMessage: (msg, context) => this.messageRouter.handle(msg, context),
      onRendererInvalidated: (rendererId, rendererGeneration) =>
        this.service.unsubscribeRendererDetails(rendererId, rendererGeneration),
      assetDir: path.join(this.platform.extensionPath, 'out', 'webview', 'panel'),
      rendererSelection: this.platform.getRendererSelection(),
      iconPath: path.join(this.platform.extensionPath, 'media', 'icon.svg'),
      titleSuffix: this.platform.getWorkspaceName(),
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
          const storedPrivateSessionPaths = this.platform.storage.get<unknown[]>(PRIVATE_SESSION_PATHS_STORAGE_KEY)
            ?.filter((sessionPath): sessionPath is string => typeof sessionPath === 'string' && sessionPath.length > 0)
            ?? [];
          const persistedPrivateSessionPaths = (privateSessionPaths ?? [
            ...new Set([...storedPrivateSessionPaths, ...activePrivateSessionPaths]),
          ]).filter((sessionPath) => !isPendingTabPath(sessionPath));
          try {
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
        postImperative: (message) => this.platform.renderer.postImperative(message as import('../../shared/protocol').HostToWebviewMessage),
      },
      modal: {
        // ShowModelSwitchConfirm: a modal host warning dialog. The reducer
        // owns the question text + confirm button label; the runner is a thin
        // executor. Resolves to the chosen label or undefined if dismissed.
        showWarningModal: (message, confirmChoice) =>
          this.platform.notifications.showModalConfirm(message, confirmChoice),
      },
      // M2 source-aware confirmation seam (§9): a BROWSER source confirms
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
        openFile: async (filePath) => {
          await this.platform.editor.openFileInEditor(filePath);
        },
      },
      service: this.service,
      statsService: this.statsService,
      dispatch: (event) => this.dispatchArchEvent(event),
      dispatchCommand: (event) => this.dispatchArchEvent(event),
      dispatchEvent: (event) => this.dispatchArchEvent(event),
    });
  }

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

  async start(): Promise<void> {
    this.reportStatus('Starting');
    await this.analyticsHandoffControl?.start();
    // Try canonical analytics before services can produce captures. A failed
    // analytics helper must not take down Pie's primary session/backend
    // harness; its capture closures remain fail-closed and never write to the
    // legacy authority. Keep startup evidence tied to a successful readiness
    // probe so a degraded host cannot claim canonical readiness.
    try {
      await this.analyticsRuntime.start();
      this.analyticsRuntime.recordLoadedGeneration();
    } catch (error) {
      const message = toErrorMessage(error);
      appendPieLog('warn', 'extension', 'analytics unavailable; continuing Pie startup without canonical capture', {
        error: message,
      });
      this.platform.notifications.showWarningMessage(
        'Pie started, but analytics is unavailable for this window. New analytics capture is paused; see Output > pie for the startup error.',
      );
    }
    this.hydratePrivacyMarkers();
    this.tokenRateService.start();
    this.aggregateStatsService.start();
    await this.statsService.start();
    await this.service.start();
    // M2 (§7.2): start the browser server only after the host can build a
    // valid initial `ViewState`. Backend readiness is a field in that state;
    // the HTTP shell does not wait for provider/backend startup.
    await this.browserServer.start();
    // A helper-issued nonce requests terminal cutover evidence. Write it only
    // after the complete host readiness sequence, including the browser
    // endpoint, has succeeded; ordinary boots remain marker-only.
    this.analyticsRuntime.recordTerminalRestartReceipt();
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

  /**
   * Project the CQRS `ArchState` into the `ViewState` consumed by the webview,
   * then merge in the host-side token-rate measurements for every running
   * session. The rate map is measured continuously by `TokenRateService`
   * (including for sessions that are not the active/selected tab); merging it
   * here keeps `selectViewState` itself pure (no service reads inside the
   * pure projection).
   */
  buildViewState(): ViewState {
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
        if (previousState.running) await this.browserServer.stop();
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
  async handleWebviewMessage(msg: WebviewToHostMessage): Promise<void> {
    await this.messageRouter.handle(msg);
  }

  /** Config-backed experiment assignment changed (host config listener). */
  notifyExperimentAssignmentChanged(): void {
    this.statsService.onExperimentAssignmentChanged(this.platform.getExperimentAssignment());
  }

  /** Lifecycle sink (§6.2): successful fallback binds are info-log-only;
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
      this.platform.renderer.postImperative({
        type: 'playCompletionSound',
        volume,
      });
    }

    this.platform.requestWindowAttention();
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
      // for the next host window immediately.
      this.browserServer.dispose();
      // Clear any pending timers first so they cannot fire into a torn-down
      // store / renderer after dispose.
      this.effectRunner.dispose();
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