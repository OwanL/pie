import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRunnerInvocation, runPackageGroup } from '../run-package-group.mjs';
import { extractRuntimeArgs, withVerificationRuntime } from '../verification-runtime.mjs';
import { parseArgs, buildTestArgs } from '../run-tests.mjs';
import { runProject, runWithConcurrency } from '../run-typechecks.mjs';
import { runSuite } from '../run-fast-batched-tests.mjs';
import { TEST_FILE_ACCOUNTING_ENV } from '../test-reporter.mjs';
import { abortOnProcessSignals } from '../../lib/process-watchdog.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pie-plumbing-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('package group puts runtime selection before forwarding, acquires once, and keeps Node args clean', async (t) => {
  const artifactDir = await temporary(t);
  await writeFile(path.join(artifactDir, 'manifest.json'), '{}');
  let acquisitions = 0;
  let confirmations = 0;
  const withPiRuntime = async ({ artifactDir: selected }, run) => {
    if (!selected) acquisitions += 1;
    else assert.equal(selected, artifactDir);
    return run({ artifactDir, confirmChildCompletion() { confirmations += 1; } });
  };
  const invocation = buildRunnerInvocation('tests', ['extensions'], ['--', '--test-name-pattern=foo']);
  const code = await runPackageGroup({ args: [] }, invocation, undefined, {
    withPiRuntime,
    runRunner: async (script, argv) => {
      assert.equal(script, 'run-tests.mjs');
      assert.ok(argv.indexOf('--pi-runtime') < argv.indexOf('--'));
      const selection = extractRuntimeArgs(argv);
      const parsed = parseArgs(selection.args);
      assert.deepEqual(parsed.testArgs, ['--test-name-pattern=foo']);
      await withVerificationRuntime(selection, undefined, async () => {
        const nodeArgs = buildTestArgs({ coverage: false, testGlobs: ['fixture.test.mjs'] }, false, parsed.testArgs);
        assert.equal(nodeArgs.filter((arg) => arg === '--test-name-pattern=foo').length, 1);
        assert.ok(!nodeArgs.includes('--pi-runtime'));
        assert.ok(!nodeArgs.includes(artifactDir));
        assert.ok(!nodeArgs.includes('--'));
      }, { withPiRuntime });
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.equal(acquisitions, 1);
  assert.equal(confirmations, 2);
});

for (const cancel of [false, true]) {
  test(`typecheck queue drains launched siblings before ${cancel ? 'cancellation' : 'failure'} returns`, async () => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const failure = new Error('first sibling failed');
    const dispatched = [];
    let settled = false;
    const pending = runWithConcurrency(['a', 'b', 'never'], 2, async (id, signal) => {
      dispatched.push(id);
      if (id === 'a') {
        await started.promise;
        if (cancel) controller.abort();
        throw failure;
      }
      started.resolve();
      await release.promise;
      assert.equal(signal.aborted, cancel);
      return id;
    }, controller.signal);
    const checked = assert.rejects(pending, (error) => error === failure).then(() => { settled = true; });
    await started.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(dispatched, ['a', 'b']);
    release.resolve();
    await checked;
  });
}

test('typecheck keeps overlay through teardown and retains it if teardown is unconfirmed', async (t) => {
  for (const gone of [true, false]) {
    const directory = await temporary(t);
    const configPath = path.join(directory, 'overlay.json');
    await writeFile(configPath, '{}');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const teardown = deferred();
    let disposed = false;
    const pending = runProject({ id: 'fixture', config: configPath, compiler: path.join(directory, 'tsc') }, undefined, {}, {
      createTsconfigOverlay: () => ({ directory, configPath, dispose() { disposed = true; } }),
      spawn: () => child,
      watchChildProcess: () => ({ settle: () => teardown.promise }),
    });
    const checked = gone ? pending : assert.rejects(pending, /unconfirmed/);
    child.emit('close', 0);
    assert.equal(disposed, false);
    teardown.resolve({ gone });
    await checked;
    assert.equal(disposed, gone);
  }
});

for (const cancel of [false, true]) {
  test(`fast batches retain config and signal lifetime until sibling ${cancel ? 'cancellation' : 'failure'} is drained`, async () => {
    const target = new EventEmitter();
    const abort = abortOnProcessSignals(target, 'linux');
    const bothStarted = deferred();
    const release = deferred();
    let tempDir;
    let dispatched = 0;
    let settled = false;
    const failure = new Error('first batch failed');
    const pending = runSuite({ mode: 'fixture' }, {}, abort.signal, {
      buildPlan: async (_mode, directory) => {
        tempDir = directory;
        return { cwd: directory, batches: ['batch.mts'], forceExitFiles: ['force.test.ts'], expectedFiles: [], directFiles: [] };
      },
      createTsconfigOverlay: (_base, { directory }) => {
        const configPath = path.join(directory, 'overlay.json');
        writeFileSync(configPath, '{}');
        return { configPath };
      },
      run: async (_command, _args, _cwd, env, signal) => {
        const index = dispatched++;
        if (dispatched === 2) bothStarted.resolve();
        if (index === 0) {
          await bothStarted.promise;
          if (cancel) target.emit('SIGTERM');
          throw failure;
        }
        await release.promise;
        assert.equal(signal.aborted, cancel);
        assert.ok(existsSync(env[TEST_FILE_ACCOUNTING_ENV]));
        assert.ok(existsSync(env.TSX_TSCONFIG_PATH));
        assert.equal(target.listenerCount('SIGINT'), 1);
        return { code: 0, signal: null, stdout: '', stderr: '' };
      },
    });
    const checked = assert.rejects(pending.finally(() => abort.dispose()), (error) => error === failure).then(() => { settled = true; });
    await bothStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.ok(existsSync(tempDir));
    release.resolve();
    await checked;
    assert.equal(existsSync(tempDir), false);
    assert.equal(target.listenerCount('SIGINT'), 0);
  });
}

test('fast batches retain files on uncertain sibling teardown even if a different sibling fails first', async (t) => {
  let tempDir;
  const second = deferred();
  const failure = new Error('first failure');
  let dispatched = 0;
  const pending = runSuite({ mode: 'fixture' }, {}, undefined, {
    buildPlan: async (_mode, directory) => {
      tempDir = directory;
      t.after(() => rm(directory, { recursive: true, force: true }));
      return { cwd: directory, batches: ['batch.mts'], forceExitFiles: ['force.test.ts'], expectedFiles: [], directFiles: [] };
    },
    createTsconfigOverlay: (_base, { directory }) => ({ configPath: path.join(directory, 'overlay.json') }),
    run: async () => {
      if (dispatched++ === 0) throw failure;
      await second.promise;
      throw Object.assign(new Error('uncertain'), { teardownUnconfirmed: true });
    },
  });
  const checked = assert.rejects(pending, (error) => error.cause === failure && error.teardownUnconfirmed === true);
  await new Promise((resolve) => setImmediate(resolve));
  second.resolve();
  await checked;
  assert.ok(existsSync(tempDir));
});
