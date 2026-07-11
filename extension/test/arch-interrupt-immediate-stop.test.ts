/**
 * Immediate-stop interrupt (host-side). Verifies that dispatching an `Interrupt`
 * Command takes effect INSTANTLY in the reducer (Copilot/Codex-style): the
 * currently-streaming assistant message is marked `interrupted`,
 * `runningSessionPaths` remains set until the abort completion barrier,
 * `interruptInFlightBySession` is set, and an
 * `InterruptRpc` effect is emitted — without waiting for the async
 * `session.abort()` to settle. Late streaming events (`MessageDelta`/
 * `MessageThinking`) arriving during the in-flight abort window are dropped as
 * no-ops, and `InterruptResult{ok:true}` clears the flag (idempotent with the
 * optimistic writes). A late `MessageFinished` self-corrects the optimistic
 * `interrupted` to `completed`.
 *
 * The SDK/subagent cascade (parent abort → child aborts) is already covered by
 * `extensions/subagent/test/interrupt-hardening.test.ts`; this file owns the
 * host-side optimistic gap that makes the user SEE the interrupt immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../src/host/core/arch-state';
import { reducer } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import type { ChatMessage } from '../src/shared/protocol';

const SESSION = '/s1';
const MSG_ID = 'a1';

/** Seed a session with a streaming assistant message, in `runningSessionPaths`,
 *  with `interruptInFlightBySession` false (the pre-Stop state). */
function withStreamingAssistant(state: ArchState): ArchState {
  return produce(state, (draft) => {
    draft.transcript.bySession[SESSION] = [
      {
        id: `${MSG_ID}:user`,
        role: 'user',
        createdAt: '2026-07-08T10:00:00.000Z',
        markdown: 'do the thing',
        status: 'completed',
      },
      {
        id: MSG_ID,
        role: 'assistant',
        createdAt: '2026-07-08T10:00:01.000Z',
        markdown: 'streaming…',
        parts: [],
        status: 'streaming',
      } satisfies ChatMessage,
    ];
    draft.sessions.runningSessionPaths = Array.from(
      new Set([...draft.sessions.runningSessionPaths, SESSION]),
    );
    // Explicitly false / absent: no abort in flight before Stop.
    draft.sessions.interruptInFlightBySession[SESSION] = false;
  });
}

function assistant(state: ArchState): ChatMessage {
  const list = state.transcript.bySession[SESSION]!;
  return list.find((m) => m.id === MSG_ID)!;
}

test('Interrupt instantly marks the streaming message interrupted, keeps running until acknowledgement, sets the flag, emits InterruptRpc, and drops late deltas', () => {
  const initial = withStreamingAssistant(createInitialArchState());

  // Sanity: pre-Stop state.
  assert.equal(assistant(initial).status, 'streaming');
  assert.ok(initial.sessions.runningSessionPaths.includes(SESSION));
  assert.equal(initial.sessions.interruptInFlightBySession[SESSION], false);

  const r1 = reducer(initial, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c-int', sessionPath: SESSION },
  } as Event);
  const state = r1.state;

  // (a) streaming message → interrupted.
  assert.equal(assistant(state).status, 'interrupted', 'streaming message marked interrupted');
  // (b) running remains truthful until the backend abort settles. This keeps
  // the composer in Stopping… and prevents stop→send from becoming follow-up.
  assert.ok(state.sessions.runningSessionPaths.includes(SESSION), 'running retained during stop');
  // (c) flag set.
  assert.equal(state.sessions.interruptInFlightBySession[SESSION], true, 'flag set');
  // (d) InterruptRpc effect emitted.
  assert.equal(r1.effects.length, 1);
  assert.deepEqual(r1.effects[0], { kind: 'InterruptRpc', corrId: 'c-int', sessionPath: SESSION });

  // Late delta during the abort window is dropped (text unchanged).
  const markdownBefore = assistant(state).markdown;
  const r2 = reducer(state, {
    kind: 'MessageDelta',
    sessionPath: SESSION,
    messageId: MSG_ID,
    delta: 'LATE OUTPUT AFTER STOP',
  } as Event);
  assert.equal(r2.state, state, 'delta is a pure no-op (returns same state reference)');
  assert.equal(
    assistant(r2.state).markdown,
    markdownBefore,
    'late delta does not append while abort is in flight',
  );

  // InterruptResult{ok:true} clears the flag; running stays clear.
  const r3 = reducer(r2.state, {
    kind: 'InterruptResult',
    corrId: 'c-int',
    sessionPath: SESSION,
    ok: true,
  } as Event);
  assert.equal(r3.state.sessions.interruptInFlightBySession[SESSION], false, 'flag cleared');
  assert.ok(
    !r3.state.sessions.runningSessionPaths.includes(SESSION),
    'running stays clear after ok result',
  );
  // The message remains interrupted (the turn was aborted, not completed).
  assert.equal(assistant(r3.state).status, 'interrupted');
});

test('MessageThinking is also dropped during the in-flight abort window', () => {
  const initial = withStreamingAssistant(createInitialArchState());

  const r1 = reducer(initial, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c-int', sessionPath: SESSION },
  } as Event);
  assert.equal(r1.state.sessions.interruptInFlightBySession[SESSION], true);

  // Late thinking delta during the abort window is dropped (reasoning unchanged).
  const thinkingBefore = assistant(r1.state).thinking;
  const r2 = reducer(r1.state, {
    kind: 'MessageThinking',
    sessionPath: SESSION,
    messageId: MSG_ID,
    thinking: 'late reasoning after stop',
  } as Event);
  assert.equal(r2.state, r1.state, 'thinking delta is a pure no-op (same state reference)');
  assert.equal(assistant(r2.state).thinking, thinkingBefore, 'late thinking not appended');
});

test('A late MessageFinished self-corrects the optimistic interrupted status to completed', () => {
  const initial = withStreamingAssistant(createInitialArchState());

  // Stop → optimistic interrupted.
  const r1 = reducer(initial, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c-int', sessionPath: SESSION },
  } as Event);
  assert.equal(assistant(r1.state).status, 'interrupted');
  // The flag is still in flight when the turn actually finishes.
  assert.equal(r1.state.sessions.interruptInFlightBySession[SESSION], true);

  // The turn finished normally (race: finished between click and abort) →
  // MessageFinished is NOT gated and overwrites the message to completed.
  const r2 = reducer(r1.state, {
    kind: 'MessageFinished',
    sessionPath: SESSION,
    message: {
      id: MSG_ID,
      role: 'assistant',
      createdAt: '2026-07-08T10:00:01.000Z',
      markdown: 'final reply',
      parts: [],
      status: 'completed',
    } satisfies ChatMessage,
  } as Event);
  assert.equal(assistant(r2.state).status, 'completed', 'optimistic interrupted self-corrects to completed');
});

test('Interrupt clears an in-flight prepass chip', () => {
  const initial = produce(withStreamingAssistant(createInitialArchState()), (draft) => {
    draft.pending.prepassBySession[SESSION] = { phase: 'running', latencyMs: null };
  });
  assert.ok(initial.pending.prepassBySession[SESSION]);

  const r1 = reducer(initial, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c-int', sessionPath: SESSION },
  } as Event);

  assert.equal(
    r1.state.pending.prepassBySession[SESSION],
    undefined,
    'prepass chip cleared (idle) on Stop',
  );
});
