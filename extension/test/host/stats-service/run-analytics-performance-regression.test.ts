import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { PathLike, WriteFileOptions } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AggregateStatsService } from '../../../src/host/aggregate-stats-service';
import { RunAnalyticsStorage } from '../../../src/host/stats-service/storage';
import { workspaceHash } from '../../../src/host/stats-service/helpers';
import { atomicWriteText as atomicWriteTextImpl } from '../../../src/host/shared/atomic-write';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  type RunSnapshot,
} from '../../../src/host/run-analytics';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analytics-perf-regression-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function snapshot(runId: string, updatedAt: string): RunSnapshot {
  // Retention applies the same canonical coercion as queries, so batching
  // fixtures must also be schema-valid records.
  return validSnapshot(runId, updatedAt);
}

function validSnapshot(runId: string, updatedAt: string): RunSnapshot {
  return {
    runId,
    sessionPath: `/session/${runId}`,
    taskGroupId: `task-${runId}`,
    status: 'open',
    startedAt: updatedAt,
    updatedAt,
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
    toolUsage: createEmptyToolUsageRollup(),
    fileMutation: createEmptyFileMutationRollup(),
    fileExtensions: { readCountsByExtension: {}, writeCountsByExtension: {}, editCountsByExtension: {} },
    verification: createEmptyVerificationRollup(),
  } as RunSnapshot;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function recomputeAggregate(service: AggregateStatsService): Promise<void> {
  await (service as unknown as { recompute(): Promise<void> }).recompute();
}

test('persist job batches each pending JSONL file and throttles automatic export while explicit/shutdown exports stay fresh', async () => {
  await withTempDir(async (root) => {
    let nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const appendCalls = new Map<string, number>();

    // Phase 3: startup no longer awaits the export, so seed a fresh export to
    // keep this test focused on batching/throttling rather than startup timing.
    const storageDir = path.join(root, workspaceHash('batch-and-export'));
    await fs.mkdir(storageDir, { recursive: true });
    const autoExportPath = path.join(storageDir, 'run-analytics.json');
    const emptyExport = JSON.stringify({ completedRuns: [], openRuns: [] });
    await fs.writeFile(autoExportPath, emptyExport, 'utf8');
    await fs.utimes(autoExportPath, new Date(nowMs), new Date(nowMs));

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'batch-and-export',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 30_000,
      appendFile: (async (file, data, options) => {
        const name = path.basename(String(file));
        appendCalls.set(name, (appendCalls.get(name) ?? 0) + 1);
        await fs.appendFile(file, data, options);
      }) as typeof fs.appendFile,
    });

    await storage.start();
    const startupExport = await fs.readFile(autoExportPath, 'utf8');

    const recordedAt = new Date(nowMs).toISOString();
    storage.schedulePersist(snapshot('r1', recordedAt));
    storage.schedulePersist(snapshot('r2', recordedAt));
    await storage.flush();

    assert.equal(appendCalls.get('run-snapshots.jsonl'), 1);
    assert.equal((await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8')).trim().split('\n').length, 2);
    assert.equal(await fs.readFile(autoExportPath, 'utf8'), startupExport, 'ordinary flush must not rebuild auto-export inside the 30s window');

    nowMs += 1_000;
    const explicitPath = path.join(root, 'explicit.json');
    const explicit = await storage.exportRunAnalytics(explicitPath);
    assert.deepEqual(explicit.completedRuns.map((entry) => entry.runId), ['r1', 'r2']);
    assert.equal(await fs.readFile(autoExportPath, 'utf8'), startupExport, 'explicit export to another path does not bypass auto-export throttling');

    await storage.dispose();
    const shutdownExport = JSON.parse(await fs.readFile(autoExportPath, 'utf8')) as { completedRuns: { runId: string }[] };
    assert.deepEqual(shutdownExport.completedRuns.map((entry) => entry.runId), ['r1', 'r2']);
  });
});

test('Phase 3: start does not await auto-export and schedules a refresh when missing', async () => {
  await withTempDir(async (root) => {
    let timerScheduled = false;
    let timerCallback: (() => void) | null = null;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'non-awaited-start',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 30_000,
      autoExportSetTimeout: (cb, _ms) => {
        timerScheduled = true;
        timerCallback = cb;
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    await storage.start();
    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    await waitFor(() => Promise.resolve(timerScheduled));

    assert.equal(timerScheduled, true, 'missing export schedules a refresh via the existing timer');
    let exportExists = false;
    try {
      await fs.stat(autoExportPath);
      exportExists = true;
    } catch {
      exportExists = false;
    }
    assert.equal(exportExists, false, 'start resolves before the export is written');

    timerCallback!();
    await waitFor(async () => {
      try {
        await fs.stat(autoExportPath);
        return true;
      } catch {
        return false;
      }
    }, 500);

    await storage.dispose();
  });
});

test('Phase 3: freshness stat failures never block startup and schedule best-effort recovery', async () => {
  await withTempDir(async (root) => {
    const scheduled: Array<() => void> = [];
    const surfaced: string[] = [];
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'freshness-stat-failure',
      now: () => new Date(),
      serializeSessions: () => ({}),
      onPersistError: ({ message }) => surfaced.push(message),
      stat: async () => {
        const error = new Error('freshness stat denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
      autoExportSetTimeout: (cb) => {
        scheduled.push(cb);
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
    });

    await storage.start();
    await waitFor(() => Promise.resolve(scheduled.length > 0 && surfaced.length > 0));

    assert.match(storage.getPersistError()?.message ?? '', /freshness stat denied/);
    assert.equal(scheduled.length, 1, 'failed freshness check schedules background export recovery');
    assert.equal(surfaced.length, 1, 'failure is surfaced best-effort');
    await storage.dispose();
  });
});

test('Phase 3: start does not rewrite a fresh auto-export', async () => {
  await withTempDir(async (root) => {
    const storageDir = path.join(root, workspaceHash('fresh-auto-export'));
    await fs.mkdir(storageDir, { recursive: true });
    const autoExportPath = path.join(storageDir, 'run-analytics.json');
    const sourcePath = path.join(storageDir, 'run-snapshots.jsonl');

    const oldTime = new Date('2026-07-12T00:00:00.000Z');
    const newTime = new Date('2026-07-12T01:00:00.000Z');

    await fs.writeFile(sourcePath, '', 'utf8');
    await fs.utimes(sourcePath, oldTime, oldTime);

    const baseline = JSON.stringify({ completedRuns: [], openRuns: [] });
    await fs.writeFile(autoExportPath, baseline, 'utf8');
    await fs.utimes(autoExportPath, newTime, newTime);

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'fresh-auto-export',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 30_000,
    });

    await storage.start();

    assert.equal(await fs.readFile(autoExportPath, 'utf8'), baseline, 'fresh export is not rewritten');
    assert.equal(
      (storage as unknown as { autoExportTimer: ReturnType<typeof setTimeout> | null }).autoExportTimer,
      null,
      'no auto-export timer is scheduled for a fresh export',
    );
  });
});

test('Phase 3: start marks a stale auto-export dirty and refreshes it', async () => {
  await withTempDir(async (root) => {
    const storageDir = path.join(root, workspaceHash('stale-auto-export'));
    await fs.mkdir(storageDir, { recursive: true });
    const autoExportPath = path.join(storageDir, 'run-analytics.json');
    const sourcePath = path.join(storageDir, 'run-snapshots.jsonl');

    const oldTime = new Date('2026-07-12T00:00:00.000Z');
    const newTime = new Date('2026-07-12T01:00:00.000Z');
    const exportOldMtime = oldTime.getTime();

    const sourceLine = `${JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: newTime.toISOString(),
      run: validSnapshot('stale-run', newTime.toISOString()),
    })}
`;
    await fs.writeFile(sourcePath, sourceLine, 'utf8');
    await fs.utimes(sourcePath, newTime, newTime);

    await fs.writeFile(autoExportPath, JSON.stringify({ staleMarker: true }), 'utf8');
    await fs.utimes(autoExportPath, oldTime, oldTime);

    let signalTimerScheduled!: () => void;
    const timerScheduled = new Promise<void>((resolve) => { signalTimerScheduled = resolve; });
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'stale-auto-export',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 20,
      autoExportSetTimeout: (callback, ms) => {
        signalTimerScheduled();
        return setTimeout(callback, ms);
      },
    });

    await storage.start();
    await timerScheduled;

    assert.ok(
      (storage as unknown as { autoExportTimer: ReturnType<typeof setTimeout> | null }).autoExportTimer !== null,
      'stale export schedules a refresh via the existing timer',
    );

    await waitFor(async () => {
      const stat = await fs.stat(autoExportPath);
      return stat.mtimeMs > exportOldMtime;
    }, 3_000);

    const refreshed = JSON.parse(await fs.readFile(autoExportPath, 'utf8')) as { completedRuns: unknown[] };
    assert.equal(refreshed.completedRuns.length, 1);

    await storage.dispose();
  });
});

test('Phase 3: start auto-export failures are retried and do not block startup', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'start-failure',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 20,
      autoExportRetryBaseMs: 10,
      autoExportRetryMaxMs: 100,
    });

    const originalWrite = (storage as unknown as { writeAutoExport(): Promise<void> }).writeAutoExport.bind(storage);
    let fail = true;
    (storage as unknown as { writeAutoExport(): Promise<void> }).writeAutoExport = async () => {
      if (fail) throw new Error('injected startup failure');
      return originalWrite();
    };

    await storage.start();
    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    await waitFor(() => Promise.resolve(
      (storage as unknown as { autoExportTimer: ReturnType<typeof setTimeout> | null }).autoExportTimer !== null,
    ));

    assert.ok(
      (storage as unknown as { autoExportTimer: ReturnType<typeof setTimeout> | null }).autoExportTimer !== null,
      'failure schedules a retry via the existing timer',
    );

    await waitFor(
      () => Promise.resolve(storage.getPersistError()?.message.includes('injected startup failure') ?? false),
      500,
    );

    fail = false;
    await storage.dispose();

    await fs.stat(autoExportPath);
  });
});

test('automatic export refreshes within its configured bounded interval', async () => {
  await withTempDir(async (root) => {
    const autoExportIntervalMs = 20;
    const scheduledTimers: Array<{ callback: () => void; delayMs: number }> = [];
    let signalTimerScheduled!: () => void;
    let timerScheduled = new Promise<void>((resolve) => { signalTimerScheduled = resolve; });
    const takeScheduledTimer = async (): Promise<{ callback: () => void; delayMs: number }> => {
      if (scheduledTimers.length === 0) await timerScheduled;
      const timer = scheduledTimers.shift();
      assert.ok(timer, 'auto-export schedules a timer');
      timerScheduled = new Promise<void>((resolve) => { signalTimerScheduled = resolve; });
      return timer;
    };
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'bounded-auto-export',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs,
      autoExportSetTimeout: (callback, delayMs) => {
        scheduledTimers.push({ callback, delayMs });
        signalTimerScheduled();
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
      },
    });
    await storage.start();
    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    const startupTimer = await takeScheduledTimer();
    assert.ok(startupTimer.delayMs > 0 && startupTimer.delayMs <= autoExportIntervalMs,
      'startup refresh honors the configured positive interval bound');
    startupTimer.callback();
    await (storage as unknown as { persistenceQueue: Promise<void> }).persistenceQueue;

    const recordedAt = new Date().toISOString();
    storage.schedulePersist(snapshot('bounded', recordedAt));
    await storage.flush();

    const postFlushTimer = await takeScheduledTimer();
    assert.ok(postFlushTimer.delayMs > 0 && postFlushTimer.delayMs <= autoExportIntervalMs,
      'post-flush refresh honors the configured positive interval bound');
    postFlushTimer.callback();
    await (storage as unknown as { persistenceQueue: Promise<void> }).persistenceQueue;

    const payload = JSON.parse(await fs.readFile(autoExportPath, 'utf8')) as { completedRuns: { runId: string }[] };
    assert.ok(payload.completedRuns.some((entry) => entry.runId === 'bounded'));
    await storage.dispose();
  });
});

test('aggregate refresh reads completed history once while active ticks use live in-memory state', async () => {
  await withTempDir(async (storageDir) => {
    let persistedQueries = 0;
    let openRunReads = 0;
    let outputTokens = 0;
    let nowMs = Date.parse('2026-07-29T12:00:00.000Z');
    const activeRun = validSnapshot('active-run', new Date(nowMs).toISOString());
    const statsService = {
      getStorageDir: () => storageDir,
      queryPersistedRunAnalytics: async () => {
        persistedQueries += 1;
        return { completedRuns: [], openRuns: [] };
      },
      getOpenRuns: () => {
        openRunReads += 1;
        return [{ ...activeRun, sessionPath: '/active', outputTokens }];
      },
      getPendingCompletedRuns: () => [],
    };
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/active'], openTabPaths: ['/active'] },
      }) as never,
      statsService: statsService as never,
      tokenRateService: {
        getRates: () => ({
          '/active': { state: 'generating', rate: outputTokens, updatedAt: nowMs },
        }),
      } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      now: () => new Date(nowMs),
    });

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().liveTokensPerSecond, 0, 'first observation establishes the rolling baseline');
    outputTokens = 3;
    nowMs += 1_000;
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().liveTokensPerSecond, 3);
    outputTokens = 7;
    nowMs += 1_000;
    await (service as unknown as { recompute(): Promise<void> }).recompute();

    assert.equal(persistedQueries, 1, 'unchanged active tick must not flush/re-read full history');
    assert.equal(openRunReads, 3, 'open runs remain live on every active recompute');
    assert.equal(service.getAggregateStats().liveTokensPerSecond, 3.5);
  });
});

test('AggregateStatsService includes live open-run tokens and counts without re-querying completed history', async () => {
  await withTempDir(async (storageDir) => {
    let persistedQueries = 0;
    const now = new Date();
    const openRun: RunSnapshot = {
      runId: 'open-1',
      sessionPath: '/live',
      taskGroupId: 'tg-1',
      status: 'open',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      modelId: 'claude-sonnet-4',
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolUsage: { totalCount: 5 },
      fileMutation: { touchedFileCount: 7 },
      turnThroughputSamples: [],
    } as unknown as RunSnapshot;
    const statsService = {
      getStorageDir: () => storageDir,
      queryPersistedRunAnalytics: async () => {
        persistedQueries += 1;
        return { completedRuns: [], openRuns: [] };
      },
      getOpenRuns: () => [openRun],
      getPendingCompletedRuns: () => [],
    };
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/live'], openTabPaths: ['/live'] },
      }) as never,
      statsService: statsService as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
    });

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().runCount, 1, 'open run contributes to runCount');
    assert.equal(service.getAggregateStats().totalOutputTokens, 1000, 'open run tokens roll up');
    assert.equal(service.getAggregateStats().todayRunCount, 1, 'open run counts as today');

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(persistedQueries, 1, 'completed history not re-queried while persisted signature unchanged');
  });
});

test('AggregateStatsService refreshLive updates estimated streaming tokens and charts without slow polling', async () => {
  await withTempDir(async (storageDir) => {
    const now = new Date();
    let liveOutputTokens = 100;
    let persistedQueries = 0;
    let backendPolls = 0;
    const openRun = {
      ...validSnapshot('live-estimate', now.toISOString()),
      sessionPath: '/live',
      status: 'open',
      finalizedAt: undefined,
      outputTokens: 1_000,
    } as RunSnapshot;
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/live'], openTabPaths: ['/live'] },
      }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => {
          persistedQueries += 1;
          return { completedRuns: [], openRuns: [] };
        },
        getOpenRuns: () => [openRun],
        getPendingCompletedRuns: () => [],
      } as never,
      tokenRateService: {
        getRates: () => ({
          '/live': { state: 'generating', rate: 20, liveOutputTokens },
        }),
      } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => { backendPolls += 1; return EMPTY_PROVIDER_GATE_STATS; },
      onChanged: () => undefined,
    });

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().todayOutputTokens, 1_100);
    const pollsAfterInitialCompute = backendPolls;

    liveOutputTokens = 250;
    service.refreshLive();
    const refreshed = service.getAggregateStats();
    assert.equal(refreshed.todayOutputTokens, 1_250);
    assert.equal(refreshed.totalOutputTokens, 1_250);
    const finalPoint = refreshed.todayTokenSeries.at(-1);
    assert.equal(finalPoint?.byProvider.reduce((sum, segment) => sum + segment.value, 0), 1_250,
      'the cumulative token graph advances with the live estimate');
    assert.equal(persistedQueries, 1, 'fast refresh never reads completed history');
    assert.equal(backendPolls, pollsAfterInitialCompute, 'fast refresh never polls backend metrics');
  });
});

test('AggregateStatsService refreshLive retains a just-persisted run until the completed layer refreshes', async () => {
  await withTempDir(async (storageDir) => {
    const now = new Date().toISOString();
    let pendingRuns = [{
      ...validSnapshot('pending-to-persisted', now),
      finalizedAt: now,
      outputTokens: 900,
    } as RunSnapshot];
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => ({
          completedRuns: [], openRuns: [],
        }),
        getOpenRuns: () => [],
        getPendingCompletedRuns: () => pendingRuns,
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: 100 }),
    });

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().totalOutputTokens, 900);
    pendingRuns = [];
    (service as unknown as { inFlight: boolean }).inFlight = true;
    service.refreshLive();
    (service as unknown as { inFlight: boolean }).inFlight = false;
    assert.equal(service.getAggregateStats().totalOutputTokens, 900,
      'fast refresh must not publish a transient aggregate dip');
  });
});

test('AggregateStatsService cache keys on snapshots only — checkpoint churn does not reread completed history', async () => {
  await withTempDir(async (storageDir) => {
    let persistedQueries = 0;
    // Snapshot stays stable; gen changes to simulate checkpoint churn.
    // AggregateStatsService keys only on snapshots, so the cache stays valid.
    let genMtime = 200;
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: [], openTabPaths: [] },
      }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => {
          persistedQueries += 1;
          return { completedRuns: [], openRuns: [] };
        },
        getOpenRuns: () => [],
        getPendingCompletedRuns: () => [],
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      mtimeFn: (p, cb) => {
        const s = String(p);
        if (s.includes('open-runs.gen')) {
          cb(null, { mtimeMs: genMtime });
        } else {
          cb(null, { mtimeMs: 100 });
        }
      },
    });

    // Tick 1: both files exist → cache populated with snapshot=100, gen=200.
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(persistedQueries, 1, 'first recompute queries persisted history');

    // Tick 2: gen mtime changes (checkpoint write) but snapshot stays the same.
    // The cache should still be valid because the signature only tracks snapshots.
    genMtime = 999;
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(persistedQueries, 1, 'checkpoint-only mtime change must not reread completed history');

    // Tick 3: another gen churn.
    genMtime = 2000;
    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(persistedQueries, 1, 'repeated checkpoint churn must not increase persisted queries');
  });
});

test('AggregateStatsService caches completed accumulation, rebuilds open runs, and bridges persistence gaps', async () => {
  await withTempDir(async (storageDir) => {
    const now = new Date().toISOString();
    let snapshotsMtime = 100;
    let persistedQueries = 0;
    let completedRuns = [
      { ...validSnapshot('historical', now), finalizedAt: now, outputTokens: 10 } as RunSnapshot,
    ];
    let openRuns = [
      { ...validSnapshot('transitioning', now), outputTokens: 20 } as RunSnapshot,
    ];
    let pendingCompletedRuns: RunSnapshot[] = [];
    const builds: Array<{ scope: 'completed' | 'open'; runCount: number }> = [];
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => {
          persistedQueries += 1;
          return { completedRuns, openRuns: [] };
        },
        getOpenRuns: () => openRuns,
        getPendingCompletedRuns: () => pendingCompletedRuns,
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      onAccumulatorBuilt: (scope, runCount) => builds.push({ scope, runCount }),
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: snapshotsMtime }),
    });

    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalOutputTokens, 30);
    await recomputeAggregate(service);
    assert.equal(persistedQueries, 1, 'unchanged history is queried once');
    assert.equal(builds.filter((entry) => entry.scope === 'completed').length, 1);
    assert.equal(builds.filter((entry) => entry.scope === 'open').length, 2, 'open set accumulates every tick');

    openRuns = [{ ...openRuns[0]!, outputTokens: 30 } as RunSnapshot];
    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalOutputTokens, 40);
    assert.equal(builds.filter((entry) => entry.scope === 'completed').length, 1,
      'changing an open run does not revisit completed runs');

    const finalizedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const finalized = {
      ...openRuns[0]!,
      status: 'closed',
      finalizedAt,
      updatedAt: finalizedAt,
    } as RunSnapshot;
    openRuns = [];
    pendingCompletedRuns = [finalized];
    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalOutputTokens, 40,
      'authoritative finalized snapshot bridges until persistence catches up');
    assert.equal(service.getAggregateStats().lastRun?.endedAt, finalizedAt);

    completedRuns = [completedRuns[0]!, finalized];
    pendingCompletedRuns = [];
    snapshotsMtime += 1;
    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalOutputTokens, 40,
      'persisted completion replaces rather than duplicates the bridge');
    assert.equal(persistedQueries, 2);
    assert.equal(builds.filter((entry) => entry.scope === 'completed').length, 3,
      'pending override and subsequent persistence each invalidate completed accumulation');
  });
});

test('AggregateStatsService pending finalized snapshots override stale persisted snapshots with the same runId', async () => {
  await withTempDir(async (storageDir) => {
    const at = new Date().toISOString();
    const stale = {
      ...validSnapshot('same-run', at),
      status: 'closed',
      finalizedAt: at,
      outputTokens: 10,
    } as RunSnapshot;
    const scored = {
      ...stale,
      status: 'closed',
      outputTokens: 20,
      updatedAt: new Date(Date.parse(at) + 1_000).toISOString(),
      finalizedAt: new Date(Date.parse(at) + 1_000).toISOString(),
    } as RunSnapshot;
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => ({
          completedRuns: [stale], openRuns: [],
        }),
        getOpenRuns: () => [],
        getPendingCompletedRuns: () => [scored],
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: 100 }),
    });

    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().runCount, 1, 'same runId is not double counted');
    assert.equal(service.getAggregateStats().totalOutputTokens, 20, 'pending scored snapshot replaces stale tokens');
  });
});

test('AggregateStatsService buckets a bridged completion by its finalized timestamp across local midnight', async () => {
  await withTempDir(async (storageDir) => {
    const beforeMidnight = new Date(2026, 6, 12, 23, 59, 59, 900);
    const afterMidnight = new Date(2026, 6, 13, 0, 0, 0, 100);
    const staleOpen = validSnapshot('midnight-run', beforeMidnight.toISOString());
    const finalized = {
      ...staleOpen,
      status: 'closed',
      finalizedAt: afterMidnight.toISOString(),
      updatedAt: afterMidnight.toISOString(),
      outputTokens: 42,
    } as RunSnapshot;
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => ({
          completedRuns: [], openRuns: [],
        }),
        getOpenRuns: () => [],
        getPendingCompletedRuns: () => [finalized],
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      now: () => afterMidnight,
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: 100 }),
    });

    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().todayRunCount, 1);
    assert.equal(service.getAggregateStats().todayOutputTokens, 42);
    assert.equal(service.getAggregateStats().lastRun?.endedAt, afterMidnight.toISOString());
  });
});

test('AggregateStatsService pricing signature invalidates completed cost accumulation', async () => {
  await withTempDir(async (root) => {
    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir, { recursive: true });
    const modelsPath = path.join(agentDir, 'models.json');
    const writePricing = async (input: number, mtimeMs: number): Promise<void> => {
      await fs.writeFile(modelsPath, JSON.stringify({
        providers: { priced: { models: [{ id: 'm', cost: { input, output: 0 } }] } },
      }), 'utf8');
      await fs.utimes(modelsPath, new Date(mtimeMs), new Date(mtimeMs));
    };
    const baseMtime = Date.now() - 60_000;
    await writePricing(1, baseMtime);

    const now = new Date().toISOString();
    const completed = {
      ...validSnapshot('priced-run', now),
      finalizedAt: now,
      modelId: 'm',
      inputTokens: 1_000_000,
    } as RunSnapshot;
    let persistedQueries = 0;
    let completedBuilds = 0;
    const service = new AggregateStatsService({
      getArchState: () => ({ sessions: { runningSessionPaths: [], openTabPaths: [] } }) as never,
      statsService: {
        getStorageDir: () => root,
        queryPersistedRunAnalytics: async () => {
          persistedQueries += 1;
          return { completedRuns: [completed], openRuns: [] };
        },
        getOpenRuns: () => [],
        getPendingCompletedRuns: () => [],
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => agentDir,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
      onAccumulatorBuilt: (scope) => { if (scope === 'completed') completedBuilds += 1; },
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: 100 }),
    });

    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalCost, 1);
    await writePricing(2, baseMtime + 30_000);
    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats().totalCost, 2);
    assert.equal(persistedQueries, 1, 'pricing invalidation reuses cached run snapshots');
    assert.equal(completedBuilds, 2, 'pricing change rebuilds the priced completed accumulator');
  });
});

test('AggregateStatsService preserves references for equal/live-only refreshes and replaces historical arrays', async () => {
  await withTempDir(async (storageDir) => {
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    let running = true;
    let changedCalls = 0;
    let openRuns = [{
      ...validSnapshot('open-reference', now),
      modelId: 'free',
      outputTokens: 10,
    } as RunSnapshot];
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: running ? ['/live'] : [], openTabPaths: ['/live'] },
      }) as never,
      statsService: {
        getStorageDir: () => storageDir,
        queryPersistedRunAnalytics: async () => ({
          completedRuns: [], openRuns: [],
        }),
        getOpenRuns: () => openRuns,
        getPendingCompletedRuns: () => [],
      } as never,
      tokenRateService: {
        getRates: () => ({ '/live': { state: 'generating', rate: 0, updatedAt: nowMs } }),
      } as never,
      getAgentDir: () => null,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => { changedCalls += 1; },
      mtimeFn: (_path, cb) => cb(null, { mtimeMs: 100 }),
      now: () => new Date(nowMs),
    });

    await recomputeAggregate(service);
    const initial = service.getAggregateStats();
    const initialTokenSeries = initial.todayTokenSeries;
    const initialProviderCosts = initial.costByProvider;
    assert.equal(changedCalls, 1);

    await recomputeAggregate(service);
    assert.equal(service.getAggregateStats(), initial, 'equal recomputation retains root identity');
    assert.equal(changedCalls, 1);

    running = false;
    await recomputeAggregate(service);
    const liveChanged = service.getAggregateStats();
    assert.notEqual(liveChanged, initial, 'live field change creates a new root');
    assert.equal(liveChanged.todayTokenSeries, initialTokenSeries,
      'live-only refresh retains intraday history reference');
    assert.equal(liveChanged.costByProvider, initialProviderCosts,
      'live-only refresh retains provider history reference');
    assert.equal(changedCalls, 2);

    const beforeHistoricalChange = service.getAggregateStats();
    openRuns = [{ ...openRuns[0]!, outputTokens: 20 } as RunSnapshot];
    await recomputeAggregate(service);
    const historicalChanged = service.getAggregateStats();
    assert.notEqual(historicalChanged.todayTokenSeries, beforeHistoricalChange.todayTokenSeries,
      'changed run replaces the affected historical series');
    assert.equal(changedCalls, 3, 'historical change invokes onChanged exactly once');
  });
});

test('auto-export failures retry with bounded exponential backoff and stop scheduling timers after dispose', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const delays: number[] = [];
    const baseMs = 10;
    const maxMs = 100;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'retry-backoff',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 5,
      autoExportRetryBaseMs: baseMs,
      autoExportRetryMaxMs: maxMs,
      autoExportSetTimeout: (cb, ms) => {
        delays.push(ms);
        return setTimeout(cb, ms);
      },
    });

    await storage.start();
    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    await waitFor(async () => {
      try {
        await fs.stat(autoExportPath);
        return true;
      } catch {
        return false;
      }
    }, 2000);

    const originalWrite = (storage as unknown as { writeAutoExport(): Promise<void> }).writeAutoExport.bind(storage);
    let fail = false;
    (storage as unknown as { writeAutoExport(): Promise<void> }).writeAutoExport = async () => {
      if (fail) throw new Error('injected auto-export failure');
      return originalWrite();
    };

    fail = true;
    storage.schedulePersist();
    await storage.flush();
    await waitFor(() => Promise.resolve(delays.length >= 7), 2000);

    await storage.dispose();
    const delayCountAfterDispose = delays.length;
    await new Promise((resolve) => setTimeout(resolve, maxMs * 3));
    assert.equal(delays.length, delayCountAfterDispose, 'no timers scheduled after dispose');

    // Phase 3: startup now schedules the export via the existing timer, so
    // the first two captured delays are the startup throttle and the post-flush
    // throttle; the retry backoff starts after that.
    const retryDelays = delays.slice(2);
    assert.ok(retryDelays.every((d) => d > 0), 'no zero-delay timers');
    assert.equal(retryDelays[0], baseMs, 'first retry uses base delay');
    assert.equal(retryDelays[1], baseMs * 2, 'second retry doubles');
    assert.equal(retryDelays[2], baseMs * 4, 'third retry doubles again');
    assert.ok(retryDelays.some((d) => d === maxMs), 'backoff reaches the configured cap');
    assert.ok(retryDelays.every((d) => d <= maxMs), 'delays stay bounded by the cap');
  });
});

test('markAutoExportDirty runs despite prune failure and prune errors surface as persistence errors', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'prune-failure',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 1,
      maxRunHistoryBytes: 1,
      autoExportIntervalMs: 60_000,
    });

    await storage.start();
    const recordedAt = new Date(nowMs).toISOString();
    storage.schedulePersist(validSnapshot('old', recordedAt));
    await storage.flush();

    (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded = async () => {
      throw new Error('prune boom');
    };

    storage.schedulePersist(validSnapshot('new', new Date(nowMs + 1).toISOString()));
    await storage.flush().catch(() => undefined);

    assert.ok(
      (storage as unknown as { autoExportDirtyVersion: number }).autoExportDirtyVersion > 0,
      'auto-export is marked dirty even when prune fails',
    );
    assert.ok(
      storage.getPersistError()?.message.includes('prune boom'),
      'prune failure is surfaced as a persistence error',
    );

    const payload = await storage.exportRunAnalytics(path.join(storage.getStorageDir(), 'run-analytics.json'));
    assert.ok(
      payload.completedRuns.some((r) => r.runId === 'new'),
      'explicit export still refreshes despite prior prune failure',
    );
  });
});

test('batched append preserves the newest pending entry when a newer version arrives while I/O is in flight', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    let releaseAppend: (() => void) | null = null;
    let appendInFlight = false;
    let blockAppend = true;
    const appendFile = async (file: PathLike, data: string, options?: WriteFileOptions): Promise<void> => {
      if (blockAppend) {
        blockAppend = false;
        appendInFlight = true;
        await new Promise<void>((resolve) => { releaseAppend = resolve; });
        appendInFlight = false;
      }
      return fs.appendFile(file, data, options);
    };
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'restaging',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      appendFile: appendFile as typeof fs.appendFile,
    });

    await storage.start();
    const first = validSnapshot('r1', new Date(nowMs).toISOString());
    storage.schedulePersist(first);
    const flush1 = storage.flush();
    await waitFor(() => Promise.resolve(appendInFlight), 500);

    const second = validSnapshot('r1', new Date(nowMs + 1000).toISOString());
    storage.schedulePersist(second);
    assert.equal(
      (storage as unknown as { pendingSnapshots: Map<string, RunSnapshot> }).pendingSnapshots.get('r1'),
      second,
      'newer snapshot replaces the pending one while the first append is in flight',
    );

    releaseAppend!();
    await flush1;
    await storage.flush();

    const result = await storage.queryRunAnalytics();
    const runs = result.completedRuns.filter((r) => r.runId === 'r1');
    assert.equal(runs.length, 1, 'query deduplicates to a single latest run');
    assert.equal(runs[0]?.updatedAt, second.updatedAt, 'latest pending snapshot wins after restaging');
  });
});

test('prunes JSONL when byte limit is exceeded but line count is not', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'byte-limit-only',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 10,
      maxRunHistoryBytes: 150,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    const t = new Date(nowMs).toISOString();
    storage.schedulePersist(validSnapshot('old1', t));
    storage.schedulePersist(validSnapshot('old2', t));
    storage.schedulePersist(validSnapshot('new', t));
    await storage.flush();

    const raw = await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'only newest record retained when byte limit is exceeded');
    assert.equal(JSON.parse(lines[0]!).run.runId, 'new');
  });
});

test('prunes JSONL when line limit is exceeded but byte limit is not', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'line-limit-only',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 2,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    const t = new Date(nowMs).toISOString();
    for (let i = 1; i <= 5; i += 1) {
      storage.schedulePersist(validSnapshot(`r${i}`, t));
    }
    await storage.flush();

    const raw = await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2, 'only newest two records retained when line limit is exceeded');
    assert.equal(JSON.parse(lines[0]!).run.runId, 'r4');
    assert.equal(JSON.parse(lines[1]!).run.runId, 'r5');
  });
});

test('prunes JSONL to satisfy both line and byte limits when both are exceeded', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const t = new Date(nowMs).toISOString();
    const sampleLine = `${JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: t,
      run: validSnapshot('sample', t),
    })}\n`;
    const oneLineBytes = Buffer.byteLength(sampleLine, 'utf8');
    // Two lines fit, three lines exceed, and the line limit is 2.
    const byteLimit = oneLineBytes * 2 + 100;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'both-limits',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 2,
      maxRunHistoryBytes: byteLimit,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    storage.schedulePersist(validSnapshot('old1', t));
    storage.schedulePersist(validSnapshot('old2', t));
    storage.schedulePersist(validSnapshot('old3', t));
    storage.schedulePersist(validSnapshot('new', t));
    await storage.flush();

    const raw = await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2, 'retained suffix satisfies both the line limit and the byte limit');
    assert.equal(JSON.parse(lines[0]!).run.runId, 'old3');
    assert.equal(JSON.parse(lines[1]!).run.runId, 'new');
    assert.ok(
      Buffer.byteLength(raw, 'utf8') <= byteLimit,
      'remaining file bytes stay within the hard byte limit',
    );
  });
});

test('counts multibyte UTF-8 bytes rather than JavaScript string length', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const t = new Date(nowMs).toISOString();
    const note = '€'.repeat(50);
    const sampleLine = `${JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: t,
      run: { ...validSnapshot('sample', t), note },
    })}\n`;
    const charLength = sampleLine.length;
    const byteLength = Buffer.byteLength(sampleLine, 'utf8');
    // Pick a byte limit that is larger than one line's bytes but smaller than
    // two lines' bytes, while two lines' character length would fit. This can
    // only happen when byte size is measured, not string length.
    const byteLimit = charLength + byteLength;

    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'utf8-bytes',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 10,
      maxRunHistoryBytes: byteLimit,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    storage.schedulePersist({ ...validSnapshot('a', t), note } as RunSnapshot);
    storage.schedulePersist({ ...validSnapshot('b', t), note } as RunSnapshot);
    storage.schedulePersist({ ...validSnapshot('c', t), note } as RunSnapshot);
    await storage.flush();

    const raw = await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'UTF-8 byte size governs retention, not JavaScript string length');
    assert.equal(JSON.parse(lines[0]!).run.runId, 'c');
  });
});

test('retains the newest records in chronological order', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'newest-order',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 2,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    for (let i = 1; i <= 5; i += 1) {
      storage.schedulePersist(validSnapshot(`r${i}`, new Date(nowMs + i).toISOString()));
    }
    await storage.flush();

    const raw = await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).run.runId, 'r4');
    assert.equal(JSON.parse(lines[1]!).run.runId, 'r5');
  });
});

test('history retention scans each under-limit file once and tracks later appends incrementally', async () => {
  await withTempDir(async (root) => {
    let historyReads = 0;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'retention-read-fast-path',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 100,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
      readFile: (async (filePath: Parameters<typeof fs.readFile>[0], encoding: BufferEncoding) => {
        historyReads += 1;
        return fs.readFile(filePath, encoding);
      }) as typeof fs.readFile,
    });
    await storage.start();

    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();
    assert.equal(historyReads, 1, 'the first pass establishes metadata for the history file');
    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();
    assert.equal(historyReads, 1, 'unchanged under-limit file is not read again');

    const t = new Date().toISOString();
    storage.schedulePersist(validSnapshot('tracked-append', t));
    await storage.flush();
    assert.equal(historyReads, 1, 'known valid appends update retention metadata without rescanning files');
    await storage.dispose();
  });
});

test('a partially written failed append invalidates retention metadata before the next prune', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'partial-append-retention',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 1,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
      appendFile: (async (file: Parameters<typeof fs.appendFile>[0], data: string | Uint8Array) => {
        await fs.appendFile(file, data);
        throw new Error('append acknowledgement lost');
      }) as typeof fs.appendFile,
    });
    await storage.start();
    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();

    const t = new Date().toISOString();
    const envelope = (runId: string) => ({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot' as const,
      recordedAt: t,
      run: validSnapshot(runId, t),
    });
    const chunk = `${JSON.stringify(envelope('partial-1'))}\n${JSON.stringify(envelope('partial-2'))}\n`;
    await assert.rejects(
      (storage as unknown as {
        appendHistoryChunk(fileName: string, chunk: string, entryCount: number): Promise<void>;
      }).appendHistoryChunk('run-snapshots.jsonl', chunk, 2),
      /append acknowledgement lost/,
    );
    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();

    const retained = (await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(retained.length, 1);
    assert.equal(JSON.parse(retained[0]!).run.runId, 'partial-2');
    await storage.dispose();
  });
});

test('malformed and truncated tails do not displace the newest valid retained records', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'malformed-retention',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 2,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    const t = new Date().toISOString();
    const filePath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');
    const validLines = ['r1', 'r2', 'r3'].map((runId) => JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: t,
      run: validSnapshot(runId, t),
    }));
    await fs.writeFile(filePath, `${validLines.join('\n')}\nnot-json\n{"kind":"run_snapshot"`, 'utf8');

    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();

    const retained = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(retained.length, 2);
    assert.deepEqual(retained.map((line) => JSON.parse(line).run.runId), ['r2', 'r3']);
    await storage.dispose();
  });
});

test('schema-invalid newest records are rejected by the same coercers as canonical queries', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'schema-invalid-retention',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 1,
      maxRunHistoryBytes: 100_000,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    const t = new Date().toISOString();
    const dir = storage.getStorageDir();
    await fs.writeFile(path.join(dir, 'run-snapshots.jsonl'), [
      JSON.stringify({ schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION, kind: 'run_snapshot', recordedAt: t, run: validSnapshot('valid-snapshot', t) }),
      JSON.stringify({ kind: 'run_snapshot', run: { runId: 'schema-invalid-snapshot' } }),
    ].join('\n') + '\n', 'utf8');

    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();

    const snapshotRaw = await fs.readFile(path.join(dir, 'run-snapshots.jsonl'), 'utf8');
    assert.equal(JSON.parse(snapshotRaw).run.runId, 'valid-snapshot');
    await storage.dispose();
  });
});

test('mandatory-newest exception selects a valid record behind an oversized malformed tail', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'valid-newest-exception',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 10,
      maxRunHistoryBytes: 1,
      autoExportIntervalMs: 60_000,
    });
    await storage.start();
    const t = new Date().toISOString();
    const filePath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');
    await fs.writeFile(filePath, `${JSON.stringify({ schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION, kind: 'run_snapshot', recordedAt: t, run: validSnapshot('valid-newest', t) })}\n${'x'.repeat(500)}\n`, 'utf8');

    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();

    const retained = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(retained.length, 1);
    assert.equal(JSON.parse(retained[0]!).run.runId, 'valid-newest');
    await storage.dispose();
  });
});

test('retains a single oversized newest record without an atomic-rewrite loop', async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    let atomicCalls = 0;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'oversized-record',
      now: () => new Date(nowMs),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 5,
      maxRunHistoryBytes: 50,
      autoExportIntervalMs: 60_000,
      atomicWriteText: async (filePath, data) => {
        atomicCalls += 1;
        await fs.writeFile(filePath, data, 'utf8');
      },
    });
    await storage.start();
    const t = new Date(nowMs).toISOString();
    storage.schedulePersist({ ...validSnapshot('old', t), note: 'x' } as RunSnapshot);
    storage.schedulePersist({ ...validSnapshot('big', t), note: '€'.repeat(200) } as RunSnapshot);
    await storage.flush();

    const filePath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'only the oversized newest record remains');
    assert.equal(JSON.parse(lines[0]!).run.runId, 'big');

    const callsAfterFlush = atomicCalls;
    await (storage as unknown as { pruneHistoryIfNeeded(): Promise<void> }).pruneHistoryIfNeeded();
    assert.equal(atomicCalls, callsAfterFlush, 'already-accepted oversized record causes no extra rewrite');
  });
});

test('atomic-write failures during pruning preserve the original file and surface a persistence error', async () => {
  await withTempDir(async (root) => {
    let shouldFail = false;
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'atomic-failure',
      now: () => new Date(),
      serializeSessions: () => ({}),
      maxRunHistoryEntries: 2,
      maxRunHistoryBytes: 10_000,
      autoExportIntervalMs: 60_000,
      atomicWriteText: async (filePath, data) => {
        if (shouldFail) {
          throw new Error('atomic write failure');
        }
        return atomicWriteTextImpl(filePath, data);
      },
    });
    await storage.start();
    const t = new Date().toISOString();
    const filePath = path.join(storage.getStorageDir(), 'run-snapshots.jsonl');

    // Seed the file with three records so the next append triggers pruning.
    const initialLines = ['r1', 'r2', 'r3'].map((runId) => `${JSON.stringify({
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      kind: 'run_snapshot',
      recordedAt: t,
      run: validSnapshot(runId, t),
    })}\n`).join('');
    await fs.writeFile(filePath, initialLines, 'utf8');

    const before = await fs.readFile(filePath, 'utf8');
    assert.equal(before.trim().split('\n').length, 3);

    shouldFail = true;
    storage.schedulePersist(validSnapshot('r4', t));
    await storage.flush();

    const after = await fs.readFile(filePath, 'utf8');
    assert.ok(after.includes('r1') && after.includes('r2') && after.includes('r3') && after.includes('r4'),
      'original records plus the newly appended record remain after a failed atomic rewrite');
    assert.ok(
      storage.getPersistError()?.message.includes('atomic write failure'),
      'atomic-write failure is surfaced as a persistence error',
    );
  });
});
