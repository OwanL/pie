import assert from 'node:assert/strict';
import test from 'node:test';

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

function price(provider: string, input: number): ModelPricingRecord {
  return { id: 'gpt-5.6-sol', provider, pricing: { input, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

test('ambiguous bare model ids never borrow provider or pricing', () => {
  const map = new Map([['gpt-5.6-sol', [price('github-copilot', 2), price('openai-codex', 5)]]]);
  assert.equal(providerForModel('gpt-5.6-sol', map), 'unknown');
  assert.equal(pricingForModel('gpt-5.6-sol', map), null);
  assert.equal(providerForModel('gpt-5.6-sol', map, 'openai-codex'), 'openai-codex');
  assert.equal(pricingForModel('gpt-5.6-sol', map, 'openai-codex')?.input, 5);
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
  assert.equal(providers.get('openai-codex')?.cost, 0.4201);
});
