import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  attachBoundedWorkerIpcReader,
  BoundedWorkerIpcWriter,
  WORKER_IPC_DEFAULT_RESPONSE_QUEUE_BYTES,
  WORKER_IPC_MAX_FRAME_BYTES,
  WORKER_IPC_RESPONSE_QUEUE_HEADROOM_BYTES,
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
  writer.enqueue({
    ...frameBase,
    kind: 'provider.rejected',
    requestId: 'provider-rejected',
    error: { name: 'ProviderGateSaturatedError', message: 'retry later', retryable: true, httpStatus: 429 },
  });
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
      ['provider.rejected', 4, undefined],
      ['heartbeat', 5, 2],
      ['fatal', 6, undefined],
      ['command', 7, undefined],
    ],
  );
  assert.deepEqual(latestHeartbeat, [{ status: 'sent', seq: 5 }]);
  assert.equal(writer.getDebugState().active, false);
});

test('heartbeat uses the bounded control reservation and coalesces within that lane when ordinary is full', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, {
    maxQueuedControlBytes: 1_024,
    maxQueuedOrdinaryBytes: 1,
  });
  const ordinary: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'tool.progress',
    payload: { sessionPath: '/session.jsonl', progress: 'ordinary' },
  };

  // Keep the descriptor blocked behind an ordinary frame, then saturate its
  // bounded ordinary reservation. Heartbeats must not inherit that pressure.
  assert.equal(writer.enqueue(ordinary).accepted, true);
  assert.equal(writer.enqueue(ordinary).accepted, true);
  assert.equal(writer.enqueue(ordinary).accepted, false);

  const staleHeartbeat: WorkerIpcSettlement[] = [];
  const latestHeartbeat: WorkerIpcSettlement[] = [];
  assert.equal(writer.enqueue(heartbeat(1), { onSettled: (value) => staleHeartbeat.push(value) }).accepted, true);
  assert.deepEqual(
    writer.enqueue(heartbeat(2), { onSettled: (value) => latestHeartbeat.push(value) }),
    { accepted: true, coalesced: true },
  );
  assert.equal(writer.getDebugState().queueDepth.control, 1,
    'the pending heartbeat occupies the bounded control reservation, not ordinary backlog');
  assert.deepEqual(staleHeartbeat, [{ status: 'coalesced' }]);

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(
    target.sent.map((frame) => frame.kind === 'heartbeat'
      ? [frame.kind, frame.heartbeat.lastEventSeq]
      : [frame.kind, frame.kind === 'runtime.event' ? frame.event : undefined]),
    [
      ['runtime.event', 'tool.progress'],
      ['heartbeat', 2],
      ['runtime.event', 'tool.progress'],
    ],
  );
  assert.deepEqual(latestHeartbeat, [{ status: 'sent', seq: 2 }]);
});

test('capacity diagnostics identify the rejected kind and event without including payload data', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedOrdinaryBytes: 1 });
  const ordinary = (marker: string): WorkerIpcFrameDraft => ({
    ...frameBase,
    kind: 'runtime.event',
    event: 'tool.progress',
    payload: { sessionPath: '/session.jsonl', marker },
  });

  assert.equal(writer.enqueue(ordinary('active')).accepted, true);
  assert.equal(writer.enqueue(ordinary('queued')).accepted, true);
  const rejected = writer.enqueue(ordinary('secret-payload-must-not-appear'));
  assert.equal(rejected.accepted, false);
  if (rejected.accepted) return;
  assert.equal(rejected.reason, 'capacity');
  assert.match(rejected.detail, /kind=runtime\.event event=tool\.progress/u);
  assert.doesNotMatch(rejected.detail, /secret-payload-must-not-appear/u);
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
  assert.equal(writer.enqueue({ ...detail, revision: 3, baseRevision: 2 }).accepted, false,
    'two within-reservation detail frames must still respect the reservation');
  writer.enqueue({ ...frameBase, kind: 'runtime.event', event: 'message.finished', payload: { requestId: 'r' } });
  writer.enqueue(command('progress'));
  writer.enqueue(response('response'));
  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind), [
    'command', 'response', 'runtime.event', 'command', 'detail.delta',
  ]);
});

test('mandatory non-progress events use lifecycle priority while runtime reports remain recoverable telemetry', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedOrdinaryBytes: 1_024 });
  const ordinary: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'tool.progress',
    payload: { sessionPath: '/session.jsonl', progress: 'x'.repeat(128) },
  };
  const lifecycleEvents = [
    'message.custom', 'message.queuedDelivered', 'contextUsage.changed', 'extension_ui.request',
    'preflight.failed', 'retry.started', 'retry.ended', 'retry.measured',
    'compaction.started', 'compaction.ended', 'auxiliary-llm.usage',
    'analytics.branch',
  ] as const;

  writer.enqueue(command('active'));
  assert.equal(writer.enqueue(ordinary).accepted, true);
  assert.equal(writer.enqueue(ordinary).accepted, true);
  const report = writer.enqueue({
    ...frameBase,
    kind: 'runtime.report',
    domain: 'catalog',
    payload: { models: [] },
  });
  assert.equal(report.accepted, false, 'runtime.report must not consume a reserved lifecycle slot');
  if (!report.accepted) assert.equal(report.reason, 'capacity');

  for (const event of lifecycleEvents) {
    const payload = event === 'analytics.branch'
      ? {
          sessionPath: '/session.jsonl', entryId: 'entry-1',
          selectedEntryId: 'entry-1', observedAt: 1,
        }
      : { sessionPath: '/session.jsonl' };
    assert.equal(writer.enqueue({
      ...frameBase, kind: 'runtime.event', event, payload,
    } as unknown as WorkerIpcFrameDraft).accepted, true, event);
  }
  assert.equal(writer.getDebugState().queueDepth.lifecycle, lifecycleEvents.length);

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(
    target.sent.filter((frame) => frame.kind === 'runtime.event').map((frame) => frame.event),
    [...lifecycleEvents, 'tool.progress', 'tool.progress'],
  );
});

test('provider observation stays ordered before its correlated release under backpressure', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  writer.enqueue(command('active'));
  writer.enqueue({
    ...frameBase,
    kind: 'provider.observation',
    leaseId: 'lease-1',
    observation: { classification: 'http-error', status: 400, retryable: false },
  });
  writer.enqueue({
    ...frameBase,
    kind: 'provider.release',
    requestId: 'release-1',
    leaseId: 'lease-1',
    outcome: 'failed',
  });

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind), [
    'command', 'provider.observation', 'provider.release',
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

test('an oversized lifecycle frame arriving behind small records is admitted and later records stay bounded', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedLifecycleBytes: 1024 });
  writer.enqueue(command('active'));
  const busy: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'busy.changed',
    payload: { sessionPath: '/session.jsonl', busy: true, seq: 1 },
  };
  const opened: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'session.opened',
    payload: { transcript: 'x'.repeat(32 * 1024) },
  };

  assert.equal(writer.enqueue(busy).accepted, true);
  assert.equal(writer.enqueue(opened).accepted, true,
    'a legal oversized frame must not be rejected because small records were queued first');
  assert.equal(writer.enqueue(busy).accepted, true,
    'small records must still fit behind the oversized frame within the reservation');
  assert.equal(writer.enqueue(opened).accepted, false,
    'a second oversized frame in the lane must still fail closed');

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind === 'runtime.event' ? frame.event : frame.kind), [
    'command', 'busy.changed', 'session.opened', 'busy.changed',
  ]);
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

test('analytics abort uses reserved response capacity when the ordinary lane is saturated', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedOrdinaryBytes: 300 });
  writer.enqueue(command('active'));
  assert.equal(writer.enqueue(command('queued-one')).accepted, true);
  assert.equal(writer.enqueue(command('queued-two')).accepted, false,
    'two within-reservation ordinary frames must still exceed the reservation');
  const abort = writer.enqueue({
    ...frameBase,
    kind: 'analytics.capture',
    packet: {
      version: 1,
      kind: 'detail.abort',
      deliveryId: 'delivery-1',
      generationId: 'generation-1',
      captureSubject: { kind: 'session', rootSessionId: 'root-1' },
      payloadId: 'payload-1',
      code: 'transport_incomplete',
      message: 'detail frame admission failed',
    },
  });
  assert.equal(abort.accepted, true);
  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind), ['command', 'analytics.capture', 'command']);
});

test('an exceptional oversized lifecycle frame leaves the lane reservation available for following terminals', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedLifecycleBytes: 1024 });
  writer.enqueue(command('active'));
  const opened: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'session.opened',
    payload: { transcript: 'x'.repeat(1_200) },
  };
  const busy: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'runtime.event',
    event: 'busy.changed',
    payload: { sessionPath: '/session.jsonl', busy: true, seq: 1 },
  };

  assert.equal(writer.enqueue(opened).accepted, true,
    'the first queued lifecycle frame may exceed the reservation');
  assert.equal(writer.enqueue(busy).accepted, true,
    'the oversized frame must not consume the reservation intended for following lifecycle frames');

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind === 'runtime.event' ? frame.event : frame.kind), [
    'command', 'session.opened', 'busy.changed',
  ]);
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

test('response lane admits a greater-than-1-MiB checkpoint response alongside its sync acknowledgement', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target);
  const checkpointBytes = 1024 * 1024 + 128 * 1024;
  const checkpointResponse: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'response',
    requestId: 'checkpoint',
    ok: true,
    result: {
      kind: 'runtime.command',
      payload: { checkpoint: 'x'.repeat(checkpointBytes) },
    },
  };
  const syncAck: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'sync.ack',
    requestId: 'runtime-prefs-sync',
    domain: 'runtimePrefs',
    revision: 1,
  };

  writer.enqueue(command('active'));
  assert.equal(writer.enqueue(checkpointResponse).accepted, true);
  assert.equal(writer.enqueue(syncAck).accepted, true,
    'a valid checkpoint response must not consume the acknowledgement reserve');
  assert.equal(writer.getDebugState().queueDepth.response, 2);

  while (target.callbacks.length > 0) target.callbacks.shift()!(null);
  assert.deepEqual(target.sent.map((frame) => frame.kind), ['command', 'response', 'sync.ack']);
});

test('response reservation is bounded to one maximum frame plus fixed acknowledgement headroom', () => {
  assert.equal(
    WORKER_IPC_DEFAULT_RESPONSE_QUEUE_BYTES,
    WORKER_IPC_MAX_FRAME_BYTES + WORKER_IPC_RESPONSE_QUEUE_HEADROOM_BYTES,
  );

  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedResponseBytes: 900 });
  const makeSizedResponse = (requestId: string): WorkerIpcFrameDraft => ({
    ...frameBase,
    kind: 'response',
    requestId,
    ok: true,
    result: { kind: 'runtime.command', payload: { value: 'x'.repeat(100) } },
  });

  writer.enqueue(makeSizedResponse('active'));
  assert.equal(writer.enqueue(makeSizedResponse('queued')).accepted, true);
  const capacity = writer.enqueue(makeSizedResponse('rejected'));
  assert.equal(capacity.accepted, false);
  if (!capacity.accepted) assert.equal(capacity.reason, 'capacity');
  assert.equal(target.sent.length, 1, 'the active response counts against the bounded reservation');
});

test('response reservation releases active-write bytes after overlapping responses drain', () => {
  const target = new FakeSendTarget();
  const writer = new BoundedWorkerIpcWriter(target, { maxQueuedResponseBytes: 900 });

  assert.equal(writer.enqueue(response('active')).accepted, true);
  assert.equal(writer.enqueue(response('queued')).accepted, true);
  while (target.callbacks.length > 0) target.callbacks.shift()!(null);

  assert.equal(writer.getDebugState().queueDepth.response, 0);
  assert.equal(writer.getDebugState().queuedBytes.response, 0,
    'the completed active response must not remain as phantom queued capacity');
  const singleLargeResponse: WorkerIpcFrameDraft = {
    ...frameBase,
    kind: 'response',
    requestId: 'large-after-drain',
    ok: true,
    result: { kind: 'runtime.command', payload: { value: 'x'.repeat(1_200) } },
  };
  assert.equal(writer.enqueue(singleLargeResponse).accepted, true,
    'an empty response lane still admits one frame larger than its reservation');
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
