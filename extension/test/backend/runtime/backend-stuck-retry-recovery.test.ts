import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ExtensionUIBridge } from '../../../src/backend/extension-ui-bridge';
import { BackendError } from '../../../src/backend/server-io';
import type { SessionContext } from '../../../src/backend/server-types';

test('stuck recovery terminalizes once and replaces a runtime without awaiting abort', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const calls: string[] = [];
  const events: Array<{ event: string; payload: any }> = [];
  let abortCalls = 0;
  const uiRequests: unknown[] = [];
  const uiBridge = new ExtensionUIBridge('/s', (_event, payload) => uiRequests.push(payload));
  const context = {
    sessionPath: '/s',
    busySeq: 0,
    unsubscribe: () => calls.push('unsubscribe'),
    activeRequest: {
      id: 'request-1',
      messageIndex: 1,
      currentMessageId: 'assistant-1',
      aborted: false,
    },
    session: {
      isStreaming: true,
      clearQueue: () => calls.push('clearQueue'),
      abortRetry: () => calls.push('abortRetry'),
      abortCompaction: () => calls.push('abortCompaction'),
      abortBranchSummary: () => calls.push('abortBranchSummary'),
      abortBash: () => calls.push('abortBash'),
      abort: () => {
        abortCalls += 1;
        return new Promise<void>(() => undefined);
      },
    },
    uiBridge,
  } as unknown as SessionContext;
  const replacement = {
    sessionPath: '/s',
    busySeq: 0,
    unsubscribe: () => undefined,
    session: { isStreaming: false },
  } as unknown as SessionContext;
  const manager = { kind: 'manager' };

  server.sdk = {
    SessionManager: {
      open: (sessionPath: string) => {
        assert.equal(sessionPath, '/s');
        calls.push('open');
        return manager;
      },
    },
  };
  server.createSessionContext = async (receivedManager: unknown, reason: string) => {
    assert.equal(receivedManager, manager);
    assert.equal(reason, 'resume');
    calls.push('createSessionContext');
    server.sessionContexts.set('/s', replacement);
    return replacement;
  };
  server.sessionContexts.set('/s', context);
  server.emit = (event: string, payload: unknown) => events.push({ event, payload });
  server.emitBusyChanged = (_context: SessionContext, busy: boolean) => events.push({ event: 'busy.changed', payload: busy });
  server.emitSessionOpened = async () => {};
  server.emitSessionListChanged = async () => {};

  server.recoverStuckSession(context, 'stalled');

  assert.equal(context.retired, true);
  assert.equal(context.activeRequest, undefined);
  assert.equal(events.filter((event) => event.event === 'message.aborted').length, 1);
  assert.equal(events.some((event) => event.event === 'busy.changed'), false);
  assert.equal(await uiBridge.confirm('late', 'runtime request'), false);
  uiBridge.notify('late runtime notice');
  assert.deepEqual(uiRequests, [], 'semantic retirement must fence late extension UI requests');

  // A late terminal event from the retired SDK session is fenced and cannot
  // produce a second terminal or advertise the zombie runtime as idle.
  server.handleSessionEvent(context, { type: 'agent_end' });
  server.recoverStuckSession(context, 'stalled again');
  assert.equal(events.filter((event) => event.event === 'message.aborted').length, 1);

  await context.recoveryPromise;

  assert.equal(abortCalls, 1);
  assert.equal(server.sessionContexts.get('/s'), replacement);
  assert.deepEqual(events.filter((event) => event.event === 'busy.changed').map((event) => event.payload), [false]);
  assert.deepEqual(calls.slice(0, 5), [
    'clearQueue',
    'abortRetry',
    'abortCompaction',
    'abortBranchSummary',
    'abortBash',
  ]);
  assert.equal(calls.includes('open'), true);
  assert.equal(calls.includes('createSessionContext'), true);
});

test('ensureSessionContext waits for the authoritative recovery runtime', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  let resolveRecovery: ((context: SessionContext) => void) | undefined;
  const old = {
    sessionPath: '/s',
    retired: true,
    recoveryPromise: new Promise<SessionContext>((resolve) => { resolveRecovery = resolve; }),
  } as unknown as SessionContext;
  const replacement = { sessionPath: '/s', retired: false } as unknown as SessionContext;
  server.sessionContexts.set('/s', old);

  let settled = false;
  const ensured = server.ensureSessionContext('/s').then((context: SessionContext) => {
    settled = true;
    return context;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  resolveRecovery?.(replacement);
  assert.equal(await ensured, replacement);
});

test('ensureSessionContext preserves the recovery-specific error when replacement fails', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const old = {
    sessionPath: '/s',
    retired: true,
    recoveryPromise: Promise.reject(new Error('replacement failed')),
  } as unknown as SessionContext;
  server.sessionContexts.set('/s', old);

  await assert.rejects(
    server.ensureSessionContext('/s'),
    (error: unknown) => error instanceof BackendError
      && error.code === 'SESSION_RUNTIME_RECOVERY_FAILED'
      && /replacement failed/.test(error.message),
  );
});

test('createSessionContext preserves an unexpired terminal checkpoint across replacement', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const terminalLiveTurn = { accumulator: { kind: 'terminal' }, expiresAt: Date.now() + 10_000 };
  const old = {
    sessionPath: '/s',
    busySeq: 7,
    terminalLiveTurn,
    willRetryWatchdogClear: () => { throw new Error('watchdog cleanup failed'); },
    uiBridge: { dispose: () => { throw new Error('UI cleanup failed'); } },
    unsubscribe: () => { throw new Error('unsubscribe failed'); },
    runtime: { dispose: () => { throw new Error('runtime disposal failed'); } },
  } as unknown as SessionContext;
  const replacement = {
    sessionPath: '/s',
    busySeq: 0,
  } as unknown as SessionContext;
  server.sessionContexts.set('/s', old);
  server.buildSessionContext = async () => replacement;

  assert.equal(await server.createSessionContext({}, 'resume'), replacement);
  assert.equal(replacement.busySeq, 7);
  assert.equal(replacement.terminalLiveTurn, terminalLiveTurn);
});

test('createSessionContext permanently fences the bridge owned by the replaced runtime', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const uiRequests: unknown[] = [];
  const uiBridge = new ExtensionUIBridge('/s', (_event, payload) => uiRequests.push(payload));
  const pending = uiBridge.confirm('pending', 'request');
  const old = {
    sessionPath: '/s',
    busySeq: 0,
    uiBridge,
    unsubscribe: () => undefined,
    runtime: { dispose: async () => undefined },
  } as unknown as SessionContext;
  const replacement = { sessionPath: '/s', busySeq: 0 } as unknown as SessionContext;
  server.sessionContexts.set('/s', old);
  server.buildSessionContext = async () => replacement;

  assert.equal(await server.createSessionContext({}, 'resume'), replacement);
  assert.equal(await pending, false);
  assert.equal(await uiBridge.confirm('late', 'request'), false);
  uiBridge.notify('late notice');
  assert.equal(uiRequests.length, 1);
});

test('backend shutdown permanently fences every runtime bridge', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const uiRequests: unknown[] = [];
  const uiBridge = new ExtensionUIBridge('/s', (_event, payload) => uiRequests.push(payload));
  const pending = uiBridge.input('pending');
  const context = {
    sessionPath: '/s',
    uiBridge,
    unsubscribe: () => undefined,
    runtime: { dispose: async () => undefined },
  } as unknown as SessionContext;
  server.sessionContexts.set('/s', context);

  await server.dispose();

  assert.equal(await pending, undefined);
  assert.equal(await uiBridge.select('late', ['request']), undefined);
  uiBridge.notify('late notice');
  assert.equal(uiRequests.length, 1);
});

test('throwing best-effort cleanup cannot strand a retired runtime without replacement', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const events: Array<{ event: string; payload: unknown }> = [];
  const context = {
    sessionPath: '/s',
    busySeq: 0,
    activeRequest: { id: 'request-throwing-cleanup', messageIndex: 1, aborted: false },
    session: {
      clearQueue: () => { throw new Error('clear queue failed'); },
      abortRetry: () => { throw new Error('abort retry failed'); },
      abortCompaction: () => undefined,
      abortBranchSummary: () => undefined,
      abortBash: () => undefined,
      abort: async () => undefined,
    },
  } as unknown as SessionContext;
  const replacement = { sessionPath: '/s', busySeq: 0, session: { isStreaming: false } } as unknown as SessionContext;
  server.sdk = { SessionManager: { open: () => ({}) } };
  server.createSessionContext = async () => {
    server.sessionContexts.set('/s', replacement);
    return replacement;
  };
  server.emit = (event: string, payload: unknown) => events.push({ event, payload });
  server.emitBusyChanged = () => undefined;
  server.emitSessionOpened = async () => undefined;
  server.emitSessionListChanged = async () => undefined;
  server.sessionContexts.set('/s', context);

  assert.doesNotThrow(() => server.recoverStuckSession(context, 'stalled'));
  assert.equal(context.retired, true);
  assert.equal(events.filter((entry) => entry.event === 'message.aborted').length, 1);
  assert.equal(await context.recoveryPromise, replacement);
});
