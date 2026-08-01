import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accumulateAggregateStats,
  computeAggregateStats,
  finalizeAggregateStatsLayers,
  prepareAggregateStatsLayer,
} from '../../../src/host/stats-service/aggregate-stats';
import type { RunSnapshot } from '../../../src/host/run-analytics';
import type { ModelPricingRecord } from '../../../../shared/pricing-core';

/**
 * Zero-turn / null-analyticsFactors boundary tests for the extension's aggregate
 * stats pipeline. The pipeline derives rates and averages (tokens/sec, per-provider
 * throughput) from run snapshots; with zero turns, null factors, and empty
 * throughput, every division denominator must be guarded so no NaN/Infinity leaks
 * into the ViewState aggregate stats. This mirrors the analysis-side zero-telemetry
 * suite but exercises the extension's own `accumulateAggregateStats` →
 * `prepareAggregateStatsLayer` → `finalizeAggregateStatsLayers` path.
 */

function makeRun(overrides: Partial<RunSnapshot>): RunSnapshot {
  return {
    sessionPath: '/s/1',
    runId: 'run-1',
    taskGroupId: 'tg-1',
    status: 'closed',
    startedAt: '2026-07-04T10:00:00.000Z',
    updatedAt: '2026-07-04T10:05:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 0,
    assistantTurnCount: 0,
    assistantTurnDurationMs: 0,
    busyDurationMs: 0,
    busyPeriodCount: 0,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: {
      totalCount: 0, failureCount: 0, executionFailureCount: 0,
      verificationProjectFailureCount: 0, probeFailureCount: 0, resultIssueCount: 0,
      countsByName: {}, failureCountsByName: {}, failureCountsByKind: {},
      failureCountsByNameAndKind: {}, failureSamples: [],
      resultIssueCountsByName: {}, resultIssueCountsByKind: {},
      resultIssueCountsByNameAndKind: {}, resultIssueSamples: [],
      totalDurationMs: 0, timedCallCount: 0, durationMsByName: {}, timedCallCountsByName: {},
      subagentCallCount: 0, subagentTaskCount: 0, subagentAgentNames: [],
      subagentInputTokens: 0, subagentOutputTokens: 0,
      subagentCacheReadTokens: 0, subagentCacheWriteTokens: 0,
    },
    fileMutation: {
      writeCount: 0, editCount: 0, deleteCount: 0, renameCount: 0,
      touchedFileCount: 0, lineAdditions: 0, lineDeletions: 0,
      lineModifications: 0, editCountsByFile: {}, readCountsByFile: {},
    },
    fileExtensions: {
      readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {},
    },
    verification: { totalCount: 0, failureCount: 0, countsByKind: {} },
    ...overrides,
  } as RunSnapshot;
}

const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime();

function assertNoNaNInfinity(value: unknown, path = 'stats'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value} (NaN/Infinity leaked)`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNaNInfinity(entry, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertNoNaNInfinity(entry, `${path}.${key}`);
    }
  }
}

test('an empty run set produces finite, zero-state aggregate stats', () => {
  const stats = computeAggregateStats([], new Map(), NOW, [], {}, 0);
  assertNoNaNInfinity(stats);
  assert.equal(stats.runCount, 0);
  assert.equal(stats.sessionCount, 0);
  assert.equal(stats.totalCost, 0);
  assert.equal(stats.tokensPerSecond, 0);
  assert.equal(stats.ready, true);
});

test('a zero-turn run with null analyticsFactors and no pricing produces finite stats', () => {
  const run = makeRun({ runId: 'zero', modelId: 'unmodeled-model' });
  const stats = computeAggregateStats([run], new Map(), NOW, [], {}, 0);
  assertNoNaNInfinity(stats);
  assert.equal(stats.runCount, 1);
  assert.equal(stats.totalCost, 0);
  assert.equal(stats.tokensPerSecond, 0, 'no completed throughput → 0, not NaN');
  assert.equal(stats.tokensPerSecondByProvider.length, 0);
});

test('throughput samples that do not qualify (errored / zero duration) yield zero rate, not NaN', () => {
  const run = makeRun({
    runId: 'errored',
    modelId: 'openai/gpt',
    turnThroughputSamples: [
      { endedAt: '2026-07-04T10:00:00.000Z', outputTokens: 100, generationDurationMs: 0, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: '2026-07-04T10:00:01.000Z', outputTokens: 50, generationDurationMs: 500, concurrentBusySessions: 1, status: 'error', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
      { endedAt: '2026-07-04T10:00:02.000Z', outputTokens: 0, generationDurationMs: 500, concurrentBusySessions: 1, status: 'interrupted', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });
  const stats = computeAggregateStats([run], new Map(), NOW, [], {}, 0);
  assertNoNaNInfinity(stats);
  // All samples are filtered (zero duration or non-completed) → no throughput observation.
  assert.equal(stats.tokensPerSecond, 0);
  assert.equal(stats.tokensPerSecondByProvider.length, 0);
});

test('the layered finalize path stays finite for a zero-turn completed layer merged with an empty open accumulator', () => {
  const zeroRun = makeRun({ runId: 'zero-layer', modelId: 'openai/gpt' });
  const completedAcc = accumulateAggregateStats([zeroRun], new Map());
  const layer = prepareAggregateStatsLayer(completedAcc, NOW);
  const openAcc = accumulateAggregateStats([], new Map());
  const stats = finalizeAggregateStatsLayers(layer, openAcc, NOW, [], {}, 0);
  assertNoNaNInfinity(stats);
  assert.equal(stats.runCount, 1);
  assert.equal(stats.sessionCount, 1);
  assert.equal(stats.tokensPerSecond, 0);
});

test('a zero-turn run mixed with a productive run yields finite stats and a non-zero rate', () => {
  const pricingMap = new Map<string, ModelPricingRecord[]>([
    ['openai/gpt', [{ id: 'm', provider: 'openai', pricing: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } }]],
  ]);
  const zeroRun = makeRun({ runId: 'zero', analyticsFactors: null, functionalSettings: null });
  const productiveRun = makeRun({
    runId: 'prod',
    modelId: 'openai/gpt',
    assistantTurnCount: 2,
    sendCount: 2,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    turnThroughputSamples: [
      { endedAt: '2026-07-04T10:00:00.000Z', outputTokens: 500, generationDurationMs: 1000, concurrentBusySessions: 1, status: 'completed', turnLatencyMs: null, overheadMs: null, providerLatencyMs: null },
    ],
  });
  const stats = computeAggregateStats([zeroRun, productiveRun], pricingMap, NOW, [], {}, 0);
  assertNoNaNInfinity(stats);
  assert.equal(stats.runCount, 2);
  assert.ok(stats.tokensPerSecond > 0, 'productive run contributes a positive rate');
  assert.ok(stats.totalCost > 0, 'productive run accrues cost');
});
