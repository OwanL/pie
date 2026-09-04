import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  WorkerClient,
  type WorkerClientOptions,
  type WorkerClientSnapshot,
  type WorkerClientScheduler,
  type WorkerRequestOptions,
} from './worker-client';
import type {
  CoordinatorToWorkerFrameBody,
  CoordinatorToWorkerRequestBody,
  WorkerResponseResult,
  WorkerToCoordinatorFrame,
  WorkerToCoordinatorResponseFrame,
} from './worker-protocol';
import type { SdkPatchIdentity } from './sdk-patch-barrier';

export interface SupervisedWorkerClient {
  start(): Promise<{ mode: 'phase2'; startedAt: number }>;
  ping(): Promise<WorkerResponseResult>;
  interrupt(targetRequestId: string | undefined, reason: string): Promise<WorkerResponseResult>;
  shutdown(reason: string): Promise<WorkerResponseResult>;
  forceKill(): Promise<void>;
  waitForConfirmedExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  getSnapshot(): WorkerClientSnapshot;
  sendFrame?(body: CoordinatorToWorkerFrameBody): boolean;
  requestFrame?<K extends WorkerToCoordinatorResponseFrame['kind']>(
    body: CoordinatorToWorkerRequestBody,
    expectedKind: K,
    options?: WorkerRequestOptions,
  ): Promise<Extract<WorkerToCoordinatorResponseFrame, { kind: K }>>;
  updateLeaseIdentity?(leasePath: string, leaseRevision: number): void;
}

export interface WorkerSupervisorOptions {
  workerEntryPath: string;
  coordinatorGeneration: number;
  sdkPatchIdentity: SdkPatchIdentity;
  heartbeatIntervalMs?: number;
  missedHeartbeatMs?: number;
  startupTimeoutMs?: number;
  softInterruptGraceMs?: number;
  shutdownGraceMs?: number;
  exitConfirmationMs?: number;
  diagnosticByteLimit?: number;
  scheduler?: WorkerClientScheduler;
  clientFactory?: (options: WorkerClientOptions) => SupervisedWorkerClient;
  /** Per-session MCP override artifact passed to the worker adapter via
   *  `--mcp-config` (session-scoped server toggles). Undone/absent files fall
   *  back to plain config discovery — resolve truthiness at spawn. */
  mcpConfigPathFor?: (sessionPath: string) => string | undefined;
  onWorkerStateChange?: (
    sessionPath: string,
    snapshot: WorkerClientSnapshot,
    identity: { workerId: string; workerGeneration: number },
  ) => void;
  onWorkerFrame?: (
    sessionPath: string,
    frame: WorkerToCoordinatorFrame,
    identity: { workerId: string; workerGeneration: number },
  ) => void;
  onDiagnostic?: (sessionPath: string, stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface SupervisedWorker {
  workerId: string;
  workerGeneration: number;
  sessionPath: string;
  client: SupervisedWorkerClient;
}

function workerKey(sessionPath: string): string {
  const absolute = path.resolve(sessionPath);
  let canonical = absolute;
  try { canonical = fsSync.realpathSync.native(absolute); } catch { /* destination may not exist yet */ }
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

const scheduler: WorkerClientScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class WorkerSupervisor {
  private readonly workers = new Map<string, SupervisedWorker>();
  private readonly generations = new Map<string, number>();
  private readonly clock: WorkerClientScheduler;
  private disposed = false;
  private initialized = false;

  constructor(private readonly options: WorkerSupervisorOptions) {
    if (!Number.isSafeInteger(options.coordinatorGeneration) || options.coordinatorGeneration <= 0) {
      throw new Error('coordinatorGeneration must be a positive safe integer.');
    }
    this.clock = options.scheduler ?? scheduler;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Worker supervisor is disposed.');
    const artifact = await fs.stat(this.options.workerEntryPath);
    if (!artifact.isFile()) throw new Error(`Worker entry is not a file: ${this.options.workerEntryPath}`);
    this.initialized = true;
  }

  async startWorker(
    sessionPath: string,
    prepareOwnership?: (identity: { workerId: string; workerGeneration: number; sessionPath: string }) => Promise<{
      leasePath: string;
      leaseRevision: number;
    }>,
  ): Promise<SupervisedWorker> {
    if (!this.initialized) throw new Error('Worker supervisor is not initialized.');
    if (this.disposed) throw new Error('Worker supervisor is disposed.');
    const requestedKey = workerKey(sessionPath);
    const existing = this.workers.get(requestedKey);
    if (existing) throw new Error(`A worker generation already owns ${sessionPath}.`);
    const workerGeneration = (this.generations.get(requestedKey) ?? 0) + 1;
    this.generations.set(requestedKey, workerGeneration);
    const workerId = randomUUID();
    const assignment = await prepareOwnership?.({ workerId, workerGeneration, sessionPath });
    const clientOptions: WorkerClientOptions = {
      workerEntryPath: this.options.workerEntryPath,
      coordinatorGeneration: this.options.coordinatorGeneration,
      workerId,
      workerGeneration,
      sessionPath,
      rootSessionPath: sessionPath,
      mcpConfigPath: this.options.mcpConfigPathFor?.(sessionPath),
      leasePath: assignment?.leasePath ?? sessionPath,
      leaseRevision: assignment?.leaseRevision ?? 1,
      sdkPatchIdentity: this.options.sdkPatchIdentity,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      missedHeartbeatMs: this.options.missedHeartbeatMs,
      startupTimeoutMs: this.options.startupTimeoutMs,
      diagnosticByteLimit: this.options.diagnosticByteLimit,
      scheduler: this.clock,
      onStateChange: (snapshot) => this.options.onWorkerStateChange?.(
        sessionPath,
        snapshot,
        { workerId, workerGeneration },
      ),
      onFrame: (frame) => this.options.onWorkerFrame?.(
        sessionPath,
        frame,
        { workerId, workerGeneration },
      ),
      onDiagnostic: (stream, chunk) => this.options.onDiagnostic?.(sessionPath, stream, chunk),
    };
    const client = (this.options.clientFactory ?? ((value) => new WorkerClient(value)))(clientOptions);
    const routePath = assignment?.leasePath ?? sessionPath;
    const routeKey = workerKey(routePath);
    if (routeKey !== requestedKey && this.workers.has(routeKey)) {
      throw new Error(`A worker generation already owns ${routePath}.`);
    }
    const worker = { workerId, workerGeneration, sessionPath: routePath, client };
    this.workers.set(routeKey, worker);
    try {
      await client.start();
      return worker;
    } catch (error) {
      // A failed bootstrap generation is not replaceable until its process exit
      // is confirmed. This also handles malformed/closed startup IPC. A fork
      // that never acquired a PID has no process identity to confirm.
      if (client.getSnapshot().pid !== undefined) {
        await client.forceKill().catch(() => undefined);
        await client.waitForConfirmedExit(this.options.exitConfirmationMs ?? 5_000);
      }
      this.workers.delete(routeKey);
      throw error;
    }
  }

  getWorker(sessionPath: string): SupervisedWorker | undefined {
    return this.workers.get(workerKey(sessionPath));
  }

  listWorkers(): readonly SupervisedWorker[] {
    return [...this.workers.values()];
  }

  /** Atomically move coordinator lookup ownership after an SDK replacement.
   * The worker's protocol root remains immutable inside WorkerClient; only the
   * supervisor's public route key and current session identity advance. */
  rekeyWorker(sourcePath: string, destinationPath: string): void {
    const sourceKey = workerKey(sourcePath);
    const destinationKey = workerKey(destinationPath);
    const worker = this.workers.get(sourceKey);
    if (!worker) throw new Error(`No worker owns ${sourcePath}.`);
    const collision = this.workers.get(destinationKey);
    if (collision && collision !== worker) throw new Error(`A worker generation already owns ${destinationPath}.`);
    this.workers.delete(sourceKey);
    worker.sessionPath = destinationPath;
    this.workers.set(destinationKey, worker);
  }

  async ping(sessionPath: string): Promise<WorkerResponseResult> {
    const worker = this.requireWorker(sessionPath);
    return await worker.client.ping();
  }

  async interrupt(sessionPath: string, targetRequestId: string | undefined, reason: string): Promise<{ soft: boolean }> {
    const worker = this.requireWorker(sessionPath);
    try {
      const result = await this.withTimeout(
        worker.client.interrupt(targetRequestId, reason),
        this.options.softInterruptGraceMs ?? 2_000,
        'Worker soft interrupt grace expired.',
      );
      if (result.kind !== 'interrupted') throw new Error(`Unexpected interrupt response ${result.kind}.`);
      return { soft: true };
    } catch {
      await worker.client.forceKill();
      await worker.client.waitForConfirmedExit(this.options.exitConfirmationMs ?? 5_000);
      this.workers.delete(workerKey(sessionPath));
      return { soft: false };
    }
  }

  async stopWorker(sessionPath: string, reason = 'worker retirement'): Promise<void> {
    const worker = this.workers.get(workerKey(sessionPath));
    if (!worker) return;
    try {
      const result = await this.withTimeout(
        worker.client.shutdown(reason),
        this.options.shutdownGraceMs ?? 2_000,
        'Worker shutdown response grace expired.',
      );
      if (result.kind !== 'shutting-down') throw new Error(`Unexpected shutdown response ${result.kind}.`);
      await worker.client.waitForConfirmedExit(this.options.exitConfirmationMs ?? 5_000);
    } catch {
      await worker.client.forceKill();
      await worker.client.waitForConfirmedExit(this.options.exitConfirmationMs ?? 5_000);
    }
    this.workers.delete(workerKey(sessionPath));
  }

  async restartWorker(sessionPath: string, reason = 'explicit supervisor restart'): Promise<SupervisedWorker> {
    // stopWorker does not return until the owning ChildProcess emitted exit.
    // No command or side effect is retained or replayed into the replacement.
    await this.stopWorker(sessionPath, reason);
    return await this.startWorker(sessionPath);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const paths = [...this.workers.keys()];
    await Promise.allSettled(paths.map((sessionPath) => this.stopWorker(sessionPath, 'coordinator shutdown')));
    if (this.workers.size > 0) {
      throw new Error(`Worker supervisor could not confirm exit for ${this.workers.size} worker(s).`);
    }
  }

  private requireWorker(sessionPath: string): SupervisedWorker {
    const worker = this.workers.get(workerKey(sessionPath));
    if (!worker) throw new Error(`No worker owns ${sessionPath}.`);
    return worker;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.clock.setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) this.clock.clearTimeout(timer);
    }
  }
}
