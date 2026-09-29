import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { cloneTreeByHardlink } from './helpers/clone-tree-by-hardlink';
import { createNormalizeSessionManager } from './sdk-patch-barrier-shared';

import {
  applySdkInterruptedContinuationRuntimePatch,
  applySdkOverflowCompactionContextPatch,
  applySdkRetryHotPatch,
  applySdkTerminalDurabilityPatch,
  classifyInterruptedContinuationTail,
  ensureSdkPatchBarrier,
  loadSdk,
  loadSdkInternalModule,
} from '../sdk';
import {
  consumedOverflowMessageEntryIds,
  isContextOverflowMessage,
} from '../../../workers/history-compaction';

interface PinnedRealSdkSession {
  subscribe(listener: (event: { type: string; message?: { role?: string } }) => void): () => void;
  continueAfterInterruption(): Promise<void>;
}

test('interrupted continuation removes only the aborted provider-context tail and starts without a user prompt', async () => {
  const runInputs: unknown[][] = [];
  class FakeAgentSession {
    agent = {
      state: {
        messages: [
          { role: 'user', content: 'work' },
          { role: 'assistant', stopReason: 'aborted', content: 'partial' },
        ] as unknown[],
      },
    };
    async _runAgentPrompt(messages: unknown[]): Promise<void> {
      runInputs.push(messages);
    }
  }

  const patch = applySdkInterruptedContinuationRuntimePatch({
    AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
  });
  assert.equal(patch, 'patched');
  const session = new FakeAgentSession() as FakeAgentSession & {
    continueAfterInterruption(): Promise<void>;
  };
  await session.continueAfterInterruption();

  assert.deepEqual(session.agent.state.messages, [{ role: 'user', content: 'work' }]);
  assert.deepEqual(runInputs, [[]], 'continuation enters the run lifecycle with no prompt messages');
  assert.equal(
    applySdkInterruptedContinuationRuntimePatch({
      AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
    }),
    'already-present',
  );
});

test('interrupted continuation resumes an open provider turn after a user or tool result', async (t) => {
  for (const tail of [
    { role: 'user', content: 'work' },
    { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
  ]) {
    await t.test(tail.role, async () => {
      const runInputs: unknown[][] = [];
      class FakeAgentSession {
        agent = { state: { messages: [tail] as unknown[] } };
        async _runAgentPrompt(messages: unknown[]): Promise<void> {
          runInputs.push(messages);
        }
      }
      applySdkInterruptedContinuationRuntimePatch({
        AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
      });
      const session = new FakeAgentSession() as FakeAgentSession & {
        continueAfterInterruption(): Promise<void>;
      };

      await session.continueAfterInterruption();

      assert.deepEqual(session.agent.state.messages, [tail], 'the existing provider boundary remains intact');
      assert.deepEqual(runInputs, [[]], 'continuation enters the run lifecycle with no prompt messages');
    });
  }
});

test('interrupted continuation retries a provider-forced context overflow and resets the bounded recovery attempt', async () => {
  const runInputs: unknown[][] = [];
  class FakeAgentSession {
    agent = {
      state: {
        messages: [
          { role: 'compactionSummary', summary: 'kept work' },
          { role: 'user', content: 'finish the task' },
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'prompt is too long: 201000 tokens > 200000 maximum',
            content: [],
          },
        ] as unknown[],
      },
    };
    _overflowRecoveryAttempted = true;
    async _runAgentPrompt(messages: unknown[]): Promise<void> {
      runInputs.push(messages);
    }
  }
  applySdkInterruptedContinuationRuntimePatch({
    AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
  });
  const session = new FakeAgentSession() as FakeAgentSession & {
    continueAfterInterruption(): Promise<void>;
  };

  await session.continueAfterInterruption();

  assert.deepEqual(session.agent.state.messages, [
    { role: 'compactionSummary', summary: 'kept work' },
    { role: 'user', content: 'finish the task' },
  ]);
  assert.equal(session._overflowRecoveryAttempted, false);
  assert.deepEqual(runInputs, [[]]);
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

test('interrupted continuation resumes after a completed assistant reply and retains it in provider context', async () => {
  const runInputs: unknown[][] = [];
  const user = { role: 'user', content: 'work' };
  const completed = {
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: 'delivered answer' }],
    usage: { input: 1_000, output: 10, cacheRead: 0 },
  };
  class FakeAgentSession {
    agent = { state: { messages: [user, completed] as unknown[] } };
    _overflowRecoveryAttempted = true;
    async _runAgentPrompt(messages: unknown[]): Promise<void> {
      runInputs.push(messages);
    }
  }
  applySdkInterruptedContinuationRuntimePatch({
    AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
  });
  const session = new FakeAgentSession() as FakeAgentSession & {
    continueAfterInterruption(): Promise<void>;
  };

  await session.continueAfterInterruption();

  assert.deepEqual(
    session.agent.state.messages,
    [user, completed],
    'the completed reply stays in the provider context and no user message is added',
  );
  assert.equal(session._overflowRecoveryAttempted, false);
  assert.deepEqual(runInputs, [[]], 'continuation enters the run lifecycle with no prompt messages');
});

test('interrupted continuation still rejects an ordinary provider error tail', async () => {
  class FakeAgentSession {
    agent = {
      state: { messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'provider 500', content: [] }] as unknown[] },
    };
    async _runAgentPrompt(): Promise<void> {}
  }
  applySdkInterruptedContinuationRuntimePatch({
    AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
  });
  const session = new FakeAgentSession() as FakeAgentSession & {
    continueAfterInterruption(): Promise<void>;
  };
  await assert.rejects(
    session.continueAfterInterruption(),
    /does not end at a supported continuation point/,
  );
});

test('pinned real SDK continues after a completed reply without a new user message and settles with persistence', async () => {
  await withPinnedSdkDist(async (sdkDir) => {
    const agentSessionModule = (await import(
      pathToFileURL(path.join(sdkDir, 'dist', 'core', 'agent-session.js')).href
    )) as { AgentSession: new (config: Record<string, unknown>) => PinnedRealSdkSession };
    const agentCoreModule = (await import(
      pathToFileURL(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-agent-core', 'dist', 'index.js')).href
    )) as { Agent: new (options: unknown) => { state: { messages: unknown[] } } };
    const extensionsModule = (await import(
      pathToFileURL(path.join(sdkDir, 'dist', 'core', 'extensions', 'index.js')).href
    )) as { createExtensionRuntime: () => unknown };

    assert.equal(
      applySdkInterruptedContinuationRuntimePatch({
        AgentSession: agentSessionModule.AgentSession as unknown as { prototype: Record<string, unknown> },
      }),
      'patched',
      'the pinned real AgentSession prototype must accept the runtime continuation patch',
    );

    const user = { role: 'user', content: [{ type: 'text', text: 'earlier work' }], timestamp: 1 };
    const completedReply = {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'delivered answer' }],
      usage: { input: 1_000, output: 10, cacheRead: 0 },
      provider: 'fake',
      model: 'fake-model',
      timestamp: 2,
    };
    const fakeModel = { id: 'fake-model', provider: 'fake', contextWindow: 200_000, maxTokens: 4_096 };
    const persisted: Array<{ role?: string; stopReason?: string }> = [];
    const fakeStreamFn = async () => {
      const finalMessage = {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'continued answer' }],
        usage: { input: 1_100, output: 5, cacheRead: 0 },
        provider: 'fake',
        model: 'fake-model',
        timestamp: 3,
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: { ...finalMessage, content: [] } };
          yield { type: 'done' };
        },
        result: async () => finalMessage,
      };
    };
    const agent = new agentCoreModule.Agent({
      initialState: {
        systemPrompt: 'test system prompt',
        messages: [user, completedReply],
        model: fakeModel,
      },
      streamFn: fakeStreamFn,
    });
    const sessionManager = {
      appendMessage: (message: { role?: string; stopReason?: string }) => {
        persisted.push(message);
        return `entry-${persisted.length}`;
      },
      appendCustomMessageEntry: () => 'custom-entry',
      getBranch: () => [],
      getEntries: () => [],
      getCwd: () => sdkDir,
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    };
    const session = new agentSessionModule.AgentSession({
      agent,
      sessionManager,
      settingsManager: {
        getImageAutoResize: () => false,
        getShellCommandPrefix: () => '',
        getShellPath: () => undefined,
        getCompactionSettings: () => ({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 }),
        getRetrySettings: () => ({ enabled: false, maxRetries: 0 }),
        isProjectTrusted: () => true,
      },
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: extensionsModule.createExtensionRuntime() }),
        getSystemPrompt: () => '',
        getAppendSystemPrompt: () => [],
        getSkills: () => ({ skills: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
      cwd: sdkDir,
    });

    const events: Array<{ type: string; message?: { role?: string } }> = [];
    session.subscribe((event) => events.push(event));
    await session.continueAfterInterruption();

    assert.deepEqual(
      agent.state.messages.map((message) => (message as { role?: string }).role),
      ['user', 'assistant', 'assistant'],
      'the completed reply stays in context and the continuation appends only the new assistant response',
    );
    assert.equal(agent.state.messages[1], completedReply, 'the completed reply object is preserved, not stripped or replaced');
    assert.equal(
      events.some((event) => event.type === 'message_start' && event.message?.role === 'user'),
      false,
      'the continuation must not emit a new user message',
    );
    assert.deepEqual(
      persisted.map((message) => ({ role: message.role, stopReason: message.stopReason })),
      [{ role: 'assistant', stopReason: 'stop' }],
      'only the new assistant response reaches durable persistence; the already-durable completed reply is not rewritten',
    );
    assert.deepEqual(
      events.filter((event) => ['agent_start', 'agent_end', 'agent_settled'].includes(event.type)).map((event) => event.type),
      ['agent_start', 'agent_end', 'agent_settled'],
      'the continuation runs the ordinary SDK lifecycle through agent_settled',
    );
  });
});

test('interrupted continuation rejects a completed assistant that ends with a dangling tool call', async () => {
  class FakeAgentSession {
    agent = {
      state: {
        messages: [
          { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', id: 'tool-1', name: 'read' }] },
        ] as unknown[],
      },
    };
    async _runAgentPrompt(): Promise<void> {}
  }
  applySdkInterruptedContinuationRuntimePatch({
    AgentSession: FakeAgentSession as unknown as { prototype: Record<string, unknown> },
  });
  const session = new FakeAgentSession() as FakeAgentSession & {
    continueAfterInterruption(): Promise<void>;
  };
  await assert.rejects(
    session.continueAfterInterruption(),
    /does not end at a supported continuation point/,
  );
});

test('overflow context projection omits the provider error across reopen and duplicate rebuilds', () => {
  const user = { role: 'user', content: 'finish the task' };
  const overflow = {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'context length exceeded',
  };
  const entries = [
    { id: 'user', type: 'message', message: user },
    { id: 'overflow', type: 'message', message: overflow },
    {
      id: 'compact',
      type: 'compaction',
      details: { pieCompaction: { reason: 'overflow' } },
    },
  ];
  class FakeSessionManager {
    getBranch() { return entries; }
    buildContextEntries() { return [entries[2], entries[0], entries[1]]; }
    buildSessionContext() {
      return {
        messages: [{ role: 'compactionSummary', summary: 'kept work' }, user, { ...overflow, content: [] }],
        thinkingLevel: 'off',
        model: null,
      };
    }
  }

  assert.equal(applySdkOverflowCompactionContextPatch({
    SessionManager: FakeSessionManager as unknown as { prototype: Record<string, unknown> },
  }), 'patched');
  const context = new FakeSessionManager().buildSessionContext();

  assert.deepEqual(context.messages, [
    { role: 'compactionSummary', summary: 'kept work' },
    user,
  ]);
});

const SESSION_MANAGER_PATCH_SOURCE = `
import { randomUUID } from "crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync, } from "fs";
import { resolve } from "path";
export const CURRENT_SESSION_VERSION = 3;
const normalizePath = (value) => value;
const getDefaultSessionDir = (cwd) => cwd;
export class SessionManager {
  flushed = false;
  constructor(cwd, dir) {
    this.cwd = cwd;
    this.dir = dir;
    this.sessionFile = resolve(dir, randomUUID() + ".jsonl");
    this.header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
  }
  getCwd() { return this.cwd; }
  getSessionFile() { return this.sessionFile; }
  getHeader() { return this.header; }
  getSessionName() { return undefined; }
  getBranch() { return []; }
  getEntries() { return []; }
  static listAll() { return Promise.resolve([]); }
  static open(sessionPath) { const manager = new SessionManager('/repo', resolve(sessionPath, '..')); manager.sessionFile = sessionPath; return manager; }
  static forkFrom(_sourcePath, cwd, sessionDir) { return SessionManager.create(cwd, sessionDir); }
  static continueRecent(cwd, sessionDir) { return SessionManager.create(cwd, sessionDir); }
  static create(cwd, sessionDir, options) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
        return new SessionManager(cwd, dir, undefined, true, options);
  }
}
`;

const DURABILITY_PATCH_SOURCE = `
        // Emit to extensions first
        await this._emitExtensionEvent(event);
        // Notify all listeners
        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
        // Handle session persistence
        if (event.type === "message_end") {
            if (event.message.role === "custom") {
                this.sessionManager.appendCustomMessageEntry(event.message.customType, event.message.content, event.message.display, event.message.details);
            }
            else if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult") {
                this.sessionManager.appendMessage(event.message);
            }
            // Other message types
        }
`;

let pinnedDistTemplatePromise: Promise<string> | undefined;
let pinnedDistTemplateRoot: string | undefined;

async function pinnedSdkDistTemplate(distributionRoot: string): Promise<string> {
  // Build one private dist template in OS temp, then clone it per fixture.
  if (!pinnedDistTemplatePromise) {
    pinnedDistTemplatePromise = fs.mkdtemp(
      path.join(os.tmpdir(), 'pie-sdk-contract-template-'),
    ).then(async (templateRoot) => {
      await fs.cp(
        path.join(distributionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist'),
        path.join(templateRoot, 'dist'),
        { recursive: true },
      );
      // SDK fixture helpers share a process-level fingerprint environment
      // override. Normalize this private copy to the same pinned pristine
      // manager image as the barrier fixtures instead of fingerprinting whatever
      // already-patched bytes happen to be installed.
      await createNormalizeSessionManager(path.join(templateRoot, 'dist'));
      pinnedDistTemplateRoot = templateRoot;
      return templateRoot;
    });
  }
  return pinnedDistTemplatePromise;
}
test.after(async () => {
  if (pinnedDistTemplateRoot) await fs.rm(pinnedDistTemplateRoot, { recursive: true, force: true });
});

async function withSdkDir(files: Record<string, string>, run: (sdkDir: string) => Promise<void>): Promise<void> {
  // Keep mutable SDK clones in OS temp. Link only hoisted dependencies from
  // the distribution owner; never write to its installed SDK.
  const distributionRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', 'application', 'hosts', 'vscode',
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sdk-contract-test-'));
  const sdkDir = path.join(root, 'sdk');
  await fs.mkdir(sdkDir);
  await fs.symlink(path.join(distributionRoot, 'node_modules'), path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const previousTrustedRoot = process.env.PIE_TRUSTED_SDK_ROOT;
  const previousFixtureFingerprints = process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
  process.env.PIE_TRUSTED_SDK_ROOT = sdkDir;
  try {
    const requiresBarrier = !!files['dist/index.js'] || !!files['dist/config.js'];
    if (requiresBarrier) {
      await cloneTreeByHardlink(await pinnedSdkDistTemplate(distributionRoot), sdkDir, [
        ...Object.keys(files),
        // The barrier may rewrite any patch target; keep the shared template
        // pristine by private-copying everything a test or patch touches.
        'dist/core/agent-session.js',
        'dist/core/session-manager.js',
        'dist/core/agent-session-runtime.js',
        'node_modules/@earendil-works/pi-ai/dist/utils/retry.js',
      ]);
      await fs.mkdir(path.join(sdkDir, 'node_modules', '@earendil-works'), { recursive: true });
      await fs.symlink(
        path.join(distributionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-agent-core'),
        path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-agent-core'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await fs.writeFile(
      path.join(sdkDir, 'package.json'),
      JSON.stringify({ type: 'module', version: '0.80.6-test' }),
      'utf8',
    );
    if (!requiresBarrier && !files['dist/core/session-manager.js']) {
      files = { 'dist/core/session-manager.js': SESSION_MANAGER_PATCH_SOURCE, ...files };
    }
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(sdkDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf8');
    }
    if (requiresBarrier) {
      const patchTargets = [
        'dist/core/agent-session.js',
        'node_modules/@earendil-works/pi-ai/dist/utils/retry.js',
        'dist/core/session-manager.js',
        'dist/core/agent-session-runtime.js',
      ];
      process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = JSON.stringify({
        sdkVersion: '0.80.6-test',
        pristineSha256ByRelativePath: Object.fromEntries(await Promise.all(patchTargets.map(async (relativePath) => [
          relativePath,
          createHash('sha256').update(await fs.readFile(path.join(sdkDir, relativePath))).digest('hex'),
        ]))),
      });
    }
    await run(sdkDir);
  } finally {
    if (previousTrustedRoot === undefined) delete process.env.PIE_TRUSTED_SDK_ROOT;
    else process.env.PIE_TRUSTED_SDK_ROOT = previousTrustedRoot;
    if (previousFixtureFingerprints === undefined) delete process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS;
    else process.env.PIE_SDK_PATCH_FIXTURE_FINGERPRINTS = previousFixtureFingerprints;
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Clone the real pinned SDK dist template into a private temp tree so a test
 * can patch the real AgentSession prototype in memory and drive the real
 * agent-session/agent-core code without touching the installed SDK. */
async function withPinnedSdkDist(run: (sdkDir: string) => Promise<void>): Promise<void> {
  const distributionRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', 'application', 'hosts', 'vscode',
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sdk-continuation-real-'));
  const sdkDir = path.join(root, 'sdk');
  await fs.mkdir(sdkDir);
  await fs.symlink(path.join(distributionRoot, 'node_modules'), path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await cloneTreeByHardlink(await pinnedSdkDistTemplate(distributionRoot), sdkDir, [
    'dist/core/agent-session.js',
  ]);
  // The pinned SDK ships a fully nested node_modules; expose every top-level
  // entry so imports rooted at the cloned dist resolve exactly like production.
  const nestedSdkNodeModules = path.join(
    distributionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules',
  );
  await fs.mkdir(path.join(sdkDir, 'node_modules'), { recursive: true });
  for (const entry of await fs.readdir(nestedSdkNodeModules, { withFileTypes: true })) {
    await fs.symlink(
      path.join(nestedSdkNodeModules, entry.name),
      path.join(sdkDir, 'node_modules', entry.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await fs.writeFile(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({ type: 'module', version: '0.80.6-test' }),
    'utf8',
  );
  try {
    await run(sdkDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('loadSdk rejects disallowed paths before attempting to import', async () => {
  const testDir = path.parse(path.dirname(fileURLToPath(import.meta.url))).root;
  await assert.rejects(
    async () => await loadSdk(path.join(testDir, 'disallowed-pie-sdk')),
    /Refusing to load SDK from disallowed path/,
  );
});

test('applySdkRetryHotPatch extends the current pi-ai retry.js array shape for terminal-event cuts + provider-gate stalls', async () => {
  // Current SDK shape: the retryable pattern is a string array in
  // pi-ai/dist/utils/retry.js (joined into a RegExp). The needle is the
  // quoted array entry with trailing comma so it does not match the comment
  // line that also mentions `stream ended before message_stop`.
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = [
        "ended without",
        "stream ended before message_stop",
        "http2 request did not get a response",
      ];
      // Comment mentioning "stream ended before message_stop" without a trailing comma - must NOT be matched.
      export function isRetryableAssistantError(message) { return RETRYABLE.some(p => new RegExp(p, "i").test(message.errorMessage)); }
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');

    assert.equal(result, 'patched');
    // New array entries appended after the matched one.
    assert.match(patched, /"stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "upstream transport circuit open",/);
    // The comment line must be untouched (no trailing-comma needle injected there).
    assert.match(patched, /Comment mentioning "stream ended before message_stop" without/);
  });
});

test('applySdkRetryHotPatch extends the legacy inline agent-session.js classifier shape', async () => {
  // Legacy SDK shape: an inline regex in dist/core/agent-session.js.
  await withSdkDir({
    'dist/core/agent-session.js': `
      return /ended without|stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');

    assert.equal(result, 'patched');
    assert.match(patched, /stream ended before message_stop\|stream ended before a terminal response event\|upstream stream stalled\|upstream header phase stalled\|upstream transport circuit open/);
  });
});

test('applySdkRetryHotPatch prefers the current pi-ai shape when both files exist', async () => {
  // Both shapes present (e.g. a transitional install): the current pi-ai
  // retry.js array shape is patched, the legacy agent-session.js untouched.
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["ended without", "stream ended before message_stop", "timeout"];
    `,
    'dist/core/agent-session.js': `
      return /stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'patched');
    const retryJs = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');
    const agentSession = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(retryJs, /stream ended before a terminal response event/);
    // Legacy file was NOT touched (no marker injected there).
    assert.doesNotMatch(agentSession, /stream ended before a terminal response event/);
  });
});

test('applySdkRetryHotPatch adds newly-required patterns to a previously patched SDK', async () => {
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "timeout"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    const patched = await fs.readFile(path.join(sdkDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'retry.js'), 'utf8');
    assert.equal(result, 'patched');
    assert.match(patched, /upstream transport circuit open/);
  });
});

test('applySdkRetryHotPatch is a no-op when every required pattern is present', async () => {
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["stream ended before message_stop", "stream ended before a terminal response event", "upstream stream stalled", "upstream header phase stalled", "upstream transport circuit open", "timeout"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'already-present');
  });
});

test('applySdkRetryHotPatch falls back to legacy shape when the pi-ai file is absent', async () => {
  // An older global npm install may only have the inline classifier.
  await withSdkDir({
    'dist/core/agent-session.js': `
      return /stream ended before message_stop|timeout/i.test(err);
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'patched');
  });
});

test('applySdkRetryHotPatch reports missing-target when no candidate file exists', async () => {
  await withSdkDir({}, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'missing-target');
  });
});

test('applySdkRetryHotPatch reports unsupported-shape when a candidate file exists but the needle is gone', async () => {
  // The classifier was restructured again (needle absent in both shapes).
  await withSdkDir({
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const R = ["totally different pattern"];
    `,
  }, async (sdkDir) => {
    const result = await applySdkRetryHotPatch(sdkDir);
    assert.equal(result, 'unsupported-shape');
  });
});

test('terminal durability patch publishes message_end only after append with stable entry id', async () => {
  await withSdkDir({ 'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE }, async (sdkDir) => {
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'patched');
    const patched = await fs.readFile(path.join(sdkDir, 'dist', 'core', 'agent-session.js'), 'utf8');
    assert.match(patched, /event\.type !== "message_end"/u);
    assert.match(patched, /sessionEntryId = this\.sessionManager\.appendMessage/u);
    assert.match(patched, /this\._emit\(\{ \.\.\.emittedEvent, sessionEntryId \}\)/u);
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'already-present');
  });
});

test('terminal durability patch fails closed on unsupported SDK shape', async () => {
  await withSdkDir({ 'dist/core/agent-session.js': 'class Changed {}' }, async (sdkDir) => {
    assert.equal(await applySdkTerminalDurabilityPatch(sdkDir), 'unsupported-shape');
  });
});

test('loadSdk imports allowed ESM SDK modules that satisfy the contract', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = ["stream ended before message_stop",];
    `,
    'dist/index.js': `
      export const VERSION = 'test-sdk';
      export class AgentSession {
        _installAgentNextTurnRefresh() {}
        _buildRuntime() {}
        async _checkCompaction() { return false; }
        async _handlePostAgentRun() { return false; }
        async _runAgentPrompt() {}
      }
      export const getAgentDir = () => '/agent';
      export const AuthStorage = { create: (filePath) => ({ filePath }) };
      export class SessionManager {
        constructor(cwd = '/repo', sessionPath) { this.cwd = cwd; this.sessionPath = sessionPath; }
        static listAll = async () => [];
        static continueRecent = (cwd) => new SessionManager(cwd);
        static create = (cwd) => new SessionManager(cwd);
        static inMemory = (cwd) => new SessionManager(cwd);
        static open = (sessionPath) => new SessionManager('/repo', sessionPath);
        getCwd() { return this.cwd; }
        getSessionFile() { return this.sessionPath; }
        getSessionName() { return undefined; }
        getBranch() { return []; }
        getEntries() { return []; }
        buildContextEntries() { return []; }
        buildSessionContext() { return { messages: [], thinkingLevel: 'off', model: null }; }
      }
      export const createAgentSessionServices = async () => ({ services: true });
      export const createAgentSessionFromServices = async () => ({ session: true });
      export const createAgentSessionRuntime = async () => ({ session: { isStreaming: false }, services: { modelRegistry: { getAvailable: () => [], find: () => undefined } }, dispose: async () => {} });
    `,
    'dist/core/system-prompt.js': `export const buildSystemPrompt = (options) => JSON.stringify(options);`,
    'dist/core/compaction/index.js': `
      globalThis.__pieInternalCompactionModuleLoaded = true;
      export const prepareCompaction = () => undefined;
      export const compact = async () => ({ summary: '', firstKeptEntryId: '', tokensBefore: 0 });
    `,
  }, async (sdkDir) => {
    delete (globalThis as { __pieInternalCompactionModuleLoaded?: boolean }).__pieInternalCompactionModuleLoaded;
    const sdk = await loadSdk(sdkDir);
    const systemPromptModule = await loadSdkInternalModule<{ buildSystemPrompt: (options: unknown) => string }>(sdkDir, path.join('core', 'system-prompt.js'));

    assert.equal(
      (globalThis as { __pieInternalCompactionModuleLoaded?: boolean }).__pieInternalCompactionModuleLoaded,
      true,
      'loadSdk must import the SDK internal compaction module when the package root does not export it',
    );
    delete (globalThis as { __pieInternalCompactionModuleLoaded?: boolean }).__pieInternalCompactionModuleLoaded;
    assert.equal(sdk.VERSION, 'test-sdk');
    assert.equal(sdk.getAgentDir(), '/agent');
    assert.deepEqual(await sdk.SessionManager.listAll(), []);
    assert.equal(systemPromptModule.buildSystemPrompt({ cwd: '/repo' }), '{"cwd":"/repo"}');
  });
});

test('cold coordinator mode imports only runtime-free exports and leaves AgentSession/compaction untouched', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = ["stream ended before message_stop",];
    `,
    'dist/config.js': `
      export const VERSION = 'cold-test-sdk';
      export const getAgentDir = () => '/cold-agent';
      export const getSessionsDir = () => '/cold-sessions';
    `,
    'dist/core/auth-storage.js': `
      export const AuthStorage = { create: (filePath) => ({ filePath }) };
    `,
    'dist/core/model-registry.js': `
      export const ModelRegistry = {
        create: (authStorage, modelsJsonPath) => ({ authStorage, modelsJsonPath, getAvailable: () => [] }),
      };
    `,
    'dist/index.js': `
      globalThis.__pieFullSdkEntryLoaded = true;
      export class AgentSession {}
    `,
    'dist/core/compaction/index.js': `
      globalThis.__pieInternalCompactionModuleLoaded = true;
      export const prepareCompaction = () => undefined;
      export const compact = async () => ({});
    `,
  }, async (sdkDir) => {
    const globals = globalThis as {
      __pieFullSdkEntryLoaded?: boolean;
      __pieInternalCompactionModuleLoaded?: boolean;
    };
    delete globals.__pieFullSdkEntryLoaded;
    delete globals.__pieInternalCompactionModuleLoaded;

    const sdk = await loadSdk(sdkDir, { mode: 'cold-coordinator' });

    assert.equal(sdk.VERSION, 'cold-test-sdk');
    assert.equal(sdk.getAgentDir(), '/cold-agent');
    assert.deepEqual(
      sdk.ModelRegistry.create(sdk.AuthStorage.create('/auth.json'), '/models.json').getAvailable(),
      [],
    );
    assert.deepEqual(await sdk.SessionManager.listAll(), []);
    assert.equal(globals.__pieFullSdkEntryLoaded, undefined);
    assert.equal(globals.__pieInternalCompactionModuleLoaded, undefined);
    assert.equal('AgentSession' in sdk, false);
    assert.equal('createAgentSessionRuntime' in sdk, false);
  });
});

test('loadSdk worker mode rejects a bad SDK fingerprint before evaluating the SDK entry', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = ["stream ended before message_stop",];
    `,
    'dist/index.js': `globalThis.__pieBadFingerprintSdkImported = true;`,
  }, async (sdkDir) => {
    delete (globalThis as { __pieBadFingerprintSdkImported?: boolean }).__pieBadFingerprintSdkImported;
    const identity = await ensureSdkPatchBarrier(sdkDir);
    const wrongIdentity = {
      ...identity,
      retryClassifier: { ...identity.retryClassifier, sha256: '0'.repeat(64) },
    };

    await assert.rejects(
      loadSdk(sdkDir, { mode: 'worker', patchIdentity: wrongIdentity }),
      /SHA-256 fingerprint verification failed/,
    );
    assert.equal(
      (globalThis as { __pieBadFingerprintSdkImported?: boolean }).__pieBadFingerprintSdkImported,
      undefined,
    );
  });
});

test('loadSdkInternalModule cold-worker validates read-only and never repairs the shared SDK', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = ["stream ended before message_stop",];
    `,
    'dist/index.js': `export const VERSION = 'cold-worker-test-sdk';`,
    'dist/core/cold-worker-proof.js': `globalThis.__pieColdWorkerInternalImported = true; export const loaded = true;`,
  }, async (sdkDir) => {
    const patchTargets = [
      'dist/core/agent-session.js',
      'node_modules/@earendil-works/pi-ai/dist/utils/retry.js',
      'dist/core/session-manager.js',
      'dist/core/agent-session-runtime.js',
    ];
    const pristine = new Map(await Promise.all(patchTargets.map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(sdkDir, relativePath)),
    ] as const)));
    const identity = await ensureSdkPatchBarrier(sdkDir);
    const coldWorkerSdkPath = path.join(path.dirname(sdkDir), 'cold-worker-sdk');
    await cloneTreeByHardlink(sdkDir, coldWorkerSdkPath, patchTargets);
    process.env.PIE_TRUSTED_SDK_ROOT = path.dirname(sdkDir);
    for (const [relativePath, contents] of pristine) {
      await fs.writeFile(path.join(coldWorkerSdkPath, relativePath), contents);
    }
    const coldWorkerIdentity = {
      ...identity,
      sdkPath: await fs.realpath(coldWorkerSdkPath),
    };
    delete (globalThis as { __pieColdWorkerInternalImported?: boolean }).__pieColdWorkerInternalImported;

    await assert.rejects(
      loadSdkInternalModule(coldWorkerSdkPath, 'core/cold-worker-proof.js', {
        mode: 'cold-worker',
        patchIdentity: coldWorkerIdentity,
      }),
      /SDK patch identity marker verification failed/,
    );
    for (const [relativePath, contents] of pristine) {
      assert.deepEqual(
        await fs.readFile(path.join(coldWorkerSdkPath, relativePath)),
        contents,
        `${relativePath} must remain untouched after cold-worker validation fails`,
      );
    }
    assert.equal(
      (globalThis as { __pieColdWorkerInternalImported?: boolean }).__pieColdWorkerInternalImported,
      undefined,
      'the internal SDK module must not be imported after failed identity validation',
    );
  });
});

test('loadSdk rejects modules that are missing required exports', async () => {
  await withSdkDir({
    'dist/core/agent-session.js': DURABILITY_PATCH_SOURCE,
    'node_modules/@earendil-works/pi-ai/dist/utils/retry.js': `
      const RETRYABLE = ["stream ended before message_stop",];
    `,
    'dist/index.js': `export const VERSION = 'broken-sdk'; export const getAgentDir = () => '/agent';`,
  }, async (sdkDir) => {
    await assert.rejects(
      async () => await loadSdk(sdkDir),
      /missing required exports/,
    );
  });
});
