import assert from 'node:assert/strict';
import test from 'node:test';

import { coerceRunSnapshot } from '../../../src/host/run-analytics/coercion-snapshots';
import { computeAggregateStats, pricingForModel, providerForModel } from '../../../src/host/stats-service/aggregate-stats';
import type { RunSnapshot } from '../../../src/host/run-analytics';
import type { ModelPricingRecord } from '../../../../shared/pricing-core';

const NOW = new Date(2026, 6, 20, 12).getTime();

function run(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    sessionPath: '/s', runId: 'r', taskGroupId: 't', status: 'open', scored: false,
    startedAt: new Date(NOW - 1_000).toISOString(), updatedAt: new Date(NOW).toISOString(),
    mixedModelConfig: false, mixedTreatmentConfig: false, treatmentChangeKinds: [],
    experimentAssignment: null, analyticsFactors: null, functionalSettings: null,
    sendCount: 1, assistantTurnCount: 1, assistantTurnDurationMs: 1,
    busyDurationMs: 1, busyPeriodCount: 1, interruptedCount: 0, messageEditCount: 0,
    truncatedAfterCount: 0, backendErrorCodes: [], contextTokens: null, contextLimit: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    tokenReportedTurnCount: 0, lastTurnUsage: null, turnThroughputSamples: [],
    filesystemPathRefCount: 0, imageInputCount: 0, imageInputBytes: 0,
    unsupportedInputCount: 0, inputKindsUsed: [],
    toolUsage: {
      totalCount: 0, failureCount: 0, executionFailureCount: 0,
      verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0,
      countsByName: {}, failureCountsByName: {}, failureCountsByKind: {},
      failureCountsByNameAndKind: {}, failureSamples: [], resultIssueCountsByName: {},
      resultIssueCountsByKind: {}, resultIssueCountsByNameAndKind: {}, resultIssueSamples: [],
      totalDurationMs: 0, timedCallCount: 0, durationMsByName: {},
      subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [],
    },
    fileMutation: { writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0,
      touchedFileCount: 0, lineAdditions: 0, lineDeletions: 0, lineModifications: 0,
      editCountsByFile: {}, readCountsByFile: {} },
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: { totalCount: 0, failureCount: 0, countsByKind: {} },
    ...overrides,
  } as RunSnapshot;
}

function price(provider: string, input: number, id = 'gpt-5.6-sol'): ModelPricingRecord {
  return { id, provider, pricing: { input, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

test('ambiguous bare model ids never borrow provider or pricing', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  assert.equal(providerForModel('gpt-5.6-sol', map), 'unknown');
  assert.equal(pricingForModel('gpt-5.6-sol', map), null);
  assert.equal(providerForModel('gpt-5.6-sol', map, 'openai-codex'), 'openai-codex');
  assert.equal(pricingForModel('gpt-5.6-sol', map, 'openai-codex')?.input, 5);
});

test('persisted provider attribution survives coercion and prices ambiguous model ids', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  const snapshot = coerceRunSnapshot(run({
    modelId: 'gpt-5.6-sol', provider: 'openai-codex', inputTokens: 100_000,
  }));
  assert.ok(snapshot);
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  assert.equal(stats.todayCostByProvider.find((entry) => entry.provider === 'openai-codex')?.cost, 0.5);
  assert.equal(stats.todayCostByProvider.some((entry) => entry.provider === 'unknown'), false);
});

test('a run provider is not borrowed by a different provider-less model sample', () => {
  const map = new Map([
    ['parent-model', [price('openai-codex', 5, 'parent-model')]],
    ['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]],
  ]);
  const snapshot = run({
    modelId: 'parent-model', provider: 'openai-codex', inputTokens: 100_000,
    turnThroughputSamples: [{
      endedAt: new Date(NOW - 500).toISOString(), inputTokens: 100_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
      concurrentBusySessions: 1, status: 'completed', modelId: 'gpt-5.6-sol',
      turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  assert.equal(stats.todayCostByProvider.find((entry) => entry.provider === 'unknown')?.inputTokens, 100_000);
  assert.equal(stats.todayCostByProvider.find((entry) => entry.provider === 'openai-codex'), undefined);

  const auxiliaryStats = computeAggregateStats([run({
    modelId: 'parent-model', provider: 'openai-codex',
    auxiliaryLlmUsage: [{
      kind: 'history_compaction', sourceId: 'different-model', occurredAt: new Date(NOW - 100).toISOString(),
      modelId: 'gpt-5.6-sol', inputTokens: 50_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
  })], map, NOW, [], {}, 0);
  assert.equal(auxiliaryStats.todayCostByProvider.find((entry) => entry.provider === 'unknown')?.inputTokens, 50_000);
  assert.equal(auxiliaryStats.todayCostByProvider.find((entry) => entry.provider === 'openai-codex'), undefined);
});

test('provider-qualified subagent ids resolve to their real provider, not unknown', () => {
  const map = new Map([
    ['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]],
    ['glm-5.2:cloud', [price('ollama', 1.2, 'glm-5.2:cloud')]],
  ]);
  // A child session records its model as `provider/id`; the catalog keys by
  // the bare id. The recorded provider must win and the reported cost must
  // land in the real provider bucket instead of 'unknown'.
  const snapshot = run({
    modelId: 'gpt-5.6-sol', provider: 'openai-codex',
    toolUsage: {
      ...run({}).toolUsage,
      subagentCallCount: 1, subagentTaskCount: 1, subagentAgentNames: [],
      subagentInputTokens: 1_000_000, subagentOutputTokens: 0,
      subagentCacheReadTokens: 0, subagentCacheWriteTokens: 0,
    },
    auxiliaryLlmUsage: [{
      kind: 'subagent', sourceId: 'child-1', occurredAt: new Date(NOW - 100).toISOString(),
      modelId: 'ollama/glm-5.2:cloud', provider: 'ollama',
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reportedCostUsd: 1.2,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  const providers = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('unknown'), undefined);
  assert.equal(providers.get('ollama')?.cost, 1.2);
  assert.equal(providers.get('ollama')?.inputTokens, 1_000_000);
});

test('provider-qualified single-provider ids resolve via the catalog without a recorded provider', () => {
  const map = new Map([['glm-5.2:cloud', [price('ollama', 1.2, 'glm-5.2:cloud')]]]);
  assert.equal(providerForModel('ollama/glm-5.2:cloud', map), 'ollama');
  assert.equal(pricingForModel('ollama/glm-5.2:cloud', map)?.input, 1.2);
  // A prefixed duplicate of the run model inherits the run provider.
  const snapshot = run({
    modelId: 'glm-5.2:cloud', provider: 'ollama', inputTokens: 100_000,
    turnThroughputSamples: [{
      endedAt: new Date(NOW - 500).toISOString(), inputTokens: 100_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
      concurrentBusySessions: 1, status: 'completed', modelId: 'ollama/glm-5.2:cloud',
      turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  const providers = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('unknown'), undefined);
  assert.equal(providers.get('ollama')?.inputTokens, 100_000);
});

test('provider-qualified ids unknown to the catalog keep their prefix as the provider', () => {
  // No catalog entry matches this id at all (neither the full id nor its bare
  // suffix). The runtime prefix is the only provider evidence and must survive:
  // catalog pricing may be zero/absent, but the usage stays attributed to the
  // provider that actually served it instead of folding into 'unknown'.
  const map = new Map<string, ModelPricingRecord[]>([
    ['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]],
  ]);
  assert.equal(providerForModel('ollama/brand-new-model', map), 'ollama');
  assert.equal(providerForModel('ollama/brand-new-model', map, 'openai-codex'), 'openai-codex',
    'a recorded provider stays authoritative over the prefix');
  assert.equal(providerForModel('bare-unregistered-model', map), 'unknown',
    'a bare unregistered id has no provider evidence and stays unknown');

  const snapshot = run({
    modelId: 'gpt-5.6-sol', provider: 'openai-codex',
    toolUsage: {
      ...run({}).toolUsage,
      subagentInputTokens: 1_000_000,
    },
    auxiliaryLlmUsage: [{
      kind: 'subagent', sourceId: 'child-1', occurredAt: new Date(NOW - 100).toISOString(),
      modelId: 'ollama/brand-new-model',
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reportedCostUsd: 0.75,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  const providers = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('unknown'), undefined, 'unpriced qualified usage never folds into unknown');
  assert.equal(providers.get('ollama')?.inputTokens, 1_000_000);
  assert.equal(providers.get('ollama')?.cost, 0.75, 'reported cost stays with the qualified provider');
});

test('a recorded provider survives an unpriced model id instead of degrading to unknown', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  // Model id not in the catalog at all, but the run recorded its provider and
  // the provider reported an exact cost: the cost must stay with the provider.
  const snapshot = run({
    modelId: 'some-unregistered-model', provider: 'openai-codex', inputTokens: 10_000,
    turnThroughputSamples: [{
      endedAt: new Date(NOW - 500).toISOString(), inputTokens: 10_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
      concurrentBusySessions: 1, status: 'completed', modelId: 'some-unregistered-model',
      provider: 'openai-codex', reportedCostUsd: 0.25,
      turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  const providers = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('unknown'), undefined);
  assert.equal(providers.get('openai-codex')?.cost, 0.25);
});

test('known token usage is repriced from the catalog instead of preserving a stale stored estimate', () => {
  const map = new Map([['gpt-5.6-sol', [price('openai-codex', 4)]]]);
  const snapshot = run({
    modelId: 'gpt-5.6-sol', provider: 'openai-codex', inputTokens: 1_000_000,
    turnThroughputSamples: [{
      endedAt: new Date(NOW - 500).toISOString(), inputTokens: 1_000_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
      concurrentBusySessions: 1, status: 'completed', modelId: 'gpt-5.6-sol',
      provider: 'openai-codex', reportedCostUsd: 5,
      turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  });

  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  assert.equal(stats.todayCost, 4);
  assert.equal(stats.totalCost, 4);
});

test('mixed same-id parent turns and auxiliary summaries remain provider-discrete', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  const snapshot = run({
    modelId: 'gpt-5.6-sol', provider: 'openai-codex', mixedModelConfig: true,
    inputTokens: 30, tokenReportedTurnCount: 2,
    turnThroughputSamples: [
      { endedAt: new Date(NOW - 500).toISOString(), inputTokens: 10, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
        concurrentBusySessions: 1, status: 'completed', modelId: 'gpt-5.6-sol',
        provider: 'github-copilot', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: new Date(NOW - 300).toISOString(), inputTokens: 20, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
        concurrentBusySessions: 1, status: 'completed', modelId: 'gpt-5.6-sol',
        provider: 'openai-codex', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
    auxiliaryLlmUsage: [{
      kind: 'history_compaction', sourceId: 'compact-1', occurredAt: new Date(NOW - 100).toISOString(),
      modelId: 'gpt-5.6-sol', provider: 'openai-codex', inputTokens: 3, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, reportedCostUsd: 0.42,
    }],
  });
  const stats = computeAggregateStats([snapshot], map, NOW, [], {}, 0);
  const providers = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(providers.get('github-copilot')?.inputTokens, 10);
  assert.equal(providers.get('openai-codex')?.inputTokens, 23);
  assert.equal(providers.get('openai-codex')?.cost, 0.000115);
});

test('durable assistant-message samples account for an active tool loop before its terminal reply', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2)]]]);
  const first = {
    kind: 'assistant_message' as const,
    sourceId: 'assistant-1',
    occurredAt: new Date(NOW - 500).toISOString(),
    modelId: 'gpt-5.6-sol',
    provider: 'github-copilot',
    inputTokens: 100_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const stats = computeAggregateStats([run({
    modelId: 'gpt-5.6-sol', provider: 'github-copilot',
    auxiliaryLlmUsage: [first, first, {
      ...first, sourceId: 'assistant-2', inputTokens: 200_000,
      occurredAt: new Date(NOW - 250).toISOString(),
    }],
  })], map, NOW, [], {}, 0);

  assert.equal(stats.todayInputTokens, 300_000);
  assert.equal(stats.todayCost, 0.6);
});

test('terminal parent totals reconcile with assistant-message samples without double counting', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2)]]]);
  const stats = computeAggregateStats([run({
    modelId: 'gpt-5.6-sol', provider: 'github-copilot', inputTokens: 300_000,
    auxiliaryLlmUsage: [{
      kind: 'assistant_message', sourceId: 'assistant-1', occurredAt: new Date(NOW - 500).toISOString(),
      modelId: 'gpt-5.6-sol', provider: 'github-copilot', inputTokens: 300_000,
      outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }],
    turnThroughputSamples: [{
      endedAt: new Date(NOW - 400).toISOString(), inputTokens: 300_000, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, generationDurationMs: 1,
      concurrentBusySessions: 1, status: 'completed', modelId: 'gpt-5.6-sol',
      provider: 'github-copilot', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null,
    }],
  })], map, NOW, [], {}, 0);

  assert.equal(stats.todayInputTokens, 300_000);
  assert.equal(stats.todayCost, 0.6);
});

test('provider-qualified ids keep one bare model separate per provider across today/week series', () => {
  // The same bare model id served by two providers: each run records only the
  // provider-qualified model id (no provider field, like child/subagent
  // sessions). The prefix must survive canonicalization so the two runs stay
  // separate — and correctly priced — through every today/week rollup.
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  const sampleFor = (modelId: string, inputTokens: number) => ({
    endedAt: new Date(NOW - 500).toISOString(),
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    generationDurationMs: 1,
    concurrentBusySessions: 1,
    status: 'completed' as const,
    modelId,
    turnLatencyMs: null,
    overheadMs: null,
    providerLatencyMs: null,
  });
  const copilot = run({
    modelId: 'github-copilot/gpt-5.6-sol', inputTokens: 100_000,
    finalizedAt: new Date(NOW - 500).toISOString(),
    turnThroughputSamples: [sampleFor('github-copilot/gpt-5.6-sol', 100_000)],
  });
  const codex = run({
    sessionPath: '/s2', runId: 'r2', modelId: 'openai-codex/gpt-5.6-sol', inputTokens: 200_000,
    turnThroughputSamples: [sampleFor('openai-codex/gpt-5.6-sol', 200_000)],
  });

  const stats = computeAggregateStats([copilot, codex], map, NOW, [], {}, 0);
  const todayProviders = new Map(stats.todayCostByProvider.map((entry) => [entry.provider, entry]));
  assert.equal(todayProviders.size, 2, 'both providers stay distinct today');
  assert.equal(todayProviders.get('unknown'), undefined);
  assert.equal(todayProviders.get('github-copilot')?.inputTokens, 100_000);
  assert.equal(todayProviders.get('github-copilot')?.cost, 0.2, 'priced at the github-copilot rate');
  assert.equal(todayProviders.get('openai-codex')?.inputTokens, 200_000);
  assert.equal(todayProviders.get('openai-codex')?.cost, 1, 'priced at the openai-codex rate');
  assert.equal(stats.totalCost, 1.2);
  assert.equal(stats.weekCost, 1.2, 'week cost keeps both providers');
  assert.deepEqual(
    stats.weekCostByProvider.map((entry) => [entry.provider, entry.cost] as [string, number]).sort(),
    [['github-copilot', 0.2], ['openai-codex', 1]],
  );

  // Series breakdowns stay provider-qualified at every point.
  const todayFinal = stats.todayCostSeries.at(-1)!;
  assert.deepEqual(
    todayFinal.byProvider.map((entry) => [entry.key, entry.value] as [string, number]).sort((a, b) => a[0].localeCompare(b[0])),
    [['github-copilot', 0.2], ['openai-codex', 1]],
  );
  assert.deepEqual(
    todayFinal.byModel.map((entry) => [entry.provider, entry.model, entry.value] as [string, string, number]).sort((a, b) => a[0].localeCompare(b[0])),
    [['github-copilot', 'gpt-5.6-sol', 0.2], ['openai-codex', 'gpt-5.6-sol', 1]],
  );
  const weekFinal = stats.weekCostSeries.at(-1)!;
  assert.deepEqual(
    weekFinal.byProvider.map((entry) => [entry.key, entry.value] as [string, number]).sort((a, b) => a[0].localeCompare(b[0])),
    [['github-copilot', 0.2], ['openai-codex', 1]],
  );
  assert.deepEqual(
    weekFinal.byModel.map((entry) => [entry.provider, entry.model, entry.value] as [string, string, number]).sort((a, b) => a[0].localeCompare(b[0])),
    [['github-copilot', 'gpt-5.6-sol', 0.2], ['openai-codex', 'gpt-5.6-sol', 1]],
    'the week chart keeps two entries for the same bare model id',
  );
  assert.equal(stats.lastRun!.provider, 'openai-codex', 'the latest run resolves its provider from the qualified id');
});
