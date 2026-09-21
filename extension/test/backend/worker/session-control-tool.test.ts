import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlTool,
  type SessionControlToolRequest,
} from '../../../src/backend/session-control-tool';
import type { CoordinatorToWorkerResponseFrame, WorkerToCoordinatorRequestBody } from '../../../src/backend/worker-protocol';

type SessionControlResult = Extract<CoordinatorToWorkerResponseFrame, { kind: 'session.control.result' }>;

function response(result: unknown): SessionControlResult {
  return {
    kind: 'session.control.result',
    requestId: 'response',
    ok: true,
    result,
  } as SessionControlResult;
}

function context(sessionPath = 'C:/sessions/current.jsonl') {
  return {
    sessionManager: { getSessionFile: () => sessionPath },
  } as never;
}

test('session_control maps ordinary message and transcript cursor requests onto the typed bridge', async () => {
  const calls: Array<{ body: WorkerToCoordinatorRequestBody; signal?: AbortSignal }> = [];
  const request: SessionControlToolRequest = async (body, signal) => {
    calls.push({ body, signal });
    return response({ ok: true });
  };
  const tool = createSessionControlTool(request);

  const message = await tool.execute(
    'message-call',
    { action: 'message', text: 'wake the other session', sessionPath: 'C:/sessions/other.jsonl' },
    undefined,
    undefined,
    context(),
  );
  assert.equal('isError' in message && message.isError, false);
  assert.deepEqual(calls[0]?.body, {
    kind: 'session.control',
    action: 'message',
    payload: { sessionPath: 'C:/sessions/other.jsonl', text: 'wake the other session' },
  });

  const read = await tool.execute(
    'read-call',
    { action: 'read', direction: 'older', cursor: { start: 16, end: 32 }, limit: 4 },
    undefined,
    undefined,
    context(),
  );
  assert.equal('isError' in read && read.isError, false);
  assert.deepEqual(calls[1]?.body, {
    kind: 'session.control',
    action: 'read',
    payload: {
      sessionPath: 'C:/sessions/current.jsonl',
      direction: 'older',
      cursor: { start: 16, end: 32 },
      limit: 4,
    },
  });
});

test('session_control forwards cancellation and rejects an invalid uncursoried page direction before IPC', async () => {
  let called = false;
  const request: SessionControlToolRequest = async (_body, signal) => {
    called = true;
    return await new Promise<SessionControlResult>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  const tool = createSessionControlTool(request);
  const controller = new AbortController();
  const pending = tool.execute(
    'cancel-call',
    { action: 'read', direction: 'newer', cursor: { start: 0, end: 1 } },
    controller.signal,
    undefined,
    context(),
  );
  controller.abort();
  const cancelled = await pending;
  assert.equal(called, true);
  assert.equal('isError' in cancelled && cancelled.isError, true);

  const invalid = await tool.execute(
    'invalid-call',
    { action: 'read', direction: 'older' },
    undefined,
    undefined,
    context(),
  );
  assert.equal('isError' in invalid && invalid.isError, true);
});
