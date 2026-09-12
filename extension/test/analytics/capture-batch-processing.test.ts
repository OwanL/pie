import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { processObservationBatch } from '../../src/analytics/capture-batch-processing.js';
import {
  isSqliteLockContention,
  type SqliteLockRetryBudget,
} from '../../src/analytics/sqlite-lock-retry.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { timeout?: number }) => {
    exec(sql: string): void;
    close(): void;
  };
};

function observation(
  sourceKey: string,
  sourceSequence: number,
  rootSessionId: string,
): AnalyticsObservation {
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'partial-proof-generation',
    producerKind: 'test',
    stableOriginId: 'partial-proof-origin',
    sourceSequence,
    sourceKey,
    entityKind: 'execution',
    entityKey: sourceKey,
    observationKind: 'end',
    observedAtMs: 1_780_000_000_000 + sourceSequence,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'partial-proof-workspace',
      rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'partial-proof-build', processGeneration: 'partial-proof-process' },
    fields: { outcome: 'original' },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function reconciliationSummary(recorder: SqliteAnalyticsRecorder, observations: readonly AnalyticsObservation[]) {
  const [entry] = recorder.readProducerAcknowledgements(observations);
  assert.ok(entry, 'the proof observations must have one producer reconciliation row');
  return {
    contiguousWatermark: String(entry.contiguousWatermark),
    highestObservedSequence: String(entry.highestObservedSequence),
    visibleGaps: entry.visibleGaps.map((gap) => ({ from: String(gap.from), to: String(gap.to) })),
  };
}

test('real SQLite subject-group partial commit is reconciled by exact batch replay', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-capture-batch-sqlite-proof-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  const blocker = new DatabaseSync(databasePath, { timeout: 100 });
  const subjectA = observation('partial-proof-a', 1, 'partial-proof-root-a');
  const subjectB = observation('partial-proof-b', 2, 'partial-proof-root-b');
  const captures = [
    { subject: 'session:partial-proof-root-a', value: subjectA },
    { subject: 'session:partial-proof-root-b', value: subjectB },
  ] as const;
  let lockAcquired = false;
  let blockerReleased = false;
  const wrappedRecorder = {
    submitBatch(batch: readonly AnalyticsObservation[]) {
      if (!lockAcquired && batch.some((entry) => entry.captureSubject.kind === 'session'
        && entry.captureSubject.rootSessionId === 'partial-proof-root-b')) {
        blocker.exec('BEGIN IMMEDIATE');
        lockAcquired = true;
      }
      recorder.submitBatch(batch);
    },
    submit(entry: AnalyticsObservation) {
      recorder.submit(entry);
    },
  };
  // The real native recorder timeout is intentionally retained. A short outer
  // deadline makes the first lock boundary fail after that native wait while
  // keeping the focused proof finite; the existing worker test covers retry
  // inside the normal eight-second budget.
  const shortBudget: SqliteLockRetryBudget = { deadlineMs: performance.now() + 250 };
  try {
    await assert.rejects(
      processObservationBatch(captures, wrappedRecorder, shortBudget),
      (error: unknown) => isSqliteLockContention(error),
      'subject B must report the real SQLite lock after subject A commits',
    );
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-b'), 0);
    assert.deepEqual(reconciliationSummary(recorder, [subjectA, subjectB]), {
      contiguousWatermark: '1',
      highestObservedSequence: '1',
      // B never committed, so the recorder must not fabricate a receipt or
      // claim knowledge of an absent sequence.
      visibleGaps: [],
    });

    blocker.exec('ROLLBACK');
    blocker.close();
    blockerReleased = true;
    const replayBudget: SqliteLockRetryBudget = { deadlineMs: performance.now() + 2_000 };
    assert.deepEqual(await processObservationBatch(captures, recorder, replayBudget), []);
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-b'), 1);
    assert.deepEqual(recorder.getStats(), {
      accepted: 2,
      duplicates: 1,
      detailsAccepted: 0,
      detailDuplicates: 0,
      rejectedAfterDelete: 0,
    });
    assert.deepEqual(reconciliationSummary(recorder, [subjectA, subjectB]), {
      contiguousWatermark: '2',
      highestObservedSequence: '2',
      visibleGaps: [],
    });

    await processObservationBatch(captures, recorder, { deadlineMs: performance.now() + 2_000 });
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('execution', 'partial-proof-root-b'), 1);
    assert.equal(recorder.getStats().accepted, 2);
    assert.equal(recorder.getStats().duplicates, 3);
  } finally {
    if (!blockerReleased) {
      try { blocker.exec('ROLLBACK'); } catch { /* preserve the primary failure */ }
      try { blocker.close(); } catch { /* preserve the primary failure */ }
    }
    recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});
