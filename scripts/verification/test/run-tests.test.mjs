import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNativeArgs, resolveTestFiles } from '../test-node.mjs';

import {
  buildNativePackageArgs,
  PACKAGE_CONFIGS,
  buildTestArgs,
  parseArgs,
} from '../run-tests.mjs';

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

test('native package invocation preserves owner globs, SDK aliases and name filters without batching', () => {
  const runtime = { sdkPath: '/verified/sdk' };
  const extension = PACKAGE_CONFIGS.find((config) => config.id === 'extension');
  const args = buildNativePackageArgs(extension, runtime, ['--test-name-pattern=answer with spaces']);
  assert.match(args[0], /test-node\.mjs$/u);
  assert.equal(args[args.indexOf('--sdk-path') + 1], runtime.sdkPath);
  assert.ok(args.includes('harness/agent-instructions/prompt-assembly/test/**/*.test.ts'));
  assert.ok(args.includes('application/frontend/**/*.test.tsx'));
  assert.ok(args.includes('application/hosts/vscode/test/**/*.test.mjs'));
  assert.equal(args.at(-1), '--test-name-pattern=answer with spaces');
  assert.ok(args.indexOf('--') < args.indexOf('--test-name-pattern=answer with spaces'));
  assert.ok(!args.some((arg) => arg.includes('run-fast-') || arg.includes('coverage')));
  const reporter = args.find((arg) => arg.startsWith('--test-reporter=')).slice('--test-reporter='.length);
  assert.ok(path.isAbsolute(reporter), 'native custom reporters require paths, not file URLs');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const auth = PACKAGE_CONFIGS.find((config) => config.id === 'model-provider-authentication');
  const native = parseNativeArgs(buildNativePackageArgs(auth, runtime).slice(1));
  assert.deepEqual(resolveTestFiles(root, native.selectors, native).map((file) => path.basename(file)), [
    'auth-storage.test.ts', 'copilot-headers.test.ts',
  ], 'owner directory selectors must enumerate real tests without a literal root-dot pathspec');

  const subagent = PACKAGE_CONFIGS.find((config) => config.id === 'subagent');
  const subagentArgs = buildNativePackageArgs(subagent, runtime);
  assert.equal(subagentArgs[subagentArgs.indexOf('--tsconfig') + 1], subagent.tsxConfig);
  assert.ok(subagentArgs.includes('harness/tools/subagent/test/**/*.test.ts'));
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

test('buildTestArgs can run infrastructure tests without coverage collection', () => {
  const args = buildTestArgs({
    testGlobs: ['scripts/test/*.test.mjs'],
    coverage: false,
  }, false);

  assert.equal(args.includes('--experimental-test-coverage'), false);
  assert.equal(args.some((arg) => arg.startsWith('--test-coverage-include=')), false);
  assert.ok(args.includes('--test-concurrency=1'));
});
