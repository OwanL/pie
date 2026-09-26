/**
 * Analytics writer-fence/admission API surface over the shared session
 * lifecycle store.
 *
 * One SQLite store (the lifecycle owner's `session-lifecycle-store` module)
 * holds both session close/retention/artifact tables and the analytics
 * host-registry/writer-fence/lease/admission tables. This module owns the
 * analytics side of that seam as a narrow adapter implemented over the same
 * store module in the coordinator process: storage owns the database, schema
 * and session-lifecycle APIs, analytics authority owns this admission API
 * surface, and the coordinator keeps the single writer-admission authority
 * through `createSessionLifecycleWriterAdmission`.
 */

import type { Int64Value } from '../contracts/contracts.js';
import type { SessionOwnershipAdmission } from '../../harness/session-storage/ownership/session-ownership-authority.js';
import type { SessionManagerFenceAdmission } from '../../harness/session-storage/ownership/session-manager-fence.js';
import {
  requireWriterIdentity,
  type SessionLifecycleStore,
} from '../../harness/session-storage/lifecycle/session-lifecycle-store.js';

/** Durable identity of an extension host that can participate in a future
 * all-host handoff. Registration is deliberately separate from completeness:
 * a caller must reconcile this set with runtime-generation leases and process
 * evidence before it may claim that every writer was quiesced. */
export type AnalyticsHostState = 'registered' | 'stopping' | 'stopped' | 'unsupported';

export interface AnalyticsHostRecord {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
  endpointName?: string;
  capabilities: string[];
  state: AnalyticsHostState;
  registeredAtMs: string;
  heartbeatAtMs: string;
  stoppedAtMs?: string;
  unsupportedReason?: string;
  updatedAtMs: string;
}

export interface AnalyticsHostPage {
  hosts: AnalyticsHostRecord[];
  truncated: boolean;
  nextCursor?: string;
}

export type AnalyticsWriterFencePurpose = 'analytics-activation' | 'storage-cutoff';
export type AnalyticsWriterFenceState = 'open' | 'fencing' | 'fenced';

/** Stable process/host identity used by the durable writer admission gate.
 * Per-boot keys and endpoint names intentionally stay outside this record. */
export interface AnalyticsWriterIdentity {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
}

export interface AnalyticsWriterFenceRecord {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  fenceEpoch: number;
  state: AnalyticsWriterFenceState;
  expectedHosts: AnalyticsWriterIdentity[];
  acknowledgedHostInstanceIds: string[];
  startedAtMs: string;
  updatedAtMs: string;
}

export interface AnalyticsWriterFenceAcknowledgement {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  acknowledgedAtMs: string;
}

export interface AnalyticsWriterLeaseRecord extends AnalyticsWriterIdentity {
  leaseId: string;
  fenceEpoch: number;
  acquiredAtMs: string;
}

export interface AnalyticsWriterAdmissionState {
  workspaceId: string;
  state: AnalyticsWriterFenceState;
  fenceEpoch: number;
}

/** The shared admission surface used by both manager and ownership seams. */
export type SessionLifecycleWriterAdmission = SessionManagerFenceAdmission & SessionOwnershipAdmission & {
  /** A narrowly-scoped lease for canonical recorder initialization while an
   * analytics-activation fence is already fenced. It is never valid for a
   * producer write and is released before successor admission reopens. */
  acquireStartup?(): () => void;
};

export interface BeginAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  expectedHosts: readonly AnalyticsWriterIdentity[];
  nowMs: Int64Value;
}

export interface AcknowledgeAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  nowMs: Int64Value;
}

export interface ReopenAnalyticsWriterAdmissionOptions {
  workspaceId: string;
  operationId: string;
  purpose: 'analytics-activation';
  admittedHosts: readonly AnalyticsWriterIdentity[];
  nowMs: Int64Value;
}

export interface ReconcileOpenAnalyticsWriterAdmissionOptions {
  identity: AnalyticsWriterIdentity;
  nowMs: Int64Value;
}

/** Bind all persistence seams in one process to the durable admission epoch
 * observed at construction. A fence or later activation reopen makes this
 * captured epoch stale, so an old manager cannot write through a new epoch. */
export function createSessionLifecycleWriterAdmission(
  store: SessionLifecycleStore,
  identity: AnalyticsWriterIdentity,
  now: () => number = Date.now,
): SessionLifecycleWriterAdmission {
  const normalizedIdentity = requireWriterIdentity(identity, 'writer identity');
  const expectedFenceEpoch = store.getAnalyticsWriterAdmissionState(normalizedIdentity.workspaceId).fenceEpoch;
  // A successor host is constructed while the completed analytics fence is
  // still closed. Its startup lease proves that it is the only new identity
  // allowed to cross that boundary; after the orchestrator re-opens admission,
  // this one admission object follows the new epoch. Ordinary writers never
  // set this flag, so old fenced managers remain stale by construction.
  let successorStartupAdmitted = false;
  const currentEpoch = (): number => successorStartupAdmitted
    ? store.getAnalyticsWriterAdmissionState(normalizedIdentity.workspaceId).fenceEpoch
    : expectedFenceEpoch;
  // Capture admission is process-local and can have many simultaneous owners,
  // while the durable lease is only the all-host fence's proof that this
  // process has at least one outstanding writer. Keep the durable row shared;
  // every acquire still re-checks the durable fence before joining it.
  let sharedLease: AnalyticsWriterLeaseRecord | undefined;
  let sharedLeaseHolders = 0;
  const releaseStandaloneLease = (lease: AnalyticsWriterLeaseRecord): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      // Mark the token released only after the durable deletion succeeds. A
      // transient close/SQLite error must not discard the caller's ownership;
      // the caller can retry the same idempotent release instead.
      store.releaseAnalyticsWriterLease(lease);
      released = true;
    };
  };
  return {
    assertAdmitted: () => {
      store.assertAnalyticsWriterAdmitted(normalizedIdentity, currentEpoch());
    },
    acquire: () => {
      const epoch = currentEpoch();
      // Do not rely on the shared row as admission evidence. A fence can be
      // installed while that row is still held, and every fresh owner must be
      // checked against the current identity and epoch before joining it.
      store.assertAnalyticsWriterAdmitted(normalizedIdentity, epoch);
      if (!sharedLease) sharedLease = store.acquireAnalyticsWriterLease(normalizedIdentity, epoch, now());
      sharedLeaseHolders += 1;
      let released = false;
      return () => {
        if (released) return;
        if (sharedLeaseHolders > 1) {
          sharedLeaseHolders -= 1;
          released = true;
          return;
        }
        const lease = sharedLease;
        if (lease) store.releaseAnalyticsWriterLease(lease);
        sharedLease = undefined;
        sharedLeaseHolders = 0;
        released = true;
      };
    },
    acquireStartup: () => {
      // Startup remains a separate durable bridge: while admission is fenced,
      // the store's successor checks—not the normal shared row—authorize it.
      const state = store.getAnalyticsWriterAdmissionState(normalizedIdentity.workspaceId);
      let successor = false;
      const followsReconciledOpenEpoch = state.state === 'open' && state.fenceEpoch !== expectedFenceEpoch;
      const lease = state.state === 'open'
        ? store.acquireAnalyticsWriterLease(normalizedIdentity, followsReconciledOpenEpoch ? state.fenceEpoch : currentEpoch(), now())
        : (() => {
          successor = true;
          return store.acquireAnalyticsWriterStartupLease(normalizedIdentity, now());
        })();
      if (successor || followsReconciledOpenEpoch) successorStartupAdmitted = true;
      return releaseStandaloneLease(lease);
    },
  };
}

/** Narrow analytics view over one open session-lifecycle store: the
 * coordinator constructs the store and exposes only this host-registry and
 * writer-fence/lease/admission surface to analytics authority consumers. */

/** Narrow analytics view over one open session-lifecycle store: the
 * coordinator constructs the store and exposes only this host-registry and
 * writer-fence/lease/admission surface to analytics authority consumers. */
export class SessionLifecycleWriterStore {
  constructor(private readonly store: SessionLifecycleStore) {}

  registerAnalyticsHost(host: Omit<AnalyticsHostRecord, 'state' | 'heartbeatAtMs' | 'updatedAtMs'> & {
    state?: AnalyticsHostState;
    heartbeatAtMs?: Int64Value;
    updatedAtMs?: Int64Value;
  }): AnalyticsHostRecord {
    return this.store.registerAnalyticsHost(host);
  }

  heartbeatAnalyticsHost(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    nowMs: Int64Value,
  ): AnalyticsHostRecord {
    return this.store.heartbeatAnalyticsHost(hostInstanceId, processId, generationId, nowMs);
  }

  markAnalyticsHostState(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    state: Extract<AnalyticsHostState, 'stopping' | 'stopped'>,
    nowMs: Int64Value,
  ): AnalyticsHostRecord {
    return this.store.markAnalyticsHostState(hostInstanceId, processId, generationId, state, nowMs);
  }

  recoverAnalyticsHostAfterProcessExit(identity: AnalyticsWriterIdentity, nowMs: Int64Value): AnalyticsHostRecord {
    return this.store.recoverAnalyticsHostAfterProcessExit(identity, nowMs);
  }

  getAnalyticsHost(hostInstanceId: string): AnalyticsHostRecord | undefined {
    return this.store.getAnalyticsHost(hostInstanceId);
  }

  listAnalyticsHosts(
    workspaceId: string,
    options: { limit?: number; cursor?: string } = {},
  ): AnalyticsHostPage {
    return this.store.listAnalyticsHosts(workspaceId, options);
  }

  getAnalyticsWriterAdmissionState(workspaceId: string): AnalyticsWriterAdmissionState {
    return this.store.getAnalyticsWriterAdmissionState(workspaceId);
  }

  reconcileOpenAnalyticsWriterAdmission(options: ReconcileOpenAnalyticsWriterAdmissionOptions): AnalyticsWriterAdmissionState {
    return this.store.reconcileOpenAnalyticsWriterAdmission(options);
  }

  beginAnalyticsWriterFence(options: BeginAnalyticsWriterFenceOptions): AnalyticsWriterFenceRecord {
    return this.store.beginAnalyticsWriterFence(options);
  }

  getAnalyticsWriterFence(workspaceId: string): AnalyticsWriterFenceRecord | undefined {
    return this.store.getAnalyticsWriterFence(workspaceId);
  }

  listAnalyticsWriterFenceAcknowledgements(
    workspaceId: string,
    operationId: string,
  ): AnalyticsWriterFenceAcknowledgement[] {
    return this.store.listAnalyticsWriterFenceAcknowledgements(workspaceId, operationId);
  }

  acknowledgeAnalyticsWriterFence(options: AcknowledgeAnalyticsWriterFenceOptions): AnalyticsWriterFenceAcknowledgement {
    return this.store.acknowledgeAnalyticsWriterFence(options);
  }

  completeAnalyticsWriterFence(
    workspaceId: string,
    operationId: string,
    nowMs: Int64Value = Date.now(),
  ): AnalyticsWriterFenceRecord {
    return this.store.completeAnalyticsWriterFence(workspaceId, operationId, nowMs);
  }

  reopenAnalyticsWriterAdmission(options: ReopenAnalyticsWriterAdmissionOptions): AnalyticsWriterAdmissionState {
    return this.store.reopenAnalyticsWriterAdmission(options);
  }

  acquireAnalyticsWriterLease(
    identity: AnalyticsWriterIdentity,
    expectedFenceEpoch: number,
    nowMs: Int64Value,
  ): AnalyticsWriterLeaseRecord {
    return this.store.acquireAnalyticsWriterLease(identity, expectedFenceEpoch, nowMs);
  }

  acquireAnalyticsWriterStartupLease(identity: AnalyticsWriterIdentity, nowMs: Int64Value): AnalyticsWriterLeaseRecord {
    return this.store.acquireAnalyticsWriterStartupLease(identity, nowMs);
  }

  assertAnalyticsWriterAdmitted(identity: AnalyticsWriterIdentity, expectedFenceEpoch: number): void {
    return this.store.assertAnalyticsWriterAdmitted(identity, expectedFenceEpoch);
  }

  releaseAnalyticsWriterLease(lease: AnalyticsWriterLeaseRecord): void {
    return this.store.releaseAnalyticsWriterLease(lease);
  }

  listAnalyticsWriterLeases(workspaceId: string): AnalyticsWriterLeaseRecord[] {
    return this.store.listAnalyticsWriterLeases(workspaceId);
  }
}
