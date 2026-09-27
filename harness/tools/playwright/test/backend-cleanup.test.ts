import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { PlaywrightBackend } from '../backend.mjs';

function errorCode(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

test('shutdown escalation shares one close and accepts late graceful evidence only with observed exit', async () => {
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
    spawnSync: () => { taskkillCalls += 1; return { status: 1, signal: null }; },
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
    resolveServerClose();
    processHandle.signalCode = 'SIGKILL';
    processHandle.emit('exit', null, 'SIGKILL');
    processHandle.emit('close', null, 'SIGKILL');

    await Promise.all([shutdown, concurrentForce]);
    assert.equal(browserCloseCalls, 1);
    assert.equal(serverCloseCalls, 1, 'concurrent shutdown paths must not close the same browser server twice');
    assert.equal(taskkillCalls, 1, 'tree kill is attempted once before the owned root exits');
    assert.equal(killCalls, 1);
    assert.equal(processHandle.signalCode, 'SIGKILL', 'root exit was observed');
    assert.equal(backend.sessions.has(session.id), false);
    assert.equal(backend.closingSessions.has(session), false);

    await backend.forceKillAll();
    await backend.closeSession(session);
    assert.equal(serverCloseCalls, 1, 'completed teardown is idempotent');
    assert.equal(taskkillCalls, 1, 'a completed or exited PID is never retried');
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
    spawnSync: () => ({ status: 0, signal: null }),
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
    spawnSync: () => { taskkillCalls += 1; return { status: 0, signal: null }; },
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
