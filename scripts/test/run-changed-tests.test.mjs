// Focused unit tests for scripts/run-changed-tests.mjs — the planning,
// run-tests arg building, and a git smoke test against the real repo. main()
// spawns run-tests.mjs and is exercised separately by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const files = await getChangedFiles(repoRoot);
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 0, 'expected changed/untracked files in this working tree');
  for (const f of files) {
    assert.equal(typeof f, 'string');
    assert.ok(!f.includes('\\'), `forward-slash only: ${f}`);
    assert.ok(!path.isAbsolute(f), `repo-relative only: ${f}`);
  }
  // The new DX scripts are untracked, so they must appear in the changed set.
  assert.ok(files.includes('scripts/run-test-files.mjs'), 'run-test-files.mjs should be in changed set');
  assert.ok(files.includes('scripts/run-changed-tests.mjs'), 'run-changed-tests.mjs should be in changed set');
});

test('planRuns maps package files to ids and de-duplicates', () => {
  const plan = planRuns([
    'extension/test/a.test.ts',
    'extension/src/backend/sdk.ts',
    'extensions/subagent/test/schema.test.ts',
  ]);
  assert.equal(plan.selectAll, false);
  assert.deepEqual(plan.packageIds, ['extension', 'subagent']);
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
