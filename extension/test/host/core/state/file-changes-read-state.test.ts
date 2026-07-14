/**
 * Read/unread state for the changed-files rail.
 *
 * Read state is host-owned (`FileChangesState.readFilePathsBySession`), lives
 * independently of the derived `bySession` list (so re-derivation never
 * clobbers it), and is email-like: a NEW tool-call modification of an
 * already-read path flips it back to unread. This file covers the SetFileRead
 * command, the email-like un-mark inside FileChangesUpdated, the projection,
 * and session-scope cleanup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { reducer, type ArchState } from '../../../../src/host/core/reducer';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';
import type { Event } from '../../../../src/host/core/events';
import type { FileChangeEntry } from '../../../../src/shared/protocol';

const S = '/a';

function fc(path: string, toolCallId: string, kind: FileChangeEntry['kind'] = 'modified'): FileChangeEntry {
  return {
    path,
    kind,
    toolCallId,
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

/** Apply an event through the reducer and return the resulting state. */
function apply(state: ArchState, event: Event): ArchState {
  return reducer(state, event).state;
}

function setFileRead(state: ArchState, filePath: string, read: boolean): ArchState {
  return apply(state, {
    kind: 'Command',
    cmd: { kind: 'SetFileRead', corrId: `c-${filePath}-${read}`, sessionPath: S, filePath, read },
  });
}

function fileChangesUpdated(state: ArchState, fileChanges: FileChangeEntry[]): ArchState {
  return apply(state, { kind: 'FileChangesUpdated', sessionPath: S, fileChanges });
}

function baseState(): ArchState {
  return {
    ...createInitialArchState(),
    sessions: { ...createInitialArchState().sessions, activeSessionPath: S },
  };
}

// ─── SetFileRead command ────────────────────────────────────────────────────

test('SetFileRead{read:true} adds a path to the per-session read set', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', true);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], ['a.ts']);
});

test('SetFileRead is idempotent — adding twice keeps a single entry', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', true);
  state = setFileRead(state, 'a.ts', true);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], ['a.ts']);
});

test('SetFileRead{read:false} removes a path from the read set', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', true);
  state = setFileRead(state, 'a.ts', false);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], []);
});

test('SetFileRead{read:false} is a no-op when the path was not read', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', false);
  // No spurious empty-array key is created for a no-op un-read.
  assert.equal(S in state.fileChanges.readFilePathsBySession, false);
});

test('SetFileRead is session-scoped — does not touch another session', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', true);
  assert.deepEqual(state.fileChanges.readFilePathsBySession['/other'], undefined);
});

// ─── Email-like un-mark inside FileChangesUpdated ───────────────────────────

test('FileChangesUpdated flips a read file back to unread when its toolCallId changed (new modification)', () => {
  // a.ts was modified by t1 and marked read.
  let state = baseState();
  state = fileChangesUpdated(state, [fc('a.ts', 't1')]);
  state = setFileRead(state, 'a.ts', true);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], ['a.ts']);

  // A new tool call (t2) modifies a.ts again → it should flip back to unread.
  state = fileChangesUpdated(state, [fc('a.ts', 't2')]);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], []);
});

test('FileChangesUpdated keeps a read file read when its toolCallId is unchanged (no new modification)', () => {
  // Re-derivation that produces the SAME toolCallId (e.g. a snapshot re-derive)
  // must not spuriously clear read state.
  let state = baseState();
  state = fileChangesUpdated(state, [fc('a.ts', 't1')]);
  state = setFileRead(state, 'a.ts', true);
  state = fileChangesUpdated(state, [fc('a.ts', 't1')]);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], ['a.ts']);
});

test('FileChangesUpdated leaves read state untouched for a path that dropped out of the list', () => {
  // a.ts was read; a create-then-delete pair removes it from the list. Its
  // stale read entry is harmless (projection intersects with the change list)
  // and must not be wiped — and must not throw.
  let state = baseState();
  state = fileChangesUpdated(state, [fc('a.ts', 't1')]);
  state = setFileRead(state, 'a.ts', true);
  state = fileChangesUpdated(state, []); // a.ts gone
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], ['a.ts']);
});

test('FileChangesUpdated does not clear read state when no paths were read', () => {
  // No read set yet → the un-mark pass is a no-op (and never creates a key).
  let state = baseState();
  state = fileChangesUpdated(state, [fc('a.ts', 't1'), fc('b.ts', 't2')]);
  assert.deepEqual(state.fileChanges.readFilePathsBySession[S], undefined);
});

// ─── Projection ───────────────────────────────────────────────────────────────

test('selectViewState projects readFilePaths for the active session', () => {
  let state = baseState();
  state = fileChangesUpdated(state, [fc('a.ts', 't1'), fc('b.ts', 't2')]);
  state = setFileRead(state, 'a.ts', true);
  const vs = selectViewState(state);
  assert.deepEqual(vs.readFilePaths, ['a.ts']);
  assert.deepEqual(vs.fileChanges.map((c) => c.path), ['a.ts', 'b.ts']);
});

test('selectViewState projects an empty readFilePaths array when none are read', () => {
  const state = baseState();
  const vs = selectViewState(state);
  assert.deepEqual(vs.readFilePaths, []);
});

test('selectViewState projects an empty readFilePaths array when no active session', () => {
  const state = createInitialArchState();
  const vs = selectViewState(state);
  assert.deepEqual(vs.readFilePaths, []);
});

// ─── Session-scope cleanup ───────────────────────────────────────────────────

test('SessionScopeCleared clears the read set for the closed session', () => {
  let state = baseState();
  state = setFileRead(state, 'a.ts', true);
  assert.equal(S in state.fileChanges.readFilePathsBySession, true);
  state = apply(state, { kind: 'SessionScopeCleared', sessionPath: S, removeSessionSummary: false });
  assert.equal(S in state.fileChanges.readFilePathsBySession, false);
});
