import assert from 'node:assert/strict';
import test from 'node:test';

import {
  basename,
  computeDiffTotals,
  computeKindStats,
  KIND_LABEL,
  KIND_ORDER,
} from '../../../src/webview/panel/file-changes-stats';
import type { FileChangeEntry, FileChangeKind } from '../../../src/shared/protocol';

function entry(
  path: string,
  kind: FileChangeKind,
  additions?: number,
  deletions?: number,
): FileChangeEntry {
  return {
    path,
    kind,
    toolCallId: 'tc',
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    additions,
    deletions,
  };
}

const ALL_KINDS: FileChangeKind[] = ['created', 'modified', 'deleted'];

// ── computeDiffTotals ─────────────────────────────────────────────────────

test('computeDiffTotals returns zero for an empty change list', () => {
  assert.deepEqual(computeDiffTotals([]), { additions: 0, deletions: 0 });
});

test('computeDiffTotals sums additions/deletions exactly across mixed kinds', () => {
  const changes = [
    entry('src/new.ts', 'created', 120, 0),
    entry('src/tweak.ts', 'modified', 45, 12),
    entry('src/fix.ts', 'modified', 0, 8),
    entry('src/old.ts', 'deleted', 0, 200),
  ];
  // 120 + 45 + 0 + 0 = 165 additions
  // 0 + 12 + 8 + 200 = 220 deletions
  assert.deepEqual(computeDiffTotals(changes), { additions: 165, deletions: 220 });
});

test('computeDiffTotals treats omitted additions/deletions as zero', () => {
  const changes = [
    entry('src/no-stats.ts', 'modified'),
    entry('src/with-stats.ts', 'modified', 7, 3),
  ];
  assert.deepEqual(computeDiffTotals(changes), { additions: 7, deletions: 3 });
});

test('computeDiffTotals is resilient to negative and large values', () => {
  const changes = [
    entry('src/big-add.ts', 'created', 1_000_000, 0),
    entry('src/big-del.ts', 'deleted', 0, 9_999_999),
  ];
  assert.deepEqual(computeDiffTotals(changes), {
    additions: 1_000_000,
    deletions: 9_999_999,
  });
});

// ── computeKindStats ────────────────────────────────────────────────────────

test('computeKindStats groups counts, additions, and deletions by kind', () => {
  const changes = [
    entry('a.ts', 'created', 10, 0),
    entry('b.ts', 'created', 5, 0),
    entry('c.ts', 'modified', 3, 7),
    entry('d.ts', 'deleted', 0, 4),
    entry('e.ts', 'deleted', 0, 6),
  ];
  const stats = computeKindStats(changes);

  assert.deepEqual(stats.created, { count: 2, additions: 15, deletions: 0 });
  assert.deepEqual(stats.modified, { count: 1, additions: 3, deletions: 7 });
  assert.deepEqual(stats.deleted, { count: 2, additions: 0, deletions: 10 });
});

test('computeKindStats initializes every kind to zero', () => {
  const stats = computeKindStats([]);
  assert.deepEqual(stats.created, { count: 0, additions: 0, deletions: 0 });
  assert.deepEqual(stats.modified, { count: 0, additions: 0, deletions: 0 });
  assert.deepEqual(stats.deleted, { count: 0, additions: 0, deletions: 0 });
});

test('computeKindStats file total equals the number of entries', () => {
  const changes = [
    entry('a.ts', 'created', 1, 0),
    entry('b.ts', 'modified', 2, 2),
    entry('c.ts', 'deleted', 0, 1),
    entry('d.ts', 'created', 0, 0),
  ];
  const stats = computeKindStats(changes);
  const totalFiles = stats.created.count + stats.modified.count + stats.deleted.count;
  assert.equal(totalFiles, changes.length);
});

// ── KIND_LABEL / KIND_ORDER ─────────────────────────────────────────────────

test('KIND_LABEL has a user-facing label for every FileChangeKind', () => {
  for (const kind of ALL_KINDS) {
    const label = KIND_LABEL[kind];
    assert.ok(typeof label === 'string' && label.length > 0, `missing label for ${kind}`);
    assert.doesNotMatch(label, /undefined/);
  }
});

test('KIND_LABEL values match the canonical user-facing names', () => {
  assert.equal(KIND_LABEL.created, 'Added');
  assert.equal(KIND_LABEL.modified, 'Modified');
  assert.equal(KIND_LABEL.deleted, 'Deleted');
});

test('KIND_ORDER contains every kind exactly once and no extras', () => {
  const kinds = KIND_ORDER.map((k) => k.kind);
  assert.deepEqual(new Set(kinds), new Set(ALL_KINDS));
  assert.equal(kinds.length, ALL_KINDS.length);
});

test('KIND_ORDER labels are non-empty and match KIND_LABEL', () => {
  for (const { kind, label } of KIND_ORDER) {
    assert.equal(label, KIND_LABEL[kind]);
    assert.ok(label.length > 0);
  }
});

// ── basename ──────────────────────────────────────────────────────────────

test('basename returns the last segment of Unix paths', () => {
  assert.equal(basename('/home/user/project/file.ts'), 'file.ts');
  assert.equal(basename('src/components/button.tsx'), 'button.tsx');
  assert.equal(basename('just-a-file.md'), 'just-a-file.md');
});

test('basename returns the last segment of Windows paths', () => {
  assert.equal(basename('C:\\Users\\user\\project\\file.ts'), 'file.ts');
  assert.equal(basename('src\\components\\button.tsx'), 'button.tsx');
  assert.equal(basename('D:\\just-a-file.md'), 'just-a-file.md');
});

test('basename handles mixed separators', () => {
  assert.equal(basename('C:/Users\\user/project\\file.ts'), 'file.ts');
});

test('basename strips trailing separators', () => {
  assert.equal(basename('/home/user/project/'), 'project');
  assert.equal(basename('C:\\Users\\user\\'), 'user');
  assert.equal(basename('relative/dir/'), 'dir');
});

test('basename returns the original path for root and single-segment paths', () => {
  assert.equal(basename('/'), '/');
  assert.equal(basename('C:\\'), 'C:\\');
  assert.equal(basename('file.ts'), 'file.ts');
});

test('basename handles empty and whitespace-only paths', () => {
  assert.equal(basename(''), '');
  assert.equal(basename('   '), '   ');
});
