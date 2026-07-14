/**
 * Brief E — Edit / interrupt UX clunkiness.
 *
 * Interrupt responsiveness (Heuristic #3): on interrupt the runner calls
 * `abortInFlightSend(sessionPath)` (BEST-EFFORT pre-ack cancel of an in-flight
 * `message.send`/edit) AND enqueues `message.interrupt` (stream abort). Calling
 * both is safe in every phase:
 *  - Pre-ack (RPC in flight, e.g. slow prepass): the abort cancels the
 *    `AbortController` passed to `backend.request` → the RPC rejects →
 *    `SendResult`/`EditResult{ok:false}` (rollback via `pending.ops`) and the
 *    send-timer is cleared. `message.interrupt` then runs (the turn never
 *    started, so it is a harmless no-op / SESSION_NOT_RUNNING).
 *  - Post-commit (RPC early-acked, turn streaming): `abortInFlightSend` finds
 *    no in-flight send (cleared at the commit point) → returns false → no
 *    rollback. `message.interrupt` aborts the stream.
 *
 * Rapid multi-prompt: a second `message.send` while a turn is in-flight is
 * REJECTED by the backend's `REQUEST_IN_PROGRESS` guard (not queued). The
 * effect-runner surfaces it as `SendResult{ok:false}` (a send failure, not a
 * silent drop or a deferred-prompt queue).
 *
 * Uses a `FakeTimerSink` + `runner.dispose()` so no real 120s send-timers keep
 * the event loop alive (mirrors `arch-effect-runner.test.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EffectRunner, type EffectRunnerDeps, type TimerSink, type TimerHandle } from '../../../../src/host/core/effect-runner';
import type { EffectResultEvent } from '../../../../src/host/core/events';
import { makeEffectRunnerDeps } from '../../../helpers/effect-runner-deps';

/** Deterministic timer sink: records scheduled timers and never auto-fires
 *  them (only `runAll()` does). Eliminates real-timer waits. */
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
  get size(): number { return this.pending.length; }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Realistic FIFO queues: lifecycle + per-session operation queues are chained
 *  promise queues (mirrors `SessionServiceState`), so a second send's session-op
 *  runs only after the first's settles. */
function makeSerializingQueues(): EffectRunnerDeps['queues'] {
  let lifecycleQueue: Promise<void> = Promise.resolve();
  const sessionQueues = new Map<string, Promise<void>>();
  return {
    enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
      const next = lifecycleQueue.catch(() => undefined).then(task);
      lifecycleQueue = next.then(() => undefined, () => undefined);
      return next;
    },
    enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      const previous = sessionQueues.get(sessionPath) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(task);
      const barrier = result.then(() => undefined, () => undefined);
      sessionQueues.set(sessionPath, barrier);
      void barrier.finally(() => {
        if (sessionQueues.get(sessionPath) === barrier) {
          sessionQueues.delete(sessionPath);
        }
      });
      return result;
    },
  };
}

function findResult<K extends EffectResultEvent['kind']>(
  events: EffectResultEvent[],
  kind: K,
): Extract<EffectResultEvent, { kind: K }> | undefined {
  return events.find((e) => e.kind === kind) as Extract<EffectResultEvent, { kind: K }> | undefined;
}

// ─── (a) Pre-ack interrupt: abortInFlightSend cancels the send → SendResult{ok:false},
//        AND message.interrupt is dispatched. ────────────────────────────────────
test('Brief E (a): interrupt aborts an in-flight pre-ack message.send AND enqueues message.interrupt', async () => {
  const timers = new FakeTimerSink();
  const { deps, calls, events } = makeEffectRunnerDeps({
    timer: timers,
    // message.send hangs (slow prepass, pre-ack); message.interrupt resolves.
    requestImpl: async (method: string) => {
      if (method === 'message.send') return new Promise(() => {});
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  // Default (inline) queues call the session-op task synchronously, so
  // `startInFlightSend` arms the AbortController before this call returns.
  runner.run({ kind: 'SendRpc', corrId: 'c-send', sessionPath: '/s', text: 'hi', inputs: [], composedText: 'hi', localId: 'l1' });
  runner.run({ kind: 'InterruptRpc', corrId: 'c-int', sessionPath: '/s' });

  await settle();

  // The pre-ack send was cancelled → SendResult{ok:false} (pre-ack rollback).
  const sendResult = findResult(events, 'SendResult') as Extract<EffectResultEvent, { kind: 'SendResult' }> | undefined;
  assert.ok(sendResult, 'SendResult dispatched for the aborted send');
  assert.equal(sendResult.ok, false, 'pre-ack send is rolled back (ok:false)');
  assert.equal(sendResult.corrId, 'c-send');
  assert.match(sendResult.error ?? '', /cancel/i, 'error reflects the abort');

  // message.interrupt was ALSO dispatched (covers the post-commit streaming
  // case; here it is a harmless no-op since the turn never started).
  assert.ok(
    calls.some((c) => c.kind === 'request' && c.method === 'message.interrupt'),
    'message.interrupt is enqueued regardless of phase',
  );

  const intResult = findResult(events, 'InterruptResult');
  assert.ok(intResult && intResult.ok, 'message.interrupt resolved ok');

  // The send-timer was cleared by the pre-ack failure (no commit will come) —
  // nothing is left armed.
  assert.equal(timers.size, 0);

  runner.dispose();
});

// ─── (b) Post-commit interrupt: the send already early-acked + committed
//        (ClearSendTimer at the first MessageStarted). abortInFlightSend finds
//        no in-flight send (returns false → no rollback); message.interrupt
//        handles the streaming phase. ─────────────────────────────────────────
test('Brief E (b): interrupt on a streaming (post-commit) turn does not roll back the send; message.interrupt dispatched', async () => {
  const timers = new FakeTimerSink();
  const { deps, calls, events } = makeEffectRunnerDeps({
    timer: timers,
    requestImpl: async (method: string) => {
      if (method === 'message.send') return { requestId: 'r1' }; // early-ack
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c-send', sessionPath: '/s', text: 'hi', inputs: [], composedText: 'hi', localId: 'l1' });
  await settle(); // early-ack → SendResult{ok:true}; send-timer armed (in-flight).

  // Commit point: first MessageStarted → reducer emits ClearSendTimer → the
  // runner clears the in-flight send context (mirrors the real commit point).
  runner.run({ kind: 'ClearSendTimer', corrId: 'c-send' });

  // Now interrupt the streaming turn. No in-flight send remains to abort.
  runner.run({ kind: 'InterruptRpc', corrId: 'c-int', sessionPath: '/s' });
  await settle();

  // The send early-acked ok:true and was NOT rolled back (no second SendResult).
  const sendResults = events.filter((e) => e.kind === 'SendResult') as Extract<EffectResultEvent, { kind: 'SendResult' }>[];
  assert.equal(sendResults.length, 1, 'exactly one SendResult (the early-ack ok:true)');
  assert.equal(sendResults[0]!.ok, true);
  assert.equal(sendResults[0]!.requestId, 'r1');

  // message.interrupt dispatched (handles the streaming phase).
  assert.ok(
    calls.some((c) => c.kind === 'request' && c.method === 'message.interrupt'),
    'message.interrupt dispatched for the streaming turn',
  );
  const intResult = findResult(events, 'InterruptResult');
  assert.ok(intResult && intResult.ok);

  runner.dispose();
});

// ─── (c) Rapid multi-prompt: a second send while a turn is in-flight is now
//        QUEUED as a steering injection — the backend acks { queued: true }
//        instead of rejecting with REQUEST_IN_PROGRESS. The effect-runner
//        surfaces it as SendResult{ok:true, queued:true}, clears the send-timer
//        (a queued send has no commit point), and emits no requestId.
//        STATE_CONTRACT "Execution Ordering" still holds (serialization, not
//        deferral — the second send runs after the first settles in the
//        per-session queue). ────────────────────────────────────────────────
test('Brief E (c): a second send while a turn is in-flight is queued as a steering injection', async () => {
  const timers = new FakeTimerSink();
  let sendCount = 0;
  const { deps, events } = makeEffectRunnerDeps({
    timer: timers,
    queues: makeSerializingQueues(),
    // First message.send early-acks with a requestId; the second acks
    // { queued: true } (the backend queued it as a steering injection).
    requestImpl: async (method: string) => {
      if (method === 'message.send') {
        sendCount += 1;
        if (sendCount === 1) return { requestId: 'r1' };
        return { queued: true };
      }
      return {};
    },
  });
  const runner = new EffectRunner(deps);

  runner.run({ kind: 'SendRpc', corrId: 'c1', sessionPath: '/s', text: 'first', inputs: [], composedText: 'hi', localId: 'l1' });
  runner.run({ kind: 'SendRpc', corrId: 'c2', sessionPath: '/s', text: 'second', inputs: [], composedText: 'hi', localId: 'l2' });
  await settle();

  const sendResults = events.filter((e) => e.kind === 'SendResult') as Extract<EffectResultEvent, { kind: 'SendResult' }>[];
  assert.equal(sendResults.length, 2, 'both sends settle (neither is silently dropped)');

  const r1 = sendResults.find((e) => e.corrId === 'c1');
  const r2 = sendResults.find((e) => e.corrId === 'c2');
  assert.ok(r1 && r1.ok && r1.requestId === 'r1', 'first send early-acked ok:true with requestId');
  assert.ok(r2 && r2.ok && r2.queued === true, 'second send is QUEUED (ok:true, queued:true), not rejected');
  assert.ok(!r2!.requestId, 'queued send has no requestId (no turn is started by the enqueue)');

  runner.dispose();
});
