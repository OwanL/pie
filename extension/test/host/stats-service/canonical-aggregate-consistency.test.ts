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

function aggregateAt(revision: string): ProviderAggregateReadModel {
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
    groups: [],
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
      return aggregateAt('1');
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
    assert.equal(readRevisionCalls, 0);
    assert.equal(changed, 1);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
