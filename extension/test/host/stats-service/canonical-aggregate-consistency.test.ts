import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CanonicalAnalyticsReadModel } from '../../../src/analytics/query-entry.js';
import type { ProviderAggregateReadModel } from '../../../src/analytics/sqlite-recorder.js';
import { AggregateStatsService } from '../../../src/host/aggregate-stats-service.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats.js';

function emptyCoverage() {
  return {
    occurrenceCount: 0,
    knownCount: 0,
    unknownCount: 0,
    knownTotal: '0',
    value: '0',
    complete: true,
  };
}

function aggregateAt(
  revision: string,
  executionCount = 0,
  sessionCount = executionCount,
): ProviderAggregateReadModel {
  return {
    revision,
    snapshotWatermark: '0',
    accounting: {
      revision,
      invocationCount: 0,
      inputTokens: emptyCoverage(),
      outputTokens: emptyCoverage(),
      cacheReadTokens: emptyCoverage(),
      cacheWriteTokens: emptyCoverage(),
      reasoningTokens: emptyCoverage(),
      providerTotalTokens: emptyCoverage(),
      effectiveCostUsd: {
        ...emptyCoverage(),
        reportedCount: 0,
        calculatedCount: 0,
      },
    },
    executionSummary: {
      revision,
      scope: { kind: 'global' },
      executionCount,
      begunCount: executionCount,
      settledCount: executionCount,
      lifecycleCoverage: 'known',
      timingCoverage: 'known',
      deliveryCoverage: 'complete',
      latestSettled: null,
    },
    latestRun: null,
    groups: [],
    sessionCount,
    truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
  };
}

test('canonical aggregate fences a snapshot older than the host-observed revision', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-canonical-aggregate-consistency-'));
  let currentRevision = '1';
  let gateStarted!: () => void;
  let releaseGate!: () => void;
  let aggregateRead = false;
  const gateObserved = new Promise<void>((resolve) => { gateStarted = resolve; });
  const gate = new Promise<typeof EMPTY_PROVIDER_GATE_STATS>((resolve) => { releaseGate = () => resolve(EMPTY_PROVIDER_GATE_STATS); });
  const readModel = {
    readProviderAggregateSummary: async () => {
      aggregateRead = true;
      return aggregateAt('1');
    },
    readRevision: async () => currentRevision,
  } as unknown as CanonicalAnalyticsReadModel;
  const archState = createInitialArchState();
  const statsService = {
    getAnalyticsReadModel: () => readModel,
    getOpenRuns: () => [],
    getPendingCompletedRuns: () => [],
    getStorageDir: () => root,
    queryPersistedRunAnalytics: async () => ({ completedRuns: [], openRuns: [] }),
    getAnalyticsRevisionRefreshStats: () => ({
      checks: 1,
      changes: 1,
      lastDurationMs: 1,
      revision: currentRevision,
      failing: false,
    }),
  };
  const service = new AggregateStatsService({
    getArchState: () => archState,
    statsService: statsService as never,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: () => {
      gateStarted();
      return gate;
    },
    onChanged: () => undefined,
    now: () => new Date(1_750_000_000_000),
  });
  try {
    const recompute = (service as unknown as { recompute(): Promise<void> }).recompute();
    await gateObserved;
    assert.equal(aggregateRead, false, 'the slow provider-gate poll must precede the durable snapshot');
    currentRevision = '2';
    releaseGate();
    await recompute;
    assert.equal(service.getAggregateStats().ready, false);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical aggregate uses exact daily rollups when temporal evidence is truncated', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-canonical-aggregate-truncated-'));
  const nowMs = 1_750_000_000_000;
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const readModel = {
    readProviderAggregateSummary: async () => ({
      ...aggregateAt('1', 4_097, 2),
      groups: [{
        provider: 'bulk-provider', model: 'bulk-model', session_count: 99,
        all_cost: 4_097, all_input: '4097', all_output: '4097', all_cache_read: '0', all_cache_write: '0',
        all_unknown: 0, all_unpriced: 0, all_gap: 0,
        today_cost: 4_097, today_input: '4097', today_output: '4097', today_cache_read: '0', today_cache_write: '0',
        today_unknown: 0, today_unpriced: 0, today_gap: 0,
        week_cost: 4_097, week_input: '4097', week_output: '4097', week_cache_read: '0', week_cache_write: '0',
        week_unknown: 0, week_unpriced: 0, week_gap: 0,
      }],
      series: {
        settlements: [{
          ms: nowMs - 1_000, provider: 'bulk-provider', model: 'bulk-model',
          cost: 1, inputTokens: '1', outputTokens: '1',
        }],
        executions: [{ startedAtMs: nowMs - 2_000, endedAtMs: nowMs - 1_000, rootSessionId: 'sampled-session' }],
        dailyCosts: [{
          date,
          totalCost: 4_097,
          byProvider: [{ provider: 'bulk-provider', cost: 4_097 }],
          byModel: [{ provider: 'bulk-provider', model: 'bulk-model', cost: 4_097 }],
        }],
        dailyExecutions: [{ date, runCount: 4_097, sessionCount: 2 }],
        truncated: true,
      },
    }),
  } as unknown as CanonicalAnalyticsReadModel;
  const archState = createInitialArchState();
  const statsService = {
    getAnalyticsReadModel: () => readModel,
    getOpenRuns: () => [],
    getPendingCompletedRuns: () => [],
    getStorageDir: () => root,
    queryPersistedRunAnalytics: async () => ({ completedRuns: [], openRuns: [] }),
  };
  const service = new AggregateStatsService({
    getArchState: () => archState,
    statsService: statsService as never,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
    onChanged: () => undefined,
    now: () => new Date(nowMs),
  });
  try {
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    const aggregate = service.getAggregateStats();
    assert.equal(aggregate.todayCost, 4_097);
    assert.equal(aggregate.dailyCost[0]?.totalCost, 4_097);
    assert.equal(aggregate.todayRunCount, 4_097);
    assert.equal(aggregate.weekRunCount, 4_097);
    assert.equal(aggregate.sessionCount, 2, 'canonical session count must come from execution truth, not provider groups');
    assert.equal(aggregate.dailyWorkTrend.at(-1)?.sessionsUsed, 2);
    assert.ok(aggregate.todayCostSeries.length > 0, 'exact daily rollups should keep a coarse cost graph visible');
    assert.equal(aggregate.todayCostSeries.at(-1)?.byProvider[0]?.value, 4_097);
    assert.equal(aggregate.todayInputTokenSeries.length, 0, 'truncated token evidence must remain explicitly unavailable');
    assert.equal(aggregate.todayTokenSeries.length, 0);
    assert.ok(aggregate.weekCostSeries.length > 0, 'exact daily rollups should keep the weekly cost graph visible');
    assert.equal(aggregate.weekCostSeries.at(-1)?.byProvider[0]?.value, 4_097);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical aggregate publishes after a live tick and does not launch a post-read revision query', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-canonical-aggregate-live-'));
  let releaseRead!: () => void;
  let readStarted!: () => void;
  let readRevisionCalls = 0;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
  const readModel = {
    readProviderAggregateSummary: async () => {
      readStarted();
      await readGate;
      const nowMs = 1_750_000_000_000;
      return {
        ...aggregateAt('1', 2),
        groups: [{
          provider: 'test-provider', model: 'test-model', session_count: 1,
          all_cost: 1, all_input: '10', all_output: '20', all_cache_read: '0', all_cache_write: '0',
          all_unknown: 0, all_unpriced: 0, all_gap: 0,
          today_cost: 1, today_input: '10', today_output: '20', today_cache_read: '0', today_cache_write: '0',
          today_unknown: 0, today_unpriced: 0, today_gap: 0,
          week_cost: 1, week_input: '10', week_output: '20', week_cache_read: '0', week_cache_write: '0',
          week_unknown: 0, week_unpriced: 0, week_gap: 0,
        }],
        series: {
          settlements: [{
            ms: nowMs - 1_000,
            provider: 'test-provider', model: 'test-model',
            cost: 1, inputTokens: '10', outputTokens: '20',
          }],
          executions: [{
            startedAtMs: nowMs - 2_000,
            endedAtMs: nowMs - 1_000,
            rootSessionId: 'test-session',
          }],
          truncated: false,
        },
      };
    },
    readRevision: async () => {
      readRevisionCalls += 1;
      throw new Error('aggregate publication must use the refresher observation, not a second helper read');
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const archState = createInitialArchState();
  const statsService = {
    getAnalyticsReadModel: () => readModel,
    getOpenRuns: () => [],
    getPendingCompletedRuns: () => [],
    getStorageDir: () => root,
    queryPersistedRunAnalytics: async () => ({ completedRuns: [], openRuns: [] }),
    getAnalyticsRevisionRefreshStats: () => ({
      checks: 1,
      changes: 0,
      lastDurationMs: 1,
      revision: '1',
      failing: false,
    }),
  };
  let changed = 0;
  const service = new AggregateStatsService({
    getArchState: () => archState,
    statsService: statsService as never,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
    onChanged: () => { changed += 1; },
    now: () => new Date(1_750_000_000_000),
  });
  try {
    const recompute = (service as unknown as { recompute(): Promise<void> }).recompute();
    await readStartedPromise;
    archState.sessions.runningSessionPaths.push('live-session');
    service.refreshLive();
    releaseRead();
    await recompute;
    const aggregate = service.getAggregateStats();
    assert.equal(aggregate.ready, true);
    assert.equal(aggregate.runningSessionCount, 1, 'the latest live session count must merge into the durable snapshot');
    assert.equal(aggregate.runCount, 2, 'canonical aggregate runCount must use root execution summary');
    assert.equal(aggregate.todayCost, 1);
    assert.equal(aggregate.todayCostSeries.length > 0, true);
    assert.equal(aggregate.todayInputTokenSeries.length > 0, true);
    assert.equal(aggregate.todayTokenSeries.length > 0, true);
    assert.equal(aggregate.weekCostSeries.length > 0, true);
    assert.equal(aggregate.dailyCost.length, 1);
    assert.equal(aggregate.todayRunCount, 1);
    assert.equal(aggregate.weekRunCount, 1);
    assert.equal(aggregate.dailyWorkTrend.at(-1)?.sessionsUsed, 1);
    assert.equal(readRevisionCalls, 0);
    assert.equal(changed, 1);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
