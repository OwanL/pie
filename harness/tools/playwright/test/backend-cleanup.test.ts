import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { PlaywrightBackend } from '../backend.mjs';
import { confirmTaskkillTree } from '../sidecar-core.mjs';

function errorCode(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

function taskkillResult(code: number, pid?: number): EventEmitter & { kill(): boolean; stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { kill(): boolean; stdout: EventEmitter; stderr: EventEmitter };
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (code === 0 && pid) child.stdout.emit('data', Buffer.from(`taskkill completed for PID ${pid}.\r\n`));
    child.emit('close', code, null);
  });
  return child;
}

test('taskkill confirms a fully reported mixed success/already-gone tree and rejects unsafe diagnostics', () => {
  const mixed = confirmTaskkillTree({
    rootPid: 24996,
    exitCode: 255,
    stdout: 'SUCCESS: The process with PID 27280 (child process of PID 24996) has been terminated.\r\nSUCCESS: The process with PID 24996 (child process of PID 4728) has been terminated.\r\n',
    stderr: 'ERROR: The process with PID 26176 (child process of PID 24996) could not be terminated.\r\nReason: There is no running instance of the task.\r\n',
    probePid: () => ({ status: 'absent' }),
  });
  assert.equal(mixed.confirmed, true, 'captured taskkill diagnostics are accepted only after all reported PIDs are checked');

  const mixed128 = confirmTaskkillTree({
    rootPid: 43572,
    exitCode: 128,
    stdout: 'SUCCESS: The process with PID 39212 (child process of PID 43572) has been terminated.\r\nSUCCESS: The process with PID 43572 (child process of PID 4728) has been terminated.\r\n',
    stderr: [22472, 13068, 7780].map((pid) => `ERROR: The process with PID ${pid} (child process of PID 43572) could not be terminated.\r\nReason: There is no running instance of the task.`).join('\r\n'),
    probePid: () => ({ status: 'absent' }),
  });
  assert.equal(mixed128.confirmed, true, 'exit 128 is accepted only for a fully reported and independently verified tree');

  for (const reason of ['Access is denied.', 'The operation attempted is not supported.', 'Unexpected taskkill reason.']) {
    const rejected = confirmTaskkillTree({
      rootPid: 62001,
      exitCode: 255,
      stdout: 'SUCCESS: The process with PID 62001 has been terminated.\r\n',
      stderr: `ERROR: The process with PID 62002 (child process of PID 62001) could not be terminated.\r\nReason: ${reason}\r\n`,
      probePid: () => ({ status: 'absent' }),
    });
    assert.equal(rejected.confirmed, false, `${reason} is not a harmless missing-process report`);
    assert.match(rejected.reason, /unrecognized diagnostic/i);
  }

  const localized = confirmTaskkillTree({
    rootPid: 62006,
    exitCode: 128,
    stdout: 'SUCCESS: The process with PID 62006 has been terminated.\r\n',
    stderr: 'ERFOLG: Der Prozess wurde beendet.\r\n',
    probePid: () => ({ status: 'absent' }),
  });
  assert.equal(localized.confirmed, false, 'localized and otherwise unknown output fails closed');

  const localizedSuccess = confirmTaskkillTree({
    rootPid: 62007,
    exitCode: 0,
    stdout: 'ERFOLG: Der Prozess wurde beendet.\r\n',
    probePid: () => { throw new Error('exit 0 must not require output parsing or PID probes'); },
  });
  assert.equal(localizedSuccess.confirmed, true, 'the exit-0 success contract is independent of localized output');

  const liveChild = confirmTaskkillTree({
    rootPid: 62003,
    exitCode: 255,
    stdout: `SUCCESS: The process with PID 62003 has been terminated.\r\nSUCCESS: The process with PID ${process.pid} has been terminated.\r\n`,
    probePid: (pid: number) => ({ status: pid === process.pid ? 'live' : 'absent' }),
  });
  assert.equal(liveChild.confirmed, false);
  assert.match(liveChild.reason, new RegExp(`PID ${process.pid} is still live`));

  const rootNotFound = confirmTaskkillTree({
    rootPid: 62004,
    exitCode: 128,
    stderr: 'ERROR: The process "62004" not found.\r\n',
    probePid: () => { throw new Error('NOT_FOUND must be rejected before PID probing'); },
  });
  assert.equal(rootNotFound.confirmed, false);
  assert.match(rootNotFound.reason, /unrecognized diagnostic/i);

  const missingRoot = confirmTaskkillTree({
    rootPid: 62004,
    exitCode: 128,
    stdout: 'SUCCESS: The process with PID 62005 has been terminated.\r\n',
    probePid: () => ({ status: 'absent' }),
  });
  assert.equal(missingRoot.confirmed, false);
  assert.match(missingRoot.reason, /did not report requested root PID 62004/);
});

test('late browser-server close cannot override unconfirmed taskkill cleanup after root exit', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let browserCloseCalls = 0;
  let serverCloseCalls = 0;
  let taskkillCalls = 0;
  let killCalls = 0;
  let resolveServerClose!: () => void;
  let resolveKillStarted!: () => void;
  const serverClose = new Promise<void>((resolve) => { resolveServerClose = resolve; });
  const killStarted = new Promise<void>((resolve) => { resolveKillStarted = resolve; });
  const backend = new PlaywrightBackend({
    closeGraceMs: 10,
    spawn: () => { taskkillCalls += 1; return taskkillResult(1); },
  });
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: string): boolean;
  };
  processHandle.pid = 7125;
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.kill = () => { killCalls += 1; resolveKillStarted(); return true; };
  const session = backend.makeSession('late-graceful-close', { artifactDir: tmpdir() });
  session.browser = { close: async () => { browserCloseCalls += 1; } };
  session.browserServer = {
    close: () => { serverCloseCalls += 1; return serverClose; },
    process: () => processHandle,
  };
  backend.sessions.set(session.id, session);
  try {
    // This begins the real backend shutdown path. The unresolved server close
    // crosses its injected grace deadline and causes the coordinated escalation.
    const shutdown = backend.shutdown();
    await killStarted;
    const concurrentForce = backend.forceKillAll();
    processHandle.signalCode = 'SIGKILL';
    processHandle.emit('exit', null, 'SIGKILL');
    processHandle.emit('close', null, 'SIGKILL');
    resolveServerClose();

    await assert.rejects(
      () => Promise.all([shutdown, concurrentForce]),
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED') && /did not confirm the complete process tree/i.test((error as Error).message),
    );
    assert.equal(browserCloseCalls, 1);
    assert.equal(serverCloseCalls, 1, 'concurrent shutdown paths must not close the same browser server twice');
    assert.equal(taskkillCalls, 1, 'tree kill is attempted once before the owned root exits');
    assert.equal(killCalls, 1);
    assert.equal(processHandle.signalCode, 'SIGKILL', 'root exit was observed');
    assert.equal(backend.sessions.has(session.id), false);
    assert.equal(backend.closingSessions.has(session), true, 'late graceful resolution cannot release unresolved ownership');
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(serverCloseCalls, 1, 'the in-flight graceful close resolves after the fallback root exit');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('Windows browser-tree taskkill is asynchronous and leaves the sidecar event loop responsive', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let asyncTaskkillCalls = 0;
  let syncTaskkillCalls = 0;
  let finishTaskkill!: () => void;
  const backend = new PlaywrightBackend({
    closeGraceMs: 500,
    spawnSync: () => { syncTaskkillCalls += 1; return { status: 0, signal: null }; },
    spawn: () => {
      asyncTaskkillCalls += 1;
      const child = new EventEmitter() as EventEmitter & { kill(): boolean; stdout: EventEmitter };
      child.kill = () => true;
      child.stdout = new EventEmitter();
      finishTaskkill = () => {
        child.stdout.emit('data', Buffer.from('SUCCESS: The process with PID 7127 (child process of PID 4728) has been terminated.'));
        child.emit('close', 0, null);
      };
      return child;
    },
  });
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: string): boolean;
  };
  processHandle.pid = 7127;
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.kill = () => {
    queueMicrotask(() => {
      processHandle.signalCode = 'SIGKILL';
      processHandle.emit('exit', null, 'SIGKILL');
      processHandle.emit('close', null, 'SIGKILL');
    });
    return true;
  };
  const session = backend.makeSession('async-tree-kill', { artifactDir: tmpdir() });
  session.browser = { close: async () => { throw new Error('injected browser close failure'); } };
  session.browserServer = {
    close: async () => { throw new Error('injected browser server close failure'); },
    process: () => processHandle,
  };
  backend.sessions.set(session.id, session);
  try {
    const closing = backend.closeSession(session);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncTaskkillCalls, 1, 'browser tree termination uses non-blocking spawn');
    assert.equal(syncTaskkillCalls, 0, 'the sidecar event loop is never blocked by spawnSync');
    assert.equal(backend.closingSessions.has(session), true, 'ownership remains held while tree termination is pending');

    finishTaskkill();
    await closing;
    assert.equal(backend.closingSessions.has(session), false, 'ownership releases only after tree and root exit confirmation');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('late graceful-close resolution after taskkill failure does not prove descendant cleanup', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let resolveServerClose!: () => void;
  let taskkillCalls = 0;
  const serverClose = new Promise<void>((resolve) => { resolveServerClose = resolve; });
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: string): boolean;
  };
  processHandle.pid = 7128;
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.kill = () => true;
  const backend = new PlaywrightBackend({
    closeGraceMs: 10,
    spawn: () => {
      taskkillCalls += 1;
      const taskkill = new EventEmitter() as EventEmitter & { kill(): boolean; stderr: EventEmitter };
      taskkill.kill = () => true;
      taskkill.stderr = new EventEmitter();
      queueMicrotask(() => {
        processHandle.signalCode = 'SIGTERM';
        processHandle.emit('exit', null, 'SIGTERM');
        processHandle.emit('close', null, 'SIGTERM');
        taskkill.stderr.emit('data', Buffer.from('ERROR: The process with PID 7128 (child process of PID 4728) could not be terminated.\r\nReason: Access is denied.\r\n'));
        taskkill.emit('close', 128, null);
        setTimeout(resolveServerClose, 5);
      });
      return taskkill;
    },
  });
  const session = backend.makeSession('taskkill-process-not-found-race', { artifactDir: tmpdir() });
  session.browser = { close: async () => {} };
  session.browserServer = {
    close: () => serverClose,
    process: () => processHandle,
  };
  backend.sessions.set(session.id, session);
  try {
    await assert.rejects(
      () => backend.closeSession(session),
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED') && /Access is denied/i.test((error as Error).message),
    );
    assert.equal(taskkillCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(backend.closingSessions.has(session), true, 'late graceful confirmation cannot release unresolved ownership');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('late graceful close without observed process exit keeps cleanup unresolved and ownership retained', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let resolveServerClose!: () => void;
  let resolveKillStarted!: () => void;
  const serverClose = new Promise<void>((resolve) => { resolveServerClose = resolve; });
  const killStarted = new Promise<void>((resolve) => { resolveKillStarted = resolve; });
  const backend = new PlaywrightBackend({
    closeGraceMs: 10,
    spawn: (_command: string, args: string[]) => taskkillResult(0, Number(args[1])),
  });
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: string): boolean;
  };
  processHandle.pid = 7126;
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.kill = () => { resolveKillStarted(); return true; };
  const session = backend.makeSession('late-close-with-live-root', { artifactDir: tmpdir() });
  session.browser = { close: async () => {} };
  session.browserServer = {
    close: () => serverClose,
    process: () => processHandle,
  };
  backend.sessions.set(session.id, session);
  try {
    const closing = backend.closeSession(session);
    await killStarted;
    resolveServerClose();

    await assert.rejects(
      () => closing,
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED'),
    );
    assert.equal(processHandle.exitCode, null);
    assert.equal(processHandle.signalCode, null, 'the owned root process never exited');
    assert.equal(backend.sessions.has(session.id), false);
    assert.equal(backend.closingSessions.has(session), true, 'unresolved cleanup retains session ownership');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('retained closing ownership blocks reuse and a successful close retry releases it', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let processAvailable = false;
  let taskkillCalls = 0;
  const backend = new PlaywrightBackend({
    closeGraceMs: 5,
    spawn: (_command: string, args: string[]) => { taskkillCalls += 1; return taskkillResult(0, Number(args[1])); },
  });
  const processHandle = new EventEmitter() as EventEmitter & {
    pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: string): boolean;
  };
  processHandle.pid = 7124;
  processHandle.exitCode = null;
  processHandle.signalCode = null;
  processHandle.kill = () => {
    queueMicrotask(() => {
      processHandle.signalCode = 'SIGKILL';
      processHandle.emit('exit', null, 'SIGKILL');
      processHandle.emit('close', null, 'SIGKILL');
    });
    return true;
  };
  const session = backend.makeSession('cleanup-retry', { artifactDir: tmpdir() });
  session.browserServer = {
    close: async () => {},
    process: () => {
      if (!processAvailable) throw new Error('injected temporary process-handle failure');
      return processHandle;
    },
  };
  backend.sessions.set(session.id, session);
  try {
    await assert.rejects(
      () => backend.handle('close', { scope: 'session', sessionId: session.id }),
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED'),
    );
    assert.equal(backend.closingSessions.has(session), true);
    await assert.rejects(
      () => backend.handle('close', { scope: 'session', sessionId: session.id }),
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED'),
    );
    await assert.rejects(
      () => backend.handle('close', { scope: 'runtime' }),
      (error: unknown) => errorCode(error, 'RUNTIME_CLEANUP_UNRESOLVED'),
    );

    backend.assertBrowserInstalled = () => { throw new Error('duplicate ownership check must run before browser setup'); };
    await assert.rejects(
      () => backend.handle('open', { sessionId: session.id, artifactDir: tmpdir() }),
      (error: unknown) => errorCode(error, 'INVALID_ARGUMENTS'),
    );

    processAvailable = true;
    const retried = await backend.handle('close', { scope: 'session', sessionId: session.id });
    assert.deepEqual(retried.closed.sessionIds, [session.id]);
    assert.equal(backend.closingSessions.has(session), false, 'successful retry releases retained ownership');
    assert.equal(backend.sessions.has(session.id), false);
    assert.equal(taskkillCalls, 1);

    const newerSession = backend.makeSession(session.id, { artifactDir: tmpdir() });
    backend.sessions.set(newerSession.id, newerSession);
    backend.finishClosedSession(session);
    assert.equal(backend.sessions.get(session.id), newerSession, 'finishing stale cleanup cannot delete a newer owner');
    backend.sessions.delete(newerSession.id);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
