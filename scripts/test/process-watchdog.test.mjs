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

test('killProcessTree uses taskkill /T /F on Windows and then kills the root defensively', () => {
  const child = fakeChild(4321);
  const calls = [];
  killProcessTree(child, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => calls.push({ command, args, options }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'taskkill');
  assert.deepEqual(calls[0].args, ['/T', '/F', '/PID', '4321']);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.deepEqual(child.killCalls, ['SIGKILL']);
});

test('killProcessTree sends SIGKILL to the Unix process group', () => {
  const child = fakeChild(2468);
  const calls = [];
  killProcessTree(child, {
    platform: 'linux',
    killImpl: (pid, signal) => calls.push({ pid, signal }),
  });
  assert.deepEqual(calls, [{ pid: -2468, signal: 'SIGKILL' }]);
  assert.deepEqual(child.killCalls, ['SIGKILL']);
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
  // Subscribe immediately: under full-suite load the 500 ms watchdog can fire
  // before the pid-file polling below completes, and EventEmitter does not
  // replay an already-emitted close event to a late listener.
  const rootClosed = new Promise((resolve) => root.once('close', resolve));
  const watchdog = watchChildProcess(root, { timeoutMs: 500, label: 'integration tree' });

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
    watchdog.cleanup();
    killProcessTree(root);
    await rm(tempDir, { recursive: true, force: true });
  }
});
