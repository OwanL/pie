/**
 * Analytics aggregate performance benchmark for pie.
 *
 * Builds a realistic on-disk analytics store with ~2,000 historical runs,
 * multiple providers/models, thousands of same-day turn samples, and one
 * changing open run. Then drives the real AggregateStatsService through a
 * series of active ticks and records:
 *
 *   - Serialized aggregate size
 *   - Intraday series point counts
 *   - Analytics query duration
 *   - Aggregate computation duration
 *   - Structured-clone duration
 *   - Completed-history accumulation count across active ticks
 *
 * Run:   npx tsx ./test/perf/analytics.perf.ts
 *        (also: npm run perf:analytics from extension/)
 *
 * Not swept by `npm test` (file is *.perf.ts), so it never runs in CI.
 * Structural assertions below DO fail the process when limits are breached.
 * Writes a timestamped JSON report to ./test/perf/reports/.
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

import { RunAnalyticsStorage } from '../../src/host/stats-service/storage';
import { AggregateStatsService } from '../../src/host/aggregate-stats-service';
import { workspaceHash } from '../../src/host/stats-service/helpers';
import { MAX_INTRADAY_CHART_POINTS } from '../../src/host/stats-service/aggregate-stats';
import type { RunSnapshot } from '../../src/host/run-analytics';
import {
  createEmptyToolUsageRollup,
  createEmptyFileMutationRollup,
  createEmptyVerificationRollup,
} from '../../src/host/run-analytics/coercion-rollups';
import {
  EMPTY_PROVIDER_GATE_STATS,
} from '../../src/shared/protocol/aggregate-stats';
import type { ArchState } from '../../src/host/core/arch-state';

// ─── Scenario constants ──────────────────────────────────────────────────────

const HISTORICAL_RUN_COUNT = 2_000;
const TODAY_RUN_FRACTION = 0.8;
const ACTIVE_TICKS = 4;
const MAX_RUN_HISTORY_ENTRIES = 2_000;
const MAX_RUN_HISTORY_BYTES = 8_000_000;
const AGGREGATE_PAYLOAD_CEILING_BYTES = 150_000;

const MODELS = [
  { id: 'openai/gpt-4o-mini', provider: 'openai', cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 } },
  { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } },
];

// ─── Fixture helpers ────────────────────────────────────────────────────────

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

const random = seededRandom(0x5eed_2026);

function makeBaseRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const now = new Date();
  return {
    sessionPath: '/s/perf',
    runId: 'run-base',
    taskGroupId: 'tg-base',
    status: 'closed',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finalizedAt: now.toISOString(),
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1_000,
    busyDurationMs: 1_000,
    busyPeriodCount: 1,
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
    tokenReportedTurnCount: 1,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    filesystemPathRefCount: 0,
    imageInputCount: 0,
    imageInputBytes: 0,
    unsupportedInputCount: 0,
    inputKindsUsed: [],
    toolUsage: createEmptyToolUsageRollup(),
    fileMutation: createEmptyFileMutationRollup(),
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: createEmptyVerificationRollup(),
    ...overrides,
  } as RunSnapshot;
}

function generateCompletedRuns(count: number): RunSnapshot[] {
  const runs: RunSnapshot[] = [];
  const today = new Date();
  const todayLocalMidnightMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  for (let i = 0; i < count; i += 1) {
    const isToday = i < count * TODAY_RUN_FRACTION;
    const dayOffset = isToday ? 0 : Math.floor(random() * 7) + 1;
    const dayBaseMs = todayLocalMidnightMs - dayOffset * 86_400_000;
    const hour = Math.floor(random() * 24);
    const minute = Math.floor(random() * 60);
    const runMs = dayBaseMs + hour * 3_600_000 + minute * 60_000;
    const runAt = new Date(runMs).toISOString();

    const sampleCount = isToday ? 2 + Math.floor(random() * 4) : 1 + Math.floor(random() * 2);
    const samples = [];
    let outputTokens = 0;
    for (let s = 0; s < sampleCount; s += 1) {
      const sMs = runMs + s * 60_000;
      const sTokens = Math.floor(500 + random() * 9_500);
      outputTokens += sTokens;
      samples.push({
        endedAt: new Date(sMs).toISOString(),
        outputTokens: sTokens,
        generationDurationMs: Math.floor(500 + random() * 4_500),
        concurrentBusySessions: 1,
        status: 'completed' as const,
        turnLatencyMs: null,
        overheadMs: null,
        providerLatencyMs: null,
      });
    }

    const inputTokens = Math.floor(outputTokens * (0.5 + random()));
    const model = MODELS[Math.floor(random() * MODELS.length)]!;

    runs.push(makeBaseRun({
      runId: `perf-completed-${i}`,
      sessionPath: `/s/perf-${i % 20}`,
      taskGroupId: `tg-perf-${i}`,
      status: 'closed',
      modelId: model.id,
      startedAt: runAt,
      updatedAt: runAt,
      finalizedAt: runAt,
      inputTokens,
      outputTokens,
      cacheReadTokens: Math.floor(inputTokens * 0.1),
      cacheWriteTokens: 0,
      turnThroughputSamples: samples,
      toolUsage: { ...createEmptyToolUsageRollup(), totalCount: Math.floor(random() * 8) },
      fileMutation: { ...createEmptyFileMutationRollup(), touchedFileCount: Math.floor(random() * 5) },
    }));
  }

  return runs;
}

function makeOpenRun(): RunSnapshot {
  const now = new Date().toISOString();
  return makeBaseRun({
    runId: 'perf-open',
    sessionPath: '/s/open',
    taskGroupId: 'tg-open',
    status: 'open',
    modelId: MODELS[0]!.id,
    startedAt: now,
    updatedAt: now,
    inputTokens: 1_000,
    outputTokens: 500,
    turnThroughputSamples: [
      {
        endedAt: now,
        outputTokens: 500,
        generationDurationMs: 1_000,
        concurrentBusySessions: 1,
        status: 'completed',
        turnLatencyMs: null,
        overheadMs: null,
        providerLatencyMs: null,
      },
    ],
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analytics-perf-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeModelsJson(agentDir: string): Promise<void> {
  const providers: Record<string, { models: unknown[] }> = {};
  for (const model of MODELS) {
    if (!providers[model.provider]) providers[model.provider] = { models: [] };
    providers[model.provider]!.models.push({ id: model.id, cost: model.cost });
  }
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers }), 'utf8');
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ─── Measurement types ───────────────────────────────────────────────────────

interface TickMeasurement {
  tickIndex: number;
  queryMs: number;
  computeMs: number;
  cloneMs: number;
  aggregateSizeBytes: number;
  todayTokenSeriesLength: number;
  todayCostSeriesLength: number;
}

interface BenchmarkReport {
  generatedAt: string;
  gitSha: string;
  fixture: {
    historicalRunCount: number;
    todayRunFraction: number;
    models: string[];
    maxRunHistoryEntries: number;
    maxRunHistoryBytes: number;
    aggregatePayloadCeilingBytes: number;
  };
  ticks: TickMeasurement[];
  completedAccumulationCount: number;
  openAccumulationCount: number;
  runSnapshotsJsonlBytes: number;
  runSnapshotsJsonlLines: number;
  retainedCompletedRunCount: number;
  startupExportAwaited: boolean;
  startupExportTimerScheduled: boolean;
}

// ─── Output formatting ───────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${(ms * 1_000).toFixed(2)}µs`;
}

function printReport(report: BenchmarkReport): void {
  console.log('\n=== pie analytics aggregate performance benchmark ===');
  console.log(`fixture: ${report.fixture.historicalRunCount} historical runs (${(report.fixture.todayRunFraction * 100).toFixed(0)}% today)`);
  console.log(`models: ${report.fixture.models.join(', ')}`);
  console.log(`storage limits: ${report.fixture.maxRunHistoryEntries} entries / ${(report.fixture.maxRunHistoryBytes / 1_000_000).toFixed(2)} MB`);
  console.log(`run-snapshots.jsonl: ${report.runSnapshotsJsonlLines} lines / ${(report.runSnapshotsJsonlBytes / 1024).toFixed(1)} KB`);
  console.log(`queried retained completed runs: ${report.retainedCompletedRunCount}`);
  console.log(`completed-history accumulations: ${report.completedAccumulationCount}`);
  console.log(`open-run accumulations: ${report.openAccumulationCount}`);
  console.log(`startup export awaited: ${report.startupExportAwaited}`);
  console.log(`startup export timer scheduled: ${report.startupExportTimerScheduled}`);

  console.log('\n=== Per-tick measurements ===');
  console.log(
    'tick | query      | compute    | clone      | aggregate KB | token pts | cost pts',
  );
  console.log('-'.repeat(90));
  for (const t of report.ticks) {
    console.log(
      [
        String(t.tickIndex + 1).padStart(4),
        fmtMs(t.queryMs).padStart(10),
        fmtMs(t.computeMs).padStart(10),
        fmtMs(t.cloneMs).padStart(10),
        (t.aggregateSizeBytes / 1024).toFixed(1).padStart(12),
        String(t.todayTokenSeriesLength).padStart(9),
        String(t.todayCostSeriesLength).padStart(8),
      ].join(' | '),
    );
  }
}

function writeReport(report: BenchmarkReport): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reportsDir = path.join(here, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `analytics-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${reportPath}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await withTempDir(async (root) => {
    const agentDir = path.join(root, 'agent');
    await writeModelsJson(agentDir);

    const dataOutcomesRoot = path.join(root, 'outcomes');
    const workspaceId = 'perf-analytics';
    const storageDir = path.join(dataOutcomesRoot, workspaceHash(workspaceId));
    const autoExportPath = path.join(storageDir, 'run-analytics.json');

    let capturedTimerCallback: (() => void) | null = null;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: dataOutcomesRoot,
      workspaceId,
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: MAX_RUN_HISTORY_ENTRIES,
      maxRunHistoryBytes: MAX_RUN_HISTORY_BYTES,
      autoExportIntervalMs: 60_000,
      autoExportSetTimeout: (cb: () => void, _ms: number) => {
        capturedTimerCallback = cb;
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    // Build and persist the historical fixture. The flush batches all pending
    // snapshots into a single JSONL append and prunes to the configured limits.
    const completedRuns = generateCompletedRuns(HISTORICAL_RUN_COUNT);
    for (const run of completedRuns) {
      storage.schedulePersist(run);
    }
    await storage.flush();

    // Phase 3 seam: start must resolve without writing the auto-export.
    await storage.start();
    let startupExportExists = false;
    try {
      await fs.stat(autoExportPath);
      startupExportExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const runSnapshotsPath = path.join(storageDir, 'run-snapshots.jsonl');
    const runSnapshotsRaw = await fs.readFile(runSnapshotsPath, 'utf8');
    const runSnapshotsJsonlBytes = Buffer.byteLength(runSnapshotsRaw, 'utf8');
    const runSnapshotsJsonlLines = runSnapshotsRaw.trim().split('\n').filter(Boolean).length;
    const retainedCompletedRunCount = (await storage.queryPersistedRunAnalytics()).completedRuns.length;

    let openRun = makeOpenRun();
    let completedBuilds = 0;
    let openBuilds = 0;
    let queryMsThisTick = 0;

    const statsService = {
      getStorageDir: () => storageDir,
      queryPersistedRunAnalytics: async () => {
        const t0 = performance.now();
        const result = await storage.queryPersistedRunAnalytics();
        const t1 = performance.now();
        queryMsThisTick += t1 - t0;
        return result;
      },
      getOpenRuns: () => [openRun],
      getPendingCompletedRuns: () => [],
    };

    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/s/open'], openTabPaths: ['/s/open'] },
      }) as ArchState,
      statsService: statsService as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => agentDir,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      onAccumulatorBuilt: (scope: 'completed' | 'open') => {
        if (scope === 'completed') completedBuilds += 1;
        if (scope === 'open') openBuilds += 1;
      },
    });

    const ticks: TickMeasurement[] = [];
    for (let i = 0; i < ACTIVE_TICKS; i += 1) {
      // Mutate the open run so each tick sees a genuine open-run change.
      openRun = { ...openRun, outputTokens: openRun.outputTokens + 100 };
      queryMsThisTick = 0;
      const tickStart = performance.now();
      await (service as unknown as { recompute(): Promise<void> }).recompute();
      const tickEnd = performance.now();
      const aggregate = service.getAggregateStats();

      const c0 = performance.now();
      structuredClone(aggregate);
      const c1 = performance.now();

      ticks.push({
        tickIndex: i,
        queryMs: queryMsThisTick,
        computeMs: Math.max(0, tickEnd - tickStart - queryMsThisTick),
        cloneMs: c1 - c0,
        aggregateSizeBytes: Buffer.byteLength(JSON.stringify(aggregate), 'utf8'),
        todayTokenSeriesLength: aggregate.todayTokenSeries.length,
        todayCostSeriesLength: aggregate.todayCostSeries.length,
      });
    }

    const report: BenchmarkReport = {
      generatedAt: new Date().toISOString(),
      gitSha: gitSha(),
      fixture: {
        historicalRunCount: HISTORICAL_RUN_COUNT,
        todayRunFraction: TODAY_RUN_FRACTION,
        models: MODELS.map((m) => m.id),
        maxRunHistoryEntries: MAX_RUN_HISTORY_ENTRIES,
        maxRunHistoryBytes: MAX_RUN_HISTORY_BYTES,
        aggregatePayloadCeilingBytes: AGGREGATE_PAYLOAD_CEILING_BYTES,
      },
      ticks,
      completedAccumulationCount: completedBuilds,
      openAccumulationCount: openBuilds,
      runSnapshotsJsonlBytes,
      runSnapshotsJsonlLines,
      retainedCompletedRunCount,
      startupExportAwaited: startupExportExists,
      startupExportTimerScheduled: capturedTimerCallback !== null,
    };

    // Structural assertions (fail the benchmark, not just the report).
    for (const tick of ticks) {
      assert.ok(
        tick.todayTokenSeriesLength <= MAX_INTRADAY_CHART_POINTS,
        `todayTokenSeries exceeds cap: ${tick.todayTokenSeriesLength} > ${MAX_INTRADAY_CHART_POINTS}`,
      );
      assert.ok(
        tick.todayCostSeriesLength <= MAX_INTRADAY_CHART_POINTS,
        `todayCostSeries exceeds cap: ${tick.todayCostSeriesLength} > ${MAX_INTRADAY_CHART_POINTS}`,
      );
    }
    const finalSize = ticks[ticks.length - 1]!.aggregateSizeBytes;
    assert.ok(
      finalSize <= AGGREGATE_PAYLOAD_CEILING_BYTES,
      `aggregate payload ${finalSize} B exceeds ceiling ${AGGREGATE_PAYLOAD_CEILING_BYTES} B`,
    );
    assert.equal(
      retainedCompletedRunCount,
      HISTORICAL_RUN_COUNT,
      'benchmark must query all ~2,000 completed runs after retention',
    );
    assert.equal(
      service.getAggregateStats().runCount,
      HISTORICAL_RUN_COUNT + 1,
      'final aggregate must accumulate every retained completion plus the open run',
    );
    assert.equal(
      completedBuilds,
      1,
      'completed history must be accumulated exactly once across active ticks',
    );
    assert.equal(
      openBuilds,
      ACTIVE_TICKS,
      'open runs must be accumulated on every active tick',
    );
    assert.ok(
      runSnapshotsJsonlBytes <= MAX_RUN_HISTORY_BYTES,
      `run-snapshots.jsonl ${runSnapshotsJsonlBytes} B exceeds byte ceiling ${MAX_RUN_HISTORY_BYTES} B`,
    );
    assert.equal(
      startupExportExists,
      false,
      'startup must not await the auto-export; export should be scheduled, not awaited',
    );

    printReport(report);
    writeReport(report);

    await storage.dispose();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
