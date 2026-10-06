import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { CompactionHooks } from '@earendil-works/pi-coding-agent';

import { classifyInterruptedContinuationTail } from '../sdk';
import {
  consumedOverflowMessageEntryIds,
  isContextOverflowMessage,
} from '../../../workers/history-compaction';
import { sourceFixture } from './source-fixture.js';

// Transform shapes, version markers, and patch idempotence are no longer SDK
// contracts. Source continuation/history/terminal/loader suites cover those
// behavioral routes; keep the pure policy edges and uncovered lifecycle edges.
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': sourceFixture.packageRoots.ai,
  '@earendil-works/pi-agent-core': sourceFixture.packageRoots.agent,
  '@earendil-works/pi-tui': sourceFixture.packageRoots.tui,
  '@earendil-works/pi-coding-agent': sourceFixture.packageRoots.codingAgent,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => specifier === name || specifier.startsWith(`${name}/`));
      assert.ok(packageName, `Unapproved source SDK package: ${specifier}`);
      const packageRoot = approvedPackages[packageName];
      const subpath = specifier.slice(packageName.length).replace(/^\//u, '');
      const target = subpath === 'package.json' ? path.join(packageRoot, 'package.json')
        : path.join(packageRoot, 'dist', subpath ? `${subpath.replace(/\.js$/u, '')}.js` : 'index.js');
      const resolved = realpathSync(target);
      assert.ok(resolved.startsWith(`${packageRoot}${path.sep}`), `Source SDK package escape: ${resolved}`);
      return nextResolve(pathToFileURL(resolved).href, context);
    }
    const result = nextResolve(specifier, context);
    assert.ok(result.url.startsWith('file:'), `Non-file source SDK dependency: ${specifier}`);
    const resolved = realpathSync(fileURLToPath(result.url));
    assert.ok(resolved.startsWith(`${sourceFixture.piRoot}${path.sep}`), `Source SDK graph escape: ${resolved}`);
    return result;
  },
});

const sourceModules = Promise.all([
  import(pathToFileURL(path.join(sourceFixture.packageRoots.codingAgent, 'dist/index.js')).href),
  import(pathToFileURL(path.join(sourceFixture.packageRoots.agent, 'dist/index.js')).href),
  import(pathToFileURL(path.join(sourceFixture.packageRoots.ai, 'dist/compat.js')).href),
]);

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: text ? [{ type: 'text', text }] : [],
    api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
    stopReason, timestamp: Date.now(),
    ...(stopReason === 'error' ? { errorMessage: 'prompt is too long: 201000 tokens > 200000 maximum' } : {}),
    usage: { input: 10, output: text ? 3 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: text ? 13 : 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function continuationFixture(t: test.TestContext, overflowEachRun = false) {
  const [sdk, { Agent }, { EventStream, getModel }] = await sourceModules;
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-source-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'cwd');
  const sessionDir = path.join(root, 'sessions');
  mkdirSync(cwd);
  mkdirSync(sessionDir);
  const manager = sdk.SessionManager.create(cwd, sessionDir);
  manager.setContextMessageOmissionsResolver(consumedOverflowMessageEntryIds);
  manager.appendMessage({ role: 'user', content: 'earlier work', timestamp: 1 });
  manager.appendMessage(assistant('delivered answer'));
  const model = getModel('anthropic', 'claude-sonnet-4-5');
  const auth = sdk.AuthStorage.inMemory();
  auth.setRuntimeApiKey('anthropic', 'offline-backend-continuation');
  const modelRegistry = sdk.ModelRegistry.create(auth, path.join(root, 'models.json'));
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: overflowEachRun, reserveTokens: 20, keepRecentTokens: 1 },
  });
  const providerContexts: unknown[][] = [];
  const agent = new Agent({
    initialState: { model, tools: [], systemPrompt: 'offline continuation fixture' },
    streamFn: (_model: unknown, context: { messages: unknown[] }) => {
      providerContexts.push(structuredClone(context.messages));
      const result = overflowEachRun ? assistant('', 'error') : assistant('continued answer');
      const latestCompaction = manager.getBranch().findLast((entry: { type: string }) => entry.type === 'compaction');
      if (latestCompaction) result.timestamp = Math.max(result.timestamp, Date.parse(latestCompaction.timestamp) + 1);
      const response = new EventStream(
        (event: { type: string }) => event.type === 'done' || event.type === 'error',
        (event: { message: AssistantMessage }) => event.message,
      );
      queueMicrotask(() => {
        response.push({ type: 'start', partial: result });
        response.push({ type: 'done', reason: result.stopReason, message: result });
      });
      return response;
    },
  });
  const compactionHooks: CompactionHooks = {
    shouldCompact: () => false,
    beforeCompact: (event) => {
      const failedEntry = event.branchEntries.slice().reverse().find((entry) => entry.type === 'message'
        && entry.message.role === 'assistant' && entry.message.stopReason === 'error');
      assert.ok(failedEntry, 'the overflow failure is durable before recovery');
      return { compaction: {
        summary: 'offline recovery summary of earlier work and delivered answer', firstKeptEntryId: failedEntry.id,
        tokensBefore: event.preparation.tokensBefore,
        details: { pieCompaction: { reason: event.reason } },
      } };
    },
  };
  const session = new sdk.AgentSession({
    agent, sessionManager: manager, settingsManager, cwd, modelRegistry,
    baseToolsOverride: {}, compactionHooks,
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'offline continuation fixture', getAppendSystemPrompt: () => [],
      extendResources: () => {}, reload: async () => {},
    },
  });
  t.after(() => session.dispose());
  const events: Array<{ type: string; message?: { role?: string }; sessionEntryId?: string }> = [];
  session.subscribe((event: typeof events[number]) => events.push(event));
  return { manager, session, agent, providerContexts, events };
}

test('source continuation preserves a completed reply and persists only the new assistant through the ordinary lifecycle', async (t) => {
  const f = await continuationFixture(t);
  const beforeEntries = structuredClone(f.manager.getEntries());
  const completedReply = f.manager.buildSessionContext().messages[1];
  const beforeBytes = readFileSync(f.manager.getSessionFile()!, 'utf8');
  assert.equal(classifyInterruptedContinuationTail(f.manager.buildSessionContext().messages, 200_000), 'completed-assistant');

  await f.session.continueAfterInterruption({ type: 'continue' });

  assert.deepEqual(f.agent.state.messages.map((message: { role: string }) => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(f.providerContexts.length, 1);
  assert.equal(f.agent.state.messages[1], completedReply, 'the completed reply object is preserved, not replaced');
  assert.match(JSON.stringify(f.providerContexts[0]), /delivered answer/u);
  assert.deepEqual(f.manager.getEntries().slice(0, beforeEntries.length), beforeEntries);
  assert.ok(readFileSync(f.manager.getSessionFile()!, 'utf8').startsWith(beforeBytes));
  const newEntries = f.manager.getEntries().slice(beforeEntries.length);
  assert.equal(newEntries.length, 1, 'the already-durable completed reply is not rewritten');
  assert.equal(newEntries[0].type, 'message');
  assert.equal(newEntries[0].message.role, 'assistant');
  assert.equal(newEntries[0].message.stopReason, 'stop');
  assert.equal(f.events.some((event) => event.type === 'message_start' && event.message?.role === 'user'), false);
  assert.deepEqual(f.events.filter((event) => ['agent_start', 'agent_end', 'agent_settled'].includes(event.type))
    .map((event) => event.type), ['agent_start', 'agent_end', 'agent_settled']);
});

test('explicit source continuation starts a fresh bounded overflow recovery attempt each time', async (t) => {
  const f = await continuationFixture(t, true);
  for (let run = 1; run <= 2; run += 1) {
    const tailEntry = f.manager.getBranch().findLast((entry: { type: string }) => entry.type === 'message');
    const tail = classifyInterruptedContinuationTail(f.manager.buildSessionContext().messages, 200_000);
    assert.equal(tail, run === 1 ? 'completed-assistant' : 'overflow-assistant');
    await f.session.continueAfterInterruption({ type: 'continue',
      ...(tail === 'overflow-assistant' ? { omitEntryIds: [tailEntry.id] } : {}),
    });
    assert.equal(f.providerContexts.length, run * 2, 'each explicit continuation gets its own single recovery retry');
    assert.equal(f.manager.getBranch().filter((entry: { type: string }) => entry.type === 'compaction').length, run);
    assert.equal(f.events.filter((event) => event.type === 'compaction_end'
      && 'errorMessage' in event && String(event.errorMessage).includes('after one compact-and-retry attempt')).length, run,
    'a second overflow exhausts the bound without another provider request');
    assert.equal(f.events.filter((event) => event.type === 'agent_settled').length, run);
    assert.equal(f.events.at(-1)?.type, 'agent_settled');
    assert.equal(f.manager.getEntries().filter((entry: any) => entry.type === 'message' && entry.message.role === 'user').length, 1);
  }
  assert.equal(f.manager.getEntries().filter((entry: any) => entry.type === 'message'
    && entry.message.role === 'assistant' && entry.message.stopReason === 'error').length, 4,
  'all failed provider rows remain durable, including each exhausted retry');
});

test('forced-overflow classification keeps transcript and continuation decisions aligned', () => {
  const dashScope = {
    role: 'assistant' as const,
    stopReason: 'error',
    errorMessage: 'Range of input length should be [1, 131072]',
    content: [],
  };
  const emptyLength = {
    role: 'assistant' as const,
    stopReason: 'length',
    content: [],
    usage: { input: 10, output: 0, cacheRead: 0 },
  };
  const allZeroEmptyLength = {
    role: 'assistant' as const,
    stopReason: 'length',
    content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque' }],
    usage: { input: 0, output: 0, cacheRead: 0 },
  };
  const completedOverWindow = {
    role: 'assistant' as const,
    stopReason: 'stop',
    content: 'delivered answer',
    usage: { input: 201_000, output: 10, cacheRead: 0 },
  };

  assert.equal(isContextOverflowMessage(dashScope), true);
  assert.equal(classifyInterruptedContinuationTail([dashScope], 200_000), 'overflow-assistant');
  assert.equal(isContextOverflowMessage(emptyLength), true);
  assert.equal(classifyInterruptedContinuationTail([emptyLength], 200_000), 'overflow-assistant');
  assert.equal(isContextOverflowMessage(allZeroEmptyLength), true);
  assert.equal(classifyInterruptedContinuationTail([allZeroEmptyLength], 200_000), 'overflow-assistant');
  assert.equal(isContextOverflowMessage(completedOverWindow, 200_000), false);
  // A completed stop over the reported window is a settled reply, not overflow:
  // continuation preserves it in the provider context, and native overflow
  // recovery owns any subsequent provider-side rejection.
  assert.equal(classifyInterruptedContinuationTail([completedOverWindow], 200_000), 'completed-assistant');

  assert.equal(
    classifyInterruptedContinuationTail([
      { role: 'assistant' as const, stopReason: 'length', content: [{ type: 'text', text: 'cut-off text' }], usage: { input: 10, output: 4, cacheRead: 0 } },
    ], 200_000),
    'completed-assistant',
  );
  assert.equal(
    classifyInterruptedContinuationTail([{ role: 'assistant', stopReason: 'error', errorMessage: 'provider 500', content: [] }]),
    undefined,
  );
  assert.equal(
    classifyInterruptedContinuationTail([
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'tool-1', name: 'read' }] },
    ], 200_000),
    undefined,
    'a completed reply with a dangling tool call has no valid provider boundary',
  );
});

test('threshold compaction consumes an all-zero empty length failure left by context exhaustion', () => {
  const entries = [
    {
      id: 'tool', type: 'message', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'toolResult' as const, toolCallId: 'tool-1', content: 'large result' },
    },
    {
      id: 'empty-length', type: 'message', timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant' as const,
        stopReason: 'length',
        content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque' }],
        usage: { input: 0, output: 0, cacheRead: 0 },
      },
    },
    {
      id: 'compact', type: 'compaction', timestamp: '2026-01-01T00:00:02.000Z',
      details: { pieCompaction: { reason: 'threshold' } },
    },
  ];

  assert.deepEqual([...consumedOverflowMessageEntryIds(entries)], ['empty-length']);
});

test('successful assistant output is never consumed by an overflow-marked compaction', () => {
  const entries = [
    {
      id: 'answer', type: 'message', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'assistant' as const, stopReason: 'stop', content: 'delivered answer' },
    },
    {
      id: 'compact', type: 'compaction', timestamp: '2026-01-01T00:00:01.000Z',
      details: { pieCompaction: { reason: 'overflow' } },
    },
  ];
  assert.deepEqual([...consumedOverflowMessageEntryIds(entries)], []);
});
