import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BillableAccounting,
  type ActivityHealMetrics,
} from '../../src/host/billable-accounting/service';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-activity-heal-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function accountingFor(dir: string): BillableAccounting {
  return new BillableAccounting({
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
}

function ledgerRecord(invocationIndex: number, sessionPath = '/workspace/heal.jsonl'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    invocationId: `inv:heal-${invocationIndex}`,
    sourceId: `assistant:heal-turn-${invocationIndex}`,
    sessionId: null,
    sessionPath,
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
}

async function seedLedger(dir: string, records: readonly Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'billable-invocations.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

test('the async heal re-derives timeline intervals in bounded batches with structured metrics', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, Array.from({ length: 300 }, (_unused, index) => ledgerRecord(index)));

    const heal: ActivityHealMetrics = await accounting.healActivityFromLedger();

    assert.equal(heal.ledgerRowsConsidered, 300);
    assert.equal(heal.healedIntervals, 300, 'every missing interval is actually appended');
    assert.equal(heal.activityBatchFlushes, 3, '300 rows at a 128-row batch size cost exactly 3 bounded batches');
    assert.equal(heal.cancelled, false);
    assert.ok(heal.durationMs >= 0);
    assert.equal(accounting.activityTimeline.projectAll().length, 300);
  });
});

test('the heal is idempotent: replaying a healed ledger appends no new intervals', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, Array.from({ length: 300 }, (_unused, index) => ledgerRecord(index)));
    await accounting.healActivityFromLedger();

    const replay: ActivityHealMetrics = await accounting.healActivityFromLedger();

    assert.equal(replay.healedIntervals, 0, 'already-healed intervals are not counted as new');
    assert.equal(replay.cancelled, false);
    assert.equal(accounting.activityTimeline.projectAll().length, 300,
      'the timeline row count is unchanged by the replay');
  });
});

test('heal cancellation takes effect between bounded intervals and leaves the timeline untouched', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, Array.from({ length: 300 }, (_unused, index) => ledgerRecord(index)));

    let shouldContinueCalls = 0;
    const heal = await accounting.healActivityFromLedger({
      shouldContinue: () => {
        shouldContinueCalls += 1;
        return shouldContinueCalls <= 2;
      },
    });

    assert.equal(heal.cancelled, true);
    assert.equal(heal.healedIntervals, 128,
      'only the first bounded batch (initial check + first batch) may write before cancellation');
    assert.equal(accounting.activityTimeline.projectAll().length, 128);
  });
});

test('a pre-cancelled heal performs no work and reports skipped metrics', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, [ledgerRecord(0)]);

    const heal = await accounting.healActivityFromLedger({ shouldContinue: () => false });

    assert.deepEqual(heal, {
      ledgerRowsConsidered: 0,
      healedIntervals: 0,
      activityBatchFlushes: 0,
      durationMs: heal.durationMs,
      cancelled: true,
    });
    assert.equal(accounting.activityTimeline.projectAll().length, 0);
  });
});

test('private ledger rows are never healed into the timeline', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, [
      ledgerRecord(0),
      ledgerRecord(1, '/workspace/private/heal.jsonl'),
      ledgerRecord(2),
    ]);

    const heal = await accounting.healActivityFromLedger();

    assert.equal(heal.ledgerRowsConsidered, 2, 'private rows are excluded from the heal sources');
    assert.equal(heal.healedIntervals, 2);
    assert.equal(accounting.activityTimeline.projectAll().length, 2);
    assert.equal(
      accounting.activityTimeline.projectAll().some((record) => record.sessionPath.startsWith('/workspace/private')),
      false,
    );
  });
});

test('a heal write failure degrades to a stale timeline without rejecting startup work', async () => {
  await withTempDir(async (dir) => {
    const accounting = accountingFor(dir);
    await accounting.initialize();
    await seedLedger(dir, [ledgerRecord(0)]);
    const timeline = accounting.activityTimeline as unknown as {
      recordMany: (...args: unknown[]) => boolean;
    };
    const recordMany = timeline.recordMany.bind(timeline);
    timeline.recordMany = () => {
      throw new Error('injected activity write failure');
    };

    const heal = await accounting.healActivityFromLedger();

    timeline.recordMany = recordMany;
    assert.equal(heal.cancelled, false);
    assert.equal(heal.healedIntervals, 0, 'no interval is counted when the batch write fails');
    assert.equal(accounting.activityTimeline.projectAll().length, 0);
    assert.equal(heal.activityBatchFlushes, 0);
  });
});