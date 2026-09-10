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
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';

function observation(options: {
  sourceKey: string;
  rootSessionId?: string;
  invocationId?: string;
  observedAtMs?: number | string | bigint;
  fields?: Record<string, unknown>;
}): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-1',
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: options.invocationId ? 'providerCall' : 'execution',
    entityKey: options.invocationId ?? options.sourceKey,
    observationKind: options.invocationId ? 'providerSettlement' : 'end',
    observedAtMs: options.observedAtMs ?? 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'workspace-a',
      rootSessionId,
      invocationId: options.invocationId,
    },
    captureSubject: { kind: 'session' as const, rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: options.fields ?? { outcome: 'success' },
  };
  return {
    ...base,
    idempotencyKey: deriveAnalyticsIdempotencyKey(base),
  };
}

function detail(options: {
  payloadId: string;
  rootSessionId?: string;
  value: unknown;
}): AnalyticsDetailCapture {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-1',
    payloadId: options.payloadId,
    sourceKey: options.payloadId,
    observedAtMs: 1_750_000_000_000,
    captureSubject: { kind: 'session', rootSessionId },
    mediaType: 'application/x-pie-subagent-result',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(options.value),
    metadata: {},
  };
}

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-recorder-'));
  return { root, databasePath: path.join(root, 'analytics.sqlite') };
}

test('SQLite recorder accepts exact redelivery and exposes conflicting source reuse', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const first = observation({ sourceKey: 'entry-1' });
    recorder.submit(first);
    recorder.submit(first);
    assert.equal(recorder.countObservations(), 1);
    assert.deepEqual(recorder.getStats(), {
      accepted: 1,
      duplicates: 1,
      detailsAccepted: 0,
      detailDuplicates: 0,
      rejectedAfterDelete: 0,
    });

    assert.throws(
      () => recorder.submit({ ...first, fields: { outcome: 'different' } }),
      AnalyticsSourceConflictError,
    );
    assert.equal(recorder.countObservations(), 1);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('linked detail storage reconstructs exact rich results and deduplicates nested bodies', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const sharedBody = 'large nested body '.repeat(16_384);
    const child = { childId: 'child-1', messages: [{ role: 'assistant', content: sharedBody }] };
    const parent = { childId: 'parent-1', messages: [{ role: 'toolResult', details: { results: [child] } }] };
    const childCapture = detail({ payloadId: 'child-payload', value: child });
    const parentCapture = detail({ payloadId: 'parent-payload', value: parent });
    const otherOwnerCapture = detail({ payloadId: 'other-owner-payload', rootSessionId: 'root-b', value: child });

    recorder.submitDetail(childCapture);
    recorder.submitDetail(parentCapture);
    recorder.submitDetail(otherOwnerCapture);
    recorder.submitDetail(childCapture);

    assert.deepEqual(recorder.reconstructDetail('child-payload'), child);
    assert.deepEqual(recorder.reconstructDetail('parent-payload'), parent);
    const storage = recorder.detailStorageStats();
    assert.equal(storage.payloadCount, 3);
    assert.ok(storage.storedContentBytes < storage.logicalBytes);
    assert.equal(recorder.getStats().detailDuplicates, 1);

    assert.throws(
      () => recorder.submitDetail({ ...childCapture, bytes: serialize({ changed: true }) }),
      AnalyticsSourceConflictError,
    );

    recorder.deleteSession('root-a', 'delete-root-a', 200);
    assert.deepEqual(recorder.reconstructDetail('other-owner-payload'), child);
    assert.ok(recorder.detailStorageStats().contentCount > 0, 'shared content remains for its other owner');
    recorder.deleteSession('root-b', 'delete-root-b', 201);
    assert.equal(recorder.detailStorageStats().contentCount, 0, 'last-owner delete removes orphaned content');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('delete intent atomically removes facts and details and fences late settlement across restart', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({ sourceKey: 'private-1', rootSessionId: 'root-private' }));
    recorder.submitDetail(detail({ payloadId: 'private-detail', rootSessionId: 'root-private', value: { secret: 'x' } }));
    recorder.submit(observation({ sourceKey: 'retained-1', rootSessionId: 'root-retained' }));

    const deleted = recorder.deleteSession('root-private', 'close-private', 104);
    assert.equal(deleted.deletedObservationCount, 1);
    assert.equal(deleted.deletedPayloadCount, 1);
    assert.equal(recorder.countObservations('root-private'), 0);
    assert.equal(recorder.countDetails('root-private'), 0);
    assert.equal(recorder.countObservations('root-retained'), 1);

    const duplicate = recorder.deleteSession('root-private', 'a-different-owner-retry', 999);
    assert.deepEqual(duplicate, { ...deleted, duplicate: true });
    assert.throws(
      () => recorder.submit(observation({ sourceKey: 'late-private', rootSessionId: 'root-private' })),
      /capture subject is deleted/,
    );
    assert.throws(
      () => recorder.submitDetail(detail({ payloadId: 'late-detail', rootSessionId: 'root-private', value: { late: true } })),
      /capture subject is deleted/,
    );

    recorder.close();
    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.equal(recorder.countObservations('root-private'), 0);
    assert.deepEqual(recorder.deleteSession('root-private', 'restart-retry', 1_000), {
      ...deleted,
      duplicate: true,
    });
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('capture and query remain available while privacy is on, then explicit close deletes', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const lifecycle = new SessionLifecycleStore(path.join(temp.root, 'lifecycle.sqlite'));
  try {
    lifecycle.setPrivacyMode('root-private-open', 'on', 100);
    recorder.submit(observation({ sourceKey: 'private-open-fact', rootSessionId: 'root-private-open' }));
    recorder.submitDetail(detail({
      payloadId: 'private-open-detail',
      rootSessionId: 'root-private-open',
      value: { visibleWhileOpen: true },
    }));
    assert.equal(recorder.countObservations('root-private-open'), 1);
    assert.deepEqual(recorder.reconstructDetail('private-open-detail'), { visibleWhileOpen: true });

    const decision = lifecycle.resolveClose('root-private-open', 'private-explicit-close', 200);
    assert.equal(decision.disposition, 'delete');
    recorder.deleteSession('root-private-open', decision.firstCloseOperationId, decision.closedAtMs);
    lifecycle.markDeleted('root-private-open', 201);
    assert.equal(recorder.countObservations('root-private-open'), 0);
    assert.equal(recorder.countDetails('root-private-open'), 0);
  } finally {
    lifecycle.close();
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('provider projection preserves missingness and signed-64-bit token strings across restart', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submitBatch([
      observation({
        sourceKey: 'provider-a-settle',
        invocationId: 'invocation-a',
        observedAtMs: '9223372036854775807',
        fields: {
          invocationId: 'invocation-a',
          inputTokens: '9007199254740993',
          outputTokens: 40,
          cacheReadTokens: null,
          reportedCostUsd: 0,
        },
      }),
      observation({
        sourceKey: 'provider-b-settle',
        invocationId: 'invocation-b',
        fields: {
          invocationId: 'invocation-b',
          inputTokens: 20,
        },
      }),
    ]);
    recorder.checkpoint();
    recorder.close();

    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.deepEqual(recorder.projectProviderUsage(), [
      {
        invocationId: 'invocation-a',
        usage: {
          inputTokens: '9007199254740993',
          outputTokens: 40,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerTotalTokens: null,
        },
        reportedCostUsd: 0,
      },
      {
        invocationId: 'invocation-b',
        usage: {
          inputTokens: 20,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerTotalTokens: null,
        },
        reportedCostUsd: null,
      },
    ]);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});
