import { randomUUID } from 'node:crypto';
import { link, open, readFile, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertChildToolRuntimeOwnerOpen,
  registerChildToolRuntimeCleanup,
  type ChildToolRuntimeOwner,
} from '../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';

export type DesktopRuntimeIdentity =
  | { readonly kind: 'persistent'; readonly sessionPath: string }
  | { readonly kind: 'child'; readonly owner: ChildToolRuntimeOwner };

export interface DesktopScope {
  readonly key: string;
  readonly label: string;
  readonly kind: 'primary' | 'child';
  readonly runtimeIdentity: DesktopRuntimeIdentity;
  status: 'open' | 'closing' | 'closed' | 'blocked';
  activeOperations: number;
  closePromise?: Promise<void>;
  closeKind?: 'settle' | 'shutdown';
  idleWaiters: Array<() => void>;
}

interface DesktopClaim {
  readonly scope: DesktopScope;
  readonly id: string;
  readonly label: string;
  readonly ownerPid: number;
  usable: boolean;
}

interface ClaimRecord {
  version?: number;
  claimId?: string;
  ownerLabel?: string;
  pid?: number;
}

function cleanLabel(label: string | undefined): string {
  const cleaned = (label ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  return cleaned || 'Pie desktop controller';
}

function coded(code: string, message: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function defaultClaimPath(): string {
  return path.join(os.tmpdir(), 'pie-computer-use', 'desktop-owner.lock');
}

/**
 * Process-wide plus cross-process exclusive ownership for the physical desktop.
 * The lock file is intentionally fail-closed: a crash leaves it behind, and
 * this module never infers staleness from a PID or removes another claim.
 */
export class DesktopCoordinator {
  private readonly scopes = new Map<string, DesktopScope>();
  private readonly primaryScopes = new Map<string, DesktopScope>();
  private readonly childScopes = new Map<string, DesktopScope>();
  private claim?: DesktopClaim;
  private acquiring?: Promise<void>;
  private acquiringScope?: DesktopScope;
  private generation = 0;

  constructor(readonly claimPath = defaultClaimPath()) {}

  beginPrimary(sessionPath: string, label: string): DesktopScope {
    const sessionKey = path.resolve(sessionPath);
    const previous = this.primaryScopes.get(sessionKey);
    if (previous?.status === 'open') return previous;
    if (previous?.status === 'closed') this.scopes.delete(previous.key);
    const scope = this.createScope(`primary:${sessionKey}:${++this.generation}`, label, 'primary', { kind: 'persistent', sessionPath: sessionKey });
    this.primaryScopes.set(sessionKey, scope);
    return scope;
  }

  primary(sessionPath: string, label: string): DesktopScope {
    const sessionKey = path.resolve(sessionPath);
    const existing = this.primaryScopes.get(sessionKey);
    if (existing) return existing;
    return this.beginPrimary(sessionKey, label);
  }

  findPrimary(sessionPath: string): DesktopScope | undefined {
    return this.primaryScopes.get(path.resolve(sessionPath));
  }

  child(owner: ChildToolRuntimeOwner, label: string, cleanup: (runtime: DesktopRuntimeIdentity) => Promise<void>): DesktopScope {
    assertChildToolRuntimeOwnerOpen(owner);
    const key = `child:${owner.id}`;
    const existing = this.childScopes.get(key);
    if (existing) return existing;
    const scope = this.createScope(key, label, 'child', { kind: 'child', owner });
    this.childScopes.set(key, scope);
    try {
      registerChildToolRuntimeCleanup(owner, 'computer-use-desktop-runtime', async () => {
        await this.shutdown(scope, cleanup);
      });
    } catch (error) {
      this.childScopes.delete(key);
      this.scopes.delete(key);
      throw error;
    }
    return scope;
  }

  findChild(owner: ChildToolRuntimeOwner): DesktopScope | undefined {
    return this.childScopes.get(`child:${owner.id}`);
  }

  async run<T>(
    scope: DesktopScope,
    operation: (runtime: DesktopRuntimeIdentity) => Promise<T>,
  ): Promise<T> {
    if (scope.status !== 'open') {
      throw coded('DESKTOP_OWNER_CLOSED', `Computer use is fenced because ${scope.label} is ${scope.status}. A new primary turn must start before this session can use the desktop again.`);
    }
    scope.activeOperations += 1;
    try {
      await this.acquire(scope);
      if (scope.status !== 'open') {
        throw coded('DESKTOP_OWNER_CLOSED', `Computer use is fenced because ${scope.label} is ${scope.status}.`);
      }
      return await operation(scope.runtimeIdentity);
    } finally {
      scope.activeOperations -= 1;
      if (scope.activeOperations === 0) {
        for (const resolve of scope.idleWaiters.splice(0)) resolve();
      }
    }
  }

  async settle(scope: DesktopScope, cleanup: (runtime: DesktopRuntimeIdentity) => Promise<void>): Promise<void> {
    await this.close(scope, cleanup, false);
  }

  async shutdown(scope: DesktopScope, cleanup: (runtime: DesktopRuntimeIdentity) => Promise<void>): Promise<void> {
    await this.close(scope, cleanup, true);
  }

  async shutdownAll(cleanup: (runtime: DesktopRuntimeIdentity) => Promise<void>): Promise<void> {
    const scopes = [...this.scopes.values()];
    // Fence all owners before awaiting any one cleanup, so no sibling can enter
    // while the process is draining another controller.
    for (const scope of scopes) if (scope.status !== 'closed') scope.status = 'closing';
    await Promise.all(scopes.map(async (scope) => await this.waitUntilIdle(scope)));
    const failures: unknown[] = [];
    // Persistent runtime identities can be shared by successive primary turns.
    // Serialize their sidecar shutdowns after every admitted operation drains.
    for (const scope of scopes) {
      try { await this.shutdown(scope, cleanup); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) {
      throw new AggregateError(failures, `Desktop shutdown could not safely release ownership. Verify the old controller is stopped and input is released before manual recovery at ${this.claimPath}.`);
    }
  }

  private createScope(key: string, label: string, kind: DesktopScope['kind'], runtimeIdentity: DesktopRuntimeIdentity): DesktopScope {
    const scope: DesktopScope = {
      key,
      label: cleanLabel(label),
      kind,
      runtimeIdentity,
      status: 'open',
      activeOperations: 0,
      idleWaiters: [],
    };
    this.scopes.set(key, scope);
    return scope;
  }

  private async acquire(scope: DesktopScope): Promise<void> {
    if (this.claim) {
      if (this.claim.scope !== scope) throw this.busyError(this.claim.label);
      if (!this.claim.usable) throw coded('DESKTOP_CLAIM_BLOCKED', `The desktop claim for ${scope.label} could not be written safely and remains held at ${this.claimPath}. Do not remove it until the controller is stopped and input is confirmed released.`, true);
      return;
    }
    if (this.acquiring) {
      if (this.acquiringScope !== scope) {
        throw this.busyError(this.acquiringScope?.label ?? 'another Pie desktop controller');
      }
      await this.acquiring;
      const acquired = this.currentClaim();
      if (acquired?.scope === scope && acquired.usable) return;
      if (acquired) throw this.busyError(acquired.label);
    }
    const attempt = this.createClaim(scope);
    this.acquiring = attempt;
    this.acquiringScope = scope;
    try {
      await attempt;
    } finally {
      if (this.acquiring === attempt) {
        this.acquiring = undefined;
        this.acquiringScope = undefined;
      }
    }
  }

  private currentClaim(): DesktopClaim | undefined {
    return this.claim;
  }

  private async createClaim(scope: DesktopScope): Promise<void> {
    await mkdir(path.dirname(this.claimPath), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const temporaryPath = `${this.claimPath}.${id}.tmp`;
    let ownsTemporaryPath = false;
    let failure: unknown;
    try {
      let handle;
      try {
        handle = await open(temporaryPath, 'wx', 0o600);
        ownsTemporaryPath = true;
      } catch (error) {
        throw coded('DESKTOP_CLAIM_UNAVAILABLE', `Could not create a private desktop claim candidate beside ${this.claimPath}: ${(error as Error)?.message ?? String(error)}. No desktop action was attempted.`, true);
      }

      const record = JSON.stringify({ version: 1, claimId: id, ownerLabel: scope.label, pid: process.pid, acquiredAt: new Date().toISOString() });
      try {
        await handle.writeFile(record);
        await handle.sync();
      } catch (error) {
        throw coded('DESKTOP_CLAIM_BLOCKED', `The desktop claim candidate could not be recorded safely for ${this.claimPath}: ${(error as Error)?.message ?? String(error)}. No desktop action was attempted.`, true);
      } finally {
        await handle.close();
      }

      try {
        // The sibling candidate is fully written and synced before the hard link
        // atomically publishes it under the exclusive claim name. Never fall
        // back to creating the destination before its metadata is complete.
        await link(temporaryPath, this.claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          let ownerLabel = 'another Pie desktop controller (claim details unavailable)';
          try {
            const existing = JSON.parse(await readFile(this.claimPath, 'utf8')) as ClaimRecord;
            if (typeof existing.ownerLabel === 'string') ownerLabel = cleanLabel(existing.ownerLabel);
          } catch {
            // Existing claims are never repaired or removed, including unknown
            // or legacy partial claims; recovery remains an explicit action.
          }
          throw this.busyError(ownerLabel);
        }
        throw coded('DESKTOP_CLAIM_UNAVAILABLE', `Could not atomically publish the exclusive desktop claim at ${this.claimPath}: ${(error as Error)?.message ?? String(error)}. No desktop action was attempted.`, true);
      }

      this.claim = { scope, id, label: scope.label, ownerPid: process.pid, usable: true };
    } catch (error) {
      failure = error;
    }

    if (ownsTemporaryPath) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && !failure) {
          failure = coded('DESKTOP_CLAIM_BLOCKED', `The published desktop claim at ${this.claimPath} is held, but its private candidate could not be removed at ${temporaryPath}: ${(error as Error)?.message ?? String(error)}.`, true);
        }
      }
    }
    if (failure) throw failure;
  }

  private busyError(ownerLabel: string): Error {
    return coded(
      'DESKTOP_BUSY',
      `The desktop is busy; current owner: “${cleanLabel(ownerLabel)}”. Computer use is globally exclusive and does not wait or take over. If that controller crashed, verify it is stopped and all held input is released before manually removing the claim file: ${this.claimPath}.`,
      true,
    );
  }

  private async close(scope: DesktopScope, cleanup: (runtime: DesktopRuntimeIdentity) => Promise<void>, shuttingDown: boolean): Promise<void> {
    const previous = scope.closePromise;
    const previousKind = scope.closeKind;
    if (scope.status === 'closed' && (!shuttingDown || !this.isCurrentScope(scope) || (!previous && previousKind === 'shutdown'))) return;
    if (scope.status !== 'closed') scope.status = 'closing';
    const work = (async () => {
      await previous?.catch(() => {});
      if (scope.status === 'closed' && (!shuttingDown || !this.isCurrentScope(scope) || (previous && previousKind === 'shutdown'))) return;
      scope.closeKind = shuttingDown ? 'shutdown' : 'settle';
      scope.status = 'closing';
      await this.waitUntilIdle(scope);
      try {
        await cleanup(scope.runtimeIdentity);
        if (this.claim?.scope === scope) await this.releaseClaim(this.claim);
        scope.status = 'closed';
        if (scope.kind === 'child') {
          this.scopes.delete(scope.key);
          this.childScopes.delete(scope.key);
        }
      } catch (error) {
        scope.status = 'blocked';
        const detail = (error as Error)?.message ?? String(error);
        throw coded(
          'DESKTOP_CLEANUP_BLOCKED',
          `Could not confirm safe desktop cleanup for ${scope.label}; desktop ownership is retained. ${detail} Verify the old controller is stopped and held input is released before manual recovery at ${this.claimPath}.`,
          true,
        );
      }
    })();
    scope.closePromise = work;
    try {
      await work;
    } finally {
      if (scope.closePromise === work) scope.closePromise = undefined;
    }
  }

  private isCurrentScope(scope: DesktopScope): boolean {
    if (scope.kind === 'child') return this.childScopes.get(scope.key) === scope;
    return scope.runtimeIdentity.kind === 'persistent'
      && this.primaryScopes.get(scope.runtimeIdentity.sessionPath) === scope;
  }

  private async waitUntilIdle(scope: DesktopScope): Promise<void> {
    if (scope.activeOperations === 0) return;
    await new Promise<void>((resolve) => scope.idleWaiters.push(resolve));
  }

  private async releaseClaim(claim: DesktopClaim): Promise<void> {
    if (!claim.usable) {
      throw coded('DESKTOP_CLEANUP_BLOCKED', `The desktop claim at ${this.claimPath} was not durably recorded and will not be removed automatically.`, true);
    }
    let record: ClaimRecord;
    try {
      record = JSON.parse(await readFile(this.claimPath, 'utf8')) as ClaimRecord;
    } catch (error) {
      throw coded('DESKTOP_CLEANUP_BLOCKED', `Could not verify the desktop claim before release at ${this.claimPath}: ${(error as Error)?.message ?? String(error)}.`, true);
    }
    if (record.claimId !== claim.id) {
      throw coded('DESKTOP_CLEANUP_BLOCKED', `The desktop claim at ${this.claimPath} no longer matches this controller; it was not removed.`, true);
    }
    await unlink(this.claimPath);
    if (this.claim === claim) this.claim = undefined;
  }
}

const DESKTOP_COORDINATOR_KEY = Symbol.for('pie.computer-use.desktop-coordinator.v1');
const globalState = globalThis as Record<PropertyKey, unknown>;
export const desktopCoordinator: DesktopCoordinator =
  (globalState[DESKTOP_COORDINATOR_KEY] as DesktopCoordinator | undefined)
  ?? (() => {
    const coordinator = new DesktopCoordinator();
    Object.defineProperty(globalState, DESKTOP_COORDINATOR_KEY, {
      value: coordinator,
      writable: false,
      configurable: false,
      enumerable: false,
    });
    return coordinator;
  })();

export function childRuntimeOwnerLabel(owner: ChildToolRuntimeOwner | undefined): string {
  return owner ? cleanLabel(owner.label) : 'Pie child agent';
}

