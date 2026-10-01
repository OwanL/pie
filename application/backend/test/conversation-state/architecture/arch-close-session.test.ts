/**
 * Reducer-level tests for the `CloseSession` MVI migration (tab lifecycle
 * op 4 of 4 — the last).
 *
 * Mirrors `arch-create-session.test.ts` / `arch-open-session.test.ts` /
 * `arch-duplicate-session.test.ts`. The reducer owns the tab-close + per-
 * select-next-tab; the runner owns host cleanup (clearSelectionRequests,
 * onSessionClosed, clearSessionScope, evict) and the recursive
 * openSession(nextPath) edge case. Session state remains intact until cleanup
 * succeeds so a failed close can restore the tab safely.
 *
 * KEY DIFFERENCE from create/open/duplicate: there is NO backend RPC for
 * close — the Effect is a host-side cleanup descriptor. And unlike
 * create/duplicate (which target a NEW pending path → clear
 * runningSessionPaths + activeRunSummaryBySession), closeSession removes its
 * tab immediately but retains session state until the stop/cleanup barrier
 * succeeds.
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

import { reducer, initialArchState, type ArchState } from '../../../conversation-state/reducer';
import type { Event } from '../../../conversation-state/events';
import type { SessionSummary, ActiveRunSummary, ChatMessage, TranscriptWindow } from '../../../../lib/protocol/index.js';

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

test('CloseSession removes the tab, selects the next tab, and retains session state until cleanup', () => {
  // [A, B] with active=A. Closing A → nextPath=B (the remaining tab slides left).
  const state = buildState({
    openTabs: [A, B],
    activePath: A,
    transcripts: { [A]: SAMPLE_MESSAGES },
  });
  const out = reducer(state, closeCmd('c1', A));

  // Tab A removed from openTabPaths; B remains.
  assert.deepEqual(out.state.sessions.openTabPaths, [B]);
  // Session data survives until the host cleanup effect succeeds.
  assert.equal(A in out.state.transcript.bySession, true);
  // Summary is NOT removed — the session persists for reopening.
  assert.deepEqual(out.state.sessions.sessions, [SUMMARY_A, SUMMARY_B]);
  // Next tab B selected (wasActive=true, nextPath=B).
  assert.equal(out.state.sessions.activeSessionPath, B);
  // Effects: PersistTabs + CloseSession + runtime-free viewed transition.
  assert.deepEqual(out.effects.map((effect) => effect.kind), [
    'PersistTabs', 'CloseSession', 'NotifySessionViewed',
  ]);
  const closeEffect = out.effects.find((effect) => effect.kind === 'CloseSession');
  if (closeEffect?.kind === 'CloseSession') {
    assert.equal(closeEffect.sessionPath, A);
    assert.equal(closeEffect.nextPath, B);
    assert.equal(closeEffect.selectionChanged, true);
  }
  assert.deepEqual(out.effects.find((effect) => effect.kind === 'NotifySessionViewed'), {
    kind: 'NotifySessionViewed', corrId: 'c1', sessionPath: B, previousSessionPath: A,
  });
});

test('CloseSession does NOT remove the session summary (unlike removeSessionFromState — the session persists for reopening)', () => {
  const state = buildState({ summaries: [SUMMARY_A, SUMMARY_B], openTabs: [A, B], activePath: B });
  const out = reducer(state, closeCmd('c2', A));

  // Both summaries still present — closing a tab ≠ deleting a session.
  assert.deepEqual(out.state.sessions.sessions, [SUMMARY_A, SUMMARY_B]);
});

test('UI close of a running tab stops before cleanup without evicting recoverable state', () => {
  const state = buildState({
    runningPaths: [A], activePath: B, openTabs: [A, B],
    transcripts: { [A]: SAMPLE_MESSAGES },
    activeRunSummaries: { [A]: STALE_RUN_SUMMARY },
  });
  const out = reducer(state, closeCmd('c3', A));

  assert.deepEqual(out.state.sessions.openTabPaths, [B]);
  assert.deepEqual(out.state.sessions.runningSessionPaths, [A]);
  assert.deepEqual(out.state.sessions.intentionallyHiddenRunningPaths, []);
  assert.deepEqual(out.state.transcript.bySession[A], SAMPLE_MESSAGES);
  assert.deepEqual(out.state.composer.activeRunSummaryBySession[A], STALE_RUN_SUMMARY);
  assert.deepEqual(out.effects.map((effect) => effect.kind), ['PersistTabs', 'InterruptRpc']);
  assert.equal(out.state.operations['session.close:c3']?.closeMode, 'stop-cleanup');
});

test('a failed running close restores the tab without taking focus and retains the running session', () => {
  const state = buildState({ runningPaths: [A], activePath: B, openTabs: [A, B] });
  const started = reducer(state, closeCmd('c3-failed', A));
  const operationId = 'session.close:c3-failed';
  const interrupt = started.effects.find((effect) => effect.kind === 'InterruptRpc');
  assert.equal(interrupt?.kind, 'InterruptRpc');
  if (interrupt?.kind !== 'InterruptRpc') return;

  const persisted = reducer(started.state, {
    kind: 'PersistTabsResult', corrId: 'c3-failed', operationId, backendGeneration: 0, ok: true,
  });
  const failed = reducer(persisted.state, {
    kind: 'InterruptResult', corrId: 'c3-failed', operationId: interrupt.operationId,
    operationAttempt: 1, backendGeneration: interrupt.backendGeneration,
    sessionPath: A, ok: false, error: 'stop failed',
  });

  assert.equal(failed.state.operations[operationId]?.terminal?.outcome, 'failed');
  assert.deepEqual(failed.state.sessions.openTabPaths, [B, A]);
  assert.equal(failed.state.sessions.activeSessionPath, B);
  assert.deepEqual(failed.state.sessions.runningSessionPaths, [A]);
  assert.ok(failed.effects.some((effect) => effect.kind === 'PersistTabs'));
  assert.ok(!failed.effects.some((effect) => effect.kind === 'NotifySessionViewed'));
});

test('failed idle cleanup restores its surviving tab without refocusing it', () => {
  const started = reducer(buildState({ activePath: B, openTabs: [A, B] }), closeCmd('c-idle-failed', A));
  const operationId = 'session.close:c-idle-failed';
  const persisted = reducer(started.state, {
    kind: 'PersistTabsResult', corrId: 'c-idle-failed', operationId, backendGeneration: 0, ok: true,
  });
  const failed = reducer(persisted.state, {
    kind: 'CloseSessionResult', corrId: 'c-idle-failed', operationId,
    backendGeneration: 0, sessionPath: A, ok: false, error: 'cleanup failed',
  });

  assert.equal(failed.state.operations[operationId]?.terminal?.outcome, 'failed');
  assert.deepEqual(failed.state.sessions.openTabPaths, [B, A]);
  assert.equal(failed.state.sessions.activeSessionPath, B);
  assert.ok(failed.effects.some((effect) => effect.kind === 'PersistTabs'));
});

test('duplicate or stale CloseSession command for an already hidden tab is idempotent', () => {
  const state = buildState({ openTabs: [A, B], activePath: B });
  const first = reducer(state, closeCmd('c3-first', A));
  const duplicate = reducer(first.state, closeCmd('c3-duplicate', A));

  assert.equal(duplicate.state, first.state);
  assert.deepEqual(duplicate.effects, []);
});

test('SessionScopeCleared after close cleanup clears the active-run summary', () => {
  const state = buildState({
    activeRunSummaries: { [A]: STALE_RUN_SUMMARY },
    activePath: B,
    openTabs: [A, B],
  });
  const closed = reducer(state, closeCmd('c4', A));
  const out = reducer(closed.state, {
    kind: 'SessionScopeCleared', sessionPath: A, removeSessionSummary: false,
  });

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

test('host cleanup clears per-session keyed maps after close retains them', () => {
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
  const closed = reducer(state, closeCmd('c9', A));
  assert.equal(A in closed.state.transcript.bySession, true);
  const out = reducer(closed.state, {
    kind: 'SessionScopeCleared', sessionPath: A, removeSessionSummary: false,
  });

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
