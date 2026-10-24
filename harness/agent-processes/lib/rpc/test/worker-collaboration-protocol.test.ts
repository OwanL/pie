import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES,
  WORKER_IPC_VERSION,
  measureWorkerIpcMessage,
  parseCoordinatorToWorkerFrame,
  parseWorkerToCoordinatorFrame,
  type WorkerFrameExpectation,
} from '../worker-protocol.js';

const base = {
  ipcVersion: WORKER_IPC_VERSION,
  coordinatorGeneration: 2,
  workerId: 'collaboration-worker',
  workerGeneration: 3,
  workerPid: 4567,
  rootSessionPath: 'C:/sessions/worker.jsonl',
  leasePath: 'C:/sessions/worker.jsonl',
  leaseRevision: 4,
  sessionPath: 'C:/sessions/worker.jsonl',
  seq: 9,
};

const expected: WorkerFrameExpectation = {
  coordinatorGeneration: base.coordinatorGeneration,
  workerId: base.workerId,
  workerGeneration: base.workerGeneration,
  workerPid: base.workerPid,
  rootSessionPath: base.rootSessionPath,
  leasePath: base.leasePath,
  leaseRevision: base.leaseRevision,
  sessionPath: base.sessionPath,
  expectedSeq: base.seq,
};

test('collaboration operations are a closed worker protocol set and read-only access rejects them', () => {
  const control = {
    ...base,
    kind: 'session.control' as const,
    requestId: 'control-1',
    action: 'note' as const,
    payload: { target: 'Research', message: 'The shared test fixture is ready.' },
  };
  assert.equal(parseWorkerToCoordinatorFrame(control, expected).status, 'accepted');
  for (const action of ['notes.drain', 'task.assign', 'task.finish', 'wait', 'wait.cancel', 'resources', 'interrupt'] as const) {
    assert.equal(parseWorkerToCoordinatorFrame({ ...control, action }, expected).status, 'accepted', `${action} is a declared action`);
    assert.equal(parseWorkerToCoordinatorFrame({ ...control, action, access: 'read-only' }, expected).status, 'invalid', `${action} is not read-only`);
  }
  assert.equal(parseWorkerToCoordinatorFrame({ ...control, action: 'not-an-action' as never }, expected).status, 'invalid');
});

test('message.note is an allowed typed worker operation with bounded JSON parameters', () => {
  const frame = {
    ...base,
    kind: 'runtime.command' as const,
    requestId: 'note-command-1',
    operation: 'message.note' as const,
    payload: {
      publicRequestId: 'note-1',
      params: {
        sessionPath: base.sessionPath,
        note: { id: 'note-1', kind: 'note', body: 'Review the latest edit.' },
      },
    },
  };
  assert.equal(parseCoordinatorToWorkerFrame(frame, expected).status, 'accepted');
  assert.equal(parseCoordinatorToWorkerFrame({ ...frame, operation: 'unregistered-note' as never }, expected).status, 'invalid');
  assert.equal(parseCoordinatorToWorkerFrame({ ...frame, payload: { ...frame.payload, unexpected: true } }, expected).status, 'invalid');
});

test('heartbeat memory measurements remain a small validated control-plane payload', () => {
  const heartbeat = {
    ...base,
    kind: 'heartbeat' as const,
    heartbeat: {
      phase: 'busy' as const,
      activeRequestId: 'active-1',
      lastEventSeq: 12,
      lastDetailRevision: 2,
      eventLoopDelayMs: 7,
      memory: { observedAt: 1_800_000_000_000, rssBytes: 500_000_000, heapUsedBytes: 80_000_000, externalBytes: 2_000_000 },
    },
  };
  const valid = parseWorkerToCoordinatorFrame(heartbeat, expected);
  assert.equal(valid.status, 'accepted');
  const measurement = measureWorkerIpcMessage(heartbeat);
  assert.ok(measurement.ok && measurement.bytes + 1 <= WORKER_IPC_MAX_HEARTBEAT_FRAME_BYTES);

  for (const memory of [
    { ...heartbeat.heartbeat.memory, rssBytes: -1 },
    { ...heartbeat.heartbeat.memory, heapUsedBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...heartbeat.heartbeat.memory, unexpected: 1 },
    '500MB',
  ]) {
    assert.equal(parseWorkerToCoordinatorFrame({ ...heartbeat, heartbeat: { ...heartbeat.heartbeat, memory } }, expected).status, 'invalid');
  }

});
