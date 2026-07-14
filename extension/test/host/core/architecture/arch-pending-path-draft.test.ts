/**
 * Regression: composer draft must follow a pending session path when it
 * resolves to the real backend path.
 *
 * Bug: `handlePendingPathReplaced` migrated every per-session keyed map that
 * the composer cares about (pendingComposerInputsBySession, activeRunSummary-
 * BySession, analyticsFactorsBySession, sendQueueBySession) EXCEPT
 * `composer.draftTextBySession`. The user's in-progress draft, posted under
 * the pending path while the backend was creating the session, was orphaned on
 * the now-defunct pending path. The projected `draftText` for the resolved
 * session fell back to '' and the webview's `[sessionPath]` seed effect then
 * cleared whatever the user had typed — "some of their message getting cut
 * off" once the session finished loading.
 *
 * This mirrors the migration already applied to the sibling composer maps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import { selectViewState } from '../../../../src/host/core/projection';
import { PENDING_SESSION_PREFIX } from '../../../../src/shared/tab-behavior';
import type { SessionSummary } from '../../../../src/shared/protocol';

const PENDING = `${PENDING_SESSION_PREFIX}abc-123`;
const RESOLVED = '/workspace/sessions/real-session.jsonl';

function placeholderSummary(path: string, name = 'New Chat'): SessionSummary {
  return {
    path,
    name,
    cwd: '/workspace',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
}

function buildState(overrides: Partial<ArchState> = {}): ArchState {
  return { ...initialArchState, ...overrides };
}

function pendingPathReplaced(oldPendingPath: string, newSessionPath: string): Event {
  return { kind: 'PendingPathReplaced', oldPendingPath, newSessionPath };
}

function selectSession(sessionPath: string): Event {
  return {
    kind: 'Command',
    cmd: { kind: 'SelectSession', corrId: `select:${sessionPath}`, sessionPath },
  };
}

test('PendingPathReplaced: migrates draftTextBySession from pending to resolved path', () => {
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
    composer: {
      ...initialArchState.composer,
      draftTextBySession: { [PENDING]: 'hello world' },
    },
  });

  const out = reducer(state, pendingPathReplaced(PENDING, RESOLVED));

  // The draft followed the session to its real path…
  assert.equal(out.state.composer.draftTextBySession[RESOLVED], 'hello world');
  // …and was removed from the defunct pending path (no orphan).
  assert.equal(out.state.composer.draftTextBySession[PENDING], undefined);
});

test('PendingPathReplaced: does not clobber a resolved-path draft when the pending path has none', () => {
  // A pre-existing draft under the resolved path (e.g. reopened session) must
  // survive a pending→resolved replacement that carries no pending draft.
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
    composer: {
      ...initialArchState.composer,
      draftTextBySession: { [RESOLVED]: 'resolved draft' },
    },
  });

  const out = reducer(state, pendingPathReplaced(PENDING, RESOLVED));

  assert.equal(out.state.composer.draftTextBySession[RESOLVED], 'resolved draft');
  assert.equal(out.state.composer.draftTextBySession[PENDING], undefined);
});

test('PendingPathReplaced: active session draft survives resolution (no orphaning at the projection seam)', () => {
  // Models the real attach.ts sequence: PendingPathReplaced followed by
  // SelectSession(resolved). Before the fix the projected draftText dropped
  // to '' because the draft was orphaned on the pending path.
  const state = buildState({
    sessions: {
      ...initialArchState.sessions,
      sessions: [placeholderSummary(PENDING)],
      openTabPaths: [PENDING],
      activeSessionPath: PENDING,
    },
    composer: {
      ...initialArchState.composer,
      draftTextBySession: { [PENDING]: 'hello world' },
    },
  });

  let s = reducer(state, pendingPathReplaced(PENDING, RESOLVED)).state;
  s = reducer(s, selectSession(RESOLVED)).state;

  assert.equal(selectViewState(s).draftText, 'hello world');
});
