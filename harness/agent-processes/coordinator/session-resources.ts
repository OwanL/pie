import { randomUUID } from 'node:crypto';

export type SessionResourceMode = 'exclusive' | 'shared';
export type SessionResourceLeaseState =
  | 'reserved'
  | 'active'
  | 'expired-unstarted'
  | 'expired-active'
  | 'orphaned'
  | 'released'
  | 'reclaimed';

export type SessionResourceAction = 'status' | 'acquire' | 'start' | 'renew' | 'release' | 'reclaim';

export interface SessionResourceRequest {
  owner: string;
  ownerAddress?: string;
  ownerTitle?: string;
  action: SessionResourceAction;
  name?: string;
  purpose?: string;
  leaseId?: string;
  mode?: SessionResourceMode;
  ttlMs?: number;
  startWithinMs?: number;
  reason?: string;
  confirmStopped?: boolean;
}

export interface SessionResourceLeaseView {
  leaseId: string;
  owner: string;
  ownerAddress?: string;
  ownerTitle?: string;
  /** Tombstone retained after the owner is privately deleted. */
  ownerDeleted?: true;
  purpose?: string;
  mode: SessionResourceMode;
  ttlMs: number;
  state: SessionResourceLeaseState;
  acquiredAt: number;
  startBy: number;
  startedAt?: number;
  expiresAt?: number;
  retiredAt?: number;
  releasedAt?: number;
  reclaimedAt?: number;
  reclaimedBy?: string;
  reclaimReason?: string;
}

export interface SessionResourceView {
  name: string;
  holders: readonly SessionResourceLeaseView[];
}

export interface SessionResourceAvailabilityChange {
  name: string;
  /** Monotonic within this coordinator process; useful for ordering observations. */
  revision: number;
  cause: 'released' | 'reclaimed' | 'reserved-expired' | 'owner-retired';
}

export type SessionResourceResult =
  | { action: 'status'; now: number; revision: number; resources: readonly SessionResourceView[] }
  | { action: 'acquire'; outcome: 'acquired'; now: number; lease: SessionResourceLeaseView }
  | { action: 'acquire'; outcome: 'busy'; now: number; name: string; conflicts: readonly SessionResourceLeaseView[] }
  | { action: 'start' | 'renew'; outcome: 'succeeded'; now: number; lease: SessionResourceLeaseView }
  | { action: 'release'; outcome: 'released' | 'already_released'; now: number; lease: SessionResourceLeaseView }
  | { action: 'reclaim'; outcome: 'reclaimed'; now: number; lease: SessionResourceLeaseView };

type Lease = SessionResourceLeaseView;

interface Resource {
  name: string;
  leaseIds: Set<string>;
}

const MAX_RESOURCES = 128;
const MAX_HOLDERS = 256;
const MAX_TERMINAL_RECEIPTS = 256;
const MAX_NAME_LENGTH = 96;
const MAX_OWNER_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 768;
const MAX_TITLE_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 240;
const MAX_REASON_LENGTH = 240;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 60 * 1_000;
const MIN_START_WITHIN_MS = 1_000;
const MAX_START_WITHIN_MS = 5 * 60 * 1_000;
const DEFAULT_START_WITHIN_MS = 30 * 1_000;

/** Resource names are trimmed and lowercased identically at every ingress.
 * Count Unicode code points (including astral characters as one), and reject
 * lowercasing expansions that would exceed the same canonical-name bound. */
export function normalizeSessionResourceName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name must be a non-empty string of at most 96 Unicode characters.');
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > MAX_NAME_LENGTH) {
    throw new Error('name must be a non-empty string of at most 96 Unicode characters after trimming.');
  }
  const canonical = trimmed.toLowerCase();
  if (Array.from(canonical).length > MAX_NAME_LENGTH) {
    throw new Error('name must remain at most 96 Unicode characters after lowercase normalization.');
  }
  return canonical;
}

/**
 * Coordinator-lifetime cooperative reservations. These records coordinate
 * callers that honor the API; they do not lock files or stop OS processes.
 * An expired active lease remains conflicting until its owner releases it or
 * an authorized caller explicitly reclaims it after verifying work stopped.
 */
export class SessionResourceRegistry {
  private readonly resources = new Map<string, Resource>();
  private readonly leases = new Map<string, Lease>();
  private readonly terminalLeaseIds: string[] = [];
  private readonly availabilityListeners = new Set<(change: SessionResourceAvailabilityChange) => void>();
  private readonly pendingAvailabilityChanges = new Map<string, SessionResourceAvailabilityChange['cause']>();
  private availabilityRevision = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Subscribe to availability-increasing changes, not ordinary lease renewal/status churn. */
  subscribeAvailability(listener: (change: SessionResourceAvailabilityChange) => void): () => void {
    if (typeof listener !== 'function') throw new Error('availability listener must be a function.');
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  /** Whether a new lease with this mode can coexist with every current holder. */
  isCompatible(nameValue: string, mode: SessionResourceMode = 'exclusive'): boolean {
    const name = this.readName(nameValue);
    if (mode !== 'exclusive' && mode !== 'shared') throw new Error('mode must be exclusive or shared.');
    try {
      const now = this.readNow();
      this.sweepAndPruneResources(now);
      const resource = this.resources.get(name);
      if (!resource) return true;
      return ![...resource.leaseIds]
        .map((id) => this.leases.get(id))
        .some((lease) => lease !== undefined && this.isConflictHolder(lease)
          && (mode === 'exclusive' || lease.mode === 'exclusive'));
    } finally {
      this.flushAvailabilityChanges();
    }
  }

  /** Earliest still-live reservation deadline, for one coordinator timer. */
  nextReservedExpiry(): number | undefined {
    let deadline: number | undefined;
    for (const lease of this.leases.values()) {
      if (lease.state === 'reserved' && (deadline === undefined || lease.startBy < deadline)) deadline = lease.startBy;
    }
    return deadline;
  }

  /** Materialize deadline expiry and emit any newly available resource names. */
  sweepExpired(): void {
    try {
      this.sweepAndPruneResources(this.readNow());
    } finally {
      this.flushAvailabilityChanges();
    }
  }

  execute(request: SessionResourceRequest): SessionResourceResult {
    const owner = this.readRequiredString(request.owner, 'owner', MAX_OWNER_LENGTH);
    const address = request.ownerAddress === undefined
      ? undefined
      : this.readBoundedUtf8String(request.ownerAddress, 'ownerAddress', MAX_ADDRESS_LENGTH);
    const title = request.ownerTitle === undefined
      ? undefined
      : this.readBoundedUtf8String(request.ownerTitle, 'ownerTitle', MAX_TITLE_LENGTH);
    try {
      switch (request.action) {
        case 'status':
          return this.status(request.name === undefined ? undefined : this.readName(request.name));
        case 'acquire':
          return this.acquire(owner, address, title, request);
        case 'start':
          return this.start(owner, this.readLeaseId(request.leaseId));
        case 'renew':
          return this.renew(owner, this.readLeaseId(request.leaseId), this.readTtl(request.ttlMs));
        case 'release':
          return this.release(owner, this.readLeaseId(request.leaseId));
        case 'reclaim':
          return this.reclaim(owner, this.readLeaseId(request.leaseId), request.confirmStopped,
            this.readRequiredString(request.reason, 'reason', MAX_REASON_LENGTH));
        default:
          throw new Error('action must be status, acquire, start, renew, release, or reclaim.');
      }
    } finally {
      this.flushAvailabilityChanges();
    }
  }

  /** Retire an owner's leases when its worker identity is definitively gone. */
  retireOwner(ownerValue: string, options: { deleted?: boolean } = {}): void {
    const owner = this.readRequiredString(ownerValue, 'owner', MAX_OWNER_LENGTH);
    if (options === null || typeof options !== 'object' || (options.deleted !== undefined && typeof options.deleted !== 'boolean')) {
      throw new Error('retireOwner options.deleted must be a boolean when provided.');
    }
    const now = this.readNow();
    try {
      for (const lease of this.leases.values()) {
        if (lease.owner !== owner) continue;
        if (lease.state === 'reserved') {
          lease.state = 'expired-unstarted';
          this.rememberTerminal(lease.leaseId);
          this.markAvailabilityChanged(this.resourceName(lease.leaseId), 'owner-retired');
        } else if (lease.state === 'active' || lease.state === 'expired-active') {
          lease.state = 'orphaned';
          lease.retiredAt = now;
        }
        if (options.deleted === true) this.redactDeletedOwner(lease);
      }
      this.sweepAndPruneResources(now);
    } finally {
      this.flushAvailabilityChanges();
    }
  }

  private status(name?: string): SessionResourceResult {
    const now = this.readNow();
    this.sweepAndPruneResources(now);
    const resources = [...this.resources.values()]
      .filter((resource) => name === undefined || resource.name === name)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((resource) => ({
        name: resource.name,
        holders: [...resource.leaseIds]
          .map((id) => this.leases.get(id))
          .filter((lease): lease is Lease => lease !== undefined && this.isConflictHolder(lease))
          .sort((left, right) => left.acquiredAt - right.acquiredAt || left.leaseId.localeCompare(right.leaseId))
          .map((lease) => this.view(lease)),
      }));
    this.flushAvailabilityChanges();
    return { action: 'status', now, revision: this.availabilityRevision, resources };
  }

  private acquire(owner: string, address: string | undefined, title: string | undefined, request: SessionResourceRequest): SessionResourceResult {
    const name = this.readName(request.name);
    const purpose = this.readRequiredString(request.purpose, 'purpose', MAX_PURPOSE_LENGTH);
    const mode = request.mode ?? 'exclusive';
    if (mode !== 'exclusive' && mode !== 'shared') throw new Error('mode must be exclusive or shared.');
    const ttlMs = this.readTtl(request.ttlMs);
    const startWithinMs = this.readStartWithin(request.startWithinMs);
    const now = this.readNow();
    this.sweepAndPruneResources(now);

    let resource = this.resources.get(name);
    if (!resource) {
      if (this.resources.size >= MAX_RESOURCES) throw new Error('resource capacity is occupied; no reservation was created.');
      resource = { name, leaseIds: new Set() };
      this.resources.set(name, resource);
    }

    const conflicts = [...resource.leaseIds]
      .map((id) => this.leases.get(id))
      .filter((lease): lease is Lease => lease !== undefined && this.isConflictHolder(lease)
        && (mode === 'exclusive' || lease.mode === 'exclusive'));
    if (conflicts.length > 0) {
      return { action: 'acquire', outcome: 'busy', now, name,
        conflicts: conflicts.map((lease) => this.view(lease)) };
    }
    if (this.activeHolderCount() >= MAX_HOLDERS) {
      if (resource.leaseIds.size === 0) this.resources.delete(name);
      throw new Error('resource holder capacity is occupied; no reservation was created.');
    }
    this.pruneTerminalReceipts();

    const lease: Lease = {
      leaseId: randomUUID(),
      owner,
      ...(address !== undefined ? { ownerAddress: address } : {}),
      ...(title !== undefined ? { ownerTitle: title } : {}),
      purpose,
      mode,
      ttlMs,
      state: 'reserved',
      acquiredAt: now,
      startBy: now + startWithinMs,
    };
    resource.leaseIds.add(lease.leaseId);
    this.leases.set(lease.leaseId, lease);
    return { action: 'acquire', outcome: 'acquired', now, lease: this.view(lease) };
  }

  private start(owner: string, leaseId: string): SessionResourceResult {
    const now = this.readNow();
    this.sweepAndPruneResources(now);
    const lease = this.requireOwnedLease(owner, leaseId);
    if (lease.state === 'expired-unstarted') throw new Error('resource reservation expired before start; acquire a fresh lease.');
    if (lease.state !== 'reserved') throw new Error(`resource lease cannot start from state ${lease.state}.`);
    if (now >= lease.startBy) {
      lease.state = 'expired-unstarted';
      this.rememberTerminal(lease.leaseId);
      this.sweepAndPruneResources(now);
      throw new Error('resource reservation expired before start; acquire a fresh lease.');
    }
    lease.state = 'active';
    lease.startedAt = now;
    lease.expiresAt = now + lease.ttlMs;
    return { action: 'start', outcome: 'succeeded', now, lease: this.view(lease) };
  }

  private renew(owner: string, leaseId: string, ttlMs: number): SessionResourceResult {
    const now = this.readNow();
    this.sweepAndPruneResources(now);
    const lease = this.requireOwnedLease(owner, leaseId);
    if (lease.state === 'expired-active' || lease.state === 'orphaned') {
      throw new Error(`resource lease cannot renew from state ${lease.state}; release it or request explicit reclaim.`);
    }
    if (lease.state !== 'active') throw new Error(`resource lease cannot renew from state ${lease.state}.`);
    lease.ttlMs = ttlMs;
    lease.expiresAt = now + ttlMs;
    return { action: 'renew', outcome: 'succeeded', now, lease: this.view(lease) };
  }

  private release(owner: string, leaseId: string): SessionResourceResult {
    const now = this.readNow();
    this.sweepAndPruneResources(now);
    const lease = this.requireOwnedLease(owner, leaseId);
    if (lease.state === 'released') {
      return { action: 'release', outcome: 'already_released', now, lease: this.view(lease) };
    }
    if (lease.state === 'reclaimed') throw new Error('resource lease was reclaimed and cannot be released by its former owner.');
    const wasConflictHolder = this.isConflictHolder(lease);
    const resourceName = this.resourceName(leaseId);
    lease.state = 'released';
    lease.releasedAt = now;
    this.rememberTerminal(lease.leaseId);
    if (wasConflictHolder) this.markAvailabilityChanged(resourceName, 'released');
    this.sweepAndPruneResources(now);
    return { action: 'release', outcome: 'released', now, lease: this.view(lease) };
  }

  /** Explicit caller assertion for recovery; this does not stop or inspect a process. */
  private reclaim(owner: string, leaseId: string, confirmStopped: boolean | undefined, reason: string): SessionResourceResult {
    if (confirmStopped !== true) throw new Error('reclaim requires confirmStopped: true after the caller verifies work stopped.');
    const now = this.readNow();
    this.sweepAndPruneResources(now);
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error('resource lease is unavailable.');
    if (lease.state !== 'orphaned' && lease.state !== 'expired-active') {
      throw new Error(`resource lease cannot be reclaimed from state ${lease.state}.`);
    }
    const resourceName = this.resourceName(leaseId);
    lease.state = 'reclaimed';
    lease.reclaimedAt = now;
    lease.reclaimedBy = owner;
    lease.reclaimReason = reason;
    this.rememberTerminal(lease.leaseId);
    this.markAvailabilityChanged(resourceName, 'reclaimed');
    this.sweepAndPruneResources(now);
    return { action: 'reclaim', outcome: 'reclaimed', now, lease: this.view(lease) };
  }

  private requireOwnedLease(owner: string, leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error('resource lease is unavailable.');
    if (lease.owner !== owner) throw new Error('resource lease belongs to another owner.');
    return lease;
  }

  private sweepAndPruneResources(now: number): void {
    for (const lease of this.leases.values()) {
      if (lease.state === 'reserved' && now >= lease.startBy) {
        lease.state = 'expired-unstarted';
        this.rememberTerminal(lease.leaseId);
        this.markAvailabilityChanged(this.resourceName(lease.leaseId), 'reserved-expired');
      } else if (lease.state === 'active' && lease.expiresAt !== undefined && now >= lease.expiresAt) {
        lease.state = 'expired-active';
      }
    }
    for (const [name, resource] of this.resources) {
      for (const id of [...resource.leaseIds]) {
        const lease = this.leases.get(id);
        if (!lease || !this.isConflictHolder(lease)) resource.leaseIds.delete(id);
      }
      if (resource.leaseIds.size === 0) this.resources.delete(name);
    }
  }

  private isConflictHolder(lease: Lease): boolean {
    return lease.state === 'reserved' || lease.state === 'active'
      || lease.state === 'expired-active' || lease.state === 'orphaned';
  }

  private resourceName(leaseId: string): string {
    for (const resource of this.resources.values()) if (resource.leaseIds.has(leaseId)) return resource.name;
    return '';
  }

  private markAvailabilityChanged(name: string, cause: SessionResourceAvailabilityChange['cause']): void {
    if (name) this.pendingAvailabilityChanges.set(name, cause);
  }

  private flushAvailabilityChanges(): void {
    if (this.pendingAvailabilityChanges.size === 0) return;
    const changes = [...this.pendingAvailabilityChanges].map(([name, cause]) => ({
      name,
      revision: ++this.availabilityRevision,
      cause,
    }));
    this.pendingAvailabilityChanges.clear();
    for (const change of changes) for (const listener of [...this.availabilityListeners]) {
      try { listener(change); } catch { /* A watcher cannot invalidate a committed resource mutation. */ }
    }
  }

  private activeHolderCount(): number {
    let count = 0;
    for (const lease of this.leases.values()) if (this.isConflictHolder(lease)) count += 1;
    return count;
  }

  private rememberTerminal(leaseId: string): void {
    if (this.terminalLeaseIds.includes(leaseId)) return;
    this.terminalLeaseIds.push(leaseId);
    this.pruneTerminalReceipts();
  }

  private redactDeletedOwner(lease: Lease): void {
    delete lease.ownerAddress;
    delete lease.ownerTitle;
    delete lease.purpose;
    delete lease.reclaimReason;
    lease.ownerDeleted = true;
  }

  private pruneTerminalReceipts(): void {
    while (this.terminalLeaseIds.length > MAX_TERMINAL_RECEIPTS) {
      const oldest = this.terminalLeaseIds.shift();
      if (oldest) this.leases.delete(oldest);
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('clock must return a non-negative safe integer epoch millisecond.');
    return now;
  }

  private readTtl(value: number | undefined): number {
    const ttlMs = value ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
      throw new Error(`ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}.`);
    }
    return ttlMs;
  }

  private readStartWithin(value: number | undefined): number {
    const startWithinMs = value ?? DEFAULT_START_WITHIN_MS;
    if (!Number.isSafeInteger(startWithinMs) || startWithinMs < MIN_START_WITHIN_MS || startWithinMs > MAX_START_WITHIN_MS) {
      throw new Error(`startWithinMs must be an integer between ${MIN_START_WITHIN_MS} and ${MAX_START_WITHIN_MS}.`);
    }
    return startWithinMs;
  }

  private readRequiredString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || Array.from(trimmed).length > maxLength) {
      throw new Error(`${field} must be a non-empty string of at most ${maxLength} Unicode characters.`);
    }
    return trimmed;
  }

  private readOptionalString(value: unknown, field: string, maxLength: number): string | undefined {
    if (value === undefined) return undefined;
    return this.readRequiredString(value, field, maxLength);
  }

  private readBoundedUtf8String(value: unknown, field: string, maxBytes: number): string {
    if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value.trim(), 'utf8') > maxBytes) {
      throw new Error(`${field} must be a non-empty UTF-8 string of at most ${maxBytes} bytes.`);
    }
    return value.trim();
  }

  private readName(value: unknown): string {
    return normalizeSessionResourceName(value);
  }

  private readLeaseId(value: unknown): string {
    return this.readRequiredString(value, 'leaseId', 64);
  }

  private view(lease: Lease): SessionResourceLeaseView {
    return { ...lease };
  }
}
