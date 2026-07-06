/**
 * Phase 3 integration test — verifies that `interrupt` routed through the new
 * CQRS spine serializes correctly with other RPC effects through the
 * double-wrap lifecycle + session-operation queues.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, type EffectRunnerDeps, type TimerSink } from '../src/host/core/effect-runner';
import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Effect } from '../src/host/core/effects';
import type { Event, EffectResultEvent } from '../src/host/core/events';
import { makeEffectRunnerDeps } from './helpers/effect-runner-deps';

/** No-op timer sink: schedules nothing (no real wall-clock timer) so the
 *  send-timer (Brief B, default 120s) never keeps the test process alive.
 *  These integration tests assert serialization ordering, not send-timer
 *  firing — so never firing is correct. */
const noopTimerSink: TimerSink = {
  schedule: () => ({}),
  cancel: () => {},
};

/**
 * Build a harness that serializes lifecycle tasks the same way `SessionServiceState`
 * does (chained promise queue) to validate FIFO ordering.
 */
function makeSerializingDeps(): {
  deps: EffectRunnerDeps;
  executionOrder: string[];
  events: EffectResultEvent[];
  suppressCalls: string[];
} {
  const executionOrder: string[] = [];
  const events: EffectResultEvent[] = [];
  const suppressCalls: string[] = [];

  // Mimic the real lifecycle and session-operation queues from SessionServiceState.
  let lifecycleQueue: Promise<void> = Promise.resolve();
  const sessionQueues = new Map<string, Promise<void>>();

  const { deps } = makeEffectRunnerDeps({
    requestImpl: async (method: string) => {
      // Record execution order by method name.
      executionOrder.push(method);
      // Simulate a small async delay to make ordering meaningful.
      await new Promise<void>((r) => setImmediate(r));
      return {};
    },
    queues: {
      enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
        const next = lifecycleQueue.catch(() => undefined).then(task);
        lifecycleQueue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
        const previous = sessionQueues.get(sessionPath) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(task);
        const barrier = result.then(
          () => undefined,
          () => undefined,
        );
        sessionQueues.set(sessionPath, barrier);
        void barrier.finally(() => {
          if (sessionQueues.get(sessionPath) === barrier) {
            sessionQueues.delete(sessionPath);
          }
        });
        return result;
      },
    },
    serviceOverrides: {
      suppressNextCompletionNotificationFor(sessionPath: string) {
        suppressCalls.push(sessionPath);
      },
    },
    dispatch: (e) => events.push(e),
    timer: noopTimerSink,
  });

  return { deps, executionOrder, events, suppressCalls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

test('serialization: SendRpc queued before InterruptRpc executes send first (FIFO)', async () => {
  const { deps, executionOrder, events } = makeSerializingDeps();
  const runner = new EffectRunner(deps);

  // Queue send, then immediately queue interrupt for the same session.
  const sendEffect: Effect = { kind: 'SendRpc', corrId: 'c-send', sessionPath: '/a', text: 'hi', inputs: [], composedText: 'hi', localId: 'local-1' };
  const interruptEffect: Effect = { kind: 'InterruptRpc', corrId: 'c-int', sessionPath: '/a' };

  runner.run(sendEffect);
  runner.run(interruptEffect);

  await settle();

  // Send must execute before interrupt because the lifecycle queue is FIFO.
  assert.equal(executionOrder[0], 'message.send', 'send must execute first');
  assert.equal(executionOrder[1], 'message.interrupt', 'interrupt must execute second');

  // Both results dispatched.
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, 'SendResult');
  assert.equal(events[1]?.kind, 'InterruptResult');
});

test('serialization: interrupt does not race ahead of a preceding send on the same session', async () => {
  const { deps, executionOrder } = makeSerializingDeps();
  const runner = new EffectRunner(deps);

  // Simulate the real scenario: reducer returns SendRpc from a Send command,
  // then InterruptRpc from an Interrupt command issued immediately after.
  runner.run({ kind: 'SendRpc', corrId: 'c1', sessionPath: '/s', text: 'msg', inputs: [], composedText: 'hi', localId: 'local-2' });
  runner.run({ kind: 'InterruptRpc', corrId: 'c2', sessionPath: '/s' });

  await settle();

  const sendIdx = executionOrder.indexOf('message.send');
  const intIdx = executionOrder.indexOf('message.interrupt');
  assert.ok(sendIdx < intIdx, `send (idx=${sendIdx}) must precede interrupt (idx=${intIdx})`);
});

test('end-to-end: interrupt command through reducer produces effect and result clears state', async () => {
  const { deps, events } = makeSerializingDeps();
  const runner = new EffectRunner(deps);

  // Step 1: dispatch Interrupt command to reducer.
  let state: ArchState = initialArchState;
  const interruptCmd: Event = {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c-e2e', sessionPath: '/x' },
  };

  const r1 = reducer(state, interruptCmd);
  state = r1.state;

  assert.equal(state.sessions.interruptInFlightBySession['/x'], true);
  assert.equal(r1.effects.length, 1);
  assert.equal(r1.effects[0]?.kind, 'InterruptRpc');

  // Step 2: execute the effect.
  for (const effect of r1.effects) runner.run(effect);
  await settle();

  // Step 3: result event arrives — feed it back to reducer.
  assert.equal(events.length, 1);
  const resultEvent = events[0]! as Event;
  const r2 = reducer(state, resultEvent);
  state = r2.state;

  assert.equal(state.sessions.interruptInFlightBySession['/x'], false);
  // Successful interrupt sets running=false directly in state.
  assert.ok(!state.sessions.runningSessionPaths.includes('/x'), 'running should be cleared by watchdog');
  // No SyncEffects — running state is mutated directly.
  assert.equal(r2.effects.length, 0);
});

test('interrupt: InterruptRpc suppresses the next completion notification for the session (flag set in the runner)', async () => {
  const { deps, suppressCalls } = makeSerializingDeps();
  const runner = new EffectRunner(deps);

  // The runner is the side-effect executor, so the host-local completion-
  // suppression flag is set here (synchronously, same tick as the click),
  // preserving the eager-set behavior the router previously performed inline.
  // The reducer never owns this flag.
  runner.run({ kind: 'InterruptRpc', corrId: 'c-sup', sessionPath: '/s' });
  assert.deepEqual(suppressCalls, ['/s']);

  await settle();
  assert.deepEqual(suppressCalls, ['/s'], 'flag set exactly once, synchronously');
});

test('interrupt: non-interrupt RPCs do not set the completion-suppression flag', async () => {
  const { deps, suppressCalls } = makeSerializingDeps();
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-send', sessionPath: '/s', text: 'hi', inputs: [], composedText: 'hi', localId: 'local-3' });
  await settle();

  assert.deepEqual(suppressCalls, [], 'only InterruptRpc sets the suppress flag');
});
