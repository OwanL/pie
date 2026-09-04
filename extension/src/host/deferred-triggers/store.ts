import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDeferredTriggersDir, TRIGGERS_FILE } from '../../shared/deferred-triggers-paths';
import type { DeferredTriggerView, TriggerKind, TriggerSpec } from '../../shared/protocol';

export type { TriggerKind, TriggerSpec };

/**
 * Deferred-trigger sidecar persistence + pure replay.
 *
 * `triggers.jsonl` is an append-only, multi-writer operation log. Delivery is
 * additionally guarded by one atomic claim artifact per trigger. Creating that
 * artifact with a hard link is the cross-process compare-and-set: only one host
 * can own delivery, while the claim/release/fire ops keep the durable state
 * inspectable and replayable.
 */
export interface TriggerOp {
  id?: string;
  op: 'register' | 'cancel' | 'claim' | 'dispatch-started' | 'release' | 'failed' | 'fire';
  /** The watcher's session path (the session to resume). */
  sessionPath: string;
  triggers?: TriggerSpec[];
  note?: string;
  at?: string;
  targetId?: string;
  reason?: string;
  /** failed: original wake reason retained for an explicit retry. */
  wakeReason?: string;
  /** claim/release/fire: unique delivery attempt. */
  claimId?: string;
  /** claim: registry instance that owns the delivery attempt. */
  ownerId?: string;
  /** claim: OS process that owns the registry. Missing/invalid legacy owners
   * remain fail-closed because their death cannot be confirmed. */
  ownerPid?: number;
  /** claim/dispatch-started: durable evidence that delivery may have begun. */
  dispatchStartedAt?: string;
  /** release: identifies a safe pre-dispatch dead-owner recovery. */
  recoveryState?: 'dead-owner-recovered';
}

export type ActiveTrigger = DeferredTriggerView & {
  /** Host-only durable claim correlation; never projected to the renderer. */
  claimId?: string;
  claimOwnerId?: string;
  claimOwnerPid?: number;
  claimAt?: string;
  dispatchStartedAt?: string;
  /** Host-only reason used when retrying a retained synthetic wake. */
  wakeReason?: string;
};

export interface TriggerClaim {
  id: string;
  sessionPath: string;
  claimId: string;
  ownerId: string;
  ownerPid: number;
  reason: string;
  at: string;
  dispatchStartedAt?: string;
}

export type ClaimOwnerLiveness = 'alive' | 'dead' | 'unknown';
export type CheckClaimOwnerLiveness = (owner: {
  ownerId: string | undefined;
  ownerPid: number;
  claimedAt: string | undefined;
}) => ClaimOwnerLiveness;

export const checkProcessOwnerLiveness: CheckClaimOwnerLiveness = ({ ownerPid }) => {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return 'unknown';
  try {
    process.kill(ownerPid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
};

/** Resolve the sidecar file path, or undefined when the dir env is unset. */
export function getTriggersFilePath(): string | undefined {
  const dir = getDeferredTriggersDir();
  return dir ? path.join(dir, TRIGGERS_FILE) : undefined;
}

/** Ensure the sidecar directory exists (best-effort; failures swallowed). */
export function ensureTriggersDir(): void {
  const dir = getDeferredTriggersDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: the first append also attempts to create it.
  }
}

/**
 * One store instance represents one host's view of the shared sidecar. Tests
 * intentionally create two instances over the same file to exercise the
 * cross-process claim boundary deterministically.
 */
export class DeferredTriggerStore {
  constructor(
    private readonly file: string | undefined = getTriggersFilePath(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  readOps(): TriggerOp[] {
    if (!this.file) return [];
    const ops = readOpsFile(this.file);
    // A claim artifact is authoritative if its owner died between the atomic
    // claim and appending the matching log op. Artifacts whose claim already
    // has a durable release/fire are stale crash residue and are cleaned.
    ops.push(...readClaimArtifacts(this.file, ops));
    return ops;
  }

  append(op: TriggerOp): void {
    if (!this.file) {
      throw new Error('deferred-triggers sidecar dir is not configured (PI_CODING_AGENT_DIR unset).');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(op) + '\n', undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Atomically claim an active trigger. Returns undefined when another host
   * owns it or it has already been consumed/cancelled. */
  tryClaim(
    id: string,
    sessionPath: string,
    ownerId: string,
    ownerPid: number,
    reason: string,
    deliveryAlreadyStarted = false,
  ): TriggerClaim | undefined {
    if (!this.file) return undefined;
    const current = replayTriggers(this.readOps()).get(id);
    if (!current || current.sessionPath !== sessionPath || current.deliveryState === 'claimed') return undefined;

    const claimedAt = this.now().toISOString();
    const claim: TriggerClaim = {
      id,
      sessionPath,
      claimId: randomUUID(),
      ownerId,
      ownerPid,
      reason,
      at: claimedAt,
      ...(deliveryAlreadyStarted ? { dispatchStartedAt: claimedAt } : {}),
    };
    const artifact = claimArtifactPath(this.file, id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!publishClaimArtifact(artifact, claim)) return undefined;

    // Re-check after winning the filesystem claim. A stale in-memory registry
    // may have raced a completed fire/cancel before it acquired the artifact.
    const afterClaim = replayTriggers(readOpsFile(this.file)).get(id);
    if (!afterClaim || afterClaim.sessionPath !== sessionPath || afterClaim.deliveryState === 'claimed') {
      removeClaimArtifact(artifact, claim.claimId);
      return undefined;
    }

    try {
      this.append({ ...claim, op: 'claim' });
      return claim;
    } catch (error) {
      removeClaimArtifact(artifact, claim.claimId);
      throw error;
    }
  }

  /** Persist the fail-closed boundary immediately before synthetic dispatch.
   * A dead owner is recoverable only while this evidence is absent. */
  markDispatchStarted(claim: TriggerClaim): void {
    if (claim.dispatchStartedAt) return;
    const dispatchStartedAt = this.now().toISOString();
    this.append({
      id: claim.id,
      op: 'dispatch-started',
      sessionPath: claim.sessionPath,
      claimId: claim.claimId,
      ownerId: claim.ownerId,
      ownerPid: claim.ownerPid,
      reason: claim.reason,
      at: dispatchStartedAt,
      dispatchStartedAt,
    });
    claim.dispatchStartedAt = dispatchStartedAt;
  }

  /** Commit a successfully dispatched delivery. The claim is retained if the
   * durable fire append fails, preventing an ambiguous delivery from being
   * dispatched again. */
  completeClaim(claim: TriggerClaim): void {
    this.append({
      id: claim.id,
      op: 'fire',
      sessionPath: claim.sessionPath,
      claimId: claim.claimId,
      reason: claim.reason,
      at: this.now().toISOString(),
    });
    if (this.file) removeClaimArtifact(claimArtifactPath(this.file, claim.id), claim.claimId);
  }

  /** Release a delivery that definitively failed before dispatch completed. */
  releaseClaim(
    claim: TriggerClaim,
    reason: string,
    recoveryState?: 'dead-owner-recovered',
  ): void {
    this.append({
      id: claim.id,
      op: 'release',
      sessionPath: claim.sessionPath,
      claimId: claim.claimId,
      reason,
      at: this.now().toISOString(),
      recoveryState,
    });
    if (this.file) removeClaimArtifact(claimArtifactPath(this.file, claim.id), claim.claimId);
  }

  /** Recover only claims whose process is confirmed dead and whose durable
   * dispatch boundary was never crossed. The release is fsynced before the
   * exact old artifact is removed, so every concurrent claimant observes
   * either the old claim or the retryable release. Duplicate recoverers may
   * append the same release, but the fixed claim artifact still selects at
   * most one subsequent live delivery owner. */
  recoverDeadOwnerClaims(checkOwner = checkProcessOwnerLiveness): string[] {
    const recovered: string[] = [];
    const active = replayTriggers(this.readOps());
    for (const trigger of active.values()) {
      if (
        trigger.deliveryState !== 'claimed'
        || trigger.dispatchStartedAt
        || !trigger.claimId
        || !Number.isSafeInteger(trigger.claimOwnerPid)
        || (trigger.claimOwnerPid ?? 0) <= 0
      ) {
        continue;
      }
      const ownerPid = trigger.claimOwnerPid!;
      if (checkOwner({
        ownerId: trigger.claimOwnerId,
        ownerPid,
        claimedAt: trigger.claimAt,
      }) !== 'dead') {
        continue;
      }

      // Liveness must be checked before this final replay. Once death is
      // confirmed the owner cannot cross the dispatch boundary, while this
      // re-read catches a boundary it fsynced immediately before exiting.
      const latest = replayTriggers(this.readOps()).get(trigger.id);
      if (
        latest?.deliveryState !== 'claimed'
        || latest.claimId !== trigger.claimId
        || latest.dispatchStartedAt
      ) {
        continue;
      }
      const recoveryClaim: TriggerClaim = {
        id: latest.id,
        sessionPath: latest.sessionPath,
        claimId: latest.claimId,
        ownerId: latest.claimOwnerId ?? '',
        ownerPid,
        reason: latest.wakeReason ?? 'deferred-trigger delivery',
        at: latest.claimAt ?? new Date(0).toISOString(),
      };
      // The artifact may be the only claim record when its owner crashed
      // between hard-link publication and the JSONL append. Persisting the
      // idempotent claim first ensures the following release remains
      // replayable after the artifact is removed.
      this.append({ ...recoveryClaim, op: 'claim' });
      this.releaseClaim(
        recoveryClaim,
        'claim owner exited before dispatch; delivery recovered and is retryable',
        'dead-owner-recovered',
      );
      recovered.push(latest.id);
    }
    return recovered;
  }

  /** Record a retryable pre-delivery failure (for example, a closed tab). */
  recordDeliveryFailure(id: string, sessionPath: string, wakeReason: string, reason: string): boolean {
    const active = replayTriggers(this.readOps()).get(id);
    if (!active || active.sessionPath !== sessionPath || active.deliveryState === 'claimed') return false;
    if (active.deliveryState === 'retryable' && active.deliveryDetail === reason) return false;
    this.append({ id, op: 'failed', sessionPath, reason, wakeReason, at: this.now().toISOString() });
    return true;
  }
}

/** Read + parse every op line plus durable claim artifacts. */
export function readTriggerOps(): TriggerOp[] {
  return new DeferredTriggerStore().readOps();
}

/** Append one op line. Creates the dir/file if needed. Throws on missing dir. */
export function appendTriggerOp(op: TriggerOp): void {
  new DeferredTriggerStore().append(op);
}

/**
 * Watch the sidecar dir for changes and invoke `onChange` (debounced) so the
 * registry re-reads after the tool (or itself) appends an op.
 */
export function startTriggerWatcher(onChange: () => void): () => void {
  const dir = getDeferredTriggersDir();
  if (!dir) return () => {};
  ensureTriggersDir();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_, filename) => {
      if (filename !== TRIGGERS_FILE && !filename?.startsWith(`${TRIGGERS_FILE}.claim-`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

/** Pure replay of registration, claim, retryable failure, and consumption. */
export function replayTriggers(ops: TriggerOp[]): Map<string, ActiveTrigger> {
  const map = new Map<string, ActiveTrigger>();
  for (const op of ops) {
    if (op.op === 'register') {
      if (!op.id || !op.triggers) continue;
      map.set(op.id, {
        id: op.id,
        sessionPath: op.sessionPath,
        triggers: op.triggers,
        note: typeof op.note === 'string' ? op.note : '',
        registeredAt: op.at ?? new Date(0).toISOString(),
        deliveryState: 'pending',
      });
      continue;
    }

    if (op.op === 'cancel') {
      if (op.targetId) {
        map.delete(op.targetId);
      } else {
        for (const [id, trigger] of map) {
          if (trigger.sessionPath === op.sessionPath) map.delete(id);
        }
      }
      continue;
    }

    if (!op.id) continue;
    const trigger = map.get(op.id);
    if (!trigger) continue;

    if (op.op === 'claim') {
      if (!op.claimId || trigger.deliveryState === 'claimed') continue;
      const dispatchStartedAt = op.dispatchStartedAt;
      map.set(op.id, {
        ...trigger,
        deliveryState: 'claimed',
        recoveryState: dispatchStartedAt ? 'acknowledgement-ambiguous' : undefined,
        deliveryDetail: dispatchStartedAt
          ? 'delivery may have started; awaiting acknowledgement and automatic retry is blocked'
          : 'delivery claimed; dispatch is pending',
        claimId: op.claimId,
        claimOwnerId: op.ownerId,
        claimOwnerPid: op.ownerPid,
        claimAt: op.at,
        dispatchStartedAt,
        wakeReason: op.reason,
      });
    } else if (op.op === 'dispatch-started') {
      if (!op.claimId || trigger.claimId !== op.claimId) continue;
      map.set(op.id, {
        ...trigger,
        deliveryState: 'claimed',
        recoveryState: 'acknowledgement-ambiguous',
        deliveryDetail: 'delivery may have started; awaiting acknowledgement and automatic retry is blocked',
        dispatchStartedAt: op.dispatchStartedAt ?? op.at ?? trigger.claimAt,
      });
    } else if (op.op === 'release') {
      if (!op.claimId || trigger.claimId !== op.claimId) continue;
      map.set(op.id, {
        ...trigger,
        deliveryState: 'retryable',
        recoveryState: op.recoveryState,
        deliveryDetail: op.reason ?? 'delivery failed before dispatch',
        claimId: undefined,
        claimOwnerId: undefined,
        claimOwnerPid: undefined,
        claimAt: undefined,
        dispatchStartedAt: undefined,
      });
    } else if (op.op === 'failed') {
      if (trigger.deliveryState === 'claimed') continue;
      map.set(op.id, {
        ...trigger,
        deliveryState: 'retryable',
        recoveryState: undefined,
        deliveryDetail: op.reason ?? 'delivery could not be attempted',
        wakeReason: op.wakeReason ?? trigger.wakeReason,
      });
    } else if (op.op === 'fire') {
      // Legacy fire records have no claimId. New records must match the owner.
      if (!op.claimId || trigger.claimId === op.claimId) map.delete(op.id);
    }
  }
  return map;
}

function readOpsFile(file: string): TriggerOp[] {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const ops: TriggerOp[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const op = normalizeOp(JSON.parse(trimmed) as unknown);
      if (op) ops.push(op);
    } catch {
      // A malformed or partially-written line cannot poison the remaining log.
    }
  }
  return ops;
}

function claimArtifactPath(file: string, id: string): string {
  const digest = createHash('sha256').update(id).digest('hex');
  return `${file}.claim-${digest}`;
}

function publishClaimArtifact(file: string, claim: TriggerClaim): boolean {
  const temp = `${file}.${claim.claimId}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ ...claim, op: 'claim' }), undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      // The source is complete before the hard link appears. linkSync fails
      // rather than replacing an existing destination on every supported OS.
      fs.linkSync(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp may never have been created, or was already removed.
    }
  }
}

function removeClaimArtifact(file: string, claimId: string): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { claimId?: unknown };
    if (parsed.claimId !== claimId) return;
    fs.unlinkSync(file);
  } catch {
    // Missing/malformed artifacts fail closed: never remove another owner's claim.
  }
}

function readClaimArtifacts(file: string, logOps: TriggerOp[]): TriggerOp[] {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.claim-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
  const claims: TriggerOp[] = [];
  for (const name of names.sort()) {
    try {
      const artifactPath = path.join(dir, name);
      const op = normalizeOp(JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown);
      if (op?.op !== 'claim' || !op.claimId) continue;
      const terminal = logOps.some((candidate) =>
        candidate.id === op.id
        && candidate.claimId === op.claimId
        && (candidate.op === 'release' || candidate.op === 'fire'));
      if (terminal) {
        removeClaimArtifact(artifactPath, op.claimId);
        continue;
      }
      const logged = logOps.some((candidate) => candidate.op === 'claim' && candidate.claimId === op.claimId);
      if (!logged) claims.push(op);
    } catch {
      // Claim publication makes complete files visible atomically; malformed
      // foreign files are ignored rather than weakening valid claims.
    }
  }
  return claims;
}

function normalizeOp(value: unknown): TriggerOp | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!['register', 'cancel', 'claim', 'dispatch-started', 'release', 'failed', 'fire'].includes(String(v.op))) return undefined;
  if (typeof v.sessionPath !== 'string') return undefined;
  const op: TriggerOp = { op: v.op as TriggerOp['op'], sessionPath: v.sessionPath };
  if (typeof v.id === 'string') op.id = v.id;
  if (typeof v.at === 'string') op.at = v.at;
  if (typeof v.note === 'string') op.note = v.note;
  if (typeof v.reason === 'string') op.reason = v.reason;
  if (typeof v.wakeReason === 'string') op.wakeReason = v.wakeReason;
  if (typeof v.targetId === 'string') op.targetId = v.targetId;
  if (typeof v.claimId === 'string') op.claimId = v.claimId;
  if (typeof v.ownerId === 'string') op.ownerId = v.ownerId;
  if (typeof v.ownerPid === 'number' && Number.isSafeInteger(v.ownerPid) && v.ownerPid > 0) op.ownerPid = v.ownerPid;
  if (typeof v.dispatchStartedAt === 'string') op.dispatchStartedAt = v.dispatchStartedAt;
  if (v.recoveryState === 'dead-owner-recovered') op.recoveryState = v.recoveryState;
  if (op.op === 'register') {
    if (!op.id) return undefined;
    const triggers = normalizeSpecs(v.triggers);
    if (!triggers || triggers.length === 0) return undefined;
    op.triggers = triggers;
  }
  if ((op.op === 'claim' || op.op === 'dispatch-started' || op.op === 'release') && (!op.id || !op.claimId)) return undefined;
  if ((op.op === 'failed' || op.op === 'fire') && !op.id) return undefined;
  return op;
}

function normalizeSpecs(value: unknown): TriggerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const specs: TriggerSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const s = item as Record<string, unknown>;
    if (s.kind !== 'session_finished' && s.kind !== 'timer' && s.kind !== 'user_input') return undefined;
    const spec: TriggerSpec = { kind: s.kind };
    if (s.kind === 'session_finished') {
      if (s.sessionPath !== undefined) {
        if (typeof s.sessionPath !== 'string' || s.sessionPath.trim() === '') return undefined;
        spec.sessionPath = s.sessionPath;
      }
    } else if (s.kind === 'timer') {
      if (typeof s.ms !== 'number' || !Number.isFinite(s.ms) || s.ms <= 0 || !Number.isInteger(s.ms)) return undefined;
      spec.ms = s.ms;
    }
    specs.push(spec);
  }
  return specs;
}
