import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSourceConflictError,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

function providerObservation(options: {
  sourceKey: string;
  invocationId: string;
  reportedCostUsd: number;
  inputTokens: number;
  rootSessionId?: string;
  captureSubject?: AnalyticsObservation['captureSubject'];
}): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'statement-reuse-root';
  const captureSubject = options.captureSubject ?? { kind: 'session' as const, rootSessionId };
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'statement-reuse-generation',
    producerKind: 'statement-reuse-test',
    stableOriginId: 'statement-reuse-origin',
    sourceKey: options.sourceKey,
    entityKind: 'providerCall' as const,
    entityKey: options.invocationId,
    observationKind: 'providerSettlement' as const,
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'statement-reuse-workspace',
      ...(captureSubject.kind === 'session' ? { rootSessionId } : {}),
      invocationId: options.invocationId,
    },
    captureSubject,
    producer: { buildId: 'statement-reuse-build', processGeneration: 'statement-reuse-process' },
    fields: {
      invocationId: options.invocationId,
      provider: 'statement-reuse-provider',
      dispatchedModel: 'statement-reuse-model',
      reportedCostUsd: options.reportedCostUsd,
      inputTokens: options.inputTokens,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: true,
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function detailCapture(options: {
  payloadId?: string;
  rootSessionId?: string;
  value?: unknown;
  captureSubject?: AnalyticsDetailCapture['captureSubject'];
} = {}): AnalyticsDetailCapture {
  const rootSessionId = options.rootSessionId ?? 'statement-reuse-root';
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'statement-reuse-generation',
    payloadId: options.payloadId ?? 'statement-reuse-detail',
    sourceKey: options.payloadId ?? 'statement-reuse-detail',
    observedAtMs: 1_750_000_000_001,
    captureSubject: options.captureSubject ?? { kind: 'session', rootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(options.value ?? { sequence: ['fact-a', 'detail', 'fact-b'], value: 42 }),
    metadata: {},
  };
}

test('reuses one writable connection safely after a rolled-back batch', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-statement-reuse-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  const durableB = providerObservation({
    sourceKey: 'durable-b', invocationId: 'invocation-b', reportedCostUsd: 2, inputTokens: 20,
  });
  const conflictingB = providerObservation({
    sourceKey: 'conflicting-b', invocationId: 'invocation-b', reportedCostUsd: 3, inputTokens: 30,
  });
  const freshA = providerObservation({
    sourceKey: 'fresh-a', invocationId: 'invocation-a', reportedCostUsd: 1, inputTokens: 10,
  });

  try {
    recorder.submit(durableB);
    const before = recorder.readProviderAccountingSummary();
    assert.equal(recorder.countObservations(), 1);
    assert.equal(before.invocationCount, 1);
    assert.equal(before.inputTokens.knownTotal, 20);
    assert.equal(recorder.getProjectionRevision(), 1);

    assert.throws(
      () => recorder.submitBatch([freshA, conflictingB]),
      AnalyticsSourceConflictError,
    );

    // The valid first item and the conflicting second item must both be
    // absent after the transaction rollback.  Projection and accounting state
    // must remain exactly at the pre-batch snapshot.
    assert.equal(recorder.countObservations(), 1);
    assert.deepEqual(recorder.readProviderSettlements().settlements.map((row) => row.invocationId), [
      'invocation-b',
    ]);
    const afterRollback = recorder.readProviderAccountingSummary();
    assert.equal(afterRollback.invocationCount, before.invocationCount);
    assert.equal(afterRollback.inputTokens.knownTotal, before.inputTokens.knownTotal);
    assert.equal(afterRollback.effectiveCostUsd.value, before.effectiveCostUsd.value);
    assert.equal(recorder.getProjectionRevision(), 1);
    assert.deepEqual(recorder.getStats(), {
      accepted: 1,
      duplicates: 0,
      detailsAccepted: 0,
      detailDuplicates: 0,
      rejectedAfterDelete: 0,
    });

    // The same connection must still accept a valid write after rollback;
    // this catches stale bindings or statement state retained across BEGIN /
    // ROLLBACK.
    assert.doesNotThrow(() => recorder.submit(freshA));
    assert.equal(recorder.countObservations(), 2);
    assert.deepEqual(recorder.readProviderSettlements().settlements.map((row) => row.invocationId).sort(), [
      'invocation-a', 'invocation-b',
    ]);
    const afterReuse = recorder.readProviderAccountingSummary();
    assert.equal(afterReuse.invocationCount, 2);
    assert.equal(afterReuse.inputTokens.knownTotal, 30);
    assert.equal(afterReuse.effectiveCostUsd.value, 3);
    assert.equal(recorder.getProjectionRevision(), 2);
  } finally {
    assert.doesNotThrow(() => recorder.close());
    assert.doesNotThrow(() => recorder.close());
    assert.throws(() => recorder.submit(freshA), /closed/);
    rmSync(root, { recursive: true, force: true });
  }
});

test('reuses the generation insert path across fact, detail, and fact writes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-statement-reuse-mixed-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    const factA = providerObservation({
      sourceKey: 'mixed-fact-a', invocationId: 'mixed-invocation-a', reportedCostUsd: 1, inputTokens: 10,
    });
    const factB = providerObservation({
      sourceKey: 'mixed-fact-b', invocationId: 'mixed-invocation-b', reportedCostUsd: 2, inputTokens: 20,
    });
    recorder.submit(factA);
    recorder.submitDetail(detailCapture());
    recorder.submit(factB);

    assert.equal(recorder.countObservations(), 2);
    assert.equal(recorder.countDetails(), 1);
    assert.deepEqual(recorder.reconstructDetail('statement-reuse-detail'), {
      sequence: ['fact-a', 'detail', 'fact-b'],
      value: 42,
    });
    assert.deepEqual(recorder.getStats(), {
      accepted: 2,
      duplicates: 0,
      detailsAccepted: 1,
      detailDuplicates: 0,
      rejectedAfterDelete: 0,
    });
    const accounting = recorder.readDeliveryAccounting();
    assert.equal(accounting.observations.accepted, 2);
    assert.equal(accounting.details.accepted, 1);
    assert.equal(recorder.readProviderAccountingSummary().invocationCount, 2);
    assert.equal(recorder.readProviderAccountingSummary().inputTokens.knownTotal, 30);
  } finally {
    assert.doesNotThrow(() => recorder.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test('reuses the connection after ordinary private deletion', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-statement-reuse-delete-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    recorder.submit(providerObservation({
      sourceKey: 'private-fact-a', invocationId: 'private-invocation-a',
      reportedCostUsd: 1, inputTokens: 10, rootSessionId: 'private-root-a',
    }));
    recorder.submitDetail(detailCapture({
      payloadId: 'private-detail-a', rootSessionId: 'private-root-a', value: { private: true },
    }));
    assert.equal(recorder.countObservations('private-root-a'), 1);
    assert.equal(recorder.countDetails('private-root-a'), 1);

    recorder.deleteSession('private-root-a', 'private-close-a', 1_800);
    assert.equal(recorder.countObservations('private-root-a'), 0);
    assert.equal(recorder.countDetails('private-root-a'), 0);
    assert.throws(() => recorder.reconstructDetail('private-detail-a'), /unavailable/);

    recorder.submit(providerObservation({
      sourceKey: 'retained-fact-b', invocationId: 'retained-invocation-b',
      reportedCostUsd: 2, inputTokens: 20, rootSessionId: 'retained-root-b',
    }));
    recorder.submitDetail(detailCapture({
      payloadId: 'retained-detail-b', rootSessionId: 'retained-root-b', value: { retained: true },
    }));
    assert.equal(recorder.countObservations('retained-root-b'), 1);
    assert.equal(recorder.countDetails('retained-root-b'), 1);
    assert.deepEqual(recorder.reconstructDetail('retained-detail-b'), { retained: true });
    assert.equal(recorder.readProviderAccountingSummary('retained-root-b').inputTokens.knownTotal, 20);
  } finally {
    assert.doesNotThrow(() => recorder.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test('reuses the connection after a late pending-create bind into a deleted root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-statement-reuse-late-bind-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    recorder.deleteSession('late-private-root', 'late-private-close', 1_900);
    const pending = { kind: 'pendingCreate' as const, operationId: 'late-private-operation' };
    recorder.submit(providerObservation({
      sourceKey: 'late-pending-fact', invocationId: 'late-pending-invocation',
      reportedCostUsd: 3, inputTokens: 30, captureSubject: pending,
    }));
    recorder.submitDetail(detailCapture({
      payloadId: 'late-pending-detail', captureSubject: pending, value: { pending: true },
    }));
    const receipt = recorder.bindPendingCreate(
      'late-private-operation',
      'late-private-root',
      'late-private-bind',
      1_901,
    );
    assert.equal(receipt.deletedSubject, true);
    assert.equal(recorder.countObservations(), 0);
    assert.equal(recorder.countDetails(), 0);
    assert.throws(() => recorder.reconstructDetail('late-pending-detail'), /unavailable/);

    recorder.submit(providerObservation({
      sourceKey: 'post-late-bind-fact', invocationId: 'post-late-bind-invocation',
      reportedCostUsd: 4, inputTokens: 40, rootSessionId: 'post-late-bind-root',
    }));
    recorder.submitDetail(detailCapture({
      payloadId: 'post-late-bind-detail', rootSessionId: 'post-late-bind-root', value: { retained: true },
    }));
    assert.equal(recorder.countObservations('late-private-root'), 0);
    assert.equal(recorder.countObservations('post-late-bind-root'), 1);
    assert.equal(recorder.countDetails('post-late-bind-root'), 1);
    assert.deepEqual(recorder.reconstructDetail('post-late-bind-detail'), { retained: true });
    assert.equal(recorder.readProviderAccountingSummary('post-late-bind-root').inputTokens.knownTotal, 40);
  } finally {
    assert.doesNotThrow(() => recorder.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test('reuses the cached accounting-projection path across repeated settlements and a rollback', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-statement-reuse-accounting-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  const conflictingFirst = providerObservation({
    sourceKey: 'projection-first', invocationId: 'projection-invocation-first',
    reportedCostUsd: 1, inputTokens: 10,
  });
  const conflictingSecond = providerObservation({
    sourceKey: 'projection-conflict', invocationId: 'projection-invocation-first',
    reportedCostUsd: 9, inputTokens: 90,
  });

  try {
    // Repeated settlements for the same subject reuse the accounting-projection
    // lookup/upsert pair; totals must accumulate across every call.
    for (let index = 0; index < 5; index++) {
      recorder.submit(providerObservation({
        sourceKey: `projection-retained-${index}`,
        invocationId: `projection-invocation-${index}`,
        reportedCostUsd: 2,
        inputTokens: 20,
      }));
    }
    const global = recorder.readProviderAccountingSummary();
    assert.equal(global.invocationCount, 5);
    assert.equal(global.inputTokens.knownTotal, 100);
    assert.equal(global.effectiveCostUsd.value, 10);
    assert.equal(recorder.getProjectionRevision(), 5);

    assert.throws(
      () => recorder.submitBatch([conflictingFirst, conflictingSecond]),
      AnalyticsSourceConflictError,
    );

    // The rolled-back batch must leave the accumulated projection untouched,
    // and the same cached statements must keep working afterwards.
    const afterRollback = recorder.readProviderAccountingSummary();
    assert.equal(afterRollback.invocationCount, 5);
    assert.equal(afterRollback.inputTokens.knownTotal, 100);
    assert.equal(afterRollback.effectiveCostUsd.value, 10);
    assert.equal(recorder.getProjectionRevision(), 5);

    recorder.submit(providerObservation({
      sourceKey: 'projection-after-rollback', invocationId: 'projection-invocation-after',
      reportedCostUsd: 3, inputTokens: 30,
    }));
    const final = recorder.readProviderAccountingSummary();
    assert.equal(final.invocationCount, 6);
    assert.equal(final.inputTokens.knownTotal, 130);
    assert.equal(final.effectiveCostUsd.value, 13);
    assert.equal(recorder.getProjectionRevision(), 6);
  } finally {
    assert.doesNotThrow(() => recorder.close());
    rmSync(root, { recursive: true, force: true });
  }
});
