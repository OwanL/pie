import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@mariozechner/pi-ai';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CoordinatorToWorkerResponseFrame, WorkerToCoordinatorRequestBody } from '../../../agent-processes/lib/rpc/worker-protocol.js';
import { createSessionCollaborationTools } from '../collaboration.js';
import type { SessionControlToolRequest } from '../index.js';

type ToolCall = Extract<WorkerToCoordinatorRequestBody, { kind: 'session.control' }>;
type ToolRecord = {
  name: string;
  parameters: {
    additionalProperties?: boolean;
    required?: readonly string[];
    properties?: Record<string, Record<string, unknown>>;
  };
  execute: ToolDefinition['execute'];
};

function response(result: unknown = { status: 'ok' }): CoordinatorToWorkerResponseFrame {
  return { kind: 'session.control.result', requestId: 'response', ok: true, result } as CoordinatorToWorkerResponseFrame;
}

function toolsFor(request: SessionControlToolRequest = async () => response()) {
  return createSessionCollaborationTools(request) as ToolRecord[];
}

async function invoke(tool: ToolRecord, args: unknown, signal?: AbortSignal) {
  return await tool.execute('test-call', args as never, signal, undefined);
}

function schema(tool: ToolRecord): Record<string, Record<string, unknown>> {
  assert.ok(tool.parameters.properties, `${tool.name} has a property schema`);
  assert.equal(tool.parameters.additionalProperties, false, `${tool.name} rejects extra properties`);
  return tool.parameters.properties;
}

function enumValues(property: Record<string, unknown>): readonly unknown[] {
  assert.ok(Array.isArray(property.enum), 'expected an enum schema');
  return property.enum;
}

function withoutRequestKey(call: ToolCall) {
  const { requestKey: _requestKey, ...payload } = call.payload;
  const generatedKey = typeof call.payload.requestKey === 'string'
    && /^\d+:[0-9a-f-]{36}$/u.test(call.payload.requestKey);
  return { action: call.action, payload: generatedKey ? payload : call.payload };
}

function mutationKey(call: ToolCall): string {
  const key = call.payload.requestKey;
  assert.equal(typeof key, 'string');
  assert.match(key, /^\d+:[0-9a-f-]{36}$/u);
  return key;
}

test('advertised tool family separates lifecycle, notes, assignments, results, waits and resources', () => {
  const all = toolsFor();
  assert.deepEqual(all.map((tool) => tool.name), [
    'session_control', 'session_send', 'session_assign', 'session_finish', 'session_wait', 'session_resources',
  ]);
  const [control, send, assign, finish, wait, resources] = all;
  assert.ok(control && send && assign && finish && wait && resources);

  const controlProperties = schema(control);
  assert.deepEqual(control.parameters.required, ['action'], 'action-specific selectors and settings remain optional at the shared schema boundary');
  assert.deepEqual(enumValues(controlProperties.action!), [
    'list', 'create', 'read', 'settings.get', 'settings.set', 'interrupt', 'close', 'cleanup', 'operation.status',
  ]);
  assert.equal(controlProperties.address?.type, 'string');
  assert.deepEqual(enumValues(controlProperties.bucket!), ['small', 'medium', 'frontier']);
  assert.equal(controlProperties.prompt?.maxLength, 16 * 1024);
  assert.match(String(controlProperties.prompt?.description), /16 KiB UTF-8/u);
  for (const legacyField of ['message', 'expectReply', 'fulfills', 'replyTo']) {
    assert.equal(controlProperties[legacyField], undefined, `session_control does not advertise legacy field ${legacyField}`);
  }
  assert.equal(enumValues(controlProperties.action!).includes('message'), false);
  assert.deepEqual(Object.keys(schema(send)).sort(), ['message', 'target']);
  assert.equal((schema(send).message as { maxLength?: number }).maxLength, 16 * 1024);
  assert.equal((schema(send).target as { maxLength?: number }).maxLength, 768);
  assert.equal(schema(send).expectReply, undefined);
  assert.equal(schema(send).settings, undefined);
  assert.deepEqual(Object.keys(schema(assign)).sort(), ['prompt', 'revision', 'target', 'taskId']);
  assert.equal((schema(assign).prompt as { maxLength?: number }).maxLength, 16 * 1024);
  assert.equal((schema(assign).taskId as { maxLength?: number }).maxLength, 128);
  assert.equal((schema(assign).revision as { minimum?: number }).minimum, 1);
  assert.equal(schema(assign).expectReply, undefined);
  assert.deepEqual(Object.keys(schema(finish)).sort(), ['outcome', 'result', 'revision', 'taskId']);
  assert.equal((schema(finish).result as { maxLength?: number }).maxLength, 32 * 1024);
  assert.equal((schema(finish).taskId as { maxLength?: number }).maxLength, 128);
  assert.deepEqual(enumValues(schema(finish).outcome!), ['completed', 'failed', 'blocked', 'cancelled']);
  assert.deepEqual(Object.keys(schema(wait)).sort(), ['afterRevision', 'taskIds', 'timeoutMs']);
  assert.equal((schema(wait).timeoutMs as { default?: number }).default, 60_000);
  assert.equal((schema(wait).timeoutMs as { minimum?: number }).minimum, 0);
  assert.equal((schema(wait).timeoutMs as { maximum?: number }).maximum, 300_000);
  assert.equal((schema(wait).taskIds as { maxItems?: number }).maxItems, 16);
  assert.equal((schema(wait).taskIds as { uniqueItems?: boolean }).uniqueItems, true);
  assert.deepEqual(enumValues(schema(resources).action!), ['status', 'acquire', 'start', 'renew', 'release', 'reclaim', 'wait']);
  assert.equal((schema(resources).name as { maxLength?: number }).maxLength, 96);
  assert.match((schema(resources).name as { description?: string }).description ?? '', /96 Unicode characters before and after normalization/u);
  assert.equal((schema(resources).purpose as { maxLength?: number }).maxLength, 240);
  assert.match((schema(resources).purpose as { description?: string }).description ?? '', /240 Unicode characters/u);
  assert.equal((schema(resources).leaseId as { maxLength?: number }).maxLength, 64);
  assert.equal((schema(resources).ttlMs as { maximum?: number }).maximum, 60 * 60 * 1_000);
  assert.equal((schema(resources).startWithinMs as { maximum?: number }).maximum, 5 * 60 * 1_000);
  assert.equal((schema(resources).reason as { maxLength?: number }).maxLength, 240);
  assert.match((schema(resources).reason as { description?: string }).description ?? '', /240 Unicode characters/u);
  assert.match(finish!.promptGuidelines.join(' '), /blocked is a terminal outcome/u);
  assert.equal((schema(resources).confirmStopped as { type?: string }).type, 'boolean');
  assert.equal((schema(resources).timeoutMs as { default?: number }).default, 60_000);
  assert.equal((schema(resources).timeoutMs as { minimum?: number }).minimum, 0);
  assert.equal((schema(resources).timeoutMs as { maximum?: number }).maximum, 300_000);
  assert.equal(schema(resources).waitId, undefined, 'wait IDs are generated privately');
  assert.equal(schema(resources).wake, undefined, 'resource wait cannot wake or acquire a worker');
  for (const tool of all.slice(1)) {
    const properties = schema(tool);
    assert.equal(properties.expectReply, undefined, `${tool.name} has no legacy reply flag`);
    assert.equal(properties.fulfills, undefined, `${tool.name} has no legacy fulfillment list`);
  }
});

test('session_control keeps bucket creation, optional first assignment, settings inheritance surface and lifecycle actions', async () => {
  const calls: ToolCall[] = [];
  const all = toolsFor(async (body) => { calls.push(body as ToolCall); return response(); });
  const control = all[0]!;
  const settings = {
    reasoning: 'low',
    autonomousMode: true,
    subagentProviderChoices: { openai: true },
    disabledSystemPromptEntries: ['entry-a'],
  };

  await invoke(control, { action: 'list' });
  await invoke(control, { action: 'create', title: 'Planner', bucket: 'medium', prompt: 'Own the bounded task.', settings });
  await invoke(control, { action: 'create', title: 'Cold worker', bucket: 'small' });
  await invoke(control, { action: 'read', address: 'session-address' });
  await invoke(control, { action: 'settings.get', address: 'session-address' });
  await invoke(control, { action: 'settings.set', address: 'session-address', settings: { reasoning: 'high' } });
  await invoke(control, { action: 'interrupt', address: 'session-address' });
  await invoke(control, { action: 'close', address: 'session-address' });
  await invoke(control, { action: 'cleanup', dontCloseRunning: true });
  await invoke(control, { action: 'operation.status', requestKey: 'receipt-key' });

  assert.deepEqual(calls.map(withoutRequestKey), [
    { action: 'list', payload: {} },
    { action: 'create', payload: { title: 'Planner', bucket: 'medium', prompt: 'Own the bounded task.', settings } },
    { action: 'create', payload: { title: 'Cold worker', bucket: 'small' } },
    { action: 'read', payload: { address: 'session-address' } },
    { action: 'settings.get', payload: { address: 'session-address' } },
    { action: 'settings.set', payload: { address: 'session-address', settings: { reasoning: 'high' } } },
    { action: 'interrupt', payload: { address: 'session-address' } },
    { action: 'close', payload: { address: 'session-address' } },
    { action: 'cleanup', payload: { dontCloseRunning: true } },
    { action: 'operation.status', payload: { requestKey: 'receipt-key' } },
  ]);
  assert.ok([1, 2, 5, 6, 7, 8].every((index) => mutationKey(calls[index]!)));
  const beforeInvalidCreate = calls.length;
  for (const args of [
    { action: 'create', title: 'No bucket' },
    { action: 'create', title: 'Bad bucket', bucket: 'large' },
    { action: 'create', title: 'Model override', bucket: 'small', settings: { model: { provider: 'openai', id: 'gpt-test' } } },
  ]) {
    await assert.rejects(invoke(control, args));
  }
  assert.equal(calls.length, beforeInvalidCreate, 'invalid bucket/model policy is rejected before IPC');
});

test('notes, assignments, finishes, waits and resource leases use distinct coordinator actions', async () => {
  const calls: ToolCall[] = [];
  const all = toolsFor(async (body) => { calls.push(body as ToolCall); return response(); });
  const [, send, assign, finish, wait, resources] = all;

  await invoke(send!, { target: 'worker-address', message: 'The accepted interface revision is v2.' });
  await invoke(assign!, { target: 'worker-address', prompt: 'Implement the bounded task.', taskId: 'task-1', revision: 2 });
  await invoke(finish!, { taskId: 'task-1', revision: 2, outcome: 'completed', result: 'Implemented and verified.' });
  await invoke(wait!, {});
  await invoke(wait!, { taskIds: ['task-1'], afterRevision: 1, timeoutMs: 0 });
  await invoke(resources!, { action: 'status', name: 'checkout:pie' });
  await invoke(resources!, { action: 'acquire', name: 'checkout:pie', purpose: 'Run whole-repository snapshot checks.', mode: 'exclusive', ttlMs: 30_000, startWithinMs: 5_000 });
  await invoke(resources!, { action: 'start', leaseId: 'lease-1' });
  await invoke(resources!, { action: 'renew', leaseId: 'lease-1', ttlMs: 30_000 });
  await invoke(resources!, { action: 'release', leaseId: 'lease-1' });
  await invoke(resources!, { action: 'reclaim', leaseId: 'lease-1', reason: 'verified stopped', confirmStopped: true });
  const resourceWait = await invoke(resources!, { action: 'wait', name: 'gpu:0', mode: 'exclusive', timeoutMs: 0 });

  assert.deepEqual(calls.map(withoutRequestKey), [
    { action: 'note', payload: { target: 'worker-address', message: 'The accepted interface revision is v2.' } },
    { action: 'task.assign', payload: { target: 'worker-address', prompt: 'Implement the bounded task.', taskId: 'task-1', revision: 2 } },
    { action: 'task.finish', payload: { taskId: 'task-1', revision: 2, outcome: 'completed', result: 'Implemented and verified.' } },
    { action: 'wait', payload: { timeoutMs: 60_000, waitId: calls[3]?.payload.waitId } },
    { action: 'wait', payload: { taskIds: ['task-1'], afterRevision: 1, timeoutMs: 0, waitId: calls[4]?.payload.waitId } },
    { action: 'resources', payload: { action: 'status', name: 'checkout:pie' } },
    { action: 'resources', payload: { action: 'acquire', name: 'checkout:pie', purpose: 'Run whole-repository snapshot checks.', mode: 'exclusive', ttlMs: 30_000, startWithinMs: 5_000 } },
    { action: 'resources', payload: { action: 'start', leaseId: 'lease-1' } },
    { action: 'resources', payload: { action: 'renew', leaseId: 'lease-1', ttlMs: 30_000 } },
    { action: 'resources', payload: { action: 'release', leaseId: 'lease-1' } },
    { action: 'resources', payload: { action: 'reclaim', leaseId: 'lease-1', reason: 'verified stopped', confirmStopped: true } },
    { action: 'resources', payload: { action: 'wait', name: 'gpu:0', mode: 'exclusive', timeoutMs: 0, waitId: calls[11]?.payload.waitId } },
  ]);
  assert.equal(typeof calls[3]?.payload.waitId, 'string');
  assert.equal(typeof calls[4]?.payload.waitId, 'string');
  assert.equal(typeof calls[11]?.payload.waitId, 'string');
  assert.equal(calls[11]?.payload.requestKey, undefined, 'resource wait is a subscription, not a mutation receipt');
  assert.equal(calls[11]?.payload.wake, undefined, 'resource wait has no worker wake flag');
  assert.equal((resourceWait.details as Record<string, unknown>).wake, undefined);
  assert.ok([0, 1, 6, 7, 8, 9, 10].every((index) => mutationKey(calls[index]!)));
  assert.equal(calls[2]?.payload.requestKey, undefined);
  assert.equal(calls[3]?.payload.requestKey, undefined);
  assert.equal(calls[4]?.payload.requestKey, undefined);
});

test('SDK validation accepts lifecycle calls without unrelated optional fields', () => {
  const control = createSessionCollaborationTools(async () => response()).find(tool => tool.name === 'session_control');
  assert.ok(control);
  for (const args of [
    { action: 'list' },
    { action: 'create', title: 'cold-peer', bucket: 'small' },
    { action: 'close', self: true },
    { action: 'settings.get', self: true },
    { action: 'settings.set', self: true, settings: { model: { provider: 'openai-codex', id: 'gpt-6-luna' } } },
  ]) {
    assert.deepEqual(validateToolArguments(control, {
      type: 'toolCall', id: 'schema-boundary', name: control.name, arguments: args,
    }), args);
  }
});

test('uncertain mutation acknowledgements return lookup evidence; known rejections stay known', async () => {
  const sent: ToolCall[] = [];
  const tools = toolsFor(async (body) => {
    sent.push(body as ToolCall);
    throw new Error('transport closed');
  });
  const assign = tools[2]!;
  await assert.rejects(invoke(assign, { target: 'worker', prompt: 'Inspect this module.' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const detail = JSON.parse(error.message) as Record<string, unknown>;
    assert.equal(detail.outcome, 'unknown');
    assert.equal(detail.requestKey, sent[0]?.payload.requestKey);
    assert.deepEqual(detail.lookup, { action: 'operation.status', requestKey: detail.requestKey });
    assert.match(String(detail.guidance), /do not repeat the assignment/u);
    return true;
  });

  const known = toolsFor(async () => ({
    kind: 'session.control.result', requestId: 'response', ok: false,
    error: { code: 'SESSION_CONTROL_FAILED', message: 'Worker already owns a different task.', retryable: false },
  } as CoordinatorToWorkerResponseFrame));
  await assert.rejects(invoke(known[2]!, { target: 'worker', prompt: 'second task' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    const detail = JSON.parse(error.message) as Record<string, unknown>;
    assert.equal(detail.outcome, undefined);
    assert.match(String(detail.requestKey), /^\d+:[0-9a-f-]{36}$/u);
    assert.equal(detail.lookup, undefined);
    assert.match(String(detail.error), /already owns/u);
    return true;
  });
});

test('session_wait sends wait.cancel after an abort that races an active wait', async () => {
  const calls: ToolCall[] = [];
  let activeSubscription = false;
  let cancellationSent!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancellationSent = resolve; });
  const request: SessionControlToolRequest = async (body, signal) => {
    const call = body as ToolCall;
    calls.push(call);
    if (call.action === 'wait.cancel') {
      activeSubscription = false;
      cancellationSent();
      return response({ cancelled: true });
    }
    if (call.action === 'wait') {
      activeSubscription = true;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('wait aborted')), { once: true });
      });
    }
    return response();
  };
  const controller = new AbortController();
  const pending = invoke(toolsFor(request)[4]!, { timeoutMs: 60_000 }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending);
  await cancelled;
  assert.equal(activeSubscription, false);
  assert.equal(calls[0]?.action, 'wait');
  assert.equal(calls[1]?.action, 'wait.cancel');
  assert.equal(calls[1]?.payload.waitId, calls[0]?.payload.waitId);
});

test('session_wait cancels even when the abort signal was already set before execute', async () => {
  const calls: ToolCall[] = [];
  let activeSubscription = false;
  let cancellationSent!: () => void;
  const cancelled = new Promise<void>((resolve) => { cancellationSent = resolve; });
  const request: SessionControlToolRequest = async (body, signal) => {
    const call = body as ToolCall;
    calls.push(call);
    if (call.action === 'wait.cancel') {
      activeSubscription = false;
      cancellationSent();
      return response({ cancelled: true });
    }
    if (call.action === 'wait') {
      // Model a subscription admitted at the coordinator before the cancelled
      // transport is observed, which must be cleaned up with wait.cancel.
      activeSubscription = true;
      if (signal?.aborted) throw new Error('wait request aborted after admission');
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('wait request aborted')), { once: true });
      });
    }
    return response();
  };
  const controller = new AbortController();
  controller.abort();
  const pending = invoke(toolsFor(request)[4]!, { timeoutMs: 60_000 }, controller.signal);
  await assert.rejects(pending);
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('wait.cancel was not sent')), 100))]);
  assert.equal(activeSubscription, false);
  assert.equal(calls.length, 1, 'an already-aborted wait is never registered');
  assert.equal(calls[0]?.action, 'wait.cancel');
  assert.equal(typeof calls[0]?.payload.waitId, 'string');
});

test('resource wait cancels the coordinator subscription when its signal aborts', async () => {
  const calls: ToolCall[] = [];
  let activeSubscription = false;
  let cancellationSent!: () => void;
  const cancelled = new Promise<void>(resolve => { cancellationSent = resolve; });
  const request: SessionControlToolRequest = async (body, signal) => {
    const call = body as ToolCall;
    calls.push(call);
    if (call.action === 'wait.cancel') {
      activeSubscription = false;
      cancellationSent();
      return response({ cancelled: true });
    }
    if (call.action === 'resources' && call.payload.action === 'wait') {
      activeSubscription = true;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('resource wait aborted')), { once: true });
      });
    }
    return response();
  };
  const controller = new AbortController();
  const pending = invoke(toolsFor(request)[5]!, { action: 'wait', name: 'gpu:0', timeoutMs: 60_000 }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending);
  await cancelled;
  assert.equal(activeSubscription, false);
  assert.equal(calls[0]?.action, 'resources');
  assert.equal(calls[0]?.payload.action, 'wait');
  assert.equal(calls[1]?.action, 'wait.cancel');
  assert.equal(calls[1]?.payload.waitId, calls[0]?.payload.waitId);
  assert.equal(calls[0]?.payload.requestKey, undefined);
  assert.equal(calls[1]?.payload.requestKey, undefined);
  assert.equal(calls[0]?.payload.wake, undefined);
});

test('resource wait cancels even when its abort signal is set before execute', async () => {
  const calls: ToolCall[] = [];
  let cancellationSent!: () => void;
  const cancelled = new Promise<void>(resolve => { cancellationSent = resolve; });
  const request: SessionControlToolRequest = async body => {
    const call = body as ToolCall;
    calls.push(call);
    if (call.action === 'wait.cancel') {
      cancellationSent();
      return response({ cancelled: true });
    }
    return response();
  };
  const controller = new AbortController();
  controller.abort();
  const pending = invoke(toolsFor(request)[5]!, { action: 'wait', name: 'gpu:0' }, controller.signal);
  await assert.rejects(pending, /aborted before registration/u);
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('wait.cancel was not sent')), 100))]);
  assert.equal(calls.length, 1, 'an already-aborted resource wait is never registered');
  assert.equal(calls[0]?.action, 'wait.cancel');
  assert.equal(typeof calls[0]?.payload.waitId, 'string');
});
