import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, decideModelStartTimerAction, type BackendLike, type CommitAwareRequestOptions, type EffectRunnerDeps, type TimerSink, type TimerHandle } from '../../../../src/host/core/effect-runner';
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
    params: { sessionPath: '/a' },
  });
  assert.equal(callsSansEffectDispatch.some((call) => call.kind === 'lifecycle'), false);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'InterruptResult');
  assert.equal(events[0]?.corrId, 'c1');
  assert.equal(events[0]?.ok, true);
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
  const observed: Array<{ sessionPath: string; timeoutMs?: number }> = [];
  let runtimeReady = false;
  const backend: EffectRunnerDeps['backend'] = {
    async request<T>(_method: string, params?: unknown, options?: import('../../../../src/shared/request-tracker').RequestOptions): Promise<T> {
      observed.push({
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

  assert.deepEqual(observed, [
    { sessionPath: '/cold', timeoutMs: BACKEND_READY_TIMEOUT_MS },
    { sessionPath: '/hot' },
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
    kind: 'request', method: 'message.compact', params: { sessionPath: '/a' },
  });
  assert.deepEqual(events, [{ kind: 'CompactResult', corrId: 'compact-1', sessionPath: '/a', ok: true }]);
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

test('EffectRunner runs PersistTabs synchronously without queueing', async () => {
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

test('decideModelStartTimerAction defers only for a saturated provider under the ceiling', () => {
  const metric = (over: { queuedRequests?: number; paused?: boolean } = {}): ProviderGateStats => ({
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
  // Saturated (queued) + under ceiling → defer.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ queuedRequests: 2 }) }), { action: 'defer' });
  // Paused (circuit breaker) counts as saturated.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric({ paused: true }) }), { action: 'defer' });
  // Saturated + at/over ceiling → fire (hard backstop).
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 240_000, ceiling: 240_000, provider: 'openai', metrics: metric({ queuedRequests: 2 }) }), { action: 'fire' });
  // Not saturated → fire.
  assert.deepEqual(decideModelStartTimerAction({ elapsed: 1000, ceiling: 240_000, provider: 'openai', metrics: metric() }), { action: 'fire' });
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

test('EffectRunner EditRpc send-timer dispatches PreflightFailed on timeout (edit follows the same phase-scoped shape)', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-9' }),
    sendTimerTimeoutMs: 50,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-pf-edit', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-e1', interruptFirst: false });
  await settle();
  // Early-ack happened (EditResult{ok:true}); the send-timer is armed.
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'EditResult');
  assert.equal(events[0]?.ok, true);
  assert.equal(timers.size, 1);

  // Fire the send-timer → PreflightFailed (STATE_CONTRACT § Optimistic
  // Reconciliation "Timer ownership": edit follows the same phase-scoped shape).
  timers.runAll();
  assert.equal(dispatchedEvents.length, 1);
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    assert.equal(pf.corrId, 'c-pf-edit');
    assert.equal(pf.requestId, 'req-9');
  }
  runner.dispose();
});

test('EffectRunner EditRpc interrupts before truncating and sending when interruptFirst is true', async () => {
  let suppressionCount = 0;
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async () => ({ requestId: 'req-edit-running' }),
    serviceOverrides: {
      suppressNextCompletionNotificationFor: () => { suppressionCount += 1; },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-edit-running', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-e1', interruptFirst: true });
  await settle();

  assert.deepEqual(
    calls.filter((call) => call.kind === 'request').map((call) => call.method),
    ['message.interrupt', 'session.truncateAfter', 'message.send'],
  );
  assert.equal(suppressionCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'EditResult');
  assert.equal(events[0]?.ok, true);
  runner.dispose();
});

test('EffectRunner EditRpc truncates then sends without interrupting an idle session', async () => {
  let suppressionCount = 0;
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async () => ({ requestId: 'req-edit-idle' }),
    serviceOverrides: {
      suppressNextCompletionNotificationFor: () => { suppressionCount += 1; },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-edit-idle', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-e2', interruptFirst: false });
  await settle();

  assert.deepEqual(
    calls.filter((call) => call.kind === 'request').map((call) => call.method),
    ['session.truncateAfter', 'message.send'],
  );
  assert.equal(suppressionCount, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'EditResult');
  assert.equal(events[0]?.ok, true);
  runner.dispose();
});

test('EffectRunner keeps an edit pending when only message.send acknowledgement times out', async () => {
  const timers = new FakeTimerSink();
  const { deps, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'message.send') throw new RequestTimeoutError('req-edit-delayed-ack');
      return {};
    },
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'EditRpc', corrId: 'c-edit-delayed-ack', sessionPath: '/a',
    messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-edit-delayed-ack',
    interruptFirst: false,
  });
  await settle();

  assert.equal(events.some((event) => event.kind === 'EditResult'), false);
  assert.equal(timers.size, 1);
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-edit-delayed-ack' });
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner retains edit ownership across a truncate waiter timeout, then sends only after the exact late acknowledgement', async () => {
  const requestCalls: Array<{ method: string; params: unknown }> = [];
  let acknowledgeTruncate!: () => void;
  const backend: BackendLike = {
    request<T>(method: string, params?: unknown, options?: CommitAwareRequestOptions<T>): Promise<T> {
      requestCalls.push({ method, params });
      if (method === 'session.truncateAfter') {
        acknowledgeTruncate = () => options?.onCorrelatedResponse?.({ ok: true, result: {} as T });
        return Promise.reject(new RequestTimeoutError('req-truncate-delayed'));
      }
      if (method === 'message.send') {
        return Promise.resolve({ requestId: 'replacement-turn' } as T);
      }
      return Promise.resolve({} as T);
    },
  };
  let sessionTail = Promise.resolve();
  const queues: EffectRunnerDeps['queues'] = {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async enqueueSessionOperation<T>(_sessionPath: string, task: () => Promise<T>): Promise<T> {
      const operation = sessionTail.then(task, task);
      sessionTail = operation.then(() => undefined, () => undefined);
      return await operation;
    },
  };
  const hostEvents: Event[] = [];
  const { deps, events } = makeEffectRunnerDeps({
    backend,
    queues,
    dispatchEvent: (event) => hostEvents.push(event),
  });
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'EditRpc', corrId: 'c-edit-truncate-delayed', sessionPath: '/a',
    messageId: 'old-user', text: 'replacement', inputs: [],
    composedText: 'replacement', localId: 'replacement-local', interruptFirst: false,
  });
  await settle();

  assert.deepEqual(requestCalls.map((call) => call.method), ['session.truncateAfter']);
  assert.equal(
    events.some((event) => event.kind === 'EditResult'),
    false,
    'the local timeout must not emit the rollback-owning EditResult failure',
  );
  assert.deepEqual(
    hostEvents.filter((event) => event.kind === 'EditTruncateRecoveryChanged')
      .map((event) => event.phase),
    ['recovering'],
  );

  // A user interrupt is admitted immediately but must remain behind the edit's
  // queue ownership while the destructive acknowledgement is ambiguous.
  runner.run({ kind: 'InterruptRpc', corrId: 'c-interrupt-after-edit', sessionPath: '/a' });
  await settle();
  assert.deepEqual(requestCalls.map((call) => call.method), ['session.truncateAfter']);

  acknowledgeTruncate();
  await settle();

  assert.deepEqual(
    requestCalls.map((call) => call.method),
    ['session.truncateAfter', 'message.send', 'message.interrupt'],
  );
  assert.deepEqual(requestCalls[1], {
    method: 'message.send',
    params: {
      sessionPath: '/a',
      text: 'replacement',
      inputs: [],
      localId: 'replacement-local',
    },
  });
  const editResults = events.filter((event) => event.kind === 'EditResult');
  assert.equal(editResults.length, 1, 'the replacement receives one acknowledgement and is never rolled back');
  assert.equal(editResults[0]?.ok, true);
  assert.equal(editResults[0]?.requestId, 'replacement-turn');
  assert.deepEqual(
    hostEvents.filter((event) => event.kind === 'EditTruncateRecoveryChanged')
      .map((event) => event.phase),
    ['recovering', 'recovered'],
  );
  runner.dispose();
});

test('EffectRunner EditRpc stops after an interrupt failure and dispatches EditResult{ok:false}', async () => {
  let suppressionCount = 0;
  const { deps, calls, events } = makeEffectRunnerDeps({
    requestImpl: async (method) => {
      if (method === 'message.interrupt') throw new Error('interrupt failed');
      return { requestId: 'req-edit-failed' };
    },
    serviceOverrides: {
      suppressNextCompletionNotificationFor: () => { suppressionCount += 1; },
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-edit-interrupt-fail', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-e3', interruptFirst: true });
  await settle();

  assert.deepEqual(
    calls.filter((call) => call.kind === 'request').map((call) => call.method),
    ['message.interrupt'],
  );
  assert.equal(suppressionCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'EditResult');
  assert.equal(events[0]?.ok, false);
  if (events[0]?.kind === 'EditResult' && !events[0].ok) {
    assert.equal(events[0].error, 'interrupt failed');
  }
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
