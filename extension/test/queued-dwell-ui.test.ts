import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import type { Event } from '../src/host/core/events';
import { selectViewState } from '../src/host/core/projection';
import { QUEUED_DWELL_HARD_MS } from '../src/shared/queued-dwell';
import { validateWebviewToHostMessage } from '../src/shared/protocol-validation';
import type { SessionSummary, QueuedDwellEntry } from '../src/shared/protocol';

const SESSION = '/workspace/session.jsonl';

function summary(path: string, name = 'Test'): SessionSummary {
  return {
    path,
    name,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: false,
  };
}

function stateWithDwell(entries: QueuedDwellEntry[]): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [summary(SESSION)],
      openTabPaths: [SESSION],
      activeSessionPath: SESSION,
      runningSessionPaths: [SESSION],
    },
    settings: { ...initialArchState.settings, backendReady: true },
    pending: {
      ...initialArchState.pending,
      queuedDwellBySession: { [SESSION]: entries },
    },
  };
}

function rearmCmd(localId: string, corrId = 'rearm'): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'RearmQueuedDwellWatchdog',
      corrId,
      sessionPath: SESSION,
      localId,
    },
  };
}

// ─── Reducer: RearmQueuedDwellWatchdog ──────────────────────────────────────

test('RearmQueuedDwellWatchdog resets watchdogFired and re-arms the host timer', () => {
  const state = stateWithDwell([
    { localId: 'local:q1', enqueuedAt: 1000, watchdogFired: true, abandoned: false },
  ]);
  const out = reducer(state, rearmCmd('local:q1'));

  assert.equal(out.state.pending.queuedDwellBySession[SESSION]?.[0]?.watchdogFired, false);
  const effect = out.effects.find((e) => e.kind === 'StartQueuedDwellWatchdog');
  assert.ok(effect, 'emits StartQueuedDwellWatchdog');
  assert.equal(effect.kind === 'StartQueuedDwellWatchdog' && effect.sessionPath, SESSION);
  assert.equal(effect.kind === 'StartQueuedDwellWatchdog' && effect.localId, 'local:q1');
  assert.equal(effect.kind === 'StartQueuedDwellWatchdog' && effect.timeoutMs, QUEUED_DWELL_HARD_MS);
});

test('RearmQueuedDwellWatchdog is a no-op when the entry is missing', () => {
  const state = stateWithDwell([]);
  const out = reducer(state, rearmCmd('local:gone'));
  assert.deepEqual(out.effects, []);
  assert.strictEqual(out.state, state);
});

test('RearmQueuedDwellWatchdog is a no-op when the entry is abandoned', () => {
  const state = stateWithDwell([
    { localId: 'local:q1', enqueuedAt: 1000, watchdogFired: true, abandoned: true },
  ]);
  const out = reducer(state, rearmCmd('local:q1'));
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.pending.queuedDwellBySession[SESSION]?.[0]?.watchdogFired, true);
});

// ─── Projection: active-session queuedDwell ───────────────────────────────────

test('selectViewState projects queuedDwell for the active session', () => {
  const entries: QueuedDwellEntry[] = [
    { localId: 'local:q1', enqueuedAt: 1000, watchdogFired: true, abandoned: false },
    { localId: 'local:q2', enqueuedAt: 2000, watchdogFired: false, abandoned: false },
  ];
  const state = stateWithDwell(entries);
  const view = selectViewState(state);
  assert.deepEqual(view.queuedDwell, entries);
});

test('selectViewState projects an empty queuedDwell when no session is active', () => {
  const state: ArchState = {
    ...stateWithDwell([{ localId: 'local:q1', enqueuedAt: 1000, watchdogFired: true, abandoned: false }]),
    sessions: {
      ...stateWithDwell([]).sessions,
      activeSessionPath: null,
    },
  };
  const view = selectViewState(state);
  assert.deepEqual(view.queuedDwell, []);
});

// ─── Protocol validation ─────────────────────────────────────────────────────

test('validateWebviewToHostMessage accepts rearmQueuedDwellWatchdog', () => {
  const result = validateWebviewToHostMessage({
    type: 'rearmQueuedDwellWatchdog',
    sessionPath: SESSION,
    localId: 'local:q1',
  });
  assert.equal(result.ok, true);
});

test('validateWebviewToHostMessage rejects rearmQueuedDwellWatchdog without localId', () => {
  const result = validateWebviewToHostMessage({
    type: 'rearmQueuedDwellWatchdog',
    sessionPath: SESSION,
  });
  assert.equal(result.ok, false);
});
