import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRunnerInvocation, runPackageGroup, runPackageGroupCli } from '../run-package-group.mjs';
import { extractRuntimeArgs, withVerificationRuntime } from '../verification-runtime.mjs';
import { parseArgs, buildTestArgs } from '../run-tests.mjs';
import { runProject, runWithConcurrency } from '../run-typechecks.mjs';

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

for (const scenario of [
  { code: 125, gone: true, uncertain: true },
  { code: 0, gone: false, uncertain: true },
  { code: null, signal: 'SIGTERM', gone: true, uncertain: false },
  { code: 2, gone: true, uncertain: false },
]) {
  test(`package group close ${scenario.code}/${scenario.signal ?? ''} gone=${scenario.gone}`, async () => {
    const child = new EventEmitter();
    let confirmed = false;
    const dependencies = {
      spawn: () => child,
      watchChildProcess: () => ({ settle: async () => ({ gone: scenario.gone }) }),
      withPiRuntime: async (_options, run) => run({ artifactDir: '/fake-runtime', confirmChildCompletion() { confirmed = true; } }),
    };
    const pending = runPackageGroup({ args: [] }, { script: 'run-tests.mjs', args: [] }, undefined, dependencies);
    const checked = scenario.uncertain
      ? assert.rejects(pending, (error) => error.teardownUnconfirmed === true)
      : pending.then((code) => assert.equal(code, scenario.code ?? 1));
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', scenario.code, scenario.signal);
    await checked;
    assert.equal(confirmed, !scenario.uncertain);
  });
}

test('package group CLI preserves uncertain teardown status 125', async () => {
  const previous = process.exitCode;
  try {
    const child = new EventEmitter();
    const pending = runPackageGroupCli(['tests', 'extensions', '--list'], {
      spawn: () => child,
      watchChildProcess: () => ({ settle: async () => ({ gone: true }) }),
    });
    child.emit('close', 125);
    await pending;
    assert.equal(process.exitCode, 125);
  } finally { process.exitCode = previous; }
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
