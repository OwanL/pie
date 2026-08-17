/**
 * Reducer-level tests for the `DuplicateSession` MVI migration (tab lifecycle
 * op 3 of 4).
 *
 * Mirrors `arch-create-session.test.ts`. The reducer owns the optimistic tab
 * setup that the service used to do via imperative `dispatchArch` calls
 * (placeholder copy summary insert, tab open ADJACENT to the source
 * (insertAfter), select, ensure-not-running, active-run summary null) and emits
 * `PersistTabs` (replacing the old `saveOpenTabs()`) + a thin `DuplicateSession`
 * Effect. The runner owns the host-local selection machinery
 * (`beginSelectionRequest` token + 60s timer) and the backend `session.duplicate`
 * RPC; on failure `handleSelectionFailure` dispatches the reducer transitions
 * that undo the optimistic setup — so the reducer's `DuplicateSessionResult`
 * handler stays a no-op (the recovery is host-driven, unchanged).
 *
 * DIFFERENCE from CreateSession: the copy tab is inserted adjacent to the
 * source (insertAfter semantics, matching `handleTabOpened`) rather than
 * appended at the end, so the duplicate appears next to its source in the tab
 * bar. Like CreateSession (NOT OpenSession): a brand-new pending copy cannot be
 * running, so the running marker + active-run summary are cleared for the
 * pending path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary, ActiveRunSummary } from '../../../../src/shared/protocol';

const OLD = '/old';
const OTHER = '/other';
const PENDING = '/__pending__:1-abc';

const OLD_SUMMARY: SessionSummary = {
  path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 5,
};
const OTHER_SUMMARY: SessionSummary = {
  path: OTHER, name: 'Other', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 2,
};
const PLACEHOLDER: SessionSummary = {
  path: PENDING, name: 'Old (copy)', cwd: '/w', modifiedAt: '2024-02-01T00:00:00.000Z', messageCount: 5, isPlaceholder: true,
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

function createCmd(corrId: string, opts: { pending?: string; source?: string; placeholder?: SessionSummary; selectionToken?: string; operationId?: string } = {}): Event {
  const pending = opts.pending ?? PENDING;
  const source = opts.source ?? OLD;
  const placeholder = opts.placeholder ?? PLACEHOLDER;
  return {
    kind: 'Command',
    cmd: { kind: 'DuplicateSession', corrId, sessionPath: pending, sourceSessionPath: source, placeholderSummary: placeholder, selectionToken: opts.selectionToken ?? 'tok', ...(opts.operationId ? { operationId: opts.operationId } : {}) },
  };
}

test('DuplicateSession inserts the placeholder copy summary, opens the tab adjacent to the source, selects it, clears running/run-summary, and emits PersistTabs + DuplicateSession', () => {
  const state = buildState({ runningPaths: [OLD] });
  const out = reducer(state, createCmd('c1'));

  // Placeholder copy summary unshifted (handleSessionSummaryUpserted semantics).
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OLD_SUMMARY]);
  // Copy tab spliced in RIGHT AFTER the source (insertAfter), not appended at end.
  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, PENDING]);
  assert.equal(out.state.sessions.activeSessionPath, PENDING);
  // Pending path ensured not running; the existing running marker untouched.
  assert.deepEqual(out.state.sessions.runningSessionPaths, [OLD]);
  // Active-run summary cleared to null for the new copy.
  assert.equal(out.state.composer.activeRunSummaryBySession[PENDING], null);
  // Effects: PersistTabs (post-open tabs + new active) then the thin RPC effect.
  assert.deepEqual(out.effects, [
    { kind: 'PersistTabs', corrId: 'c1', openTabPaths: [OLD, PENDING], activeSessionPath: PENDING, pinnedTabPaths: [], pinnedTabGroups: [] },
    { kind: 'DuplicateSession', corrId: 'c1', sessionPath: PENDING, sourceSessionPath: OLD, selectionToken: 'tok' },
  ]);
});

test('DuplicateSession timeout retry keeps one operation identity and the pending copy', () => {
  const operationId = 'duplicate-op-1';
  const created = reducer(buildState(), createCmd('duplicate-1', { operationId, selectionToken: 'duplicate-token' }));
  const delayed = reducer(created.state, {
    kind: 'CreateOperationDelayed', operationId, pendingPath: PENDING,
    selectionToken: 'duplicate-token', notice: 'still duplicating', ownsSelection: true,
  });
  assert.equal(delayed.state.pending.createOperations[operationId]?.status, 'delayed-awaiting-outcome');
  assert.equal(delayed.state.sessions.openTabPaths.includes(PENDING), true);
  const retried = reducer(delayed.state, createCmd('duplicate-2', { operationId, selectionToken: 'duplicate-token' }));
  assert.equal(retried.state.pending.createOperations[operationId]?.status, 'pending');
  const effect = retried.effects.find((item) => item.kind === 'DuplicateSession');
  assert.equal(effect?.kind, 'DuplicateSession');
  if (effect?.kind === 'DuplicateSession') {
    assert.equal(effect.operationId, operationId);
    assert.equal(effect.sourceSessionPath, OLD);
  }
});

test('DuplicateSession does not duplicate the summary or tab if the pending path is already present', () => {
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

test('DuplicateSession clears a stale running marker and overwrites a stale active-run summary for the pending path', () => {
  const state = buildState({ runningPaths: [PENDING, OLD], activeRunSummaries: { [PENDING]: STALE_RUN_SUMMARY } });
  const out = reducer(state, createCmd('c3'));

  assert.deepEqual(out.state.sessions.runningSessionPaths, [OLD]);
  assert.equal(out.state.composer.activeRunSummaryBySession[PENDING], null);
});

test('DuplicateSession appends the copy at the end when the source tab is not already open (insertAfter fallback, matching handleTabOpened)', () => {
  // Source is summarized but its tab is not open (e.g. it was closed but the
  // summary lingers). handleTabOpened falls back to appending at end when the
  // insertAfter anchor is absent; the DuplicateSession reducer mirrors that.
  const state = buildState({
    summaries: [OTHER_SUMMARY, OLD_SUMMARY],
    openTabs: [OTHER],
    activePath: OTHER,
  });
  const out = reducer(state, createCmd('c4'));

  // Placeholder still unshifted onto the summaries list.
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OTHER_SUMMARY, OLD_SUMMARY]);
  // Source (OLD) is not in openTabPaths → copy appended at the end (not spliced).
  assert.deepEqual(out.state.sessions.openTabPaths, [OTHER, PENDING]);
  assert.equal(out.state.sessions.activeSessionPath, PENDING);
});

test('DuplicateSession splices the copy immediately after the source even when other tabs follow it', () => {
  // [OLD, OTHER] with source=OLD → copy spliced after OLD → [OLD, PENDING, OTHER].
  const state = buildState({
    summaries: [OLD_SUMMARY, OTHER_SUMMARY],
    openTabs: [OLD, OTHER],
    activePath: OLD,
  });
  const out = reducer(state, createCmd('c5'));

  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, PENDING, OTHER]);
  assert.equal(out.state.sessions.activeSessionPath, PENDING);
});

test('the optimistic DuplicateSession setup is fully undone by the host-side failure path (SessionScopeCleared + SelectSession-fallback)', () => {
  // Pin that handleSelectionFailure's dispatched transitions revert exactly
  // what the reducer applied: after scope-clear (removeSummary) + select
  // fallback, the state matches the pre-duplicate state.
  const before = buildState({ runningPaths: [OLD] });
  const duplicated = reducer(before, createCmd('c6'));
  assert.equal(duplicated.state.sessions.activeSessionPath, PENDING);

  // Recovery: clear the pending copy's scope (remove its summary + tab) and
  // select the fallback (the previous active path).
  const cleared = reducer(duplicated.state, { kind: 'SessionScopeCleared', sessionPath: PENDING, removeSessionSummary: true });
  const restored = reducer(cleared.state, { kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'sel', sessionPath: OLD } });

  // Back to the pre-duplicate state: only the old tab open + active, old summary,
  // no pending copy summary/tab/run-summary.
  assert.deepEqual(restored.state.sessions.openTabPaths, [OLD]);
  assert.equal(restored.state.sessions.activeSessionPath, OLD);
  assert.deepEqual(restored.state.sessions.sessions, [OLD_SUMMARY]);
  assert.equal(PENDING in restored.state.composer.activeRunSummaryBySession, false);
  assert.equal(PENDING in restored.state.sessions.openTabPaths, false);
});
