import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { reducer } from '../../../../src/host/core/reducer';
import { LAST_COMPACTION_CHIP_TTL_MS } from '../../../../src/host/core/reducer/session-handlers';
import type { Event } from '../../../../src/host/core/events';

function apply(state: ReturnType<typeof createInitialArchState>, event: Event) {
  const result = reducer(state, event);
  return { state: result.state, effects: result.effects };
}

test('CompactionStarted adds the session to compactingSessionPaths', () => {
  const initial = createInitialArchState();
  const { state, effects } = apply(initial, { kind: 'CompactionStarted', sessionPath: '/s' });

  assert.deepEqual(state.sessions.compactingSessionPaths, ['/s']);
  assert.deepEqual(effects, []);
});

test('CompactionEnded clears the compacting marker and records the transient chip', () => {
  let state = createInitialArchState();
  state = apply(state, { kind: 'CompactionStarted', sessionPath: '/s' }).state;

  const { state: next, effects } = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  });

  assert.deepEqual(next.sessions.compactingSessionPaths, []);
  assert.deepEqual(next.sessions.lastCompactionBySession['/s'], {
    at: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  });
  assert.deepEqual(effects, [{
    kind: 'ClearLastCompaction',
    corrId: 'clear-last-compaction:/s:1700000000000',
    sessionPath: '/s',
    ttlMs: LAST_COMPACTION_CHIP_TTL_MS,
  }]);
});

test('CompactionEnded without token metrics still records the chip timestamp', () => {
  const initial = createInitialArchState();
  const { state } = apply(initial, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
  });

  assert.deepEqual(state.sessions.lastCompactionBySession['/s'], { at: 1_700_000_000_000 });
});

test('LastCompactionCleared expires the chip entry', () => {
  let state = createInitialArchState();
  state = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
  }).state;

  const { state: next, effects } = apply(state, { kind: 'LastCompactionCleared', sessionPath: '/s' });
  assert.equal('/s' in next.sessions.lastCompactionBySession, false);
  assert.deepEqual(effects, []);
});

test('LastCompactionCleared is a no-op for an unknown session', () => {
  const initial = createInitialArchState();
  const { state, effects } = apply(initial, { kind: 'LastCompactionCleared', sessionPath: '/s' });
  assert.equal(state, initial);
  assert.deepEqual(effects, []);
});

test('a newer compaction replaces the pending chip entry and re-arms the TTL', () => {
  let state = createInitialArchState();
  state = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }).state;
  const { state: next, effects } = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_100,
    tokensBefore: 90_000,
    estimatedTokensAfter: 20_000,
  });

  assert.deepEqual(next.sessions.lastCompactionBySession['/s'], {
    at: 1_700_000_000_100,
    tokensBefore: 90_000,
    estimatedTokensAfter: 20_000,
  });
  assert.equal(effects.length, 1);
  assert.equal(effects[0]!.kind, 'ClearLastCompaction');
});

test('session.opened with isCompacting restores the compacting marker', () => {
  const initial = createInitialArchState();
  const { state } = apply(initial, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    sessionPath: '/s',
    payload: {
      session: { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0 },
      transcript: [],
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: true,
      isCompacting: true,
    },
  });

  assert.deepEqual(state.sessions.runningSessionPaths, ['/s']);
  assert.deepEqual(state.sessions.compactingSessionPaths, ['/s']);
});

test('RunningSessionsChanged prunes compacting paths that are no longer running', () => {
  let state = createInitialArchState();
  state = apply(state, { kind: 'CompactionStarted', sessionPath: '/s' }).state;
  state = apply(state, { kind: 'CompactionStarted', sessionPath: '/t' }).state;

  const { state: next } = apply(state, { kind: 'RunningSessionsChanged', sessionPaths: ['/s'] });
  assert.deepEqual(next.sessions.compactingSessionPaths, ['/s']);
});

test('session close evicts compacting and chip state', () => {
  let state = createInitialArchState();
  state = apply(state, { kind: 'CompactionStarted', sessionPath: '/s' }).state;
  state = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    occurredAt: 1_700_000_000_000,
  }).state;

  const { state: next } = apply(state, { kind: 'SessionClosed', sessionPath: '/s' });
  assert.deepEqual(next.sessions.compactingSessionPaths, []);
  assert.equal('/s' in next.sessions.lastCompactionBySession, false);
});
