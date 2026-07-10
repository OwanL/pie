import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, type EffectRunnerDeps, type TimerSink, type TimerHandle } from '../src/host/core/effect-runner';
import type { Effect } from '../src/host/core/effects';
import type { EffectResultEvent, CommandEvent, Event } from '../src/host/core/events';
import { makeEffectRunnerDeps } from './helpers/effect-runner-deps';

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

test('EffectRunner routes InterruptRpc through enqueueLifecycle → enqueueSessionOperation (double-wrap)', async () => {
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  const effect: Effect = { kind: 'InterruptRpc', corrId: 'c1', sessionPath: '/a' };
  runner.run(effect);
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'info' && c.message === 'effect.dispatch'),
  );

  // Expected order: outer lifecycle wrap, inner session wrap, then the RPC.
  assert.equal(callsSansEffectDispatch[0]?.kind, 'lifecycle');
  assert.deepEqual(callsSansEffectDispatch[1], { kind: 'session', sessionPath: '/a' });
  assert.deepEqual(callsSansEffectDispatch[2], {
    kind: 'request',
    method: 'message.interrupt',
    params: { sessionPath: '/a' },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'InterruptResult');
  assert.equal(events[0]?.corrId, 'c1');
  assert.equal(events[0]?.ok, true);
});

test('EffectRunner CreateSession issues session.create (with the pre-minted token) on the lifecycle queue and dispatches CreateSessionResult{ok:true}', async () => {
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
  // The runner only issues the backend session.create RPC, serialized on the
  // lifecycle queue, carrying that token.
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
  });
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'info' && c.message === 'effect.dispatch'),
  );

  assert.equal(callsSansEffectDispatch.some((c) => c.kind === 'lifecycle'), false);
  assert.deepEqual(callsSansEffectDispatch[0], {
    kind: 'persistTabs',
    openTabPaths: ['/a', '/b'],
    active: '/a',
    pinnedTabPaths: [],
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
    { kind: 'log', level: 'info', message: 'effect.dispatch' },
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
    (c) => !(c.kind === 'log' && c.level === 'info' && c.message === 'effect.dispatch'),
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
  const { deps, calls, events } = makeEffectRunnerDeps();
  const runner = new EffectRunner(deps);

  runner.run({
    kind: 'SetModelRpc',
    corrId: 'sm1',
    sessionPath: '/s',
    modelSettings: { defaultModel: 'image-model', defaultThinkingLevel: 'medium' },
  });
  await settle();

  const callsSansEffectDispatch = calls.filter(
    (c) => !(c.kind === 'log' && c.level === 'info' && c.message === 'effect.dispatch'),
  );

  // Serialized through the lifecycle queue (single-wrap, matching the old
  // service path), then the backend write.
  assert.equal(callsSansEffectDispatch[0]?.kind, 'lifecycle');
  const req = callsSansEffectDispatch.find((c) => c.kind === 'request');
  assert.deepEqual(req, { kind: 'request', method: 'settings.set', params: { sessionPath: '/s', defaultModel: 'image-model', defaultThinkingLevel: 'medium' } });
  // Effect-side concerns (host-local epoch + disk-persisting analytics).
  assert.deepEqual(callsSansEffectDispatch.find((c) => c.kind === 'bumpEpoch'), { kind: 'bumpEpoch', sessionPath: '/s' });
  assert.deepEqual(callsSansEffectDispatch.find((c) => c.kind === 'onModelConfigChanged'), { kind: 'onModelConfigChanged', sessionPath: '/s', modelId: 'image-model', thinkingLevel: 'medium' });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'SetModelResult');
  assert.equal(events[0]?.corrId, 'sm1');
  assert.equal(events[0]?.ok, true);
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

test('EffectRunner SendRpc passes the sessionPath to getSendTimerTimeoutMs so the budget can be sized per-provider (FP-C3)', async () => {
  // FP-C3: the send-timer budget getter now receives the sessionPath so the
  // production wiring can add the real per-provider queueWaitSeconds as
  // headroom. Verify the runner forwards the sessionPath (the getter is the
  // only seam; the extension-host's resolveQueueWaitHeadroomMs reads it).
  const timers = new FakeTimerSink();
  let capturedSessionPath: string | undefined;
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-fp3' }),
    getSendTimerTimeoutMs: (sessionPath: string) => {
      capturedSessionPath = sessionPath;
      return 60_000;
    },
    timer: timers,
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-fp3', sessionPath: '/fp3-session', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-fp3' });
  await settle();

  assert.equal(capturedSessionPath, '/fp3-session', 'getSendTimerTimeoutMs received the send sessionPath');
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

test('EffectRunner ReArmSendTimer re-arms the send-timer with the model-start budget (fire blames model-start, not pruning)', async () => {
  // Pruning succeeds → the reducer emits ReArmSendTimer. The send-timer (armed
  // with the tight prepass budget at send-dispatch) is cancelled and re-armed
  // with the generous model-start budget. A later fire carries the model-start
  // error string so the notice blames model-start (concurrency/rate-limit),
  // NOT pruning — pruning already finished.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-ms' }),
    sendTimerTimeoutMs: 50_000, // tight prepass budget (50s)
    modelStartTimerTimeoutMs: 90_000, // generous model-start budget (90s; small for test)
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-ms', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-ms' });
  await settle();
  assert.equal(timers.size, 1, 'prepass send-timer armed after early-ack');

  // Pruning succeeds → reducer would emit ReArmSendTimer; drive it directly.
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-ms' });
  assert.equal(timers.size, 1, 're-armed: old prepass timer cancelled, new model-start timer scheduled');

  // Fire the (re-armed) model-start timer.
  timers.runAll();
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    // model-start error string (NOT the prepass/turn string) → notice blames
    // model-start, not pruning.
    assert.match(pf.error, /Timed out waiting for the model to start streaming/);
    assert.ok(!/Timed out waiting for the turn to start streaming/.test(pf.error), 'not the prepass-timeout string');
    assert.match(pf.error, /90s/, 'model-start budget (90s), not the 50s prepass budget');
  }
  runner.dispose();
});

test('EffectRunner ReArmSendTimer is a no-op when no in-flight send exists (late re-arm after commit/fire)', () => {
  const timers = new FakeTimerSink();
  const { deps } = makeEffectRunnerDeps({ timer: timers });
  const runner = new EffectRunner(deps);
  // No send was dispatched → no in-flight entry. ReArmSendTimer must not throw
  // and must not schedule a timer.
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-none' });
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner ReArmSendTimer also covers the EDIT path (edit waiting for a slot does not false-positive as pruning)', async () => {
  // An edit arms the same post-ack send-timer (phase 'prepass'). When pruning
  // succeeds the reducer re-arms it with the model-start budget, so an edit
  // waiting for a concurrency slot does not trip a spurious prepass-timeout
  // ("Pruning took too long") either. The fire carries the model-start string;
  // the mapper then classifies it as edit-failed (opKind 'edit').
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-edit-ms' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'EditRpc', corrId: 'c-edit-ms', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-edit-ms' });
  await settle();
  assert.equal(timers.size, 1, 'edit send-timer armed after early-ack');

  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-edit-ms' });
  assert.equal(timers.size, 1, 'edit re-armed with the model-start budget');

  timers.runAll();
  const pf = dispatchedEvents[0];
  assert.equal(pf?.kind, 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    assert.match(pf.error, /Timed out waiting for the model to start streaming/);
    assert.match(pf.error, /90s/);
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

  runner.run({ kind: 'EditRpc', corrId: 'c-pf-edit', sessionPath: '/a', messageId: 'msg-1', text: 'edited', inputs: [], localId: 'loc-e1' });
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

// ─── FP-C2a: model-start send-timer metric-gated re-arm (false-positive guard) ──
// The model-start send-timer's clock starts at issue time, BEFORE the request
// acquires its ProviderGate concurrency slot. When the in-flight request's
// provider is legitimately QUEUED (`queuedRequests>0`) or PAUSED (circuit
// breaker), firing now would be a FALSE-POSITIVE PreflightFailed that rolls
// back the user's message even though the turn would succeed once a slot frees
// up. `onSendTimerFire`'s modelStart branch calls `shouldReArmModelStartTimer`
// which re-arms instead of firing, up to `MODEL_START_HARD_CEILING_MS` (a
// genuinely-stuck backstop). FAIL-OPEN: any missing dep/metric/provider, a
// non-queued/non-paused provider, or an elapsed ceiling falls through to fire.
// The gate is scoped to the modelStart phase ONLY — the prepass phase is NOT
// gated (a prepass fire is a genuine pruning timeout, not a queue wait).

// `MODEL_START_HARD_CEILING_MS` is a private static on EffectRunner, derived
// from the (also private) `MODEL_START_TIMER_TIMEOUT_MS = 600_000` static
// default — NOT from the injected `modelStartTimerTimeoutMs` override. Mirrored
// here as a local so the ceiling test advances the clock past it; if the
// source constant changes this must change in lock-step (lock-in intent).
const MODEL_START_HARD_CEILING_MS = 600_000 * 2; // = EffectRunner.MODEL_START_HARD_CEILING_MS

test('EffectRunner modelStart send-timer RE-ARMS when the provider has queuedRequests>0 and elapsed < ceiling (no false-positive PreflightFailed)', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-q' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 1, paused: false }],
    }),
    resolveSessionProvider: () => 'openai',
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-q', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-q' });
  await settle();
  // Pruning prepass succeeds → reducer emits ReArmSendTimer → modelStart phase.
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-q' });
  assert.equal(timers.size, 1, 'model-start timer armed after re-arm');

  // Fire the model-start timer: provider is queued + elapsed ~0 < ceiling →
  // RE-ARM (extend) instead of firing a false-positive PreflightFailed.
  timers.runAll();

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 0, 'no false-positive PreflightFailed while the provider is legitimately queued');
  assert.equal(timers.size, 1, 'timer re-armed (a fresh model-start timer scheduled)');
  runner.dispose();
});

test('EffectRunner modelStart send-timer RE-ARMS when the provider is paused (circuit breaker) and elapsed < ceiling', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-pause' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 0, paused: true }],
    }),
    resolveSessionProvider: () => 'openai',
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-pause', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-pause' });
  await settle();
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-pause' });

  timers.runAll();

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 0, 'no false-positive PreflightFailed while the provider is paused (circuit breaker)');
  assert.equal(timers.size, 1, 'timer re-armed (provider paused → defer)');
  runner.dispose();
});

test('EffectRunner modelStart send-timer FIRES (PreflightFailed) when the provider has a free slot (not queued, not paused) — genuinely stuck, not a queue wait', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-free' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 0, paused: false }],
    }),
    resolveSessionProvider: () => 'openai',
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-free', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-free' });
  await settle();
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-free' });

  timers.runAll();

  // Free slot → the wait is NOT a queue wait → the turn is genuinely stuck →
  // fire (don't mask a real hang behind a phantom queue).
  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'fires when the provider is neither queued nor paused');
  assert.equal(timers.size, 0, 'no re-arm (fired, existing behavior)');
  const pf = dispatchedEvents.find((e) => e.kind === 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    assert.equal(pf.corrId, 'c-free');
    assert.match(pf.error, /Timed out waiting for the model to start streaming/);
  }
  runner.dispose();
});

test('EffectRunner modelStart send-timer FAIL-OPEN: fires when getProviderGateMetrics is absent (never hangs on a missing gate)', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-nogate' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  // Neither gate accessor wired → fail-open (fire as today).
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-nogate', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-nogate' });
  await settle();
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-nogate' });

  timers.runAll();

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'fails open when the metrics accessor is absent');
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner modelStart send-timer FAIL-OPEN: fires when resolveSessionProvider returns undefined (provider unresolvable)', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-noprovider' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    // Metrics say the provider is saturated, but the in-flight request's
    // provider can't be resolved → can't match → fail-open.
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 5, paused: true }],
    }),
    resolveSessionProvider: () => undefined,
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-noprovider', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-noprovider' });
  await settle();
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-noprovider' });

  timers.runAll();

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'fails open when the provider cannot be resolved');
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner modelStart send-timer FAIL-OPEN: fires when no matching provider is present in the metrics', async () => {
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-nomatch' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    // The in-flight request routes to 'anthropic', but the metrics only know
    // 'openai' → no matching entry → fail-open.
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 9, paused: true }],
    }),
    resolveSessionProvider: () => 'anthropic',
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-nomatch', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-nomatch' });
  await settle();
  runner.run({ kind: 'ReArmSendTimer', corrId: 'c-nomatch' });

  timers.runAll();

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'fails open when no matching provider is present in the metrics');
  assert.equal(timers.size, 0);
  runner.dispose();
});

test('EffectRunner modelStart send-timer FIRES past the hard ceiling even when the provider is queued (genuinely-stuck backstop)', async () => {
  // A queue that never drains (deadlock) must still fire after the cumulative
  // ceiling — the metric-gated re-arm path cannot extend a genuinely-stuck
  // turn indefinitely. `modelStartFirstArmedAt` is captured (once) at re-arm
  // time, so we pin the clock there, then advance past the ceiling before
  // firing.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-stuck' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 1, paused: false }],
    }),
    resolveSessionProvider: () => 'openai',
  });

  const realNow = Date.now;
  const base = 1_700_000_000_000; // a plausible epoch-ms
  let now = base;
  Date.now = () => now;
  try {
    runner.run({ kind: 'SendRpc', corrId: 'c-stuck', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-stuck' });
    await settle();
    // Re-arm captures modelStartFirstArmedAt = Date.now() = base.
    runner.run({ kind: 'ReArmSendTimer', corrId: 'c-stuck' });

    // Advance the wall clock PAST the hard ceiling (1_200_000 ms).
    now = base + MODEL_START_HARD_CEILING_MS + 1;

    timers.runAll(); // fire → ceiling exceeded → shouldReArmModelStartTimer returns false → FIRE

    assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'fires past the hard ceiling even when the provider is still queued');
    assert.equal(timers.size, 0, 'no re-arm past the ceiling');
    const pf = dispatchedEvents.find((e) => e.kind === 'PreflightFailed');
    if (pf?.kind === 'PreflightFailed') {
      assert.equal(pf.corrId, 'c-stuck');
      assert.match(pf.error, /Timed out waiting for the model to start streaming/);
    }
  } finally {
    Date.now = realNow;
  }
  runner.dispose();
});

test('EffectRunner send-timer provider-gate re-arm is scoped to the modelStart phase (prepass phase is NOT gated — always fires)', async () => {
  // During the prepass phase (before ReArmSendTimer) the gate is NOT consulted
  // even when the provider is queued/paused AND the gate accessor is wired: a
  // prepass fire is a genuine pruning timeout, not a concurrency queue wait,
  // so it fires (existing behavior). Proves the gate is a modelStart-phase
  // concern only.
  const timers = new FakeTimerSink();
  const dispatchedEvents: Event[] = [];
  const { deps } = makeEffectRunnerDeps({
    requestImpl: () => Promise.resolve({ requestId: 'req-prepass' }),
    sendTimerTimeoutMs: 50_000,
    modelStartTimerTimeoutMs: 90_000,
    timer: timers,
  });
  const runner = new EffectRunner({
    ...deps,
    dispatchEvent: (e) => dispatchedEvents.push(e),
    getProviderGateMetrics: () => ({
      providers: [{ provider: 'openai', queuedRequests: 1, paused: true }],
    }),
    resolveSessionProvider: () => 'openai',
  });

  runner.run({ kind: 'SendRpc', corrId: 'c-prepass', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'loc-prepass' });
  await settle();
  // NO ReArmSendTimer → phase stays 'prepass' (the tight prepass budget).
  assert.equal(timers.size, 1, 'prepass send-timer armed after early-ack');

  timers.runAll(); // fire → phase !== 'modelStart' → gate check skipped → FIRE

  assert.equal(dispatchedEvents.filter((e) => e.kind === 'PreflightFailed').length, 1, 'prepass phase is NOT gated by provider metrics — fires even when the provider is queued/paused');
  assert.equal(timers.size, 0, 'no re-arm during the prepass phase');
  const pf = dispatchedEvents.find((e) => e.kind === 'PreflightFailed');
  if (pf?.kind === 'PreflightFailed') {
    // Prepass-phase fire string (the turn-start string, NOT the model-start string).
    assert.match(pf.error, /Timed out waiting for the turn to start streaming/);
  }
  runner.dispose();
});
