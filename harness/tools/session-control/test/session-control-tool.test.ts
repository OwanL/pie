import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlTool,
  SessionControlParameters,
  type SessionControlToolRequest,
} from '../index.js';
import type { CoordinatorToWorkerResponseFrame, WorkerToCoordinatorRequestBody } from '../../../agent-processes/lib/rpc/worker-protocol.js';

type SessionControlResult = Extract<CoordinatorToWorkerResponseFrame, { kind: 'session.control.result' }>;

function response(result: unknown): SessionControlResult {
  return {
    kind: 'session.control.result',
    requestId: 'response',
    ok: true,
    result,
  } as SessionControlResult;
}

test('session_control maps title/self targeting and the prompt payload onto the typed bridge', async () => {
  const calls: Array<{ body: WorkerToCoordinatorRequestBody; signal?: AbortSignal }> = [];
  const request: SessionControlToolRequest = async (body, signal) => {
    calls.push({ body, signal });
    return response({ ok: true });
  };
  const tool = createSessionControlTool(request);

  const message = await tool.execute(
    'message-call',
    { action: 'message', title: 'Refactor auth', prompt: 'wake the other session' },
    undefined,
    undefined,
  );
  assert.equal('isError' in message && message.isError, false);
  assert.deepEqual(calls[0]?.body, {
    kind: 'session.control',
    action: 'message',
    payload: { title: 'Refactor auth', prompt: 'wake the other session' },
  });

  const read = await tool.execute(
    'read-call',
    { action: 'read', self: true, direction: 'older', cursor: { start: 16, end: 32 }, limit: 4 },
    undefined,
    undefined,
  );
  assert.equal('isError' in read && read.isError, false);
  assert.deepEqual(calls[1]?.body, {
    kind: 'session.control',
    action: 'read',
    payload: {
      self: true,
      direction: 'older',
      cursor: { start: 16, end: 32 },
      limit: 4,
    },
  });

  const close = await tool.execute(
    'close-call',
    { action: 'close', title: 'Refactor auth (2)', delete: true },
    undefined,
    undefined,
  );
  assert.equal('isError' in close && close.isError, false);
  assert.deepEqual(calls[2]?.body, {
    kind: 'session.control',
    action: 'close',
    payload: { title: 'Refactor auth (2)', delete: true },
  });
});

test('session_control forwards settings inspection/update, identity-bound replies, and combined create patches', async () => {
  const calls: WorkerToCoordinatorRequestBody[] = [];
  const tool = createSessionControlTool(async (body) => {
    calls.push(body);
    return response({ ok: true });
  });
  const settings = {
    model: { provider: 'openai', id: 'gpt-test' },
    reasoning: 'high' as const,
    autonomousMode: true,
    subagentProviderChoices: { anthropic: false },
    disabledSystemPromptEntries: ['prompt-a'],
  };

  await tool.execute('settings-get', { action: 'settings.get', title: 'Research' }, undefined, undefined);
  await tool.execute('settings-set', { action: 'settings.set', self: true, settings }, undefined, undefined);
  await tool.execute('reply', {
    action: 'message',
    replyTo: 'pie-reply:v1:eyJpZGVudGl0eSJ9',
    prompt: 'answer',
  }, undefined, undefined);
  await tool.execute('create-combined', {
    action: 'create',
    title: 'New worker',
    prompt: 'start this task',
    settings,
  }, undefined, undefined);

  assert.deepEqual(calls, [
    { kind: 'session.control', action: 'settings.get', payload: { title: 'Research' } },
    { kind: 'session.control', action: 'settings.set', payload: { self: true, settings } },
    { kind: 'session.control', action: 'message', payload: { replyTo: 'pie-reply:v1:eyJpZGVudGl0eSJ9', prompt: 'answer' } },
    { kind: 'session.control', action: 'create', payload: { title: 'New worker', prompt: 'start this task', settings } },
  ]);
});

test('session_control requires an explicit title or self target and rejects conflicting targets', async () => {
  const calls: Array<{ body: WorkerToCoordinatorRequestBody; signal?: AbortSignal }> = [];
  const request: SessionControlToolRequest = async (body, signal) => {
    calls.push({ body, signal });
    return response({ ok: true });
  };
  const tool = createSessionControlTool(request);

  const missing = await tool.execute('missing-call', { action: 'message', prompt: 'hi' }, undefined, undefined);
  assert.equal('isError' in missing && missing.isError, true, 'there is no implicit current-session default');
  assert.deepEqual(calls, [], 'an untargeted request must not reach the coordinator');

  const conflict = await tool.execute(
    'conflict-call',
    { action: 'message', title: 'A', self: true, prompt: 'hi' },
    undefined,
    undefined,
  );
  assert.equal('isError' in conflict && conflict.isError, true, 'title and self are mutually exclusive');
  assert.deepEqual(calls, []);
});

test('session_control requires a bounded create title and forwards it with the create payload', async () => {
  const calls: Array<{ body: WorkerToCoordinatorRequestBody; signal?: AbortSignal }> = [];
  const request: SessionControlToolRequest = async (body, signal) => {
    calls.push({ body, signal });
    return response({ ok: true, sessionPath: '/workspace/new.jsonl', title: 'Research notes' });
  };
  const tool = createSessionControlTool(request);

  const missing = await tool.execute('create-missing', { action: 'create', cwd: '/workspace/project' }, undefined, undefined);
  assert.equal('isError' in missing && missing.isError, true, 'create requires a title');

  const created = await tool.execute(
    'create-ok',
    { action: 'create', title: 'Research notes', cwd: '/workspace/project' },
    undefined,
    undefined,
  );
  assert.equal('isError' in created && created.isError, false);
  assert.deepEqual(calls[0]?.body, {
    kind: 'session.control',
    action: 'create',
    payload: { title: 'Research notes', cwd: '/workspace/project' },
  });
});

test('session_control marks lost mutation acknowledgements unknown without implying remote cancellation', async () => {
  const tool = createSessionControlTool(async () => { throw new Error('request cancelled'); });
  for (const params of [
    { action: 'create', title: 'Disposable' },
    { action: 'message', self: true, prompt: 'body' },
    { action: 'settings.set', self: true, settings: { reasoning: 'low' } },
    { action: 'close', self: true },
  ]) {
    const result = await tool.execute('lost-reply', params as never, undefined, undefined);
    assert.equal('isError' in result && result.isError, true);
    assert.equal((result.details as { outcome?: string }).outcome, 'unknown');
    assert.match((result.content[0] as { text: string }).text, /may still continue.*Do not automatically retry/u);
  }
  const read = await tool.execute('read-lost-reply', { action: 'read', self: true }, undefined, undefined);
  assert.equal((read.details as { outcome?: string }).outcome, undefined);
  const rejectedTool = createSessionControlTool(async () => ({
    kind: 'session.control.result', requestId: 'rejected', ok: false,
    error: { code: 'INVALID_PARAMS', message: 'Known preflight rejection' },
  }));
  const rejected = await rejectedTool.execute('known-rejection', { action: 'message', self: true, prompt: 'body' }, undefined, undefined);
  assert.equal((rejected.details as { outcome?: string }).outcome, undefined);
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
    { action: 'read', self: true, direction: 'newer', cursor: { start: 0, end: 1 } },
    controller.signal,
    undefined,
  );
  controller.abort();
  const cancelled = await pending;
  assert.equal(called, true);
  assert.equal('isError' in cancelled && cancelled.isError, true);

  const invalid = await tool.execute(
    'invalid-call',
    { action: 'read', title: 'Refactor auth', direction: 'older' },
    undefined,
    undefined,
  );
  assert.equal('isError' in invalid && invalid.isError, true);
});

// Move regression: the relocated tool module keeps its public identity, schema,
// and prompt guidance intact so the relocation stays behavior-neutral.
test('session_control rejects action-inapplicable inputs instead of silently discarding agent intent', async () => {
  const calls: unknown[] = [];
  const tool = createSessionControlTool(async (body) => { calls.push(body); return response({}); });
  for (const params of [
    { action: 'list', title: 'ignored target' },
    { action: 'create', title: 'A', self: true },
    { action: 'settings.get', self: true, settings: { autonomousMode: false } },
    { action: 'close', self: true, prompt: 'ignored instruction' },
    { action: 'read', self: true, replyTo: 'ignored reply' },
    { action: 'create', title: 'A', cwd: '  ' },
    { action: 'create', title: 'a'.repeat(26) },
  ]) {
    const result = await tool.execute('invalid', params as never, undefined, undefined);
    assert.equal('isError' in result && result.isError, true, JSON.stringify(params));
  }
  assert.deepEqual(calls, []);
});

test('session_control relocation preserves tool identity, schema, and guidance', () => {
  const tool = createSessionControlTool(async () => response({ ok: true }));

  assert.equal(tool.name, 'session_control');
  assert.equal(tool.label, 'Session control');
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.parameters, SessionControlParameters);
  assert.deepEqual(tool.promptGuidelines, [
    'list exposes live sessions with their assigned titles (field `title`) and provisional `name` labels; only assigned titles address existing sessions.',
    "read, settings, and close require an explicit target: set `self` for the caller's own session or `title` for another live session; message may instead use replyTo.",
    "create requires a 1-25-character title (trimmed), inherits the creator's saved model/reasoning, system-prompt toggles, and execution settings, and configures them before any optional prompt is sent. Without a prompt the new session remains cold. creation.status=not_created confirms no session exists; unknown never authorizes automatic recreation.",
    'Cancellation or a lost mutation acknowledgement does not prove the coordinator stopped; its outcome is unknown and it may continue. Do not automatically repeat create, message, settings, or close requests after such an error.',
    'Use read direction latest for the first page, then pass the returned cursor with direction older or newer. Tool bodies are bounded previews; renderer diagnostics and image bytes are omitted.',
    "message uses ordinary send semantics: an idle target wakes and a busy target receives Pie's normal queued-send behavior. replyTo resolves only while the original sender is live.",
    "settings.get captures the target's saved model, reasoning, system-prompt toggles, and execution preferences; settings.set persists only the supplied patch through its owning settings paths.",
    "close stops active and queued work, removes the tab, and runs host-owned lifecycle cleanup; it does not merely hide a running tab.",
    "A self-close returns after the host accepts responsibility (close requested), which is not a completed-close result; closing another session waits for the hosted stop/cleanup confirmation, or reports explicitly unknown when the acknowledgement is missing.",
    'pass delete:true only when the existing privacy/deletion lifecycle is intended; deletion is committed by the host and can never be undone.',
  ]);

  const properties = SessionControlParameters.properties as Record<string, { type?: string; enum?: string[] }>;
  assert.deepEqual([...SessionControlParameters.required ?? []].sort(), ['action']);
  assert.deepEqual(properties.action?.enum, ['list', 'create', 'read', 'message', 'settings.get', 'settings.set', 'close']);
  assert.deepEqual(properties.direction?.enum, ['older', 'newer', 'latest']);
  // Paths are never accepted: addressing uses title, self, or an identity-bound
  // reply reference; settings use a closed patch schema.
  assert.deepEqual(
    Object.keys(properties).sort(),
    ['action', 'cursor', 'cwd', 'delete', 'direction', 'limit', 'prompt', 'replyTo', 'self', 'settings', 'title'],
  );
});