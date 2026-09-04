import { randomUUID } from 'node:crypto';

import type { ProviderGateMetrics } from './provider-gate';
import type { SdkWorkerOwnershipIdentity } from './sdk';
import type { WorkerProviderReleaseOutcome } from './worker-protocol';

interface PendingLease {
  requestId: string;
  owner: SdkWorkerOwnershipIdentity;
  provider: string;
  model: string;
  resolve: (lease: CoordinatorProviderNetworkLease) => void;
  reject: (error: Error) => void;
  queueWaitMs: number;
  deadlineAt: number;
  timer: unknown | undefined;
}

export interface CoordinatorProviderNetworkLease {
  leaseId: string;
  provider: string;
  model: string;
  grantedAt: number;
  /** Worker-local bound for waiting on upstream response headers. */
  headerWaitMs: number;
  /** Worker-local bound between successive response-body chunks. */
  streamIdleTimeoutMs: number;
}

interface ActiveLease extends CoordinatorProviderNetworkLease {
  requestId: string;
  owner: SdkWorkerOwnershipIdentity;
  released: boolean;
  delivered: boolean;
  halfOpenProbe: boolean;
  observation?: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean };
}

interface AfterburnHold {
  holdId: string;
  owner: SdkWorkerOwnershipIdentity;
  expiresAt: number;
  timer: unknown | undefined;
}

export interface CoordinatorProviderCancellation {
  status: 'queued' | 'granted' | 'not-found';
  leaseId?: string;
  /** The acquire waiter still needs a correlated provider.cancelled frame. */
  notifyAcquire: boolean;
}

export interface CoordinatorProviderPolicy {
  maxConcurrentRequests: number;
  /** Per-owner sticky capacity retained after a healthy settlement. */
  afterburnMs: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
  /** Maximum time an admission may remain queued. Always finite. */
  queueWaitMs: number;
  /** Maximum time the granted worker may wait for response headers. */
  headerWaitMs: number;
  /** Maximum time the granted worker may wait between body chunks. */
  streamIdleTimeoutMs: number;
}

export interface CoordinatorProviderLeaseOptions {
  now?: () => number;
  defaultPolicy?: Partial<CoordinatorProviderPolicy>;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

interface ProviderPool {
  policy: CoordinatorProviderPolicy;
  queue: PendingLease[];
  active: Map<string, ActiveLease>;
  holds: Map<string, AfterburnHold>;
  consecutiveFailures: number;
  circuit: 'closed' | 'open' | 'half-open';
  openUntil: number;
  halfOpenLeaseId?: string;
}

const DEFAULT_POLICY: CoordinatorProviderPolicy = {
  maxConcurrentRequests: 1,
  afterburnMs: 0,
  circuitFailureThreshold: 3,
  circuitResetMs: 30_000,
  queueWaitMs: 30_000,
  headerWaitMs: 120_000,
  streamIdleTimeoutMs: 120_000,
};

/** No individual provider-network phase may monopolize a worker for longer
 * than five minutes. Together, queue + headers + first body chunk remain below
 * the 20-minute semantic hard ceiling used by both host and backend. */
export const PROVIDER_NETWORK_PHASE_MAX_WAIT_MS = 5 * 60 * 1000;

function sameOwner(left: SdkWorkerOwnershipIdentity, right: SdkWorkerOwnershipIdentity): boolean {
  return left.coordinatorGeneration === right.coordinatorGeneration
    && left.workerId === right.workerId
    && left.workerGeneration === right.workerGeneration;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function circuitError(provider: string, retryAt: number): Error {
  const error = new Error(
    `Provider circuit is open for ${provider} until ${new Date(retryAt).toISOString()}.`,
  ) as Error & { isRetryable: boolean; httpStatus: number };
  error.name = 'ProviderCircuitOpenError';
  error.isRetryable = true;
  error.httpStatus = 503;
  return error;
}

function queueWaitError(provider: string, queueWaitMs: number): Error {
  const error = new Error(
    `Provider "${provider}" concurrency cap reached: waited ${queueWaitMs}ms without a slot. Retry after a brief delay.`,
  ) as Error & { isRetryable: boolean; httpStatus: number };
  error.name = 'ProviderGateSaturatedError';
  error.isRetryable = true;
  error.httpStatus = 429;
  return error;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedPositiveMilliseconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(PROVIDER_NETWORK_PHASE_MAX_WAIT_MS, Math.ceil(value)));
}

function boundedQueueMilliseconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  // The former zero/unbounded setting is migrated to the longest permitted
  // finite wait. A saturated provider can no longer pin a worker forever.
  if (value === 0) return PROVIDER_NETWORK_PHASE_MAX_WAIT_MS;
  return Math.max(1, Math.min(PROVIDER_NETWORK_PHASE_MAX_WAIT_MS, Math.ceil(value)));
}

function boundedAfterburnMilliseconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  if (value === 0) return 0;
  return Math.max(1, Math.min(PROVIDER_NETWORK_PHASE_MAX_WAIT_MS, Math.ceil(value)));
}

function afterburnPolicyMilliseconds(record: Record<string, unknown>, fallback: number): number {
  const milliseconds = record.afterburnMs;
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0) {
    return boundedAfterburnMilliseconds(milliseconds, fallback);
  }
  const seconds = record.afterburnSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? boundedAfterburnMilliseconds(seconds * 1000, fallback)
    : fallback;
}

function policyMilliseconds(
  record: Record<string, unknown>,
  millisecondsKey: string,
  secondsKey: string,
  fallback: number,
): number {
  const milliseconds = record[millisecondsKey];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0) {
    return boundedQueueMilliseconds(milliseconds, fallback);
  }
  const seconds = record[secondsKey];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? boundedQueueMilliseconds(seconds * 1000, fallback)
    : fallback;
}

function positivePolicyMilliseconds(
  record: Record<string, unknown>,
  millisecondsKey: string,
  secondsKey: string,
  fallback: number,
): number {
  const milliseconds = record[millisecondsKey];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0) {
    return boundedPositiveMilliseconds(milliseconds, fallback);
  }
  const seconds = record[secondsKey];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? boundedPositiveMilliseconds(seconds * 1000, fallback)
    : fallback;
}

/**
 * Coordinator-owned provider authority. Capacity, circuits, and the
 * half-open probe are global across worker processes while provider I/O remains
 * in the owning worker. Pools are independent by configured provider key.
 */
export class CoordinatorProviderNetworkLeaseAuthority {
  private readonly pools = new Map<string, ProviderPool>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly defaultPolicy: CoordinatorProviderPolicy;
  private readonly configuredPolicies = new Map<string, CoordinatorProviderPolicy>();

  constructor(options: CoordinatorProviderLeaseOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.defaultPolicy = {
      maxConcurrentRequests: positiveInteger(options.defaultPolicy?.maxConcurrentRequests, DEFAULT_POLICY.maxConcurrentRequests),
      afterburnMs: boundedAfterburnMilliseconds(options.defaultPolicy?.afterburnMs, DEFAULT_POLICY.afterburnMs),
      circuitFailureThreshold: positiveInteger(options.defaultPolicy?.circuitFailureThreshold, DEFAULT_POLICY.circuitFailureThreshold),
      circuitResetMs: nonNegativeNumber(options.defaultPolicy?.circuitResetMs, DEFAULT_POLICY.circuitResetMs),
      queueWaitMs: boundedQueueMilliseconds(options.defaultPolicy?.queueWaitMs, DEFAULT_POLICY.queueWaitMs),
      headerWaitMs: boundedPositiveMilliseconds(options.defaultPolicy?.headerWaitMs, DEFAULT_POLICY.headerWaitMs),
      streamIdleTimeoutMs: boundedPositiveMilliseconds(
        options.defaultPolicy?.streamIdleTimeoutMs,
        DEFAULT_POLICY.streamIdleTimeoutMs,
      ),
    };
  }

  /** Apply coordinator-authoritative policy in place without dropping queued or
   * active leases. Capacity increases grant immediately; decreases apply as
   * existing bodies settle. Unknown fields are ignored at this closed seam. */
  updatePolicies(policies: Record<string, unknown>): void {
    const seen = new Set<string>();
    for (const [provider, raw] of Object.entries(policies)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const previous = this.configuredPolicies.get(provider) ?? this.defaultPolicy;
      const policy: CoordinatorProviderPolicy = {
        maxConcurrentRequests: positiveInteger(record.maxConcurrentRequests, previous.maxConcurrentRequests),
        afterburnMs: afterburnPolicyMilliseconds(record, previous.afterburnMs),
        circuitFailureThreshold: positiveInteger(record.circuitFailureThreshold, previous.circuitFailureThreshold),
        circuitResetMs: nonNegativeNumber(
          record.circuitResetMs,
          typeof record.circuitResetSeconds === 'number' ? record.circuitResetSeconds * 1000 : previous.circuitResetMs,
        ),
        queueWaitMs: policyMilliseconds(record, 'queueWaitMs', 'queueWaitSeconds', previous.queueWaitMs),
        headerWaitMs: positivePolicyMilliseconds(record, 'headerWaitMs', 'headerWaitSeconds', previous.headerWaitMs),
        streamIdleTimeoutMs: positivePolicyMilliseconds(
          record,
          'streamIdleTimeoutMs',
          'streamIdleTimeoutSeconds',
          previous.streamIdleTimeoutMs,
        ),
      };
      this.configuredPolicies.set(provider, policy);
      seen.add(provider);
      const pool = this.pools.get(provider);
      if (pool) {
        const previousPolicy = pool.policy;
        pool.policy = policy;
        this.reconcileAfterburnHolds(provider, pool, previousPolicy);
        this.grantNext(provider, pool);
      }
    }
    for (const provider of [...this.configuredPolicies.keys()]) {
      if (seen.has(provider)) continue;
      this.configuredPolicies.delete(provider);
      const pool = this.pools.get(provider);
      if (pool) {
        const previousPolicy = pool.policy;
        pool.policy = { ...this.defaultPolicy };
        this.reconcileAfterburnHolds(provider, pool, previousPolicy);
        this.grantNext(provider, pool);
      }
    }
  }

  acquire(
    owner: SdkWorkerOwnershipIdentity,
    requestId: string,
    request: { provider: string; model: string },
  ): Promise<CoordinatorProviderNetworkLease> {
    const provider = request.provider.trim() || 'unknown-provider';
    if (this.findRequest(owner, requestId)) {
      return Promise.reject(new Error(`Provider admission ${requestId} is already registered.`));
    }
    const pool = this.pool(provider);
    this.refreshCircuit(provider, pool);
    if (pool.circuit === 'open') return Promise.reject(circuitError(provider, pool.openUntil));
    return new Promise((resolve, reject) => {
      const queueWaitMs = pool.policy.queueWaitMs;
      const pending: PendingLease = {
        requestId,
        owner: { ...owner },
        provider,
        model: request.model,
        resolve,
        reject,
        queueWaitMs,
        deadlineAt: queueWaitMs > 0 ? this.now() + queueWaitMs : 0,
        timer: undefined,
      };
      pool.queue.push(pending);
      this.armQueueDeadline(provider, pool, pending);
      this.grantNext(provider, pool);
    });
  }

  markDelivered(owner: SdkWorkerOwnershipIdentity, requestId: string, leaseId: string): boolean {
    const active = this.findActive(owner, leaseId);
    if (!active || active.requestId !== requestId) return false;
    active.delivered = true;
    return true;
  }

  isActive(owner: SdkWorkerOwnershipIdentity, requestId: string, leaseId: string): boolean {
    const active = this.findActive(owner, leaseId);
    return !!active && active.requestId === requestId;
  }

  cancel(owner: SdkWorkerOwnershipIdentity, requestId: string, reason = 'Provider admission cancelled.'): CoordinatorProviderCancellation {
    for (const [provider, pool] of this.pools) {
      const queuedIndex = pool.queue.findIndex((pending) => pending.requestId === requestId && sameOwner(pending.owner, owner));
      if (queuedIndex >= 0) {
        const [pending] = pool.queue.splice(queuedIndex, 1);
        this.clearQueueDeadline(pending!);
        pending!.reject(abortError(reason));
        return { status: 'queued', notifyAcquire: true };
      }
      const active = [...pool.active.values()].find((lease) => lease.requestId === requestId && sameOwner(lease.owner, owner));
      if (!active) continue;
      this.removeActive(provider, pool, active, 'cancelled');
      return { status: 'granted', leaseId: active.leaseId, notifyAcquire: !active.delivered };
    }
    return { status: 'not-found', notifyAcquire: false };
  }

  observe(
    owner: SdkWorkerOwnershipIdentity,
    leaseId: string,
    observation: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean },
  ): boolean {
    const active = this.findActive(owner, leaseId);
    if (!active) return false;
    active.observation = { ...observation };
    return true;
  }

  release(owner: SdkWorkerOwnershipIdentity, leaseId: string, outcome: WorkerProviderReleaseOutcome): boolean {
    for (const [provider, pool] of this.pools) {
      const active = pool.active.get(leaseId);
      if (!active || active.released || !sameOwner(active.owner, owner)) continue;
      this.removeActive(provider, pool, active, outcome);
      return true;
    }
    return false;
  }

  /** Worker exit/cancellation revokes queued work and releases every active
   * generation-owned body exactly once. Cancellation never trips a circuit. */
  releaseOwner(owner: SdkWorkerOwnershipIdentity, reason = 'Worker exited before provider network settlement.'): void {
    for (const [provider, pool] of this.pools) {
      for (let index = pool.queue.length - 1; index >= 0; index -= 1) {
        const pending = pool.queue[index]!;
        if (!sameOwner(pending.owner, owner)) continue;
        pool.queue.splice(index, 1);
        this.clearQueueDeadline(pending);
        pending.reject(abortError(reason));
      }
      for (const active of [...pool.active.values()]) {
        if (sameOwner(active.owner, owner)) this.removeActive(provider, pool, active, 'cancelled', false);
      }
      for (const hold of [...pool.holds.values()]) {
        if (sameOwner(hold.owner, owner)) this.removeAfterburnHold(pool, hold);
      }
      this.grantNext(provider, pool);
    }
  }

  inspect(): {
    activeLeaseId?: string;
    activeRequestId?: string;
    queued: number;
    providers?: Record<string, { active: number; queued: number; circuit: 'closed' | 'open' | 'half-open'; consecutiveFailures: number }>;
  } {
    const providers: Record<string, { active: number; queued: number; circuit: 'closed' | 'open' | 'half-open'; consecutiveFailures: number }> = {};
    let queued = 0;
    let first: ActiveLease | undefined;
    for (const [provider, pool] of this.pools) {
      this.refreshCircuit(provider, pool);
      queued += pool.queue.length;
      first ??= pool.active.values().next().value as ActiveLease | undefined;
      if (pool.active.size > 0 || pool.holds.size > 0 || pool.queue.length > 0
        || pool.circuit !== 'closed' || pool.consecutiveFailures > 0) {
        providers[provider] = {
          active: pool.active.size,
          queued: pool.queue.length,
          circuit: pool.circuit,
          consecutiveFailures: pool.consecutiveFailures,
        };
      }
    }
    return {
      ...(first ? { activeLeaseId: first.leaseId, activeRequestId: first.requestId } : {}),
      queued,
      ...(Object.keys(providers).length > 0 ? { providers } : {}),
    };
  }

  /** ProviderGate-compatible live coordinator metrics. Unlike inspect(), this
   * includes idle configured providers so callers can use it as policy state. */
  getMetrics(): ProviderGateMetrics[] {
    const providers = new Set([...this.configuredPolicies.keys(), ...this.pools.keys()]);
    const result: ProviderGateMetrics[] = [];
    for (const provider of providers) {
      const pool = this.pools.get(provider);
      if (pool) this.refreshCircuit(provider, pool);
      const policy = pool?.policy ?? this.configuredPolicies.get(provider) ?? this.defaultPolicy;
      const circuitOpen = pool?.circuit === 'open';
      result.push({
        provider,
        activeRequests: pool?.active.size ?? 0,
        queuedRequests: pool?.queue.length ?? 0,
        maxConcurrentRequests: policy.maxConcurrentRequests,
        afterburnSeconds: policy.afterburnMs / 1000,
        queueWaitSeconds: policy.queueWaitMs / 1000,
        paused: circuitOpen,
        pausedUntilMs: circuitOpen ? (pool?.openUntil ?? 0) : 0,
        strikeCount: pool?.consecutiveFailures ?? 0,
      });
    }
    return result.sort((left, right) => left.provider.localeCompare(right.provider));
  }

  private pool(provider: string): ProviderPool {
    let pool = this.pools.get(provider);
    if (!pool) {
      pool = {
        policy: this.configuredPolicies.get(provider) ?? { ...this.defaultPolicy },
        queue: [], active: new Map(), holds: new Map(), consecutiveFailures: 0,
        circuit: 'closed', openUntil: 0,
      };
      this.pools.set(provider, pool);
    }
    return pool;
  }

  private findRequest(owner: SdkWorkerOwnershipIdentity, requestId: string): boolean {
    for (const pool of this.pools.values()) {
      if (pool.queue.some((pending) => pending.requestId === requestId && sameOwner(pending.owner, owner))) return true;
      if ([...pool.active.values()].some((active) => active.requestId === requestId && sameOwner(active.owner, owner))) return true;
    }
    return false;
  }

  private findActive(owner: SdkWorkerOwnershipIdentity, leaseId: string): ActiveLease | undefined {
    for (const pool of this.pools.values()) {
      const active = pool.active.get(leaseId);
      if (active && !active.released && sameOwner(active.owner, owner)) return active;
    }
    return undefined;
  }

  private refreshCircuit(provider: string, pool: ProviderPool): void {
    if (pool.circuit === 'open' && this.now() >= pool.openUntil) {
      pool.circuit = 'half-open';
      pool.halfOpenLeaseId = undefined;
      this.grantNext(provider, pool);
    }
  }

  private grantNext(provider: string, pool: ProviderPool): void {
    this.refreshCircuit(provider, pool);
    if (pool.circuit === 'open') return;
    while (pool.queue.length > 0) {
      const halfOpen = pool.circuit === 'half-open';
      if (halfOpen && pool.halfOpenLeaseId) return;
      let next: PendingLease;
      if (!halfOpen) {
        const stickyIndex = pool.queue.findIndex((pending) => this.findAfterburnHold(pool, pending.owner) !== undefined);
        if (stickyIndex >= 0) {
          next = pool.queue.splice(stickyIndex, 1)[0]!;
          const hold = this.findAfterburnHold(pool, next.owner)!;
          this.removeAfterburnHold(pool, hold);
        } else {
          if (pool.active.size + pool.holds.size >= pool.policy.maxConcurrentRequests) return;
          next = pool.queue.shift()!;
        }
      } else {
        next = pool.queue.shift()!;
      }
      this.clearQueueDeadline(next);
      const active: ActiveLease = {
        requestId: next.requestId,
        leaseId: randomUUID(), provider, model: next.model, grantedAt: this.now(),
        headerWaitMs: pool.policy.headerWaitMs,
        streamIdleTimeoutMs: pool.policy.streamIdleTimeoutMs,
        owner: next.owner, released: false, delivered: false, halfOpenProbe: halfOpen,
      };
      pool.active.set(active.leaseId, active);
      if (halfOpen) pool.halfOpenLeaseId = active.leaseId;
      next.resolve({
        leaseId: active.leaseId,
        provider,
        model: active.model,
        grantedAt: active.grantedAt,
        headerWaitMs: active.headerWaitMs,
        streamIdleTimeoutMs: active.streamIdleTimeoutMs,
      });
      if (halfOpen) return;
    }
  }

  private armQueueDeadline(provider: string, pool: ProviderPool, pending: PendingLease): void {
    if (pending.deadlineAt <= 0) return;
    const onDeadline = (): void => {
      const remaining = pending.deadlineAt - this.now();
      if (remaining > 0) {
        pending.timer = this.setTimer(onDeadline, remaining);
        return;
      }
      pending.timer = undefined;
      const index = pool.queue.indexOf(pending);
      if (index < 0) return;
      pool.queue.splice(index, 1);
      pending.reject(queueWaitError(provider, pending.queueWaitMs));
      this.grantNext(provider, pool);
    };
    pending.timer = this.setTimer(onDeadline, pending.deadlineAt - this.now());
  }

  private clearQueueDeadline(pending: PendingLease): void {
    if (pending.timer === undefined) return;
    this.clearTimer(pending.timer);
    pending.timer = undefined;
  }

  private findAfterburnHold(pool: ProviderPool, owner: SdkWorkerOwnershipIdentity): AfterburnHold | undefined {
    return [...pool.holds.values()].find((hold) => sameOwner(hold.owner, owner));
  }

  private createAfterburnHold(provider: string, pool: ProviderPool, owner: SdkWorkerOwnershipIdentity): void {
    if (pool.policy.afterburnMs <= 0 || pool.circuit !== 'closed'
      || pool.active.size + pool.holds.size >= pool.policy.maxConcurrentRequests) return;
    const hold: AfterburnHold = {
      holdId: randomUUID(),
      owner: { ...owner },
      expiresAt: this.now() + pool.policy.afterburnMs,
      timer: undefined,
    };
    pool.holds.set(hold.holdId, hold);
    this.armAfterburnHold(provider, pool, hold);
  }

  private armAfterburnHold(provider: string, pool: ProviderPool, hold: AfterburnHold): void {
    if (hold.timer !== undefined) this.clearTimer(hold.timer);
    const onDeadline = (): void => {
      const remaining = hold.expiresAt - this.now();
      if (remaining > 0) {
        hold.timer = this.setTimer(onDeadline, remaining);
        return;
      }
      hold.timer = undefined;
      if (!pool.holds.delete(hold.holdId)) return;
      this.grantNext(provider, pool);
    };
    hold.timer = this.setTimer(onDeadline, Math.max(0, hold.expiresAt - this.now()));
  }

  private removeAfterburnHold(pool: ProviderPool, hold: AfterburnHold): void {
    if (!pool.holds.delete(hold.holdId)) return;
    if (hold.timer !== undefined) this.clearTimer(hold.timer);
    hold.timer = undefined;
  }

  private clearAfterburnHolds(pool: ProviderPool): void {
    for (const hold of [...pool.holds.values()]) this.removeAfterburnHold(pool, hold);
  }

  private reconcileAfterburnHolds(
    provider: string,
    pool: ProviderPool,
    previousPolicy: CoordinatorProviderPolicy,
  ): void {
    if (pool.policy.afterburnMs === 0) {
      this.clearAfterburnHolds(pool);
    } else if (pool.policy.afterburnMs < previousPolicy.afterburnMs) {
      const latestExpiry = this.now() + pool.policy.afterburnMs;
      for (const hold of pool.holds.values()) {
        if (hold.expiresAt <= latestExpiry) continue;
        hold.expiresAt = latestExpiry;
        this.armAfterburnHold(provider, pool, hold);
      }
    }
    while (pool.active.size + pool.holds.size > pool.policy.maxConcurrentRequests && pool.holds.size > 0) {
      const hold = [...pool.holds.values()].at(-1)!;
      this.removeAfterburnHold(pool, hold);
    }
  }

  private removeActive(
    provider: string,
    pool: ProviderPool,
    active: ActiveLease,
    outcome: WorkerProviderReleaseOutcome,
    grant = true,
  ): void {
    if (active.released) return;
    active.released = true;
    pool.active.delete(active.leaseId);
    if (pool.halfOpenLeaseId === active.leaseId) pool.halfOpenLeaseId = undefined;

    const circuitFailure = outcome === 'failed' && active.observation?.retryable !== false;
    const circuitSuccess = outcome === 'completed'
      || (outcome === 'failed' && active.observation?.retryable === false);
    if (circuitFailure) {
      pool.consecutiveFailures += 1;
      if (active.halfOpenProbe || pool.consecutiveFailures >= pool.policy.circuitFailureThreshold) {
        pool.circuit = 'open';
        pool.openUntil = this.now() + pool.policy.circuitResetMs;
        this.clearAfterburnHolds(pool);
        for (const pending of pool.queue.splice(0)) {
          this.clearQueueDeadline(pending);
          pending.reject(circuitError(provider, pool.openUntil));
        }
      }
    } else if (circuitSuccess && (active.halfOpenProbe || pool.circuit === 'closed')) {
      // Success from an ordinary request that was already in flight when a
      // sibling opened the circuit must not close it. A non-retryable HTTP
      // response (for example 4xx auth/input failure) proves provider transport
      // health and therefore has the same circuit effect as a completed call.
      pool.consecutiveFailures = 0;
      pool.circuit = 'closed';
      pool.openUntil = 0;
    } // cancellation does not affect circuit state

    // A non-retryable HTTP failure proves transport health and may reset the
    // circuit, but it did not complete useful work and must not reserve sticky
    // capacity ahead of unrelated queued requests.
    if (outcome === 'completed' && pool.circuit === 'closed') {
      this.createAfterburnHold(provider, pool, active.owner);
    }

    if (grant) this.grantNext(provider, pool);
  }
}
