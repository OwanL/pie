/**
 * Reducer-level tests for the `CloseSession` MVI migration (tab lifecycle
 * op 4 of 4 — the last).
 *
 * Mirrors `arch-create-session.test.ts` / `arch-open-session.test.ts` /
 * `arch-duplicate-session.test.ts`. The reducer owns the tab-close + per-
 * session map clearing + select-next-tab; the runner owns the host-side
 * cleanup (clearSelectionRequests, onSessionClosed, clearSessionScope,
 * evict) + the recursive openSession(nextPath) edge case.
 *
 * KEY DIFFERENCE from create/open/duplicate: there is NO backend RPC for
 * close — the Effect is a host-side cleanup descriptor. And unlike
 * create/duplicate (which target a NEW pending path → clear
 * runningSessionPaths + activeRunSummaryBySession), closeSession REMOVES a
 * tab → mirror SessionScopeCleared{removeSessionSummary:false} (clear
 * per-session maps but KEEP the summary for reopening, do NOT touch
 * runningSessionPaths — the session may still be running in the backend
 * even if its tab is closed).
 *
 * Also pins the fix for the latent double-execution bug: the old
 * CloseSession handler called `removeSessionFromState` (full eviction,
 * nulled activeSessionPath) BEFORE the runner's fat `service.closeSession()`
 * could read the original activeSessionPath — so the next-tab selection was
 * silently skipped. The new handler computes nextPath FIRST (from the
 * pre-close state), does the close + select-next, and passes nextPath to
 * the runner via the Effect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { SessionSummary, ActiveRunSummary, ChatMessage, TranscriptWindow } from '../../../../src/shared/protocol';

const A = '/a';
const B = '/b';
const C = '/c';

const SUMMARY_A: SessionSummary = { path: A, name: 'Alpha', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 3 };
const SUMMARY_B: SessionSummary = { path: B, name: 'Beta', cwd: '/w', modifiedAt: '2024-01-02T00:00:00.000Z', messageCount: 5 };
const SUMMARY_C: SessionSummary = { path: C, name: 'Gamma', cwd: '/w', modifiedAt: '2024-01-03T00:00:00.000Z', messageCount: 1 };
const STALE_RUN_SUMMARY: ActiveRunSummary = { runId: 'r1', status: 'open' };

const SAMPLE_MESSAGES: ChatMessage[] = [
  { id: 'm1', role: 'user', createdAt: '2024-01-01T00:00:00.000Z', markdown: 'hello', status: 'completed' } as ChatMessage,
];
const SAMPLE_WINDOW: TranscriptWindow = { totalCount: 1, loadedStart: 0, loadedEnd: 1 } as TranscriptWindow;

interface BuildOpts {
  openTabs?: string[];
  activePath?: string | null;
  runningPaths?: string[];
  summaries?: SessionSummary[];
  activeRunSummaries?: Record<string, ActiveRunSummary | null>;
  transcripts?: Record<string, ChatMessage[]>;
  unreadPaths?: string[];
}

function buildState(opts: BuildOpts = {}): ArchState {
  return {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: opts.summaries ?? [SUMMARY_A, SUMMARY_B],
      openTabPaths: opts.openTabs ?? [A, B],
      activeSessionPath: opts.activePath ?? A,
      runningSessionPaths: opts.runningPaths ?? [],
      unreadFinishedSessionPaths: opts.unreadPaths ?? [],
    },
    composer: {
      ...initialArchState.composer,
      activeRunSummaryBySession: opts.activeRunSummaries ?? {},
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: opts.transcripts ?? {},
    },
  };
}

function closeCmd(corrId: string, sessionPath: string): Event {
  return { kind: 'Command', cmd: { kind: 'CloseSession', corrId, sessionPath } };
}

test('CloseSession removes the tab from openTabPaths + clears per-session maps + selects the next tab, and emits PersistTabs + CloseSession', () => {
  // [A, B] with active=A. Closing A → nextPath=B (the remaining tab slides left).
  const state = buildState({
    openTabs: [A, B],
    activePath: A,
    transcripts: { [A]: SAMPLE_MESSAGES },
  });
  const out = reducer(state, closeCmd('c1', A));

  // Tab A removed from openTabPaths; B remains.
  assert.deepEqual(out.state.sessions.openTabPaths, [B]);
  // A's transcript cleared (SessionScopeCleared semantics).
  assert.equal(A in out.state.transcript.bySession, false);
  // Summary is NOT removed — the session persists for reopening.
  assert.deepEqual(out.state.sessions.sessions, [SUMMARY_A, SUMMARY_B]);
  // Next tab B selected (wasActive=true, nextPath=B).
  assert.equal(out.state.sessions.activeSessionPath, B);
  // Effects: PersistTabs + CloseSession (with nextPath=B).
  assert.equal(out.effects.length, 2);
  assert.equal(out.effects[0]?.kind, 'PersistTabs');
  assert.equal(out.effects[1]?.kind, 'CloseSession');
  if (out.effects[1]?.kind === 'CloseSession') {
    assert.equal(out.effects[1].sessionPath, A);
    assert.equal(out.effects[1].nextPath, B);
  }
});

test('CloseSession does NOT remove the session summary (unlike removeSessionFromState — the session persists for reopening)', () => {
  const state = buildState({ summaries: [SUMMARY_A, SUMMARY_B], openTabs: [A, B], activePath: B });
  const out = reducer(state, closeCmd('c2', A));

  // Both summaries still present — closing a tab ≠ deleting a session.
  assert.deepEqual(out.state.sessions.sessions, [SUMMARY_A, SUMMARY_B]);
});

test('CloseSession hides a running tab without clearing recoverable state or finalizing its run', () => {
  const state = buildState({
    runningPaths: [A], activePath: B, openTabs: [A, B],
    transcripts: { [A]: SAMPLE_MESSAGES },
    activeRunSummaries: { [A]: STALE_RUN_SUMMARY },
  });
  const out = reducer(state, closeCmd('c3', A));

  assert.deepEqual(out.state.sessions.openTabPaths, [B]);
  assert.deepEqual(out.state.sessions.runningSessionPaths, [A]);
  assert.deepEqual(out.state.transcript.bySession[A], SAMPLE_MESSAGES);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession[A], STALE_RUN_SUMMARY);
  assert.deepEqual(out.effects.map((effect) => effect.kind), ['PersistTabs']);
});

test('duplicate or stale CloseSession command for an already hidden tab is idempotent', () => {
  const state = buildState({ openTabs: [A, B], activePath: B });
  const first = reducer(state, closeCmd('c3-first', A));
  const duplicate = reducer(first.state, closeCmd('c3-duplicate', A));

  assert.equal(duplicate.state, first.state);
  assert.deepEqual(duplicate.effects, []);
});

test('outbox ensureClosed retries persistence and idle cleanup for an already-hidden target', () => {
  const state = buildState({ openTabs: [B], activePath: B });
  const out = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'CloseSession', corrId: 'review-retry', sessionPath: A, ensureClosed: true },
  });

  assert.equal(out.state, state);
  assert.deepEqual(out.effects.map((effect) => effect.kind), ['PersistTabs', 'CloseSession']);
  assert.equal(out.effects[1]?.kind === 'CloseSession' ? out.effects[1].nextPath : undefined, null);
});

test('outbox ensureClosed preserves hidden running-session state and retries persistence only', () => {
  const state = buildState({
    openTabs: [B], activePath: B, runningPaths: [A], transcripts: { [A]: SAMPLE_MESSAGES },
    activeRunSummaries: { [A]: STALE_RUN_SUMMARY },
  });
  const out = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'CloseSession', corrId: 'review-running-retry', sessionPath: A, ensureClosed: true },
  });

  assert.equal(out.state, state);
  assert.deepEqual(out.effects.map((effect) => effect.kind), ['PersistTabs']);
  assert.deepEqual(out.state.transcript.bySession[A], SAMPLE_MESSAGES);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession[A], STALE_RUN_SUMMARY);
});

test('CloseSession clears the active-run summary for the closed session (mirror onSessionClosed)', () => {
  const state = buildState({
    activeRunSummaries: { [A]: STALE_RUN_SUMMARY },
    activePath: B,
    openTabs: [A, B],
  });
  const out = reducer(state, closeCmd('c4', A));

  // A's run summary cleared (handleSessionScopeCleared clears activeRunSummaryBySession).
  assert.equal(A in out.state.composer.activeRunSummaryBySession, false);
});

test('CloseSession when closing a non-active tab: activeSessionPath unchanged', () => {
  // Active=B, closing A → active stays B.
  const state = buildState({ openTabs: [A, B], activePath: B });
  const out = reducer(state, closeCmd('c5', A));

  assert.equal(out.state.sessions.activeSessionPath, B);
  assert.deepEqual(out.state.sessions.openTabPaths, [B]);
  // nextPath is still computed (for the runner's recursive-open edge case),
  // even though it's not used for selection (the closed tab wasn't active).
  if (out.effects[1]?.kind === 'CloseSession') {
    assert.equal(out.effects[1].nextPath, B);
  }
});

test('CloseSession when closing the last tab: activeSessionPath = null, nextPath = null', () => {
  const state = buildState({ openTabs: [A], activePath: A, summaries: [SUMMARY_A] });
  const out = reducer(state, closeCmd('c6', A));

  assert.deepEqual(out.state.sessions.openTabPaths, []);
  assert.equal(out.state.sessions.activeSessionPath, null);
  if (out.effects[1]?.kind === 'CloseSession') {
    assert.equal(out.effects[1].nextPath, null);
  }
});

test('CloseSession selects the tab that slides into the closed position (getNextVisibleTabPathOnClose semantics)', () => {
  // [A, B, C] with active=B. Closing B → nextPath=B (C slides into B's position).
  const state = buildState({
    summaries: [SUMMARY_A, SUMMARY_B, SUMMARY_C],
    openTabs: [A, B, C],
    activePath: B,
  });
  const out = reducer(state, closeCmd('c7', B));

  assert.deepEqual(out.state.sessions.openTabPaths, [A, C]);
  assert.equal(out.state.sessions.activeSessionPath, C);
  if (out.effects[1]?.kind === 'CloseSession') {
    assert.equal(out.effects[1].nextPath, C);
  }
});

test('CloseSession clears unreadFinishedSessionPaths for the closed session', () => {
  const state = buildState({ openTabs: [A, B], activePath: B, unreadPaths: [A] });
  const out = reducer(state, closeCmd('c8', A));

  assert.deepEqual(out.state.sessions.unreadFinishedSessionPaths, []);
});

test('CloseSession clears per-session keyed maps (transcript, windows, paging, models, context, composer, fileChanges, setModel pending)', () => {
  const state: ArchState = {
    ...buildState({ openTabs: [A, B], activePath: B, transcripts: { [A]: SAMPLE_MESSAGES } }),
    transcript: {
      ...initialArchState.transcript,
      bySession: { [A]: SAMPLE_MESSAGES },
      windowBySession: { [A]: SAMPLE_WINDOW },
      pagingInFlightBySession: { [A]: 'corr-1' },
    },
    settings: {
      ...initialArchState.settings,
      availableModelsBySession: { [A]: [] },
      contextUsageBySession: { [A]: null },
    },
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: { [A]: [] },
      activeRunSummaryBySession: { [A]: STALE_RUN_SUMMARY },
    },
    fileChanges: {
      ...initialArchState.fileChanges,
      bySession: { [A]: [] },
    },
  };
  const out = reducer(state, closeCmd('c9', A));

  assert.equal(A in out.state.transcript.bySession, false);
  assert.equal(A in out.state.transcript.windowBySession, false);
  assert.equal(A in out.state.transcript.pagingInFlightBySession, false);
  assert.equal(A in out.state.settings.availableModelsBySession, false);
  assert.equal(A in out.state.settings.contextUsageBySession, false);
  assert.equal(A in out.state.composer.pendingComposerInputsBySession, false);
  assert.equal(A in out.state.composer.activeRunSummaryBySession, false);
  assert.equal(A in out.state.fileChanges.bySession, false);
});

test('CloseSession does NOT clear per-session maps for OTHER sessions', () => {
  const state: ArchState = {
    ...buildState({ openTabs: [A, B], activePath: B, transcripts: { [A]: SAMPLE_MESSAGES, [B]: SAMPLE_MESSAGES } }),
    transcript: {
      ...initialArchState.transcript,
      bySession: { [A]: SAMPLE_MESSAGES, [B]: SAMPLE_MESSAGES },
      windowBySession: { [A]: SAMPLE_WINDOW, [B]: SAMPLE_WINDOW },
    },
  };
  const out = reducer(state, closeCmd('c10', A));

  // B's maps are untouched.
  assert.deepEqual(out.state.transcript.bySession[B], SAMPLE_MESSAGES);
  assert.deepEqual(out.state.transcript.windowBySession[B], SAMPLE_WINDOW);
});
