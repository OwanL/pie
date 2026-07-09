import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { computeFileDiff } from '../src/diff';
import type { DiffInput } from '../src/diff';

const execFileP = promisify(execFile);

async function git(dir: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileP('git', args, { cwd: dir, maxBuffer: 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string };
    if (typeof err.code === 'number') return { stdout: err.stdout ?? '', code: err.code };
    throw e;
  }
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function withTempRepo(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-diff-'));
  try {
    await initRepo(dir);
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function input(absPath: string, kind: DiffInput['kind'], relPath?: string, context = 0): DiffInput {
  return { relPath: relPath ?? absPath, absPath, kind, context };
}

// ─── created: full content as additions (no git baseline needed) ────────────

test('computeFileDiff: created file → synthetic all-additions body, baseline=(new file)', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'new.ts');
    await fs.writeFile(file, 'a\nb\nc');
    const out = await computeFileDiff(input(file, 'created', 'new.ts'));
    assert.equal(out.kind, 'created');
    assert.equal(out.baseline, '(new file)');
    assert.equal(out.body, '@@ -0,0 +1,3 @@\n+a\n+b\n+c');
  });
});

test('computeFileDiff: created file missing on disk → note, empty body', async () => {
  await withTempRepo(async (dir) => {
    const out = await computeFileDiff(input(path.join(dir, 'gone.ts'), 'created', 'gone.ts'));
    assert.equal(out.body, '');
    assert.match(out.note!, /no longer exists on disk/);
  });
});

// ─── modified: diff against the pre-change baseline (not bare HEAD) ─────────

test('computeFileDiff: modified committed change → diff vs pre-change baseline', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'v1\n');
    const initial = await commit(dir, 'initial');
    await fs.writeFile(file, 'v2\n');
    await commit(dir, 'agent change'); // working tree clean (== HEAD)

    const out = await computeFileDiff(input(file, 'modified', 'f.ts'));
    assert.equal(out.baseline, initial);
    assert.match(out.body, /-v1/);
    assert.match(out.body, /\+v2/);
    // The 4-line preamble is dropped (minified).
    assert.ok(!out.body.includes('diff --git'));
    assert.ok(!out.body.includes('+++ '));
  });
});

test('computeFileDiff: context=0 by default (changes-only)', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'l1\nl2\nl3\nl4\nl5\n');
    await commit(dir, 'initial');
    await fs.writeFile(file, 'l1\nl2\nCHANGED\nl4\nl5\n');
    await commit(dir, 'agent change');

    const out = await computeFileDiff(input(file, 'modified', 'f.ts', 0));
    // context=0 → no leading ' ' unchanged lines around the change.
    assert.ok(!out.body.split('\n').some((l) => l.startsWith(' ')));
  });
});

test('computeFileDiff: context=3 keeps surrounding unchanged lines', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'l1\nl2\nl3\nl4\nl5\n');
    await commit(dir, 'initial');
    await fs.writeFile(file, 'l1\nl2\nCHANGED\nl4\nl5\n');
    await commit(dir, 'agent change');

    const out = await computeFileDiff(input(file, 'modified', 'f.ts', 3));
    assert.ok(out.body.split('\n').some((l) => l.startsWith(' ')), 'expected context lines');
  });
});

// ─── deleted: old content as deletions ─────────────────────────────────────

test('computeFileDiff: deleted committed file → old content as deletions', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'v1\nv2\n');
    const content = await commit(dir, 'initial');
    await fs.rm(file);
    await commit(dir, 'agent deletes'); // working tree clean, file absent

    const out = await computeFileDiff(input(file, 'deleted', 'f.ts'));
    assert.equal(out.baseline, content);
    assert.match(out.body, /-v1/);
    assert.match(out.body, /-v2/);
  });
});

// ─── no-baseline fallback (never errors) ────────────────────────────────────

test('computeFileDiff: repo with no commits (unborn HEAD) → no-git-baseline note', async () => {
  // A fresh repo with no commits has an unborn HEAD: `git log` exits 128 →
  // resolveBaselineRef returns 'HEAD', then `git diff HEAD` exits 128 (bad
  // revision) → the noBaseline fallback. Reliable (own .git, no ancestor walk).
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'x');
    const out = await computeFileDiff(input(file, 'modified', 'f.ts'));
    assert.equal(out.body, '');
    assert.match(out.note!, /no git baseline; use read to view/);
  });
});

test('computeFileDiff: untracked file in a committed repo → no-changes note', async () => {
  // kind=modified but the file is untracked → `git diff HEAD -- <file>` is empty
  // (untracked files aren't in HEAD's diff) → "no changes vs baseline" note.
  await withTempRepo(async (dir) => {
    await fs.writeFile(path.join(dir, 'seed.txt'), 'seed');
    await commit(dir, 'seed'); // give HEAD a commit so `git diff HEAD` resolves
    const file = path.join(dir, 'untracked.ts');
    await fs.writeFile(file, 'x');
    const out = await computeFileDiff(input(file, 'modified', 'untracked.ts'));
    assert.equal(out.body, '');
    assert.match(out.note!, /no changes vs baseline/);
  });
});
