import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlTool,
  SessionControlParameters,
  type SessionControlToolRequest,
} from '../../../../tools/session-control';
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

// Move regression: the relocated tool module keeps its public identity, schema,
// and prompt guidance intact so the relocation stays behavior-neutral.
test('session_control relocation preserves tool identity, schema, and guidance', () => {
  const tool = createSessionControlTool(async () => response({ ok: true }));

  assert.equal(tool.name, 'session_control');
  assert.equal(tool.label, 'Session control');
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.parameters, SessionControlParameters);
  assert.deepEqual(tool.promptGuidelines, [
    'Only sessions in the current extension host\'s local catalog are addressable; do not guess paths from another window.',
    'Use read direction latest for the first page, then pass the returned cursor with direction older or newer.',
    'message uses ordinary send semantics: an idle target wakes and a busy target receives Pie\'s normal queued-send behavior.',
    'close defaults to a reversible lifecycle close; pass delete:true only when the existing privacy/deletion behavior is intended.',
    'create returns a durably agent-created cold session path; it opens as an ordinary background tab without changing the selected tab, and message can subsequently wake it and promote its isolated runtime.',
  ]);

  const properties = SessionControlParameters.properties as Record<string, { type?: string; enum?: string[] }>;
  assert.deepEqual([...SessionControlParameters.required ?? []].sort(), ['action']);
  assert.deepEqual(properties.action?.enum, ['list', 'create', 'read', 'message', 'close']);
  assert.deepEqual(properties.direction?.enum, ['older', 'newer', 'latest']);
  assert.deepEqual(Object.keys(properties).sort(), ['action', 'cursor', 'cwd', 'delete', 'direction', 'limit', 'sessionPath', 'text']);
});