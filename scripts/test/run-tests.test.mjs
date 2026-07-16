import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTestArgs, groupFastPackageConfigs, parseArgs } from '../run-tests.mjs';

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
    { id: 'b', cwd: '/repo', testGlobs: ['b.test.ts'] },
    { id: 'isolated', cwd: '/other', testGlobs: ['c.test.ts'] },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].testGlobs, ['a.test.ts', 'b.test.ts']);
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

test('buildTestArgs can run infrastructure tests without coverage collection', () => {
  const args = buildTestArgs({
    testGlobs: ['scripts/test/*.test.mjs'],
    coverage: false,
  }, false);

  assert.equal(args.includes('--experimental-test-coverage'), false);
  assert.equal(args.some((arg) => arg.startsWith('--test-coverage-include=')), false);
  assert.ok(args.includes('--test-concurrency=1'));
});
