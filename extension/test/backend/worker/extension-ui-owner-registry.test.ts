import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExtensionUiOwnerRegistry,
  EXTENSION_UI_PENDING_PER_SESSION_LIMIT,
  EXTENSION_UI_PENDING_TOTAL_LIMIT,
} from '../../../src/backend/extension-ui-owner-registry';

const owner = {
  sessionPath: '/sessions/a.jsonl',
  workerId: 'worker-a',
  workerGeneration: 1,
  uiRequestId: 'ui-1',
  subagentCallId: 'sub-1',
  toolCallId: 'tool-1',
};

test('registry records one exact owner and resolves only the same worker generation', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record(owner);
  assert.equal(registry.size, 1);
  const resolved = registry.resolve('/sessions/a.jsonl', 'ui-1', { workerId: 'worker-a', workerGeneration: 1 });
  assert.ok(resolved);
  assert.equal(resolved.uiRequestId, 'ui-1');
  assert.equal(resolved.subagentCallId, 'sub-1');
  assert.equal(resolved.toolCallId, 'tool-1');
  // A different live generation must not receive the response.
  assert.equal(registry.resolve('/sessions/a.jsonl', 'ui-1', { workerId: 'worker-a', workerGeneration: 2 }), undefined);
  // A different session path must not receive the response.
  assert.equal(registry.resolve('/sessions/b.jsonl', 'ui-1', { workerId: 'worker-a', workerGeneration: 1 }), undefined);
});

test('registry settles exactly once; duplicates and mismatches are typed stale', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record(owner);
  registry.settle('/sessions/a.jsonl', 'ui-1');
  assert.equal(registry.size, 0);
  assert.equal(registry.resolve('/sessions/a.jsonl', 'ui-1', { workerId: 'worker-a', workerGeneration: 1 }), undefined);
  // Settling an unknown id is idempotent.
  registry.settle('/sessions/a.jsonl', 'ui-1');
  assert.equal(registry.size, 0);
});

test('registry clears every owner of one worker generation on crash/kill/retire', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record(owner);
  registry.record({ ...owner, uiRequestId: 'ui-2' });
  registry.record({ ...owner, workerId: 'worker-b', uiRequestId: 'ui-3' });
  registry.clearWorker('worker-a', 1);
  assert.equal(registry.size, 1);
  assert.equal(registry.resolve('/sessions/a.jsonl', 'ui-1', { workerId: 'worker-a', workerGeneration: 1 }), undefined);
  assert.equal(registry.resolve('/sessions/a.jsonl', 'ui-2', { workerId: 'worker-a', workerGeneration: 1 }), undefined);
  assert.ok(registry.resolve('/sessions/a.jsonl', 'ui-3', { workerId: 'worker-b', workerGeneration: 1 }));
  // Clearing again is idempotent.
  registry.clearWorker('worker-a', 1);
  assert.equal(registry.size, 1);
});

test('registry expires timed-out owners after the dialog timeout plus grace', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record({ ...owner, uiRequestId: 'ui-timeout' });
  registry.attachMetadata('ui-timeout', { method: 'select', timeoutMs: 30_000 });
  // Not yet expired.
  assert.ok(registry.resolve('/sessions/a.jsonl', 'ui-timeout', { workerId: 'worker-a', workerGeneration: 1 }));
  // Rewind the recordedAt past the timeout+grace window (test seam over the
  // private map; expiry must be deterministic, never a wall-clock race).
  const backdated = registry as unknown as {
    pending: Map<string, { recordedAt: number; sessionPath: string; uiRequestId: string }>;
  };
  for (const entry of backdated.pending.values()) {
    if (entry.uiRequestId === 'ui-timeout') entry.recordedAt = Date.now() - 60_000;
  }
  assert.equal(registry.resolve('/sessions/a.jsonl', 'ui-timeout', { workerId: 'worker-a', workerGeneration: 1 }), undefined);
  assert.equal(registry.size, 0);
});

test('registry is bounded per session and in total and rejects exact duplicates', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record(owner);
  assert.throws(() => registry.record(owner));
  registry.settle('/sessions/a.jsonl', 'ui-1');
  for (let index = 0; index < EXTENSION_UI_PENDING_PER_SESSION_LIMIT; index += 1) {
    registry.record({ ...owner, uiRequestId: `ui-${index}` });
  }
  assert.throws(() => registry.record({ ...owner, uiRequestId: 'overflow' }));
  // Other sessions can still record until the total cap (per-session 64 < total 512).
  const otherSessions = Math.floor((EXTENSION_UI_PENDING_TOTAL_LIMIT - EXTENSION_UI_PENDING_PER_SESSION_LIMIT) / EXTENSION_UI_PENDING_PER_SESSION_LIMIT);
  for (let session = 0; session < otherSessions; session += 1) {
    for (let index = 0; index < EXTENSION_UI_PENDING_PER_SESSION_LIMIT; index += 1) {
      registry.record({ ...owner, sessionPath: `/sessions/other-${session}.jsonl`, uiRequestId: `other-${session}-${index}` });
    }
  }
  assert.equal(registry.size, EXTENSION_UI_PENDING_TOTAL_LIMIT);
  assert.throws(() => registry.record({ ...owner, sessionPath: '/sessions/third.jsonl', uiRequestId: 'total-overflow' }));
  assert.throws(() => registry.record(owner));
});

test('registry inspect is a bounded diagnostic snapshot', () => {
  const registry = new ExtensionUiOwnerRegistry();
  registry.record(owner);
  const snapshot = registry.inspect();
  assert.deepEqual(snapshot, [{
    sessionPath: owner.sessionPath,
    workerId: owner.workerId,
    workerGeneration: owner.workerGeneration,
    uiRequestId: owner.uiRequestId,
    method: 'confirm',
    recordedAt: snapshot[0]!.recordedAt,
  }]);
  assert.equal(typeof snapshot[0]!.recordedAt, 'number');
});
