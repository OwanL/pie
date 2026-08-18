import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  attachBoundedWorkerIpcReader,
  BoundedWorkerIpcWriter,
  WORKER_IPC_MAX_FRAME_BYTES,
  type WorkerIpcWriteTarget,
  type WorkerIpcSettlement,
} from '../../../src/backend/worker-frame-io';
import {
  WORKER_IPC_VERSION,
  type WorkerIpcFrame,
  type WorkerIpcFrameDraft,
} from '../../../src/backend/worker-protocol';

const frameBase = {
  ipcVersion: WORKER_IPC_VERSION,
  coordinatorGeneration: 1,
  workerId: 'worker',
  workerGeneration: 1,
  workerPid: 1234,
  rootSessionPath: '/session.jsonl',
  leasePath: '/session.jsonl',
  leaseRevision: 1,
  sessionPath: '/session.jsonl',
};

const command = (requestId: string): WorkerIpcFrameDraft => ({
  ...frameBase, kind: 'command', requestId, operation: 'ping',
});
const response = (requestId: string): WorkerIpcFrameDraft => ({
  ...frameBase, kind: 'response', requestId, ok: true, result: { kind: 'pong' },
});
const heartbeat = (lastEventSeq: number): WorkerIpcFrameDraft => ({
  ...frameBase,
  kind: 'heartbeat',
  heartbeat: { phase: 'busy', lastEventSeq, lastDetailRevision: 0, eventLoopDelayMs: 1 },
});
const fatal = (message = 'fatal'): WorkerIpcFrameDraft => ({
  ...frameBase, kind: 'fatal', error: { code: 'INTERNAL_ERROR', phase: 'ipc', message },
});

class FakeSendTarget implements WorkerIpcWriteTarget {
  writable = true;
  readonly sent: WorkerIpcFrame[] = [];
  readonly wire: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  returnValue = true;
  throwError?: Error;

  write(data: string, callback: (error?: Error | null) => void): boolean {
    if (this.throwError) throw this.throwError;
    this.wire.push(data);
    this.sent.push(JSON.parse(data) as WorkerIpcFrame);
    this.callbacks.push(callback);
    return this.returnValue;
  }
}

test('writer has one active send, priority FIFO lanes, contiguous dispatch sequences, and pre-seq heartbeat coalescing', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  const staleHeartbeat: WorkerIpcSettlement[] = [];
  const latestHeartbeat: WorkerIpcSettlement[] = [];

  writer.enqueue(command('active'));
  assert.deepEqual(target.sent.map((frame) => [frame.kind, frame.seq]), [['command', 1]]);
  writer.enqueue(heartbeat(1), { onSettled: (value) => staleHeartbeat.push(value) });
  writer.enqueue(command('ordinary-2'));
  const replacement = writer.enqueue(heartbeat(2), { onSettled: (value) => latestHeartbeat.push(value) });
  assert.deepEqual(replacement, { accepted: true, coalesced: true });
  writer.enqueue(response('response-1'));
  writer.enqueue(response('response-2'));
  writer.enqueue(fatal());
  assert.equal(target.sent.length, 1, 'an active descriptor write is never preempted');
  assert.deepEqual(staleHeartbeat, [{ status: 'coalesced' }]);
  assert.equal(writer.getDebugState().nextSeq, 2, 'the replaced heartbeat never consumed a sequence');

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(
    target.sent.map((frame) => [frame.kind, frame.seq, frame.kind === 'heartbeat' ? frame.heartbeat.lastEventSeq : undefined]),
    [
      ['command', 1, undefined],
      ['response', 2, undefined],
      ['response', 3, undefined],
      ['fatal', 4, undefined],
      ['command', 5, undefined],
      ['heartbeat', 6, 2],
    ],
  );
  assert.deepEqual(latestHeartbeat, [{ status: 'sent', seq: 6 }]);
  assert.equal(writer.getDebugState().active, false);
});

test('writer prioritizes lifecycle over progress and bounds detail independently', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedDetailBytes: 700 });
  writer.enqueue(command('active'));
  const detail = {
    ...frameBase, kind: 'detail.delta' as const, subscriptionId: 'subscription-1',
    baseRevision: 1, revision: 2, operations: [{ op: 'appendString' as const, path: ['text'], value: 'x'.repeat(80) }],
  };
  assert.equal(writer.enqueue(detail).accepted, true);
  assert.equal(writer.enqueue({ ...detail, revision: 3, baseRevision: 2, operations: [{ op: 'appendString', path: ['text'], value: 'y'.repeat(400) }] }).accepted, false);
  writer.enqueue({ ...frameBase, kind: 'runtime.event', event: 'message.finished', payload: { requestId: 'r' } });
  writer.enqueue(command('progress'));
  writer.enqueue(response('response'));
  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind), [
    'command', 'response', 'runtime.event', 'command', 'detail.delta',
  ]);
});

test('writer validates the JSON wire form, including omitted undefined optional fields', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  const result = writer.enqueue({
    ...frameBase,
    kind: 'interrupt',
    requestId: 'interrupt',
    targetRequestId: undefined,
    reason: 'user',
  });
  assert.equal(result.accepted, true);
  assert.equal(target.sent[0]?.kind, 'interrupt');
  if (target.sent[0]?.kind === 'interrupt') {
    assert.equal(Object.prototype.hasOwnProperty.call(target.sent[0], 'targetRequestId'), false);
  }
});

test('writer rejects a huge invalid field before invoking JSON.stringify or write', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = ((value: unknown) => {
    stringifyCalls += 1;
    return originalStringify(value);
  }) as typeof JSON.stringify;
  try {
    const huge = 'x'.repeat(64 * 1024 * 1024);
    for (const draft of [
      { ...command('request'), requestId: huge },
      { ...command('request'), payload: huge },
    ]) {
      const result = writer.enqueue(draft as unknown as WorkerIpcFrameDraft);
      assert.equal(result.accepted, false);
      if (!result.accepted) assert.equal(result.reason, 'invalid');
    }
    assert.equal(stringifyCalls, 0);
    assert.equal(target.wire.length, 0);
  } finally {
    JSON.stringify = originalStringify;
  }
});

test('writer rejects invalid, oversize, and over-capacity frames without assigning sequence numbers', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedOrdinaryBytes: 300 });
  writer.enqueue(command('active'));
  const nextSeq = writer.getDebugState().nextSeq;

  const invalid = writer.enqueue({ ...command('bad'), operation: 'phase3-operation' } as unknown as WorkerIpcFrameDraft);
  assert.equal(invalid.accepted, false);
  if (!invalid.accepted) assert.equal(invalid.reason, 'invalid');
  const oversizedPath = 'x'.repeat(6 * 1024);
  const oversize = writer.enqueue({
    ...heartbeat(1),
    rootSessionPath: oversizedPath,
    leasePath: oversizedPath,
    sessionPath: oversizedPath,
  });
  assert.equal(oversize.accepted, false);
  if (!oversize.accepted) assert.equal(oversize.reason, 'oversize');
  assert.equal(writer.enqueue(command('queued-one')).accepted, true);
  const capacity = writer.enqueue(command('queued-two'));
  assert.equal(capacity.accepted, false);
  if (!capacity.accepted) assert.equal(capacity.reason, 'capacity');
  assert.equal(writer.getDebugState().nextSeq, nextSeq);
  assert.equal(target.sent.length, 1);
});

test('writer admits a single large control frame that exceeds the lane capacity', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedControlBytes: 1024 });
  const largeTranscript = 'x'.repeat(8 * 1024);
  const promote: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.promote',
    requestId: 'promote',
    operationId: 'operation-1',
    payload: {
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/work', sessionDir: '/sessions',
      sessionPath: '/session.jsonl', creationReason: 'resume',
      writeLease: {
        coordinatorGeneration: 1, workerId: 'worker', workerGeneration: 1,
        canonicalSessionPath: '/session.jsonl', ownershipRevision: 1, nonce: 'nonce',
      },
      openedPayload: { runtimeReady: false, transcript: [{ role: 'user', text: largeTranscript }] },
      modelSettings: { defaultModel: 'gpt' },
    },
  };
  const result = writer.enqueue(promote);
  assert.equal(result.accepted, true, 'a single large control frame is not rejected by the lane capacity');
  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0]?.kind, 'runtime.promote');
});

test('false send return reports backpressure and waits for the callback before continuing', () => {
  const target = new FakeSendTarget();
  target.returnValue = false;
  const backpressured: WorkerIpcFrame[] = [];
  const writer = new BoundedWorkerIpcWriter(target, { onBackpressure: (frame) => backpressured.push(frame) });

  writer.enqueue(command('one'));
  writer.enqueue(command('two'));
  assert.equal(target.sent.length, 1);
  assert.deepEqual(backpressured.map((frame) => frame.seq), [1]);
  target.callbacks.shift()!(null);
  assert.equal(target.sent.length, 2);
  assert.deepEqual(backpressured.map((frame) => frame.seq), [1, 2]);
});

test('callback error fails the writer once and settles active and queued frames deterministically', () => {
  const target = new FakeSendTarget();
  const fatalErrors: Error[] = [];
  const active: WorkerIpcSettlement[] = [];
  const queued: WorkerIpcSettlement[] = [];
  const writer = new BoundedWorkerIpcWriter(target, { onFatal: (error) => fatalErrors.push(error) });
  writer.enqueue(command('active'), { onSettled: (value) => active.push(value) });
  writer.enqueue(command('queued'), { onSettled: (value) => queued.push(value) });

  target.callbacks.shift()!(new Error('channel closed'));
  assert.equal(fatalErrors.length, 1);
  assert.equal(active[0]?.status, 'failed');
  assert.equal(queued[0]?.status, 'failed');
  assert.equal(writer.getDebugState().failed, true);
  const afterFailure = writer.enqueue(command('late'));
  assert.equal(afterFailure.accepted, false);
  if (!afterFailure.accepted) assert.equal(afterFailure.reason, 'unavailable');
});

test('send throws and explicit disconnect fail closed; disconnected targets never receive a send', () => {
  const throwing = new FakeSendTarget();
  throwing.throwError = new Error('send exploded');
  const thrownFatal: Error[] = [];
  const throwingWriter = new BoundedWorkerIpcWriter(throwing, { onFatal: (error) => thrownFatal.push(error) });
  assert.doesNotThrow(() => throwingWriter.enqueue(command('throw')));
  assert.match(thrownFatal[0]?.message ?? '', /write threw/);

  const disconnected = new FakeSendTarget();
  disconnected.writable = false;
  const disconnectedFatal: Error[] = [];
  const disconnectedWriter = new BoundedWorkerIpcWriter(disconnected, { onFatal: (error) => disconnectedFatal.push(error) });
  const result = disconnectedWriter.enqueue(command('never-sent'));
  assert.equal(result.accepted, false);
  assert.equal(disconnected.sent.length, 0);
  assert.equal(disconnectedFatal.length, 1);

  const throwingObserverTarget = new FakeSendTarget();
  throwingObserverTarget.writable = false;
  const throwingObserverWriter = new BoundedWorkerIpcWriter(throwingObserverTarget, {
    onFatal: () => { throw new Error('observer failure'); },
  });
  assert.doesNotThrow(() => throwingObserverWriter.enqueue(command('observer-safe')));

  const externallyClosed = new FakeSendTarget();
  const settlements: WorkerIpcSettlement[] = [];
  const closedWriter = new BoundedWorkerIpcWriter(externallyClosed);
  closedWriter.enqueue(command('active'), { onSettled: (value) => settlements.push(value) });
  closedWriter.handleDisconnect();
  assert.equal(settlements[0]?.status, 'failed');
  externallyClosed.callbacks.shift()!(null);
  assert.equal(settlements.length, 1, 'a late write callback cannot settle the active frame twice');
});

test('dedicated bounded reader rejects a valid delimiterless JSON frame at EOF without dispatch', async () => {
  const stream = new PassThrough();
  const frames: unknown[] = [];
  const fatals: Error[] = [];
  const detach = attachBoundedWorkerIpcReader(stream, {
    onFrame: (frame) => frames.push(frame),
    onFatal: (error) => fatals.push(error),
  });
  try {
    stream.end(JSON.stringify({ ok: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(frames, []);
    assert.equal(fatals.length, 1);
    assert.match(fatals[0]?.message ?? '', /LF delimiter/);
  } finally {
    detach();
    stream.destroy();
  }
});

test('bounded reader parses only complete under-cap JSONL and fails before parsing an overlong raw frame', async () => {
  const stream = new PassThrough();
  const frames: unknown[] = [];
  const fatals: Error[] = [];
  const detach = attachBoundedWorkerIpcReader(stream, {
    onFrame: (frame) => frames.push(frame),
    onFatal: (error) => fatals.push(error),
  });
  try {
    stream.write(`${JSON.stringify({ ok: true })}\n`);
    assert.deepEqual(frames, [{ ok: true }]);
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    for (let written = 0; written < WORKER_IPC_MAX_FRAME_BYTES; written += chunk.length) stream.write(chunk);
    stream.write('\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(frames.length, 1, 'the overlong raw descriptor input never reaches JSON.parse/frame dispatch');
    assert.match(fatals[0]?.message ?? '', /exceeds.*wire limit/);
  } finally {
    detach();
    stream.destroy();
  }
});
