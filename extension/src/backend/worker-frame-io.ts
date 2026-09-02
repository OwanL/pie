import type { Readable } from 'node:stream';

import { attachJsonlLineReader } from '../shared/jsonl';
import {
  WORKER_IPC_MAX_FRAME_BYTES,
  WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES,
  WORKER_IPC_MAX_ORDINARY_FRAME_BYTES,
  measureWorkerIpcMessage,
  validateWorkerIpcFrameDraft,
  workerIpcFrameByteLimit,
  type WorkerIpcFrame,
  type WorkerIpcFrameDraft,
  type WorkerIpcFrameKind,
} from './worker-protocol';

/**
 * Extra response-lane space beyond one maximum legal frame. Checkpoint
 * responses can legitimately approach the shared 32 MiB wire ceiling; this
 * fixed reserve keeps their small correlated acknowledgements admissible
 * without making the queue unbounded.
 */
export const WORKER_IPC_RESPONSE_QUEUE_HEADROOM_BYTES = 1024 * 1024;
export const WORKER_IPC_DEFAULT_RESPONSE_QUEUE_BYTES =
  WORKER_IPC_MAX_FRAME_BYTES + WORKER_IPC_RESPONSE_QUEUE_HEADROOM_BYTES;
export const WORKER_IPC_DEFAULT_CONTROL_QUEUE_BYTES = 1024 * 1024;
export const WORKER_IPC_DEFAULT_LIFECYCLE_QUEUE_BYTES = 2 * 1024 * 1024;
export const WORKER_IPC_DEFAULT_ORDINARY_QUEUE_BYTES = 2 * 1024 * 1024;
export const WORKER_IPC_DEFAULT_DETAIL_QUEUE_BYTES = 2 * 1024 * 1024;

/** Child-side inherited descriptors. stdout/stderr remain diagnostics. */
export const WORKER_IPC_COORDINATOR_TO_WORKER_FD = 3;
export const WORKER_IPC_WORKER_TO_COORDINATOR_FD = 4;

type WriterLane = 'response' | 'control' | 'lifecycle' | 'ordinary' | 'detail';

export interface WorkerIpcWriteTarget {
  readonly destroyed?: boolean;
  readonly writable?: boolean;
  readonly writableEnded?: boolean;
  write(data: string, callback: (error?: Error | null) => void): boolean;
}

export type WorkerIpcSettlement =
  | { status: 'sent'; seq: number }
  | { status: 'coalesced' }
  | { status: 'rejected'; reason: 'invalid' | 'oversize' | 'capacity' | 'unavailable'; detail: string }
  | { status: 'failed'; error: Error; seq?: number };

export interface WorkerIpcEnqueueOptions {
  onSettled?: (settlement: WorkerIpcSettlement) => void;
}

export type WorkerIpcEnqueueResult =
  | { accepted: true; coalesced: boolean }
  | { accepted: false; reason: 'invalid' | 'oversize' | 'capacity' | 'unavailable'; detail: string };

export interface BoundedWorkerIpcWriterOptions {
  initialSeq?: number;
  maxQueuedResponseBytes?: number;
  maxQueuedControlBytes?: number;
  maxQueuedLifecycleBytes?: number;
  maxQueuedOrdinaryBytes?: number;
  maxQueuedDetailBytes?: number;
  onBackpressure?: (frame: WorkerIpcFrame) => void;
  onFatal?: (error: Error) => void;
}

interface PendingFrame {
  draft: WorkerIpcFrameDraft;
  kind: WorkerIpcFrameKind;
  lane: WriterLane;
  bytes: number;
  onSettled?: (settlement: WorkerIpcSettlement) => void;
}

export interface BoundedWorkerIpcReaderOptions {
  onFrame: (value: unknown) => void;
  onFatal: (error: Error) => void;
  onEnd?: () => void;
}

/**
 * Attach the shared bounded JSONL ingress before JSON.parse. An overlong line
 * is discarded through LF by the shared reader and fails the owning worker
 * generation without ever becoming a string or parsed frame.
 */
export function attachBoundedWorkerIpcReader(
  stream: Readable,
  options: BoundedWorkerIpcReaderOptions,
): () => void {
  let failed = false;
  const fail = (error: Error): void => {
    if (failed) return;
    failed = true;
    options.onFatal(error);
  };
  const detachLines = attachJsonlLineReader(stream, (line) => {
    if (failed) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(new Error(`Malformed worker IPC JSONL: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    options.onFrame(value);
  }, {
    // attachJsonlLineReader counts bytes before LF. Reserve the final LF so the
    // complete OS write is bounded by WORKER_IPC_MAX_FRAME_BYTES exactly.
    maxLineBytes: WORKER_IPC_MAX_FRAME_BYTES - 1,
    emitTrailingLineOnEnd: false,
    onOverflow: () => fail(new Error(`Worker IPC frame exceeds the ${WORKER_IPC_MAX_FRAME_BYTES}-byte wire limit.`)),
    onIncomplete: () => fail(new Error('Worker IPC frame ended before its LF delimiter.')),
  });
  const onError = (error: Error): void => fail(new Error(`Worker IPC read failed: ${error.message}`));
  const onEnd = (): void => { if (!failed) options.onEnd?.(); };
  stream.on('error', onError);
  stream.on('end', onEnd);
  return () => {
    detachLines();
    stream.off('error', onError);
    stream.off('end', onEnd);
  };
}

/**
 * Bounded, sequence-owning JSONL writer for one inherited private FD.
 *
 * Only one stream.write may be active. Correlated responses drain first, then
 * control/terminal frames, then ordinary commands and heartbeats; every lane
 * is FIFO. Pending heartbeats replace the older pending heartbeat before
 * either receives a sequence number. Every frame is serialized and checked
 * against its exact JSON+LF byte cap before the first OS write.
 */
export class BoundedWorkerIpcWriter {
  private readonly lanes: Record<WriterLane, PendingFrame[]> = {
    response: [],
    control: [],
    lifecycle: [],
    ordinary: [],
    detail: [],
  };
  private readonly queuedBytes: Record<WriterLane, number> = {
    response: 0,
    control: 0,
    lifecycle: 0,
    ordinary: 0,
    detail: 0,
  };
  private readonly capacities: Record<WriterLane, number>;
  private readonly onBackpressure?: (frame: WorkerIpcFrame) => void;
  private readonly onFatal: (error: Error) => void;
  private nextSeq: number;
  private active?: { pending: PendingFrame; frame: WorkerIpcFrame };
  private failedError?: Error;

  constructor(private readonly target: WorkerIpcWriteTarget, options: BoundedWorkerIpcWriterOptions = {}) {
    this.nextSeq = options.initialSeq ?? 1;
    if (!Number.isSafeInteger(this.nextSeq) || this.nextSeq <= 0) throw new Error('initialSeq must be a positive safe integer.');
    this.capacities = {
      response: validateCapacity(options.maxQueuedResponseBytes ?? WORKER_IPC_DEFAULT_RESPONSE_QUEUE_BYTES, 'maxQueuedResponseBytes'),
      control: validateCapacity(options.maxQueuedControlBytes ?? WORKER_IPC_DEFAULT_CONTROL_QUEUE_BYTES, 'maxQueuedControlBytes'),
      lifecycle: validateCapacity(options.maxQueuedLifecycleBytes ?? WORKER_IPC_DEFAULT_LIFECYCLE_QUEUE_BYTES, 'maxQueuedLifecycleBytes'),
      ordinary: validateCapacity(options.maxQueuedOrdinaryBytes ?? WORKER_IPC_DEFAULT_ORDINARY_QUEUE_BYTES, 'maxQueuedOrdinaryBytes'),
      detail: validateCapacity(options.maxQueuedDetailBytes ?? WORKER_IPC_DEFAULT_DETAIL_QUEUE_BYTES, 'maxQueuedDetailBytes'),
    };
    this.onBackpressure = options.onBackpressure;
    this.onFatal = options.onFatal ?? (() => undefined);
  }

  enqueue(draft: WorkerIpcFrameDraft, options: WorkerIpcEnqueueOptions = {}): WorkerIpcEnqueueResult {
    if (this.failedError) return this.reject(options.onSettled, 'unavailable', this.failedError.message);
    if (!isWritable(this.target)) {
      this.fail(new Error('Worker IPC write descriptor is unavailable.'));
      return this.reject(options.onSettled, 'unavailable', 'Worker IPC write descriptor is unavailable.');
    }

    // Validate the closed draft shape before constructing or serializing it.
    // In particular, an invalid field must not reach JSON.stringify, whose
    // traversal/duplication cost is otherwise controlled by the caller.
    let draftDetail: string | undefined;
    try {
      draftDetail = validateWorkerIpcFrameDraft(draft);
    } catch {
      draftDetail = 'IPC frame draft could not be structurally validated.';
    }
    if (draftDetail) return this.reject(options.onSettled, 'invalid', draftDetail);

    // MAX_SAFE_INTEGER conservatively reserves the longest legal sequence and
    // validates the exact JSON wire shape without consuming a sequence.
    const candidate = { ...draft, seq: Number.MAX_SAFE_INTEGER } as WorkerIpcFrame;
    const measured = measureWorkerIpcMessage(candidate);
    if (!measured.ok) return this.reject(options.onSettled, 'invalid', measured.detail);
    const wireBytes = measured.bytes + 1;
    if (wireBytes > WORKER_IPC_MAX_FRAME_BYTES) {
      return this.reject(options.onSettled, 'oversize', sizeDetail(wireBytes, WORKER_IPC_MAX_FRAME_BYTES));
    }
    const semanticLimit = workerIpcFrameByteLimit(candidate);
    if (wireBytes > semanticLimit) {
      return this.reject(options.onSettled, 'oversize', sizeDetail(wireBytes, semanticLimit));
    }

    // Retain the actual JSON representation. Undefined optional keys disappear
    // now and caller mutation after enqueue cannot alter a queued frame.
    // The draft was structurally validated before serialization. Parsing this
    // bounded, canonical wire form gives queued frames snapshot semantics and
    // also removes optional undefined keys without a second shape traversal.
    const admitted = JSON.parse(measured.serialized) as WorkerIpcFrame;
    const { seq: _measurementSeq, ...stableDraft } = admitted;
    const lane = laneFor(admitted);
    const pending: PendingFrame = {
      draft: stableDraft as WorkerIpcFrameDraft,
      kind: admitted.kind,
      lane,
      bytes: wireBytes,
      onSettled: options.onSettled,
    };

    if (pending.kind === 'heartbeat') {
      const heartbeatIndex = this.lanes.ordinary.findIndex((entry) => entry.kind === 'heartbeat');
      if (heartbeatIndex >= 0) {
        const previous = this.lanes.ordinary[heartbeatIndex]!;
        const replacementBytes = this.queuedBytes.ordinary - previous.bytes + pending.bytes;
        if (replacementBytes > this.capacities.ordinary) {
          return this.reject(options.onSettled, 'capacity', capacityDetail('ordinary', replacementBytes, this.capacities.ordinary));
        }
        this.lanes.ordinary.splice(heartbeatIndex, 1);
        this.lanes.ordinary.push(pending);
        this.queuedBytes.ordinary = replacementBytes;
        settle(previous.onSettled, { status: 'coalesced' });
        return { accepted: true, coalesced: true };
      }
    }

    // Count an in-flight response against the response reservation. Without
    // this, the descriptor could retain one maximum response as its active OS
    // write and another full reservation in the queue. Other lanes retain the
    // historical meaning of maxQueued*Bytes: queued backlog behind the one
    // active descriptor write.
    const activeLaneBytes = lane === 'response' && this.active?.pending.lane === lane
      ? this.active.pending.bytes
      : 0;
    const retainedLaneBytes = activeLaneBytes + this.queuedBytes[lane];
    const nextLaneBytes = retainedLaneBytes + pending.bytes;
    // A single frame may exceed the lane's reserved capacity (it is bounded by
    // the semantic frame limit above), but only when the lane is otherwise
    // empty. This lets a large promotion snapshot or session.opened pass while
    // still bounding the backlog of many queued frames under backpressure.
    // That exceptional frame does not consume the lane's ordinary reservation:
    // lifecycle records such as busy.changed must still fit behind a large
    // session.opened instead of turning valid backpressure into worker death.
    const exceptionalQueuedFrameBytes = this.lanes[lane]
      .find((entry) => entry.bytes > this.capacities[lane])?.bytes ?? 0;
    const reservedLaneBytes = retainedLaneBytes - exceptionalQueuedFrameBytes;
    if (retainedLaneBytes > 0 && reservedLaneBytes + pending.bytes > this.capacities[lane]) {
      return this.reject(options.onSettled, 'capacity', capacityDetail(lane, nextLaneBytes, this.capacities[lane]));
    }
    this.lanes[lane].push(pending);
    // `queuedBytes` deliberately excludes the descriptor's active write. The
    // active response participates in the admission calculation above, but it
    // must not be persisted into the queued balance or it survives every
    // later dequeue as phantom capacity.
    this.queuedBytes[lane] += pending.bytes;
    this.pump();
    return { accepted: true, coalesced: false };
  }

  /** Notify the writer when its inherited descriptor closes unexpectedly. */
  handleDisconnect(error: Error = new Error('Worker IPC write descriptor closed.')): void {
    this.fail(error);
  }

  getDebugState(): {
    failed: boolean;
    active: boolean;
    nextSeq: number;
    queueDepth: Record<WriterLane, number>;
    queuedBytes: Record<WriterLane, number>;
  } {
    return {
      failed: this.failedError !== undefined,
      active: this.active !== undefined,
      nextSeq: this.nextSeq,
      queueDepth: {
        response: this.lanes.response.length,
        control: this.lanes.control.length,
        lifecycle: this.lanes.lifecycle.length,
        ordinary: this.lanes.ordinary.length,
        detail: this.lanes.detail.length,
      },
      queuedBytes: { ...this.queuedBytes },
    };
  }

  private reject(
    callback: WorkerIpcEnqueueOptions['onSettled'],
    reason: 'invalid' | 'oversize' | 'capacity' | 'unavailable',
    detail: string,
  ): WorkerIpcEnqueueResult {
    settle(callback, { status: 'rejected', reason, detail });
    return { accepted: false, reason, detail };
  }

  private pump(): void {
    if (this.active || this.failedError) return;
    if (!isWritable(this.target)) {
      this.fail(new Error('Worker IPC write descriptor is unavailable.'));
      return;
    }
    if (!Number.isSafeInteger(this.nextSeq) || this.nextSeq <= 0 || this.nextSeq > Number.MAX_SAFE_INTEGER) {
      this.fail(new Error('Worker IPC sequence space is exhausted.'));
      return;
    }
    const pending = this.shiftNext();
    if (!pending) return;

    const frame = { ...pending.draft, seq: this.nextSeq } as WorkerIpcFrame;
    const measured = measureWorkerIpcMessage(frame);
    const semanticLimit = workerIpcFrameByteLimit(frame);
    if (!measured.ok || measured.bytes + 1 > WORKER_IPC_MAX_FRAME_BYTES || measured.bytes + 1 > semanticLimit) {
      this.fail(new Error(measured.ok
        ? sizeDetail(measured.bytes + 1, Math.min(WORKER_IPC_MAX_FRAME_BYTES, semanticLimit))
        : measured.detail));
      return;
    }
    const wire = `${measured.serialized}\n`;
    this.nextSeq += 1;
    this.active = { pending, frame };
    let callbackSettled = false;
    const callback = (error?: Error | null): void => {
      if (callbackSettled) return;
      callbackSettled = true;
      if (this.active?.pending !== pending) return;
      this.active = undefined;
      if (error) {
        settle(pending.onSettled, { status: 'failed', error, seq: frame.seq });
        this.fail(new Error(`Worker IPC write callback failed: ${error.message}`));
        return;
      }
      settle(pending.onSettled, { status: 'sent', seq: frame.seq });
      this.pump();
    };

    try {
      const writable = this.target.write(wire, callback);
      if (!writable && !callbackSettled) observe(() => this.onBackpressure?.(frame));
    } catch (error) {
      callbackSettled = true;
      this.active = undefined;
      const writeError = error instanceof Error ? error : new Error(String(error));
      settle(pending.onSettled, { status: 'failed', error: writeError, seq: frame.seq });
      this.fail(new Error(`Worker IPC write threw: ${writeError.message}`));
    }
  }

  private shiftNext(): PendingFrame | undefined {
    for (const lane of ['response', 'control', 'lifecycle', 'ordinary', 'detail'] as const) {
      const pending = this.lanes[lane].shift();
      if (!pending) continue;
      this.queuedBytes[lane] -= pending.bytes;
      return pending;
    }
    return undefined;
  }

  private fail(error: Error): void {
    if (this.failedError) return;
    this.failedError = error;
    const active = this.active;
    this.active = undefined;
    if (active) settle(active.pending.onSettled, { status: 'failed', error, seq: active.frame.seq });
    for (const lane of ['response', 'control', 'lifecycle', 'ordinary', 'detail'] as const) {
      for (const pending of this.lanes[lane].splice(0)) settle(pending.onSettled, { status: 'failed', error });
      this.queuedBytes[lane] = 0;
    }
    observe(() => this.onFatal(error));
  }
}

function isWritable(target: WorkerIpcWriteTarget): boolean {
  return target.destroyed !== true && target.writable !== false && target.writableEnded !== true;
}

function laneFor(frame: WorkerIpcFrame): WriterLane {
  const kind = frame.kind;
  if (kind === 'response' || kind === 'runtime.ready' || kind === 'sync.ack'
      || kind === 'ownership.reserved' || kind === 'ownership.committed'
      || kind === 'ownership.consumed' || kind === 'ownership.aborted'
      || kind === 'ownership.rejected' || kind === 'ownership.runtimeReadyAck'
      || kind === 'provider.granted' || kind === 'provider.cancelled' || kind === 'provider.rejected'
      || kind === 'provider.cancelAck' || kind === 'provider.released'
      || kind === 'settings.authoritative'
      || kind === 'detail.unsubscribed') return 'response';
  if (kind === 'bootstrap' || kind === 'interrupt' || kind === 'shutdown'
      || kind === 'ready' || kind === 'fatal' || kind === 'runtime.promote'
      || kind === 'runtime.command' || kind === 'sync'
      || kind === 'ownership.reserve' || kind === 'ownership.commit'
      || kind === 'ownership.abort' || kind === 'ownership.runtimeReady'
      || kind === 'provider.acquire' || kind === 'provider.cancel'
      || kind === 'provider.observation' || kind === 'provider.release'
      || kind === 'detail.subscribe' || kind === 'detail.unsubscribe' || kind === 'detail.fetch'
      || kind === 'detail.rebase' || kind === 'detail.error') return 'control';
  if (kind === 'detail.start' || kind === 'detail.terminal') return 'lifecycle';
  if (kind === 'detail.page' || kind === 'detail.delta') return 'detail';
  if (kind === 'runtime.event' && isLifecycleRuntimeEvent(frame.event)) return 'lifecycle';
  return 'ordinary';
}

function isLifecycleRuntimeEvent(event: string): boolean {
  return event === 'session.opened' || event === 'message.started' || event === 'message.finished'
    || event === 'message.aborted' || event === 'tool.started' || event === 'tool.finished'
    || event === 'busy.changed' || event === 'live.lifecycle';
}

function validateCapacity(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function sizeDetail(bytes: number, limit: number): string {
  return `Worker IPC frame is ${bytes} UTF-8 wire bytes; limit is ${limit}.`;
}

function capacityDetail(lane: WriterLane, bytes: number, capacity: number): string {
  return `Worker IPC ${lane} queue would use ${bytes} bytes; reserved capacity is ${capacity}.`;
}

function settle(callback: WorkerIpcEnqueueOptions['onSettled'], settlement: WorkerIpcSettlement): void {
  if (!callback) return;
  observe(() => callback(settlement));
}

function observe(callback: () => void): void {
  try { callback(); } catch { /* observer callbacks cannot alter transport invariants */ }
}

export {
  WORKER_IPC_MAX_FRAME_BYTES,
  WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES,
  WORKER_IPC_MAX_ORDINARY_FRAME_BYTES,
};
