import test from 'node:test';
import assert from 'node:assert/strict';

import { renderList, minifyDiff, renderDiffs } from '../render';
import type { FileChange } from '../types';
import type { DiffOutput } from '../diff';

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

test('minifyDiff: preserves header-like changed lines inside a hunk', () => {
  const body = '@@ -1 +1 @@\n--- old option\n+++ new option';
  assert.equal(minifyDiff(`diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n${body}\n`), body);
});

test('renderDiffs: oversized first hunk and file are bounded with continuation', () => {
  const body = '@@ -0,0 +1,2000 @@\n' + Array.from({ length: 2000 }, (_, i) => `+${i}${'x'.repeat(100)}`).join('\n');
  const out = renderDiffs([diffOut('large.ts', 'created', body)]);
  assert.ok(out.length <= 8000, `got ${out.length} characters`);
  assert.match(out, /offset=\d+/);
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

// ─── renderDiffs (header + per-file/total budgeting) ────────────────────────

test('renderDiffs: header line carries kind/path/churn/baseline, then body', () => {
  const out = renderDiffs([diffOut('src/f.ts', 'modified', '@@ -1 +1 @@\n-a\n+b', 'deadbeef', 1, 1)]);
  const lines = out.split('\n');
  assert.match(lines[0]!, /Current Git changes, not session-only edits/);
  assert.equal(lines[1], 'M src/f.ts recorded=+1/-1 baseline=deadbeef');
  assert.equal(lines[2], '@@ -1 +1 @@');
  assert.equal(lines[3], '-a');
  assert.equal(lines[4], '+b');
});

test('renderDiffs: staged addition is labelled as current Git against HEAD', () => {
  const out = renderDiffs([diffOut('src/new.ts', 'created', '@@ -0,0 +1,1 @@\n+hi', 'HEAD', 1, 0)]);
  assert.match(out, /^A src\/new.ts recorded=\+1\/-0 baseline=HEAD/m);
});

test('renderDiffs: note replaces a missing body inline', () => {
  const out = renderDiffs([diffOut('src/x.ts', 'modified', '', 'HEAD', 0, 0, 'no git baseline; use read to view')]);
  const lines = out.split('\n');
  assert.equal(lines[1], 'M src/x.ts recorded=+0/-0 baseline=HEAD');
  assert.equal(lines[2], 'no git baseline; use read to view');
  assert.equal(lines.length, 3);
});

test('renderDiffs: per-file cap returns a bounded page and continuation', () => {
  // Build a body of many small hunks so the per-file (~8KB) cap bites mid-way.
  const hunks: string[] = [];
  for (let i = 0; i < 500; i++) hunks.push(`@@ -${i},1 +${i},1 @@\n-line${i}\n+line${i}X`);
  const body = hunks.join('\n');
  const out = renderDiffs([diffOut('big.ts', 'modified', body, 'HEAD', 500, 500)]);
  assert.match(out, /truncated; next: action=diff, path=\[this file only\], offset=\d+/);
  assert.ok(out.length <= 8000);
  // The entire response, including metadata and recovery guidance, is bounded.
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
  assert.ok(out.length <= 32000);
});

function collectPages(render: (offset: number) => string, budget: number, diff = false): string {
  let offset = 0;
  let combined = '';
  for (let page = 0; page < 100; page++) {
    let text = render(offset);
    assert.ok(text.length <= budget, `page ${page}: ${text.length}`);
    if (diff) text = text.slice(text.indexOf('\n') + 1); // scope disclaimer
    text = text.replace(/^\[continued at offset=\d+\]\n/, '');
    const marker = text.lastIndexOf('\n[truncated; next:');
    if (marker < 0) return combined + text;
    const next = Number(/offset=(\d+)/.exec(text.slice(marker))![1]);
    assert.ok(next > offset, 'pagination must make progress');
    combined += text.slice(0, marker);
    assert.equal(combined.length, next);
    offset = next;
  }
  assert.fail('pagination did not terminate');
}

test('diff pagination recovers every character of an oversized deletion and giant line', () => {
  for (const body of [
    '@@ -1,2000 +0,0 @@\n' + Array.from({ length: 2000 }, (_, i) => `-${i}${'x'.repeat(100)}`).join('\n'),
    '@@ -1 +1 @@\n-' + '😀'.repeat(20000) + '\n+replacement',
  ]) {
    const result = diffOut('deleted.ts', 'deleted', body, 'HEAD', 0, 2000);
    const all = collectPages((offset) => renderDiffs([result], offset), 8000, true);
    assert.equal(all, `D deleted.ts recorded=+0/-2000 baseline=HEAD\n${body}`);
  }
});

test('even oversized path metadata is bounded and recoverable', () => {
  const result = diffOut('p'.repeat(40000), 'modified', '@@ -1 +1 @@\n-a\n+b');
  const all = collectPages((offset) => renderDiffs([result], offset), 8000, true);
  assert.equal(all, `M ${result.path} recorded=+5/-2 baseline=abc1234\n${result.body}`);
});

test('large manifests are bounded and all paths survive pagination', () => {
  const changes = Array.from({ length: 3000 }, (_, i) => change(`src/file-${i}.ts`, 'modified', 1, 1));
  const all = collectPages((offset) => renderList(changes, offset), 32000);
  for (const c of changes) assert.ok(all.includes(`M\t${c.path}\t+1\t-1\n`));
  assert.match(all, /^3000 \+3000 -3000/);
});
