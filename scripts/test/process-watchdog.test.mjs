import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  watchChildProcess,
  withProcessTreeIsolation,
} from '../lib/process-watchdog.mjs';

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
  assert.deepEqual(child.killCalls, ['SIGKILL']);
  assert.equal(result.gone, true);
  assert.deepEqual(result.ownedPids, [4321]);
});

test('killProcessTree retains Windows tree termination when process enumeration fails', async () => {
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
  assert.deepEqual(calls, [['/T', '/F', '/PID', '4321']]);
  assert.equal(result.gone, true);
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

test('abort kills a real uniquely-owned child and grandchild but preserves an unrelated sentinel', { timeout: 20_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-process-abort-'));
  const pidFile = path.join(tempDir, 'grandchild.pid');
  const rootCode = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const root = spawn(process.execPath, ['-e', rootCode], withProcessTreeIsolation({ stdio: 'ignore', windowsHide: true }));
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], withProcessTreeIsolation({ stdio: 'ignore', windowsHide: true }));
  const controller = new AbortController();
  const rootClosed = new Promise((resolve) => root.once('close', resolve));
  let watchdog;
  try {
    let grandchildPid;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { grandchildPid = Number(await readFile(pidFile, 'utf8')); if (grandchildPid > 0) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
  assert.deepEqual(cleanup, { gone: true, survivors: [], ownedPids: [] });
});

test('Windows watchdog kills a real grandchild process tree', { skip: process.platform !== 'win32' }, async () => {
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
    let grandchildPid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        grandchildPid = Number(await readFile(pidFile, 'utf8'));
        if (grandchildPid > 0) break;
      } catch {
        // Root has not written the pid yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(grandchildPid > 0, 'root process must publish its grandchild pid');
    watchdog = watchChildProcess(root, { timeoutMs: 500, label: 'integration tree' });

    let closeTimer;
    try {
      await Promise.race([
        rootClosed,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('root tree did not close')), 5000);
        }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
    watchdog.cleanup();
    assert.equal(watchdog.timedOut, true);

    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
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
