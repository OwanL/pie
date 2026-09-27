import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { computeFileDiff, type DiffDependencies, type DiffInput } from '../diff';

const execFileP = promisify(execFile);
function input(absPath: string, kind: DiffInput['kind'] = 'modified', context = 0): DiffInput {
  return { relPath: path.basename(absPath), absPath, kind, context };
}
function dependencies(diff = '', tracked = true): DiffDependencies {
  return { execGit: async (_dir, args) => {
    if (args[0] === 'rev-parse') return { stdout: args.includes('HEAD') ? 'head-sha' : path.resolve('/repo'), code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: tracked ? 0 : 1 };
    return { stdout: diff, code: 0 };
  } };
}
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-diff-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('diff inspects HEAD literally with requested context and no history walk', async () => {
  const calls: string[][] = [];
  const deps = dependencies('diff --git a/f b/f\nindex 1..2\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n--- old\n+++ new\n');
  const out = await computeFileDiff(input(path.resolve('/repo/[f].ts'), 'modified', 3), {
    execGit: async (dir, args, max) => { calls.push(args); return deps.execGit(dir, args, max); },
  });
  assert.equal(out.baseline, 'HEAD');
  assert.equal(out.body, '@@ -1 +1 @@\n--- old\n+++ new');
  const diff = calls.find((args) => args[0] === 'diff')!;
  assert.ok(diff.includes('HEAD'));
  assert.ok(diff.includes('--unified=3'));
  assert.equal(diff.at(-1), ':(literal)[f].ts');
  assert.ok(calls.every((args) => args[0] !== 'log'));
});

test('untracked files are explicit rather than synthetic session patches', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'new.ts');
    await fs.writeFile(file, 'current content');
    const out = await computeFileDiff(input(file, 'created'), dependencies('', false));
    assert.equal(out.body, '');
    assert.match(out.note!, /Untracked.*read/);
  });
});

test('non-Git and absent paths have actionable, distinct notes', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'f.ts');
    const deps: DiffDependencies = { execGit: async () => ({ stdout: '', code: 128 }) };
    await fs.writeFile(file, 'content');
    assert.match((await computeFileDiff(input(file), deps)).note!, /Not in a Git repository; use read/);
    await fs.unlink(file);
    assert.match((await computeFileDiff(input(file, 'deleted'), deps)).note!, /path is absent/);
  });
});

test('clean and already-committed files do not resurrect historical changes', async () => {
  const out = await computeFileDiff(input(path.resolve('/repo/f.ts')), dependencies());
  assert.equal(out.body, '');
  assert.match(out.note!, /No current changes against HEAD/);
});

test('missing HEAD and failed Git capture are not reported as clean diffs', async () => {
  const normal = dependencies();
  const noHead = await computeFileDiff(input(path.resolve('/repo/f.ts')), {
    execGit: async (dir, args, max) => args.includes('--verify') ? { stdout: '', code: 128 } : normal.execGit(dir, args, max),
  });
  assert.match(noHead.note!, /no HEAD.*git diff --cached/);
  const failed = await computeFileDiff(input(path.resolve('/repo/f.ts')), {
    execGit: async () => { throw new Error('buffer exceeded'); },
  });
  assert.match(failed.note!, /capture limit.*temporary file/);
});

test('real Git: staged and unstaged changes, literal filenames, clean commits and deleted directories', async () => {
  await withTempDir(async (dir) => {
    const git = (args: string[]) => execFileP('git', args, { cwd: dir });
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await fs.mkdir(path.join(dir, 'sub'));
    const file = path.join(dir, 'sub', '[f].ts');
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(dir, 'sub', 'f.ts'), 'other\n');
    await git(['add', '.']); await git(['commit', '-q', '-m', 'initial']);
    await fs.writeFile(file, 'staged\ntwo\nthree\n'); await git(['add', '.']);
    await fs.writeFile(file, 'staged\ntwo\nunstaged\n');
    await fs.writeFile(path.join(dir, 'sub', 'f.ts'), 'unrelated\n');
    const out = await computeFileDiff(input(file));
    assert.match(out.body, /\+staged/); assert.match(out.body, /\+unstaged/);
    assert.doesNotMatch(out.body, /unrelated/);
    await git(['add', '.']); await git(['commit', '-q', '-m', 'session edits']);
    assert.equal((await computeFileDiff(input(file))).body, '');
    await fs.rm(path.join(dir, 'sub'), { recursive: true });
    const deleted = await computeFileDiff(input(file, 'deleted'));
    assert.match(deleted.body, /-staged/); assert.match(deleted.body, /-unstaged/);
    await git(['add', '-u']);
    assert.match((await computeFileDiff(input(file, 'deleted'))).body, /-staged/);
  });
});
