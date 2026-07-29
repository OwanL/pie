import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { computeFileDiff, type DiffDependencies, type DiffInput } from '../src/diff';

const integrationTest = process.env.PIE_RUN_INTEGRATION_TESTS === '1' ? test : test.skip;
const execFileP = promisify(execFile);

function input(absPath: string, kind: DiffInput['kind'], context = 0): DiffInput {
  return { relPath: path.basename(absPath), absPath, kind, context };
}

function dependencies(overrides: Partial<DiffDependencies> = {}): DiffDependencies {
  return {
    isTrackedByGit: async () => false,
    resolveBaselineRef: async () => 'baseline-sha',
    execGit: async () => ({ stdout: '', code: 0 }),
    ...overrides,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-diff-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('created files render a synthetic all-additions patch without resolving a baseline', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'new.ts');
    await fs.writeFile(file, 'a\nb\nc');
    let resolvedBaseline = false;
    const out = await computeFileDiff(input(file, 'created'), dependencies({
      resolveBaselineRef: async () => { resolvedBaseline = true; return 'unused'; },
    }));

    assert.equal(out.kind, 'created');
    assert.equal(out.baseline, '(new file)');
    assert.equal(out.body, '@@ -0,0 +1,3 @@\n+a\n+b\n+c');
    assert.equal(resolvedBaseline, false);
  });
});

test('a created file missing on disk returns an actionable note', async () => {
  const out = await computeFileDiff(input(path.join(os.tmpdir(), `missing-${process.pid}.ts`), 'created'), dependencies());
  assert.equal(out.body, '');
  assert.match(out.note ?? '', /no longer exists on disk/);
});

test('a tracked write is treated as a modification against the resolved baseline', async () => {
  const out = await computeFileDiff(input('/repo/f.ts', 'created'), dependencies({
    isTrackedByGit: async () => true,
    resolveBaselineRef: async () => 'before-write',
    execGit: async () => ({
      code: 1,
      stdout: 'diff --git a/f.ts b/f.ts\nindex 1..2 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-v1\n+v2\n',
    }),
  }));

  assert.equal(out.kind, 'modified');
  assert.equal(out.baseline, 'before-write');
  assert.equal(out.body, '@@ -1 +1 @@\n-v1\n+v2');
});

test('modified diffs forward the requested context and retain only the unified body', async () => {
  const calls: string[][] = [];
  const deps = dependencies({
    execGit: async (_dir, args) => {
      calls.push(args);
      return {
        code: 1,
        stdout: 'diff --git a/f.ts b/f.ts\nindex 1..2 100644\n--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n same\n-old\n+new\n',
      };
    },
  });

  const withoutContext = await computeFileDiff(input('/repo/f.ts', 'modified', 0), deps);
  const withContext = await computeFileDiff(input('/repo/f.ts', 'modified', 3), deps);
  assert.ok(calls[0]?.includes('--unified=0'));
  assert.ok(calls[1]?.includes('--unified=3'));
  assert.doesNotMatch(withoutContext.body, /diff --git|\+\+\+/);
  assert.match(withContext.body, /^ same$/m);
});

test('deleted files preserve deletion lines from the git diff', async () => {
  const out = await computeFileDiff(input('/repo/f.ts', 'deleted'), dependencies({
    execGit: async () => ({
      code: 1,
      stdout: 'diff --git a/f.ts b/f.ts\ndeleted file mode 100644\n--- a/f.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-v1\n-v2\n',
    }),
  }));
  assert.match(out.body, /-v1/);
  assert.match(out.body, /-v2/);
});

test('bad git baselines fail closed with the no-baseline note', async () => {
  const out = await computeFileDiff(input('/repo/f.ts', 'modified'), dependencies({
    execGit: async () => ({ stdout: '', code: 128 }),
  }));
  assert.equal(out.baseline, 'HEAD');
  assert.equal(out.body, '');
  assert.match(out.note ?? '', /no git baseline/);
});

test('an empty git diff reports no changes rather than claiming a baseline failure', async () => {
  const out = await computeFileDiff(input('/repo/untracked.ts', 'modified'), dependencies());
  assert.equal(out.baseline, 'baseline-sha');
  assert.equal(out.body, '');
  assert.match(out.note ?? '', /no changes vs baseline/);
});

test('git and filesystem failures are converted to bounded fallback output', async () => {
  const out = await computeFileDiff(input('/repo/f.ts', 'modified'), dependencies({
    resolveBaselineRef: async () => { throw new Error('git unavailable'); },
  }));
  assert.deepEqual(out, {
    kind: 'modified', path: 'f.ts', additions: 0, deletions: 0,
    baseline: 'HEAD', body: '', note: 'no git baseline; use read to view',
  });
});

integrationTest('real git integration recognizes a tracked write as a modification', async () => {
  await withTempDir(async (dir) => {
    await execFileP('git', ['init', '-q'], { cwd: dir });
    await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir });
    const file = path.join(dir, 'f.ts');
    await fs.writeFile(file, 'v1\n');
    await execFileP('git', ['add', 'f.ts'], { cwd: dir });
    await execFileP('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    await fs.writeFile(file, 'v2\n');

    const out = await computeFileDiff(input(file, 'created'));
    assert.equal(out.kind, 'modified');
    assert.match(out.body, /-v1/);
    assert.match(out.body, /\+v2/);
  });
});
