import { createHash, randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

import { redactSensitiveText } from '../shared/sensitive-redaction';
import {
  attachBoundedWorkerIpcReader,
  BoundedWorkerIpcWriter,
  WORKER_IPC_COORDINATOR_TO_WORKER_FD,
  WORKER_IPC_WORKER_TO_COORDINATOR_FD,
  type WorkerIpcWriteTarget,
} from './worker-frame-io';
import {
  WORKER_IPC_VERSION,
  parseCoordinatorToWorkerFrame,
  type CoordinatorToWorkerFrame,
  type CoordinatorToWorkerResponseFrame,
  type WorkerFrameBase,
  type WorkerFrameExpectation,
  type WorkerHeartbeatPhase,
  type WorkerIpcFrameDraft,
  type WorkerResponseResult,
  type WorkerSyncDomain,
  type WorkerToCoordinatorFrameBody,
  type WorkerToCoordinatorRequestBody,
} from './worker-protocol';
import { validateSdkPatchBarrier } from './sdk-patch-barrier';

export interface WorkerServerIdentity {
  coordinatorGeneration: number;
  workerId: string;
  workerGeneration: number;
  sessionPath: string;
  rootSessionPath: string;
  leasePath: string;
  leaseRevision: number;
  ipcReadFd: number;
  ipcWriteFd: number;
}

export interface WorkerServerProcess {
  pid: number;
  exit(code?: number): never;
  /** Optional test/embedding seam; production uses process.stderr. */
  stderr?: { write(chunk: string): unknown };
}

export interface WorkerServerTransport {
  readable: Readable;
  writable: Writable;
}

export interface WorkerServerHandlers {
  /** Called in descriptor sequence order for valid coordinator frames. */
  onFrame?: (frame: CoordinatorToWorkerFrame, server: WorkerServer) => void | Promise<void>;
  onInterrupt?: (frame: Extract<CoordinatorToWorkerFrame, { kind: 'interrupt' }>) => void | Promise<void>;
  onShutdown?: (frame: Extract<CoordinatorToWorkerFrame, { kind: 'shutdown' }>) => void | Promise<void>;
  /** Test/embedding seam; production defaults to the immutable SDK patch validator. */
  validateBootstrap?: (frame: Extract<CoordinatorToWorkerFrame, { kind: 'bootstrap' }>) => void | Promise<void>;
}

const WORKER_CLOSE_DIAGNOSTIC_MAX_BYTES = 8 * 1024;

interface PendingCoordinatorResponse {
  expectedKind: CoordinatorToWorkerFrame['kind'];
  resolve: (frame: CoordinatorToWorkerFrame) => void;
  reject: (error: Error) => void;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

export function parseWorkerServerArgs(argv: readonly string[]): WorkerServerIdentity {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error('Malformed worker entry arguments.');
    values.set(key, value);
  }
  const allowed = new Set([
    '--coordinator-generation', '--worker-id', '--worker-generation', '--session-path',
    '--root-session-path', '--lease-path', '--lease-revision', '--mcp-config',
    '--ipc-read-fd', '--ipc-write-fd',
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown worker entry argument ${key}.`);
  const workerId = values.get('--worker-id');
  const sessionPath = values.get('--session-path');
  if (!workerId || !sessionPath) throw new Error('Worker identity arguments are incomplete.');
  const rootSessionPath = values.get('--root-session-path') ?? sessionPath;
  const leasePath = values.get('--lease-path') ?? sessionPath;
  const leaseRevision = values.has('--lease-revision')
    ? positiveInteger(values.get('--lease-revision'), 'worker lease revision')
    : 1;
  const ipcReadFd = positiveInteger(values.get('--ipc-read-fd'), 'worker IPC read descriptor');
  const ipcWriteFd = positiveInteger(values.get('--ipc-write-fd'), 'worker IPC write descriptor');
  if (ipcReadFd !== WORKER_IPC_COORDINATOR_TO_WORKER_FD || ipcWriteFd !== WORKER_IPC_WORKER_TO_COORDINATOR_FD) {
    throw new Error('Worker IPC descriptors do not match the dedicated inherited transport contract.');
  }
  return {
    coordinatorGeneration: positiveInteger(values.get('--coordinator-generation'), 'coordinator generation'),
    workerId,
    workerGeneration: positiveInteger(values.get('--worker-generation'), 'worker generation'),
    sessionPath: rootSessionPath,
    rootSessionPath,
    leasePath,
    leaseRevision,
    ipcReadFd,
    ipcWriteFd,
  };
}

export function openWorkerServerTransport(identity: WorkerServerIdentity): WorkerServerTransport {
  return {
    readable: new Socket({ fd: identity.ipcReadFd, readable: true, writable: false }),
    writable: new Socket({ fd: identity.ipcWriteFd, readable: false, writable: true }),
  };
}

export class WorkerServer {
  private frameBase: Omit<WorkerFrameBase, 'seq'>;
  private readonly writer: BoundedWorkerIpcWriter;
  private detachReader?: () => void;
  private expectedInboundSeq = 1;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private heartbeatIntervalMs = 0;
  private nextHeartbeatAt = 0;
  private lastDetailRevision = 0;
  private lastDurableAppendId?: string;
  private phase: WorkerHeartbeatPhase = 'bootstrapping';
  private activeRequestId?: string;
  private bootstrapped = false;
  private closing = false;
  private exitScheduled = false;
  private closeFailureReason?: unknown;
  private closeDiagnosticWritten = false;
  private inbound = Promise.resolve();
  private readonly pending = new Map<string, PendingCoordinatorResponse>();
  private readonly syncRevisions: Record<WorkerSyncDomain, number> = {
    settings: 0,
    catalog: 0,
    auth: 0,
    runtimePrefs: 0,
    providerPolicy: 0,
    sessionRegistry: 0,
  };
  private readonly syncPayloadFingerprints: Partial<Record<WorkerSyncDomain, string>> = {};
  private readonly syncApplications: Partial<Record<WorkerSyncDomain, Promise<void>>> = {};

  constructor(
    private readonly identity: WorkerServerIdentity,
    private readonly processRef: WorkerServerProcess = process,
    private readonly transport: WorkerServerTransport = openWorkerServerTransport(identity),
    private readonly handlers: WorkerServerHandlers = {},
  ) {
    this.frameBase = {
      ipcVersion: WORKER_IPC_VERSION,
      coordinatorGeneration: identity.coordinatorGeneration,
      workerId: identity.workerId,
      workerGeneration: identity.workerGeneration,
      workerPid: processRef.pid,
      rootSessionPath: identity.rootSessionPath,
      leasePath: identity.leasePath,
      leaseRevision: identity.leaseRevision,
      sessionPath: identity.rootSessionPath,
    };
    const target: WorkerIpcWriteTarget = transport.writable;
    this.writer = new BoundedWorkerIpcWriter(target, { onFatal: (error) => this.close(1, error) });
  }

  start(): void {
    this.detachReader = attachBoundedWorkerIpcReader(this.transport.readable, {
      onFrame: (message) => {
        // Parsing, identity fencing, sequence advancement, and response
        // correlation stay descriptor-ordered. Runtime handlers are launched
        // after that ordered admission instead of being awaited by it, so a
        // later interrupt/shutdown or ownership/provider response cannot sit
        // behind an active provider/tool command.
        this.inbound = this.inbound.then(() => this.handleMessage(message)).catch((error) => {
          this.failProtocol(error instanceof Error ? error.message : String(error), 'INTERNAL_ERROR');
        });
      },
      onFatal: (error) => this.failProtocol(error.message, 'PROTOCOL_ERROR'),
      onEnd: () => this.close(1, new Error('Coordinator IPC read descriptor closed.')),
    });
    this.transport.writable.once('error', (error) => this.close(1, error));
    this.transport.writable.once('close', () => this.close(1, new Error('Worker IPC write descriptor closed.')));
  }

  /** Send a closed worker frame while the transport supplies exact identity and sequence fields. */
  sendFrame(body: WorkerToCoordinatorFrameBody): boolean {
    return this.send({ ...this.frameBase, ...body } as WorkerIpcFrameDraft);
  }

  /** Detail pages/deltas use a separately bounded low-priority lane. Queue
   * capacity rejection is recoverable and lets the canonical store emit an
   * explicit rebase instead of killing the worker generation. */
  sendDetailFrame(body: Extract<WorkerToCoordinatorFrameBody, {
    kind: 'detail.start' | 'detail.page' | 'detail.delta' | 'detail.rebase' | 'detail.terminal' | 'detail.error' | 'detail.unsubscribed';
  }>): boolean {
    const revision = 'revision' in body && typeof body.revision === 'number'
      ? body.revision
      : 'currentRevision' in body && typeof body.currentRevision === 'number'
        ? body.currentRevision
        : 'baselineRevision' in body && typeof body.baselineRevision === 'number'
          ? body.baselineRevision
          : undefined;
    if (revision !== undefined) this.lastDetailRevision = Math.max(this.lastDetailRevision, revision);
    if (body.kind === 'detail.terminal') this.lastDurableAppendId = body.durableRef.messageId;
    const result = this.writer.enqueue({ ...this.frameBase, ...body } as WorkerIpcFrameDraft, {
      onSettled: (settlement) => {
        if (settlement.status === 'failed') this.close(1, settlement.error);
      },
    });
    return result.accepted;
  }

  /** Correlate a worker-originated request with its dedicated coordinator response. */
  requestFrame<K extends CoordinatorToWorkerResponseFrame['kind']>(
    body: WorkerToCoordinatorRequestBody,
    expectedKind: K,
    correlatedRequestId?: string,
  ): Promise<Extract<CoordinatorToWorkerResponseFrame, { kind: K }>> {
    if (this.closing) return Promise.reject(new Error('Coordinator transport is unavailable.'));
    const requestId = correlatedRequestId ?? randomUUID();
    if (this.pending.has(requestId)) return Promise.reject(new Error(`Coordinator IPC request ${requestId} is already pending.`));
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        expectedKind,
        resolve: (frame) => resolve(frame as Extract<CoordinatorToWorkerResponseFrame, { kind: K }>),
        reject,
      });
      if (!this.sendFrame({ ...body, requestId } as WorkerToCoordinatorFrameBody)) {
        this.pending.delete(requestId);
        reject(new Error('Coordinator IPC request was rejected.'));
      }
    });
  }

  /** Terminalize a worker-local runtime invariant through the closed fatal
   * frame so the coordinator confirms process death and reconciles ownership. */
  failRuntime(error: Error): void {
    this.failProtocol(error.message || 'Worker runtime failed closed.', 'INTERNAL_ERROR');
  }

  /** Advance the current write lease without changing the immutable root identity. */
  updateLeaseIdentity(leasePath: string, leaseRevision: number): void {
    if (!leasePath || !Number.isSafeInteger(leaseRevision) || leaseRevision <= this.frameBase.leaseRevision) {
      throw new Error('Worker lease identity must advance to a non-empty path and higher revision.');
    }
    this.frameBase = { ...this.frameBase, leasePath, leaseRevision };
  }

  private expectation(): WorkerFrameExpectation {
    return { ...this.frameBase, expectedSeq: this.expectedInboundSeq };
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (this.closing) return;
    const parsed = parseCoordinatorToWorkerFrame(message, this.expectation());
    if (parsed.status === 'stale') return;
    if (parsed.status === 'invalid') {
      this.failProtocol(`${parsed.reason}: ${parsed.detail}`, 'PROTOCOL_ERROR');
      return;
    }
    this.expectedInboundSeq += 1;
    const frame = parsed.frame;
    if (!this.bootstrapped) {
      if (frame.kind !== 'bootstrap') {
        this.failProtocol('The first coordinator frame must be bootstrap.', 'PROTOCOL_ERROR');
        return;
      }
      await this.bootstrap(frame);
      return;
    }
    if (frame.kind === 'bootstrap') {
      this.failProtocol('Duplicate bootstrap frame.', 'PROTOCOL_ERROR');
      return;
    }
    const requestId = 'requestId' in frame ? frame.requestId : undefined;
    const pending = requestId ? this.pending.get(requestId) : undefined;
    if (pending) {
      this.pending.delete(requestId!);
      if (frame.kind === 'ownership.rejected') {
        pending.reject(new Error(`${frame.code}: ${frame.message}`));
        return;
      }
      if (frame.kind === 'provider.cancelled') {
        pending.reject(createAbortError(frame.reason));
        return;
      }
      if (frame.kind === 'provider.rejected') {
        pending.reject(createProviderRejectedError(frame.error));
        return;
      }
      if (frame.kind !== pending.expectedKind) {
        const error = new Error(`Coordinator response ${requestId} returned frame ${frame.kind}; expected ${pending.expectedKind}.`);
        pending.reject(error);
        this.failProtocol(error.message, 'PROTOCOL_ERROR');
        return;
      }
      pending.resolve(frame);
      return;
    }
    if (frame.kind === 'ownership.reserved' || frame.kind === 'ownership.committed' || frame.kind === 'ownership.consumed'
        || frame.kind === 'ownership.aborted' || frame.kind === 'ownership.rejected' || frame.kind === 'ownership.runtimeReadyAck'
        || frame.kind === 'provider.granted' || frame.kind === 'provider.cancelled' || frame.kind === 'provider.rejected'
        || frame.kind === 'provider.cancelAck'
        || frame.kind === 'provider.released' || frame.kind === 'settings.authoritative') {
      this.failProtocol(`Coordinator ${frame.kind} has unknown requestId ${frame.requestId}.`, 'PROTOCOL_ERROR');
      return;
    }
    void this.dispatch(frame).catch((error) => {
      this.failProtocol(error instanceof Error ? error.message : String(error), 'INTERNAL_ERROR');
    });
  }

  private async bootstrap(frame: Extract<CoordinatorToWorkerFrame, { kind: 'bootstrap' }>): Promise<void> {
    try {
      // Worker startup imports no Pi runtime. Only the coordinator-prepared immutable
      // patch identity is verified before a future runtime import.
      if (this.handlers.validateBootstrap) await this.handlers.validateBootstrap(frame);
      else await validateSdkPatchBarrier(frame.sdkPatchIdentity.sdkPath, frame.sdkPatchIdentity);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error.message : String(error), 'BOOTSTRAP_FAILED', 'bootstrap');
      return;
    }
    if (this.closing) return;
    this.bootstrapped = true;
    this.phase = 'ready';
    this.heartbeatIntervalMs = frame.heartbeatIntervalMs;
    this.send({
      ...this.frameBase,
      kind: 'ready',
      runtimeMetadata: { mode: 'phase2', startedAt: Date.now() },
    });
    this.startHeartbeat();
  }

  private async dispatch(frame: Exclude<CoordinatorToWorkerFrame, { kind: 'bootstrap' }>): Promise<void> {
    if (frame.kind === 'command') {
      this.activeRequestId = frame.requestId;
      this.phase = 'busy';
      this.respond(frame.requestId, { kind: 'pong' });
      this.activeRequestId = undefined;
      this.phase = 'ready';
      return;
    }
    if (frame.kind === 'interrupt') {
      this.activeRequestId = frame.targetRequestId;
      this.phase = 'interrupting';
      await this.handlers.onInterrupt?.(frame);
      this.respond(frame.requestId, { kind: 'interrupted' });
      this.activeRequestId = undefined;
      this.phase = 'ready';
      return;
    }
    if (frame.kind === 'shutdown') {
      this.phase = 'shutting-down';
      await this.handlers.onShutdown?.(frame);
      this.closing = true;
      this.stopHeartbeat();
      this.send({
        ...this.frameBase,
        kind: 'response',
        requestId: frame.requestId,
        ok: true,
        result: { kind: 'shutting-down' },
      }, () => this.close(0));
      return;
    }
    if (frame.kind === 'sync') {
      const current = this.syncRevisions[frame.domain];
      if (frame.revision < current) {
        this.failProtocol(`Sync revision for ${frame.domain} must advance beyond ${current}.`, 'PROTOCOL_ERROR');
        return;
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(frame.payload)).digest('hex');
      if (frame.revision === current) {
        if (this.syncPayloadFingerprints[frame.domain] !== fingerprint) {
          this.failProtocol(`Sync retry for ${frame.domain}@${current} changed its payload.`, 'PROTOCOL_ERROR');
          return;
        }
        // The coordinator may retry after its ACK deadline while the original
        // frame is still waiting for a blocked JS turn. Join the exact apply
        // before replaying the acknowledgement; never run host side effects
        // twice and never make an idempotent retry protocol-fatal.
        await this.syncApplications[frame.domain];
        this.sendFrame({
          kind: 'sync.ack', requestId: frame.requestId,
          domain: frame.domain, revision: frame.revision,
        });
        return;
      }
      const previousApplication = this.syncApplications[frame.domain] ?? Promise.resolve();
      this.syncRevisions[frame.domain] = frame.revision;
      this.syncPayloadFingerprints[frame.domain] = fingerprint;
      const application = previousApplication.then(async () => {
        if (!this.handlers.onFrame) {
          throw new Error(`No Phase 4 handler is installed for ${frame.kind}.`);
        }
        await this.handlers.onFrame(frame, this);
      });
      this.syncApplications[frame.domain] = application;
      await application;
      this.sendFrame({
        kind: 'sync.ack', requestId: frame.requestId,
        domain: frame.domain, revision: frame.revision,
      });
      return;
    }
    if (!this.handlers.onFrame) {
      this.failProtocol(`No Phase 4 handler is installed for ${frame.kind}.`, 'PROTOCOL_ERROR');
      return;
    }
    await this.handlers.onFrame(frame, this);
  }

  private respond(requestId: string, result: WorkerResponseResult): void {
    this.send({ ...this.frameBase, kind: 'response', requestId, ok: true, result });
  }

  private startHeartbeat(): void {
    this.nextHeartbeatAt = performance.now() + this.heartbeatIntervalMs;
    this.heartbeatInterval = setInterval(() => {
      const now = performance.now();
      const eventLoopDelayMs = Math.max(0, Math.trunc(now - this.nextHeartbeatAt));
      this.nextHeartbeatAt = now + this.heartbeatIntervalMs;
      this.send({
        ...this.frameBase,
        kind: 'heartbeat',
        heartbeat: {
          phase: this.phase,
          ...(this.activeRequestId ? { activeRequestId: this.activeRequestId } : {}),
          lastEventSeq: 0,
          lastDetailRevision: this.lastDetailRevision,
          eventLoopDelayMs,
          ...(this.lastDurableAppendId ? { lastDurableAppendId: this.lastDurableAppendId } : {}),
        },
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
  }

  private failProtocol(
    message: string,
    code: 'BOOTSTRAP_FAILED' | 'PROTOCOL_ERROR' | 'INTERNAL_ERROR',
    phase: 'bootstrap' | 'ipc' = 'ipc',
  ): void {
    if (this.closing) return;
    this.closing = true;
    this.stopHeartbeat();
    const failure = new Error(message || 'Worker protocol failed closed.');
    this.closeFailureReason = failure;
    const accepted = this.send({
      ...this.frameBase,
      kind: 'fatal',
      error: { code, phase, message: failure.message },
    }, () => this.close(1, failure));
    // A fatal frame can itself be rejected (for example when its diagnostic is
    // oversized). Heartbeats have already stopped, so close immediately rather
    // than leaving a coordinator-orphaned process alive forever.
    if (!accepted) this.close(1, failure);
  }

  private send(draft: WorkerIpcFrameDraft, onSettled?: () => void): boolean {
    const result = this.writer.enqueue(draft, {
      onSettled: (settlement) => {
        if (settlement.status === 'sent') onSettled?.();
        else if (settlement.status === 'failed') this.close(1, settlement.error);
        else if (settlement.status === 'rejected') {
          if (this.closing) this.close(1, new Error(`Worker IPC frame rejected (${settlement.reason}): ${settlement.detail}`));
          else {
            this.failProtocol(
              `Worker IPC frame rejected (${settlement.reason}): ${settlement.detail}`,
              'INTERNAL_ERROR',
            );
          }
        }
      },
    });
    if (!result.accepted && !this.closing) {
      this.failProtocol(
        `Worker IPC frame rejected (${result.reason}): ${result.detail}`,
        'INTERNAL_ERROR',
      );
    }
    return result.accepted;
  }

  private writeCloseDiagnostic(reason: unknown): void {
    if (this.closeDiagnosticWritten) return;
    this.closeDiagnosticWritten = true;
    const raw = reason instanceof Error
      ? reason.stack ?? reason.message
      : reason === undefined
        ? 'Worker server closed with code 1 without a failure reason.'
        : String(reason);
    const redacted = redactSensitiveText(raw);
    const bytes = Buffer.from(redacted, 'utf8');
    const bounded = bytes.length > WORKER_CLOSE_DIAGNOSTIC_MAX_BYTES
      ? `${bytes.subarray(0, WORKER_CLOSE_DIAGNOSTIC_MAX_BYTES - 1).toString('utf8')}…`
      : redacted;
    try {
      this.processRef.stderr?.write(`[pie-worker] close(1): ${bounded}\n`);
    } catch {
      // Diagnostics must never alter the worker's fail-closed exit path.
    }
  }

  private close(code: number, reason?: unknown): void {
    if (this.exitScheduled) return;
    this.exitScheduled = true;
    if (code === 1) {
      this.closeFailureReason ??= reason;
      this.writeCloseDiagnostic(this.closeFailureReason);
    }
    if (!this.closing) this.closing = true;
    this.stopHeartbeat();
    const closedError = new Error('Coordinator transport closed.');
    for (const pending of this.pending.values()) pending.reject(closedError);
    this.pending.clear();
    this.detachReader?.();
    this.detachReader = undefined;
    const exit = (): void => { setImmediate(() => this.processRef.exit(code)); };
    if (!this.transport.writable.destroyed && !this.transport.writable.writableEnded) {
      this.transport.writable.end(exit);
    } else exit();
  }
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function createProviderRejectedError(
  payload: { name: string; message: string; retryable: boolean; httpStatus?: number },
): Error {
  const error = new Error(payload.message) as Error & { isRetryable: boolean; httpStatus?: number };
  error.name = payload.name;
  error.isRetryable = payload.retryable;
  if (payload.httpStatus !== undefined) error.httpStatus = payload.httpStatus;
  return error;
}
