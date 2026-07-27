/**
 * Reducer-level tests for the `OpenSession` MVI migration (tab lifecycle
 * op 2 of 4).
 *
 * The reducer now owns the optimistic tab setup that the service used to do via
 * imperative `dispatchArch` calls (placeholder summary insert iff the session
 * isn't already summarized, tab open iff it isn't already open, select,
 * unread-finished clear) and emits `PersistTabs` (replacing the old
 * `saveOpenTabs()`) + a thin `OpenSession` Effect. The runner owns the
 * host-local selection machinery (`beginSelectionRequest` token + 60s timer)
 * and the backend `session.open` RPC; on failure `handleSelectionFailure`
 * dispatches the reducer transitions that undo the optimistic setup — so the
 * reducer's `OpenSessionResult` handler stays a no-op (the recovery is
 * host-driven, unchanged).
 *
 * The key semantic difference from CreateSession: opening an existing tab must
 * NOT touch `runningSessionPaths` or `activeRunSummaryBySession` — the opened
 * session may be running, and stopping it or dropping its in-progress summary
 * on a mere tab switch would be a regression. CreateSession clears both because
 * a brand-new session cannot be running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary, ActiveRunSummary } from '../../../../src/shared/protocol';

const OLD = '/old';
const NEW = '/new';

const OLD_SUMMARY: SessionSummary = {
  path: OLD, name: 'Old', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 5,
};
const NEW_SUMMARY: SessionSummary = {
  path: NEW, name: 'New', cwd: '/w', modifiedAt: '2024-01-02T00:00:00.000Z', messageCount: 3,
};
const PLACEHOLDER: SessionSummary = {
  path: NEW, name: 'Loading...', cwd: '/w', modifiedAt: '2024-02-01T00:00:00.000Z', messageCount: 0, isPlaceholder: true,
};
const STALE_RUN_SUMMARY: ActiveRunSummary = { runId: 'r1', status: 'open' };

interface BuildOpts {
  openTabs?: string[];
  activePath?: string | null;
  runningPaths?: string[];
  summaries?: SessionSummary[];
  activeRunSummaries?: Record<string, ActiveRunSummary | null>;
  unreadFinished?: string[];
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
      ...(opts.unreadFinished ? { unreadFinishedSessionPaths: opts.unreadFinished } : {}),
    },
    composer: {
      ...initialArchState.composer,
      activeRunSummaryBySession: opts.activeRunSummaries ?? {},
    },
  };
}

function openCmd(corrId: string, sessionPath: string = NEW, placeholder: SessionSummary | null = PLACEHOLDER, selectionToken = 'tok'): Event {
  return { kind: 'Command', cmd: { kind: 'OpenSession', corrId, sessionPath, placeholderSummary: placeholder, selectionToken } };
}

test('OpenSession inserts the placeholder summary, opens + selects the tab, leaves running/run-summary untouched, and emits PersistTabs + OpenSession', () => {
  // OLD is running with an in-progress run summary; opening NEW (a fresh path)
  // must not disturb either.
  const state = buildState({ runningPaths: [OLD], activeRunSummaries: { [OLD]: STALE_RUN_SUMMARY } });
  const out = reducer(state, openCmd('c1'));

  // Placeholder summary unshifted (handleSessionSummaryUpserted semantics).
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OLD_SUMMARY]);
  // Tab appended (handleTabOpened semantics) + selected (SelectSession).
  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, NEW]);
  assert.equal(out.state.sessions.activeSessionPath, NEW);
  // KEY DIFFERENCE FROM CREATE: running marker untouched (OLD still running,
  // NEW not added); active-run summary untouched (no null entry minted for NEW).
  assert.deepEqual(out.state.sessions.runningSessionPaths, [OLD]);
  assert.equal(NEW in out.state.composer.activeRunSummaryBySession, false);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession, { [OLD]: STALE_RUN_SUMMARY });
  // Effects: PersistTabs (post-open tabs + new active) then the thin RPC effect.
  assert.deepEqual(out.effects, [
    { kind: 'PersistTabs', corrId: 'c1', openTabPaths: [OLD, NEW], activeSessionPath: NEW, pinnedTabPaths: [] },
    { kind: 'OpenSession', corrId: 'c1', sessionPath: NEW, selectionToken: 'tok' },
  ]);
});

test('OpenSession does not duplicate the summary or tab if the path is already summarized + already open', () => {
  const state = buildState({
    summaries: [PLACEHOLDER, OLD_SUMMARY],
    openTabs: [OLD, NEW],
    activePath: OLD,
  });
  const out = reducer(state, openCmd('c2', NEW, null));

  // No duplicate summary, no duplicate tab — but selection still moves to it.
  assert.deepEqual(out.state.sessions.sessions, [PLACEHOLDER, OLD_SUMMARY]);
  assert.deepEqual(out.state.sessions.openTabPaths, [OLD, NEW]);
  assert.equal(out.state.sessions.activeSessionPath, NEW);
  // No running/run-summary change (none were set up to begin with).
  assert.deepEqual(out.state.sessions.runningSessionPaths, []);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession, {});
  assert.equal(out.effects.length, 2);
});

test('OpenSession preserves a running marker and an in-progress active-run summary for the opened session', () => {
  // NEW is already summarized + open + running with an in-progress summary.
  // Switching to it must not stop the run or drop the summary — the invariant
  // CreateSession violates on purpose (a new session can't be running) but
  // OpenSession must respect.
  const state = buildState({
    summaries: [NEW_SUMMARY],
    openTabs: [NEW],
    activePath: null,
    runningPaths: [NEW],
    activeRunSummaries: { [NEW]: STALE_RUN_SUMMARY },
  });
  const out = reducer(state, openCmd('c3', NEW, null));

  assert.deepEqual(out.state.sessions.runningSessionPaths, [NEW]);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession, { [NEW]: STALE_RUN_SUMMARY });
  assert.equal(out.state.sessions.activeSessionPath, NEW);
});

test('OpenSession clears the opened session from unread-finished (SelectSession semantics)', () => {
  const state = buildState({ unreadFinished: [NEW, OLD] });
  const out = reducer(state, openCmd('c4'));

  assert.deepEqual(out.state.sessions.unreadFinishedSessionPaths, [OLD]);
});

test('the optimistic OpenSession setup is fully undone by the host-side failure path (CloseTab + SessionScopeCleared + SelectSession-fallback)', () => {
  // Pin that handleSelectionFailure's dispatched transitions (for the
  // newly-opened-tab case: !wasOpenTab) revert exactly what the reducer
  // applied: after CloseTab + scope-clear (removeSummary) + select fallback,
  // the state matches the pre-open state.
  const before = buildState();
  const opened = reducer(before, openCmd('c5'));
  assert.equal(opened.state.sessions.activeSessionPath, NEW);
  assert.ok(opened.state.sessions.openTabPaths.includes(NEW));

  // Recovery (mirrors handleSelectionFailure's !wasOpenTab branch):
  // CloseTab(NEW) then SessionScopeCleared(NEW, removeSummary=true) then
  // SelectSession(previousActivePath=OLD).
  const afterCloseTab = reducer(opened.state, { kind: 'Command', cmd: { kind: 'CloseTab', corrId: 'cl', sessionPath: NEW } });
  const cleared = reducer(afterCloseTab.state, { kind: 'SessionScopeCleared', sessionPath: NEW, removeSessionSummary: true });
  const restored = reducer(cleared.state, { kind: 'Command', cmd: { kind: 'SelectSession', corrId: 'sel', sessionPath: OLD } });

  // Back to the pre-open state: only the old tab open + active, old summary,
  // no opened placeholder/tab/run-summary.
  assert.deepEqual(restored.state.sessions.openTabPaths, [OLD]);
  assert.equal(restored.state.sessions.activeSessionPath, OLD);
  assert.deepEqual(restored.state.sessions.sessions, [OLD_SUMMARY]);
  assert.equal(NEW in restored.state.composer.activeRunSummaryBySession, false);
  assert.equal(restored.state.sessions.openTabPaths.includes(NEW), false);
});
