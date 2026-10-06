/**
 * Analytics writer-fence/admission API surface over the shared session
 * lifecycle store.
 *
 * The lifecycle owner supplies the minimal analytics store port; analytics
 * owns the writer-admission policy and does not depend on harness storage.
 */

import type { Int64Value } from '../contracts/contracts.js';
import {
  requireWriterIdentity,
  type AnalyticsWriterAdmissionState,
  type AnalyticsWriterIdentity,
  type AnalyticsWriterLeaseRecord,
} from '../contracts/session-lifecycle-writer.js';

export type {
  AcknowledgeAnalyticsWriterFenceOptions,
  AnalyticsHostPage,
  AnalyticsHostRecord,
  AnalyticsHostState,
  AnalyticsWriterAdmissionState,
  AnalyticsWriterFenceAcknowledgement,
  AnalyticsWriterFencePurpose,
  AnalyticsWriterFenceRecord,
  AnalyticsWriterFenceState,
  AnalyticsWriterIdentity,
  AnalyticsWriterLeaseRecord,
  BeginAnalyticsWriterFenceOptions,
  ReopenAnalyticsWriterAdmissionOptions,
  ReconcileOpenAnalyticsWriterAdmissionOptions,
} from '../contracts/session-lifecycle-writer.js';

/** Analytics-owned admission shape shared structurally with harness consumers. */
export interface SessionLifecycleWriterAdmission {
  assertAdmitted(): void;
  acquire(): () => void;
  /** A narrowly-scoped lease for canonical recorder initialization while an
   * analytics-activation fence is already fenced. It is never valid for a
   * producer write and is released before successor admission reopens. */
  acquireStartup?(): () => void;
}

/** Exact durable surface consumed by analytics writer admission and activation. */
export interface AnalyticsWriterStorePort {
  getAnalyticsWriterAdmissionState(workspaceId: string): AnalyticsWriterAdmissionState;
  assertAnalyticsWriterAdmitted(identity: AnalyticsWriterIdentity, expectedFenceEpoch: number): void;
  acquireAnalyticsWriterLease(
    identity: AnalyticsWriterIdentity,
    expectedFenceEpoch: number,
    nowMs: Int64Value,
  ): AnalyticsWriterLeaseRecord;
  acquireAnalyticsWriterStartupLease(identity: AnalyticsWriterIdentity, nowMs: Int64Value): AnalyticsWriterLeaseRecord;
  releaseAnalyticsWriterLease(lease: AnalyticsWriterLeaseRecord): void;
  listAnalyticsWriterLeases(workspaceId: string): AnalyticsWriterLeaseRecord[];
  close(): void;
}

/** Bind all persistence seams in one process to the durable admission epoch
 * observed at construction. A fence or later activation reopen makes this
 * captured epoch stale, so an old manager cannot write through a new epoch. */
export function createSessionLifecycleWriterAdmission(
  store: AnalyticsWriterStorePort,
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
