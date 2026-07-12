import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { PathLike, WriteFileOptions } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AggregateStatsService } from '../src/host/aggregate-stats-service';
import { RunAnalyticsStorage } from '../src/host/stats-service/storage';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  type OutcomeHistoryLogEntry,
  type RunSnapshot,
} from '../src/host/run-analytics';
import { EMPTY_PROVIDER_GATE_STATS, EMPTY_WARM_BASH_STATS } from '../src/shared/protocol/aggregate-stats';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-analytics-perf-regression-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function outcome(runId: string, recordedAt: string): OutcomeHistoryLogEntry {
  return {
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_outcome',
    recordedAt,
    sessionPath: `/session/${runId}`,
    runId,
    taskGroupId: `task-${runId}`,
    outcome: { resolution: 'resolved', satisfaction: 4 },
  };
}

function snapshot(runId: string, updatedAt: string): RunSnapshot {
  // Persistence treats snapshots as opaque JSON. The query coercion tests cover
  // the complete schema separately; this fixture intentionally targets batching.
  return {
    runId,
    sessionPath: `/session/${runId}`,
    taskGroupId: `task-${runId}`,
    startedAt: updatedAt,
    updatedAt,
  } as RunSnapshot;
}

function validSnapshot(runId: string, updatedAt: string): RunSnapshot {
  return {
    runId,
    sessionPath: `/session/${runId}`,
    taskGroupId: `task-${runId}`,
    status: 'open',
    scored: false,
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

test('persist job batches each pending JSONL file and throttles automatic export while explicit/shutdown exports stay fresh', async () => {
  await withTempDir(async (root) => {
    let nowMs = Date.parse('2026-07-12T00:00:00.000Z');
    const appendCalls = new Map<string, number>();
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
    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    const startupExport = await fs.readFile(autoExportPath, 'utf8');

    const recordedAt = new Date(nowMs).toISOString();
    storage.schedulePersist(snapshot('r1', recordedAt), outcome('r1', recordedAt));
    storage.schedulePersist(snapshot('r2', recordedAt), outcome('r2', recordedAt));
    await storage.flush();

    assert.equal(appendCalls.get('run-snapshots.jsonl'), 1);
    assert.equal(appendCalls.get('outcome-history.jsonl'), 1);
    assert.equal((await fs.readFile(path.join(storage.getStorageDir(), 'run-snapshots.jsonl'), 'utf8')).trim().split('\n').length, 2);
    assert.equal(await fs.readFile(autoExportPath, 'utf8'), startupExport, 'ordinary flush must not rebuild auto-export inside the 30s window');

    nowMs += 1_000;
    const explicitPath = path.join(root, 'explicit.json');
    const explicit = await storage.exportRunAnalytics(explicitPath);
    assert.deepEqual(explicit.outcomes.map((entry) => entry.runId), ['r1', 'r2']);
    assert.equal(await fs.readFile(autoExportPath, 'utf8'), startupExport, 'explicit export to another path does not bypass auto-export throttling');

    await storage.dispose();
    const shutdownExport = JSON.parse(await fs.readFile(autoExportPath, 'utf8')) as { outcomes: OutcomeHistoryLogEntry[] };
    assert.deepEqual(shutdownExport.outcomes.map((entry) => entry.runId), ['r1', 'r2']);
  });
});

test('automatic export refreshes within its configured bounded interval', async () => {
  await withTempDir(async (root) => {
    const storage = new RunAnalyticsStorage({
      dataOutcomesRootPath: root,
      workspaceId: 'bounded-auto-export',
      now: () => new Date(),
      serializeSessions: () => ({}),
      autoExportIntervalMs: 20,
    });
    await storage.start();
    const recordedAt = new Date().toISOString();
    storage.schedulePersist(undefined, outcome('bounded', recordedAt));
    await storage.flush();

    const autoExportPath = path.join(storage.getStorageDir(), 'run-analytics.json');
    await waitFor(async () => {
      const payload = JSON.parse(await fs.readFile(autoExportPath, 'utf8')) as { outcomes: OutcomeHistoryLogEntry[] };
      return payload.outcomes.some((entry) => entry.runId === 'bounded');
    }, 2000);
    await storage.dispose();
  });
});

test('aggregate refresh reads completed history once while active ticks use live in-memory state', async () => {
  await withTempDir(async (storageDir) => {
    let persistedQueries = 0;
    let openRunReads = 0;
    let rate = 3;
    const statsService = {
      getStorageDir: () => storageDir,
      queryPersistedRunAnalytics: async () => {
        persistedQueries += 1;
        return { completedRuns: [], openRuns: [], outcomes: [], agentReviews: [] };
      },
      getOpenRuns: () => {
        openRunReads += 1;
        return [];
      },
    };
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/active'], openTabPaths: ['/active'] },
      }) as never,
      statsService: statsService as never,
      tokenRateService: {
        getRates: () => ({
          '/active': { state: 'generating', rate, updatedAt: Date.now() },
        }),
      } as never,
      getAgentDir: () => null,
      fetchWarmBashStats: async () => EMPTY_WARM_BASH_STATS,
      fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
      onChanged: () => undefined,
    });

    await (service as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(service.getAggregateStats().liveTokensPerSecond, 3);
    rate = 7;
    await (service as unknown as { recompute(): Promise<void> }).recompute();

    assert.equal(persistedQueries, 1, 'unchanged active tick must not flush/re-read full history');
    assert.equal(openRunReads, 2, 'open runs remain live on every active recompute');
    assert.equal(service.getAggregateStats().liveTokensPerSecond, 7);
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
      scored: false,
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
        return { completedRuns: [], openRuns: [], outcomes: [], agentReviews: [] };
      },
      getOpenRuns: () => [openRun],
    };
    const service = new AggregateStatsService({
      getArchState: () => ({
        sessions: { runningSessionPaths: ['/live'], openTabPaths: ['/live'] },
      }) as never,
      statsService: statsService as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchWarmBashStats: async () => EMPTY_WARM_BASH_STATS,
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
          return { completedRuns: [], openRuns: [], outcomes: [], agentReviews: [] };
        },
        getOpenRuns: () => [],
      } as never,
      tokenRateService: { getRates: () => ({}) } as never,
      getAgentDir: () => null,
      fetchWarmBashStats: async () => EMPTY_WARM_BASH_STATS,
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
    }, 500);

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

    const retryDelays = delays.slice(1);
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
      pruneByteThreshold: 1,
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
