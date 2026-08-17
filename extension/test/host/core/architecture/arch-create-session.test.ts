/**
 * Reducer-level tests for the `CreateSession` MVI migration (tab lifecycle
 * op 1 of 4).
 *
 * The reducer now owns the optimistic tab setup that the service used to do via
 * imperative `dispatchArch` calls (placeholder summary insert, tab open,
 * select, ensure-not-running, active-run summary null) and emits `PersistTabs`
 * (replacing the old `saveOpenTabs()`) + a thin `CreateSession` Effect. The
 * runner owns the host-local selection machinery (`beginSelectionRequest` token
 * + 60s timer) and the backend `session.create` RPC; on failure
 * `handleSelectionFailure` dispatches the reducer transitions that undo the
 * optimistic setup — so the reducer's `CreateSessionResult` handler stays a
 * no-op (the recovery is host-driven, unchanged).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary, ActiveRunSummary } from '../../../../src/shared/protocol';

const OLD = '/old';
const PENDING = '/__pending__:1-abc';

const OLD_SUMMARY: SessionSummary = {
  path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 5,
};
const PLACEHOLDER: SessionSummary = {
  path: PENDING, name: 'New Session', cwd: '/w', modifiedAt: '2024-02-01T00:00:00.000Z', messageCount: 0, isPlaceholder: true,
};
const STALE_RUN_SUMMARY: ActiveRunSummary = { runId: 'r1', status: 'open' };

interface BuildOpts {
  openTabs?: string[];
  activePath?: string | null;
  runningPaths?: string[];
  summaries?: SessionSummary[];
  activeRunSummaries?: Record<string, ActiveRunSummary | null>;
}

function buildState(opts: BuildOpts = {}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: opts.summaries ?? [OLD_SUMMARY],
      openTabPaths: opts.openTabs ?? [OLD],
      activeSessionPath: opts.activePath ?? OLD,
      runningSessionPaths: opts.runningPaths ?? [],
    },
    composer: {
      ...initialArchState.composer,
      activeRunSummaryBySession: opts.activeRunSummaries ?? {},
    },
  };
}

function createCmd(corrId: string, sessionPath: string = PENDING, placeholder: SessionSummary = PLACEHOLDER, cwd = '/w', selectionToken = 'tok', operationId?: string): Event {
  return { kind: 'Command', cmd: { kind: 'CreateSession', corrId, sessionPath, cwd, placeholderSummary: placeholder, selectionToken, ...(operationId ? { operationId } : {}) } };
}

test('CreateSession inserts the placeholder summary, opens + selects the tab, clears running/run-summary, and emits PersistTabs + CreateSession', () => {
  const state = buildState({ runningPaths: [OLD] });
  const out = reducer(state, createCmd('c1'));

  // Placeholder summary unshifted (handleSessionSummaryUpserted semantics).
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OLD_SUMMARY]);
  // Tab appended (handleTabOpened semantics) + selected (SelectSession).
  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, PENDING]);
  assert.equal(out.state.sessions.activeSessionPath, PENDING);
  // Pending path ensured not running; the existing running marker untouched.
  assert.deepEqual(out.state.sessions.runningSessionPaths, [OLD]);
  // Active-run summary cleared to null for the new session.
  assert.equal(out.state.composer.activeRunSummaryBySession[PENDING], null);
  // Effects: PersistTabs (post-open tabs + new active) then the thin RPC effect.
  assert.deepEqual(out.effects, [
    { kind: 'PersistTabs', corrId: 'c1', openTabPaths: [OLD, PENDING], activeSessionPath: PENDING, pinnedTabPaths: [], pinnedTabGroups: [] },
    { kind: 'CreateSession', corrId: 'c1', sessionPath: PENDING, cwd: '/w', selectionToken: 'tok' },
  ]);
});

test('CreateSession does not duplicate the summary or tab if the pending path is already present', () => {
  const state = buildState({
    summaries: [PLACEHOLDER, OLD_SUMMARY],
    openTabs: [OLD, PENDING],
    activePath: OLD,
  });
  const out = reducer(state, createCmd('c2'));

  // No duplicate summary, no duplicate tab — but selection still moves to it.
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OLD_SUMMARY]);
  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, PENDING]);
  assert.equal(out.state.sessions.activeSessionPath, PENDING);
  assert.equal(out.state.composer.activeRunSummaryBySession[PENDING], null);
  assert.equal(out.effects.length, 2);
});

test('CreateSession clears a stale running marker and overwrites a stale active-run summary for the pending path', () => {
  const state = buildState({ runningPaths: [PENDING, OLD], activeRunSummaries: { [PENDING]: STALE_RUN_SUMMARY } });
  const out = reducer(state, createCmd('c3'));

  assert.deepEqual(out.state.sessions.runningSessionPaths, [OLD]);
  assert.equal(out.state.composer.activeRunSummaryBySession[PENDING], null);
});

test('a create timeout retains the delayed ledger, pending tab, queued sends, and stable retry identity', () => {
  const operationId = 'create-op-1';
  const created = reducer(buildState(), createCmd('c-timeout', PENDING, PLACEHOLDER, '/w', 'tok-timeout', operationId));
  const queued = {
    corrId: 'queued-1', text: 'after create', inputs: [], composedText: 'after create',
    localId: 'local-1', userParts: undefined, previousSummary: null, timestamp: 1,
  };
  const queuedState: ArchState = {
    ...created.state,
    pending: {
      ...created.state.pending,
      sendQueueBySession: { [PENDING]: [queued] },
    },
  };
  const delayed = reducer(queuedState, {
    kind: 'CreateOperationDelayed', operationId, pendingPath: PENDING,
    selectionToken: 'tok-timeout', notice: 'still creating', ownsSelection: true,
  });
  assert.equal(delayed.state.pending.createOperations[operationId]?.status, 'delayed-awaiting-outcome');
  assert.equal(delayed.state.sessions.openTabPaths.includes(PENDING), true);
  assert.equal(delayed.state.sessions.sessions[0]?.creationState, 'delayed');
  assert.deepEqual(delayed.state.pending.sendQueueBySession[PENDING], [queued]);

  const retried = reducer(delayed.state, createCmd('c-retry', PENDING, PLACEHOLDER, '/w', 'tok-timeout', operationId));
  assert.equal(retried.state.pending.createOperations[operationId]?.status, 'pending');
  assert.deepEqual(retried.state.pending.sendQueueBySession[PENDING], [queued]);
  const retryEffect = retried.effects.find((effect) => effect.kind === 'CreateSession');
  assert.equal(retryEffect?.kind, 'CreateSession');
  if (retryEffect?.kind === 'CreateSession') assert.equal(retryEffect.operationId, operationId);
});

test('hiding a delayed create preserves its ledger and queued sends without reopening on late success', () => {
  const operationId = 'create-op-hidden';
  const created = reducer(buildState(), createCmd('c-hidden', PENDING, PLACEHOLDER, '/w', 'tok-hidden', operationId));
  const delayed = reducer(created.state, {
    kind: 'CreateOperationDelayed', operationId, pendingPath: PENDING,
    selectionToken: 'tok-hidden', ownsSelection: true,
  });
  const queue = [{
    corrId: 'queued-hidden', text: 'queued', inputs: [], composedText: 'queued',
    localId: 'local-hidden', previousSummary: null, timestamp: 1,
  }];
  const withQueue = {
    ...delayed.state,
    pending: { ...delayed.state.pending, sendQueueBySession: { [PENDING]: queue } },
  } as ArchState;
  const hidden = reducer(withQueue, {
    kind: 'Command', cmd: { kind: 'CloseSession', corrId: 'close-hidden', sessionPath: PENDING },
  });
  assert.equal(hidden.state.sessions.openTabPaths.includes(PENDING), false);
  assert.equal(hidden.state.sessions.activeSessionPath, OLD);
  assert.equal(hidden.state.pending.createOperations[operationId]?.hidden, true);
  assert.deepEqual(hidden.state.pending.sendQueueBySession[PENDING], queue);
  assert.equal(hidden.effects.length, 1);
  assert.equal(hidden.effects[0]?.kind, 'PersistTabs');
});

test('the optimistic CreateSession setup is fully undone by the host-side failure path (SessionScopeCleared + SelectSession-fallback)', () => {
  // Pin that handleSelectionFailure's dispatched transitions revert exactly
  // what the reducer applied: after scope-clear (removeSummary) + select
  // fallback, the state matches the pre-create state.
  const before = buildState({ runningPaths: [OLD] });
  const created = reducer(before, createCmd('c4'));
  assert.equal(created.state.sessions.activeSessionPath, PENDING);

  // Recovery: clear the pending session's scope (remove its summary + tab) and
  // select the fallback (the previous active path).
  const cleared = reducer(created.state, { kind: 'SessionScopeCleared', sessionPath: PENDING, removeSessionSummary: true });
  const restored = reducer(cleared.state, { kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'sel', sessionPath: OLD } });

  // Back to the pre-create state: only the old tab open + active, old summary,
  // no pending summary/tab/run-summary.
  assert.deepEqual(restored.state.sessions.openTabPaths, [OLD]);
  assert.equal(restored.state.sessions.activeSessionPath, OLD);
  assert.deepEqual(restored.state.sessions.sessions, [OLD_SUMMARY]);
  assert.equal(PENDING in restored.state.composer.activeRunSummaryBySession, false);
  assert.equal(PENDING in restored.state.sessions.openTabPaths, false);
});