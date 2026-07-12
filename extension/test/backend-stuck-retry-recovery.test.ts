import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../src/backend';
import type { SessionContext } from '../src/backend/server-types';

test('retry-stuck recovery aborts billable windows and terminalizes host state', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  const calls: string[] = [];
  const events: Array<{ event: string; payload: any }> = [];
  const context = {
    sessionPath: '/s',
    busySeq: 0,
    activeRequest: {
      id: 'request-1',
      messageIndex: 1,
      currentMessageId: 'assistant-1',
      aborted: false,
    },
    session: {
      clearQueue: () => calls.push('clearQueue'),
      abortRetry: () => calls.push('abortRetry'),
      abortCompaction: () => calls.push('abortCompaction'),
      abortBranchSummary: () => calls.push('abortBranchSummary'),
      abortBash: () => calls.push('abortBash'),
      abort: async () => { calls.push('abort'); },
    },
  } as unknown as SessionContext;

  server.emit = (event: string, payload: unknown) => events.push({ event, payload });
  server.emitBusyChanged = (_context: SessionContext, busy: boolean) => events.push({ event: 'busy.changed', payload: busy });
  server.emitSessionOpened = async () => {};
  server.emitSessionListChanged = async () => {};

  await server.recoverStuckSession(context, 'stalled');

  assert.deepEqual(calls, [
    'clearQueue',
    'abortRetry',
    'abortCompaction',
    'abortBranchSummary',
    'abortBash',
    'abort',
  ]);
  assert.equal(context.activeRequest, undefined);
  assert.equal(events.find((event) => event.event === 'message.aborted')?.payload.reason, 'stalled');
  assert.equal(events.at(-1)?.event, 'busy.changed');
  assert.equal(events.at(-1)?.payload, false);
});
