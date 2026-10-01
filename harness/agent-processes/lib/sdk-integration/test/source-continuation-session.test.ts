import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeOptions,
} from '@earendil-works/pi-coding-agent';
import { classifyInterruptedContinuationTail } from '../sdk';

// Exercise only the privately built source graph; never load the installed SDK.
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
  const [{ Agent }, { EventStream, getModel }, { AgentSession }, { SessionManager }, { SettingsManager },
    { AuthStorage }, { ModelRegistry }, { createAgentSession }, { createAgentSessionRuntime },
    { createExtensionRuntime, loadExtensionFromFactory }, { StaleSessionWriteLeaseError, buildSessionContext }] = await Promise.all([
    import(pathToFileURL(path.join(packageRoots.agent, 'dist/index.js')).href),
    import(pathToFileURL(path.join(packageRoots.ai, 'dist/compat.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/agent-session.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/session-manager.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/settings-manager.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/auth-storage.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/model-registry.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/sdk.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/agent-session-runtime.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/extensions/loader.js')).href),
    import(pathToFileURL(path.join(coding, 'dist/core/session-manager.js')).href),
  ]);
  return {
    Agent, EventStream, getModel, AgentSession, SessionManager, SettingsManager, AuthStorage, ModelRegistry,
    createAgentSession, createAgentSessionRuntime, createExtensionRuntime, loadExtensionFromFactory,
    StaleSessionWriteLeaseError, buildSessionContext,
  };
})();

function assistant(
  content: AssistantMessage['content'] = [{ type: 'text', text: 'completed answer' }],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
    stopReason, errorMessage, timestamp: Date.now(),
    usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

type Decision =
  | { type: 'continue'; omitEntryIds?: readonly string[] }
  | { type: 'unsupported'; reason: string };

function decideFromPiePolicy(messages: AgentMessage[], tailEntryId: string): Decision {
  const tail = classifyInterruptedContinuationTail(messages, 200_000);
  if (!tail) return { type: 'unsupported', reason: 'The session does not end at a supported continuation point.' };
  if (tail === 'aborted-assistant' || tail === 'overflow-assistant') {
    return { type: 'continue', omitEntryIds: [tailEntryId] };
  }
  return { type: 'continue' };
}

function baseMessages(tail: AgentMessage): AgentMessage[] {
  const previousReply = assistant([{ type: 'text', text: 'earlier completed reply' }]);
  const messages: AgentMessage[] = [
    { role: 'user', content: 'earlier request', timestamp: 1 },
    previousReply,
  ];
  if (tail.role !== 'user') {
    messages.push({ role: 'user', content: 'current request', timestamp: 2 });
  }
  messages.push(tail);
  return messages;
}

async function fixture(t: test.TestContext, seed: AgentMessage[], options: { cancellable?: boolean; deferred?: boolean } = {}) {
  const modules = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = modules.SessionManager.create(cwd, sessionDir);
  for (const message of seed) manager.appendMessage(message as never);

  const auth = modules.AuthStorage.inMemory();
  auth.setRuntimeApiKey('anthropic', 'offline-continuation-fixture');
  const modelRegistry = modules.ModelRegistry.create(auth, path.join(root, 'models.json'));
  const settingsManager = modules.SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: false },
  });
  const model = modules.getModel('anthropic', 'claude-sonnet-4-5');
  const streamCalls: Array<{ messages: unknown[]; signal?: AbortSignal }> = [];
  let announceStarted: (() => void) | undefined;
  let completeDeferredResponse: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const agent = new modules.Agent({
    initialState: { model, tools: [], systemPrompt: 'offline continuation fixture' },
    streamFn: (_model: unknown, context: { messages: unknown[] }, streamOptions: { signal?: AbortSignal }) => {
      streamCalls.push({ messages: context.messages, signal: streamOptions.signal });
      const response = new modules.EventStream(
        (event: { type: string }) => event.type === 'done' || event.type === 'error',
        (event: { message: AssistantMessage }) => event.message,
      );
      const partial = assistant([{ type: 'text', text: 'fixture response' }], 'stop');
      queueMicrotask(() => {
        announceStarted?.();
        response.push({ type: 'start', partial });
        if (options.cancellable) {
          streamOptions.signal?.addEventListener('abort', () => {
            const aborted = assistant([{ type: 'text', text: 'partial fixture response' }], 'aborted');
            response.push({ type: 'done', reason: 'aborted', message: aborted });
          }, { once: true });
        } else if (options.deferred) {
          completeDeferredResponse = () => response.push({ type: 'done', reason: 'stop', message: partial });
        } else {
          response.push({ type: 'done', reason: 'stop', message: partial });
        }
      });
      return response;
    },
  });
  agent.state.messages = manager.buildSessionContext().messages;
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: modules.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'offline continuation fixture', getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const session = new modules.AgentSession({
    agent, sessionManager: manager, settingsManager, cwd, resourceLoader,
    baseToolsOverride: {}, modelRegistry,
  });
  t.after(() => session.dispose());
  const events: Array<{ type: string; message?: AgentMessage }> = [];
  session.subscribe((event: { type: string; message?: AgentMessage }) => events.push(event));
  return {
    root, cwd, sessionDir, manager, session, agent, events, streamCalls, started, modelRegistry, settingsManager, auth, model,
    completeDeferredResponse: () => {
      if (!completeDeferredResponse) throw new Error('The deferred provider response has not started.');
      completeDeferredResponse();
    },
  };
}

const supportedCases: Array<{ name: string; tail: AgentMessage; omitted: boolean; retainedText?: string }> = [
  { name: 'aborted assistant', tail: assistant([{ type: 'text', text: 'partial' }], 'aborted'), omitted: true },
  { name: 'overflow assistant', tail: assistant([], 'error', 'prompt is too long: 201000 tokens > 200000 maximum'), omitted: true },
  { name: 'open provider turn after user', tail: { role: 'user', content: 'current request', timestamp: 2 }, omitted: false },
  { name: 'open provider turn after tool result', tail: {
    role: 'toolResult', toolCallId: 'tool-1', toolName: 'lookup', content: [{ type: 'text', text: 'tool output' }], isError: false, timestamp: 3,
  }, omitted: false },
  { name: 'completed stop reply', tail: assistant([{ type: 'text', text: 'completed stop reply' }]), omitted: false, retainedText: 'completed stop reply' },
  { name: 'completed length reply', tail: assistant([{ type: 'text', text: 'completed length reply' }], 'length'), omitted: false, retainedText: 'completed length reply' },
];

for (const continuationCase of supportedCases) {
  test(`real AgentSession zero-message continuation supports ${continuationCase.name}`, async (t) => {
    const f = await fixture(t, baseMessages(continuationCase.tail));
    const originalBytes = readFileSync(f.manager.getSessionFile()!, 'utf8');
    const originalRows = structuredClone(f.manager.getEntries());
    const tailEntry = f.manager.getBranch().findLast((entry: { type: string }) => entry.type === 'message');
    const decision = decideFromPiePolicy(f.agent.state.messages, tailEntry.id);
    assert.equal(decision.type, 'continue');

    await f.session.continueAfterInterruption(decision);

    assert.equal(f.streamCalls.length, 1);
    assert.equal(JSON.stringify(f.streamCalls[0].messages).includes('current request'), true,
      'the original user request remains available to the zero-message provider continuation');
    if (continuationCase.omitted) {
      assert.equal(f.agent.state.messages.some((message: any) => message.stopReason === 'aborted'
        || (message.role === 'assistant' && message.errorMessage?.includes('prompt is too long'))), false);
    }
    const retainedText = continuationCase.retainedText;
    if (retainedText) {
      assert.equal(f.streamCalls[0].messages.some((message: any) => message.role === 'assistant'
        && JSON.stringify(message.content).includes(retainedText)), true,
      'the completed assistant reply remains in the provider context');
    }
    assert.equal(f.manager.getEntries().filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length,
      originalRows.filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length,
      'zero-message continuation adds no user rows');
    assert.deepEqual(f.manager.getEntries().slice(0, originalRows.length), originalRows,
      'all previously persisted entries remain byte-for-byte equivalent as objects');
    assert.equal(readFileSync(f.manager.getSessionFile()!, 'utf8').startsWith(originalBytes), true,
      'context-only omission leaves the original persisted transcript prefix unchanged');
    assert.equal(f.events.filter((event) => event.type === 'agent_settled').length, 1);
    assert.equal(f.events.at(-1)?.type, 'agent_settled');
  });
}

const unsupportedCases: Array<{ name: string; messages: AgentMessage[] }> = [
  { name: 'ordinary provider error', messages: baseMessages(assistant([], 'error', 'provider rejected request permanently')) },
  { name: 'empty context', messages: [] },
  ...(['stop', 'length', 'toolUse'] as const).map((stopReason) => ({
    name: `assistant dangling tool-call (stopReason=${stopReason})`,
    messages: baseMessages(assistant([
      { type: 'toolCall', id: `dangling-${stopReason}`, name: 'lookup', arguments: { query: 'offline' } },
    ], stopReason)),
  })),
];

for (const unsupportedCase of unsupportedCases) {
  test(`unsupported ${unsupportedCase.name} rejects without streaming, events, or writes`, async (t) => {
    const f = await fixture(t, unsupportedCase.messages);
    const beforeEntries = structuredClone(f.manager.getEntries());
    const beforeBytes = readFileSync(f.manager.getSessionFile()!, 'utf8');
    let persistCalls = 0;
    const persist = f.manager._persist.bind(f.manager);
    f.manager._persist = (...args: unknown[]) => { persistCalls += 1; return persist(...args as never[]); };
    const tailEntry = f.manager.getBranch().findLast((entry: { type: string }) => entry.type === 'message');
    const decision = decideFromPiePolicy(f.agent.state.messages, tailEntry?.id ?? '');
    assert.deepEqual(decision, { type: 'unsupported', reason: 'The session does not end at a supported continuation point.' });

    await assert.rejects(f.session.continueAfterInterruption(decision), /supported continuation point/u);

    assert.equal(f.streamCalls.length, 0);
    assert.deepEqual(f.events, []);
    assert.equal(persistCalls, 0);
    assert.deepEqual(f.manager.getEntries(), beforeEntries);
    assert.equal(readFileSync(f.manager.getSessionFile()!, 'utf8'), beforeBytes);
  });
}

test('real continuation with a stale write lease publishes no assistant terminal and still settles', async (t) => {
  const modules = await sourceModules;
  const tail = { role: 'user', content: 'current request', timestamp: 2 } as AgentMessage;
  const f = await fixture(t, baseMessages(tail), { deferred: true });
  const beforeEntries = structuredClone(f.manager.getEntries());
  const beforeBytes = readFileSync(f.manager.getSessionFile()!, 'utf8');
  let persistCalls = 0;
  const persist = f.manager._persist.bind(f.manager);
  f.manager._persist = (...args: unknown[]) => { persistCalls += 1; return persist(...args as never[]); };
  const lease = {
    coordinatorGeneration: 1, workerId: 'continuation-terminal-fence', workerGeneration: 1,
    ownershipRevision: 1, nonce: 'active-terminal-lease', canonicalSessionPath: f.manager.getSessionFile(),
  };
  let leaseActive = true;
  const rejectedWriteSeams: string[] = [];
  const adapter = {
    assertWriteLease(current: any, canonicalPath: string, seam: string) {
      if (!leaseActive || current !== lease || path.resolve(canonicalPath) !== path.resolve(lease.canonicalSessionPath)) {
        rejectedWriteSeams.push(seam);
        throw new modules.StaleSessionWriteLeaseError('Stale fixture lease.');
      }
    },
  };
  f.manager.attachPieWriteLease(adapter as never, lease as never);
  const tailEntry = f.manager.getBranch().findLast((entry: { type: string }) => entry.type === 'message');
  const run = f.session.continueAfterInterruption(decideFromPiePolicy(f.agent.state.messages, tailEntry.id));
  await f.started;
  assert.equal(f.streamCalls.length, 1, 'the real continuation reached the provider before the lease went stale');
  leaseActive = false;
  f.completeDeferredResponse();

  await assert.rejects(run, modules.StaleSessionWriteLeaseError);

  assert.ok(rejectedWriteSeams.length > 0, 'the stale lease rejected the assistant terminal append');
  assert.ok(rejectedWriteSeams.every((seam) => seam === '_appendEntry'));
  assert.equal(persistCalls, 0, 'the rejected assistant terminal never reached persistence');
  assert.deepEqual(f.manager.getEntries(), beforeEntries, 'the stale terminal did not change the durable transcript');
  assert.equal(readFileSync(f.manager.getSessionFile()!, 'utf8'), beforeBytes);
  assert.equal(f.events.some((event) => event.type === 'message_end'), false,
    'message_end is not published unless the assistant terminal is durable');
  assert.equal(f.events.filter((event) => event.type === 'agent_settled').length, 1,
    'the ordinary continuation lifecycle still settles exactly once after the rejected terminal write');
  assert.equal(f.events.at(-1)?.type, 'agent_settled');
});

test('continuation cancellation settles through AgentSession and does not synthesize a user row', async (t) => {
  const tail = { role: 'user', content: 'current request', timestamp: 2 } as AgentMessage;
  const f = await fixture(t, baseMessages(tail), { cancellable: true });
  const userRowsBefore = f.manager.getEntries().filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length;
  const tailEntry = f.manager.getBranch().findLast((entry: { type: string }) => entry.type === 'message');
  const run = f.session.continueAfterInterruption(decideFromPiePolicy(f.agent.state.messages, tailEntry.id));
  await f.started;
  await f.session.abort();
  await run;
  assert.equal(f.manager.getEntries().filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length,
    userRowsBefore);
  assert.equal(f.events.filter((event) => event.type === 'agent_settled').length, 1);
  assert.equal(f.manager.getLeafEntry()?.type, 'message');
  assert.equal((f.manager.getLeafEntry() as any).message.stopReason, 'aborted');
});

test('typed SDK context omission option filters initial, replacement, and self-reopen startup context', async (t) => {
  const modules = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-continuation-reopen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs');
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const auth = modules.AuthStorage.inMemory();
  auth.setRuntimeApiKey('anthropic', 'offline-continuation-fixture');
  const modelRegistry = modules.ModelRegistry.create(auth, path.join(root, 'models.json'));
  const settingsManager = modules.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const model = modules.getModel('anthropic', 'claude-sonnet-4-5');
  const startupObservations: Array<{ reason: string; roles: string[]; contents: string[] }> = [];
  const factoryOrder: string[] = [];
  const contextMessageOmissions: CreateAgentSessionOptions['contextMessageOmissions'] = (branchEntries) => {
    factoryOrder.push('resolver-evaluated');
    const messageEntries = branchEntries.flatMap((entry) => entry.type === 'message' ? [entry] : []);
    const tailEntry = messageEntries.at(-1);
    if (!tailEntry) return new Set<string>();
    const decision = decideFromPiePolicy(messageEntries.map((entry) => entry.message as AgentMessage), tailEntry.id);
    return new Set(decision.type === 'continue' ? decision.omitEntryIds ?? [] : []);
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    sessionManager, cwd: targetCwd, agentDir, sessionStartEvent, contextMessageOmissions: runtimeOmissions,
  }) => {
    factoryOrder.push('runtime-factory');
    assert.equal(typeof runtimeOmissions, 'function', 'runtime replacement forwards the configured resolver');
    const originalSetResolver = sessionManager.setContextMessageOmissionsResolver.bind(sessionManager);
    sessionManager.setContextMessageOmissionsResolver = (resolver) => {
      factoryOrder.push('omissions-installed');
      originalSetResolver(resolver);
    };
    const originalBuildSessionContext = sessionManager.buildSessionContext.bind(sessionManager);
    sessionManager.buildSessionContext = (options?: any) => {
      factoryOrder.push('context-built');
      return originalBuildSessionContext(options);
    };

    const runtime = modules.createExtensionRuntime();
    let session: any;
    const extension = await modules.loadExtensionFromFactory((api: any) => {
      api.on('session_start', (event: { reason: string }) => {
        const messages = session.agent.state.messages as any[];
        startupObservations.push({
          reason: event.reason,
          roles: messages.map((message) => message.role),
          contents: messages.map((message) => typeof message.content === 'string'
            ? message.content
            : Array.isArray(message.content) ? message.content.map((part: any) => part.text ?? '').join('') : ''),
        });
      });
    }, targetCwd, undefined, runtime, '<source-continuation-factory>');
    const resourceLoader = {
      getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'offline continuation fixture', getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const sdkOptions: CreateAgentSessionOptions = {
      cwd: targetCwd, agentDir, sessionManager, authStorage: auth, modelRegistry, settingsManager,
      model, resourceLoader, sessionStartEvent, contextMessageOmissions: runtimeOmissions,
    };
    const created = await modules.createAgentSession(sdkOptions);
    session = created.session;
    session.agent.streamFn = () => { throw new Error('Inference forbidden in startup observation test'); };
    await session.bindExtensions({});
    return {
      ...created,
      services: { cwd: targetCwd, agentDir, authStorage: auth, settingsManager, modelRegistry, resourceLoader, diagnostics: [] },
      diagnostics: [],
    };
  };

  const initialManager = modules.SessionManager.create(cwd, sessionDir);
  const firstReply = assistant([{ type: 'text', text: 'initial interrupted reply' }], 'aborted');
  initialManager.appendMessage({ role: 'user', content: 'initial request', timestamp: 1 } as never);
  const initialTailId = initialManager.appendMessage(firstReply as never);
  initialManager.appendThinkingLevelChange('medium');
  const initialEntries = structuredClone(initialManager.getEntries());
  const initialBytes = readFileSync(initialManager.getSessionFile()!, 'utf8');
  const runtimeOptions: CreateAgentSessionRuntimeOptions = {
    cwd, agentDir: path.join(root, 'agent'), sessionManager: initialManager, contextMessageOmissions,
  };
  const runtime = await modules.createAgentSessionRuntime(createRuntime, runtimeOptions);
  assert.ok(factoryOrder.indexOf('omissions-installed') < factoryOrder.indexOf('context-built'),
    'the typed resolver is installed before the SDK first constructs context');
  assert.equal(startupObservations[0].reason, 'startup');
  assert.equal(startupObservations[0].contents.includes('initial request'), true);
  assert.equal(startupObservations[0].contents.includes('initial interrupted reply'), false,
    'initial SDK session context is built after the omission setter');
  assert.deepEqual(initialManager.getEntries().find((entry: any) => entry.id === initialTailId)?.message, firstReply,
    'the omitted persisted assistant row is unchanged');
  assert.deepEqual(initialManager.getEntries(), initialEntries, 'initial context projection leaves every raw entry unchanged');
  assert.equal(readFileSync(initialManager.getSessionFile()!, 'utf8'), initialBytes,
    'initial context projection does not rewrite the raw transcript');

  const targetManager = modules.SessionManager.create(cwd, sessionDir);
  const targetReply = assistant([{ type: 'text', text: 'reopened interrupted reply' }], 'aborted');
  targetManager.appendMessage({ role: 'user', content: 'reopened request', timestamp: 2 } as never);
  const targetTailId = targetManager.appendMessage(targetReply as never);
  targetManager.appendThinkingLevelChange('medium');
  const targetEntries = structuredClone(targetManager.getEntries());
  const targetFile = targetManager.getSessionFile();
  const targetBytes = readFileSync(targetFile, 'utf8');
  await runtime.switchSession(targetFile);
  assert.equal(startupObservations[1].reason, 'resume');
  assert.equal(startupObservations[1].contents.includes('reopened request'), true);
  assert.equal(startupObservations[1].contents.includes('reopened interrupted reply'), false,
    'the real replacement factory attaches omissions before constructing the reopened AgentSession');
  assert.equal(readFileSync(targetFile, 'utf8'), targetBytes,
    'replacement context omission does not rewrite the raw transcript');
  assert.equal(JSON.stringify(runtime.session.sessionManager.getEntries()), JSON.stringify(targetEntries),
    'replacement context projection leaves every serialized raw entry unchanged');
  assert.equal(JSON.stringify(runtime.session.sessionManager.getEntry(targetTailId)?.message), JSON.stringify(targetReply));
  const installIndexes = factoryOrder.flatMap((event, index) => event === 'omissions-installed' ? [index] : []);
  const buildIndexes = factoryOrder.flatMap((event, index) => event === 'context-built' ? [index] : []);
  assert.equal(installIndexes.length, 2, 'the shared runtime factory installs the resolver for both sessions');
  assert.equal(buildIndexes.length, 2);
  assert.ok(installIndexes.every((index, sessionIndex) => index < buildIndexes[sessionIndex]));
  assert.equal(factoryOrder.filter((event) => event === 'resolver-evaluated').length, 2);

  await runtime.switchSession(targetFile);
  assert.equal(startupObservations[2].reason, 'resume');
  assert.equal(startupObservations[2].contents.includes('reopened interrupted reply'), false,
    'self-reopen rebuilds use the same context omission resolver');
  assert.equal(readFileSync(targetFile, 'utf8'), targetBytes);
  assert.equal(factoryOrder.filter((event) => event === 'omissions-installed').length, 3);
  assert.equal(factoryOrder.filter((event) => event === 'context-built').length, 3);
  assert.equal(factoryOrder.filter((event) => event === 'resolver-evaluated').length, 3);
});

test('SessionManager context omission resolver re-evaluates current branch without changing entries', async (t) => {
  const modules = await sourceModules;
  const manager = modules.SessionManager.inMemory();
  manager.appendMessage(assistant([], 'error', 'prompt is too long: 201000 tokens > 200000 maximum') as never);
  let evaluations = 0;
  manager.setContextMessageOmissionsResolver((branchEntries: readonly any[]) => {
    evaluations += 1;
    return new Set(branchEntries.flatMap((entry) => entry.type === 'message' && entry.message.role === 'assistant'
      ? [entry.id]
      : []));
  });

  assert.equal(manager.buildSessionContext().messages.some((message: any) => message.role === 'assistant'), false);
  const futureOverflowId = manager.appendMessage(
    assistant([], 'error', 'prompt is too long: 202000 tokens > 200000 maximum') as never,
  );
  const secondContext = manager.buildSessionContext();
  assert.equal(secondContext.messages.some((message: any) => message.role === 'assistant'), false,
    'a later consumed-overflow entry is omitted by reevaluating the resolver');
  assert.equal(evaluations, 2);
  assert.equal(manager.getEntry(futureOverflowId)?.type, 'message', 'omitted entries remain in the raw branch');
});

test('context projection is pure and stale SessionManager write leases still fence writes', async (t) => {
  const modules = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-source-continuation-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { mkdirSync } = await import('node:fs');
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = modules.SessionManager.create(cwd, sessionDir);
  const userId = manager.appendMessage({ role: 'user', content: 'keep me', timestamp: 1 } as never);
  const replyId = manager.appendMessage(assistant([{ type: 'text', text: 'omit me only in context' }]) as never);
  const beforeEntries = structuredClone(manager.getEntries());
  const beforeBytes = readFileSync(manager.getSessionFile()!, 'utf8');
  const defaultContext = modules.buildSessionContext(manager.getEntries(), manager.getLeafId());
  assert.equal(defaultContext.messages.some((message: any) => message.role === 'assistant'), true,
    'omitting the optional builder argument preserves the default transcript context');
  const context = modules.buildSessionContext(manager.getEntries(), manager.getLeafId(), undefined, {
    omitEntryIds: new Set([replyId]),
  });
  assert.equal(context.messages.some((message: any) => message.role === 'assistant'), false);
  assert.deepEqual(manager.getEntries(), beforeEntries);
  assert.equal(readFileSync(manager.getSessionFile()!, 'utf8'), beforeBytes);
  assert.equal(context.messages[0].role, 'user');
  assert.equal(typeof userId, 'string');

  const lease = {
    coordinatorGeneration: 1, workerId: 'continuation-fence', workerGeneration: 1,
    ownershipRevision: 1, nonce: 'active-lease', canonicalSessionPath: manager.getSessionFile(),
  };
  let leaseActive = true;
  const adapter = {
    assertWriteLease(current: any, canonicalPath: string) {
      if (!leaseActive || current !== lease || path.resolve(canonicalPath) !== path.resolve(lease.canonicalSessionPath)) {
        throw new modules.StaleSessionWriteLeaseError('Stale fixture lease.');
      }
    },
  };
  manager.attachPieWriteLease(adapter as never, lease as never);
  leaseActive = false;
  assert.throws(() => manager.appendMessage({ role: 'user', content: 'must be fenced', timestamp: 3 } as never),
    modules.StaleSessionWriteLeaseError);
  assert.deepEqual(manager.getEntries(), beforeEntries);
});
