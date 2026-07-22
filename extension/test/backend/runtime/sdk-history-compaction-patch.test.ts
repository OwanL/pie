import assert from 'node:assert/strict';
import test from 'node:test';

import { HISTORY_COMPACTION_ENV } from '../../../src/shared/protocol';
import {
  applySdkHistoryCompactionRuntimePatch,
  shouldRunHistoryCompaction,
} from '../../../src/backend/sdk';

const config = {
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
    agent = {
      state: { messages: ['raw'] as unknown[] },
      prepareNextTurnWithContext: undefined as undefined | ((turn: { context: Record<string, unknown> }) => Promise<Record<string, unknown>>),
    };
    sessionManager = {
      entries: [] as Array<{ type: string; id: string }>,
      getBranch: () => this.sessionManager.entries,
    };
    _isAgentRunActive = true;
    usage = { tokens: 0 as number | null, contextWindow: 10_000 };
    originalChecks = 0;
    compactions: boolean[] = [];

    constructor() {
      this._installAgentNextTurnRefresh();
    }

    _installAgentNextTurnRefresh(): void {
      this.agent.prepareNextTurnWithContext = async (turn) => ({ context: turn.context });
    }

    async _checkCompaction(_assistantMessage: { stopReason?: string } = {}): Promise<boolean> {
      this.originalChecks += 1;
      return false;
    }

    async _runAutoCompaction(_reason: 'threshold', willRetry: boolean): Promise<boolean> {
      this.compactions.push(willRetry);
      const id = `cmp-${this.compactions.length}`;
      this.sessionManager.entries.push({ type: 'compaction', id });
      this.agent.state.messages = [`summary-${id}`];
      return willRetry;
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

test('hard trigger compacts at the awaited between-turn barrier and refreshes loop context', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    assert.equal(applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never }), 'patched');
    const session = new FakeAgentSession();
    session.usage.tokens = 2_000;

    const snapshot = await session.agent.prepareNextTurnWithContext?.({ context: { messages: ['raw'] } });

    assert.deepEqual(session.compactions, [true], 'hard compaction marks that the current run will continue');
    assert.deepEqual(snapshot?.context, { messages: ['summary-cmp-1'] });
  });
});

test('soft trigger runs only after an active run and idle preflight uses the hard threshold', async () => {
  await withConfig(async () => {
    const FakeAgentSession = createFakeSessionClass();
    applySdkHistoryCompactionRuntimePatch({ AgentSession: FakeAgentSession as never });
    const session = new FakeAgentSession();
    session.usage.tokens = 1_500;

    const softResult = await session._checkCompaction({});
    assert.equal(softResult, false);
    assert.deepEqual(session.compactions, [false]);
    assert.equal(session.originalChecks, 0);

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
