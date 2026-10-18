import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractRuntimeArgs } from '../verification-runtime.mjs';
import { withPiRuntime as acquirePiRuntime } from '../../lib/pi-runtime-context.mjs';
import { ARTIFACT_TEST_GLOB, DEFAULT_ARTIFACT_SELECTORS, main, runArtifactTests } from '../test-artifact.mjs';
import { resolveTestFiles } from '../test-node.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const sdkPath = path.resolve('fixture/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
const selectors = [
  'harness/agent-processes', 'harness/session-storage', 'harness/tool-and-skill-selection',
  'test/integration', 'application/hosts/test',
];

function fixture(t, { code = 0, gone = true, spawnFailure } = {}) {
  const state = { acquired: 0, confirmed: 0, spawn: undefined, options: undefined, watchOptions: undefined };
  const dependencies = {
    withPiRuntime: async (options, run) => {
      state.acquired += 1;
      state.runtimeOptions = options;
      return run({ sdkPath, confirmChildCompletion: () => { state.confirmed += 1; } });
    },
    resolveTestFiles: (_root, roots, options) => {
      state.roots = roots;
      state.discoveryOptions = options;
      return Array.from({ length: 29 }, (_, index) => `/fixture/${index}.artifact.test.mjs`);
    },
    spawnImpl: (_exe, args, options) => {
      if (spawnFailure) throw spawnFailure;
      state.spawn = args;
      state.options = options;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', code));
      return child;
    },
    watchChildProcessImpl: (_child, options) => {
      state.watchOptions = options;
      return { timedOut: false, aborted: false, settle: async () => ({ gone }) };
    },
  };
  return { state, dependencies };
}

test('default domains resolve the intended artifact suites without ordinary source tests', () => {
  const files = resolveTestFiles(repoRoot, DEFAULT_ARTIFACT_SELECTORS, { includeGlobs: [ARTIFACT_TEST_GLOB] });
  assert.equal(files.length, 51);
  const relative = files.map(file => path.relative(repoRoot, file).split(path.sep).join('/'));
  assert.ok(relative.every(file => path.matchesGlob(file, ARTIFACT_TEST_GLOB)));
  assert.ok(relative.includes('harness/agent-processes/coordinator/test/existing-provider-inventory.artifact.test.ts'),
    'default artifact discovery includes native keyless provider inventory coverage');
  const expectedFamilies = new Map([
    ['harness/agent-processes/', 21],
    ['harness/session-storage/', 3],
    ['harness/tool-and-skill-selection/', 4],
    ['harness/tools/playwright/', 1],
    ['harness/model-providers/model-discovery/', 2],
    ['harness/model-providers/runtime/', 5],
    ['harness/model-providers/management/', 1],
    ['harness/tools/package-integrations/web-access/', 1],
    ['harness/tools/subagent/', 2],
    ['harness/tools/warm-bash/', 1],
    ['application/backend/', 1],
    ['scripts/install/test/', 1],
    ['scripts/lib/test/', 2],
    ['scripts/development/test/', 1],
    ['test/integration/', 5],
  ]);
  for (const [family, count] of expectedFamilies) {
    assert.equal(relative.filter(file => file.startsWith(family)).length, count, `${family} artifact count`);
  }
});

test('CLI selectors and aliases discover artifact files before one runtime acquisition and forward the verified SDK', async (t) => {
  const { state, dependencies } = fixture(t, { code: 1 });
  const selection = extractRuntimeArgs([
    '--pi-runtime', path.resolve('fixture/pi-runtime'), '--tsconfig', 'application/hosts/vscode/tsconfig.json',
    '--exclude', '**/*.slow.artifact.test.*', ...selectors, '--', '--test-name-pattern=smoke', '--test-timeout=5000',
  ]);
  const previousTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'fixture-marker';
  try {
    const code = await runArtifactTests(selection, undefined, dependencies);
    assert.equal(code, 1, 'a failed test is still a completed, safely-cleanable child');
  } finally {
    if (previousTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousTestContext;
  }
  assert.equal(state.acquired, 1);
  assert.equal(state.confirmed, 1);
  assert.equal(state.runtimeOptions.artifactDir, path.resolve('fixture/pi-runtime'));
  assert.deepEqual(state.roots, selectors);
  assert.deepEqual(state.discoveryOptions, { includeGlobs: [ARTIFACT_TEST_GLOB], excludeGlobs: ['**/*.slow.artifact.test.*'] });
  assert.deepEqual(state.spawn.slice(1), [
    '--sdk-path', sdkPath, '--tsconfig', 'application/hosts/vscode/tsconfig.json',
    '--exclude', '**/*.slow.artifact.test.*', '--include', ARTIFACT_TEST_GLOB, ...selectors,
    '--', '--test-name-pattern=smoke', '--test-timeout=5000',
  ]);
  assert.equal(Object.hasOwn(state.options.env, 'NODE_TEST_CONTEXT'), false);
  assert.equal(state.watchOptions.label, 'artifact node tests');
  assert.equal(state.watchOptions.timeoutMs > 0, true);
});

test('confirmed success and product test failure both confirm child completion', async (t) => {
  for (const code of [0, 1]) {
    const { state, dependencies } = fixture(t, { code, gone: true });
    assert.equal(await runArtifactTests({ args: selectors }, undefined, dependencies), code);
    assert.equal(state.confirmed, 1, `exit ${code} confirms the gone child tree`);
  }
});

test('the real invocation owner cleans private artifacts after confirmed exit 1 but retains explicit reuse', async (t) => {
  const { state, dependencies } = fixture(t, { code: 1 });
  delete dependencies.withPiRuntime;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-artifact-owner-test-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const builds = [];
  dependencies.runtimeDependencies = {
    buildPiRuntime: async ({ output }) => { mkdirSync(output, { recursive: true }); builds.push(output); return { artifactDir: output }; },
    verifyPiRuntimeArtifact: async artifactDir => ({
      artifactDir, sdkPath: path.join(artifactDir, 'node_modules/@earendil-works/pi-coding-agent'), identity: 'fixture',
    }),
  };

  assert.equal(await runArtifactTests({ args: selectors }, undefined, dependencies), 1);
  assert.equal(builds.length, 1);
  assert.equal(existsSync(path.dirname(builds[0])), false, 'confirmed private invocation storage is removed');

  const explicit = path.join(tempRoot, 'reused');
  mkdirSync(explicit);
  assert.equal(await runArtifactTests({ args: selectors, artifactDir: explicit }, undefined, dependencies), 1);
  assert.equal(builds.length, 1, 'explicit reuse skips private acquisition');
  assert.equal(existsSync(explicit), true, 'explicit verified artifacts are never removed');
});

test('default domains are discovered before acquisition and an empty artifact selection acquires nothing', async (t) => {
  const { state, dependencies } = fixture(t);
  dependencies.resolveTestFiles = (_root, roots) => { state.roots = roots; return []; };
  await assert.rejects(runArtifactTests({ args: [] }, undefined, dependencies), /No artifact tests found/);
  assert.equal(state.acquired, 0);
  assert.deepEqual(state.roots, [
    'harness/agent-processes', 'harness/session-storage',
    'harness/tool-and-skill-selection', 'harness/tools/playwright',
    'harness/model-providers/model-discovery', 'harness/model-providers/runtime',
    'harness/model-providers/management',
    'harness/tools/package-integrations/web-access', 'harness/tools/subagent',
    'harness/tools/warm-bash', 'application/backend',
    'scripts/install/test', 'scripts/lib/test', 'scripts/development/test', 'test/integration',
  ]);
});

test('uncertain child-tree teardown never confirms completion and retains the private artifact', async (t) => {
  const { dependencies } = fixture(t, { gone: false });
  delete dependencies.withPiRuntime;
  let ownedRoot;
  let builds = 0;
  dependencies.runtimeDependencies = {
    buildPiRuntime: async ({ output }) => {
      mkdirSync(output, { recursive: true });
      ownedRoot = path.dirname(output);
      builds += 1;
      return { artifactDir: output };
    },
    verifyPiRuntimeArtifact: async artifactDir => ({
      artifactDir, sdkPath: path.join(artifactDir, 'node_modules/@earendil-works/pi-coding-agent'), identity: 'fixture',
    }),
  };
  t.after(() => { if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true }); });
  await assert.rejects(runArtifactTests({ args: selectors }, undefined, dependencies), { teardownUnconfirmed: true });
  assert.equal(builds, 1);
  assert.equal(existsSync(ownedRoot), true);
});

test('reserved inner teardown status retains the private SDK even after the outer watchdog confirms exit', async (t) => {
  const { state, dependencies } = fixture(t, { code: 125, gone: true });
  delete dependencies.withPiRuntime;
  dependencies.withPiRuntime = (options, run, runtimeDependencies) => acquirePiRuntime(options, context => run({
    ...context,
    confirmChildCompletion() {
      state.confirmed += 1;
      context.confirmChildCompletion();
    },
  }), runtimeDependencies);
  let ownedRoot;
  dependencies.runtimeDependencies = {
    buildPiRuntime: async ({ output }) => {
      mkdirSync(output, { recursive: true });
      ownedRoot = path.dirname(output);
      return { artifactDir: output };
    },
    verifyPiRuntimeArtifact: async artifactDir => ({
      artifactDir, sdkPath: path.join(artifactDir, 'node_modules/@earendil-works/pi-coding-agent'), identity: 'fixture',
    }),
  };
  t.after(() => { if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true }); });

  await assert.rejects(runArtifactTests({ args: selectors }, undefined, dependencies), { teardownUnconfirmed: true });
  assert.equal(state.confirmed, 0, 'the uncertain child is never declared complete');
  assert.equal(existsSync(ownedRoot), true, 'private SDK storage survives despite outer-tree disappearance');
});

test('artifact CLI propagates inner or outer uncertainty as reserved exit 125', async (t) => {
  const previousCode = process.exitCode;
  const previousError = console.error;
  const messages = [];
  console.error = message => messages.push(message);
  t.after(() => { process.exitCode = previousCode; console.error = previousError; });
  for (const [code, gone, expected] of [[125, true, 125], [0, false, 125], [1, true, 1], [0, true, 0]]) {
    const { state, dependencies } = fixture(t, { code, gone });
    dependencies.abortOnProcessSignals = () => ({ signal: undefined, dispose() {} });
    await main(selectors, dependencies);
    assert.equal(process.exitCode, expected);
    assert.equal(state.confirmed, expected === 125 ? 0 : 1);
  }
  assert.equal(messages.length, 2);
});

test('a prelaunch failure confirms safely because no child could read the artifact', async (t) => {
  const { state, dependencies } = fixture(t, { spawnFailure: new Error('spawn failed') });
  await assert.rejects(runArtifactTests({ args: selectors }, undefined, dependencies), /spawn failed/);
  assert.equal(state.acquired, 1);
  assert.equal(state.confirmed, 1);
});
