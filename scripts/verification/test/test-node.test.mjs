import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  assertCoverageQualification,
  buildNodeArgs,
  createRunnerTsconfigOverlay,
  createTestEnvironment,
  discoverTrackedTests,
  parseArgs,
  parseNodeTestFlags,
  createNodeTestEntries,
  main,
  resolveTestFiles,
  resolveTestSdkPath,
  runNodeTests,
  runNodeTestsWithOverlay,
  TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE,
} from '../test-node.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const testEnvironmentPreload = pathToFileURL(path.join(repoRoot, 'scripts', 'verification', 'test-environment.mjs')).href;

function makeGitRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-discovery-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(path.join(root, 'suite'), { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), 'ignored.test.mjs\n');
  writeFileSync(path.join(root, 'suite', 'tracked.test.mjs'), '');
  writeFileSync(path.join(root, 'suite', 'untracked.test.ts'), '');
  writeFileSync(path.join(root, 'suite', 'unfocused.e2e.ts'), '');
  writeFileSync(path.join(root, 'suite', 'ignored.test.mjs'), '');
  writeFileSync(path.join(root, 'suite', 'not-a-test.ts'), '');
  execFileSync('git', ['add', '.gitignore', 'suite/tracked.test.mjs'], { cwd: root });
  return root;
}

test('directory discovery uses tracked and nonignored Git files with supported test suffixes', (t) => {
  const root = makeGitRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(discoverTrackedTests(root, ['suite']), [
    'suite/tracked.test.mjs',
    'suite/untracked.test.ts',
  ]);
  assert.deepEqual(resolveTestFiles(root, ['suite']).map((file) => path.relative(root, file).replaceAll('\\', '/')), [
    'suite/tracked.test.mjs',
    'suite/untracked.test.ts',
  ]);
});

test('repeatable exclude globs filter directory and explicit selections without duplicates', (t) => {
  const root = makeGitRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'suite', 'nested'));
  for (const relative of [
    'suite/one.artifact.test.ts',
    'suite/nested/two.artifact.test.tsx',
    'suite/pure.test.tsx',
  ]) writeFileSync(path.join(root, relative), '');
  execFileSync('git', ['add', 'suite/one.artifact.test.ts', 'suite/nested/two.artifact.test.tsx', 'suite/pure.test.tsx'], { cwd: root });

  const selected = resolveTestFiles(root, [
    'suite', 'suite/tracked.test.mjs', 'suite/one.artifact.test.ts', 'suite/nested/two.artifact.test.tsx',
  ], {
    excludeGlobs: ['suite\\*.artifact.test.ts', 'suite/nested/**'],
  }).map((file) => path.relative(root, file).replaceAll('\\', '/'));
  assert.deepEqual(selected, ['suite/pure.test.tsx', 'suite/tracked.test.mjs', 'suite/untracked.test.ts']);
  assert.deepEqual(resolveTestFiles(root, ['suite/one.artifact.test.ts']), [path.join(root, 'suite', 'one.artifact.test.ts')],
    'explicit artifact tests remain selectable unless excluded');
  const included = resolveTestFiles(root, ['suite', 'suite/tracked.test.mjs'], {
    includeGlobs: ['**/*.artifact.test.*', '**/*.test.tsx'],
    excludeGlobs: ['suite/nested/**'],
  }).map((file) => path.relative(root, file).replaceAll('\\', '/'));
  assert.deepEqual(included, ['suite/one.artifact.test.ts', 'suite/pure.test.tsx'],
    'repeatable includes use any-match semantics across discovered and explicit files, then excludes win');
  assert.throws(() => resolveTestFiles(root, ['suite'], {
    includeGlobs: ['**/*.missing.artifact.test.*'],
  }), /No test files remain after applying --include.*adjust or remove the inclusion/u);
  assert.throws(() => resolveTestFiles(root, ['suite'], { includeGlobs: ['/outside/*.test.ts'] }), /repository-relative glob/u);
  assert.throws(() => resolveTestFiles(root, ['suite'], { includeGlobs: ['../outside/*.test.ts'] }), /stay within the repository/u);
  assert.throws(() => resolveTestFiles(root, ['suite/one.artifact.test.ts'], {
    excludeGlobs: ['**/*.artifact.test.*'],
  }), /No test files remain after applying --exclude.*adjust or remove/u);
  assert.throws(() => resolveTestFiles(root, ['suite'], { excludeGlobs: ['/outside/*.test.ts'] }), /repository-relative glob/u);
  assert.throws(() => resolveTestFiles(root, ['suite'], { excludeGlobs: ['../outside/*.test.ts'] }), /stay within the repository/u);
});

test('excluded synthetic artifact tests are never loaded by the standard runner', async (t) => {
  const root = makeGitRepo();
  const fixture = createTestEnvironment();
  const artifact = path.join(root, 'suite', 'load-failure.artifact.test.ts');
  const pure = path.join(root, 'suite', 'pure.test.mjs');
  writeFileSync(artifact, "throw new Error('excluded artifact test was loaded');\n");
  writeFileSync(pure, "import test from 'node:test'; test('ordinary test still runs', () => {});\n");
  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  try {
    const files = resolveTestFiles(root, ['suite'], { excludeGlobs: ['**/*.artifact.test.*'] });
    assert.equal(files.includes(artifact), false);
    assert.deepEqual(files.map((file) => path.relative(root, file).replaceAll('\\', '/')), [
      'suite/pure.test.mjs', 'suite/tracked.test.mjs', 'suite/untracked.test.ts',
    ]);
    const result = await runNodeTests(files, { cwd: repoRoot, env: fixture.env });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    assert.equal(result.teardownConfirmed, true);
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('include globs run only matching artifact files before native child launch', async (t) => {
  const root = makeGitRepo();
  const artifactDirectory = path.join(root, 'suite', 'artifact-only');
  mkdirSync(artifactDirectory);
  const artifact = path.join(artifactDirectory, 'selected.artifact.test.mjs');
  const ordinary = path.join(artifactDirectory, 'must-not-load.test.mjs');
  writeFileSync(artifact, [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "test('artifact selection runs', () => writeFileSync(path.join(process.env.PIE_TEST_FIXTURE_ROOT, 'artifact-ran'), 'yes'));",
  ].join('\n'));
  writeFileSync(ordinary, "throw new Error('non-artifact test was loaded');\n");
  const fixture = createTestEnvironment();
  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  try {
    const files = resolveTestFiles(root, ['suite/artifact-only'], {
      includeGlobs: ['**/*.artifact.test.*'],
    });
    assert.deepEqual(files, [artifact]);
    const result = await runNodeTests(files, { cwd: repoRoot, env: fixture.env });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    assert.equal(result.teardownConfirmed, true);
    assert.equal(readFileSync(path.join(fixture.root, 'artifact-ran'), 'utf8'), 'yes');
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('deleted cached tests are skipped while a relocated untracked test is selected once', (t) => {
  const root = makeGitRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const removed = path.join(root, 'suite', 'removed.test.mjs');
  const relocated = path.join(root, 'suite', 'relocated.test.mjs');
  writeFileSync(removed, '');
  execFileSync('git', ['add', 'suite/removed.test.mjs'], { cwd: root });
  renameSync(removed, relocated);

  const discovered = discoverTrackedTests(root, ['suite']);
  assert.equal(discovered.includes('suite/removed.test.mjs'), false);
  assert.equal(discovered.filter((file) => file === 'suite/relocated.test.mjs').length, 1);
  const selected = resolveTestFiles(root, ['suite', 'suite/relocated.test.mjs'])
    .map((file) => path.relative(root, file).replaceAll('\\', '/'));
  assert.equal(selected.includes('suite/removed.test.mjs'), false);
  assert.equal(selected.filter((file) => file === 'suite/relocated.test.mjs').length, 1);
});

test('explicit files accept focused e2e tests and reject unrelated files', (t) => {
  const root = makeGitRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'suite', 'focused.e2e.ts'), '');
  assert.deepEqual(resolveTestFiles(root, ['suite/focused.e2e.ts']), [path.join(root, 'suite', 'focused.e2e.ts')]);
  assert.throws(() => resolveTestFiles(root, ['suite/not-a-test.ts']), /Explicit test file must end/);
  assert.throws(() => resolveTestFiles(root, ['../outside.test.mjs']), /stay within the repository/);
});

test('CLI rejects unknown options before -- with native forwarding guidance', () => {
  for (const argv of [
    ['--test-name-pattern', 'worker', 'suite'],
    ['suite', '--test-name-pattern=worker'],
    ['suite', '--typo'],
    ['-x', 'suite'],
  ]) {
    assert.throws(() => parseArgs(argv), /Unknown option .*test:file <selector> -- <flags>/u);
  }
  assert.deepEqual(parseArgs(['./-suite', '--', '--test-name-pattern', 'worker']).selectors, ['./-suite']);
  assert.deepEqual(parseArgs(['suite', '--', '--test-name-pattern', 'worker']).nodeFlags,
    ['--test-name-pattern', 'worker']);
});

test('CLI separates selectors and forwards Node test flags after --', () => {
  assert.deepEqual(parseArgs(['--tsconfig', 'application/hosts/vscode/tsconfig.json', '--sdk-path=harness/pi/packages/coding-agent', '--include', '**/*.artifact.test.*', '--include=**/*.generated.test.*', '--exclude', '**/*.artifact.test.*', '--exclude=**/*.generated.test.*', 'scripts', 'test/foo.test.mjs', '--', '--test-name-pattern=worker', '--test-reporter=spec']), {
    selectors: ['scripts', 'test/foo.test.mjs'],
    nodeFlags: ['--test-name-pattern=worker', '--test-reporter=spec'],
    includeGlobs: ['**/*.artifact.test.*', '**/*.generated.test.*'],
    excludeGlobs: ['**/*.artifact.test.*', '**/*.generated.test.*'],
    tsconfig: 'application/hosts/vscode/tsconfig.json',
    sdkPath: 'harness/pi/packages/coding-agent',
  });
  assert.deepEqual(parseArgs(['--exclude=**/*.artifact.test.*', 'suite', '--', '--test']), {
    selectors: ['suite'],
    nodeFlags: ['--test'],
    includeGlobs: [],
    excludeGlobs: ['**/*.artifact.test.*'],
  });
  assert.deepEqual(parseArgs(['suite']), {
    selectors: ['suite'],
    nodeFlags: [],
    includeGlobs: [],
    excludeGlobs: [],
  });
  assert.throws(() => parseArgs(['scripts', '--sdk-path', 'sdk']), /before test selectors/);
  assert.throws(() => parseArgs(['scripts', '--include', '*.artifact.test.*']), /before test selectors/);
  assert.throws(() => parseArgs(['scripts', '--exclude', '*.artifact.test.*']), /before test selectors/);
  assert.throws(() => parseArgs(['--tsconfig']), /--tsconfig requires a path/);
  assert.throws(() => parseArgs(['--sdk-path', '--', 'suite']), /--sdk-path requires a path/);
  assert.throws(() => parseArgs(['--include']), /--include requires a repository-relative glob/);
  assert.throws(() => parseArgs(['--exclude']), /--exclude requires a repository-relative glob/);
  assert.equal(createRunnerTsconfigOverlay(repoRoot), undefined, 'default tests need no tsconfig overlay');
  const args = buildNodeArgs('/tmp/runner.json', [
    '--test-name-pattern=worker', '--test-reporter=spec', '--test-concurrency=2', '--experimental-test-module-mocks',
  ]);
  assert.deepEqual(args, [
    '--import', testEnvironmentPreload, '--import', 'tsx', '--experimental-test-module-mocks',
    path.join(repoRoot, 'scripts', 'verification', 'test-node-runner.mjs'), '/tmp/runner.json',
  ]);
  assert.deepEqual(parseNodeTestFlags(['--test-name-pattern', 'worker', '--test-reporter', 'dot', '--test-concurrency=2']), {
    options: { concurrency: 2, testNamePatterns: ['worker'] },
    processFlags: [],
    reporterNames: ['dot'],
    reporterDestinations: [],
  });
  assert.deepEqual(parseNodeTestFlags([
    '--test-timeout=250', '--test-global-setup=setup.mjs', '--test-rerun-failures=failed.json',
    '--test-shard=1/3', '--test-random-seed=17', '--test-only', '--test-force-exit',
    '--test-randomize', '--experimental-test-coverage', '--test-coverage-lines=90',
    '--test-coverage-branches=80', '--test-coverage-functions=70',
    '--test-coverage-include=src/**', '--test-coverage-exclude=src/ignored/**',
  ]), {
    options: {
      concurrency: 4, timeout: 250, globalSetupPath: 'setup.mjs', rerunFailuresFilePath: 'failed.json',
      shard: { index: 1, total: 3 }, randomSeed: 17, only: true, forceExit: true,
      randomize: true, coverage: true, lineCoverage: 90, branchCoverage: 80, functionCoverage: 70,
      coverageIncludeGlobs: ['src/**'], coverageExcludeGlobs: ['src/ignored/**'],
    },
    processFlags: [],
    reporterNames: [],
    reporterDestinations: [],
  });
  assert.throws(() => parseNodeTestFlags(['--test-isolation=none']), /requires --test-isolation=process/);
});

function writeCandidatePackage(packageRoot, name) {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    exports: { '.': { types: './index.d.ts', import: './index.mjs', require: './index.cjs' } },
  }));
  writeFileSync(path.join(packageRoot, 'index.mjs'), 'export const candidate = true;\n');
  writeFileSync(path.join(packageRoot, 'index.cjs'), 'exports.candidate = true;\n');
  writeFileSync(path.join(packageRoot, 'index.d.ts'), 'export declare const candidate: boolean;\n');
}

function makeCandidateSdk(root, sdkRoot = path.join(root, 'candidate-workspace', 'packages', 'coding-agent')) {
  const names = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'typebox',
  ];
  writeCandidatePackage(sdkRoot, names[0]);
  writeFileSync(path.join(sdkRoot, 'index.mjs'), [
    "import { Type } from 'typebox';",
    'export { Type };',
    'export const candidate = true;',
    "export function createAgent(options) { return { kind: 'fixture-agent', options }; }",
  ].join('\n'));
  writeFileSync(path.join(sdkRoot, 'index.cjs'), [
    "const { Type } = require('typebox');",
    'exports.Type = Type;',
    'exports.candidate = true;',
    "exports.createAgent = options => ({ kind: 'fixture-agent', options });",
  ].join('\n'));
  for (const name of names.slice(1)) {
    const packageRoot = path.join(sdkRoot, 'node_modules', ...name.split('/'));
    writeCandidatePackage(packageRoot, name);
    if (name === 'typebox') {
      writeFileSync(path.join(packageRoot, 'index.mjs'), "export const Type = Object.freeze({ String: () => ({ type: 'string' }) });\n");
      writeFileSync(path.join(packageRoot, 'index.cjs'), "exports.Type = Object.freeze({ String: () => ({ type: 'string' }) });\n");
    }
  }
  return sdkRoot;
}

test('TypeScript test entries use private CJS wrappers while JavaScript tests keep native paths', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-entry-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = [
    path.join(root, 'one.test.ts'),
    path.join(root, 'two.test.tsx'),
    path.join(root, 'ordinary.test.mjs'),
    path.join(root, 'ordinary.test.js'),
  ];
  const mapped = createNodeTestEntries(sources, path.join(root, 'entries'));
  assert.deepEqual(mapped.files.slice(2), sources.slice(2));
  assert.deepEqual(Object.values(mapped.sourceFileByEntry), sources.slice(0, 2));
  for (const entry of mapped.files.slice(0, 2)) {
    assert.equal(path.dirname(entry), path.join(root, 'entries'));
    assert.match(entry, /entry-\d+\.cjs$/u);
    assert.doesNotMatch(entry, /\.test\./u, 'temporary entries are not product test inventory files');
    const content = readFileSync(entry, 'utf8');
    assert.match(content, /createRequire\(/u);
    assert.match(content, /require\(/u);
    assert.ok(content.includes(JSON.stringify(mapped.sourceFileByEntry[entry])));
  }
});

test('native reporters project TypeScript wrapper failures to original source paths', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-reporter-paths-'));
  const fixture = createTestEnvironment();
  const source = path.join(root, 'failure.test.ts');
  const customReporter = path.join(root, 'reporter.mjs');
  const reports = Object.fromEntries(['tap', 'spec', 'custom'].map((name) => [name, path.join(root, `${name}.out`)]));
  writeFileSync(source, "throw new Error('fixture load failure');\n");
  writeFileSync(customReporter, [
    'export default async function* (events) {',
    '  for await (const event of events) {',
    "    yield JSON.stringify({ type: event.type, name: event.data?.name, file: event.data?.file }) + '\\n';",
    '  }',
    '}',
  ].join('\n'));

  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  try {
    for (const [name, reporter] of [['tap', 'tap'], ['spec', 'spec'], ['custom', customReporter]]) {
      const result = await runNodeTests([source], {
        env: fixture.env,
        nodeFlags: [`--test-reporter=${reporter}`, `--test-reporter-destination=${reports[name]}`],
      });
      teardownConfirmed &&= result.teardownConfirmed === true;
      assert.equal(result.code, 1, `${name} reporter preserves the native load-failure exit code`);
    }

    const tap = readFileSync(reports.tap, 'utf8');
    const tapSource = source.replaceAll('\\', '\\\\');
    const tapHeadline = tap.split('\n').find((line) => line.startsWith('not ok 1 - '));
    assert.equal(tapHeadline, `not ok 1 - ${tapSource}`);
    assert.ok(tap.includes(`${tapSource}:1`), 'the actual TypeScript error stack remains source-mapped');

    const specHeadlines = readFileSync(reports.spec, 'utf8').split('\n').filter((line) => line.startsWith('✖ '));
    assert.ok(specHeadlines.some((line) => line.startsWith(`✖ ${source} (`)));
    assert.equal(specHeadlines.some((line) => /entry-\d+\.cjs/u.test(line)), false,
      'spec failure headlines do not expose private wrapper entries');

    const customEvents = readFileSync(reports.custom, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = customEvents.find((event) => event.type === 'test:fail');
    assert.equal(failure?.name, source);
    assert.equal(failure?.file, source);
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('the node-test CLI reserves exit 125 for uncertain teardown and normalizes test failures to 1', async () => {
  assert.equal(TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE, 125);
  const previousExitCode = process.exitCode;
  const previousError = console.error;
  const messages = [];
  let fixtureDisposals = 0;
  let abortDisposals = 0;
  console.error = (...args) => messages.push(args.join(' '));
  try {
    await main(['scripts/verification/test/test-node.test.mjs'], {
      createTestEnvironment: () => ({ env: {}, dispose() { fixtureDisposals += 1; } }),
      abortOnProcessSignals: () => ({ signal: undefined, dispose() { abortDisposals += 1; } }),
      runNodeTestsWithOverlay: async () => {
        throw Object.assign(new Error('Node test process tree teardown is unconfirmed'), { teardownUnconfirmed: true });
      },
    });
    assert.equal(process.exitCode, TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE);
    assert.deepEqual(messages, ['Node test process tree teardown is unconfirmed']);
    assert.equal(fixtureDisposals, 0, 'uncertain teardown retains the test fixture');
    assert.equal(abortDisposals, 0, 'uncertain teardown preserves process-signal ownership');

    messages.length = 0;
    await main(['scripts/verification/test/test-node.test.mjs'], {
      createTestEnvironment: () => ({ env: {}, dispose() { fixtureDisposals += 1; } }),
      abortOnProcessSignals: () => ({ signal: undefined, dispose() { abortDisposals += 1; } }),
      runNodeTestsWithOverlay: async () => ({ code: 1, teardownConfirmed: true }),
    });
    assert.equal(process.exitCode, 1, 'ordinary aggregate test failure does not inherit the reserved status');
    assert.deepEqual(messages, []);
    assert.equal(fixtureDisposals, 1);
    assert.equal(abortDisposals, 1);
  } finally {
    process.exitCode = previousExitCode;
    console.error = previousError;
  }
});

test('the node-test CLI includes retained teardown diagnostic paths in its error', async () => {
  const previousExitCode = process.exitCode;
  const previousError = console.error;
  const messages = [];
  const diagnosticPath = path.join(os.tmpdir(), 'pie-retained-teardown.json');
  console.error = (...args) => messages.push(args.join(' '));
  try {
    await main(['scripts/verification/test/test-node.test.mjs'], {
      createTestEnvironment: () => ({ env: {}, dispose() {} }),
      abortOnProcessSignals: () => ({ signal: undefined, dispose() {} }),
      runNodeTestsWithOverlay: async () => {
        throw Object.assign(new Error('Node test process tree teardown is unconfirmed'), {
          teardownUnconfirmed: true,
          diagnosticPath,
        });
      },
    });
    assert.equal(process.exitCode, TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE);
    assert.deepEqual(messages, [`Node test process tree teardown is unconfirmed\nDiagnostic: ${diagnosticPath}`]);
  } finally {
    process.exitCode = previousExitCode;
    console.error = previousError;
  }
});

test('a product test exiting 125 remains ordinary aggregate failure code 1', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-product-exit-125-'));
  const fixture = createTestEnvironment();
  const source = path.join(root, 'product-exit.test.mjs');
  writeFileSync(source, 'process.exit(125);\n');
  let teardownConfirmed = false;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  try {
    const result = await runNodeTests([source], { env: fixture.env });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 1, 'native node:test aggregates an individual product process exit 125 to ordinary failure 1');
    assert.equal(result.teardownConfirmed, true);
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('test wrappers and runner config survive unconfirmed process-tree teardown', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-unconfirmed-teardown-'));
  const source = path.join(root, 'uncertain.test.ts');
  writeFileSync(source, "import test from 'node:test'; test('fixture', () => {});\n");
  let configPath;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (configPath) rmSync(path.dirname(configPath), { recursive: true, force: true });
  });

  await assert.rejects(runNodeTests([source], {
    sdkPath: '/selected/sdk',
    spawnImpl(_executable, args) {
      configPath = args.at(-1);
      const child = new EventEmitter();
      child.pid = 71234;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    watchChildProcessImpl: () => ({
      timedOut: false,
      aborted: false,
      settle: async () => ({
        gone: false,
        survivors: [71234, 71235],
        ownedPids: [71234, 71235],
        ownedProcesses: [
          { pid: 71234, ppid: 10, identity: 'root-creation-id' },
          { pid: 71235, ppid: 71234, identity: 'child-creation-id' },
        ],
        survivorProcesses: [
          { pid: 71234, ppid: 10, identity: 'root-creation-id' },
          { pid: 71235, ppid: 71234, identity: 'child-creation-id' },
        ],
        diagnostics: ['forced termination failed: fixture'],
      }),
    }),
  }), (error) => error.teardownUnconfirmed === true);

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const entry = config.files[0];
  assert.ok(existsSync(configPath), 'the runner config remains while teardown is uncertain');
  assert.ok(existsSync(entry), 'the CJS test entry remains while teardown is uncertain');
  assert.equal(config.sourceFileByEntry[entry], source, 'the retained entry keeps its original source mapping');
  const diagnosticPath = path.join(path.dirname(configPath), 'teardown.json');
  assert.ok(existsSync(diagnosticPath), 'an unconfirmed teardown writes retained diagnostics beside the runner config');
  const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
  assert.equal(diagnostic.rootChildPid, 71234);
  assert.equal(diagnostic.owner.pid, process.pid);
  assert.equal(diagnostic.sdkSelection.explicit, true);
  assert.equal(diagnostic.sdkSelection.path, '/selected/sdk');
  assert.deepEqual(diagnostic.ownedProcesses.map(({ pid, identity }) => [pid, identity]), [
    [71234, 'root-creation-id'], [71235, 'child-creation-id'],
  ]);
  assert.deepEqual(diagnostic.survivorProcesses.map(({ pid, identity }) => [pid, identity]), [
    [71234, 'root-creation-id'], [71235, 'child-creation-id'],
  ]);
  assert.match(diagnostic.whyUnknown[0], /still observed captured PID/u);
  assert.deepEqual(diagnostic.diagnostics, ['forced termination failed: fixture']);

  let confirmedConfigPath;
  let confirmedEntry;
  let captureComplete = false;
  const completed = await runNodeTests([source], {
    spawnImpl(_executable, args) {
      confirmedConfigPath = args.at(-1);
      const config = JSON.parse(readFileSync(confirmedConfigPath, 'utf8'));
      confirmedEntry = config.files[0];
      assert.equal(config.waitForOwnership, true);
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = token => {
        assert.equal(captureComplete, true);
        assert.equal(token, 'pie-focused-ownership-ready\n');
      };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    watchChildProcessImpl: () => {
      captureComplete = true;
      return {
        ownershipReady: true,
        timedOut: false,
        aborted: false,
        settle: async () => ({ gone: true }),
      };
    },
  });
  assert.equal(completed.teardownConfirmed, true);
  assert.equal(existsSync(confirmedConfigPath), false, 'the runner config is removed after confirmed teardown');
  assert.equal(existsSync(confirmedEntry), false, 'the CJS entry is removed after confirmed teardown');
  assert.equal(existsSync(path.dirname(confirmedConfigPath)), false, 'the temporary runner directory is removed after confirmed teardown');
});

for (const state of [{ ownershipReady: false }, { ownershipReady: true, terminationStarted: true }]) {
test(`failed or cancelled ownership startup never releases the short suite (${JSON.stringify(state)})`, async () => {
  let released = false;
  let settled = false;
  await assert.rejects(runNodeTests([], {
    spawnImpl(_executable, args, options) {
      assert.deepEqual(options.stdio, ['pipe', 'inherit', 'inherit']);
      assert.equal(JSON.parse(readFileSync(args.at(-1), 'utf8')).waitForOwnership, true);
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => { released = true; };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    watchChildProcessImpl: () => ({
      ...state,
      settle: async () => { settled = true; return { gone: true }; },
    }),
  }), /ownership startup handshake failed/u);
  assert.equal(released, false);
  assert.equal(settled, true);
});
}

test('unconfirmed native SDK teardown retains its reader registration', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-sdk-reader-retained-'));
  const sdkRoot = makeCandidateSdk(root, path.join(root, 'harness', 'pi', 'packages', 'coding-agent'));
  const source = path.join(root, 'suite.test.mjs');
  writeFileSync(source, "import test from 'node:test'; test('fixture', () => {});\n");
  let configPath;
  let overlayDisposals = 0;
  const overlay = { configPath: path.join(root, 'overlay.json'), dispose() { overlayDisposals += 1; } };
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (configPath) rmSync(path.dirname(configPath), { recursive: true, force: true });
  });

  await assert.rejects(runNodeTestsWithOverlay([source], { repoRoot: root, sdkPath: sdkRoot, env: {} }, {
    createOverlay: () => overlay,
    run: (files, options) => runNodeTests(files, {
      ...options,
      spawnImpl(_executable, args) {
        configPath = args.at(-1);
        const child = new EventEmitter();
        child.pid = 71300;
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
      watchChildProcessImpl: () => ({
        timedOut: false,
        aborted: false,
        settle: async () => ({
          gone: false,
          survivors: [71300],
          ownedPids: [71300],
          ownedProcesses: [{ pid: 71300, ppid: 10, identity: 'sdk-runner-creation-id' }],
          survivorProcesses: [{ pid: 71300, ppid: 10, identity: 'sdk-runner-creation-id' }],
          diagnostics: [],
        }),
      }),
    }),
  }), (error) => error.teardownUnconfirmed === true);

  const readerDirectory = path.join(root, 'harness', 'pi', '.cache', 'development-runtime', 'readers');
  const registrations = readdirSync(readerDirectory);
  assert.equal(registrations.length, 1, 'the SDK reader registration is retained while child teardown is uncertain');
  const registration = JSON.parse(readFileSync(path.join(readerDirectory, registrations[0]), 'utf8'));
  assert.equal(registration.kind, 'reader');
  assert.equal(registration.workspaceRoot, realpathSync.native(path.join(root, 'harness', 'pi')));
  assert.equal(overlayDisposals, 0, 'SDK aliases remain available while the reader registration is retained');
  const diagnostic = JSON.parse(readFileSync(path.join(path.dirname(configPath), 'teardown.json'), 'utf8'));
  assert.equal(diagnostic.sdkSelection.path, realpathSync.native(sdkRoot));
});

test('teardown diagnostic write failure preserves reserved unconfirmed status', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-diagnostic-write-failure-'));
  const source = path.join(root, 'uncertain.test.mjs');
  writeFileSync(source, '');
  const diagnosticWriteError = new Error('fixture diagnostic write failure');
  const previousExitCode = process.exitCode;
  const previousError = console.error;
  const messages = [];
  let configPath;
  let observedError;
  let fixtureDisposals = 0;
  let abortDisposals = 0;
  console.error = (...args) => messages.push(args.join(' '));
  t.after(() => {
    process.exitCode = previousExitCode;
    console.error = previousError;
    rmSync(root, { recursive: true, force: true });
    if (configPath) rmSync(path.dirname(configPath), { recursive: true, force: true });
  });

  await main(['scripts/verification/test/test-node.test.mjs'], {
    createTestEnvironment: () => ({ env: {}, dispose() { fixtureDisposals += 1; } }),
    abortOnProcessSignals: () => ({ signal: undefined, dispose() { abortDisposals += 1; } }),
    runNodeTestsWithOverlay: async (_files, options) => {
      try {
        return await runNodeTests([source], {
          env: options.env,
          spawnImpl(_executable, args) {
            configPath = args.at(-1);
            const child = new EventEmitter();
            child.pid = 71301;
            queueMicrotask(() => child.emit('close', 0));
            return child;
          },
          watchChildProcessImpl: () => ({ settle: async () => ({ gone: false }) }),
          writeTeardownDiagnosticImpl: () => { throw diagnosticWriteError; },
        });
      } catch (error) {
        observedError = error;
        throw error;
      }
    },
  });

  assert.equal(process.exitCode, TEST_TEARDOWN_UNCONFIRMED_EXIT_CODE);
  assert.equal(observedError?.teardownUnconfirmed, true);
  assert.equal(observedError?.message, 'Node test process tree teardown is unconfirmed');
  assert.equal(observedError?.diagnosticWriteError, diagnosticWriteError, 'the diagnostic write failure is retained without replacing teardown uncertainty');
  assert.deepEqual(messages, ['Node test process tree teardown is unconfirmed']);
  assert.equal(fixtureDisposals, 0, 'a diagnostic write failure cannot release the test fixture');
  assert.equal(abortDisposals, 0, 'a diagnostic write failure cannot release process-signal ownership');
});

test('explicit config and SDK options build executable aliases with the host Preact require singleton', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-sdk-overlay-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const sdkPath = makeCandidateSdk(fixtureRoot);
  const resolvedSdkPath = resolveTestSdkPath(repoRoot, sdkPath);
  assert.equal(resolveTestSdkPath(fixtureRoot, path.relative(fixtureRoot, sdkPath)), resolvedSdkPath);
  const tsconfigPath = path.join(repoRoot, 'application', 'hosts', 'vscode', 'tsconfig.json');
  const overlay = createRunnerTsconfigOverlay(repoRoot, { tsconfigPath, sdkPath });
  assert.ok(overlay);
  t.after(() => overlay.dispose());

  const config = JSON.parse(readFileSync(overlay.configPath, 'utf8'));
  assert.equal(config.extends, tsconfigPath);
  const paths = config.compilerOptions.paths;
  for (const name of [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    '@mariozechner/pi-coding-agent',
    '@mariozechner/pi-agent-core',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-tui',
    'typebox',
    '@sinclair/typebox',
  ]) {
    const target = paths[name]?.[0];
    assert.ok(target, `missing candidate alias ${name}`);
    const resolvedTarget = realpathSync.native(target);
    const relativeTarget = path.relative(resolvedSdkPath, resolvedTarget);
    assert.ok(relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget),
      `candidate alias ${name} escaped the selected SDK: ${resolvedTarget} (SDK ${resolvedSdkPath})`);
  }
  const hostPreact = path.join(repoRoot, 'application', 'hosts', 'vscode', 'node_modules', 'preact');
  assert.equal(paths.preact[0], path.join(hostPreact, 'dist', 'preact.js'));
  assert.equal(paths['preact/hooks'][0], path.join(hostPreact, 'hooks', 'dist', 'hooks.js'));
  assert.ok(paths.yaml[0].startsWith(path.join(repoRoot, 'application', 'hosts', 'vscode', 'node_modules')));
});

test('config overlay executes moved-source dependencies with shared Preact and SDK TypeBox identities', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-overlay-execution-'));
  const fixture = createTestEnvironment();
  const testFile = path.join(root, 'aliases.test.ts');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(testFile, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { h } from 'preact';",
    "import { useState } from 'preact/hooks';",
    "import render from 'preact-render-to-string';",
    "import { parse } from 'yaml';",
    "import * as currentSdk from '@earendil-works/pi-coding-agent';",
    "import * as legacySdk from '@mariozechner/pi-coding-agent';",
    "import { Type as currentType } from 'typebox';",
    "import { Type as legacyType } from '@sinclair/typebox';",
    "import { createRequire } from 'node:module';",
    "test('owner and candidate aliases share their runtime singletons', () => {",
    "  function Counter() { const [count] = useState(7); return h('span', null, count); }",
    "  assert.equal(render(h(Counter)), '<span>7</span>');",
    "  assert.equal(parse('answer: 42').answer, 42);",
    '  assert.equal(currentSdk.candidate, true);',
    '  assert.equal(legacySdk.candidate, true);',
    '  assert.equal(currentSdk.Type, legacySdk.Type);',
    '  assert.equal(currentSdk.Type, currentType);',
    '  assert.equal(currentType, legacyType);',
    "  assert.deepEqual(currentType.String(), { type: 'string' });",
    "  assert.deepEqual(currentSdk.createAgent({ provider: 'fixture-only' }), { kind: 'fixture-agent', options: { provider: 'fixture-only' } });",
    '  const requireFromSource = createRequire(import.meta.url);',
    "  assert.equal(requireFromSource('typebox').Type, currentType);",
    "  assert.equal(requireFromSource('@sinclair/typebox').Type, currentType);",
    '});',
  ].join('\n'));
  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  try {
    const result = await runNodeTestsWithOverlay([testFile], {
      env: fixture.env,
      nodeFlags: ['--test-name-pattern=candidate aliases'],
      tsconfigPath: path.join(repoRoot, 'application', 'hosts', 'vscode', 'tsconfig.json'),
      sdkPath: makeCandidateSdk(root),
    });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    assert.equal(result.teardownConfirmed, true);
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('runner overlay is disposed only after confirmed test-tree teardown', async () => {
  let disposed = 0;
  let receivedEnv;
  const overlay = { configPath: '/tmp/tsconfig.overlay.json', dispose() { disposed += 1; } };
  const createOverlay = () => overlay;
  const run = async (_files, options) => {
    receivedEnv = options.env;
    return { code: 0, teardownConfirmed: true };
  };
  const result = await runNodeTestsWithOverlay(['suite.test.mjs'], {
    env: { BASE: 'kept' },
  }, { createOverlay, run });
  assert.equal(result.code, 0);
  assert.equal(receivedEnv.BASE, 'kept');
  assert.equal(receivedEnv.TSX_TSCONFIG_PATH, overlay.configPath);
  assert.equal(disposed, 1);

  disposed = 0;
  await assert.rejects(runNodeTestsWithOverlay(['suite.test.mjs'], {}, {
    createOverlay,
    run: async () => { throw Object.assign(new Error('uncertain child teardown'), { teardownUnconfirmed: true }); },
  }), /uncertain child teardown/);
  assert.equal(disposed, 0, 'preserve the overlay when process-tree teardown is uncertain');
});

test('unsupported explicit SDK setup fails closed without retrying another SDK or native route', async () => {
  let runnerStarted = false;
  await assert.rejects(runNodeTestsWithOverlay(['suite.test.ts'], {
    sdkPath: path.join(os.tmpdir(), 'pie-node-not-an-sdk'),
  }, {
    run: async () => { runnerStarted = true; return { code: 0, teardownConfirmed: true }; },
  }), /Expected @earendil-works\/pi-coding-agent package manifest/);
  assert.equal(runnerStarted, false, 'invalid explicit SDK selection is not silently retried without aliases');
});

test('test environment uses fresh user/auth/data/agent fixtures without ambient credentials', () => {
  const ambientAuth = mkdtempSync(path.join(os.tmpdir(), 'pie-node-ambient-auth-'));
  writeFileSync(path.join(ambientAuth, 'auth.json'), 'fixture-only-placeholder');
  const userPaths = {
    HOME: '/private/home',
    USERPROFILE: 'C:/private/home',
    APPDATA: 'C:/private/roaming',
    LOCALAPPDATA: 'C:/private/local',
    XDG_CONFIG_HOME: '/private/xdg/config',
    XDG_DATA_HOME: '/private/xdg/data',
    XDG_CACHE_HOME: '/private/xdg/cache',
    PI_CONFIG_DIR: '/private/config',
    PI_CODING_AGENT_AUTH_DIR: ambientAuth,
    PI_CODING_AGENT_DIR: '/private/agent',
    PI_CODING_AGENT_SESSION_DIR: '/private/sessions',
    PIE_DATA_DIR: '/private/data',
    PIE_CACHE_DIR: '/private/cache',
  };
  const sourceEnv = {
    ...userPaths,
    PIE_STORAGE_CUTOFF_AUTHORIZATION: 'ambient-cutoff',
    TSX_TSCONFIG_PATH: '/private/config/overlay.json',
    PIE_DEVELOPMENT_PI_RUNTIME: '/private/runtime',
    PIE_HOST_COORDINATOR_PORT: '1234',
    GIT_DIR: '/private/repo/.git',
  };
  const originalSourceEnv = { ...sourceEnv };
  const fixture = createTestEnvironment(sourceEnv);
  try {
    assert.deepEqual(sourceEnv, originalSourceEnv, 'creating test fixtures does not mutate caller-owned user paths');
    assert.equal(fixture.env.PIE_TEST_FIXTURE_ROOT, fixture.root);
    assert.equal(fixture.env.HOME, fixture.directories.home);
    assert.equal(fixture.env.USERPROFILE, fixture.directories.home);
    assert.equal(fixture.env.APPDATA, fixture.directories.appData);
    assert.equal(fixture.env.LOCALAPPDATA, fixture.directories.localAppData);
    assert.equal(fixture.env.XDG_CONFIG_HOME, fixture.directories.xdgConfig);
    assert.equal(fixture.env.XDG_DATA_HOME, fixture.directories.xdgData);
    assert.equal(fixture.env.XDG_CACHE_HOME, fixture.directories.xdgCache);
    assert.equal(fixture.env.PI_CODING_AGENT_AUTH_DIR, fixture.directories.auth);
    assert.equal(fixture.env.PI_CODING_AGENT_DIR, fixture.directories.agent);
    assert.equal(fixture.env.PI_CODING_AGENT_SESSION_DIR, fixture.directories.sessions);
    assert.equal(fixture.env.PIE_DATA_DIR, fixture.directories.data);
    assert.equal(fixture.env.PIE_CACHE_DIR, fixture.directories.cache);
    assert.equal(fixture.env.PI_CONFIG_DIR, fixture.directories.config);
    assert.equal(fixture.env.PIE_STORAGE_CUTOFF_AUTHORIZATION, undefined);
    assert.equal(fixture.env.PIE_DEVELOPMENT_PI_RUNTIME, undefined);
    assert.equal(fixture.env.PIE_HOST_COORDINATOR_PORT, undefined);
    assert.equal(fixture.env.GIT_DIR, undefined);
    assert.equal(fixture.env.TSX_TSCONFIG_PATH, undefined);
    assert.deepEqual(readdirSync(fixture.directories.auth), []);
    assert.deepEqual(readdirSync(fixture.directories.data), []);
    assert.deepEqual(readdirSync(fixture.directories.config), []);
    assert.deepEqual(readdirSync(fixture.directories.appData), []);
    assert.deepEqual(readdirSync(fixture.directories.localAppData), []);
    assert.deepEqual(readdirSync(fixture.directories.xdgConfig), []);
    assert.deepEqual(readdirSync(fixture.directories.xdgData), []);
    assert.deepEqual(readdirSync(fixture.directories.xdgCache), []);
  } finally {
    fixture.dispose();
    rmSync(ambientAuth, { recursive: true, force: true });
  }
});

test('native sibling test files receive separate process fixtures and preserve user paths', async () => {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-sibling-files-'));
  const fixture = createTestEnvironment();
  const userPathKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
  const userPathsBefore = Object.fromEntries(userPathKeys.map((key) => [key, process.env[key]]));
  const observations = path.join(fixture.root, 'observations');
  mkdirSync(observations, { recursive: true });
  for (const label of ['first', 'second']) {
    writeFileSync(path.join(sourceRoot, `${label}.test.mjs`), [
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import test from 'node:test';",
      "test('uses a child-PID fixture without sharing data state', () => {",
      '  const env = process.env;',
      '  const pidRoot = path.join(env.PIE_TEST_FIXTURE_ROOT, `process-${process.pid}`);',
      '  const directories = [env.HOME, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.PI_CONFIG_DIR, env.PI_CODING_AGENT_AUTH_DIR, env.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_SESSION_DIR, env.PIE_DATA_DIR, env.PIE_CACHE_DIR];',
      '  assert.ok(directories.every((directory) => directory.startsWith(pidRoot + path.sep)));',
      "  assert.ok(process.execArgv.includes('--experimental-test-module-mocks'), 'module-mock flag reaches the isolated test process');",
      "  writeFileSync(path.join(env.PIE_DATA_DIR, 'state.txt'), String(process.pid));",
      `  writeFileSync(path.join(env.PIE_TEST_FIXTURE_ROOT, 'observations', '${label}.json'), JSON.stringify({ pid: process.pid, data: env.PIE_DATA_DIR, home: env.HOME }));`,
      '});',
      "test('filtered out by native name pattern', () => { throw new Error('unexpected filtered test'); });",
    ].join('\n'));
  }

  let teardownConfirmed = true;
  try {
    const { runNodeTests } = await import('../test-node.mjs');
    const result = await runNodeTests([path.join(sourceRoot, 'first.test.mjs'), path.join(sourceRoot, 'second.test.mjs')], {
      env: fixture.env,
      nodeFlags: [
        '--test-name-pattern=uses a child-PID fixture', '--test-reporter=spec', '--test-concurrency=2',
        '--experimental-test-module-mocks', '--experimental-test-coverage', '--test-coverage-lines=0',
      ],
    });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    assert.equal(result.teardownConfirmed, true);

    const reports = ['first', 'second'].map((label) => JSON.parse(readFileSync(path.join(observations, `${label}.json`), 'utf8')));
    assert.notEqual(reports[0].pid, reports[1].pid);
    assert.notEqual(reports[0].data, reports[1].data);
    for (const report of reports) {
      assert.equal(report.home, path.join(fixture.root, `process-${report.pid}`, 'home'));
      assert.equal(readFileSync(path.join(report.data, 'state.txt'), 'utf8'), String(report.pid), 'a sibling did not overwrite this process fixture');
    }
    assert.deepEqual(Object.fromEntries(userPathKeys.map((key) => [key, process.env[key]])), userPathsBefore,
      'the invoking process user paths remain unchanged');
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  } finally {
    if (teardownConfirmed) {
      fixture.dispose();
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }
});

test('TypeScript CJS entries preserve original ESM-scope source behavior and per-file isolation', async (t) => {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-typescript-entry-'));
  const fixture = createTestEnvironment();
  const observations = path.join(fixture.root, 'typescript-entry-observations');
  mkdirSync(observations, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  const sourceTs = path.join(sourceRoot, 'first.test.ts');
  const sourceTsx = path.join(sourceRoot, 'second.test.tsx');
  const sourceJs = path.join(sourceRoot, 'native.test.js');
  const sourceMjs = path.join(sourceRoot, 'native.test.mjs');
  const files = [sourceTs, sourceTsx, sourceJs, sourceMjs];
  writeFileSync(path.join(sourceRoot, 'legacy.cjs'), "module.exports = Object.fromEntries([['answer', 42]]);\n");
  writeFileSync(path.join(sourceRoot, 'hooked.cts'), 'export const hooked = 73;\n');
  writeFileSync(path.join(sourceRoot, 'dynamic.mjs'), 'export const dynamicValue = 91;\n');
  writeFileSync(path.join(sourceRoot, 'mocked.mjs'), 'export const value = \'real\';\n');
  writeFileSync(sourceTs, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { writeFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "import path from 'node:path';",
    "import { answer } from './legacy.cjs';",
    "import { hooked } from './hooked.cts';",
    'test(\'CJS require keeps source imports and source paths\', async t => {',
    '  assert.equal(answer, 42);',
    '  assert.equal(hooked, 73);',
    `  assert.equal(path.dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(sourceRoot)});`,
    `  assert.equal(import.meta.url, ${JSON.stringify(pathToFileURL(sourceTs).href)});`,
    "  assert.equal((await import('./dynamic.mjs')).dynamicValue, 91);",
    "  const target = { run: () => 'original' };",
    "  const spy = t.mock.method(target, 'run', () => 'mocked');",
    "  assert.equal(target.run(), 'mocked');",
    '  assert.equal(spy.mock.callCount(), 1);',
    "  await t.test('subtests remain attached to their source test', () => assert.equal(target.run(), 'mocked'));",
    "  await t.mock.module('./mocked.mjs', { exports: { value: 'mocked' } });",
    "  assert.equal((await import('./mocked.mjs')).value, 'mocked');",
    "  globalThis.__pieNodeTestEntryGlobal = 'first';",
    `  writeFileSync(path.join(${JSON.stringify(observations)}, 'typescript.json'), JSON.stringify({ pid: process.pid, url: import.meta.url }));`,
    '});',
  ].join('\n'));
  writeFileSync(sourceTsx, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'test(\'tsx source has a fresh process global\', () => {',
    "  assert.equal(globalThis.__pieNodeTestEntryGlobal, undefined);",
    "  globalThis.__pieNodeTestEntryGlobal = 'second';",
    `  writeFileSync(path.join(${JSON.stringify(observations)}, 'tsx.json'), String(process.pid));`,
    '});',
  ].join('\n'));
  for (const [source, label] of [[sourceJs, 'js'], [sourceMjs, 'mjs']]) {
    writeFileSync(source, [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      'test(\'native JavaScript keeps a fresh process\', () => {',
      "  assert.equal(globalThis.__pieNodeTestEntryGlobal, undefined);",
      `  writeFileSync(path.join(${JSON.stringify(observations)}, '${label}.json'), String(process.pid));`,
      '});',
    ].join('\n'));
  }

  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(sourceRoot, { recursive: true, force: true });
  });
  try {
    const result = await runNodeTests(files, {
      env: { ...fixture.env, PIE_TEST_FILE_DIAGNOSTICS: '1' },
      nodeFlags: ['--test-concurrency=4', '--experimental-test-module-mocks'],
    });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    const pids = files.map((source, index) => {
      const label = ['typescript', 'tsx', 'js', 'mjs'][index];
      const observation = readFileSync(path.join(observations, `${label}.json`), 'utf8');
      return label === 'typescript' ? JSON.parse(observation).pid : observation;
    });
    assert.equal(new Set(pids).size, files.length, 'each original test file receives its own native process');
    assert.equal(JSON.parse(readFileSync(path.join(observations, 'typescript.json'), 'utf8')).url, pathToFileURL(sourceTs).href);
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('native coverage options enforce thresholds while honoring include and exclude globs', async (t) => {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-coverage-'));
  const fixture = createTestEnvironment();
  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  const includedModule = path.join(sourceRoot, 'coverage-included.mjs');
  const excludedModule = path.join(sourceRoot, 'coverage-excluded.mjs');
  const unincludedModule = path.join(sourceRoot, 'other-unincluded.mjs');
  const testFile = path.join(sourceRoot, 'coverage.test.mjs');
  const coverageIncludeGlob = path.join(sourceRoot, 'coverage-*.mjs').replaceAll('\\', '/');
  const coverageExcludeGlob = excludedModule.replaceAll('\\', '/');
  writeFileSync(includedModule, "export function choose(value) { return value ? 'yes' : 'no'; }\n");
  writeFileSync(excludedModule, 'export function chooseExcluded(value) { return value ? true : false; }\n');
  writeFileSync(unincludedModule, "export function chooseUnincluded(value) { return value ? 'yes' : 'no'; }\n");

  const runCoverageFixture = async (coverEveryBranch, marker) => {
    writeFileSync(testFile, [
      "import assert from 'node:assert/strict';",
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import test from 'node:test';",
      "import { choose } from './coverage-included.mjs';",
      "import { chooseExcluded } from './coverage-excluded.mjs';",
      "import { chooseUnincluded } from './other-unincluded.mjs';",
      "test('fixture assertions pass', () => {",
      "  assert.equal(choose(true), 'yes');",
      ...(coverEveryBranch ? ["  assert.equal(choose(false), 'no');"] : []),
      '  assert.equal(chooseExcluded(true), true);',
      "  assert.equal(chooseUnincluded(true), 'yes');",
      `  writeFileSync(path.join(process.env.PIE_TEST_FIXTURE_ROOT, '${marker}'), 'passed');`,
      '});',
    ].join('\n'));

    try {
      return await runNodeTests([testFile], {
        cwd: repoRoot,
        env: fixture.env,
        nodeFlags: [
          '--experimental-test-coverage',
          '--test-coverage-lines=100',
          '--test-coverage-branches=100',
          '--test-coverage-functions=100',
          `--test-coverage-include=${coverageIncludeGlob}`,
          `--test-coverage-exclude=${coverageExcludeGlob}`,
        ],
      });
    } catch (error) {
      if (error?.teardownUnconfirmed === true) teardownConfirmed = false;
      throw error;
    }
  };

  const fullyCovered = await runCoverageFixture(true, 'coverage-pass-marker');
  teardownConfirmed &&= fullyCovered.teardownConfirmed === true;
  assert.equal(fullyCovered.code, 0, '100% native line/branch/function thresholds pass when the included fixture is fully covered');
  assert.equal(readFileSync(path.join(fixture.root, 'coverage-pass-marker'), 'utf8'), 'passed');

  const uncoveredBranch = await runCoverageFixture(false, 'coverage-threshold-marker');
  teardownConfirmed &&= uncoveredBranch.teardownConfirmed === true;
  assert.equal(readFileSync(path.join(fixture.root, 'coverage-threshold-marker'), 'utf8'), 'passed',
    'the native test case itself passes despite leaving one included branch uncovered');
  assert.equal(uncoveredBranch.code, 1,
    'the native runner exits nonzero when the 100% branch coverage threshold is violated');

  const typedModule = path.join(sourceRoot, 'coverage-underlying.ts');
  const typedTest = path.join(sourceRoot, 'coverage-underlying.test.ts');
  const typedReport = path.join(fixture.root, 'typescript-coverage-report.txt');
  writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(typedModule, "export function chooseTyped(value: boolean) { return value ? 'yes' : 'no'; }\n");
  writeFileSync(typedTest, [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { chooseTyped } from './coverage-underlying.ts';",
    "test('typed coverage fixture', () => assert.equal(chooseTyped(true), 'yes'));",
  ].join('\n'));
  let spawned = false;
  assert.throws(() => runNodeTests([typedTest], {
    env: fixture.env,
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
    nodeFlags: [
      '--experimental-test-coverage', '--test-coverage-lines=100', '--test-coverage-branches=100',
      '--test-coverage-functions=100', `--test-coverage-include=${typedModule.replaceAll('\\', '/')}`,
      '--test-reporter=spec', `--test-reporter-destination=${typedReport}`,
    ],
  }), /TypeScript native coverage unqualified; retained legacy coverage gate/u);
  assert.equal(spawned, false, 'unqualified TypeScript coverage cannot spawn or report a false pass');
  assert.equal(existsSync(typedReport), false);
});

test('explicit source maps cannot bypass the unqualified TypeScript coverage guard', async () => {
  // Node 24.16.0 + tsx 4.22.3 still reports untouched TS lines/functions as
  // 100% covered with --enable-source-maps. Do not qualify by filenames alone.
  for (const extension of ['ts', 'tsx']) {
    const files = [`suite.test.${extension}`];
    const nodeFlags = ['--enable-source-maps', '--experimental-test-coverage', '--test-coverage-functions=100'];
    assert.throws(() => assertCoverageQualification(files, nodeFlags), /TypeScript native coverage unqualified/u);
    let spawned = false;
    assert.throws(() => runNodeTests(files, {
      nodeFlags,
      spawnImpl() { spawned = true; throw new Error('must not spawn'); },
    }), /TypeScript native coverage unqualified/u);
    assert.equal(spawned, false);
    let overlayCreated = false;
    let runnerStarted = false;
    await assert.rejects(runNodeTestsWithOverlay(files, { nodeFlags }, {
      createOverlay() { overlayCreated = true; },
      run: async () => { runnerStarted = true; },
    }), /TypeScript native coverage unqualified/u);
    assert.equal(overlayCreated, false, 'coverage refusal precedes alias/SDK setup');
    assert.equal(runnerStarted, false);
    assert.doesNotThrow(() => assertCoverageQualification(files, ['--enable-source-maps']),
      'source maps without coverage remain supported');
  }
  assert.doesNotThrow(() => assertCoverageQualification(['suite.test.mjs'], [
    '--enable-source-maps', '--experimental-test-coverage',
  ]), 'JavaScript coverage remains supported');
});

test('many long test paths stay off Windows command lines and retain per-file processes', async (t) => {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-node-long-paths-'));
  const fixture = createTestEnvironment();
  const markerRoot = path.join(fixture.root, 'many-file-markers');
  mkdirSync(markerRoot, { recursive: true });
  let teardownConfirmed = true;
  t.after(() => {
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(sourceRoot, { recursive: true, force: true });
  });
  const files = [];
  const fileCount = 140;
  const targetPathLength = 240;
  for (let index = 0; index < fileCount; index += 1) {
    const fileName = `case-${index}.test.mjs`;
    const prefix = `file-${index}-`;
    const directoryLength = targetPathLength - sourceRoot.length - fileName.length - 2;
    assert.ok(directoryLength >= prefix.length && directoryLength <= 255);
    const directory = path.join(sourceRoot, prefix + 'x'.repeat(directoryLength - prefix.length));
    mkdirSync(directory);
    const testFile = path.join(directory, fileName);
    assert.equal(testFile.length, targetPathLength);
    files.push(testFile);
    writeFileSync(testFile, [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import test from 'node:test';",
      "import { randomUUID } from 'node:crypto';",
      "const instanceKey = Symbol.for('pie.node-long-paths.process-instance');",
      'globalThis[instanceKey] ??= randomUUID();',
      `test('writes an isolated marker', () => writeFileSync(path.join(process.env.PIE_NODE_TEST_MARKERS, '${index}'), JSON.stringify({ pid: process.pid, instance: globalThis[instanceKey] })));`,
    ].join('\n'));
  }
  const aggregateArgLength = files.reduce((length, file) => length + file.length + 1, 0);
  assert.ok(aggregateArgLength > 32 * 1024, `fixture paths total ${aggregateArgLength} characters`);
  const env = { ...fixture.env, PIE_NODE_TEST_MARKERS: markerRoot };
  try {
    const { runNodeTests } = await import('../test-node.mjs');
    const { spawn } = await import('node:child_process');
    const invocations = [];
    const result = await runNodeTests(files, {
      env,
      nodeFlags: ['--test-reporter=dot', '--test-concurrency=4'],
      spawnImpl(command, args, options) {
        invocations.push({ command, args });
        return spawn(command, args, options);
      },
    });
    teardownConfirmed = result.teardownConfirmed === true;
    assert.equal(result.code, 0);
    const markers = readdirSync(markerRoot);
    assert.equal(markers.length, fileCount);
    assert.deepEqual(markers.sort(), Array.from({ length: fileCount }, (_, index) => String(index)).sort(),
      'every selected test file wrote its marker');
    const reports = markers.map((marker) => JSON.parse(readFileSync(path.join(markerRoot, marker), 'utf8')));
    for (const report of reports) {
      assert.ok(Number.isInteger(report.pid) && report.pid > 0, 'each instance records its numeric PID');
      assert.match(report.instance, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    }
    // Numeric PIDs may be reused after exit; the global nonce is shared by any files batched in one process.
    assert.equal(new Set(reports.map(({ instance }) => instance)).size, fileCount,
      'each test file ran in its own native process instance');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, process.execPath);
    assert.ok(files.every((file) => !invocations[0].args.some((arg) => arg.includes(file))),
      'source test paths stay out of the actual Node command line');
  } catch (error) {
    teardownConfirmed = error?.teardownUnconfirmed !== true;
    throw error;
  }
});

test('aborting a node:test run waits until the child process tree is gone', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-node-signal-'));
  const hangingTest = path.join(root, 'hanging.test.mjs');
  writeFileSync(hangingTest, "import test from 'node:test'; test('never settles', () => new Promise(() => {}));\n");
  const fixture = createTestEnvironment();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('unit test signal')), 350);
  let teardownConfirmed = false;
  t.after(() => {
    clearTimeout(timer);
    if (!teardownConfirmed) return;
    fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const { runNodeTests } = await import('../test-node.mjs');
  const result = await runNodeTests([hangingTest], {
    signal: controller.signal,
    env: fixture.env,
    timeoutMs: 10_000,
  });
  teardownConfirmed = result.teardownConfirmed === true;
  assert.equal(result.code, 1);
  assert.equal(result.teardownConfirmed, true);
});
