import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTaskError, SessionTaskRegistry } from '../session-tasks.js';

const participant = (owner: string) => ({ owner, address: `pie-session:${owner}`, title: owner });
const assign = (registry: SessionTaskRegistry, operationId = 'op-1', worker = 'worker', requester = 'requester', prompt = 'do the task') => registry.assign({
  requester: participant(requester), worker: participant(worker), operationId, prompt,
});
const code = (action: () => unknown, expected: SessionTaskError['code']) => {
  assert.throws(action, error => error instanceof SessionTaskError && error.code === expected);
};

test('assignment is coordinator-owned, idempotent by operation, and exclusive per worker', async () => {
  const registry = new SessionTaskRegistry();
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => assign(registry)),
    Promise.resolve().then(() => {
      try { return assign(registry, 'op-2', 'worker', 'peer-requester', 'different work'); }
      catch (error) { assert.ok(error instanceof SessionTaskError); assert.equal(error.code, 'BUSY'); return undefined; }
    }),
  ]);
  assert.equal(first.status, 'accepted');
  assert.equal(first.revision, 1);
  assert.equal(second, undefined);
  assert.equal(assign(registry).taskId, first.taskId);
  code(() => assign(registry, 'op-1', 'worker', 'requester', 'changed task'), 'CONFLICT');
  code(() => assign(registry, 'op-3'), 'BUSY');
  assert.deepEqual(registry.inspect('peer-requester', first.taskId), []);
  assert.equal(registry.inspect('requester', first.taskId)[0]?.worker.owner, 'worker');
  assert.equal(registry.inspect('worker', first.taskId)[0]?.requester.owner, 'requester');
});

test('finish is requester-independent, worker-authenticated, immutable, and revision checked', () => {
  const registry = new SessionTaskRegistry();
  const task = assign(registry, 'peer-op', 'unrelated-worker', 'unrelated-requester');
  const result = { worker: 'unrelated-worker', taskId: task.taskId, revision: 1, outcome: 'completed' as const, result: 'verified output' };
  const committed = registry.finish(result);
  assert.equal(committed.status, 'terminal');
  assert.equal(committed.requester.owner, 'unrelated-requester');
  assert.equal(registry.finish(result), committed);
  assert.equal(registry.settled({ worker: 'unrelated-worker', operationId: 'peer-op', outcome: 'failed', result: 'late lifecycle result' }), committed);
  code(() => registry.finish({ ...result, worker: 'requester' }), 'FORBIDDEN');
  code(() => registry.finish({ ...result, result: 'different output' }), 'CONFLICT');
  code(() => registry.finish({ ...result, revision: 0 }), 'CONFLICT');
  assert.equal(registry.inspect('unrelated-requester', task.taskId)[0]?.result, 'verified output');
});

test('settlement without finish waits for explicit requester amendment; stale worker operation cannot finish it', () => {
  const registry = new SessionTaskRegistry();
  const task = assign(registry, 'run-1');
  assert.equal(registry.started('worker', 'run-1').status, 'running');
  assert.equal(registry.settled({ worker: 'worker', operationId: 'run-1' }).status, 'awaiting-result');
  code(() => registry.finish({ worker: 'worker', taskId: task.taskId, revision: 0, outcome: 'completed', result: 'late' }), 'CONFLICT');
  code(() => registry.amend({ requester: 'someone-else', taskId: task.taskId, expectedRevision: 1, prompt: 'retry', operationId: 'run-2' }), 'FORBIDDEN');
  code(() => registry.amend({ requester: 'requester', taskId: task.taskId, expectedRevision: 0, prompt: 'retry', operationId: 'run-2' }), 'CONFLICT');
  code(() => registry.amend({ requester: 'requester', taskId: task.taskId, expectedRevision: 1, prompt: 'retry', operationId: 'run-1' }), 'CONFLICT');
  const amended = registry.amend({ requester: 'requester', taskId: task.taskId, expectedRevision: 1, prompt: 'revised task', operationId: 'run-2' });
  assert.equal(amended.taskId, task.taskId);
  assert.equal(amended.worker.owner, 'worker');
  assert.equal(amended.requester.owner, 'requester');
  assert.equal(amended.revision, 2);
  assert.equal(amended.status, 'accepted');
  assert.equal(amended.prompt, 'revised task');
  code(() => registry.started('worker', 'run-1'), 'UNAVAILABLE');
  registry.started('worker', 'run-2');
  const finished = registry.finish({ worker: 'worker', taskId: task.taskId, revision: 2, outcome: 'completed', result: 'revised output' });
  assert.equal(finished.revision, 2);
  assert.equal(finished.result, 'revised output');
  const operationKeys = (registry as unknown as { operationTasks: Map<string, string> }).operationTasks;
  assert.equal(operationKeys.size, 1);
});

test('lifecycle evidence records failure/cancellation and worker retirement never invents success', () => {
  const registry = new SessionTaskRegistry();
  assign(registry, 'failed-op', 'failed-worker');
  const failedResult = registry.settled({ worker: 'failed-worker', operationId: 'failed-op', outcome: 'failed', result: 'provider error' });
  assert.equal(failedResult.status, 'terminal');
  assert.equal(failedResult.outcome, 'failed');
  assert.equal(failedResult.result, 'provider error');
  const retired = assign(registry, 'retired-op', 'retired-worker');
  registry.retireParticipant({ owner: 'retired-worker' });
  assert.equal(registry.inspect('requester', retired.taskId)[0]?.outcome, 'unknown');
  const cancelled = assign(registry, 'cancelled-op', 'cancelled-worker', 'requester-2');
  registry.retireParticipant({ owner: 'cancelled-worker', workerOutcome: 'cancelled' });
  assert.equal(registry.inspect('requester-2', cancelled.taskId)[0]?.outcome, 'cancelled');
});

test('authoritative worker interruption cancels awaiting-result work, releases capacity, and rejects a late success', () => {
  const registry = new SessionTaskRegistry();
  const task = assign(registry, 'interrupt-op');
  registry.settled({ worker: 'worker', operationId: 'interrupt-op' });
  const cancelled = registry.interruptWorker('worker');
  assert.equal(cancelled?.status, 'terminal');
  assert.equal(cancelled?.outcome, 'cancelled');
  assert.equal(registry.assign({ requester: participant('requester'), worker: participant('worker'), operationId: 'next-op', prompt: 'next work' }).status, 'accepted');
  code(() => registry.finish({ worker: 'worker', taskId: task.taskId, revision: 1, outcome: 'completed', result: 'late success' }), 'CONFLICT');
  assert.equal(registry.inspect('requester', task.taskId)[0]?.outcome, 'cancelled');
  assert.equal(registry.interruptWorker('worker')?.operationId, 'next-op', 'a later interrupt applies only to the current task');
});

test('known admission rejection releases worker; unknown admission remains fenced', () => {
  const registry = new SessionTaskRegistry();
  const rejected = assign(registry, 'reject-op', 'worker-1');
  assert.equal(registry.admissionFailed({ worker: 'worker-1', operationId: 'reject-op', status: 'rejected', error: 'known rejection' }).status, 'rejected');
  assert.equal(assign(registry, 'next-op', 'worker-1').status, 'accepted');
  const uncertain = assign(registry, 'uncertain-op', 'worker-2', 'requester-2');
  assert.equal(registry.admissionFailed({ worker: 'worker-2', operationId: 'uncertain-op', status: 'unknown' }).status, 'unknown');
  code(() => assign(registry, 'next-uncertain-op', 'worker-2', 'requester-2'), 'BUSY');
  assert.equal(registry.started('worker-2', 'uncertain-op').status, 'running');
  assert.equal(registry.inspect('requester', rejected.taskId)[0]?.status, 'rejected');
  assert.equal(registry.inspect('requester-2', uncertain.taskId)[0]?.status, 'running');
});

test('late lost acknowledgements cannot regress known execution or strand amendment', () => {
  const registry = new SessionTaskRegistry();
  const task = assign(registry, 'late-ack');
  registry.admissionFailed({ worker: 'worker', operationId: 'late-ack', status: 'unknown', error: 'Acknowledgement timed out' });
  const running = registry.started('worker', 'late-ack');
  assert.equal(running.error, undefined);
  assert.equal(registry.admissionFailed({ worker: 'worker', operationId: 'late-ack', status: 'unknown', error: 'Late transport failure' }), running);
  const awaiting = registry.settled({ worker: 'worker', operationId: 'late-ack' });
  assert.equal(registry.admissionFailed({ worker: 'worker', operationId: 'late-ack', status: 'unknown', error: 'Even later failure' }), awaiting);
  const amended = registry.amend({ requester: 'requester', taskId: task.taskId, expectedRevision: 1, prompt: 'Record the missing result', operationId: 'amended' });
  assert.equal(amended.revision, 2);
  registry.admissionFailed({ worker: 'worker', operationId: 'amended', status: 'unknown', error: 'No admission acknowledgement' });
  const finished = registry.finish({ worker: 'worker', taskId: task.taskId, revision: 2, outcome: 'completed', result: 'Verified result' });
  assert.equal(finished.error, undefined, 'conclusive completion replaces transient admission ambiguity');
});

test('requester close retains result; privacy deletion purges records for either participant', () => {
  const registry = new SessionTaskRegistry();
  const retained = assign(registry, 'retain-op', 'worker-1');
  registry.finish({ worker: 'worker-1', taskId: retained.taskId, revision: 1, outcome: 'completed', result: 'kept result' });
  registry.retireParticipant({ owner: 'requester' });
  assert.equal(registry.inspect('requester', retained.taskId)[0]?.result, 'kept result');
  const removed = assign(registry, 'delete-op', 'worker-2', 'requester-2');
  registry.retireParticipant({ owner: 'requester-2', deleted: true });
  assert.deepEqual(registry.inspect('worker-2', removed.taskId), []);
  assert.equal(registry.inspect('requester-2', removed.taskId).length, 0);
  assert.equal(assign(registry, 'delete-op', 'worker-2', 'requester-2').taskId === removed.taskId, false);
});

test('bounded active records, total records, and UTF-8 text reject admission without dropping evidence', () => {
  const registry = new SessionTaskRegistry({ maxActive: 1, maxRecords: 2, maxTextBytes: 2048, maxPromptBytes: 8, maxResultBytes: 8 });
  const first = assign(registry, 'one', 'worker-1', 'requester-1', '12345678');
  code(() => assign(registry, 'too-large', 'worker-2', 'requester-2', '123456789'), 'INVALID');
  code(() => assign(registry, 'active-full', 'worker-2', 'requester-2', 'work'), 'CAPACITY');
  registry.finish({ worker: 'worker-1', taskId: first.taskId, revision: 1, outcome: 'completed', result: '12345678' });
  const second = assign(registry, 'two', 'worker-2', 'requester-2', 'work');
  registry.finish({ worker: 'worker-2', taskId: second.taskId, revision: 1, outcome: 'completed', result: '12345678' });
  const third = assign(registry, 'three', 'worker-3', 'requester-3', 'work');
  assert.equal(registry.lookup('requester-1', first.taskId).status, 'unavailable');
  assert.equal(registry.inspect('requester-2', second.taskId)[0]?.result, '12345678');
  code(() => assign(registry, 'four', 'worker-4', 'requester-4', 'work'), 'CAPACITY');
  assert.equal(registry.inspect('requester-3', third.taskId)[0]?.status, 'accepted');
});

test('active tasks reserve result capacity at admission instead of becoming unfinishable under text pressure', () => {
  const registry = new SessionTaskRegistry({ maxActive: 3, maxRecords: 10, maxTextBytes: 1700, maxPromptBytes: 600, maxResultBytes: 300 });
  const first = assign(registry, 'capacity-one', 'worker-1', 'requester-1', 'a'.repeat(500));
  code(() => assign(registry, 'capacity-two', 'worker-2', 'requester-2', 'b'.repeat(300)), 'CAPACITY');
  const result = registry.finish({ worker: 'worker-1', taskId: first.taskId, revision: 1, outcome: 'completed', result: 'c'.repeat(200) });
  assert.equal(result.status, 'terminal');
  assert.equal(result.result, 'c'.repeat(200));
  assert.equal(assign(registry, 'capacity-two', 'worker-2', 'requester-2', 'b'.repeat(300)).status, 'accepted');
});

test('an admitted task can settle without a result even at its minimum text budget', () => {
  const makeRegistry = (maxTextBytes: number) => new SessionTaskRegistry({ maxTextBytes, maxResultBytes: 8 });
  // Find the admission boundary through the public API rather than copying its
  // internal accounting formula into the test.
  let lower = 1;
  let upper = 2048;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper) / 2);
    try { assign(makeRegistry(candidate), 'settle-boundary'); upper = candidate; }
    catch (error) {
      assert.ok(error instanceof SessionTaskError && error.code === 'CAPACITY');
      lower = candidate + 1;
    }
  }
  const registry = makeRegistry(lower);
  const task = assign(registry, 'settle-boundary');
  registry.started('worker', 'settle-boundary');
  registry.admissionFailed({ worker: 'worker', operationId: 'settle-boundary', status: 'unknown', error: '12345678' });
  assert.equal(registry.settled({ worker: 'worker', operationId: 'settle-boundary' }).status, 'awaiting-result');
  assert.equal(registry.finish({ worker: 'worker', taskId: task.taskId, revision: 1, outcome: 'completed', result: '12345678' }).status, 'terminal');
});

test('default swarm capacity admits and finishes 64 maximum-size Unicode-safe tasks', () => {
  const registry = new SessionTaskRegistry();
  const prompt = '\u0000'.repeat(16 * 1024);
  const result = '\u0000'.repeat(32 * 1024);
  const tasks = Array.from({ length: 64 }, (_, index) => registry.assign({
    requester: { owner: 'r'.repeat(512), address: 'r'.repeat(1024), title: 'r'.repeat(256) },
    worker: { owner: `w${index}` + 'w'.repeat(510 - String(index).length), address: 'a'.repeat(1024), title: 't'.repeat(256) },
    operationId: `${index}` + 'o'.repeat(510 - String(index).length), prompt,
  }));
  assert.equal(tasks.length, 64);
  for (const task of tasks) {
    const finished = registry.finish({ worker: task.worker.owner, taskId: task.taskId, revision: 1, outcome: 'completed', result });
    assert.equal(finished.status, 'terminal');
    assert.equal(finished.result, result);
  }
  assert.equal(registry.inspect(tasks[0]!.requester.owner).length, 64);
});

test('UTF-8 field accounting and lifecycle error reservations handle control and multibyte text', () => {
  const registry = new SessionTaskRegistry({ maxTextBytes: 2048, maxPromptBytes: 32, maxResultBytes: 300 });
  const task = assign(registry, 'unicode', 'worker', 'requester', '\u0001'.repeat(32));
  const failed = registry.admissionFailed({ worker: 'worker', operationId: 'unicode', status: 'unknown', error: '😀'.repeat(1000) });
  assert.equal(Buffer.byteLength(failed.error ?? '', 'utf8'), 300);
  const settled = registry.settled({ worker: 'worker', operationId: 'unicode', outcome: 'failed', result: '😀'.repeat(1000) });
  assert.equal(Buffer.byteLength(settled.result ?? '', 'utf8'), 300);
  assert.equal(registry.lookup('requester', task.taskId).status, 'available');
  assert.equal(registry.assign({ requester: participant('requester'), worker: participant('worker-2'), operationId: 'after-unicode', prompt: 'next' }).status, 'accepted');
});

test('capacity evicts only oldest terminal evidence and missing lookup is explicitly unavailable', () => {
  const registry = new SessionTaskRegistry({ maxActive: 2, maxRecords: 2 });
  const first = assign(registry, 'first', 'worker-1', 'requester-1');
  registry.finish({ worker: 'worker-1', taskId: first.taskId, revision: 1, outcome: 'completed', result: 'first result' });
  const second = assign(registry, 'second', 'worker-2', 'requester-2');
  registry.finish({ worker: 'worker-2', taskId: second.taskId, revision: 1, outcome: 'completed', result: 'second result' });
  const third = assign(registry, 'third', 'worker-3', 'requester-3');
  assert.equal(registry.lookup('requester-1', first.taskId).status, 'unavailable');
  assert.equal(registry.lookup('requester-2', second.taskId).status, 'available');
  assert.equal(registry.inspect('requester-3', third.taskId)[0]?.status, 'accepted');
  assert.equal(registry.inspect('requester-1').length, 0);
});

test('capacity never evicts unknown or awaiting-result work', () => {
  const registry = new SessionTaskRegistry({ maxActive: 2, maxRecords: 2 });
  const unknown = assign(registry, 'unknown', 'worker-1', 'requester-1');
  registry.admissionFailed({ worker: 'worker-1', operationId: 'unknown', status: 'unknown' });
  const awaiting = assign(registry, 'awaiting', 'worker-2', 'requester-2');
  registry.settled({ worker: 'worker-2', operationId: 'awaiting' });
  code(() => assign(registry, 'third', 'worker-3', 'requester-3'), 'CAPACITY');
  assert.equal(registry.lookup('requester-1', unknown.taskId).status, 'available');
  assert.equal(registry.lookup('requester-2', awaiting.taskId).status, 'available');
});

test('record subscriptions are bounded and observe committed state', () => {
  const registry = new SessionTaskRegistry({ maxListeners: 1 });
  const task = assign(registry);
  let observedCommitted = false;
  const unsubscribe = registry.subscribe(change => {
    if (change.type === 'changed' && change.record.status === 'terminal') {
      observedCommitted = registry.inspect('requester', change.record.taskId)[0]?.result === 'done';
    }
  });
  code(() => registry.subscribe(() => undefined), 'CAPACITY');
  registry.finish({ worker: 'worker', taskId: task.taskId, revision: 1, outcome: 'completed', result: 'done' });
  assert.equal(observedCommitted, true);
  unsubscribe();
  registry.subscribe(() => undefined)();
});

test('listener errors cannot interrupt a committed mutation or poison later mutations', () => {
  const registry = new SessionTaskRegistry();
  const unsubscribe = registry.subscribe(() => { throw new Error('observer failed'); });
  const task = assign(registry);
  const finished = registry.finish({ worker: 'worker', taskId: task.taskId, revision: 1, outcome: 'completed', result: 'done' });
  const lookup = registry.lookup('requester', task.taskId);
  assert.equal(lookup.status, 'available');
  if (lookup.status === 'available') assert.equal(lookup.record, finished);
  unsubscribe();
  assert.equal(assign(registry, 'next', 'worker').status, 'accepted');
});

test('privacy purge publishes unavailable evidence and removes worker reservation', () => {
  const registry = new SessionTaskRegistry();
  const task = assign(registry);
  let removed = false;
  registry.subscribe(change => {
    if (change.type !== 'removed') return;
    assert.equal(change.taskId, task.taskId);
    assert.deepEqual(change.owners, ['requester', 'worker']);
    assert.deepEqual(registry.inspect('requester', task.taskId), []);
    removed = true;
  });
  registry.retireParticipant({ owner: 'worker', deleted: true });
  assert.equal(removed, true);
  assert.deepEqual(registry.inspect('requester', task.taskId), []);
  assert.equal(assign(registry, 'new-task', 'worker').status, 'accepted');
});
