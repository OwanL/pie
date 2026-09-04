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
    reason: 'threshold',
    outcome: 'succeeded',
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

test('failed and aborted CompactionEnded outcomes clear activity without a success chip', () => {
  let state = createInitialArchState();
  state = apply(state, { kind: 'CompactionStarted', sessionPath: '/s' }).state;

  let result = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    reason: 'manual',
    outcome: 'failed',
    occurredAt: 1_700_000_000_000,
  });
  assert.deepEqual(result.state.sessions.compactingSessionPaths, []);
  assert.equal('/s' in result.state.sessions.lastCompactionBySession, false);
  assert.deepEqual(result.effects, []);

  state = apply(result.state, { kind: 'CompactionStarted', sessionPath: '/s' }).state;
  result = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    reason: 'manual',
    outcome: 'aborted',
    occurredAt: 1_700_000_000_100,
  });
  assert.deepEqual(result.state.sessions.compactingSessionPaths, []);
  assert.equal('/s' in result.state.sessions.lastCompactionBySession, false);
  assert.deepEqual(result.effects, []);
});

test('CompactionEnded without token metrics still records the chip timestamp', () => {
  const initial = createInitialArchState();
  const { state } = apply(initial, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    outcome: 'succeeded',
    occurredAt: 1_700_000_000_000,
  });

  assert.deepEqual(state.sessions.lastCompactionBySession['/s'], { at: 1_700_000_000_000 });
});

test('LastCompactionCleared expires the chip entry', () => {
  let state = createInitialArchState();
  state = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    outcome: 'succeeded',
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
    outcome: 'succeeded',
    occurredAt: 1_700_000_000_000,
    tokensBefore: 120_000,
    estimatedTokensAfter: 30_000,
  }).state;
  const { state: next, effects } = apply(state, {
    kind: 'CompactionEnded',
    sessionPath: '/s',
    outcome: 'succeeded',
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

test('authoritative idle session.opened clears an orphaned compaction marker', () => {
  const initial = createInitialArchState();
  const stale = {
    ...initial,
    sessions: {
      ...initial.sessions,
      runningSessionPaths: ['/s'],
      compactingSessionPaths: ['/s'],
    },
  };
  const { state } = apply(stale, {
    kind: 'SessionOpened', backendGeneration: 0, modelWriteFence: 0, modelHydrationRevision: 0, catalogHydrationRevision: 0,
    sessionPath: '/s',
    payload: {
      session: { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0 },
      transcript: [],
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false,
      isCompacting: false,
    },
  });
  assert.deepEqual(state.sessions.runningSessionPaths, []);
  assert.deepEqual(state.sessions.compactingSessionPaths, []);
});

test('committed compact status repairs activity when compaction.ended was lost', () => {
  let state = apply(createInitialArchState(), {
    kind: 'Command',
    cmd: {
      kind: 'Compact', corrId: 'compact-status', operationId: 'compact-status-op',
      operationAttempt: 1, operationSource: { kind: 'host' }, backendGeneration: 4, sessionPath: '/s',
    },
  }).state;
  state = apply(state, {
    kind: 'MessageOperationDelayed', operationId: 'compact-status-op', operationKind: 'message.compact',
    sessionPath: '/s', backendGeneration: 4, error: 'ack lost',
  }).state;
  state = apply(state, {
    kind: 'MessageOperationStatus', operationId: 'compact-status-op', operationKind: 'message.compact',
    sessionPath: '/s', backendGeneration: 4, state: 'committed',
  }).state;

  assert.equal(state.operations['compact-status-op']?.terminal?.outcome, 'settled');
  assert.deepEqual(state.sessions.runningSessionPaths, []);
  assert.deepEqual(state.sessions.compactingSessionPaths, []);
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
    outcome: 'succeeded',
    occurredAt: 1_700_000_000_000,
  }).state;

  const { state: next } = apply(state, { kind: 'SessionClosed', sessionPath: '/s' });
  assert.deepEqual(next.sessions.compactingSessionPaths, []);
  assert.equal('/s' in next.sessions.lastCompactionBySession, false);
});

test('Compact command optimistically marks the session compacting and emits CompactRpc', () => {
  const initial = createInitialArchState();
  const { state, effects } = apply(initial, {
    kind: 'Command',
    cmd: { kind: 'Compact', corrId: 'c1', sessionPath: '/s' },
  });

  assert.deepEqual(state.sessions.compactingSessionPaths, ['/s']);
  assert.deepEqual(effects, [{
    kind: 'CompactRpc', corrId: 'c1', sessionPath: '/s',
    operationId: 'c1', operationAttempt: 1, backendGeneration: 0,
  }]);
  assert.equal(state.operations.c1?.kind, 'message.compact');
});

test('manual compaction records one explicit terminal outcome despite duplicate late evidence', () => {
  let state = apply(createInitialArchState(), {
    kind: 'Command',
    cmd: {
      kind: 'Compact', corrId: 'compact-terminal', sessionPath: '/s',
      operationId: 'compact-op', operationAttempt: 1,
      operationSource: { kind: 'host' }, backendGeneration: 6,
    },
  }).state;
  state = apply(state, {
    kind: 'CompactResult', corrId: 'compact-terminal', operationId: 'compact-op',
    operationAttempt: 1, backendGeneration: 6, sessionPath: '/s', ok: true,
  }).state;
  assert.equal(state.operations['compact-op']?.terminal?.outcome, 'settled');

  const succeeded = apply(state, {
    kind: 'CompactionEnded', sessionPath: '/s', operationId: 'compact-op',
    operationAttempt: 1, reason: 'manual', outcome: 'succeeded', occurredAt: 100,
  });
  assert.equal(succeeded.state.operations['compact-op']?.terminal?.outcome, 'settled');
  assert.equal(succeeded.effects.length, 1);

  const duplicate = apply(succeeded.state, {
    kind: 'CompactionEnded', sessionPath: '/s', operationId: 'compact-op',
    operationAttempt: 1, reason: 'manual', outcome: 'failed', occurredAt: 101,
  });
  assert.equal(duplicate.state, succeeded.state);
  assert.deepEqual(duplicate.effects, []);
});

test('a post-start compact RPC failure waits for the explicit aborted outcome', () => {
  let state = apply(createInitialArchState(), {
    kind: 'Command', cmd: { kind: 'Compact', corrId: 'compact-order', sessionPath: '/s' },
  }).state;
  state = apply(state, {
    kind: 'CompactionStarted', sessionPath: '/s', operationId: 'compact-order', operationAttempt: 1,
  }).state;
  state = apply(state, {
    kind: 'CompactResult', corrId: 'compact-order', operationId: 'compact-order',
    operationAttempt: 1, backendGeneration: 0, sessionPath: '/s', ok: false, error: 'Compaction cancelled',
  }).state;
  assert.equal(state.operations['compact-order']?.terminal, undefined);
  assert.equal(state.operations['compact-order']?.phase, 'ambiguous');

  state = apply(state, {
    kind: 'CompactionEnded', sessionPath: '/s', operationId: 'compact-order', operationAttempt: 1,
    reason: 'manual', outcome: 'aborted', occurredAt: 100,
  }).state;
  assert.equal(state.operations['compact-order']?.terminal?.outcome, 'cancelled');
});

test('aborted manual compaction settles cancelled and clears activity immediately', () => {
  let state = apply(createInitialArchState(), {
    kind: 'Command', cmd: { kind: 'Compact', corrId: 'compact-abort', sessionPath: '/s' },
  }).state;
  state = apply(state, {
    kind: 'CompactionEnded', sessionPath: '/s', operationId: 'compact-abort',
    reason: 'manual', outcome: 'aborted', occurredAt: 100,
  }).state;
  assert.equal(state.operations['compact-abort']?.terminal?.outcome, 'cancelled');
  assert.deepEqual(state.sessions.compactingSessionPaths, []);
});

test('CompactResult failure clears the optimistic compacting marker and surfaces a notice', () => {
  let state = createInitialArchState();
  state = apply(state, {
    kind: 'Command',
    cmd: { kind: 'Compact', corrId: 'c1', sessionPath: '/s' },
  }).state;

  const { state: next, effects } = apply(state, {
    kind: 'CompactResult',
    corrId: 'c1',
    sessionPath: '/s',
    ok: false,
    error: 'REQUEST_IN_PROGRESS: Cannot compact while this session is running.',
  });

  assert.deepEqual(next.sessions.compactingSessionPaths, []);
  assert.equal(next.settings.notice, 'Could not compact this conversation.');
  assert.equal(next.settings.noticeKind, 'operational-error');
  assert.deepEqual(effects, []);
});

test('CompactResult success settles the operation but leaves the compacting marker for CompactionEnded', () => {
  let state = createInitialArchState();
  state = apply(state, {
    kind: 'Command',
    cmd: { kind: 'Compact', corrId: 'c1', sessionPath: '/s' },
  }).state;

  const { state: next } = apply(state, {
    kind: 'CompactResult',
    corrId: 'c1',
    sessionPath: '/s',
    ok: true,
  });

  // The RPC ack does not mean compaction finished; the marker stays until the
  // backend's CompactionEnded event (success/failure/abort) clears it.
  assert.deepEqual(next.sessions.compactingSessionPaths, ['/s']);
});
