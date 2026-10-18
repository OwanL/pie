import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireDevelopmentReader, withDevelopmentWriter } from '../../../lib/development-runtime/lifetime.mjs';
import { snapshotProcessTree } from '../../lib/process-watchdog.mjs';
import { spawnWindowsOwnedTree } from '../../../lib/process-lifecycle/windows-owned-tree.mjs';
import { runNativeTestLease } from '../native-test-keeper.mjs';
import { runOwnedTestDriver } from '../owned-test-driver.mjs';
import { OWNERSHIP_STARTUP_TOKEN } from '../ownership-startup.mjs';
import { createTestEnvironment, runNodeTestsWithOverlay, runOwnedNodeTests } from '../test-node.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const windows = { skip: process.platform !== 'win32', timeout: 90_000 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(20); }
  throw new Error('Fixture condition timed out');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function temp(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function workspace(t) {
  const root = temp(t, 'pie-keeper-test-');
  const sdkPath = path.join(root, 'harness/pi/packages/coding-agent');
  const names = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox'];
  for (const name of names) {
    const directory = name === names[0] ? sdkPath : path.join(sdkPath, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.mjs' } }));
    writeFileSync(path.join(directory, 'index.mjs'), 'export const fixture = true;');
  }
  const config = path.join(root, 'application/hosts/vscode/tsconfig.json');
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '{"compilerOptions":{}}');
  const workspaceRoot = realpathSync.native(path.join(root, 'harness/pi'));
  const readerDirectory = path.join(workspaceRoot, '.cache/development-runtime/readers');
  const records = () => existsSync(readerDirectory) ? readdirSync(readerDirectory).map((name) => JSON.parse(readFileSync(path.join(readerDirectory, name), 'utf8'))) : [];
  return { root, sdkPath, workspaceRoot, records };
}
async function denied(root) {
  await assert.rejects(withDevelopmentWriter(root, async () => assert.fail('writer ran')), /writer denied/);
}
async function admitted(root) { await withDevelopmentWriter(root, async () => {}); }
function removeEvidence(record) {
  const directory = record?.metadata?.evidence;
  if (!directory) return;
  for (const name of ['lifetime.json', 'owned-tree.json']) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    const candidates = [evidence.overlayPath && path.dirname(evidence.overlayPath), evidence.configRoot, evidence.evidenceDirectory];
    for (const candidate of candidates.filter(Boolean)) {
      if (/^pie-(?:tsx-overlay|node-runner|windows-owned-tree)-/u.test(path.basename(candidate))) rmSync(candidate, { recursive: true, force: true });
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
function cleanEvidence(t, record) { t.after(() => removeEvidence(record)); }

function invocation(t) {
  const configRoot = temp(t, 'pie-owned-driver-test-');
  const configPath = path.join(configRoot, 'runner.json');
  writeFileSync(configPath, '{}');
  return { configRoot, configPath, args: ['fixture', configPath], dispose() { rmSync(configRoot, { recursive: true, force: true }); } };
}
function fakeTree(events, overrides = {}) {
  const proof = { gone: true, activeProcesses: 0, invocationId: 'invocation', rootPid: 123,
    admissionSealed: true, authority: 'open-windows-job-accounting' };
  return {
    invocationId: proof.invocationId, rootPid: proof.rootPid,
    stdout: new PassThrough(), stderr: new PassThrough(),
    completion: Promise.resolve({ code: 0 }),
    async authorizeStartup(text) { assert.equal(text, OWNERSHIP_STARTUP_TOKEN); events.push('authorize'); },
    async stopAndDrain() { events.push('drain'); return proof; },
    async closeAfterRelease() { events.push('close'); },
    ...overrides,
  };
}

test('native production delegation precedes lease/validation/overlay even with injected legacy callbacks', windows, async (t) => {
  const ws = workspace(t);
  const expected = { code: 0, teardownConfirmed: true };
  const actual = await runNodeTestsWithOverlay([], { repoRoot: ws.root, sdkPath: ws.sdkPath }, {
    createOverlay() { assert.fail('launcher overlay'); }, run() { assert.fail('legacy driver'); },
    runInKeeper(files, options) { assert.deepEqual(files, []); assert.equal(options.sdkPath, ws.sdkPath); assert.equal(ws.records().length, 0); return expected; },
  });
  assert.equal(actual, expected);
});

test('keeper acquires before SDK validation; validation failure releases without launching', async (t) => {
  const ws = workspace(t);
  await assert.rejects(runNativeTestLease([], { repoRoot: ws.root, sdkPath: ws.sdkPath }, {
    resolveSdkPath() { assert.equal(ws.records().length, 1); throw new Error('not compiled'); },
    runOwnedTests() { assert.fail('must not launch'); },
  }), /not compiled/);
  assert.equal(ws.records().length, 0);
  await admitted(ws.workspaceRoot);
});

test('keeper confirmed proof callback releases exact registration and then disposes overlay', async (t) => {
  const ws = workspace(t);
  let disposed = false;
  const result = await runNativeTestLease([], { repoRoot: ws.root, sdkPath: ws.sdkPath, env: { BASE: 'kept' } }, {
    createOverlay() { return { configPath: 'overlay', dispose() { disposed = true; } }; },
    async runOwnedTests(files, options, { releaseReader }) {
      assert.deepEqual(options.env, { BASE: 'kept', TSX_TSCONFIG_PATH: 'overlay' });
      await denied(ws.workspaceRoot);
      assert.equal(disposed, false);
      await releaseReader({ teardownConfirmed: true });
      return { code: 0, teardownConfirmed: true };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(disposed, true);
  assert.equal(ws.records().length, 0);
  await admitted(ws.workspaceRoot);
});

for (const failure of ['exception-without-flag', 'missing-confirmation', 'success-without-proof']) {
  test(`keeper defaults to unknown after admission: ${failure}`, async (t) => {
    const ws = workspace(t);
    let disposed = false;
    await assert.rejects(runNativeTestLease([], { repoRoot: ws.root, sdkPath: ws.sdkPath }, {
      createOverlay: () => ({ configPath: 'overlay', dispose() { disposed = true; } }),
      async runOwnedTests() {
        if (failure === 'exception-without-flag') throw new Error('unexpected driver exception');
        return failure === 'missing-confirmation' ? { code: 0 } : { code: 0, teardownConfirmed: true };
      },
    }), (error) => error.teardownUnconfirmed === true && existsSync(error.diagnosticPath));
    assert.equal(disposed, false);
    assert.equal(ws.records().length, 1);
    cleanEvidence(t, ws.records()[0]);
    await denied(ws.workspaceRoot);
  });
}

test('pre-acquisition cancellation never registers or builds aliases', async (t) => {
  const ws = workspace(t);
  const result = await runNativeTestLease([], { repoRoot: ws.root, sdkPath: ws.sdkPath, signal: AbortSignal.abort() }, {
    acquireReader() { assert.fail('acquisition'); }, createOverlay() { assert.fail('overlay'); },
  });
  assert.deepEqual(result, { code: 1, teardownConfirmed: true });
  assert.equal(ws.records().length, 0);
});

test('owned driver uses one shared invocation; release precedes close/dispose, root completion still drains', async (t) => {
  const events = [];
  const prepared = invocation(t);
  await runOwnedTestDriver(prepared, { cwd: repoRoot, env: { TEST: 'value' } }, {
    spawnTree(options) {
      assert.deepEqual(options, { command: process.execPath, args: prepared.args, cwd: repoRoot, env: { TEST: 'value' } });
      return fakeTree(events);
    },
    async releaseReader(proof) { assert.deepEqual(proof, { teardownConfirmed: true }); events.push('release'); },
  });
  assert.deepEqual(events, ['authorize', 'drain', 'release', 'close']);
  assert.equal(existsSync(prepared.configRoot), false);
});

for (const field of ['gone', 'activeProcesses', 'invocationId', 'rootPid', 'admissionSealed', 'authority']) {
  test(`owned driver rejects nonmatching proof field ${field}`, async (t) => {
    const prepared = invocation(t);
    const events = [];
    const tree = fakeTree(events);
    const proof = await tree.stopAndDrain();
    delete proof[field];
    tree.stopAndDrain = async () => proof;
    await assert.rejects(runOwnedTestDriver(prepared, {}, {
      spawnTree: () => tree, releaseReader() { assert.fail('unsafe release'); },
    }), (error) => error.teardownUnconfirmed && existsSync(error.diagnosticPath));
    assert.equal(events.includes('close'), false);
    assert.equal(existsSync(prepared.configRoot), true);
  });
}

test('cancel/readiness race queues cancellation without aborting guardian startup or authorizing', async (t) => {
  const controller = new AbortController();
  const events = [];
  let ready;
  const startup = new Promise((resolve) => { ready = resolve; });
  const prepared = invocation(t);
  const running = runOwnedTestDriver(prepared, { signal: controller.signal }, {
    spawnTree(options) { assert.equal(options.signal, undefined); events.push('startup'); return startup; },
    releaseReader() { events.push('release'); },
  });
  controller.abort();
  await wait(20);
  assert.deepEqual(events, ['startup']);
  ready(fakeTree(events));
  assert.deepEqual(await running, { code: 1, teardownConfirmed: true });
  assert.deepEqual(events, ['startup', 'drain', 'release', 'close']);
});

for (const mode of ['abort', 'timeout', 'authorize-exception']) {
  test(`owned driver drains after ${mode}`, async (t) => {
    const events = [];
    const controller = new AbortController();
    const tree = fakeTree(events, { completion: new Promise(() => {}) });
    if (mode === 'authorize-exception') tree.authorizeStartup = async () => { throw new Error('lost acknowledgement'); };
    else tree.authorizeStartup = async () => { if (mode === 'abort') controller.abort(); };
    const promise = runOwnedTestDriver(invocation(t), { signal: controller.signal, timeoutMs: 10 }, {
      spawnTree: () => tree, releaseReader() { events.push('release'); },
    });
    if (mode === 'authorize-exception') await assert.rejects(promise, /lost acknowledgement/);
    else assert.deepEqual(await promise, { code: 1, teardownConfirmed: true });
    assert.deepEqual(events, ['drain', 'release', 'close']);
  });
}

for (const evidence of [true, false]) {
  test(`startup failure ${evidence ? 'with' : 'without'} primitive evidence`, async (t) => {
    let released = false;
    const prepared = invocation(t);
    const error = new Error('startup failed');
    if (evidence) error.evidenceDirectory = 'fixture-evidence';
    await assert.rejects(runOwnedTestDriver(prepared, {}, {
      spawnTree() { throw error; }, releaseReader() { released = true; },
    }), (caught) => evidence ? caught.teardownUnconfirmed === true : caught === error);
    assert.equal(released, !evidence);
    assert.equal(existsSync(prepared.configRoot), evidence);
  });
}

test('interrupted acquisition retains its durable record and invocation evidence', async (t) => {
  const ws = workspace(t);
  await assert.rejects(runNativeTestLease([], { repoRoot: ws.root, sdkPath: ws.sdkPath }, {
    async acquireReader(root, options) {
      await acquireDevelopmentReader(root, options);
      throw new Error('interrupted after durable mutation');
    },
  }), (error) => error.teardownUnconfirmed && existsSync(error.diagnosticPath));
  assert.equal(ws.records().length, 1);
  cleanEvidence(t, ws.records()[0]);
  await denied(ws.workspaceRoot);
});

// Real Windows routes. Census is used ONLY to choose a fault-injection target,
// never as release authority; all release assertions inspect the writer gate.
async function experiment(t, { beforeAuthorization = false } = {}) {
  const ws = workspace(t);
  const fixture = createTestEnvironment();
  t.after(() => fixture.dispose());
  const pidFile = path.join(ws.root, 'grandchild.pid');
  const marker = path.join(ws.root, 'suite-ran');
  const source = path.join(ws.root, 'fixture.test.mjs');
  writeFileSync(source, `import test from 'node:test'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'ran');
    test('keeps grandchild live', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      await new Promise(() => {});
    });`);
  const launcherFile = path.join(ws.root, 'launcher.mjs');
  writeFileSync(launcherFile, `import { runNodeTestsWithOverlay } from ${JSON.stringify(new URL('../test-node.mjs', import.meta.url).href)};
    try { const result = await runNodeTestsWithOverlay(${JSON.stringify([source])}, ${JSON.stringify({ repoRoot: ws.root, cwd: repoRoot, sdkPath: ws.sdkPath, env: fixture.env, timeoutMs: 60_000 })}); console.log('RESULT', JSON.stringify(result)); }
    catch (error) { console.error('ERROR', error.message, error.diagnosticPath); process.exitCode = 1; }`);
  const launcher = spawn(process.execPath, [launcherFile], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  launcher.stdout.on('data', (chunk) => { output += chunk; });
  launcher.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(launcher, 'exit');
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    await exited;
    // Only task-owned synthetic records/evidence are removed after assertions.
    for (const record of ws.records()) removeEvidence(record);
    if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')))) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  });
  try { await until(() => ws.records().length === 1); }
  catch (error) { throw new Error(`${error.message}: ${output}`); }
  const record = ws.records()[0];
  assert.notEqual(record.pid, launcher.pid, 'keeper, not launcher, acquired the reader');
  if (!beforeAuthorization) {
    try { await until(() => existsSync(pidFile)); }
    catch (error) { throw new Error(`${error.message}: ${output}`); }
  }
  return { ...ws, launcher, exited, pidFile, marker, keeperPid: record.pid, output: () => output };
}

test('Windows normal root completion drains a still-live grandchild before releasing', windows, async (t) => {
  const ws = workspace(t);
  const fixture = createTestEnvironment();
  t.after(() => fixture.dispose());
  const source = path.join(ws.root, 'normal.test.mjs');
  const pidFile = path.join(ws.root, 'normal-grandchild.pid');
  writeFileSync(source, `import test from 'node:test'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    test('normal', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      await new Promise(resolve => setTimeout(resolve, 500));
    });`);
  const running = runNodeTestsWithOverlay([source], { repoRoot: ws.root, cwd: repoRoot, sdkPath: ws.sdkPath, env: fixture.env });
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(alive(pid), true);
  await denied(ws.workspaceRoot);
  assert.deepEqual(await running, { code: 0, teardownConfirmed: true });
  assert.equal(alive(pid), false);
  await admitted(ws.workspaceRoot);
});

test('Windows contained native lifetime succeeds with synchronous WMI/census execution unavailable', windows, async (t) => {
  const ws = workspace(t);
  const fixture = createTestEnvironment();
  t.after(() => fixture.dispose());
  const source = path.join(ws.root, 'no-census.test.mjs');
  const marker = path.join(ws.root, 'no-census-ran');
  writeFileSync(source, `import test from 'node:test'; import { writeFileSync } from 'node:fs';
    test('kernel only', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });`);
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw new Error('WMI/process census unavailable'); };
  syncBuiltinESMExports();
  try {
    const result = await runNativeTestLease([source], { repoRoot: ws.root, cwd: repoRoot, sdkPath: ws.sdkPath, env: fixture.env });
    assert.deepEqual(result, { code: 0, teardownConfirmed: true });
    assert.equal(readFileSync(marker, 'utf8'), 'ran', 'actual fixture test body executed');
    await admitted(ws.workspaceRoot);
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
});

test('Windows cancellation during actual guardian readiness preserves the proof channel', windows, async (t) => {
  const ws = workspace(t);
  const controller = new AbortController();
  const source = path.join(ws.root, 'never.test.mjs');
  const marker = path.join(ws.root, 'never-ran');
  writeFileSync(source, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const result = await runNativeTestLease([source], { repoRoot: ws.root, cwd: repoRoot, sdkPath: ws.sdkPath, signal: controller.signal }, {
    runOwnedTests(files, options, dependencies) {
      return runOwnedNodeTests(files, options, { ...dependencies, spawnTree(spawnOptions) {
        assert.equal(spawnOptions.signal, undefined);
        const readiness = spawnWindowsOwnedTree(spawnOptions);
        controller.abort();
        return readiness;
      } });
    },
  });
  assert.deepEqual(result, { code: 1, teardownConfirmed: true });
  assert.equal(existsSync(marker), false);
  assert.equal(ws.records().length, 0);
  await admitted(ws.workspaceRoot);
});

test('Windows launcher hard death during execution: writer denied while detached grandchild lives, admitted after keeper drain', windows, async (t) => {
  const run = await experiment(t);
  const pid = Number(readFileSync(run.pidFile, 'utf8'));
  assert.equal(alive(pid), true);
  await denied(run.workspaceRoot);
  run.launcher.kill('SIGKILL');
  await run.exited;
  await until(() => run.records().length === 0 && !alive(pid));
  await admitted(run.workspaceRoot);
});

test('Windows launcher hard death during guardian startup drains without authorizing', windows, async (t) => {
  const run = await experiment(t, { beforeAuthorization: true });
  assert.equal(existsSync(run.marker), false, 'fixture code has not run');
  run.launcher.kill('SIGKILL');
  await run.exited;
  await until(() => run.records().length === 0);
  assert.equal(existsSync(run.marker), false, 'launcher loss is not startup authorization');
  await admitted(run.workspaceRoot);
});

for (const target of ['keeper', 'guardian']) {
  test(`Windows ${target} loss retains reader and evidence, settles launcher error`, windows, async (t) => {
    const run = await experiment(t);
    const pid = Number(readFileSync(run.pidFile, 'utf8'));
    let targetPid = run.keeperPid;
    if (target === 'guardian') {
      // Diagnostic census only. Node keeper -> PowerShell guardian -> root.
      const rows = snapshotProcessTree(run.keeperPid);
      targetPid = rows.find((row) => row.ppid === run.keeperPid)?.pid;
      assert.ok(targetPid, JSON.stringify(rows));
    }
    process.kill(targetPid, 'SIGKILL');
    await run.exited;
    await until(() => !alive(pid));
    assert.equal(run.records().length, 1);
    assert.ok(existsSync(run.records()[0].metadata.evidence));
    await denied(run.workspaceRoot);
    assert.match(run.output(), /ERROR/);
  });
}
