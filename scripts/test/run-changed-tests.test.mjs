// Focused unit tests for scripts/run-changed-tests.mjs — the planning,
// run-tests arg building, and a git smoke test against the real repo. main()
// spawns run-tests.mjs and is exercised separately by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inferRepoRoot,
  getChangedFiles,
  buildRunTestsArgs,
  planRuns,
} from '../run-changed-tests.mjs';

const repoRoot = inferRepoRoot();
const fwd = (p) => p.replace(/\\/g, '/');

test('inferRepoRoot resolves to the pie repo root', () => {
  assert.equal(fwd(inferRepoRoot()), fwd(repoRoot));
  assert.equal(path.basename(repoRoot), 'pie');
});

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

test('planRuns maps package files to ids and de-duplicates', () => {
  const plan = planRuns([
    'extension/test/a.test.ts',
    'extension/src/backend/sdk.ts',
    'extensions/subagent/test/schema.test.ts',
    'scripts/test/pre-push-safety.test.mjs',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['extension', 'scripts', 'subagent']);
});

test('planRuns selects ALL when global infra changes', () => {
  const plan = planRuns([
    'extension/test/a.test.ts',
    'scripts/run-tests.mjs',
  ]);
  assert.equal(plan.selectAll, true);
  // shared/ is cross-cutting => global
  assert.equal(planRuns(['shared/pricing-core.ts']).selectAll, true);
  assert.equal(planRuns(['package-lock.json']).selectAll, true);
  assert.equal(planRuns(['scripts/lib/sdk-version.mjs']).selectAll, true);
  assert.equal(planRuns(['.githooks/pre-commit']).selectAll, true);
});

test('planRuns ignores unrelated files', () => {
  const plan = planRuns(['README.md', 'docs/x.md', 'settings.json']);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, []);
});

test('buildRunTestsArgs passes --fast alone when selectAll', () => {
  assert.deepEqual(buildRunTestsArgs({ selectAll: true, packageIds: [] }), ['--fast']);
  // even if packageIds happen to be populated, selectAll wins
  assert.deepEqual(
    buildRunTestsArgs({ selectAll: true, packageIds: ['extension'] }),
    ['--fast'],
  );
});

test('buildRunTestsArgs emits a --package pair per affected id in order', () => {
  assert.deepEqual(
    buildRunTestsArgs({ selectAll: false, packageIds: ['extension', 'analysis'] }),
    ['--fast', '--package', 'extension', '--package', 'analysis'],
  );
  assert.deepEqual(
    buildRunTestsArgs({ selectAll: false, packageIds: ['subagent'] }),
    ['--fast', '--package', 'subagent'],
  );
});

test('buildRunTestsArgs args are valid run-tests.mjs flags', () => {
  // --fast is always present; --package values must be known package ids
  const args = buildRunTestsArgs({ selectAll: false, packageIds: ['extension', 'subagent'] });
  assert.equal(args[0], '--fast');
  const packages = args.filter((_, i) => i > 0 && args[i - 1] === '--package');
  assert.deepEqual(packages, ['extension', 'subagent']);
});
