import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../src/analytics/query-entry.js';
import { sessionUsageSnapshotFromCanonicalSettlements } from '../../src/analytics/canonical-usage.js';
import {
  SqliteAnalyticsRecorder,
  type AnalyticsQuerySnapshotMetadata,
} from '../../src/analytics/sqlite-recorder.js';

const workerScript = fileURLToPath(new URL('../../src/analytics/query-worker-entry.ts', import.meta.url));
const execArgv = [
  `--import=${new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

function settlementObservation(options: {
  generationId: string;
  sourceKey: string;
  invocationId: string;
  rootSessionId: string;
  provider: string;
  model: string;
  purpose: string;
  outcome: string;
  settledAtMs: number;
  reportedCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number | null;
}): AnalyticsObservation {
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId,
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: 'providerCall',
    entityKey: options.invocationId,
    observationKind: 'providerSettlement',
    observedAtMs: options.settledAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-a',
      rootSessionId: options.rootSessionId,
      invocationId: options.invocationId,
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: {
      invocationId: options.invocationId,
      provider: options.provider,
      dispatchedModel: options.model,
      reportedModel: options.model,
      purpose: options.purpose,
      outcome: options.outcome,
      settledAtMs: options.settledAtMs,
      inputTokens: options.inputTokens ?? 100,
      outputTokens: options.outputTokens ?? 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      providerTotalTokens: (options.inputTokens ?? 100) + (options.outputTokens ?? 50) + 15,
      ...(options.reportedCostUsd !== undefined ? { reportedCostUsd: options.reportedCostUsd } : {}),
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function detailCapture(options: { generationId: string; payloadId: string; rootSessionId: string; value: string }): AnalyticsDetailCapture {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId,
    payloadId: options.payloadId,
    sourceKey: options.payloadId,
    observedAtMs: 1_750_000_000_100,
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    mediaType: 'application/x-pie-tool-observation',
    encoding: 'node-v8',
    complete: true,
    bytes: serialize(options.value),
    metadata: { captureStage: 'terminal' },
  };
}

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'pie-analytics-read-model-'));
}

function assertSnapshotMetadata(result: AnalyticsQuerySnapshotMetadata): void {
  assert.equal(result.databaseSchemaVersion, 8);
  assert.equal(typeof result.projectionRevision === 'number' || typeof result.projectionRevision === 'string', true);
  assert.equal(typeof result.snapshotWatermark === 'number' || typeof result.snapshotWatermark === 'string', true);
  assert.equal(result.generationIds.length > 0, true);
  assert.equal(typeof result.generationIdsTruncated, 'boolean');
  assert.equal(result.pendingDetailCoverage.deliveryHistoryCoverage, 'complete');
  assert.equal(
    typeof result.pendingDetailCoverage.completeDetailWatermark === 'number'
      || typeof result.pendingDetailCoverage.completeDetailWatermark === 'string',
    true,
  );
  assert.deepEqual(result.truncation, { rowLimit: false, byteLimit: false, cellLimit: false });
}

test('canonical read model serves schema, bounded queries, settlements, accounting, dimensions, storage, and detail ranges', async () => {
  const root = tempRoot();
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const writer = new SqliteAnalyticsRecorder(databasePath);
  try {
    writer.submitBatch([
      settlementObservation({
        generationId: 'generation-1',
        sourceKey: 'settlement-1',
        invocationId: 'invocation-1',
        rootSessionId: 'root-a',
        provider: 'anthropic',
        model: 'claude-x',
        purpose: 'conversation',
        outcome: 'succeeded',
        settledAtMs: 1_750_000_000_000,
        reportedCostUsd: 0.04,
      }),
      settlementObservation({
        generationId: 'generation-1',
        sourceKey: 'settlement-2',
        invocationId: 'invocation-2',
        rootSessionId: 'root-b',
        provider: 'openai',
        model: 'gpt-y',
        purpose: 'subagent',
        outcome: 'succeeded',
        settledAtMs: 1_750_000_060_000,
        reportedCostUsd: 0.03,
      }),
      settlementObservation({
        generationId: 'generation-2',
        sourceKey: 'settlement-3',
        invocationId: 'invocation-3',
        rootSessionId: 'root-b',
        provider: 'openai',
        model: 'gpt-y',
        purpose: 'retry',
        outcome: 'failed',
        settledAtMs: 1_750_000_120_000,
      }),
    ]);
    writer.submitDetail(detailCapture({
      generationId: 'generation-1',
      payloadId: 'payload-large',
      rootSessionId: 'root-a',
      value: 'x'.repeat(300_000),
    }));
  } finally {
    writer.close();
  }

  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 20_000,
    revisionPollIntervalMs: 50,
  });

  // Schema: canonical views and logical commands resolve through the helper.
  const schema = await readModel.describeSchema();
  assertSnapshotMetadata(schema);
  assert.deepEqual(schema.logicalCommands, ['schema', 'query', 'detail', 'storage']);
  assert.ok(schema.views.includes('analytics_provider_usage_v1'));

  // Revision refresh: the cheap read plus a bounded wait on an unchanged
  // revision resolves without waiting a full poll, and a committed change
  // resolves the wait promptly.
  const revisionBefore = await readModel.readRevision();
  assert.equal(typeof revisionBefore, 'string');
  assert.equal(BigInt(revisionBefore) >= 3n, true);
  const startedAt = Date.now();
  assert.equal(await readModel.waitForRevision(revisionBefore, { maxWaitMs: 200 }), revisionBefore);
  assert.ok(Date.now() - startedAt < 5_000);

  const lateWriter = new SqliteAnalyticsRecorder(databasePath);
  try {
    lateWriter.submit(settlementObservation({
      generationId: 'generation-1',
      sourceKey: 'settlement-4',
      invocationId: 'invocation-4',
      rootSessionId: 'root-a',
      provider: 'anthropic',
      model: 'claude-x',
      purpose: 'session_title',
      outcome: 'succeeded',
      settledAtMs: 1_750_000_180_000,
      reportedCostUsd: 0.01,
    }));
  } finally {
    lateWriter.close();
  }
  const revisionAfter = await readModel.waitForRevision(revisionBefore, { maxWaitMs: 5_000 });
  assert.notEqual(BigInt(revisionAfter), BigInt(revisionBefore));

  // Bounded read-only SELECT with explicit truncation metadata.
  const query = await readModel.executeQuery({
    sql: 'SELECT invocation_id, provider, effective_cost_usd FROM analytics_provider_usage_v1 ORDER BY invocation_id',
  });
  assert.equal(query.databaseSchemaVersion, 8);
  assertSnapshotMetadata(query);
  assert.equal(query.returnedRows, 4);
  assert.deepEqual(query.truncation, { rowLimit: false, byteLimit: false, cellLimit: false });
  assert.ok(BigInt(query.snapshotWatermark) >= 4n);
  const bounded = await readModel.executeQuery({
    sql: 'SELECT invocation_id FROM analytics_provider_usage_v1 ORDER BY invocation_id',
    maxRows: 2,
  });
  assert.equal(bounded.returnedRows, 2);
  assert.equal(bounded.truncation.rowLimit, true);
  assert.deepEqual(bounded.rows.map((row) => row.invocation_id), ['invocation-1', 'invocation-2']);

  // Settlement read model with root-session scope and snapshot mapping.
  const all = await readModel.readProviderSettlements();
  assert.equal(all.settlements.length, 4);
  const scoped = await readModel.readProviderSettlements({ rootSessionId: 'root-b' });
  assert.deepEqual(scoped.settlements.map((settlement) => settlement.invocationId), ['invocation-2', 'invocation-3']);
  const snapshot = sessionUsageSnapshotFromCanonicalSettlements(scoped.settlements);
  assert.equal(snapshot.authority, 'canonical');
  const retry = snapshot.samples.find((sample) => sample.sourceId === 'invocation-3');
  assert.equal(retry?.kind, 'retry');
  assert.equal(retry?.provenance, 'unpriced');
  assert.equal(retry?.tokenChannelPresence?.output, true);

  // Engine-neutral scoped accounting summary straight from the durable store.
  const globalAccounting = await readModel.readProviderAccountingSummary();
  assert.equal(globalAccounting.invocationCount, 4);
  assert.equal(globalAccounting.effectiveCostUsd.knownTotal, 0.08);
  const sessionAccounting = await readModel.readProviderAccountingSummary('root-a');
  assert.equal(sessionAccounting.invocationCount, 2);

  // Historical dimensions are durable membership, not synthesized aggregates.
  const dimensions = await readModel.readHistoricalDimensions();
  assert.ok((dimensions.providers as Array<{ provider?: string }>).some((row) => row.provider === 'anthropic'));

  // Storage and delivery accounting expose pending-detail coverage.
  const storage = await readModel.readStorageSummary();
  assertSnapshotMetadata(storage);
  assert.ok(BigInt(storage.storage.databaseBytes) > 0n);
  assert.equal(storage.storage.payloadCount, 1);
  assert.equal(storage.delivery.details.accepted, 1);

  // Large detail payloads page within the 64 KiB default bound.
  const firstPage = await readModel.readDetail({ payloadId: 'payload-large' });
  assertSnapshotMetadata(firstPage);
  assert.equal(firstPage.available, true);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.bytes.byteLength, 64 * 1024);
  assert.ok(firstPage.nextOffset !== null);
  const secondPage = await readModel.readDetail({ payloadId: 'payload-large', offset: firstPage.nextOffset! });
  assert.equal(
    secondPage.truncated,
    BigInt(firstPage.nextOffset!) + BigInt(secondPage.bytes.byteLength) < BigInt(firstPage.totalLength),
  );
  assert.ok(secondPage.bytes.byteLength > 0);

  // Validation and explicit failure semantics.
  assert.throws(() => readModel.executeQuery({ sql: 'SELECT \0' }));
  assert.throws(() => readModel.readProviderSettlements({ rootSessionId: 'a\0b' }));
  assert.throws(() => readModel.readProviderAccountingSummary(''));
  assert.throws(() => readModel.readProviderAccountingSummary('   '));
  assert.throws(() => readModel.readProviderAccountingSummary('a\0b'));
  assert.throws(() => readModel.readDetail({ payloadId: '' }));
  await assert.rejects(
    Reflect.apply(readModel.readScopedProviderSettlements, readModel, [{
      kind: 'unexpected',
      generationId: 'generation-1',
      copySessionId: 'root-a',
    }]),
    /Unsupported provider settlement scope kind/u,
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    readModel.executeQuery({ sql: 'SELECT 1' }, aborted.signal),
    /cancelled|aborted/u,
  );
  await assert.rejects(
    readModel.readRevision(aborted.signal),
  );
});

test('canonical read model fails explicitly without a database and never falls back', async () => {
  const root = tempRoot();
  const readModel = new CanonicalAnalyticsReadModel({
    databasePath: path.join(root, 'missing', 'analytics.sqlite'),
    workerScript,
    execArgv,
    timeoutMs: 20_000,
  });
  await assert.rejects(
    readModel.describeSchema(),
    /unable to open database file|SQLITE_CANTOPEN|failed|exited/u,
  );
  rmSync(root, { recursive: true, force: true });
});
