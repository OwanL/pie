import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseArgs as parseNativeArgs, resolveTestFiles } from '../test-node.mjs';

import {
  buildNativePackageArgs,
  PACKAGE_CONFIGS,
  buildTestArgs,
  parseArgs,
  runChildProcess,
  runPackage,
  runSelectedPackages,
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

function fakeChild(code = 0, output = 'captured stdout', errorOutput = 'captured stderr') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.write(output);
    child.stderr.write(errorOutput);
    child.emit('close', code, null);
  });
  return child;
}

const lifetimeConfig = { id: 'fixture', cwd: process.cwd(), coverage: false,
  testGlobs: ['unused.test.ts'], coverageIncludes: [] };

test('retained coverage preserves uncertain child diagnostics and both output streams', async () => {
  const result = await runChildProcess('unused', [], process.cwd(), undefined, {}, true, {
    spawnImpl: () => fakeChild(),
    watchChildProcessImpl: () => ({ settle: async () => ({ gone: false, survivors: [321], diagnostics: ['census denied'] }) }),
  });
  assert.equal(result.exitCode, 125);
  assert.equal(result.teardownConfirmed, false);
  assert.equal(result.stdout, 'captured stdout');
  assert.equal(result.stderr, 'captured stderr');
  assert.ok(result.diagnostics.includes('census denied'));
  assert.match(result.diagnostics.join(';'), /321/);
});

test('retained coverage keeps overlays on unconfirmed or nested teardown, but disposes confirmed failures', async () => {
  for (const [code, gone, retained] of [[0, false, true], [125, true, true], [1, true, false]]) {
    let disposed = 0;
    const result = await runPackage(lifetimeConfig, false, false, [], undefined, { sdkPath: '/fixture' }, {
      createOverlay: () => ({ configPath: '/fixture/overlay.json', dispose: () => { disposed += 1; } }),
      resolveTsx: () => '/unused/tsx',
      runChild: (...args) => runChildProcess(...args, {
        spawnImpl: () => fakeChild(code),
        watchChildProcessImpl: () => ({ settle: async () => ({ gone, survivors: [], diagnostics: ['proof'] }) }),
      }),
    });
    assert.equal(disposed, retained ? 0 : 1);
    assert.equal(result.teardownConfirmed, !retained);
    assert.equal(result.rawResult.exitCode, retained ? 125 : 1);
  }
});

test('retained coverage joins launched siblings and prints their evidence before propagating uncertainty', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  let release;
  let siblingStarted;
  const started = new Promise((resolve) => { siblingStarted = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const running = runSelectedPackages({ fast: false, testArgs: [] },
    [{ ...lifetimeConfig, id: 'uncertain' }, { ...lifetimeConfig, id: 'sibling' }], {}, undefined, {
      runPackageImpl: async (config) => {
        if (config.id === 'uncertain') throw Object.assign(new Error('inner teardown denied'), {
          rawResult: { stdout: 'uncertain stdout', stderr: 'uncertain stderr' },
        });
        siblingStarted();
        await delayed;
        return { config, passed: false, teardownConfirmed: true, hasInfrastructureFailure: true,
          summary: null, coverage: null, failures: [], coverageFailures: [],
          rawResult: { stdout: 'sibling stdout', stderr: 'sibling stderr', diagnostics: ['sibling proof'] } };
      },
    });
  const observed = running.catch((error) => { settled = true; return error; });
  await started;
  await Promise.resolve();
  assert.equal(settled, false, 'uncertain owner must not escape before its launched sibling');
  release();
  const error = await observed;
  assert.equal(error.teardownUnconfirmed, true);
  for (const evidence of ['uncertain stdout', 'uncertain stderr', 'inner teardown denied', 'sibling stdout', 'sibling stderr', 'sibling proof']) {
    assert.ok(lines.join('\n').includes(evidence), evidence);
  }
});
