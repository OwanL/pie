import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionControlTool,
  SessionControlParameters,
  SessionControlReadOnlyParameters,
  type SessionControlToolRequest,
} from '../index.js';
import { createBackendTools } from '../../../agent-processes/coordinator/backend-tools.js';
import type { CoordinatorToWorkerResponseFrame, WorkerToCoordinatorRequestBody } from '../../../agent-processes/lib/rpc/worker-protocol.js';

type SessionControlResult = Extract<CoordinatorToWorkerResponseFrame, { kind: 'session.control.result' }>;
type Request = Extract<WorkerToCoordinatorRequestBody, { kind: 'session.control' }>;
function response(result: unknown): SessionControlResult {
  return { kind: 'session.control.result', requestId: 'response', ok: true, result } as SessionControlResult;
}
function harness(result: unknown = { ok: true }) {
  const calls: Request[] = [];
  const tool = createSessionControlTool(async (body) => { calls.push(body as Request); return response(result); });
  return { calls, tool };
}
function withoutKey(call: Request) {
  const { requestKey, ...payload } = call.payload;
  if (['create', 'message', 'settings.set', 'close', 'cleanup'].includes(call.action)) assert.match(String(requestKey), /^\d+:[0-9a-f-]{36}$/u);
  return { ...call, payload };
}
// Model the SDK contract: only throws set isError; returned flags are ignored.
const run = async (tool: ReturnType<typeof createSessionControlTool>, params: unknown) => {
  try {
    return { ...await tool.execute('call', params as never, undefined, undefined), isError: false };
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith('session_control error: '));
    return { content: [{ type: 'text' as const, text: error.message }], details: JSON.parse(error.message.slice('session_control error: '.length)), isError: true };
  }
};

test('title requests map onto the bridge and mutations get distinct generated keys', async () => {
  const { calls, tool } = harness();
  await run(tool, { action: 'message', title: 'Refactor auth', prompt: 'wake the other session', expectReply: false });
  await run(tool, { action: 'read', title: 'Refactor auth', direction: 'older', cursor: 'opaque', maxCharacters: 8000 });
  await run(tool, { action: 'close', title: 'Refactor auth (2)', delete: true });
  assert.deepEqual(calls.map(withoutKey), [
    { kind: 'session.control', action: 'message', payload: { title: 'Refactor auth', prompt: 'wake the other session', expectReply: false } },
    { kind: 'session.control', action: 'read', payload: { title: 'Refactor auth', direction: 'older', cursor: 'opaque', maxCharacters: 8000, includeToolCalls: false, includeReasoning: false } },
    { kind: 'session.control', action: 'close', payload: { title: 'Refactor auth (2)', delete: true } },
  ]);
  assert.notEqual(calls[0].payload.requestKey, calls[2].payload.requestKey);
});

test('settings, replies, and create patches preserve payloads', async () => {
  const { calls, tool } = harness();
  const settings = { model: { provider: 'openai', id: 'gpt-test' }, reasoning: 'high', autonomousMode: true, subagentProviderChoices: { anthropic: false }, disabledSystemPromptEntries: ['prompt-a'] };
  await run(tool, { action: 'settings.get', title: 'Research' });
  await run(tool, { action: 'settings.set', title: 'Research', settings });
  await run(tool, { action: 'message', replyTo: 'pie-reply:v1:eyJpZGVudGl0eSJ9', prompt: 'answer', expectReply: false });
  const { model: _model, ...createSettings } = settings;
  await run(tool, { action: 'create', title: 'New worker', bucket: 'medium', prompt: 'start this task', settings: createSettings });
  assert.deepEqual(calls.map(withoutKey), [
    { kind: 'session.control', action: 'settings.get', payload: { title: 'Research' } },
    { kind: 'session.control', action: 'settings.set', payload: { title: 'Research', settings } },
    { kind: 'session.control', action: 'message', payload: { replyTo: 'pie-reply:v1:eyJpZGVudGl0eSJ9', prompt: 'answer', expectReply: false } },
    { kind: 'session.control', action: 'create', payload: { title: 'New worker', bucket: 'medium', prompt: 'start this task', settings: createSettings } },
  ]);
});

test('invalid create, targeting, inapplicable fields and attempted key replay do not reach IPC', async () => {
  const { calls, tool } = harness();
  for (const params of [
    ...[undefined, 'large', '', null, 1].map(bucket => ({ action: 'create', title: 'A', bucket })),
    { action: 'create', title: 'A', bucket: 'medium', settings: { model: { provider: 'p', id: 'm' } } },
    { action: 'create', bucket: 'small' },
    { action: 'create', bucket: 'small', title: 'a'.repeat(26) },
    { action: 'create', bucket: 'small', title: 'a\nb' },
    { action: 'create', bucket: 'small', title: 'A', cwd: '  ' },
    { action: 'create', bucket: 'small', title: 'A', prompt: '  ' },
    { action: 'message', prompt: 'hi' },
    { action: 'message', title: '', replyTo: 'ref', prompt: 'hi' },
    { action: 'message', title: 'A', replyTo: 'ref', prompt: 'hi' },
    { action: 'message', title: 'A', prompt: '' },
    { action: 'settings.set', title: 'A', settings: {} },
    { action: 'message', title: 'A', prompt: 'hi', settings: {} },
    { action: 'close', title: 'A', prompt: 'ignored' },
    { action: 'message', title: 'A', prompt: 'hi', requestKey: 'caller-replay' },
    { action: 'message', title: 'A', prompt: 'hi', expectReply: 'yes' },
    { action: 'create', title: 'A', bucket: 'small', expectReply: false },
    { action: 'read', title: 'A', limit: 4 },
    { action: 'read', self: false },
    { action: 'message', self: true, replyTo: 'ref', prompt: 'hi' },
    { action: 'close', title: 'A', self: true },
    { action: 'list', title: 'A' },
    { action: 'list', access: 'full' },
    { action: 'operation.status' },
    { action: 'operation.status', requestKey: '' },
    { action: 'cleanup', dontCloseRunning: 'false' },
  ]) {
    const result = await run(tool, params);
    assert.equal(result.isError, true, JSON.stringify(params));
  }
  assert.deepEqual(calls, []);
  for (const bucket of ['small', 'medium', 'frontier']) {
    assert.equal((await run(tool, { action: 'create', title: ' A ', bucket, cwd: ' /work ' })).isError, false);
    assert.deepEqual(withoutKey(calls.at(-1)!), { kind: 'session.control', action: 'create', payload: { title: 'A', bucket, cwd: '/work' } });
  }
});

test('unnamed self targets remain usable, including subagent read of its owning primary', async () => {
  const { calls, tool } = harness();
  for (const params of [
    { action: 'read', self: true }, { action: 'message', self: true, prompt: 'body', expectReply: false },
    { action: 'settings.get', self: true }, { action: 'settings.set', self: true, settings: { reasoning: 'low' } },
    { action: 'close', self: true },
  ]) assert.equal((await run(tool, params)).isError, false);
  assert.ok(calls.every(call => call.payload.self === true && call.payload.title === undefined));
  const child = createSessionControlTool(async body => { calls.push(body as Request); return response({}); }, { readOnly: true });
  assert.equal((await run(child, { action: 'read', self: true })).isError, false);
  assert.equal(calls.at(-1)!.payload.self, true);
});

test('read applies defaults and validates opaque cursors, character limits and projection flags', async () => {
  const { calls, tool } = harness();
  await run(tool, { action: 'read', title: 'A' });
  assert.deepEqual(calls[0].payload, { title: 'A', direction: 'latest', maxCharacters: 4000, includeToolCalls: false, includeReasoning: false });
  await run(tool, { action: 'read', title: 'A', direction: 'newer', cursor: 'opaque', maxCharacters: 256 * 1024, includeToolCalls: true, includeReasoning: true });
  assert.equal(calls[1].payload.maxCharacters, 256 * 1024);
  for (const params of [
    { direction: 'older' }, { direction: 'newer', cursor: { start: 0, end: 1 } },
    { direction: 'latest', cursor: 'opaque' }, { direction: 'else' },
    ...[0, 1.5, 256 * 1024 + 1, NaN].map(maxCharacters => ({ maxCharacters })),
    { includeToolCalls: 1 }, { includeReasoning: 'true' },
  ]) assert.equal((await run(tool, { action: 'read', title: 'A', ...params })).isError, true);
  assert.equal(calls.length, 2);
});

test('read renders the same compact serialization counted by its character budget', async () => {
  const value = { sessionPath: '/session', messages: Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: 'assistant', text: 'response body' })), cursor: 'opaque' };
  const budget = JSON.stringify(value).length;
  const result = await run(harness(value).tool, { action: 'read', title: 'A', maxCharacters: budget });
  const text = (result.content[0] as { text: string }).text;
  assert.equal(text.length, budget);
  assert.equal(text, JSON.stringify(value));
  assert.ok(JSON.stringify(value, null, 2).length > budget);
});

test('prompt bound is UTF-8 bytes for both create and message', async () => {
  const { calls, tool } = harness();
  for (const action of ['create', 'message']) {
    const base = action === 'create' ? { action, title: 'A', bucket: 'small' } : { action, title: 'A', expectReply: true };
    assert.equal((await run(tool, { ...base, prompt: 'é'.repeat(32 * 1024) })).isError, false);
    assert.equal((await run(tool, { ...base, prompt: 'é'.repeat(32 * 1024 + 1) })).isError, true);
    assert.equal((await run(tool, { ...base, prompt: 'x'.repeat(64 * 1024 + 1) })).isError, true);
  }
  assert.equal(calls.length, 2);
});

test('cleanup forwards privacy-owned close semantics and operation.status only looks up', async () => {
  const { calls, tool } = harness();
  await run(tool, { action: 'cleanup' });
  await run(tool, { action: 'cleanup', dontCloseRunning: false });
  await run(tool, { action: 'operation.status', requestKey: 'receipt' });
  assert.deepEqual(calls.map(call => call.action === 'operation.status' ? call : withoutKey(call)), [
    { kind: 'session.control', action: 'cleanup', payload: { dontCloseRunning: true } },
    { kind: 'session.control', action: 'cleanup', payload: { dontCloseRunning: false } },
    { kind: 'session.control', action: 'operation.status', payload: { requestKey: 'receipt' } },
  ]);
});

test('lost mutation acknowledgements return key and exact lookup without suggesting replay', async () => {
  const sent: Request[] = [];
  const tool = createSessionControlTool(async body => { sent.push(body as Request); throw new Error('request cancelled'); });
  for (const params of [
    { action: 'create', bucket: 'frontier', title: 'Disposable' },
    { action: 'message', title: 'A', prompt: 'body', expectReply: false },
    { action: 'settings.set', title: 'A', settings: { reasoning: 'low' } },
    { action: 'close', title: 'A' }, { action: 'cleanup' },
  ]) {
    const result = await run(tool, params);
    assert.equal(result.isError, true);
    const details = result.details as { outcome: string; requestKey: string; lookup: unknown };
    assert.equal(details.outcome, 'unknown');
    assert.equal(details.requestKey, sent.at(-1)!.payload.requestKey);
    assert.deepEqual(details.lookup, { action: 'operation.status', requestKey: details.requestKey });
    assert.match((result.content[0] as { text: string }).text, /may still continue.*Do not automatically retry/u);
  }
  assert.equal((await run(tool, { action: 'read', title: 'A' })).details.outcome, undefined);
});

test('known rejection and partial/unknown phase outcomes are errors, not unconditional success', async () => {
  const rejected = createSessionControlTool(async () => ({ kind: 'session.control.result', requestId: 'rejected', ok: false, error: { code: 'SESSION_CONTROL_FAILED', message: 'Known preflight rejection', retryable: false } }));
  const failure = await run(rejected, { action: 'message', title: 'A', prompt: 'body', expectReply: false });
  assert.equal(failure.isError, true);
  assert.equal(failure.details.outcome, undefined);
  for (const value of [
    { creation: { status: 'not_created' } }, { configuration: { status: 'failed', appliedFields: ['reasoning'] } },
    { creation: { status: 'created', titleAssigned: false }, configuration: { status: 'not_started' }, message: { status: 'not_sent' } },
    { creation: { status: 'created', titleAssigned: false } }, { message: { status: 'not_sent' } },
    { message: { status: 'rejected' } }, { message: { status: 'unknown' } }, { closed: false, unknown: true },
    { operation: { status: 'known', outcome: 'unknown', result: { configuration: { status: 'unknown' } } } },
    { operation: { status: 'known', outcome: 'known', evidenceUnavailable: true } },
    { operation: { status: 'known', result: { configuration: { status: 'failed' } } } },
    { operation: { status: 'unavailable' } }, { results: [{ unknown: true }] },
    { results: [], resultsTruncated: true, failedCount: 1 }, { results: [], resultsTruncated: true, unknownCount: 1 },
  ]) assert.equal((await run(harness(value).tool, { action: 'list' })).isError, true, JSON.stringify(value));
  for (const value of [{ closed: true }, { closeRequested: true, closed: false }, { creation: { status: 'created' }, configuration: { status: 'succeeded' }, message: { status: 'not_requested' } }, { operation: { status: 'pending' } }]) {
    assert.equal((await run(harness(value).tool, { action: 'list' })).isError, false, JSON.stringify(value));
  }
});

test('cancellation signal is forwarded', async () => {
  let called = false;
  const request: SessionControlToolRequest = async (_body, signal) => {
    called = true;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const controller = new AbortController();
  const pending = createSessionControlTool(request).execute('cancel', { action: 'read', title: 'A', direction: 'newer', cursor: 'opaque' }, controller.signal, undefined);
  controller.abort();
  await assert.rejects(pending, /session_control error:.*aborted/u);
  assert.equal(called, true);
});

test('subagent tool has read-only schema and cannot escalate by execute arguments', async () => {
  const calls: Request[] = [];
  const tools = createBackendTools({ kind: 'subagent', requestSessionControl: async body => { calls.push(body as Request); return response({}); } });
  const tool = tools.find(tool => tool.name === 'session_control')!;
  assert.equal(tool.parameters, SessionControlReadOnlyParameters);
  assert.deepEqual(SessionControlReadOnlyParameters.properties.action.enum, ['list', 'read']);
  for (const action of ['create', 'message', 'settings.get', 'settings.set', 'close', 'cleanup', 'operation.status']) {
    assert.equal((await run(tool, { action, title: 'A', prompt: 'hi', bucket: 'small', requestKey: 'key' })).isError, true);
  }
  assert.equal((await run(tool, { action: 'list', access: 'full' })).isError, true);
  assert.deepEqual(calls, []);
  assert.equal((await run(tool, { action: 'list' })).isError, false);
  assert.equal((await run(tool, { action: 'read', title: 'A' })).isError, false);
  assert.equal(calls.length, 2);
});

test('public schema and guidance reflect approved access and actions', () => {
  const tool = harness().tool;
  assert.equal(tool.name, 'session_control');
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.parameters, SessionControlParameters);
  assert.deepEqual(SessionControlParameters.required, ['action']);
  assert.deepEqual(SessionControlParameters.properties.action.enum, ['list', 'create', 'read', 'message', 'settings.get', 'settings.set', 'close', 'cleanup', 'operation.status']);
  assert.equal(SessionControlParameters.properties.maxCharacters.maximum, 256 * 1024);
  assert.equal(SessionControlParameters.properties.maxCharacters.default, 4000);
  assert.equal(SessionControlParameters.properties.cursor.type, 'string');
  assert.equal('self' in SessionControlParameters.properties, true);
  assert.equal('self' in SessionControlReadOnlyParameters.properties, true);
  assert.equal('limit' in SessionControlParameters.properties, false);
  assert.equal('path' in SessionControlParameters.properties, false);
  assert.match(SessionControlParameters.properties.replyTo.description!, /mutually exclusive with title/);
  assert.equal(SessionControlParameters.properties.expectReply.type, 'boolean');
  assert.ok(tool.promptGuidelines?.includes('Prefer cheaper subagents for large-output inspection; use bounded reads for small checks.'));
  assert.ok(tool.promptGuidelines?.includes('Before cleanup, check for owned sessions the user is still using; close sessions individually if any should remain open'));
  assert.ok(tool.promptGuidelines?.includes('Message decisions, blockers, interface changes, and final findings; omit routine progress and acknowledgements'));
  assert.equal(tool.promptGuidelines?.some(text => text.includes('has taken them over')), false);
});
