import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { attachJsonlLineReader } from '../shared/jsonl';
import {
  SESSION_SNAPSHOT_TOO_LARGE_CODE,
  type DetailResult,
  type LazyDetailRef,
  type SessionOpenedPayload,
  type TranscriptPageDirection,
  type TranscriptPagePayload,
} from '../shared/protocol';
import { SessionSnapshotTooLargeError } from '../shared/transcript-window';
import {
  COLD_BROWSE_HELPER_MAX_FRAME_BYTES,
  COLD_BROWSE_HELPER_PROTOCOL_VERSION,
  type ColdBrowseHelperFence,
  type ColdBrowseHelperInputFrame,
  type ColdBrowseHelperOpenOptions,
  type ColdBrowseHelperOperation,
  type ColdBrowseHelperOutputFrame,
  type ColdBrowseHelperPageOptions,
  type ColdBrowseHelperSuccessFrame,
} from './cold-browse-helper-protocol';
import type { SdkPatchIdentity } from './sdk-patch-barrier';

export interface ColdBrowseHelper {
  warm(): Promise<void>;
  openSnapshot(fence: ColdBrowseHelperFence, options: ColdBrowseHelperOpenOptions): Promise<SessionOpenedPayload>;
  loadPage(
    fence: ColdBrowseHelperFence,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options?: ColdBrowseHelperPageOptions,
  ): Promise<TranscriptPagePayload>;
  loadDetail(fence: ColdBrowseHelperFence, ref: LazyDetailRef): Promise<DetailResult>;
  invalidatePath(sessionPathKey: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ColdBrowseHelperRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
    readonly fingerprint?: string,
  ) {
    super(message);
    this.name = 'ColdBrowseHelperRequestError';
  }
}

interface PendingRequest {
  readonly operation: ColdBrowseHelperOperation;
  resolve(frame: ColdBrowseHelperSuccessFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelperGeneration {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<void>;
  readonly exited: Deferred<void>;
  readonly shutdown: Deferred<void>;
  readonly pending: Map<string, PendingRequest>;
  detachReader?: () => void;
  startupTimer?: ReturnType<typeof setTimeout>;
  failed: boolean;
  readySeen: boolean;
  shutdownRequested: boolean;
  shutdownSeen: boolean;
  diagnosticBytes: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export interface ColdBrowseHelperClientOptions {
  readonly entryPath: string;
  /** Additional child arguments for isolated transport fixtures only. */
  readonly entryArgs?: readonly string[];
  readonly sdkPath: string;
  readonly sdkPatchIdentity: SdkPatchIdentity;
  readonly startupCwd: string;
  readonly nodePath?: string;
  readonly parentPid?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxSourceBytes?: number;
  readonly maxEntries?: number;
  readonly spawnProcess?: typeof spawn;
  readonly onDiagnostic?: (chunk: string) => void;
}

/** Persistent, restartable client for the read-only browse helper process. */
export class ColdBrowseHelperClient implements ColdBrowseHelper {
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private current?: HelperGeneration;
  private starting?: Promise<HelperGeneration>;
  private nextRequestId = 1;
  private disposed = false;

  constructor(private readonly options: ColdBrowseHelperClientOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000;
    for (const [name, value] of [
      ['startup', this.startupTimeoutMs],
      ['request', this.requestTimeoutMs],
      ['shutdown', this.shutdownTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Cold browse helper ${name} timeout must be a positive safe integer.`);
      }
    }
  }

  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  async openSnapshot(
    fence: ColdBrowseHelperFence,
    options: ColdBrowseHelperOpenOptions,
  ): Promise<SessionOpenedPayload> {
    return await this.request({ operation: 'open', fence, options }) as SessionOpenedPayload;
  }

  async loadPage(
    fence: ColdBrowseHelperFence,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options: ColdBrowseHelperPageOptions = {
      transport: { kind: 'response', requestId: 'cold-browse-helper' },
    },
  ): Promise<TranscriptPagePayload> {
    return await this.request({
      operation: 'page',
      fence,
      direction,
      loadedStart,
      loadedEnd,
      options,
    }) as TranscriptPagePayload;
  }

  async loadDetail(fence: ColdBrowseHelperFence, ref: LazyDetailRef): Promise<DetailResult> {
    return await this.request({ operation: 'detail', fence, ref }) as DetailResult;
  }

  async invalidatePath(sessionPathKey: string): Promise<void> {
    // No child means no off-process transcript cache to reclaim. Mutations
    // must never start the helper merely to invalidate an empty cache.
    if ((!this.current || this.current.failed) && !this.starting) return;
    await this.request({ operation: 'invalidate', sessionPathKey });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const generation = this.current ?? await this.starting?.catch(() => undefined);
    if (!generation) return;
    clearTimeout(generation.startupTimer);
    if (!generation.failed && !hasExited(generation.child)) {
      generation.shutdownRequested = true;
      this.writeFrame(generation, {
        protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
        kind: 'shutdown',
      });
      await Promise.race([
        generation.shutdown.promise,
        generation.exited.promise,
        delay(this.shutdownTimeoutMs),
      ]).catch(() => undefined);
    }

    // A shutdown acknowledgement is not proof of process exit. Closing stdin
    // lets a healthy helper drain naturally; a bounded kill closes the orphan
    // edge when an SDK handle or fixture keeps the child alive on Windows.
    generation.child.stdin.end();
    if (await waitForExit(generation, this.shutdownTimeoutMs)) return;
    generation.child.kill();
    generation.child.stdin.destroy();
    if (!await waitForExit(generation, this.shutdownTimeoutMs)) {
      throw new Error('Cold browse helper did not exit after termination.');
    }
  }

  private async request(payload: ColdBrowseHelperOperation): Promise<unknown> {
    const generation = await this.ensureStarted();
    const requestId = `browse-${this.nextRequestId++}`;
    const result = deferred<ColdBrowseHelperSuccessFrame>();
    // The helper intentionally serializes projection mutations and reads. A
    // later request receives one timeout budget per request already ahead of
    // it, so it cannot expire merely while waiting its FIFO turn.
    const timeoutMs = Math.min(
      2_147_483_647,
      this.requestTimeoutMs * (generation.pending.size + 1),
    );
    const timer = setTimeout(() => {
      const pending = generation.pending.get(requestId);
      if (!pending) return;
      generation.pending.delete(requestId);
      const error = new Error(`Cold browse helper request timed out: ${requestId}`);
      pending.reject(error);
      this.failGeneration(generation, error, true);
    }, timeoutMs);
    timer.unref?.();
    generation.pending.set(requestId, {
      operation: payload,
      resolve: result.resolve,
      reject: result.reject,
      timer,
    });
    this.writeFrame(generation, {
      protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
      kind: 'request',
      requestId,
      payload,
    });
    const frame = await result.promise;
    return frame.result;
  }

  private async ensureStarted(): Promise<HelperGeneration> {
    if (this.disposed) throw new Error('Cold browse helper client is disposed.');
    if (this.current && !this.current.failed) {
      await this.current.ready.promise;
      return this.current;
    }
    if (!this.starting) {
      const starting = this.startGeneration();
      this.starting = starting;
      void starting.finally(() => {
        if (this.starting === starting) this.starting = undefined;
      }).catch(() => undefined);
    }
    return await this.starting;
  }

  private async startGeneration(): Promise<HelperGeneration> {
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(
      this.options.nodePath ?? process.execPath,
      [this.options.entryPath, ...(this.options.entryArgs ?? [])],
      {
        cwd: this.options.startupCwd,
        env: { ...process.env, PIE_COLD_BROWSE_HELPER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    const generation: HelperGeneration = {
      child,
      ready: deferred<void>(),
      exited: deferred<void>(),
      shutdown: deferred<void>(),
      pending: new Map(),
      failed: false,
      readySeen: false,
      shutdownRequested: false,
      shutdownSeen: false,
      diagnosticBytes: 0,
    };
    this.current = generation;
    generation.detachReader = attachJsonlLineReader(child.stdout, (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        this.failGeneration(generation, new Error(`Malformed cold browse helper JSONL: ${String(error)}`), true);
        return;
      }
      this.handleOutput(generation, value);
    }, {
      maxLineBytes: COLD_BROWSE_HELPER_MAX_FRAME_BYTES - 1,
      emitTrailingLineOnEnd: false,
      onOverflow: () => this.failGeneration(generation, new Error('Cold browse helper response exceeded its frame limit.'), true),
      onIncomplete: () => this.failGeneration(generation, new Error('Cold browse helper response ended mid-frame.'), true),
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const remaining = Math.max(0, (64 * 1024) - generation.diagnosticBytes);
      if (remaining === 0) return;
      const bounded = bytes.subarray(0, remaining);
      generation.diagnosticBytes += bounded.byteLength;
      this.options.onDiagnostic?.(bounded.toString('utf8'));
    });
    child.once('error', (error) => this.failGeneration(generation, error, true));
    child.once('exit', (code, signal) => {
      clearTimeout(generation.startupTimer);
      generation.exited.resolve(undefined);
      if (!generation.shutdownRequested) {
        this.failGeneration(
          generation,
          new Error(`Cold browse helper exited unexpectedly (${code ?? signal ?? 'unknown'}).`),
          false,
        );
      }
    });
    generation.startupTimer = setTimeout(() => {
      this.failGeneration(
        generation,
        new Error(`Cold browse helper readiness timed out after ${this.startupTimeoutMs}ms.`),
        true,
      );
    }, this.startupTimeoutMs);
    generation.startupTimer.unref?.();
    this.writeFrame(generation, {
      protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
      kind: 'initialize',
      sdkPath: this.options.sdkPath,
      sdkPatchIdentity: this.options.sdkPatchIdentity,
      startupCwd: this.options.startupCwd,
      parentPid: this.options.parentPid ?? process.pid,
      maxSourceBytes: this.options.maxSourceBytes,
      maxEntries: this.options.maxEntries,
    });
    await generation.ready.promise;
    return generation;
  }

  private handleOutput(generation: HelperGeneration, value: unknown): void {
    if (!isOutputFrame(value)) {
      this.failGeneration(generation, new Error('Cold browse helper returned an invalid protocol frame.'), true);
      return;
    }
    if (value.kind === 'ready') {
      if (generation.readySeen || generation.shutdownRequested) {
        this.failGeneration(generation, new Error('Cold browse helper returned duplicate readiness.'), true);
        return;
      }
      generation.readySeen = true;
      clearTimeout(generation.startupTimer);
      generation.ready.resolve(undefined);
      return;
    }
    if (!generation.readySeen) {
      this.failGeneration(generation, new Error('Cold browse helper returned output before readiness.'), true);
      return;
    }
    if (value.kind === 'shutdown-complete') {
      if (!generation.shutdownRequested || generation.shutdownSeen) {
        this.failGeneration(generation, new Error('Cold browse helper returned an unexpected shutdown acknowledgement.'), true);
        return;
      }
      generation.shutdownSeen = true;
      generation.shutdown.resolve(undefined);
      return;
    }
    const pending = generation.pending.get(value.requestId);
    if (!pending) {
      this.failGeneration(generation, new Error(`Cold browse helper returned an unknown correlation: ${value.requestId}`), true);
      return;
    }
    if (value.ok) {
      const validationError = validateSuccessFrame(pending.operation, value);
      if (validationError) {
        this.failGeneration(generation, new Error(validationError), true);
        return;
      }
      generation.pending.delete(value.requestId);
      clearTimeout(pending.timer);
      pending.resolve(value);
      return;
    }

    let error: Error;
    if (value.error.code === SESSION_SNAPSHOT_TOO_LARGE_CODE) {
      const fence = operationFence(pending.operation);
      const data = parseSnapshotTooLargeData(value.error.data);
      if (!fence || value.fingerprint !== fence.fingerprint || !data) {
        this.failGeneration(
          generation,
          new Error('Cold browse helper returned an invalid oversized-snapshot error frame.'),
          true,
        );
        return;
      }
      error = new SessionSnapshotTooLargeError(data.bytes, data.maxBytes, data.requiredMessageId);
    } else if (value.error.code === 'FINGERPRINT_CHANGED') {
      const fence = operationFence(pending.operation);
      if (!fence || value.fingerprint !== fence.fingerprint) {
        this.failGeneration(
          generation,
          new Error('Cold browse helper returned an invalid fingerprint-change error frame.'),
          true,
        );
        return;
      }
      error = new ColdBrowseHelperRequestError(
        value.error.code,
        value.error.message,
        value.error.data,
        value.fingerprint,
      );
    } else {
      error = new ColdBrowseHelperRequestError(
        value.error.code,
        value.error.message,
        value.error.data,
        value.fingerprint,
      );
    }
    generation.pending.delete(value.requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private writeFrame(generation: HelperGeneration, frame: ColdBrowseHelperInputFrame): void {
    let wire: string;
    try {
      wire = `${JSON.stringify(frame)}\n`;
    } catch (error) {
      this.failGeneration(generation, new Error(`Cold browse helper request is not serializable: ${String(error)}`), true);
      return;
    }
    if (Buffer.byteLength(wire, 'utf8') > COLD_BROWSE_HELPER_MAX_FRAME_BYTES) {
      this.failGeneration(generation, new Error('Cold browse helper request exceeded its frame limit.'), true);
      return;
    }
    generation.child.stdin.write(wire, (error) => {
      if (error) this.failGeneration(generation, error, true);
    });
  }

  private failGeneration(generation: HelperGeneration, error: Error, kill: boolean): void {
    if (generation.failed) return;
    generation.failed = true;
    clearTimeout(generation.startupTimer);
    generation.detachReader?.();
    generation.ready.reject(error);
    for (const pending of generation.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    generation.pending.clear();
    if (kill && !hasExited(generation.child)) {
      generation.child.stdin.destroy();
      generation.child.kill();
    }
  }
}

function operationFence(operation: ColdBrowseHelperOperation): ColdBrowseHelperFence | undefined {
  return operation.operation === 'invalidate' ? undefined : operation.fence;
}

function validateSuccessFrame(
  operation: ColdBrowseHelperOperation,
  frame: ColdBrowseHelperSuccessFrame,
): string | undefined {
  const fence = operationFence(operation);
  if (fence && frame.fingerprint !== fence.fingerprint) {
    return 'Cold browse helper returned a response for the wrong durable fingerprint.';
  }
  if (!isRecord(frame.result)) return 'Cold browse helper returned a non-object result.';
  const result: Record<string, unknown> = frame.result;
  if (operation.operation === 'invalidate') {
    return result.invalidated === true
      ? undefined
      : 'Cold browse helper returned an invalid invalidation result.';
  }
  if (operation.operation === 'open') {
    const session = result.session;
    return isRecord(session)
      && session.path === operation.fence.sessionPath
      && hasTranscriptSnapshotShape(result)
      ? undefined
      : 'Cold browse helper returned an invalid open result.';
  }
  if (operation.operation === 'page') {
    return result.sessionPath === operation.fence.sessionPath
      && hasTranscriptSnapshotShape(result)
      ? undefined
      : 'Cold browse helper returned an invalid page result.';
  }
  return result.sessionPath === operation.fence.sessionPath
    && result.key === operation.ref.key
    && (result.status === 'loaded'
      || result.status === 'unavailable'
      || result.status === 'stale')
    ? undefined
    : 'Cold browse helper returned an invalid detail result.';
}

function hasTranscriptSnapshotShape(value: Record<string, unknown>): boolean {
  return Array.isArray(value.transcript)
    && isRecord(value.transcriptWindow)
    && typeof value.busy === 'boolean';
}

function parseSnapshotTooLargeData(
  value: unknown,
): { bytes: number; maxBytes: number; requiredMessageId?: string } | undefined {
  if (!isRecord(value)
      || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
      || !Number.isSafeInteger(value.maxBytes) || (value.maxBytes as number) <= 0
      || (value.requiredMessageId !== undefined && typeof value.requiredMessageId !== 'string')) {
    return undefined;
  }
  return {
    bytes: value.bytes as number,
    maxBytes: value.maxBytes as number,
    ...(typeof value.requiredMessageId === 'string' ? { requiredMessageId: value.requiredMessageId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(generation: HelperGeneration, timeoutMs: number): Promise<boolean> {
  if (hasExited(generation.child)) return true;
  return await Promise.race([
    generation.exited.promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A startup/crash can reject an observer nobody awaits after a synchronous
  // spawn failure. Mark the promise observed without changing its settlement.
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => resolvePromise(value),
    reject: (error) => rejectPromise(error),
  };
}

function isOutputFrame(value: unknown): value is ColdBrowseHelperOutputFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  if (frame.protocolVersion !== COLD_BROWSE_HELPER_PROTOCOL_VERSION || typeof frame.kind !== 'string') return false;
  if (frame.kind === 'ready' || frame.kind === 'shutdown-complete') return true;
  if (frame.kind !== 'response' || typeof frame.requestId !== 'string' || typeof frame.ok !== 'boolean') return false;
  if (frame.fingerprint !== undefined && typeof frame.fingerprint !== 'string') return false;
  if (frame.ok) return Object.hasOwn(frame, 'result');
  return !!frame.error && typeof frame.error === 'object'
    && typeof (frame.error as Record<string, unknown>).code === 'string'
    && typeof (frame.error as Record<string, unknown>).message === 'string';
}

// Kept as structural documentation for spawn-test fakes.
export type ColdBrowseHelperReadable = Readable;
export type ColdBrowseHelperWritable = Writable;
