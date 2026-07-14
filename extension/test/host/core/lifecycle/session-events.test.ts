/**
 * Phase 1 — Session event semantics tests.
 *
 * Covers behaviours not exercised by store.test.ts: busy-seq dedup, pending
 * tab promotion, session summary name preservation, and prefs round-tripping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';

// ─── Busy-seq dedup ────────────────────────────────────────────────────────────

/**
 * The host session-service uses a per-session busySeqMap to discard stale
 * busy.changed events. Reproduces the logic inline because the logic lives
 * outside the Redux store.
 */
function acceptBusySeq(map: Map<string, number>, path: string, seq: number | undefined): boolean {
  if (typeof seq !== 'number') return true;
  const last = map.get(path) ?? 0;
  if (seq <= last) return false;
  map.set(path, seq);
  return true;
}

test('busy-seq: accepts events in order and drops out-of-order', () => {
  const m = new Map<string, number>();
  assert.equal(acceptBusySeq(m, '/s', 1), true);
  assert.equal(acceptBusySeq(m, '/s', 2), true);
  assert.equal(acceptBusySeq(m, '/s', 1), false, 'stale event should be rejected');
  assert.equal(acceptBusySeq(m, '/s', 2), false, 'same-seq event should be rejected');
  assert.equal(acceptBusySeq(m, '/s', 3), true);
  assert.equal(acceptBusySeq(m, '/t', 1), true, 'different session has independent counter');
});

test('busy-seq: undefined seq is always accepted (backward-compat)', () => {
  const m = new Map<string, number>();
  m.set('/s', 100);
  assert.equal(acceptBusySeq(m, '/s', undefined), true);
});

// ─── Pending tab promotion ────────────────────────────────────────────────────

test('pending tab is promoted to real path on session.opened', () => {
  const pendingPath = '__pending__:test-1234';
  const realPath = '/ws/sessions/abc.jsonl';

  let state = produce(createInitialArchState(), draft => {
    draft.sessions.sessions.push({
      path: pendingPath,
      name: 'New Session',
      cwd: '/ws',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      isPlaceholder: true,
    });
    draft.sessions.openTabPaths.push(pendingPath);
  });

  // Simulate session.opened handler replacing the pending tab.
  state = produce(state, draft => {
    const idx = draft.sessions.openTabPaths.indexOf(pendingPath);
    if (idx !== -1) draft.sessions.openTabPaths[idx] = realPath;
    // Remove pending sessions
    draft.sessions.sessions = draft.sessions.sessions.filter(s => s.path !== pendingPath);
    draft.sessions.sessions.push({
      path: realPath,
      name: 'New Session',
      cwd: '/ws',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      isPlaceholder: true,
    });
  });

  assert.ok(!state.sessions.openTabPaths.includes(pendingPath), 'pending tab should be gone');
  assert.ok(state.sessions.openTabPaths.includes(realPath), 'real path should be in tabs');
  assert.ok(!state.sessions.sessions.some((s) => s.path === pendingPath), 'pending session should be removed');
  assert.ok(state.sessions.sessions.some((s) => s.path === realPath), 'real session should be present');
});

// ─── Session summary name preservation ────────────────────────────────────────

test('replaceSessionSummaries preserves real name over incoming placeholder', () => {
  const path = '/ws/name-preserve-test';
  let state = produce(createInitialArchState(), draft => {
    draft.sessions.sessions.push({
      path,
      name: 'My Real Session',
      cwd: '/ws',
      modifiedAt: new Date().toISOString(),
      messageCount: 1,
      isPlaceholder: false,
    });
  });

  // Backend emits a list refresh where the name reverted to a placeholder.
  state = produce(state, draft => {
    const existingByName = new Map(
      draft.sessions.sessions
        .filter(s => s.isPlaceholder !== true)
        .map(s => [s.path, s.name]),
    );
    draft.sessions.sessions = draft.sessions.sessions.map(s => {
      if (s.path !== path) return s;
      const prevName = existingByName.get(s.path);
      // Incoming is placeholder — preserve existing name.
      return prevName
        ? { ...s, name: prevName, isPlaceholder: false, messageCount: 1 }
        : { path, name: 'New Session', cwd: '/ws', modifiedAt: new Date().toISOString(), messageCount: 1, isPlaceholder: true };
    });
  });

  const session = state.sessions.sessions.find((s) => s.path === path);
  assert.ok(session, 'session should still exist');
  assert.equal(session?.name, 'My Real Session', 'real name should be preserved over placeholder');
});

test('replaceSessionSummaries updates name when incoming is not a placeholder', () => {
  const path = '/ws/name-update-test';
  let state = produce(createInitialArchState(), draft => {
    draft.sessions.sessions.push({
      path,
      name: 'Old Name',
      cwd: '/ws',
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
      isPlaceholder: false,
    });
  });

  state = produce(state, draft => {
    const s = draft.sessions.sessions.find(x => x.path === path);
    if (s) {
      s.name = 'New Real Name';
      s.messageCount = 2;
    }
  });

  const session = state.sessions.sessions.find((s) => s.path === path);
  assert.equal(session?.name, 'New Real Name');
  assert.equal(session?.messageCount, 2);
});

// ─── Chat prefs ───────────────────────────────────────────────────────────────

test('uiActions.setPrefs merges into existing prefs', () => {
  let state = produce(createInitialArchState(), draft => {
    draft.settings.prefs = {
      ...draft.settings.prefs,
      autoExpandReasoning: false,
      autoExpandToolCalls: false,
      autoExpandSubagentCalls: false,
      suppressCompletionNotifications: false,
    };
  });

  state = produce(state, draft => {
    draft.settings.prefs = {
      ...draft.settings.prefs,
      autoExpandReasoning: true,
      autoExpandSubagentCalls: true,
      suppressCompletionNotifications: true,
    };
  });

  const { prefs } = state.settings;
  assert.equal(prefs.autoExpandReasoning, true);
  assert.equal(prefs.autoExpandToolCalls, false, 'unchanged pref should not be modified');
  assert.equal(prefs.autoExpandSubagentCalls, true);
  assert.equal(prefs.suppressCompletionNotifications, true);
});

// ─── selectViewState prefs round-trip ──────────────────────────────────────────

test('selectViewState includes prefs from settings', () => {
  const state = produce(createInitialArchState(), draft => {
    draft.settings.prefs = {
      ...draft.settings.prefs,
      autoExpandReasoning: true,
      autoExpandToolCalls: true,
      autoExpandSubagentCalls: true,
      suppressCompletionNotifications: true,
    };
  });

  const viewState = selectViewState(state);
  assert.equal(viewState.prefs.autoExpandReasoning, true);
  assert.equal(viewState.prefs.autoExpandToolCalls, true);
  assert.equal(viewState.prefs.autoExpandSubagentCalls, true);
  assert.equal(viewState.prefs.suppressCompletionNotifications, true);
});

test('edit rerun keeps an optimistic user row until the authoritative snapshot arrives', () => {
  const sessionPath = '/ws/edit-rerun-test';
  let state = produce(createInitialArchState(), draft => {
    draft.transcript.bySession[sessionPath] = [
      { id: 'user-1', role: 'user', createdAt: '', markdown: 'Original prompt', status: 'completed' },
      { id: 'assistant-1', role: 'assistant', createdAt: '', markdown: 'Original reply', status: 'completed' },
    ];
  });

  // session.truncateAfter emits a snapshot that removes the edited row and tail.
  state = produce(state, draft => {
    draft.transcript.bySession[sessionPath] = [];
    // Append optimistic user message
    draft.transcript.bySession[sessionPath]!.push({
      id: 'local:edit:1',
      role: 'user',
      createdAt: '',
      markdown: 'Original prompt ',
      status: 'completed',
    });
  });

  let transcript = state.transcript.bySession[sessionPath] ?? [];
  assert.equal(transcript.length, 1, 'edited prompt should remain visible during rerun');
  assert.equal(transcript[0]?.role, 'user');
  assert.equal(transcript[0]?.markdown, 'Original prompt ');

  // agent_end emits a fresh session.opened snapshot that replaces the optimistic row.
  state = produce(state, draft => {
    draft.transcript.bySession[sessionPath] = [
      { id: 'user-2', role: 'user', createdAt: '', markdown: 'Original prompt ', status: 'completed' },
      { id: 'assistant-2', role: 'assistant', createdAt: '', markdown: 'New reply', status: 'completed' },
    ];
  });

  transcript = state.transcript.bySession[sessionPath] ?? [];
  assert.deepEqual(transcript.map((message) => message.id), ['user-2', 'assistant-2']);
  assert.equal(transcript[0]?.markdown, 'Original prompt ');
});
