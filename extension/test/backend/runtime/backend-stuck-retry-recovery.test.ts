import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import type { SessionContext } from '../../../src/backend/server-types';

test('stuck recovery terminalizes once and replaces a runtime without awaiting abort', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const calls: string[] = [];
  const events: Array<{ event: string; payload: any }> = [];
  let abortCalls = 0;
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
