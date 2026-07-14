/**
 * Phase 3 chunk 2 — collapsing `QueueManager.backendReadyQueue` + watchdog into
 * ArchState/runner.
 *
 * The reducer owns the backend-ready queue (`pending.backendReadyQueueBySession`).
 * When a `Send` Command targets a non-pending session and `!backendReady`, the
 * reducer queues the entry + inserts the optimistic message + clears the draft +
 * emits `StartBackendReadyWatchdog` — but does NOT emit `SendRpc` or mark running.
 * When `BackendReadyChanged{ready:true}` fires, the reducer emits
 * `DrainBackendReadyQueue` + `CancelBackendReadyWatchdog`; the runner re-dispatches
 * each entry as a `Send` Command (normal path) + clears the timer. If the watchdog
 * fires (30s timeout), the runner dispatches `BackendReadyWatchdogFired` → the
 * reducer drops the queue + removes optimistic messages + sets a notice.
 * `SessionScopeCleared` clears the queue for the closed session + cancels the
 * watchdog if the queue is now empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { Effect } from '../../../../src/host/core/effects';
import type { SessionSummary } from '../../../../src/shared/protocol';

const SESSION = '/workspace/session.jsonl';
const SESSION_B = '/workspace/other.jsonl';

function summary(path: string, name = 'Test'): SessionSummary {
  return { path, name, cwd: '/workspace', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0, isPlaceholder: false };
}

function notReadyState(overrides: Partial<ArchState> = {}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION)],
      openTabPaths: [SESSION],
    },
    settings: { ...initialArchState.settings, backendReady: false },
    ...overrides,
  };
}

function sendCmd(corrId: string, sessionPath: string, text = 'hello'): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'Send', corrId, sessionPath, text,
      inputs: [], composedText: text, localId: `local:${corrId}`,
      userParts: undefined, previousSummary: null, timestamp: 1000,
    },
  };
}

function backendReadyChanged(ready: boolean): Event {
  return { kind: 'BackendReadyChanged', ready };
}

function watchdogFired(): Event {
  return { kind: 'BackendReadyWatchdogFired' };
}

function sessionScopeCleared(sessionPath: string, removeSessionSummary = false): Event {
  return { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary };
}

// ─── Send Command: !backendReady → queue, no SendRpc, StartWatchdog ──────────

test('Send when !backendReady: inserts optimistic message, queues entry, clears draft, no SendRpc, emits StartBackendReadyWatchdog', () => {
  const out = reducer(notReadyState(), sendCmd('c1', SESSION));

  // No SendRpc — queued, not sent to backend.
  const rpcEffects = out.effects.filter((e) => e.kind === 'SendRpc');
  assert.equal(rpcEffects.length, 0);

  // StartBackendReadyWatchdog emitted.
  const watchdogEffect = out.effects.find((e) => e.kind === 'StartBackendReadyWatchdog');
  assert.ok(watchdogEffect, 'StartBackendReadyWatchdog should be emitted');

  // Optimistic message inserted.
  assert.equal(out.state.transcript.bySession[SESSION]?.length, 1);
  assert.equal(out.state.transcript.bySession[SESSION]?.[0]?.id, 'local:c1');

  // Queued in backendReadyQueueBySession.
  const queue = out.state.pending.backendReadyQueueBySession[SESSION];
  assert.equal(queue?.length, 1);
  assert.equal(queue?.[0]?.corrId, 'c1');
  assert.equal(queue?.[0]?.sessionPath, SESSION);

  // Draft cleared.
  assert.equal(out.state.composer.draftTextBySession[SESSION], undefined);

  // NOT marked running, no pending.ops.
  assert.equal(out.state.sessions.runningSessionPaths.includes(SESSION), false);
  assert.equal(out.state.pending.ops['c1'], undefined);
});

test('Send when !backendReady: previousSummary is null in queue entry', () => {
  const state = notReadyState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION)],
      openTabPaths: [SESSION],
    },
  });
  const out = reducer(state, sendCmd('c1', SESSION));
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION]?.[0]?.previousSummary, null);
});

test('Send when !backendReady: multiple sends queue in order, each emits StartWatchdog', () => {
  let state = notReadyState();
  let out = reducer(state, sendCmd('c1', SESSION));
  state = out.state;
  assert.equal(out.effects.filter((e) => e.kind === 'StartBackendReadyWatchdog').length, 1);

  out = reducer(state, sendCmd('c2', SESSION));
  state = out.state;
  // Second send also emits StartWatchdog (runner no-ops if already running).
  assert.equal(out.effects.filter((e) => e.kind === 'StartBackendReadyWatchdog').length, 1);

  const queue = state.pending.backendReadyQueueBySession[SESSION];
  assert.equal(queue?.length, 2);
  assert.equal(queue?.[0]?.text, 'hello');
  assert.equal(queue?.[1]?.text, 'hello');
});

test('Send when backendReady: normal path (no queue, SendRpc emitted)', () => {
  const state: ArchState = {
    ...notReadyState(),
    settings: { ...initialArchState.settings, backendReady: true },
  };
  const out = reducer(state, sendCmd('c1', SESSION));

  assert.equal(out.effects[0]?.kind, 'SendRpc');
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION], undefined);
  assert.equal(out.state.sessions.runningSessionPaths.includes(SESSION), true);
});

// ─── BackendReadyChanged: drain the queue ────────────────────────────────────

test('BackendReadyChanged{ready:true} with queued sends: emits DrainBackendReadyQueue + CancelBackendReadyWatchdog, clears queue', () => {
  const state = notReadyState({
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [
          { sessionPath: SESSION, corrId: 'c1', text: 'first', inputs: [], composedText: 'first', localId: 'local:c1', previousSummary: null, timestamp: 1000 },
          { sessionPath: SESSION, corrId: 'c2', text: 'second', inputs: [], composedText: 'second', localId: 'local:c2', previousSummary: null, timestamp: 2000 },
        ],
      },
    },
  });

  const out = reducer(state, backendReadyChanged(true));

  // Queue cleared.
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION], undefined);
  assert.equal(Object.keys(out.state.pending.backendReadyQueueBySession).length, 0);

  // backendReady set to true.
  assert.equal(out.state.settings.backendReady, true);

  // Two effects: DrainBackendReadyQueue + CancelBackendReadyWatchdog.
  assert.equal(out.effects.length, 2);
  const drainEffect = out.effects.find((e) => e.kind === 'DrainBackendReadyQueue') as Extract<Effect, { kind: 'DrainBackendReadyQueue' }>;
  assert.ok(drainEffect);
  assert.equal(drainEffect.entries.length, 2);
  assert.equal(drainEffect.entries[0]?.corrId, 'c1');
  assert.equal(drainEffect.entries[1]?.corrId, 'c2');

  const cancelEffect = out.effects.find((e) => e.kind === 'CancelBackendReadyWatchdog');
  assert.ok(cancelEffect);
});

test('BackendReadyChanged{ready:true} with empty queue: no effects', () => {
  const state = notReadyState();
  const out = reducer(state, backendReadyChanged(true));

  assert.equal(out.state.settings.backendReady, true);
  assert.deepEqual(out.effects, []);
});

test('BackendReadyChanged{ready:true} with entries across multiple sessions: drains all', () => {
  const state = notReadyState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION), summary(SESSION_B)],
      openTabPaths: [SESSION, SESSION_B],
    },
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [{ sessionPath: SESSION, corrId: 'c1', text: 'a', inputs: [], composedText: 'a', localId: 'l1', previousSummary: null, timestamp: 1000 }],
        [SESSION_B]: [{ sessionPath: SESSION_B, corrId: 'c2', text: 'b', inputs: [], composedText: 'b', localId: 'l2', previousSummary: null, timestamp: 2000 }],
      },
    },
  });

  const out = reducer(state, backendReadyChanged(true));

  const drainEffect = out.effects.find((e) => e.kind === 'DrainBackendReadyQueue') as Extract<Effect, { kind: 'DrainBackendReadyQueue' }>;
  assert.equal(drainEffect.entries.length, 2);
  assert.equal(drainEffect.entries[0]?.sessionPath, SESSION);
  assert.equal(drainEffect.entries[1]?.sessionPath, SESSION_B);
});

test('BackendReadyChanged{ready:false}: just sets backendReady=false, no effects', () => {
  const state: ArchState = {
    ...notReadyState(),
    settings: { ...initialArchState.settings, backendReady: true },
  };
  const out = reducer(state, backendReadyChanged(false));

  assert.equal(out.state.settings.backendReady, false);
  assert.deepEqual(out.effects, []);
});

// ─── BackendReadyWatchdogFired: drop queued messages ─────────────────────────

test('BackendReadyWatchdogFired: removes optimistic messages, clears queue, sets notice', () => {
  const state = notReadyState({
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [{ sessionPath: SESSION, corrId: 'c1', text: 'hello', inputs: [], composedText: 'hello', localId: 'local:c1', previousSummary: null, timestamp: 1000 }],
      },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        [SESSION]: [{ id: 'local:c1', role: 'user', createdAt: '2024-01-01T00:00:00.000Z', markdown: 'hello', status: 'completed' }],
      },
    },
  });

  const out = reducer(state, watchdogFired());

  // Queue cleared.
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION], undefined);

  // Optimistic message removed.
  assert.equal(out.state.transcript.bySession[SESSION]?.length ?? 0, 0);

  // Notice set.
  assert.ok(out.state.settings.notice);
  assert.ok(out.state.settings.notice!.includes('Backend did not become ready'));
  assert.ok(out.state.settings.notice!.includes('1 queued message'));
});

test('BackendReadyWatchdogFired: with empty queue is a no-op', () => {
  const state = notReadyState();
  const out = reducer(state, watchdogFired());

  assert.deepEqual(out.effects, []);
  assert.equal(out.state.settings.notice, null);
});

test('BackendReadyWatchdogFired: pluralizes "messages" for multiple entries', () => {
  const state = notReadyState({
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [
          { sessionPath: SESSION, corrId: 'c1', text: 'a', inputs: [], composedText: 'a', localId: 'l1', previousSummary: null, timestamp: 1000 },
          { sessionPath: SESSION, corrId: 'c2', text: 'b', inputs: [], composedText: 'b', localId: 'l2', previousSummary: null, timestamp: 2000 },
        ],
      },
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        [SESSION]: [
          { id: 'l1', role: 'user', createdAt: '2024-01-01T00:00:00.000Z', markdown: 'a', status: 'completed' },
          { id: 'l2', role: 'user', createdAt: '2024-01-01T00:00:00.000Z', markdown: 'b', status: 'completed' },
        ],
      },
    },
  });

  const out = reducer(state, watchdogFired());
  assert.ok(out.state.settings.notice!.includes('2 queued messages'));
});

// ─── SessionScopeCleared: clears the queue + cancels watchdog if empty ───────

test('SessionScopeCleared: clears backendReadyQueueBySession for the closed session', () => {
  const state = notReadyState({
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [{ sessionPath: SESSION, corrId: 'c1', text: 'a', inputs: [], composedText: 'a', localId: 'l1', previousSummary: null, timestamp: 1000 }],
      },
    },
  });

  const out = reducer(state, sessionScopeCleared(SESSION, true));

  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION], undefined);
  // Watchdog cancelled (queue is now empty).
  assert.equal(out.effects[0]?.kind, 'CancelBackendReadyWatchdog');
});

test('SessionScopeCleared: preserves backendReadyQueue for other sessions, no CancelWatchdog', () => {
  const state = notReadyState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION), summary(SESSION_B)],
      openTabPaths: [SESSION, SESSION_B],
    },
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION]: [{ sessionPath: SESSION, corrId: 'c1', text: 'a', inputs: [], composedText: 'a', localId: 'l1', previousSummary: null, timestamp: 1000 }],
        [SESSION_B]: [{ sessionPath: SESSION_B, corrId: 'c2', text: 'b', inputs: [], composedText: 'b', localId: 'l2', previousSummary: null, timestamp: 2000 }],
      },
    },
  });

  const out = reducer(state, sessionScopeCleared(SESSION, true));

  // SESSION cleared, SESSION_B preserved.
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION], undefined);
  assert.equal(out.state.pending.backendReadyQueueBySession[SESSION_B]?.length, 1);

  // No CancelWatchdog — other sessions still have entries.
  assert.deepEqual(out.effects, []);
});

test('SessionScopeCleared: no CancelWatchdog when session had no entries', () => {
  const state = notReadyState({
    pending: {
      ...initialArchState.pending,
      backendReadyQueueBySession: {
        [SESSION_B]: [{ sessionPath: SESSION_B, corrId: 'c2', text: 'b', inputs: [], composedText: 'b', localId: 'l2', previousSummary: null, timestamp: 2000 }],
      },
    },
  });

  const out = reducer(state, sessionScopeCleared(SESSION, true));

  // No CancelWatchdog — the closed session had no entries.
  assert.deepEqual(out.effects, []);
});

// ─── E2E: send when !backendReady → backend ready → drain → send goes through ─

test('E2E: send when !backendReady → BackendReadyChanged{ready:true} drains → re-dispatched Send goes through normal path', () => {
  // Step 1: Send when !backendReady → queued.
  let state = notReadyState();
  const sendResult = reducer(state, sendCmd('c1', SESSION));
  state = sendResult.state;
  assert.equal(sendResult.effects.filter((e) => e.kind === 'SendRpc').length, 0);
  assert.equal(state.pending.backendReadyQueueBySession[SESSION]?.length, 1);

  // Step 2: BackendReadyChanged{ready:true} → drain.
  const readyResult = reducer(state, backendReadyChanged(true));
  state = readyResult.state;
  assert.equal(state.pending.backendReadyQueueBySession[SESSION], undefined);
  assert.equal(state.settings.backendReady, true);

  const drainEffect = readyResult.effects.find((e) => e.kind === 'DrainBackendReadyQueue') as Extract<Effect, { kind: 'DrainBackendReadyQueue' }>;
  assert.ok(drainEffect);
  assert.equal(drainEffect.entries.length, 1);

  // Step 3: Runner re-dispatches the entry as a Send Command (simulated).
  const entry = drainEffect.entries[0]!;
  const reDispatched: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: entry.corrId,
      sessionPath: entry.sessionPath,
      text: entry.text,
      inputs: entry.inputs,
      composedText: entry.composedText,
      localId: entry.localId,
      userParts: entry.userParts,
      previousSummary: entry.previousSummary,
      timestamp: entry.timestamp,
    },
  };

  const reDispatchResult = reducer(state, reDispatched);

  // Normal path: SendRpc emitted, session running, pending.ops set.
  assert.equal(reDispatchResult.effects[0]?.kind, 'SendRpc');
  assert.equal(reDispatchResult.state.sessions.runningSessionPaths.includes(SESSION), true);
  assert.equal(reDispatchResult.state.pending.ops['c1']?.kind, 'send');
});
