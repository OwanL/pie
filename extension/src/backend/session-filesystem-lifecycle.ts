import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Int64Value } from '../../../shared/analytics/contracts.js';
import {
  SessionLifecycleConflictError,
  SessionLifecycleStore,
  type LifecycleArtifactRecord,
  type SessionCloseCause,
  type SessionCloseResolution,
  type SessionLifecycleRecord,
} from './session-lifecycle-store.js';

interface MutationLockOwner {
  schema: 1;
  pid: number;
  token: string;
  sessionId: string;
  acquiredAtMs: number;
}

const MAX_MUTATION_LOCK_TOKEN_LENGTH = 256;

function parseMutationLockOwner(value: unknown, expectedSessionId: string): MutationLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionLifecycleConflictError('Session mutation barrier owner evidence is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== 1
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid as number) <= 0
    || typeof candidate.token !== 'string'
    || candidate.token.length === 0
    || candidate.token.length > MAX_MUTATION_LOCK_TOKEN_LENGTH
    || candidate.token.includes('\u0000')
    || candidate.token.includes('/')
    || candidate.token.includes('\\')
    || candidate.sessionId !== expectedSessionId
    || typeof candidate.sessionId !== 'string'
    || candidate.sessionId.length === 0
    || candidate.sessionId.includes('\u0000')
    || !Number.isSafeInteger(candidate.acquiredAtMs)
    || (candidate.acquiredAtMs as number) < 0) {
    throw new SessionLifecycleConflictError(
      'Session mutation barrier owner evidence is invalid or bound to another session.',
    );
  }
  return {
    schema: 1,
    pid: candidate.pid as number,
    token: candidate.token as string,
    sessionId: candidate.sessionId as string,
    acquiredAtMs: candidate.acquiredAtMs as number,
  };
}

export interface SessionMutationBarrierOptions {
  store: SessionLifecycleStore;
  lockRoot: string;
  now?: () => number;
  processId?: number;
  processAlive?: (pid: number) => boolean;
  waitTimeoutMs?: number;
  retryDelayMs?: number;
}

export interface SessionWriteMutationOptions {
  expectedWriteEpoch?: number;
}

export interface AnalyticsLifecycleDeletionAdapter {
  deleteSession(
    rootSessionId: string,
    sourceKey: string,
    deletedAtMs: Int64Value,
    pendingOperationId?: string,
  ): Promise<unknown> | unknown;
}

export interface SessionCleanupRoots {
  [rootName: string]: string;
}

export interface SessionLifecycleCleanerOptions {
  store: SessionLifecycleStore;
  barrier: SessionFilesystemMutationBarrier;
  roots: SessionCleanupRoots;
  analytics?: AnalyticsLifecycleDeletionAdapter;
  cleanupExternalArtifact?: (artifact: LifecycleArtifactRecord) => Promise<void> | void;
  now?: () => number;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cross-process filesystem lock used by every transcript mutation and by the
 * close/delete owner. Close changes the durable epoch while holding this lock,
 * so a writer admitted before cutoff finishes first and every later writer
 * observes revocation before touching the filesystem. Dead owners are recovered
 * through an independently-created takeover directory. */
export class SessionFilesystemMutationBarrier {
  private readonly now: () => number;
  private readonly processId: number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly waitTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly held = new Map<string, { depth: number; token: string }>();

  constructor(private readonly options: SessionMutationBarrierOptions) {
    this.now = options.now ?? Date.now;
    this.processId = options.processId ?? process.pid;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 10;
    mkdirSync(options.lockRoot, { recursive: true, mode: 0o700 });
  }

  runWriteMutation<T>(
    sessionId: string,
    seam: string,
    mutation: () => T,
    options: SessionWriteMutationOptions = {},
  ): T {
    return this.runExclusive(sessionId, seam, () => {
      this.options.store.assertWritable(sessionId, options.expectedWriteEpoch);
      return mutation();
    });
  }

  runAdministrative<T>(sessionId: string, seam: string, operation: () => T): T {
    return this.runExclusive(sessionId, seam, operation);
  }

  async runWriteMutationAsync<T>(sessionId: string, seam: string, operation: () => Promise<T>): Promise<T> {
    return await this.runExclusiveAsync(sessionId, seam, () => {
      this.options.store.assertWritable(sessionId);
      return operation();
    });
  }

  async runAdministrativeAsync<T>(sessionId: string, seam: string, operation: () => Promise<T>): Promise<T> {
    return await this.runExclusiveAsync(sessionId, seam, operation);
  }

  private runExclusive<T>(sessionId: string, seam: string, operation: () => T): T {
    const key = lockKey(sessionId);
    const nested = this.held.get(key);
    if (nested) {
      nested.depth += 1;
      try {
        return operation();
      } finally {
        nested.depth -= 1;
      }
    }

    const token = randomUUID();
    const lockPath = path.join(this.options.lockRoot, `${key}.lock`);
    const startedAt = this.now();
    while (!this.tryAcquire(lockPath, sessionId, token)) {
      if (this.now() - startedAt >= this.waitTimeoutMs) {
        throw new SessionLifecycleConflictError(`Timed out acquiring session mutation barrier at ${seam}.`);
      }
      sleepSync(this.retryDelayMs);
    }
    this.held.set(key, { depth: 1, token });
    try {
      return operation();
    } finally {
      this.held.delete(key);
      this.release(lockPath, token);
    }
  }

  private async runExclusiveAsync<T>(sessionId: string, seam: string, operation: () => Promise<T>): Promise<T> {
    const key = lockKey(sessionId);
    const token = randomUUID();
    const lockPath = path.join(this.options.lockRoot, `${key}.lock`);
    const startedAt = this.now();
    while (!this.tryAcquire(lockPath, sessionId, token)) {
      if (this.now() - startedAt >= this.waitTimeoutMs) {
        throw new SessionLifecycleConflictError(`Timed out acquiring session mutation barrier at ${seam}.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
    try {
      return await operation();
    } finally {
      this.release(lockPath, token);
    }
  }

  private tryAcquire(lockPath: string, sessionId: string, token: string): boolean {
    const takeoverPath = `${lockPath}.takeover`;
    if (existsSync(takeoverPath)) {
      try {
        const takeoverOwner = parseMutationLockOwner(
          JSON.parse(readFileSync(path.join(takeoverPath, 'owner.json'), 'utf8')) as unknown,
          sessionId,
        );
        if (!this.processAlive(takeoverOwner.pid)) rmSync(takeoverPath, { recursive: true, force: true });
      } catch (error) {
        // Atomically published owner directories cannot be ownerless. Corrupt
        // takeover evidence fails closed instead of being reclaimed by time.
        if (error instanceof SessionLifecycleConflictError) throw error;
      }
      return false;
    }

    const owner: MutationLockOwner = {
      schema: 1,
      pid: this.processId,
      token,
      sessionId,
      acquiredAtMs: this.now(),
    };
    if (this.publishOwnerDirectory(lockPath, owner)) return true;
    if (!this.publishOwnerDirectory(takeoverPath, owner)) return false;
    try {
      let currentOwner: MutationLockOwner;
      try {
        currentOwner = parseMutationLockOwner(
          JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as unknown,
          sessionId,
        );
      } catch (error) {
        // The lock directory itself is atomically published. Missing/corrupt
        // owner evidence is unsafe corruption, never permission for takeover.
        if (error instanceof SessionLifecycleConflictError) throw error;
        throw new SessionLifecycleConflictError('Session mutation barrier owner evidence is unreadable.');
      }
      if (this.processAlive(currentOwner.pid)) return false;
      rmSync(lockPath, { recursive: true, force: true });
      return false;
    } finally {
      rmSync(takeoverPath, { recursive: true, force: true });
    }
  }

  private publishOwnerDirectory(targetPath: string, owner: MutationLockOwner): boolean {
    const candidatePath = `${targetPath}.candidate-${owner.token}`;
    try {
      mkdirSync(candidatePath, { mode: 0o700 });
      writeFileSync(path.join(candidatePath, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(candidatePath, targetPath);
      return true;
    } catch (error) {
      rmSync(candidatePath, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') return false;
      throw error;
    }
  }

  private release(lockPath: string, token: string): void {
    try {
      const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as MutationLockOwner;
      if (owner.token !== token || owner.pid !== this.processId) {
        throw new SessionLifecycleConflictError('Session mutation barrier ownership changed before release.');
      }
      rmSync(lockPath, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function resolveManagedArtifact(artifact: LifecycleArtifactRecord, roots: SessionCleanupRoots): string | undefined {
  if (artifact.locationKind === 'external') return undefined;
  if (artifact.locationKind === 'fixed_absolute') return path.resolve(artifact.location);
  const root = artifact.rootName ? roots[artifact.rootName] : undefined;
  if (!root) throw new Error(`Lifecycle root ${artifact.rootName ?? '<missing>'} is unavailable.`);
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, ...artifact.location.split('/'));
  const relative = path.relative(absoluteRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact ${artifact.artifactId} escapes or aliases its lifecycle root.`);
  }
  return candidate;
}

interface ArtifactIdentity {
  device: string;
  inode: string;
}

export function filesystemArtifactIdentity(absolutePath: string): string {
  const stat = lstatSync(absolutePath, { bigint: true });
  const identity: ArtifactIdentity = { device: stat.dev.toString(), inode: stat.ino.toString() };
  return JSON.stringify(identity);
}

function verifyTranscriptHeader(artifact: LifecycleArtifactRecord, absolutePath: string): void {
  if (artifact.kind !== 'transcript') return;
  const descriptor = openSync(absolutePath, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);
    if (newline < 0) throw new Error(`Transcript ${artifact.artifactId} has no bounded header line.`);
    const header = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { type?: unknown; id?: unknown };
    if (header.type !== 'session' || header.id !== artifact.sessionId) {
      throw new Error(`Transcript ${artifact.artifactId} header identity does not match ${artifact.sessionId}.`);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function verifyFilesystemArtifactIdentity(artifact: LifecycleArtifactRecord, absolutePath: string): void {
  verifyTranscriptHeader(artifact, absolutePath);
  if (!artifact.identityJson) return;
  let expected: ArtifactIdentity;
  try {
    expected = JSON.parse(artifact.identityJson) as ArtifactIdentity;
  } catch {
    throw new Error(`Artifact ${artifact.artifactId} has corrupt identity evidence.`);
  }
  const actual = JSON.parse(filesystemArtifactIdentity(absolutePath)) as ArtifactIdentity;
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`Artifact ${artifact.artifactId} identity changed; refusing unsafe deletion.`);
  }
}

/** Persisted, resumable deletion owner. Discovery is forbidden: it deletes
 * only explicitly-registered managed artifacts and the recorder's canonical
 * root subject. Missing owned paths are already complete; present targets must
 * retain their registered identity. */
export class SessionLifecycleCleaner {
  private readonly now: () => number;

  constructor(private readonly options: SessionLifecycleCleanerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Whether this cleaner can complete the coupled private analytics delete.
   * Cutoff admission uses the actual cleaner capability rather than a separate
   * caller flag, so a private close cannot be admitted with an unwired adapter. */
  get hasAnalyticsDeletionAdapter(): boolean {
    return typeof this.options.analytics?.deleteSession === 'function';
  }

  get analyticsDeletionAdapter(): AnalyticsLifecycleDeletionAdapter | undefined {
    return this.options.analytics;
  }

  async closeSession(
    sessionId: string,
    operationId: string,
    cause: SessionCloseCause = 'user_close',
  ): Promise<SessionCloseResolution> {
    const closed = this.options.barrier.runAdministrative(sessionId, 'session.close', () => {
      const current = this.options.store.get(sessionId);
      if (current?.privacyMode === 'on' && !this.hasAnalyticsDeletionAdapter) {
        throw new Error(`Private analytics deletion adapter is unavailable for ${sessionId}; refusing close.`);
      }
      return this.options.store.resolveClose(sessionId, operationId, this.now(), cause);
    });
    if (closed.disposition === 'delete' && closed.cleanupState !== 'deleted') {
      await this.cleanupSession(
        sessionId,
        closed.cleanupOperationId ?? operationId,
      );
    }
    return closed;
  }

  async cleanupSession(sessionId: string, requestedOperationId: string): Promise<SessionLifecycleRecord> {
    const claim = this.options.barrier.runAdministrative(sessionId, 'session.cleanup.claim', () => (
      this.options.store.claimCleanup(sessionId, requestedOperationId, this.now())
    ));
    if (claim.cleanupState === 'deleted') return claim;
    const operationId = claim.cleanupOperationId!;

    try {
      for (const artifact of this.options.store.listArtifacts(sessionId)) {
        if (artifact.state === 'deleted' || artifact.locationKind !== 'external') continue;
        if (!this.options.cleanupExternalArtifact) {
          throw new Error(`No cleanup adapter owns external artifact ${artifact.artifactId}.`);
        }
        const deleting = this.options.barrier.runAdministrative(sessionId, 'session.cleanup.external.claim', () => (
          this.options.store.markArtifactDeleting(sessionId, artifact.artifactId, operationId, this.now())
        ));
        await this.options.cleanupExternalArtifact(deleting);
        this.options.barrier.runAdministrative(sessionId, 'session.cleanup.external.commit', () => {
          this.options.store.markArtifactResult(sessionId, artifact.artifactId, operationId, 'deleted', this.now());
        });
      }
      if (claim.disposition === 'delete' && !this.options.analytics) {
        throw new Error(`Private analytics deletion adapter is unavailable for ${sessionId}.`);
      }
      if (claim.disposition === 'delete' && this.options.analytics) {
        await this.options.analytics.deleteSession(
          sessionId,
          `session-lifecycle:${operationId}`,
          claim.closedAtMs!,
          claim.pendingCreateOperationId,
        );
      }
      this.options.barrier.runAdministrative(sessionId, 'session.cleanup.filesystem', () => {
        for (const artifact of this.options.store.listArtifacts(sessionId)) {
          if (artifact.state === 'deleted' || artifact.locationKind === 'external') continue;
          const deleting = this.options.store.markArtifactDeleting(sessionId, artifact.artifactId, operationId, this.now());
          const artifactPath = resolveManagedArtifact(deleting, this.options.roots)!;
          if (!existsSync(artifactPath)) {
            this.options.store.markArtifactResult(sessionId, artifact.artifactId, operationId, 'deleted', this.now());
            continue;
          }
          const stat = lstatSync(artifactPath);
          if (!stat.isFile() && !stat.isDirectory()) {
            throw new Error(`Registered artifact is not a regular file or directory: ${artifact.artifactId}`);
          }
          verifyFilesystemArtifactIdentity(deleting, artifactPath);
          if (stat.isDirectory()) rmSync(artifactPath, { recursive: true, force: false });
          else unlinkSync(artifactPath);
          this.options.store.markArtifactResult(sessionId, artifact.artifactId, operationId, 'deleted', this.now());
        }
        this.options.store.markDeleted(sessionId, this.now(), operationId);
      });
      return this.options.store.get(sessionId)!;
    } catch (error) {
      this.options.store.markCleanupBlocked(sessionId, operationId, errorMessage(error), this.now());
      throw error;
    }
  }

  async runDue(limit = 100): Promise<{ deleted: string[]; blocked: Array<{ sessionId: string; error: string }> }> {
    const deleted: string[] = [];
    const blocked: Array<{ sessionId: string; error: string }> = [];
    for (const record of this.options.store.listDue(this.now(), limit)) {
      try {
        const operationId = record.cleanupOperationId ?? `expiry:${record.sessionId}:${record.expiresAtMs}`;
        await this.cleanupSession(record.sessionId, operationId);
        deleted.push(record.sessionId);
      } catch (error) {
        blocked.push({ sessionId: record.sessionId, error: errorMessage(error) });
      }
    }
    return { deleted, blocked };
  }
}

export interface SessionExpirySchedulerOptions {
  cleaner: SessionLifecycleCleaner;
  store: SessionLifecycleStore;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  maximumDelayMs?: number;
  idlePollMs?: number;
  onError?: (error: unknown) => void;
}

/** Deadline-driven scheduler; no interval scan. It remains inert until start()
 * and is therefore safe to wire behind the separately-authorized P7b gate. */
export class SessionExpiryScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private task: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SessionExpirySchedulerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<SessionExpirySchedulerOptions['clearTimer']>;
  private readonly maximumDelayMs: number;
  private readonly idlePollMs: number;

  constructor(private readonly options: SessionExpirySchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.maximumDelayMs = options.maximumDelayMs ?? 2_147_483_647;
    this.idlePollMs = options.idlePollMs ?? 60_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.task = this.runAndReschedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    await this.task;
  }

  notifyDeadlineChanged(): void {
    if (!this.running) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    const next = this.options.store.nextExpiry();
    const remaining = next === undefined ? undefined : BigInt(next) - BigInt(this.now());
    const delay = remaining === undefined
      ? this.idlePollMs
      : remaining <= 0n
        ? 0
        : Number(remaining > BigInt(this.maximumDelayMs) ? BigInt(this.maximumDelayMs) : remaining);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.task = this.runAndReschedule();
    }, delay);
  }

  private async runAndReschedule(): Promise<void> {
    try {
      await this.options.cleaner.runDue();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.schedule();
    }
  }
}
