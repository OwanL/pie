// Focused unit tests for scripts/lib/git-changed-files.mjs — the git-diff
// helper shared by scripts/run-affected-tests.mjs (the live `npm test` entry
// point). Exercises getChangedFiles against a real temp git repo and a
// non-git directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getChangedFiles } from '../lib/git-changed-files.mjs';

test('getChangedFiles returns repo-relative forward-slash paths from git', async () => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-changed-files-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: tempRepo });
    fs.mkdirSync(path.join(tempRepo, 'scripts'));
    fs.writeFileSync(path.join(tempRepo, 'scripts', 'tracked.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(tempRepo, 'scripts', 'untracked.mjs'), 'export {};\n');
    execFileSync('git', ['add', 'scripts/tracked.mjs'], { cwd: tempRepo });

    const files = await getChangedFiles(tempRepo);
    assert.deepEqual(files, ['scripts/tracked.mjs', 'scripts/untracked.mjs']);
    for (const f of files) {
      assert.ok(!f.includes('\\'), `forward-slash only: ${f}`);
      assert.ok(!path.isAbsolute(f), `repo-relative only: ${f}`);
    }
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('getChangedFiles fails closed when git state cannot be inspected', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-no-git-'));
  try {
    await assert.rejects(getChangedFiles(directory), /Cannot inspect tracked files/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
