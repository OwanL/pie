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

interface ActivityObservationOptions {
  generationId?: string;
  sourceKey: string;
  spanId: string;
  rootSessionId?: string;
  kind?: string;
  coverage?: 'observed' | 'estimated' | 'unknown';
  durationMs?: number | null;
}

function activityObservation(options: ActivityObservationOptions): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-act',
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: 'activitySpan',
    entityKey: options.spanId,
    observationKind: 'observation',
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-a',
      rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: {
      spanId: options.spanId,
      kind: options.kind ?? 'tool',
      startedAtMs: null,
      endedAtMs: null,
      durationMs: options.durationMs ?? null,
      clockDomain: 'wall-clock-utc',
      coverage: options.coverage ?? 'unknown',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function facetObservation(
  rootSessionId: string,
  scopedToolCallId: string,
  extraFields: Record<string, unknown> = {},
): AnalyticsObservation {
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-act',
    producerKind: 'test',
    sourceKey: `tool-facet:${scopedToolCallId}`,
    entityKind: 'toolFacet',
    entityKey: `${scopedToolCallId}:file-activity`,
    observationKind: 'observation',
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-a',
      rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: {
      toolCallId: scopedToolCallId,
      facetId: `${scopedToolCallId}:file-activity`,
      ...extraFields,
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function assertSnapshotMetadata(result: AnalyticsQuerySnapshotMetadata): void {
  assert.equal(result.databaseSchemaVersion, 13);
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
    writer.prepareProviderDailyProjection('UTC', 1_750_000_000_000, 1_750_000_200_000);
    writer.submitDetail(detailCapture({
      generationId: 'generation-1',
      payloadId: 'payload-large',
      rootSessionId: 'root-a',
      value: 'x'.repeat(300_000),
    }));
  } finally {
    writer.close();
  }

  let aggregatePreparationCalls = 0;
  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 20_000,
    revisionPollIntervalMs: 50,
    beforeProviderAggregateRead: async (request) => {
      aggregatePreparationCalls += 1;
      assert.equal(request.timeZone, 'UTC');
    },
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
  assert.equal(query.databaseSchemaVersion, 13);
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

  // Root execution counts are a separate maintained projection and remain
  // known zero when this fixture contains provider settlements only.
  const executionSummary = await readModel.readExecutionSummary();
  assert.equal(executionSummary.executionCount, 0);
  assert.equal(executionSummary.settledCount, 0);
  assert.equal(executionSummary.lifecycleCoverage, 'known');
  assert.equal(executionSummary.deliveryCoverage, 'complete');

  // Accounting and bounded provider/model/date groups share one recorder
  // snapshot and revision. The week end also proves the date bounds are not
  // silently widened to the current time.
  const aggregate = await readModel.readProviderAggregateSummary({
    todayStartMs: 1_750_000_000_000,
    todayEndMs: 1_750_000_200_000,
    weekStartMs: 1_750_000_000_000,
    weekEndMs: 1_750_000_060_000,
    timeZone: 'UTC',
  });
  assert.equal(aggregatePreparationCalls, 1, 'aggregate reads invoke the writer-owned preparation seam before forking the reader');
  assert.equal(String(aggregate.accounting.revision), String(aggregate.revision));
  assert.equal(aggregate.executionSummary.executionCount, 0);
  assert.equal(aggregate.executionSummary.lifecycleCoverage, 'known');
  assert.equal(aggregate.executionSummary.deliveryCoverage, 'complete');
  assert.ok(BigInt(aggregate.snapshotWatermark) >= 4n);
  assert.deepEqual(aggregate.truncation, { rowLimit: false, byteLimit: false, cellLimit: false });
  assert.equal(aggregate.groups.length, 2);
  const anthropic = aggregate.groups.find((row) => row.provider === 'anthropic');
  assert.equal(anthropic?.today_cost, 0.05);
  assert.equal(anthropic?.week_cost, 0.05);

  const boundedAggregate = await readModel.readProviderAggregateSummary({
    todayStartMs: 1_750_000_000_000,
    todayEndMs: 1_750_000_200_000,
    weekStartMs: 1_750_000_000_000,
    weekEndMs: 1_750_000_200_000,
    timeZone: 'UTC',
    maxGroups: 1,
  });
  assert.equal(boundedAggregate.groups.length, 1);
  assert.equal(boundedAggregate.truncation.rowLimit, true);
  assert.throws(() => readModel.readProviderAggregateSummary({
    todayStartMs: 2,
    todayEndMs: 1,
    weekStartMs: 1,
    weekEndMs: 2,
  }), /date bounds/u);

  // Historical dimensions are durable membership, not synthesized aggregates.
  const dimensions = await readModel.readHistoricalDimensions();
  assertSnapshotMetadata(dimensions);
  assert.deepEqual(dimensions.scope, { kind: 'global' });
  assert.equal(String(dimensions.revision), String(dimensions.projectionRevision));
  assert.ok((dimensions.providers as Array<{ provider?: string }>).some((row) => row.provider === 'anthropic'));
  assert.equal(dimensions.maxRowsPerDimension, 200);
  assert.equal(typeof dimensions.truncation.rowLimit, 'boolean');
  const dimensionLimitedReader = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, maxRows: 1 });
  const limitedDimensions = await dimensionLimitedReader.readHistoricalDimensions();
  assert.equal(limitedDimensions.maxRowsPerDimension, 1, 'dimension helper honors configured row limits');
  assert.equal(limitedDimensions.providers.length, 1);
  assert.equal(limitedDimensions.truncation.rowLimit, true);

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

test('canonical read model serves activity and tool-facet projections through the helper', async () => {
  const root = tempRoot();
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const writer = new SqliteAnalyticsRecorder(databasePath);
  try {
    writer.submitBatch([
      activityObservation({
        generationId: 'generation-act',
        sourceKey: 'span-a1',
        spanId: 'span-a1',
        rootSessionId: 'root-a',
        kind: 'tool',
        coverage: 'observed',
        durationMs: 1_000,
      }),
      activityObservation({
        generationId: 'generation-act',
        sourceKey: 'span-a2',
        spanId: 'span-a2',
        rootSessionId: 'root-a',
        kind: 'agent',
        coverage: 'estimated',
        durationMs: 500,
      }),
      activityObservation({
        generationId: 'generation-act',
        sourceKey: 'span-a3',
        spanId: 'span-a3',
        rootSessionId: 'root-a',
        kind: 'agent',
        coverage: 'unknown',
        durationMs: null,
      }),
      activityObservation({
        generationId: 'generation-act',
        sourceKey: 'span-b1',
        spanId: 'span-b1',
        rootSessionId: 'root-b',
        kind: 'tool',
        coverage: 'observed',
        durationMs: 250,
      }),
      facetObservation('root-a', 'tool-call-1', {
        commands: ['edit src/a.ts'],
        observedPaths: ['src/a.ts'],
        attemptedAddedLines: 5,
        attemptedRemovedLines: 2,
        verification: 'unverified',
      }),
      facetObservation('root-a', 'tool-call-2', {
        verification: 'not_applicable',
      }),
      facetObservation('root-b', 'tool-call-3', {
        attemptedAddedLines: 1,
        verification: 'unverified',
      }),
    ]);
  } finally {
    writer.close();
  }

  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 20_000,
  });

  // Schema discovery includes the versioned facet view over the projection.
  const schema = await readModel.describeSchema();
  assert.equal(schema.projectionVersion, 4);
  assert.ok(schema.views.includes('analytics_tool_facet_v1'));

  // Global activity totals: additive measured work (1_750 ms over 4 spans),
  // known/unknown measured counts isolated, no wall union.
  const activity = await readModel.readActivityProjection();
  assertSnapshotMetadata(activity);
  assert.equal(activity.scope.kind, 'global');
  assert.deepEqual(activity.totals, {
    spanCount: 4,
    observedCount: 2,
    estimatedCount: 1,
    unknownCount: 1,
    measuredKnownCount: 3,
    measuredUnknownCount: 1,
    measuredTotalMs: 1_750,
  });
  assert.deepEqual(activity.kinds.map((row) => [row.activityKind, row.spanCount]), [
    ['agent', 2],
    ['tool', 2],
  ]);
  assert.equal(activity.truncated, false);

  // Session scope reads only that root's contribution.
  const rootAActivity = await readModel.readActivityProjection({ rootSessionId: 'root-a' });
  assert.deepEqual(rootAActivity.scope, { kind: 'session', rootSessionId: 'root-a' });
  assert.equal(rootAActivity.totals.spanCount, 3);
  assert.equal(rootAActivity.totals.measuredTotalMs, 1_500);

  // All-unknown kind rows keep isolated unknown counts and zero measured work;
  // an unobserved session stays zero totals with an empty kind set, not error.
  const emptySession = await readModel.readActivityProjection({ rootSessionId: 'root-never-seen' });
  assert.deepEqual(emptySession.totals, {
    spanCount: 0,
    observedCount: 0,
    estimatedCount: 0,
    unknownCount: 0,
    measuredKnownCount: 0,
    measuredUnknownCount: 0,
    measuredTotalMs: 0,
  });
  assert.deepEqual(emptySession.kinds, []);
  assert.equal(emptySession.truncated, false);
  const kindCapped = await readModel.readActivityProjection({ maxKinds: 1 });
  assert.equal(kindCapped.truncated, true);
  assert.equal(kindCapped.kinds.length, 1);
  assert.throws(() => readModel.readActivityProjection({ rootSessionId: 'a\0b' }));
  assert.throws(() => readModel.readActivityProjection({ rootSessionId: '' }));
  assert.throws(() => readModel.readActivityProjection({ maxKinds: 0 }));

  // Tool facets carry explicit attempted/unverified proxies; absence of line
  // evidence stays null, never an invented empty change.
  const facets = await readModel.readToolFacetProjection();
  assertSnapshotMetadata(facets);
  assert.equal(facets.scope.kind, 'global');
  assert.equal(facets.facets.length, 3);
  const verifiedProxy = facets.facets.find((row) => row.toolCallId === 'tool-call-1');
  assert.equal(verifiedProxy?.verification, 'unverified');
  assert.equal(verifiedProxy?.attemptedAddedLines, 5);
  assert.equal(verifiedProxy?.attemptedRemovedLines, 2);
  assert.deepEqual(verifiedProxy?.commands, ['edit src/a.ts']);
  const noLineEvidence = facets.facets.find((row) => row.toolCallId === 'tool-call-2');
  assert.equal(noLineEvidence?.attemptedAddedLines, null);
  assert.equal(noLineEvidence?.attemptedRemovedLines, null);
  assert.equal(noLineEvidence?.verification, 'not_applicable');
  const scopedFacets = await readModel.readToolFacetProjection({ rootSessionId: 'root-b' });
  assert.deepEqual(scopedFacets.scope, { kind: 'session', rootSessionId: 'root-b' });
  assert.deepEqual(scopedFacets.facets.map((row) => row.toolCallId), ['tool-call-3']);
  const limitedFacets = await readModel.readToolFacetProjection({ limit: 1 });
  assert.equal(limitedFacets.truncated, true);
  assert.equal(limitedFacets.facets.length, 1);
  assert.throws(() => readModel.readToolFacetProjection({ rootSessionId: 'a\0b' }));
  assert.throws(() => readModel.readToolFacetProjection({ limit: -1 }));

  // After close-time deletion the retained rows and their global/session
  // contributions are removed and the revision moves; unknown sessions are
  // unaffected.
  const revisionBefore = BigInt(facets.projectionRevision);
  const closer = new SqliteAnalyticsRecorder(databasePath);
  try {
    closer.deleteSession('root-a', 'delete-act-1', 1_750_000_500_000);
  } finally {
    closer.close();
  }
  const afterDeletion = await readModel.readActivityProjection();
  assert.ok(BigInt(afterDeletion.projectionRevision) > revisionBefore);
  assert.deepEqual(afterDeletion.totals, {
    spanCount: 1,
    observedCount: 1,
    estimatedCount: 0,
    unknownCount: 0,
    measuredKnownCount: 1,
    measuredUnknownCount: 0,
    measuredTotalMs: 250,
  });
  const deletedScope = await readModel.readActivityProjection({ rootSessionId: 'root-a' });
  assert.equal(deletedScope.totals.spanCount, 0);
  assert.deepEqual(deletedScope.kinds, []);
  const deletedFacets = await readModel.readToolFacetProjection({ rootSessionId: 'root-a' });
  assert.deepEqual(deletedFacets.facets, []);
  const survivingFacets = await readModel.readToolFacetProjection();
  assert.deepEqual(survivingFacets.facets.map((row) => row.toolCallId), ['tool-call-3']);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    readModel.readActivityProjection({}, aborted.signal),
    /cancelled|aborted/u,
  );
  await assert.rejects(
    readModel.readToolFacetProjection({}, aborted.signal),
    /cancelled|aborted/u,
  );

  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
