import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main, parseArgs, resolveProjectCompiler, runProject, runWithConcurrency, selectProjects, TYPECHECK_PROJECTS } from '../run-typechecks.mjs';
import { resolveTypeScriptCompiler } from '../../lib/package-resolution.mjs';
import { DEFAULT_CHILD_PROCESS_TIMEOUT_MS } from '../../lib/process-watchdog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('parseArgs accepts repeatable projects and concurrency', () => {
  assert.deepEqual(parseArgs(['--project', 'extension', '--project=analysis', '--concurrency', '2']), {
    ids: ['extension', 'analysis'], concurrency: 2, list: false, help: false,
  });
});

test('selectProjects deduplicates requested projects', () => {
  assert.deepEqual(selectProjects(['extension', 'extension']).map(({ id }) => id), ['extension']);
  assert.throws(() => selectProjects(['missing']), /Unknown typecheck project/);
});

test('subagent release config is a configured typecheck project', () => {
  const subagent = TYPECHECK_PROJECTS.find((project) => project.id === 'subagent');
  assert.ok(subagent, 'subagent must be a configured typecheck project');
  assert.equal(subagent.config, 'harness/tools/subagent/tsconfig.release.json');
});

test('detached application source projects resolve dependencies through the registered owner', () => {
  for (const id of ['extension', 'analytics-runtime', 'conversation-state']) {
    const project = TYPECHECK_PROJECTS.find((candidate) => candidate.id === id);
    assert.equal(project?.includeOwnerDependencies, true, `${id} uses the application dependency owner`);
  }
});

test('runWithConcurrency preserves order and limits active work', async () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency(projects, 2, async (project) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return project.id;
  });
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(peak, 2);
});

test('resolveProjectCompiler resolves the registry-declared compiler owner-relatively', (t) => {
  const extensionTsc = resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' });
  assert.equal(extensionTsc, resolveTypeScriptCompiler());
  assert.equal(path.isAbsolute(extensionTsc), true);
  assert.equal(
    resolveProjectCompiler({ compiler: 'analytics/analysis/node_modules/typescript/bin/tsc' }),
    resolveTypeScriptCompiler({ dependencyOwnerRoot: path.join(repoRoot, 'analytics/analysis') }),
  );

  // Absolute declarations (future-root proof projects) pass through unchanged.
  const absolute = path.join(os.tmpdir(), 'pie-tsc-proof', 'tsc');
  assert.equal(resolveProjectCompiler({ compiler: absolute }), absolute);

  // The owner is the complete path before the explicit compiler suffix, not
  // just the first directory component (future planned owner is nested).
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'pie-nested-tsc-owner-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const nestedCompiler = path.join(fixtureRoot, 'application', 'hosts', 'vscode', 'node_modules', 'typescript', 'bin', 'tsc');
  mkdirSync(path.dirname(nestedCompiler), { recursive: true });
  writeFileSync(path.join(path.dirname(path.dirname(nestedCompiler)), 'package.json'), JSON.stringify({ name: 'typescript', version: '0.0.0-fixture' }));
  writeFileSync(nestedCompiler, '');
  assert.equal(
    resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/bin/tsc' }, fixtureRoot),
    nestedCompiler,
  );

  // Invalid declarations fail validation, and valid owners still fail loudly
  // if they do not provide TypeScript instead of falling back to another copy.
  assert.throws(() => resolveProjectCompiler({ compiler: '' }), /non-empty path/);
  assert.throws(
    () => resolveProjectCompiler({ compiler: 'application/hosts/vscode/node_modules/typescript/tsc' }),
    /must end with/,
  );
  assert.throws(
    () => resolveProjectCompiler({ compiler: 'docs/node_modules/typescript/bin/tsc' }, fixtureRoot),
    /Cannot find module|Cannot find package|typescript/,
  );
});

function projectFixture(t, settle) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pie-typecheck-teardown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
  let disposed = 0;
  let settlements = 0;
  const logs = [];
  const dependencies = {
    createTsconfigOverlay: () => ({ directory, configPath: path.join(directory, 'tsconfig.json'), dispose: () => { disposed += 1; } }),
    spawn: () => child,
    watchChildProcess: (_child, options) => {
      assert.equal(options.timeoutMs, DEFAULT_CHILD_PROCESS_TIMEOUT_MS);
      return { timedOut: false, aborted: false, settle: () => { settlements += 1; return settle(); } };
    },
    console: { error: (line) => logs.push(line) },
  };
  const project = { id: 'proof', config: path.join(directory, 'source.json'), compiler: path.join(directory, 'tsc') };
  const runtime = { sdkPath: path.join(directory, 'selected-sdk'), artifactDir: path.join(directory, 'selected-runtime'), credentials: 'DO-NOT-RECORD' };
  return { directory, child, dependencies, project, runtime, logs, get disposed() { return disposed; }, get settlements() { return settlements; } };
}

test('uncertain close retains bounded current-run diagnostics and cannot be overwritten by error', async (t) => {
  const owned = { pid: 4242, ppid: 42, identity: 'creation-1', creationDate: 'creation-1', credentials: 'DO-NOT-RECORD' };
  const fixture = projectFixture(t, async () => ({ gone: false, ownedProcesses: [owned], survivorProcesses: [owned], ownedPids: [4242], survivors: [4242], diagnostics: ['census timed out; descendant ownership unknown'], credentials: 'DO-NOT-RECORD' }));
  const result = runProject(fixture.project, undefined, fixture.runtime, fixture.dependencies);
  fixture.child.stdout.emit('data', 'x'.repeat(100000));
  fixture.child.emit('close', 0);
  fixture.child.emit('error', new Error('later event'));
  await assert.rejects(result, (error) => error.teardownUnconfirmed && error.diagnosticPath === path.join(fixture.directory, 'teardown.json'));
  const raw = readFileSync(path.join(fixture.directory, 'teardown.json'), 'utf8');
  const evidence = JSON.parse(raw);
  assert.equal(evidence.childPid, 4242);
  assert.equal(evidence.owner.directory, fixture.directory);
  assert.equal(evidence.project.id, 'proof');
  assert.equal(evidence.sdkSelection.sdkPath, fixture.runtime.sdkPath);
  assert.equal(evidence.survivorProcesses[0].creationDate, 'creation-1');
  assert.equal(evidence.output.length, 16384);
  assert.ok(raw.length < 20000);
  assert.ok(!raw.includes('DO-NOT-RECORD'));
  assert.match(fixture.logs[0], /census timed out.*teardown.json/);
  assert.equal(fixture.settlements, 1);
  assert.equal(fixture.disposed, 0);
});

test('settlement rejection preserves cause and unknown evidence after spawn error plus close', async (t) => {
  const cause = new Error('enumeration failed');
  const fixture = projectFixture(t, async () => { throw cause; });
  const result = runProject(fixture.project, undefined, fixture.runtime, fixture.dependencies);
  fixture.child.emit('error', new Error('spawn failed'));
  fixture.child.emit('close', 1);
  await assert.rejects(result, (error) => error.teardownUnconfirmed && error.cause === cause);
  const evidence = JSON.parse(readFileSync(path.join(fixture.directory, 'teardown.json'), 'utf8'));
  assert.match(evidence.diagnostics[0], /enumeration failed/);
  assert.equal(evidence.childError, 'spawn failed');
  assert.deepEqual(evidence.ownedProcesses, []);
  assert.match(evidence.evidenceScope, /unknown/);
  assert.equal(fixture.settlements, 1);
  assert.equal(fixture.disposed, 0);
});

test('confirmed spawn error and close dispose and settle exactly once without uncertainty', async (t) => {
  const fixture = projectFixture(t, async () => ({ gone: true }));
  const cause = new Error('spawn failed');
  const result = runProject(fixture.project, undefined, fixture.runtime, fixture.dependencies);
  fixture.child.emit('error', cause);
  fixture.child.emit('close', 1);
  await assert.rejects(result, (error) => error === cause);
  assert.equal(fixture.settlements, 1);
  assert.equal(fixture.disposed, 1);
  assert.equal(existsSync(path.join(fixture.directory, 'teardown.json')), false);
});

test('confirmed compiler close preserves ordinary success/failure results without diagnostic files', async (t) => {
  for (const code of [0, 2]) {
    const fixture = projectFixture(t, async () => ({ gone: true }));
    const result = runProject(fixture.project, undefined, fixture.runtime, fixture.dependencies);
    fixture.child.stdout.emit('data', 'compiler output');
    fixture.child.emit('close', code);
    assert.equal((await result).code, code);
    assert.equal((await result).output, 'compiler output');
    assert.equal(fixture.disposed, 1);
    assert.equal(fixture.settlements, 1);
    assert.equal(existsSync(path.join(fixture.directory, 'teardown.json')), false);
  }
});

test('CLI reserves exit 125 for uncertainty even when compiler closes successfully', async (t) => {
  const fixture = projectFixture(t, async () => ({ gone: false, diagnostics: ['final census unavailable'] }));
  const target = {};
  let signalDisposed = false;
  const dependencies = {
    ...fixture.dependencies,
    process: target,
    abortOnProcessSignals: () => ({ signal: new AbortController().signal, dispose: () => { signalDisposed = true; } }),
    withVerificationRuntime: async (selection, _signal, run) => {
      assert.equal(selection.artifactDir, fixture.runtime.artifactDir);
      const pending = run(fixture.runtime);
      fixture.child.emit('close', 0);
      return pending;
    },
  };
  await main(['--project', 'extension', '--pi-runtime', fixture.runtime.artifactDir], dependencies);
  assert.equal(target.exitCode, 125);
  assert.equal(signalDisposed, false);
  assert.equal(fixture.disposed, 0);
  assert.equal(existsSync(path.join(fixture.directory, 'teardown.json')), true);
  await main(['--project', 'missing'], dependencies);
  assert.equal(target.exitCode, 1);
});

test('failed workers join already-launched siblings and propagate later uncertainty', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  let finished = false;
  const pending = runWithConcurrency([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, async (project) => {
    started.push(project.id);
    if (project.id === 'a') throw new Error('first failure');
    await gate;
    finished = true;
    throw Object.assign(new Error('later uncertain sibling'), { teardownUnconfirmed: true });
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await assert.rejects(pending, (error) => error.teardownUnconfirmed && error.cause.message === 'first failure');
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(finished, true);
});
