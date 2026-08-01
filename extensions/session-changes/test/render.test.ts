import test from 'node:test';
import assert from 'node:assert/strict';

import { renderList, minifyDiff, syntheticCreatedDiff, renderDiffs } from '../src/render';
import type { FileChange } from '../src/types';
import type { DiffOutput } from '../src/diff';

function change(path: string, kind: FileChange['kind'], additions = 0, deletions = 0): FileChange {
  return { path, kind, toolCallId: 't', messageId: 'm', description: '', timestamp: '', additions, deletions };
}
function diffOut(
  path: string,
  kind: DiffOutput['kind'],
  body: string,
  baseline = 'abc1234',
  additions = 5,
  deletions = 2,
  note?: string,
): DiffOutput {
  return { kind, path, additions, deletions, baseline, body, note };
}

// ─── renderList (TSV) ───────────────────────────────────────────────────────

test('renderList: empty manifest has a clear empty message', () => {
  assert.equal(renderList([]), 'No file changes derived from this session.');
});

test('renderList: totals line + one TSV row per file (M/A/D codes)', () => {
  const out = renderList([
    change('src/widget.ts', 'modified', 5, 2),
    change('src/new.ts', 'created', 9, 0),
    change('src/old.ts', 'deleted', 0, 3),
  ]);
  const lines = out.split('\n');
  assert.equal(lines[0], '3 +14 -5 (1c/1m/1d)');
  assert.equal(lines[1], 'M\tsrc/widget.ts\t+5\t-2');
  assert.equal(lines[2], 'A\tsrc/new.ts\t+9\t-0');
  assert.equal(lines[3], 'D\tsrc/old.ts\t+0\t-3');
});

// ─── minifyDiff ─────────────────────────────────────────────────────────────

test('minifyDiff: drops the 4-line git preamble, keeps @@ hunks + diff lines', () => {
  const raw = [
    'diff --git a/f.ts b/f.ts',
    'index 111..222 100644',
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -1,2 +1,2 @@ function foo() {',
    '-old',
    '+new',
    ' context',
  ].join('\n');
  assert.equal(
    minifyDiff(raw),
    '@@ -1,2 +1,2 @@ function foo() {\n-old\n+new\n context',
  );
});

test('minifyDiff: empty input → empty string', () => {
  assert.equal(minifyDiff(''), '');
});

test('minifyDiff: trims a trailing blank line', () => {
  const raw = 'diff --git a/f b/f\nindex 1..2\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n+a\n';
  assert.equal(minifyDiff(raw), '@@ -1 +1 @@\n+a');
});

test('minifyDiff: normalizes CRLF external diff output', () => {
  const raw = 'diff --git a/f b/f\r\nindex 1..2\r\n--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
  assert.equal(minifyDiff(raw), '@@ -1 +1 @@\n-old\n+new');
});

// ─── syntheticCreatedDiff ───────────────────────────────────────────────────

test('syntheticCreatedDiff: full content as additions with a creation hunk header', () => {
  assert.equal(
    syntheticCreatedDiff('a\nb\nc'),
    '@@ -0,0 +1,3 @@\n+a\n+b\n+c',
  );
});

test('syntheticCreatedDiff: trailing newline does not inflate the line count', () => {
  assert.equal(
    syntheticCreatedDiff('a\nb\n'),
    '@@ -0,0 +1,2 @@\n+a\n+b',
  );
});

test('syntheticCreatedDiff: normalizes CRLF file content', () => {
  assert.equal(
    syntheticCreatedDiff('a\r\nb\r\n'),
    '@@ -0,0 +1,2 @@\n+a\n+b',
  );
});

test('syntheticCreatedDiff: empty content → empty body', () => {
  assert.equal(syntheticCreatedDiff(''), '');
});

// ─── renderDiffs (header + per-file/total budgeting) ────────────────────────

test('renderDiffs: header line carries kind/path/churn/baseline, then body', () => {
  const out = renderDiffs([diffOut('src/f.ts', 'modified', '@@ -1 +1 @@\n-a\n+b', 'deadbeef', 1, 1)]);
  const lines = out.split('\n');
  assert.equal(lines[0], 'M src/f.ts +1 -1 baseline=deadbeef');
  assert.equal(lines[1], '@@ -1 +1 @@');
  assert.equal(lines[2], '-a');
  assert.equal(lines[3], '+b');
});

test('renderDiffs: created file uses baseline=(new file)', () => {
  const out = renderDiffs([diffOut('src/new.ts', 'created', '@@ -0,0 +1,1 @@\n+hi', '(new file)', 1, 0)]);
  assert.ok(out.startsWith('A src/new.ts +1 -0 baseline=(new file)'));
});

test('renderDiffs: note replaces a missing body inline', () => {
  const out = renderDiffs([diffOut('src/x.ts', 'modified', '', 'HEAD', 0, 0, 'no git baseline; use read to view')]);
  const lines = out.split('\n');
  assert.equal(lines[0], 'M src/x.ts +0 -0 baseline=HEAD');
  assert.equal(lines[1], 'no git baseline; use read to view');
  assert.equal(lines.length, 2);
});

test('renderDiffs: per-file cap truncates at a hunk boundary + reports omitted hunks', () => {
  // Build a body of many small hunks so the per-file (~8KB) cap bites mid-way.
  const hunks: string[] = [];
  for (let i = 0; i < 500; i++) hunks.push(`@@ -${i},1 +${i},1 @@\n-line${i}\n+line${i}X`);
  const body = hunks.join('\n');
  const out = renderDiffs([diffOut('big.ts', 'modified', body, 'HEAD', 500, 500)]);
  assert.match(out, /truncated, \d+ hunk(s)? omitted/);
  // The kept body must be ≤ the per-file cap (header + notice excluded from body
  // budget, but the body itself should not exceed ~8KB).
  assert.ok(body.length > 8000, 'fixture should be large enough to trigger the cap');
});

test('renderDiffs: total budget omits trailing files with a count notice', () => {
  // Many files each with a sizable body → total (~32KB) cap omits the tail.
  const files: DiffOutput[] = [];
  for (let i = 0; i < 50; i++) {
    files.push(diffOut(`f${i}.ts`, 'modified', '@@ -1 +1 @@\n-' + 'x'.repeat(700), 'HEAD', 1, 1));
  }
  const out = renderDiffs(files);
  assert.match(out, /more files? omitted/);
});
