import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PACKAGE_REGISTRY, isSdkIndependentTestFile, packageTestFiles, packageTestRoots } from '../../lib/test-packages.mjs';
import { ARTIFACT_TEST_GLOB, DEFAULT_ARTIFACT_SELECTORS } from '../test-artifact.mjs';
import { parseArgs, resolveTestFiles } from '../test-node.mjs';
import { withoutGitRepositoryEnv } from '../../lib/git-environment.mjs';
import { watchChildProcess, withProcessTreeIsolation } from '../../lib/process-watchdog.mjs';

function fixtureChildEnv(source = process.env) {
  const env = withoutGitRepositoryEnv(source);
  // Preserve HOME and Proto's tool owner, not the invoking Moon workspace/task.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('MOON_') || key.toUpperCase() === 'NODE_TEST_CONTEXT') delete env[key];
  }
  return env;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NATIVE_NODE_RUNNER = 'scripts/verification/test-node.mjs';
const SELECTOR_REGRESSION_TEST = 'scripts/verification/test/moon-test-selectors.test.mjs';
const CHECKPOINT_ARTIFACT_FILES = [
  'harness/agent-processes/cold-browse-helper/test/cold-browse-helper-client.artifact.test.ts',
  'harness/agent-processes/cold-browse-helper/test/cold-browse-helper-runtime.artifact.test.ts',
  'harness/agent-processes/context-inventory/test/initial-context-estimate-client.artifact.test.ts',
  'harness/agent-processes/coordinator/test/provider-runtime-creation.artifact.test.ts',
  'harness/agent-processes/workers/test/worker-public-address.artifact.test.ts',
];
const ARTIFACT_FILES = [
  'harness/agent-processes/coordinator/test/admission-session-titles.artifact.test.ts',
  'harness/agent-processes/coordinator/test/session-control-sdk.artifact.test.ts',
  'harness/model-providers/management/test/management-overlay.artifact.test.ts',
  'harness/tools/playwright/test/host-runtime-integration.artifact.test.ts',
  'scripts/install/test/source-pi-cli.artifact.test.mjs',
  'scripts/lib/test/package-resolution.artifact.test.mjs',
  'scripts/lib/test/unbundled-owner-resolution.artifact.test.mjs',
  'scripts/development/test/refresh.artifact.test.mjs',
];
const LIFECYCLE_PIN_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.prototools',
];
const INTENTIONAL_UNREGISTERED_FAST_FILES = [
  'application/lib/test/renderer-delivery/renderer-view-state.test.ts',
  'application/lib/test/source-boundaries.test.ts',
  'lib/development-runtime/test/lifetime.test.mjs',
];

function relativeFiles(files) {
  return new Set(files.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')));
}

function projectMoonConfigs() {
  const workspace = parseYaml(readFileSync(path.join(repoRoot, '.moon/workspace.yml'), 'utf8'));
  return [
    'moon.yml',
    ...Object.values(workspace.projects.sources)
      .filter((projectRoot) => projectRoot !== '.')
      .map((projectRoot) => `${projectRoot}/moon.yml`),
  ];
}

function resolveMoonTestFiles(configPath) {
  const absoluteConfig = path.join(repoRoot, configPath);
  const config = parseYaml(readFileSync(absoluteConfig, 'utf8'));
  const command = config?.tasks?.test?.command;
  assert.equal(typeof command, 'string', `${configPath} must define a test command`);

  const runnerIndex = command.indexOf(NATIVE_NODE_RUNNER);
  assert.notEqual(runnerIndex, -1, `${configPath} must use the native Node test runner`);
  const args = command.slice(runnerIndex + NATIVE_NODE_RUNNER.length).trim().split(/\s+/u).filter(Boolean)
    .map((arg) => arg.replace(/^(["'])(.*)\1$/u, '$2'));
  const parsed = parseArgs(args);
  assert.deepEqual(parsed.nodeFlags, [], `${configPath} test task should not add runner flags after --`);
  assert.ok(parsed.excludeGlobs.includes(ARTIFACT_TEST_GLOB),
    `${configPath} native Node selectors must exclude artifact-only tests before selectors`);
  return relativeFiles(resolveTestFiles(repoRoot, parsed.selectors, {
    includeGlobs: parsed.includeGlobs,
    excludeGlobs: parsed.excludeGlobs,
  }));
}

function explicitNativeTestTsconfigs(config) {
  const command = config?.tasks?.test?.command;
  if (typeof command !== 'string') return [];
  const runnerIndex = command.indexOf(NATIVE_NODE_RUNNER);
  if (runnerIndex === -1) return [];
  const args = command.slice(runnerIndex + NATIVE_NODE_RUNNER.length).trim().split(/\s+/u).filter(Boolean)
    .map((arg) => arg.replace(/^("|')(.*)\1$/u, '$2'));
  const { tsconfig } = parseArgs(args);
  return tsconfig === undefined ? [] : [path.posix.normalize(tsconfig.replaceAll('\\', '/'))];
}

function assertExplicitTsconfigInputs(configPath, config) {
  const task = config.tasks.test;
  const inputs = task.inputs ?? [];
  const tsconfigs = explicitNativeTestTsconfigs(config);
  assert.ok(tsconfigs.length > 0, `${configPath}: native test command declares an explicit --tsconfig`);
  assert.ok(inputs.includes('@globs(protected)'), `${configPath}: native test inputs retain protected rules`);

  const allTasks = parseYaml(readFileSync(path.join(repoRoot, '.moon/tasks/all.yml'), 'utf8'));
  const expandedInputs = inputs.flatMap((input) => {
    const group = /^@globs\(([^)]+)\)$/u.exec(input);
    return group ? allTasks.fileGroups[group[1]] ?? [] : [input];
  });
  const matchesInput = (relativePath, input) => {
    const glob = input.replace(/^!/u, '').replace(/^\//u, '');
    return path.matchesGlob(relativePath, glob);
  };

  for (const tsconfig of tsconfigs) {
    assert.ok(expandedInputs.some((input) => !input.startsWith('!') && matchesInput(tsconfig, input)),
      `${configPath}:test inputs cover explicit TypeScript config ${tsconfig}`);
    assert.equal(expandedInputs.some((input) => input.startsWith('!') && matchesInput(tsconfig, input)), false,
      `${configPath}:test protected and scoped exclusions do not omit ${tsconfig}`);
  }
}

function resolveRegistryTestFiles() {
  const directories = new Set();
  const explicitFiles = new Set();
  for (const entry of PACKAGE_REGISTRY) {
    for (const directory of packageTestRoots(entry)) {
      const absolute = path.join(repoRoot, directory);
      if (existsSync(absolute) && statSync(absolute).isDirectory()) directories.add(directory);
    }
    for (const file of packageTestFiles(entry)) {
      if (existsSync(path.join(repoRoot, file))) explicitFiles.add(file);
    }
  }
  return relativeFiles(resolveTestFiles(repoRoot, [...directories, ...explicitFiles]));
}

test('Moon Node selectors partition ordinary suites from artifact and framework-only tests', () => {
  const fastFiles = new Set();
  let nativeProjectCount = 0;
  for (const configPath of projectMoonConfigs()) {
    const config = parseYaml(readFileSync(path.join(repoRoot, configPath), 'utf8'));
    const command = config?.tasks?.test?.command;
    if (typeof command !== 'string' || !command.includes(NATIVE_NODE_RUNNER)) continue;
    nativeProjectCount += 1;
    for (const file of resolveMoonTestFiles(configPath)) fastFiles.add(file);
  }
  assert.ok(nativeProjectCount > 0, 'workspace projects expose native Node test selectors');
  assert.equal([...fastFiles].some((file) => path.matchesGlob(file, ARTIFACT_TEST_GLOB)), false,
    'the union of all fast native Node selectors excludes artifact files');

  const rootFiles = resolveMoonTestFiles('moon.yml');
  assert.ok(rootFiles.has('lib/development-runtime/test/lifetime.test.mjs'));

  const scriptFiles = resolveMoonTestFiles('scripts/moon.yml');
  assert.ok(scriptFiles.has('scripts/development/test/launch.test.mjs'));
  assert.ok(scriptFiles.has('scripts/development/test/vscode-development.test.mjs'));
  assert.ok(scriptFiles.has('scripts/development/test/inspect-workspace.test.mjs'));
  const hostCommonFiles = resolveMoonTestFiles('application/hosts/lib/moon.yml');
  assert.ok(hostCommonFiles.has('application/hosts/test/image-actions.test.ts'));
  assert.ok(scriptFiles.has(SELECTOR_REGRESSION_TEST), 'the scripts project directly selects this regression test');

  const applicationLibFiles = resolveMoonTestFiles('application/lib/moon.yml');
  assert.ok(applicationLibFiles.has('application/lib/test/renderer-delivery/renderer-view-state.test.ts'));
  assert.ok(applicationLibFiles.has('application/lib/test/source-boundaries.test.ts'));

  const computerUseFiles = resolveMoonTestFiles('extensions/computer-use/moon.yml');
  assert.ok(computerUseFiles.has('harness/tools/computer-use/test/artifact-result.test.ts'));
  assert.equal(computerUseFiles.has('harness/tools/computer-use/fixtures/event-server.test.mjs'), false);

  const vscodeFiles = resolveMoonTestFiles('application/hosts/vscode/moon.yml');
  assert.equal([...vscodeFiles].some((file) => file.endsWith('.pw.ts')), false,
    'Playwright browser suites remain outside native node:test discovery');

  const artifactFiles = relativeFiles(resolveTestFiles(repoRoot, DEFAULT_ARTIFACT_SELECTORS, {
    includeGlobs: [ARTIFACT_TEST_GLOB],
  }));
  assert.ok([...artifactFiles].every((file) => path.matchesGlob(file, ARTIFACT_TEST_GLOB)));
  for (const file of CHECKPOINT_ARTIFACT_FILES) {
    assert.ok(artifactFiles.has(file), `${file} is an intended checkpoint artifact suite`);
    assert.equal(fastFiles.has(file), false, `${file} remains outside ordinary native selectors`);
  }
  for (const file of ARTIFACT_FILES) {
    assert.ok(artifactFiles.has(file), `${file} is selected by the default artifact selectors`);
    assert.equal(fastFiles.has(file), false, `${file} is excluded from all fast native Node selectors`);
  }
  for (const file of [
    'scripts/lib/test/package-resolution.test.mjs',
    'scripts/lib/test/unbundled-owner-resolution.test.mjs',
    'scripts/install/test/source-pi-cli.test.mjs',
  ]) {
    assert.ok(fastFiles.has(file), `${file} remains in fast selectors as an SDK-free source fixture`);
    assert.equal(isSdkIndependentTestFile(file), true, `${file} remains eligible for focused SDK-free test:file runs`);
  }
  assert.deepEqual(PACKAGE_REGISTRY.filter((entry) => entry.sdkIndependentTestFiles?.length)
    .map((entry) => entry.id), ['extension', 'scripts'],
  'SDK-independent files remain exact allowlists owned only by extension and scripts');
  assert.equal(isSdkIndependentTestFile('scripts/lib/test/not-allowlisted.test.mjs'), false,
    'SDK independence is not inferred from a directory or filename pattern');

  const registryFiles = resolveRegistryTestFiles();
  const autonomousModeTest = 'harness/tool-and-skill-selection/test/autonomous-mode.test.ts';
  assert.ok(registryFiles.has(autonomousModeTest), 'autonomous mode stays in the registered selector test root');
  assert.ok(fastFiles.has(autonomousModeTest), 'Moon native selectors retain autonomous mode coverage');
  assert.ok(registryFiles.has(SELECTOR_REGRESSION_TEST), 'new scripts tests remain in the dynamic registry inventory');
  assert.ok(registryFiles.has('scripts/development/test/inspect-workspace.test.mjs'));
  for (const file of INTENTIONAL_UNREGISTERED_FAST_FILES) {
    assert.ok(fastFiles.has(file), `${file} is an intentional Moon-only fast suite`);
  }
  assert.deepEqual([...registryFiles].filter((file) => path.matchesGlob(file, ARTIFACT_TEST_GLOB)).sort(),
    [...artifactFiles].sort(),
    'every registered artifact suite is selected only by the artifact lane');
  const expectedFiles = new Set([...registryFiles, ...INTENTIONAL_UNREGISTERED_FAST_FILES]);
  const actualFiles = new Set([...fastFiles, ...artifactFiles]);
  assert.deepEqual({
    unregistered: [...actualFiles].filter((file) => !expectedFiles.has(file)).sort(),
    unselected: [...expectedFiles].filter((file) => !actualFiles.has(file)).sort(),
  }, { unregistered: [], unselected: [] }, 'inventory partition has no unregistered or unselected files');
  assert.deepEqual([...actualFiles].sort(), [...expectedFiles].sort(),
    'fast and artifact selectors partition the registered inventory and three ordinary extras');
});

function workspaceProjects() {
  const sources = parseYaml(readFileSync(path.join(repoRoot, '.moon/workspace.yml'), 'utf8')).projects.sources;
  return Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, {
    source,
    config: parseYaml(readFileSync(path.join(repoRoot, source, 'moon.yml'), 'utf8')),
  }]));
}

// Configuration acceptance only: never used to select production tasks.
function declaredClosure(projects, id, seen = new Set()) {
  if (seen.has(id)) return seen;
  seen.add(id);
  for (const dependency of projects[id].config.dependsOn ?? []) declaredClosure(projects, dependency, seen);
  return seen;
}

test('ordinary Moon inputs cover declared consumer closures without downstream test orchestration', () => {
  const projects = workspaceProjects();
  assert.deepEqual(projects.analytics.config.dependsOn, ['root'], 'test fixtures must not create analytics → harness');
  assert.ok(projects.vscode.config.dependsOn.includes('frontend'), 'the renderer build is an explicit host dependency');
  assert.deepEqual(projects.analysis.config.dependsOn, ['analytics', 'harness', 'root'],
    'analysis imports analytics contracts and harness pricing at runtime');
  for (const [id, { config }] of Object.entries(projects)) {
    const inputs = config.tasks.test.inputs;
    if (explicitNativeTestTsconfigs(config).length > 0) assertExplicitTsconfigInputs(id, config);
    for (const dependency of declaredClosure(projects, id)) {
      const source = dependency === 'root' ? 'lib' : projects[dependency].source;
      assert.ok(inputs.includes(`/${source}/**/*`), `${id}:test covers ${dependency} in the declared closure`);
    }
    assert.ok(inputs.includes('/lib/**/*'), `${id}:test conservatively covers neutral root libraries`);
    assert.ok(inputs.includes('@globs(lifecycle)'));
    assert.ok(inputs.includes('@globs(protected)'));
    if (id !== 'analysis' && inputs.includes('/analytics/**/*')) {
      assert.ok(inputs.includes('!/analytics/analysis/**/*'), `${id} does not own analysis`);
    }
    if (id !== 'pi') assert.ok((config.tasks.test.deps ?? []).every((dep) => dep === 'pi:build'),
      `${id}:test has compilation prerequisites only, never dependency tests`);
  }
  assert.ok(projects.analytics.config.tasks.test.inputs.includes('/harness/**/*'));
  assertExplicitTsconfigInputs('harness', projects.harness.config);
  assert.deepEqual(explicitNativeTestTsconfigs(projects.harness.config), ['application/hosts/vscode/tsconfig.json']);
  assert.ok(projects.root.config.tasks.test.inputs.includes('/harness/agent-processes/lib/rpc/jsonl.ts'));
  assert.ok(projects.root.config.tasks.test.inputs.includes('/harness/session-storage/ownership/session-identity.ts'));
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  for (const id of ['test', 'test:changed', 'check']) assert.doesNotMatch(scripts[id], /--downstream|\^test/u);
});

test('fixture environment removes invoking repository and task context without changing tool ownership', () => {
  const env = fixtureChildEnv({
    HOME: 'tool-home', PROTO_HOME: 'proto-owner', PROTO_VERSION: 'pinned', PATH: 'tool-path',
    MOON_WORKSPACE_ROOT: repoRoot, moon_task_id: 'root:graphTest', MOON_CACHE: 'off',
    GIT_DIR: repoRoot, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: repoRoot, NODE_TEST_CONTEXT: 'child-v8',
  });
  assert.deepEqual(env, { HOME: 'tool-home', PROTO_HOME: 'proto-owner', PROTO_VERSION: 'pinned', PATH: 'tool-path' });
});

test('pinned Moon executes affected input cases with NOOP tasks and no artifact execution', {
  timeout: 240_000,
  skip: process.env.PIE_RUN_MOON_INPUT_TESTS !== '1'
    ? 'Tool integration is opt-in: run proto run moon -- run root:graphTest in the current HOME tool context.'
    : false,
}, async (t) => {
  const projects = workspaceProjects();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-moon-inputs-'));
  const all = Object.keys(projects).sort();
  const common = ['analytics', 'app-common', 'backend', 'browser', 'frontend', 'host-common', 'scripts', 'standalone', 'vscode'];
  const sdk = ['analysis', 'analytics', 'app-common', 'backend', 'browser', 'computer-use', 'frontend', 'harness', 'host-common', 'pi', 'playwright', 'scripts', 'standalone', 'vscode'];
  const cases = [
    ...LIFECYCLE_PIN_FILES.map((file) => [file, all]),
    ['scripts/verification/test-node.mjs', all],
    ['scripts/lib/test-packages.mjs', all],
    ['application/frontend/shell/ui.tsx', ['analytics', 'backend', 'frontend', 'standalone', 'vscode']],
    ['application/lib/protocol/index.ts', common],
    ['harness/pi/packages/coding-agent/src/index.ts', sdk],
    ['harness/pi/packages/ai/src/index.ts', sdk],
    ['analytics/contracts/tool-call-analysis-input.ts', sdk.filter((id) => id !== 'pi')],
    ['analytics/analysis/test/duckdb-query.test.ts', ['analysis']],
    ['analytics/analysis/scripts/source.ts', ['analysis', 'analytics']],
    ['harness/tools/subagent/selection.ts', sdk.filter((id) => id !== 'pi')],
    ['application/hosts/vscode/tsconfig.json', ['analytics', 'app-common', 'backend', 'browser', 'computer-use', 'frontend', 'harness', 'host-common', 'playwright', 'scripts', 'standalone', 'vscode']],
    ['harness/agent-processes/lib/rpc/jsonl.ts', [...sdk.filter((id) => id !== 'pi'), 'root']],
    ['harness/session-storage/ownership/session-identity.ts', [...sdk.filter((id) => id !== 'pi'), 'root']],
    ['lib/serialization/json-lines.ts', all],
    ['application/hosts/test/browser/browser-server.test.ts', ['browser']],
    ['application/hosts/vscode/runtime/runtime-generations.cjs', ['analytics', 'backend', 'browser', 'host-common', 'scripts', 'standalone', 'vscode']],
    ['docs/unrelated.md', []],
    ['harness/pi/packages/coding-agent/dist/index.js', []],
    ['application/hosts/vscode/out-dev/extension.js', []],
    ['harness/pi-runtime/.cache/artifact/manifest.json', []],
  ];
  // Deliberate fixture policy, never inherited: cache hashing races task state writes.
  const env = { ...fixtureChildEnv(), MOON_CACHE: 'off' };
  let teardownConfirmed = true;
  let failure;
  async function runMoon(args, input) {
    const child = spawn('proto', ['run', 'moon', '--', ...args], withProcessTreeIsolation({
      cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }));
    const closed = new Promise((resolve) => { child.once('close', resolve); });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.stdin.on('error', (cause) => { error ??= cause; });
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
      child.once('error', (cause) => { error = cause; resolve(null); });
      child.once('exit', resolve);
    });
    const watchdog = watchChildProcess(child, {
      timeoutMs: 30_000, signal: t.signal, label: `fixture Moon ${args.join(' ')}`,
      // Unconfirmed teardown may never emit exit; retain evidence rather than hang.
      onTerminate: () => { queueMicrotask(() => { void watchdog.settle().then(() => resolveExit(null), () => resolveExit(null)); }); },
    });
    child.stdin.end(input);
    const status = await exited;
    // Settle the owned tree before removing fixture files, including on failure.
    let cleanup;
    try { cleanup = await watchdog.settle(); }
    catch (cause) { cleanup = { gone: false, error: String(cause) }; }
    teardownConfirmed &&= cleanup.gone;
    if (cleanup.gone) await closed; // Drain stdout/stderr only after confirmed extinction.
    if (!cleanup.gone || watchdog.timedOut || watchdog.aborted) {
      t.diagnostic(`${directory}: Moon tree teardown ${JSON.stringify(cleanup)}`);
    }
    return { status, stdout, stderr, error, timedOut: watchdog.timedOut, aborted: watchdog.aborted, cleanup };
  }
  function save(relative, content) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  try {
    save('.moon/workspace.yml', readFileSync(path.join(repoRoot, '.moon/workspace.yml')));
    save('.moon/tasks/all.yml', readFileSync(path.join(repoRoot, '.moon/tasks/all.yml')));
    save('.prototools', readFileSync(path.join(repoRoot, '.prototools')));
    // Moon asks Git to hash workspace files while tasks write cache state.
    save('.gitignore', '.moon/cache/\n');
    for (const [file] of cases) if (file !== '.prototools') save(file, 'NOOP input fixture\n');
    for (const [id, { source, config }] of Object.entries(projects)) {
      // Only commands/output side effects change; relations, inputs and deps stay intact.
      for (const [taskId, task] of Object.entries(config.tasks)) {
        task.command = [process.execPath.replaceAll('\\', '/'), '-e', `console.log('NOOP ${id}:${taskId}')`];
        delete task.outputs;
        task.options = { ...task.options, cache: false, persistent: false, shell: false };
      }
      for (const task of Object.values(config.tasks)) {
        for (const input of task.inputs ?? []) {
          if (input.startsWith('/') && !/[*!?{}()]/u.test(input)) save(input.slice(1), 'NOOP exact input fixture\n');
        }
      }
      save(path.join(source, 'moon.yml'), stringifyYaml(config));
    }
    const init = spawnSync('git', ['init', '-b', 'master'], { cwd: directory, encoding: 'utf8', env });
    assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}\n${init.error?.stack ?? ''}`);
    const add = spawnSync('git', ['add', '.'], { cwd: directory, encoding: 'utf8', env });
    assert.equal(add.status, 0, `${add.stdout}\n${add.stderr}\n${add.error?.stack ?? ''}`);
    const commit = spawnSync('git', ['-c', 'user.name=Moon regression', '-c', 'user.email=moon@example.invalid', 'commit', '--allow-empty', '-m', 'NOOP fixture baseline'], { cwd: directory, encoding: 'utf8', env });
    assert.equal(commit.status, 0, `${commit.stdout}\n${commit.stderr}\n${commit.error?.stack ?? ''}`);
    const version = await runMoon(['--version']);
    assert.equal(version.status, 0, `${version.stdout}\n${version.stderr}\n${version.error?.stack ?? ''}\n${JSON.stringify(version.cleanup)}`);
    assert.equal(version.timedOut || version.aborted, false, 'Moon version invocation interrupted');
    assert.equal(version.cleanup.gone, true, 'Moon version tree teardown unconfirmed');
    assert.match(version.stdout, /\b2\.4\.2\b/u, 'NOOP acceptance uses the pinned Moon version');
    for (const [file, expected] of cases) {
      const result = await runMoon(['run', ':test', '--affected', '--include-relations', '--stdin', '--no-actions'], `${file}\n`);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.equal(result.status, 0, `${file}: ${output}\n${result.error?.stack ?? ''}\n${JSON.stringify(result.cleanup)}`);
      assert.equal(result.timedOut || result.aborted, false, `${file}: Moon invocation interrupted\n${output}`);
      assert.equal(result.cleanup.gone, true, `${file}: Moon tree teardown unconfirmed`);
      const executed = [...output.matchAll(/NOOP ([\w-]+):test\r?$/gmu)].map((match) => match[1]).sort();
      t.diagnostic(`${file}: ${executed.join(', ') || '(none)'}\n${output}`);
      assert.deepEqual(executed, [...expected].sort(), file);
      assert.doesNotMatch(output, /NOOP root:artifactTest/u, 'ordinary affected selection never executes artifacts');
      assert.doesNotMatch(output, /NOOP .*:(?:delivery|watch|dev|browser|typecheck)/u);
      if (expected.some((id) => (projects[id].config.tasks.test.deps ?? []).includes('pi:build'))) {
        assert.match(output, /NOOP pi:build/u, 'SDK consumers retain only the compile prerequisite');
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (teardownConfirmed) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) {
        t.diagnostic(`Retained fixture ${directory}: cleanup failed: ${error.stack ?? error}`);
        if (!failure) throw error;
      }
    } else {
      t.diagnostic(`Retained fixture ${directory}: owned Moon process teardown is unconfirmed; no files deleted.`);
    }
  }
});

test('Moon lifecycle globs cover each root pinfile', () => {
  const allTasks = parseYaml(readFileSync(path.join(repoRoot, '.moon/tasks/all.yml'), 'utf8'));
  const lifecycleGlobs = allTasks.fileGroups.lifecycle;
  assert.ok(Array.isArray(lifecycleGlobs), 'Moon lifecycle file group is defined');

  for (const file of LIFECYCLE_PIN_FILES) {
    const absoluteFile = path.join(repoRoot, file);
    assert.ok(lifecycleGlobs.some((glob) => {
      if (glob.startsWith('!')) return false;
      const absoluteGlob = path.join(repoRoot, glob.replace(/^\//u, ''));
      return path.matchesGlob(absoluteFile, absoluteGlob);
    }), `${file} is covered by a Moon lifecycle file-group glob`);
  }
});

test('delivery qualification is explicit and uncached, with runtime reuse independent of Pi compilation', () => {
  const rootConfig = parseYaml(readFileSync(path.join(repoRoot, 'moon.yml'), 'utf8'));
  const task = rootConfig.tasks.deliveryQualification;
  assert.equal(task.command, 'proto run node -- scripts/verification/qualify-delivery.mjs');
  assert.equal(task.options.cache, false);
  assert.equal(task.outputs, undefined);
  assert.deepEqual(task.deps ?? [], [], 'the command compiles only on its default path');
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['delivery:qualify'], 'proto run moon -- run root:deliveryQualification');
  for (const name of ['test', 'test:all', 'test:fast', 'check', 'verify', 'verify:release']) {
    assert.doesNotMatch(scripts[name], /deliveryQualification|delivery:qualify/u,
      `${name} must not implicitly start delivered hosts`);
  }
});

test('the root artifact task is explicit, uncached, and does not declare SDK outputs', () => {
  const rootConfig = parseYaml(readFileSync(path.join(repoRoot, 'moon.yml'), 'utf8'));
  const artifactTask = rootConfig.tasks.artifactTest;
  assert.equal(artifactTask.command, 'proto run node -- scripts/verification/test-artifact.mjs');
  assert.deepEqual(artifactTask.deps, ['pi:build']);
  assert.equal(artifactTask.options.cache, false);
  assert.equal(artifactTask.outputs, undefined, 'artifact runs do not write static SDK outputs');
  for (const selector of DEFAULT_ARTIFACT_SELECTORS) {
    assert.ok(artifactTask.inputs.includes(`${selector}/**/*`), `${selector} is an artifact source input`);
  }
  assert.ok(artifactTask.inputs.includes('harness/pi/packages/**/*'), 'Pi SDK source changes invalidate the task');
  assert.equal(artifactTask.inputs.includes('harness/pi-runtime/package.json'), false, 'retired npm bridge is not a dependency authority');
  assert.equal(artifactTask.inputs.includes('harness/pi-runtime/package-lock.json'), false, 'shared lifecycle pnpm lock supplies dependency authority');
  assert.ok(artifactTask.inputs.includes('scripts/build/pi-runtime.mjs'));
  assert.ok(artifactTask.inputs.includes('lib/development-runtime/**/*'));
  assert.ok(artifactTask.inputs.includes('@globs(lifecycle)'));
  assert.ok(artifactTask.inputs.includes('@globs(protected)'));
  assert.equal(artifactTask.inputs.some((input) => /(?:^|\/)(?:\.cache|node_modules|dist)(?:\/|$)/u.test(input)), false,
    'generated SDK artifacts and caches are not task inputs');
  assert.equal(artifactTask.inputs.includes('harness/pi-runtime/**/*'), false,
    'the full private SDK artifact/cache tree is not a task input');

  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:artifact'], 'proto run moon -- run root:artifactTest');
  for (const scriptName of ['test', 'check', 'verify']) {
    assert.doesNotMatch(packageJson.scripts[scriptName], /artifactTest|test:artifact/u,
      `${scriptName} must not implicitly invoke artifact verification`);
  }
});
