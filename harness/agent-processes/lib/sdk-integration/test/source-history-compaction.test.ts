import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompactionHooks, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { consumedOverflowMessageEntryIds, isEstimatedContextOverflowMessage } from '../../../workers/history-compaction';

// Load only the privately compiled source candidate. The resolver rejects any
// package escape or non-file runtime import; fixtures replace provider streams.
import { sourceFixture } from './source-fixture.js';
const { piRoot, packageRoots } = sourceFixture;
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const packageRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(packageRoot, `Unapproved private SDK package import: ${specifier}`);
      const subpath = specifier.slice(packageName!.length).replace(/^\//u, '');
      const target = subpath === 'package.json'
        ? path.join(packageRoot!, 'package.json')
        : path.join(packageRoot!, 'dist', subpath ? `${subpath.replace(/\.js$/u, '')}.js` : 'index.js');
      const resolved = realpathSync(target);
      assert.ok(isWithin(resolved, packageRoot!), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return nextResolve(pathToFileURL(resolved).href, context);
    }

    const result = nextResolve(specifier, context);
    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = realpathSync(fileURLToPath(result.url));
    assert.ok(isWithin(resolved, realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

const sourceModules = (async () => {
  const coding = packageRoots.codingAgent;
  const [{ Agent }, { EventStream, getModel }, { AgentSession }, { convertToLlm }, { SessionManager }, { SettingsManager },
    { AuthStorage }, { ModelRegistry }, { createExtensionRuntime, loadExtensionFromFactory }, { prepareCompaction }, { compact },
    { createAgentSessionFromServices }] = await Promise.all([
    import(pathToFileURL(path.join(packageRoots.agent, 'dist/index.js')).href),
    import(pathToFileURL(path.join(packageRoots.ai, 'dist/compat.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/agent-session.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/messages.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/session-manager.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/settings-manager.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/auth-storage.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/model-registry.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/extensions/loader.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/compaction/index.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/compaction/index.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/agent-session-services.js')).href),
  ]);
  return { Agent, EventStream, getModel, AgentSession, convertToLlm, SessionManager, SettingsManager, AuthStorage,
    ModelRegistry, createExtensionRuntime, loadExtensionFromFactory, createAgentSessionFromServices, prepareCompaction, compact };
})();

function assistant(
  provider: string,
  model: string,
  text: string,
  options: { timestamp?: number; stopReason?: string; input?: number; output?: number; errorMessage?: string } = {},
): any {
  const input = options.input ?? 80;
  const output = options.output ?? 10;
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'anthropic-messages',
    provider,
    model,
    stopReason: options.stopReason ?? 'stop',
    errorMessage: options.errorMessage,
    timestamp: options.timestamp ?? Date.now(),
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

const offlineSplitTurnSummary = 'offline summary response\n\n---\n\n**Turn Context (split turn):**\n\noffline summary response';

function extensionCompaction(event: any, summary = 'source-hook-summary') {
  return {
    compaction: {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: {
        owner: 'source-hook-test',
        ...(event.reason === 'overflow' ? { pieCompaction: { reason: 'overflow' } } : {}),
      },
    },
  };
}

async function fixture(
  t: test.TestContext,
  options: {
    hooks?: CompactionHooks;
    model?: any;
    contextWindow?: number;
    streamFn?: (model: any, context: any, streamOptions: any) => unknown;
    contextMessageOmissions?: (entries: any[]) => Iterable<string>;
    baseTools?: Record<string, any>;
    compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  } = {},
): Promise<any> {
  const modules = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-history-compaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = modules.SessionManager.create(cwd, sessionDir);
  if (options.contextMessageOmissions) {
    manager.setContextMessageOmissionsResolver(options.contextMessageOmissions);
  }
  const model = options.model ?? {
    ...modules.getModel('anthropic', 'claude-sonnet-4-5'),
    contextWindow: options.contextWindow ?? 100_000,
  };
  for (let index = 0; index < 4; index += 1) {
    manager.appendMessage({ role: 'user', content: `offline request ${index}`, timestamp: Date.now() - 20_000 + index * 2 });
    manager.appendMessage(assistant(model.provider, model.id, `offline answer ${index}`, {
      timestamp: Date.now() - 20_000 + index * 2 + 1,
      input: index === 3 ? 80 : 60,
    }));
  }

  const auth = modules.AuthStorage.inMemory();
  auth.set(model.provider, { type: 'api_key', key: 'offline-chat-key', env: { PIE_FIXTURE_ENV: 'offline' } });
  const modelRegistry = modules.ModelRegistry.create(auth, path.join(root, 'models.json'));
  const settingsManager = modules.SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1, ...(options.compaction ?? {}) },
  });
  const streamCalls: any[] = [];
  const streamFn = (requestModel: any, context: any, streamOptions: any) => {
    streamCalls.push({ model: requestModel, context, options: streamOptions });
    if (options.streamFn) return options.streamFn(requestModel, context, streamOptions);
    const response = new modules.EventStream(
      (event: any) => event.type === 'done' || event.type === 'error',
      (event: any) => event.message,
    );
    const result = assistant(requestModel.provider, requestModel.id, 'offline summary response', {
      input: 12,
      output: 6,
    });
    result.api = requestModel.api;
    // Synthetic responses must follow synchronous compaction boundaries even
    // when both occur within the same wall-clock millisecond.
    const latestCompaction = manager.getBranch().findLast((entry: any) => entry.type === 'compaction');
    if (latestCompaction) result.timestamp = Math.max(result.timestamp, Date.parse(latestCompaction.timestamp) + 1);
    queueMicrotask(() => {
      response.push({ type: 'start', partial: result });
      response.push({ type: 'done', reason: 'stop', message: result });
    });
    return response;
  };
  const agent = new modules.Agent({
    initialState: { model, tools: [], systemPrompt: 'offline source-history-compaction fixture' },
    convertToLlm: modules.convertToLlm,
    getApiKey: (provider: string) => auth.getApiKey(provider),
    streamFn,
  });
  agent.state.messages = manager.buildSessionContext().messages;
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: modules.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'offline source-history-compaction fixture',
    getAppendSystemPrompt: () => [],
  };
  const session = new modules.AgentSession({
    agent,
    sessionManager: manager,
    settingsManager,
    cwd,
    resourceLoader,
    baseToolsOverride: options.baseTools ?? {},
    modelRegistry,
    compactionHooks: options.hooks,
  });
  t.after(() => session.dispose());
  const events: any[] = [];
  session.subscribe((event: any) => events.push(event));
  return { modules, root, cwd, manager, session, agent, model, auth, modelRegistry, settingsManager,
    streamCalls, events };
}

function denyNetwork(t: test.TestContext): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network denied by source compaction fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
}

function fakeAssistantResponse(modules: any, model: any, message: any): any {
  message.api = model.api;
  const response = new modules.EventStream(
    (event: any) => event.type === 'done' || event.type === 'error',
    (event: any) => event.message,
  );
  queueMicrotask(() => {
    response.push({ type: 'start', partial: message });
    response.push({ type: 'done', reason: message.stopReason, message });
  });
  return response;
}

test('source candidate compaction stays in the sanitized, network-denied private runtime graph', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network denied by source compaction fixture'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const hooks: CompactionHooks = {
    shouldCompact: ({ trigger }) => trigger === 'soft',
    beforeCompact: (event) => extensionCompaction(event, 'offline-only-summary'),
  };
  const f = await fixture(t, { hooks });
  await f.session.prompt('offline request');
  assert.equal(f.streamCalls.length, 1);
  assert.equal(f.streamCalls[0].options.apiKey, 'offline-chat-key');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
  assert.equal(f.manager.getBranch().some((entry: any) => entry.type === 'compaction' && entry.summary === 'offline-only-summary'), true);
});

test('pre-prompt hard threshold runs before the provider request and post-run compaction does not continue', async (t) => {
  const checks: Array<{ trigger: string; phase: string }> = [];
  const hooks: CompactionHooks = {
    shouldCompact: ({ trigger, phase, contextUsage }) => {
      checks.push({ trigger, phase });
      return trigger === 'hard' && (contextUsage?.tokens ?? 0) >= 50;
    },
    beforeCompact: (event) => extensionCompaction(event),
  };
  const f = await fixture(t, { hooks });
  await f.session.prompt('offline request');
  assert.deepEqual(checks.map((check) => check.trigger), ['hard', 'hard', 'soft']);
  assert.deepEqual(checks.map((check) => check.phase), ['pre-prompt', 'between-turn', 'post-run']);
  assert.equal(f.streamCalls.length, 1);
  assert.equal(JSON.stringify(f.streamCalls[0].context.messages).includes('source-hook-summary'), true,
    'the provider request sees the refreshed post-compaction context');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
});

test('post-run soft threshold compacts a completed response without retrying it', async (t) => {
  const triggers: string[] = [];
  const hooks: CompactionHooks = {
    shouldCompact: ({ trigger }) => { triggers.push(trigger); return trigger === 'soft'; },
    beforeCompact: (event) => extensionCompaction(event),
  };
  const f = await fixture(t, { hooks });
  await f.session.prompt('offline request');
  assert.deepEqual(triggers, ['hard', 'hard', 'soft']);
  assert.equal(f.streamCalls.length, 1, 'a completed answer is never continued by threshold maintenance');
  assert.equal(f.events.filter((event: any) => event.type === 'compaction_end' && event.willRetry).length, 0);
});

test('full prompt awaits hard between-turn compaction before executing and continuing a tool call', async (t) => {
  denyNetwork(t);
  const modules = await sourceModules;
  let toolExecutions = 0;
  const tool = {
    name: 'lookup', label: 'Lookup', description: 'Return the fixture lookup result.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      toolExecutions += 1;
      return { content: [{ type: 'text', text: 'fixture lookup result' }], details: { offline: true } };
    },
  };
  const refreshedTool = {
    ...tool, name: 'refreshed_lookup', label: 'Refreshed lookup',
    execute: async () => ({ content: [{ type: 'text', text: 'refreshed lookup result' }], details: { offline: true } }),
  };
  const phases: string[] = [];
  let compactionWillRetry: boolean | undefined;
  let responseIndex = 0;
  const f = await fixture(t, {
    baseTools: { lookup: tool },
    // Keep the complete tool exchange. The upstream cut-point algorithm cannot
    // split at a tool result when a one-token test budget is exhausted there.
    compaction: { keepRecentTokens: 40 },
    hooks: {
      shouldCompact: ({ trigger, phase }) => {
        phases.push(`${trigger}:${phase}`);
        return trigger === 'hard' && phase === 'between-turn' && responseIndex === 1;
      },
      beforeCompact: (event, session) => {
        compactionWillRetry = event.willRetry;
        session.agent.state.tools = [refreshedTool as any];
        return extensionCompaction(event, 'tool-continuation-summary');
      },
    },
    streamFn: (requestModel) => {
      const message = responseIndex++ === 0
        ? Object.assign(assistant(requestModel.provider, requestModel.id, '', { stopReason: 'toolUse' }), {
          content: [{ type: 'toolCall', id: 'fixture-tool-call', name: 'lookup', arguments: {} }],
        })
        : assistant(requestModel.provider, requestModel.id, 'tool request completed');
      return fakeAssistantResponse(modules, requestModel, message);
    },
  });

  await f.session.prompt('perform the fixture lookup');

  assert.equal(toolExecutions, 1, 'the actual registered tool executes once');
  assert.equal(compactionWillRetry, true, 'the awaited compaction sees a natural tool continuation');
  assert.equal(phases.filter((phase) => phase === 'hard:between-turn').length, 2,
    'the source checks both the tool boundary and the final answer without manufacturing a continuation');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
  assert.equal(f.streamCalls.length, 2, 'the tool continuation gets one provider request and final answer does not trigger another');
  assert.equal(f.streamCalls.every((call: any) => call.options.apiKey === 'offline-chat-key'), true,
    'provider calls use only the fixture in-memory credential');
  assert.deepEqual(f.streamCalls[0].context.tools.map((candidate: any) => candidate.name), ['lookup']);
  assert.deepEqual(f.streamCalls[1].context.tools.map((candidate: any) => candidate.name), ['refreshed_lookup'],
    'the continuation request receives the refreshed tool context');
  assert.match(JSON.stringify(f.streamCalls[1].context.messages), /tool-continuation-summary/u,
    'the continuation request sees the awaited compaction summary');
  assert.match(JSON.stringify(f.streamCalls[1].context.messages), /fixture lookup result/u,
    'the tool result remains in the refreshed provider context');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'message'
    && entry.message.role === 'assistant' && JSON.stringify(entry.message.content).includes('tool request completed')).length, 1,
  'the final answer is persisted once');
  assert.equal(f.events.filter((event: any) => event.type === 'agent_settled').length, 1);
});

test('full prompt hard-compacts a queued follow-up once and does not duplicate its continuation', async (t) => {
  denyNetwork(t);
  const modules = await sourceModules;
  let compactionWillRetry: boolean | undefined;
  let responseIndex = 0;
  const f = await fixture(t, {
    hooks: {
      shouldCompact: ({ trigger, phase }) => trigger === 'hard' && phase === 'between-turn' && responseIndex === 1,
      beforeCompact: (event) => {
        compactionWillRetry = event.willRetry;
        return extensionCompaction(event, 'queued-follow-up-summary');
      },
    },
    streamFn: (requestModel) => {
      const message = assistant(requestModel.provider, requestModel.id,
        responseIndex++ === 0 ? 'initial answer' : 'queued follow-up completed');
      return fakeAssistantResponse(modules, requestModel, message);
    },
  });

  await f.session.followUp('queued follow-up request');
  await f.session.prompt('initial request');

  assert.equal(compactionWillRetry, true, 'the hard compaction recognizes the queued follow-up continuation');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
  assert.equal(f.streamCalls.length, 2, 'the initial request and queued follow-up each receive exactly one provider call');
  assert.match(JSON.stringify(f.streamCalls[1].context.messages), /queued-follow-up-summary/u,
    'the queued continuation request sees the awaited hard-compaction summary');
  assert.equal(f.streamCalls[1].context.messages.filter((message: any) => message.role === 'user'
    && JSON.stringify(message.content).includes('queued follow-up request')).length, 1,
  'the queued user message is consumed into context exactly once');
  assert.deepEqual(f.session.getFollowUpMessages(), [], 'the session queue is empty after the follow-up runs');
  assert.equal(f.session.pendingMessageCount, 0);
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'message'
    && entry.message.role === 'assistant' && JSON.stringify(entry.message.content).includes('queued follow-up completed')).length, 1,
  'the final answer is persisted exactly once with no duplicate continuation');
  assert.equal(f.events.filter((event: any) => event.type === 'agent_settled').length, 1);
});

for (const scenario of [
  { name: 'tool continuation', toolResults: [{ role: 'toolResult', toolCallId: 'tool-1', toolName: 'fixture', content: 'done' }], queued: false, expectedRetry: true },
  { name: 'queued user continuation', toolResults: [], queued: true, expectedRetry: true },
  { name: 'terminal response', toolResults: [], queued: false, expectedRetry: false },
]) {
  test(`awaited between-turn barrier refreshes context and preserves ${scenario.name}`, async (t) => {
    let willRetry: boolean | undefined;
    const hooks: CompactionHooks = {
      shouldCompact: ({ trigger }) => trigger === 'hard',
      beforeCompact: (event) => { willRetry = event.willRetry; return extensionCompaction(event); },
    };
    const f = await fixture(t, { hooks });
    if (scenario.queued) {
      f.agent.followUp({ role: 'user', content: 'already queued', timestamp: Date.now() });
    }
    const turnMessage = assistant(f.model.provider, f.model.id, '', { input: 80 });
    if (scenario.name === 'tool continuation') {
      turnMessage.content = [{ type: 'toolCall', id: 'tool-1', name: 'fixture', arguments: {} }];
    }
    const snapshot = await f.agent.prepareNextTurnWithContext({
      message: turnMessage,
      toolResults: scenario.toolResults,
      context: { messages: f.agent.state.messages },
      newMessages: [],
    });
    assert.equal(willRetry, scenario.expectedRetry);
    assert.deepEqual(snapshot.context.messages, f.agent.state.messages,
      'the awaited continuation barrier replaces its stale message snapshot');
    assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
  });
}

test('false threshold hook suppresses native threshold but not provider overflow recovery', async (t) => {
  let thresholdCalls = 0;
  const hooks: CompactionHooks = {
    shouldCompact: () => { thresholdCalls += 1; return false; },
    beforeCompact: (event) => extensionCompaction(event, `recovered-${event.reason}`),
  };
  const f = await fixture(t, { hooks, contextWindow: 100, compaction: { reserveTokens: 20 } });
  const normal = assistant(f.model.provider, f.model.id, 'large but valid answer', { input: 95, output: 1 });
  assert.equal(await f.session._checkCompaction(normal), false);
  assert.equal(f.manager.getBranch().some((entry: any) => entry.type === 'compaction'), false,
    'false owns and suppresses the native proactive threshold');

  const overflow = assistant(f.model.provider, f.model.id, '', {
    stopReason: 'error', input: 0, output: 0, errorMessage: 'prompt is too long',
  });
  f.agent.state.messages = [...f.agent.state.messages, overflow];
  assert.equal(await f.session._checkCompaction(overflow), true,
    'native provider-error overflow recovery ignores the proactive threshold decision');
  assert.equal(thresholdCalls, 1, 'provider overflow bypasses the threshold callback');
  assert.equal(f.manager.getBranch().some((entry: any) => entry.type === 'compaction' && entry.summary === 'recovered-overflow'), true);
  const repeatedOverflow = assistant(f.model.provider, f.model.id, '', {
    timestamp: Date.now() + 2_000, stopReason: 'error', input: 0, output: 0, errorMessage: 'prompt is too long',
  });
  assert.equal(await f.session._checkCompaction(repeatedOverflow), false);
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1,
    'native provider-error recovery is bounded to one retry for this user continuation');
});

test('ordinary provider errors retain native threshold delegation despite a false proactive hook', async (t) => {
  let thresholdCalls = 0;
  const hooks: CompactionHooks = {
    shouldCompact: () => { thresholdCalls += 1; return false; },
    beforeCompact: (event) => extensionCompaction(event, `native-${event.reason}`),
  };
  const f = await fixture(t, { hooks, contextWindow: 100, compaction: { reserveTokens: 20 } });
  const error = assistant(f.model.provider, f.model.id, '', {
    stopReason: 'error', input: 0, output: 0, errorMessage: 'temporary provider failure',
  });
  f.manager.appendMessage(error);
  f.agent.state.messages = f.manager.buildSessionContext().messages;
  assert.equal(await f.session._checkCompaction(error), false,
    'native threshold maintenance does not retry the ordinary provider error');
  assert.equal(thresholdCalls, 0, 'the proactive false decision does not replace native provider-error delegation');
  assert.equal(f.manager.getBranch().some((entry: any) => entry.type === 'compaction'
    && entry.summary === 'native-threshold'), true);
});

test('estimated overflow hook is guarded by model identity and compaction freshness', async (t) => {
  let estimatedChecks = 0;
  const hooks: CompactionHooks = {
    shouldCompact: () => false,
    isEstimatedContextOverflow: () => { estimatedChecks += 1; return true; },
  };
  const f = await fixture(t, { hooks });
  const mismatch = assistant(f.model.provider, 'previous-model', '', { stopReason: 'length', input: 0, output: 0 });
  assert.equal(await f.session._checkCompaction(mismatch), false);
  assert.equal(estimatedChecks, 0, 'old-model empty length replies are rejected before the estimate predicate');

  const branch = f.manager.getBranch();
  f.manager.appendCompaction('already compacted', branch.find((entry: any) => entry.type === 'message').id, 500);
  const stale = assistant(f.model.provider, f.model.id, '', {
    timestamp: Date.now() - 10_000, stopReason: 'length', input: 0, output: 0,
  });
  assert.equal(await f.session._checkCompaction(stale), false);
  assert.equal(estimatedChecks, 0, 'pre-compaction messages and their usage never reach the estimate predicate');
});

test('unknown post-compaction usage is rejected before the estimated-overflow predicate', async (t) => {
  let estimatedChecks = 0;
  const f = await fixture(t, {
    hooks: { isEstimatedContextOverflow: () => { estimatedChecks += 1; return true; } },
  });
  const branch = f.manager.getBranch();
  f.manager.appendCompaction('unknown usage boundary', branch.find((entry: any) => entry.type === 'message').id, 500);
  const unknownUsage = assistant(f.model.provider, f.model.id, '', {
    timestamp: Date.now() + 2_000, stopReason: 'length', input: 0, output: 0,
  });
  f.manager.appendMessage(unknownUsage);
  f.agent.state.messages = f.manager.buildSessionContext().messages;
  assert.equal(f.session.getContextUsage()?.tokens, null, 'no assistant usage exists after the compaction boundary');
  assert.equal(await f.session._checkCompaction(unknownUsage), false);
  assert.equal(estimatedChecks, 0, 'an always-true caller predicate cannot retry an unknown estimate');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);
});

for (const overflowScenario of [
  { name: 'estimated zero-length overflow', stopReason: 'length', errorMessage: undefined },
  { name: 'native provider-error overflow', stopReason: 'error', errorMessage: 'prompt is too long' },
]) {
  test(`${overflowScenario.name} compacts then retries without the durable failed row`, async (t) => {
  const modules = await sourceModules;
  let failedMessage: any;
  let responseIndex = 0;
  const hooks: CompactionHooks = {
    shouldCompact: () => false,
    isEstimatedContextOverflow: ({ assistantMessage, contextUsage, model }) => isEstimatedContextOverflowMessage(
      assistantMessage,
      model.contextWindow,
      contextUsage?.tokens,
    ),
    beforeCompact: (event) => {
      const failedEntry = [...event.branchEntries].reverse().find((entry): entry is SessionMessageEntry => (
        entry.type === 'message'
          && entry.message.role === 'assistant'
          && entry.message.stopReason === overflowScenario.stopReason
      ));
      assert.ok(failedEntry, 'the failed overflow reply remains durable when compaction starts');
      const result = extensionCompaction(event, 'estimated-overflow-summary');
      result.compaction.firstKeptEntryId = failedEntry.id;
      return result;
    },
  };
  const streamFn = (requestModel: any) => {
    const response = new modules.EventStream(
      (event: any) => event.type === 'done' || event.type === 'error',
      (event: any) => event.message,
    );
    const result = responseIndex++ === 0
      ? (failedMessage = assistant(requestModel.provider, requestModel.id, '', {
        stopReason: overflowScenario.stopReason, input: 0, output: 0, errorMessage: overflowScenario.errorMessage,
      }))
      : assistant(requestModel.provider, requestModel.id, 'retry succeeded', { input: 20, output: 4 });
    result.api = requestModel.api;
    queueMicrotask(() => {
      response.push({ type: 'start', partial: result });
      response.push({ type: 'done', reason: result.stopReason, message: result });
    });
    return response;
  };
  const f = await fixture(t, {
    hooks,
    contextWindow: 90,
    streamFn,
    contextMessageOmissions: consumedOverflowMessageEntryIds,
  });
  await f.session.prompt('recover the request');

  assert.equal(f.streamCalls.length, 2, 'the failed request is followed by one provider retry');
  assert.equal(f.streamCalls[1].context.messages.some((message: any) => (
    message.role === 'assistant' && message.stopReason === overflowScenario.stopReason
      && message.timestamp === failedMessage.timestamp
  )), false, 'the consumed-overflow resolver omits the retained failed row from retried provider context');
  assert.equal(f.agent.state.messages.some((message: any) => (
    message.role === 'assistant' && message.stopReason === overflowScenario.stopReason
      && message.timestamp === failedMessage.timestamp
  )), false, 'the successful retry leaves the consumed failed row out of live prompt state');

  const branch = f.manager.getBranch();
  const failedEntry = branch.find((entry: any) => entry.type === 'message' && entry.message === failedMessage);
  const compaction = branch.find((entry: any) => entry.type === 'compaction');
  assert.ok(failedEntry, 'the failed provider row remains durable');
  assert.equal(failedEntry.message.stopReason, overflowScenario.stopReason);
  if (overflowScenario.errorMessage) {
    assert.equal(failedEntry.message.errorMessage, overflowScenario.errorMessage,
      'the native provider error remains durable in the transcript');
  }
  assert.ok(compaction);
  assert.equal(compaction.firstKeptEntryId, failedEntry.id, 'the compaction explicitly retains the failed entry boundary');
  assert.equal(consumedOverflowMessageEntryIds(branch).has(failedEntry.id), true,
    'the existing Pie consumed-overflow resolver recognizes the failed row without rewriting it');
  assert.equal(branch.filter((entry: any) => entry.type === 'message'
    && entry.message.role === 'assistant' && entry.message.content?.[0]?.text === 'retry succeeded').length, 1,
  'the single retry succeeds exactly once');
});
}

test('estimated overflow has one retry per continuation and rejects stale post-compaction estimates', async (t) => {
  let estimatedChecks = 0;
  const hooks: CompactionHooks = {
    shouldCompact: () => false,
    isEstimatedContextOverflow: () => { estimatedChecks += 1; return true; },
    beforeCompact: (event) => extensionCompaction(event, 'estimated-overflow-summary'),
  };
  const f = await fixture(t, { hooks });
  const first = assistant(f.model.provider, f.model.id, '', { stopReason: 'length', input: 0, output: 0 });
  f.agent.state.messages = [...f.agent.state.messages, first];
  assert.equal(await f.session._checkCompaction(first), true);
  const second = assistant(f.model.provider, f.model.id, '', {
    timestamp: Date.now() + 2_000, stopReason: 'length', input: 0, output: 0,
  });
  assert.equal(await f.session._checkCompaction(second), false);
  assert.equal(estimatedChecks, 1, 'unknown post-compaction usage does not reach the estimate predicate');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);

  const otherModel = { ...f.model, id: 'second-model' };
  f.agent.state.model = otherModel;
  f.manager.appendMessage(assistant(otherModel.provider, otherModel.id, 'fresh post-compaction usage', {
    timestamp: Date.now() + 1_000, input: 20,
  }));
  f.agent.state.messages = f.manager.buildSessionContext().messages;
  const otherOverflow = assistant(otherModel.provider, otherModel.id, '', {
    timestamp: Date.now() + 4_000, stopReason: 'length', input: 0, output: 0,
  });
  assert.equal(await f.session._checkCompaction(otherOverflow), false,
    'switching models does not reset the single retry bound for this user continuation');
  assert.equal(estimatedChecks, 2, 'a fresh post-compaction estimate reaches the predicate before the bound rejects retry');
  assert.equal(f.events.some((event: any) => event.type === 'compaction_end'
    && event.errorMessage?.includes('after one compact-and-retry attempt')), true);
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 1);

  let staleChecks = 0;
  const staleFixture = await fixture(t, {
    hooks: { ...hooks, isEstimatedContextOverflow: () => { staleChecks += 1; return true; } },
  });
  const before = staleFixture.manager.getBranch();
  staleFixture.manager.appendCompaction('old boundary', before.find((entry: any) => entry.type === 'message').id, 500);
  const staleUsage = assistant(staleFixture.model.provider, staleFixture.model.id, '', {
    timestamp: Date.now() - 10_000, stopReason: 'length', input: 0, output: 0,
  });
  assert.equal(await staleFixture.session._checkCompaction(staleUsage), false);
  assert.equal(staleChecks, 0);
});

test('beforeCompact customization selects summary model and forwards instructions, thinking, auth, and env', async (t) => {
  const modules = await sourceModules;
  const summaryModel = {
    ...modules.getModel('openai', 'gpt-4o-mini'),
    reasoning: true,
    headers: { 'x-pie-summary': 'source-test' },
  };
  const hooks: CompactionHooks = {
    beforeCompact: async (event, session) => {
      const selected = session.modelRegistry.find('openai', 'gpt-4o-mini');
      if (!selected) return { cancel: true };
      const preparation = modules.prepareCompaction(event.branchEntries, {
        ...session.settingsManager.getCompactionSettings(),
        keepRecentTokens: 1,
      });
      if (!preparation) return { cancel: true };
      const auth = await session.getCompactionRequestAuth(selected);
      const instructions = [
        'Preserve exact source test failures.',
        event.customInstructions,
      ].filter(Boolean).join('\n\nAdditional one-time focus:\n');
      const result = await modules.compact(
        preparation,
        selected,
        auth.apiKey,
        auth.headers,
        instructions,
        event.signal,
        'low',
        session.agent.streamFn,
        auth.env,
      );
      return { compaction: result };
    },
  };
  const f = await fixture(t, { hooks });
  f.auth.set('openai', {
    type: 'api_key', key: 'offline-summary-key', env: { PIE_SUMMARY_ENV: 'offline-summary-value' },
  });
  const originalFind = f.modelRegistry.find.bind(f.modelRegistry);
  f.modelRegistry.find = (provider: string, id: string) => (
    provider === 'openai' && id === 'gpt-4o-mini' ? summaryModel : originalFind(provider, id)
  );

  const auth = await f.session.getCompactionRequestAuth(summaryModel);
  assert.equal(auth.apiKey, 'offline-summary-key');
  assert.deepEqual(auth.headers, { ...summaryModel.headers });
  assert.deepEqual(auth.env, { PIE_SUMMARY_ENV: 'offline-summary-value' });
  const result = await f.session.compact('Focus on the affected API.');
  assert.equal(result.summary, offlineSplitTurnSummary);
  assert.equal(f.streamCalls.length, 2, 'split-turn compaction summarizes history and the retained turn prefix');
  for (const call of f.streamCalls) {
    assert.equal(call.model.id, 'gpt-4o-mini');
    assert.equal(call.options.apiKey, 'offline-summary-key');
    assert.deepEqual(call.options.headers, { 'x-pie-summary': 'source-test' });
    assert.deepEqual(call.options.env, { PIE_SUMMARY_ENV: 'offline-summary-value' });
    assert.equal(call.options.reasoning, 'low');
  }
  assert.match(JSON.stringify(f.streamCalls[0].context), /Preserve exact source test failures\.[\s\S]*Focus on the affected API\./u);
});

test('customization fallback is controlled: explicit summary failure cancels, active-model choice delegates', async (t) => {
  let adapterCalls = 0;
  const explicitHooks: CompactionHooks = {
    beforeCompact: async (_event, session) => {
      adapterCalls += 1;
      const configured = session.modelRegistry.find('missing-provider', 'missing-model');
      if (!configured) return { cancel: true };
      throw new Error('unreachable');
    },
  };
  const explicit = await fixture(t, { hooks: explicitHooks });
  await assert.rejects(explicit.session.compact(), /Compaction cancelled/u);
  assert.equal(adapterCalls, 1);
  assert.equal(explicit.streamCalls.length, 0, 'an explicit but unavailable summary model never falls back to chat');

  // The adapter callback owns fallback choice: for Active model it returns
  // undefined after failure, letting source compaction use the active model.
  const activeFallback = await fixture(t, {
    hooks: {
      beforeCompact: async () => {
        try {
          throw new Error('controlled adapter failed');
        } catch {
          return undefined;
        }
      },
    },
  });
  const result = await activeFallback.session.compact();
  assert.equal(result.summary, offlineSplitTurnSummary);
  assert.equal(activeFallback.streamCalls.length, 2, 'native split-turn compaction generates both summary sections');
  assert.equal(activeFallback.streamCalls.every((call: any) => call.model.id === activeFallback.model.id), true,
    'both summary requests use the active model when the hook delegates');
});

test('extension cancellation and compaction results take precedence over beforeCompact', async (t) => {
  let hookCalls = 0;
  const f = await fixture(t, {
    hooks: {
      beforeCompact: (event) => { hookCalls += 1; return extensionCompaction(event, 'lower-priority-hook'); },
    },
  });
  const runner = f.session._extensionRunner;
  const nativeHasHandlers = runner.hasHandlers.bind(runner);
  runner.hasHandlers = (eventType: string) => eventType === 'session_before_compact' || nativeHasHandlers(eventType);
  runner.emit = async (event: any) => event.type === 'session_before_compact'
    ? { cancel: true, compaction: extensionCompaction(event, 'extension-result').compaction }
    : undefined;
  await assert.rejects(f.session.compact(), /Compaction cancelled/u);
  assert.equal(hookCalls, 0);
  assert.equal(f.manager.getBranch().some((entry: any) => entry.type === 'compaction'), false);
});

test('extension compaction result wins without invoking the final hook', async (t) => {
  let hookCalls = 0;
  const f = await fixture(t, {
    hooks: {
      beforeCompact: (event) => { hookCalls += 1; return extensionCompaction(event, 'lower-priority-hook'); },
    },
  });
  const runner = f.session._extensionRunner;
  const nativeHasHandlers = runner.hasHandlers.bind(runner);
  runner.hasHandlers = (eventType: string) => eventType === 'session_before_compact' || nativeHasHandlers(eventType);
  runner.emit = async (event: any) => event.type === 'session_before_compact'
    ? extensionCompaction(event, 'extension-result')
    : undefined;
  const result = await f.session.compact();
  assert.equal(result.summary, 'extension-result');
  assert.equal(hookCalls, 0);
});

test('abortCompaction cancels an awaited auto-summary without changing the default transcript', async (t) => {
  let finishSummary: (() => void) | undefined;
  let announceSummary: (() => void) | undefined;
  const summaryStarted = new Promise<void>((resolve) => { announceSummary = resolve; });
  const summaryGate = new Promise<void>((resolve) => { finishSummary = resolve; });
  let hookCalls = 0;
  let summarySignal: AbortSignal | undefined;
  const hooks: CompactionHooks = {
    beforeCompact: async (event) => {
      hookCalls += 1;
      summarySignal = event.signal;
      announceSummary?.();
      await summaryGate;
      return extensionCompaction(event, 'must-not-publish');
    },
  };
  const f = await fixture(t, { hooks });
  const entriesBefore = f.manager.getEntries();
  const defaultTranscriptBefore = f.manager.buildSessionContext().messages;
  const livePromptBefore = f.agent.state.messages.slice();
  const pending = f.session._runAutoCompaction('threshold', false);
  await summaryStarted;
  f.session.abortCompaction();
  finishSummary?.();
  await pending;

  assert.equal(hookCalls, 1);
  assert.equal(summarySignal?.aborted, true, 'abortCompaction aborts the pending summary signal');
  assert.deepEqual(f.manager.getEntries(), entriesBefore, 'cancellation appends no compaction or transcript row');
  assert.deepEqual(f.manager.buildSessionContext().messages, defaultTranscriptBefore,
    'the default transcript context is unchanged');
  assert.deepEqual(f.agent.state.messages, livePromptBefore, 'cancellation leaves the active prompt unchanged');
  assert.equal(f.manager.getBranch().filter((entry: any) => entry.type === 'compaction').length, 0);
  const endings = f.events.filter((event: any) => event.type === 'compaction_end');
  assert.equal(endings.length, 1);
  assert.equal(endings[0].reason, 'threshold');
  assert.equal(endings[0].aborted, true);
  assert.equal(endings[0].willRetry, false);
  assert.equal(endings[0].result, undefined);
});

test('stale session lease during async summary suppresses append and terminal publication', async (t) => {
  let finishSummary: (() => void) | undefined;
  let announceSummary: (() => void) | undefined;
  const summaryStarted = new Promise<void>((resolve) => { announceSummary = resolve; });
  const summaryGate = new Promise<void>((resolve) => { finishSummary = resolve; });
  const hooks: CompactionHooks = {
    beforeCompact: async (event) => {
      announceSummary?.();
      await summaryGate;
      return extensionCompaction(event, 'must-not-publish');
    },
  };
  const f = await fixture(t, { hooks });
  const sessionPath = realpathSync(f.manager.getSessionFile());
  let valid = true;
  const lease = {
    coordinatorGeneration: 1,
    workerId: 'source-history-compaction-test',
    workerGeneration: 1,
    ownershipRevision: 1,
    nonce: 'offline-lease',
    canonicalSessionPath: sessionPath,
  };
  const adapter = {
    assertWriteLease: (candidate: any) => {
      if (!valid || candidate.nonce !== lease.nonce) throw new Error('Stale test lease.');
    },
    runWriteMutation: (_candidate: any, _path: string, _seam: string, _id: string, mutation: () => unknown) => {
      if (!valid) throw new Error('Stale test lease.');
      return mutation();
    },
  };
  f.manager.attachPieWriteLease(adapter, lease);
  const entriesBefore = f.manager.getEntries().length;
  const pending = f.session._runAutoCompaction('threshold', false);
  await summaryStarted;
  valid = false;
  f.manager.revokePieWriteLease();
  finishSummary?.();
  await pending;
  assert.equal(f.manager.getEntries().length, entriesBefore, 'the stale source cannot append its summary');
  assert.equal(f.events.some((event: any) => event.type === 'compaction_end'), false,
    'the stale source publishes no terminal compaction result');
});

test('services factory forwards compaction hooks and installs initial context omissions before session startup', async (t) => {
  const modules = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-history-services-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const manager = modules.SessionManager.create(cwd, sessionDir);
  const model = { ...modules.getModel('anthropic', 'claude-sonnet-4-5'), contextWindow: 100_000 };
  for (let index = 0; index < 4; index += 1) {
    manager.appendMessage({ role: 'user', content: `offline request ${index}`, timestamp: Date.now() - 20_000 + index * 2 });
    manager.appendMessage(assistant(model.provider, model.id, `offline answer ${index}`, {
      timestamp: Date.now() - 20_000 + index * 2 + 1,
      input: index === 3 ? 80 : 60,
    }));
  }
  manager.appendThinkingLevelChange('medium');
  const omittedEntry = manager.getBranch().findLast((entry: any) => entry.type === 'message'
    && entry.message.role === 'assistant');
  assert.ok(omittedEntry);
  const omittedMessage = structuredClone(omittedEntry.message);
  const entriesBeforeCreation = structuredClone(manager.getEntries());
  const transcriptBeforeCreation = readFileSync(manager.getSessionFile()!, 'utf8');

  const order: string[] = [];
  const originalSetResolver = manager.setContextMessageOmissionsResolver.bind(manager);
  manager.setContextMessageOmissionsResolver = (resolver: any) => {
    order.push('resolver-installed');
    return originalSetResolver(resolver);
  };
  const originalBuildContext = manager.buildSessionContext.bind(manager);
  manager.buildSessionContext = (options?: any) => {
    order.push('context-built');
    return originalBuildContext(options);
  };
  const contextMessageOmissions = (branchEntries: readonly any[]) => {
    order.push('omission-resolved');
    return new Set(branchEntries.filter((entry) => entry.type === 'message' && entry.id === omittedEntry.id)
      .map((entry) => entry.id));
  };

  const auth = modules.AuthStorage.inMemory();
  auth.set(model.provider, { type: 'api_key', key: 'offline-services-key', env: { PIE_FIXTURE_ENV: 'offline' } });
  const modelRegistry = modules.ModelRegistry.create(auth, path.join(root, 'models.json'));
  const settingsManager = modules.SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 1 },
  });
  const extensionRuntime = modules.createExtensionRuntime();
  let session: any;
  let startupContents: string[] | undefined;
  const extension = await modules.loadExtensionFromFactory((api: any) => {
    api.on('session_start', () => {
      startupContents = session.agent.state.messages.map((message: any) => typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content) ? message.content.map((part: any) => part.text ?? '').join('') : '');
    });
  }, cwd, undefined, extensionRuntime, '<source-history-services-factory>');
  const resourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'offline services-factory fixture',
    getAppendSystemPrompt: () => [],
  };

  const thresholdChecks: string[] = [];
  let beforeCompactCalls = 0;
  const compactionHooks: CompactionHooks = {
    shouldCompact: ({ trigger }) => {
      thresholdChecks.push(trigger);
      return trigger === 'soft';
    },
    beforeCompact: (event) => {
      beforeCompactCalls += 1;
      return extensionCompaction(event, 'services-factory-compaction');
    },
  };
  const created = await modules.createAgentSessionFromServices({
    services: { cwd, agentDir, authStorage: auth, settingsManager, modelRegistry, resourceLoader, diagnostics: [] },
    sessionManager: manager,
    model,
    noTools: 'all',
    contextMessageOmissions,
    compactionHooks,
    sessionStartEvent: { type: 'session_start', reason: 'startup' },
  });
  session = created.session;
  t.after(() => session?.dispose());

  const initialContents = session.agent.state.messages.map((message: any) => typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content) ? message.content.map((part: any) => part.text ?? '').join('') : '');
  assert.equal(initialContents.includes('offline request 3'), true);
  assert.equal(initialContents.includes('offline answer 3'), false,
    'the services factory forwards omissions into the initial Agent context');
  assert.ok(order.indexOf('resolver-installed') < order.indexOf('context-built'),
    'the resolver is installed before the SDK builds initial context');
  assert.ok(order.indexOf('omission-resolved') > order.indexOf('resolver-installed'));

  await session.bindExtensions({});
  assert.ok(startupContents);
  assert.equal(startupContents.includes('offline request 3'), true);
  assert.equal(startupContents.includes('offline answer 3'), false,
    'the extension observes the projected session_start context');
  assert.deepEqual(manager.getEntries(), entriesBeforeCreation,
    'initial context projection and session_start leave the raw entries unchanged');
  assert.equal(readFileSync(manager.getSessionFile()!, 'utf8'), transcriptBeforeCreation,
    'initial context projection does not rewrite the raw transcript');
  assert.deepEqual(manager.getEntry(omittedEntry.id)?.message, omittedMessage,
    'the omitted message remains durable and unchanged');

  const streamCalls: any[] = [];
  session.agent.streamFn = (requestModel: any, context: any, streamOptions: any) => {
    streamCalls.push({ model: requestModel, context, options: streamOptions });
    return fakeAssistantResponse(modules, requestModel, assistant(requestModel.provider, requestModel.id, 'factory path reply'));
  };
  await session.prompt('offline follow-up');
  assert.ok(thresholdChecks.includes('soft'), 'the forwarded policy hook controls real AgentSession threshold checks');
  assert.equal(beforeCompactCalls, 1, 'the forwarded beforeCompact hook runs during real AgentSession compaction');
  assert.equal(streamCalls.length, 1, 'the fake provider stream keeps this regression network-free');
  assert.equal(manager.getBranch().some((entry: any) => entry.type === 'compaction'
    && entry.summary === 'services-factory-compaction'), true);
  assert.deepEqual(manager.getEntry(omittedEntry.id)?.message, omittedMessage,
    'compaction does not rewrite the raw entry omitted from projected context');
});
