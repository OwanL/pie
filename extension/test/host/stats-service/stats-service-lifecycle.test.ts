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

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-stats-lifecycle-'));
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
    workspaceId: 'workspace-migration-lifecycle',
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

test('shutdown during historical migration stops writes and renders at the run boundary and blocks start reactivation', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-migration-lifecycle'));
    const runA = legacyCompletedRun('legacy-run-a', { inputTokens: 100, outputTokens: 10 });
    const runB = legacyCompletedRun('legacy-run-b', { inputTokens: 200, outputTokens: 20 });
    await seedLegacyRunSnapshots(storageDir, [runA, runB]);

    const counters = { renders: 0 };
    const state = createInitialArchState();
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, state, counters));

    // Start without awaiting: the migration processes run A, then yields via
    // setImmediate between runs.
    const startPromise = stats.start();

    // Deterministically wait until run A's migration row exists. At this
    // moment the migration is suspended at its inter-run yield.
    const residualA = `legacy-run:${runA.runId}:conversation-residual`;
    const residualB = `legacy-run:${runB.runId}:conversation-residual`;
    let ticks = 0;
    while (!stats.getBillableInvocationRecords().some((record) => record.sourceId === residualA)) {
      if (++ticks > 10_000) {
        throw new Error('historical migration never processed the first legacy run');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Shutdown synchronously marks the service disposed (cancelling the
    // suspended migration) and drains at the run boundary instead of waiting
    // out the remaining catalogue.
    const baselineRenders = counters.renders;
    await stats.shutdown();
    await startPromise;

    const ledgerPath = path.join(stats.getStorageDir(), 'billable-invocations.jsonl');
    const rowsAfterShutdown = (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n');
    assert.equal(rowsAfterShutdown.length, 1, 'exactly the first legacy run must have migrated');
    const records = stats.getBillableInvocationRecords();
    assert.ok(records.some((record) => record.sourceId === residualA), 'run A migrated before shutdown');
    assert.equal(
      records.some((record) => record.sourceId === residualB),
      false,
      'shutdown must cancel the remaining migration instead of waiting for the full catalogue',
    );

    await pumpMacrotasks();
    assert.equal(counters.renders, baselineRenders, 'no render may be scheduled after shutdown');
    assert.equal(
      (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n').length,
      1,
      'no ledger row may be written after shutdown',
    );

    // A late start() call must not reactivate the disposed service.
    await stats.start();
    await pumpMacrotasks();
    assert.equal(counters.renders, baselineRenders, 'start after shutdown must not render');
    assert.equal(
      stats.getBillableInvocationRecords().some((record) => record.sourceId === residualB),
      false,
      'start after shutdown must not re-run the historical migration',
    );
    assert.equal(
      (await fs.readFile(ledgerPath, 'utf8')).trim().split('\n').length,
      1,
      'start after shutdown must not write ledger rows',
    );
  });
});

test('a rejected persisted query after shutdown skips healing, migration, and render', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const counters = { renders: 0 };
    const stats = new StatsService(optionsFor(
      analyticsRoot,
      tempDir,
      createInitialArchState(),
      counters,
    ));
    const seams = stats as unknown as {
      storage: { queryPersistedRunAnalytics: () => Promise<never> };
      accounting: {
        healActivityFromLedger: () => void;
        migrateHistoricalRunUsage: () => Promise<void>;
      };
    };
    let healCalls = 0;
    let migrationCalls = 0;
    seams.accounting.healActivityFromLedger = () => { healCalls += 1; };
    seams.accounting.migrateHistoricalRunUsage = async () => { migrationCalls += 1; };

    let rejectQuery!: (reason?: unknown) => void;
    let resolveQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { resolveQueryStarted = resolve; });
    seams.storage.queryPersistedRunAnalytics = () => {
      resolveQueryStarted();
      return new Promise<never>((_, reject) => { rejectQuery = reject; });
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    const startPromise = stats.start();
    try {
      await queryStarted;
      await stats.shutdown();
      rejectQuery(new Error('controlled persisted-query failure after shutdown'));
      await startPromise;
      await pumpMacrotasks();

      assert.equal(healCalls, 0, 'shutdown must prevent activity healing after a rejected query');
      assert.equal(migrationCalls, 0, 'shutdown must prevent migration after a rejected query');
      assert.equal(counters.renders, 0, 'shutdown must prevent rendering after a rejected query');
      assert.deepEqual(unhandledRejections, [], 'the rejected query must be handled by start()');
    } finally {
      rejectQuery(new Error('release controlled persisted query'));
      await startPromise.catch(() => undefined);
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

test('start() after shutdown never reactivates storage or migrates', async () => {
  await withTempDir(async (tempDir) => {
    const analyticsRoot = path.join(tempDir, 'data', 'outcomes');
    const storageDir = path.join(analyticsRoot, workspaceHash('workspace-migration-lifecycle'));
    const runA = legacyCompletedRun('legacy-run-a', { inputTokens: 100, outputTokens: 10 });
    await seedLegacyRunSnapshots(storageDir, [runA]);

    const counters = { renders: 0 };
    const state = createInitialArchState();
    const stats = new StatsService(optionsFor(analyticsRoot, tempDir, state, counters));
    await stats.shutdown();
    const baselineRenders = counters.renders;

    await stats.start();
    await pumpMacrotasks();

    assert.equal(counters.renders, baselineRenders, 'start after shutdown must be a no-op');
    await assert.rejects(
      fs.access(path.join(stats.getStorageDir(), 'billable-invocations.jsonl')),
      { code: 'ENOENT' },
      'start after shutdown must not restore/migrate storage',
    );
  });
});
