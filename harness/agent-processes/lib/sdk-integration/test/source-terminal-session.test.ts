import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentEvent, AgentMessage } from '../../../../pi/packages/agent/dist/types.js';
import type { AssistantMessage } from '../../../../pi/packages/ai/dist/types.js';
import type { AgentSessionEvent } from '../../../../pi/packages/coding-agent/dist/core/agent-session.js';
import { sourceFixture } from './source-fixture.js';

// Never use loadSdk: these tests exercise only the privately built source graph.
const { piRoot, packageRoots } = sourceFixture;
const codingEntry = path.join(packageRoots.codingAgent, 'dist/core/agent-session.js');
const corePackages = {
  'pi-ai': packageRoots.ai,
  'pi-agent-core': packageRoots.agent,
  'pi-tui': packageRoots.tui,
  'pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);
const graphRoot = realpathSync(piRoot);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    const result = nextResolve(specifier, context);
    for (const [name, dir] of Object.entries(corePackages)) {
      const packageName = `@earendil-works/${name}`;
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
      const resolved = realpathSync(fileURLToPath(result.url));
      assert.ok(isWithin(resolved, dir), `Core graph escape: ${resolved}`);
      return result;
    }

    // Constrain ordinary imports made by the SDK artifact while leaving
    // test-runner/tooling resolution outside that graph untouched.
    const parent = context.parentURL?.startsWith('file:')
      ? realpathSync(fileURLToPath(context.parentURL))
      : undefined;
    if (parent !== undefined && isWithin(parent, graphRoot)) {
      assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
      const resolved = realpathSync(fileURLToPath(result.url));
      // TSX may resolve declaration-only tooling imports from the host install;
      // they are not part of the SDK runtime artifact graph.
      if (!resolved.endsWith('.d.ts')) {
        assert.ok(isWithin(resolved, graphRoot), `Core runtime graph escape for ${specifier}: ${resolved}`);
      }
    }
    return result;
  },
});
const candidate = (async () => {
  const { AgentSession } = await import(pathToFileURL(codingEntry).href);
  const { Agent } = await import(pathToFileURL(path.join(packageRoots.agent, 'dist/index.js')).href);
  const { EventStream, getModel } = await import(pathToFileURL(path.join(packageRoots.ai, 'dist/compat.js')).href);
  const { SessionManager } = await import(pathToFileURL(path.join(packageRoots.codingAgent, 'dist/core/session-manager.js')).href);
  const { SettingsManager } = await import(pathToFileURL(path.join(packageRoots.codingAgent, 'dist/core/settings-manager.js')).href);
  const { AuthStorage } = await import(pathToFileURL(path.join(packageRoots.codingAgent, 'dist/core/auth-storage.js')).href);
  const { ModelRegistry } = await import(pathToFileURL(path.join(packageRoots.codingAgent, 'dist/core/model-registry.js')).href);
  const { createExtensionRuntime, loadExtensionFromFactory } = await import(pathToFileURL(path.join(packageRoots.codingAgent, 'dist/core/extensions/loader.js')).href);
  return { AgentSession, Agent, EventStream, getModel, SessionManager, SettingsManager, AuthStorage, ModelRegistry, createExtensionRuntime, loadExtensionFromFactory };
})();

function assistant(content: AssistantMessage['content'] = [{ type: 'text', text: 'answer' }], tokens = 0): AssistantMessage {
  return {
    role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
    stopReason: 'stop', timestamp: Date.now(),
    usage: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, totalTokens: tokens * 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

type ExtensionEvent = { type: 'message_end'; message: AgentMessage };
async function fixture(t: test.TestContext, onEnd?: (event: ExtensionEvent) => unknown) {
  const { AgentSession, Agent, getModel, SessionManager, SettingsManager, AuthStorage, ModelRegistry, createExtensionRuntime, loadExtensionFromFactory } = await candidate;
  const cwd = mkdtempSync(path.join(tmpdir(), 'pie-source-terminal-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    (api: { on: (name: string, handler: (event: ExtensionEvent) => unknown) => void }) => {
      api.on('message_end', onEnd ?? (() => undefined));
    }, cwd, undefined, runtime, '<source-terminal-test>',
  );
  const resourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'offline test', getAppendSystemPrompt: () => [],
  };
  const agent = new Agent({
    initialState: { model: getModel('anthropic', 'claude-sonnet-4-5'), tools: [] },
    streamFn: () => { throw new Error('Inference forbidden in source terminal tests'); },
  });
  const manager = SessionManager.create(cwd, cwd);
  // Existing upstream buffering before the first assistant is outside this slice.
  manager.appendMessage(assistant());
  const auth = AuthStorage.inMemory();
  auth.setRuntimeApiKey('anthropic', 'offline-fixture');
  const session = new AgentSession({ agent, sessionManager: manager, cwd, resourceLoader,
    baseToolsOverride: {}, modelRegistry: ModelRegistry.create(auth, cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }),
  });
  t.after(() => session.dispose());
  const handle = (event: AgentEvent): Promise<void> => session._handleAgentEvent(event);
  return { session, manager, agent, handle };
}

for (const tokens of [0, 12]) {
  test(`reasoning-only stop is retryable before extension observation, usage=${tokens}`, async (t) => {
    const message = assistant([{ type: 'thinking', thinking: 'unfinished' }, { type: 'text', text: '  ' }], tokens);
    const order: string[] = [];
    const f = await fixture(t, (event) => {
      order.push('extension');
      assert.equal(event.message, message);
      assert.equal((event.message as AssistantMessage).stopReason, 'error');
      assert.match((event.message as AssistantMessage).errorMessage!, /Stream ended before a terminal response event/);
      assert.equal('sessionEntryId' in event, false);
    });
    f.agent.state.messages.push(message);
    f.session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== 'message_end') return;
      order.push('listener');
      assert.equal(event.message, message);
      assert.equal(f.manager.getEntry(event.sessionEntryId).message, message);
    });
    await f.handle({ type: 'message_end', message });
    assert.deepEqual(order, ['extension', 'listener']);
    assert.equal(f.agent.state.messages[0], message);
    assert.equal(f.session._isRetryableError(message), true);
    let willRetry: boolean | undefined;
    f.session.subscribe((event: AgentSessionEvent) => { if (event.type === 'agent_end') willRetry = event.willRetry; });
    await f.handle({ type: 'agent_end', messages: [message] });
    assert.equal(willRetry, true);
  });
}

test('ordinary terminal content and stop reasons retain upstream semantics', async (t) => {
  const f = await fixture(t);
  const cases = [
    assistant([{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }]),
    assistant([{ type: 'thinking', thinking: 'reason' }, { type: 'toolCall', id: 't', name: 'test', arguments: {} }]),
    assistant([]), assistant([{ type: 'thinking', thinking: '  ' }]),
    { ...assistant([{ type: 'thinking', thinking: 'reason' }]), stopReason: 'length' as const },
    { ...assistant([{ type: 'thinking', thinking: 'reason' }]), stopReason: 'aborted' as const },
    { ...assistant([{ type: 'thinking', thinking: 'reason' }]), stopReason: 'error' as const, errorMessage: 'original' },
  ];
  for (const message of cases) {
    const before = structuredClone(message);
    await f.handle({ type: 'message_end', message });
    assert.deepEqual(message, before);
  }
});

test('append completes before terminal listener and publishes the durable entry identity for each persisted role', async (t) => {
  const order: string[] = [];
  const f = await fixture(t, () => { order.push('extension'); });
  for (const method of ['appendMessage', 'appendCustomMessageEntry']) {
    const append = f.manager[method].bind(f.manager);
    f.manager[method] = (...args: unknown[]) => {
      order.push('append:start');
      const id = append(...args);
      order.push('append:done');
      return id;
    };
  }
  f.session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== 'message_end') return;
    order.push('listener');
    assert.equal(typeof event.sessionEntryId, 'string');
    const persisted = readFileSync(f.manager.getSessionFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(persisted.at(-1).id, event.sessionEntryId);
    assert.equal(f.manager.getLeafId(), event.sessionEntryId);
  });
  const messages: AgentMessage[] = [
    assistant(), { role: 'user', content: 'hello', timestamp: 1 },
    { role: 'toolResult', toolCallId: 't', toolName: 'test', content: [], isError: false, timestamp: 2 },
    { role: 'custom', customType: 'notice', content: 'custom', display: true, details: {}, timestamp: 3 },
  ];
  for (const message of messages) {
    order.length = 0;
    await f.handle({ type: 'message_end', message });
    assert.deepEqual(order, ['extension', 'append:start', 'append:done', 'listener']);
  }
});

for (const custom of [false, true]) {
  test(`failed ${custom ? 'custom' : 'regular'} append emits no terminal listener notification`, async (t) => {
    const f = await fixture(t);
    const events: AgentSessionEvent[] = [];
    f.session.subscribe((event: AgentSessionEvent) => events.push(event));
    // Fail inside the real append path, at persistence, rather than replacing the handler.
    f.manager._persist = () => { throw new Error('fixture disk failure'); };
    const message: AgentMessage = custom
      ? { role: 'custom', customType: 'notice', content: 'custom', display: true, timestamp: 1 }
      : assistant();
    await assert.rejects(f.handle({ type: 'message_end', message }), /fixture disk failure/);
    assert.deepEqual(events, []);
  });
}

test('nonterminal and already-persisted role notifications keep their original payloads', async (t) => {
  const f = await fixture(t);
  const events: AgentSessionEvent[] = [];
  f.session.subscribe((event: AgentSessionEvent) => events.push(event));
  const start: AgentEvent = { type: 'message_start', message: assistant() };
  const end: AgentEvent = { type: 'message_end', message: {
    role: 'bashExecution', command: 'fixture', output: 'offline', exitCode: 0, cancelled: false, truncated: false, timestamp: 1,
  } };
  const count = f.manager.getEntries().length;
  await f.handle(start);
  await f.handle(end);
  assert.equal(events[0], start);
  assert.equal(events[1], end);
  assert.equal('sessionEntryId' in events[1], false);
  assert.equal(f.manager.getEntries().length, count);
});

test('extension replacement remains in place and is what gets persisted and published', async (t) => {
  const message = assistant([{ type: 'thinking', thinking: 'unfinished' }]);
  const f = await fixture(t, (event) => ({ message: { ...event.message, content: [{ type: 'text', text: 'extension answer' }], stopReason: 'stop' } }));
  let observed: AgentMessage | undefined;
  f.session.subscribe((event: AgentSessionEvent) => { if (event.type === 'message_end') observed = event.message; });
  await f.handle({ type: 'message_end', message });
  assert.equal(observed, message);
  assert.equal(message.stopReason, 'stop');
  assert.deepEqual(message.content, [{ type: 'text', text: 'extension answer' }]);
  assert.equal(f.manager.getEntry(f.manager.getLeafId()).message, message);
});

test('real agent loop retries malformed success and settles after a visible answer', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const { EventStream } = await candidate;
  f.agent.streamFn = () => {
    const stream = new EventStream((event: { type: string }) => event.type === 'done', (event: { message: AssistantMessage }) => event.message);
    const message = ++calls === 1 ? assistant([{ type: 'thinking', thinking: 'unfinished' }], 12) : assistant();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
    });
    return stream;
  };
  const events: AgentSessionEvent[] = [];
  f.session.subscribe((event: AgentSessionEvent) => events.push(event));
  await f.session.prompt('offline fixture');
  assert.equal(calls, 2);
  assert.deepEqual(events.filter((e) => e.type === 'agent_end').map((e) => e.willRetry), [true, false]);
  assert.deepEqual(events.filter((e) => e.type === 'auto_retry_end').map((e) => e.success), [true]);
  assert.equal(events.at(-1)?.type, 'agent_settled');
  const persisted = f.manager.getEntries().filter((e: { type: string; message?: AgentMessage }) => e.type === 'message' && e.message?.role === 'assistant');
  assert.deepEqual(persisted.slice(-2).map((e: { message: AssistantMessage }) => e.message.stopReason), ['error', 'stop']);
});
