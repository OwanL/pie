import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, type ArchState } from '../../../conversation-state/arch-state';
import { reducer } from '../../../conversation-state/reducer';
import { selectViewState } from '../../../conversation-state/projections/projection';
import { canSnoozeSession, normalizeStoredSnoozes } from '../../../conversation-state/session-snooze';
import { projectHostLiveMembership } from '../../../agent-connection/live-session-membership';
import { sessionSnoozeWakeAt } from '../../../../lib/protocol/session-snooze';
import { EffectRunner } from '../../../conversation-state/effects/effect-runner';
import { makeEffectRunnerDeps } from '../../helpers/effect-runner-deps';

function fixture(): ArchState {
  const state = createInitialArchState();
  return { ...state, sessions: { ...state.sessions,
    sessions: ['/a', '/b', '/c'].map((path) => ({ path, name: path, cwd: '/w', modifiedAt: '', messageCount: 0 })),
    openTabPaths: ['/a', '/b', '/c'], pinnedTabPaths: ['/a', '/b'], pinnedTabGroups: [['/a', '/b']],
    activeSessionPath: '/a', privacyModeBySession: { '/a': true },
  } };
}
function snooze(state = fixture()) {
  return committedSnooze(state, '/a', 2000);
}
function committedSnooze(state: ArchState, sessionPath: string, wakeAt: number) {
  const requested = reducer(state, { kind: 'SessionSnoozeRequested', sessionPath, now: 1000, wakeAt, deferredTarget: false });
  const pending = requested.state.sessions.pendingSnoozes[sessionPath];
  return pending ? reducer(requested.state, { kind: 'SessionSnoozeReservationResult', sessionPath, reservationId: pending.reservationId, ok: true, now: 1001 }) : requested;
}

test('idle snooze hides membership, preserves private state/data, chooses successor and wakes in background with pin/group intent', () => {
  const original = fixture();
  const hidden = snooze(original);
  assert.deepEqual(hidden.state.sessions.openTabPaths, ['/b', '/c']);
  assert.equal(hidden.state.sessions.activeSessionPath, '/b');
  assert.deepEqual(projectHostLiveMembership(hidden.state, {}).sessions.map((s) => s.path), ['/b', '/c']);
  assert.deepEqual(selectViewState(hidden.state).sessions.map((s) => s.path), ['/b', '/c']);
  assert.deepEqual(selectViewState(hidden.state).snoozedSessions, [{ path: '/a', name: '/a', wakeAt: 2000 }]);
  assert.equal(hidden.state.transcript, original.transcript);
  assert.equal(hidden.state.sessions.privacyModeBySession, original.sessions.privacyModeBySession);
  assert.ok(!hidden.effects.some((e) => e.kind === 'CloseSession'));
  const early = reducer(hidden.state, { kind: 'SessionSnoozeTimerFired', now: 1999 });
  assert.equal(early.state, hidden.state);
  assert.equal(early.effects[0]?.kind, 'ScheduleSessionSnooze');
  const awake = reducer(hidden.state, { kind: 'SessionSnoozeTimerFired', now: 2000 });
  assert.deepEqual(awake.state.sessions.openTabPaths, ['/a', '/b', '/c']);
  assert.deepEqual(awake.state.sessions.pinnedTabGroups, [['/a', '/b']]);
  assert.equal(awake.state.sessions.activeSessionPath, '/b');
  assert.deepEqual(awake.state.sessions.snoozedBySession, {});
  assert.equal(fixture().sessions.openTabPaths.length, 3);
});

test('early restore is background; explicit ordinary open restores and selects; stale opened/tab/selection events cannot reveal snoozes', () => {
  const hidden = snooze().state;
  const early = reducer(hidden, { kind: 'SessionSnoozeRestoreRequested', sessionPath: '/a' });
  assert.equal(early.state.sessions.activeSessionPath, '/b');
  const staleTab = reducer(hidden, { kind: 'TabOpened', sessionPath: '/a' });
  assert.equal(staleTab.state, hidden);
  const staleSelect = reducer(hidden, { kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'stale', sessionPath: '/a' } });
  assert.equal(staleSelect.state, hidden);
  const staleOpen = reducer(hidden, { kind: 'SessionOpened', sessionPath: '/a' } as never);
  assert.equal(staleOpen.state, hidden);
  const open = reducer(hidden, { kind: 'Command', cmd: { kind: 'OpenSession', corrId: 'normal-open', sessionPath: '/a', selectionToken: 'new', placeholderSummary: fixture().sessions.sessions[0]! } });
  assert.equal(open.state.sessions.activeSessionPath, '/a');
  assert.deepEqual(open.state.sessions.snoozedBySession, {});
});

test('busy, billable, queued backend work, pending operations and deferred trigger targets reject snooze', () => {
  const base = fixture();
  for (const state of [
    { ...base, sessions: { ...base.sessions, runningSessionPaths: ['/a'] } },
    { ...base, sessions: { ...base.sessions, capabilitiesBySession: { '/a': { billableActivity: true, canContinue: false, canInterrupt: true, canCompact: false } } } },
    { ...base, pending: { ...base.pending, backendReadyQueueBySession: { '/a': [{}] } } } as unknown as ArchState,
    { ...base, operations: { pending: { terminal: undefined, session: { pendingPath: '/a' } } } } as unknown as ArchState,
  ]) {
    assert.equal(canSnoozeSession(state, '/a'), false);
    assert.equal(snooze(state).state, state);
  }
  assert.equal(reducer(base, { kind: 'SessionSnoozeRequested', sessionPath: '/a', now: 1000, wakeAt: 2000, deferredTarget: true }).state, base);
});

test('startup normalizes missing/malformed entries and restores expired tabs without selecting them', () => {
  const stored = snooze().state.sessions.snoozedBySession;
  const normalized = normalizeStoredSnoozes({ ...stored, '/missing': { ...stored['/a'], path: '/missing' }, '/invalid': { wakeAt: 'bad' } }, (p) => p !== '/missing');
  assert.deepEqual(Object.keys(normalized), ['/a']);
  const initial = createInitialArchState();
  const restored = reducer(initial, { kind: 'SessionSnoozesRestored', entries: normalized, now: 3000 });
  assert.deepEqual(restored.state.sessions.openTabPaths, ['/a']);
  assert.equal(restored.state.sessions.activeSessionPath, null);
  assert.ok(restored.effects.some((e) => e.kind === 'PersistTabs'));
});

test('multiple snoozes preserve original pinned order/group across separate background wakes', () => {
  const first = snooze().state;
  const both = committedSnooze(first, '/b', 3000).state;
  const firstWake = reducer(both, { kind: 'SessionSnoozeTimerFired', now: 2000 }).state;
  const secondWake = reducer(firstWake, { kind: 'SessionSnoozeTimerFired', now: 3000 }).state;
  assert.deepEqual(secondWake.sessions.openTabPaths, ['/a', '/b', '/c']);
  assert.deepEqual(secondWake.sessions.pinnedTabGroups, [['/a', '/b']]);
  assert.equal(secondWake.sessions.activeSessionPath, '/c');
});

test('three-member pinned group intent survives separate wakes in either order', () => {
  const original = { ...fixture(), sessions: { ...fixture().sessions,
    pinnedTabPaths: ['/a', '/b', '/c'], pinnedTabGroups: [['/a', '/b', '/c']],
  } };
  const both = committedSnooze(committedSnooze(original, '/a', 2000).state, '/b', 3000).state;
  for (const order of [['/a', '/b'], ['/b', '/a']] as const) {
    const afterFirst = reducer(both, { kind: 'SessionSnoozeRestoreRequested', sessionPath: order[0] }).state;
    const afterSecond = reducer(afterFirst, { kind: 'SessionSnoozeRestoreRequested', sessionPath: order[1] }).state;
    assert.deepEqual(afterSecond.sessions.openTabPaths, ['/a', '/b', '/c']);
    assert.deepEqual(afterSecond.sessions.pinnedTabGroups, [['/a', '/b', '/c']]);
  }
  const withoutC = { ...both, sessions: { ...both.sessions,
    openTabPaths: [], pinnedTabPaths: ['/b'], pinnedTabGroups: [],
  } };
  const restoredA = reducer(withoutC, { kind: 'SessionSnoozeRestoreRequested', sessionPath: '/a' }).state;
  const restoredB = reducer(restoredA, { kind: 'SessionSnoozeRestoreRequested', sessionPath: '/b' }).state;
  assert.deepEqual(restoredB.sessions.pinnedTabGroups, [['/a', '/b']]);
});

test('duration policy uses host time and local Monday 09:00, including today-before-nine', () => {
  const monday = new Date(2026, 9, 12, 8, 59).getTime();
  assert.equal(sessionSnoozeWakeAt(monday, 'monday'), new Date(2026, 9, 12, 9).getTime());
  assert.equal(sessionSnoozeWakeAt(new Date(2026, 9, 12, 9).getTime(), 'monday'), new Date(2026, 9, 19, 9).getTime());
  assert.equal(sessionSnoozeWakeAt(1000, 48), 1000 + 48 * 3600000);
});

test('runner owns one cancellable snooze timer and ordered persistence recovers after failure', async () => {
  const callbacks: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const { deps } = makeEffectRunnerDeps({ timer: { schedule: (fn) => { callbacks.push(fn); return callbacks.length; }, cancel: (handle) => { cancelled.push(handle); } } });
  const events: unknown[] = [];
  deps.dispatchEvent = (event) => events.push(event);
  deps.backend.request = async <T>() => ({ released: true } as T);
  let writes = 0;
  deps.tabs.persistTabs = async (_open, _active, _pin, _groups, _private, entries) => {
    writes++;
    assert.ok(entries);
    if (writes === 1) throw new Error('storage unavailable');
  };
  const runner = new EffectRunner(deps);
  const hidden = snooze();
  for (const effect of hidden.effects) runner.run(effect);
  for (const effect of reducer(hidden.state, { kind: 'SessionSnoozeRestoreRequested', sessionPath: '/a' }).effects) runner.run(effect);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 2);
  assert.deepEqual(cancelled, [1]);
  runner.run({ kind: 'ScheduleSessionSnooze', corrId: 'test', wakeAt: Date.now() + 1000 });
  callbacks.at(-1)!();
  assert.ok(events.some((event) => (event as { kind: string }).kind === 'SessionSnoozeTimerFired'));
  runner.run({ kind: 'ScheduleSessionSnooze', corrId: 'test', wakeAt: Date.now() + 1000 });
  runner.dispose();
  assert.deepEqual(cancelled, [1, 3]);
});

test('reservation acknowledgement is reducer-owned: reselect, close, repeat clicks, busy and ack loss cannot hide newer work', () => {
  const request = (state: ArchState) => reducer(state, { kind: 'SessionSnoozeRequested', sessionPath: '/a', now: 1000, wakeAt: 2000, deferredTarget: false });
  const first = request(fixture());
  assert.deepEqual(first.state.sessions.openTabPaths, ['/a', '/b', '/c']);
  const id = first.state.sessions.pendingSnoozes['/a']!.reservationId;
  const ack = (state: ArchState, ok = true) => reducer(state, { kind: 'SessionSnoozeReservationResult', sessionPath: '/a', reservationId: id, ok, now: 1001 });
  for (const state of [
    reducer(first.state, { kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'reselect', sessionPath: '/a' } }).state,
    reducer(first.state, { kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'close', sessionPath: '/a' } }).state,
    reducer(first.state, { kind: 'BusyChanged', sessionPath: '/a', running: true }).state,
    request(first.state).state,
  ]) {
    const late = ack(state);
    assert.equal(late.state.sessions.snoozedBySession['/a'], undefined);
    assert.ok(late.effects.some((e) => e.kind === 'ReleaseSessionSnooze'));
  }
  assert.equal(ack(first.state, false).state.sessions.snoozedBySession['/a'], undefined);
  const hidden = ack(first.state).state;
  const defensive = reducer(hidden, { kind: 'BusyChanged', sessionPath: '/a', running: true });
  assert.ok(defensive.state.sessions.openTabPaths.includes('/a'));
  assert.ok(defensive.state.sessions.runningSessionPaths.includes('/a'));
});

test('snoozing selected path hydrates/selects successor through the ordinary service selection seam', () => {
  const selected: string[] = [];
  const { deps } = makeEffectRunnerDeps();
  deps.service.openSession = (path) => { selected.push(path); };
  const runner = new EffectRunner(deps);
  const hidden = snooze();
  for (const effect of hidden.effects.filter((e) => e.kind === 'SelectSnoozeSuccessor')) runner.run(effect);
  assert.deepEqual(selected, ['/b']);
  runner.dispose();
});

test('persistence failure reports restart uncertainty without closing/deleting a private snooze', () => {
  const hidden = snooze().state;
  const failed = reducer(hidden, { kind: 'PersistTabsResult', corrId: 'session-snooze', ok: false, error: 'disk' });
  assert.match(failed.state.settings.notice!, /Could not save/);
  assert.equal(failed.state.sessions, hidden.sessions);
  assert.deepEqual(failed.effects, []);
});
