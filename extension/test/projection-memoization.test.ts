/**
 * Brief G — Projection memoization & render-path performance.
 *
 * Asserts the §9 acceptance criteria:
 *  - unchanged-delta projection is O(1) amortized (same-reference return);
 *  - structural sharing: a genuine recompute reuses references for slices the
 *    delta did not touch, so the webview's pickStable / memo barriers stay
 *    effective;
 *  - the cache is scoped to the ACTIVE session, so a background session
 *    streaming does not bust the active view's projection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../src/host/core/arch-state';
import { selectViewState } from '../src/host/core/projection';
import type { ChatMessage } from '../src/shared/protocol';

const SESSION_A = '/ws/session-a';
const SESSION_B = '/ws/session-b';

function assistantMsg(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    createdAt: '',
    markdown: '',
    status: 'completed',
  };
}

function sessionSummary(path: string, messageCount = 0) {
  return { path, name: path, cwd: '/', modifiedAt: '', messageCount };
}

function stateWithActiveSession(path: string, transcript: ChatMessage[] = []): ArchState {
  return produce(createInitialArchState(), (draft) => {
    draft.sessions.sessions = [sessionSummary(path, transcript.length)];
    draft.sessions.openTabPaths = [path];
    draft.sessions.activeSessionPath = path;
    draft.transcript.bySession[path] = transcript;
  });
}

test('projection memoization: same signature returns the SAME ViewState reference (O(1) cache hit)', () => {
  const state = stateWithActiveSession(SESSION_A, [assistantMsg('m1')]);

  const first = selectViewState(state);
  const second = selectViewState(state);

  // Cache hit: identical top-level reference, not a recomputed copy.
  assert.equal(second, first);
  // Slice references are identical too (the whole object is shared on a hit).
  assert.equal(second.transcript, first.transcript);
  assert.equal(second.prefs, first.prefs);
  assert.equal(second.pruningSettings, first.pruningSettings);
  assert.equal(second.sessions, first.sessions);
});

test('projection memoization: unchanged-delta posts are O(1) amortized (1000 repeated hits)', () => {
  const state = stateWithActiveSession(SESSION_A, [assistantMsg('m1')]);

  const first = selectViewState(state);

  // Simulate the hot unchanged-delta path: the host re-posts without any
  // state change (token-rate tick, debounced re-flush, watchdog resnapshot,
  // no-op backend event). Every call must return the cached reference — no
  // recomputation, no transcript walk, no pruning derivation.
  let prev = first;
  for (let i = 0; i < 1000; i++) {
    const next = selectViewState(state);
    assert.equal(next, prev, `iteration ${i} should be a cache hit`);
    prev = next;
  }
  // Amortized cost is O(1): 1000 hits cost ~1000 pointer comparisons. The
  // O(transcript) pruning scan never re-runs for an unchanged signature.
  assert.equal(prev, first);
});

test('projection memoization: a background session streaming does NOT bust the active view cache', () => {
  // Active session A with one message; background session B exists but empty.
  const state = produce(stateWithActiveSession(SESSION_A, [assistantMsg('a1')]), (draft) => {
    draft.sessions.sessions.push(sessionSummary(SESSION_B));
    draft.transcript.bySession[SESSION_B] = [];
  });

  const first = selectViewState(state);

  // B streams a delta while A stays active and unchanged. The whole
  // `transcript` slice gets a new reference (Immer rewrote bySession for B),
  // but A's active-session sub-references are untouched — the cache must
  // still hit for A's view. This is the active-session scoping that makes
  // background streaming O(1) for the viewed session.
  const stateAfterBDelta = produce(state, (draft) => {
    draft.transcript.bySession[SESSION_B] = [assistantMsg('b1')];
  });
  const second = selectViewState(stateAfterBDelta);

  assert.equal(second, first, 'active view projection should be a cache hit despite background streaming');
});

test('projection memoization: a genuine active-session delta recomputes but keeps unchanged slices referentially stable', () => {
  const state = stateWithActiveSession(SESSION_A, [assistantMsg('a1')]);
  const first = selectViewState(state);

  // Append a real delta to the ACTIVE session → signature changes → recompute.
  const stateAfterDelta = produce(state, (draft) => {
    draft.transcript.bySession[SESSION_A] = [assistantMsg('a1'), assistantMsg('a2')];
  });
  const second = selectViewState(stateAfterDelta);

  // Cache miss: a fresh ViewState with the grown transcript.
  assert.notEqual(second, first);
  assert.equal(second.transcript.length, 2);

  // Structural sharing on a miss: slices the delta did not touch keep their
  // references, so the webview's pickStable/memo barriers skip re-rendering
  // them. (prefs/pruningSettings/sessions/modelSettings all flow through by
  // reference from ArchState slices that the transcript delta never touched.)
  assert.equal(second.prefs, first.prefs, 'prefs unchanged → same reference');
  assert.equal(second.pruningSettings, first.pruningSettings, 'pruningSettings unchanged → same reference');
  assert.equal(second.sessions, first.sessions, 'sessions slice unchanged → same reference');
  assert.equal(second.modelSettings, first.modelSettings, 'modelSettings unchanged → same reference');
});

test('projection memoization: switching active session busts the cache', () => {
  const stateA = produce(stateWithActiveSession(SESSION_A, [assistantMsg('a1')]), (draft) => {
    draft.sessions.sessions.push(sessionSummary(SESSION_B));
    draft.transcript.bySession[SESSION_B] = [assistantMsg('b1')];
  });
  const first = selectViewState(stateA);
  assert.equal(first.transcript[0]?.id, 'a1');

  // Switch active session → activeSessionPath changes → signature changes →
  // recompute, now projecting B's transcript.
  const stateB = produce(stateA, (draft) => {
    draft.sessions.activeSessionPath = SESSION_B;
  });
  const second = selectViewState(stateB);

  assert.notEqual(second, first);
  assert.equal(second.transcript[0]?.id, 'b1');
});

test('projection memoization: toggling pruning visibility busts the cache (settings reference changes)', () => {
  const state = stateWithActiveSession(SESSION_A, [assistantMsg('a1')]);
  const first = selectViewState(state);

  // Flipping a prefs flag goes through Immer → settings gets a new reference
  // → signature changes → recompute (the pruning banner depends on prefs).
  const stateAfterToggle = produce(state, (draft) => {
    draft.settings.prefs = { ...draft.settings.prefs, showPruningMessages: !draft.settings.prefs.showPruningMessages };
  });
  const second = selectViewState(stateAfterToggle);

  assert.notEqual(second, first, 'a settings change must bust the cache');
});
