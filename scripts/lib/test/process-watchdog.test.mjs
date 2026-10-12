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

test('closed Windows root never authorizes visible old or unproven descendants', async () => {
  for (const identity of ['20261009134013.000000+780', '20261009180000.000000+780']) {
    const child = new ChildProcess();
    child.pid = 3268;
    child.exitCode = 0;
    const calls = [];
    const result = await killProcessTree(child, {
      platform: 'win32', gracefulMs: 1, forceMs: 1,
      spawnSyncImpl: (command, args) => {
        if (command === 'taskkill') calls.push(args);
        return { status: 0, stdout: `27736|3268|${identity}\n` };
      },
      killImpl: (pid) => { if (pid === 3268) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.gone, false);
  }
});

test('killProcessTree gives Windows a grace window then uses individually identity-checked taskkill /F', async () => {
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
  assert.deepEqual(taskkill.args, ['/F', '/PID', '4321']);
  assert.deepEqual(child.killCalls, []);
  assert.equal(result.gone, true);
  assert.deepEqual(result.ownedPids, [4321]);
  assert.deepEqual(result.ownedProcesses, [{ pid: 4321, ppid: 1, identity: 'identity', creationDate: 'identity' }]);
  assert.deepEqual(result.survivorProcesses, []);
});

test('Windows ownership query projects only ancestry and preserves precise provider creation identities', () => {
  const identity = '20261007002935.227617+780';
  let call;
  const rows = snapshotProcessTree(4321, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      call = { command, args, options };
      return { status: 0, stdout: `4321|1|${identity}\n` };
    },
  });
  assert.equal(call.command, 'powershell.exe');
  const script = call.args.at(-1);
  assert.ok(script.includes('[wmisearcher]'));
  assert.ok(script.includes('SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process'));
  assert.ok(!script.includes('Get-CimInstance'));
  assert.equal(call.options.timeout, 5_000);
  assert.equal(rows[0].identity, identity);
});

integrationTest('real Windows census returns a stable precise identity for this owned test process', { skip: process.platform !== 'win32' }, () => {
  const first = snapshotProcessTree(process.pid)[0];
  const second = snapshotProcessTree(process.pid)[0];
  assert.match(first.identity, /^\d{14}\.\d{6}[+-]\d{3}$/u);
  assert.equal(second.identity, first.identity);
});

test('killProcessTree confirms absent Windows identities despite a later live PID probe', async () => {
  let queries = 0;
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 1,
    spawnSyncImpl: (command) => {
      if (command === 'taskkill') return { status: 0 };
      queries += 1;
      return { status: 0, stdout: queries < 4 ? '4321|1|20261009170000.000000+780\n7654|4321|20261009170001.000000+780\n' : '' };
    },
    // Model PID reuse after the final census: the later probe sees a new
    // process, but absence already proves the captured identity gone.
    killImpl: () => {},
  });
  assert.equal(result.gone, true);
  assert.deepEqual(result.survivors, []);
});

test('killProcessTree keeps an uncaptured Windows identity unknown despite an absent final row', async () => {
  let queries = 0;
  const result = await killProcessTree(fakeChild(4321), {
    platform: 'win32', gracefulMs: 1, forceMs: 1,
    spawnSyncImpl: () => ({ status: 0, stdout: ++queries === 1 ? '4321|1|\n' : '' }),
    killImpl: () => {},
  });
  assert.equal(result.gone, false);
  assert.deepEqual(result.survivors, [4321]);
  assert.ok(result.diagnostics.some((message) => message.includes('captured creation identity is unknown')));
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
  assert.deepEqual(result.ownedProcesses, []);
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
      return { status: 0, stdout: query <= 2 ? '4321|1|captured-root\n' : '4321|1|\n' };
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
      if (query <= 2) return { status: 0, stdout: '4321|1|old-root\n' };
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
      assert.deepEqual(result.ownedPids, []);
      assert.deepEqual(result.ownedProcesses, []);
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
      if (query <= 2) return { status: 0, stdout: '4321|1|20261009170000.000000+780\n7654|4321|20261009170001.000000+780\n' };
      return { status: 0, stdout: '4321|1|new-root\n7654|1|20261009170001.000000+780\n' };
    },
    killImpl: (pid, signal) => {
      if (signal === 0 && pid === 7654 && !childAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(calls, [['/F', '/PID', '7654']]);
  assert.equal(result.gone, true);
  assert.deepEqual(result.survivors, []);
});

test('Windows watchdog retains live-captured leaks, skips reuse, and fails closed on census failure', async (t) => {
  for (const scenario of ['leak', 'reuse', 'failed-census', 'unseen-newer', 'older-ghost']) {
    await t.test(scenario, async () => {
      const root = '20261009170000.000000+780';
      const captured = '20261009170001.000000+780';
      const child = new ChildProcess();
      child.pid = 4321;
      let closed = false;
      let descendantAlive = true;
      const calls = [];
      const watchdog = watchChildProcess(child, {
        timeoutMs: 0, platform: 'win32', gracefulMs: 1, forceMs: 1,
        spawnSyncImpl: (command, args) => {
          if (command === 'taskkill') {
            calls.push(args);
            descendantAlive = false;
            return { status: 0 };
          }
          if (!closed) return { status: 0, stdout: `4321|1|${root}\n${scenario === 'unseen-newer' || scenario === 'older-ghost' ? '' : `7654|4321|${captured}\n`}` };
          if (scenario === 'failed-census') return { status: null, error: new Error('census timeout') };
          const identity = scenario === 'reuse' ? '20261009170002.000000+780'
            : scenario === 'older-ghost' ? '20261009160000.000000+780' : captured;
          return { status: 0, stdout: `7654|4321|${identity}\n` };
        },
        killImpl: (pid) => {
          if ((pid === 4321 && closed) || (pid === 7654 && !descendantAlive)) {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          }
        },
      });
      child.exitCode = 0;
      closed = true;
      const result = await watchdog.settle();
      assert.deepEqual(calls, scenario === 'leak' ? [['/F', '/PID', '7654']] : []);
      assert.equal(result.gone, scenario !== 'failed-census' && scenario !== 'unseen-newer');
      assert.equal(result.ownedPids.includes(7654), !['unseen-newer', 'older-ghost'].includes(scenario));
    });
  }
});

test('Windows live capture rejects impossible older children and root closure or reuse during capture', async (t) => {
  for (const scenario of ['older-child', 'root-closed', 'root-reused', 'latest-root-absent', 'changed-ancestry']) {
    await t.test(scenario, async () => {
      const child = new ChildProcess();
      child.pid = 4321;
      const root = '20261009170000.000000+780';
      const calls = [];
      let query = 0;
      const result = await killProcessTree(child, {
        platform: 'win32', gracefulMs: 1, forceMs: 1,
        spawnSyncImpl: (command, args) => {
          if (command === 'taskkill') { calls.push(args); return { status: 0 }; }
          query += 1;
          if (query === 2 && scenario === 'root-closed') child.exitCode = 0;
          if (query >= 2 && scenario === 'latest-root-absent') return { status: 0, stdout: '' };
          const identity = query >= 2 && scenario === 'root-reused' ? '20261009170002.000000+780' : root;
          const descendant = scenario === 'older-child' ? '20261009160000.000000+780' : '20261009170001.000000+780';
          return { status: 0, stdout: `4321|1|${identity}\n7654|${scenario === 'changed-ancestry' ? 99 : 4321}|${descendant}\n` };
        },
        killImpl: () => {},
      });
      assert.deepEqual(calls, ['older-child', 'changed-ancestry'].includes(scenario) ? [['/F', '/PID', '4321']] : []);
      assert.equal(result.ownedPids.includes(7654), false);
      if (!['older-child', 'changed-ancestry'].includes(scenario)) assert.equal(result.gone, false);
    });
  }
});

test('Windows watchdog ownership readiness requires a consistent live identity capture', async (t) => {
  for (const scenario of ['ready', 'root-closed', 'root-reused', 'root-absent', 'census-failed']) {
    await t.test(scenario, async () => {
      const child = new ChildProcess();
      child.pid = 4321;
      let query = 0;
      const watchdog = watchChildProcess(child, {
        timeoutMs: 0, platform: 'win32', gracefulMs: 1, forceMs: 1,
        spawnSyncImpl: () => {
          query += 1;
          if (scenario === 'census-failed') return { status: 1, stdout: '' };
          if (query === 2 && scenario === 'root-closed') child.exitCode = 0;
          if (query === 2 && scenario === 'root-absent') return { status: 0, stdout: '' };
          const identity = query === 2 && scenario === 'root-reused'
            ? '20261009170002.000000+780' : '20261009170000.000000+780';
          return { status: 0, stdout: `4321|1|${identity}\n` };
        },
      });
      assert.equal(watchdog.ownershipReady, scenario === 'ready');
      watchdog.cleanup();
    });
  }
});

test('Windows live capture brackets ancestry in one shell without trusting an early root row', async (t) => {
  for (const scenario of ['ready', 'absent', 'reused', 'closed', 'failed']) {
    await t.test(scenario, () => {
      const child = new ChildProcess();
      child.pid = 4321;
      const root = '20261009170000.000000+780';
      let queries = 0;
      const watchdog = watchChildProcess(child, {
        timeoutMs: 0, platform: 'win32',
        spawnSyncImpl: (command, args, options) => {
          queries += 1;
          assert.equal(command, 'powershell.exe');
          assert.equal(options.timeout, 5_000);
          const script = args.at(-1);
          assert.ok(script.indexOf('PIE_ROOT_CHECK') > script.indexOf('$q.Get()'));
          assert.ok(script.indexOf(' WHERE ProcessId=4321') > script.indexOf('PIE_ROOT_CHECK'));
          if (scenario === 'closed') child.exitCode = 0;
          if (scenario === 'failed') return { status: 1, stdout: '' };
          const checked = scenario === 'absent' ? '' : `4321|1|${scenario === 'reused' ? '20261009170002.000000+780' : root}\n`;
          return { status: 0, stdout: `4321|1|${root}\n7654|4321|20261009170001.000000+780\nPIE_ROOT_CHECK\n${checked}` };
        },
      });
      assert.equal(queries, 1, 'no second PowerShell startup exposes short-lived roots to a capture race');
      assert.equal(watchdog.ownershipReady, scenario === 'ready');
      watchdog.cleanup();
    });
  }
});

integrationTest('real Windows short-lived child is captured before its natural exit', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const watchdog = watchChildProcess(child, { timeoutMs: 5_000 });
  try {
    assert.equal(watchdog.ownershipReady, true);
    await closed;
    const result = await watchdog.settle();
    assert.equal(result.gone, true, result.diagnostics.join('; '));
    assert.ok(result.ownedPids.includes(child.pid));
  } finally {
    await watchdog.settle();
  }
});

test('Windows watchdog cannot recover failed live ownership capture from an empty post-close census', async () => {
  const child = new ChildProcess();
  child.pid = 4321;
  let closed = false;
  const calls = [];
  const watchdog = watchChildProcess(child, {
    timeoutMs: 0, platform: 'win32', gracefulMs: 1, forceMs: 1,
    spawnSyncImpl: (command) => {
      calls.push(command);
      return closed ? { status: 0, stdout: '' } : { status: null, error: new Error('census timeout') };
    },
    killImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
  child.exitCode = 0;
  closed = true;
  const result = await watchdog.settle();
  assert.equal(result.gone, false);
  assert.ok(result.diagnostics.some((message) => message.includes('failed live capture')));
  assert.ok(!calls.includes('taskkill'));
});

test('Windows watchdog retains an observed unproven descendant after root exit and reparenting', async () => {
  const child = new ChildProcess();
  child.pid = 4321;
  let closed = false;
  let census = 0;
  const calls = [];
  const watchdog = watchChildProcess(child, {
    timeoutMs: 0, platform: 'win32', gracefulMs: 1, forceMs: 1,
    spawnSyncImpl: (command, args) => {
      if (command === 'taskkill') { calls.push(args); return { status: 0 }; }
      census += 1;
      if (census === 1) return { status: 0, stdout: '4321|1|\n7654|4321|descendant-identity\n' };
      return { status: 0, stdout: '7654|1|descendant-identity\n' };
    },
    killImpl: (pid) => {
      if (pid === 4321 && closed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  child.exitCode = 0;
  closed = true;
  const result = await watchdog.settle();
  assert.deepEqual(calls, [], 'unknown descendants are never targeted');
  assert.equal(result.gone, false, 'the observed descendant cannot be certified extinct after escaping the root');
  assert.ok(result.survivors.includes(7654));
  assert.ok(result.survivorProcesses.some((entry) => entry.pid === 7654 && entry.identity === 'descendant-identity'));
});

test('Windows later consistent capture does not clear prior unproven ownership uncertainty', async () => {
  const child = new ChildProcess();
  child.pid = 4321;
  let closed = false;
  let census = 0;
  const calls = [];
  const root = '20261009170000.000000+780';
  const descendant = '20261009170001.000000+780';
  const watchdog = watchChildProcess(child, {
    timeoutMs: 0, platform: 'win32', gracefulMs: 1, forceMs: 1,
    spawnSyncImpl: (command, args) => {
      if (command === 'taskkill') { calls.push(args); return { status: 0 }; }
      census += 1;
      if (census === 1) return { status: 0, stdout: `4321|1|\n7654|4321|${descendant}\n` };
      if (census <= 3) return { status: 0, stdout: `4321|1|${root}\n` };
      return { status: 0, stdout: `7654|1|${descendant}\n` };
    },
    killImpl: (pid) => {
      if (pid === 4321) {
        closed = true;
        child.exitCode = 0;
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
    },
  });
  const result = await watchdog.settle();
  assert.ok(calls.every((args) => args.at(-1) !== '7654'), 'the unproven descendant is never targeted');
  assert.equal(closed, true);
  assert.equal(result.gone, false, 'a consistent root capture cannot erase uncertainty about the escaped descendant');
  assert.ok(result.survivors.includes(7654));
});

test('Windows cleanup reports unseen descendants in pre-force and final censuses without targeting them', async (t) => {
  for (const stage of ['pre-force', 'final']) {
    await t.test(stage, async () => {
      let queries = 0;
      let rootAlive = stage === 'pre-force';
      const calls = [];
      const result = await killProcessTree(fakeChild(4321), {
        platform: 'win32', gracefulMs: 1, forceMs: 1,
        spawnSyncImpl: (command, args) => {
          if (command === 'taskkill') { calls.push(args); rootAlive = false; return { status: 0 }; }
          queries += 1;
          const root = queries <= 2 || rootAlive ? '4321|1|20261009170000.000000+780\n' : '';
          return { status: 0, stdout: root + (queries >= 3 ? '7654|4321|20261009170001.000000+780\n' : '') };
        },
        killImpl: (pid) => { if (pid === 4321 && !rootAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
      });
      assert.deepEqual(calls, stage === 'pre-force' ? [['/F', '/PID', '4321']] : []);
      assert.equal(result.gone, false);
      assert.deepEqual(result.ownedPids, [4321]);
      assert.ok(result.survivors.includes(7654));
    });
  }
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
    const cleanup = await watchdog.settle();
    assert.equal(cleanup.gone, true, cleanup.diagnostics.join('; '));
    assert.ok(cleanup.ownedPids.includes(grandchildPid));
    assert.ok(cleanup.ownedProcesses.every((entry) => entry.identity != null));
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
    await killProcessTree(root);
    await rm(tempDir, { recursive: true, force: true });
  }
});
