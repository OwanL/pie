import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import pngjs from 'pngjs';

import registerComputer from '../index.js';
import { runtimeRegistry } from '../src/runtime-client.js';

const { PNG } = pngjs;

function registeredTool(): any {
  let tool: any;
  registerComputer({ registerTool(value: any) { tool = value; }, on() {} } as any);
  return tool;
}

async function withFakeClient<T>(client: any, run: (tool: any) => Promise<T>): Promise<T> {
  const registry = runtimeRegistry as any; const originalGet = registry.get; const originalPeek = registry.peek;
  registry.get = async () => client; registry.peek = async () => client;
  try { return await run(registeredTool()); }
  finally { registry.get = originalGet; registry.peek = originalPeek; }
}

const context = { sessionManager: { getSessionFile: () => '/tmp/computer-extension-fake.jsonl' }, model: { input: ['text'] } };

test('package pins exact native/image dependencies and exposes one computer extension', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies, {
    '@computer-use/nut-js': '4.2.0', '@trycua/cua-driver': '0.12.5', pngjs: '7.0.0',
  });
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
});

test('extension registers exactly one sequential computer tool and session-owned shutdown', () => {
  const tools: any[] = []; const handlers = new Map<string, Function>();
  registerComputer({ registerTool(tool: any) { tools.push(tool); }, on(name: string, handler: Function) { handlers.set(name, handler); } } as any);
  assert.equal(tools.length, 1); assert.equal(tools[0].name, 'computer'); assert.equal(tools[0].executionMode, 'sequential');
  assert.deepEqual(tools[0].parameters.properties.action.enum, ['open', 'observe', 'act', 'run_sequence', 'close']);
  // The newest-three image projection is now owned by the generic
  // image-context-guard extension (it reuses projectComputerImageContext from
  // src/context.ts, still unit-tested in context.test.ts). computer-use no
  // longer registers its own `context` handler, so the two limits are never
  // enforced by two independently ordered handlers.
  assert.equal(handlers.has('context'), false);
  assert.ok(handlers.has('session_shutdown'));
});

test('repeated module evaluations install process teardown only once', () => {
  // The pi loader re-evaluates the extension module on every session create; the
  // install-once flag must survive re-evaluation or exit/beforeExit listeners
  // accumulate (MaxListenersExceededWarning). Earlier tests may already have
  // installed teardown, so assert the invariant: a first load adds at most one
  // listener per signal and further loads add none.
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

test('disabled and validation failures reject with bounded computer errors instead of pseudo-error results', async () => {
  const tool = registeredTool(); const previous = process.env.PIE_EXTENSION_TOGGLES_JSON;
  process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify({ 'computer-use': false });
  try {
    await assert.rejects(
      () => tool.execute('x', { action: 'open', selector: { kind: 'desktop' } }, undefined, undefined, context),
      (error: any) => error.code === 'EXTENSION_DISABLED' && /^computer error \[EXTENSION_DISABLED\]:/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.PIE_EXTENSION_TOGGLES_JSON; else process.env.PIE_EXTENSION_TOGGLES_JSON = previous;
  }
  await assert.rejects(
    () => tool.execute('x', { action: 'act', sessionId: 's' }, undefined, undefined, context),
    (error: any) => error.code === 'INVALID_ARGUMENTS' && error.name === 'ComputerToolError',
  );
});

test('runtime failures reject with retryability and artifact metadata', async () => {
  const runtimeError = Object.assign(new Error('injected runtime failure'), {
    code: 'REQUEST_FAILED', retryable: true, artifacts: { sequencePath: '/tmp/sequence.json', tracePath: '/tmp/trace.json' },
  });
  const client = {
    async releaseAllHeldKnown() {},
    async request() { throw runtimeError; },
  };
  await withFakeClient(client, async (tool) => {
    await assert.rejects(
      () => tool.execute('x', { action: 'observe', sessionId: 's' }, undefined, undefined, context),
      (error: any) => error.code === 'REQUEST_FAILED' && error.retryable === true
        && error.artifacts.sequencePath === '/tmp/sequence.json' && /^computer error \[REQUEST_FAILED\]:/.test(error.message),
    );
  });
});

test('cleanup failures reject with both cleanup and original causes', async () => {
  let cleanupCalls = 0;
  const client = {
    async releaseAllHeldKnown() {
      cleanupCalls += 1;
      throw Object.assign(new Error('emergency release remained incomplete'), { code: 'RELEASE_FAILED', retryable: true });
    },
    async request() { throw Object.assign(new Error('action failed'), { code: 'REQUEST_FAILED' }); },
  };
  await withFakeClient(client, async (tool) => {
    await assert.rejects(
      () => tool.execute('x', { action: 'act', sessionId: 's', input: { kind: 'text', text: 'x' } }, undefined, undefined, context),
      (error: any) => error.code === 'RELEASE_FAILED' && error.retryable === true
        && /cleanup failed/i.test(error.message) && /original failure \[REQUEST_FAILED\]: action failed/.test(error.message),
    );
  });
  assert.equal(cleanupCalls, 1);
});

test('failed emergency ownership cleanup prevents extension open and close requests and rejects', async () => {
  for (const params of [
    { action: 'open', selector: { kind: 'desktop' }, sessionId: 'new' },
    { action: 'close', sessionId: 'held' },
  ]) {
    const requests: string[] = []; let cleanupCalls = 0;
    const client = {
      async releaseAllHeldKnown() {
        cleanupCalls += 1;
        throw Object.assign(new Error('held W survived emergency release'), { code: 'RELEASE_FAILED', retryable: true });
      },
      async request(method: string) { requests.push(method); return {}; },
      markReopened() {},
    };
    await withFakeClient(client, async (tool) => {
      await assert.rejects(
        () => tool.execute('x', params, undefined, undefined, context),
        (error: any) => error.code === 'RELEASE_FAILED' && /^computer error \[RELEASE_FAILED\]:/.test(error.message),
      );
    });
    assert.deepEqual(requests, [], `${params.action} was not sent`);
    assert.equal(cleanupCalls, 2, 'execute retries bounded cleanup in its catch and reports that failure');
  }
});

test('open delivers an inline observation image exactly like observe for image-capable models', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-ext-open-image-'));
  const pngPath = path.join(dir, 'open.png');
  await writeFile(pngPath, PNG.sync.write(new PNG({ width: 2, height: 2 })));
  const imageContext = { sessionManager: { getSessionFile: () => path.join(dir, 'session.jsonl') }, model: { input: ['text', 'image'] } };
  const client = {
    async releaseAllHeldKnown() {},
    async request(method: string) {
      if (method === 'open') return { sessionId: 's', targetId: 'window:1:2', displayImagePath: pngPath, revision: 1, accessibilityAvailable: true };
      return {};
    },
    markReopened() {},
  };
  await withFakeClient(client, async (tool) => {
    const result: any = await tool.execute('x', { action: 'open', selector: { kind: 'foreground' }, screenshot: true }, undefined, undefined, imageContext);
    assert.equal(result.isError, false);
    assert.ok(result.content.some((part: any) => part.type === 'image'), 'image part is delivered for an image-capable model');
  });
});

test('open with a screenshot and a text-only model emits the image_delivery unavailable notice', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-ext-open-text-'));
  const pngPath = path.join(dir, 'open.png');
  const textContext = { sessionManager: { getSessionFile: () => path.join(dir, 'session.jsonl') }, model: { input: ['text'] } };
  const client = {
    async releaseAllHeldKnown() {},
    async request(method: string) {
      if (method === 'open') return { sessionId: 's', targetId: 'window:1:2', displayImagePath: pngPath, revision: 1, accessibilityAvailable: true };
      return {};
    },
    markReopened() {},
  };
  await withFakeClient(client, async (tool) => {
    const result: any = await tool.execute('x', { action: 'open', selector: { kind: 'foreground' }, screenshot: true }, undefined, undefined, textContext);
    assert.equal(result.isError, false);
    assert.equal(result.content.some((part: any) => part.type === 'image'), false, 'no image part for a text-only model');
    assert.match(result.content[0].text, /image_delivery: unavailable/);
    assert.match(result.content[0].text, /delegate the artifact with modelRequirements\.inputKinds=\["image"\]/);
  });
});
