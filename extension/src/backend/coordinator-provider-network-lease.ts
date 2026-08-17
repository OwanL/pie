import { randomUUID } from 'node:crypto';

import type { SdkWorkerOwnershipIdentity } from './sdk';
import type { WorkerProviderReleaseOutcome } from './worker-protocol';

interface PendingLease {
  requestId: string;
  owner: SdkWorkerOwnershipIdentity;
  provider: string;
  model: string;
  resolve: (lease: CoordinatorProviderNetworkLease) => void;
  reject: (error: Error) => void;
}

export interface CoordinatorProviderNetworkLease {
  leaseId: string;
  provider: string;
  model: string;
  grantedAt: number;
}

interface ActiveLease extends CoordinatorProviderNetworkLease {
  requestId: string;
  owner: SdkWorkerOwnershipIdentity;
  released: boolean;
  delivered: boolean;
  halfOpenProbe: boolean;
  observation?: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean };
}

export interface CoordinatorProviderCancellation {
  status: 'queued' | 'granted' | 'not-found';
  leaseId?: string;
  /** The acquire waiter still needs a correlated provider.cancelled frame. */
  notifyAcquire: boolean;
}

export interface CoordinatorProviderPolicy {
  maxConcurrentRequests: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export interface CoordinatorProviderLeaseOptions {
  now?: () => number;
  defaultPolicy?: Partial<CoordinatorProviderPolicy>;
}

interface ProviderPool {
  policy: CoordinatorProviderPolicy;
  queue: PendingLease[];
  active: Map<string, ActiveLease>;
  consecutiveFailures: number;
  circuit: 'closed' | 'open' | 'half-open';
  openUntil: number;
  halfOpenLeaseId?: string;
}

const DEFAULT_POLICY: CoordinatorProviderPolicy = {
  maxConcurrentRequests: 1,
  circuitFailureThreshold: 3,
  circuitResetMs: 30_000,
};

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
  const error = new Error(`Provider circuit is open for ${provider} until ${new Date(retryAt).toISOString()}.`);
  error.name = 'ProviderCircuitOpenError';
  return error;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Coordinator-owned Phase 6 provider authority. Capacity, circuits, and the
 * half-open probe are global across worker processes while provider I/O remains
 * in the owning worker. Pools are independent by configured provider key.
 */
export class CoordinatorProviderNetworkLeaseAuthority {
  private readonly pools = new Map<string, ProviderPool>();
  private readonly now: () => number;
  private readonly defaultPolicy: CoordinatorProviderPolicy;
  private readonly configuredPolicies = new Map<string, CoordinatorProviderPolicy>();

  constructor(options: CoordinatorProviderLeaseOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultPolicy = {
      maxConcurrentRequests: positiveInteger(options.defaultPolicy?.maxConcurrentRequests, DEFAULT_POLICY.maxConcurrentRequests),
      circuitFailureThreshold: positiveInteger(options.defaultPolicy?.circuitFailureThreshold, DEFAULT_POLICY.circuitFailureThreshold),
      circuitResetMs: nonNegativeNumber(options.defaultPolicy?.circuitResetMs, DEFAULT_POLICY.circuitResetMs),
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
        circuitFailureThreshold: positiveInteger(record.circuitFailureThreshold, previous.circuitFailureThreshold),
        circuitResetMs: nonNegativeNumber(
          record.circuitResetMs,
          typeof record.circuitResetSeconds === 'number' ? record.circuitResetSeconds * 1000 : previous.circuitResetMs,
        ),
      };
      this.configuredPolicies.set(provider, policy);
      seen.add(provider);
      const pool = this.pools.get(provider);
      if (pool) {
        pool.policy = policy;
        this.grantNext(provider, pool);
      }
    }
    for (const provider of [...this.configuredPolicies.keys()]) {
      if (seen.has(provider)) continue;
      this.configuredPolicies.delete(provider);
      const pool = this.pools.get(provider);
      if (pool) {
        pool.policy = { ...this.defaultPolicy };
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
      pool.queue.push({ requestId, owner: { ...owner }, provider, model: request.model, resolve, reject });
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
        pending.reject(abortError(reason));
      }
      for (const active of [...pool.active.values()]) {
        if (sameOwner(active.owner, owner)) this.removeActive(provider, pool, active, 'cancelled', false);
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
      if (pool.active.size > 0 || pool.queue.length > 0 || pool.circuit !== 'closed' || pool.consecutiveFailures > 0) {
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

  private pool(provider: string): ProviderPool {
    let pool = this.pools.get(provider);
    if (!pool) {
      pool = {
        policy: this.configuredPolicies.get(provider) ?? { ...this.defaultPolicy },
        queue: [], active: new Map(), consecutiveFailures: 0,
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
      if (!halfOpen && pool.active.size >= pool.policy.maxConcurrentRequests) return;
      const next = pool.queue.shift()!;
      const active: ActiveLease = {
        requestId: next.requestId,
        leaseId: randomUUID(), provider, model: next.model, grantedAt: this.now(),
        owner: next.owner, released: false, delivered: false, halfOpenProbe: halfOpen,
      };
      pool.active.set(active.leaseId, active);
      if (halfOpen) pool.halfOpenLeaseId = active.leaseId;
      next.resolve({ leaseId: active.leaseId, provider, model: active.model, grantedAt: active.grantedAt });
      if (halfOpen) return;
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
        for (const pending of pool.queue.splice(0)) pending.reject(circuitError(provider, pool.openUntil));
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

    if (grant) this.grantNext(provider, pool);
  }
}
