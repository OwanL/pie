import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyFileMutationDelta,
  getFileExtensionFromToolCall,
  getFileMutationFromToolCall,
  mergeFileMutationDelta,
} from '../../../src/shared/tool-call-analysis/mutation-file';
import {
  combineEditStats,
  editStatsFromEntry,
  editStatsFromPatchText,
  getEditStatsFromInput,
  getPatchTextFromInput,
  getToolCallSizeHint,
  lineCountFromRecordKeys,
} from '../../../src/shared/tool-call-analysis/mutation-size';
import { hashPath } from '../../../src/shared/tool-call-analysis/mutation-tools';
import type { ToolCall } from '../../../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'bash',
    input: {},
    status: 'completed',
    ...overrides,
  };
}

test('lineCountFromRecordKeys traverses nested text containers and ignores empty or over-deep structures', () => {
  assert.equal(lineCountFromRecordKeys({
    contents: [
      { text: 'one\ntwo\n' },
      { output: 'three' },
    ],
  }, ['contents']), 3);
  assert.equal(lineCountFromRecordKeys({ value: '' }, ['value']), null);
  assert.equal(lineCountFromRecordKeys({ content: { content: { content: { text: 'too deep' } } } }, ['content']), null);
});

test('editStats helpers cover additions, deletions, modifications, arrays, and patch fallback parsing', () => {
  assert.deepEqual(editStatsFromEntry({ newText: 'one\ntwo\n' }), { additions: 2, deletions: 0, modifications: 0 });
  assert.deepEqual(editStatsFromEntry({ old_text: 'one\ntwo\n' }), { additions: 0, deletions: 2, modifications: 0 });
  assert.deepEqual(editStatsFromEntry({ oldText: 'old\n', new_text: 'new\nnext\n' }), { additions: 0, deletions: 0, modifications: 2 });
  assert.equal(editStatsFromEntry({ oldText: 123 }), null);

  assert.deepEqual(combineEditStats(
    { additions: 1, deletions: 2, modifications: 3 },
    { additions: 4, deletions: 5, modifications: 6 },
  ), { additions: 5, deletions: 7, modifications: 9 });

  const patchText = [
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@',
    '-old-1',
    '-old-2',
    '+new-1',
    '+new-2',
    ' context',
    '+added',
    ' context',
    '-removed',
  ].join('\n');
  assert.deepEqual(editStatsFromPatchText(patchText), { additions: 1, deletions: 1, modifications: 2 });
  assert.equal(editStatsFromPatchText('*** Begin Patch\n*** End Patch'), null);

  assert.deepEqual(getEditStatsFromInput({
    changes: [
      { oldText: 'before\n', newText: 'after\n' },
      { new_text: 'added\n' },
      { ignored: true },
    ],
  }), { additions: 1, deletions: 0, modifications: 1 });
  assert.deepEqual(getEditStatsFromInput({ diff: '@@\n-old\n' }), { additions: 0, deletions: 1, modifications: 0 });
  assert.equal(getEditStatsFromInput({ replacements: [{ ignored: true }] }), null);
});

test('getPatchTextFromInput prefers input, then patch, then diff', () => {
  assert.equal(getPatchTextFromInput({ input: 'input patch', patch: 'ignored', diff: 'ignored' }), 'input patch');
  assert.equal(getPatchTextFromInput({ patch: 'patch text', diff: 'ignored' }), 'patch text');
  assert.equal(getPatchTextFromInput({ diff: 'diff text' }), 'diff text');
  assert.equal(getPatchTextFromInput({}), null);
});

test('getToolCallSizeHint handles read, create, edit, and unresolved text-like results', () => {
  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'read_file',
    input: { path: '/workspace/file.ts', startLine: 10, endLine: 20 },
    result: 'a\nb\nc\n',
  })), '3 lines');

  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'read_file',
    input: { path: '/workspace/file.ts', line_count: 4 },
    result: { content: '' },
  })), null);

  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'write_file',
    input: {
      path: '/workspace/generated.ts',
      contents: [
        { text: 'export const one = 1;\n' },
        { output: 'export const two = 2;\n' },
      ],
    },
  })), '+2 lines');

  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'edit',
    input: {
      path: '/workspace/file.ts',
      edits: [{ oldText: '', newText: 'one\ntwo\n' }],
    },
  })), '+2 lines');

  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'edit',
    input: {
      path: '/workspace/file.ts',
      edits: [{ oldText: 'gone\n', newText: '' }],
    },
  })), '-1 line');

  assert.equal(getToolCallSizeHint(makeToolCall({
    name: 'edit',
    input: {
      path: '/workspace/file.ts',
      oldText: 'before\n',
      newText: 'after\nnext\n',
    },
  })), '2 lines');
});

test('getFileMutationFromToolCall covers patch fallbacks, path-based tools, and empty results', () => {
  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: [
        '*** Begin Patch',
        'rename to src/new-name.ts',
        '*** End Patch',
      ].join('\n'),
    },
  })), {
    writeCount: 0,
    editCount: 0,
    deleteCount: 0,
    renameCount: 1,
    touchedFileCount: 1,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: {},
  });

  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: '@@\n-old\n+new\n',
    },
  })), {
    writeCount: 0,
    editCount: 1,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 1,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 1,
    editCountsByFile: {},
    readCountsByFile: {},
  });

  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'rename_file',
    input: { oldPath: 'src/old.ts', newPath: 'src/new.ts' },
  })), {
    writeCount: 0,
    editCount: 0,
    deleteCount: 0,
    renameCount: 1,
    touchedFileCount: 1,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: {},
  });

  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'delete_file',
    input: { filePath: 'src/old.ts' },
  })), {
    writeCount: 0,
    editCount: 0,
    deleteCount: 1,
    renameCount: 0,
    touchedFileCount: 1,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: {},
  });

  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'create_file',
    input: { path: 'src/new.ts', body: 'line one\nline two\n' },
  })), {
    writeCount: 1,
    editCount: 0,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 1,
    lineAdditions: 2,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: {},
  });

  // Edit ops attribute to their file (path-hashed) for the file-churn signal.
  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'edit_file',
    input: { path: 'src/existing.ts', replacements: [{ ignored: true }] },
  })), {
    writeCount: 0,
    editCount: 1,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 1,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: { [hashPath('src/existing.ts')]: 1 },
    readCountsByFile: {},
  });

  // Read ops attribute to their file (path-hashed) for the "files reviewed" +
  // re-read churn signals. Reads are not mutations: they don't touch (modify) a
  // file, so only readCountsByFile is populated (no touchedFileCount bump).
  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'read',
    input: { path: 'src/existing.ts' },
  })), {
    writeCount: 0,
    editCount: 0,
    deleteCount: 0,
    renameCount: 0,
    touchedFileCount: 0,
    lineAdditions: 0,
    lineDeletions: 0,
    lineModifications: 0,
    editCountsByFile: {},
    readCountsByFile: { [hashPath('src/existing.ts')]: 1 },
  });

  // Reads without an extractable path still count via readCountsByExtension;
  // readCountsByFile stays empty (no per-file attribution).
  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'read',
    input: { offset: 10 },
  })), createEmptyFileMutationDelta());

  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({
    name: 'search',
    input: { path: 'src/ignored.ts' },
  })), createEmptyFileMutationDelta());
  assert.deepEqual(getFileMutationFromToolCall(makeToolCall({ input: 'not-an-object' as any })), createEmptyFileMutationDelta());
});

test('file mutation delta helpers return isolated empties, merge counts, and classify file extensions', () => {
  const first = createEmptyFileMutationDelta();
  first.writeCount = 99;
  assert.equal(createEmptyFileMutationDelta().writeCount, 0);

  assert.deepEqual(mergeFileMutationDelta(
    {
      writeCount: 1,
      editCount: 2,
      deleteCount: 3,
      renameCount: 4,
      touchedFileCount: 5,
      lineAdditions: 6,
      lineDeletions: 7,
      lineModifications: 8,
      editCountsByFile: { aaa: 2 },
      readCountsByFile: { xxx: 2 },
    },
    {
      writeCount: 10,
      editCount: 20,
      deleteCount: 30,
      renameCount: 40,
      touchedFileCount: 50,
      lineAdditions: 60,
      lineDeletions: 70,
      lineModifications: 80,
      editCountsByFile: { aaa: 1, bbb: 3 },
      readCountsByFile: { xxx: 1, yyy: 3 },
    },
  ), {
    writeCount: 11,
    editCount: 22,
    deleteCount: 33,
    renameCount: 44,
    touchedFileCount: 55,
    lineAdditions: 66,
    lineDeletions: 77,
    lineModifications: 88,
    editCountsByFile: { aaa: 3, bbb: 3 },
    readCountsByFile: { xxx: 3, yyy: 3 },
  });

  assert.deepEqual(getFileExtensionFromToolCall(makeToolCall({
    name: 'read_file',
    input: { path: '/workspace/README' },
  })), {
    extension: '(none)',
    operation: 'read',
  });
  assert.deepEqual(getFileExtensionFromToolCall(makeToolCall({
    name: 'write_file',
    input: { path: '/workspace/src/APP.TS' },
  })), {
    extension: '.ts',
    operation: 'write',
  });
  assert.equal(getFileExtensionFromToolCall(makeToolCall({ name: 'search', input: { path: '/workspace/src/app.ts' } })), null);
  assert.equal(getFileExtensionFromToolCall(makeToolCall({ name: 'edit_file', input: {} })), null);
});
