import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AggregateStatsService } from '../../../src/host/aggregate-stats-service';
import {
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  type RunSnapshot,
} from '../../../src/host/run-analytics';
import { MAX_INTRADAY_CHART_POINTS } from '../../../src/host/stats-service/aggregate-stats';
import { RunAnalyticsStorage } from '../../../src/host/stats-service/storage';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats';

const RUN_COUNT = 2_000;
const STORAGE_CEILING_BYTES = 8_000_000;
// Covers the protocol's designed maximum: four bounded series (today cost /
// input tokens / output tokens / week cost) at up to MAX_INTRADAY_CHART_POINTS
// points each, with provider-qualified per-model segments, plus the base
// rollups. Still far below the unbounded failure mode (one point per raw
// sample instant).
const AGGREGATE_CEILING_BYTES = 400_000;

async function writeModelsJson(agentDir: string): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'fixture-provider-a': {
          models: [{ id: 'fixture/model-a', name: 'Fixture A', cost: { input: 0.002, output: 0.006, cacheRead: 0, cacheWrite: 0 } }],
        },
        'fixture-provider-b': {
          models: [{ id: 'fixture/model-b', name: 'Fixture B', cost: { input: 0.003, output: 0.009, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }),
    'utf8',
  );
}

function runFixture(index: number, day: Date): RunSnapshot {
  const at = new Date(day.getTime() + (index % 1_200) * 60_000);
  const iso = at.toISOString();
  return {
    runId: `structural-${index}`,
    sessionPath: `/session/${index % 20}`,
    taskGroupId: `task-${index}`,
    status: 'closed',
    startedAt: iso,
    updatedAt: iso,
    finalizedAt: iso,
    modelId: index % 2 === 0 ? 'fixture/model-a' : 'fixture/model-b',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 2,
    assistantTurnDurationMs: 2_000,
    busyDurationMs: 2_000,
    busyPeriodCount: 1,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: 100 + index,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenReportedTurnCount: 2,
    lastTurnUsage: null,
    turnThroughputSamples: [0, 1].map((sample) => ({
      endedAt: new Date(at.getTime() + sample * 1_000).toISOString(),
      outputTokens: 50,
      generationDurationMs: 1_000,
      concurrentBusySessions: 1,
      status: 'completed' as const,
      turnLatencyMs: null,
      overheadMs: null,
      providerLatencyMs: null,
    })),
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: createEmptyToolUsageRollup(),
    fileMutation: createEmptyFileMutationRollup(),
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: createEmptyVerificationRollup(),
  } as RunSnapshot;
}

test('analytics fixed fixture stays structurally bounded in CI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analytics-structural-'));
  try {
    const fixtureNow = new Date(2026, 6, 13, 20, 0, 0);
    const dayStart = new Date(2026, 6, 13, 0, 0, 0);
    const agentDir = path.join(root, 'agent');
    await writeModelsJson(agentDir);
    let startupTimerScheduled = false;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'structural-ci',
      now: () => fixtureNow,
      serializeSessions: () => ({}),
      maxRunHistoryEntries: RUN_COUNT,
      maxRunHistoryBytes: STORAGE_CEILING_BYTES,
      autoExportSetTimeout: () => {
        startupTimerScheduled = true;
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    await storage.start();
    assert.equal(await fs.access(path.join(storage.getStorageDir(), 'run-analytics.json')).then(() => true, () => false), false,
      'startup export is not awaited');
    for (let i = 0; i < RUN_COUNT; i += 1) storage.schedulePersist(runFixture(i, dayStart));
    await storage.flush();

    const snapshotsPath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');
    const stat = await fs.stat(snapshotsPath);
    const queried = await storage.queryPersistedRunAnalytics();
    assert.equal(queried.completedRuns.length, RUN_COUNT, 'retention keeps the full fixed fixture');
    assert.ok(stat.size <= STORAGE_CEILING_BYTES, 'storage stays under its byte ceiling');

    let completedBuilds = 0;
    let completedSourceVisits = 0;
    let visitsAfterFirstTick = 0;
    let openRun = {
      ...runFixture(RUN_COUNT + 1, dayStart),
      runId: 'structural-open',
      sessionPath: '/session/open',
      status: 'open',
      finalizedAt: undefined,
    } as RunSnapshot;
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => storage.getStorageDir(),
        queryPersistedRunAnalytics: () => storage.queryPersistedRunAnalytics(),
        getOpenRuns: () => [openRun],
        getPendingCompletedRuns: () => storage.getPendingCompletedRuns(),
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => agentDir,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      onAccumulatorBuilt: (scope) => { if (scope === 'completed') completedBuilds += 1; },
      onCompletedSourceEntryVisited: () => { completedSourceVisits += 1; },
      now: () => fixtureNow,
    });

    for (let tick = 0; tick < 3; tick += 1) {
      openRun = { ...openRun, outputTokens: openRun.outputTokens + 1 };
      await (service as unknown as { recompute(): Promise<void> }).recompute();
      if (tick === 0) visitsAfterFirstTick = completedSourceVisits;
      else assert.equal(completedSourceVisits, visitsAfterFirstTick,
        'changing-open ticks do not revisit completed day/raw-sample accumulator entries');
    }
    const aggregate = service.getAggregateStats();
    assert.equal(aggregate.runCount, RUN_COUNT + 1);
    assert.ok(aggregate.todayTokenSeries.length <= MAX_INTRADAY_CHART_POINTS);
    assert.ok(aggregate.todayCostSeries.length <= MAX_INTRADAY_CHART_POINTS);
    assert.ok(aggregate.todayInputTokenSeries.length <= MAX_INTRADAY_CHART_POINTS);
    assert.ok(aggregate.weekCostSeries.length <= MAX_INTRADAY_CHART_POINTS);
    assert.equal(aggregate.costByProvider.length, 2, 'all-time cost breakdown covers both fixture providers');
    assert.equal(aggregate.todayCostByProvider.length, 2, 'today cost breakdown covers both fixture providers');
    assert.equal(
      aggregate.dailyCost[aggregate.dailyCost.length - 1]!.byModel.length,
      2,
      'today daily cost model breakdown covers both fixture models',
    );
    assert.ok(Buffer.byteLength(JSON.stringify(aggregate), 'utf8') <= AGGREGATE_CEILING_BYTES);
    assert.equal(completedBuilds, 1, 'completed history is not repeatedly accumulated');
    assert.ok(visitsAfterFirstTick > 0, 'instrumentation observed completed source entries on initial preparation');
    assert.equal(startupTimerScheduled, true, 'missing startup export is scheduled in the background');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
