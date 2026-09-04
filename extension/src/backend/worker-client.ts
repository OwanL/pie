import * as cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import {
  establishWindowsProcessTreeGuardian,
  terminateProcessTree,
  type WindowsProcessTreeGuardian,
} from './process-tree';
import {
  attachBoundedWorkerIpcReader,
  BoundedWorkerIpcWriter,
  WORKER_IPC_COORDINATOR_TO_WORKER_FD,
  WORKER_IPC_WORKER_TO_COORDINATOR_FD,
  type WorkerIpcWriteTarget,
} from './worker-frame-io';
import {
  WORKER_IPC_VERSION,
  parseWorkerToCoordinatorFrame,
  type WorkerFrameBase,
  type WorkerFrameExpectation,
  type CoordinatorToWorkerFrameBody,
  type CoordinatorToWorkerRequestBody,
  type WorkerHeartbeatFrame,
  type WorkerIpcFrameDraft,
  type WorkerReadyFrame,
  type WorkerResponseResult,
  type WorkerToCoordinatorFrame,
  type WorkerToCoordinatorResponseFrame,
} from './worker-protocol';
import type { SdkPatchIdentity } from './sdk-patch-barrier';

export type WorkerClientStatus = 'new' | 'starting' | 'ready' | 'unresponsive' | 'stopping' | 'failed' | 'exited';

export interface WorkerClientScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const defaultScheduler: WorkerClientScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export interface WorkerClientOptions {
  workerEntryPath: string;
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  /** Compatibility spawn identity; defaults all isolated-runtime path identities. */
  sessionPath: string;
  rootSessionPath?: string;
  leasePath?: string;
  leaseRevision?: number;
  sdkPatchIdentity: SdkPatchIdentity;
  /** Session-scoped MCP override artifact forwarded as `--mcp-config` so the
   *  adapter's config discovery substitutes its highest-precedence layer for
   *  this session only. Optional — absent means default discovery. */
  mcpConfigPath?: string;
  heartbeatIntervalMs?: number;
  missedHeartbeatMs?: number;
  startupTimeoutMs?: number;
  /** Default deadline for one correlated coordinator -> worker request. */
  requestTimeoutMs?: number;
  diagnosticByteLimit?: number;
  env?: NodeJS.ProcessEnv;
  scheduler?: WorkerClientScheduler;
  spawn?: typeof cp.spawn;
  terminateTree?: typeof terminateProcessTree;
  onStateChange?: (snapshot: WorkerClientSnapshot) => void;
  /** Receives only the newly-arrived chunk, not the accumulated tail. The
   *  bounded tail remains available via `getSnapshot()` for crash diagnostics;
   *  re-emitting the full tail on every chunk made the coordinator's log grow
   *  quadratically and did synchronous `Buffer.concat` + `JSON.stringify` work
   *  on its event loop for every worker stderr write. */
  onDiagnostic?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Receives valid, current-generation frames not consumed by request correlation or liveness handling. */
  onFrame?: (frame: WorkerToCoordinatorFrame) => void;
}

export interface WorkerClientSnapshot {
  status: WorkerClientStatus;
  pid?: number;
  lastHeartbeatAt?: number;
  /** Last validated bounded worker checkpoint; never inferred after death. */
  lastHeartbeat?: WorkerHeartbeatFrame['heartbeat'];
  failure?: string;
  stdoutTail: string;
  stderrTail: string;
}

interface PendingResponse {
  expectedFrameKind: WorkerToCoordinatorFrame['kind'];
  expectedResultKind?: WorkerResponseResult['kind'];
  resolve: (frame: WorkerToCoordinatorFrame) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WorkerRequestOptions {
  timeoutMs?: number;
  /** Auxiliary latest-wins requests may treat a bounded local enqueue
   * rejection as a retryable publication failure instead of killing an
   * otherwise healthy worker generation. Descriptor/write failures remain
   * fatal regardless. */
  fatalOnEnqueueRejection?: boolean;
}

export class WorkerRequestTimeoutError extends Error {
  readonly code = 'WORKER_REQUEST_TIMEOUT';

  constructor(
    readonly requestId: string,
    readonly requestKind: CoordinatorToWorkerRequestBody['kind'],
    readonly timeoutMs: number,
  ) {
    super(`Worker ${requestKind} request ${requestId} did not respond within ${timeoutMs} ms.`);
    this.name = 'WorkerRequestTimeoutError';
  }
}

export class WorkerRequestEnqueueError extends Error {
  readonly code = 'WORKER_REQUEST_ENQUEUE_FAILED';

  constructor(
    readonly reason: 'invalid' | 'oversize' | 'capacity' | 'unavailable',
    readonly detail: string,
  ) {
    super(`Worker IPC frame could not be enqueued (${reason}: ${detail}).`);
    this.name = 'WorkerRequestEnqueueError';
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_EXPIRED_REQUEST_IDS = 256;

class DiagnosticTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8');
    if (value.length >= this.limit) {
      this.chunks = [value.subarray(value.length - this.limit)];
      this.bytes = this.limit;
      return;
    }
    this.chunks.push(value);
    this.bytes += value.length;
    while (this.bytes > this.limit && this.chunks.length > 0) {
      const excess = this.bytes - this.limit;
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asReadable(value: unknown): Readable | undefined {
  return value && typeof (value as Readable).on === 'function' && typeof (value as Readable).pipe === 'function'
    ? value as Readable
    : undefined;
}

function asWritable(value: unknown): Writable | undefined {
  return value && typeof (value as Writable).write === 'function' ? value as Writable : undefined;
}

export class WorkerClient {
  private readonly scheduler: WorkerClientScheduler;
  private readonly heartbeatIntervalMs: number;
  private readonly missedHeartbeatMs: number;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stdoutTail: DiagnosticTail;
  private readonly stderrTail: DiagnosticTail;
  private readonly terminateTree: typeof terminateProcessTree;
  private child?: cp.ChildProcess;
  private writer?: BoundedWorkerIpcWriter;
  private detachReader?: () => void;
  private frameBase?: Omit<WorkerFrameBase, 'seq'>;
  private readonly rootSessionPath: string;
  private expectedInboundSeq = 1;
  private readonly pending = new Map<string, PendingResponse>();
  /** A bounded tombstone set prevents a response that lost a deadline race
   *  from being treated as hostile, uncorrelated protocol traffic. */
  private readonly expiredRequestIds = new Set<string>();
  private readonly ready = deferred<WorkerReadyFrame['runtimeMetadata']>();
  private readonly exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  private startupTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private status: WorkerClientStatus = 'new';
  private lastHeartbeatAt?: number;
  private lastHeartbeat?: WorkerHeartbeatFrame['heartbeat'];
  private failure?: Error;
  private readySeen = false;
  private exitSeen = false;
  private killStarted?: Promise<void>;
  private processTreeGuardian?: WindowsProcessTreeGuardian;

  constructor(private readonly options: WorkerClientOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.rootSessionPath = options.rootSessionPath ?? options.sessionPath;
    const leaseRevision = options.leaseRevision ?? 1;
    if (!Number.isSafeInteger(leaseRevision) || leaseRevision <= 0) throw new Error('leaseRevision must be a positive safe integer.');
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    this.missedHeartbeatMs = options.missedHeartbeatMs ?? Math.max(3_000, this.heartbeatIntervalMs * 3);
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be a positive safe integer.');
    }
    const diagnosticByteLimit = options.diagnosticByteLimit ?? 64 * 1024;
    if (!Number.isSafeInteger(diagnosticByteLimit) || diagnosticByteLimit <= 0) throw new Error('diagnosticByteLimit must be positive.');
    this.stdoutTail = new DiagnosticTail(diagnosticByteLimit);
    this.stderrTail = new DiagnosticTail(diagnosticByteLimit);
    this.terminateTree = options.terminateTree ?? terminateProcessTree;
  }

  async start(): Promise<WorkerReadyFrame['runtimeMetadata']> {
    if (this.status !== 'new') throw new Error('WorkerClient.start may be called only once.');
    this.status = 'starting';
    this.notify();
    const args = [
      this.options.workerEntryPath,
      '--coordinator-generation', String(this.options.coordinatorGeneration),
      '--worker-id', this.options.workerId,
      '--worker-generation', String(this.options.workerGeneration),
      '--session-path', this.rootSessionPath,
      '--root-session-path', this.rootSessionPath,
      '--lease-path', this.options.leasePath ?? this.options.sessionPath,
      '--lease-revision', String(this.options.leaseRevision ?? 1),
      '--ipc-read-fd', String(WORKER_IPC_COORDINATOR_TO_WORKER_FD),
      '--ipc-write-fd', String(WORKER_IPC_WORKER_TO_COORDINATOR_FD),
      ...(this.options.mcpConfigPath ? ['--mcp-config', this.options.mcpConfigPath] : []),
    ];
    let child: cp.ChildProcess;
    try {
      child = (this.options.spawn ?? cp.spawn)(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), false);
      throw this.failure;
    }
    this.child = child;
    const outbound = asWritable(child.stdio[WORKER_IPC_COORDINATOR_TO_WORKER_FD]);
    const inbound = asReadable(child.stdio[WORKER_IPC_WORKER_TO_COORDINATOR_FD]);
    if (!child.pid || !outbound || !inbound) {
      this.fail(new Error('Spawned worker did not expose a PID and both inherited IPC descriptors.'), true);
      return await this.ready.promise;
    }
    this.frameBase = {
      ipcVersion: WORKER_IPC_VERSION,
      coordinatorGeneration: this.options.coordinatorGeneration,
      workerId: this.options.workerId,
      workerGeneration: this.options.workerGeneration,
      workerPid: child.pid,
      rootSessionPath: this.rootSessionPath,
      leasePath: this.options.leasePath ?? this.options.sessionPath,
      leaseRevision: this.options.leaseRevision ?? 1,
      sessionPath: this.rootSessionPath,
    };
    this.attachDiagnostics(child.stdout, 'stdout');
    this.attachDiagnostics(child.stderr, 'stderr');
    child.once('error', (error) => this.fail(error, true));
    child.once('exit', (code, signal) => { void this.handleExit(code, signal); });

    try {
      // Assignment happens before bootstrap, so the worker cannot execute user
      // runtime code or spawn descendants outside its private Windows Job.
      this.processTreeGuardian = await establishWindowsProcessTreeGuardian(child.pid);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), true);
      return await this.ready.promise;
    }

    const target: WorkerIpcWriteTarget = outbound;
    this.writer = new BoundedWorkerIpcWriter(target, { onFatal: (error) => this.fail(error, true) });
    outbound.once('error', (error) => this.writer?.handleDisconnect(error));
    outbound.once('close', () => {
      if (!this.exitSeen && this.status !== 'stopping') this.writer?.handleDisconnect();
    });
    this.detachReader = attachBoundedWorkerIpcReader(inbound, {
      onFrame: (message) => this.handleMessage(message),
      onFatal: (error) => this.fail(error, true),
      onEnd: () => {
        if (!this.exitSeen && this.status !== 'stopping') this.fail(new Error('Worker IPC read descriptor closed before process exit.'), true);
      },
    });

    this.startupTimer = this.scheduler.setTimeout(() => {
      this.fail(new Error(`Worker did not become ready within ${this.startupTimeoutMs} ms.`), true);
    }, this.startupTimeoutMs);
    this.startupTimer.unref?.();
    this.enqueue({
      ...this.frameBase,
      kind: 'bootstrap',
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      sdkPatchIdentity: this.options.sdkPatchIdentity,
    });
    return await this.ready.promise;
  }

  /** Send a closed coordinator frame while the transport supplies identity and sequence fields. */
  sendFrame(body: CoordinatorToWorkerFrameBody): boolean {
    if (!this.frameBase || !this.writer || this.exitSeen || this.status === 'failed') return false;
    return this.enqueue({ ...this.frameBase, ...body } as WorkerIpcFrameDraft);
  }

  /** Correlate any worker request with its exact dedicated response kind. */
  requestFrame<K extends WorkerToCoordinatorResponseFrame['kind']>(
    body: CoordinatorToWorkerRequestBody,
    expectedKind: K,
    options: WorkerRequestOptions = {},
  ): Promise<Extract<WorkerToCoordinatorResponseFrame, { kind: K }>> {
    if (!this.frameBase || !this.writer || this.exitSeen || this.status === 'failed') return Promise.reject(new Error('Worker is unavailable.'));
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('Worker request timeout must be a positive safe integer.'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending: PendingResponse = {
        expectedFrameKind: expectedKind,
        resolve: (frame) => resolve(frame as Extract<WorkerToCoordinatorResponseFrame, { kind: K }>),
        reject,
      };
      this.pending.set(requestId, pending);
      pending.timer = this.scheduler.setTimeout(() => {
        const expired = this.takePending(requestId);
        if (!expired) return;
        this.rememberExpiredRequest(requestId);
        if (this.status === 'ready') {
          this.status = 'unresponsive';
          this.notify();
        }
        expired.reject(new WorkerRequestTimeoutError(requestId, body.kind, timeoutMs));
      }, timeoutMs);
      pending.timer.unref?.();
      const accepted = this.enqueue(
        { ...this.frameBase!, ...body, requestId } as WorkerIpcFrameDraft,
        {
          fatalOnRejection: options.fatalOnEnqueueRejection !== false,
          onRejected: (error) => this.takePending(requestId)?.reject(error),
        },
      );
      if (!accepted) {
        this.takePending(requestId)?.reject(new Error('Worker IPC request was rejected.'));
      }
    });
  }

  /** Advance only the current lease identity; the spawned root remains immutable. */
  updateLeaseIdentity(leasePath: string, leaseRevision: number): void {
    if (!this.frameBase) throw new Error('Cannot update worker lease identity before spawn.');
    if (!leasePath || !Number.isSafeInteger(leaseRevision) || leaseRevision <= this.frameBase.leaseRevision) {
      throw new Error('Worker lease identity must advance to a non-empty path and higher revision.');
    }
    this.frameBase = { ...this.frameBase, leasePath, leaseRevision };
  }

  ping(): Promise<WorkerResponseResult> {
    return this.requestLegacy({ kind: 'command', operation: 'ping' });
  }

  interrupt(targetRequestId: string | undefined, reason: string): Promise<WorkerResponseResult> {
    return this.requestLegacy({ kind: 'interrupt', ...(targetRequestId ? { targetRequestId } : {}), reason });
  }

  async shutdown(reason: string): Promise<WorkerResponseResult> {
    if (this.status !== 'exited') {
      this.status = 'stopping';
      this.notify();
    }
    return await this.requestLegacy({ kind: 'shutdown', reason });
  }

  async forceKill(): Promise<void> {
    if (this.killStarted) return await this.killStarted;
    const pid = this.child?.pid;
    if (!pid) throw new Error('Cannot kill worker before its PID is known.');
    this.killStarted = (async () => {
      if (this.processTreeGuardian) {
        await this.processTreeGuardian.terminate();
      } else if (!this.exitSeen || process.platform !== 'win32') {
        await this.terminateTree(pid, { signal: 'SIGKILL' });
      }
    })();
    return await this.killStarted;
  }

  async waitForConfirmedExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exitSeen) return await this.exited.promise;
    return await new Promise((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => reject(new Error(`Worker exit was not confirmed within ${timeoutMs} ms.`)), timeoutMs);
      timer.unref?.();
      void this.exited.promise.then(
        (value) => { this.scheduler.clearTimeout(timer); resolve(value); },
        (error) => { this.scheduler.clearTimeout(timer); reject(error); },
      );
    });
  }

  getSnapshot(): WorkerClientSnapshot {
    return {
      status: this.status,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: this.lastHeartbeatAt }),
      ...(this.lastHeartbeat ? { lastHeartbeat: { ...this.lastHeartbeat } } : {}),
      ...(this.failure ? { failure: this.failure.message } : {}),
      stdoutTail: this.stdoutTail.toString(),
      stderrTail: this.stderrTail.toString(),
    };
  }

  private requestLegacy(draft: { kind: 'command'; operation: 'ping' } | { kind: 'interrupt'; targetRequestId?: string; reason: string } | { kind: 'shutdown'; reason: string }): Promise<WorkerResponseResult> {
    if (!this.frameBase || !this.writer || this.exitSeen || this.status === 'failed') return Promise.reject(new Error('Worker is unavailable.'));
    const requestId = randomUUID();
    const expectedResultKind: WorkerResponseResult['kind'] = draft.kind === 'command'
      ? 'pong'
      : draft.kind === 'interrupt'
        ? 'interrupted'
        : 'shutting-down';
    return new Promise<WorkerResponseResult>((resolve, reject) => {
      const pending: PendingResponse = {
        expectedFrameKind: 'response',
        expectedResultKind,
        resolve: (frame) => {
          if (frame.kind !== 'response') return reject(new Error(`Worker response ${requestId} has the wrong frame kind.`));
          if (frame.ok) resolve(frame.result);
          else reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        },
        reject,
      };
      this.pending.set(requestId, pending);
      pending.timer = this.scheduler.setTimeout(() => {
        const expired = this.takePending(requestId);
        if (!expired) return;
        this.rememberExpiredRequest(requestId);
        if (this.status === 'ready') {
          this.status = 'unresponsive';
          this.notify();
        }
        expired.reject(new WorkerRequestTimeoutError(requestId, draft.kind, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      pending.timer.unref?.();
      if (!this.sendFrame({ ...draft, requestId } as CoordinatorToWorkerFrameBody)) {
        this.takePending(requestId)?.reject(new Error('Worker IPC request was rejected.'));
      }
    });
  }

  private enqueue(
    draft: WorkerIpcFrameDraft,
    options: { fatalOnRejection?: boolean; onRejected?: (error: Error) => void } = {},
  ): boolean {
    const result = this.writer?.enqueue(draft, {
      onSettled: (settlement) => {
        if (settlement.status === 'failed') {
          const reason = settlement.error?.message ?? 'unknown write error';
          this.fail(new Error(`Worker IPC frame could not be sent (${reason}).`), true);
          return;
        }
        if (settlement.status !== 'rejected') return;
        const error = new WorkerRequestEnqueueError(settlement.reason, settlement.detail);
        if (options.fatalOnRejection === false) options.onRejected?.(error);
        else this.fail(error, true);
      },
    });
    return result?.accepted === true;
  }

  private handleMessage(message: unknown): void {
    if (!this.frameBase || this.exitSeen) return;
    const expectation: WorkerFrameExpectation = { ...this.frameBase, expectedSeq: this.expectedInboundSeq };
    const parsed = parseWorkerToCoordinatorFrame(message, expectation);
    if (parsed.status === 'stale') return;
    if (parsed.status === 'invalid') {
      this.fail(new Error(`Worker protocol ${parsed.reason}: ${parsed.detail}`), true);
      return;
    }
    this.expectedInboundSeq += 1;
    const frame = parsed.frame;
    if (frame.kind === 'ready') {
      if (this.readySeen) return this.fail(new Error('Worker sent duplicate ready.'), true);
      this.readySeen = true;
      if (this.startupTimer) this.scheduler.clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
      this.status = 'ready';
      this.noteHeartbeat();
      this.ready.resolve(frame.runtimeMetadata);
      this.notify();
      return;
    }
    if (!this.readySeen) return this.fail(new Error(`Worker sent ${frame.kind} before ready.`), true);
    if (frame.kind === 'heartbeat') {
      this.handleHeartbeat(frame);
      return;
    }
    if (frame.kind === 'fatal') {
      this.fail(new Error(`Worker fatal ${frame.error.code}: ${frame.error.message}`), true);
      return;
    }
    const requestId = 'requestId' in frame ? frame.requestId : undefined;
    if (requestId && this.expiredRequestIds.delete(requestId)) return;
    const pending = requestId ? this.takePending(requestId) : undefined;
    if (pending) {
      if (frame.kind === 'detail.error') {
        pending.reject(new Error(`${frame.code}: ${frame.message}`));
        try { this.options.onFrame?.(frame); } catch { /* router owns stream errors */ }
        return;
      }
      if (frame.kind !== pending.expectedFrameKind) {
        const error = new Error(`Worker response ${requestId} returned frame ${frame.kind}; expected ${pending.expectedFrameKind}.`);
        pending.reject(error);
        this.fail(error, true);
        return;
      }
      if (frame.kind === 'response' && frame.ok && pending.expectedResultKind
          && frame.result.kind !== pending.expectedResultKind) {
        const error = new Error(`Worker response ${requestId} returned ${frame.result.kind}; expected ${pending.expectedResultKind}.`);
        pending.reject(error);
        this.fail(error, true);
        return;
      }
      pending.resolve(frame);
      return;
    }
    if (frame.kind === 'response' || frame.kind === 'runtime.ready' || frame.kind === 'sync.ack'
      || frame.kind === 'detail.start' || frame.kind === 'detail.unsubscribed') {
      return this.fail(new Error(`Worker ${frame.kind} has unknown requestId ${frame.requestId}.`), true);
    }
    try { this.options.onFrame?.(frame); } catch { /* observer/router owns its failures */ }
  }

  private handleHeartbeat(frame: WorkerHeartbeatFrame): void {
    this.lastHeartbeat = { ...frame.heartbeat };
    this.noteHeartbeat();
    if (this.status === 'unresponsive') this.status = 'ready';
    this.notify();
  }

  private noteHeartbeat(): void {
    this.lastHeartbeatAt = this.scheduler.now();
    if (this.heartbeatTimer) this.scheduler.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      if (this.exitSeen || this.status === 'stopping' || this.status === 'failed') return;
      this.status = 'unresponsive';
      this.notify();
    }, this.missedHeartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private attachDiagnostics(stream: Readable | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    stream.on('data', (chunk: Buffer | string) => {
      const tail = name === 'stdout' ? this.stdoutTail : this.stderrTail;
      tail.append(chunk);
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      try { this.options.onDiagnostic?.(name, value); } catch { /* observer only */ }
    });
    stream.resume();
  }

  private fail(error: Error, kill: boolean): void {
    if (!this.failure) this.failure = error;
    if (!this.readySeen) this.rejectReadySeamlessly();
    if (!this.exitSeen) this.status = 'failed';
    if (this.startupTimer) this.scheduler.clearTimeout(this.startupTimer);
    if (this.heartbeatTimer) this.scheduler.clearTimeout(this.heartbeatTimer);
    this.startupTimer = undefined;
    this.heartbeatTimer = undefined;
    for (const requestId of [...this.pending.keys()]) this.takePending(requestId)?.reject(this.failure);
    this.expiredRequestIds.clear();
    this.notify();
    if (kill && this.child?.pid && !this.exitSeen) void this.forceKill().catch(() => undefined);
  }

  /**
   * Reject the ready deferred while marking it handled. If no caller is
   * awaiting (e.g. a synchronous spawn throw before start() awaits the
   * deferred), the bare rejection would surface as an unhandledRejection and
   * crash whoever spawned the client; awaiting callers still receive it.
   */
  private rejectReadySeamlessly(): void {
    this.ready.reject(this.failure ?? new Error('Worker never became ready.'));
    void this.ready.promise.catch(() => undefined);
  }

  private async handleExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.exitSeen) return;
    this.exitSeen = true;
    this.detachReader?.();
    this.detachReader = undefined;
    if (this.startupTimer) this.scheduler.clearTimeout(this.startupTimer);
    if (this.heartbeatTimer) this.scheduler.clearTimeout(this.heartbeatTimer);
    this.startupTimer = undefined;
    this.heartbeatTimer = undefined;
    if (!this.failure && this.status !== 'stopping') this.failure = new Error(`Worker exited unexpectedly (${code ?? signal ?? 'unknown'}).`);
    if (!this.readySeen) this.rejectReadySeamlessly();
    for (const requestId of [...this.pending.keys()]) {
      this.takePending(requestId)?.reject(this.failure ?? new Error('Worker exited.'));
    }
    this.expiredRequestIds.clear();
    try {
      if (this.processTreeGuardian) {
        await this.processTreeGuardian.terminate();
      } else {
        const rootPid = this.child?.pid;
        // POSIX process-group cleanup remains valid after its leader exits.
        if (rootPid && process.platform !== 'win32') await this.terminateTree(rootPid, { signal: 'SIGKILL' });
      }
    } catch (error) {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    }
    this.status = 'exited';
    this.exited.resolve({ code, signal });
    this.notify();
  }


  private notify(): void {
    try { this.options.onStateChange?.(this.getSnapshot()); } catch { /* observer only */ }
  }

  private takePending(requestId: string): PendingResponse | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    if (pending.timer) this.scheduler.clearTimeout(pending.timer);
    pending.timer = undefined;
    return pending;
  }

  private rememberExpiredRequest(requestId: string): void {
    this.expiredRequestIds.add(requestId);
    while (this.expiredRequestIds.size > MAX_EXPIRED_REQUEST_IDS) {
      const oldest = this.expiredRequestIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.expiredRequestIds.delete(oldest);
    }
  }
}
