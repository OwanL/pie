import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import registerPlaywright from '../index.js';
import { runtimeRegistry } from '../src/runtime-client.js';
import type { RuntimeResponse } from '../src/types.js';

function registeredTool(): Record<string, any> {
  let tool: Record<string, any> | undefined;
  registerPlaywright({
    registerTool(value: Record<string, any>) { tool = value; },
    on() {},
  } as never);
  return tool!;
}

async function withFakeClient<T>(client: unknown, run: (tool: Record<string, any>) => Promise<T>): Promise<T> {
  const registry = runtimeRegistry as unknown as { get(): Promise<unknown>; peek(): Promise<unknown> };
  const originalGet = registry.get; const originalPeek = registry.peek;
  registry.get = async () => client; registry.peek = async () => client;
  try { return await run(registeredTool()); }
  finally { registry.get = originalGet; registry.peek = originalPeek; }
}

const context = { sessionManager: { getSessionFile: () => '/tmp/pw-extension-fake.jsonl' }, model: { input: ['text'] } };

test('package pins the exact Playwright runtime and exposes exactly one extension entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies, { playwright: '1.62.1', pngjs: '7.0.0' });
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
});

test('extension registers one sequential playwright tool and session-owned shutdown', () => {
  const tools: unknown[] = []; const handlers = new Map<string, unknown>();
  registerPlaywright({
    registerTool(tool: unknown) { tools.push(tool); },
    on(name: string, handler: unknown) { handlers.set(name, handler); },
  } as never);
  assert.equal(tools.length, 1);
  const tool = tools[0] as Record<string, any>;
  assert.equal(tool.name, 'playwright');
  assert.equal(tool.executionMode, 'sequential');
  assert.deepEqual(tool.parameters.properties.action.enum, ['open', 'observe', 'act', 'run_code', 'close']);
  assert.ok(typeof tool.promptSnippet === 'string' && tool.promptSnippet.length > 0);
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 5, 'metadata must be sufficient for basic operation without the skill');
  assert.ok(!handlers.has('context'), 'playwright relies on the generic image-context-guard for image projection');
  assert.ok(handlers.has('session_shutdown'));
});

test('repeated module evaluations install process teardown only once', () => {
  const exitBefore = process.listenerCount('exit');
  const beforeExitBefore = process.listenerCount('beforeExit');
  registeredTool();
  const exitAfterFirst = process.listenerCount('exit');
  const beforeExitAfterFirst = process.listenerCount('beforeExit');
  registeredTool();
  registeredTool();
  assert.equal(process.listenerCount('exit'), exitAfterFirst);
  assert.equal(process.listenerCount('beforeExit'), beforeExitAfterFirst);
  assert.ok(exitAfterFirst - exitBefore <= 1);
  assert.ok(beforeExitAfterFirst - beforeExitBefore <= 1);
});

test('the disabled extension fails with EXTENSION_DISABLED', async () => {
  const tool = registeredTool();
  const previous = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  process.env['PIE_EXTENSION_TOGGLES_JSON'] = JSON.stringify({ playwright: false });
  try {
    await assert.rejects(
      () => tool.execute('x', { action: 'open' }, undefined, undefined, context),
      (error: unknown) => (error as { code?: string }).code === 'EXTENSION_DISABLED' && /^playwright error \[EXTENSION_DISABLED\]:/.test((error as Error).message),
    );
  } finally {
    if (previous === undefined) delete process.env['PIE_EXTENSION_TOGGLES_JSON']; else process.env['PIE_EXTENSION_TOGGLES_JSON'] = previous;
  }
});

test('missing pie session path fails with SESSION_PATH_REQUIRED', async () => {
  const tool = registeredTool();
  await assert.rejects(
    () => tool.execute('x', { action: 'open' }, undefined, undefined, { sessionManager: { getSessionFile: () => undefined }, model: { input: ['text'] } } as never),
    (error: unknown) => (error as { code?: string }).code === 'SESSION_PATH_REQUIRED',
  );
});

test('invalid params fail with INVALID_ARGUMENTS before any runtime work', async () => {
  const tool = registeredTool();
  await assert.rejects(
    () => tool.execute('x', { action: 'act', sessionId: 's', input: { kind: 'click', target: { selector: 'aria-ref=e1' } } }, undefined, undefined, context),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENTS' && /aria-ref/.test((error as Error).message),
  );
});

test('open wires sessionId and artifactDir through, marks reopen, and returns a bounded result', async () => {
  const calls: unknown[] = [];
  const fakeClient = {
    async request(method: string, params: unknown, options: unknown) {
      calls.push({ method, params, options });
      const result: RuntimeResponse = {
        sessionId: (params as { sessionId: string }).sessionId,
        headless: true, isolated: true,
        observation: {
          pageId: 'p1', url: 'https://example.test/', title: 'Example', revision: 1,
          snapshot: '- heading "Example" [ref=e2]',
          events: { console: [], pageErrors: [], failedRequests: [], downloads: [], dropped: { console: 0, pageErrors: 0, failedRequests: 0, downloads: 0 } },
          tabs: [{ pageId: 'p1', url: 'https://example.test/', title: 'Example', active: true }],
        },
      };
      return result;
    },
    markReopened() { calls.push('markReopened'); },
  };
  const result = await withFakeClient(fakeClient, async (tool) => {
    return await tool.execute('x', { action: 'open', url: 'https://example.test/' }, undefined, undefined, context);
  });
  const request = calls[0] as { method: string; params: { sessionId: string; artifactDir: string; url: string }; options: { allowNeedsReopen?: boolean } };
  assert.equal(request.method, 'open');
  assert.match(request.params.sessionId, /^pw-/);
  assert.ok(request.params.artifactDir.includes('playwright'));
  assert.equal(request.options.allowNeedsReopen, true);
  assert.ok(calls.includes('markReopened'));
  const text = (result as { content: Array<{ type: string; text?: string }> }).content[0].text!;
  assert.match(text, /playwright open: ok/);
  assert.match(text, /snapshot:/);
});

test('close can target runtime scope even after runtime loss', async () => {
  const fakeClient = {
    async request() { return { closed: { scope: 'runtime', sessionIds: [] } } satisfies RuntimeResponse as RuntimeResponse; },
    markReopened() {},
  };
  const result = await withFakeClient(fakeClient, async (tool) => {
    return await tool.execute('x', { action: 'close', scope: 'runtime' }, undefined, undefined, context);
  });
  const text = (result as { content: Array<{ text?: string }> }).content[0].text!;
  assert.match(text, /closed_runtime: \(no live sessions\)/);
});

test('session_shutdown shuts down only the owning runtime', async () => {
  const handlers = new Map<string , (event: unknown, ctx: unknown) => Promise<void>>();
  registerPlaywright({
    registerTool() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) { handlers.set(name, handler); },
  } as never);
  const shutdowns: string[] = [];
  const registry = runtimeRegistry as unknown as { shutdownSession(path: string): Promise<void> };
  const original = registry.shutdownSession;
  registry.shutdownSession = async (path: string) => { shutdowns.push(path); };
  try {
    await handlers.get('session_shutdown')!(undefined, { sessionManager: { getSessionFile: () => 'C:/sessions/chat.jsonl' } });
  } finally {
    registry.shutdownSession = original;
  }
  assert.deepEqual(shutdowns, ['C:/sessions/chat.jsonl']);
});
