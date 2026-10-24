import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createInitialArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { EffectRunner } from '../../../conversation-state/effects/effect-runner';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';
import { WorkerRuntimeRouter } from '../../../../../harness/agent-processes/coordinator/worker-runtime-router';
import { WorkerRuntimeHost } from '../../../../../harness/agent-processes/workers/worker-runtime-host';
import { createSyntheticSourceTestSdkRuntime } from '../../../../../harness/agent-processes/test/fixtures/sdk-runtime-selection';
import { createSessionControlSender } from '../../../../../harness/agent-processes/lib/rpc/session-control-attribution';

function fixture() {
  const state = createInitialArchState();
  return { ...state, sessions: { ...state.sessions, openTabPaths: ['/a', '/b'], activeSessionPath: '/a' } };
}

function idleBarrierFixture() {
  const worker = new WorkerRuntimeHost({
    owner: { coordinatorGeneration: 1, workerId: 'snooze-worker', workerGeneration: 1 },
    sdkRuntime: createSyntheticSourceTestSdkRuntime('/sdk'),
    server: {
      sendDetailFrame: () => true,
      onDetailDrain: () => () => undefined,
      requestFrame: async (body: { kind: string; action: string }) => {
        assert.equal(body.kind, 'session.control');
        assert.equal(body.action, 'notes.drain');
        return { ok: true, result: { attempted: 0, remaining: 0, issues: [] } };
      },
    },
  } as never);
  const workerInternals = worker as any;
  workerInternals.context = { sessionPath: '/a', session: { pendingMessageCount: 0 }, uiBridge: { hasPendingRequests: () => false } };
  const router = new WorkerRuntimeRouter({ supervisor: {}, coldStore: {}, ownership: {}, emit: () => undefined } as never);
  const internals = router as any;
  let forwarded = 0;
  const hot = { state: 'hot', rootSessionPath: '/a', workerRootSessionPath: '/a', currentLeasePath: '/a', currentLeaseRevision: 1,
    owner: { coordinatorGeneration: 1, workerId: 'snooze-worker', workerGeneration: 1 }, checkpoint: { busySeq: 0, tools: [] },
    worker: { workerId: 'snooze-worker', workerGeneration: 1, sessionPath: '/a', client: { requestFrame: async (body: any) => {
      forwarded++;
      try {
        const payload = await worker.command(body.operation, body.payload, body.payload.publicRequestId);
        return { ok: true, result: { kind: 'runtime.command', payload } };
      } catch (error) { return { ok: false, error: { code: 'SESSION_NOT_IDLE', message: String(error) } }; }
    } } },
  };
  const key = process.platform === 'win32' ? resolve('/a').toLowerCase() : resolve('/a');
  internals.roots.set(key, hot);
  internals.currentPaths.set(key, hot);
  internals.workersById.set('snooze-worker', hot);
  return { worker, workerInternals, router, internals, hot, forwarded: () => forwarded };
}

test('agent send overlapping snooze: coordinator ingress and already-forwarded worker work reject without hiding billable activity', async () => {
  const { worker, workerInternals, router, forwarded } = idleBarrierFixture();
  const wakeAt = Date.now() + 60_000;
  const initial = reducer(fixture(), { kind: 'SessionSnoozeRequested', sessionPath: '/a', now: Date.now(), wakeAt, deferredTarget: false });
  const id = initial.state.sessions.pendingSnoozes['/a']!.reservationId;
  const releaseAgent = router.beginAgentOperation('/a');
  await assert.rejects(router.reserveSnooze('/a', id, wakeAt), /pending or active work/);
  assert.equal(forwarded(), 0);
  releaseAgent();
  // Exercise the real message handler/worker admission, withholding busy IPC.
  workerInternals.sdk = {};
  workerInternals.requestDeps = () => ({
    allowCoordinatorAttribution: true, ensureSessionContext: async () => workerInternals.context,
    emit: () => undefined, emitBusyChanged: () => undefined,
  });
  workerInternals.context.session.prompt = () => {
    // Emulate SDK user-append acceptance; the provider/turn is unresolved.
    workerInternals.context.activeRequest.agentMessageDurability.settle(true);
    return new Promise(() => undefined);
  };
  const accepted = await worker.command('message.send', { params: {
    sessionPath: '/a', text: 'agent prompt', inputs: [], localId: 'local:agent-session:race',
    coordinatorAttribution: JSON.parse(JSON.stringify(createSessionControlSender({ sessionId: 'sender', identityFallback: false }))),
  } }, 'forwarded-agent-send') as { requestId: string };
  assert.ok(accepted.requestId);
  await assert.rejects(router.reserveSnooze('/a', id, wakeAt), /Worker did not confirm/);
  const rejected = reducer(initial.state, { kind: 'SessionSnoozeReservationResult', sessionPath: '/a', reservationId: id, ok: false, now: Date.now() });
  const visibleBusy = reducer(rejected.state, { kind: 'BusyChanged', sessionPath: '/a', running: true });
  assert.ok(visibleBusy.state.sessions.openTabPaths.includes('/a'));
  assert.ok(visibleBusy.state.sessions.runningSessionPaths.includes('/a'));
  assert.equal(workerInternals.context.activeRequest.id, accepted.requestId, 'snooze never stops work');
  workerInternals.context.activeRequest = undefined;
  workerInternals.pendingCommands = 1;
  await assert.rejects(router.reserveSnooze('/a', id, wakeAt), /Worker did not confirm/);
  workerInternals.pendingCommands = 0;
  assert.deepEqual(await router.reserveSnooze('/a', id, wakeAt), { reserved: true });
  const hidden = reducer(initial.state, { kind: 'SessionSnoozeReservationResult', sessionPath: '/a', reservationId: id, ok: true, now: Date.now() });
  assert.equal(hidden.state.sessions.snoozedBySession['/a']?.reservationId, id);
  assert.throws(() => router.beginAgentOperation('/a'), /reserved for snooze/);
  await assert.rejects(router.route({ id: 'racing-agent-send', method: 'message.send', params: { sessionPath: '/a', text: 'work' } }), /reserved for snooze/);
  assert.equal(workerInternals.context.activeRequest, undefined, 'no hidden billable work was admitted');
  await router.releaseSnooze('/a', id);
  router.beginAgentOperation('/a')();
});

test('promoting/transitioning routes and a forwarded runtime command reject snooze before busy telemetry', async () => {
  const { router, hot, internals } = idleBarrierFixture();
  const key = process.platform === 'win32' ? resolve('/a').toLowerCase() : resolve('/a');
  for (const state of ['promoting', 'transitioning', 'retiring']) {
    internals.roots.set(key, { state, rootSessionPath: '/a' });
    await assert.rejects(router.reserveSnooze('/a', 'busy-route', Date.now() + 60_000), /pending or active work/);
  }
  internals.roots.set(key, hot);
  let settle!: (value: unknown) => void;
  hot.worker.client.requestFrame = async () => await new Promise((resolve) => { settle = resolve; }) as any;
  const send = router.route({ id: 'agent-ipc', method: 'message.send', params: { sessionPath: '/a', text: 'prompt' } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(router.reserveSnooze('/a', 'ipc-race', Date.now() + 60_000), /pending or active work/);
  settle({ ok: true, result: { kind: 'runtime.command', payload: { requestId: 'owned-request' } } });
  await send;
  await assert.rejects(router.reserveSnooze('/a', 'preflight-race', Date.now() + 60_000), /pending or active work/);
});

test('worker fence rejects SDK queues/UI and expired reservations restore admission; failed ack releases both fences', async () => {
  const { worker, workerInternals, router, hot, internals } = idleBarrierFixture();
  for (const patch of [{ pendingMessageCount: 1 }, { isCompacting: true }, { isBashRunning: true }]) {
    workerInternals.context.session = patch;
    await assert.rejects(router.reserveSnooze('/a', 'reject', Date.now() + 60_000));
  }
  workerInternals.context.session = {};
  workerInternals.context.uiBridge.hasPendingRequests = () => true;
  await assert.rejects(router.reserveSnooze('/a', 'ui', Date.now() + 60_000));
  workerInternals.context.uiBridge.hasPendingRequests = () => false;
  await router.reserveSnooze('/a', 'expiry', Date.now() + 60_000);
  [...internals.snoozeReservations.values()][0].wakeAt = Date.now() - 1;
  workerInternals.snoozeReservation.wakeAt = Date.now() - 1;
  router.beginAgentOperation('/a')();
  await worker.command('session.snoozeReserve', { params: { reservationId: 'expired-replaced', wakeAt: Date.now() + 60_000 } }, 'expiry');
  await worker.command('session.snoozeRelease', { params: { reservationId: 'expired-replaced' } }, 'release');
  const realRequest = hot.worker.client.requestFrame;
  hot.worker.client.requestFrame = async (body: any) => {
    const response = await realRequest(body);
    if (body.operation === 'session.snoozeReserve') throw new Error('lost acknowledgement');
    return response;
  };
  await assert.rejects(router.reserveSnooze('/a', 'lost', Date.now() + 60_000), /lost acknowledgement/);
  assert.equal(workerInternals.snoozeReservation, undefined);
  router.beginAgentOperation('/a')();
});

test('failed worker release retains coordinator ownership and stale release cannot remove a newer reservation', async () => {
  const { router, hot, workerInternals, internals } = idleBarrierFixture();
  await router.reserveSnooze('/a', 'old', Date.now() + 60_000);
  const request = hot.worker.client.requestFrame;
  hot.worker.client.requestFrame = async () => { throw new Error('release lost'); };
  await assert.rejects(router.releaseSnooze('/a', 'old'), /release lost/);
  assert.equal([...internals.snoozeReservations.values()][0].reservationId, 'old');
  assert.throws(() => router.beginAgentOperation('/a'), /reserved for snooze/);
  hot.worker.client.requestFrame = request;
  await router.releaseSnooze('/a', 'old');
  router.beginAgentOperation('/a')();
  await router.reserveSnooze('/a', 'new', Date.now() + 60_000);
  await router.releaseSnooze('/a', 'old');
  assert.equal([...internals.snoozeReservations.values()][0].reservationId, 'new');
  assert.equal(workerInternals.snoozeReservation.reservationId, 'new');
  await router.releaseSnooze('/a', 'new');
});

test('ordinary reopen waits for delayed worker release and preserves ingress selection ownership', async () => {
  const { router, hot, workerInternals } = idleBarrierFixture();
  const now = Date.now();
  const requested = reducer(fixture(), { kind: 'SessionSnoozeRequested', sessionPath: '/a', now, wakeAt: now + 60_000, deferredTarget: false });
  const reservationId = requested.state.sessions.pendingSnoozes['/a']!.reservationId;
  await router.reserveSnooze('/a', reservationId, now + 60_000);
  let state = reducer(requested.state, { kind: 'SessionSnoozeReservationResult', sessionPath: '/a', reservationId, ok: true, now }).state;
  let resume!: () => void;
  const delayed = new Promise<void>((resolve) => { resume = resolve; });
  const request = hot.worker.client.requestFrame;
  hot.worker.client.requestFrame = async (body: any) => {
    if (body.operation === 'session.snoozeRelease') await delayed;
    return request(body);
  };
  const opens: unknown[] = [];
  const { deps, calls } = makeEffectRunnerDeps();
  deps.backend.request = async <T>(method: string, params?: unknown) => {
    if (method === 'session.snoozeRelease') return await router.releaseSnooze('/a', reservationId) as T;
    if (method === 'session.open') {
      assert.equal(workerInternals.snoozeReservation, undefined, 'hot worker admission is restored before hydration');
      router.beginAgentOperation('/a')();
      opens.push(params);
    }
    return {} as T;
  };
  const runner = new EffectRunner(deps);
  const dispatch = (event: Parameters<typeof reducer>[1]) => {
    const result = reducer(state, event);
    state = result.state;
    for (const effect of result.effects) runner.run(effect);
  };
  deps.dispatchEvent = dispatch;
  deps.dispatch = dispatch;
  dispatch({ kind: 'Command', cmd: { kind: 'OpenSession', corrId: 'ordinary-open', sessionPath: '/a', selectionToken: 'requested-focus', placeholderSummary: null, operationId: 'ordinary-open-op' } });
  assert.equal(state.sessions.activeSessionPath, '/a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opens, []);
  assert.equal(workerInternals.snoozeReservation.reservationId, reservationId);
  dispatch({ kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'newer-focus', sessionPath: '/b' } });
  resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, 1);
  assert.equal((opens[0] as { selectionToken: string }).selectionToken, 'requested-focus');
  assert.equal(state.sessions.activeSessionPath, '/b', 'release does not replay optimistic selection or steal newer focus');
  assert.deepEqual(state.sessions.snoozeReleases, {});
  assert.equal(calls.filter((call) => call.kind === 'handleSelectionFailure').length, 0);
  runner.dispose();
});
