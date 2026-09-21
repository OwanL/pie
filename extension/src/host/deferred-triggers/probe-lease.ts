import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CommandTrigger } from '../../../../shared/wake-conditions';
import {
  checkProcessOwnerLiveness,
  type CheckClaimOwnerLiveness,
} from './store';

export interface CommandProbeLease {
  key: string;
  token: string;
  path: string;
  ownerId: string;
  ownerPid: number;
  at: string;
}

export interface CommandProbeLeaseOptions {
  ownerId: string;
  ownerPid: number;
  now?: () => Date;
  checkOwnerLiveness?: CheckClaimOwnerLiveness;
}

interface LeaseArtifact {
  key: string;
  token: string;
  ownerId: string;
  ownerPid: number;
  at: string;
}

/**
 * Cross-host exclusion for command probes. This is deliberately separate from
 * the trigger delivery claim: multiple hosts may observe a condition, but only
 * one process should execute a given predicate at a time. A PID-owned artifact
 * is published with O_EXCL (`wx`); a confirmed-dead owner can be atomically
 * moved aside and replaced by the next probe.
 */
export class CommandProbeLeaseStore {
  private readonly owned = new Map<string, CommandProbeLease>();
  private readonly now: () => Date;
  private readonly checkOwnerLiveness: CheckClaimOwnerLiveness;

  constructor(
    private readonly triggersFile: string | undefined,
    private readonly options: CommandProbeLeaseOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.checkOwnerLiveness = options.checkOwnerLiveness ?? checkProcessOwnerLiveness;
  }

  tryAcquire(spec: Pick<CommandTrigger, 'command' | 'cwd'>): CommandProbeLease | undefined {
    if (!this.triggersFile || !isValidPid(this.options.ownerPid)) return undefined;
    const key = commandProbeKey(spec);
    if (this.owned.has(key)) return undefined;
    const leasePath = `${this.triggersFile}.probe-${key}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lease = this.publish(leasePath, key);
      if (lease) {
        this.owned.set(key, lease);
        return lease;
      }
      if (!this.reclaimDeadOwner(leasePath, key)) return undefined;
    }
    return undefined;
  }

  release(lease: CommandProbeLease): void {
    const current = this.owned.get(lease.key);
    if (current?.token === lease.token) this.owned.delete(lease.key);
    removeOwnedArtifact(lease);
  }

  /** Best-effort cleanup for leases which are no longer running. The registry
   * does not call this for an in-flight check: abort and release happen only
   * after that check settles, preserving the no-concurrent-execution promise. */
  dispose(): void {
    for (const lease of this.owned.values()) removeOwnedArtifact(lease);
    this.owned.clear();
  }

  private publish(leasePath: string, key: string): CommandProbeLease | undefined {
    const lease: CommandProbeLease = {
      key,
      token: randomUUID(),
      path: leasePath,
      ownerId: this.options.ownerId,
      ownerPid: this.options.ownerPid,
      at: this.now().toISOString(),
    };
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(leasePath), { recursive: true });
      fd = fs.openSync(leasePath, 'wx');
      fs.writeSync(fd, JSON.stringify(lease), undefined, 'utf8');
      fs.fsyncSync(fd);
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        try { fs.unlinkSync(leasePath); } catch { /* best effort */ }
      }
      return undefined;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  private reclaimDeadOwner(leasePath: string, expectedKey: string): boolean {
    const artifact = readArtifact(leasePath);
    if (!artifact || artifact.key !== expectedKey || !isValidPid(artifact.ownerPid)) return false;
    if (this.checkOwnerLiveness({
      ownerId: artifact.ownerId,
      ownerPid: artifact.ownerPid,
      claimedAt: artifact.at,
    }) !== 'dead') return false;

    // rename is the atomic winner among multiple recovering hosts. The old
    // artifact cannot be replaced in place by this operation, and the unique
    // quarantine name prevents a second recovery from deleting a new lease.
    const stalePath = `${leasePath}.stale-${randomUUID()}`;
    try {
      fs.renameSync(leasePath, stalePath);
      try { fs.unlinkSync(stalePath); } catch { /* cleanup is best effort */ }
      return true;
    } catch {
      try { fs.unlinkSync(stalePath); } catch { /* another recovery may own it */ }
      return false;
    }
  }
}

/** Stable identity for the executable predicate, independent of its polling
 * policy. Different wake registrations for the same command/cwd therefore do
 * not execute concurrently across hosts. */
export function commandProbeKey(spec: Pick<CommandTrigger, 'command' | 'cwd'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: spec.command, cwd: spec.cwd }))
    .digest('hex');
}

function readArtifact(file: string): LeaseArtifact | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof value.key !== 'string'
      || typeof value.token !== 'string'
      || typeof value.ownerId !== 'string'
      || typeof value.ownerPid !== 'number'
      || typeof value.at !== 'string') return undefined;
    return {
      key: value.key,
      token: value.token,
      ownerId: value.ownerId,
      ownerPid: value.ownerPid,
      at: value.at,
    };
  } catch {
    return undefined;
  }
}

function removeOwnedArtifact(lease: CommandProbeLease): void {
  const current = readArtifact(lease.path);
  if (!current || current.token !== lease.token || current.key !== lease.key) return;
  try { fs.unlinkSync(lease.path); } catch { /* missing or foreign artifact */ }
}

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}
