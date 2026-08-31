import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';

import { sessionMcpOverridePath } from './mcp-session-config';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { BoundedEventLoopHistogram } from '../shared/live-pipeline-trace';
import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES } from '../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../shared/error-message';
import { updateSettingsJsonObject } from '../shared/settings-json-update';
import { SESSION_SNAPSHOT_MAX_LINE_BYTES, sessionSnapshotLineBytes } from '../shared/transcript-window';
import {
  PROTOCOL_VERSION,
  type DetailResult,
  type LazyDetailRef,
  type ModelSettings,
  type RequestEnvelope,
  type SessionListChangedPayload,
  type SessionOpenedPayload,
  type SessionSummary,
  type ThinkingLevel,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { getDefaultAuthDir, ensureDir, isInsideGitWorkTree, migrateAuthFile } from './auth.js';
import {
  handleBackendRequest,
  parseLivePipelineToggleParams,
  type TranscriptPageLoadOptions,
} from './request-handler';
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
import {
  loadAvailableModels,
  loadConfiguredModels,
} from './session-metadata';
import { SessionCatalog } from './session-catalog';
import {
  ensureReviewsDir,
  getReviewSidecarFingerprint,
  hasActiveReviewClosureActions,
  startReviewWatcher,
} from './session-review-store';
import { forgetPrivateSessionArtifacts } from './private-session-artifacts';
import {
  isSystemPromptTogglePersistenceAvailable,
  writeSystemPromptTogglesForSession,
} from './system-prompt-toggle-store';
import {
  ensureSdkPatchBarrier,
  loadSdk,
  type ColdCoordinatorSdkModule,
  type SdkAuthStorage,
  type SdkModelRegistry,
} from './sdk';
import { ProviderGate, type ProviderConcurrencyConfig } from './provider-gate.js';
import { CreateOperationLedger } from './create-operation-ledger';
import { BackendError, extractRequestError, log, responseError, responseOk, writeStdout } from './server-io';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTraceHealth,
  isBackendLivePipelineTraceEnabled,
  recordBackendLivePipelineTrace,
  setBackendLivePipelineTraceEnabled,
} from './live-pipeline-trace-runtime';
import {
  type SessionContextCreationReason,
} from './server-types';
import { backendTrace, backendError, backendInfo, backendWarn, backendLog, classifyWorkerStderrChunk } from './log';
import { isCoordinatorOperationAllowed } from './coordinator-operations';
import { ColdSessionStore, StaleColdSessionLeaseError, type ColdSessionManagerHandle } from './cold-session-store';
import { ColdBrowseHelperClient } from './cold-browse-helper-client';
import { InitialContextEstimateClient } from './initial-context-estimate-client';
import { DurableDetailStore, type ResolvedDurableDetail } from './durable-detail-store';
import type { BackendDetailFence, LiveSubagentDetailAddress } from '../shared/protocol/subagent-detail';
import { WorkerSupervisor } from './worker-supervisor';
import { SessionOwnershipAuthority } from './session-ownership-authority';
import { WorkerRuntimeRouter } from './worker-runtime-router';
import type { WorkerJsonObject, WorkerJsonValue } from './worker-protocol';

const ISOLATED_PROMOTION_METHODS = new Set([
  'message.send',
  'message.continue',
  'message.compact',
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

/** Convert models.json concurrency declarations into the JSON policy shared by
 * the real cross-worker admission authority. URL prefixes stay in the payload
 * so workers can classify internal pruning/failover fetches by their actual
 * destination instead of blindly charging the root session's provider. */
export function providerPoliciesFromConfigs(configs: readonly ProviderConcurrencyConfig[]): WorkerJsonObject {
  return Object.fromEntries(configs.map((config) => [config.provider, {
    maxConcurrentRequests: config.maxConcurrentRequests,
    queueWaitSeconds: config.queueWaitSeconds ?? 30,
    headerWaitSeconds: (config.headerWaitSeconds ?? 0) > 0 ? config.headerWaitSeconds! : 120,
    streamIdleTimeoutSeconds: 120,
    afterburnSeconds: config.afterburnSeconds ?? 0,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.baseUrls && config.baseUrls.length > 0 ? { baseUrls: [...config.baseUrls] } : {}),
  }])) as WorkerJsonObject;
}

export function mergeProviderPolicies(base: WorkerJsonObject, overrides: unknown): WorkerJsonObject {
  const overrideMap = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? overrides as WorkerJsonObject
    : {};
  const providers = new Set([...Object.keys(base), ...Object.keys(overrideMap)]);
  return Object.fromEntries([...providers].map((provider) => {
    const basePolicy = base[provider];
    const override = overrideMap[provider];
    const baseRecord = basePolicy && typeof basePolicy === 'object' && !Array.isArray(basePolicy)
      ? basePolicy as WorkerJsonObject
      : {};
    const overrideRecord = override && typeof override === 'object' && !Array.isArray(override)
      ? override as WorkerJsonObject
      : {};
    const normalizedOverride = { ...overrideRecord };
    // Public settings use zero to mean "restore the provider default" for the
    // header phase. Resolve that against the current models.json base snapshot,
    // not whichever older override happens to be installed in the authority.
    if (normalizedOverride.headerWaitSeconds === 0) delete normalizedOverride.headerWaitSeconds;
    return [provider, { ...baseRecord, ...normalizedOverride }];
  })) as WorkerJsonObject;
}

/** Module-level guard: install the fatal handlers at most once even if
 *  `start()` is invoked more than once. */
let backendFatalHandlersInstalled = false;
const SESSION_CATALOG_POLL_INTERVAL_MS = 10_000;

interface PreparedViewedSessionTransition {
  changed: boolean;
  revision: number;
  hadPrevious: boolean;
  previous?: string;
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
  private sdk!: ColdCoordinatorSdkModule;
  private readonly sdkPath: string;
  private readonly startupCwd: string;
  /** Host-authoritative generation shared by backend, coordinator, worker, and detail fences. */
  private readonly backendGeneration: number;
  private sessionDir?: string;
  private sessionDirResolved = false;
  private agentDir = '';
  private authStorage?: SdkAuthStorage;
  /** Runtime-free coordinator registry used for cold-session catalog
   * hydration. This preserves built-in providers represented by
   * `modelOverrides` without creating an AgentSession in the coordinator. */
  private modelRegistry?: SdkModelRegistry;
  private viewedSessionPath?: string;
  /** Monotonic fence preventing a slow session.open from overwriting a newer
   * host-local visual transition after its durable read completes. */
  private viewedSessionRevision = 0;
  private runtimePrefs: WorkerJsonObject = {};
  /** models.json is the baseline provider policy. Runtime preferences are
   * sparse overrides and must never erase these configured capacities. */
  private providerBasePolicies: WorkerJsonObject = {};
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
  /** Non-serialized generation stamp checked synchronously at correlated stdout
   * publication, after the request handler's final await has unwound. */
  private readonly browseResponseOwners = new WeakMap<object, {
    sessionPath: string;
    fingerprint?: string;
  }>();
  /** Predecessor captured when a cold session first becomes viewed. Promotion
   * consumes this immutable identity instead of rereading viewedSessionPath. */
  private readonly browsePreviousSessionFiles = new Map<string, string | undefined>();
  /** Paths currently being forgotten; prevents a racing open from installing
   *  a runtime after its transcript has been removed. */
  private readonly forgottenSessionPaths = new Set<string>();
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

  /** True once `dispose()` has begun. Suppresses stale events and payload
   *  builds from in-flight async paths (recovery replacement emissions, catalog
   *  polling, late SDK events) so a dying backend cannot push post-shutdown
   *  state to a host that is already tearing it down. */
  private disposed = false;
  /** Accepted stdin requests that have not yet completed. EOF-driven restart
   * drains these before disposal so a settings writer cannot be killed while
   * holding the shared settings lock. */
  private readonly inFlightInputRequests = new Set<Promise<void>>();
  /** All shutdown callers join one teardown. A second EOF/watchdog signal must
   * not observe `disposed` and exit while the first caller still owns workers. */
  private disposePromise?: Promise<void>;
  /** Generation/process-scoped create-operation ledger (§6.3): dedupes
   *  concurrent/retried `session.create`/`session.duplicate` by the optional
   *  host-generated `operationId` and retains in-flight and completed durable
   *  results for this backend generation. A backend restart (generation
   *  death) naturally drops the ledger with the process. */
  private readonly createOperationLedger = new CreateOperationLedger();
  private readonly workerEntryPath?: string;
  private readonly coldBrowseHelperEntryPath?: string;
  private coldBrowseHelper?: ColdBrowseHelperClient;
  private readonly initialContextEstimateEntryPath?: string;
  private initialContextEstimateClient?: InitialContextEstimateClient;
  private workerSupervisor?: WorkerSupervisor;
  private sessionOwnershipAuthority?: SessionOwnershipAuthority;
  private workerRuntimeRouter?: WorkerRuntimeRouter;
  /** Highest coordinator-owned registry revision published to the legacy
   * process env mirror. Broadcast acknowledgements can settle out of order,
   * so completion order must never be allowed to roll this mirror back. */
  private mirroredSessionRegistryRevision = 0;
  private durableDetailStore?: DurableDetailStore;
  private authPath = '';
  private hostWatchdogTimer?: ReturnType<typeof setInterval>;
  private readonly hostPid?: number;
  private readonly lifetimeFd?: number;
  private hostLifetimeStream?: fsSync.ReadStream;
  private hostLossHandled = false;
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
    lifetimeFd?: number;
    workerEntryPath?: string;
    /** Production explicitly supplies the bundled helper. Direct test
     * constructions remain coordinator-only unless they opt in. */
    coldBrowseHelperEntryPath?: string;
    /** Bundled one-shot full-runtime inventory worker. */
    initialContextEstimateEntryPath?: string;
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
    this.lifetimeFd = options.lifetimeFd;
    this.workerEntryPath = options.workerEntryPath;
    this.coldBrowseHelperEntryPath = options.coldBrowseHelperEntryPath;
    this.initialContextEstimateEntryPath = options.initialContextEstimateEntryPath;
    this.sessionCatalog = options.sessionCatalog ?? new SessionCatalog({
      onCatalogChanged: () => {
        void this.emitSessionListChanged();
      },
    });
    if (!this.workerEntryPath) {
      throw new Error('The session runtime requires a bundled worker entry path.');
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
      browseHelper: this.coldBrowseHelper,
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
    // Create the generation-scoped supervisor and verify the stable worker
    // artifact. The coordinator owns the patching barrier and workers only
    // validate it.
    const sdkPatchIdentity = await ensureSdkPatchBarrier(this.sdkPath);
    if (this.initialContextEstimateEntryPath) {
      this.initialContextEstimateClient = new InitialContextEstimateClient({
        entryPath: this.initialContextEstimateEntryPath,
        sdkPath: this.sdkPath,
        sdkPatchIdentity,
        onDiagnostic: (chunk) => backendWarn('backend-initial-context-inventory', 'worker diagnostic', { chunk }),
      });
    }
    if (this.coldBrowseHelperEntryPath) {
      this.coldBrowseHelper = new ColdBrowseHelperClient({
        entryPath: this.coldBrowseHelperEntryPath,
        sdkPath: this.sdkPath,
        sdkPatchIdentity,
        startupCwd: this.startupCwd,
        parentPid: process.pid,
        onDiagnostic: (chunk) => backendWarn('backend-cold-browse-helper', 'helper diagnostic', { chunk }),
      });
      // Eagerly validate/import the helper SDK while coordinator startup does
      // independent work. Failure is deliberately non-fatal: the first exact
      // v3 miss retries lazily, then ColdSessionStore preserves semantics with
      // its synchronous fallback if the helper is still unavailable.
      void this.coldBrowseHelper.warm().catch((error) => {
        backendWarn('backend-cold-browse-helper', 'eager warm failed', { error: toErrorMessage(error) });
      });
    }
    this.workerSupervisor = new WorkerSupervisor({
      workerEntryPath: this.workerEntryPath!,
      coordinatorGeneration: this.backendGeneration,
      sdkPatchIdentity,
      mcpConfigPathFor: (sessionPath) => {
        const overridePath = sessionMcpOverridePath(sessionPath);
        try {
          return fsSync.existsSync(overridePath) ? overridePath : undefined;
        } catch {
          return undefined;
        }
      },
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
      onDiagnostic: (rootSessionPath, stream, chunk) => {
        // Worker stderr carries structured `[pie:backend] {json}` lines with an
        // explicit `level`. Classify the chunk so debug/info/warn chatter is not
        // mis-reported as `error` (which flooded the pie log with false errors).
        // Non-JSON / level-less chunks (e.g. a worker crash stack) surface at
        // `error` so genuine failures stay visible.
        const level = classifyWorkerStderrChunk(chunk);
        backendLog(level, 'backend-worker', `worker ${stream}`, { rootSessionPath, chunk });
      },
    });
    await this.workerSupervisor.initialize();
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
          { mode: 'cold-coordinator' },
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
        this.providerBasePolicies = providerPoliciesFromConfigs(configs);
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
      this.modelRegistry = this.sdk.ModelRegistry.create(
        this.authStorage,
        path.join(this.agentDir, 'models.json'),
      );
    });

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
          const openedPayload = await this.buildSessionOpenedPayload(
            exactSessionPath,
            undefined,
            'tail',
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          );
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
      await this.workerRuntimeRouter.syncProviderPolicy(mergeProviderPolicies(
        this.providerBasePolicies,
        this.runtimePrefs.providerConcurrency,
      ));
      this.authFingerprint = await fs.stat(this.authPath || path.join(this.agentDir, 'auth.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');
      this.modelsJsonFingerprint = await fs.stat(path.join(this.agentDir, 'models.json'))
        .then((stat) => `${stat.size}:${stat.mtimeMs}`)
        .catch(() => 'missing');

    // Attach the stdin reader BEFORE emitting backend.ready so that any
    // request the client sends immediately after receiving ready is captured,
    // rather than racing with reader attachment.
    const detachReader = attachJsonlLineReader(process.stdin, (line) => {
      const request = this.handleLine(line);
      this.inFlightInputRequests.add(request);
      void request.catch((error) => {
        log(`backend request drain failed: ${toErrorMessage(error)}`);
      }).finally(() => {
        this.inFlightInputRequests.delete(request);
      });
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
      void (async () => {
        await Promise.allSettled([...this.inFlightInputRequests]);
        await this.dispose();
      })().then(
        () => process.exit(0),
        (error) => { log(`backend disposal failed closed: ${toErrorMessage(error)}`); process.exitCode = 1; },
      );
    });

    this.startHostLifetimeWatch();
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
    if (!this.workerRuntimeRouter) {
      throw new Error('Worker promotion smoke requires an initialized coordinator.');
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
        this.handleHostLoss('pid-watchdog', { hostPid });
      }
    };

    this.hostWatchdogTimer = setInterval(checkHost, 2_000);
    this.hostWatchdogTimer.unref?.();
    checkHost();
  }

  private stopHostWatchdog(): void {
    if (this.hostWatchdogTimer) clearInterval(this.hostWatchdogTimer);
    this.hostWatchdogTimer = undefined;
  }

  /** The host owns the write side of fd 3. OS-level EOF is a stronger lifetime
   * signal than stdio or PID polling: it is immediate, has no PID-reuse race,
   * and remains independent of accepted RPC drainage. */
  private startHostLifetimeWatch(): void {
    const lifetimeFd = this.lifetimeFd;
    if (lifetimeFd === undefined) return;
    try {
      const stream = fsSync.createReadStream('', { fd: lifetimeFd, autoClose: true });
      this.hostLifetimeStream = stream;
      stream.once('end', () => this.handleHostLoss('lifetime-pipe-eof', { lifetimeFd }));
      stream.once('error', (error) => {
        if (this.disposed) return;
        backendWarn('backend', 'host lifetime pipe failed; PID watchdog remains active', {
          lifetimeFd,
          error: toErrorMessage(error),
        });
      });
      stream.resume();
    } catch (error) {
      backendWarn('backend', 'could not open host lifetime pipe; PID watchdog remains active', {
        lifetimeFd,
        error: toErrorMessage(error),
      });
    }
  }

  private stopHostLifetimeWatch(): void {
    const stream = this.hostLifetimeStream;
    this.hostLifetimeStream = undefined;
    stream?.destroy();
  }

  private handleHostLoss(source: string, details: Record<string, unknown>): void {
    if (this.hostLossHandled || this.disposed) return;
    this.hostLossHandled = true;
    this.stopHostWatchdog();
    this.stopHostLifetimeWatch();
    backendWarn('backend', 'extension host disappeared; stopping backend', { source, ...details });

    const forcedExit = setTimeout(() => {
      log('backend host-loss disposal exceeded 3 seconds; forcing process exit');
      process.exit(1);
    }, 3_000);
    forcedExit.unref?.();
    void this.dispose().then(
      () => {
        clearTimeout(forcedExit);
        process.exit(0);
      },
      (error) => {
        clearTimeout(forcedExit);
        log(`backend disposal failed closed: ${toErrorMessage(error)}`);
        process.exit(1);
      },
    );
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
    if (!prepared?.changed || prepared.revision !== this.viewedSessionRevision) return;
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


  private readColdBrowseFileFingerprintSync(sessionPath: string): string {
    const stat = fsSync.statSync(sessionPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  private async loadTranscriptPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options?: TranscriptPageLoadOptions,
  ): Promise<TranscriptPagePayload> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.initializeColdSessionStore().loadPage(
          sessionPath,
          direction,
          loadedStart,
          loadedEnd,
          options,
        );
        this.registerColdResult(result);
        return result;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) continue;
        throw error;
      }
    }
    throw new BackendError('SESSION_CHANGED_DURING_READ', `The session changed repeatedly while it was being paged: ${sessionPath}`);
  }

  private async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (ref.source !== 'durable') {
      return { sessionPath, key: ref.key, status: 'unavailable', message: 'Live detail is owned by the extension host.' };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.initializeColdSessionStore().loadDetail(sessionPath, ref);
        this.registerColdResult(result);
        return result;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) continue;
        throw error;
      }
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








  private async readModelSettings(): Promise<ModelSettings> {
    const defaults: ModelSettings = { defaultModel: '', defaultThinkingLevel: 'high' };
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

  private async writeModelSettings(updates: Partial<ModelSettings>): Promise<ModelSettings> {
    const settingsPath = path.join(this.agentDir, 'settings.json');
    // Model updates run in the backend while pruning updates run in the
    // extension host. Share the same cross-process lock so their
    // read-modify-write cycles cannot silently overwrite each other.
    await updateSettingsJsonObject(settingsPath, (existing) => ({ ...existing, ...updates }));
    return await this.readModelSettings();
  }




  private async buildSessionOpenedPayload(
    sessionPath: string,
    selectionToken?: string,
    transcript?: import('../shared/protocol').TranscriptMode,
    transport?: import('../shared/transcript-window').SessionSnapshotTransport,
    operationId?: string,
    operationAttempt?: number,
    systemPromptDisabledEntries?: readonly string[],
    includeInitialContextEstimate = true,
  ): Promise<SessionOpenedPayload> {
    return await timed('buildSessionOpenedPayload', async () => {
      const catalog = await loadConfiguredModels(this.agentDir, this.modelRegistry);
      const availableModels = catalog.models;
      const modelSettings = await this.readModelSettings();
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
          systemPromptDisabledEntries,
        };
        const payload = retained
          ? await store.openHandleSnapshot(retained.handle, options)
          : await store.openSnapshot(sessionPath, options);
        if (includeInitialContextEstimate
          && payload.runtimeReady === false
          && payload.transcriptWindow.hasUserMessages === false
          && payload.contextUsage === undefined
          && (payload.sessionUsage?.samples.length ?? 0) === 0
          && this.initialContextEstimateClient) {
          const selectedModelId = payload.session.modelId ?? modelSettings.defaultModel;
          const selectedProvider = payload.session.provider ?? modelSettings.defaultProvider
            ?? availableModels.find((model) => model.id === selectedModelId)?.provider;
          if (selectedModelId && selectedProvider) {
            const estimate = await this.initialContextEstimateClient.estimate({
              cwd: payload.session.cwd || this.startupCwd,
              agentDir: this.agentDir,
              model: { provider: selectedProvider, id: selectedModelId },
            });
            if (estimate) {
              // Preserve the cold store's WeakMap ownership stamp by mutating
              // the already-stamped object. The field is omitted instead of
              // violating the producer envelope when the fitted snapshot has
              // no remaining headroom.
              const transportShape = transport ?? { kind: 'event' as const, event: 'session.opened' };
              const candidate = { ...payload, initialContextEstimate: estimate };
              if (sessionSnapshotLineBytes(candidate, transportShape) <= SESSION_SNAPSHOT_MAX_LINE_BYTES) {
                payload.initialContextEstimate = estimate;
              }
            }
          }
        }
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
            return await this.buildSessionOpenedPayload(
              sessionPath,
              selectionToken,
              transcript,
              transport,
              operationId,
              operationAttempt,
              systemPromptDisabledEntries,
              includeInitialContextEstimate,
            );
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
        sessionCatalogProgress: this.sessionCatalog.getProgress(),
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
    return await this.initializeColdSessionStore().list([]);
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
      if (this.workerRuntimeRouter) {
        try {
          const authPath = this.authPath || path.join(this.agentDir, 'auth.json');
          const authFingerprint = await fs.stat(authPath)
            .then((stat) => `${stat.size}:${stat.mtimeMs}`)
            .catch(() => 'missing');
          if (authFingerprint !== this.authFingerprint) {
            this.authFingerprint = authFingerprint;
            this.authStorage?.reload?.();
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
            const rawModels = JSON.parse(await fs.readFile(modelsPath, 'utf8'));
            const providerConfigs = ProviderGate.resolveConfigs(rawModels);
            this.providerBasePolicies = providerPoliciesFromConfigs(providerConfigs);
            if (providerConfigs.length > 0) ProviderGate.install(providerConfigs, 120);
            else ProviderGate.uninstall();
            await this.workerRuntimeRouter.syncProviderPolicy(mergeProviderPolicies(
              this.providerBasePolicies,
              this.runtimePrefs.providerConcurrency,
            ));
            const catalog = await loadConfiguredModels(this.agentDir, this.modelRegistry);
            if (!catalog.ok) {
              throw new Error(`Configured model catalog reload failed: ${catalog.error}`);
            }
            await this.workerRuntimeRouter.syncCatalog(catalog.models as unknown as WorkerJsonValue[]);
            // Commit only after every authority publication succeeds. A
            // transient parse/sync failure must see the same fingerprint as
            // pending on the next poll rather than suppressing its own retry.
            this.modelsJsonFingerprint = modelsFingerprint;
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
    if (this.disposed || this.isSessionForgotten(stamp.sessionPath)) return false;
    if (!stamp.fingerprint) return false;
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
    this.forgottenSessionPaths.add(sessionPath);
    this.browsePreviousSessionFiles.delete(sessionPath);
    // A session-scoped MCP override artifact must not outlive its session.
    await fs.rm(sessionMcpOverridePath(sessionPath), { force: true }).catch(() => undefined);
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
    const router = this.workerRuntimeRouter;
    if (router) {
        const sessionPath = requestSessionPath(request.params);
        const routeState = sessionPath ? router.getRoute(sessionPath) : undefined;
        if (routeState?.state === 'transitioning'
            && request.method !== 'session.truncateAfter'
            && request.method !== 'session.viewed'
            && request.method !== 'message.interrupt') {
          throw new BackendError(
            'SESSION_TRANSITION_IN_PROGRESS',
            `Session transition is already in progress for ${sessionPath}.`,
          );
        }
        if (routeState?.state === 'transitioning' && request.method === 'message.interrupt' && sessionPath) {
          // The transition has already fenced the old worker and its first step
          // is an interrupt. Serialize this later public interrupt behind the
          // transition instead of rejecting a legitimate user action. If the
          // transition restores or promotes a hot owner, interrupt that current
          // owner; if it settles cold/fenced, there is no live turn left.
          onRequestValidated?.();
          await routeState.completion.catch(() => undefined);
          if (router.hasHotOwner(sessionPath)) {
            const result = await router.interrupt(sessionPath, `public request ${request.id} after session transition`);
            return result.soft
              ? { interrupted: true, settled: true }
              : { interrupted: true, settled: false, teardownTimedOut: true };
          }
          return { interrupted: true, settled: true };
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
          // The shared `.pi/mcp.json`-layer overrides cannot leak here, but a
          // session-scoped artifact must die with its session.
          await fs.rm(sessionMcpOverridePath(sessionPath), { force: true }).catch(() => undefined);
        } else if (sessionPath && WorkerRuntimeRouter.isHotOperation(request.method)) {
          if (request.method === 'extension_ui.response' && !router.hasHotOwner(sessionPath)) {
            // A response for a session whose worker is gone (crashed, retired,
            // or replaced) is correlated typed-stale: never promote a fresh
            // worker just to reject it, and never invoke any worker callback.
            throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
          }
          const shouldPromote = ISOLATED_PROMOTION_METHODS.has(request.method);
          if (shouldPromote) return await router.route(request);
          if (router.hasHotOwner(sessionPath)) return await router.routeExisting(request);
          if (!isCoordinatorOperationAllowed(request.method, request.params)) {
            throw new BackendError('SESSION_NOT_FOUND', `No hot worker owns ${sessionPath}.`);
          }
        }
      }
      if (!isCoordinatorOperationAllowed(request.method, request.params)) {
        throw new BackendError(
          'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
          router
            ? `Operation ${request.method} requires an isolated runtime owner and cannot use the coordinator runtime.`
            : `Operation ${request.method} requires Phase 4 isolated-runtime routing; Phase 4 isolated-runtime routing is unavailable.`,
        );
      }
    const sessionDir = this.getSessionDir();
    const result = await handleBackendRequest({
      sdkPath: this.sdkPath,
      agentDir: this.agentDir,
      startupCwd: this.startupCwd,
      sessionDir,
      sdk: this.sdk,
      getSessionContext: () => undefined,
      createSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not create in-process session runtimes.');
      },
      ensureSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not own in-process session runtimes.');
      },
      recycleSessionRuntime: async (sessionPath, reason) => {
        const runtimeRouter = this.workerRuntimeRouter;
        if (!runtimeRouter || !runtimeRouter.hasHotOwner(sessionPath)) return false;
        // Never retire a worker with a request in flight (owner of a turn whose
        // tool calls / message stream still reference its process).
        const route = runtimeRouter.getRoute(sessionPath);
        if (route.state !== 'hot' || route.checkpoint.requestId !== undefined) return false;
        await runtimeRouter.retire(sessionPath, reason);
        return true;
      },
      createColdSession: (cwd) => {
        const handle = this.initializeColdSessionStore().create({ cwd });
        this.retainColdSessionManager(handle, 'new');
        return { sessionPath: handle.sessionPath };
      },
      duplicateColdSession: (sessionPath) => {
        const handle = this.initializeColdSessionStore().duplicate(sessionPath);
        this.retainColdSessionManager(handle, 'new');
        return { sessionPath: handle.sessionPath };
      },
      truncateColdSessionAfter: async (sessionPath, entryId) => {
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
      applyColdSessionModelSettings: async (sessionPath, updates) => {
        const store = this.initializeColdSessionStore();
        await this.runColdSessionMutation(sessionPath, async () => {
          const retained = this.coldSessionManagerHandles.get(this.coldManagerKey(sessionPath));
          if (retained) store.setHandleModelSettings(retained.handle, updates);
          else store.setModelSettings(sessionPath, updates);
        });
      },
      applyColdSystemPromptToggles: async (sessionPath, disabledEntries) => {
        await this.runColdSessionMutation(sessionPath, async () => {
          if (this.forgottenSessionPaths.has(sessionPath) || !fsSync.existsSync(sessionPath)) {
            throw new BackendError('SESSION_NOT_FOUND', `Unknown session: ${sessionPath}`);
          }
          if (!isSystemPromptTogglePersistenceAvailable()) {
            throw new BackendError(
              'COLD_SESSION_SETTINGS_UNAVAILABLE',
              'System-prompt toggle persistence directory is unavailable.',
            );
          }
          // A cold coordinator has no in-memory prompt state to fall back to,
          // so this write is strict: success means the choice will survive a
          // backend restart and be consumed when the worker is promoted.
          await writeSystemPromptTogglesForSession(sessionPath, disabledEntries, true);
        });
      },
      isSessionTransitionPending: () => false,
      transitionSessionContext: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not transition in-process session runtimes.');
      },
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
      buildSessionOpenedPayload: (sessionPath, selectionToken, transcript, transport, operationId, operationAttempt, systemPromptDisabledEntries) => (
        this.buildSessionOpenedPayload(
          sessionPath,
          selectionToken,
          transcript,
          transport,
          operationId,
          operationAttempt,
          systemPromptDisabledEntries,
        )
      ),
      createOperationLedger: this.createOperationLedger,
      buildTransitionSessionOpenedPayload: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'The coordinator does not build in-process transition snapshots.');
      },
      applySystemPromptToggles: () => {
        throw new BackendError('ISOLATED_RUNTIME_ROUTING_UNAVAILABLE', 'System prompt toggles require a hot worker owner.');
      },
      setAutonomousMode: () => undefined,
      forgetSession: (sessionPath) => this.forgetSession(sessionPath),
      loadTranscriptPage: (sessionPath, direction, loadedStart, loadedEnd, options) => (
        this.loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd, options)
      ),
      loadDetail: (sessionPath, ref) => this.loadDetail(sessionPath, ref),
      transferBrowseResponseOwnership: (source, target) => {
        const owner = this.browseResponseOwners.get(source);
        if (owner) this.browseResponseOwners.set(target, owner);
        this.coldSessionStore?.transferOwnershipStamp(source, target);
      },
      emit: (event, payload) => this.emit(event, payload),
      syncOpenTabsRegistry: async (tabs, sourceRevision) => {
        const router = this.workerRuntimeRouter;
        if (!router) {
          throw new BackendError(
            'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
            'The coordinator cannot publish the session registry without worker routing.',
          );
        }
        const normalized = JSON.parse(JSON.stringify(tabs)) as WorkerJsonValue[];
        const outcome = await router.syncSessionRegistry(normalized, sourceRevision);
        if (!outcome.applied || outcome.revision <= this.mirroredSessionRegistryRevision) return;
        // Keep the coordinator mirror for diagnostics/legacy in-process
        // consumers. Ready hot workers receive the same snapshot through the
        // auxiliary latest-wins sync; a missed acknowledgement retries without
        // making this host publication or an active turn wait. The synchronous
        // revision claim fences an older publication behind a newer one.
        this.mirroredSessionRegistryRevision = outcome.revision;
        process.env['PIE_OPEN_TABS'] = JSON.stringify(normalized);
        process.env['PIE_OPEN_TABS_REVISION'] = String(outcome.revision);
      },
      emitBusyChanged: () => undefined,
      emitContextUsageChanged: () => undefined,
      emitSessionListChanged: () => this.emitSessionListChanged(),
      listSessions: () => this.listSessionSummaries(),
      listAvailableModels: async (context) => {
        const catalog = context
          ? loadAvailableModels(context, this.agentDir)
          : await loadConfiguredModels(this.agentDir, this.modelRegistry);
        if (!catalog.ok) {
          throw new BackendError('MODEL_CATALOG_UNAVAILABLE', `Unable to load the model catalog: ${catalog.error}`);
        }
        return catalog.models;
      },
      readModelSettings: () => this.readModelSettings(),
      writeModelSettings: (updates) => this.writeModelSettings(updates),
      getProviderGateMetrics: () => this.workerRuntimeRouter?.getProviderGateMetrics(),
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
    if (request.method === 'runtimePrefs.set'
      && result && typeof result === 'object' && !Array.isArray(result)) {
      this.runtimePrefs = JSON.parse(JSON.stringify(result)) as WorkerJsonObject;
      await this.workerRuntimeRouter?.syncRuntimePrefs(this.runtimePrefs);
      await this.workerRuntimeRouter?.syncProviderPolicy(
        mergeProviderPolicies(this.providerBasePolicies, this.runtimePrefs.providerConcurrency),
      );
    }
    if (request.method === 'settings.set'
      && result && typeof result === 'object' && !Array.isArray(result)) {
      // A settings write that the coordinator handled (a global write, or a
      // session-scoped write for a cold session with no live runtime) must be
      // re-broadcast so hot workers never serve the pre-write snapshot.
      // Session-scoped writes for hot sessions are routed to the owning worker
      // above and never reach this block.
      await this.workerRuntimeRouter?.syncSettings();
    }
    return result;
  }


  /**
   * Locally terminalize a stuck runtime immediately, then replace it without
   * waiting for provider teardown. The old runtime is fenced before any async
   * work so late SDK events cannot revive or terminalize the request twice.
   */

  async dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    await this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    // Idempotent ownership is provided by disposePromise. The flag suppresses
    // stale events from in-flight async paths via the `disposed` guard on
    // `emit`/`emitSessionListChanged`.
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'success',
      phase: 'backend_mapping',
      readiness: 'not_ready',
      processRole: 'coordinator',
      pid: process.pid,
    });
    this.disposed = true;
    if (this.coldSessionStore) {
      // Backend generations are host-authoritative and increase across every
      // restart. Advancing to a hard-coded generation only works for the
      // first process; generation 2+ then throws during ordinary shutdown and
      // forces the host to kill an otherwise healthy coordinator.
      this.coldSessionStore.leases.advanceCoordinatorGeneration(this.backendGeneration + 1);
    }
    this.coldSessionManagerHandles.clear();
    this.pendingLivePipelineTraceDisables.clear();
    this.stopHostWatchdog();
    this.stopHostLifetimeWatch();
    this.stopEventLoopMonitor();
    let workerSupervisorDisposeError: unknown;
    if (this.initialContextEstimateClient) {
      try {
        await this.initialContextEstimateClient.dispose();
        this.initialContextEstimateClient = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`initial context inventory disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.coldBrowseHelper) {
      try {
        await this.coldBrowseHelper.dispose();
        this.coldBrowseHelper = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`cold browse helper disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.workerRuntimeRouter) {
      try {
        await this.workerRuntimeRouter.dispose();
        this.workerRuntimeRouter = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`worker runtime router disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    if (this.workerSupervisor) {
      try {
        await this.workerSupervisor.dispose();
        this.workerSupervisor = undefined;
      } catch (error) {
        workerSupervisorDisposeError ??= error;
        log(`worker supervisor disposal failed closed: ${toErrorMessage(error)}`);
      }
    }
    // Reject provider waiters and clear referenced queue/afterburn timers even
    // when an SDK runtime ignores abort during shutdown. The global fetch
    // wrapper is process-owned, so server disposal is its production teardown.
    ProviderGate.uninstall();

    this.sessionCatalogPollingActive = false;
    if (this.sessionCatalogPollTimer) clearInterval(this.sessionCatalogPollTimer);
    this.sessionCatalogPollTimer = undefined;
    this.stopReviewWatcher?.();
    this.stopReviewWatcher = undefined;
    this.browsePreviousSessionFiles.clear();

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
