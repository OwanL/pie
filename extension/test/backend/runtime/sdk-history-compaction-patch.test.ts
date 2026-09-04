import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_COMPACTION_ENV,
  type HistoryCompactionSettings,
} from '../../../src/shared/protocol';
import {
  applySdkHistoryCompactionRuntimePatch,
  shouldRunHistoryCompaction,
} from '../../../src/backend/sdk';

const config: HistoryCompactionSettings = {
  enabled: true,
  thresholdMode: 'tokens' as const,
  softThreshold: 1_000,
  hardThreshold: 2_000,
  keepRecentTokens: 30_000,
  summaryInstructions: '',
  summaryThinkingLevel: 'inherit' as const,
  summaryModel: null,
  modelProfiles: {},
};

function withConfig<T>(
  fn: () => Promise<T> | T,
  settings: typeof config = config,
): Promise<T> {
  const previous = process.env[HISTORY_COMPACTION_ENV];
  process.env[HISTORY_COMPACTION_ENV] = JSON.stringify(settings);
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env[HISTORY_COMPACTION_ENV];
    else process.env[HISTORY_COMPACTION_ENV] = previous;
  });
}

function createFakeSessionClass() {
  return class FakeAgentSession {
    queuedMessages = false;
    agent = {
      state: {
        messages: [
          { role: 'user', content: 'work' },
          { role: 'assistant', stopReason: 'stop', content: 'partial result' },
        ] as unknown[],
      },
      prepareNextTurnWithContext: undefined as undefined | ((turn: {
        context: Record<string, unknown>;
        message?: { role?: string; stopReason?: string; content?: unknown[] };
        toolResults?: unknown[];
      }) => Promise<Record<string, unknown> | undefined>),
      hasQueuedMessages: () => this.queuedMessages,
    };
    sessionManager = {
      entries: [] as Array<{ type: string; id: string }>,
      getBranch: () => this.sessionManager.entries,
    };
    _isAgentRunActive = true;
    usage = { tokens: 0 as number | null, contextWindow: 10_000 };
    originalChecks = 0;
    compactions: boolean[] = [];
    compactionReasons: Array<'threshold' | 'overflow'> = [];
    messagesAtCompaction: unknown[][] = [];
    emitted: unknown[] = [];
    postRunMessage?: {
      stopReason?: string;
      content?: unknown[];
      usage?: { input?: number; cacheRead?: number; output?: number };
    };

    constructor() {
      this._installAgentNextTurnRefresh();
    }

    _installAgentNextTurnRefresh(): void {
      this.agent.prepareNextTurnWithContext = async (turn) => ({ context: turn.context });
    }

    async _checkCompaction(
      _assistantMessage: {
        stopReason?: string;
        provider?: string;
        model?: string;
        content?: unknown[];
        usage?: { input?: number; cacheRead?: number; output?: number };
      } = {},
      _skipAbortedCheck = true,
    ): Promise<boolean> {
      this.originalChecks += 1;
      return false;
    }

    async _runAutoCompaction(reason: 'threshold' | 'overflow', willRetry: boolean): Promise<boolean> {
      this.compactionReasons.push(reason);
      this.compactions.push(willRetry);
      this.messagesAtCompaction.push(this.agent.state.messages.slice());
      const id = `cmp-${this.compactions.length}`;
      this.sessionManager.entries.push({ type: 'compaction', id });
      this.agent.state.messages = [
        { role: 'compactionSummary', summary: `summary-${id}` },
        { role: 'user', content: 'work' },
        { role: 'assistant', stopReason: 'stop', content: 'partial result' },
      ];
      return willRetry;
    }

    _emit(event: unknown): void {
      this.emitted.push(event);
    }

    async _handlePostAgentRun(): Promise<boolean> {
      const message = this.postRunMessage;
      this.postRunMessage = undefined;
      return message ? await this._checkCompaction(message) : false;
    }

    getContextUsage() {
      return this.usage;
    }
  };
}

test('history compaction threshold helper resolves percentage and token modes', () => {
  assert.equal(shouldRunHistoryCompaction(config, { tokens: 999, contextWindow: 10_000 }, 'soft'), false);
  assert.equal(shouldRunHistoryCompaction(config, { tokens: 1_000, contextWindow: 10_000 }, 'soft'), true);
  assert.equal(shouldRunHistoryCompaction({ ...config, thresholdMode: 'percentage', softThreshold: 70, hardThreshold: 85, keepRecentTokens: 30_000, summaryInstructions: '', summaryThinkingLevel: 'inherit', summaryModel: null, modelProfiles: {} }, { tokens: 8_500, contextWindow: 10_000 }, 'hard'), true);
  assert.equal(shouldRunHistoryCompaction(undefined, { tokens: 9_000, contextWindow: 10_000 }, 'hard'), false);

  const profiled = {
    ...config,
    modelProfiles: {
      'test/profiled': { softThreshold: 3_000, hardThreshold: 4_000, keepRecentTokens: 1_000 },
    },
  };
  assert.equal(
    shouldRunHistoryCompaction(profiled, { tokens: 2_500, contextWindow: 10_000 }, 'soft', { provider: 'test', id: 'profiled' }),
    false,
  );
  assert.equal(
    shouldRunHistoryCompaction(profiled, { tokens: 3_000, contextWindow: 10_000 }, 'soft', { provider: 'test', id: 'profiled' }),
    true,
  );
});

test('hard trigger compacts at the awaited between-turn barrier and refreshes a continuing tool loop', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    assert.equal(applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never }), 'patched');
    const session = new FakeAgentSession();
    session.usage.tokens = 2_000;

    const snapshot = await session.agent.prepareNextTurnWithContext?.({
      context: { messages: ['raw'] },
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall' }] },
      toolResults: [{ role: 'toolResult' }],
    });

    assert.deepEqual(session.compactions, [true], 'hard compaction marks the natural tool loop as continuing');
    assert.deepEqual(snapshot?.context, { messages: session.agent.state.messages });
  });
});

test('hard compaction after a completed terminal response does not resume the agent', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 2_000;

    await session.agent.prepareNextTurnWithContext?.({
      context: { messages: session.agent.state.messages },
      message: { role: 'assistant', stopReason: 'stop', content: [] },
      toolResults: [],
    });
    const shouldContinue = await session._handlePostAgentRun();

    assert.deepEqual(session.compactions, [false], 'completed output is compacted without retry intent');
    assert.equal(shouldContinue, false, 'the AgentSession outer loop must remain settled');
    assert.equal(
      (session.agent.state.messages.at(-1) as { role?: string } | undefined)?.role,
      'assistant',
      'the completed assistant response remains the provider-context tail',
    );
  });
});

test('hard compaction preserves an already-queued user continuation', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 2_000;
    session.queuedMessages = true;

    await session.agent.prepareNextTurnWithContext?.({
      context: { messages: session.agent.state.messages },
      message: { role: 'assistant', stopReason: 'stop', content: [] },
      toolResults: [],
    });

    assert.deepEqual(session.compactions, [true], 'queued user work keeps the existing run active');
  });
});

test('hard compaction during a terminating tool batch does not add an outer-loop continuation', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 2_000;

    await session.agent.prepareNextTurnWithContext?.({
      context: { messages: session.agent.state.messages },
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall' }] },
      toolResults: [{ terminate: true }],
    });

    assert.deepEqual(session.compactions, [true]);
    assert.equal(await session._handlePostAgentRun(), false);
  });
});

test('soft threshold compaction after a completed agent run does not resume it', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 1_500;

    session.postRunMessage = {
      stopReason: 'stop',
      content: [],
      usage: { input: 1_500, cacheRead: 0, output: 100 },
    };

    assert.equal(await session._handlePostAgentRun(), false);
    assert.deepEqual(session.compactions, [false], 'completed output is compacted without retry intent');
    assert.equal(
      (session.agent.state.messages.at(-1) as { role?: string } | undefined)?.role,
      'assistant',
    );
    assert.equal(session.originalChecks, 0);
  });
});

test('pre-prompt soft compaction does not create a second continuation', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 1_500;

    assert.equal(await session._checkCompaction({}, false), false);
    assert.deepEqual(session.compactions, [false]);
    assert.equal(await session._handlePostAgentRun(), false);
  });
});

test('idle preflight uses the hard threshold', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const idle = new FakeAgentSession();
    idle._isAgentRunActive = false;
    idle.usage.tokens = 1_500;

    await idle._checkCompaction({});

    assert.deepEqual(idle.compactions, []);
    assert.equal(idle.originalChecks, 0, 'the configured hard limit replaces pi native threshold timing');
  });
});

test('disabled proactive compaction does not fall through to pi native thresholds', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 9_000;

    await session._checkCompaction({ stopReason: 'stop' });

    assert.deepEqual(session.compactions, []);
    assert.equal(session.originalChecks, 0, 'enabled=false must suppress native threshold compaction');
  }, { ...config, enabled: false });
});

test('provider errors always delegate to pi overflow recovery', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 9_000;

    await session._checkCompaction({ stopReason: 'error' });

    assert.deepEqual(session.compactions, []);
    assert.equal(session.originalChecks, 1);
  });
});

test('silent stop and length overflows delegate to pi overflow recovery', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });

    const lengthOverflow = new FakeAgentSession();
    (lengthOverflow as unknown as { model: unknown }).model = { provider: 'test', id: 'm', contextWindow: 10_000 };
    await lengthOverflow._checkCompaction({
      stopReason: 'length',
      usage: { input: 9_900, cacheRead: 0, output: 0 },
    } as never);
    assert.equal(lengthOverflow.originalChecks, 1);
    assert.deepEqual(lengthOverflow.compactions, []);

    const stopOverflow = new FakeAgentSession();
    (stopOverflow as unknown as { model: unknown }).model = { provider: 'test', id: 'm', contextWindow: 10_000 };
    await stopOverflow._checkCompaction({
      stopReason: 'stop',
      usage: { input: 10_001, cacheRead: 0, output: 10 },
    } as never);
    assert.equal(stopOverflow.originalChecks, 1);
    assert.deepEqual(stopOverflow.compactions, []);
  });
});

test('all-zero empty length response near the context window uses bounded overflow recovery', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    (session as unknown as { model: unknown }).model = { provider: 'test', id: 'm', contextWindow: 10_000 };
    session.usage.tokens = 9_840;

    const shouldContinue = await session._checkCompaction({
      stopReason: 'length',
      provider: 'test',
      model: 'm',
      content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque' }],
      usage: { input: 0, cacheRead: 0, output: 0 },
    });

    assert.equal(shouldContinue, true);
    assert.deepEqual(session.compactionReasons, ['overflow']);
    assert.deepEqual(session.compactions, [true]);
    assert.equal(
      (session.messagesAtCompaction[0]?.at(-1) as { role?: string } | undefined)?.role,
      'user',
      'the failed assistant tail is removed before automatic continuation',
    );
  });
});

test('all-zero empty length recovery respects an already-owned SDK overflow attempt', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    (session as unknown as { model: unknown }).model = { provider: 'test', id: 'm', contextWindow: 10_000 };
    (session as unknown as { _overflowRecoveryAttempted: boolean })._overflowRecoveryAttempted = true;
    session.usage.tokens = 9_840;

    assert.equal(await session._checkCompaction({
      stopReason: 'length',
      provider: 'test',
      model: 'm',
      content: [],
      usage: { input: 0, cacheRead: 0, output: 0 },
    }), false);

    assert.deepEqual(session.compactionReasons, []);
    assert.deepEqual(session.emitted, [{
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.',
    }]);
  });
});

test('post-compaction unknown usage prevents a second all-zero empty length recovery', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    (session as unknown as { model: unknown }).model = { provider: 'test', id: 'm', contextWindow: 10_000 };
    session.usage.tokens = 9_840;
    const overflow = {
      stopReason: 'length',
      provider: 'test',
      model: 'm',
      content: [{ type: 'thinking', thinking: '' }],
      usage: { input: 0, cacheRead: 0, output: 0 },
    };

    assert.equal(await session._checkCompaction(overflow), true);
    session.usage.tokens = null;
    (session as unknown as { _overflowRecoveryAttempted: boolean })._overflowRecoveryAttempted = false;
    assert.equal(await session._checkCompaction(overflow), false);

    assert.deepEqual(session.compactionReasons, ['overflow']);
  });
});

test('all-zero empty length recovery rejects model mismatch and sub-boundary estimates', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });

    const mismatch = new FakeAgentSession();
    (mismatch as unknown as { model: unknown }).model = { provider: 'test', id: 'current', contextWindow: 10_000 };
    mismatch.usage.tokens = 9_840;
    assert.equal(await mismatch._checkCompaction({
      stopReason: 'length', provider: 'test', model: 'old', content: [],
      usage: { input: 0, cacheRead: 0, output: 0 },
    }), false);
    assert.deepEqual(mismatch.compactionReasons, ['threshold']);
    assert.deepEqual(mismatch.compactions, [false]);

    const belowBoundary = new FakeAgentSession();
    (belowBoundary as unknown as { model: unknown }).model = { provider: 'test', id: 'current', contextWindow: 10_000 };
    belowBoundary.usage.tokens = 9_799;
    assert.equal(await belowBoundary._checkCompaction({
      stopReason: 'length', provider: 'test', model: 'current', content: [],
      usage: { input: 0, cacheRead: 0, output: 0 },
    }), false);
    assert.deepEqual(belowBoundary.compactionReasons, ['threshold']);
    assert.deepEqual(belowBoundary.compactions, [false]);
  });
});

test('compaction customization refuses an SDK shape that cannot install the model override', () => {
  const AgentSession = createFakeSessionClass();
  const result = applySdkHistoryCompactionRuntimePatch({
    AgentSession: AgentSession as never,
    prepareCompaction: () => ({ firstKeptEntryId: 'kept', tokensBefore: 5_000 }),
    compact: async () => ({
      summary: 'summary',
      firstKeptEntryId: 'kept',
      tokensBefore: 5_000,
    }),
  } as never);

  assert.equal(result, 'unsupported-shape');
});

test('compaction customization refuses a runtime without an extension runner', () => {
  class MissingExtensionRunnerSession extends createFakeSessionClass() {
    constructor() {
      super();
      this._buildRuntime();
    }

    _buildRuntime(): void {}
  }

  const result = applySdkHistoryCompactionRuntimePatch({
    AgentSession: MissingExtensionRunnerSession as never,
    prepareCompaction: () => ({ firstKeptEntryId: 'kept', tokensBefore: 5_000 }),
    compact: async () => ({
      summary: 'summary',
      firstKeptEntryId: 'kept',
      tokensBefore: 5_000,
    }),
  } as never);

  assert.equal(result, 'patched');
  assert.throws(
    () => new MissingExtensionRunnerSession(),
    /history-compaction patch failed: extension runner unavailable/i,
  );
});

test('configured summary model never falls back to the active model when unavailable', async () => {
  await withConfig(async () => {
    let compactCalls = 0;
    class MissingSummaryModelSession extends createFakeSessionClass() {
      model = { provider: 'chat', id: 'expensive', contextWindow: 10_000 };
      settingsManager = {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 }),
      };
      _modelRegistry = { find: () => undefined };
      _extensionRunner = {
        hasHandlers: (_eventType: string) => false,
        emit: async (_event: unknown) => undefined as unknown,
      };

      constructor() {
        super();
        this._buildRuntime();
      }

      _buildRuntime(): void {
        this._extensionRunner = {
          hasHandlers: (_eventType: string) => false,
          emit: async (_event: unknown) => undefined as unknown,
        };
      }

      async _getCompactionRequestAuth() {
        return { apiKey: 'active-model-key' };
      }
    }

    const sdk = {
      AgentSession: MissingSummaryModelSession as never,
      prepareCompaction: () => ({ firstKeptEntryId: 'kept', tokensBefore: 5_000 }),
      compact: async () => {
        compactCalls += 1;
        throw new Error('compact must not run with the active model');
      },
    };
    assert.equal(applySdkHistoryCompactionRuntimePatch(sdk as never), 'patched');
    const session = new MissingSummaryModelSession();
    const result = await session._extensionRunner.emit({
      type: 'session_before_compact',
      preparation: { firstKeptEntryId: 'native', tokensBefore: 5_000 },
      branchEntries: [{ type: 'message' }],
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    }) as { cancel?: boolean } | undefined;

    assert.deepEqual(result, { cancel: true });
    assert.equal(compactCalls, 0);
  }, {
    ...config,
    summaryModel: { provider: 'summary', id: 'cheap' },
  });
});

test('request failure blocks configured-model fallback but preserves explicit active-model fallback', async () => {
  const compactedModels: string[] = [];
  class FailingSummaryRequestSession extends createFakeSessionClass() {
    model = { provider: 'chat', id: 'expensive', contextWindow: 10_000 };
    settingsManager = {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 }),
    };
    _modelRegistry = {
      find: (provider: string, id: string) => ({ provider, id, contextWindow: 10_000 }),
    };
    _extensionRunner = {
      hasHandlers: (_eventType: string) => false,
      emit: async (_event: unknown) => undefined as unknown,
    };

    constructor() {
      super();
      this._buildRuntime();
    }

    _buildRuntime(): void {
      this._extensionRunner = {
        hasHandlers: (_eventType: string) => false,
        emit: async (_event: unknown) => undefined as unknown,
      };
    }

    async _getCompactionRequestAuth() {
      return { apiKey: 'summary-model-key' };
    }
  }

  const sdk = {
    AgentSession: FailingSummaryRequestSession as never,
    prepareCompaction: () => ({ firstKeptEntryId: 'kept', tokensBefore: 5_000 }),
    compact: async (_preparation: unknown, model: { id: string }) => {
      compactedModels.push(model.id);
      throw new Error('summary provider failed');
    },
  };
  applySdkHistoryCompactionRuntimePatch(sdk as never);
  const emitCompaction = async () => {
    const session = new FailingSummaryRequestSession();
    return await session._extensionRunner.emit({
      type: 'session_before_compact',
      preparation: { firstKeptEntryId: 'native', tokensBefore: 5_000 },
      branchEntries: [{ type: 'message' }],
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    }) as { cancel?: boolean } | undefined;
  };

  await withConfig(async () => {
    assert.deepEqual(await emitCompaction(), { cancel: true });
    assert.deepEqual(compactedModels, ['cheap']);
  }, {
    ...config,
    summaryModel: { provider: 'summary', id: 'cheap' },
  });

  compactedModels.length = 0;
  await withConfig(async () => {
    assert.equal(await emitCompaction(), undefined);
    assert.deepEqual(compactedModels, ['expensive']);
  });

  compactedModels.length = 0;
  const previous = process.env[HISTORY_COMPACTION_ENV];
  process.env[HISTORY_COMPACTION_ENV] = '{invalid';
  try {
    assert.deepEqual(await emitCompaction(), { cancel: true });
    assert.deepEqual(compactedModels, []);
  } finally {
    if (previous === undefined) delete process.env[HISTORY_COMPACTION_ENV];
    else process.env[HISTORY_COMPACTION_ENV] = previous;
  }
});

test('before-compact customization applies retention, instructions, thinking and model overrides', async () => {
  const previous = process.env[HISTORY_COMPACTION_ENV];
  process.env[HISTORY_COMPACTION_ENV] = JSON.stringify({
    ...config,
    keepRecentTokens: 30_000,
    summaryInstructions: 'Preserve exact test failures.',
    summaryThinkingLevel: 'low',
    summaryModel: { provider: 'summary', id: 'fast' },
    modelProfiles: {
      'chat/main': { softThreshold: 4_000, hardThreshold: 6_000, keepRecentTokens: 2_500 },
    },
  });

  try {
    const preparations: unknown[] = [];
    const compactions: unknown[][] = [];
    class CustomizableSession extends createFakeSessionClass() {
      model = { provider: 'chat', id: 'main', contextWindow: 10_000 };
      thinkingLevel = 'high' as const;
      settingsManager = {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
      };
      _modelRegistry = {
        find: (provider: string, id: string) => provider === 'summary' && id === 'fast'
          ? { provider, id, contextWindow: 20_000 }
          : undefined,
      };
      _extensionRunner = {
        hasHandlers: (_eventType: string) => false,
        emit: async (_event: unknown) => undefined as unknown,
      };

      constructor() {
        super();
        this._buildRuntime();
      }

      _buildRuntime(): void {
        this._extensionRunner = {
          hasHandlers: (_eventType: string) => false,
          emit: async (_event: unknown) => undefined as unknown,
        };
      }

      async _getCompactionRequestAuth() {
        return { apiKey: 'test-key', headers: { test: '1' }, env: { TEST: '1' } };
      }
    }

    const sdk = {
      AgentSession: CustomizableSession as never,
      prepareCompaction: (entries: unknown[], settings: unknown) => {
        preparations.push([entries, settings]);
        return { firstKeptEntryId: 'kept', tokensBefore: 5_000 };
      },
      compact: async (...args: unknown[]) => {
        compactions.push(args);
        return {
          summary: 'custom summary',
          firstKeptEntryId: 'kept',
          tokensBefore: 5_000,
          details: { readFiles: ['a.ts'], modifiedFiles: [] },
        };
      },
    };
    assert.equal(applySdkHistoryCompactionRuntimePatch(sdk as never), 'patched');
    const session = new CustomizableSession();
    const event = {
      type: 'session_before_compact',
      preparation: { firstKeptEntryId: 'native', tokensBefore: 5_000 },
      branchEntries: [{ type: 'message' }],
      reason: 'threshold',
      willRetry: false,
      signal: new AbortController().signal,
    };
    assert.equal(session._extensionRunner.hasHandlers('session_before_compact'), true);
    const result = session._extensionRunner.hasHandlers('session_before_compact')
      ? await session._extensionRunner.emit(event) as { compaction?: { details?: Record<string, unknown> } }
      : undefined;

    assert.ok(result);
    assert.deepEqual(preparations, [[event.branchEntries, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 2_500,
    }]]);
    assert.equal(compactions.length, 1);
    assert.equal((compactions[0][1] as { id?: string }).id, 'fast');
    assert.equal(compactions[0][4], 'Preserve exact test failures.');
    assert.equal(compactions[0][6], 'low');
    assert.deepEqual(result.compaction?.details?.pieCompaction, {
      version: 1,
      reason: 'threshold',
      modelId: 'fast',
      provider: 'summary',
      thinkingLevel: 'low',
      keepRecentTokens: 2_500,
      instructionsApplied: true,
    });
  } finally {
    if (previous === undefined) delete process.env[HISTORY_COMPACTION_ENV];
    else process.env[HISTORY_COMPACTION_ENV] = previous;
  }
});
