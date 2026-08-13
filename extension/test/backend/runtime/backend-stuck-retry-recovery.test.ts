import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ExtensionUIBridge } from '../../../src/backend/extension-ui-bridge';
import { BackendError } from '../../../src/backend/server-io';
import { createSessionManagerFence, FENCED_ENTRY_ID } from '../../../src/backend/session-manager-fence';
import type { SdkSessionManager } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
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

test('stuck recovery publishes its transition-local snapshot and releases future ensure/send waiters', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const events: Array<{ event: string; payload?: any }> = [];
  const checkpoint = { marker: 'terminal-checkpoint' };
  const context = {
    sessionPath: '/s',
    busySeq: 4,
    activeRequest: {
      id: 'request-recovery',
      messageIndex: 1,
      currentMessageId: 'assistant-recovery',
      aborted: false,
      liveTurnAccumulator: checkpoint,
    },
    session: {
      isStreaming: true,
      clearQueue: () => undefined,
      abortRetry: () => undefined,
      abortCompaction: () => undefined,
      abortBranchSummary: () => undefined,
      abortBash: () => undefined,
      abort: () => new Promise<void>(() => undefined),
    },
  } as unknown as SessionContext;
  const replacement = {
    sessionPath: '/s',
    busySeq: 0,
    session: {
      isStreaming: false,
      prompt: async () => undefined,
    },
  } as unknown as SessionContext;
  const payload = {
    session: { path: '/s' },
    runtimeReady: true,
    busy: false,
    liveTurnCheckpoint: checkpoint,
  };
  const hotPayload = deferred<any>();
  const publicPayload = deferred<any>();
  let hotBuilds = 0;
  let publicBuilds = 0;

  server.sdk = { SessionManager: { open: () => ({}) } };
  server.createSessionContext = async () => {
    replacement.busySeq = context.busySeq;
    replacement.terminalLiveTurn = context.terminalLiveTurn;
    server.sessionContexts.set('/s', replacement);
    return replacement;
  };
  server.buildHotSessionOpenedPayload = async () => {
    hotBuilds += 1;
    assert.equal(server.pendingSessionContexts.has('/s'), true, 'hydration remains inside transition ownership');
    assert.equal(server.sessionContexts.get('/s'), replacement);
    assert.equal(replacement.terminalLiveTurn?.accumulator, checkpoint);
    return await hotPayload.promise;
  };
  // This deferred is the regression seam: the public builder joins
  // pendingSessionContexts. Calling it from the owning transition would wait
  // forever on itself, while the transition-local hot builder can proceed.
  server.buildSessionOpenedPayload = async () => {
    publicBuilds += 1;
    return await publicPayload.promise;
  };
  server.emit = (event: string, eventPayload?: unknown) => events.push({ event, payload: eventPayload });
  server.emitSessionListChanged = async () => { events.push({ event: 'session.list.changed' }); };
  server.sessionContexts.set('/s', context);

  server.recoverStuckSession(context, 'stalled');
  const recovery = context.recoveryPromise as Promise<SessionContext>;
  assert.ok(recovery);
  const futureEnsure = server.ensureSessionContext('/s');
  const futureSend = server.handleRequest({
    id: 'future-send',
    method: 'message.send',
    params: { sessionPath: '/s', text: 'after recovery', inputs: [], localId: 'local-after-recovery' },
  });

  await tick();
  assert.equal(hotBuilds, 1);
  assert.equal(publicBuilds, 0, 'the transition must not enter the public owner-resolving builder');
  assert.equal(events.some((entry) => entry.event === 'session.opened'), false);

  hotPayload.resolve(payload);
  publicPayload.resolve(payload);
  const [recovered, ensured, sendResult] = await Promise.all([recovery, futureEnsure, futureSend]);
  await tick();

  assert.equal(recovered, replacement);
  assert.equal(ensured, replacement);
  assert.equal(typeof (sendResult as { requestId?: unknown }).requestId, 'string');
  assert.equal(server.pendingSessionContexts.size, 0);
  assert.equal(replacement.busySeq, 5, 'replacement preserves the predecessor sequence before publishing idle');
  assert.equal(replacement.terminalLiveTurn?.accumulator, checkpoint, 'terminal checkpoint remains available after replacement');
  assert.deepEqual(
    events.filter((entry) => entry.event === 'session.opened').map((entry) => entry.payload),
    [payload],
  );
  const eventNames = events.map((entry) => entry.event);
  assert.ok(eventNames.indexOf('message.aborted') < eventNames.indexOf('busy.changed'));
  assert.ok(eventNames.indexOf('busy.changed') < eventNames.indexOf('session.opened'));
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
  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
  server.emitSessionListChanged = async () => undefined;
  server.sessionContexts.set('/s', context);

  assert.doesNotThrow(() => server.recoverStuckSession(context, 'stalled'));
  assert.equal(context.retired, true);
  assert.equal(events.filter((entry) => entry.event === 'message.aborted').length, 1);
  assert.equal(await context.recoveryPromise, replacement);
});

test('recoverStuckSession invalidates the old session manager fence before replacement', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const appendCalls: unknown[] = [];
  const underlyingManager = {
    getCwd: () => '/repo',
    getSessionFile: () => '/s',
    getSessionName: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
    appendMessage: (message: unknown) => {
      appendCalls.push(message);
      return 'underlying-msg-id';
    },
  };
  const { manager: fencedManager, fence } = createSessionManagerFence(underlyingManager as SdkSessionManager);
  const context = {
    sessionPath: '/s',
    busySeq: 0,
    sessionManager: fencedManager,
    sessionManagerFence: fence,
    activeRequest: {
      id: 'request-fence',
      messageIndex: 1,
      currentMessageId: 'assistant-1',
      aborted: false,
    },
    session: {
      isStreaming: true,
      clearQueue: () => undefined,
      abortRetry: () => undefined,
      abortCompaction: () => undefined,
      abortBranchSummary: () => undefined,
      abortBash: () => undefined,
      abort: () => new Promise<void>(() => undefined),
    },
  } as unknown as SessionContext;
  const replacement = { sessionPath: '/s', busySeq: 0, session: { isStreaming: false } } as unknown as SessionContext;
  server.sdk = { SessionManager: { open: () => ({}) } };
  server.createSessionContext = async () => {
    server.sessionContexts.set('/s', replacement);
    return replacement;
  };
  server.emit = () => undefined;
  server.emitBusyChanged = () => undefined;
  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
  server.emitSessionListChanged = async () => undefined;
  server.sessionContexts.set('/s', context);

  assert.equal(fencedManager.appendMessage({ role: 'assistant' }), 'underlying-msg-id');
  assert.equal(appendCalls.length, 1);

  server.recoverStuckSession(context, 'stalled');

  assert.equal(context.retired, true);
  assert.equal(fence.isInvalidated(), true);
  assert.equal(fencedManager.appendMessage({ role: 'assistant' }), FENCED_ENTRY_ID);
  assert.equal(appendCalls.length, 1, 'retired manager must not append to the underlying store');

  await context.recoveryPromise;
  assert.equal(server.sessionContexts.get('/s'), replacement);
});

test('server shutdown invalidates every session manager fence', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const createManager = () => {
    const calls: unknown[] = [];
    const underlying = {
      getCwd: () => '/repo',
      getSessionFile: () => '/s',
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
      appendMessage: (message: unknown) => {
        calls.push(message);
        return 'msg-id';
      },
    };
    const { manager, fence } = createSessionManagerFence(underlying as SdkSessionManager);
    return { manager, fence, calls };
  };
  const a = createManager();
  const b = createManager();
  server.sessionContexts.set('/a', {
    sessionPath: '/a',
    sessionManager: a.manager,
    sessionManagerFence: a.fence,
    unsubscribe: () => undefined,
    runtime: { dispose: async () => undefined },
  } as unknown as SessionContext);
  server.sessionContexts.set('/b', {
    sessionPath: '/b',
    sessionManager: b.manager,
    sessionManagerFence: b.fence,
    unsubscribe: () => undefined,
    runtime: { dispose: async () => undefined },
  } as unknown as SessionContext);

  await server.dispose();

  assert.equal(a.fence.isInvalidated(), true);
  assert.equal(b.fence.isInvalidated(), true);
  assert.equal(a.manager.appendMessage({}), FENCED_ENTRY_ID);
  assert.equal(b.manager.appendMessage({}), FENCED_ENTRY_ID);
  assert.deepEqual(a.calls, []);
  assert.deepEqual(b.calls, []);
});

test('shutdown disposes every context even when one runtime rejects', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const disposed: string[] = [];
  server.sessionContexts.set('/a', {
    sessionPath: '/a',
    unsubscribe: () => undefined,
    runtime: { dispose: async () => { throw new Error('runtime A teardown exploded'); } },
  } as unknown as SessionContext);
  server.sessionContexts.set('/b', {
    sessionPath: '/b',
    unsubscribe: () => undefined,
    runtime: { dispose: async () => { disposed.push('/b'); } },
  } as unknown as SessionContext);

  await server.dispose();

  assert.deepEqual(disposed, ['/b'], 'a rejecting runtime must not strand the remaining contexts');
  assert.equal(server.sessionContexts.size, 0);
});

test('shutdown isolates every best-effort cleanup step within a context', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const calls: string[] = [];
  server.sessionContexts.set('/a', {
    sessionPath: '/a',
    willRetryWatchdogClear: () => { calls.push('watchdog'); throw new Error('watchdog cleanup exploded'); },
    uiBridge: { dispose: () => { calls.push('bridge'); throw new Error('bridge cleanup exploded'); } },
    unsubscribe: () => { calls.push('unsubscribe'); throw new Error('unsubscribe exploded'); },
    sessionManagerFence: { invalidate: () => { calls.push('fence'); throw new Error('fence cleanup exploded'); } },
    runtime: { dispose: async () => { calls.push('runtime-a'); } },
  } as unknown as SessionContext);
  server.sessionContexts.set('/b', {
    sessionPath: '/b',
    unsubscribe: () => undefined,
    runtime: { dispose: async () => { calls.push('runtime-b'); } },
  } as unknown as SessionContext);

  await server.dispose();

  assert.deepEqual(
    calls,
    ['watchdog', 'bridge', 'unsubscribe', 'fence', 'runtime-a', 'runtime-b'],
    'each cleanup runs even when every preceding cleanup throws',
  );
});
