import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, type ArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { selectViewState } from '../../../conversation-state/projections/projection';
import { EffectRunner } from '../../../conversation-state/effects/effect-runner';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';

function restored() {
  const initial = createInitialArchState();
  initial.sessions.openTabPaths = ['/a'];
  initial.sessions.activeSessionPath = '/a';
  const requested = reducer(initial, { kind: 'SessionSnoozeRequested', sessionPath: '/a', wakeAt: 100000, now: 1, deferredTarget: false });
  const reservationId = requested.state.sessions.pendingSnoozes['/a']!.reservationId;
  const hidden = reducer(requested.state, { kind: 'SessionSnoozeReservationResult', sessionPath: '/a', reservationId, ok: true, now: 2 });
  const awake = reducer(hidden.state, { kind: 'SessionSnoozeRestoreRequested', sessionPath: '/a' });
  return { state: { ...awake.state, sessions: { ...awake.state.sessions, activeSessionPath: '/a' } }, reservationId };
}

test('failed-first release retries, retaining reducer identity and blocking restored admission until acknowledgement', async () => {
  const restoredState = restored();
  let state: ArchState = restoredState.state;
  const reservationId = restoredState.reservationId;
  const callbacks: Array<() => void> = [];
  const { deps } = makeEffectRunnerDeps({ timer: { schedule: (fn) => { callbacks.push(fn); return callbacks.length; }, cancel: () => {} } });
  let calls = 0;
  deps.backend.request = async <T>() => { if (++calls === 1) throw new Error('lost release'); return { released: true } as T; };
  deps.dispatchEvent = (event) => { state = reducer(state, event).state; };
  const runner = new EffectRunner(deps);
  runner.run({ kind: 'ReleaseSessionSnooze', corrId: reservationId, reservationId, sessionPath: '/a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.keys(state.sessions.snoozeReleases).length, 1);
  assert.equal(selectViewState(state).busy, true);
  assert.ok(selectViewState(state).runningSessionPaths.includes('/a'));
  assert.equal(selectViewState(state).sessionCapabilitiesBySession['/a']?.canContinue, false);
  callbacks.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(state.sessions.snoozeReleases, {});
  assert.equal(selectViewState(state).busy, false);
  runner.dispose();
});

test('stale release acknowledgement cannot clear newer owner; exhaustion retains backend-ready retry ownership', () => {
  const { state, reservationId } = restored();
  assert.equal(reducer(state, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId: 'stale', ok: true }).state, state);
  const failed = reducer(state, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId, ok: false });
  assert.match(failed.state.settings.notice!, /Restart the backend/);
  assert.deepEqual(failed.state.sessions.snoozeReleases, state.sessions.snoozeReleases);
  assert.ok(reducer(failed.state, { kind: 'BackendReadyChanged', ready: true }).effects.some((e) => e.kind === 'ReleaseSessionSnooze'));
});

test('pending or failed release fences close without evicting unsafe session work', () => {
  const { state, reservationId } = restored();
  const queued: ArchState = { ...state, pending: { ...state.pending, sendQueueBySession: { '/a': [{
    corrId: 'unsafe', localId: 'unsafe', text: 'work', composedText: 'work', inputs: [], previousSummary: null, timestamp: 1,
  }] } } };
  for (const fenced of [queued, reducer(queued, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId, ok: false }).state]) {
    const close = reducer(fenced, { kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'close-fenced', sessionPath: '/a', privacyMode: true } });
    assert.ok(close.state.sessions.openTabPaths.includes('/a'));
    assert.equal(close.state.pending, fenced.pending);
    assert.equal(close.state.livePipeline, fenced.livePipeline);
    assert.deepEqual(close.effects, []);
    assert.match(close.state.settings.notice!, /still being restored/);
  }
});

test('reopen hydration requires all matching releases and retries retain deferred effects', () => {
  const { state, reservationId } = restored();
  const another = { sessionPath: '/a', reservationId: 'other' };
  const overlapping = { ...state, sessions: { ...state.sessions, snoozeReleases: { ...state.sessions.snoozeReleases, other: another } } };
  const open = reducer(overlapping, { kind: 'Command', cmd: { kind: 'OpenSession', corrId: 'open', sessionPath: '/a', selectionToken: 'focus', placeholderSummary: null } });
  assert.equal(open.effects.some((e) => e.kind === 'OpenSession'), false);
  const retry = reducer(open.state, { kind: 'BackendReadyChanged', ready: true });
  const first = reducer(retry.state, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId, ok: true });
  assert.equal(first.effects.some((e) => e.kind === 'OpenSession'), false);
  const last = reducer(first.state, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId: 'other', ok: true });
  assert.deepEqual(last.effects.filter((e) => e.kind === 'OpenSession'), [{ kind: 'OpenSession', corrId: 'open', sessionPath: '/a', selectionToken: 'focus' }]);
  assert.equal(reducer(last.state, { kind: 'SessionSnoozeReleaseResult', sessionPath: '/a', reservationId: 'other', ok: true }).effects.length, 0);
});
