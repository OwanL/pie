import assert from 'node:assert/strict';
import test from 'node:test';

import { attemptFlakyRerun, buildTestArgs, groupFastPackageConfigs, parseArgs } from '../run-tests.mjs';
import { accountTestFiles } from '../test-reporter.mjs';

test('parseArgs forwards name filters without requiring a second separator', () => {
  assert.deepEqual(
    parseArgs(['--fast', '--package', 'extension', '--test-name-pattern=streamed text']),
    {
      selected: ['extension'],
      listOnly: false,
      helpOnly: false,
      fast: true,
      integration: false,
      testArgs: ['--test-name-pattern=streamed text'],
    },
  );
});

test('parseArgs forwards arbitrary node:test arguments after --', () => {
  const parsed = parseArgs(['--package=ask-user', '--integration', '--', '--test-only', '--test-timeout=5000']);
  assert.deepEqual(parsed.testArgs, ['--test-only', '--test-timeout=5000']);
  assert.deepEqual(parsed.selected, ['ask-user']);
  assert.equal(parsed.integration, true);
});

test('buildTestArgs places forwarded node:test arguments before test globs', () => {
  const args = buildTestArgs({
    testGlobs: ['./test/**/*.test.ts'],
    coverageIncludes: ['src/**/*.ts'],
  }, true, ['--test-name-pattern=answer with spaces']);

  assert.equal(args.includes('tsx'), false, 'the caller invokes the local tsx CLI directly');
  assert.ok(args.indexOf('--test-name-pattern=answer with spaces') < args.indexOf('./test/**/*.test.ts'));
});

test('groupFastPackageConfigs combines compatible runners to avoid worker oversubscription', () => {
  const groups = groupFastPackageConfigs([
    { id: 'a', cwd: '/repo', testGlobs: ['a.test.ts'] },
    { id: 'b', cwd: '/repo', testGlobs: ['b.test.ts'], includeOwnerDependencies: true },
    { id: 'isolated', cwd: '/other', testGlobs: ['c.test.ts'] },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].testGlobs, ['a.test.ts', 'b.test.ts']);
  assert.equal(groups[0].includeOwnerDependencies, true, 'compatible package groups retain owner dependency resolution');
  assert.equal(groups[1].id, 'isolated');
});

test('buildTestArgs applies an explicit fast worker budget', () => {
  const args = buildTestArgs({
    testGlobs: ['./test/**/*.test.ts'],
    fastConcurrency: 4,
  }, true);

  assert.ok(args.includes('--test-concurrency=4'));
  assert.equal(args.includes('--experimental-test-coverage'), false);
});

test('buildTestArgs can use a stable single-process release coverage entrypoint', () => {
  const config = {
    testGlobs: ['test/**/*.test.ts'],
    coverageTestGlobs: ['test/coverage-suite.ts'],
    coverageIncludes: ['src/**/*.ts'],
  };
  const releaseArgs = buildTestArgs(config, false);
  assert.ok(releaseArgs.includes('test/coverage-suite.ts'));
  assert.equal(releaseArgs.includes('test/**/*.test.ts'), false);
  const fastArgs = buildTestArgs(config, true);
  assert.ok(fastArgs.includes('test/**/*.test.ts'));
  assert.equal(fastArgs.includes('test/coverage-suite.ts'), false);
});

test('selective flaky rerun cannot erase original missing or duplicate test-file accounting', async () => {
  for (const executed of [[], ['a.test.mjs', 'a.test.mjs']]) {
    const accounting = accountTestFiles(['a.test.mjs'], executed);
    const original = {
      config: { id: 'scripts' },
      passed: false,
      hasInfrastructureFailure: false,
      fileAccounting: accounting,
      summary: { success: false, counts: { tests: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 } },
      failures: [
        { name: 'attributed failure', file: 'scripts/verification/test/run-tests.test.mjs' },
        { name: 'test-file accounting mismatch', file: null, message: JSON.stringify(accounting) },
      ],
    };
    let reruns = 0;
    const diagnostics = [];
    const originalLog = console.log;
    let result;
    try {
      console.log = (message) => diagnostics.push(message);
      result = await attemptFlakyRerun(original, true, false, [], undefined, async () => {
        reruns += 1;
        return { passed: true };
      });
    } finally {
      console.log = originalLog;
    }
    assert.match(diagnostics.join('\n'), /original test-file accounting mismatch — flaky rerun skipped/);
    assert.equal(result.passed, false);
    assert.equal(result.summary.counts.failed, 1);
    assert.equal(result.flakyRerun, undefined);
    assert.equal(reruns, 0, 'an accounting mismatch must not enter the selective rerun');
  }
});

test('subprocess accounting mismatch still blocks rerun when aggregate accounting succeeded', async () => {
  const original = {
    config: { id: 'extension' },
    passed: false,
    fileAccounting: accountTestFiles(['a.test.mjs'], ['a.test.mjs']),
    failures: [
      { name: 'attributed failure', file: 'scripts/verification/test/run-tests.test.mjs' },
      { name: 'test-file accounting mismatch', file: null, message: 'subprocess missing file' },
    ],
  };
  let reruns = 0;
  const originalLog = console.log;
  try {
    console.log = () => {};
    const result = await attemptFlakyRerun(original, true, false, [], undefined, async () => {
      reruns += 1;
      return { passed: true };
    });
    assert.equal(result, original);
  } finally {
    console.log = originalLog;
  }
  assert.equal(reruns, 0);
});

test('selective flaky rerun still accepts a passing attributed test-file rerun', async () => {
  const original = {
    config: { id: 'scripts' },
    passed: false,
    hasInfrastructureFailure: false,
    fileAccounting: accountTestFiles(['a.test.mjs'], ['a.test.mjs']),
    summary: { success: false, counts: { tests: 1, passed: 0, failed: 1, skipped: 0, todo: 0, cancelled: 0 } },
    failures: [{ name: 'transient failure', file: 'scripts/verification/test/run-tests.test.mjs' }],
  };
  let reruns = 0;
  const originalLog = console.log;
  let result;
  try {
    console.log = () => {};
    result = await attemptFlakyRerun(original, true, false, [], undefined, async (files) => {
      reruns += 1;
      assert.deepEqual(files, ['scripts/verification/test/run-tests.test.mjs']);
      return { passed: true };
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(reruns, 1);
  assert.equal(result.passed, true);
  assert.equal(result.flakyRerun, true);
  assert.equal(result.summary.counts.failed, 0);
});

test('buildTestArgs can run infrastructure tests without coverage collection', () => {
  const args = buildTestArgs({
    testGlobs: ['scripts/test/*.test.mjs'],
    coverage: false,
  }, false);

  assert.equal(args.includes('--experimental-test-coverage'), false);
  assert.equal(args.some((arg) => arg.startsWith('--test-coverage-include=')), false);
  assert.ok(args.includes('--test-concurrency=1'));
});
