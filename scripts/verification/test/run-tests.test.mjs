import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseArgs as parseNativeArgs, resolveTestFiles } from '../test-node.mjs';

import {
  buildNativePackageArgs,
  createCoverageScope,
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

const coveredConfig = { ...lifetimeConfig, coverage: true, coverageIncludes: ['src/**/*.ts'],
  thresholds: { lines: 80, branches: 75 } };
const qualifiedCoverage = { coveredLinePercent: 60, coveredBranchPercent: 70,
  files: [{ path: path.join(process.cwd(), 'src/subject.ts'), totalLineCount: 5, coveredLineCount: 3,
    totalBranchCount: 10, coveredBranchCount: 7, coveredLinePercent: 60, coveredBranchPercent: 70,
    lines: [{ line: 1, count: 1 }, { line: 2, count: 0 }] }] };
function reporterResult(exitCode = 0) {
  return { exitCode, teardownConfirmed: true, signal: null, stderr: '',
    stdout: '__PI_TEST_SUMMARY__' + JSON.stringify({
      summary: { success: exitCode === 0, counts: { passed: 1, failed: exitCode ? 1 : 0 } },
      coverage: { coveredLinePercent: 100, coveredBranchPercent: 100 }, failures: [],
    }) };
}

test('qualified accounting replaces Node aggregates after joined child and cleans captured failures', async () => {
  for (const exitCode of [0, 1]) {
    const events = [];
    const result = await runPackage(coveredConfig, false, true, [], undefined, { sdkPath: '/fixture' }, {
      createOverlay: () => ({ configPath: '/fixture/overlay', dispose: () => events.push('overlay disposed') }),
      createCoverageScope: () => ({ directory: '/private/coverage', dispose: () => events.push('coverage disposed') }),
      resolveTsx: () => '/unused/tsx',
      runChild: async (_command, args, cwd, _signal, env) => {
        assert.equal(cwd, coveredConfig.cwd);
        assert.ok(args.includes('--test-concurrency=1'));
        assert.match(env.NODE_OPTIONS, /--require=.*coverage-capture\.cjs/u);
        assert.match(env.NODE_OPTIONS, /--inspect-port=0/u);
        assert.equal(env.PIE_RUN_INTEGRATION_TESTS, '1');
        assert.equal(env.PIE_TEST_COVERAGE_DIR, '/private/coverage');
        assert.equal(env.PIE_TEST_COVERAGE_CWD, coveredConfig.cwd);
        assert.deepEqual(JSON.parse(env.PIE_TEST_COVERAGE_INCLUDES), coveredConfig.coverageIncludes);
        assert.equal(env.NODE_V8_COVERAGE, path.join('/private/coverage', 'v8'));
        assert.ok(path.isAbsolute(env.PIE_TEST_COVERAGE_ROOT));
        events.push('joined');
        return reporterResult(exitCode);
      },
      collectCoverage: async (options) => {
        assert.deepEqual(events, ['joined']);
        assert.equal(options.directory, '/private/coverage');
        assert.equal(options.cwd, coveredConfig.cwd);
        assert.deepEqual(options.includes, coveredConfig.coverageIncludes);
        events.push('captured');
        return qualifiedCoverage;
      },
    });
    assert.strictEqual(result.coverage, qualifiedCoverage);
    assert.equal(result.passed, false);
    assert.equal(result.hasInfrastructureFailure, false);
    assert.equal(result.summary.counts.passed, 1);
    assert.equal(result.coverageFailures.length, 2);
    assert.match(result.coverageDiagnostics[0], /subject\.ts.*uncovered lines: 2/u);
    assert.deepEqual(events, ['joined', 'captured', 'overlay disposed', 'coverage disposed']);
    assert.equal(result.retainedCoverage, undefined);
  }
});

test('missing records and mapping failures retain evidence and cannot fall back to Node coverage', async () => {
  for (const collectCoverage of [async () => ({ ...qualifiedCoverage, files: [] }),
    async () => { throw new Error('Missing TypeScript source map'); }]) {
    let overlayDisposed = false;
    const result = await runPackage(coveredConfig, false, false, [], undefined, { sdkPath: '/fixture' }, {
      createOverlay: () => ({ configPath: '/fixture/overlay', dispose: () => { overlayDisposed = true; } }),
      createCoverageScope: () => ({ directory: '/private/evidence', dispose: () => assert.fail('evidence removed') }),
      resolveTsx: () => '/unused/tsx', runChild: async () => reporterResult(), collectCoverage,
    });
    assert.equal(result.hasInfrastructureFailure, true);
    assert.equal(result.coverage, null);
    assert.equal(result.passed, false);
    assert.equal(result.retainedCoverage, '/private/evidence');
    assert.equal(result.retainedOverlay, '/fixture/overlay');
    assert.equal(overlayDisposed, false);
    assert.match(result.rawResult.diagnostics.join(';'), /Qualified source coverage/u);
  }
});

test('uncertain lifetime and capture exit 125 retain both scopes without accounting', async () => {
  for (const raw of [{ ...reporterResult(), teardownConfirmed: false }, reporterResult(125)]) {
    const result = await runPackage(coveredConfig, false, false, [], undefined, { sdkPath: '/fixture' }, {
      createOverlay: () => ({ configPath: '/fixture/overlay', dispose: () => assert.fail('overlay removed') }),
      createCoverageScope: () => ({ directory: '/private/evidence', dispose: () => assert.fail('evidence removed') }),
      resolveTsx: () => '/unused/tsx', runChild: async () => raw,
      collectCoverage: () => assert.fail('accounting before confirmed lifetime'),
    });
    assert.equal(result.teardownConfirmed, false);
    assert.equal(result.retainedOverlay, '/fixture/overlay');
    assert.equal(result.retainedCoverage, '/private/evidence');
  }
});

test('source recorder failure propagates exit 125 and retains both scopes', async () => {
  const result = await runPackage(coveredConfig, false, false, [], undefined, { sdkPath: '/fixture' }, {
    createOverlay: () => ({ configPath: '/fixture/overlay', dispose: () => assert.fail('overlay removed') }),
    createCoverageScope: () => ({ directory: '/private/evidence', dispose: () => assert.fail('evidence removed') }),
    resolveTsx: () => '/unused/tsx', runChild: async () => reporterResult(1),
    collectCoverage: async () => { throw Object.assign(new Error('Source capture failed'), { exitCode: 125 }); },
  });
  assert.equal(result.rawResult.exitCode, 125);
  assert.equal(result.teardownConfirmed, false);
  assert.equal(result.retainedOverlay, '/fixture/overlay');
  assert.equal(result.retainedCoverage, '/private/evidence');
});

test('single-process coverage inherits capture but no inspector-port flag; fast and no-coverage avoid scopes', async () => {
  for (const [config, fast] of [[{ ...coveredConfig, singleProcessCoverage: true }, false],
    [coveredConfig, true], [lifetimeConfig, false]]) {
    const covered = !fast && config.coverage !== false;
    await runPackage(config, fast, false, [], undefined, { sdkPath: '/fixture' }, {
      createOverlay: () => ({ configPath: '/fixture/overlay', dispose() {} }),
      createCoverageScope: () => {
        assert.equal(covered, true);
        return { directory: '/private/evidence', dispose() {} };
      },
      resolveTsx: () => '/unused/tsx',
      runChild: async (_command, _args, _cwd, _signal, env) => {
        if (covered) {
          assert.match(env.NODE_OPTIONS, /coverage-capture/u);
          assert.ok(!env.NODE_OPTIONS.includes('--inspect-port=0'));
        } else assert.deepEqual(env, {});
        return reporterResult();
      },
      collectCoverage: async () => { assert.equal(covered, true); return qualifiedCoverage; },
    });
  }
});

test('each real coverage scope owns a distinct OS-temp directory', () => {
  const first = createCoverageScope();
  const second = createCoverageScope();
  try {
    assert.notEqual(first.directory, second.directory);
    assert.ok(path.isAbsolute(first.directory));
    assert.ok(path.isAbsolute(second.directory));
  } finally {
    first.dispose();
    second.dispose();
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function successfulOwner(config) {
  return { config, passed: true, teardownConfirmed: true, summary: null };
}

test('release owners use four rolling slots, preserve selection and print in owner order', async (t) => {
  t.mock.method(console, 'log', () => {});
  const configs = Array.from({ length: 9 }, (_, index) => ({ ...lifetimeConfig, id: String(index) }));
  const gates = configs.map(() => deferred());
  const starts = configs.map(() => deferred());
  const launched = [];
  const printed = [];
  let active = 0;
  let peak = 0;
  const runtime = {};
  const controller = new AbortController();
  const args = { fast: false, integration: true, testArgs: ['--test-only'] };
  const running = runSelectedPackages(args, configs, runtime, controller.signal, {
    runPackageImpl: async (config, fast, integration, testArgs, signal, receivedRuntime) => {
      assert.strictEqual(config, configs[Number(config.id)]);
      assert.deepEqual([fast, integration, testArgs], [false, true, args.testArgs]);
      assert.strictEqual(signal, controller.signal);
      assert.strictEqual(receivedRuntime, runtime);
      launched.push(config.id);
      peak = Math.max(peak, ++active);
      starts[Number(config.id)].resolve();
      await gates[Number(config.id)].promise;
      active -= 1;
      return successfulOwner(config);
    },
    printResult: (result) => printed.push(result.config.id),
  });
  await Promise.all(starts.slice(0, 4).map((start) => start.promise));
  assert.deepEqual(launched, ['0', '1', '2', '3']);
  gates[2].resolve();
  await starts[4].promise;
  assert.deepEqual(launched, ['0', '1', '2', '3', '4'], 'refill must not wait for the first owner or a whole batch');
  for (const index of [4, 3, 5, 6]) {
    gates[index].resolve();
    await starts[launched.length].promise;
  }
  assert.equal(peak, 4);
  assert.deepEqual(printed, [], 'printing waits for all launched jobs');
  for (const gate of gates) gate.resolve();
  await running;
  assert.equal(active, 0);
  assert.deepEqual(printed, configs.map((config) => config.id));
});

test('ordinary release failures still admit every selected owner', async (t) => {
  t.mock.method(console, 'log', () => {});
  const previousExitCode = process.exitCode;
  const launched = [];
  try {
    await runSelectedPackages({ fast: false, testArgs: [] },
      Array.from({ length: 7 }, (_, index) => ({ ...lifetimeConfig, id: String(index) })), {}, undefined, {
        runPackageImpl: async (config) => {
          launched.push(config.id);
          return { ...successfulOwner(config), passed: config.id !== '0' };
        },
        printResult: () => {},
      });
    assert.deepEqual(launched, ['0', '1', '2', '3', '4', '5', '6']);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('cancellation stops release admission and joins all active owners', async (t) => {
  t.mock.method(console, 'log', () => {});
  const previousExitCode = process.exitCode;
  const controller = new AbortController();
  const gates = Array.from({ length: 4 }, deferred);
  const launched = [];
  const printed = [];
  let settled = false;
  try {
    const running = runSelectedPackages({ fast: false, testArgs: [] },
      Array.from({ length: 8 }, (_, index) => ({ ...lifetimeConfig, id: String(index) })), {}, controller.signal, {
        runPackageImpl: async (config) => {
          launched.push(config.id);
          await gates[Number(config.id)].promise;
          return successfulOwner(config);
        },
        printResult: (result) => printed.push(result.config.id),
      });
    const observed = running.finally(() => { settled = true; });
    controller.abort();
    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(launched, ['0', '1', '2', '3']);
    for (const gate of gates) gate.resolve();
    await observed;
    assert.deepEqual(printed, launched);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('pre-aborted selection admits no owners in either mode', async (t) => {
  t.mock.method(console, 'log', () => {});
  const previousExitCode = process.exitCode;
  try {
    for (const fast of [false, true]) {
      const controller = new AbortController();
      controller.abort();
      await runSelectedPackages({ fast, testArgs: [] }, [lifetimeConfig], {}, controller.signal, {
        runPackageImpl: () => assert.fail('aborted owner was admitted'),
        printResult: () => assert.fail('unlaunched owner was printed'),
      });
      assert.equal(process.exitCode, 1);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('fast owners remain sequential', async (t) => {
  t.mock.method(console, 'log', () => {});
  const first = deferred();
  const secondStarted = deferred();
  const launched = [];
  const running = runSelectedPackages({ fast: true, testArgs: [] },
    [{ ...lifetimeConfig, id: 'first' }, { ...lifetimeConfig, id: 'second' }], {}, undefined, {
      runPackageImpl: async (config) => {
        launched.push(config.id);
        if (config.id === 'first') await first.promise;
        else secondStarted.resolve();
        return successfulOwner(config);
      },
      printResult: () => {},
    });
  assert.deepEqual(launched, ['first']);
  first.resolve();
  await secondStarted.promise;
  await running;
  assert.deepEqual(launched, ['first', 'second']);
});

test('retained coverage joins launched siblings and prints their evidence before propagating uncertainty', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  let release;
  let siblingStarted;
  const started = new Promise((resolve) => { siblingStarted = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const launched = [];
  const configs = ['uncertain', 'sibling', 'third', 'fourth', 'queued', 'last']
    .map((id) => ({ ...lifetimeConfig, id }));
  const running = runSelectedPackages({ fast: false, testArgs: [] }, configs, {}, undefined, {
      runPackageImpl: async (config) => {
        launched.push(config.id);
        if (config.id === 'uncertain') throw Object.assign(new Error('inner teardown denied'), {
          rawResult: { stdout: 'uncertain stdout', stderr: 'uncertain stderr' },
        });
        if (config.id === 'sibling') {
          siblingStarted();
          await delayed;
        }
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
  assert.deepEqual(launched, configs.map((config) => config.id), 'uncertainty must not discard queued owners');
  assert.deepEqual(lines.filter((line) => line.startsWith('✖ ')).map((line) => line.split(' ')[1]),
    configs.map((config) => config.id), 'uncertain results still print in owner order');
  for (const evidence of ['uncertain stdout', 'uncertain stderr', 'inner teardown denied', 'sibling stdout', 'sibling stderr', 'sibling proof']) {
    assert.ok(lines.join('\n').includes(evidence), evidence);
  }
});
