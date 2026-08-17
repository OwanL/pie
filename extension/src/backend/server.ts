import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { rewritePieHarnessPrompt } from '../../../shared/pie-harness-prompt.js';
import { BoundedEventLoopHistogram } from '../shared/live-pipeline-trace';
import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../shared/error-message';
import { updateSettingsJsonObject } from '../shared/settings-json-update';
import {
  PROTOCOL_VERSION,
  type BusyChangedPayload,
  type ContextUsageChangedPayload,
  type ContextWindowUsage,
  type DetailResult,
  type LazyDetailRef,
  type MessageAbortedPayload,
  type ModelSettings,
  type RequestEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SessionSummary,
  type SystemPromptEntry,
  type ThinkingLevel,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { getDefaultAuthDir, ensureDir, isInsideGitWorkTree, migrateAuthFile } from './auth.js';
import { deriveContextUsageFromBranch } from './context-usage';
import { ExtensionUIBridge } from './extension-ui-bridge';
import { handleBackendRequest, parseLivePipelineToggleParams } from './request-handler';
import {
  validateDetailFetch,
  validateDetailSubscribe,
  validateDetailUnsubscribe,
  validateTruncateAfter,
  type DetailFetchParams,
  type DetailSubscribeParams,
  type DetailUnsubscribeParams,
} from './rpc';
import { backendSessionPathKey, resolveBackendSessionDir } from './session-directory';
import { handleSdkSessionEvent } from './session-event-handler';
import {
  buildCurrentSummary,
  loadAvailableModels,
  loadConfiguredModels,
  resolveActiveModel,
} from './session-metadata';
import { SessionCatalog } from './session-catalog';
import {
  ensureReviewsDir,
  getReviewSidecarFingerprint,
  hasActiveReviewClosureActions,
  startReviewWatcher,
} from './session-review-store';
import {
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from './system-prompt-toggle-store';
import { forgetPrivateSessionArtifacts } from './private-session-artifacts';
import {
  coordinatorSdkLoadMode,
  ensureSdkPatchBarrier,
  isFullSdkModule,
  loadSdk,
  loadSdkInternalModule,
  type ColdCoordinatorSdkModule,
  type SdkModule,
  type SdkSession,
  type SdkSessionEvent,
  type SdkSessionManager,
  type SdkSystemPromptModule,
} from './sdk';
import { ProviderGate } from './provider-gate.js';
import { CreateOperationLedger } from './create-operation-ledger';
import { observeProviderTransport } from './provider-progress-bus.js';
import { observeProviderIncidents, providerIncidentCode } from './provider-incident.js';
import { BackendError, extractRequestError, log, responseError, responseOk, writeStdout } from './server-io';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTraceHealth,
  isBackendLivePipelineTraceEnabled,
  recordBackendLivePipelineTrace,
  setBackendLivePipelineTraceEnabled,
} from './live-pipeline-trace-runtime';
import {
  type SessionContext,
  type SessionContextCreationReason,
  type SessionPromptState,
} from './server-types';
import {
  buildSessionSystemPrompts,
  buildToggledSystemPrompt,
  captureOriginalSystemPromptOptions,
  installAutonomousModeToolGuard,
  installSystemPromptToggleRebuildGuard,
  installSystemPromptToolToggleGuard,
  normalizePromptText,
  TOOLS_ENTRY_ID,
} from './system-prompts';
import { buildPagedTranscriptWindow } from './transcript-window';
import { createRuntimeFactory, ServiceLoadingGate } from './runtime-factory.js';
import { createSessionManagerFence } from './session-manager-fence';
import { installAuxiliaryLlmMeter } from './auxiliary-llm-meter';
import { backendTrace, backendError, backendInfo, backendWarn } from './log';
import {
  buildSessionOpenedPayload as buildSessionOpenedPayloadHelper,
  ensureDisplayTranscriptCache,
  normalizeDanglingTranscript,
} from './session-opened.js';
import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts.js';
import { findDurableDetail } from '../shared/lazy-details.js';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol.js';
import { ASK_USER_TOOL_NAME } from '../../../shared/autonomous-mode.js';
import { isPhase3IsolatedCoordinatorOperationAllowed, type RuntimeIsolationMode } from './runtime-isolation-mode';
import { ColdSessionStore, StaleColdSessionLeaseError, type ColdSessionManagerHandle } from './cold-session-store';
import { DurableDetailStore, type ResolvedDurableDetail } from './durable-detail-store';
import type { BackendDetailFence, LiveSubagentDetailAddress } from '../shared/protocol/subagent-detail';
import { WorkerSupervisor } from './worker-supervisor';
import { SessionOwnershipAuthority } from './session-ownership-authority';
import { WorkerRuntimeRouter } from './worker-runtime-router';
import type { WorkerJsonObject, WorkerJsonValue } from './worker-protocol';

const ISOLATED_PROMOTION_METHODS = new Set([
  'message.send',
  'message.compact',
  'systemPromptToggles.set',
]);

/** Live worker detail errors that mean the worker no longer retains the
 *  source and the durable JSONL is authoritative. */
function isLiveDetailGoneError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith('NOT_FOUND:') || error.message.startsWith('NOT_LIVE_ADDRESSABLE:'));
}

function requestSessionPath(params: unknown): string | undefined {
  return params && typeof params === 'object' && !Array.isArray(params)
    && typeof (params as { sessionPath?: unknown }).sessionPath === 'string'
    ? (params as { sessionPath: string }).sessionPath
    : undefined;
}

export function extractPreviewRequestId(preview: string): string | undefined {
  const match = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(preview);
  return match?.[1];
}

/** Simple stopwatch for backend timing probes. */
function timed<T>(label: string, op: () => T): T;
function timed<T>(label: string, op: () => Promise<T>): Promise<T>;
function timed<T>(label: string, op: () => T | Promise<T>): T | Promise<T> {
  const start = Date.now();
  const finish = (result: T | Promise<T>): T | Promise<T> => {
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
          return value;
        },
        (error) => {
          backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
          throw error;
        },
      );
    }
    backendTrace('timing', 'op.completed', { label, durationMs: Date.now() - start });
    return result;
  };
  try {
    return finish(op());
  } catch (error) {
    backendTrace('timing', 'op.failed', { level: 'warn', label, durationMs: Date.now() - start, error: toErrorMessage(error) });
    throw error;
  }
}

/** Module-level guard: install the fatal handlers at most once even if
 *  `start()` is invoked more than once. */
let backendFatalHandlersInstalled = false;
const SESSION_CATALOG_POLL_INTERVAL_MS = 10_000;
/** Grace bound for `runtime.dispose()` during replacement and shutdown. A
 *  provider teardown can wedge an SDK runtime; disposal is bounded best-effort
 *  so it can never block recovery or shutdown. Shared by `createSessionContext`
 *  (replacement) and `dispose()` (shutdown) so the bound stays consistent.
 *  `PIE_RUNTIME_DISPOSE_GRACE_MS` overrides the bound (mirroring
 *  `PIE_WILLRETRY_WATCHDOG_GRACE_MS`) so disposal-bound tests need not wait the
 *  full production window. */
function resolveRuntimeDisposeGraceMs(): number {
  const override = Number(process.env.PIE_RUNTIME_DISPOSE_GRACE_MS);
  return Number.isFinite(override) && override > 0 ? override : 5_000;
}

/** Timer seam for the bounded runtime-disposal policy. The production
 * scheduler uses ordinary unref'd timers; tests can advance the grace window
 * without waiting on wall-clock time. */
export interface RuntimeDisposeScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface PreparedViewedSessionTransition {
  changed: boolean;
  revision: number;
  hadPrevious: boolean;
  previous?: string;
}

const defaultRuntimeDisposeScheduler: RuntimeDisposeScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function disposeRuntimeBounded(
  runtime: Pick<SessionContext['runtime'], 'dispose'>,
  sessionPath: string | undefined,
  scheduler: RuntimeDisposeScheduler,
): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = scheduler.setTimeout(resolve, resolveRuntimeDisposeGraceMs());
    (graceTimer as { unref?: () => void }).unref?.();
  });
  let dispose: Promise<void>;
  try {
    dispose = Promise.resolve(runtime.dispose());
  } catch (error) {
    backendWarn('backend-session', 'session runtime dispose threw', {
      ...(sessionPath ? { sessionPath } : {}),
      error: toErrorMessage(error),
    });
    dispose = Promise.resolve();
  }
  return Promise.race([dispose, grace])
    .catch((error) => {
      backendWarn('backend-session', 'session runtime dispose failed', {
        ...(sessionPath ? { sessionPath } : {}),
        error: toErrorMessage(error),
      });
    })
    .finally(() => {
      if (graceTimer) scheduler.clearTimeout(graceTimer);
    });
}

/** Surface swallowed promise rejections and uncaught exceptions on stderr (the
 *  host captures backend stderr) instead of letting them die invisibly. We
 *  deliberately do NOT `process.exit` — the host's backend-exit detection
 *  owns crash handling; this only prevents silent invisibility. */
function installBackendFatalHandlers(): void {
  if (backendFatalHandlersInstalled) return;
  backendFatalHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? String(reason.stack ?? reason) : String(reason);
    backendError('backend', 'unhandledRejection', { error });
  });
  process.on('uncaughtException', (err) => {
    const error = err instanceof Error ? String(err.stack ?? err) : String(err);
    backendError('backend', 'uncaughtException', { error });
  });
  // Node's default warning text omits the creation stack in normal runs. Keep a
  // structured copy so listener leaks and deprecations point to the call site
  // that created them rather than only reporting the final listener count.
  process.on('warning', (warning) => {
    backendWarn('backend', 'process.warning', {
      warningName: warning.name,
      message: warning.message,
      stack: warning.stack,
      listenerCounts: {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
        exit: process.listenerCount('exit'),
        warning: process.listenerCount('warning'),
      },
    });
  });
}

export class BackendServer {
  private sdk!: SdkModule | ColdCoordinatorSdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  /** Host-authoritative generation shared by backend, coordinator, worker, and detail fences. */
  private readonly backendGeneration: number;
  private sessionDir?: string;
  private sessionDirResolved = false;
  private agentDir = '';
  private authStorage: unknown;
  private viewedSessionPath?: string;
  /** Monotonic fence preventing a slow session.open from overwriting a newer
   * host-local visual transition after its durable read completes. */
  private viewedSessionRevision = 0;
  /** Process-wide user preference mirrored by runtimePrefs.set. */
  private autonomousMode = false;
  private runtimePrefs: WorkerJsonObject = {};
  private readonly sessionContexts = new Map<string, SessionContext>();
  private readonly sessionCatalog: SessionCatalog;
  /** One runtime-free store is installed after SDK load and shares the
   * coordinator generation/catalog/settings authority. */
  private coldSessionStore?: ColdSessionStore;
  /** Newly created/forked/truncated managers remain process-local and are
   * transferred exactly once on first legacy promotion. Keys are normalized
   * only for ownership lookup; public paths retain their original spelling. */
  private readonly coldSessionManagerHandles = new Map<string, {
    handle: ColdSessionManagerHandle;
    creationReason: SessionContextCreationReason;
  }>();
  /** Cold destructive mutations reserve their path before the first await so
   * promotion cannot install a writer while truncate/forget owns the file. */
  private readonly pendingColdSessionMutations = new Map<string, Promise<unknown>>();
  /** Deduplicates concurrent lazy promotions for the same cold session. */
  private readonly pendingSessionContexts = new Map<string, Promise<SessionContext>>();
  /** Generation owner recorded on snapshots built through the public browse
   * path. Publication uses it to replace a payload superseded after its final
   * awaited ownership check. Transition-internal hydration payloads bypass it. */
  private readonly sessionOpenedPayloadOwners = new WeakMap<object, SessionContext | undefined>();
  /** Non-serialized generation stamp checked synchronously at correlated stdout
   * publication, after the request handler's final await has unwound. */
  private readonly browseResponseOwners = new WeakMap<object, {
    sessionPath: string;
    owner?: SessionContext;
    fingerprint?: string;
  }>();
  /** Predecessor captured when a cold session first becomes viewed. Promotion
   * consumes this immutable identity instead of rereading viewedSessionPath. */
  private readonly browsePreviousSessionFiles = new Map<string, string | undefined>();
  /** Paths currently being forgotten; prevents a racing open from installing
   *  a runtime after its transcript has been removed. */
  private readonly forgottenSessionPaths = new Set<string>();
  /** Serializes prompt persistence and live prompt rebuilds for each session. */
  private readonly pendingSystemPromptToggleApplications = new Map<string, Promise<void>>();
  private systemPromptModulePromise?: Promise<SdkSystemPromptModule>;
  /** Disposer for the session-review sidecar watcher (see `startReviewWatcher`). */
  private stopReviewWatcher?: () => void;
  private sessionCatalogPollTimer?: ReturnType<typeof setInterval>;
  private sessionCatalogPollingActive = false;
  private sessionCatalogPollInFlight = false;
  /** Last cheap snapshot of the append-only review/closure files. Used by the
   * catalog poll to recover when fs.watch drops or coalesces an event. */
  private reviewSidecarFingerprint = getReviewSidecarFingerprint();
  /** Auth-file fingerprint baseline; a moved fingerprint refreshes workers. */
  private authFingerprint = '';
  /** models.json fingerprint baseline; a moved fingerprint re-broadcasts the
   *  configured catalog authority to hot workers. */
  private modelsJsonFingerprint = '';
  /** Cached active-action state belongs to `reviewSidecarFingerprint`; an
   * unchanged poll must not synchronously reparse the growing sidecars. */
  private reviewClosureReconciliationPending = false;
  private stopProviderProgressObserver?: () => void;
  private stopProviderIncidentObserver?: () => void;
  /** Captures request+turn ownership at an attempt's first synchronous gate
   * observation so a late acquisition cannot be charged to a newer request. */
  private readonly providerAttemptOwners = new Map<string, {
    context: SessionContext;
    requestId: string;
    turnSequence: number;
    retryId?: string;
  }>();

  /** True once `dispose()` has begun. Suppresses stale events and payload
   *  builds from in-flight async paths (recovery replacement emissions, catalog
   *  polling, late SDK events) so a dying backend cannot push post-shutdown
   *  state to a host that is already tearing it down. */
  private disposed = false;
  /** All shutdown callers join one teardown. A second EOF/watchdog signal must
   * not observe `disposed` and exit while the first caller still owns workers. */
  private disposePromise?: Promise<void>;
  /** Backend-wide FIFO admission gate for `sdk.createAgentSessionServices`;
   *  shared by every runtime-factory invocation this server creates (all
   *  sessions/cwds). Service creation is serialized so concurrent session
   *  opens cannot saturate the process during an active generation; results
   *  are never cached or shared — each admitted call creates fresh services. */
  private readonly serviceLoadingGate = new ServiceLoadingGate();
  /** Generation/process-scoped create-operation ledger (§6.3): dedupes
   *  concurrent/retried `session.create`/`session.duplicate` by the optional
   *  host-generated `operationId` and retains in-flight and completed durable
   *  results for this backend generation. A backend restart (generation
   *  death) naturally drops the ledger with the process. */
  private readonly createOperationLedger = new CreateOperationLedger();
  private readonly runtimeDisposeScheduler: RuntimeDisposeScheduler;
  private readonly runtimeIsolationMode: RuntimeIsolationMode;
  private readonly workerEntryPath?: string;
  private workerSupervisor?: WorkerSupervisor;
  private sessionOwnershipAuthority?: SessionOwnershipAuthority;
  private workerRuntimeRouter?: WorkerRuntimeRouter;
  private durableDetailStore?: DurableDetailStore;
  private authPath = '';
  private hostWatchdogTimer?: ReturnType<typeof setInterval>;
  private readonly hostPid?: number;
  private eventLoopDelayMonitor?: ReturnType<typeof monitorEventLoopDelay>;
  private eventLoopHistogram?: BoundedEventLoopHistogram;
  private eventLoopDelayTimer?: ReturnType<typeof setInterval>;
  private eventLoopNextSampleAt?: number;
  /** Request identities whose successful diagnostics off transition must be
   * completed by handleLine after its matching handler_finished record. Each
   * entry also owns the one monitor callback for that transition. */
  private readonly pendingLivePipelineTraceDisables = new Map<string, {
    generation: number;
    onApplied: () => void;
  }>();
  /** Monotonic diagnostics-toggle generation. Advanced once per received
   * toggle request (on or off) at request receipt, so concurrent requests are
   * ordered by receipt, not settlement. A newer request supersedes older
   * deferred off requests without allowing their completion to turn the
   * global trace back off. */
  private livePipelineTraceToggleGeneration = 0;

  constructor(options: {
    sdkPath: string;
    cwd: string;
    backendGeneration?: number;
    hostPid?: number;
    runtimeDisposeScheduler?: RuntimeDisposeScheduler;
    runtimeIsolationMode?: RuntimeIsolationMode;
    workerEntryPath?: string;
    /** Test seam for causally blocking a cold catalog operation at the public
     * JSONL/writer boundary. Production always constructs the default. */
    sessionCatalog?: SessionCatalog;
  }) {
    this.sdkPath = options.sdkPath;
    this.startupCwd = options.cwd;
    this.backendGeneration = options.backendGeneration ?? 1;
    if (!Number.isSafeInteger(this.backendGeneration) || this.backendGeneration <= 0) {
      throw new Error('backendGeneration must be a positive safe integer.');
    }
    this.hostPid = options.hostPid;
    this.runtimeDisposeScheduler = options.runtimeDisposeScheduler ?? defaultRuntimeDisposeScheduler;
    this.runtimeIsolationMode = options.runtimeIsolationMode ?? 'legacy';
    this.workerEntryPath = options.workerEntryPath;
    this.sessionCatalog = options.sessionCatalog ?? new SessionCatalog();
    if (this.runtimeIsolationMode === 'isolated' && !this.workerEntryPath) {
      throw new Error('Isolated session runtime mode requires a bundled worker entry path.');
    }
  }

  private getSessionDir(): string | undefined {
    if (!this.sessionDirResolved) {
      this.sessionDir = resolveBackendSessionDir(
        this.agentDir,
        process.env.PI_CODING_AGENT_SESSION_DIR,
      );
      this.sessionDirResolved = true;
    }
    return this.sessionDir;
  }

  private initializeColdSessionStore(): ColdSessionStore {
    this.coldSessionStore ??= new ColdSessionStore({
      sdk: this.sdk,
      coordinatorGeneration: this.backendGeneration,
      startupCwd: this.startupCwd,
      agentDir: this.agentDir,
      sessionDir: this.getSessionDir(),
      sessionCatalog: this.sessionCatalog,
    });
    return this.coldSessionStore;
  }

  private coldManagerKey(sessionPath: string): string {
    return backendSessionPathKey(sessionPath);
  }

  private retainColdSessionManager(
    handle: ColdSessionManagerHandle,
    creationReason: SessionContextCreationReason,
  ): void {
    const key = this.coldManagerKey(handle.sessionPath);
    if (this.coldSessionManagerHandles.has(key)) {
      throw new BackendError('SESSION_OWNERSHIP_CONFLICT', `A cold manager is already retained for ${handle.sessionPath}.`);
    }
    this.coldSessionManagerHandles.set(key, { handle, creationReason });
  }

  private assertColdCoordinatorOwner(sessionPath: string): void {
    if (this.getSessionContext(sessionPath) || this.getPendingSessionContext(sessionPath)) {
      throw new BackendError(
        'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
        `Session ${sessionPath} has a hot or promoting owner; Phase 4 isolated-runtime routing is unavailable.`,
      );
    }
  }

  private async runColdSessionMutation<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
    const key = this.coldManagerKey(sessionPath);
    if (this.pendingColdSessionMutations.has(key)) {
      throw new BackendError('SESSION_OWNERSHIP_CONFLICT', `A cold mutation is already active for ${sessionPath}.`);
    }
    const pending = Promise.resolve().then(operation);
    this.pendingColdSessionMutations.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingColdSessionMutations.get(key) === pending) {
        this.pendingColdSessionMutations.delete(key);
      }
    }
  }

  private registerColdResult(result: object): void {
    const stamp = this.initializeColdSessionStore().ownershipStamp(result)?.[0];
    if (stamp) {
      this.browseResponseOwners.set(result, {
        sessionPath: stamp.sessionPath,
        fingerprint: stamp.fingerprint,
      });
    }
  }

  async start(): Promise<void> {
    // Install fatal handlers first so even an early spawn-time rejection is
    // surfaced. Idempotent (module-level guard).
    installBackendFatalHandlers();
    if (this.runtimeIsolationMode === 'isolated') {
      // Phase 2 creates the generation-scoped supervisor and verifies the stable
      // worker artifact. Hot operations fail closed below until Phase 4 routing;
      // they must never fall through to this process's legacy runtime path. The
      // coordinator owns the patching barrier and workers only validate it.
      const sdkPatchIdentity = await ensureSdkPatchBarrier(this.sdkPath);
      this.workerSupervisor = new WorkerSupervisor({
        workerEntryPath: this.workerEntryPath!,
        coordinatorGeneration: this.backendGeneration,
        sdkPatchIdentity,
        onWorkerStateChange: (rootSessionPath, snapshot, identity) => {
          void this.workerRuntimeRouter?.handleWorkerStateChange(rootSessionPath, snapshot, identity).catch((error) => {
            backendError('backend-worker', 'runtime state reconciliation failed', {
              rootSessionPath,
              error: toErrorMessage(error),
            });
          });
        },
        onWorkerFrame: (rootSessionPath, frame) => {
          void this.workerRuntimeRouter?.handleWorkerFrame(rootSessionPath, frame).catch((error) => {
            backendError('backend-worker', 'runtime frame failed', {
              rootSessionPath,
              error: toErrorMessage(error),
            });
          });
        },
        onDiagnostic: (rootSessionPath, stream, tail) => {
          backendError('backend-worker', `worker ${stream}`, { rootSessionPath, tail });
        },
      });
      await this.workerSupervisor.initialize();
    }
    const sdkStartedAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'start',
      phase: 'sdk_import',
      processRole: 'coordinator',
      pid: process.pid,
    });
    try {
      await timed('start.loadSdk', async () => {
        this.sdk = await loadSdk(
          this.sdkPath,
          coordinatorSdkLoadMode(this.runtimeIsolationMode === 'isolated'),
        );
        this.agentDir = this.sdk.getAgentDir();
        this.getSessionDir();
        this.initializeColdSessionStore();
      });
    } catch (error) {
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'failure',
        phase: 'sdk_import',
        durationMs: Math.max(0, performance.now() - sdkStartedAt),
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
      throw error;
    }
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'success',
      phase: 'sdk_import',
      durationMs: Math.max(0, performance.now() - sdkStartedAt),
      processRole: 'coordinator',
      pid: process.pid,
    });

    // Install the host-side provider gate BEFORE any session runtime is
    // created. The gate wraps globalThis.fetch to enforce per-provider
    // concurrency, afterburn sticky slots, stream-liveness, and circuit
    // breaking — replacing the LiteLLM proxy. Configs are read from
    // models.json (in agentDir) which is generated by sync-models from
    // models.yaml providers.<p>.concurrency.
    await timed('start.providerGate', async () => {
      try {
        const modelsJsonPath = path.join(this.agentDir, 'models.json');
        const raw = await fs.readFile(modelsJsonPath, 'utf8');
        const modelsJson = JSON.parse(raw);
        const configs = ProviderGate.resolveConfigs(modelsJson);
        // Install whenever at least one provider ships a concurrency block.
        // The gate matches outbound requests by each config's `baseUrl`, so
        // only providers in `configs` are gated; user overrides via
        // runtimePrefs.set reconfigure the live gate in place (no restart).
        if (configs.length > 0) {
          ProviderGate.install(configs, 120);
        }
      } catch (error) {
        // Non-fatal: if models.json is missing or unreadable, the gate is
        // simply not installed — requests go direct (no concurrency cap).
        backendInfo('backend', 'providerGate.notInstalled', { error: (error as Error).message });
      }
    });

    this.stopProviderProgressObserver = observeProviderTransport((observation) => {
      const currentContext = [...this.sessionContexts.values()].find((candidate) =>
        candidate.session.sessionManager.getSessionId?.() === observation.sessionId,
      );
      const currentRequest = currentContext?.activeRequest;
      let owner = this.providerAttemptOwners.get(observation.attemptId);
      if (!owner && (observation.kind === 'gate_queue' || observation.kind === 'gate_acquired')
        && currentContext && currentRequest && currentRequest.providerTurnSequence !== undefined) {
        owner = {
          context: currentContext,
          requestId: currentRequest.id,
          turnSequence: currentRequest.providerTurnSequence,
          retryId: currentRequest.retryTiming?.retryId,
        };
        this.providerAttemptOwners.set(observation.attemptId, owner);
      }

      const ownerRequest = owner?.context.activeRequest;
      const ownsCurrentRequest = owner !== undefined && ownerRequest?.id === owner.requestId;
      if (owner && ownerRequest?.id === owner.requestId) {
        if (owner.retryId !== undefined
          && ownerRequest.retryTiming?.retryId === owner.retryId
          && ownerRequest.retryTiming.providerAttemptStartedAt === undefined
          && (observation.kind === 'gate_queue' || observation.kind === 'gate_acquired')) {
          ownerRequest.retryTiming.providerAttemptStartedAt = observation.occurredAt;
        }
        if (observation.kind === 'gate_acquired'
          && typeof observation.queueDurationMs === 'number'
          && Number.isFinite(observation.queueDurationMs)) {
          const queueByTurn = ownerRequest.providerQueueByTurn ?? new Map();
          const previous = queueByTurn.get(owner.turnSequence) ?? { durationMs: 0, attemptCount: 0 };
          queueByTurn.set(owner.turnSequence, {
            durationMs: previous.durationMs + Math.max(0, Math.trunc(observation.queueDurationMs)),
            attemptCount: previous.attemptCount + 1,
          });
          ownerRequest.providerQueueByTurn = queueByTurn;
        }
      }
      if (observation.kind === 'gate_rejected' || observation.kind === 'headers_received'
        || observation.kind === 'transport_terminal' || observation.kind === 'transport_error') {
        this.providerAttemptOwners.delete(observation.attemptId);
      }

      const context = owner?.context ?? currentContext;
      const accumulator = ownsCurrentRequest ? ownerRequest.liveTurnAccumulator : undefined;
      const checkpointSeq = accumulator?.currentSeq ?? 0;
      if (context && accumulator && checkpointSeq > 0) {
        if (observation.kind === 'gate_queue') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'queued', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        } else if (observation.kind === 'headers_wait' || observation.kind === 'headers_received') {
          this.emit('live.semantic', accumulator.observe({ kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: 120_000 }, observation.occurredAt));
        }
      }
      if (context && isBackendLivePipelineTraceEnabled()) {
        recordBackendLivePipelineTrace({
          stage: 'provider.phase.transition',
          kind: 'transition',
          identifiers: {
            session: context.sessionPath,
            ...(ownsCurrentRequest && owner ? { request: owner.requestId } : {}),
            attempt: observation.attemptId,
          },
          phase: observation.kind === 'gate_queue'
            ? 'provider_gate_queue'
            : observation.kind === 'headers_wait'
              ? 'headers'
              : observation.kind === 'headers_received'
                ? 'pre_first_semantic'
                : observation.kind === 'raw_chunk'
                  ? 'semantic_stream'
                  : 'terminal',
        });
      }
    });

    this.stopProviderIncidentObserver = observeProviderIncidents((incident) => {
      const context = [...this.sessionContexts.values()].find((candidate) =>
        candidate.session.sessionManager.getSessionId?.() === incident.sessionId,
      );
      const active = context?.activeRequest;
      if (!context || !active) return;

      active.latestProviderIncident = incident;
      active.lastProviderErrorForDiagnostics = incident.userMessage;
      const noticeKey = [
        incident.kind,
        incident.providerHost,
        incident.status ?? '',
        incident.retryAt ?? '',
      ].join(':');
      const emitted = active.providerIncidentNoticeKeys ?? new Set<string>();
      active.providerIncidentNoticeKeys = emitted;
      if (!emitted.has(noticeKey)) {
        emitted.add(noticeKey);
        this.emit('operational-error', {
          incidentId: `provider:${active.id}:${noticeKey}`,
          code: providerIncidentCode(incident.kind),
          message: incident.userMessage,
          detail: incident.detail,
          sessionPath: context.sessionPath,
          requestId: active.id,
        });
      }

      // A terminal quota response cannot recover by waiting on the same
      // provider. Give the SDK a short window to publish its normal terminal
      // message, then fence/replace the runtime if it remains busy. This turns
      // hidden SDK backoff into a bounded, explicit failure.
      if (incident.kind === 'quota_exhausted' && !active.quotaSettlementTimer) {
        const requestId = active.id;
        active.quotaSettlementTimer = setTimeout(() => {
          const current = context.activeRequest;
          if (current?.id !== requestId || current.latestProviderIncident?.kind !== 'quota_exhausted') return;
          this.recoverStuckSession(context, current.latestProviderIncident.userMessage);
        }, 15_000);
        active.quotaSettlementTimer.unref?.();
      }
    });

    const authDir = process.env.PI_CODING_AGENT_AUTH_DIR?.trim();
    let authPath = '';

    await timed('start.authSetup', async () => {
      if (authDir) {
        // Explicit override — use as-is.
        authPath = path.resolve(authDir, 'auth.json');
      } else {
        // Default: check if agentDir is inside a git tree.
        const agentDirAuthPath = path.resolve(this.agentDir, 'auth.json');
        if (await isInsideGitWorkTree(agentDirAuthPath)) {
          const allowInTree = process.env.PIE_ALLOW_IN_TREE_AUTH === '1';
          if (allowInTree) {
            authPath = agentDirAuthPath;
          } else {
            // Auto-resolve to platform-standard safe location.
            const safeDir = getDefaultAuthDir();
            authPath = path.resolve(safeDir, 'auth.json');
            // Migrate existing in-tree auth.json to the safe location.
            await migrateAuthFile(agentDirAuthPath, authPath);
          }
        } else {
          authPath = agentDirAuthPath;
        }
      }

      // Ensure the auth directory exists so the SDK can write to it.
      await ensureDir(path.dirname(authPath));

      this.authPath = authPath;
      this.authStorage = this.sdk.AuthStorage.create(authPath);
    });

    if (this.runtimeIsolationMode === 'isolated') {
      const coldStore = this.initializeColdSessionStore();
      this.sessionOwnershipAuthority = new SessionOwnershipAuthority({
        coldLeaseAuthority: coldStore.leases,
      });
      this.durableDetailStore = new DurableDetailStore({
        resolve: (sessionPath, address, durableRef) => this.resolveDurableDetail(sessionPath, address, durableRef),
        emit: (message) => {
          this.emit('detail.stream', message as unknown as WorkerJsonObject);
          return true;
        },
      });
      this.workerRuntimeRouter = new WorkerRuntimeRouter({
        supervisor: this.workerSupervisor!,
        coordinatorGeneration: this.backendGeneration,
        coldStore,
        ownership: this.sessionOwnershipAuthority,
        emit: (event, payload) => this.emit(event, payload),
        emitDetail: (message) => this.emit('detail.stream', message as unknown as WorkerJsonObject),
        onSessionReplaced: (sourcePath, destinationPath) => {
          if (this.viewedSessionPath && backendSessionPathKey(this.viewedSessionPath) === backendSessionPathKey(sourcePath)) {
            this.recordViewedSessionTransition(destinationPath, sourcePath);
            this.setViewedSessionPath(destinationPath);
          }
        },
        writeModelSettings: (updates) => this.writeModelSettings(updates),
        readModelSettings: () => this.readModelSettings(),
        readRuntimePrefs: () => ({ ...this.runtimePrefs }),
        buildPromotionSnapshot: async (sessionPath) => {
          const retainedKey = this.coldManagerKey(sessionPath);
          const retained = this.coldSessionManagerHandles.get(retainedKey);
          const exactSessionPath = retained?.handle.sessionPath ?? sessionPath;
          const openedPayload = await this.buildSessionOpenedPayload(exactSessionPath, undefined, 'tail');
          return {
            sdkPath: this.sdkPath,
            agentDir: this.agentDir,
            startupCwd: this.startupCwd,
            sessionDir: this.getSessionDir() ?? path.join(this.agentDir, 'sessions'),
            openedPayload,
            modelSettings: await this.readModelSettings(),
            creationReason: retained?.creationReason ?? 'resume',
            exactSessionPath,
            runtimePrefs: { ...this.runtimePrefs },
            commitPromotion: () => {
              if (retained && this.coldSessionManagerHandles.get(retainedKey) === retained) {
                this.coldSessionManagerHandles.delete(retainedKey);
                coldStore.retireHandle(retained.handle);
              }
            },
            abortPromotion: () => {
              if (retained && this.coldSessionManagerHandles.get(retainedKey) === retained) {
                coldStore.refreshHandle(retained.handle);
              }
            },
            authPath: this.authPath || path.join(this.agentDir, 'auth.json'),
            authFingerprint: await fs.stat(this.authPath || path.join(this.agentDir, 'auth.json'))
              .then((stat) => `${stat.size}:${stat.mtimeMs}`)
              .catch(() => 'missing'),
          };
        },
      });
      this.authFingerprint = await fs.stat(this.authPath || path.join(this.agentDir, 'auth.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');
      this.modelsJsonFingerprint = await fs.stat(path.join(this.agentDir, 'models.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');
    }

    // Attach the stdin reader BEFORE emitting backend.ready so that any
    // request the client sends immediately after receiving ready is captured,
    // rather than racing with reader attachment.
    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      void this.handleLine(line);
    }, {
      maxLineBytes: JSONL_MAX_LINE_BYTES,
      onOverflow: ({ maxLineBytes, preview }) => {
        const requestId = extractPreviewRequestId(preview);
        log(JSON.stringify({
          level: 'error',
          event: 'protocol.stdin-overflow',
          maxLineBytes,
          requestId: requestId ?? null,
          preview,
        }));
        if (requestId) {
          writeStdout(responseError(
            requestId,
            'REQUEST_TOO_LARGE',
            `Request exceeds the ${maxLineBytes}-byte JSONL transport limit.`,
          ));
        }
      },
    });

    process.stdin.on('end', () => {
      detachReader();
      void this.dispose().then(
        () => process.exit(0),
        (error) => { log(`backend disposal failed closed: ${toErrorMessage(error)}`); process.exitCode = 1; },
      );
    });

    this.startHostWatchdog();
    // The event-loop monitor is diagnostics-only: it must not run (native
    // histogram + interval sampling) while the live-pipeline trace is
    // disabled. The toggle handler restarts it when diagnostics are enabled.
    if (isBackendLivePipelineTraceEnabled()) {
      this.startEventLoopMonitor();
    }

    // Record readiness before publishing the public event. The trace therefore
    // cannot claim readiness after a host has already observed it.
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'success',
      phase: 'backend_mapping',
      readiness: 'ready',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.emit('backend.ready', {
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      backendGeneration: this.backendGeneration,
      sdkVersion: this.sdk.VERSION,
      protocolVersion: PROTOCOL_VERSION,
      authPath,
    });

    this.startReviewReconciliation();
  }

  /** Opt-in packaged-artifact probe through the real cold store, promotion
   * router, full worker SDK/runtime, command transport, and retirement. */
  async runPhase2WorkerSmoke(_sessionPath: string): Promise<void> {
    if (this.runtimeIsolationMode !== 'isolated' || !this.workerRuntimeRouter) {
      throw new Error('Worker promotion smoke requires an initialized isolated coordinator.');
    }
    const store = this.initializeColdSessionStore();
    const handle = store.create({ cwd: this.startupCwd });
    const switchTarget = store.create({ cwd: this.startupCwd });
    (switchTarget.manager as typeof switchTarget.manager & {
      appendCustomEntry(customType: string, data?: unknown): string;
    }).appendCustomEntry('phase4-switch-fork-source', { durable: true });
    this.retainColdSessionManager(handle, 'new');
    this.retainColdSessionManager(switchTarget, 'new');
    const commandResultPath = process.env.PIE_PHASE4_EXTENSION_FIXTURE_RESULT;
    if (!commandResultPath) throw new Error('Packaged extension replacement smoke requires PIE_PHASE4_EXTENSION_FIXTURE_RESULT.');
    await fs.rm(commandResultPath, { force: true });
    const first = await this.workerRuntimeRouter.promote(handle.sessionPath);
    let currentPath = handle.sessionPath;
    try {
      await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-promotion-smoke',
        method: 'models.list',
        params: { sessionPath: handle.sessionPath },
      });
      await this.handleRequest({
        id: 'packaged-worker-prefs-smoke',
        method: 'runtimePrefs.set',
        params: { providerToggles: {}, extensionToggles: {}, autonomousMode: true },
      });
      const beforeSettings = await this.readModelSettings();
      const nextThinkingLevel: ThinkingLevel = beforeSettings.defaultThinkingLevel === 'low' ? 'medium' : 'low';
      const updatedSettings = await this.handleRequest({
        id: 'packaged-worker-settings-smoke',
        method: 'settings.set',
        params: { sessionPath: handle.sessionPath, defaultThinkingLevel: nextThinkingLevel },
      }) as ModelSettings;
      if (updatedSettings.defaultThinkingLevel !== nextThinkingLevel
        || (await this.readModelSettings()).defaultThinkingLevel !== nextThinkingLevel) {
        throw new Error('Session-scoped worker settings mutation did not commit through the coordinator.');
      }
      const waitForCommandResult = async <T>(label: string): Promise<T> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            return JSON.parse(await fs.readFile(commandResultPath, 'utf8')) as T;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        }
        throw new Error(`Timed out waiting for packaged extension command result: ${label}`);
      };
      const dispatchNoAgentExtensionCommand = async (sessionPath: string): Promise<void> => {
        await fs.rm(commandResultPath, { force: true });
        const encodedResultPath = Buffer.from(commandResultPath).toString('base64url');
        const result = await this.workerRuntimeRouter!.routeExisting({
          id: 'packaged-worker-public-no-agent-command',
          method: 'message.send',
          params: { sessionPath, text: `/phase4-no-agent ${encodedResultPath}`, inputs: [] },
        }) as { requestId?: string };
        if (typeof result.requestId !== 'string') {
          throw new Error('Packaged public no-agent extension command did not receive an early acknowledgement.');
        }
        const completed = await waitForCommandResult('no-agent');
        if (!completed || typeof (completed as { sessionPath?: unknown }).sessionPath !== 'string') {
          throw new Error('Packaged no-agent extension command returned an invalid result.');
        }
      };
      await dispatchNoAgentExtensionCommand(currentPath);

      const sourcePaths: string[] = [];
      const dispatchExtensionReplacement = async (
        action: 'new' | 'switch' | 'fork',
        sourcePath: string,
        switchPath?: string,
      ): Promise<string> => {
        await fs.rm(commandResultPath, { force: true });
        const encodedArgs = Buffer.from(JSON.stringify({ action, resultPath: commandResultPath, switchPath }))
          .toString('base64url');
        const result = await this.workerRuntimeRouter!.routeExisting({
          id: `packaged-worker-public-extension-command:${action}`,
          method: 'message.send',
          params: { sessionPath: sourcePath, text: `/phase4-replace ${encodedArgs}`, inputs: [] },
        }) as { requestId?: string };
        if (typeof result.requestId !== 'string') {
          throw new Error(`Packaged public ${action} extension command did not receive an early acknowledgement.`);
        }
        const replacement = await waitForCommandResult(action) as {
          action: string;
          sourcePath: string;
          finalPath: string;
        };
        if (replacement.action !== action || typeof replacement.sourcePath !== 'string'
            || typeof replacement.finalPath !== 'string') {
          throw new Error(`Packaged extension command returned an invalid ${action} replacement result.`);
        }
        sourcePaths.push(replacement.sourcePath);
        return replacement.finalPath;
      };
      currentPath = await dispatchExtensionReplacement('new', currentPath);
      currentPath = await dispatchExtensionReplacement('switch', currentPath, switchTarget.sessionPath);
      currentPath = await dispatchExtensionReplacement('fork', currentPath);
      await fs.writeFile(commandResultPath, JSON.stringify({ sourcePaths, finalPath: currentPath }));
      const destinationRoute = this.workerRuntimeRouter.getRoute(currentPath);
      if (destinationRoute.state !== 'hot' || destinationRoute.owner.workerId !== first.owner.workerId) {
        throw new Error('Extension replacement destination was not rekeyed to the initiating coordinator owner.');
      }
      const destinationOwnership = await this.sessionOwnershipAuthority!.inspect(currentPath);
      if (destinationOwnership?.state !== 'hot'
          || destinationOwnership.owner.workerId !== first.owner.workerId
          || !destinationOwnership.transferConsumed) {
        throw new Error('Extension replacement destination did not reach consumed hot ownership.');
      }
      const durableDestination = await fs.readFile(currentPath, 'utf8');
      if (!durableDestination.includes('phase4-extension-durable')) {
        throw new Error('Extension replacement destination marker was not durable before command completion.');
      }
      for (const releasedPath of [...new Set(sourcePaths)]) {
        if (releasedPath === currentPath) continue;
        if (this.workerRuntimeRouter.getRoute(releasedPath).state !== 'cold') {
          throw new Error(`Extension replacement source was not released as cold: ${releasedPath}`);
        }
        const reused = await this.workerRuntimeRouter.promote(releasedPath);
        if (reused.owner.workerId === first.owner.workerId) {
          throw new Error('Released extension replacement source was not reusable by an independent worker.');
        }
        await this.workerRuntimeRouter.routeExisting({
          id: `packaged-worker-source-reuse:${releasedPath}`,
          method: 'models.list',
          params: { sessionPath: releasedPath },
        });
        await this.workerRuntimeRouter.retire(releasedPath, 'packaged extension replacement source reuse complete');
      }
      const truncated = await this.handleRequest({
        id: 'packaged-worker-hot-truncate-smoke',
        method: 'session.truncateAfter',
        params: { sessionPath: currentPath, entryId: 'missing-smoke-entry' },
      }) as { sessionPath: string };
      currentPath = truncated.sessionPath;
      const replacement = this.workerRuntimeRouter.getRoute(truncated.sessionPath);
      if (replacement.state !== 'hot' || replacement.owner.workerId === first.owner.workerId) {
        throw new Error('Hot truncate did not publish a fresh worker generation.');
      }
      await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-post-truncate-smoke',
        method: 'models.list',
        params: { sessionPath: truncated.sessionPath },
      });
      const futureWorkerSettings = await this.workerRuntimeRouter.routeExisting({
        id: 'packaged-worker-future-settings-smoke',
        method: 'settings.set',
        params: { sessionPath: truncated.sessionPath, defaultThinkingLevel: nextThinkingLevel },
      }) as WorkerJsonObject;
      if (futureWorkerSettings.defaultThinkingLevel !== nextThinkingLevel) {
        throw new Error('Fresh worker did not receive authoritative coordinator settings.');
      }
    } finally {
      if (this.workerRuntimeRouter.hasHotOwner(currentPath)) {
        await this.workerRuntimeRouter.retire(currentPath, 'packaged promotion smoke complete');
      }
    }
  }

  private startEventLoopMonitor(): void {
    if (this.eventLoopDelayTimer) return;
    // Diagnostics gate: never start the native monitor or its sampling timer
    // while the live-pipeline trace is disabled.
    if (!isBackendLivePipelineTraceEnabled()) return;
    const nativeMonitor = monitorEventLoopDelay({ resolution: 20 });
    nativeMonitor.enable();
    this.eventLoopDelayMonitor = nativeMonitor;
    this.eventLoopHistogram = new BoundedEventLoopHistogram();
    const intervalMs = 1_000;
    this.eventLoopNextSampleAt = performance.now() + intervalMs;
    this.eventLoopDelayTimer = setInterval(() => {
      if (this.disposed) return;
      if (!isBackendLivePipelineTraceEnabled()) {
        // Toggle-off safety net: never keep sampling once diagnostics are
        // disabled, even if the toggle callback wiring was missed.
        this.stopEventLoopMonitor();
        return;
      }
      const now = performance.now();
      const expected = this.eventLoopNextSampleAt ?? now;
      const driftMs = now - expected;
      // The interval sample is a real coordinator scheduling observation. It
      // is deliberately kept separate from the native monitor's aggregate
      // mean/max, which supplies the finer-grained delay evidence.
      this.eventLoopHistogram?.record(Math.max(0, driftMs));
      this.eventLoopHistogram?.recordDrift(driftMs);
      this.eventLoopNextSampleAt = now + intervalMs;
      const mean = Number.isFinite(nativeMonitor.mean) ? nativeMonitor.mean / 1e6 : 0;
      const max = Number.isFinite(nativeMonitor.max) ? nativeMonitor.max / 1e6 : 0;
      recordBackendLivePipelineTrace({
        stage: 'backend.event_loop',
        kind: 'observation',
        phase: 'backend_mapping',
        eventLoopDelayMs: Math.max(0, mean),
        eventLoopMaxDelayMs: Math.max(0, max),
        eventLoopHistogram: this.eventLoopHistogram?.snapshot(),
        processRole: 'coordinator',
        pid: process.pid,
      });
      nativeMonitor.reset();
      this.eventLoopHistogram?.reset();
    }, intervalMs);
    this.eventLoopDelayTimer.unref?.();
  }

  private stopEventLoopMonitor(): void {
    if (this.eventLoopDelayTimer) clearInterval(this.eventLoopDelayTimer);
    this.eventLoopDelayTimer = undefined;
    this.eventLoopDelayMonitor?.disable();
    this.eventLoopDelayMonitor = undefined;
    this.eventLoopHistogram = undefined;
    this.eventLoopNextSampleAt = undefined;
  }

  /** Reserve a monotonic diagnostics-toggle generation at request receipt.
   * Every received toggle request (on or off) advances the generation, so
   * concurrent requests are ordered by receipt, not settlement. Superseded
   * pending off entries can no longer apply and are pruned here; their exact
   * identities are never reused. */
  private reserveLivePipelineTraceToggle(): number {
    this.livePipelineTraceToggleGeneration += 1;
    for (const [requestId, pending] of this.pendingLivePipelineTraceDisables) {
      if (pending.generation < this.livePipelineTraceToggleGeneration) {
        this.pendingLivePipelineTraceDisables.delete(requestId);
      }
    }
    return this.livePipelineTraceToggleGeneration;
  }

  private deferLivePipelineTraceDisable(requestId: string, generation: number, onApplied?: () => void): boolean {
    if (this.disposed) return false;
    // Set semantics are intentional: a retry of the same request identity
    // remains deferred until handleLine's final attempt completes. The
    // callback is replaced by a retry's callback, but can still run only once.
    this.pendingLivePipelineTraceDisables.set(requestId, {
      generation,
      onApplied: onApplied ?? (() => this.stopEventLoopMonitor()),
    });
    return true;
  }

  private completeLivePipelineTraceDisable(requestId: string): boolean {
    const pending = this.pendingLivePipelineTraceDisables.get(requestId);
    if (!pending) return false;
    this.pendingLivePipelineTraceDisables.delete(requestId);
    // A newer on request wins over an older deferred off request. The exact
    // request entry is still removed here, but it must not change global state.
    if (pending.generation !== this.livePipelineTraceToggleGeneration) return false;
    // These synchronous state changes form one transition at the request's
    // completion boundary: no monitor sample can be scheduled after tracing is
    // disabled, and no later request can consume this request's pending state.
    setBackendLivePipelineTraceEnabled(false);
    pending.onApplied();
    return true;
  }

  private markLivePipelineTraceEnabled(): void {
    // The generation was already reserved at request receipt
    // (`reserveLivePipelineTraceToggle`); applying the enable here only
    // starts the trace-gated monitor.
    this.startEventLoopMonitor();
  }

  private cancelLivePipelineTraceDisable(requestId: string): void {
    this.pendingLivePipelineTraceDisables.delete(requestId);
  }

  /**
   * Stdio EOF is not sufficient when Node is launched through a process
   * manager: the manager can retain the pipe after the extension host dies.
   * Keep a low-cost, unref'd ownership check so a backend cannot outlive its
   * host indefinitely. The host PID is optional for compatibility with direct
   * backend launches and unit tests.
   */
  private startHostWatchdog(): void {
    const hostPid = this.hostPid;
    if (hostPid === undefined || hostPid === process.pid) return;

    const checkHost = (): void => {
      try {
        process.kill(hostPid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') return;
        this.stopHostWatchdog();
        backendWarn('backend', 'extension host disappeared; stopping backend', { hostPid });
        void this.dispose().then(
          () => process.exit(0),
          (error) => { log(`backend disposal failed closed: ${toErrorMessage(error)}`); process.exitCode = 1; },
        );
      }
    };

    this.hostWatchdogTimer = setInterval(checkHost, 2_000);
    this.hostWatchdogTimer.unref?.();
  }

  private stopHostWatchdog(): void {
    if (this.hostWatchdogTimer) clearInterval(this.hostWatchdogTimer);
    this.hostWatchdogTimer = undefined;
  }

  private requireFullSdk(): SdkModule {
    if (!isFullSdkModule(this.sdk)) {
      throw new BackendError(
        'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
        'The isolated coordinator did not load the SDK execution runtime.',
      );
    }
    return this.sdk;
  }

  private createRuntimeFactory() {
    // Isolated public routing fails before this legacy-only helper is reached;
    // the cast preserves narrow test doubles that intercept runtime creation
    // without invoking the supplied factory.
    return createRuntimeFactory(this.sdk as SdkModule, this.authStorage, this.startupCwd, this.serviceLoadingGate);
  }

  private disposeRuntimeBounded(runtime: SessionContext['runtime'], sessionPath?: string): Promise<void> {
    return disposeRuntimeBounded(runtime, sessionPath, this.runtimeDisposeScheduler);
  }

  private resolveSessionPath(session: SdkSession): string | undefined {
    return session.sessionFile ?? session.sessionManager.getSessionFile();
  }

  private getSessionContext(sessionPath?: string): SessionContext | undefined {
    if (!sessionPath) return undefined;
    const direct = this.sessionContexts.get(sessionPath);
    if (direct) return direct;
    const key = this.coldManagerKey(sessionPath);
    for (const [candidatePath, context] of this.sessionContexts) {
      if (this.coldManagerKey(candidatePath) === key) return context;
    }
    return undefined;
  }

  private getPendingSessionContext(sessionPath: string): Promise<SessionContext> | undefined {
    const direct = this.pendingSessionContexts.get(sessionPath);
    if (direct) return direct;
    const key = this.coldManagerKey(sessionPath);
    for (const [candidatePath, pending] of this.pendingSessionContexts) {
      if (this.coldManagerKey(candidatePath) === key) return pending;
    }
    return undefined;
  }

  private isSessionForgotten(sessionPath: string): boolean {
    if (this.forgottenSessionPaths.has(sessionPath)) return true;
    const key = this.coldManagerKey(sessionPath);
    for (const candidatePath of this.forgottenSessionPaths) {
      if (this.coldManagerKey(candidatePath) === key) return true;
    }
    return false;
  }

  private prepareViewedSessionPath(sessionPath: string): PreparedViewedSessionTransition {
    const prepared: PreparedViewedSessionTransition = {
      changed: false,
      revision: this.viewedSessionRevision,
      hadPrevious: this.browsePreviousSessionFiles.has(sessionPath),
      previous: this.browsePreviousSessionFiles.get(sessionPath),
    };
    if (this.isSessionForgotten(sessionPath) || this.viewedSessionPath === sessionPath) {
      return prepared;
    }
    prepared.changed = true;
    this.browsePreviousSessionFiles.set(sessionPath, this.viewedSessionPath);
    return prepared;
  }

  private discardPreparedViewedSessionPath(
    sessionPath: string,
    prepared?: PreparedViewedSessionTransition,
  ): void {
    if (!prepared?.changed || prepared.revision !== this.viewedSessionRevision
      || this.sessionContexts.has(sessionPath) || this.pendingSessionContexts.has(sessionPath)) return;
    if (prepared.hadPrevious) this.browsePreviousSessionFiles.set(sessionPath, prepared.previous);
    else this.browsePreviousSessionFiles.delete(sessionPath);
  }

  private commitPreparedViewedSessionPath(
    sessionPath: string,
    prepared?: PreparedViewedSessionTransition,
  ): boolean {
    if (!prepared?.changed || prepared.revision !== this.viewedSessionRevision
      || this.isSessionForgotten(sessionPath)) return false;
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
    return true;
  }

  private recordViewedSessionTransition(
    sessionPath: string,
    previousSessionPath: string | null,
  ): boolean {
    if (this.isSessionForgotten(sessionPath) || previousSessionPath === sessionPath) return false;
    this.browsePreviousSessionFiles.set(sessionPath, previousSessionPath ?? undefined);
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
    return true;
  }

  private setViewedSessionPath(sessionPath: string | undefined): void {
    if ((sessionPath && this.isSessionForgotten(sessionPath))
      || this.viewedSessionPath === sessionPath) return;
    this.viewedSessionPath = sessionPath;
    this.viewedSessionRevision += 1;
  }

  private setViewedSessionPathIfCurrent(sessionPath: string, revision: unknown): boolean {
    if (revision !== this.viewedSessionRevision || this.isSessionForgotten(sessionPath)) return false;
    this.setViewedSessionPath(sessionPath);
    return true;
  }

  private async createSessionContext(
    sessionManager: SdkSessionManager,
    reason: SessionContextCreationReason,
    previousSessionFile?: string,
    previousSessionFileCaptured = false,
  ): Promise<SessionContext> {
    const context = await this.buildSessionContext({
      sessionManager,
      reason,
      previousSessionFile,
      previousSessionFileCaptured,
    });

    const existing = this.sessionContexts.get(context.sessionPath);
    context.sessionOwnershipEpoch = (existing?.sessionOwnershipEpoch ?? 0) + 1;
    if (existing) {
      // A replacement installs a new context object. Fence the predecessor
      // before any late prompt callback can publish through its old closure.
      existing.retired = true;
      context.busySeq = existing.busySeq;
      if (existing.terminalLiveTurn && existing.terminalLiveTurn.expiresAt > Date.now()) {
        context.terminalLiveTurn = existing.terminalLiveTurn;
      }
      const cleanup = (operation: string, action: () => void): void => {
        try {
          action();
        } catch (error) {
          backendWarn('backend-session', `replaced runtime ${operation} failed`, {
            sessionPath: context.sessionPath,
            error: toErrorMessage(error),
          });
        }
      };
      cleanup('watchdog cleanup', () => existing.willRetryWatchdogClear?.());
      cleanup('UI disposal', () => existing.uiBridge?.dispose());
      cleanup('unsubscribe', () => existing.unsubscribe());
      cleanup('session manager fence', () => existing.sessionManagerFence?.invalidate());
      // A provider teardown can wedge the old runtime. The replacement becomes
      // authoritative immediately; old disposal is bounded best-effort and
      // must not block local recovery or the next send.
      void this.disposeRuntimeBounded(existing.runtime, existing.sessionPath);
    }

    if (this.isSessionForgotten(context.sessionPath)) {
      context.retired = true;
      context.sessionManagerFence?.invalidate();
      try { context.uiBridge?.dispose(); } catch { /* best effort */ }
      try { context.unsubscribe(); } catch { /* best effort */ }
      await this.disposeRuntimeBounded(context.runtime, context.sessionPath);
      throw new BackendError('SESSION_NOT_FOUND', `The session was forgotten while it was opening: ${context.sessionPath}`);
    }
    // A runtime whose service creation was admitted before shutdown but which
    // settled after disposal began must not be installed; tear it down through
    // the same ownership path as a forgotten session.
    if (this.disposed) {
      context.retired = true;
      context.sessionManagerFence?.invalidate();
      try { context.uiBridge?.dispose(); } catch { /* best effort */ }
      try { context.unsubscribe(); } catch { /* best effort */ }
      await this.disposeRuntimeBounded(context.runtime, context.sessionPath);
      throw new BackendError(
        'SERVER_SHUTTING_DOWN',
        `The backend is shutting down; the session runtime was not installed: ${context.sessionPath}`,
      );
    }
    this.sessionContexts.set(context.sessionPath, context);
    return context;
  }

  private async buildSessionContext(options: {
    sessionManager: SdkSessionManager;
    reason: SessionContextCreationReason;
    previousSessionFile?: string;
    previousSessionFileCaptured?: boolean;
  }): Promise<SessionContext> {
    return await timed('buildSessionContext', async () => {
      const { sessionManager, reason } = options;
      const { manager: fencedSessionManager, fence: sessionManagerFence } = createSessionManagerFence(sessionManager);
      const previousSessionFile = options.previousSessionFileCaptured
        ? options.previousSessionFile
        : options.previousSessionFile ?? this.viewedSessionPath;
      const currentSessionFile = sessionManager.getSessionFile();
      const safePreviousSessionFile = previousSessionFile && previousSessionFile !== currentSessionFile
        ? previousSessionFile
        : undefined;
      let runtime: SessionContext['runtime'] | undefined;
      try {
      runtime = await this.requireFullSdk().createAgentSessionRuntime(this.createRuntimeFactory(), {
        cwd: fencedSessionManager.getCwd() || this.startupCwd,
        agentDir: this.agentDir,
        sessionManager: fencedSessionManager,
        sessionStartEvent: safePreviousSessionFile
          ? {
              type: 'session_start',
              reason,
              previousSessionFile: safePreviousSessionFile,
            }
          : undefined,
      });

      // Runtime model registries contain the effective request URLs after
      // built-in defaults and credential-specific OAuth rewrites are applied.
      // Feed those URLs into the already-installed gate so configured providers
      // without a static models.json baseUrl (and providers whose URL changes at
      // runtime) are gated and reported like ordinary custom providers.
      const modelRegistry = runtime.services?.modelRegistry;
      ProviderGate.getInstance()?.registerModelBaseUrls(
        modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? [],
      );

      const session = runtime.session;
      const sessionPath = this.resolveSessionPath(session);
      if (!sessionPath) {
        throw new Error('The PI session did not expose a session path.');
      }

      const context: SessionContext = {
        runtime,
        session,
        sessionPath,
        sessionOwnershipEpoch: 0,
        unsubscribe: () => undefined,
        busySeq: 0,
        lastContextUsage: undefined,
        sessionManagerFence,
      };

      // Wire the ExtensionUI bridge so extensions can ask questions through the webview.
      const uiBridge = new ExtensionUIBridge(context.sessionPath, (event, payload) => this.emit(event, payload));
      context.uiBridge = uiBridge;
      const extensionRunner = (session as unknown as { extensionRunner?: { setUIContext?: (ctx: unknown) => void } }).extensionRunner;
      if (extensionRunner?.setUIContext) {
        extensionRunner.setUIContext(uiBridge);
      }

      installAuxiliaryLlmMeter(
        session,
        sessionPath,
        (event, payload) => this.emit(event, payload),
      );
      const subscriptionStartedAt = performance.now();
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'start',
        phase: 'subscriptions',
        identifiers: { session: sessionPath },
        processRole: 'coordinator',
        pid: process.pid,
      });
      try {
        context.unsubscribe = session.subscribe((event: SdkSessionEvent) => {
          this.handleSessionEvent(context, event);
        });
      } catch (error) {
        recordBackendLivePipelineTrace({
          stage: 'backend.runtime',
          kind: 'failure',
          phase: 'subscriptions',
          durationMs: Math.max(0, performance.now() - subscriptionStartedAt),
          identifiers: { session: sessionPath },
          reasonCode: 'unknown_unattributable',
          processRole: 'coordinator',
          pid: process.pid,
        });
        throw error;
      }
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'success',
        phase: 'subscriptions',
        durationMs: Math.max(0, performance.now() - subscriptionStartedAt),
        identifiers: { session: sessionPath },
        processRole: 'coordinator',
        pid: process.pid,
      });

      // Load persisted picker state before installing guards: both prompt
      // rebuilds and extension-driven tool changes consult this live set.
      const persistedDisabled = await readSystemPromptTogglesForSession(sessionPath);
      context.systemPromptDisabledEntries = persistedDisabled;

      // The SDK rebuilds its base prompt whenever active tools or extension
      // resources change. Guard that synchronous rebuild so it cannot silently
      // restore entries the picker disabled.
      const promptGuardStartedAt = performance.now();
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'start',
        phase: 'prompt_guards',
        identifiers: { session: sessionPath },
        processRole: 'coordinator',
        pid: process.pid,
      });
      try {
        const promptState = this.getSessionPromptState(context);
        if (typeof promptState._rebuildSystemPrompt === 'function') {
          const { buildSystemPrompt } = await this.getSystemPromptModule();
          installSystemPromptToggleRebuildGuard(
            promptState,
            () => context.systemPromptDisabledEntries ?? [],
            buildSystemPrompt,
          );
        }
        installSystemPromptToolToggleGuard(
          session,
          () => context.systemPromptDisabledEntries ?? [],
        );
        installAutonomousModeToolGuard(session, () => this.autonomousMode);
      } catch (error) {
        recordBackendLivePipelineTrace({
          stage: 'backend.runtime',
          kind: 'failure',
          phase: 'prompt_guards',
          durationMs: Math.max(0, performance.now() - promptGuardStartedAt),
          identifiers: { session: sessionPath },
          reasonCode: 'unknown_unattributable',
          processRole: 'coordinator',
          pid: process.pid,
        });
        throw error;
      }
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'success',
        phase: 'prompt_guards',
        durationMs: Math.max(0, performance.now() - promptGuardStartedAt),
        identifiers: { session: sessionPath },
        processRole: 'coordinator',
        pid: process.pid,
      });

      // Disabling Tools controls both prompt prose and the provider's separate
      // tool-schema field. Capture the initial active set so a later re-enable
      // can restore it, including after reopening a persisted disabled session.
      if (persistedDisabled.includes(TOOLS_ENTRY_ID)) {
        context.systemPromptToolsBeforeDisable = session.getActiveToolNames?.()
          ?? session.getAllTools?.().map((tool) => tool.name)
          ?? [];
        session.setActiveToolsByName?.([]);
      }
      if (persistedDisabled.length > 0) {
        await this.applySystemPromptTogglesToBasePrompt(context, persistedDisabled);
      }
      this.applyAutonomousModeToContext(context, this.autonomousMode);

      return context;
      } catch (error) {
        sessionManagerFence.invalidate();
        if (runtime) {
          // Construction failure remains authoritative; disposal is bounded
          // best effort so a wedged SDK runtime cannot strand the open.
          await this.disposeRuntimeBounded(runtime);
        }
        throw error;
      }
    });
  }

  private async ensureSessionContext(sessionPath: string): Promise<SessionContext> {
    if (this.isSessionForgotten(sessionPath)) {
      throw new BackendError('SESSION_NOT_FOUND', `The session has been forgotten: ${sessionPath}`);
    }
    // A registered cold mutation or promotion/replacement owns this path
    // atomically even when its publication has not completed yet. Loop because
    // a successor can register while any predecessor is being awaited.
    while (true) {
      const coldMutation = this.pendingColdSessionMutations.get(this.coldManagerKey(sessionPath));
      if (coldMutation) {
        await coldMutation;
        continue;
      }
      const pending = this.getPendingSessionContext(sessionPath);
      if (!pending) break;
      await pending;
      if (this.disposed || this.isSessionForgotten(sessionPath)) {
        throw new BackendError('SESSION_NOT_FOUND', `The session is no longer available: ${sessionPath}`);
      }
    }
    const existing = this.getSessionContext(sessionPath);
    if (existing) {
      if (existing.recoveryPromise) {
        try {
          return await existing.recoveryPromise;
        } catch (error) {
          throw new BackendError(
            'SESSION_RUNTIME_RECOVERY_FAILED',
            `The session runtime could not be replaced: ${toErrorMessage(error)}`,
          );
        }
      }
      if (existing.retired) {
        throw new BackendError(
          'SESSION_RUNTIME_RECOVERY_FAILED',
          `The session runtime for ${sessionPath} was retired without a replacement.`,
        );
      }
      return existing;
    }

    const previousSessionFile = this.browsePreviousSessionFiles.get(sessionPath);
    const store = this.initializeColdSessionStore();
    const handleKey = this.coldManagerKey(sessionPath);
    const retained = this.coldSessionManagerHandles.get(handleKey);
    let contextCreation: Promise<SessionContext>;
    if (retained) {
      this.coldSessionManagerHandles.delete(handleKey);
      contextCreation = store.handoff(retained.handle, (manager) => this.createSessionContext(
        manager,
        retained.creationReason,
        previousSessionFile,
        true,
      ));
    } else {
      // Promotion steals cold ownership synchronously before SessionManager.open
      // or any runtime await. Every in-flight cold result is stale from here.
      store.leases.invalidate(sessionPath);
      contextCreation = this.createSessionContext(
        this.sdk.SessionManager.open(sessionPath),
        'resume',
        previousSessionFile,
        true,
      );
    }
    const creation = contextCreation.then(async (context) => {
      try {
        // Publish runtime metadata before the first mutation can start streaming.
        // This one-time refresh belongs to the single-flight promotion promise.
        if (this.disposed || this.isSessionForgotten(sessionPath)) {
          throw new BackendError('SESSION_NOT_FOUND', `The session is no longer available: ${sessionPath}`);
        }
        const payload = await this.buildHotSessionOpenedPayload(sessionPath);
        if (this.disposed || this.isSessionForgotten(sessionPath)
          || this.getSessionContext(sessionPath) !== context) {
          throw new BackendError('SESSION_NOT_FOUND', `The promoted session is no longer authoritative: ${sessionPath}`);
        }
        // A successor transition may have queued behind this promotion while
        // hydration was building. Complete this owner so the successor can run,
        // but do not publish metadata it already superseded.
        if (this.pendingSessionContexts.get(sessionPath) === creation) {
          this.emit('session.opened', payload);
        }
        this.browsePreviousSessionFiles.delete(sessionPath);
        return context;
      } catch (error) {
        if (this.sessionContexts.get(sessionPath) === context) this.sessionContexts.delete(sessionPath);
        context.retired = true;
        context.sessionManagerFence?.invalidate();
        try { context.uiBridge?.dispose(); } catch { /* best effort */ }
        try { context.unsubscribe(); } catch { /* best effort */ }
        await this.disposeRuntimeBounded(context.runtime, context.sessionPath);
        throw error;
      }
    });
    this.pendingSessionContexts.set(sessionPath, creation);
    try {
      await creation;
    } finally {
      if (this.pendingSessionContexts.get(sessionPath) === creation) {
        this.pendingSessionContexts.delete(sessionPath);
      }
    }
    // A transition can reserve the path as soon as the promotion promise is
    // released. Re-enter the owner loop rather than returning an intermediate.
    return await this.ensureSessionContext(sessionPath);
  }

  private async transitionSessionContext(
    sessionPath: string,
    transition: () => Promise<SessionContext>,
  ): Promise<SessionContext> {
    if (this.isSessionForgotten(sessionPath)) {
      throw new BackendError('SESSION_NOT_FOUND', `The session has been forgotten: ${sessionPath}`);
    }
    this.initializeColdSessionStore().leases.invalidate(sessionPath);
    this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
    const previous = this.pendingSessionContexts.get(sessionPath);
    let predecessor: SessionContext | undefined;
    const owned = (async () => {
      try {
        if (previous) await previous;
        if (this.isSessionForgotten(sessionPath) || this.disposed) {
          throw new BackendError('SESSION_NOT_FOUND', `The session is no longer available: ${sessionPath}`);
        }
        predecessor = this.sessionContexts.get(sessionPath);
        return await transition();
      } catch (error) {
        // Once a replacement transition fails, the predecessor can no longer
        // be trusted: truncate may already have atomically rewritten the file.
        // Fence it so later reads/mutations reopen durable authority instead of
        // serving a pre-transition branch.
        if (predecessor && this.sessionContexts.get(sessionPath) === predecessor) {
          predecessor.retired = true;
          predecessor.sessionManagerFence?.invalidate();
          try { predecessor.uiBridge?.dispose(); } catch { /* best effort */ }
          try { predecessor.unsubscribe(); } catch { /* best effort */ }
          this.sessionContexts.delete(sessionPath);
          void this.disposeRuntimeBounded(predecessor.runtime, predecessor.sessionPath);
        }
        throw error;
      }
    })();
    this.pendingSessionContexts.set(sessionPath, owned);
    try {
      return await owned;
    } finally {
      if (this.pendingSessionContexts.get(sessionPath) === owned) {
        this.pendingSessionContexts.delete(sessionPath);
      }
    }
  }

  private getPinnedStreamingMessageId(context: SessionContext): string | undefined {
    return context.activeRequest?.currentMessageId ?? context.activeRequest?.lastAssistantMessageId;
  }

  /** Resolve an already-owned runtime without promoting a cold browse. Pending
   * promotion/replacement always wins, and every awaited owner is rechecked for
   * a successor before it can be used. */
  private async resolveBrowseContext(sessionPath: string): Promise<SessionContext | undefined> {
    while (true) {
      if (this.disposed || this.isSessionForgotten(sessionPath)) {
        throw new BackendError('SESSION_NOT_FOUND', `The session is no longer available: ${sessionPath}`);
      }
      const coldMutation = this.pendingColdSessionMutations.get(this.coldManagerKey(sessionPath));
      if (coldMutation) {
        await coldMutation;
        continue;
      }
      const pending = this.getPendingSessionContext(sessionPath);
      if (pending) {
        try {
          await pending;
        } catch (error) {
          // The owner removes itself in its finally block. If it was replaced
          // or cleared while rejecting, re-evaluate cold/hot authority rather
          // than making a tokened browse refresh inherit the failed promotion.
          if (this.pendingSessionContexts.get(sessionPath) !== pending) continue;
          throw error;
        }
        continue;
      }
      const context = this.getSessionContext(sessionPath);
      if (!context) return undefined;
      if (context.recoveryPromise) {
        await context.recoveryPromise;
        continue;
      }
      if (context.retired) {
        throw new BackendError('SESSION_RUNTIME_RECOVERY_FAILED', `The session runtime is no longer authoritative: ${sessionPath}`);
      }
      return context;
    }
  }

  private readColdBrowseFileFingerprintSync(sessionPath: string): string {
    const stat = fsSync.statSync(sessionPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
  ): Promise<TranscriptPagePayload> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.resolveBrowseContext(sessionPath);
      if (!context) {
        try {
          const result = await this.initializeColdSessionStore().loadPage(
            sessionPath,
            direction,
            loadedStart,
            loadedEnd,
          );
          if (await this.resolveBrowseContext(sessionPath)) continue;
          this.registerColdResult(result);
          return result;
        } catch (error) {
          if (error instanceof StaleColdSessionLeaseError) continue;
          throw error;
        }
      }
      if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
      if (this.disposed || this.isSessionForgotten(sessionPath)
        || this.getPendingSessionContext(sessionPath)
        || this.getSessionContext(sessionPath) !== context) continue;
      const page = buildPagedTranscriptWindow(ensureDisplayTranscriptCache(context), {
        direction,
        loadedStart,
        loadedEnd,
        pinnedMessageId: this.getPinnedStreamingMessageId(context),
      });
      const busy = context.session.isStreaming || !!context.activeRequest || context.session.isCompacting === true;
      const result: TranscriptPagePayload = {
        sessionPath,
        transcript: (busy ? page.transcript : normalizeDanglingTranscript(page.transcript))
          .map(deduplicateToolCallResultsForTransport),
        transcriptWindow: page.transcriptWindow,
        busy,
      };
      this.browseResponseOwners.set(result, { sessionPath, owner: context });
      return result;
    }
    throw new BackendError('SESSION_CHANGED_DURING_READ', `The session changed repeatedly while it was being paged: ${sessionPath}`);
  }

  private async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (ref.source !== 'durable') {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'Live detail is owned by the extension host.' };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.resolveBrowseContext(sessionPath);
      if (!context) {
        try {
          const result = await this.initializeColdSessionStore().loadDetail(sessionPath, ref);
          if (await this.resolveBrowseContext(sessionPath)) continue;
          this.registerColdResult(result);
          return result;
        } catch (error) {
          if (error instanceof StaleColdSessionLeaseError) continue;
          throw error;
        }
      }
      if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
      if (this.disposed || this.isSessionForgotten(sessionPath)
        || this.getPendingSessionContext(sessionPath)
        || this.getSessionContext(sessionPath) !== context) continue;
      const found = findDurableDetail(ensureDisplayTranscriptCache(context).transcript, ref);
      let result: DetailResult;
      if (found.status === 'unavailable') {
        result = { sessionPath, key: ref.key, status: 'unavailable', message: 'The durable detail is no longer available.' };
      } else if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
        result = { sessionPath, key: ref.key, status: 'unavailable', message: 'The detail exceeds the supported retrieval size.' };
      } else if (found.sizeBytes !== ref.sizeBytes) {
        result = { sessionPath, key: ref.key, status: 'stale', message: 'The durable detail changed; refresh the session and retry.' };
      } else {
        result = { sessionPath, key: ref.key, status: 'loaded', value: found.value, sizeBytes: found.sizeBytes };
      }
      this.browseResponseOwners.set(result, { sessionPath, owner: context });
      return result;
    }
    throw new BackendError('SESSION_CHANGED_DURING_READ', `The session changed repeatedly while detail was being read: ${sessionPath}`);
  }

  // ─── Phase 5 detail routing: live worker vs coordinator durable authority ──

  /** Route `detail.subscribe`. A hot session's live source wins (the worker's
   *  canonical store is authoritative while the subagent runs); a terminal or
   *  cold source is answered by the durable paged authority directly from the
   *  durable JSONL. A live NOT_FOUND/NOT_LIVE_ADDRESSABLE means the worker no
   *  longer retains the source (terminal or evicted) and the durable JSONL is
   *  authoritative, so it falls back to durable. */
  private async routeDetailSubscribe(requestId: string, params: DetailSubscribeParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    if (!router) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    const fence = this.detailFence();
    const sessionPath = params.address.sessionPath;
    if (router.hasHotOwner(sessionPath)) {
      try {
        await router.subscribeDetail({
          kind: 'detail.subscribe',
          requestId,
          subscriptionId: params.subscriptionId,
          address: params.address,
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          maxPageBytes: params.maxPageBytes,
        });
        return;
      } catch (error) {
        if (!isLiveDetailGoneError(error)) throw error;
        // The live source is gone (terminal handoff or eviction); the durable
        // JSONL now owns the exact detail.
      }
    }
    const durable = this.durableDetailStore;
    if (!durable) {
      throw new BackendError('UNKNOWN_METHOD', 'Durable detail subscription routing is unavailable.');
    }
    await durable.subscribe(requestId, params.subscriptionId, params.address, params.maxPageBytes, fence);
  }

  private async routeDetailUnsubscribe(requestId: string, params: DetailUnsubscribeParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    const durable = this.durableDetailStore;
    if (!router && !durable) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    // Both registries no-op for subscription ids they do not own.
    durable?.unsubscribe(requestId, params.subscriptionId);
    if (router) {
      await router.unsubscribeDetail({
        kind: 'detail.unsubscribe',
        requestId,
        subscriptionId: params.subscriptionId,
        reason: params.reason,
      });
    }
  }

  private async routeDetailFetch(requestId: string, params: DetailFetchParams): Promise<void> {
    const router = this.workerRuntimeRouter;
    const durable = this.durableDetailStore;
    if (durable?.owns(params.subscriptionId)) {
      await durable.fetch(requestId, params.subscriptionId, params.address, params.ref, params.maxPageBytes, this.detailFence());
      return;
    }
    if (!router) {
      throw new BackendError('UNKNOWN_METHOD', 'Detail subscription routing is unavailable.');
    }
    router.fetchDetail({
      kind: 'detail.fetch',
      requestId,
      subscriptionId: params.subscriptionId,
      address: params.address,
      ref: params.ref,
      maxPageBytes: params.maxPageBytes,
    });
  }

  /** Coordinator-owned durable detail authority: resolve the address against
   *  the durable JSONL under the cold ownership lease (stable cold reads are
   *  permitted while a worker owns the path; the terminal tool result is
   *  written before the terminal handoff). */
  private async resolveDurableDetail(
    sessionPath: string,
    address: LiveSubagentDetailAddress,
    durableRef?: LazyDetailRef,
  ): Promise<ResolvedDurableDetail> {
    return await this.initializeColdSessionStore().resolveDurableDetail(sessionPath, address, durableRef);
  }

  private detailFence(): BackendDetailFence {
    return { backendGeneration: this.backendGeneration, coordinatorGeneration: this.backendGeneration };
  }

  private resolveCurrentContextWindow(context: SessionContext): number | undefined {
    const sessionContextWindow = context.session.model?.contextWindow;
    if (
      typeof sessionContextWindow === 'number'
      && Number.isFinite(sessionContextWindow)
      && sessionContextWindow > 0
    ) {
      return Math.trunc(sessionContextWindow);
    }

    const currentModelId = context.session.model?.id;
    if (!currentModelId) {
      return undefined;
    }

    try {
      const models = context.runtime.services?.modelRegistry?.getAvailable() ?? [];
      const model = models.find((candidate) => candidate.id === currentModelId);
      if (
        typeof model?.contextWindow === 'number'
        && Number.isFinite(model.contextWindow)
        && model.contextWindow > 0
      ) {
        return Math.trunc(model.contextWindow);
      }
    } catch (error) {
      // Ignore model registry issues and fall back to undefined.
      backendTrace('modelRegistry', 'contextWindowLookup.failed', { level: 'warn', error: toErrorMessage(error) });
    }

    return undefined;
  }

  private getContextUsage(context: SessionContext): ContextWindowUsage | undefined {
    // Derive `tokens` from the most recent assistant usage's prompt footprint
    // (input + cacheRead + cacheWrite) — the tokens that actually counted
    // against the context window on the last API call.
    //
    // We deliberately do NOT use the SDK's `getContextUsage().tokens`: that
    // value is `calculateContextTokens(lastUsage)` (= `totalTokens` = prompt
    // footprint + output) plus a chars/4 estimate of trailing in-progress
    // messages. Including output overstates window fill, and the trailing
    // estimate disagrees with the real usage that lands on completion, so the
    // indicator jumps ("doubling" / changing mid-turn and on completion).
    //
    // The prompt footprint is stable during a turn — it only steps forward
    // when a new assistant usage arrives — so the indicator reflects actual
    // window use consistently. `contextWindow` follows the active model.
    const contextWindow = this.resolveCurrentContextWindow(context);
    if (!contextWindow) {
      return undefined;
    }
    const measuredUsage = deriveContextUsageFromBranch(
      context.session.sessionManager.getBranch(),
      contextWindow,
    );
    if (measuredUsage) {
      context.postCompactionEstimatedTokens = undefined;
      return measuredUsage;
    }

    const estimatedTokens = context.postCompactionEstimatedTokens;
    if (estimatedTokens === undefined) {
      return undefined;
    }
    return {
      tokens: estimatedTokens,
      contextWindow,
      percent: Math.min(100, Math.max(0, (estimatedTokens / contextWindow) * 100)),
    };
  }

  private emitContextUsageChanged(context: SessionContext, postCompactionEstimatedTokens?: number): void {
    if (postCompactionEstimatedTokens !== undefined) {
      context.postCompactionEstimatedTokens = postCompactionEstimatedTokens;
    }
    const nextUsage = this.getContextUsage(context) ?? null;
    const previousUsage = context.lastContextUsage;
    const changed = previousUsage === undefined
      || (previousUsage === null
        ? nextUsage !== null
        : nextUsage === null
          || previousUsage.tokens !== nextUsage.tokens
          || previousUsage.contextWindow !== nextUsage.contextWindow
          || previousUsage.percent !== nextUsage.percent);

    if (!changed) {
      return;
    }

    context.lastContextUsage = nextUsage;
    this.emit('contextUsage.changed', {
      sessionPath: context.sessionPath,
      contextUsage: nextUsage,
    } satisfies ContextUsageChangedPayload);
  }

  private async getSystemPromptModule(): Promise<SdkSystemPromptModule> {
    if (this.systemPromptModulePromise) return await this.systemPromptModulePromise;
    const startedAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'start',
      phase: 'sdk_import',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.systemPromptModulePromise = loadSdkInternalModule<SdkSystemPromptModule>(
      this.sdkPath,
      path.join('core', 'system-prompt.js'),
    );
    try {
      const module = await this.systemPromptModulePromise;
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'success',
        phase: 'sdk_import',
        durationMs: Math.max(0, performance.now() - startedAt),
        processRole: 'coordinator',
        pid: process.pid,
      });
      return module;
    } catch (error) {
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'failure',
        phase: 'sdk_import',
        durationMs: Math.max(0, performance.now() - startedAt),
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
      throw error;
    }
  }

  private getSessionPromptState(context: SessionContext): SessionPromptState {
    return context.session as SdkSession & SessionPromptState;
  }

  private async readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined> {
    const promptState = this.getSessionPromptState(context);
    const options = promptState._baseSystemPromptOptions;
    if (!options) {
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const basePrompt = normalizePromptText(buildSystemPrompt({
        cwd: options.cwd,
        selectedTools: options.selectedTools,
        toolSnippets: options.toolSnippets,
        promptGuidelines: options.promptGuidelines,
      }));
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    } catch (error) {
      backendTrace('systemPrompt', 'harnessRead.failed', { level: 'debug', error: toErrorMessage(error) });
      const basePrompt = normalizePromptText(promptState._baseSystemPrompt);
      return basePrompt ? rewritePieHarnessPrompt(basePrompt, this.agentDir) : undefined;
    }
  }

  private async buildSystemPrompts(
    context: SessionContext,
    harnessPromptOverride?: string,
  ): Promise<SystemPromptEntry[]> {
    const promptState = this.getSessionPromptState(context);
    // Refresh the unfiltered-options snapshot from the SDK's live options
    // whenever they're at least as complete as what we cached (e.g. the SDK
    // rebuilt them after a tool/resource change). The display entry list is
    // then built from the snapshot so disabled option-driven entries (context
    // files, skills, append) stay present and re-toggleable instead of
    // vanishing once the live options are filtered for the model prompt.
    captureOriginalSystemPromptOptions(promptState);
    const promptOptions = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    const harnessPrompt = harnessPromptOverride ?? await this.readHarnessSystemPrompt(context);
    const tools = typeof context.session.getAllTools === 'function'
      ? context.session.getAllTools()
      : [];

    return buildSessionSystemPrompts({
      harnessPrompt,
      promptOptions,
      formatSkillsForPrompt: (this.sdk as Partial<SdkModule>).formatSkillsForPrompt,
      tools,
      activeProvider: resolveActiveModel(context),
      disabledEntries: context.systemPromptDisabledEntries,
    });
  }

  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'medium' };
    try {
      const raw = await fs.readFile(path.join(this.agentDir, 'settings.json'), 'utf8');
      const parsed = parseJsonOrThrow<Partial<ModelSettings>>(raw, 'settings.json');
      const result: ModelSettings = {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? defaults.defaultThinkingLevel,
      };
      if (typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.length > 0) {
        result.defaultProvider = parsed.defaultProvider;
      }
      return result;
    } catch (error) {
      backendTrace('modelSettings', 'read.failed', { level: 'warn', error: toErrorMessage(error) });
      return defaults;
    }
  }

  /** Rewrite the SDK session's cached `_baseSystemPrompt` (and the structured
   *  `_baseSystemPromptOptions`) so the next turn sends a prompt with the
   *  disabled entries removed. The SDK reads `_baseSystemPrompt` each turn
   *  (falling back to it when no extension overrides), so this mutation takes
   *  effect on the next `message.send` without restarting the session.
   *
   *  The filtered options are always rebuilt from the unfiltered
   *  `_originalSystemPromptOptions` snapshot (captured before any filtering),
   *  never from the already-filtered live `_baseSystemPromptOptions`. This keeps
   *  re-enabling an entry a true inverse of disabling it (the prior behavior
   *  rebuilt from filtered options, so a toggled-off context file never came
   *  back) and lets rapid toggles compose instead of accumulating drift. */
  private async applySystemPromptTogglesToBasePrompt(
    context: SessionContext,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const promptState = this.getSessionPromptState(context);
    // Capture the unfiltered snapshot from the live options before we touch
    // them. On the first toggle the live options are still the SDK's unfiltered
    // set, so this is the moment the full entry set is recorded. On later
    // toggles the live options are already filtered; `capture...` only refreshes
    // the snapshot when the live set is a superset of the cached one, so a
    // filtered set never clobbers it.
    captureOriginalSystemPromptOptions(promptState);
    const source = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (!source) return;

    try {
      const { buildSystemPrompt } = await this.getSystemPromptModule();
      const toggled = buildToggledSystemPrompt(source, disabledEntries, buildSystemPrompt);
      // Empty is intentional and valid when every entry is disabled. Do not
      // use a truthiness check here or the prior full prompt survives.
      promptState._baseSystemPrompt = toggled.prompt;
      // Keep the structured options in sync so downstream extensions (e.g. the
      // skill-pruner `before_agent_start` hook) see the filtered skill/context
      // sets instead of re-adding stripped sections from the original options.
      promptState._baseSystemPromptOptions = toggled.options;
    } catch (error) {
      // Leave the existing base prompt untouched if the SDK builder is not
      // available; sending the previous known prompt is safer than a partial
      // regex-only rewrite.
      backendTrace('systemPrompt', 'harnessRebuild.failed', { level: 'debug', error: toErrorMessage(error) });
    }
  }

  /** Apply autonomous-mode tool visibility to one live SDK session. */
  private applyAutonomousModeToContext(context: SessionContext, enabled: boolean): void {
    const active = context.session.getActiveToolNames?.()
      ?? context.session.getAllTools?.().map((tool) => tool.name)
      ?? [];

    if (enabled) {
      // Tools-off stores its prior provider schema outside the live active set.
      // Preserve that latent ask_user ownership too: Tools may be switched back
      // on while autonomous mode is still filtering the restoration call.
      const askUserWasCapturedByToolsToggle = (
        context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) === true
        && context.systemPromptToolsBeforeDisable?.includes(ASK_USER_TOOL_NAME) === true
      );
      context.autonomousModeAskUserWasActive = (
        active.includes(ASK_USER_TOOL_NAME) || askUserWasCapturedByToolsToggle
      );
      if (active.includes(ASK_USER_TOOL_NAME)) {
        context.session.setActiveToolsByName?.(
          active.filter((name) => name !== ASK_USER_TOOL_NAME),
        );
      }
      return;
    }

    if (!context.autonomousModeAskUserWasActive) {
      context.autonomousModeAskUserWasActive = undefined;
      return;
    }

    // If the whole Tools entry is off, preserve the restoration intent in its
    // captured set. The Tools guard intentionally reduces every live update to
    // [], so restoring directly here would otherwise be forgotten.
    if (context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID)) {
      context.systemPromptToolsBeforeDisable = [
        ...new Set([...(context.systemPromptToolsBeforeDisable ?? []), ASK_USER_TOOL_NAME]),
      ];
      context.autonomousModeAskUserWasActive = undefined;
      return;
    }

    const configured = context.session.getAllTools?.().map((tool) => tool.name) ?? [];
    if (configured.includes(ASK_USER_TOOL_NAME) && !active.includes(ASK_USER_TOOL_NAME)) {
      context.session.setActiveToolsByName?.([...active, ASK_USER_TOOL_NAME]);
    }
    context.autonomousModeAskUserWasActive = undefined;
  }

  /** Update every live session immediately; newly created contexts read the
   * process-wide field while installing their tool guard. */
  private setAutonomousMode(enabled: boolean): void {
    if (this.autonomousMode === enabled) return;
    this.autonomousMode = enabled;
    if (this.runtimeIsolationMode === 'isolated') return;
    for (const context of this.sessionContexts.values()) {
      this.applyAutonomousModeToContext(context, enabled);
    }
  }

  /** Apply a new disabled-entry set for a session: update the SessionContext,
   *  persist to the sidecar, rewrite the base prompt. (Re-emitting
   *  `session.opened` is the caller's responsibility — the RPC handler does it
   *  after this resolves.) The `disabledEntries` array is the complete set. */
  async applySystemPromptToggles(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const previous = this.pendingSystemPromptToggleApplications.get(sessionPath) ?? Promise.resolve();
    const application = previous.catch(() => undefined).then(() => (
      this.applySystemPromptTogglesNow(sessionPath, disabledEntries)
    ));
    this.pendingSystemPromptToggleApplications.set(sessionPath, application);
    try {
      await application;
    } finally {
      if (this.pendingSystemPromptToggleApplications.get(sessionPath) === application) {
        this.pendingSystemPromptToggleApplications.delete(sessionPath);
      }
    }
  }

  private async applySystemPromptTogglesNow(
    sessionPath: string,
    disabledEntries: readonly string[],
  ): Promise<void> {
    const context = this.sessionContexts.get(sessionPath);
    if (!context) return;
    const next = [...new Set(disabledEntries)];
    const toolsWereDisabled = context.systemPromptDisabledEntries?.includes(TOOLS_ENTRY_ID) ?? false;
    const toolsWillBeDisabled = next.includes(TOOLS_ENTRY_ID);

    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.systemPromptToolsBeforeDisable = context.session.getActiveToolNames?.()
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
    }

    // Update the live set before invoking setActiveToolsByName: the installed
    // guard consults it synchronously and prevents extensions from re-exposing
    // schemas while Tools is off.
    context.systemPromptDisabledEntries = next;
    if (!toolsWereDisabled && toolsWillBeDisabled) {
      context.session.setActiveToolsByName?.([]);
    } else if (toolsWereDisabled && !toolsWillBeDisabled) {
      const restore = context.systemPromptToolsBeforeDisable
        ?? context.session.getAllTools?.().map((tool) => tool.name)
        ?? [];
      context.session.setActiveToolsByName?.(restore);
      context.systemPromptToolsBeforeDisable = undefined;
    }

    await writeSystemPromptTogglesForSession(sessionPath, next);
    await this.applySystemPromptTogglesToBasePrompt(context, next);
  }

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    // Model updates run in the backend while pruning updates run in the
    // extension host. Share the same cross-process lock so their
    // read-modify-write cycles cannot silently overwrite each other.
    await updateSettingsJsonObject(settingsPath, (existing) => ({ ...existing, ...updates }));
    return await this.readModelSettings();
  }

  private async emitSessionOpened(sessionPath: string, selectionToken?: string, operationId?: string): Promise<void> {
    if (this.disposed || !this.sessionContexts.has(sessionPath)) {
      return;
    }
    // Rejection-safe: most callers fire-and-forget this (`void …`). A thrown
    // payload build (transcript scan, context usage, system prompts) must log
    // and swallow instead of becoming an unhandled rejection that leaves the
    // host waiting on a `session.opened` that never arrives.
    try {
      const payload = await this.buildSessionOpenedPayload(sessionPath, selectionToken, undefined, undefined, operationId);
      this.emit('session.opened', payload);
    } catch (error) {
      backendWarn('backend-session', 'emitSessionOpened.failed', {
        sessionPath,
        error: toErrorMessage(error),
      });
    }
  }

  private async buildHotSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: import('../shared/transcript-window').SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
  ): Promise<SessionOpenedPayload> {
    return await buildSessionOpenedPayloadHelper(sessionPath, {
      getContextUsage: (context) => this.getContextUsage(context),
      readHarnessSystemPrompt: (context) => this.readHarnessSystemPrompt(context),
      buildSystemPrompts: (context, override) => this.buildSystemPrompts(context, override),
      readModelSettings: () => this.readModelSettings(),
      getPinnedStreamingMessageId: (context) => this.getPinnedStreamingMessageId(context),
      getSessionContext: (path) => this.getSessionContext(path),
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
    }, selectionToken, transcript, transport, operationId, operationAttempt);
  }

  private async buildAuthoritativeHotSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: import('../shared/transcript-window').SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
  ): Promise<SessionOpenedPayload> {
    while (true) {
      const owner = await this.resolveBrowseContext(sessionPath);
      if (!owner) throw new BackendError('SESSION_NOT_FOUND', `Unknown session: ${sessionPath}`);
      const payload = await this.buildHotSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
      if (this.disposed || this.isSessionForgotten(sessionPath)) {
        throw new BackendError('SESSION_NOT_FOUND', `The session is no longer available: ${sessionPath}`);
      }
      if (this.getPendingSessionContext(sessionPath)
        || this.getSessionContext(sessionPath) !== owner) continue;
      this.sessionOpenedPayloadOwners.set(payload, owner);
      this.browseResponseOwners.set(payload, { sessionPath, owner });
      return payload;
    }
  }

  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: import('../shared/transcript-window').SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
  ): Promise<SessionOpenedPayload> {
    return await timed('buildSessionOpenedPayload', async () => {
      const initialOwner = await this.resolveBrowseContext(sessionPath);
      if (initialOwner) {
        if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
        return await this.buildAuthoritativeHotSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
      }
      const catalog = await loadConfiguredModels(this.agentDir);
      const availableModels = catalog.models;
      const afterCatalog = await this.resolveBrowseContext(sessionPath);
      if (afterCatalog) {
        if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
        return await this.buildAuthoritativeHotSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
      }
      const modelSettings = await this.readModelSettings();
      const afterSettings = await this.resolveBrowseContext(sessionPath);
      if (afterSettings) {
        if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
        return await this.buildAuthoritativeHotSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
      }
      const store = this.initializeColdSessionStore();
      const retained = this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath));
      try {
        const options = {
          modelSettings,
          availableModels: catalog.ok ? availableModels : undefined,
          selectionToken,
          transcript,
          transport,
          operationId,
          operationAttempt,
        };
        const payload = retained
          ? await store.openHandleSnapshot(retained.handle, options)
          : await store.openSnapshot(sessionPath, options);
        if (this.getPendingSessionContext(sessionPath) || this.getSessionContext(sessionPath)) {
          return await this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
        }
        this.sessionOpenedPayloadOwners.set(payload, undefined);
        this.registerColdResult(payload);
        return payload;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) {
          if (retained
            && this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath)) === retained) {
            // An external durable rewrite invalidates a retained empty manager.
            // Evict it once; the retry reopens current durable authority rather
            // than selecting the same stale handle forever.
            this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
            return await this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
          }
          if (this.getPendingSessionContext(sessionPath) || this.getSessionContext(sessionPath)) {
            return await this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt);
          }
          throw new BackendError(
            'SESSION_CHANGED_DURING_READ',
            `The session changed while its cold snapshot was being built: ${sessionPath}`,
          );
        }
        throw error;
      }
    });
  }

  private async emitSessionListChanged(): Promise<void> {
    if (this.disposed) return;
    // Rejection-safe: most callers fire-and-forget this (`void …`). A thrown
    // session-list scan must log and swallow instead of becoming an unhandled
    // rejection; the next catalog poll/emit refreshes the list opportunistically.
    try {
      const sessions = await this.listSessionSummaries();
      const payload: SessionListChangedPayload = {
        sessions,
        activeSessionPath: this.viewedSessionPath,
      };
      this.coldSessionStore?.transferOwnershipStamp(sessions, payload);
      this.emit('session.list.changed', payload);
    } catch (error) {
      backendWarn('backend-session', 'emitSessionListChanged.failed', {
        error: toErrorMessage(error),
      });
    }
  }

  private async listSessionSummaries(): Promise<SessionSummary[]> {
    if (this.runtimeIsolationMode === 'isolated' && (this.sessionContexts.size > 0 || this.pendingSessionContexts.size > 0)) {
      throw new BackendError(
        'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
        'Hot session listing requires Phase 4 isolated-runtime routing.',
      );
    }
    const liveSummaries = [...this.sessionContexts.values()]
      .filter((context) => !context.retired)
      .map((context) => buildCurrentSummary(context, this.startupCwd));
    const result = await this.initializeColdSessionStore().list(liveSummaries);
    return result;
  }

  /** Start durable closure reconciliation. The watcher is a low-latency hint;
   * an unconditional startup list and the bounded sidecar fingerprint poll are
   * the correctness paths, including after a backend restart. */
  private startReviewReconciliation(): void {
    ensureReviewsDir();
    this.refreshReviewSidecarState(true);
    this.stopReviewWatcher = startReviewWatcher(() => {
      this.refreshReviewSidecarState();
      void this.emitSessionListChanged();
    });
    this.startSessionCatalogPolling();
    void this.emitSessionListChanged();
  }

  /** Refresh parsed closure state only when its cheap file fingerprint moves.
   * `force` establishes the startup baseline even when construction happened
   * after PIE_REVIEWS_DIR was already configured. */
  private refreshReviewSidecarState(force = false): boolean {
    const fingerprint = getReviewSidecarFingerprint();
    const changed = fingerprint !== this.reviewSidecarFingerprint;
    if (force || changed) {
      this.reviewSidecarFingerprint = fingerprint;
      this.reviewClosureReconciliationPending = hasActiveReviewClosureActions();
    }
    return changed;
  }

  private startSessionCatalogPolling(intervalMs = SESSION_CATALOG_POLL_INTERVAL_MS): void {
    if (this.sessionCatalogPollTimer) return;
    this.sessionCatalogPollingActive = true;
    this.sessionCatalogPollTimer = setInterval(() => {
      void this.pollSessionCatalog();
    }, intervalMs);
    this.sessionCatalogPollTimer.unref();
  }

  private async pollSessionCatalog(): Promise<void> {
    if (!this.sessionCatalogPollingActive || this.sessionCatalogPollInFlight) return;
    this.sessionCatalogPollInFlight = true;
    let catalogChanged = false;
    try {
      catalogChanged = await this.sessionCatalog.invalidateIfInventoryChanged(
        this.agentDir,
        this.getSessionDir(),
      );
    } catch (error) {
      backendWarn('backend-session', 'catalogInventoryPoll.failed', {
        error: toErrorMessage(error),
      });
    }

    try {
      const sidecarChanged = this.refreshReviewSidecarState();
      // Cached active actions force a bounded retry even when a prior list scan
      // failed after the watcher/fingerprint wake was consumed. The cache is
      // reparsed only when the append-only sidecar fingerprint changes.
      if ((catalogChanged || sidecarChanged || this.reviewClosureReconciliationPending)
        && this.sessionCatalogPollingActive) {
        await this.emitSessionListChanged();
      }

      // Phase 6 monotonic sync: auth fingerprint refresh bumps/broadcasts (or
      // retires unacknowledging workers) and a moved models.json re-broadcasts
      // the configured catalog authority. Both are best-effort poll extensions;
      // the next poll retries a failed broadcast.
      if (this.runtimeIsolationMode === 'isolated' && this.workerRuntimeRouter) {
        try {
          const authPath = this.authPath || path.join(this.agentDir, 'auth.json');
          const authFingerprint = await fs.stat(authPath)
            .then((stat) => `${stat.size}:${stat.mtimeMs}`)
            .catch(() => 'missing');
          if (authFingerprint !== this.authFingerprint) {
            this.authFingerprint = authFingerprint;
            await this.workerRuntimeRouter.refreshAuth(authFingerprint, authPath);
          }
        } catch (error) {
          backendWarn('backend-session', 'authFingerprintPoll.failed', {
            error: toErrorMessage(error),
          });
        }
        try {
          const modelsPath = path.join(this.agentDir, 'models.json');
          const modelsFingerprint = await fs.stat(modelsPath)
            .then((stat) => `${stat.size}:${stat.mtimeMs}`)
            .catch(() => 'missing');
          if (modelsFingerprint !== this.modelsJsonFingerprint) {
            this.modelsJsonFingerprint = modelsFingerprint;
            const catalog = await loadConfiguredModels(this.agentDir);
            if (catalog.ok) {
              await this.workerRuntimeRouter.syncCatalog(catalog.models as unknown as WorkerJsonValue[]);
            }
          }
        } catch (error) {
          backendWarn('backend-session', 'modelsJsonPoll.failed', {
            error: toErrorMessage(error),
          });
        }
      }
    } finally {
      this.sessionCatalogPollInFlight = false;
    }
  }

  private emitBusyChanged(context: SessionContext, busy: boolean): void {
    context.busySeq += 1;
    const payload: BusyChangedPayload = {
      sessionPath: context.sessionPath,
      busy,
      seq: context.busySeq,
    };
    this.emit('busy.changed', payload);
  }

  private emit(event: string, payload?: unknown): void {
    // After disposal begins, suppress every event so in-flight async paths
    // (recovery replacement emissions, catalog polling, late SDK events) cannot
    // push stale state to a host that is already tearing the backend down.
    if (this.disposed) return;
    if (event === 'session.list.changed' && payload && typeof payload === 'object'
      && this.coldSessionStore?.ownershipStamp(payload as object)) {
      try {
        this.coldSessionStore.publishSync(payload, () => undefined);
      } catch (error) {
        if (!(error instanceof StaleColdSessionLeaseError)) throw error;
        void this.emitSessionListChanged();
        return;
      }
    }
    if (event === 'session.opened' && payload && typeof payload === 'object') {
      const opened = payload as Partial<SessionOpenedPayload>;
      const sessionPath = opened.session?.path;
      if (typeof sessionPath === 'string') {
        const coldStamps = this.coldSessionStore?.ownershipStamp(payload as object);
        if (coldStamps) {
          try {
            this.coldSessionStore!.publishSync(payload, () => undefined);
          } catch (error) {
            if (!(error instanceof StaleColdSessionLeaseError)) throw error;
            if (this.isSessionForgotten(sessionPath)) return;
            void this.buildSessionOpenedPayload(
              sessionPath,
              opened.selectionToken,
              opened.transcriptSkipped ? 'skip' : 'tail',
              undefined,
              opened.operationId,
              opened.operationAttempt,
            ).then((authoritative) => this.emit('session.opened', authoritative)).catch((refreshError) => {
              backendWarn('backend-session', 'sessionOpened.coldPublicationRefreshFailed', {
                sessionPath,
                error: toErrorMessage(refreshError),
              });
            });
            return;
          }
        }
        // Final publication fence: ownership can change after the payload's
        // last awaited check but before its caller resumes to emit. Rebuild on
        // the winning generation while preserving selection ownership instead
        // of silently dropping the tokened open event.
        if (this.isSessionForgotten(sessionPath)) return;
        if (this.sessionOpenedPayloadOwners.has(payload as object)) {
          const payloadOwner = this.sessionOpenedPayloadOwners.get(payload as object);
          const currentOwner = this.getSessionContext(sessionPath);
          if (this.getPendingSessionContext(sessionPath) || currentOwner !== payloadOwner) {
            void this.buildSessionOpenedPayload(
              sessionPath,
              opened.selectionToken,
              opened.transcriptSkipped ? 'skip' : 'tail',
              undefined,
              opened.operationId,
              opened.operationAttempt,
            ).then((authoritative) => this.emit('session.opened', authoritative)).catch((error) => {
              backendWarn('backend-session', 'sessionOpened.publicationRefreshFailed', {
                sessionPath,
                error: toErrorMessage(error),
              });
            });
            return;
          }
        }
        if (opened.runtimeReady === false
          && (this.getPendingSessionContext(sessionPath) || this.getSessionContext(sessionPath))) return;
      }
    }
    if (event === 'extension_ui.request' && payload && typeof payload === 'object') {
      const request = payload as { sessionPath?: unknown; id?: unknown };
      if (typeof request.sessionPath === 'string' && typeof request.id === 'string') {
        const context = this.sessionContexts.get(request.sessionPath);
        const accumulator = context?.activeRequest?.liveTurnAccumulator;
        if (accumulator) {
          if (context?.activeRequest?.semanticLeaseTimer) {
            clearTimeout(context.activeRequest.semanticLeaseTimer);
            context.activeRequest.semanticLeaseTimer = undefined;
          }
          this.emit('live.semantic', accumulator.observe({
            kind: 'turn.extensionUi', uiRequestId: request.id, action: 'opened',
          }, Date.now()));
        }
      }
    }
    if (isBackendLivePipelineTraceEnabled()) {
      const scoped = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
      recordBackendLivePipelineTrace({
        stage: 'backend.mapped',
        kind: 'success',
        identifiers: {
          ...(typeof scoped?.sessionPath === 'string' ? { session: scoped.sessionPath } : {}),
          ...(typeof scoped?.requestId === 'string' ? { request: scoped.requestId } : {}),
          ...(typeof scoped?.turnId === 'string' ? { turn: scoped.turnId } : {}),
          ...(typeof scoped?.attemptId === 'string' ? { attempt: scoped.attemptId } : {}),
          ...(typeof scoped?.messageId === 'string' ? { message: scoped.messageId } : {}),
          ...(typeof scoped?.toolCallId === 'string' ? { tool: scoped.toolCallId } : {}),
        },
        eventKind: backendTraceEventKind(event),
        eventSeq: typeof scoped?.seq === 'number' && Number.isSafeInteger(scoped.seq) && scoped.seq >= 0
          ? scoped.seq
          : undefined,
      });
    }
    writeStdout({ event, payload });
  }

  private isBrowseResponseCurrent(result: unknown): boolean {
    if (!result || typeof result !== 'object') return true;
    if (this.coldSessionStore?.ownershipStamp(result as object)) {
      try {
        this.coldSessionStore.publishSync(result, () => undefined);
      } catch {
        return false;
      }
    }
    const stamp = this.browseResponseOwners.get(result as object);
    if (!stamp) return true;
    if (this.disposed || this.isSessionForgotten(stamp.sessionPath)
      || this.getPendingSessionContext(stamp.sessionPath)) return false;
    const current = this.getSessionContext(stamp.sessionPath);
    if (stamp.owner) return current === stamp.owner;
    if (current || !stamp.fingerprint) return false;
    try {
      return this.readColdBrowseFileFingerprintSync(stamp.sessionPath) === stamp.fingerprint;
    } catch {
      return false;
    }
  }

  async handleLine(line: string): Promise<void> {
    let request: RequestEnvelope;
    try {
      request = parseJsonOrThrow<RequestEnvelope>(line, 'request envelope');
    } catch (error) {
      writeStdout(responseError('parse-error', 'PARSE_ERROR', String(error)));
      return;
    }

    backendTrace('request', 'received', { id: request.id, method: request.method });
    // Reserve the diagnostics-toggle generation at production request
    // receipt, before any awaited handler work, so concurrent toggle requests
    // are ordered by receipt, not settlement. The reserved generation is
    // bound to this exact request and gates its off transition at completion:
    // an older off settling after a newer on must not disable tracing or stop
    // the event-loop monitor. Invalid toggles never reserve (they never
    // apply), so they cannot supersede a valid request's transition.
    const toggleGeneration = request.method === 'diagnostics.livePipeline.setEnabled'
      && parseLivePipelineToggleParams(request.params)
      ? this.reserveLivePipelineTraceToggle()
      : undefined;
    recordBackendLivePipelineTrace({
      stage: 'backend.request',
      kind: 'observation',
      phase: 'request_received',
      identifiers: { request: request.id },
      processRole: 'coordinator',
      pid: process.pid,
    });
    const requestStartedAt = performance.now();
    let requestValidated = false;
    const onRequestValidated = (): void => {
      if (requestValidated) return;
      requestValidated = true;
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'success',
        phase: 'request_validated',
        identifiers: { request: request.id },
        processRole: 'coordinator',
        pid: process.pid,
      });
    };
    const invoke = () => this.handleRequest(request, onRequestValidated, toggleGeneration);
    // Exactly one finish/error completion per request: the success record is
    // emitted only after the final (possibly retried) handler run settles, and
    // a later response-write failure must not also emit a failure completion.
    let completionEmitted = false;
    try {
      let result = await timed(`request:${request.method}:${request.id}`, invoke);
      // Correlated browse responses do not pass through emit(), so perform the
      // generation/file fence at the actual writer boundary. The check and
      // write are synchronous with no event-loop gap; a superseded result is
      // rebuilt from the winning hot owner or fresh durable file.
      for (let attempt = 0; !this.isBrowseResponseCurrent(result); attempt += 1) {
        if (attempt >= 2) {
          throw new BackendError(
            'SESSION_CHANGED_DURING_READ',
            `The session changed repeatedly while ${request.method} was being published.`,
          );
        }
        result = await invoke();
      }
      backendTrace('request', 'handled', { id: request.id, method: request.method });
      recordBackendLivePipelineTrace({
        stage: 'backend.request',
        kind: 'success',
        phase: 'handler_finished',
        durationMs: Math.max(0, performance.now() - requestStartedAt),
        identifiers: { request: request.id },
        processRole: 'coordinator',
        pid: process.pid,
      });
      completionEmitted = true;
      if (this.completeLivePipelineTraceDisable(request.id)
        && result && typeof result === 'object' && 'health' in result) {
        // handleBackendRequest composes the same public response shape before
        // returning, while the server owns the actual off transition. Refresh
        // only the already-public health field after the atomic transition.
        result = { ...result, health: getBackendLivePipelineTraceHealth() };
      }
      writeStdout(responseOk(request.id, result));
    } catch (error) {
      this.cancelLivePipelineTraceDisable(request.id);
      const details = extractRequestError(error);
      // A correlated handler failure has exactly one public owner: the RPC
      // response. Emitting a second generic `error` event made the host show and
      // count the same failure twice. Structured trace/stderr remains the
      // diagnostic channel; later asynchronous incidents use their dedicated
      // event families and identities.
      backendTrace('request', 'error', { level: 'warn', id: request.id, method: request.method, code: details.code, message: details.message });
      if (!completionEmitted) {
        recordBackendLivePipelineTrace({
          stage: 'backend.request',
          kind: 'failure',
          phase: 'handler_finished',
          durationMs: Math.max(0, performance.now() - requestStartedAt),
          identifiers: { request: request.id },
          reasonCode: 'unknown_unattributable',
          processRole: 'coordinator',
          pid: process.pid,
        });
      }
      writeStdout(responseError(request.id, details.code, details.message, details.data));
    }
  }

  /** Retire a private session runtime and remove every durable session-side
   *  artifact. Called only after the host has chosen privacy mode; ordinary
   *  tab closes intentionally keep sessions reopenable. */
  private async forgetSession(sessionPath: string): Promise<void> {
    const hasHotOwner = !!this.getSessionContext(sessionPath) || !!this.getPendingSessionContext(sessionPath);
    if (this.runtimeIsolationMode === 'isolated' && hasHotOwner) {
      this.assertColdCoordinatorOwner(sessionPath);
    }
    if (!hasHotOwner) {
      this.forgottenSessionPaths.add(sessionPath);
      this.browsePreviousSessionFiles.delete(sessionPath);
      const store = this.initializeColdSessionStore();
      try {
        await this.runColdSessionMutation(sessionPath, async () => {
          store.leases.invalidate(sessionPath);
          this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
          await store.forget(sessionPath);
        });
        if (this.viewedSessionPath === sessionPath) this.setViewedSessionPath(undefined);
      } catch (error) {
        this.forgottenSessionPaths.delete(sessionPath);
        throw error;
      }
      return;
    }

    this.initializeColdSessionStore().leases.invalidate(sessionPath);
    this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
    this.forgottenSessionPaths.add(sessionPath);
    this.browsePreviousSessionFiles.delete(sessionPath);
    const pending = this.getPendingSessionContext(sessionPath);
    if (pending) await pending.catch(() => undefined);
    const context = this.getSessionContext(sessionPath);
    if (context) {
      context.retired = true;
      context.sessionManagerFence?.invalidate();
      context.willRetryWatchdogClear?.();
      context.willRetryWatchdogClear = undefined;
      const active = context.activeRequest;
      if (active) {
        active.aborted = true;
        if (active.promptSafetyTimer) clearTimeout(active.promptSafetyTimer);
        if (active.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
        if (active.quotaSettlementTimer) clearTimeout(active.quotaSettlementTimer);
        active.pendingDurableToolTerminals?.clear();
        context.activeRequest = undefined;
        await Promise.race([
          Promise.resolve().then(() => context.session.abort()).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
      try { context.uiBridge?.dispose(); } catch { /* best effort */ }
      try { context.unsubscribe(); } catch { /* best effort */ }
      try {
        await this.disposeRuntimeBounded(context.runtime, context.sessionPath);
      } finally {
        this.sessionContexts.delete(sessionPath);
      }
    }

    let transcriptDeleted = false;
    try {
      // Review/system-prompt sidecars are fallible and must be removed before
      // transcript deletion commits; otherwise a cleanup failure could leave a
      // recoverable private transcript with its forget tombstone removed.
      await forgetPrivateSessionArtifacts(sessionPath);
      transcriptDeleted = true;
      this.sessionCatalog.remove(sessionPath);
      if (this.viewedSessionPath === sessionPath) this.setViewedSessionPath(undefined);
    } catch (error) {
      // Once transcript deletion commits the tombstone is permanent. There are
      // deliberately no fallible operations after that boundary.
      if (!transcriptDeleted) this.forgottenSessionPaths.delete(sessionPath);
      throw error;
    }
    // Keep the successful tombstone for the life of this backend process so a
    // queued session.open cannot recreate the deleted file after this RPC.
  }

  private async handleRequest(
    request: RequestEnvelope,
    onRequestValidated?: () => void,
    livePipelineTraceToggleGeneration?: number,
  ): Promise<unknown> {
    if (this.runtimeIsolationMode === 'isolated') {
      const router = this.workerRuntimeRouter;
      if (router) {
        const sessionPath = requestSessionPath(request.params);
        const routeState = sessionPath ? router.getRoute(sessionPath) : undefined;
        if (routeState?.state === 'transitioning' && request.method !== 'session.truncateAfter') {
          throw new BackendError(
            'SESSION_TRANSITION_IN_PROGRESS',
            `Session transition is already in progress for ${sessionPath}.`,
          );
        }
        if (request.method === 'message.interrupt' && sessionPath && router.hasHotOwner(sessionPath)) {
          onRequestValidated?.();
          const result = await router.interrupt(sessionPath, `public request ${request.id}`);
          return result.soft
            ? { interrupted: true, settled: true }
            : { interrupted: true, settled: false, teardownTimedOut: true };
        }
        // Phase 5 demand-driven subagent detail. These are router/store-level
        // operations, not worker runtime commands: subscribe/unsubscribe/fetch
        // settle as correlated control responses while stream content crosses
        // only through the six `detail.stream` events. Hot live sources are
        // answered by the owning worker; terminal/cold sources are answered by
        // the coordinator's durable paged authority directly from the durable
        // JSONL (never one >30 MiB response).
        if (request.method === 'detail.subscribe' || request.method === 'detail.unsubscribe' || request.method === 'detail.fetch') {
          onRequestValidated?.();
          if (request.method === 'detail.subscribe') {
            const params = validateDetailSubscribe(request.params);
            await this.routeDetailSubscribe(request.id, params);
          } else if (request.method === 'detail.unsubscribe') {
            const params = validateDetailUnsubscribe(request.params);
            await this.routeDetailUnsubscribe(request.id, params);
          } else {
            const params = validateDetailFetch(request.params);
            await this.routeDetailFetch(request.id, params);
          }
          return { accepted: true };
        }
        if (request.method === 'session.truncateAfter' && sessionPath) {
          const transition = router.getRoute(sessionPath);
          if (transition.state === 'promoting') await transition.promotion;
          else if (transition.state === 'retiring') await transition.retirement;
        }
        if (request.method === 'session.truncateAfter' && sessionPath
            && (router.hasHotOwner(sessionPath) || router.getRoute(sessionPath).state === 'transitioning')) {
          const params = validateTruncateAfter(request.params);
          onRequestValidated?.();
          // Install the transition synchronously before the first interrupt
          // await. Same-entry retries join this exact transaction; every other
          // path-scoped command is fenced by SESSION_TRANSITION_IN_PROGRESS.
          return await router.runHotTransition(
            sessionPath,
            `hot-truncate:${params.entryId}`,
            async (transition) => {
              await transition.interrupt(`hot truncate ${request.id}`);
              await transition.retire('hot truncate quiesced');
              const store = this.initializeColdSessionStore();
              const handle = await this.runColdSessionMutation(sessionPath, async () => {
                const truncated = await store.truncateAfter(sessionPath, params.entryId);
                this.retainColdSessionManager(truncated, 'resume');
                return truncated;
              });
              await transition.promote(handle.sessionPath);
              void this.emitSessionListChanged();
              return { ok: true, sessionPath: handle.sessionPath };
            },
          );
        }
        if (request.method === 'session.forget' && sessionPath && router.hasHotOwner(sessionPath)) {
          await router.retire(sessionPath, 'session forgotten');
        } else if (sessionPath && WorkerRuntimeRouter.isHotOperation(request.method)) {
          if (request.method === 'extension_ui.response' && !router.hasHotOwner(sessionPath)) {
            // A response for a session whose worker is gone (crashed, retired,
            // or replaced) is correlated typed-stale: never promote a fresh
            // worker just to reject it, and never invoke any worker callback.
            throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
          }
          const shouldPromote = ISOLATED_PROMOTION_METHODS.has(request.method)
            || request.method === 'settings.set';
          if (shouldPromote) return await router.route(request);
          if (router.hasHotOwner(sessionPath)) return await router.routeExisting(request);
          if (!isPhase3IsolatedCoordinatorOperationAllowed(request.method, request.params)) {
            throw new BackendError('SESSION_NOT_FOUND', `No hot worker owns ${sessionPath}.`);
          }
        }
      }
      if (!isPhase3IsolatedCoordinatorOperationAllowed(request.method, request.params)) {
        throw new BackendError(
          'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
          router
            ? `Operation ${request.method} requires an isolated runtime owner and cannot use the coordinator runtime.`
            : `Operation ${request.method} requires Phase 4 isolated-runtime routing; Phase 4 isolated-runtime routing is unavailable.`,
        );
      }
    }
    const sessionDir = this.getSessionDir();
    const result = await handleBackendRequest({
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sessionDir,
      sdk: this.sdk,
      getSessionContext: (sessionPath) => {
        const context = this.getSessionContext(sessionPath);
        if (this.runtimeIsolationMode === 'isolated'
          && (context || (sessionPath && this.getPendingSessionContext(sessionPath)))) {
          this.assertColdCoordinatorOwner(sessionPath!);
        }
        return context;
      },
      createSessionContext: (sessionManager, reason) => this.createSessionContext(sessionManager, reason),
      ensureSessionContext: (sessionPath) => this.ensureSessionContext(sessionPath),
      createColdSession: (cwd) => {
        const handle = this.initializeColdSessionStore().create({ cwd });
        this.retainColdSessionManager(handle, 'new');
        return { sessionPath: handle.sessionPath };
      },
      duplicateColdSession: (sessionPath) => {
        if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
        const handle = this.initializeColdSessionStore().duplicate(sessionPath);
        this.retainColdSessionManager(handle, 'new');
        return { sessionPath: handle.sessionPath };
      },
      truncateColdSessionAfter: async (sessionPath, entryId) => {
        const hasOwner = !!this.getSessionContext(sessionPath) || !!this.getPendingSessionContext(sessionPath);
        if (hasOwner) {
          if (this.runtimeIsolationMode === 'isolated') this.assertColdCoordinatorOwner(sessionPath);
          throw new BackendError('REQUEST_IN_PROGRESS', `Cannot cold-truncate an owned session: ${sessionPath}`);
        }
        const store = this.initializeColdSessionStore();
        const handle = await this.runColdSessionMutation(sessionPath, async () => {
          store.leases.invalidate(sessionPath);
          this.coldSessionManagerHandles.delete(this.coldManagerKey(sessionPath));
          const truncated = await store.truncateAfter(sessionPath, entryId);
          // Retention is part of the mutation owner. A promotion waiting on the
          // mutation cannot resume between durable commit and handle install.
          this.retainColdSessionManager(truncated, 'resume');
          return truncated;
        });
        return { sessionPath: handle.sessionPath };
      },
      isSessionTransitionPending: (sessionPath) => !!this.getPendingSessionContext(sessionPath),
      transitionSessionContext: (sessionPath, transition) => this.transitionSessionContext(sessionPath, transition),
      prepareViewedSessionPath: (sessionPath) => this.prepareViewedSessionPath(sessionPath),
      discardPreparedViewedSessionPath: (sessionPath, token) => this.discardPreparedViewedSessionPath(
        sessionPath,
        token as PreparedViewedSessionTransition | undefined,
      ),
      commitPreparedViewedSessionPath: (sessionPath, token) => this.commitPreparedViewedSessionPath(
        sessionPath,
        token as PreparedViewedSessionTransition | undefined,
      ),
      recordViewedSessionTransition: (sessionPath, previousSessionPath) => (
        this.recordViewedSessionTransition(sessionPath, previousSessionPath)
      ),
      captureViewedSessionRevision: () => this.viewedSessionRevision,
      setViewedSessionPathIfCurrent: (sessionPath, revision) => (
        this.setViewedSessionPathIfCurrent(sessionPath, revision)
      ),
      setViewedSessionPath: (sessionPath) => this.setViewedSessionPath(sessionPath),
      buildSessionOpenedPayload: (sessionPath, selectionToken, transcript, transport, operationId, operationAttempt) => (
        this.buildSessionOpenedPayload(sessionPath, selectionToken, transcript, transport, operationId, operationAttempt)
      ),
      createOperationLedger: this.createOperationLedger,
      buildTransitionSessionOpenedPayload: (sessionPath) => (
        this.buildHotSessionOpenedPayload(sessionPath)
      ),
      applySystemPromptToggles: (sessionPath, disabledEntries) => (
        this.applySystemPromptToggles(sessionPath, disabledEntries)
      ),
      setAutonomousMode: (enabled) => this.setAutonomousMode(enabled),
      forgetSession: (sessionPath) => this.forgetSession(sessionPath),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd)
      ),
      loadDetail: (sessionPath, ref) => this.loadDetail(sessionPath, ref),
      transferBrowseResponseOwnership: (source, target) => {
        const owner = this.browseResponseOwners.get(source);
        if (owner) this.browseResponseOwners.set(target, owner);
        this.coldSessionStore?.transferOwnershipStamp(source, target);
      },
      emit: (event, payload) => this.emit(event, payload),
      emitBusyChanged: (context, busy) => this.emitBusyChanged(context, busy),
      emitContextUsageChanged: (sessionContext) => this.emitContextUsageChanged(sessionContext),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      listSessions: () => this.listSessionSummaries(),
      listAvailableModels: async (context) => {
        const catalog = context
          ? loadAvailableModels(context, this.agentDir)
          : await loadConfiguredModels(this.agentDir);
        if (!catalog.ok) {
          throw new BackendError('MODEL_CATALOG_UNAVAILABLE', `Unable to load the model catalog: ${catalog.error}`);
        }
        return catalog.models;
      },
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
      onRequestValidated,
      suppressRequestTrace: true,
      livePipelineTraceToggleGeneration,
      deferLivePipelineTraceDisable: (requestId, generation, onApplied) => (
        this.deferLivePipelineTraceDisable(requestId, generation, onApplied)
      ),
      onLivePipelineTraceEnabledChange: (enabled) => {
        if (enabled) this.markLivePipelineTraceEnabled();
        else this.stopEventLoopMonitor();
      },
    }, request);
    if (this.runtimeIsolationMode === 'isolated' && request.method === 'runtimePrefs.set'
      && result && typeof result === 'object' && !Array.isArray(result)) {
      this.runtimePrefs = JSON.parse(JSON.stringify(result)) as WorkerJsonObject;
      await this.workerRuntimeRouter?.syncRuntimePrefs(this.runtimePrefs);
      const providerConcurrency = this.runtimePrefs.providerConcurrency;
      await this.workerRuntimeRouter?.syncProviderPolicy(
        providerConcurrency && typeof providerConcurrency === 'object' && !Array.isArray(providerConcurrency)
          ? providerConcurrency as WorkerJsonObject
          : {},
      );
    }
    if (this.runtimeIsolationMode === 'isolated' && request.method === 'settings.set'
      && (!request.params || typeof request.params !== 'object' || !('sessionPath' in request.params))
      && result && typeof result === 'object' && !Array.isArray(result)) {
      // A global settings write bypasses worker routing (session-scoped writes
      // are routed to the owning worker, which persists and broadcasts). Hot
      // workers must not serve the pre-write snapshot, so re-broadcast the
      // coordinator-authoritative values after the write settles.
      await this.workerRuntimeRouter?.syncSettings();
    }
    return result;
  }

  private handleSessionEvent(context: SessionContext, event: SdkSessionEvent): void {
    if (context.retired) return;
    handleSdkSessionEvent({
      emit: (name, payload) => this.emit(name, payload),
      emitBusyChanged: (sessionContext, busy) => this.emitBusyChanged(sessionContext, busy),
      emitContextUsageChanged: (sessionContext, postCompactionEstimatedTokens) => (
        this.emitContextUsageChanged(sessionContext, postCompactionEstimatedTokens)
      ),
      emitSessionOpened: (sessionPath, selectionToken) => this.emitSessionOpened(sessionPath, selectionToken),
      emitSessionListChanged: () => this.emitSessionListChanged(),
      recoverStuckSession: (sessionContext, reason) => {
        void this.recoverStuckSession(sessionContext, reason);
      },
    }, context, event);
  }

  /**
   * Locally terminalize a stuck runtime immediately, then replace it without
   * waiting for provider teardown. The old runtime is fenced before any async
   * work so late SDK events cannot revive or terminalize the request twice.
   */
  private recoverStuckSession(context: SessionContext, reason: string): void {
    if (context.retired || context.recoveryPromise) return;
    const active = context.activeRequest;
    if (!active) {
      return;
    }

    const requestId = active.id;
    const messageId = active.lastAssistantMessageId ?? active.currentMessageId;
    context.retired = true;
    const bestEffort = (operation: string, action: () => void): void => {
      try {
        action();
      } catch (error) {
        backendWarn('backend-session', `stuck runtime ${operation} failed`, {
          sessionPath: context.sessionPath,
          requestId,
          error: toErrorMessage(error),
        });
      }
    };
    bestEffort('session manager fence', () => context.sessionManagerFence?.invalidate());
    bestEffort('watchdog cleanup', () => context.willRetryWatchdogClear?.());
    context.willRetryWatchdogClear = undefined;
    if (active.promptSafetyTimer) clearTimeout(active.promptSafetyTimer);
    if (active.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
    if (active.quotaSettlementTimer) clearTimeout(active.quotaSettlementTimer);
    active.promptSafetyTimer = undefined;
    active.semanticLeaseTimer = undefined;
    active.quotaSettlementTimer = undefined;
    active.pendingDurableToolTerminals?.clear();
    active.aborted = true;
    if (active.liveTurnAccumulator) {
      context.terminalLiveTurn = {
        accumulator: active.liveTurnAccumulator,
        expiresAt: Date.now() + 10_000,
      };
    }
    context.activeRequest = undefined;
    bestEffort('UI disposal', () => context.uiBridge?.dispose());
    bestEffort('queue cleanup', () => { context.session.clearQueue(); });
    context.queuedLocalIds = [];
    bestEffort('retry abort', () => context.session.abortRetry?.());
    bestEffort('compaction abort', () => context.session.abortCompaction?.());
    bestEffort('branch-summary abort', () => context.session.abortBranchSummary?.());
    bestEffort('bash abort', () => context.session.abortBash?.());

    this.emit('message.aborted', {
      requestId,
      sessionPath: context.sessionPath,
      messageId,
      userInitiated: false,
      reason,
    } satisfies MessageAbortedPayload);

    let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = Promise.resolve()
      .then(() => context.session.abort())
      .then(
        () => 'settled' as const,
        (error) => {
          backendWarn('backend-session', 'stuck runtime abort failed', {
            sessionPath: context.sessionPath,
            requestId,
            error: toErrorMessage(error),
          });
          return 'failed' as const;
        },
      );
    const abortGrace = new Promise<'timeout'>((resolve) => {
      abortGraceTimer = setTimeout(() => resolve('timeout'), 5_000);
      abortGraceTimer.unref?.();
    });
    void Promise.race([abort, abortGrace]).then((outcome) => {
      if (abortGraceTimer) clearTimeout(abortGraceTimer);
      if (outcome === 'timeout') {
        backendWarn('backend-session', 'stuck runtime abort did not settle within grace', {
          sessionPath: context.sessionPath,
          requestId,
        });
      }
    });

    const replacementPromise = this.transitionSessionContext(
      context.sessionPath,
      async () => {
        const replacement = await this.createSessionContext(
          this.sdk.SessionManager.open(context.sessionPath),
          'resume',
        );
        this.emitBusyChanged(replacement, false);
        await Promise.allSettled([
          (async () => {
            // This callback is itself the pendingSessionContexts owner for the
            // path. The public build/emit path resolves that owner first, so
            // calling it here would await this transition's own promise.
            try {
              if (this.disposed || this.forgottenSessionPaths.has(replacement.sessionPath)
                || this.sessionContexts.get(replacement.sessionPath) !== replacement) return;
              const payload = await this.buildHotSessionOpenedPayload(replacement.sessionPath);
              if (this.disposed || this.forgottenSessionPaths.has(replacement.sessionPath)
                || this.sessionContexts.get(replacement.sessionPath) !== replacement) return;
              this.emit('session.opened', payload);
            } catch (error) {
              backendWarn('backend-session', 'emitSessionOpened.failed', {
                sessionPath: replacement.sessionPath,
                error: toErrorMessage(error),
              });
            }
          })(),
          this.emitSessionListChanged(),
        ]);
        return replacement;
      },
    );
    context.recoveryPromise = replacementPromise;
    void replacementPromise.catch((error) => {
      this.emit('operational-error', {
        incidentId: `session-recovery:${requestId}`,
        code: 'SESSION_RUNTIME_RECOVERY_FAILED',
        message: `Failed to replace the stuck session runtime: ${toErrorMessage(error)}`,
        sessionPath: context.sessionPath,
        requestId,
      });
    });
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    await this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    // Idempotent ownership is provided by disposePromise. The flag suppresses
    // stale events from in-flight async paths via the `disposed` guard on
    // `emit`/`emitSessionOpened`/`emitSessionListChanged`.
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'success',
      phase: 'backend_mapping',
      readiness: 'not_ready',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.disposed = true;
    if (this.coldSessionStore) this.coldSessionStore.leases.advanceCoordinatorGeneration(2);
    this.coldSessionManagerHandles.clear();
    this.pendingLivePipelineTraceDisables.clear();
    this.stopHostWatchdog();
    this.stopEventLoopMonitor();
    let workerSupervisorDisposeError: unknown;
    if (this.workerRuntimeRouter) {
      try {
        await this.workerRuntimeRouter.dispose();
        this.workerRuntimeRouter = undefined;
      } catch (error) {
        workerSupervisorDisposeError = error;
        log(`worker runtime router disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.workerSupervisor) {
      try {
        await this.workerSupervisor.dispose();
        this.workerSupervisor = undefined;
      } catch (error) {
        workerSupervisorDisposeError = error;
        log(`worker supervisor disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    // Reject queued session service creations: a queued open must not hang
    // behind an admitted creation while the host is tearing the backend down.
    // An admitted in-flight creation is allowed to settle; the late runtime it
    // produces is refused installation by the ownership check above.
    this.serviceLoadingGate.dispose();

    const contexts = [...this.sessionContexts.values()];
    this.sessionContexts.clear();

    // Reject provider waiters and clear referenced queue/afterburn timers even
    // when an SDK runtime ignores abort during shutdown. The global fetch
    // wrapper is process-owned, so server disposal is its production teardown.
    ProviderGate.uninstall();

    this.sessionCatalogPollingActive = false;
    if (this.sessionCatalogPollTimer) clearInterval(this.sessionCatalogPollTimer);
    this.sessionCatalogPollTimer = undefined;
    this.stopReviewWatcher?.();
    this.stopReviewWatcher = undefined;
    this.stopProviderProgressObserver?.();
    this.stopProviderProgressObserver = undefined;
    this.stopProviderIncidentObserver?.();
    this.stopProviderIncidentObserver = undefined;
    this.providerAttemptOwners.clear();
    this.browsePreviousSessionFiles.clear();

    // Teardown is best-effort per context: one cleanup that throws or rejects
    // must not strand this context's remaining cleanup or any later context.
    const runCleanup = (label: string, action: () => void): void => {
      try {
        action();
      } catch (err) {
        log(`${label} failed: ${String(err)}`);
      }
    };

    // Clear every active-request/watchdog timer a context may still hold. These
    // are `unref`'d so they do not keep the process alive, but a late fire
    // would touch retired/freed state (prompt-safety abort, semantic-lease
    // recovery, quota settlement, retry-stuck watchdog). The watchdog clear fn
    // is the primary path; the direct handle clear is belt-and-suspenders for a
    // missing or already-invoked clear fn.
    const clearContextTimers = (context: SessionContext): void => {
      runCleanup('session retry-watchdog cleanup', () => context.willRetryWatchdogClear?.());
      context.willRetryWatchdogClear = undefined;
      if (context.willRetryWatchdogTimer) {
        clearTimeout(context.willRetryWatchdogTimer);
        context.willRetryWatchdogTimer = undefined;
      }
      const active = context.activeRequest;
      if (active) {
        if (active.promptSafetyTimer) {
          clearTimeout(active.promptSafetyTimer);
          active.promptSafetyTimer = undefined;
        }
        if (active.semanticLeaseTimer) {
          clearTimeout(active.semanticLeaseTimer);
          active.semanticLeaseTimer = undefined;
        }
        if (active.quotaSettlementTimer) {
          clearTimeout(active.quotaSettlementTimer);
          active.quotaSettlementTimer = undefined;
        }
        active.pendingDurableToolTerminals?.clear();
      }
    };

    const teardownContext = async (context: SessionContext): Promise<void> => {
      clearContextTimers(context);
      runCleanup('session UI bridge dispose', () => context.uiBridge?.dispose());
      runCleanup('session event unsubscribe', () => context.unsubscribe());
      runCleanup('session manager fence invalidation', () => context.sessionManagerFence?.invalidate());
      await this.disposeRuntimeBounded(context.runtime, context.sessionPath);
    };

    for (const context of contexts) {
      await teardownContext(context);
    }

    // Handle in-flight recovery replacement contexts. A retired context may
    // have a replacement runtime being constructed asynchronously by
    // `recoverStuckSession` (or the abort-replacement path in request-handler);
    // the snapshot above predates that replacement (the map was cleared), so
    // its freshly created runtime would otherwise leak and its post-replacement
    // emissions would fire post-shutdown. Await each in-flight recovery
    // (bounded) and tear down the replacement runtime too. The `disposed` guard
    // on `emit`/`emitSessionOpened`/`emitSessionListChanged` makes the
    // recovery's post-replacement emissions no-ops.
    const inFlightRecoveries = contexts
      .map((context) => context.recoveryPromise)
      .filter((recovery): recovery is Promise<SessionContext> => Boolean(recovery));
    if (inFlightRecoveries.length > 0) {
      await Promise.allSettled(inFlightRecoveries.map(async (recovery) => {
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const waitGrace = new Promise<SessionContext | null>((resolve) => {
          waitTimer = setTimeout(() => resolve(null), resolveRuntimeDisposeGraceMs());
          waitTimer.unref?.();
        });
        let replacement: SessionContext | null;
        try {
          replacement = await Promise.race([recovery, waitGrace]);
        } catch {
          // Recovery failed; its own .catch already surfaced the error (now
          // suppressed by the `disposed` guard). Nothing left to tear down.
          replacement = null;
        } finally {
          if (waitTimer) clearTimeout(waitTimer);
        }
        if (replacement) {
          await teardownContext(replacement);
        }
      }));
    }
    await flushBackendLivePipelineTrace();
    if (workerSupervisorDisposeError) throw workerSupervisorDisposeError;
  }
}

function backendTraceEventKind(event: string) {
  if (event === 'message.delta') return 'text' as const;
  if (event === 'message.thinking') return 'reasoning' as const;
  if (event === 'message.toolCallDelta') return 'tool_draft' as const;
  if (event === 'tool.started') return 'tool_start' as const;
  if (event === 'tool.progress') return 'tool_progress' as const;
  if (event === 'tool.finished') return 'tool_terminal' as const;
  if (event === 'message.started') return 'turn_start' as const;
  if (event === 'message.finished' || event === 'message.aborted') return 'turn_terminal' as const;
  return 'control' as const;
}
