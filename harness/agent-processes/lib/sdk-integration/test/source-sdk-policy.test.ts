import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentSession,
  CompactionHooks,
  ContinueAfterInterruptionDecision,
} from '../../../../pi/packages/coding-agent/dist/core/agent-session.js';
import type { ContextMessageOmissionsResolver, SessionEntry } from '../../../../pi/packages/coding-agent/dist/core/session-manager.js';
import { resolveHistoryCompactionSettings } from '../../../../session-storage/settings/history-compaction';
import { createSourceSdkPolicyAdapter } from '../source-sdk-policy';

function assistant(stopReason: string, errorMessage?: string): any {
  return {
    role: 'assistant',
    content: [],
    provider: 'fixture-provider',
    model: 'fixture-model',
    timestamp: 10,
    stopReason,
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
}

function messageEntry(id: string, message: any): any {
  return { type: 'message', id, parentId: null, message };
}

function compactionEntry(id: string): any {
  return {
    type: 'compaction',
    id,
    parentId: 'overflow-entry',
    summary: 'offline fixture',
    firstKeptEntryId: 'overflow-entry',
    tokensBefore: 100,
    details: { pieCompaction: { reason: 'overflow' } },
  };
}

const emptySettings = resolveHistoryCompactionSettings({
  thresholdMode: 'percentage',
  softThreshold: 70,
  hardThreshold: 85,
  keepRecentTokens: 10,
});

test('source policy composes durable consumed-overflow IDs with caller omissions', () => {
  const overflow = assistant('error', 'prompt is too long');
  const branch = [messageEntry('overflow-entry', overflow), compactionEntry('overflow-compaction')];
  const callerResolver: ContextMessageOmissionsResolver = () => new Set(['caller-entry']);
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => undefined,
    beforeCompact: () => undefined,
  });

  const omitted = adapter.contextMessageOmissions(callerResolver)(branch as SessionEntry[]);
  assert.deepEqual([...omitted].sort(), ['caller-entry', 'overflow-entry']);
  assert.equal(branch[0].message, overflow, 'projection leaves the durable message object untouched');
});

test('source compaction hooks preserve Pie thresholds and estimated-overflow classification', async () => {
  let delegatedThresholdCalls = 0;
  const priorHooks: CompactionHooks = {
    shouldCompact: () => { delegatedThresholdCalls += 1; return true; },
  };
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => emptySettings,
    beforeCompact: () => undefined,
  });
  const hooks = adapter.compactionHooks(priorHooks);
  const model = { provider: 'fixture-provider', id: 'fixture-model', contextWindow: 100 } as any;

  assert.equal(await hooks.shouldCompact?.({
    trigger: 'soft', phase: 'post-run', contextUsage: { tokens: 70, contextWindow: 100, percent: 70 }, model,
  }), true);
  assert.equal(await hooks.shouldCompact?.({
    trigger: 'hard', phase: 'post-run', contextUsage: { tokens: 84, contextWindow: 100, percent: 84 }, model,
  }), false);
  assert.equal(delegatedThresholdCalls, 0, 'a configured Pie threshold owns native threshold fallback');

  const emptyLength = assistant('length');
  assert.equal(await hooks.isEstimatedContextOverflow?.({
    assistantMessage: emptyLength,
    contextUsage: { tokens: 97, contextWindow: 100, percent: 97 },
    model,
  }), false);
  assert.equal(await hooks.isEstimatedContextOverflow?.({
    assistantMessage: emptyLength,
    contextUsage: { tokens: 98, contextWindow: 100, percent: 98 },
    model,
  }), true);
});

test('missing Pie settings delegate threshold decisions to the existing source hook', async () => {
  let delegatedThresholdCalls = 0;
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => undefined,
    beforeCompact: () => undefined,
  });
  const hooks = adapter.compactionHooks({
    shouldCompact: () => { delegatedThresholdCalls += 1; return undefined; },
  });

  assert.equal(await hooks.shouldCompact?.({
    trigger: 'hard', phase: 'between-turn', contextUsage: undefined, model: undefined,
  }), undefined);
  assert.equal(delegatedThresholdCalls, 1);
});

test('source compaction decisions take precedence over Pie summary customization', async () => {
  let pieSummaryCalls = 0;
  const pieSummary = { compaction: { summary: 'Pie summary' } } as any;
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => undefined,
    beforeCompact: async () => {
      pieSummaryCalls += 1;
      return pieSummary;
    },
  });
  const hooks = adapter.compactionHooks();
  const event = {} as Parameters<NonNullable<CompactionHooks['beforeCompact']>>[0];
  const session = {} as AgentSession;
  const sourceDecisions = [{ cancel: true }, { compaction: { summary: 'source summary' } }] as any[];

  for (const sourceDecision of sourceDecisions) {
    const result = await adapter.compactionHooks({ beforeCompact: async () => sourceDecision })
      .beforeCompact?.(event, session);
    assert.strictEqual(result, sourceDecision);
  }
  assert.equal(pieSummaryCalls, 0, 'cancel/summary decisions bypass Pie summary customization');

  const result = await hooks.beforeCompact?.(event, session);
  assert.strictEqual(result, pieSummary);
  assert.equal(pieSummaryCalls, 1, 'Pie summary policy runs when the source supplies no decision');
});

test('continuation-only factory adaptation leaves runtime-forwarded options unchanged', async () => {
  const aborted = assistant('aborted');
  const sourceSession = {
    messages: [aborted],
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => [messageEntry('interrupted-entry', aborted)] },
    async continueAfterInterruption(_decision: ContinueAfterInterruptionDecision) {},
  } as unknown as AgentSession;
  const options = { marker: 'runtime owns its policies' };
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => emptySettings,
    beforeCompact: () => undefined,
  });
  const factory = adapter.wrapContinuationFactory(async (received: typeof options) => {
    assert.strictEqual(received, options);
    return { session: sourceSession, marker: 'preserved result' };
  });
  const created = await factory(options);

  assert.equal(created.marker, 'preserved result');
  await created.session.continueAfterInterruption();
});

test('wrapped source factory installs policies before context creation and adapts legacy continuation', async () => {
  const aborted = assistant('aborted');
  const branch = [messageEntry('interrupted-entry', aborted)];
  const factoryOrder: string[] = [];
  const receivedDecisions: ContinueAfterInterruptionDecision[] = [];
  const sourceSession = {
    messages: [aborted],
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => branch },
    async continueAfterInterruption(decision: ContinueAfterInterruptionDecision) {
      receivedDecisions.push(decision);
    },
  } as unknown as AgentSession;
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => emptySettings,
    beforeCompact: async (_event, session) => {
      factoryOrder.push('pie-summary-policy');
      assert.equal(typeof session.getCompactionRequestAuth, 'function');
      return undefined;
    },
  });
  const factory = adapter.wrapFactory(async (options: {
    contextMessageOmissions?: ContextMessageOmissionsResolver;
    compactionHooks?: CompactionHooks;
  }) => {
    factoryOrder.push('factory-entered');
    assert.equal(options.contextMessageOmissions?.(branch as SessionEntry[]).has('interrupted-entry'), false);
    assert.equal(typeof options.compactionHooks?.shouldCompact, 'function');
    assert.equal(typeof options.compactionHooks?.isEstimatedContextOverflow, 'function');
    assert.equal(typeof options.compactionHooks?.beforeCompact, 'function');
    factoryOrder.push('first-context-built');
    return { session: sourceSession };
  });

  const created = await factory({});
  assert.deepEqual(factoryOrder, ['factory-entered', 'first-context-built']);
  await created.session.continueAfterInterruption();
  assert.deepEqual(receivedDecisions, [{ type: 'continue', omitEntryIds: ['interrupted-entry'] }]);
  const explicitDecision = { type: 'unsupported', reason: 'caller decision' } as const;
  await created.session.continueAfterInterruption(explicitDecision);
  assert.strictEqual(receivedDecisions.at(-1), explicitDecision, 'typed source decisions remain supported');
});

test('wrapped continuation rejects unsupported Pie tails through the source decision API', async () => {
  const ordinaryError = assistant('error', 'provider rejected the request');
  const sourceSession = {
    messages: [ordinaryError],
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => [messageEntry('error-entry', ordinaryError)] },
    async continueAfterInterruption(decision: ContinueAfterInterruptionDecision) {
      if (decision.type === 'unsupported') throw new Error(decision.reason);
    },
  } as unknown as AgentSession;
  const adapter = createSourceSdkPolicyAdapter({
    readHistoryCompactionSettings: () => undefined,
    beforeCompact: () => undefined,
  });
  const factory = adapter.wrapFactory(async () => ({ session: sourceSession }));
  const created = await factory({});

  await assert.rejects(created.session.continueAfterInterruption(), /supported continuation point/u);
});
