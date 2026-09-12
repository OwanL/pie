import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
} from '../../../src/host/run-analytics';
import { StatsService } from '../../../src/host/stats-service';
import { workspaceHash } from '../../../src/host/stats-service/helpers';
import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import type { StatsStartupStageMetric } from '../../../src/host/stats-service/service';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-startup-background-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A completed legacy run snapshot that survives coerceRunSnapshot and carries
 *  token usage so the historical migration emits one conversation-residual row
 *  (`legacy-run:<runId>:conversation-residual`) per run. */
function legacyCompletedRun(runId: string, usage: { inputTokens: number; outputTokens: number }) {
  return {
    sessionPath: `/workspace/${runId}.jsonl`,
    runId,
    taskGroupId: `${runId}-task`,
    status: 'closed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    finalizedAt: '2026-01-01T00:10:00.000Z',
    mixedModelConfig: false,
    mixedTreatmentConfig: false,
    treatmentChangeKinds: [],
    experimentAssignment: null,
    analyticsFactors: null,
    functionalSettings: null,
    sendCount: 1,
    assistantTurnCount: 1,
    assistantTurnDurationMs: 1_000,
    interruptedCount: 0,
    messageEditCount: 0,
    truncatedAfterCount: 0,
    backendErrorCodes: [],
    contextTokens: null,
    contextLimit: null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
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
  };
}

async function seedLegacyRunSnapshots(storageDir: string, runs: ReturnType<typeof legacyCompletedRun>[]) {
  await fs.mkdir(storageDir, { recursive: true });
  const lines = runs.map((run) => JSON.stringify({
    schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
    kind: 'run_snapshot',
    recordedAt: '2026-01-01T00:10:00.000Z',
    run,
  }));
  await fs.writeFile(path.join(storageDir, 'run-snapshots.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function optionsFor(
  analyticsRoot: string,
  tempDir: string,
  state: ArchState,
  counters: { renders: number },
) {
  return {
    dataOutcomesRootPath: analyticsRoot,
    legacyUsageDataRootPath: tempDir,
    workspaceId: 'workspace-startup-background',
    getArchState: () => state,
    now: () => new Date(Date.parse('2026-01-01T00:10:00.000Z')),
    scheduleRender: () => { counters.renders += 1; },
  };
}

async function pumpMacrotasks(ticks = 25): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function activityJournalRecord(index: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    intervalId: `activity:compaction-cancel:${index}`,
    sessionId: null,
    sessionPath: '/workspace/compaction-cancel.jsonl',
    parentRunId: 'run-compaction-cancel',
    parentOperationId: null,
    invocationId: `invocation-${index}`,
    toolId: null,
    kind: 'provider',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    outcome: 'succeeded',
  };
}

function compactionTemp(name: string): boolean {
  return name.startsWith('activity-intervals') && name.endsWith('.tmp');
}

function stage(metrics: readonly StatsStartupStageMetric[], name: string): StatsStartupStageMetric {
  const found = metrics.find((metric) => metric.stage === name);
  assert.ok(found, `startup stage metrics must include "${name}"`);
  return found;
}

test('start() completes and renders before deferred healing or historical migration begins', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-startup-background'));
    const runA = legacyCompletedRun('legacy-run-a', { inputTokens: 100, outputTokens: 10 });
    const runB = legacyCompletedRun('legacy-run-b', { inputTokens: 200, outputTokens: 20 });
    await seedLegacyRunSnapshots(storageDir, [runA, runB]);

    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), counters));

    await stats.start();

    // The startup promise resolved with the first render already scheduled,
    // while healing/migration are still parked at their event-loop defer.
    assert.ok(counters.renders >= 1, 'first render must be scheduled before migration work');
    assert.equal(stats.getBillableInvocationRecords().length, 0,
      'no ledger row may exist before the deferred background pass starts');
    assert.equal(stats.getActivityIntervals().length, 0,
      'healing must not have run before startup completed');

    const metricsSoFar = stats.getStartupStageMetrics();
    assert.deepEqual(metricsSoFar.map((metric) => metric.stage), [
      'storage.start',
      'persisted-query',
      'accounting.initialize',
      'timeline-restore',
    ]);
    assert.equal(stage(metricsSoFar, 'persisted-query').counts.completedRuns, 2);
    assert.equal(stage(metricsSoFar, 'persisted-query').counts.openRuns, 0);
    assert.ok(stage(metricsSoFar, 'timeline-restore').durationMs >= 0);

    // start() re-entry while background work is pending is an immediate no-op.
    await stats.start();
    assert.equal(stats.getBillableInvocationRecords().length, 0);

    // The deferred pass then heals (empty ledger) and migrates run A.
    const residualA = `legacy-run:${runA.runId}:conversation-residual`;
    let ticks = 0;
    while (!stats.getBillableInvocationRecords().some((record) => record.sourceId === residualA)) {
      if (++ticks > 10_000) {
        throw new Error('deferred historical migration never processed the first legacy run');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Shutdown drains/cancels the remaining catalogue at the run boundary.
    const baselineRenders = counters.renders;
    await stats.shutdown();
    await pumpMacrotasks();

    // The cancelled pass still reports its structured stage metrics.
    const allMetrics = stats.getStartupStageMetrics();
    assert.deepEqual(allMetrics.map((metric) => metric.stage), [
      'storage.start',
      'persisted-query',
      'accounting.initialize',
      'timeline-restore',
      'timeline-healing',
      'historical-migration',
    ]);
    assert.ok(stage(allMetrics, 'historical-migration').counts.attemptedRows >= 1);
    assert.ok(stage(allMetrics, 'historical-migration').counts.newInvocationRows >= 1);

    const residualB = `legacy-run:${runB.runId}:conversation-residual`;
    assert.equal(
      stats.getBillableInvocationRecords().some((record) => record.sourceId === residualB),
      false,
      'shutdown must cancel the remaining migration instead of waiting for the full catalogue',
    );
    assert.equal(counters.renders, baselineRenders, 'no render may be scheduled after shutdown');
  });
});

test('a deferred ledger-heal cannot push new working time after startup restored live state', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-startup-background'));
    // Simulate the crash boundary the heal repairs: a durable ledger row with
    // no correlated activity interval on disk.
    await fs.mkdir(storageDir, { recursive: true });
    const seededRecord = {
      schemaVersion: 1,
      invocationId: 'inv:heal-crash-boundary',
      sourceId: 'assistant:heal-turn',
      sessionId: null,
      sessionPath: '/workspace/heal.jsonl',
      branchId: null,
      parentOperationId: null,
      parentRunId: 'run-heal',
      parentToolId: null,
      kind: 'conversation',
      provider: 'seed-provider',
      model: 'seed-model',
      provenance: 'unknown',
      evidenceOrigin: 'live',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      outcome: 'succeeded',
      instrumentationGap: true,
      instrumentationGapReason: 'seeded crash-boundary fixture',
    };
    await fs.writeFile(
      path.join(storageDir, 'billable-invocations.jsonl'),
      `${JSON.stringify(seededRecord)}\n`,
      'utf8',
    );

    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), counters));

    try {
      await stats.start();
    assert.equal(stats.getActivityIntervals().length, 0,
      'startup must resolve before healing projects the ledger into the timeline');
    assert.deepEqual(stats.getWorkingTimeBySession(), {},
      'working-time restoration must not invent state the healed timeline will later own');

    await pumpMacrotasks();
    assert.equal(stats.getActivityIntervals().length, 1,
      'the deferred heal repairs the ledger→timeline crash boundary');
    assert.deepEqual(stats.getWorkingTimeBySession(), {},
      'a late heal must not overwrite or inject working time after startup');
    assert.deepEqual(
      stats.getStartupStageMetrics().map((metric) => metric.stage),
      [
        'storage.start',
        'persisted-query',
        'accounting.initialize',
        'timeline-restore',
        'timeline-healing',
        'historical-migration',
      ],
      );
    } finally {
      await stats.shutdown();
    }
  });
});

test('shutdown drains the tracked background promise and cancels an in-flight heal before migration', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), counters));
    const seams = stats as unknown as {
      accounting: {
        healActivityFromLedger: (options?: {
          shouldContinue?: () => boolean;
        }) => Promise<unknown>;
        migrateHistoricalRunUsage: () => Promise<void>;
      };
    };
    let healStarted = 0;
    let migrationCalls = 0;
    let healSawCancellation: boolean | null = null;
    seams.accounting.healActivityFromLedger = async ({ shouldContinue } = {}) => {
      healStarted += 1;
      // Simulate a long bounded heal: the loop only exits when shutdown
      // flips the cancellation flag, so shutdown() must drain this promise.
      for (let tick = 0; tick < 10_000; tick += 1) {
        if (shouldContinue && !shouldContinue()) {
          healSawCancellation = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return {
        ledgerRowsConsidered: 1,
        healedIntervals: 0,
        activityBatchFlushes: 0,
        durationMs: 0,
        cancelled: healSawCancellation === true,
      };
    };
    seams.accounting.migrateHistoricalRunUsage = async () => { migrationCalls += 1; };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await stats.start();
      let ticks = 0;
      while (healStarted === 0) {
        if (++ticks > 10_000) throw new Error('the deferred heal never started');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      await stats.shutdown();
      await pumpMacrotasks();

      assert.equal(healSawCancellation, true,
        'shutdown cancellation must reach the in-flight heal via the tracked background promise');
      assert.equal(migrationCalls, 0, 'no migration may start after shutdown cancelled the heal');
      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

test('shutdown aborts deferred activity compaction and drains its bounded cancellation', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), { renders: 0 }));
    const seams = stats as unknown as {
      accounting: {
        activityTimeline: {
          compact: (options?: { signal?: AbortSignal }) => Promise<boolean>;
        };
      };
    };
    let compactStarted!: (signal: AbortSignal | undefined) => void;
    const compactCall = new Promise<AbortSignal | undefined>((resolve) => {
      compactStarted = resolve;
    });
    let compactFinished = false;
    seams.accounting.activityTimeline.compact = async (options = {}) => {
      compactStarted(options.signal);
      while (!options.signal?.aborted) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      compactFinished = true;
      return false;
    };

    await stats.start();
    const signal = await compactCall;
    assert.ok(signal, 'background compaction must receive an AbortSignal');
    assert.equal(signal.aborted, false);

    await stats.shutdown();

    assert.equal(signal.aborted, true, 'shutdown must abort the background compaction signal');
    assert.equal(compactFinished, true, 'shutdown must drain the cancelled compaction promise');
  });
});

test('shutdown cancels real timeline compaction and removes unpublished temp files', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-startup-background'));
    await fs.mkdir(storageDir, { recursive: true });
    const journalPath = path.join(storageDir, 'activity-intervals.journal.jsonl');
    const journal = Array.from({ length: 12_000 }, (_unused, index) => JSON.stringify(activityJournalRecord(index))).join('\n');
    await fs.writeFile(path.join(storageDir, 'activity-intervals.json'), '[]\n', 'utf8');
    await fs.writeFile(journalPath, `${journal}\n`, 'utf8');

    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), { renders: 0 }));
    const seams = stats as unknown as {
      accounting: {
        activityTimeline: {
          compact: (options?: { signal?: AbortSignal }) => Promise<boolean>;
        };
      };
    };
    const originalCompact = seams.accounting.activityTimeline.compact.bind(seams.accounting.activityTimeline);
    let compactStarted!: () => void;
    const compactCall = new Promise<void>((resolve) => { compactStarted = resolve; });
    let compactResult!: Promise<boolean>;
    let compactSignal: AbortSignal | undefined;
    seams.accounting.activityTimeline.compact = (options = {}) => {
      compactSignal = options.signal;
      compactStarted();
      compactResult = originalCompact(options);
      return compactResult;
    };

    await stats.start();
    await compactCall;
    assert.ok(compactSignal);

    let unpublishedTempSeen = false;
    for (let tick = 0; tick < 10_000; tick += 1) {
      const names = await fs.readdir(storageDir);
      unpublishedTempSeen = names.some(compactionTemp);
      if (unpublishedTempSeen) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(unpublishedTempSeen, true,
      'the fixture must observe compaction after it creates a temp file');

    await stats.shutdown();

    assert.equal(compactSignal.aborted, true, 'shutdown must abort real compaction');
    assert.equal(await compactResult, false, 'aborted compaction must not publish a rewrite');
    assert.deepEqual(
      (await fs.readdir(storageDir)).filter(compactionTemp),
      [],
      'aborted compaction must remove both unpublished temp files',
    );
    assert.equal(await fs.access(journalPath).then(() => true, () => false), true,
      'aborted compaction leaves the source journal available for a later retry');
  });
});

test('background migration failures are caught and never reject the resolved start() promise', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, createInitialArchState(), counters));
    const seams = stats as unknown as {
      accounting: { migrateHistoricalRunUsage: () => Promise<never> };
    };
    seams.accounting.migrateHistoricalRunUsage = async () => {
      throw new Error('controlled migration failure');
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await stats.start();
      await pumpMacrotasks(50);

      assert.ok(counters.renders >= 1, 'startup itself still completes and renders');
      assert.deepEqual(unhandledRejections, [],
        'the background migration failure must be caught, not left unhandled');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      await stats.shutdown();
    }
  });
});
