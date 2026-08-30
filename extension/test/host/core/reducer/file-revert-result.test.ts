import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { FileChangeEntry } from '../../../../src/shared/protocol';

/**
 * `FileRevertResult` settlement: the changed-file row is removed from the
 * reducer only AFTER the revert effect confirms success, and a failed or
 * cancelled revert must leave the row present (the file still carries its
 * changes). This replaces the old eager `FileChangeRemoved` dispatch from the
 * message router, which lost the row on browser-declined confirms or revert
 * failures before the menu made Revert a first-class row action.
 */

function change(path: string): FileChangeEntry {
  return {
    path,
    kind: 'modified',
    additions: 3,
    deletions: 1,
    toolCallId: 'tc-1',
    messageId: 'm1',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function stateWithChanges(opts: {
  sessionPath: string;
  paths: string[];
}): ArchState {
  return {
    ...initialArchState,
    fileChanges: {
      ...initialArchState.fileChanges,
      bySession: { [opts.sessionPath]: opts.paths.map(change) },
    },
  };
}

test('FileRevertResult (ok) removes only the matching row for the matching session', () => {
  const state = {
    ...initialArchState,
    fileChanges: {
      ...initialArchState.fileChanges,
      bySession: {
        '/sessions/a': [change('src/a.ts'), change('src/b.ts'), change('src/c.ts')],
        '/sessions/b': [change('src/z.ts')],
      },
    },
  };
  const otherRows = state.fileChanges.bySession['/sessions/b'];
  const result = reducer(state, {
    kind: 'FileRevertResult',
    corrId: 'c1',
    sessionPath: '/sessions/a',
    filePath: 'src/b.ts',
    ok: true,
  });
  assert.deepEqual(result.state.fileChanges.bySession['/sessions/a'], [change('src/a.ts'), change('src/c.ts')]);
  // Unrelated sessions keep their rows (untouched reference).
  assert.equal(result.state.fileChanges.bySession['/sessions/b'], otherRows);
});

test('FileRevertResult (failed) leaves the row present and surfaces an operational notice', () => {
  const state = stateWithChanges({ sessionPath: '/sessions/a', paths: ['src/a.ts', 'src/b.ts'] });
  const result = reducer(state, {
    kind: 'FileRevertResult',
    corrId: 'c6',
    sessionPath: '/sessions/a',
    filePath: 'src/b.ts',
    ok: false,
    error: 'EACCES: permission denied',
  });
  // Both rows stay — the revert never succeeded.
  assert.deepEqual(result.state.fileChanges.bySession['/sessions/a'], [change('src/a.ts'), change('src/b.ts')]);
  assert.equal(result.state.settings.notice, 'Could not revert that file.');
  assert.equal(result.state.settings.noticeKind, 'operational-error');
  assert.equal(result.state.settings.noticeRaw, 'EACCES: permission denied');
  assert.equal(result.state.settings.noticeSessionPath, '/sessions/a');
  assert.deepEqual(result.effects, []);
});

test('FileRevertResult (cancelled) leaves the row present and stays quiet', () => {
  const state = stateWithChanges({ sessionPath: '/sessions/a', paths: ['src/a.ts', 'src/b.ts'] });
  const result = reducer(state, {
    kind: 'FileRevertResult',
    corrId: 'c7',
    sessionPath: '/sessions/a',
    filePath: 'src/b.ts',
    ok: false,
    error: 'cancelled',
  });
  assert.deepEqual(result.state.fileChanges.bySession['/sessions/a'], [change('src/a.ts'), change('src/b.ts')]);
  assert.equal(result.state.settings.notice, null, 'a cancelled confirm is not an error');
  assert.equal(result.state.settings.noticeKind, null);
  assert.deepEqual(result.effects, []);
});

test('FileRevertResult (ok) for a session with no tracked changes keeps state shape intact', () => {
  const state = stateWithChanges({ sessionPath: '/sessions/a', paths: [] });
  const result = reducer(state, {
    kind: 'FileRevertResult',
    corrId: 'c8',
    sessionPath: '/sessions/a',
    filePath: 'src/ghost.ts',
    ok: true,
  });
  assert.deepEqual(result.state.fileChanges.bySession['/sessions/a'], []);
  assert.deepEqual(result.effects, []);
});