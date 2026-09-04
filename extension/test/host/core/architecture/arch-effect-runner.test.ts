import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, decideModelStartTimerAction, type EffectRunnerDeps, type TimerSink, type TimerHandle } from '../../../../src/host/core/effect-runner';
import type { Effect } from '../../../../src/host/core/effects';
import type { EffectResultEvent, CommandEvent, Event } from '../../../../src/host/core/events';
import type { ProviderGateStats } from '../../../../src/shared/protocol';
import { BACKEND_READY_TIMEOUT_MS } from '../../../../src/shared/backend-ready-timeout';
import { RequestTimeoutError } from '../../../../src/shared/request-tracker';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

/** Deterministic timer sink: records scheduled timers and fires them on
 *  `runAll()` instead of waiting on wall-clock time. Eliminates real-timer
 *  waits and the flakes they cause under load. */
class FakeTimerSink implements TimerSink {
  private readonly pending: { fn: () => void; cancelled: boolean }[] = [];
  schedule(fn: () => void, _ms: number): TimerHandle {
    const handle = { fn, cancelled: false };
    this.pending.push(handle);
    return handle;
  }
  cancel(handle: TimerHandle): void {
    const h = handle as { fn: () => void; cancelled: boolean };
    h.cancelled = true;
    const i = this.pending.indexOf(h);
    if (i >= 0) this.pending.splice(i, 1);
  }
  /** Fire all pending timers synchronously (earliest-scheduled first). */
  runAll(): void {
    const ready = this.pending.splice(0);
    for (const h of ready) {
      if (!h.cancelled) {
        h.cancelled = true;
        h.fn();
      }
    }
  }
  get size(): number { return this.pending.length; }
}

async function settle(): Promise<void> {
  // Allow the runner's async work (microtasks + queued promises) to drain.
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function reconciliationEffect(options: {
  corrId: string;
  operationId: string;
  operationKind: Extract<Effect, { kind: 'ScheduleOperationReconciliation' }>['operationKind'];
  sessionPath?: string;
  backendGeneration: number;
  operationAttempt?: number;
  reconciliationAttempt: number;
  delayMs?: number;
}): Extract<Effect, { kind: 'ScheduleOperationReconciliation' }> {
  return {
    kind: 'ScheduleOperationReconciliation',
    sessionPath: '/a',
    operationAttempt: 1,
    delayMs: 0,
    ...options,
  };
}

test('EffectRunner logs effect.dispatch at debug for normal effect execution', () => {
  const { deps, calls } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'PersistTabs',
    corrId: 'debug-1',
    openTabPaths: ['/a'],
    activeSessionPath: '/a',
    pinnedTabPaths: [],
    pinnedTabGroups: [],
  });

  assert.deepEqual(calls[0], { kind: 'log', level: 'debug', message: 'effect.dispatch' });
});

test('EffectRunner routes InterruptRpc only through the target session queue', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = { kind: 'InterruptRpc', corrId: 'c1', sessionPath: '/a' };
  runner.run(effect);
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'debug' && c.message === 'effect.dispatch'),
  );

  assert.deepEqual(callsSansEffectDispatch[0], { kind: 'session', sessionPath: '/a' });
  assert.deepEqual(callsSansEffectDispatch[1], {
    kind: 'request',
    method: 'message.interrupt',
    params: { sessionPath: '/a', operationId: 'c1', operationAttempt: 1 },
  });
  assert.equal(callsSansEffectDispatch.some((call) => call.kind === 'lifecycle'), false);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'InterruptResult');
  assert.equal(events[0]?.corrId, 'c1');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner routes ContinueRpc through the session queue without a user prompt payload', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async () => ({ requestId: 'continue-request' }),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'ContinueRpc', corrId: 'continue-1', sessionPath: '/a' });
  await settle();

  const request = calls.find((call) => call.kind === 'request');
  assert.deepEqual(request, {
    kind: 'request',
    method: 'message.continue',
    params: { sessionPath: '/a', operationId: 'continue-1', operationAttempt: 1 },
  });
  assert.equal(events[0]?.kind, 'ContinueResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.requestId, 'continue-request');
});

test('EffectRunner façade preserves FIFO order across delegated session operations', async () => {
  let tail = Promise.resolve();
  const queues: EffectRunnerDeps['queues'] = {
    enqueueLifecycle: async <T>(task: () => Promise<T>): Promise<T> => task(),
    enqueueSessionOperation<T>(_sessionPath: string, task: () => Promise<T>): Promise<T> {
      const operation = tail.then(task);
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
  const timers = new FakeTimerSink();
  const { deps, calls } = makeEffectRunnerDeps({
    queues,
    timer: timers,
    requestImpl: async (method) => method === 'message.send' || method === 'message.continue'
      ? { requestId: `${method}:request` }
      : {},
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SendRpc', corrId: 'send-corr', operationId: 'send-op', operationAttempt: 1,
    backendGeneration: 4, sessionPath: '/a', text: 'one', composedText: 'one',
    inputs: [], localId: 'local-one',
  });
  runner.run({
    kind: 'ContinueRpc', corrId: 'continue-corr', operationId: 'continue-op',
    operationAttempt: 1, backendGeneration: 4, sessionPath: '/a',
  });
  runner.run({
    kind: 'CompactRpc', corrId: 'compact-corr', operationId: 'compact-op',
    operationAttempt: 1, backendGeneration: 4, sessionPath: '/a',
  });
  await tail;
  await settle();

  assert.deepEqual(
    calls.filter((call) => call.kind === 'request').map((call) => call.method),
    ['message.send', 'message.continue', 'message.compact'],
  );
  runner.dispose();
});

test('message.continue acknowledgement timeout reconciles to committed without a false rejection', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps, events, calls } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'message.continue') throw new RequestTimeoutError('continue-ack-lost');
      if (method === 'operation.status') return { state: 'accepted', requestId: 'continue-request', committed: true };
      return {};
    },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ContinueRpc', corrId: 'continue-lost', operationId: 'continue-op',
    operationAttempt: 1, backendGeneration: 7, sessionPath: '/a',
  });
  await settle();

  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationDelayed'
    && event.operationId === 'continue-op'));
  runner.run(reconciliationEffect({
    corrId: 'continue-lost', operationId: 'continue-op', operationKind: 'message.continue',
    backendGeneration: 7, reconciliationAttempt: 1,
  }));
  timers.runAll();
  await settle();
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.operationId === 'continue-op' && event.state === 'accepted' && event.committed === true));
  assert.equal(events.some((event) => event.kind === 'ContinueResult'), false);
  assert.ok(calls.some((call) => call.kind === 'request' && call.method === 'operation.status'
    && (call.params as { backendGeneration?: number }).backendGeneration === 7));
  runner.dispose();
});

test('message.compact acknowledgement ambiguity reaches bounded visible recovery', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'message.compact') throw new RequestTimeoutError('compact-ack-lost');
      if (method === 'operation.status') return { state: 'pending' };
      return {};
    },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'CompactRpc', corrId: 'compact-lost', operationId: 'compact-op',
    operationAttempt: 1, backendGeneration: 9, sessionPath: '/a',
  });
  await settle();
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationDelayed'
    && event.operationKind === 'message.compact'));
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    runner.run(reconciliationEffect({
      corrId: 'compact-lost', operationId: 'compact-op', operationKind: 'message.compact',
      backendGeneration: 9, reconciliationAttempt: attempt,
    }));
    timers.runAll();
    await settle();
  }

  assert.equal(hostEvents.filter((event) => event.kind === 'MessageOperationStatus'
    && event.state === 'pending').length, 4);
  assert.equal(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.state === 'reconciliation-exhausted'), false,
  'exhaustion is a reducer decision, not runner-owned state');
  runner.dispose();
});

test('session.open timeout stays ambiguous and a late correlated response settles the same operation', async () => {
  let lateSuccess: (() => void) | undefined;
  const backend: EffectRunnerDeps['backend'] = {
    async request<T>(_method: string, _params?: unknown, options?: import('../../../../src/host/core/effect-runner').CommitAwareRequestOptions<T>) {
      lateSuccess = () => options?.onCorrelatedResponse?.({ ok: true, result: {} as T });
      throw new RequestTimeoutError('open acknowledgement lost');
    },
  };
  const { deps, events, calls } = makeEffectRunnerDeps({ backend });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'OpenSession', corrId: 'open-corr', sessionPath: '/a', selectionToken: 'selection-1',
    operationId: 'open-operation', operationAttempt: 1, backendGeneration: 1,
  });
  await settle();

  assert.equal(calls.some((call) => call.kind === 'handleSelectionFailure'), false);
  assert.equal(events.some((event) => event.kind === 'OpenSessionResult'
    && event.operationId === 'open-operation' && event.ambiguous === true), true);

  lateSuccess?.();
  await settle();
  assert.equal(events.some((event) => event.kind === 'OpenSessionResult'
    && event.operationId === 'open-operation' && event.ok && !event.ambiguous), true);
});

test('EffectRunner keeps session.open reconciliation timers opaque and dispatches the reducer fence', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps, calls } = makeEffectRunnerDeps({
    timer: timers,
    dispatchEvent: (event) => hostEvents.push(event),
  });
  const runner = new EffectRunner(deps);
  const schedule: Effect = {
    kind: 'ScheduleOpenSessionReconciliation',
    corrId: 'open-reconcile-timer:open-operation:1',
    operationId: 'open-operation', sessionPath: '/a', operationAttempt: 1,
    backendGeneration: 7, delayMs: 1_000,
  };

  runner.run(schedule);
  runner.run(schedule);
  assert.equal(timers.size, 1, 'duplicate reducer effects share one opaque attempt timer');
  timers.runAll();
  assert.deepEqual(hostEvents, [{
    kind: 'OpenSessionReconciliationDue', operationId: 'open-operation',
    sessionPath: '/a', operationAttempt: 1, backendGeneration: 7,
  }]);

  runner.run({
    kind: 'RecoverOpenSession', corrId: 'open-recover:open-operation:3',
    selectionToken: 'selection-1', operationAttempt: 3, notice: 'Open could not be confirmed.',
  });
  await settle();
  assert.ok(calls.some((call) => call.kind === 'handleSelectionFailure'));
  runner.dispose();
});

test('EffectRunner serializes rapid system-prompt toggle snapshots per session', async () => {
  const queueTails = new Map<string, Promise<void>>();
  const queues: EffectRunnerDeps['queues'] = {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> { return await task(); },
    async enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      const previous = queueTails.get(sessionPath) ?? Promise.resolve();
      const next = previous.then(task, task);
      queueTails.set(sessionPath, next.then(() => undefined, () => undefined));
      return await next;
    },
  };
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const applied: string[][] = [];
  const { deps } = makeEffectRunnerDeps({
    queues,
    serviceOverrides: {
      async setSystemPromptToggles(_sessionPath, disabledEntries) {
        applied.push([...disabledEntries]);
        if (applied.length === 1) await firstBlocked;
      },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SetSystemPromptTogglesRpc', corrId: 'toggle-1', sessionPath: '/a', disabledEntries: ['harness'] });
  runner.run({ kind: 'SetSystemPromptTogglesRpc', corrId: 'toggle-2', sessionPath: '/a', disabledEntries: ['harness', 'skills', 'runtime'] });
  await settle();

  assert.deepEqual(applied, [['harness']], 'newer complete set waits for the older request');
  releaseFirst();
  await settle();
  assert.deepEqual(applied, [
    ['harness'],
    ['harness', 'skills', 'runtime'],
  ], 'the final picker snapshot is applied last');
});

test('a failed system-prompt toggle persist surfaces a notice instead of failing silently', async () => {
  const dispatched: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    dispatchEvent: (event) => { dispatched.push(event); },
    serviceOverrides: {
      async setSystemPromptToggles() { throw new Error('EACCES: settings.json is read-only'); },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SetSystemPromptTogglesRpc', corrId: 'toggle-fail', sessionPath: '/a', disabledEntries: ['harness'] });
  await settle();

  const notices = dispatched.filter((event) => event.kind === 'NoticeShown');
  assert.equal(notices.length, 1, 'the user must be told their toggle did not persist');
  assert.match((notices[0] as { notice: string }).notice, /Failed to save the system-prompt setting/);
  assert.equal((notices[0] as { sessionPath?: string }).sessionPath, '/a');
});

test('EffectRunner rolls privacy mode back and notifies when analytics cleanup fails', async () => {
  const dispatchedEvents: Event[] = [];
  const { deps, calls, commands } = makeEffectRunnerDeps({
    dispatchEvent: (event) => dispatchedEvents.push(event),
  });
  deps.statsService.setSessionPrivacy = async () => { throw new Error('analytics store locked'); };
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SetPrivacyMode', corrId: 'privacy-1', sessionPath: '/private.jsonl', enabled: true });
  await settle();

  assert.deepEqual(commands, [{
    kind: 'Command',
    cmd: {
      kind: 'SetPrivacyMode',
      corrId: 'privacy-cleanup-failed:privacy-1',
      sessionPath: '/private.jsonl',
      enabled: false,
    },
  }]);
  assert.ok(dispatchedEvents.some((event) => event.kind === 'NoticeShown'
    && event.notice?.includes('analytics store locked')));
  assert.ok(calls.some((call) => call.kind === 'log'
    && call.level === 'warn'
    && call.message === 'privacy analytics cleanup failed'));
});

test('EffectRunner grants only cold promotion the measured SDK startup budget', async () => {
  assert.ok(
    BACKEND_READY_TIMEOUT_MS > 68_000,
    'cold promotion must outlive the observed healthy 68s worker startup',
  );
  const observed: Array<{ method: string; sessionPath: string; timeoutMs?: number }> = [];
  let runtimeReady = false;
  const backend: EffectRunnerDeps['backend'] = {
    async request<T>(method: string, params?: unknown, options?: import('../../../../src/shared/request-tracker').RequestOptions): Promise<T> {
      observed.push({
        method,
        sessionPath: (params as { sessionPath: string }).sessionPath,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return { requestId: `request-${observed.length}` } as T;
    },
  };
  const { deps } = makeEffectRunnerDeps({
    backend,
    serviceOverrides: { isSessionRuntimeReady: () => runtimeReady },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'cold-send', sessionPath: '/cold', text: 'cold', inputs: [], composedText: 'cold', localId: 'local-cold' });
  await settle();
  runtimeReady = true;
  runner.run({ kind: 'SendRpc', corrId: 'hot-send', sessionPath: '/hot', text: 'hot', inputs: [], composedText: 'hot', localId: 'local-hot' });
  await settle();
  runtimeReady = false;
  runner.run({ kind: 'ContinueRpc', corrId: 'cold-continue', sessionPath: '/cold-continue' });
  await settle();
  runtimeReady = true;
  runner.run({ kind: 'ContinueRpc', corrId: 'hot-continue', sessionPath: '/hot-continue' });
  await settle();

  assert.deepEqual(observed, [
    { method: 'message.send', sessionPath: '/cold', timeoutMs: BACKEND_READY_TIMEOUT_MS },
    { method: 'message.send', sessionPath: '/hot' },
    { method: 'message.continue', sessionPath: '/cold-continue', timeoutMs: BACKEND_READY_TIMEOUT_MS },
    { method: 'message.continue', sessionPath: '/hot-continue' },
  ]);
  runner.dispose();
});

test('EffectRunner routes CompactRpc through the target session queue', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'CompactRpc', corrId: 'compact-1', sessionPath: '/a' });
  await settle();

  const relevantCalls = calls.filter(
    (call) => !(call.kind === 'log' && call.level === 'debug' && call.message === 'effect.dispatch'),
  );
  assert.deepEqual(relevantCalls[0], { kind: 'session', sessionPath: '/a' });
  assert.deepEqual(relevantCalls[1], {
    kind: 'request', method: 'message.compact', params: {
      sessionPath: '/a', operationId: 'compact-1', operationAttempt: 1, reason: 'manual',
    },
  });
  assert.deepEqual(events, [{
    kind: 'CompactResult', corrId: 'compact-1', operationId: 'compact-1',
    operationAttempt: 1, backendGeneration: 0, sessionPath: '/a', ok: true,
  }]);
});

test('Stop interrupts an in-flight manual compact immediately and later sends remain FIFO-ordered', async () => {
  const queueTails = new Map<string, Promise<void>>();
  const queues: EffectRunnerDeps['queues'] = {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> { return await task(); },
    async enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      const previous = queueTails.get(sessionPath) ?? Promise.resolve();
      const next = previous.then(task, task);
      queueTails.set(sessionPath, next.then(() => undefined, () => undefined));
      return await next;
    },
  };
  let markCompactStarted!: () => void;
  const compactStarted = new Promise<void>((resolve) => { markCompactStarted = resolve; });
  let finishCompact!: () => void;
  const compactFinished = new Promise<void>((resolve) => { finishCompact = resolve; });
  let finishInterrupt!: () => void;
  const interruptFinished = new Promise<void>((resolve) => { finishInterrupt = resolve; });
  const executionOrder: string[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    queues,
    timer: { schedule: () => ({}), cancel: () => undefined },
    requestImpl: async (method) => {
      executionOrder.push(method);
      if (method === 'message.compact') {
        markCompactStarted();
        await compactFinished;
      } else if (method === 'message.interrupt') {
        finishCompact();
        await interruptFinished;
        return { interrupted: true, settled: true };
      } else if (method === 'message.send') {
        return { requestId: 'send-after-stop' };
      }
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'CompactRpc', corrId: 'compact-active', sessionPath: '/a' });
  await compactStarted;
  runner.run({
    kind: 'InterruptRpc', corrId: 'stop-compact', sessionPath: '/a',
    usePriorityLane: true,
  });
  await settle();

  assert.deepEqual(
    executionOrder,
    ['message.compact', 'message.interrupt'],
    'Stop reaches the backend while compact still owns the session FIFO',
  );

  runner.run({
    kind: 'SendRpc', corrId: 'send-later', sessionPath: '/a', text: 'after stop',
    inputs: [], composedText: 'after stop', localId: 'local-after-stop',
  });
  await settle();
  assert.equal(executionOrder.includes('message.send'), false, 'later send waits for the interrupt barrier');

  finishInterrupt();
  await settle();
  runner.run({
    kind: 'ReleaseOperationResources', corrId: 'stop-compact',
    operationId: 'stop-compact', operationAttempt: 1,
  });
  await settle();
  assert.deepEqual(executionOrder, ['message.compact', 'message.interrupt', 'message.send']);
  assert.deepEqual(events.map((event) => event.kind), ['CompactResult', 'InterruptResult', 'SendResult']);
  runner.dispose();
});

test('ExtensionUiResponseRpc treats an already-consumed backend request as terminal success', async () => {
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      assert.equal(method, 'extension_ui.response');
      throw new Error('The extension UI request is no longer pending.');
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ExtensionUiResponseRpc',
    corrId: 'ui-stale',
    sessionPath: '/a',
    response: { id: 'dialog-1', confirmed: true },
  });
  await settle();

  assert.deepEqual(events, [{
    kind: 'ExtensionUiResponseResult',
    corrId: 'ui-stale',
    sessionPath: '/a',
    ok: true,
  }]);
});

test('a slow session RPC cannot block creating another session', async () => {
  let releaseSend!: () => void;
  const slowSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  let lifecycleQueue: Promise<void> = Promise.resolve();
  const sessionQueues = new Map<string, Promise<void>>();
  const queues: EffectRunnerDeps['queues'] = {
    enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
      const next = lifecycleQueue.catch(() => undefined).then(task);
      lifecycleQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      const previous = sessionQueues.get(sessionPath) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(task);
      sessionQueues.set(sessionPath, next.then(() => undefined, () => undefined));
      return next;
    },
  };
  const { deps, calls } = makeEffectRunnerDeps({
    queues,
    requestImpl: async (method) => {
      if (method === 'message.send') await slowSend;
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'slow-a', sessionPath: '/a', text: 'slow', inputs: [], composedText: 'slow', localId: 'local-a' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  runner.run({ kind: 'CreateSession', corrId: 'create-b', sessionPath: '/__pending__:b', cwd: '/workspace', selectionToken: 'token-b' });
  await settle();

  assert.ok(
    calls.some((call) => call.kind === 'request' && call.method === 'session.create'),
    'session.create must execute while an unrelated session request is pending',
  );

  releaseSend();
  await settle();
  runner.dispose();
});

test('live checkpoint repair bypasses mutation queues so active-session work cannot block recovery', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => method === 'liveTurn.checkpoint'
      ? { status: 'inactive', checkpoint: null, watermark: null }
      : {},
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'RequestLiveTurnCheckpoint',
    corrId: 'checkpoint-1',
    sessionPath: '/active',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
  });
  await settle();

  const meaningfulCalls = calls.filter(
    (call) => !(call.kind === 'log' && call.level === 'debug' && call.message === 'effect.dispatch'),
  );
  assert.equal(
    meaningfulCalls.some((call) => call.kind === 'lifecycle'),
    false,
    'repair traffic must not block create/open operations on the global lifecycle queue',
  );
  assert.deepEqual(meaningfulCalls[0], {
    kind: 'request',
    method: 'liveTurn.checkpoint',
    params: { sessionPath: '/active', turnId: 'turn-1', attemptId: 'attempt-1' },
  });
  assert.equal(events[0]?.kind, 'LiveTurnCheckpointResult');
  assert.equal(events[0]?.ok, true);
});

test('live checkpoint failure releases dedupe ownership before dispatching its retry result', async () => {
  let requestCount = 0;
  const checkpointResults: EffectResultEvent[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method !== 'liveTurn.checkpoint') return {};
      requestCount += 1;
      throw new Error('No hot worker owns /active');
    },
    dispatch: (event) => {
      checkpointResults.push(event);
      if (event.kind === 'LiveTurnCheckpointResult' && !event.ok && checkpointResults.length < 3) {
        runner.run({
          kind: 'RequestLiveTurnCheckpoint',
          corrId: `checkpoint-retry-${checkpointResults.length}`,
          sessionPath: '/active',
          turnId: 'turn-1',
          attemptId: 'attempt-1',
        });
      }
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'RequestLiveTurnCheckpoint',
    corrId: 'checkpoint-initial',
    sessionPath: '/active',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
  });
  await settle();

  assert.equal(requestCount, 3, 'each reducer-requested retry reaches the backend');
  assert.equal(checkpointResults.length, 3);
  assert.ok(checkpointResults.every((event) => event.kind === 'LiveTurnCheckpointResult' && !event.ok));
});

test('rapid preference writes are serialized latest-last without occupying lifecycle queue', async () => {
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const applied: Array<Record<string, unknown>> = [];
  const { deps, calls, events } = makeEffectRunnerDeps({
    serviceOverrides: {
      async setPrefs(prefs) {
        applied.push(prefs as Record<string, unknown>);
        if (applied.length === 1) await firstPending;
      },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SetPrefsRpc', corrId: 'prefs-a', prefs: { subagentMaxInflight: 2 } });
  runner.run({ kind: 'SetPrefsRpc', corrId: 'prefs-b', prefs: { subagentMaxInflight: 4 } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(applied, [{ subagentMaxInflight: 2 }], 'second write waits for the first');
  assert.equal(calls.some((call) => call.kind === 'lifecycle'), false);

  releaseFirst();
  await settle();
  assert.deepEqual(applied, [{ subagentMaxInflight: 2 }, { subagentMaxInflight: 4 }]);
  const prefsResults = events.filter((event): event is Extract<typeof event, { kind: 'SetPrefsResult' }> =>
    event.kind === 'SetPrefsResult');
  assert.deepEqual(prefsResults.map((event) => [event.kind, event.corrId, event.ok]), [
    ['SetPrefsResult', 'prefs-a', true],
    ['SetPrefsResult', 'prefs-b', true],
  ]);
});

test('EffectRunner CreateSession runs on the lifecycle queue and dispatches CreateSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'CreateSession',
    corrId: 'c2',
    sessionPath: '/__pending__:new',
    cwd: '/w',
    selectionToken: 'tok-1',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup; the service already
  // minted the selection token (before the reducer activated the pending tab).
  // The request is serialized with other session lifecycle work and carries
  // the pre-minted selection token.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.create', params: { cwd: '/w', selectionToken: 'tok-1' } });
  assert.equal(events[0]?.kind, 'CreateSessionResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.sessionPath, '/__pending__:new');
});

test('EffectRunner CreateSession calls handleSelectionFailure + dispatches CreateSessionResult{ok:false} when session.create rejects', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.create' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'CreateSession', corrId: 'c2b', sessionPath: '/__pending__:new2', cwd: '/w', selectionToken: 'tok-2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-2', notice: 'Failed to create session: backend down' });
  assert.equal(events[0]?.kind, 'CreateSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner OpenSession issues session.open (with the pre-minted token) on the lifecycle queue and dispatches OpenSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'OpenSession',
    corrId: 'c3',
    sessionPath: '/existing',
    selectionToken: 'tok',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup; the service already
  // minted the selection token (before the reducer activated the opened tab).
  // The runner only issues the backend session.open RPC, serialized on the
  // lifecycle queue, carrying that token — mirroring CreateSession.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.open', params: { sessionPath: '/existing', selectionToken: 'tok', transcript: 'tail' } });
  assert.equal(events[0]?.kind, 'OpenSessionResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.sessionPath, '/existing');
});

test('EffectRunner OpenSession forwards the service-chosen transcript mode (skip) on session.open', async () => {
  const { deps, calls } = makeEffectRunnerDeps({
    serviceOverrides: { getOpenTranscriptMode: () => 'skip' },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'OpenSession', corrId: 'c3-skip', sessionPath: '/cached', selectionToken: 'tok-skip' });
  await settle();

  assert.deepEqual(
    calls.find((c) => c.kind === 'request'),
    { kind: 'request', method: 'session.open', params: { sessionPath: '/cached', selectionToken: 'tok-skip', transcript: 'skip' } },
  );
});

test('EffectRunner OpenSession calls handleSelectionFailure + dispatches OpenSessionResult{ok:false} when session.open rejects', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.open' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'OpenSession', corrId: 'c3b', sessionPath: '/existing2', selectionToken: 'tok-2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-2', notice: 'Failed to open session: backend down' });
  assert.equal(events[0]?.kind, 'OpenSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner DuplicateSession issues session.duplicate (with the SOURCE path + pre-minted token) on the lifecycle queue and dispatches DuplicateSessionResult{ok:true}', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = {
    kind: 'DuplicateSession',
    corrId: 'c4',
    sessionPath: '/__pending__:copy',
    sourceSessionPath: '/src',
    selectionToken: 'tok-d',
  };
  runner.run(effect);
  await settle();

  // The reducer already did the optimistic tab setup (copy tab adjacent to the
  // source); the service already minted the selection token (before the reducer
  // activated the copy tab). The runner only issues the backend session.duplicate
  // RPC, serialized on the lifecycle queue, carrying the SOURCE path (not the
  // pending copy path) + the token — mirroring CreateSession/OpenSession.
  assert.equal(calls.some((c) => c.kind === 'lifecycle'), true);
  assert.deepEqual(calls.find((c) => c.kind === 'request'), { kind: 'request', method: 'session.duplicate', params: { sessionPath: '/src', selectionToken: 'tok-d' } });
  assert.equal(events[0]?.kind, 'DuplicateSessionResult');
  assert.equal(events[0]?.ok, true);
  // The pending COPY path is echoed back on the result (not the source path).
  assert.equal(events[0]?.sessionPath, '/__pending__:copy');
});

test('EffectRunner DuplicateSession calls handleSelectionFailure + dispatches DuplicateSessionResult{ok:false} when session.duplicate rejects', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: (method) => method === 'session.duplicate' ? Promise.reject(new Error('backend down')) : Promise.resolve({}) });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'DuplicateSession', corrId: 'c4b', sessionPath: '/__pending__:copy2', sourceSessionPath: '/src2', selectionToken: 'tok-d2' });
  await settle();

  assert.deepEqual(calls.find((c) => c.kind === 'handleSelectionFailure'), { kind: 'handleSelectionFailure', token: 'tok-d2', notice: 'Failed to duplicate session: backend down' });
  assert.equal(events[0]?.kind, 'DuplicateSessionResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner dispatches a failure result when an RPC rejects', async () => {
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c3', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'local-1' });
  await settle();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.equal(events[0].error, 'boom');
  }
});

test('EffectRunner runs PersistTabs outside lifecycle and session queues', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'PersistTabs',
    corrId: 'c4',
    openTabPaths: ['/a', '/b'],
    activeSessionPath: '/a',
    pinnedTabPaths: [],
    pinnedTabGroups: [],
  });
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'debug' && c.message === 'effect.dispatch'),
  );

  assert.equal(callsSansEffectDispatch.some((c) => c.kind === 'lifecycle'), false);
  assert.deepEqual(callsSansEffectDispatch[0], {
    kind: 'persistTabs',
    openTabPaths: ['/a', '/b'],
    active: '/a',
    pinnedTabPaths: [],
    pinnedTabGroups: [],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'PersistTabsResult');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner preserves private marker-removal lifecycle correlation on PersistTabs results', async () => {
  const { deps, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'PersistTabs',
    corrId: 'private-final',
    operationId: 'close-private',
    backendGeneration: 7,
    acknowledgementKey: 'privacy-marker-removal',
    openTabPaths: [],
    activeSessionPath: null,
    pinnedTabPaths: [],
    pinnedTabGroups: [],
    privateSessionPaths: [],
  });
  await settle();

  assert.deepEqual(events, [{
    kind: 'PersistTabsResult',
    corrId: 'private-final',
    operationId: 'close-private',
    backendGeneration: 7,
    acknowledgementKey: 'privacy-marker-removal',
    ok: true,
  }]);
});

test('EffectRunner fails the blocked private marker-removal acknowledgement when cleanup fails', async () => {
  let closeArgs: unknown[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    serviceOverrides: {
      async closeSession(...args) {
        closeArgs = args;
        throw new Error('forget failed');
      },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'CloseSession', corrId: 'private-close', sessionPath: '/private',
    operationId: 'close-private', backendGeneration: 7,
    privacyMode: true, nextPath: null,
  });
  await settle();

  assert.deepEqual(closeArgs, ['/private', null, true, false, 'close-private', 7]);
  assert.deepEqual(events.map((event) => {
    if (event.kind === 'PersistTabsResult') return [event.kind, event.acknowledgementKey, event.ok];
    if (event.kind === 'CloseSessionResult') return [event.kind, undefined, event.ok];
    return [event.kind, undefined, 'unexpected'];
  }), [
    ['CloseSessionResult', undefined, false],
    ['PersistTabsResult', 'privacy-marker-removal', false],
  ]);
});

test('EffectRunner serializes complete PersistTabs snapshots in dispatch order', async () => {
  const { deps, events } = makeEffectRunnerDeps();
  const started: string[] = [];
  const completed: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let activeWrites = 0;
  let maxActiveWrites = 0;

  deps.tabs.persistTabs = async (openTabPaths) => {
    const label = openTabPaths.join(',');
    started.push(label);
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    if (label === '/old,/closing') await firstBlocked;
    completed.push(label);
    activeWrites -= 1;
  };

  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'PersistTabs', corrId: 'persist-old',
    openTabPaths: ['/old', '/closing'], activeSessionPath: '/closing',
    pinnedTabPaths: ['/closing'], pinnedTabGroups: [],
  });
  runner.run({
    kind: 'PersistTabs', corrId: 'persist-new',
    openTabPaths: ['/old'], activeSessionPath: '/old',
    pinnedTabPaths: [], pinnedTabGroups: [],
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['/old,/closing']);
  assert.equal(maxActiveWrites, 1);

  releaseFirst();
  await settle();

  assert.deepEqual(started, ['/old,/closing', '/old']);
  assert.deepEqual(completed, ['/old,/closing', '/old']);
  assert.equal(maxActiveWrites, 1);
  assert.deepEqual(events.map((event) => event.kind === 'PersistTabsResult'
    ? [event.kind, event.corrId, event.ok]
    : [event.kind, event.corrId, 'unexpected']), [
    ['PersistTabsResult', 'persist-old', true],
    ['PersistTabsResult', 'persist-new', true],
  ]);
});

test('EffectRunner continues ordered tab persistence after an earlier snapshot fails', async () => {
  const { deps, events } = makeEffectRunnerDeps();
  const persisted: string[] = [];
  deps.tabs.persistTabs = async (openTabPaths) => {
    const label = openTabPaths.join(',');
    persisted.push(label);
    if (label === '/stale') throw new Error('storage unavailable');
  };

  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'PersistTabs', corrId: 'persist-failed', openTabPaths: ['/stale'],
    activeSessionPath: '/stale', pinnedTabPaths: [], pinnedTabGroups: [],
  });
  runner.run({
    kind: 'PersistTabs', corrId: 'persist-recovered', openTabPaths: ['/current'],
    activeSessionPath: '/current', pinnedTabPaths: [], pinnedTabGroups: [],
  });
  await settle();

  assert.deepEqual(persisted, ['/stale', '/current']);
  assert.deepEqual(events.map((event) => event.kind === 'PersistTabsResult'
    ? [event.corrId, event.ok]
    : [event.corrId, 'unexpected']), [
    ['persist-failed', false],
    ['persist-recovered', true],
  ]);
});

test('EffectRunner runs Log directly via the log sink (no dispatch event)', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'Log', corrId: 'c5', level: 'warn', message: 'hello' });
  await settle();

  assert.deepEqual(calls, [
    { kind: 'log', level: 'debug', message: 'effect.dispatch' },
    { kind: 'log', level: 'warn', message: 'hello' },
  ]);
  assert.equal(events.length, 0);
});

test('EffectRunner ShowModelSwitchConfirm dispatches ModelSwitchConfirmResult matching the user choice', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ modalChoice: 'Switch Model' });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'm1',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' },
    message: 'remove images?',
    confirmChoice: 'Switch Model',
  });
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'debug' && c.message === 'effect.dispatch'),
  );
  assert.deepEqual(callsSansEffectDispatch, [{ kind: 'showWarningModal', message: 'remove images?', confirmChoice: 'Switch Model' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'ModelSwitchConfirmResult');
  assert.equal(events[0]?.corrId, 'm1');
  assert.equal(events[0]?.confirmed, true);
});

test('EffectRunner ShowModelSwitchConfirm maps a dismissal (undefined choice) to confirmed:false', async () => {
  const { deps, events } = makeEffectRunnerDeps({ modalChoice: undefined });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'ShowModelSwitchConfirm',
    corrId: 'm2',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' },
    message: 'remove images?',
    confirmChoice: 'Switch Model',
  });
  await settle();

  assert.equal(events[0]?.kind, 'ModelSwitchConfirmResult');
  assert.equal(events[0]?.confirmed, false);
});

test('EffectRunner SetModelRpc writes settings.set, bumps the epoch, notifies the observer, and dispatches SetModelResult{ok:true}', async () => {
  const { deps, calls, commands, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm1',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'image-model', defaultProvider: 'image-provider', defaultThinkingLevel: 'medium' },
  });
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'debug' && c.message === 'effect.dispatch'),
  );

  // Serialized with sends for this session without blocking other tabs.
  assert.deepEqual(callsSansEffectDispatch[0], { kind: 'session', sessionPath: '/s' });
  assert.equal(callsSansEffectDispatch.some((call) => call.kind === 'lifecycle'), false);
  const req = callsSansEffectDispatch.find((c) => c.kind === 'request');
  assert.deepEqual(req, { kind: 'request', method: 'settings.set', params: { sessionPath: '/s', defaultModel: 'image-model', defaultProvider: 'image-provider', defaultThinkingLevel: 'medium' } });
  // Effect-side concerns (host-local epoch + disk-persisting analytics).
  assert.deepEqual(callsSansEffectDispatch.find((c) => c.kind === 'bumpEpoch'), { kind: 'bumpEpoch', sessionPath: '/s' });
  assert.deepEqual(callsSansEffectDispatch.find((c) => c.kind === 'onModelConfigChanged'), { kind: 'onModelConfigChanged', sessionPath: '/s', modelId: 'image-model', thinkingLevel: 'medium', provider: 'image-provider' });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SetModelResult');
  assert.equal(events[0]?.corrId, 'sm1');
  assert.equal(events[0]?.ok, true);
  assert.deepEqual(commands, [{
    kind: 'Command',
    cmd: { kind: 'HydrateModel', corrId: 'hydrate:model:sm1', sessionPath: '/s' },
  }]);
});

test('EffectRunner SetModelRpc dispatches SetModelResult{ok:false} when settings.set rejects (no epoch/observer call)', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps({ requestImpl: () => Promise.reject(new Error('backend down')) });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm2',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'image-model', defaultThinkingLevel: 'medium' },
  });
  await settle();

  assert.equal(calls.some((c) => c.kind === 'bumpEpoch'), false);
  assert.equal(calls.some((c) => c.kind === 'onModelConfigChanged'), false);
  assert.equal(events[0]?.kind, 'SetModelResult');
  assert.equal(events[0]?.ok, false);
  assert.equal(events[0]?.error, 'backend down');
});

test('EffectRunner restart drain waits for an accepted model/reasoning write to settle', async () => {
  let releaseWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'settings.set') await writeBlocked;
      return undefined;
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm-drain',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'gpt-5.6-sol', defaultProvider: 'openai-codex', defaultThinkingLevel: 'high' },
  });
  await settle();

  let drained = false;
  const drain = runner.drainConfigurationOperations().then(() => { drained = true; });
  await settle();
  assert.equal(drained, false, 'restart must remain fenced while settings.set is accepted but incomplete');

  releaseWrite();
  await drain;
  assert.equal(drained, true);
  assert.equal(events.some((event) => event.kind === 'SetModelResult' && event.ok), true);
});

test('RestartBackend effect drains configuration, confirms old death, then commits one result', async () => {
  let releaseWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const hostEvents: Event[] = [];
  let restartCalled = false;
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'settings.set') await writeBlocked;
      return undefined;
    },
    dispatchEvent: (event) => hostEvents.push(event),
    serviceOverrides: {
      async restart(onOldGenerationDeathConfirmed) {
        restartCalled = true;
        onOldGenerationDeathConfirmed?.();
      },
      getBackendGeneration: () => 8,
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'SetModelRpc', corrId: 'config-write', sessionPath: '/s',
    modelSettings: { defaultModel: 'model', defaultThinkingLevel: 'high' },
  });
  runner.run({
    kind: 'RestartBackend', corrId: 'restart-corr', operationId: 'restart-operation', backendGeneration: 7,
  });
  await settle();
  assert.equal(restartCalled, false);
  assert.equal(hostEvents.some((event) => event.kind === 'BackendRestartDrainCompleted'), false);

  releaseWrite();
  await settle();
  assert.equal(restartCalled, true);
  assert.deepEqual(hostEvents.map((event) => event.kind), [
    'BackendRestartDrainCompleted', 'BackendRestartOldGenerationDied',
  ]);
  const result = events.find((event) => event.kind === 'BackendRestartResult');
  assert.equal(result?.ok, true);
  assert.equal(result?.replacementBackendGeneration, 8);
});

test('EffectRunner DrainDeferredSetModelQueue re-dispatches confirmed choices against durable paths', async () => {
  const { deps, commands } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'DrainDeferredSetModelQueue',
    corrId: 'drain-model',
    entries: [{
      corrId: 'model-1',
      sessionPath: '/workspace/real.jsonl',
      modelSettings: { defaultModel: 'text-only', defaultProvider: 'p', defaultThinkingLevel: 'high' },
      clearImages: true,
      sequence: 1,
      previousModelId: 'old-model',
    }],
  });
  assert.equal(commands.length, 0, 'replay yields so SessionOpened can land after PendingPathReplaced');
  await settle();

  assert.deepEqual(commands, [{
    kind: 'Command',
    cmd: {
      kind: 'SetModel',
      corrId: 'model-1',
      sessionPath: '/workspace/real.jsonl',
      modelSettings: { defaultModel: 'text-only', defaultProvider: 'p', defaultThinkingLevel: 'high' },
      deferredReplay: true,
      clearImagesConfirmed: true,
    },
  }]);
});

// ─── DrainPendingSendQueue ────────────────────────────────────────────────────

test('EffectRunner DrainPendingSendQueue re-dispatches Send Commands with the resolved session path', async () => {
  const { deps, commands } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'DrainPendingSendQueue',
    corrId: 'drain:p1',
    resolvedSessionPath: '/workspace/real.jsonl',
    entries: [
      { corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
      { corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
    ],
  });
  await settle();

  // Two Send Commands dispatched, each with the resolved session path.
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.kind, 'Command');
  assert.equal(commands[0]?.cmd.kind, 'Send');
  assert.equal(commands[0]?.cmd.sessionPath, '/workspace/real.jsonl');
  assert.equal(commands[0]?.cmd.corrId, 'c1');
  assert.equal(commands[0]?.cmd.text, 'first');
  assert.equal(commands[0]?.cmd.localId, 'local:c1');
  assert.equal(commands[0]?.cmd.previousSummary, null);

  assert.equal(commands[1]?.kind, 'Command');
  assert.equal(commands[1]?.cmd.kind, 'Send');
  assert.equal(commands[1]?.cmd.sessionPath, '/workspace/real.jsonl');
  assert.equal(commands[1]?.cmd.corrId, 'c2');
  assert.equal(commands[1]?.cmd.text, 'second');
});

test('EffectRunner DrainPendingSendQueue with empty entries dispatches nothing', async () => {
  const { deps, commands } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'DrainPendingSendQueue',
    corrId: 'drain:p2',
    resolvedSessionPath: '/workspace/real.jsonl',
    entries: [],
  });
  await settle();

  assert.equal(commands.length, 0);
});

// ─── DrainBackendReadyQueue + Watchdog ────────────────────────────────────────

test('EffectRunner DrainBackendReadyQueue re-dispatches Send Commands for each entry + clears watchdog', async () => {
  const { deps, commands, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  // First start the watchdog (so we can verify it's cleared).
  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 30_000 });

  runner.run({
    kind: 'DrainBackendReadyQueue',
    corrId: 'drain:backendReady',
    entries: [
      { sessionPath: '/s1', corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
      { sessionPath: '/s2', corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
    ],
  });
  await settle();

  // Two Send Commands dispatched, each with its own sessionPath.
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.kind, 'Command');
  const cmd0 = commands[0]?.cmd;
  assert.equal(cmd0?.kind, 'Send');
  if (cmd0?.kind === 'Send') {
    assert.equal(cmd0.sessionPath, '/s1');
    assert.equal(cmd0.corrId, 'c1');
  }
  const cmd1 = commands[1]?.cmd;
  if (cmd1?.kind === 'Send') {
    assert.equal(cmd1.sessionPath, '/s2');
    assert.equal(cmd1.corrId, 'c2');
  }
});

test('EffectRunner StartBackendReadyWatchdog starts a timer that dispatches BackendReadyWatchdogFired on fire', () => {
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({ timer: timers });
  const dispatchedEvents: Event[] = [];
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });

  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 10 });
  // Fire the scheduled timer synchronously.
  timers.runAll();

  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0]?.kind, 'BackendReadyWatchdogFired');
});

test('EffectRunner CancelBackendReadyWatchdog prevents the timer from firing', () => {
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({ timer: timers });
  const dispatchedEvents: Event[] = [];
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });

  runner.run({ kind: 'StartBackendReadyWatchdog', corrId: 'watchdog', timeoutMs: 10 });
  runner.run({ kind: 'CancelBackendReadyWatchdog', corrId: 'watchdog' });
  // A cancelled timer must not fire.
  timers.runAll();

  assert.equal(dispatchedEvents.length, 0);
});

// ─── Send-timer (Brief B): post-ack, pre-commit phase ─────────────────────

// The send-timer owns the pre-ack-to-first-delta phase. It is started at RPC
// dispatch, cleared at the commit point (first MessageStarted → ClearSendTimer
// effect), and on fire dispatches PreflightFailed. The pre-ack phase is owned
// by the RequestTracker timeout (rejection → catch → clearInFlightSend).

test('EffectRunner SendRpc keeps the send-timer armed after early-ack (cleared at the commit point via ClearSendTimer)', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-1' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-ok', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  // Early-ack succeeded (SendResult{ok:true}); the send-timer stays armed — it
  // owns the post-ack, pre-commit phase and is cleared at the commit point
  // (first MessageStarted → ClearSendTimer), NOT at ack.
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, true);
  if (events[0]?.ok === true) {
    assert.equal(events[0].requestId, 'req-1');
  }
  assert.equal(timers.size, 1);

  // Commit point: the reducer emits ClearSendTimer; the runner clears the
  // send-timer so it cannot fire during a long-but-progressing turn.
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-ttl-ok' });
  assert.equal(timers.size, 0);
  timers.runAll(); // no spurious PreflightFailed dispatch
  assert.equal(events.length, 1);
  runner.dispose();
});

test('EffectRunner keeps a send pending when only its local acknowledgement deadline expires', async () => {
  const timers = new FakeTimerSink();
  const { deps, events, calls } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      assert.equal(method, 'message.send');
      throw new RequestTimeoutError('req-delayed-ack');
    },
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SendRpc', corrId: 'c-delayed-ack', sessionPath: '/a',
    text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-delayed-ack',
  });
  await settle();

  assert.equal(
    events.some((event) => event.kind === 'SendResult'),
    false,
    'a local timeout is not authoritative rejection evidence',
  );
  assert.equal(timers.size, 1, 'the semantic commit watchdog remains owned by the send');
  assert.ok(calls.some((call) => call.kind === 'log'
    && call.level === 'warn'
    && call.message === 'message.send acknowledgement delayed'));

  runner.run({ kind: 'ClearSendTimer', corrId: 'c-delayed-ack' });
  assert.equal(timers.size, 0, 'a later semantic commit can still settle the delayed send');
  runner.dispose();
});

test('message.send acknowledgement timeout reconciles through operation.status without rollback', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const observations: string[] = [];
  const { deps, events, calls } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'message.send') throw new RequestTimeoutError('req-stable-operation');
      if (method === 'operation.status') {
        return { state: 'accepted', requestId: 'request-1', committed: false };
      }
      return {};
    },
    dispatch: (event) => {
      events.push(event);
      observations.push(event.kind);
    },
    dispatchEvent: (event) => {
      hostEvents.push(event);
      observations.push(event.kind);
    },
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SendRpc', corrId: 'corr-stable', operationId: 'op-stable', operationAttempt: 2,
    backendGeneration: 4, sessionPath: '/a', text: 'hello', inputs: [], composedText: 'hello', localId: 'local-stable',
  });
  await settle();

  assert.ok(hostEvents.some((event) => event.kind === 'SendOperationDelayed'
    && event.operationId === 'op-stable' && event.operationAttempt === 2));
  assert.deepEqual(calls.find((call) => call.kind === 'request' && call.method === 'message.send'), {
    kind: 'request', method: 'message.send', params: {
      sessionPath: '/a', operationId: 'op-stable', operationAttempt: 2,
      text: 'hello', inputs: [], localId: 'local-stable',
    },
  });
  runner.run(reconciliationEffect({
    corrId: 'corr-stable', operationId: 'op-stable', operationKind: 'message.send',
    backendGeneration: 4, operationAttempt: 2, reconciliationAttempt: 1,
  }));
  timers.runAll();
  await settle();
  assert.ok(hostEvents.some((event) => event.kind === 'SendOperationStatus'
    && event.state === 'accepted' && event.operationAttempt === 2));
  assert.ok(events.some((event) => event.kind === 'SendResult' && event.ok
    && event.operationId === 'op-stable' && event.operationAttempt === 2
    && event.requestId === 'request-1'));
  const statusIndex = observations.lastIndexOf('SendOperationStatus');
  const resultIndex = observations.lastIndexOf('SendResult');
  assert.ok(statusIndex >= 0 && resultIndex > statusIndex,
    'ledger lifecycle status is delivered before its synthetic payload acknowledgement');
  assert.ok(calls.some((call) => call.kind === 'request' && call.method === 'operation.status'));
  assert.equal(hostEvents.some((event) => event.kind === 'PreflightFailed'), false);
  runner.dispose();
});

test('message.send ambiguity reaches bounded visible recovery when status stays pending', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => method === 'message.send'
      ? { requestId: 'request-pending' }
      : { state: 'pending' },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'SendRpc', corrId: 'corr-pending', operationId: 'op-pending', backendGeneration: 4,
    sessionPath: '/a', text: 'hello', inputs: [], composedText: 'hello', localId: 'local-pending',
  });
  await settle();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    runner.run(reconciliationEffect({
      corrId: 'corr-pending', operationId: 'op-pending', operationKind: 'message.send',
      backendGeneration: 4, reconciliationAttempt: attempt,
    }));
    timers.runAll();
    await settle();
  }

  assert.equal(hostEvents.filter((event) => event.kind === 'SendOperationStatus'
    && event.state === 'pending').length, 4);
  assert.equal(hostEvents.some((event) => event.kind === 'SendOperationStatus'
    && event.state === 'reconciliation-exhausted'), false);
  assert.equal(hostEvents.some((event) => event.kind === 'PreflightFailed'), false);
  runner.dispose();
});

test('message.send post-ack watchdog records ambiguity instead of rolling back', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => method === 'message.send'
      ? { requestId: 'request-watchdog' }
      : { state: 'accepted', requestId: 'request-watchdog', committed: false },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'SendRpc', corrId: 'corr-watchdog', operationId: 'op-watchdog', backendGeneration: 4,
    sessionPath: '/a', text: 'hello', inputs: [], composedText: 'hello', localId: 'local-watchdog',
  });
  await settle();
  timers.runAll();
  await settle();

  assert.ok(hostEvents.some((event) => event.kind === 'SendOperationDelayed'
    && event.operationId === 'op-watchdog'));
  assert.equal(hostEvents.some((event) => event.kind === 'PreflightFailed'), false);
  runner.dispose();
});

test('EffectRunner SendRpc calls getSendTimerTimeoutMs() with no argument for the dynamic send-timer budget', async () => {
  // The production wiring derives the budget from the current
  // prepassTimeoutSec + first-token headroom. Verify the runner calls the
  // getter with no argument (the getter is the only seam).
  const timers = new FakeTimerSink();
  let getterCalled = false;
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-fp3' }),
    getSendTimerTimeoutMs: () => {
      getterCalled = true;
      return 60_000;
    },
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-fp3', sessionPath: '/fp3-session', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-fp3' });
  await settle();

  assert.equal(getterCalled, true, 'getSendTimerTimeoutMs was called');
  runner.dispose();
});

test('EffectRunner SendRpc send-timer dispatches PreflightFailed on timeout (post-ack, no commit point)', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-7' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-pf', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  // Early-ack happened (SendResult{ok:true}); the send-timer is armed (no
  // commit point reached — no ClearSendTimer dispatched).
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(timers.size, 1);

  // Fire the send-timer → PreflightFailed dispatched WITH corrId (the
  // reducer's explicit-corrId path short-circuits its requestId scan).
  timers.runAll();
  assert.equal(dispatchedEvents.length, 1);
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    assert.equal(pf.corrId, 'c-pf');
    assert.equal(pf.sessionPath, '/a');
    assert.equal(pf.requestId, 'req-7');
    assert.match(pf.error, /Timed out/);
  }
  runner.dispose();
});

test('EffectRunner re-arms a successful prepass as model-start and reports the correct timeout phase', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-model-start' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-model-start', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-model-start' });
  await settle();
  runner.run({ kind: 'MarkPrepassSucceeded', corrId: 'c-model-start' });
  assert.equal(timers.size, 1, 'prepass timer is replaced, not duplicated');

  timers.runAll();
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    assert.equal(pf.error, 'Timed out waiting for the model to start streaming (120s)');
  }
  runner.dispose();
});

test('decideModelStartTimerAction defers for bounded active, queued, or paused provider work under the ceiling', () => {
  const metric = (over: { activeRequests?: number; queuedRequests?: number; paused?: boolean } = {}): ProviderGateStats => ({
    enabled: true,
    providers: [{
      provider: 'openai',
      activeRequests: 1,
      queuedRequests: 0,
      maxConcurrentRequests: 1,
      afterburnSeconds: 0,
      paused: false,
      pausedUntilMs: 0,
      strikeCount: 0,
      ...over,
    }],
  });
  // An admitted request may still be inside its bounded headers/first-chunk phase.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric(), requestProviderPending: true }), { action: 'defer' });
  // Saturated (queued) + under ceiling → defer.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ queuedRequests: 2 }), requestProviderPending: true }), { action: 'defer' });
  // Paused (circuit breaker) counts as saturated.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ paused: true }) }), { action: 'defer' });
  // Saturated + at/over ceiling → fire (hard backstop).
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 240_000, ceiling: 240_000, provider: 'openai', metrics: metric({ queuedRequests: 2 }), requestProviderPending: true }), { action: 'fire' });
  // Aggregate activity from a sibling session cannot mask this request.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ queuedRequests: 2 }), requestProviderPending: false }), { action: 'fire' });
  // No provider work → fire.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ activeRequests: 0 }) }), { action: 'fire' });
  // Fail-open: absent gate / unresolvable provider / missing metric → fire.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: undefined }), { action: 'fire' });
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: undefined, metrics: metric({ queuedRequests: 2 }) }), { action: 'fire' });
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'anthropic', metrics: metric({ queuedRequests: 2 }) }), { action: 'fire' });
});

test('EffectRunner model-start timer re-arms (defers) when the provider is saturated instead of firing PreflightFailed', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-rearm' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      enabled: true,
      providers: [{
        provider: 'openai',
        activeRequests: 1,
        queuedRequests: 2,
        maxConcurrentRequests: 1,
        afterburnSeconds: 0,
        paused: false,
        pausedUntilMs: 0,
        strikeCount: 0,
      }],
    }),
    resolveSessionProvider: () => 'openai',
    isSessionProviderPending: () => true,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-rearm', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-rearm' });
  await settle();
  runner.run({ kind: 'MarkPrepassSucceeded', corrId: 'c-rearm' });
  assert.equal(timers.size, 1, 'prepass timer replaced by the model-start timer');

  timers.runAll(); // model-start timer fires → saturated → re-arm (defer)
  assert.equal(dispatchedEvents.length, 0, 'no PreflightFailed while the provider is saturated');
  assert.equal(timers.size, 1, 'timer re-armed for another window');
  runner.dispose();
});

test('EffectRunner SendRpc send-timer budget honors getSendTimerTimeoutMs (prepass-aware; takes precedence over the 120s default)', async () => {
  // The production wiring derives the budget from the current prepassTimeoutSec
  // (+ first-token headroom) so a long-but-legitimate prepass never trips a
  // spurious PreflightFailed. Verify the getter governs the timer: the fire
  // error reflects the getter's budget, NOT the 120s default.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-pp' }),
    getSendTimerTimeoutMs: () => 210_000, // e.g. prepassTimeoutSec=180 + 30s headroom
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-pp', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-pp' });
  await settle();
  assert.equal(timers.size, 1); // send-timer armed after early-ack
  timers.runAll(); // fire
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    // 210s (the getter's budget), NOT 120s (the default) — proves the
    // prepass-aware budget governs the timer + the error message.
    assert.match(pf.error, /210s/);
    assert.ok(!/120s/.test(pf.error));
  }
  runner.dispose();
});

test('EffectRunner EditRpc issues one idempotent compound request with commit evidence', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => method === 'message.edit'
      ? { operationId: 'edit-op', operationAttempt: 1, requestId: 'replacement', committed: true }
      : { state: 'accepted', requestId: 'replacement', committed: true },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'EditRpc', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', messageId: 'old-user', text: 'replacement',
    inputs: [], composedText: 'replacement', localId: 'replacement-local',
  });
  await settle();

  const requests = calls.filter((call) => call.kind === 'request');
  assert.equal(requests[0]?.method, 'message.edit');
  assert.deepEqual(requests[0]?.params, {
    sessionPath: '/a', entryId: 'old-user', text: 'replacement', inputs: [],
    localId: 'replacement-local', operationId: 'edit-op', operationAttempt: 1,
  });
  assert.equal(requests.some((call) => call.method === 'message.interrupt'
    || call.method === 'session.truncateAfter' || call.method === 'message.send'), false);
  assert.deepEqual(events, [{
    kind: 'EditResult', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', ok: true, committed: true, requestId: 'replacement',
  }]);
  assert.equal(timers.size, 0, 'a correlated committed acknowledgement needs no semantic-status polling');
  assert.equal(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.state === 'reconciliation-exhausted'), false);
  runner.dispose();
});

test('EditRpc dropped acknowledgement reconciles committed status without a false terminal deadline', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const methods: string[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.edit') throw new RequestTimeoutError('edit ack dropped');
      return { operationId: 'edit-op', state: 'accepted', requestId: 'replacement', committed: true };
    },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'EditRpc', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', messageId: 'old-user', text: 'replacement',
    inputs: [], localId: 'replacement-local',
  });
  await settle();
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationDelayed'
    && event.operationKind === 'message.edit'));
  runner.run(reconciliationEffect({
    corrId: 'edit-corr', operationId: 'edit-op', operationKind: 'message.edit',
    backendGeneration: 7, reconciliationAttempt: 1,
  }));
  timers.runAll();
  await settle();

  assert.deepEqual(methods, ['message.edit', 'operation.status']);
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.operationKind === 'message.edit' && event.state === 'accepted'
    && event.committed === true));
  assert.equal(timers.size, 0);
  assert.equal(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.state === 'reconciliation-exhausted'), false);
  runner.dispose();
});

test('Stop cancels an edit waiting in the session FIFO before any destructive request', async () => {
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const tails = new Map<string, Promise<void>>();
  const queues = {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> { return await task(); },
    async enqueueSessionOperation<T>(path: string, task: () => Promise<T>): Promise<T> {
      const next = (tails.get(path) ?? Promise.resolve()).then(task, task);
      tails.set(path, next.then(() => undefined, () => undefined));
      return await next;
    },
  };
  void queues.enqueueSessionOperation('/a', async () => await blocker);

  const hostEvents: Event[] = [];
  const methods: string[] = [];
  const { deps } = makeEffectRunnerDeps({
    queues,
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.interrupt') return { interrupted: true, settled: true };
      if (method === 'message.edit') return { requestId: 'must-not-run', committed: true };
      return {};
    },
    dispatchEvent: (event) => hostEvents.push(event),
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'EditRpc', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', messageId: 'old-user', text: 'replacement',
    inputs: [], localId: 'replacement-local',
  });
  runner.run({
    kind: 'InterruptRpc', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a',
    cancelQueuedOperationIds: ['edit-op'], usePriorityLane: true,
  });
  await settle();
  assert.deepEqual(methods, ['message.interrupt'], 'Stop reaches the backend while the edit remains queued');

  releaseBlocker();
  await settle();
  assert.equal(methods.includes('message.edit'), false);
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.operationId === 'edit-op' && event.state === 'cancelled'
    && event.committed === false));
  runner.dispose();
});

test('EditRpc acknowledgement loss reconciles read-only and never repeats the mutation', async () => {
  const timers = new FakeTimerSink();
  const hostEvents: Event[] = [];
  const methods: string[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.edit') throw new RequestTimeoutError('edit ack lost');
      return { operationId: 'edit-op', state: 'failed', committed: true,
        code: 'MESSAGE_SEND_PRECOMMIT_FAILED', message: 'replacement failed', outcome: 'failed' };
    },
    dispatchEvent: (event) => hostEvents.push(event),
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'EditRpc', corrId: 'edit-corr', operationId: 'edit-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', messageId: 'old-user', text: 'replacement',
    inputs: [], localId: 'replacement-local',
  });
  await settle();
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationDelayed'
    && event.operationKind === 'message.edit'));
  runner.run(reconciliationEffect({
    corrId: 'edit-corr', operationId: 'edit-op', operationKind: 'message.edit',
    backendGeneration: 7, reconciliationAttempt: 1,
  }));
  timers.runAll();
  await settle();

  assert.deepEqual(methods, ['message.edit', 'operation.status']);
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.operationKind === 'message.edit' && event.state === 'failed'
    && event.committed === true));
  runner.dispose();
});

test('InterruptRpc carries stable identity and blocks a following send until settlement', async () => {
  const timers = new FakeTimerSink();
  let releaseStop!: () => void;
  const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
  const methods: string[] = [];
  const queues = (() => {
    const tails = new Map<string, Promise<void>>();
    return {
      async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> { return await task(); },
      async enqueueSessionOperation<T>(path: string, task: () => Promise<T>): Promise<T> {
        const next = (tails.get(path) ?? Promise.resolve()).then(task, task);
        tails.set(path, next.then(() => undefined, () => undefined));
        return await next;
      },
    };
  })();
  const { deps, events } = makeEffectRunnerDeps({
    queues, timer: timers,
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.interrupt') {
        await stopPending;
        return { interrupted: true, settled: true };
      }
      if (method === 'message.send') return { requestId: 'after-stop' };
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'InterruptRpc', corrId: 'stop-corr', operationId: 'stop-op',
    operationAttempt: 1, backendGeneration: 7, sessionPath: '/a' });
  runner.run({ kind: 'SendRpc', corrId: 'send-corr', operationId: 'send-op',
    backendGeneration: 7, sessionPath: '/a', text: 'later', inputs: [],
    composedText: 'later', localId: 'later-local' });
  await settle();
  assert.deepEqual(methods, ['message.interrupt']);

  releaseStop();
  await settle();
  runner.run({
    kind: 'ReleaseOperationResources', corrId: 'stop-corr',
    operationId: 'stop-op', operationAttempt: 1,
  });
  await settle();
  assert.deepEqual(methods, ['message.interrupt', 'message.send']);
  const stop = events.find((event) => event.kind === 'InterruptResult');
  assert.ok(stop?.kind === 'InterruptResult' && stop.committed === undefined && stop.settled === true);
  runner.dispose();
});

test('an unsettled interrupt acknowledgement keeps status reconciliation alive', async () => {
  const timers = new FakeTimerSink();
  const methods: string[] = [];
  const hostEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    timer: timers,
    dispatch: (event) => hostEvents.push(event),
    dispatchEvent: (event) => hostEvents.push(event),
    requestImpl: async (method) => {
      methods.push(method);
      if (method === 'message.interrupt') {
        return { interrupted: false, alreadyStopped: true, settled: false, recoveryPending: true };
      }
      return { state: 'accepted', committed: true, interrupted: true, settled: true };
    },
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'InterruptRpc', corrId: 'stop-corr', operationId: 'stop-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a',
  });
  await settle();
  const acknowledgement = hostEvents.find((event) => event.kind === 'InterruptResult');
  assert.ok(acknowledgement?.kind === 'InterruptResult');
  assert.equal(acknowledgement.committed, undefined);
  runner.run(reconciliationEffect({
    corrId: 'stop-corr', operationId: 'stop-op', operationKind: 'message.interrupt',
    backendGeneration: 7, reconciliationAttempt: 1, delayMs: 1_000,
  }));
  assert.equal(timers.size, 1);

  timers.runAll();
  await settle();
  assert.deepEqual(methods, ['message.interrupt', 'operation.status']);
  assert.ok(hostEvents.some((event) => event.kind === 'MessageOperationStatus'
    && event.operationKind === 'message.interrupt' && event.state === 'accepted'
    && event.committed === true && event.settled === true));
  runner.dispose();
});

test('EffectRunner SendRpc clears the send-timer on pre-ack failure (no spurious PreflightFailed)', async () => {
  // Pre-ack failure window: the RequestTracker rejection (or abort) rejects
  // backend.request → the catch clears the send-timer (no commit will come) and
  // dispatches SendResult{ok:false}. The send-timer never fires → no double
  // rollback path (never both timers fire for one send).
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-fail', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  // The failure path must have cancelled the send-timer; firing pending timers
  // must not produce a spurious PreflightFailed.
  assert.equal(timers.size, 0);
  timers.runAll();
  assert.equal(dispatchedEvents.length, 0);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.equal(events[0].error, 'boom');
  }
  runner.dispose();
});

test('EffectRunner send-timer fire then late commit retracts the false-positive (PreflightSuperseded) — no double PreflightFailed', async () => {
  // False-positive retraction (hardening): if the send-timer fires
  // (PreflightFailed) because the provider was slow to first-token, and the
  // commit point then arrives late (the turn actually started streaming),
  // ClearSendTimer detects `fired === true` and dispatches a PreflightSuperseded
  // retraction so the reducer undoes the rollback. Exactly one PreflightFailed is
  // ever dispatched (no double-rollback); the second event is the retraction.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-dd' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-dd', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  timers.runAll(); // fire → PreflightFailed dispatched once
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1);
  assert.equal(dispatchedEvents[0]?.kind, 'PreflightFailed');

  // A late ClearSendTimer (commit point arriving after the fire) retracts the
  // false-positive: dispatches PreflightSuperseded (NOT a second PreflightFailed).
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-dd' });
  timers.runAll();
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1); // still exactly one PreflightFailed
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightSuperseded').length, 1); // exactly one retraction
  const retract = dispatchedEvents.find((e) => e.kind === 'PreflightSuperseded');
  if (retract?.kind === 'PreflightSuperseded') {
    assert.equal(retract.corrId, 'c-dd');
    assert.equal(retract.sessionPath, '/a');
    assert.equal(retract.localId, 'loc-1');
    assert.equal(retract.composedText, 'hi');
    assert.equal(retract.requestId, 'req-dd');
    assert.equal(typeof retract.timestamp, 'number');
  }
  runner.dispose();
});

test('EffectRunner send-timer pre-ack fire (no requestId) does NOT emit a stray PreflightSuperseded on late clear', async () => {
  // Degenerate case (hardening): the send-timer fired BEFORE the early-ack
  // stamped a requestId. `onSendTimerFire` logs a warn but dispatches NO
  // `PreflightFailed` (it has no requestId to attribute). A late ClearSendTimer
  // must NOT emit a stray `PreflightSuperseded` — there was no false-positive
  // notice/rollback to retract — so it falls through to the normal pruning
  // restore. Guards against a spurious retraction for a turn that never
  // surfaced an error in the first place.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // never early-acks → no requestId stamped
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-pre', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-pre' });
  await settle();
  timers.runAll(); // pre-ack fire → warn logged, NO PreflightFailed (no requestId)
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 0);

  // A late ClearSendTimer must not retract a false-positive that never happened.
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-pre' });
  await settle();
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightSuperseded').length, 0);
  runner.dispose();
});

test('EffectRunner dispose clears all send-timers', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // never resolves
    sendTimerTimeoutMs: 1000,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ttl-dispose', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  // Dispose before the timer can fire; firing pending timers must not dispatch.
  runner.dispose();
  assert.equal(timers.size, 0);
  timers.runAll();

  assert.equal(events.length, 0);
});

test('registered send cancellation executes only the reducer-described corrId', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    timer: timers,
    requestImpl: async (method) => method === 'message.send'
      ? new Promise(() => {})
      : { interrupted: false, alreadyStopped: true, settled: true },
  });
  const runner = new EffectRunner(deps);
  runner.run({
    kind: 'SendRpc', corrId: 'registered-send', operationId: 'send-op', backendGeneration: 7,
    sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'local-registered',
  });
  runner.run({
    kind: 'InterruptRpc', corrId: 'registered-stop', operationId: 'stop-op', operationAttempt: 1,
    backendGeneration: 7, sessionPath: '/a', abortSendCorrIds: ['registered-send'],
  });
  await settle();

  const rejected = events.find((event) => event.kind === 'SendResult');
  assert.ok(rejected?.kind === 'SendResult' && rejected.ok === false);
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner abortInFlightSend cancels an in-flight message.send (pre-ack) → SendResult{ok:false} + send-timer cleared', async () => {
  // Cancel path (Brief E consumes this): aborting the in-flight send's
  // AbortController rejects backend.request → catch → SendResult{ok:false}
  // (pre-ack rollback) + the send-timer cleared (no spurious PreflightFailed).
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => new Promise(() => {}), // hangs until aborted
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-abort', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  // The send is in-flight (pre-ack, hanging). Abort it (Brief E interrupt).
  assert.equal(runner.abortInFlightSend('/a'), true);
  await settle();

  // The abort rejected the in-flight message.send → SendResult{ok:false} + the
  // send-timer cleared (no spurious PreflightFailed).
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.ok === false) {
    assert.match(events[0].error ?? '', /cancelled/i);
  }
  assert.equal(timers.size, 0);
  assert.equal(dispatchedEvents.length, 0);
  timers.runAll(); // no spurious PreflightFailed
  assert.equal(events.length, 1);

  // abortInFlightSend on a session with no in-flight send returns false.
  assert.equal(runner.abortInFlightSend('/none'), false);
  runner.dispose();
});

test('EffectRunner abortInFlightSend returns false when the send already early-acked-and-committed (cleared)', async () => {
  // After the commit point (ClearSendTimer), the in-flight send context is
  // gone, so a later abort is a safe no-op (returns false) — no stale abort.
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-cl' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-cl', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-1' });
  await settle();
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-cl' });
  assert.equal(runner.abortInFlightSend('/a'), false);
  runner.dispose();
});

// ─── Brief H: retry-without-pruning restores the prior pruning mode ──────────
// A "retry without pruning" send carries the user's prior pruning mode (captured
// before the host disabled it). The EffectRunner restores it when the in-flight
// send resolves — at the commit point (ClearSendTimer), on send-timer fire
// (PreflightFailed), and on pre-ack failure — so pruning returns to the user's
// prior mode for the next turn instead of staying permanently off.

test('EffectRunner SendRpc restores prior pruning mode at the commit point (Brief H retry-without-pruning)', async () => {
  const timers = new FakeTimerSink();
  const pruningCalls: { mode?: string }[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-rp' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    serviceOverrides: { setPruningSettings: async (updates) => { pruningCalls.push(updates as { mode?: string }); } },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-rp', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-rp', priorPruningMode: 'auto' });
  await settle();
  // Early-ack: NO restore yet — the prepass is still running (pruning must stay
  // off until the turn commits).
  assert.equal(pruningCalls.length, 0, 'no restore at ack time (prepass still running)');

  // Commit point (first MessageStarted → ClearSendTimer): restore the prior mode.
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-rp' });
  assert.equal(pruningCalls.length, 1, 'pruning restored at the commit point');
  assert.equal(pruningCalls[0]?.mode, 'auto', 'restored to the captured prior mode');
  // The send-timer is cleared; a later fire cannot double-restore.
  assert.equal(timers.size, 0);
  timers.runAll();
  assert.equal(pruningCalls.length, 1, 'no double-restore after clear (send already resolved)');
  runner.dispose();
});

test('EffectRunner SendRpc restores prior pruning mode on send-timer fire (PreflightFailed — Brief H)', async () => {
  const timers = new FakeTimerSink();
  const pruningCalls: { mode?: string }[] = [];
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-fire' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    serviceOverrides: { setPruningSettings: async (updates) => { pruningCalls.push(updates as { mode?: string }); } },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-fire', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-fire', priorPruningMode: 'shadow' });
  await settle();
  // No commit point — fire the send-timer (PreflightFailed: the turn never
  // started streaming). The prepass ran (and timed out), so restoring is safe.
  timers.runAll();
  assert.equal(dispatchedEvents.length, 1);
  assert.equal(dispatchedEvents[0]?.kind, 'PreflightFailed');
  assert.equal(pruningCalls.length, 1, 'pruning restored on fire');
  assert.equal(pruningCalls[0]?.mode, 'shadow');
  runner.dispose();
});

test('EffectRunner SendRpc restores prior pruning mode on pre-ack failure (Brief H)', async () => {
  const timers = new FakeTimerSink();
  const pruningCalls: { mode?: string }[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.reject(new Error('boom')),
    sendTimerTimeoutMs: 50,
    timer: timers,
    serviceOverrides: { setPruningSettings: async (updates) => { pruningCalls.push(updates as { mode?: string }); } },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-paf', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-paf', priorPruningMode: 'custom' });
  await settle();
  // Pre-ack failure: SendResult{ok:false} (no commit will come) + restore. The
  // prepass never ran (the RPC itself failed), so restoring is safe.
  assert.equal(events.at(-1)?.kind, 'SendResult');
  assert.equal(pruningCalls.length, 1, 'pruning restored on pre-ack failure');
  assert.equal(pruningCalls[0]?.mode, 'custom');
  runner.dispose();
});

test('EffectRunner SendRpc does NOT touch pruning for a normal send (no priorPruningMode — Brief H)', async () => {
  const timers = new FakeTimerSink();
  const pruningCalls: { mode?: string }[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-norm' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    serviceOverrides: { setPruningSettings: async (updates) => { pruningCalls.push(updates as { mode?: string }); } },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-norm', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-norm' });
  await settle();
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-norm' });
  timers.runAll();
  assert.equal(pruningCalls.length, 0, 'a normal send (no priorPruningMode) never restores pruning');
  runner.dispose();
});

test('EffectRunner mints the subscription ID and routes Phase 5 detail effects to the session service', async () => {
  const { deps, calls } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);
  const address = {
    sessionPath: '/a/session.jsonl', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };

  runner.run({
    kind: 'DetailSubscribeRpc', corrId: 'c-sub', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 7,
    address, cursor: { revision: 1 },
  });
  runner.run({
    kind: 'DetailUnsubscribeRpc', corrId: 'c-unsub', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 7, reason: 'collapse',
  });
  runner.run({
    kind: 'DetailFetchPagesRpc', corrId: 'c-fetch', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 7,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 2 },
  });
  await settle();

  const detailCalls = calls.filter((call) => call.kind === 'subscribeDetail' || call.kind === 'unsubscribeDetail' || call.kind === 'fetchDetailPages');
  assert.equal(detailCalls.length, 3);
  const subscribe = detailCalls[0];
  assert.equal(subscribe?.kind, 'subscribeDetail');
  if (subscribe?.kind === 'subscribeDetail') {
    assert.equal(typeof subscribe.subscriptionId, 'string');
    assert.ok(subscribe.subscriptionId.length > 0, 'the runner mints the subscription ID');
    assert.equal(subscribe.viewGeneration, 3);
    assert.equal(subscribe.detailKey, 'subagent:msg:tool');
    assert.equal(subscribe.detailAttempt, 7);
    assert.deepEqual(subscribe.address, address);
    assert.deepEqual(subscribe.cursor, { revision: 1 });
  }
  assert.deepEqual(detailCalls[1], { kind: 'unsubscribeDetail', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 7, reason: 'collapse' });
  assert.deepEqual(detailCalls[2], {
    kind: 'fetchDetailPages', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 7,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 2 },
  });
  runner.dispose();
});
