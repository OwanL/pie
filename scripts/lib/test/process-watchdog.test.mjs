import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CHILD_PROCESS_TIMEOUT_MS,
  abortOnProcessSignals,
  killProcessTree,
  resolveChildProcessTimeoutMs,
  snapshotProcessTree,
  watchChildProcess,
  withProcessTreeIsolation,
} from '../process-watchdog.mjs';

const integrationTest = process.env.PIE_RUN_INTEGRATION_TESTS === '1' ? test : test.skip;

/**
 * Read the grandchild pid the fixture publishes, then wait until the OS
 * actually reports it as a descendant of `rootPid`.
 *
 * The fixture writes the pid as soon as `spawn()` returns, but the process
 * table does not necessarily expose the parent link yet. `terminateProcessTree`
 * captures ownership via `snapshotProcessTree`, so arming the watchdog before
 * that link is visible makes ownership capture race process creation — which
 * surfaced as intermittent "grandchild was captured as owned" failures on
 * loaded runs. Waiting on the real precondition removes the race rather than
 * widening a timeout.
 *
 * The wait is tiered because `snapshotProcessTree` shells out to a process
 * enumeration on every call: cheap checks (pid file, liveness probe) poll
 * fast, and the expensive tree enumeration is retried on a slow cadence so
 * this stays affordable under coverage instrumentation.
 */
async function waitForVisibleGrandchild(pidFile, rootPid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let grandchildPid = 0;

  // Tier 1 (cheap): the fixture has published a pid and the process is live.
  while (Date.now() < deadline) {
    if (!(grandchildPid > 0)) {
      try { grandchildPid = Number(await readFile(pidFile, 'utf8')); } catch { /* not published yet */ }
    }
    if (grandchildPid > 0) {
      try { process.kill(grandchildPid, 0); break; } catch { /* not scheduled yet */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!(grandchildPid > 0)) return 0;

  // Tier 2 (expensive): the parent link is visible to process enumeration.
  while (Date.now() < deadline) {
    if (snapshotProcessTree(rootPid).some((entry) => entry.pid === grandchildPid)) return grandchildPid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 0;
}

function fakeChild(pid = 1234) {
  return {
    pid,
    killCalls: [],
    kill(signal) {
      this.killCalls.push(signal);
    },
  };
}

test('resolveChildProcessTimeoutMs is bounded by default and supports explicit disable', () => {
  assert.equal(resolveChildProcessTimeoutMs(undefined), DEFAULT_CHILD_PROCESS_TIMEOUT_MS);
  assert.equal(DEFAULT_CHILD_PROCESS_TIMEOUT_MS, 20 * 60 * 1000);
  assert.equal(resolveChildProcessTimeoutMs('2500'), 2500);
  assert.equal(resolveChildProcessTimeoutMs('0'), 0);
  assert.equal(resolveChildProcessTimeoutMs('-1'), DEFAULT_CHILD_PROCESS_TIMEOUT_MS);
  assert.equal(resolveChildProcessTimeoutMs('invalid'), DEFAULT_CHILD_PROCESS_TIMEOUT_MS);
});

test('withProcessTreeIsolation creates a Unix process group but not a Windows detached process', () => {
  assert.equal(withProcessTreeIsolation({ cwd: '/tmp' }, 'linux').detached, true);
  assert.equal(withProcessTreeIsolation({ cwd: 'C:\\tmp' }, 'win32').detached, false);
});

test('killProcessTree gives Windows a grace window then uses identity-checked taskkill /T /F', async () => {
  const child = fakeChild(4321);
  const calls = [];
  let alive = true;
  const result = await killProcessTree(child, {
    platform: 'win32',
    gracefulMs: 1,
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'powershell.exe') return { status: 0, stdout: '4321|1|identity\n' };
      alive = false;
      return { status: 0, stdout: '' };
    },
    killImpl: (_pid, signal) => { if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  const taskkill = calls.find((call) => call.command === 'taskkill');
  assert.deepEqual(taskkill.args, ['/T', '/F', '/PID', '4321']);
  assert.deepEqual(child.killCalls, []);
  assert.equal(result.gone, true);
  assert.deepEqual(result.ownedPids, [4321]);
  assert.deepEqual(result.ownedProcesses, [{ pid: 4321, ppid: 1, identity: 'identity', creationDate: 'identity' }]);
  assert.deepEqual(result.survivorProcesses, []);
});

test('killProcessTree skips Windows taskkill when process enumeration fails', async () => {
  let alive = true;
  const calls = [];
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: (command, args) => {
      if (command === 'powershell.exe') return { status: null, stdout: '', error: new Error('enumeration timeout') };
      calls.push(args); alive = false; return { status: 0, stdout: '' };
    },
    killImpl: (_pid, signal) => { if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.gone, false);
  assert.deepEqual(result.survivors, [4321]);
  assert.deepEqual(result.survivorProcesses, [{ pid: 4321, ppid: 0, identity: null }]);
  assert.ok(result.diagnostics.some((message) => message.includes('enumeration failed') && message.includes('descendant ownership is unknown')));
  assert.ok(result.diagnostics.some((message) => message.includes('taskkill skipped for all PIDs')));
});

test('killProcessTree fails closed when the captured Windows creation identity and later query are missing', async () => {
  const child = fakeChild(4321);
  let alive = true;
  let enumerationCount = 0;
  const calls = [];
  const result = await killProcessTree(child, {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: (command, args) => {
      if (command === 'powershell.exe') {
        enumerationCount += 1;
        if (enumerationCount === 1) return { status: 0, stdout: '4321|1|\n' };
        return { status: null, stdout: '', error: new Error('enumeration timeout') };
      }
      calls.push(args);
      alive = false;
      return { status: 0, stdout: '' };
    },
    killImpl: (_pid, signal) => { if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.gone, false);
  assert.deepEqual(result.ownedProcesses, [{ pid: 4321, ppid: 1, identity: null, creationDate: null }]);
  assert.deepEqual(result.survivorProcesses, [{ pid: 4321, ppid: 1, identity: null, creationDate: null }]);
  assert.ok(result.diagnostics.some((message) => message.includes('no captured creation identity')));
  assert.ok(result.diagnostics.some((message) => message.includes('enumeration failed') && message.includes('timeout')));
  assert.deepEqual(child.killCalls, []);
});

test('killProcessTree treats a missing current Windows creation date as unknown', async () => {
  let query = 0;
  const calls = [];
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: (command, args) => {
      if (command !== 'powershell.exe') {
        calls.push(args);
        return { status: 0, stdout: '' };
      }
      query += 1;
      return { status: 0, stdout: query === 1 ? '4321|1|captured-root\n' : '4321|1|\n' };
    },
    killImpl: () => {},
  });
  assert.deepEqual(calls, []);
  assert.equal(result.gone, false);
  assert.deepEqual(result.survivorProcesses, [{ pid: 4321, ppid: 1, identity: 'captured-root', creationDate: 'captured-root' }]);
  assert.ok(result.diagnostics.some((message) => message.includes('no current creation identity')));
});

test('killProcessTree does not signal a reused Windows root or its new children', async () => {
  const calls = [];
  let query = 0;
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: (command, args) => {
      if (command !== 'powershell.exe') {
        calls.push(args);
        return { status: 0, stdout: '' };
      }
      query += 1;
      if (query === 1) return { status: 0, stdout: '4321|1|old-root\n' };
      return { status: 0, stdout: '4321|1|new-root\n7654|4321|new-child\n' };
    },
    killImpl: () => {},
  });
  assert.deepEqual(calls, []);
  assert.equal(result.gone, true);
  assert.deepEqual(result.survivors, []);
  assert.ok(result.diagnostics.some((message) => message.includes('was reused') && message.includes('root tree taskkill skipped')));
});

test('killProcessTree leaves a reused Windows tree unverified when the real ChildProcess already closed', async (t) => {
  for (const closeState of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) {
    await t.test(JSON.stringify(closeState), async () => {
      const child = new ChildProcess();
      child.pid = 123;
      Object.assign(child, closeState);
      const calls = [];
      const rows = '123|1|reused-root\n456|123|new-descendant\n';
      const result = await killProcessTree(child, {
        platform: 'win32', gracefulMs: 1, forceMs: 5,
        spawnSyncImpl: (command, args) => {
          calls.push(command);
          return { status: 0, stdout: rows };
        },
        killImpl: () => {},
      });
      assert.deepEqual(calls, ['powershell.exe']);
      assert.equal(result.gone, false);
      assert.deepEqual(result.ownedPids, [123, 456]);
      assert.deepEqual(result.ownedProcesses.map(({ identity }) => identity), ['reused-root', 'new-descendant']);
      assert.ok(result.diagnostics.some((message) => message.includes('ownership is unverified') && message.includes('taskkill skipped')));
    });
  }
});

test('killProcessTree may target a captured Windows child only when its creation identity still matches', async () => {
  const calls = [];
  let childAlive = true;
  let query = 0;
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: (command, args) => {
      if (command === 'taskkill') {
        calls.push(args);
        if (args.at(-1) === '7654') childAlive = false;
        return { status: 0, stdout: '' };
      }
      query += 1;
      if (query === 1) return { status: 0, stdout: '4321|1|old-root\n7654|4321|known-child\n' };
      return { status: 0, stdout: '4321|1|new-root\n7654|1|known-child\n' };
    },
    killImpl: (pid, signal) => {
      if (signal === 0 && pid === 7654 && !childAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(calls, [['/T', '/F', '/PID', '7654']]);
  assert.equal(result.gone, true);
  assert.deepEqual(result.survivors, []);
});

test('killProcessTree still recognizes an already-gone Windows root without creation identity', async () => {
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: () => ({ status: 0, stdout: '' }),
    killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.equal(result.gone, true);
  assert.deepEqual(result.survivors, []);
});

test('killProcessTree does not confirm unknown Windows descendants after initial enumeration failure', async () => {
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: () => ({ status: null, stdout: '', error: new Error('enumeration timeout') }),
    killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  assert.equal(result.gone, false);
  assert.deepEqual(result.survivors, []);
  assert.ok(result.diagnostics.some((message) => message.includes('descendant ownership is unknown')));
});

test('killProcessTree gracefully terminates an isolated Unix process group', async () => {
  const child = fakeChild(2468);
  const calls = [];
  let alive = true;
  const result = await killProcessTree(child, {
    platform: 'linux',
    gracefulMs: 1,
    spawnSyncImpl: () => ({ status: 0, stdout: '2468 1 Mon Jan  1 00:00:00 2024\n' }),
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      if (signal === 'SIGTERM') alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(calls[0], { pid: -2468, signal: 'SIGTERM' });
  assert.equal(result.gone, true);
});

test('killProcessTree escalates when a Unix child ignores graceful termination', async () => {
  let alive = true;
  const signals = [];
  const result = await killProcessTree(fakeChild(2468), {
    platform: 'linux', gracefulMs: 1, forceMs: 5,
    spawnSyncImpl: () => ({ status: 0, stdout: '2468 1 Mon Jan  1 00:00:00 2024\n' }),
    killImpl: (_pid, signal) => {
      if (signal !== 0) signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.gone, true);
});

test('watchChildProcess kills the full tree on timeout and records timeout state', async () => {
  const child = fakeChild();
  const reasons = [];
  const watchdog = watchChildProcess(child, {
    timeoutMs: 10,
    killTree: () => reasons.push('killed'),
    onTerminate: ({ reason }) => reasons.push(reason),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(watchdog.timedOut, true);
  assert.equal(watchdog.aborted, false);
  assert.deepEqual(reasons, ['timeout', 'killed']);
  watchdog.cleanup();
});

test('watchChildProcess still kills when timeout diagnostics throw', async () => {
  let kills = 0;
  const watchdog = watchChildProcess(fakeChild(), {
    timeoutMs: 5,
    onTerminate: () => { throw new Error('broken logger'); },
    killTree: () => { kills += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(kills, 1);
  assert.equal(watchdog.timedOut, true);
  watchdog.cleanup();
});

test('watchChildProcess kills the full tree on parent abort and removes its listener', () => {
  const child = fakeChild();
  const controller = new AbortController();
  let kills = 0;
  const watchdog = watchChildProcess(child, {
    timeoutMs: 0,
    signal: controller.signal,
    killTree: () => { kills += 1; },
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  assert.equal(kills, 1);
  assert.equal(watchdog.aborted, true);
  watchdog.cleanup();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('watchChildProcess cleanup disarms a normal child before timeout', async () => {
  let kills = 0;
  const watchdog = watchChildProcess(fakeChild(), {
    timeoutMs: 10,
    killTree: () => { kills += 1; },
  });
  watchdog.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kills, 0);
  assert.equal(watchdog.timedOut, false);
});

test('abortOnProcessSignals converts SIGINT into an AbortSignal and cleans handlers', () => {
  const target = new EventEmitter();
  const processAbort = abortOnProcessSignals(target);
  assert.equal(target.listenerCount('SIGINT'), 1);
  assert.equal(target.listenerCount('SIGTERM'), 1);
  target.emit('SIGINT');
  assert.equal(processAbort.signal.aborted, true);
  processAbort.dispose();
  assert.equal(target.listenerCount('SIGINT'), 0);
  assert.equal(target.listenerCount('SIGTERM'), 0);
});

integrationTest('abort kills a real uniquely-owned child and grandchild but preserves an unrelated sentinel', { timeout: 60_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-process-abort-'));
  const pidFile = path.join(tempDir, 'grandchild.pid');
  const rootCode = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const root = spawn(process.execPath, ['-e', rootCode], withProcessTreeIsolation({ stdio: 'ignore', windowsHide: true }));
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], withProcessTreeIsolation({ stdio: 'ignore', windowsHide: true }));
  const controller = new AbortController();
  const rootClosed = new Promise((resolve) => root.once('close', resolve));
  let watchdog;
  try {
    const grandchildPid = await waitForVisibleGrandchild(pidFile, root.pid);
    assert.ok(grandchildPid > 0);
    watchdog = watchChildProcess(root, { timeoutMs: 0, signal: controller.signal });
    controller.abort(new Error('test cancellation'));
    await rootClosed;
    const cleanup = await watchdog.settle();
    assert.equal(cleanup.gone, true);
    assert.ok(cleanup.ownedPids.includes(grandchildPid), 'grandchild was captured as owned');
    assert.throws(() => process.kill(grandchildPid, 0), (error) => error?.code === 'ESRCH');
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    watchdog?.cleanup();
    await killProcessTree(root);
    await killProcessTree(sentinel);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('spawn failure has no owned PID and cleanup settles', { timeout: 5_000 }, async () => {
  const child = spawn(`pie-command-that-does-not-exist-${process.pid}`, [], { stdio: 'ignore' });
  const watchdog = watchChildProcess(child, { timeoutMs: 1000 });
  await new Promise((resolve) => child.once('error', resolve));
  const cleanup = await watchdog.settle();
  assert.equal(child.pid, undefined);
  assert.deepEqual(cleanup, {
    gone: true, survivors: [], ownedPids: [], ownedProcesses: [], survivorProcesses: [], diagnostics: [],
  });
});

integrationTest('Windows watchdog kills a real grandchild process tree', { skip: process.platform !== 'win32' }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-process-watchdog-'));
  const pidFile = path.join(tempDir, 'grandchild.pid');
  const rootCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify("setInterval(() => {}, 1000)")}], { stdio: 'ignore', windowsHide: true });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const root = spawn(process.execPath, ['-e', rootCode], withProcessTreeIsolation({
    stdio: 'ignore',
    windowsHide: true,
  }));
  // Subscribe immediately because EventEmitter does not replay an already-
  // emitted close event to a late listener. Arm the watchdog only after the
  // fixture has published its grandchild pid; otherwise a loaded Windows run
  // can kill fixture setup before the behavior under test is observable.
  const rootClosed = new Promise((resolve) => root.once('close', resolve));
  let watchdog;

  try {
    // Upper bounds below are deliberately generous: each bounds an *eventual*
    // outcome, so a healthy run still finishes in ~3s. This test runs
    // alongside other packages, where Windows spawn + `taskkill /T` teardown
    // can be scheduled far past a tight deadline; tight budgets produced
    // false "root tree did not close" failures under load while the test
    // passed in isolation.
    const grandchildPid = await waitForVisibleGrandchild(pidFile, root.pid);
    assert.ok(grandchildPid > 0, 'root process must publish its grandchild pid');
    watchdog = watchChildProcess(root, { timeoutMs: 500, label: 'integration tree' });

    let closeTimer;
    try {
      await Promise.race([
        rootClosed,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('root tree did not close')), 60_000);
        }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    watchdog.cleanup();
    assert.equal(watchdog.timedOut, true);

    let alive = true;
    for (let attempt = 0; attempt < 1000 && alive; attempt += 1) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild ${grandchildPid} survived taskkill /T`);
  } finally {
    watchdog?.cleanup();
    killProcessTree(root);
    await rm(tempDir, { recursive: true, force: true });
  }
});
