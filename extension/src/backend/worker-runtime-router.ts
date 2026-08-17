import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { ModelSettings, RequestEnvelope, SessionOpenedPayload } from '../shared/protocol';
import type {
  CoordinatorToHostDetailMessage,
  HostToCoordinatorDetailMessage,
  LiveSubagentDetailAddress,
} from '../shared/protocol/subagent-detail.js';
import type { ColdSessionStore, SerializedColdSessionPromotionGrant } from './cold-session-store';
import { CoordinatorProviderNetworkLeaseAuthority } from './coordinator-provider-network-lease';
import { ExtensionUiOwnerRegistry } from './extension-ui-owner-registry';
import {
  SessionOwnershipAuthority,
  SessionOwnershipConflictError,
  StaleSessionWriteLeaseError,
} from './session-ownership-authority';
import type { SdkSessionWriteLease, SdkWorkerOwnershipIdentity } from './sdk';
import type { SupervisedWorker, WorkerSupervisor } from './worker-supervisor';
import type { WorkerClientSnapshot } from './worker-client';
import { BackendError } from './server-io';
import type {
  WorkerJsonObject,
  WorkerJsonValue,
  WorkerRuntimeOperation,
  WorkerToCoordinatorFrame,
} from './worker-protocol';

export type WorkerRuntimeRouteState =
  | { state: 'cold'; rootSessionPath: string }
  | { state: 'promoting'; rootSessionPath: string; promotion: Promise<HotWorkerRoute> }
  | HotWorkerRoute
  | WorkerRuntimeTransitionRoute
  | { state: 'retiring'; rootSessionPath: string; owner: SdkWorkerOwnershipIdentity; retirement: Promise<void> };

export interface WorkerRuntimeTransitionRoute {
  state: 'transitioning';
  rootSessionPath: string;
  transitionKey: string;
  owner: SdkWorkerOwnershipIdentity;
  completion: Promise<unknown>;
  source: HotWorkerRoute;
  retireStarted: boolean;
  retired: boolean;
}

export interface WorkerRuntimeTransitionControl {
  interrupt(reason: string): Promise<{ soft: boolean }>;
  retire(reason: string): Promise<void>;
  promote(sessionPath: string): Promise<HotWorkerRoute>;
}

export class SessionTransitionInProgressError extends BackendError {
  constructor(sessionPath: string) {
    super('SESSION_TRANSITION_IN_PROGRESS', `Session transition is already in progress for ${sessionPath}.`);
    this.name = 'SessionTransitionInProgressError';
  }
}

export interface HotWorkerRoute {
  state: 'hot';
  /** Current public route root; advances atomically after SDK replacement. */
  rootSessionPath: string;
  /** Immutable process/protocol root assigned at spawn. */
  workerRootSessionPath: string;
  currentLeasePath: string;
  currentLeaseRevision: number;
  /** Source path retained briefly so terminal events emitted during a session
   *  replacement can still settle the superseded public send after rekeying. */
  previousLeasePath?: string;
  owner: SdkWorkerOwnershipIdentity;
  worker: SupervisedWorker;
  checkpoint: {
    busySeq: number;
    requestId?: string;
    terminalRequestId?: string;
    preflightOnly?: boolean;
    messageId?: string;
    tools: Array<{ requestId: string; messageId: string; toolCallId: string; name?: string; input?: WorkerJsonValue; startedAt?: number }>;
    /** Last observed context usage (bounded). */
    usage?: { tokens: number; contextWindow: number; percent: number };
    /** Last durability-confirmed session entry identity (bounded). */
    durableWatermark?: string;
  };
}

export interface WorkerRuntimeCheckpointManifest {
  busySeq: number;
  requestId?: string;
  tools: Array<{ requestId: string; messageId: string; toolCallId: string; name?: string; startedAt?: number }>;
  usage?: { tokens: number; contextWindow: number; percent: number };
  durableWatermark?: string;
  detailManifest?: Array<{ subscriptionId: string; state: string; revision: number; pageCount: number }>;
}

export interface WorkerRuntimePromotionSnapshot {
  openedPayload: SessionOpenedPayload;
  modelSettings: ModelSettings;
  agentDir: string;
  startupCwd: string;
  sessionDir: string;
  sdkPath: string;
  creationReason?: 'new' | 'resume';
  /** Exact durable handle path. Never substitute the caller's alias. */
  exactSessionPath?: string;
  /** Transactional retained-manager settlement hooks. */
  commitPromotion?: () => void;
  abortPromotion?: () => void;
  authPath?: string;
  authFingerprint?: string;
  runtimePrefs?: Record<string, WorkerJsonValue>;
  providerPolicy?: Record<string, WorkerJsonValue>;
}

interface DetailSubscriptionOwner {
  address: LiveSubagentDetailAddress;
  route: HotWorkerRoute;
  state: 'subscribing' | 'active' | 'closing' | 'rebasing' | 'terminal';
  revision: number;
  baselineRevision: number;
  pageCount: number;
  nextPageIndex: number;
}

export interface WorkerRuntimeRouterOptions {
  supervisor: WorkerSupervisor;
  /** Host-authoritative backend/coordinator generation; defaults to 1 only for legacy tests. */
  coordinatorGeneration?: number;
  coldStore: ColdSessionStore;
  ownership: SessionOwnershipAuthority;
  providerLeases?: CoordinatorProviderNetworkLeaseAuthority;
  buildPromotionSnapshot(sessionPath: string): Promise<WorkerRuntimePromotionSnapshot>;
  writeModelSettings?(updates: Partial<ModelSettings>): Promise<ModelSettings>;
  readModelSettings?(): Promise<ModelSettings>;
  readRuntimePrefs?(): WorkerJsonObject;
  emit(event: string, payload?: unknown): void;
  /** Closed imperative stream; detail pages never enter ViewState. */
  emitDetail?(message: CoordinatorToHostDetailMessage): void;
  onSessionReplaced?: (sourcePath: string, destinationPath: string) => void;
  onRouteChanged?: (state: WorkerRuntimeRouteState) => void;
}

class UnconfirmedWorkerExitError extends Error {
  constructor(message: string, readonly owner: SdkWorkerOwnershipIdentity) {
    super(message);
    this.name = 'UnconfirmedWorkerExitError';
  }
}

const HOT_OPERATIONS: ReadonlySet<string> = new Set<WorkerRuntimeOperation>([
  'session.open',
  'session.preload',
  'session.loadTranscriptPage',
  'session.loadDetail',
  'session.truncateAfter',
  'models.list',
  'liveTurn.checkpoint',
  'message.send',
  'message.compact',
  'message.clearQueue',
  'message.replaceQueue',
  'extension_ui.response',
  'settings.set',
  'systemPromptToggles.set',
  'test.extensionCommand',
]);

/** Coordinator owner for cold→promoting→hot→retiring routing. */
export class WorkerRuntimeRouter {
  private readonly roots = new Map<string, WorkerRuntimeRouteState>();
  private readonly currentPaths = new Map<string, HotWorkerRoute>();
  private readonly workersById = new Map<string, HotWorkerRoute>();
  private readonly providerLeases: CoordinatorProviderNetworkLeaseAuthority;
  private readonly syncRevisions: Record<'settings' | 'catalog' | 'auth' | 'runtimePrefs' | 'providerPolicy', number> = {
    settings: 1, catalog: 1, auth: 1, runtimePrefs: 1, providerPolicy: 1,
  };
  private readonly workerSyncRevisions = new WeakMap<SupervisedWorker, Partial<Record<'settings' | 'catalog' | 'auth' | 'runtimePrefs' | 'providerPolicy', number>>>();
  private syncTail = Promise.resolve();
  private providerPolicy: WorkerJsonObject = {};
  private disposed = false;
  private readonly detailSubscriptions = new Map<string, DetailSubscriptionOwner>();
  private readonly extensionUiOwners = new ExtensionUiOwnerRegistry();
  /** Bounded per-worker runtime discovery reports; never replaces the configured catalog authority. */
  private readonly reportedRuntimeCatalogs = new Map<string, { reportedAt: number; models: unknown[] }>();
  private authPath?: string;
  private authFingerprint?: string;

  constructor(private readonly options: WorkerRuntimeRouterOptions) {
    this.providerLeases = options.providerLeases ?? new CoordinatorProviderNetworkLeaseAuthority();
  }

  static isHotOperation(method: string): method is WorkerRuntimeOperation {
    return HOT_OPERATIONS.has(method);
  }

  getRoute(sessionPath: string): WorkerRuntimeRouteState {
    return this.roots.get(routeKey(sessionPath))
      ?? this.currentPaths.get(routeKey(sessionPath))
      ?? { state: 'cold', rootSessionPath: sessionPath };
  }

  hasHotOwner(sessionPath: string): boolean {
    const route = this.currentPaths.get(routeKey(sessionPath));
    return !!route && route.state === 'hot'
      && this.roots.get(routeKey(route.rootSessionPath)) === route;
  }

  async route(request: RequestEnvelope): Promise<WorkerJsonValue> {
    return await this.routeCommand(request, true);
  }

  async routeExisting(request: RequestEnvelope): Promise<WorkerJsonValue> {
    return await this.routeCommand(request, false);
  }

  async subscribeDetail(message: Extract<HostToCoordinatorDetailMessage, { kind: 'detail.subscribe' }>): Promise<void> {
    if (this.detailSubscriptions.has(message.subscriptionId)) throw new Error('Detail subscription identity is already owned.');
    const route = this.requireHot(message.address.sessionPath);
    this.assertDetailAddressOwner(route, message.address);
    const owner: DetailSubscriptionOwner = {
      address: cloneDetailAddress(message.address), route, state: 'subscribing',
      revision: 0, baselineRevision: 0, pageCount: 0, nextPageIndex: 0,
    };
    this.detailSubscriptions.set(message.subscriptionId, owner);
    try {
      const start = await route.worker.client.requestFrame!({
        kind: 'detail.subscribe', subscriptionId: message.subscriptionId, address: message.address,
        ...(message.cursor ? { cursor: message.cursor } : {}), maxPageBytes: message.maxPageBytes,
      }, 'detail.start');
      if (!this.isCurrent(route) || this.detailSubscriptions.get(message.subscriptionId) !== owner
        || !sameDetailAddress(start.address, message.address)) throw new Error('Detail start owner changed before acknowledgement.');
      owner.state = 'active';
      owner.revision = start.baselineRevision;
      owner.baselineRevision = start.baselineRevision;
      owner.pageCount = start.pageCount;
      owner.nextPageIndex = 0;
      this.forwardDetail(route, {
        kind: 'detail.start', subscriptionId: message.subscriptionId, address: cloneDetailAddress(start.address),
        source: start.source, baselineRevision: start.baselineRevision, pageCount: start.pageCount,
        totalBytes: start.totalBytes, fence: this.detailFence(route),
      });
    } catch (error) {
      this.detailSubscriptions.delete(message.subscriptionId);
      throw error;
    }
  }

  async unsubscribeDetail(message: Extract<HostToCoordinatorDetailMessage, { kind: 'detail.unsubscribe' }>): Promise<void> {
    const owner = this.detailSubscriptions.get(message.subscriptionId);
    if (!owner) return;
    owner.state = 'closing';
    try {
      await owner.route.worker.client.requestFrame!({
        kind: 'detail.unsubscribe', subscriptionId: message.subscriptionId,
      }, 'detail.unsubscribed');
    } finally {
      if (this.detailSubscriptions.get(message.subscriptionId) === owner) this.detailSubscriptions.delete(message.subscriptionId);
    }
  }

  fetchDetail(message: Extract<HostToCoordinatorDetailMessage, { kind: 'detail.fetch' }>): void {
    const owner = this.detailSubscriptions.get(message.subscriptionId);
    if (!owner || owner.state !== 'active' || !sameDetailAddress(owner.address, message.address)) {
      throw new Error('Detail fetch does not match the active subscription owner.');
    }
    this.assertDetailAddressOwner(owner.route, message.address);
    if (message.ref.baselineRevision !== owner.baselineRevision || message.ref.pageCount !== owner.pageCount) {
      throw new Error('Detail fetch ref does not match the active baseline manifest.');
    }
    const sent = owner.route.worker.client.sendFrame?.({
      kind: 'detail.fetch', requestId: message.requestId, subscriptionId: message.subscriptionId,
      address: message.address, ref: message.ref, maxPageBytes: message.maxPageBytes,
    });
    if (!sent) throw new Error('Detail fetch could not be queued to its owning worker.');
  }

  private async routeCommand(request: RequestEnvelope, promoteIfCold: boolean): Promise<WorkerJsonValue> {
    if (!WorkerRuntimeRouter.isHotOperation(request.method)) {
      throw new Error(`Operation ${request.method} is not a worker-runtime command.`);
    }
    const sessionPath = readSessionPath(request.params);
    const hot = promoteIfCold ? await this.promote(sessionPath) : this.requireHot(sessionPath);
    this.assertCurrentOwner(hot, sessionPath);
    const extensionUiResponse = request.method === 'extension_ui.response'
      ? readExtensionUiResponseId(request.params)
      : undefined;
    if (extensionUiResponse !== undefined) {
      // Only the exact first response for a recorded owner is routed. A
      // duplicate, mismatched, timed-out, cancelled, or stale-generation
      // response finds no owner and receives the correlated typed terminal
      // result without ever invoking the worker callback.
      const owner = this.extensionUiOwners.resolve(sessionPath, extensionUiResponse, hot.owner);
      if (!owner) {
        throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
      }
    }
    const response = await hot.worker.client.requestFrame!({
      kind: 'runtime.command',
      operation: request.method,
      payload: asWorkerJsonObject({ params: request.params ?? {}, publicRequestId: request.id }),
    }, 'response');
    if (extensionUiResponse !== undefined) {
      // The owning worker settled (accepted or definitively rejected); the
      // owner is cleared so any duplicate response is typed stale. A worker
      // that already consumed the dialog locally reports the legacy terminal
      // error; surface the exact typed message so the host treats it as the
      // same already-consumed terminal state it does in legacy mode.
      this.extensionUiOwners.settle(sessionPath, extensionUiResponse);
      if (!response.ok && typeof response.error?.message === 'string'
        && (response.error.message.startsWith('UI_REQUEST_NOT_PENDING:')
          || response.error.message.startsWith('NO_UI_BRIDGE:'))) {
        throw new BackendError('UI_REQUEST_NOT_PENDING', 'The extension UI request is no longer pending.');
      }
    }
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    if (response.result.kind !== 'runtime.command') throw new Error('Worker returned the wrong runtime command result.');
    const resultPayload = response.result.payload;
    const earlyAckRequestId = resultPayload !== null
      && typeof resultPayload === 'object'
      && !Array.isArray(resultPayload)
      && typeof resultPayload.requestId === 'string'
      ? resultPayload.requestId
      : undefined;
    if (request.method === 'message.send' && earlyAckRequestId
      && hot.checkpoint.requestId === undefined
      && hot.checkpoint.terminalRequestId !== earlyAckRequestId) {
      // Early-acked sends have no message.started checkpoint yet. Retain the
      // request identity so a worker crash can terminalize the promoted send
      // as preflight.failed instead of waiting for the host timeout.
      hot.checkpoint.requestId = earlyAckRequestId;
      hot.checkpoint.messageId = undefined;
      hot.checkpoint.preflightOnly = true;
    }
    return resultPayload;
  }

  async promote(sessionPath: string): Promise<HotWorkerRoute> {
    if (this.disposed) throw new Error('Worker runtime router is disposed.');
    const key = routeKey(sessionPath);
    const root = this.roots.get(key);
    if (root?.state === 'transitioning') throw new SessionTransitionInProgressError(sessionPath);
    const current = root ?? this.currentPaths.get(key);
    if (current?.state === 'hot') {
      this.assertCurrentOwner(current, sessionPath);
      return current;
    }
    if (current?.state === 'promoting') return await current.promotion;
    if (current?.state === 'retiring') {
      await current.retirement;
      return await this.promote(sessionPath);
    }
    const promotion = this.promoteOnce(sessionPath);
    const promoting: WorkerRuntimeRouteState = { state: 'promoting', rootSessionPath: sessionPath, promotion };
    this.roots.set(key, promoting);
    this.notify(promoting);
    try {
      return await promotion;
    } catch (error) {
      if (!this.roots.has(key) || this.roots.get(key) === promoting) {
        if (error instanceof UnconfirmedWorkerExitError) {
          const retirement = Promise.reject(error);
          void retirement.catch(() => undefined);
          const retiring: WorkerRuntimeRouteState = {
            state: 'retiring',
            rootSessionPath: sessionPath,
            owner: error.owner,
            retirement,
          };
          this.roots.set(key, retiring);
          this.notify(retiring);
        } else {
          const cold: WorkerRuntimeRouteState = { state: 'cold', rootSessionPath: sessionPath };
          this.roots.set(key, cold);
          this.notify(cold);
        }
      }
      throw error;
    }
  }

  runHotTransition<T>(
    sessionPath: string,
    transitionKey: string,
    operation: (control: WorkerRuntimeTransitionControl) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Worker runtime router is disposed.'));
    const key = routeKey(sessionPath);
    const existing = this.roots.get(key);
    if (existing?.state === 'transitioning') {
      if (existing.transitionKey === transitionKey) return existing.completion as Promise<T>;
      return Promise.reject(new SessionTransitionInProgressError(sessionPath));
    }
    const route = this.currentPaths.get(key);
    if (!route || !this.isCurrent(route)) return Promise.reject(new Error(`No hot worker owns ${sessionPath}.`));

    let resolveCompletion!: (value: T | PromiseLike<T>) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<T>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const transition: WorkerRuntimeTransitionRoute = {
      state: 'transitioning',
      rootSessionPath: route.rootSessionPath,
      transitionKey,
      owner: route.owner,
      completion,
      source: route,
      retireStarted: false,
      retired: false,
    };
    this.roots.set(routeKey(route.rootSessionPath), transition);
    this.notify(transition);

    const control: WorkerRuntimeTransitionControl = {
      interrupt: async (reason) => await this.options.supervisor.interrupt(route.currentLeasePath, undefined, reason),
      retire: async (reason) => {
        if (transition.retired) return;
        transition.retireStarted = true;
        await this.options.supervisor.stopWorker(route.currentLeasePath, reason);
        this.extensionUiOwners.clearWorker(route.owner.workerId, route.owner.workerGeneration);
        this.providerLeases.releaseOwner(route.owner, reason);
        await this.options.ownership.reconcileCrash({ owner: route.owner, processDeathConfirmed: true });
        this.currentPaths.delete(routeKey(route.currentLeasePath));
        this.workersById.delete(route.owner.workerId);
        transition.retired = true;
      },
      promote: async (target) => await this.promoteOnce(target),
    };

    void (async () => {
      try {
        const result = await operation(control);
        if (this.roots.get(routeKey(transition.rootSessionPath)) === transition) {
          const settled: WorkerRuntimeRouteState = transition.retired
            ? { state: 'cold', rootSessionPath: route.currentLeasePath }
            : route;
          this.roots.set(routeKey(settled.rootSessionPath), settled);
          this.notify(settled);
        }
        resolveCompletion(result);
      } catch (error) {
        const transitionRootKey = routeKey(transition.rootSessionPath);
        const current = this.roots.get(transitionRootKey);
        if (current === transition && !transition.retireStarted
            && this.currentPaths.get(routeKey(route.currentLeasePath)) === route) {
          this.roots.set(routeKey(route.rootSessionPath), route);
          this.notify(route);
        } else if (transition.retired && (!current || current === transition)) {
          // A failed fresh promotion removes its provisional lookup. Publish an
          // explicit retryable cold route while the coordinator retains the
          // exact durable manager created by the truncate.
          const cold: WorkerRuntimeRouteState = { state: 'cold', rootSessionPath: route.currentLeasePath };
          this.roots.set(routeKey(route.currentLeasePath), cold);
          this.notify(cold);
        }
        // An unconfirmed retirement remains transitioning/fenced. No command
        // may be routed back to a process whose death is ambiguous.
        rejectCompletion(error);
      }
    })();
    return completion;
  }

  async interrupt(sessionPath: string, reason: string): Promise<{ soft: boolean }> {
    const route = this.requireHot(sessionPath);
    const result = await this.options.supervisor.interrupt(route.currentLeasePath, undefined, reason);
    if (!result.soft && this.isCurrent(route)) {
      await this.handleWorkerStateChange(
        route.workerRootSessionPath,
        route.worker.client.getSnapshot(),
        { workerId: route.owner.workerId, workerGeneration: route.owner.workerGeneration },
      );
    }
    return result;
  }

  async retire(sessionPath: string, reason = 'runtime retirement'): Promise<void> {
    const route = this.requireHot(sessionPath);
    const rootKey = routeKey(route.rootSessionPath);
    const retirement = (async () => {
      await this.options.supervisor.stopWorker(route.currentLeasePath, reason);
      // Keep an active response body fenced until process-tree death is
      // confirmed. Releasing before stop could overlap it with the next worker.
      this.extensionUiOwners.clearWorker(route.owner.workerId, route.owner.workerGeneration);
      this.providerLeases.releaseOwner(route.owner, reason);
      await this.options.ownership.reconcileCrash({ owner: route.owner, processDeathConfirmed: true });
      this.currentPaths.delete(routeKey(route.currentLeasePath));
      this.workersById.delete(route.owner.workerId);
      const cold: WorkerRuntimeRouteState = { state: 'cold', rootSessionPath: route.currentLeasePath };
      this.roots.delete(rootKey);
      this.roots.set(routeKey(route.currentLeasePath), cold);
      this.notify(cold);
    })();
    const retiring: WorkerRuntimeRouteState = {
      state: 'retiring', rootSessionPath: route.rootSessionPath, owner: route.owner, retirement,
    };
    this.roots.set(rootKey, retiring);
    this.notify(retiring);
    await retirement;
  }

  async syncRuntimePrefs(values: WorkerJsonObject): Promise<void> {
    await this.broadcastSync('runtimePrefs', { values });
  }

  async syncProviderPolicy(providers: WorkerJsonObject): Promise<void> {
    this.providerPolicy = { ...providers };
    this.providerLeases.updatePolicies(this.providerPolicy);
    await this.broadcastSync('providerPolicy', { providers: this.providerPolicy });
  }

  /** Broadcast the coordinator-authoritative settings snapshot after a cold
   * (global) settings write so hot workers never serve stale values. */
  async syncSettings(): Promise<void> {
    const values = this.options.readModelSettings ? await this.options.readModelSettings() : undefined;
    if (!values) return;
    await this.broadcastSync('settings', { values: asWorkerJsonObject(values) });
  }

  /** Broadcast the coordinator-authoritative configured catalog (models.json)
   * after its file fingerprint moved. The payload is the configured authority;
   * runtime discovery reports never replace it. */
  async syncCatalog(models: WorkerJsonValue[]): Promise<void> {
    await this.broadcastSync('catalog', { models });
  }

  /** Auth fingerprint refresh: bump the auth sync revision and broadcast the
   * new fingerprint to every worker. A worker that cannot acknowledge is
   * retired fail-closed (its runtime may hold stale credentials); other
   * workers continue. Returns the number of retired workers. */
  async refreshAuth(fingerprint: string, authPath?: string): Promise<{ bumped: boolean; retiredWorkers: number }> {
    if (authPath) this.authPath = authPath;
    if (!this.authPath) return { bumped: false, retiredWorkers: 0 };
    if (fingerprint === this.authFingerprint) return { bumped: false, retiredWorkers: 0 };
    this.authFingerprint = fingerprint;
    let retiredWorkers = 0;
    await this.withSyncLock(async () => {
      const revision = this.syncRevisions.auth + 1;
      this.syncRevisions.auth = revision;
      const payload = { authPath: this.authPath!, fingerprint };
      const workers = this.options.supervisor.listWorkers();
      await Promise.all(workers.map(async (worker) => {
        const known = this.workerSyncRevisions.get(worker)?.auth ?? 0;
        if (known >= revision) return;
        try {
          const response = await worker.client.requestFrame!({ kind: 'sync', domain: 'auth', revision, payload } as never, 'sync.ack');
          if (response.domain !== 'auth' || response.revision !== revision) {
            throw new Error(`Worker sync acknowledgement mismatch for auth.`);
          }
          const revisions = this.workerSyncRevisions.get(worker) ?? {};
          revisions.auth = revision;
          this.workerSyncRevisions.set(worker, revisions);
        } catch (error) {
          retiredWorkers += 1;
          void this.retire(worker.sessionPath, `auth refresh could not be acknowledged: ${error instanceof Error ? error.message : String(error)}`)
            .catch(() => undefined);
        }
      }));
    });
    return { bumped: true, retiredWorkers };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const hot = [...this.roots.values()].filter((route): route is HotWorkerRoute => route.state === 'hot');
    for (const route of hot) this.extensionUiOwners.clearWorker(route.owner.workerId, route.owner.workerGeneration);
    await Promise.allSettled(hot.map((route) => this.retire(route.currentLeasePath, 'coordinator shutdown')));
  }

  async handleWorkerStateChange(
    rootSessionPath: string,
    snapshot: WorkerClientSnapshot,
    identity?: { workerId: string; workerGeneration: number },
  ): Promise<void> {
    if (snapshot.status !== 'exited') return;
    const route = identity
      ? this.workersById.get(identity.workerId)
      : [...this.workersById.values()].find((candidate) => routeKey(candidate.workerRootSessionPath) === routeKey(rootSessionPath));
    if (!route || route.state !== 'hot') return;
    // Snapshot the bounded checkpoint (including the detail subscription
    // manifest) BEFORE invalidating live subscriptions so crash diagnostics
    // still describe what was in flight.
    const crashCheckpoint = this.checkpointManifest(route);
    this.invalidateDetailSubscriptions(route, 'generation-change');
    this.extensionUiOwners.clearWorker(route.owner.workerId, route.owner.workerGeneration);
    this.providerLeases.releaseOwner(route.owner, 'Worker crashed.');
    await this.options.supervisor.stopWorker(route.currentLeasePath, 'confirmed worker exit').catch(() => undefined);
    await this.options.ownership.reconcileCrash({ owner: route.owner, processDeathConfirmed: true });
    if (!this.isCurrent(route)) return;
    this.currentPaths.delete(routeKey(route.currentLeasePath));
    this.workersById.delete(route.owner.workerId);
    const cold: WorkerRuntimeRouteState = { state: 'cold', rootSessionPath: route.currentLeasePath };
    this.roots.delete(routeKey(route.rootSessionPath));
    this.roots.set(routeKey(route.currentLeasePath), cold);
    this.notify(cold);
    this.reconcileInterruptedCheckpoint(route, snapshot);
    this.options.emit('operational-error', {
      incidentId: `worker-exit:${route.owner.workerId}:${route.owner.workerGeneration}`,
      code: 'SESSION_WORKER_EXITED',
      message: 'The session worker exited. Live work was interrupted and was not replayed.',
      sessionPath: route.currentLeasePath,
      checkpoint: crashCheckpoint,
    });
  }

  async handleWorkerFrame(rootSessionPath: string, frame: WorkerToCoordinatorFrame): Promise<void> {
    const root = this.roots.get(routeKey(rootSessionPath));
    const route = this.workersById.get(frame.workerId)
      ?? (root?.state === 'hot'
        ? root
        : root?.state === 'promoting'
          ? this.currentPaths.get(routeKey(frame.leasePath))
          : undefined);
    if (!route || frame.workerId !== route.owner.workerId
      || frame.workerGeneration !== route.owner.workerGeneration
      || frame.coordinatorGeneration !== route.owner.coordinatorGeneration
      || routeKey(frame.rootSessionPath) !== routeKey(route.workerRootSessionPath)
      || routeKey(frame.leasePath) !== routeKey(route.currentLeasePath)
      || frame.leaseRevision !== route.currentLeaseRevision) {
      return; // stale/cross-session frames are telemetry-only drops
    }

    if (frame.kind === 'runtime.event') {
      const eventPath = typeof frame.payload.sessionPath === 'string' ? frame.payload.sessionPath : route.currentLeasePath;
      const isSupersededTerminal = route.previousLeasePath !== undefined
        && routeKey(eventPath) === routeKey(route.previousLeasePath)
        && (frame.event === 'preflight.failed'
          || (frame.event === 'busy.changed' && frame.payload.busy === false));
      if (routeKey(eventPath) !== routeKey(route.currentLeasePath) && !isSupersededTerminal) return;
      if (frame.event === 'extension_ui.request' && !isSupersededTerminal) {
        // Record the exact pending owner BEFORE forwarding the public request.
        // A request that cannot be owned exactly once must never reach the
        // host, and a later response for it must never invoke the worker.
        if (!this.recordExtensionUiOwner(route, frame.payload)) return;
      }
      if (!isSupersededTerminal) this.observeCheckpoint(route, frame.event, frame.payload);
      this.options.emit(frame.event, frame.payload);
      return;
    }
    if (frame.kind === 'runtime.report') {
      this.handleRuntimeReport(route, frame);
      return;
    }
    if (frame.kind === 'detail.page' || frame.kind === 'detail.delta' || frame.kind === 'detail.rebase'
      || frame.kind === 'detail.terminal' || frame.kind === 'detail.error') {
      this.handleDetailFrame(route, frame);
      return;
    }
    if (frame.kind === 'detail.start' || frame.kind === 'detail.unsubscribed') {
      return; // Correlated responses are consumed by WorkerClient.
    }
    if (frame.kind === 'ownership.reserve') {
      try {
        const reservation = await this.options.ownership.reserve(route.owner, frame.intent);
        route.worker.client.sendFrame?.({ kind: 'ownership.reserved', requestId: frame.requestId, reservation });
      } catch (error) {
        this.sendOwnershipRejected(route, frame.requestId, 'reserve', error);
      }
      return;
    }
    if (frame.kind === 'ownership.abort') {
      try {
        await this.options.ownership.abort(route.owner, frame.reservation, frame.reason);
        route.worker.client.sendFrame?.({ kind: 'ownership.aborted', requestId: frame.requestId, reservationId: frame.reservation.reservationId });
      } catch (error) {
        this.sendOwnershipRejected(route, frame.requestId, 'abort', error);
      }
      return;
    }
    if (frame.kind === 'ownership.commit') {
      try {
        const authorization = await this.options.ownership.commit(route.owner, frame.reservation, frame.sourceLease);
        // Enqueue the response under the old frame identity, then atomically rekey
        // both coordinator route and client identity before any successor frame.
        route.worker.client.sendFrame?.({ kind: 'ownership.committed', requestId: frame.requestId, authorization });
        const sourcePath = route.currentLeasePath;
        const sourceRootKey = routeKey(route.rootSessionPath);
        const destinationPath = authorization.destinationLease.canonicalSessionPath;
        // The coordinator response is queued under the source identity first.
        // Everything after it is a synchronous ownership commit: supervisor
        // lookup, public roots, current lease lookup, and client identity move
        // together. The released source immediately becomes an independent
        // cold root and can be promoted without resolving through this worker.
        route.worker.client.updateLeaseIdentity?.(
          destinationPath,
          authorization.destinationLease.ownershipRevision,
        );
        this.options.supervisor.rekeyWorker(sourcePath, destinationPath);
        this.currentPaths.delete(routeKey(sourcePath));
        this.roots.delete(sourceRootKey);
        this.roots.set(routeKey(sourcePath), { state: 'cold', rootSessionPath: sourcePath });
        route.rootSessionPath = destinationPath;
        route.previousLeasePath = sourcePath;
        route.currentLeasePath = destinationPath;
        route.currentLeaseRevision = authorization.destinationLease.ownershipRevision;
        this.roots.set(routeKey(destinationPath), route);
        this.currentPaths.set(routeKey(destinationPath), route);
        this.options.onSessionReplaced?.(sourcePath, destinationPath);
        this.notify(route);
      } catch (error) {
        this.sendOwnershipRejected(route, frame.requestId, 'commit', error);
        await this.options.ownership.failClosed(route.owner, error).catch(() => undefined);
        await this.failWorkerRoute(route, error);
      }
      return;
    }
    if (frame.kind === 'ownership.consume') {
      try {
        const lease = await this.options.ownership.consumeTransfer(
          route.owner,
          frame.authorization,
          frame.canonicalDestinationPath,
        );
        route.worker.client.sendFrame?.({
          kind: 'ownership.consumed',
          requestId: frame.requestId,
          authorizationId: frame.authorization.authorizationId,
          lease,
        });
      } catch (error) {
        this.sendOwnershipRejected(route, frame.requestId, 'consume', error);
        await this.options.ownership.failClosed(route.owner, error).catch(() => undefined);
        await this.failWorkerRoute(route, error);
      }
      return;
    }
    if (frame.kind === 'ownership.runtimeReady') {
      try {
        await this.options.ownership.createAdapter(route.owner).runtimeReady(frame.lease, frame.canonicalPath);
        route.worker.client.sendFrame?.({
          kind: 'ownership.runtimeReadyAck',
          requestId: frame.requestId,
          canonicalPath: frame.canonicalPath,
          ownershipRevision: frame.lease.ownershipRevision,
        });
      } catch (error) {
        this.sendOwnershipRejected(route, frame.requestId, 'runtimeReady', error);
        await this.failWorkerRoute(route, error);
      }
      return;
    }
    if (frame.kind === 'provider.acquire') {
      try {
        const lease = await this.providerLeases.acquire(route.owner, frame.requestId, frame.request);
        if (!this.isCurrentOrPromoting(route) || !this.providerLeases.isActive(route.owner, frame.requestId, lease.leaseId)) {
          this.providerLeases.release(route.owner, lease.leaseId, 'cancelled');
          return;
        }
        const sent = route.worker.client.sendFrame?.({ kind: 'provider.granted', requestId: frame.requestId, lease }) === true;
        if (!sent || !this.providerLeases.markDelivered(route.owner, frame.requestId, lease.leaseId)) {
          this.providerLeases.release(route.owner, lease.leaseId, 'cancelled');
        }
      } catch (error) {
        // Admission rejection must settle the exact acquire (notably an open
        // global circuit). A correlated cancellation (AbortError) is already
        // settled by the provider.cancel handler's own provider.cancelled
        // frame when the acquire was queued, or is unnecessary because the
        // owner is being retired; re-sending here would fatal the worker on
        // an unknown requestId.
        if (error instanceof Error && error.name === 'AbortError') return;
        route.worker.client.sendFrame?.({
          kind: 'provider.cancelled',
          requestId: frame.requestId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (frame.kind === 'provider.cancel') {
      const cancellation = this.providerLeases.cancel(route.owner, frame.targetRequestId, frame.reason);
      if (cancellation.notifyAcquire) {
        route.worker.client.sendFrame?.({
          kind: 'provider.cancelled',
          requestId: frame.targetRequestId,
          reason: frame.reason,
        });
      }
      route.worker.client.sendFrame?.({
        kind: 'provider.cancelAck',
        requestId: frame.requestId,
        targetRequestId: frame.targetRequestId,
        status: cancellation.status,
        ...(cancellation.leaseId ? { leaseId: cancellation.leaseId } : {}),
      });
      return;
    }
    if (frame.kind === 'provider.observation') {
      this.providerLeases.observe(route.owner, frame.leaseId, frame.observation);
      return;
    }
    if (frame.kind === 'provider.release') {
      this.providerLeases.release(route.owner, frame.leaseId, frame.outcome);
      route.worker.client.sendFrame?.({ kind: 'provider.released', requestId: frame.requestId, leaseId: frame.leaseId });
      return;
    }
    if (frame.kind === 'settings.mutate') {
      try {
        if (!this.options.writeModelSettings) throw new Error('Coordinator settings authority is unavailable.');
        // The whole persist+revision+broadcast sequence is one sync-locked
        // unit so two concurrent mutations can never produce the same
        // revision for different persisted values (which would let the second
        // broadcast skip workers that already acked the first).
        await this.withSyncLock(async () => {
          const values = await this.options.writeModelSettings!(frame.updates as unknown as Partial<ModelSettings>);
          const revision = this.syncRevisions.settings + 1;
          this.syncRevisions.settings = revision;
          route.worker.client.sendFrame?.({
            kind: 'settings.authoritative',
            requestId: frame.requestId,
            revision,
            values: asWorkerJsonObject(values),
          });
          await this.broadcastSyncLocked('settings', { values: asWorkerJsonObject(values) }, revision);
        });
      } catch (error) {
        await this.failWorkerRoute(route, error);
      }
    }
  }

  private handleDetailFrame(
    route: HotWorkerRoute,
    frame: Extract<WorkerToCoordinatorFrame, {
      kind: 'detail.page' | 'detail.delta' | 'detail.rebase' | 'detail.terminal' | 'detail.error';
    }>,
  ): void {
    const owner = this.detailSubscriptions.get(frame.subscriptionId);
    if (!owner || owner.route !== route || owner.state === 'closing' || !this.isCurrent(route)) return;
    const fence = this.detailFence(route);
    if (frame.kind === 'detail.page') {
      if (frame.ref.baselineRevision !== owner.baselineRevision || frame.ref.pageCount !== owner.pageCount
        || frame.ref.pageIndex >= owner.pageCount
        || frame.checksum !== createHash('sha256').update(JSON.stringify(frame.payload)).digest('hex')) {
        this.rebaseDetail(owner, 'gap');
        return;
      }
      if (frame.requestId === undefined) {
        if (owner.state !== 'active' || frame.ref.pageIndex !== owner.nextPageIndex) {
          this.rebaseDetail(owner, 'gap');
          return;
        }
        owner.nextPageIndex += 1;
      }
      this.forwardDetail(route, {
        kind: 'detail.page', subscriptionId: frame.subscriptionId, ref: frame.ref,
        payload: frame.payload, payloadBytes: frame.payloadBytes, checksum: frame.checksum, fence,
      });
      return;
    }
    if (frame.kind === 'detail.delta') {
      if (owner.state !== 'active' || frame.baseRevision !== owner.revision || frame.revision <= frame.baseRevision) {
        this.rebaseDetail(owner, 'gap');
        return;
      }
      owner.revision = frame.revision;
      this.forwardDetail(route, { kind: 'detail.delta', subscriptionId: frame.subscriptionId,
        baseRevision: frame.baseRevision, revision: frame.revision, operations: frame.operations, fence });
      return;
    }
    if (frame.kind === 'detail.rebase') {
      owner.state = 'rebasing';
      this.forwardDetail(route, { kind: 'detail.rebase', subscriptionId: frame.subscriptionId,
        currentRevision: frame.currentRevision, reason: frame.reason, fence });
      return;
    }
    if (frame.kind === 'detail.terminal') {
      if (owner.state === 'terminal') return;
      owner.state = 'terminal';
      this.forwardDetail(route, { kind: 'detail.terminal', subscriptionId: frame.subscriptionId,
        revision: frame.revision, durableRef: frame.durableRef, fence });
      this.detailSubscriptions.delete(frame.subscriptionId);
      return;
    }
    // Subscribe-correlated failures (`detail.error` carrying the subscribe
    // requestId while the owner is still `subscribing`) settle through the
    // correlated RPC rejection and must not also be forwarded as stream
    // traffic: the server may fall back to the durable authority for the same
    // subscriptionId, and a forwarded error would kill the owner before the
    // durable baseline arrives. Stream-time errors (no requestId, or after the
    // start) are forwarded normally.
    if (frame.requestId === undefined || owner.state !== 'subscribing') {
      this.forwardDetail(route, { kind: 'detail.error', subscriptionId: frame.subscriptionId,
        code: frame.code, message: frame.message, retryable: frame.retryable, fence });
    }
  }

  private rebaseDetail(owner: DetailSubscriptionOwner, reason: 'gap' | 'backpressure' | 'evicted' | 'generation-change'): void {
    if (owner.state === 'rebasing' || owner.state === 'closing' || owner.state === 'terminal') return;
    owner.state = 'rebasing';
    const subscriptionId = [...this.detailSubscriptions].find(([, candidate]) => candidate === owner)?.[0];
    if (!subscriptionId) return;
    this.forwardDetail(owner.route, { kind: 'detail.rebase', subscriptionId, currentRevision: owner.revision,
      reason, fence: this.detailFence(owner.route) });
  }

  private assertDetailAddressOwner(route: HotWorkerRoute, address: LiveSubagentDetailAddress): void {
    this.assertCurrentOwner(route, address.sessionPath);
    if (routeKey(address.sessionPath) !== routeKey(route.currentLeasePath)) throw new Error('Detail address path is not owned by this worker route.');
  }

  private detailFence(route: HotWorkerRoute): import('../shared/protocol/subagent-detail.js').BackendDetailFence {
    return {
      backendGeneration: route.owner.coordinatorGeneration,
      coordinatorGeneration: route.owner.coordinatorGeneration,
      workerId: route.owner.workerId,
      workerGeneration: route.owner.workerGeneration,
    };
  }

  private forwardDetail(route: HotWorkerRoute, message: CoordinatorToHostDetailMessage): void {
    if (!this.isCurrent(route)) return;
    this.options.emitDetail?.(message);
  }

  private async promoteOnce(sessionPath: string): Promise<HotWorkerRoute> {
    const snapshot = await this.options.buildPromotionSnapshot(sessionPath);
    const exactSessionPath = snapshot.exactSessionPath ?? snapshot.openedPayload.session.path;
    const grant = this.options.coldStore.serializePromotionGrant(
      exactSessionPath,
      snapshot.creationReason ?? 'resume',
    );
    let owner: SdkWorkerOwnershipIdentity | undefined;
    let lease: SdkSessionWriteLease | undefined;
    let worker: SupervisedWorker | undefined;
    try {
      worker = await this.options.supervisor.startWorker(exactSessionPath, async (identity) => {
        owner = {
          coordinatorGeneration: this.options.coordinatorGeneration ?? 1,
          workerId: identity.workerId,
          workerGeneration: identity.workerGeneration,
        };
        lease = await this.options.ownership.registerHot(exactSessionPath, owner);
        return { leasePath: lease.canonicalSessionPath, leaseRevision: lease.ownershipRevision };
      });
      if (!owner || !lease) throw new Error('Worker ownership was not prepared before spawn.');
      await this.syncStartup(worker, snapshot);
      const route: HotWorkerRoute = {
        state: 'hot',
        rootSessionPath: lease.canonicalSessionPath,
        workerRootSessionPath: exactSessionPath,
        currentLeasePath: lease.canonicalSessionPath,
        currentLeaseRevision: lease.ownershipRevision,
        owner,
        worker,
        checkpoint: { busySeq: 0, tools: [] },
      };
      // Install only worker/current-path lookup while the public root remains
      // `promoting`. Events are fenced and delivered through that owner, but a
      // concurrent command still joins the promotion promise and cannot reach
      // the process before runtime.ready.
      this.currentPaths.set(routeKey(route.currentLeasePath), route);
      this.workersById.set(route.owner.workerId, route);
      await worker.client.requestFrame!({
        kind: 'runtime.promote',
        operationId: grant.grantId,
        payload: asWorkerJsonObject({
          sdkPath: snapshot.sdkPath,
          agentDir: snapshot.agentDir,
          startupCwd: snapshot.startupCwd,
          sessionDir: snapshot.sessionDir,
          sessionPath: exactSessionPath,
          creationReason: grant.creationReason,
          writeLease: lease,
          openedPayload: snapshot.openedPayload,
          modelSettings: snapshot.modelSettings,
        }),
      }, 'runtime.ready');
      this.options.coldStore.consumePromotionGrant(grant);
      snapshot.commitPromotion?.();
      this.roots.set(routeKey(route.rootSessionPath), route);
      this.notify(route);
      return route;
    } catch (error) {
      this.options.coldStore.abortPromotionGrant(grant);
      if (owner) {
        try {
          await this.options.supervisor.stopWorker(worker?.sessionPath ?? exactSessionPath, 'failed promotion');
        } catch (stopError) {
          throw new UnconfirmedWorkerExitError(
            `Failed promotion remains fenced because worker exit was not confirmed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
            owner,
          );
        }
        this.extensionUiOwners.clearWorker(owner.workerId, owner.workerGeneration);
        this.providerLeases.releaseOwner(owner);
        await this.options.ownership.reconcileCrash({ owner, processDeathConfirmed: true });
      }
      const failedRoute = owner ? this.workersById.get(owner.workerId) : undefined;
      if (failedRoute) {
        this.roots.delete(routeKey(failedRoute.rootSessionPath));
        this.currentPaths.delete(routeKey(failedRoute.currentLeasePath));
        this.workersById.delete(failedRoute.owner.workerId);
      }
      snapshot.abortPromotion?.();
      throw error;
    }
  }

  private async broadcastSync(
    domain: 'settings' | 'catalog' | 'auth' | 'runtimePrefs' | 'providerPolicy',
    payload: WorkerJsonObject,
    fixedRevision?: number,
  ): Promise<void> {
    await this.withSyncLock(() => this.broadcastSyncLocked(domain, payload, fixedRevision));
  }

  private async broadcastSyncLocked(
    domain: 'settings' | 'catalog' | 'auth' | 'runtimePrefs' | 'providerPolicy',
    payload: WorkerJsonObject,
    fixedRevision?: number,
  ): Promise<void> {
    const revision = fixedRevision ?? this.syncRevisions[domain] + 1;
    this.syncRevisions[domain] = revision;
    const workers = this.options.supervisor.listWorkers();
    await Promise.all(workers.map(async (worker) => {
      const known = this.workerSyncRevisions.get(worker)?.[domain] ?? 0;
      if (known >= revision) return;
      const response = await worker.client.requestFrame!(
        { kind: 'sync', domain, revision, payload } as never,
        'sync.ack',
      );
      if (response.domain !== domain || response.revision !== revision) {
        throw new Error(`Worker sync acknowledgement mismatch for ${domain}.`);
      }
      const revisions = this.workerSyncRevisions.get(worker) ?? {};
      revisions[domain] = revision;
      this.workerSyncRevisions.set(worker, revisions);
    }));
  }

  private async syncStartup(worker: SupervisedWorker, snapshot: WorkerRuntimePromotionSnapshot): Promise<void> {
    await this.withSyncLock(async () => {
      const currentSettings = this.options.readModelSettings
        ? await this.options.readModelSettings()
        : snapshot.modelSettings;
      const currentRuntimePrefs = this.options.readRuntimePrefs?.() ?? snapshot.runtimePrefs ?? {};
      this.authPath ??= snapshot.authPath ?? path.join(snapshot.agentDir, 'auth.json');
      this.authFingerprint ??= snapshot.authFingerprint ?? 'startup-unavailable';
      const syncs = [
        { domain: 'settings' as const, revision: this.syncRevisions.settings, payload: { values: asWorkerJsonObject(currentSettings) } },
        { domain: 'catalog' as const, revision: this.syncRevisions.catalog, payload: { models: (snapshot.openedPayload.availableModels ?? []) as unknown as WorkerJsonValue[] } },
        { domain: 'auth' as const, revision: this.syncRevisions.auth, payload: {
          authPath: this.authPath ?? snapshot.authPath ?? path.join(snapshot.agentDir, 'auth.json'),
          fingerprint: snapshot.authFingerprint ?? this.authFingerprint ?? 'startup-unavailable',
        } },
        { domain: 'runtimePrefs' as const, revision: this.syncRevisions.runtimePrefs, payload: { values: currentRuntimePrefs } },
        { domain: 'providerPolicy' as const, revision: this.syncRevisions.providerPolicy, payload: {
          providers: Object.keys(this.providerPolicy).length > 0 ? this.providerPolicy : snapshot.providerPolicy ?? {},
        } },
      ];
      const revisions = this.workerSyncRevisions.get(worker) ?? {};
      for (const sync of syncs) {
        if ((revisions[sync.domain] ?? 0) >= sync.revision) continue;
        const response = await worker.client.requestFrame!({ kind: 'sync', ...sync }, 'sync.ack');
        if (response.domain !== sync.domain || response.revision !== sync.revision) {
          throw new Error(`Worker sync acknowledgement mismatch for ${sync.domain}.`);
        }
        revisions[sync.domain] = sync.revision;
      }
      this.workerSyncRevisions.set(worker, revisions);
    });
  }

  private async withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.syncTail.then(operation, operation);
    this.syncTail = run.then(() => undefined, () => undefined);
    return await run;
  }

  private requireHot(sessionPath: string): HotWorkerRoute {
    const root = this.roots.get(routeKey(sessionPath));
    if (root?.state === 'transitioning') throw new SessionTransitionInProgressError(sessionPath);
    const route = this.currentPaths.get(routeKey(sessionPath));
    if (!route || route.state !== 'hot') throw new Error(`No hot worker owns ${sessionPath}.`);
    this.assertCurrentOwner(route, sessionPath);
    return route;
  }

  private assertCurrentOwner(route: HotWorkerRoute, sessionPath: string): void {
    if (!this.isCurrent(route) || routeKey(route.currentLeasePath) !== routeKey(sessionPath)) {
      throw new Error(`Stale or cross-session worker route for ${sessionPath}.`);
    }
  }

  private isCurrent(route: HotWorkerRoute): boolean {
    return this.roots.get(routeKey(route.rootSessionPath)) === route
      && this.currentPaths.get(routeKey(route.currentLeasePath)) === route
      && this.workersById.get(route.owner.workerId) === route;
  }

  /** True when `route` is the legitimate owner, including while it is still
   *  promoting. During promotion the public root holds a `promoting` placeholder
   *  (the hot route is installed in `roots` only after `runtime.ready`), so
   *  `isCurrent` is false even though the route is already the sole owner in
   *  `currentPaths`/`workersById`. Provider admission and ownership handshakes
   *  that the worker performs DURING promotion (e.g. a `session_start` extension
   *  fetch) must not be dropped just because the root has not yet flipped to
   *  `hot`; otherwise the worker's correlated `provider.granted` never arrives
   *  and promotion hangs forever. */
  private isCurrentOrPromoting(route: HotWorkerRoute): boolean {
    if (this.currentPaths.get(routeKey(route.currentLeasePath)) !== route) return false;
    if (this.workersById.get(route.owner.workerId) !== route) return false;
    const root = this.roots.get(routeKey(route.rootSessionPath));
    if (root === route) return true;
    return root?.state === 'promoting'
      && routeKey(root.rootSessionPath) === routeKey(route.rootSessionPath);
  }

  private observeCheckpoint(route: HotWorkerRoute, event: string, payload: WorkerJsonObject): void {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : undefined;
    if (event === 'busy.changed' && Number.isSafeInteger(payload.seq)) {
      route.checkpoint.busySeq = Math.max(route.checkpoint.busySeq, payload.seq as number);
    } else if (event === 'message.started') {
      route.checkpoint.requestId = requestId;
      route.checkpoint.terminalRequestId = undefined;
      route.checkpoint.messageId = messageId;
      route.checkpoint.preflightOnly = false;
    } else if (event === 'message.finished' || event === 'message.aborted' || event === 'preflight.failed') {
      if (requestId) route.checkpoint.terminalRequestId = requestId;
      route.checkpoint.requestId = undefined;
      route.checkpoint.messageId = undefined;
      route.checkpoint.preflightOnly = undefined;
      route.checkpoint.tools = [];
      if (event === 'message.finished') {
        const durableId = readDurableEntryId(payload, 'message');
        if (durableId) route.checkpoint.durableWatermark = durableId;
      }
    } else if (event === 'tool.started' && requestId && messageId && typeof payload.toolCallId === 'string') {
      route.checkpoint.tools = [
        ...route.checkpoint.tools.filter((tool) => tool.toolCallId !== payload.toolCallId),
        {
          requestId,
          messageId,
          toolCallId: payload.toolCallId,
          ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          ...(payload.input !== undefined ? { input: payload.input } : {}),
          ...(typeof payload.startedAt === 'number' ? { startedAt: payload.startedAt } : {}),
        },
      ].slice(-64);
    } else if (event === 'tool.finished' && typeof payload.toolCallId === 'string') {
      route.checkpoint.tools = route.checkpoint.tools.filter((tool) => tool.toolCallId !== payload.toolCallId);
      const durableId = readDurableEntryId(payload, 'tool');
      if (durableId) route.checkpoint.durableWatermark = durableId;
    } else if (event === 'contextUsage.changed') {
      const usage = payload.contextUsage;
      if (usage && typeof usage === 'object' && !Array.isArray(usage)
        && typeof usage.tokens === 'number' && typeof usage.contextWindow === 'number'
        && typeof usage.percent === 'number' && Number.isFinite(usage.tokens)
        && Number.isFinite(usage.contextWindow) && Number.isFinite(usage.percent)) {
        route.checkpoint.usage = {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
        };
      } else {
        route.checkpoint.usage = undefined;
      }
    }
  }

  private reconcileInterruptedCheckpoint(route: HotWorkerRoute, _snapshot: WorkerClientSnapshot): void {
    const reason = 'The session worker exited before live work settled.';
    for (const tool of route.checkpoint.tools) {
      this.options.emit('tool.finished', {
        ...tool,
        sessionPath: route.currentLeasePath,
        result: { error: reason },
        status: 'failed',
      });
    }
    // Event checkpoint terminal observations clear request ownership. A
    // heartbeat may predate message.finished, so never resurrect its older
    // activeRequestId during crash reconciliation.
    const requestId = route.checkpoint.requestId;
    if (requestId) {
      if (route.checkpoint.preflightOnly) {
        this.options.emit('preflight.failed', {
          requestId,
          sessionPath: route.currentLeasePath,
          error: reason,
        });
      } else {
        this.options.emit('message.aborted', {
          requestId,
          sessionPath: route.currentLeasePath,
          ...(route.checkpoint.messageId ? { messageId: route.checkpoint.messageId } : {}),
          reason,
        });
      }
    }
    this.options.emit('busy.changed', {
      sessionPath: route.currentLeasePath,
      busy: false,
      seq: route.checkpoint.busySeq + 1,
    });
  }

  /** Bounded last-known checkpoint projection for diagnostics. Usage is a
   * fixed-shape triple, the durable watermark one bounded identity, and the
   * detail manifest is sliced so a hostile subscription set cannot grow the
   * payload. */
  private checkpointManifest(route: HotWorkerRoute): WorkerRuntimeCheckpointManifest {
    return {
      busySeq: route.checkpoint.busySeq,
      ...(route.checkpoint.requestId ? { requestId: route.checkpoint.requestId } : {}),
      tools: route.checkpoint.tools.map((tool) => ({
        requestId: tool.requestId,
        messageId: tool.messageId,
        toolCallId: tool.toolCallId,
        ...(tool.name === undefined ? {} : { name: tool.name }),
        ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
      })).slice(-64),
      ...(route.checkpoint.usage ? { usage: { ...route.checkpoint.usage } } : {}),
      ...(route.checkpoint.durableWatermark ? { durableWatermark: route.checkpoint.durableWatermark } : {}),
      ...(this.detailSubscriptions.size > 0 ? {
        detailManifest: [...this.detailSubscriptions.entries()]
          .filter(([, owner]) => owner.route === route)
          .map(([subscriptionId, owner]) => ({ subscriptionId, state: owner.state, revision: owner.revision, pageCount: owner.pageCount }))
          .slice(-32),
      } : {}),
    };
  }

  private recordExtensionUiOwner(route: HotWorkerRoute, payload: WorkerJsonObject): boolean {
    const request = payload as {
      id?: unknown;
      method?: unknown;
      sessionPath?: unknown;
      subagentCallId?: unknown;
      toolCallId?: unknown;
      timeout?: unknown;
    };
    if (typeof request.id !== 'string' || request.id.length === 0
      || (request.method !== 'confirm' && request.method !== 'select' && request.method !== 'input')) {
      // `notify` and malformed requests are fire-and-forget/never forwarded.
      return request.method !== 'notify';
    }
    try {
      this.extensionUiOwners.record({
        sessionPath: route.currentLeasePath,
        workerId: route.owner.workerId,
        workerGeneration: route.owner.workerGeneration,
        uiRequestId: request.id,
        ...(typeof request.subagentCallId === 'string' ? { subagentCallId: request.subagentCallId } : {}),
        ...(typeof request.toolCallId === 'string' ? { toolCallId: request.toolCallId } : {}),
      });
      this.extensionUiOwners.attachMetadata(request.id, {
        method: request.method as 'confirm' | 'select' | 'input',
        ...(typeof request.timeout === 'number' && Number.isSafeInteger(request.timeout) && request.timeout > 0
          ? { timeoutMs: request.timeout }
          : {}),
      });
      return true;
    } catch (error) {
      // Fail closed: never forward a request the coordinator cannot settle
      // exactly once. The worker's dialog timeout still releases its own
      // pending promise, so no extension callback is leaked.
      this.options.emit('operational-error', {
        incidentId: `extension-ui-owner:${route.owner.workerId}:${request.id}`,
        code: 'EXTENSION_UI_OWNER_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
        sessionPath: route.currentLeasePath,
      });
      return false;
    }
  }

  private handleRuntimeReport(route: HotWorkerRoute, frame: Extract<WorkerToCoordinatorFrame, { kind: 'runtime.report' }>): void {
    if (frame.domain !== 'catalog' || !Array.isArray(frame.payload.models)) return;
    // Bounded: one latest report per live worker; cap the total map and evict
    // the oldest report when it overflows. The configured catalog authority
    // (loadConfiguredModels) is never replaced by these reports.
    this.reportedRuntimeCatalogs.set(route.owner.workerId, {
      reportedAt: Date.now(),
      models: frame.payload.models as unknown[],
    });
    if (this.reportedRuntimeCatalogs.size > 64) {
      const oldest = [...this.reportedRuntimeCatalogs.entries()]
        .sort((left, right) => left[1].reportedAt - right[1].reportedAt)[0];
      if (oldest) this.reportedRuntimeCatalogs.delete(oldest[0]);
    }
  }

  /** Bounded per-worker runtime discovery report snapshot for diagnostics/tests. */
  inspectRuntimeReports(): Array<{ workerId: string; reportedAt: number; models: unknown[] }> {
    return [...this.reportedRuntimeCatalogs.entries()].map(([workerId, report]) => ({
      workerId,
      reportedAt: report.reportedAt,
      models: report.models,
    }));
  }

  /** Bounded pending extension-UI owner snapshot for diagnostics/tests. */
  inspectExtensionUiOwners(): ReturnType<ExtensionUiOwnerRegistry['inspect']> {
    return this.extensionUiOwners.inspect();
  }

  private sendOwnershipRejected(
    route: HotWorkerRoute,
    requestId: string,
    phase: 'reserve' | 'commit' | 'consume' | 'abort' | 'runtimeReady',
    error: unknown,
  ): void {
    const code = error instanceof SessionOwnershipConflictError
      ? 'OWNERSHIP_CONFLICT'
      : error instanceof StaleSessionWriteLeaseError
        ? 'STALE_OWNERSHIP'
        : 'OWNERSHIP_FAILED';
    route.worker.client.sendFrame?.({
      kind: 'ownership.rejected',
      requestId,
      phase,
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: code === 'OWNERSHIP_CONFLICT',
    });
  }

  private invalidateDetailSubscriptions(route: HotWorkerRoute, reason: 'generation-change' | 'evicted'): void {
    for (const [subscriptionId, owner] of [...this.detailSubscriptions]) {
      if (owner.route !== route) continue;
      this.forwardDetail(route, { kind: 'detail.rebase', subscriptionId, currentRevision: owner.revision,
        reason, fence: this.detailFence(route) });
      this.detailSubscriptions.delete(subscriptionId);
    }
  }

  private async failWorkerRoute(route: HotWorkerRoute, error: unknown): Promise<void> {
    this.options.emit('operational-error', {
      code: 'SESSION_RUNTIME_OWNERSHIP_FAILED',
      message: error instanceof Error ? error.message : String(error),
      sessionPath: route.currentLeasePath,
    });
    await this.retire(route.currentLeasePath, 'ownership failure');
  }

  private notify(state: WorkerRuntimeRouteState): void {
    try { this.options.onRouteChanged?.(state); } catch { /* observer only */ }
  }
}

function readSessionPath(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || typeof (params as { sessionPath?: unknown }).sessionPath !== 'string') {
    throw new Error('Worker runtime command requires an exact sessionPath.');
  }
  return (params as { sessionPath: string }).sessionPath;
}

function readExtensionUiResponseId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const response = (params as { response?: unknown }).response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const id = (response as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** Read the durability-confirmed entry identity from a terminal event payload
 * (`message.finished` nests it under `message`; `tool.finished` carries it
 * directly). Bounded to the identity budget of a message id. */
function readDurableEntryId(payload: WorkerJsonObject, kind: 'message' | 'tool'): string | undefined {
  const candidate = kind === 'message'
    ? (payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
        ? (payload.message as { durableEntryId?: unknown }).durableEntryId
        : undefined)
    : payload.durableEntryId;
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 512
    ? candidate
    : undefined;
}

function routeKey(sessionPath: string): string {
  const absolute = path.resolve(sessionPath);
  let canonical = absolute;
  try { canonical = fs.realpathSync.native(absolute); } catch { /* replacement destination may not exist yet */ }
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function cloneDetailAddress(address: LiveSubagentDetailAddress): LiveSubagentDetailAddress {
  return { ...address, lineage: address.lineage.map((identity) => ({ ...identity })) };
}

function sameDetailAddress(left: LiveSubagentDetailAddress, right: LiveSubagentDetailAddress): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asWorkerJsonObject(value: unknown): WorkerJsonObject {
  const normalized = JSON.parse(JSON.stringify(value)) as WorkerJsonValue;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new Error('Worker command payload must be a JSON object.');
  return normalized as WorkerJsonObject;
}

export function assertPromotionGrantConsumedOnce(
  store: ColdSessionStore,
  grant: SerializedColdSessionPromotionGrant,
): void {
  store.consumePromotionGrant(grant);
}
