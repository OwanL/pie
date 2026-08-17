import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ColdSessionLeaseAuthority,
  ColdSessionPathReservationToken,
} from './cold-session-store';
import type {
  SdkSessionOwnershipAdapter,
  SdkSessionOwnershipFingerprint,
  SdkSessionOwnershipReservation,
  SdkSessionReplacementIntent,
  SdkSessionTransferAuthorization,
  SdkSessionWriteLease,
  SdkWorkerOwnershipIdentity,
} from './sdk';

export const STALE_SESSION_WRITE_LEASE = 'STALE_SESSION_WRITE_LEASE' as const;

export class StaleSessionWriteLeaseError extends Error {
  readonly code = STALE_SESSION_WRITE_LEASE;

  constructor(message: string) {
    super(message);
    this.name = 'StaleSessionWriteLeaseError';
  }
}

export class SessionOwnershipConflictError extends Error {
  readonly code = 'SESSION_OWNERSHIP_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SessionOwnershipConflictError';
  }
}

export class SessionOwnershipFailClosedError extends Error {
  readonly code = 'SESSION_OWNERSHIP_FAIL_CLOSED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SessionOwnershipFailClosedError';
  }
}

export interface SessionOwnershipColdState {
  state: 'cold';
  canonicalPath: string;
  revision: number;
  fingerprint: SdkSessionOwnershipFingerprint;
}

export interface SessionOwnershipReservedState {
  state: 'reserved';
  canonicalPath: string;
  revision: number;
  fingerprint: SdkSessionOwnershipFingerprint;
  reservation: SdkSessionOwnershipReservation;
  sourceLease: SdkSessionWriteLease;
  destinationWasSource: boolean;
}

export interface SessionOwnershipHotState {
  state: 'hot';
  canonicalPath: string;
  revision: number;
  fingerprint: SdkSessionOwnershipFingerprint;
  owner: SdkWorkerOwnershipIdentity;
  lease: SdkSessionWriteLease;
  transferNonce?: string;
  transferConsumed: boolean;
  retiringSourceKey?: string;
}

export interface SessionOwnershipRetiringState {
  state: 'retiring';
  canonicalPath: string;
  revision: number;
  fingerprint: SdkSessionOwnershipFingerprint;
  owner: SdkWorkerOwnershipIdentity;
  reason: string;
}

export type SessionOwnershipState =
  | SessionOwnershipColdState
  | SessionOwnershipReservedState
  | SessionOwnershipHotState
  | SessionOwnershipRetiringState;

export interface SessionCrashReconciliation {
  owner: SdkWorkerOwnershipIdentity;
  processDeathConfirmed: boolean;
  fingerprints?: Readonly<Record<string, SdkSessionOwnershipFingerprint>>;
}

export interface SessionOwnershipAuthorityOptions {
  /** Shared coordinator cold authority. Replacement reservations fence the
   * exact same canonical paths used by cold browse/write commits. */
  coldLeaseAuthority?: ColdSessionLeaseAuthority;
}

interface ReservationFence {
  owner: SdkWorkerOwnershipIdentity;
  tokens: readonly ColdSessionPathReservationToken[];
}

interface HotFence {
  owner: SdkWorkerOwnershipIdentity;
  token: ColdSessionPathReservationToken;
}

function sameOwner(left: SdkWorkerOwnershipIdentity, right: SdkWorkerOwnershipIdentity): boolean {
  return left.coordinatorGeneration === right.coordinatorGeneration
    && left.workerId === right.workerId
    && left.workerGeneration === right.workerGeneration;
}

function pathIdentity(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function sameLease(left: SdkSessionWriteLease, right: SdkSessionWriteLease): boolean {
  return sameOwner(left, right)
    && pathIdentity(left.canonicalSessionPath) === pathIdentity(right.canonicalSessionPath)
    && left.ownershipRevision === right.ownershipRevision
    && left.nonce === right.nonce;
}

function sameFingerprint(
  left: SdkSessionOwnershipFingerprint,
  right: SdkSessionOwnershipFingerprint,
): boolean {
  return left.exists === right.exists
    && left.size === right.size
    && left.sha256 === right.sha256;
}

function sameReservation(
  left: SdkSessionOwnershipReservation,
  right: SdkSessionOwnershipReservation,
): boolean {
  return left.reservationId === right.reservationId
    && left.operationId === right.operationId
    && left.canonicalSourcePath === right.canonicalSourcePath
    && left.canonicalDestinationPath === right.canonicalDestinationPath
    && left.ownershipRevision === right.ownershipRevision
    && left.nonce === right.nonce
    && sameFingerprint(left.destinationFingerprint, right.destinationFingerprint);
}

function cloneState(state: SessionOwnershipState): SessionOwnershipState {
  return structuredClone(state);
}

/**
 * Coordinator-owned ownership authority used by the supported Pie SDK adapter.
 * All state transitions run through one FIFO, which serializes replacements;
 * each transition also orders its canonical source/destination keys before it
 * validates or changes either record.
 */
export class SessionOwnershipAuthority {
  private readonly states = new Map<string, SessionOwnershipState>();
  private readonly reservations = new Map<string, string>();
  private readonly reservationRecords = new Map<string, SessionOwnershipReservedState>();
  private readonly transferPaths = new Map<string, string>();
  private readonly reservationFences = new Map<string, ReservationFence>();
  private readonly hotFences = new Map<string, HotFence>();
  private readonly coldLeaseAuthority?: ColdSessionLeaseAuthority;
  private transitionTail = Promise.resolve();

  constructor(options: SessionOwnershipAuthorityOptions = {}) {
    this.coldLeaseAuthority = options.coldLeaseAuthority;
  }

  async canonicalize(sessionPath: string): Promise<{ canonicalPath: string; key: string }> {
    const absolute = path.resolve(sessionPath);
    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const missingSegments: string[] = [];
      let existingAncestor = absolute;
      while (true) {
        missingSegments.unshift(path.basename(existingAncestor));
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          canonicalPath = path.join(parent, ...missingSegments);
          break;
        }
        existingAncestor = parent;
        try {
          const canonicalAncestor = await fs.realpath(existingAncestor);
          canonicalPath = path.join(canonicalAncestor, ...missingSegments);
          break;
        } catch (ancestorError) {
          if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
        }
      }
    }
    canonicalPath = path.normalize(canonicalPath);
    return {
      canonicalPath,
      key: process.platform === 'win32' ? canonicalPath.toLocaleLowerCase('en-US') : canonicalPath,
    };
  }

  async fingerprint(sessionPath: string): Promise<SdkSessionOwnershipFingerprint> {
    try {
      const data = await fs.readFile(sessionPath);
      return {
        exists: true,
        size: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, size: 0, sha256: null };
      }
      throw error;
    }
  }

  async registerHot(
    sessionPath: string,
    owner: SdkWorkerOwnershipIdentity,
  ): Promise<SdkSessionWriteLease> {
    const canonical = await this.canonicalize(sessionPath);
    const fingerprint = await this.fingerprint(canonical.canonicalPath);
    return await this.exclusive(async () => {
      const existing = this.states.get(canonical.key);
      if (existing && existing.state !== 'cold') {
        throw new SessionOwnershipConflictError(`Session is not cold: ${canonical.canonicalPath}`);
      }
      const revision = (existing?.revision ?? 0) + 1;
      const lease = this.makeLease(canonical.canonicalPath, owner, revision);
      const [hotFence] = this.coldLeaseAuthority?.reserveCanonicalPaths(
        [canonical.canonicalPath],
        `hot:${lease.nonce}`,
      ) ?? [];
      if (hotFence) this.hotFences.set(canonical.key, { owner: { ...owner }, token: hotFence });
      this.states.set(canonical.key, {
        state: 'hot',
        canonicalPath: canonical.canonicalPath,
        revision,
        fingerprint,
        owner: { ...owner },
        lease,
        transferConsumed: true,
      });
      return { ...lease };
    });
  }

  createAdapter(owner: SdkWorkerOwnershipIdentity): SdkSessionOwnershipAdapter {
    return {
      reserveReplacement: async (intent) => await this.reserve(owner, intent),
      abortPrecommit: async (reservation, reason) => await this.abort(owner, reservation, reason),
      commitTransfer: async (reservation, sourceLease) => await this.commit(owner, reservation, sourceLease),
      consumeTransferAuthorization: (authorization, canonicalDestinationPath) => (
        this.consumeTransfer(owner, authorization, canonicalDestinationPath)
      ),
      assertWriteLease: (lease, canonicalPath, seam) => this.assertWrite(owner, lease, canonicalPath, seam),
      runtimeReady: async (lease, canonicalPath) => {
        await this.completeRuntimeReady(owner, lease, canonicalPath);
      },
      failClosed: async (error) => await this.failClosed(owner, error),
    };
  }

  async reserve(
    owner: SdkWorkerOwnershipIdentity,
    intent: SdkSessionReplacementIntent,
  ): Promise<SdkSessionOwnershipReservation> {
    const sourceCanonical = await this.canonicalize(intent.source.canonicalSessionPath);
    const destinationCanonical = await this.canonicalize(intent.destinationPath);
    return await this.exclusive(async () => {
      const destinationFingerprint = await this.fingerprint(destinationCanonical.canonicalPath);
      this.assertHotLease(owner, intent.source, sourceCanonical.key, 'reserveReplacement');
      const destinationState = this.states.get(destinationCanonical.key);
      const selfReopen = sourceCanonical.key === destinationCanonical.key;
      if (!selfReopen && destinationState && destinationState.state !== 'cold') {
        throw new SessionOwnershipConflictError(`Destination is already owned: ${destinationCanonical.canonicalPath}`);
      }
      if (!selfReopen && intent.destinationMustNotExist && destinationFingerprint.exists) {
        throw new SessionOwnershipConflictError(`Destination already exists for ${intent.reason}: ${destinationCanonical.canonicalPath}`);
      }
      const revision = Math.max(
        this.states.get(sourceCanonical.key)?.revision ?? 0,
        destinationState?.revision ?? 0,
      ) + 1;
      const reservation: SdkSessionOwnershipReservation = {
        reservationId: randomUUID(),
        operationId: intent.operationId,
        canonicalSourcePath: sourceCanonical.canonicalPath,
        canonicalDestinationPath: destinationCanonical.canonicalPath,
        ownershipRevision: revision,
        nonce: randomUUID(),
        destinationFingerprint,
      };
      const fenceTokens = selfReopen
        ? []
        : this.coldLeaseAuthority?.reserveCanonicalPaths(
          [destinationCanonical.canonicalPath],
          reservation.reservationId,
        ) ?? [];
      const reserved: SessionOwnershipReservedState = {
        state: 'reserved',
        canonicalPath: destinationCanonical.canonicalPath,
        revision,
        fingerprint: destinationFingerprint,
        reservation,
        sourceLease: { ...intent.source },
        destinationWasSource: selfReopen,
      };
      if (!selfReopen) this.states.set(destinationCanonical.key, reserved);
      this.reservations.set(reservation.reservationId, destinationCanonical.key);
      this.reservationRecords.set(reservation.reservationId, reserved);
      this.reservationFences.set(reservation.reservationId, {
        owner: { ...owner },
        tokens: fenceTokens,
      });
      return structuredClone(reservation);
    });
  }

  async abort(
    owner: SdkWorkerOwnershipIdentity,
    reservation: SdkSessionOwnershipReservation,
    _reason: string,
  ): Promise<void> {
    await this.exclusive(async () => {
      const destinationKey = this.reservations.get(reservation.reservationId);
      if (!destinationKey) return;
      const state = this.reservationRecords.get(reservation.reservationId);
      if (!state
          || state.reservation.nonce !== reservation.nonce
          || !sameOwner(owner, state.sourceLease)) {
        throw new StaleSessionWriteLeaseError('Replacement reservation is stale or owned by another worker.');
      }
      this.reservations.delete(reservation.reservationId);
      this.reservationRecords.delete(reservation.reservationId);
      if (!state.destinationWasSource) {
        this.states.set(destinationKey, {
          state: 'cold',
          canonicalPath: state.canonicalPath,
          revision: state.revision,
          fingerprint: await this.fingerprint(state.canonicalPath),
        });
      }
      this.releaseReservationFence(reservation.reservationId);
    });
  }

  async commit(
    owner: SdkWorkerOwnershipIdentity,
    reservation: SdkSessionOwnershipReservation,
    sourceLease: SdkSessionWriteLease,
  ): Promise<SdkSessionTransferAuthorization> {
    return await this.exclusive(async () => {
      const destinationKey = this.reservations.get(reservation.reservationId);
      const destinationState = this.reservationRecords.get(reservation.reservationId);
      if (!destinationKey || !destinationState
          || !sameReservation(destinationState.reservation, reservation)
          || !sameLease(destinationState.sourceLease, sourceLease)
          || !sameOwner(owner, sourceLease)) {
        throw new StaleSessionWriteLeaseError('Replacement transfer reservation or source lease is stale.');
      }
      const currentFingerprint = await this.fingerprint(destinationState.canonicalPath);
      if (!destinationState.destinationWasSource
          && !sameFingerprint(currentFingerprint, destinationState.fingerprint)) {
        throw new SessionOwnershipConflictError('Destination fingerprint changed while replacement was reserved.');
      }
      const sourceCanonical = await this.canonicalize(sourceLease.canonicalSessionPath);
      const sourceState = this.states.get(sourceCanonical.key);
      if (!sourceState || sourceState.state !== 'hot' || !sameLease(sourceState.lease, sourceLease)) {
        throw new StaleSessionWriteLeaseError('Source write lease was revoked before transfer.');
      }

      const destinationLease = this.makeLease(
        destinationState.canonicalPath,
        owner,
        destinationState.revision,
      );
      const transferNonce = randomUUID();
      if (!destinationState.destinationWasSource) {
        // The SDK revokes the source manager locally before awaiting commit.
        // Once transfer commits, coordinator ownership can therefore return
        // the source to cold immediately while the destination remains fenced
        // to this worker. A stale source manager still fails its adapter lease
        // check, but an independent worker may now promote the released root.
        this.states.set(sourceCanonical.key, {
          state: 'cold',
          canonicalPath: sourceCanonical.canonicalPath,
          revision: sourceLease.ownershipRevision + 1,
          fingerprint: await this.fingerprint(sourceCanonical.canonicalPath),
        });
        this.releaseHotFence(sourceCanonical.key);
      }
      this.states.set(destinationKey, {
        state: 'hot',
        canonicalPath: destinationState.canonicalPath,
        revision: destinationState.revision,
        fingerprint: currentFingerprint,
        owner: { ...owner },
        lease: destinationLease,
        transferNonce,
        transferConsumed: false,
      });
      this.reservations.delete(reservation.reservationId);
      this.reservationRecords.delete(reservation.reservationId);
      const destinationFence = this.reservationFences.get(reservation.reservationId)?.tokens[0];
      if (destinationFence) {
        this.hotFences.set(destinationKey, { owner: { ...owner }, token: destinationFence });
      }
      this.reservationFences.delete(reservation.reservationId);
      this.transferPaths.set(transferNonce, destinationKey);
      return {
        authorizationId: randomUUID(),
        reservationId: reservation.reservationId,
        canonicalDestinationPath: destinationState.canonicalPath,
        ownershipRevision: destinationState.revision,
        nonce: transferNonce,
        destinationLease: { ...destinationLease },
      };
    });
  }

  async consumeTransfer(
    owner: SdkWorkerOwnershipIdentity,
    authorization: SdkSessionTransferAuthorization,
    canonicalDestinationPath: string,
  ): Promise<SdkSessionWriteLease> {
    return await this.exclusive(async () => {
      const key = this.transferPaths.get(authorization.nonce);
      const state = key ? this.states.get(key) : undefined;
      if (!key || !state || state.state !== 'hot'
          || state.transferConsumed
          || state.transferNonce !== authorization.nonce
          || state.canonicalPath !== canonicalDestinationPath
          || authorization.canonicalDestinationPath !== canonicalDestinationPath
          || authorization.ownershipRevision !== state.revision
          || !sameOwner(owner, state.owner)
          || !sameLease(authorization.destinationLease, state.lease)) {
        throw new StaleSessionWriteLeaseError('Transfer authorization is stale, replayed, or for the wrong destination.');
      }
      state.transferConsumed = true;
      this.transferPaths.delete(authorization.nonce);
      return { ...state.lease };
    });
  }

  assertWrite(
    owner: SdkWorkerOwnershipIdentity,
    lease: SdkSessionWriteLease,
    canonicalPath: string,
    seam: string,
  ): void {
    const normalized = path.normalize(path.resolve(canonicalPath));
    const key = pathIdentity(normalized);
    const state = this.states.get(key);
    if (!state || state.state !== 'hot' || !state.transferConsumed
        || pathIdentity(state.canonicalPath) !== key
        || !sameOwner(owner, state.owner)
        || !sameLease(state.lease, lease)) {
      throw new StaleSessionWriteLeaseError(`Stale session write lease at ${seam} for ${normalized}.`);
    }
  }

  private async completeRuntimeReady(
    owner: SdkWorkerOwnershipIdentity,
    lease: SdkSessionWriteLease,
    canonicalPath: string,
  ): Promise<void> {
    await this.exclusive(async () => {
      const normalized = path.normalize(path.resolve(canonicalPath));
      const key = pathIdentity(normalized);
      const destination = this.states.get(key);
      if (!destination || destination.state !== 'hot' || !destination.transferConsumed
          || !sameOwner(owner, destination.owner) || !sameLease(destination.lease, lease)) {
        throw new StaleSessionWriteLeaseError('Destination lease changed before runtime-ready publication.');
      }
      const sourceKey = destination.retiringSourceKey;
      if (!sourceKey) return;
      const source = this.states.get(sourceKey);
      if (!source || source.state !== 'retiring' || !sameOwner(owner, source.owner)
          || source.reason !== 'replacement-transfer') {
        throw new StaleSessionWriteLeaseError('Transferred source ownership is not retiring as expected.');
      }
      const fingerprint = await this.fingerprint(source.canonicalPath);
      const current = this.states.get(sourceKey);
      if (!current || current.state !== 'retiring' || !sameOwner(owner, current.owner)
          || current.revision !== source.revision) {
        throw new StaleSessionWriteLeaseError('Transferred source ownership changed during runtime readiness.');
      }
      this.states.set(sourceKey, {
        state: 'cold',
        canonicalPath: source.canonicalPath,
        revision: source.revision,
        fingerprint,
      });
      this.releaseHotFence(sourceKey);
      delete destination.retiringSourceKey;
    });
  }

  async failClosed(owner: SdkWorkerOwnershipIdentity, error: unknown): Promise<never> {
    await this.exclusive(async () => {
      const refresh: Array<{ key: string; revision: number; canonicalPath: string }> = [];
      for (const [reservationId, reservation] of this.reservationRecords) {
        if (!sameOwner(owner, reservation.sourceLease)) continue;
        this.reservations.delete(reservationId);
        this.reservationRecords.delete(reservationId);
        // Keep the shared cold fence until confirmed process-death
        // reconciliation. The worker may have lost the commit response.
      }
      for (const [key, state] of this.states) {
        if (state.state === 'reserved' && sameOwner(owner, state.sourceLease)) {
          this.reservations.delete(state.reservation.reservationId);
          this.reservationRecords.delete(state.reservation.reservationId);
          const revision = state.revision + 1;
          this.states.set(key, {
            state: 'retiring',
            canonicalPath: state.canonicalPath,
            revision,
            fingerprint: state.fingerprint,
            owner: { ...owner },
            reason: 'ambiguous-precommit-failure',
          });
          refresh.push({ key, revision, canonicalPath: state.canonicalPath });
        } else if (state.state === 'hot' && sameOwner(owner, state.owner)) {
          if (state.transferNonce) this.transferPaths.delete(state.transferNonce);
          const revision = state.revision + 1;
          this.states.set(key, {
            state: 'retiring',
            canonicalPath: state.canonicalPath,
            revision,
            fingerprint: state.fingerprint,
            owner: { ...owner },
            reason: 'postcommit-failure',
          });
          refresh.push({ key, revision, canonicalPath: state.canonicalPath });
        }
      }
      // Every write lease is synchronously fenced above. Fingerprinting may now
      // yield without allowing assertWrite() to observe a hot owner.
      for (const item of refresh) {
        const fingerprint = await this.fingerprint(item.canonicalPath);
        const current = this.states.get(item.key);
        if (current?.state === 'retiring' && current.revision === item.revision) {
          current.fingerprint = fingerprint;
        }
      }
    });
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionOwnershipFailClosedError(`Worker session ownership failed closed: ${detail}`);
  }

  async reconcileCrash(reconciliation: SessionCrashReconciliation): Promise<void> {
    await this.exclusive(async () => {
      if (!reconciliation.processDeathConfirmed) {
        throw new SessionOwnershipConflictError('Worker process death is not confirmed; ownership remains fenced.');
      }
      for (const [reservationId, reservation] of this.reservationRecords) {
        if (!sameOwner(reconciliation.owner, reservation.sourceLease)) continue;
        this.reservations.delete(reservationId);
        this.reservationRecords.delete(reservationId);
      }
      for (const [key, state] of this.states) {
        const stateOwner = state.state === 'reserved' ? state.sourceLease : state.state === 'cold' ? undefined : state.owner;
        if (!stateOwner || !sameOwner(reconciliation.owner, stateOwner)) continue;
        const observed = reconciliation.fingerprints?.[state.canonicalPath]
          ?? await this.fingerprint(state.canonicalPath);
        if (state.state === 'reserved') {
          this.reservations.delete(state.reservation.reservationId);
          this.reservationRecords.delete(state.reservation.reservationId);
        }
        if (state.state === 'hot' && state.transferNonce) this.transferPaths.delete(state.transferNonce);
        // A caller-supplied fingerprint is an explicit durable observation. If
        // it disagrees with the current file, reconciliation remains retiring.
        const current = await this.fingerprint(state.canonicalPath);
        if (!sameFingerprint(observed, current)) {
          this.states.set(key, {
            state: 'retiring',
            canonicalPath: state.canonicalPath,
            revision: state.revision + 1,
            fingerprint: current,
            owner: { ...reconciliation.owner },
            reason: 'crash-fingerprint-ambiguous',
          });
          continue;
        }
        this.states.set(key, {
          state: 'cold',
          canonicalPath: state.canonicalPath,
          revision: state.revision + 1,
          fingerprint: current,
        });
      }
      const ownedFenceIds = [...this.reservationFences.entries()]
        .filter(([, fence]) => sameOwner(reconciliation.owner, fence.owner)
          && fence.tokens.every((token) => this.states.get(token.sessionPathKey)?.state === 'cold'))
        .map(([reservationId]) => reservationId)
        .sort();
      for (const reservationId of ownedFenceIds) this.releaseReservationFence(reservationId);
      const ownedHotKeys = [...this.hotFences.entries()]
        .filter(([key, fence]) => sameOwner(reconciliation.owner, fence.owner)
          && this.states.get(key)?.state === 'cold')
        .map(([key]) => key)
        .sort();
      for (const key of ownedHotKeys) this.releaseHotFence(key);
    });
  }

  async inspect(sessionPath: string): Promise<SessionOwnershipState | undefined> {
    const canonical = await this.canonicalize(sessionPath);
    const state = this.states.get(canonical.key);
    return state ? cloneState(state) : undefined;
  }

  private assertHotLease(
    owner: SdkWorkerOwnershipIdentity,
    lease: SdkSessionWriteLease,
    key: string,
    seam: string,
  ): void {
    const state = this.states.get(key);
    if (!state || state.state !== 'hot' || !state.transferConsumed
        || !sameOwner(owner, state.owner) || !sameLease(state.lease, lease)) {
      throw new StaleSessionWriteLeaseError(`Stale source session write lease at ${seam}.`);
    }
  }

  private releaseReservationFence(reservationId: string): void {
    const fence = this.reservationFences.get(reservationId);
    if (!fence) return;
    this.coldLeaseAuthority?.releaseCanonicalPaths(fence.tokens);
    this.reservationFences.delete(reservationId);
  }

  private releaseHotFence(key: string): void {
    const fence = this.hotFences.get(key);
    if (!fence) return;
    this.coldLeaseAuthority?.releaseCanonicalPaths([fence.token]);
    this.hotFences.delete(key);
  }

  private makeLease(
    canonicalSessionPath: string,
    owner: SdkWorkerOwnershipIdentity,
    ownershipRevision: number,
  ): SdkSessionWriteLease {
    return {
      ...owner,
      canonicalSessionPath,
      ownershipRevision,
      nonce: randomUUID(),
    };
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release!: () => void;
    this.transitionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
