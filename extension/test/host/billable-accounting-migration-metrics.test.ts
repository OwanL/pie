import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createEmptyFileMutationRollup,
  createEmptyToolUsageRollup,
  createEmptyVerificationRollup,
  type AuxiliaryLlmUsageSample,
  type RunSnapshot,
} from '../../src/host/run-analytics';
import {
  BillableAccounting,
  type HistoricalMigrationMetrics,
} from '../../src/host/billable-accounting/service';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-migration-metrics-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A completed legacy run snapshot whose only migration source is the given
 *  auxiliary samples: run-level token totals stay zero so no residual rows
 *  are generated and the row count is exactly the sample count. */
function legacyRunWithAuxiliary(runId: string, auxiliary: AuxiliaryLlmUsageSample[]): RunSnapshot {
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
    tokenReportedTurnCount: 0,
    lastTurnUsage: null,
    turnThroughputSamples: [],
    auxiliaryLlmUsage: auxiliary,
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

function auxiliarySamples(count: number): AuxiliaryLlmUsageSample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'subagent' as const,
    sourceId: `aux:${index}`,
    occurredAt: '2026-01-01T00:05:00.000Z',
    modelId: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }));
}

function accountingFor(dir: string): BillableAccounting {
  return new BillableAccounting({
    getStorageDir: () => dir,
    now: () => new Date(),
    scheduleRender: () => undefined,
    dispatchArchEvent: () => undefined,
    getAgentDir: () => null,
    isPrivateSession: () => false,
    sessionIdentity: () => ({ sessionId: null }),
    currentRunId: () => null,
    activeOperationId: () => null,
    markDerivedExportDirty: () => undefined,
  });
}

test('historical migration reports structured metrics and yields in bounded activity batches', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    const runs = [legacyRunWithAuxiliary('legacy-aux-run', auxiliarySamples(300))];

    const metrics = await accounting.migrateHistoricalRunUsage(runs);

    assert.equal(metrics.runsConsidered, 1);
    assert.equal(metrics.attemptedRows, 300, 'every auxiliary sample is an attempted migration row');
    assert.equal(metrics.newInvocationRows, 300);
    assert.equal(metrics.cancelled, false);
    assert.equal(metrics.activityBatchFlushes, 3,
      '300 rows at a 128-row activity batch must flush twice plus its final remainder');
    assert.ok(metrics.durationMs >= 0);
    assert.equal(accounting.exportRecords().length, 300);
    assert.equal(accounting.activityTimeline.projectAll().length, 300,
      'the deferred activity batch is fully flushed when the pass finishes');
  });
});

test('historical migration is idempotent: a replay attempts every row but creates none', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    const runs = [legacyRunWithAuxiliary('legacy-idempotent-run', auxiliarySamples(300))];
    await accounting.migrateHistoricalRunUsage(runs);

    const replay = await accounting.migrateHistoricalRunUsage(runs);

    assert.equal(replay.attemptedRows, 300, 'already-migrated rows are still attempted');
    assert.equal(replay.newInvocationRows, 0, 'no duplicate rows may be created on replay');
    assert.equal(replay.cancelled, false);
    assert.equal(accounting.exportRecords().length, 300, 'ledger row count is unchanged');
  });
});

test('an already-migrated giant single run cancels between attempted rows, not only between runs', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    const runs = [legacyRunWithAuxiliary('legacy-giant-run', auxiliarySamples(512))];
    await accounting.migrateHistoricalRunUsage(runs);

    // Permit the first attempts, then cancel: on a run whose rows all already
    // exist, no activity batch ever fills, so cancellation must be observed
    // per attempted row for the drain to stay bounded.
    let shouldContinueCalls = 0;
    const metrics = await accounting.migrateHistoricalRunUsage(runs, {
      shouldContinue: () => {
        shouldContinueCalls += 1;
        return shouldContinueCalls <= 200;
      },
    });

    assert.equal(metrics.cancelled, true);
    assert.ok(metrics.attemptedRows < 512 && metrics.attemptedRows > 0,
      'cancellation must take effect within the already-migrated run');
    assert.equal(accounting.exportRecords().length, 512, 'no rows are added or removed by the cancelled pass');
  });
});

test('a pre-cancelled migration pass performs no work and reports skipped metrics', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    const runs = [legacyRunWithAuxiliary('legacy-skipped-run', auxiliarySamples(4))];

    const metrics: HistoricalMigrationMetrics = await accounting.migrateHistoricalRunUsage(runs, {
      shouldContinue: () => false,
    });

    assert.deepEqual(metrics, {
      runsConsidered: 0,
      attemptedRows: 0,
      newInvocationRows: 0,
      activityBatchFlushes: 0,
      durationMs: metrics.durationMs,
      cancelled: true,
    });
    assert.equal(accounting.exportRecords().length, 0);
    assert.equal(accounting.activityTimeline.projectAll().length, 0);
  });
});

test('private migration rows are attempted but never counted as new durable ledger rows', async () => {
  await withTempDir(async (dir) => {
    const accounting = new BillableAccounting({
      getStorageDir: () => dir,
      now: () => new Date(),
      scheduleRender: () => undefined,
      dispatchArchEvent: () => undefined,
      getAgentDir: () => null,
      isPrivateSession: (sessionPath) => sessionPath.startsWith('/workspace/private'),
      sessionIdentity: () => ({ sessionId: null }),
      currentRunId: () => null,
      activeOperationId: () => null,
      markDerivedExportDirty: () => undefined,
    });
    await accounting.initialize();
    const run = {
      ...legacyRunWithAuxiliary('legacy-private-run', auxiliarySamples(4)),
      sessionPath: '/workspace/private/legacy-private-run.jsonl',
    };

    const metrics = await accounting.migrateHistoricalRunUsage([run]);

    assert.equal(metrics.attemptedRows, 4, 'every sample is still attempted');
    assert.equal(metrics.newInvocationRows, 0,
      'private (process-local) rows must not count as new durable ledger rows');
    assert.equal(accounting.exportRecords().length, 0, 'no ordinary ledger row was appended');
    assert.equal(accounting.activityTimeline.projectAll().length, 0,
      'private migration rows never produce activity intervals');
  });
});

test('queued-for-retry migration rows are attempted but never counted as new durable ledger rows', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    const ledger = accounting.invocationLedger;
    const append = ledger.append.bind(ledger);
    ledger.append = (...args: unknown[]) => {
      throw new Error('injected ledger append failure');
    };
    try {
      const metrics = await accounting.migrateHistoricalRunUsage([
        legacyRunWithAuxiliary('legacy-queued-run', auxiliarySamples(4)),
      ]);

      assert.equal(metrics.attemptedRows, 4, 'every sample is attempted');
      assert.equal(metrics.newInvocationRows, 0,
        'rows queued for retry must not count as new durable ledger rows');
      assert.equal(accounting.exportRecords().length, 0);
    } finally {
      ledger.append = append;
    }
  });
});