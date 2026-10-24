import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionCollaborationCoordinator, type CollaborationPorts } from '../session-collaboration.js';
import type { WorkerJsonObject } from '../../lib/rpc/worker-protocol.js';
import { SessionNoteAdmission, type SessionNoteAdmissionOptions } from '../session-note-admission.js';
import { BackendLiveTurnAccumulator } from '../../workers/live-turn-accumulator.js';

const paths = { a: 'session:a', b: 'session:b', c: 'session:c' } as const;
const people = {
  [paths.a]: { owner: 'owner-a', address: 'reply:a', title: 'A' },
  [paths.b]: { owner: 'owner-b', address: 'reply:b', title: 'B' },
  [paths.c]: { owner: 'owner-c', address: 'reply:c', title: 'C' },
};

function setup(noteLimits: SessionNoteAdmissionOptions = {}, drainTimeoutMs = 20_000) {
  const identities: Record<string, { owner: string; address: string; title: string }> = structuredClone(people);
  const cold = new Set<string>();
  const busy = new Set<string>();
  let noteMode: 'ok' | 'reject' | 'delay' | 'delay-reject' | 'status-unknown' | 'known-reject' | 'unavailable' | 'sync-throw' = 'ok';
  let assignmentGate: Promise<WorkerJsonObject> | undefined;
  let markAssignmentStarted: (() => void) | undefined;
  let assignmentStarted: Promise<void> | undefined;
  let finishAssignment: ((result: WorkerJsonObject) => void) | undefined;
  const finishDeliveries: Array<() => void> = [];
  const delivered: Array<{ path: string; payload: WorkerJsonObject }> = [];
  const ports: CollaborationPorts = {
    resolve(target, sourcePath) {
      const path = target === 'self' ? sourcePath : target;
      const participant = identities[path];
      if (!participant) throw new Error('unknown target');
      return { path, participant };
    },
    participant(path) {
      const participant = identities[path];
      if (!participant) throw new Error('unknown participant');
      return participant;
    },
    sender(path) {
      const person = identities[path];
      if (!person) throw new Error('unknown sender');
      return { address: person.address, title: person.title } as never;
    },
    busy(path) { return busy.has(path); },
    async assignment(_source, target, prompt, operationId) {
      if (assignmentGate) {
        markAssignmentStarted?.();
        return await assignmentGate;
      }
      return { status: 'accepted', target, prompt, operationId };
    },
    note(path, payload) {
      if (cold.has(path)) return undefined;
      delivered.push({ path, payload });
      if (noteMode === 'sync-throw') throw new Error('send admission is closed');
      if (noteMode === 'known-reject') return Promise.resolve({ status: 'rejected', outcome: 'recipient_queue_edit', error: 'queue edit active' });
      if (noteMode === 'unavailable') return Promise.resolve({ status: 'unavailable', error: 'custom delivery unavailable' });
      if (noteMode === 'status-unknown') return Promise.resolve({ status: 'unknown', error: 'recipient outcome unknown' });
      if (noteMode === 'reject') return Promise.reject(new Error('route closed before acknowledgement'));
      if (noteMode === 'delay' || noteMode === 'delay-reject') {
        const result = noteMode === 'delay-reject' ? { status: 'rejected', error: 'queue edit active' } : { status: 'accepted' };
        return new Promise(resolve => finishDeliveries.push(() => resolve(result)));
      }
      return Promise.resolve({ status: 'accepted' });
    },
    workerMemory() { return { workers: [{ address: 'reply:b', memory: { freshness: 'fresh' } }], total: 1, truncated: false }; },
  };
  const coordinator = new SessionCollaborationCoordinator(ports, { noteAdmission: new SessionNoteAdmission(noteLimits), drainTimeoutMs });
  return {
    coordinator,
    delivered,
    setAddress(path: string, address: string) { identities[path]!.address = address; },
    setCold(path: string, value: boolean) { if (value) cold.add(path); else cold.delete(path); },
    setBusy(path: string, value: boolean) { if (value) busy.add(path); else busy.delete(path); },
    delayAssignment() {
      assignmentStarted = new Promise<void>(resolve => { markAssignmentStarted = resolve; });
      assignmentGate = new Promise<WorkerJsonObject>(resolve => { finishAssignment = resolve; });
      return {
        started: assignmentStarted,
        finish(result: WorkerJsonObject = { status: 'accepted' }) {
          finishAssignment?.(result);
          assignmentGate = undefined;
          finishAssignment = undefined;
          markAssignmentStarted = undefined;
        },
      };
    },
    setNoteMode(value: 'ok' | 'reject' | 'delay' | 'delay-reject' | 'status-unknown' | 'known-reject' | 'unavailable' | 'sync-throw') { noteMode = value; },
    finishDeliveries() { for (const finish of finishDeliveries.splice(0)) finish(); },
  };
}

const execute = (coordinator: SessionCollaborationCoordinator, action: Parameters<SessionCollaborationCoordinator['execute']>[0],
  payload: WorkerJsonObject, sourcePath = paths.a, requestId = 'request-1') => coordinator.execute(action, payload, sourcePath, requestId);

test('resource availability waits observe release without acquiring or waking a worker', async () => {
  const { coordinator, delivered } = setup();
  const reserved = await execute(coordinator, 'resources', { action: 'acquire', name: 'GPU:0', purpose: 'render' });
  const leaseId = (reserved.lease as WorkerJsonObject).leaseId as string;
  const pending = execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'resource-b', timeoutMs: 1_000 }, paths.b);
  await assert.rejects(execute(coordinator, 'wait', { waitId: 'second-b', timeoutMs: 1_000 }, paths.b), /One active wait/u);
  await execute(coordinator, 'resources', { action: 'release', leaseId });
  const available = await pending;
  assert.equal(available.reason, 'available');
  assert.equal(available.compatible, true);
  assert.equal(available.acquired, false);
  assert.equal(delivered.length, 0);
  assert.deepEqual(available.resources, []);
  const alreadyFree = await execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'already-free', timeoutMs: 1_000 }, paths.c);
  assert.equal(alreadyFree.reason, 'available', 'release before registration cannot be missed');
  assert.equal((await execute(coordinator, 'resources', { action: 'acquire', name: 'gpu:0', purpose: 'next render' }, paths.c)).outcome, 'acquired');
  coordinator.dispose();
});

test('resource acquire and wait share trimmed lowercase Unicode name normalization and bounds', async () => {
  const { coordinator } = setup();
  const cjkName = '界'.repeat(60);
  const acquired = await execute(coordinator, 'resources', {
    action: 'acquire', name: cjkName, purpose: 'Unicode resource name',
  }, paths.a);
  assert.equal(acquired.outcome, 'acquired', '60 code points are valid despite using 180 UTF-8 bytes');
  const cjkWait = await execute(coordinator, 'resources', {
    action: 'wait', name: ` ${cjkName} `, waitId: 'cjk-wait', timeoutMs: 0,
  }, paths.b);
  assert.equal(cjkWait.name, cjkName.toLowerCase());
  assert.equal(cjkWait.compatible, false);
  assert.equal((cjkWait.resources as WorkerJsonObject[])[0]?.name, cjkName.toLowerCase());

  const mixed = await execute(coordinator, 'resources', {
    action: 'acquire', name: '  MiXeD:Name  ', purpose: 'case and trim equivalence',
  }, paths.b);
  assert.equal(mixed.outcome, 'acquired');
  const mixedWait = await execute(coordinator, 'resources', {
    action: 'wait', name: ' mixed:name ', waitId: 'mixed-wait', timeoutMs: 0,
  }, paths.c);
  assert.equal(mixedWait.name, 'mixed:name');
  assert.equal(mixedWait.compatible, false);

  const emojiWait = await execute(coordinator, 'resources', {
    action: 'wait', name: '🙂'.repeat(96), waitId: 'emoji-wait', timeoutMs: 0,
  }, paths.c);
  assert.equal(emojiWait.reason, 'inspection', '96 astral Unicode code points are within the public bound');
  assert.equal(emojiWait.name, '🙂'.repeat(96));

  const dottedI = 'İ'.repeat(48);
  assert.equal((await execute(coordinator, 'resources', {
    action: 'acquire', name: dottedI, purpose: 'lowercase expansion at bound',
  }, paths.c)).outcome, 'acquired');
  const dottedIWait = await execute(coordinator, 'resources', {
    action: 'wait', name: dottedI, waitId: 'dotted-i-wait', timeoutMs: 0,
  }, paths.a);
  assert.equal(dottedIWait.name, 'i\u0307'.repeat(48));
  assert.equal(dottedIWait.compatible, false);

  await assert.rejects(execute(coordinator, 'resources', {
    action: 'acquire', name: 'x'.repeat(97), purpose: 'too many source code points',
  }, paths.a), /96 Unicode characters/u);
  await assert.rejects(execute(coordinator, 'resources', {
    action: 'wait', name: 'x'.repeat(97), waitId: 'too-many-raw', timeoutMs: 0,
  }, paths.a), /96 Unicode characters/u);
  await assert.rejects(execute(coordinator, 'resources', {
    action: 'acquire', name: 'İ'.repeat(49), purpose: 'canonical lowercase expansion is too long',
  }, paths.a), /after lowercase normalization/u);
  await assert.rejects(execute(coordinator, 'resources', {
    action: 'wait', name: 'İ'.repeat(49), waitId: 'too-long-expansion', timeoutMs: 0,
  }, paths.a), /after lowercase normalization/u);
  coordinator.dispose();
});

test('resource views expose contactable owners and privacy deletion keeps only a conflicting tombstone', async () => {
  const { coordinator, setAddress } = setup();
  const longAddress = `pie-reply:${'x'.repeat(700)}`;
  setAddress(paths.a, longAddress);
  const acquired = await execute(coordinator, 'resources', { action: 'acquire', name: 'private:render', purpose: 'private render subject' });
  const lease = acquired.lease as WorkerJsonObject;
  assert.deepEqual(lease.owner, { address: longAddress, title: 'A' });
  assert.equal(lease.ownerAddress, undefined);
  assert.equal(JSON.stringify(acquired).includes('owner-a'), false);
  await execute(coordinator, 'resources', { action: 'start', leaseId: lease.leaseId as string });
  coordinator.retire(paths.a, true);
  const status = await execute(coordinator, 'resources', { action: 'status', name: 'private:render' }, paths.b);
  const tombstone = ((status.resources as WorkerJsonObject[])[0]?.holders as WorkerJsonObject[])[0]!;
  assert.equal(tombstone.state, 'orphaned');
  assert.deepEqual(tombstone.owner, { deleted: true });
  assert.equal(tombstone.leaseId, lease.leaseId);
  for (const privateText of ['owner-a', longAddress, 'private render subject']) assert.equal(JSON.stringify(status).includes(privateText), false);
  const busy = await execute(coordinator, 'resources', { action: 'acquire', name: 'private:render', purpose: 'new work' }, paths.b);
  assert.equal(busy.outcome, 'busy');
  const reclaimed = await execute(coordinator, 'resources', { action: 'reclaim', leaseId: lease.leaseId as string, confirmStopped: true, reason: 'Verified the owned render process stopped.' }, paths.b);
  assert.equal(JSON.stringify(reclaimed).includes('owner-b'), false);
  assert.equal(reclaimed.outcome, 'reclaimed');
  coordinator.dispose();
});

test('shared and exclusive resource waiters use compatibility rather than notification counts', async () => {
  const { coordinator } = setup();
  const one = await execute(coordinator, 'resources', { action: 'acquire', name: 'checkout:pie', purpose: 'read', mode: 'shared' });
  const two = await execute(coordinator, 'resources', { action: 'acquire', name: 'checkout:pie', purpose: 'read', mode: 'shared' }, paths.b);
  assert.equal((await execute(coordinator, 'resources', { action: 'wait', name: 'checkout:pie', mode: 'shared', waitId: 'shared-c', timeoutMs: 1_000 }, paths.c)).compatible, true);
  let resolved = false;
  const exclusive = execute(coordinator, 'resources', { action: 'wait', name: 'checkout:pie', waitId: 'exclusive-c', timeoutMs: 1_000 }, paths.c).then(result => { resolved = true; return result; });
  await execute(coordinator, 'resources', { action: 'release', leaseId: (one.lease as WorkerJsonObject).leaseId as string });
  await Promise.resolve();
  assert.equal(resolved, false, 'another shared holder still conflicts');
  await execute(coordinator, 'resources', { action: 'release', leaseId: (two.lease as WorkerJsonObject).leaseId as string }, paths.b);
  assert.equal((await exclusive).compatible, true);
  coordinator.dispose();
});

test('resource wait cancellation is owner scoped, close cancels, and notes interrupt without a route wake', async () => {
  const { coordinator, delivered } = setup();
  await execute(coordinator, 'resources', { action: 'acquire', name: 'gpu:0', purpose: 'render' });
  let resolved = false;
  const cancelled = execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'cancel-resource', timeoutMs: 1_000 }, paths.b).then(result => { resolved = true; return result; });
  await execute(coordinator, 'wait.cancel', { waitId: 'cancel-resource' }, paths.c);
  await Promise.resolve();
  assert.equal(resolved, false);
  await execute(coordinator, 'wait.cancel', { waitId: 'cancel-resource' }, paths.b);
  assert.equal((await cancelled).reason, 'cancelled');
  const closed = execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'close-resource', timeoutMs: 1_000 }, paths.b);
  coordinator.retire(paths.b);
  assert.equal((await closed).reason, 'cancelled');
  const informed = execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'mail-resource', timeoutMs: 1_000 }, paths.c);
  await execute(coordinator, 'note', { target: paths.c, message: 'Render is nearly done; inspect the output path.' });
  const result = await informed;
  assert.equal(result.reason, 'mail');
  assert.equal(result.compatible, false);
  assert.equal((result.messages as WorkerJsonObject[])[0]?.body, 'Render is nearly done; inspect the output path.');
  assert.equal(delivered.length, 0);
  coordinator.dispose();
});

test('resource wait deadline observes abandoned reservations but never frees expired active work', async () => {
  const { coordinator } = setup();
  await execute(coordinator, 'resources', { action: 'acquire', name: 'gpu:0', purpose: 'abandoned reservation', startWithinMs: 1_000 });
  const expiredReservation = await execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'reserved-expiry', timeoutMs: 2_000 }, paths.b);
  assert.equal(expiredReservation.reason, 'available');
  const active = await execute(coordinator, 'resources', { action: 'acquire', name: 'gpu:0', purpose: 'running work', ttlMs: 1_000 });
  await execute(coordinator, 'resources', { action: 'start', leaseId: (active.lease as WorkerJsonObject).leaseId as string });
  const expiredActive = await execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'active-expiry', timeoutMs: 1_050 }, paths.b);
  assert.equal(expiredActive.reason, 'timeout');
  assert.equal(expiredActive.compatible, false);
  assert.equal(((expiredActive.resources as WorkerJsonObject[])[0]?.holders as WorkerJsonObject[])[0]?.state, 'expired-active');
  coordinator.dispose();
});

test('cold notes remain retained until a hot control-lane drain dispatches them', async () => {
  const { coordinator, delivered, setCold } = setup();
  setCold(paths.b, true);
  const accepted = await execute(coordinator, 'note', { target: paths.b, message: 'inspect the fixture first' });
  assert.equal(accepted.delivery, 'mailbox');
  assert.equal(accepted.wake, false);
  assert.equal(delivered.length, 0);

  const stillCold = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(stillCold.retained, 1);
  assert.equal(delivered.length, 0);

  setCold(paths.b, false);
  const drained = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(drained.attempted, 1);
  assert.equal(drained.retained, 0);
  assert.equal((drained.issues as WorkerJsonObject[]).length, 0);
  assert.equal(delivered[0]?.payload.body, 'inspect the fixture first');
  assert.equal((await execute(coordinator, 'notes.drain', {}, paths.b)).attempted, 0);
  coordinator.dispose();
});

test('known cold-mail delivery rejection stays retained, counts against capacity, and can be retried', async () => {
  const { coordinator, setCold, setNoteMode, delivered } = setup();
  setCold(paths.b, true);
  const receipt = await execute(coordinator, 'note', { target: paths.b, message: 'retain on known pre-enqueue reject' }, paths.a);
  assert.equal(receipt.delivery, 'mailbox');
  await execute(coordinator, 'note', { target: paths.b, message: 'second item' }, paths.a, 'request-second');
  setCold(paths.b, false);
  setNoteMode('known-reject');
  const rejected = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(rejected.attempted, 1);
  assert.equal(rejected.retained, 2);
  assert.deepEqual(rejected.issues, [{ id: (delivered[0]?.payload.id as string), status: 'rejected', retained: true, error: 'queue edit active' }]);
  setNoteMode('ok');
  const retried = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(retried.attempted, 2, 'the later note remains behind the retained rejection');
  assert.equal(retried.retained, 0);
  coordinator.dispose();
});

test('in-flight control-lane delivery continues to occupy mailbox capacity', async () => {
  const { coordinator, setCold, setNoteMode, finishDeliveries } = setup({
    pairBurst: 100,
    recipientBurst: 100,
  });
  setCold(paths.b, true);
  for (let index = 0; index < 63; index++) {
    await execute(coordinator, 'note', { target: paths.b, message: `retained ${index}` }, paths.a, `request-${index}`);
  }
  setCold(paths.b, false);
  setNoteMode('delay');
  const draining = execute(coordinator, 'notes.drain', {}, paths.b);
  await Promise.resolve();
  setCold(paths.b, true);
  assert.equal((await execute(coordinator, 'note', { target: paths.b, message: 'fills last slot' }, paths.a, 'request-fill')).delivery, 'mailbox');
  await assert.rejects(execute(coordinator, 'note', { target: paths.b, message: 'must not exceed capacity' }, paths.a, 'request-overflow'), /Mailbox capacity/u);
  finishDeliveries();
  const result = await draining;
  assert.equal(result.retained, 63, 'the accepted in-flight item is removed while the remaining cold entries stay retained');
  coordinator.dispose();
});

test('unknown cold-mail delivery is removed without replay and its dedupe receipt becomes unknown', async () => {
  const { coordinator, setCold, setNoteMode, delivered } = setup();
  setCold(paths.b, true);
  const accepted = await execute(coordinator, 'note', { target: paths.b, message: 'might have reached the SDK' }, paths.a);
  const id = accepted.messageId as string;
  setCold(paths.b, false);
  setNoteMode('reject');
  const drained = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(drained.retained, 0);
  assert.equal((drained.issues as WorkerJsonObject[])[0]?.status, 'unknown');
  assert.equal((await execute(coordinator, 'notes.drain', {}, paths.b)).attempted, 0);
  const duplicate = await execute(coordinator, 'note', { target: paths.b, message: 'might have reached the SDK' }, paths.a);
  assert.equal(duplicate.status, 'unknown');
  assert.equal(duplicate.messageId, id);
  assert.equal(delivered.length, 1, 'unknown delivery is never retried by drain or duplicate input');
  coordinator.dispose();
});

test('an explicit unknown delivery outcome stops the batch and its duplicate is never replayed', async () => {
  const { coordinator, setCold, setNoteMode, delivered } = setup();
  setCold(paths.b, true);
  const first = await execute(coordinator, 'note', { target: paths.b, message: 'explicitly unknown' }, paths.a, 'request-first');
  await execute(coordinator, 'note', { target: paths.b, message: 'suffix stays queued' }, paths.c, 'request-second');
  setCold(paths.b, false);
  setNoteMode('status-unknown');
  const drained = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(drained.attempted, 1);
  assert.equal(drained.remaining, 1);
  assert.equal((drained.issues as WorkerJsonObject[])[0]?.status, 'unknown');
  assert.equal(delivered.length, 1, 'the suffix is not dispatched after explicit unknown evidence');
  const duplicate = await execute(coordinator, 'note', { target: paths.b, message: 'explicitly unknown' }, paths.a, 'request-first');
  assert.equal(duplicate.status, 'unknown');
  assert.equal(duplicate.messageId, first.messageId);
  assert.equal(delivered.length, 1, 'duplicate input does not replay an unknown delivery');
  setNoteMode('ok');
  const suffix = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(suffix.attempted, 1);
  assert.equal(suffix.remaining, 0);
  assert.equal(delivered.length, 2);
  coordinator.dispose();
});

test('concurrent drains skip in-flight mail while capacity retains its envelope and retirement purges it', async () => {
  const { coordinator, setCold, setNoteMode, finishDeliveries, delivered } = setup();
  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'claimed once' }, paths.a);
  await execute(coordinator, 'note', { target: paths.b, message: 'must not dispatch after delete' }, paths.c);
  setCold(paths.b, false);
  setNoteMode('delay');
  const first = execute(coordinator, 'notes.drain', {}, paths.b);
  await Promise.resolve();
  const second = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(second.attempted, 0);
  assert.equal(second.retained, 2);
  assert.equal(second.alreadyInProgress, true);
  coordinator.retire(paths.b, true);
  finishDeliveries();
  const result = await first;
  assert.equal(result.retained, 0, 'a late completion cannot restore mail purged by privacy deletion');
  assert.equal(delivered.length, 1, 'deletion prevents dispatch of the unattempted preclaimed suffix');
  assert.equal(result.alreadyInProgress, undefined);
  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'new owner-lifetime mail after delete' }, paths.a, 'request-after-delete');
  setCold(paths.b, false);
  setNoteMode('ok');
  const reopenedDrain = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(reopenedDrain.alreadyInProgress, undefined, 'private deletion and prior drain cannot leave a stale owner gate');
  assert.equal(reopenedDrain.attempted, 1);
  assert.equal(reopenedDrain.remaining, 0);
  coordinator.dispose();
});

test('a bounded drain deadline commits only the attempted item as unknown and ignores late completion', async () => {
  const { coordinator, setCold, setNoteMode, finishDeliveries, delivered } = setup({}, 10);
  setCold(paths.b, true);
  const first = await execute(coordinator, 'note', { target: paths.b, message: 'first possibly queued' }, paths.a, 'request-first');
  await execute(coordinator, 'note', { target: paths.b, message: 'second retained' }, paths.c, 'request-second');
  setCold(paths.b, false);
  setNoteMode('delay');
  const drain = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(drain.attempted, 1);
  assert.equal(drain.remaining, 1, 'the unattempted suffix remains in the mailbox');
  assert.deepEqual(drain.issues, [{ id: (delivered[0]?.payload.id as string), status: 'unknown', retained: false, error: 'The delivery acknowledgement exceeded the bounded drain deadline.' }]);
  finishDeliveries();
  const duplicate = await execute(coordinator, 'note', { target: paths.b, message: 'first possibly queued' }, paths.a, 'request-first');
  assert.equal(duplicate.status, 'unknown');
  assert.equal(duplicate.messageId, first.messageId);
  setNoteMode('ok');
  const retrySuffix = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(retrySuffix.attempted, 1);
  assert.equal(retrySuffix.remaining, 0);
  assert.equal(delivered.length, 2, 'the late first result is ignored and the ambiguous message is never replayed');
  coordinator.dispose();
});

test('released claims wake ordinary and resource waiters when known-failed mail remains available', async () => {
  const { coordinator, setCold, setNoteMode, finishDeliveries } = setup();
  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'known failure wakes ordinary wait' }, paths.a);
  setCold(paths.b, false);
  setNoteMode('delay-reject');
  const draining = execute(coordinator, 'notes.drain', {}, paths.b);
  await Promise.resolve();
  const ordinaryWait = execute(coordinator, 'wait', { waitId: 'mail-visible', timeoutMs: 1_000 }, paths.b);
  finishDeliveries();
  const [drainResult, ordinaryResult] = await Promise.all([draining, ordinaryWait]);
  assert.equal(drainResult.retained, 0, 'the waiter consumes the now-visible retained message');
  assert.equal(ordinaryResult.reason, 'mail');
  assert.equal((ordinaryResult.messages as WorkerJsonObject[])[0]?.body, 'known failure wakes ordinary wait');

  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'known failure wakes resource wait' }, paths.a);
  setCold(paths.b, false);
  await execute(coordinator, 'resources', { action: 'acquire', name: 'gpu:0', purpose: 'keep resource unavailable' }, paths.a);
  const resourceDrain = execute(coordinator, 'notes.drain', {}, paths.b);
  await Promise.resolve();
  const resourceWait = execute(coordinator, 'resources', { action: 'wait', name: 'gpu:0', waitId: 'resource-mail-visible', timeoutMs: 1_000 }, paths.b);
  finishDeliveries();
  const [resourceDrainResult, resourceResult] = await Promise.all([resourceDrain, resourceWait]);
  assert.equal(resourceDrainResult.retained, 0);
  assert.equal(resourceResult.reason, 'mail');
  assert.equal(resourceResult.compatible, false);
  assert.equal((resourceResult.messages as WorkerJsonObject[])[0]?.body, 'known failure wakes resource wait');
  coordinator.dispose();
});

test('a waiting target receives a note as mailbox data without waking its worker route', async () => {
  const { coordinator, delivered } = setup();
  const waiting = execute(coordinator, 'wait', { waitId: 'wait-b', timeoutMs: 1_000 }, paths.b);
  await Promise.resolve();
  const receipt = await execute(coordinator, 'note', { target: paths.b, message: 'new evidence arrived' }, paths.a);
  assert.equal(receipt.delivery, 'wait');
  assert.equal(receipt.wake, false);
  assert.equal(delivered.length, 0);
  const result = await waiting;
  assert.equal(result.reason, 'mail');
  assert.equal((result.messages as WorkerJsonObject[])[0]?.body, 'new evidence arrived');
  coordinator.dispose();
});

test('assignment and finish are authenticated by participant and result is inspectable by requester', async () => {
  const { coordinator, delivered } = setup();
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'summarize the files' }, paths.a, 'op-42');
  assert.equal(admitted.status, 'accepted');
  const task = admitted.task as WorkerJsonObject;
  assert.equal(task.requester && (task.requester as WorkerJsonObject).address, 'reply:a');
  assert.equal(task.worker && (task.worker as WorkerJsonObject).address, 'reply:b');
  assert.equal((task.requester as WorkerJsonObject).owner, undefined, 'public task views do not expose private owner hashes');
  assert.equal((task.worker as WorkerJsonObject).owner, undefined, 'public task views do not expose private owner hashes');

  const finished = await execute(coordinator, 'task.finish', {
    taskId: task.taskId as string, revision: task.revision as number, outcome: 'completed', result: 'three files reviewed',
  }, paths.b);
  assert.equal(finished.status, 'committed');
  const snapshot = await execute(coordinator, 'wait', { waitId: 'inspect', timeoutMs: 0, taskIds: [task.taskId as string] }, paths.a);
  assert.equal(snapshot.reason, 'inspection');
  const record = (snapshot.tasks as WorkerJsonObject[])[0]!;
  assert.equal(record.status, 'terminal');
  assert.equal(record.result, 'three files reviewed');
  assert.equal(delivered.filter(item => item.payload.kind === 'result').length, 1);
  assert.match(String(delivered.find(item => item.payload.kind === 'result')?.payload.body), /three files reviewed/u);
  await assert.rejects(execute(coordinator, 'task.finish', {
    taskId: task.taskId as string, revision: task.revision as number, outcome: 'completed', result: 'spoofed result',
  }, paths.c), /Only the assigned worker/u);
  coordinator.dispose();
});

test('wait returns existing results, times out, supports remote cancellation, and is cancelled when owner retires', async () => {
  const { coordinator } = setup();
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'check status' }, paths.a, 'op-wait');
  const task = admitted.task as WorkerJsonObject;
  await execute(coordinator, 'task.finish', {
    taskId: task.taskId as string, revision: task.revision as number, outcome: 'completed', result: 'done',
  }, paths.b);
  const already = await execute(coordinator, 'wait', { waitId: 'already', taskIds: [task.taskId as string], timeoutMs: 1_000 }, paths.a);
  assert.equal(already.reason, 'available');

  const timeout = await execute(coordinator, 'wait', { waitId: 'timeout', timeoutMs: 5 }, paths.c);
  assert.equal(timeout.reason, 'timeout');

  const pendingCancel = execute(coordinator, 'wait', { waitId: 'cancel-me', timeoutMs: 1_000 }, paths.c);
  await Promise.resolve();
  await execute(coordinator, 'wait.cancel', { waitId: 'cancel-me' }, paths.c);
  assert.equal((await pendingCancel).reason, 'cancelled');

  const pendingClose = execute(coordinator, 'wait', { waitId: 'close-me', timeoutMs: 1_000 }, paths.c);
  await Promise.resolve();
  coordinator.retire(paths.c);
  assert.equal((await pendingClose).reason, 'cancelled');
  coordinator.dispose();
});

test('busy assignments are rejected before task admission; caller payload cannot spoof identity', async () => {
  const { coordinator, setBusy } = setup();
  setBusy(paths.b, true);
  const busy = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'queue later' }, paths.a, 'op-busy');
  assert.equal(busy.status, 'rejected');
  assert.equal(busy.reason, 'busy');
  assert.equal(coordinator.tasks.inspect('owner-a').length, 0);
  await assert.rejects(execute(coordinator, 'task.assign', {
    target: paths.b, prompt: 'do work', requester: 'owner-c',
  } as unknown as WorkerJsonObject), /Unexpected task.assign field/u);
  coordinator.dispose();
});

test('private deletion during pending assignment never returns a stale task or replays it', async () => {
  for (const deletedPath of [paths.a, paths.b]) {
    const { coordinator, delayAssignment } = setup();
    const gate = delayAssignment();
    const assigned = execute(coordinator, 'task.assign', {
      target: paths.b, prompt: 'secret task prompt that must not leak after purge',
    }, paths.a, `delete-race-${deletedPath}`);
    await gate.started;
    coordinator.retire(deletedPath, true);
    gate.finish({ status: 'accepted', prompt: 'secret task prompt that must not leak after purge', target: paths.b });

    const result = await assigned;
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'task_record_unavailable_after_dispatch');
    assert.equal(result.task, undefined);
    assert.equal(result.message, 'The task record was removed while delivery was pending; the delivery acknowledgement cannot establish retained work.');
    assert.doesNotMatch(JSON.stringify(result), /secret task prompt|reply:a|reply:b/u);
    assert.match(String(result.guidance), /Do not automatically repeat/u);
    assert.equal(coordinator.tasks.inspect('owner-a').length, 0);
    coordinator.dispose();
  }
});

test('ordinary close during pending assignment preserves lifecycle-derived task evidence', async () => {
  const { coordinator, delayAssignment } = setup();
  const gate = delayAssignment();
  const assigned = execute(coordinator, 'task.assign', { target: paths.b, prompt: 'close without deletion' }, paths.a, 'close-race');
  await gate.started;
  coordinator.retire(paths.b, false);
  gate.finish({ status: 'accepted' });

  const result = await assigned;
  const task = result.task as WorkerJsonObject;
  assert.equal(result.status, 'accepted');
  assert.equal(task.status, 'terminal');
  assert.equal(task.outcome, 'unknown');
  assert.equal(coordinator.tasks.inspect('owner-a', String(task.taskId)).length, 1);
  coordinator.dispose();
});

test('historical task results do not make a later mailbox wait return before new information', async () => {
  const { coordinator } = setup();
  const assigned = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'finish once' }, paths.a, 'history');
  const task = assigned.task as WorkerJsonObject;
  await execute(coordinator, 'task.finish', { taskId: task.taskId as string, revision: 1, outcome: 'completed', result: 'old result' }, paths.b);
  // A hot requester already received the non-waking result in its context.
  let resolved = false;
  const pending = execute(coordinator, 'wait', { waitId: 'future-mail', timeoutMs: 1_000 }, paths.a).then(result => { resolved = true; return result; });
  await Promise.resolve();
  assert.equal(resolved, false, 'consumed historical results are not new mailbox events');
  await execute(coordinator, 'note', { target: paths.a, message: 'new information' }, paths.c);
  const received = await pending;
  assert.equal(received.reason, 'mail');
  assert.equal((received.messages as WorkerJsonObject[])[0]?.body, 'new information');
  coordinator.dispose();
});

test('cancelling a task-filtered wait preserves unrelated unread result mail', async () => {
  const { coordinator } = setup();
  const one = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'first task' }, paths.a, 'cancel-one');
  const two = await execute(coordinator, 'task.assign', { target: paths.c, prompt: 'second task' }, paths.a, 'cancel-two');
  const waiting = execute(coordinator, 'wait', { waitId: 'cancel-with-unrelated-mail', taskIds: [(one.task as WorkerJsonObject).taskId as string], timeoutMs: 1_000 }, paths.a);
  await execute(coordinator, 'task.finish', { taskId: (two.task as WorkerJsonObject).taskId as string, revision: 1, outcome: 'completed', result: 'retain this result' }, paths.c);
  await execute(coordinator, 'wait.cancel', { waitId: 'cancel-with-unrelated-mail' }, paths.a);
  const cancelled = await waiting;
  assert.equal(cancelled.reason, 'cancelled');
  assert.deepEqual(cancelled.messages, []);
  const later = await execute(coordinator, 'wait', { waitId: 'inspect-unrelated-result', timeoutMs: 0 }, paths.a);
  assert.equal((later.messages as WorkerJsonObject[]).length, 1);
  assert.equal(((later.messages as WorkerJsonObject[])[0]?.task as WorkerJsonObject)?.id, (two.task as WorkerJsonObject).taskId);
  assert.match(String(((later.tasks as WorkerJsonObject[]).find(row => row.taskId === (two.task as WorkerJsonObject).taskId)?.result)), /retain this result/u);
  coordinator.dispose();
});

test('delayed result notification is committed once and status inspection never re-sends it', async () => {
  const { coordinator, delivered, setNoteMode, finishDeliveries } = setup();
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'return a short finding' }, paths.a, 'op-delayed');
  const task = admitted.task as WorkerJsonObject;
  setNoteMode('delay');
  const finish = { taskId: task.taskId as string, revision: task.revision as number, outcome: 'completed', result: 'immutable finding' } as const;
  await execute(coordinator, 'task.finish', finish, paths.b);

  const inspection = await execute(coordinator, 'wait', { waitId: 'during-notice', timeoutMs: 0, taskIds: [finish.taskId] }, paths.a);
  assert.equal((inspection.tasks as WorkerJsonObject[])[0]?.result, finish.result);
  assert.equal(delivered.filter(item => item.payload.kind === 'result').length, 1);
  finishDeliveries();
  await execute(coordinator, 'task.finish', finish, paths.b);
  assert.equal(delivered.filter(item => item.payload.kind === 'result').length, 1, 'idempotent finish/status does not resend');
  await assert.rejects(execute(coordinator, 'task.finish', { ...finish, result: 'conflicting result' }, paths.b), /different immutable finish/u);
  coordinator.dispose();
});

test('a run without finish becomes awaiting-result and can be amended only at its current revision', async () => {
  const { coordinator } = setup();
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'inspect carefully' }, paths.a, 'op-awaiting');
  const task = admitted.task as WorkerJsonObject;
  coordinator.observe('agent.settled', { sessionPath: paths.b, operationId: 'agent-session:op-awaiting' });
  const awaiting = await execute(coordinator, 'wait', { waitId: 'awaiting', timeoutMs: 0, taskIds: [task.taskId as string] }, paths.a);
  assert.equal((awaiting.tasks as WorkerJsonObject[])[0]?.status, 'awaiting-result');

  const revised = await execute(coordinator, 'task.assign', {
    target: paths.b, prompt: 'retry with the missing verification', taskId: task.taskId as string, revision: 1,
  }, paths.a, 'op-amend');
  assert.equal((revised.task as WorkerJsonObject).revision, 2);
  await assert.rejects(execute(coordinator, 'task.assign', {
    target: paths.b, prompt: 'stale retry', taskId: task.taskId as string, revision: 1,
  }, paths.a, 'op-stale'), /stale/u);
  coordinator.dispose();
});

test('authenticated semantic turn.started promotes an assigned task; other semantic progress does not', async () => {
  const { coordinator } = setup();
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'complete a bounded task' }, paths.a, 'semantic-start');
  const task = admitted.task as WorkerJsonObject;
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 7,
    sessionPath: paths.b,
    requestId: 'semantic-start',
    operationId: 'agent-session:semantic-start',
    turnId: 'turn-semantic-start',
    attemptId: 'attempt-semantic-start',
    canonicalMessageId: 'semantic-start:1',
    startedAt: 100,
  });
  const started = accumulator.observe({ kind: 'turn.started' }, 101);
  assert.equal(started?.kind, 'turn.started');
  assert.equal(started?.operationId, 'agent-session:semantic-start');

  // The live semantic event reaches this authority only after the worker
  // router authenticated the frame owner and exact lease sessionPath.
  coordinator.observe('live.semantic', started);
  const running = await execute(coordinator, 'wait', { waitId: 'semantic-start-snapshot', timeoutMs: 0, taskIds: [task.taskId as string] }, paths.a);
  assert.equal((running.tasks as WorkerJsonObject[])[0]?.status, 'running');

  const phase = accumulator.observe({ kind: 'turn.phase', phase: 'waiting_provider' }, 102);
  coordinator.observe('live.semantic', phase);
  const stillRunning = await execute(coordinator, 'wait', { waitId: 'semantic-phase-snapshot', timeoutMs: 0, taskIds: [task.taskId as string] }, paths.a);
  assert.equal((stillRunning.tasks as WorkerJsonObject[])[0]?.status, 'running', 'phase progress is not a lifecycle transition');
  coordinator.dispose();
});

test('late semantic starts cannot resurrect a settled or terminal assignment; legacy start remains supported', async () => {
  const { coordinator } = setup();
  const awaitingAdmission = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'settle without finish' }, paths.a, 'late-semantic-start');
  const awaitingTask = awaitingAdmission.task as WorkerJsonObject;
  const startEnvelope = (requestId: string, operationId: string) => new BackendLiveTurnAccumulator({
    protocolVersion: 7, sessionPath: paths.b, requestId, operationId,
    turnId: `turn-${requestId}`, attemptId: `attempt-${requestId}`,
    canonicalMessageId: `${requestId}:1`, startedAt: 100,
  }).observe({ kind: 'turn.started' }, 101);

  coordinator.observe('agent.settled', { sessionPath: paths.b, operationId: 'agent-session:late-semantic-start' });
  coordinator.observe('live.semantic', startEnvelope('late-semantic-start', 'agent-session:late-semantic-start'));
  let snapshot = await execute(coordinator, 'wait', { waitId: 'late-awaiting', timeoutMs: 0, taskIds: [awaitingTask.taskId as string] }, paths.a);
  assert.equal((snapshot.tasks as WorkerJsonObject[])[0]?.status, 'awaiting-result');

  await execute(coordinator, 'task.finish', {
    taskId: awaitingTask.taskId as string, revision: 1, outcome: 'failed', result: 'No result was produced before settlement.',
  }, paths.b);
  coordinator.observe('live.semantic', startEnvelope('late-semantic-start', 'agent-session:late-semantic-start'));
  snapshot = await execute(coordinator, 'wait', { waitId: 'late-terminal', timeoutMs: 0, taskIds: [awaitingTask.taskId as string] }, paths.a);
  assert.equal((snapshot.tasks as WorkerJsonObject[])[0]?.status, 'terminal');

  const legacyAdmission = await execute(coordinator, 'task.assign', { target: paths.c, prompt: 'legacy lifecycle compatibility' }, paths.a, 'legacy-start');
  const legacyTask = legacyAdmission.task as WorkerJsonObject;
  coordinator.observe('message.started', { sessionPath: paths.c, operationId: 'agent-session:legacy-start' });
  snapshot = await execute(coordinator, 'wait', { waitId: 'legacy-start-snapshot', timeoutMs: 0, taskIds: [legacyTask.taskId as string] }, paths.a);
  assert.equal((snapshot.tasks as WorkerJsonObject[])[0]?.status, 'running');
  coordinator.dispose();
});

test('a late rejected acknowledgement cannot override correlated execution evidence', async () => {
  for (const state of ['running', 'awaiting-result', 'terminal'] as const) {
    const { coordinator, delayAssignment } = setup();
    const gate = delayAssignment();
    const requestId = `late-rejected-${state}`;
    const assigning = execute(coordinator, 'task.assign', { target: paths.b, prompt: `task ${state}` }, paths.a, requestId);
    await gate.started;
    const operationId = `agent-session:${requestId}`;
    if (state === 'running' || state === 'terminal') {
      coordinator.observe('message.started', { sessionPath: paths.b, operationId });
    }
    if (state === 'awaiting-result') coordinator.observe('agent.settled', { sessionPath: paths.b, operationId });
    const admitted = coordinator.tasks.inspect('owner-a')[0]!;
    if (state === 'terminal') {
      await execute(coordinator, 'task.finish', {
        taskId: admitted.taskId, revision: admitted.revision, outcome: 'completed', result: 'immutable completed result',
      }, paths.b, `finish-${requestId}`);
    }

    gate.finish({ status: 'rejected', error: 'worker IPC closed before the acknowledgement arrived' });
    const result = await assigning;
    const task = result.task as WorkerJsonObject;
    assert.equal(result.status, 'unknown', state);
    assert.equal((result.message as WorkerJsonObject).status, 'unknown', state);
    assert.equal(task.status, state, state);
    assert.match(String(result.guidance), /Inspect this task.*do not repeat/u, state);
    if (state === 'terminal') assert.equal(task.result, 'immutable completed result');
    coordinator.dispose();
  }
});

test('task-filtered wait preserves unrelated result notices in the mailbox', async () => {
  const { coordinator, setCold } = setup();
  setCold(paths.a, true);
  const first = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'first result' }, paths.a, 'op-one');
  const second = await execute(coordinator, 'task.assign', { target: paths.c, prompt: 'second result' }, paths.a, 'op-two');
  const one = first.task as WorkerJsonObject;
  const two = second.task as WorkerJsonObject;
  await execute(coordinator, 'task.finish', { taskId: one.taskId as string, revision: 1, outcome: 'completed', result: 'unrelated result' }, paths.b);

  const filtered = await execute(coordinator, 'wait', { waitId: 'only-two', taskIds: [two.taskId as string], timeoutMs: 5 }, paths.a);
  assert.equal(filtered.reason, 'timeout', 'an unrelated result cannot wake a task-filtered wait');
  const preserved = await execute(coordinator, 'wait', { waitId: 'only-one', taskIds: [one.taskId as string], timeoutMs: 0 }, paths.a);
  assert.equal((preserved.tasks as WorkerJsonObject[])[0]?.result, 'unrelated result');
  assert.equal((preserved.messages as WorkerJsonObject[]).some(message => message.task && (message.task as WorkerJsonObject).id === one.taskId), true);
  coordinator.dispose();
});

test('multi-task afterRevision uses the coordinator-wide version cursor', async () => {
  const { coordinator } = setup();
  const first = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'first task' }, paths.a, 'cursor-one');
  const second = await execute(coordinator, 'task.assign', { target: paths.c, prompt: 'second task' }, paths.a, 'cursor-two');
  const one = first.task as WorkerJsonObject;
  const two = second.task as WorkerJsonObject;
  await execute(coordinator, 'task.finish', {
    taskId: one.taskId as string, revision: 1, outcome: 'completed', result: 'first result',
  }, paths.b);

  const snapshot = await execute(coordinator, 'wait', {
    waitId: 'multi-task-cursor-inspect', taskIds: [one.taskId as string, two.taskId as string], timeoutMs: 0,
  });
  const cursor = snapshot.revision as number;
  const firstAfter = (snapshot.tasks as WorkerJsonObject[]).find(task => task.taskId === one.taskId);
  const secondBefore = (snapshot.tasks as WorkerJsonObject[]).find(task => task.taskId === two.taskId);
  assert.equal(cursor, firstAfter?.version as number);
  assert.ok(cursor > (secondBefore?.version as number));

  const waiting = execute(coordinator, 'wait', {
    waitId: 'multi-task-cursor-wait', taskIds: [one.taskId as string, two.taskId as string], afterRevision: cursor, timeoutMs: 1_000,
  });
  await execute(coordinator, 'task.finish', {
    taskId: two.taskId as string, revision: 1, outcome: 'completed', result: 'second result',
  }, paths.c);
  const changed = await waiting;
  assert.equal(changed.reason, 'changed');
  assert.ok((changed.revision as number) > cursor);
  assert.equal((changed.tasks as WorkerJsonObject[]).find(task => task.taskId === two.taskId)?.result, 'second result');
  coordinator.dispose();
});

test('hot note acknowledgement loss is reported unknown and never automatically replayed', async () => {
  const { coordinator, delivered, setNoteMode } = setup();
  setNoteMode('reject');
  const receipt = await execute(coordinator, 'note', { target: paths.b, message: 'one delivery attempt' });
  assert.equal(receipt.status, 'unknown');
  assert.match(String(receipt.error), /acknowledgement/u);
  assert.equal(delivered.length, 1);
  const drained = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.deepEqual(drained.messages, [], 'unknown hot delivery is not silently replayed from mailbox');
  assert.equal(delivered.length, 1);
  coordinator.dispose();
});

test('hot recipients have pair burst backpressure even when their mailbox drains immediately', async () => {
  const { coordinator, delivered } = setup();
  for (let index = 0; index < 5; index++) {
    assert.equal((await execute(coordinator, 'note', { target: paths.b, message: `distinct decision ${index}` })).status, 'accepted');
  }
  const limited = await execute(coordinator, 'note', { target: paths.b, message: 'one more distinct decision' });
  assert.equal(limited.status, 'rejected');
  assert.equal(limited.reason, 'rate_limited');
  assert.equal(limited.messageId, undefined);
  assert.ok(typeof limited.retryAfterMs === 'number' && limited.retryAfterMs > 0);
  assert.equal(delivered.length, 5);
  coordinator.dispose();
});

test('duplicate notes preserve pending or unknown evidence without another SDK delivery attempt', async () => {
  const { coordinator, delivered, setNoteMode, finishDeliveries } = setup();
  setNoteMode('delay');
  const pending = execute(coordinator, 'note', { target: paths.b, message: 'one context update' });
  const duplicatePending = await execute(coordinator, 'note', { target: paths.b, message: 'one context update' });
  assert.equal(duplicatePending.status, 'unknown');
  assert.equal(duplicatePending.duplicate, true);
  assert.equal(delivered.length, 1);
  finishDeliveries();
  const accepted = await pending;
  const duplicateAccepted = await execute(coordinator, 'note', { target: paths.b, message: 'one context update' });
  assert.equal(duplicateAccepted.status, 'accepted');
  assert.equal(duplicateAccepted.messageId, accepted.messageId);
  setNoteMode('reject');
  const unknown = await execute(coordinator, 'note', { target: paths.c, message: 'uncertain context update' });
  const duplicateUnknown = await execute(coordinator, 'note', { target: paths.c, message: 'uncertain context update' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(duplicateUnknown.status, 'unknown');
  assert.equal(duplicateUnknown.messageId, unknown.messageId);
  assert.equal(delivered.length, 2);
  coordinator.dispose();
});

test('non-delete close and reopen retain notes, while private deletion purges inbound and result mail', async () => {
  const { coordinator, setCold, delivered } = setup();
  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'survive ordinary close' }, paths.a);
  coordinator.retire(paths.b);
  setCold(paths.b, false);
  const reopened = await execute(coordinator, 'notes.drain', {}, paths.b);
  assert.equal(reopened.attempted, 1);
  assert.equal(delivered[0]?.payload.body, 'survive ordinary close');

  setCold(paths.a, true);
  setCold(paths.b, true);
  await execute(coordinator, 'note', { target: paths.b, message: 'purge when sender is deleted' }, paths.a);
  const admitted = await execute(coordinator, 'task.assign', { target: paths.b, prompt: 'produce a result notice' }, paths.a, 'op-private');
  const task = admitted.task as WorkerJsonObject;
  await execute(coordinator, 'task.finish', { taskId: task.taskId as string, revision: 1, outcome: 'completed', result: 'private result' }, paths.b);
  assert.equal(coordinator.tasks.inspect('owner-a', task.taskId as string).length, 1);
  coordinator.retire(paths.a, true);
  assert.equal(coordinator.tasks.inspect('owner-a', task.taskId as string).length, 0);
  assert.deepEqual((await execute(coordinator, 'notes.drain', {}, paths.a)).messages, []);
  assert.deepEqual((await execute(coordinator, 'notes.drain', {}, paths.b)).messages, []);
  coordinator.dispose();
});

test('wait.cancel is owner-scoped and cannot cancel a peer session wait', async () => {
  const { coordinator } = setup();
  const pending = execute(coordinator, 'wait', { waitId: 'owned-by-c', timeoutMs: 1_000 }, paths.c);
  await Promise.resolve();
  await execute(coordinator, 'wait.cancel', { waitId: 'owned-by-c' }, paths.a);
  const outcome = await Promise.race([pending.then(() => 'settled'), new Promise<string>(resolve => setTimeout(() => resolve('pending'), 0))]);
  assert.equal(outcome, 'pending');
  await execute(coordinator, 'wait.cancel', { waitId: 'owned-by-c' }, paths.c);
  assert.equal((await pending).reason, 'cancelled');
  coordinator.dispose();
});

test('wait result serialization stays bounded for sixteen maximum-size Unicode/control-character results', async () => {
  const { coordinator } = setup();
  const taskIds: string[] = [];
  const result = '\u0001🙂'.repeat(6_553); // 32,765 UTF-8 bytes.
  for (let index = 0; index < 16; index++) {
    const task = coordinator.tasks.assign({
      requester: { owner: 'owner-a', address: 'reply:a' },
      worker: { owner: `synthetic-worker-${index}`, address: `reply:w${index}` },
      operationId: `large-${index}`, prompt: 'bounded task',
    });
    taskIds.push(task.taskId);
    coordinator.tasks.finish({ worker: task.worker.owner, taskId: task.taskId, revision: 1, outcome: 'completed', result });
  }
  const response = await execute(coordinator, 'wait', { waitId: 'large', taskIds, timeoutMs: 0 }, paths.a);
  const encoded = JSON.stringify(response);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 224 * 1024);
  const parsed = JSON.parse(encoded) as WorkerJsonObject;
  const records = parsed.tasks as WorkerJsonObject[];
  assert.equal(records.length, 16);
  assert.ok(records.every(record => record.resultTruncated === true));
  for (const record of records) {
    const body = record.result as string;
    assert.ok(body.includes('🙂'));
    assert.ok(body.includes('\u0001'));
    for (let index = 0; index < body.length; index++) {
      const unit = body.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) assert.ok(body.charCodeAt(index + 1) >= 0xdc00 && body.charCodeAt(index + 1) <= 0xdfff);
      if (unit >= 0xdc00 && unit <= 0xdfff) assert.ok(body.charCodeAt(index - 1) >= 0xd800 && body.charCodeAt(index - 1) <= 0xdbff);
    }
  }
  coordinator.dispose();
});

test('mailbox admits at most 64 notes and applies backpressure without dropping retained notes', async () => {
  const { coordinator, setCold } = setup({ pairBurst: 100, recipientBurst: 100 });
  setCold(paths.b, true);
  for (let index = 0; index < 64; index++) {
    await execute(coordinator, 'note', { target: paths.b, message: `note ${index}` });
  }
  await assert.rejects(execute(coordinator, 'note', { target: paths.b, message: 'the sixty-fifth note' }), /capacity/u);
  setCold(paths.b, false);
  let attempted = 0;
  let remaining = 64;
  while (remaining > 0) {
    const drained = await execute(coordinator, 'notes.drain', {}, paths.b);
    attempted += drained.attempted as number;
    remaining = drained.remaining as number;
    assert.ok((drained.attempted as number) <= 8, 'each control-lane turn has a bounded batch');
  }
  assert.equal(attempted, 64);
  coordinator.dispose();
});

test('mailbox byte admission counts retained routing envelopes as well as note bodies', async () => {
  const targetPath = `C:\\${'long-directory\\'.repeat(600)}session.jsonl`;
  const caller = { owner: 'caller-owner', address: 'reply:caller' };
  const recipient = { owner: 'recipient-owner', address: 'reply:recipient' };
  const coordinator = new SessionCollaborationCoordinator({
    participant: path => path === targetPath ? recipient : caller,
    resolve: () => ({ path: targetPath, participant: recipient }),
    sender: () => ({ address: 'reply:caller' } as never),
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => undefined,
    workerMemory: () => ({ workers: [], total: 0, truncated: false }),
  }, { noteAdmission: new SessionNoteAdmission({ pairBurst: 100, recipientBurst: 100, duplicateWindowMs: 1 }) });
  let admitted = 0;
  for (; admitted < 64; admitted++) {
    try { await execute(coordinator, 'note', { target: 'recipient', message: `short note ${admitted}` }); }
    catch (error) { assert.match(String(error), /Mailbox capacity/u); break; }
  }
  assert.ok(admitted > 0 && admitted < 64, 'long retained paths consume the bounded inbox envelope budget');
  const retained = await execute(coordinator, 'notes.drain', {}, targetPath);
  assert.equal(retained.retained, admitted, 'a cold route keeps every accepted note retained');
  coordinator.dispose();
});

test('mailbox byte limits distinguish each recipient from the aggregate retained mail', async () => {
  const caller = { owner: 'caller', address: 'reply:caller' };
  const recipient = (path: string) => ({ owner: path, address: `reply:${path}` });
  const coordinator = new SessionCollaborationCoordinator({
    participant: path => path === paths.a ? caller : recipient(path),
    resolve: path => ({ path, participant: recipient(path) }),
    sender: () => ({ address: caller.address } as never),
    busy: () => false,
    assignment: async () => ({ status: 'accepted' }),
    note: () => undefined,
    workerMemory: () => ({ workers: [], total: 0, truncated: false }),
  }, { noteAdmission: new SessionNoteAdmission({ pairBurst: 100, recipientBurst: 100 }) });
  let sequence = 0;
  const send = (target: string) => execute(coordinator, 'note', {
    target, message: `${sequence++}:`.padEnd(16 * 1024, 'x'),
  });
  try {
    for (let index = 0; index < 15; index++) await send('recipient-0');
    await assert.rejects(send('recipient-0'), /Mailbox capacity/u);
    // A full recipient must not spend another recipient's local allowance.
    for (let owner = 1; owner < 16; owner++) {
      for (let index = 0; index < 15; index++) {
        assert.equal((await send(`recipient-${owner}`)).delivery, 'mailbox');
      }
    }
    let admitted = 0;
    for (; admitted < 15; admitted++) {
      try { await send('recipient-16'); }
      catch (error) { assert.match(String(error), /Mailbox capacity/u); break; }
    }
    assert.ok(admitted > 0 && admitted < 15, 'aggregate bytes reject before this recipient reaches its local byte limit');
    await assert.rejects(send('fresh-recipient'), /Mailbox capacity/u);
    const retained = await execute(coordinator, 'notes.drain', {}, 'recipient-16');
    assert.equal(retained.retained, admitted, 'aggregate rejection preserves already admitted mail');
  } finally {
    coordinator.dispose();
  }
});

test('resource reservations have acquire/start/renew/release lifecycle and host status facts', async () => {
  const { coordinator } = setup();
  const status = await execute(coordinator, 'resources', { action: 'status' });
  assert.equal(status.cooperative, true);
  assert.equal(typeof (status.hardware as WorkerJsonObject).coordinatorRssBytes, 'number');
  assert.equal((status.workers as WorkerJsonObject[])[0]?.address, 'reply:b');
  assert.equal((status.workers as WorkerJsonObject[])[0]?.sessionPath, undefined);
  assert.equal(status.workerCount, 1);
  assert.equal(status.workersTruncated, false);

  const acquired = await execute(coordinator, 'resources', { action: 'acquire', name: 'repo:pie', purpose: 'edit test fixture' });
  assert.equal(acquired.outcome, 'acquired');
  const lease = acquired.lease as WorkerJsonObject;
  const leaseId = lease.leaseId as string;
  assert.equal(lease.state, 'reserved');
  assert.equal((await execute(coordinator, 'resources', { action: 'start', leaseId })).outcome, 'succeeded');
  assert.equal((await execute(coordinator, 'resources', { action: 'renew', leaseId, ttlMs: 5_000 })).outcome, 'succeeded');
  assert.equal((await execute(coordinator, 'resources', { action: 'release', leaseId })).outcome, 'released');
  assert.equal((await execute(coordinator, 'resources', { action: 'release', leaseId })).outcome, 'already_released');
  coordinator.dispose();
});
