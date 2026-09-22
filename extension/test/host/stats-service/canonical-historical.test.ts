import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../../shared/analytics/contracts.js';
import {
  CanonicalAnalyticsReadModel,
  canonicalAnalyticsDatabasePath,
} from '../../../src/analytics/query-entry.js';
import { SqliteAnalyticsRecorder } from '../../../src/analytics/sqlite-recorder.js';
import { CanonicalAnalyticsCapture } from '../../../src/analytics/canonical-capture.js';
import { AggregateStatsService } from '../../../src/host/aggregate-stats-service.js';
import { createInitialArchState } from '../../../src/host/core/arch-state.js';
import { StatsService } from '../../../src/host/stats-service/index.js';
import { EMPTY_PROVIDER_GATE_STATS } from '../../../src/shared/protocol/aggregate-stats.js';

const workerScript = fileURLToPath(new URL('../../../src/analytics/query-worker-entry.ts', import.meta.url));
const execArgv = [
  `--import=${new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

/**
 * The recorder API is synchronous, but a fixture should also leave a clean
 * WAL boundary before a separate read-only helper opens the database. The
 * checkpoint is the completion observation; no wall-clock sleep is used.
 */
function closeFixtureWriter(writer: SqliteAnalyticsRecorder): void {
  const checkpoint = writer.truncateWalAndRead();
  assert.equal(Number(checkpoint.busy), 0, 'fixture writer must finish its WAL checkpoint before close');
  writer.close();
}

function settlement(options: {
  invocationId: string;
  rootSessionId: string;
  purpose: string;
  settledAtMs: number;
  inputTokens: number;
  outputTokens?: number;
  reportedCostUsd: number;
  generationId?: string;
  branchId?: string;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-historical',
    producerKind: 'test',
    sourceKey: options.invocationId,
    entityKind: 'providerCall',
    entityKey: options.invocationId,
    observationKind: 'providerSettlement',
    observedAtMs: options.settledAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-historical',
      rootSessionId: options.rootSessionId,
      invocationId: options.invocationId,
      ...(options.branchId ? { branchId: options.branchId } : {}),
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      invocationId: options.invocationId,
      sourceId: options.invocationId,
      provider: 'fixture-provider',
      dispatchedModel: 'fixture/model',
      reportedModel: 'fixture/model',
      purpose: options.purpose,
      outcome: options.purpose === 'retry' ? 'failed' : 'succeeded',
      startedAtMs: options.settledAtMs - 1_000,
      endedAtMs: options.settledAtMs,
      settledAtMs: options.settledAtMs,
      inputTokens: options.inputTokens,
      ...(options.outputTokens === undefined ? {} : { outputTokens: options.outputTokens }),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerTotalTokens: options.inputTokens + (options.outputTokens ?? 0),
      reportedCostUsd: options.reportedCostUsd,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: false,
      coverage: options.outputTokens === undefined ? 'unknown' : 'known',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function executionBeginObservation(rootSessionId: string, executionId: string, startedAtMs: number): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-historical',
    producerKind: 'test',
    sourceKey: `${executionId}:begin`,
    entityKind: 'execution',
    entityKey: executionId,
    observationKind: 'begin',
    observedAtMs: startedAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-historical',
      rootSessionId,
      executionId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: { operationKind: 'agent-run', startedAtMs },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function activityObservation(options: {
  spanId: string;
  rootSessionId: string;
  kind: string;
  coverage: 'observed' | 'estimated' | 'unknown';
  durationMs: number | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-activity-consumer',
    producerKind: 'test',
    sourceKey: `activity:${options.spanId}`,
    entityKind: 'activitySpan',
    entityKey: options.spanId,
    observationKind: 'observation',
    observedAtMs: options.endedAtMs ?? options.startedAtMs ?? 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-activity-consumer',
      rootSessionId: options.rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      spanId: options.spanId,
      kind: options.kind,
      startedAtMs: options.startedAtMs ?? null,
      endedAtMs: options.endedAtMs ?? null,
      durationMs: options.durationMs,
      clockDomain: 'wall-clock-utc',
      coverage: options.coverage,
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function toolFacetObservation(rootSessionId: string, toolCallId: string): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-activity-consumer',
    producerKind: 'test',
    sourceKey: `tool-facet:${toolCallId}`,
    entityKind: 'toolFacet',
    entityKey: `${toolCallId}:file-activity`,
    observationKind: 'observation',
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-activity-consumer',
      rootSessionId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      toolCallId,
      facetId: `${toolCallId}:file-activity`,
      commands: ['apply_patch'],
      cwd: '/workspace',
      observedPaths: ['src/changed.ts'],
      attemptedAddedLines: 4,
      attemptedRemovedLines: 1,
      verification: 'unverified',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function branchObservation(options: {
  branchId: string;
  parentBranchId: string | null;
  rootSessionId: string;
  observedAtMs: number;
  selection?: boolean;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-historical',
    producerKind: 'test',
    sourceKey: `${options.selection ? 'selection' : 'edge'}:${options.branchId}`,
    entityKind: 'branch',
    entityKey: options.branchId,
    observationKind: options.selection ? 'phase' : 'observation',
    observedAtMs: options.observedAtMs,
    scope: {
      workspaceCoverage: 'known',
      workspaceId: 'workspace-historical',
      rootSessionId: options.rootSessionId,
      branchId: options.branchId,
    },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: 'test-build', processGeneration: 'test-process' },
    fields: {
      branchId: options.branchId,
      parentBranchId: options.parentBranchId,
      sourceEntryId: options.branchId,
      ...(options.selection ? { sourceSelectionId: `selection:${options.branchId}` } : {}),
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

test('canonical historical session and aggregate projections survive a new host and revision refresh', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-historical-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const writer = new SqliteAnalyticsRecorder(databasePath);
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  writer.submitBatch([
    executionBeginObservation('root-historical', 'execution-historical', at - 1_000),
    settlement({ invocationId: 'inv-conversation', rootSessionId: 'root-historical', purpose: 'conversation', settledAtMs: at, inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.04 }),
    settlement({ invocationId: 'inv-retry', rootSessionId: 'root-historical', purpose: 'retry', settledAtMs: at + 1_000, inputTokens: 200, reportedCostUsd: 0.01 }),
  ]);
  // The projection is writer-maintained. Prepare the UTC local-day envelope
  // before handing the database to the disposable read helper.
  writer.prepareProviderDailyProjection('UTC', Date.parse('2026-01-02T00:00:00.000Z'), Date.parse('2026-01-16T00:00:00.000Z'));
  closeFixtureWriter(writer);

  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, timeoutMs: 20_000, revisionPollIntervalMs: 25 });
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: '/sessions/historical.jsonl',
    name: 'historical',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 2,
    sessionId: 'root-historical',
  });
  state.sessions.activeSessionPath = '/sessions/historical.jsonl';
  state.sessions.openTabPaths = ['/sessions/historical.jsonl'];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const aggregate = new AggregateStatsService({
    getArchState: () => state,
    statsService: stats,
    tokenRateService: { getRates: () => ({}) } as never,
    getAgentDir: () => null,
    fetchProviderGateStats: async () => EMPTY_PROVIDER_GATE_STATS,
    onChanged: () => undefined,
    now: () => new Date(at + 2_000),
    analyticsTimeZone: 'UTC',
  });
  try {
    await stats.start();
    const usage = stats.getSessionUsage('/sessions/historical.jsonl');
    assert.equal(usage.authority, 'canonical');
    assert.deepEqual(usage.samples.map((sample) => sample.kind), ['conversation', 'retry']);
    assert.equal(usage.samples.find((sample) => sample.kind === 'retry')?.instrumentationGap, true);
    assert.deepEqual(await stats.queryPersistedRunAnalytics(), { completedRuns: [], openRuns: [] });

    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    const first = aggregate.getAggregateStats();
    assert.equal(first.ready, true);
    assert.equal(first.totalCost, 0.05);
    assert.equal(first.totalInputTokens, 300);
    assert.equal(first.totalOutputTokens, 50);
    assert.equal(first.sessionCount, 1);
    assert.equal(first.billableAccounting?.invocationCount, 2);

    const lateWriter = new SqliteAnalyticsRecorder(databasePath);
    lateWriter.submit(settlement({ invocationId: 'inv-late', rootSessionId: 'root-historical', purpose: 'conversation', settledAtMs: at + 1_500, inputTokens: 25, outputTokens: 10, reportedCostUsd: 0.02 }));
    lateWriter.close();
    const revision = await readModel.waitForRevision(await readModel.readRevision(), { maxWaitMs: 2_000 });
    assert.ok(BigInt(revision) > 0n);
    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(aggregate.getAggregateStats().totalCost, 0.07);
    await (stats as unknown as { refreshCanonicalSessionUsage(): Promise<void> }).refreshCanonicalSessionUsage();
    assert.equal(stats.getSessionUsage('/sessions/historical.jsonl').samples.length, 3);

    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-historical', 'private-close-historical', at + 3_000);
    deleteWriter.close();
    // SqliteAnalyticsRecorder.close() is synchronous: deleteSession commits
    // before it returns and Database.close() releases the writer handles.
    // The read helper is separately awaited by waitForRevision and shutdown.
    const deletedRevision = await readModel.waitForRevision(revision, { maxWaitMs: 2_000 });
    assert.ok(BigInt(deletedRevision) > BigInt(revision));
    await (aggregate as unknown as { recompute(): Promise<void> }).recompute();
    assert.equal(aggregate.getAggregateStats().totalCost, 0);
    for (let index = 0; index < 200 && stats.getSessionUsage('/sessions/historical.jsonl').samples.length > 0; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(stats.getSessionUsage('/sessions/historical.jsonl').samples.length, 0);
  } finally {
    aggregate.dispose();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('StatsService hydrates bounded canonical activity and facets, refreshes them, and converges after peer deletion', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-activity-consumer-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const sessionPath = '/sessions/activity.jsonl';
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    activityObservation({
      spanId: 'span-a-1',
      rootSessionId: 'root-activity-a',
      kind: 'tool',
      coverage: 'observed',
      durationMs: 1_200,
      startedAtMs: at,
      endedAtMs: at + 1_200,
    }),
    activityObservation({
      spanId: 'span-b-1',
      rootSessionId: 'root-activity-b',
      kind: 'child',
      coverage: 'estimated',
      durationMs: 300,
      startedAtMs: at + 100,
      endedAtMs: at + 400,
    }),
    activityObservation({
      spanId: 'span-a-unknown',
      rootSessionId: 'root-activity-a',
      kind: 'preflight',
      coverage: 'unknown',
      durationMs: null,
      startedAtMs: at + 4_000,
      endedAtMs: at + 3_000,
    }),
    toolFacetObservation('root-activity-a', 'tool-a-1'),
    toolFacetObservation('root-activity-b', 'tool-b-1'),
    // Replayed terminal evidence is idempotent at the recorder and must not
    // inflate the consumer's facet count.
    toolFacetObservation('root-activity-a', 'tool-a-1'),
  ]);
  closeFixtureWriter(writer);

  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 20_000,
    revisionPollIntervalMs: 25,
  });
  const state = createInitialArchState();
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'activity',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-activity-a',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-activity-consumer',
    workspaceId: 'workspace-activity-consumer',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-activity-consumer',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let index = 0; index < 240; index += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(predicate(), true, 'canonical activity refresh did not converge');
  };
  try {
    await stats.start();
    const global = stats.getCanonicalActivityStats();
    assert.equal(global.activity.authority, 'canonical');
    assert.equal(global.activity.projection?.scope.kind, 'global');
    assert.equal(global.activity.projection?.totals.spanCount, 3);
    assert.equal(global.activity.projection?.totals.observedCount, 1);
    assert.equal(global.activity.projection?.totals.estimatedCount, 1);
    assert.equal(global.activity.projection?.totals.unknownCount, 1);
    assert.equal(global.activity.projection?.totals.measuredUnknownCount, 1);
    assert.equal(global.activity.projection?.totals.measuredTotalMs, 1_500);
    assert.equal(global.toolFacets.authority, 'canonical');
    assert.equal(global.toolFacets.projection?.facets.length, 2);
    assert.deepEqual(
      global.toolFacets.projection?.facets.map((facet) => facet.rootSessionId).sort(),
      ['root-activity-a', 'root-activity-b'],
    );

    const selected = stats.getCanonicalActivityStats(sessionPath);
    assert.equal(selected.activity.authority, 'canonical');
    assert.equal(selected.activity.projection?.scope.kind, 'session');
    assert.equal(selected.activity.projection?.totals.spanCount, 2);
    assert.equal(selected.activity.projection?.totals.unknownCount, 1);
    assert.equal(selected.activity.projection?.totals.measuredUnknownCount, 1);
    assert.equal(selected.activity.projection?.totals.measuredTotalMs, 1_200);
    assert.equal(selected.toolFacets.projection?.facets.length, 1);
    assert.deepEqual(selected.toolFacets.projection?.facets[0]?.observedPaths, ['src/changed.ts']);

    const beforeRefresh = await readModel.readRevision();
    const lateWriter = new SqliteAnalyticsRecorder(databasePath);
    lateWriter.submitBatch([
      activityObservation({
        spanId: 'span-a-2',
        rootSessionId: 'root-activity-a',
        kind: 'tool',
        coverage: 'observed',
        durationMs: 700,
        startedAtMs: at + 2_000,
        endedAtMs: at + 2_700,
      }),
      toolFacetObservation('root-activity-a', 'tool-a-2'),
    ]);
    closeFixtureWriter(lateWriter);
    const refreshedRevision = await readModel.waitForRevision(beforeRefresh, { maxWaitMs: 2_000 });
    assert.ok(BigInt(refreshedRevision) > BigInt(beforeRefresh));
    await waitFor(() => stats.getCanonicalActivityProjection(sessionPath).projection?.totals.spanCount === 3);
    assert.equal(stats.getCanonicalActivityProjection(sessionPath).projection?.totals.measuredTotalMs, 1_900);
    assert.equal(stats.getCanonicalToolFacetProjection(sessionPath).projection?.facets.length, 2);

    const beforeDelete = await readModel.readRevision();
    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-activity-a', 'private-close-activity', at + 3_000);
    closeFixtureWriter(deleteWriter);
    const deletedRevision = await readModel.waitForRevision(beforeDelete, { maxWaitMs: 2_000 });
    assert.ok(BigInt(deletedRevision) > BigInt(beforeDelete));
    await waitFor(() => {
      const deleted = stats.getCanonicalActivityProjection(sessionPath);
      return deleted.authority === 'canonical' && deleted.projection?.totals.spanCount === 0;
    });
    assert.equal(stats.getCanonicalToolFacetProjection(sessionPath).projection?.facets.length, 0);
    // A peer delete is scoped to the selected root session; the global read
    // still retains activity belonging to another root.
    await waitFor(() => {
      const globalAfterDelete = stats.getCanonicalActivityProjection();
      return globalAfterDelete.authority === 'canonical'
        && globalAfterDelete.projection?.totals.spanCount === 1;
    });
    const globalFacetsAfterDelete = stats.getCanonicalToolFacetProjection();
    assert.equal(globalFacetsAfterDelete.projection?.facets.length, 1);
    assert.equal(globalFacetsAfterDelete.projection?.facets[0]?.rootSessionId, 'root-activity-b');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('open private usage remains visible until close and a peer delete cannot resurrect local rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-private-peer-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writerA = new SqliteAnalyticsRecorder(databasePath);
  writerA.submit(settlement({
    invocationId: 'inv-private',
    rootSessionId: 'root-private',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.03,
  }));
  closeFixtureWriter(writerA);

  const stateA = createInitialArchState();
  const sessionPath = '/sessions/private.jsonl';
  stateA.sessions.privacyModeBySession[sessionPath] = true;
  stateA.sessions.sessions.push({
    path: sessionPath,
    name: 'private',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-private',
  });
  stateA.sessions.activeSessionPath = sessionPath;
  stateA.sessions.openTabPaths = [sessionPath];
  const lifecycleEvents: unknown[] = [];
  const readModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    revisionPollIntervalMs: 25,
    onQueryLifecycle: (event) => lifecycleEvents.push(structuredClone(event)),
  });
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const statsA = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => stateA,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    statsA.onAssistantTurnEnded(sessionPath, 'pre-hydration-local', 100, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      reportedCostUsd: 0.07,
    }, 'completed', undefined, { occurredAt: new Date(at + 500).toISOString() });
    assert.equal(statsA.getSessionUsage(sessionPath).authority, 'unknown', 'canonical hydration must fail closed before durable read');
    await statsA.start();
    assert.equal(
      statsA.getSessionUsage(sessionPath).authority,
      'canonical',
      JSON.stringify({ databasePath, lifecycleEvents }),
    );
    assert.equal(statsA.getSessionUsage(sessionPath).samples.length, 1, 'open private usage must remain queryable');

    // Keep a stale process-local observation that would have been merged by
    // the old adapter after the peer deletion.
    statsA.onAssistantTurnEnded(sessionPath, 'stale-local-turn', 100, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      reportedCostUsd: 0.07,
    }, 'completed', undefined, { occurredAt: new Date(at + 1_000).toISOString() });
    assert.equal(statsA.getSessionUsage(sessionPath).samples.length, 1, 'durable cache must remain authoritative');

    const beforeDelete = await readModel.readRevision();
    const writerB = new SqliteAnalyticsRecorder(databasePath);
    writerB.deleteSession('root-private', 'private-close-peer', at + 3_000);
    writerB.close();
    await readModel.waitForRevision(beforeDelete, { maxWaitMs: 2_000 });
    for (let index = 0; index < 160; index += 1) {
      const candidate = statsA.getSessionUsage(sessionPath);
      if (candidate.authority === 'canonical' && candidate.samples.length === 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const afterDelete = statsA.getSessionUsage(sessionPath);
    assert.equal(afterDelete.authority, 'canonical');
    assert.equal(afterDelete.samples.length, 0, 'peer private delete must tombstone local durable usage');
  } finally {
    await statsA.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical startup establishes its revision baseline before hydration', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-startup-revision-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submit(settlement({
    invocationId: 'inv-startup-peer',
    rootSessionId: 'root-startup-peer',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.03,
  }));
  closeFixtureWriter(writer);

  const baseReadModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    revisionPollIntervalMs: 25,
  });
  const readModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  const originalReadRevision = baseReadModel.readRevision.bind(baseReadModel);
  let holdFirstRead = true;
  let signalBaselineStarted: () => void = () => undefined;
  const baselineStarted = new Promise<void>((resolve) => { signalBaselineStarted = resolve; });
  let releaseBaseline: () => void = () => undefined;
  const baselineReleased = new Promise<void>((resolve) => { releaseBaseline = resolve; });
  readModel.readRevision = async (signal?: AbortSignal): Promise<string> => {
    if (holdFirstRead) {
      holdFirstRead = false;
      signalBaselineStarted();
      await baselineReleased;
    }
    return originalReadRevision(signal);
  };

  const state = createInitialArchState();
  const sessionPath = '/sessions/startup-peer.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'startup-peer',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-startup-peer',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    const startup = stats.start();
    await baselineStarted;

    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-startup-peer', 'private-close-startup-peer', at + 3_000);
    deleteWriter.close();
    const deletedRevision = await baseReadModel.readRevision();
    assert.ok(BigInt(deletedRevision) > 0n, 'peer delete must commit before baseline release');

    releaseBaseline();
    await startup;
    const usage = stats.getSessionUsage(sessionPath);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.samples.length, 0, 'startup must not cache rows from before the peer delete');
  } finally {
    releaseBaseline();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical startup remains fail-closed until a failed baseline recovers', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-revision-recovery-'));
  const state = createInitialArchState();
  const sessionPath = '/sessions/revision-recovery.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'revision-recovery',
    cwd: '/sessions',
    modifiedAt: new Date(1_700_000_000_000).toISOString(),
    messageCount: 1,
    sessionId: 'root-revision-recovery',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  let revisionReads = 0;
  let pathReads = 0;
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readRevision: async () => {
      revisionReads += 1;
      if (revisionReads === 1) throw new Error('synthetic unavailable revision');
      return '1';
    },
    readScopedProviderSettlements: async (scope: { kind: 'rootSession'; rootSessionId: string }) => {
      pathReads += 1;
      return {
        revision: '1',
        settlements: [],
        truncated: false,
        scope,
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    assert.equal(pathReads, 0, 'pre-start access must not bypass the revision baseline');
    await stats.start();
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    assert.equal(pathReads, 0, 'failed baseline must suppress lazy hydration');

    const deadline = Date.now() + 4_000;
    while (stats.getSessionUsage(sessionPath).authority !== 'canonical' && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'canonical');
    assert.ok(revisionReads >= 2, 'the refresher must retry after its failed baseline');
    assert.ok(pathReads >= 1, 'recovered baseline must permit bounded hydration');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical refresh rejects a delayed pre-delete response instead of resurrecting rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-refresh-race-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submit(settlement({
    invocationId: 'inv-race',
    rootSessionId: 'root-race',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.03,
  }));
  closeFixtureWriter(writer);
  const state = createInitialArchState();
  const sessionPath = '/sessions/race.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'race',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-race',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const lifecycleEvents: unknown[] = [];
  const baseReadModel = new CanonicalAnalyticsReadModel({
    databasePath,
    workerScript,
    execArgv,
    timeoutMs: 5_000,
    revisionPollIntervalMs: 25,
    onQueryLifecycle: (event) => lifecycleEvents.push(structuredClone(event)),
  });
  const originalRead = baseReadModel.readScopedProviderSettlements.bind(baseReadModel);
  let holdNextRead = false;
  let captureOldRead: () => void = () => undefined;
  let rejectOldRead: (reason?: unknown) => void = () => undefined;
  const oldReadCaptured = new Promise<void>((resolve, reject) => {
    captureOldRead = () => resolve();
    rejectOldRead = reject;
  });
  // Keep a rejection handler attached while the delayed helper is starting;
  // the test later awaits the same promise to preserve the original failure.
  void oldReadCaptured.catch(() => undefined);
  let releaseOldRead: () => void = () => undefined;
  const heldReadReleased = new Promise<void>((resolve) => {
    releaseOldRead = resolve;
  });
  const delayedReadModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  delayedReadModel.readScopedProviderSettlements = async (scope, page, signal) => {
    let result: Awaited<ReturnType<typeof originalRead>>;
    try {
      result = await originalRead(scope, page, signal);
    } catch (error) {
      if (holdNextRead) {
        holdNextRead = false;
        rejectOldRead(error);
      }
      throw error;
    }
    if (!holdNextRead) return result;
    holdNextRead = false;
    captureOldRead();
    await heldReadReleased;
    return result;
  };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: delayedReadModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 1);
    holdNextRead = true;
    const refresh = (stats as unknown as { refreshCanonicalSessionUsage(): Promise<void> }).refreshCanonicalSessionUsage();
    const handshakeTimeout = setTimeout(() => {
      rejectOldRead(new Error(
        `Timed out waiting for delayed canonical read (database=${databasePath}, rootSessionId=root-race, workerLifecycle=${JSON.stringify(lifecycleEvents)}).`,
      ));
    }, 5_000);
    try {
      await oldReadCaptured;
    } catch (error) {
      throw new Error(
        `Delayed canonical read handshake failed (database=${databasePath}, rootSessionId=root-race, workerLifecycle=${JSON.stringify(lifecycleEvents)}): ${String(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(handshakeTimeout);
    }
    const beforeDelete = await baseReadModel.readRevision();
    const deleteWriter = new SqliteAnalyticsRecorder(databasePath);
    deleteWriter.deleteSession('root-race', 'private-close-race', at + 3_000);
    deleteWriter.close();
    const deletedRevision = await baseReadModel.readRevision();
    assert.ok(BigInt(deletedRevision) > BigInt(beforeDelete), 'peer delete must advance the durable revision');
    (stats as unknown as { markCanonicalRevisionDirty(revision: string): void })
      .markCanonicalRevisionDirty(deletedRevision);
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 0);
    releaseOldRead();
    await refresh;
    assert.equal(stats.getSessionUsage(sessionPath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 0);
  } finally {
    // The delayed helper may still be between its capture handshake and the
    // held-read release when an assertion or timeout fails. Resolve this gate
    // before StatsService.shutdown() drains tracked work, so cleanup cannot
    // wait forever on a deliberately paused response.
    releaseOldRead();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical session hydration is root-owned and includes branchless child and auxiliary calls', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-selected-branch-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch([
    branchObservation({ branchId: 'branch-a', parentBranchId: null, rootSessionId: 'root-branch', observedAtMs: at }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 1 }),
    branchObservation({ branchId: 'branch-c', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 2 }),
    branchObservation({ branchId: 'branch-b', parentBranchId: 'branch-a', rootSessionId: 'root-branch', observedAtMs: at + 3, selection: true }),
    settlement({ invocationId: 'inv-branch-a', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 4, inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.01, branchId: 'branch-a' }),
    settlement({ invocationId: 'inv-branch-b', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 5, inputTokens: 20, outputTokens: 5, reportedCostUsd: 0.02, branchId: 'branch-b' }),
    settlement({ invocationId: 'inv-branch-c', rootSessionId: 'root-branch', purpose: 'conversation', settledAtMs: at + 6, inputTokens: 30, outputTokens: 5, reportedCostUsd: 0.03, branchId: 'branch-c' }),
    // These calls intentionally carry no branch ID. Root scope must retain
    // them alongside branch-attributed calls for the session indicator.
    settlement({ invocationId: 'inv-branchless-child', rootSessionId: 'root-branch', purpose: 'subagent', settledAtMs: at + 7, inputTokens: 40, outputTokens: 5, reportedCostUsd: 0.04 }),
    settlement({ invocationId: 'inv-auxiliary', rootSessionId: 'root-branch', purpose: 'history_compaction', settledAtMs: at + 8, inputTokens: 50, outputTokens: 5, reportedCostUsd: 0.05 }),
  ]);
  closeFixtureWriter(writer);
  const state = createInitialArchState();
  const sessionPath = '/sessions/branch.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'branch',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 3,
    sessionId: 'root-branch',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, revisionPollIntervalMs: 25 });
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    stats.onBranchObserved(sessionPath, 'branch-b', 'branch-a', 'branch-b', at + 3);
    await stats.start();
    const usage = stats.getSessionUsage(sessionPath);
    assert.equal(usage.authority, 'canonical');
    assert.equal(usage.branchId, undefined, 'the root projection must not claim selected-branch ownership');
    assert.deepEqual(
      usage.samples.map((sample) => sample.sourceId).sort(),
      ['inv-branch-a', 'inv-branch-b', 'inv-branch-c', 'inv-branchless-child', 'inv-auxiliary'].sort(),
    );
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical usage fails closed when a session path is rebound to a new identity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-identity-guard-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submit(settlement({
    invocationId: 'inv-old-identity',
    rootSessionId: 'root-old-identity',
    purpose: 'conversation',
    settledAtMs: at,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.01,
  }));
  closeFixtureWriter(writer);
  const state = createInitialArchState();
  const sessionPath = '/sessions/rebound.jsonl';
  state.sessions.sessions.push({
    path: sessionPath,
    name: 'rebound',
    cwd: '/sessions',
    modifiedAt: new Date(at).toISOString(),
    messageCount: 1,
    sessionId: 'root-old-identity',
  });
  state.sessions.activeSessionPath = sessionPath;
  state.sessions.openTabPaths = [sessionPath];
  const readModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv });
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at),
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    await stats.start();
    assert.equal(stats.getSessionUsage(sessionPath).samples.length, 1);
    state.sessions.sessions[0]!.sessionId = 'root-new-identity';
    const rebound = stats.getSessionUsage(sessionPath);
    assert.equal(rebound.authority, 'unknown');
    assert.equal(rebound.samples.length, 0, 'old-root data must not appear under the replacement identity');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical startup hydrates visible sessions within query capacity and isolates one failed session', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-hydration-bound-'));
  const databasePath = canonicalAnalyticsDatabasePath(path.join(root, 'analytics'));
  const at = Date.parse('2026-01-15T12:00:00.000Z');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.submitBatch(Array.from({ length: 11 }, (_, index) => settlement({
    invocationId: `inv-hydration-${index}`,
    rootSessionId: index === 5 ? 'root-fail' : `root-hydration-${index}`,
    purpose: 'conversation',
    settledAtMs: at + index,
    inputTokens: 10,
    outputTokens: 5,
    reportedCostUsd: 0.01,
  })));
  closeFixtureWriter(writer);

  const state = createInitialArchState();
  for (let index = 0; index < 11; index += 1) {
    const rootSessionId = index === 5 ? 'root-fail' : `root-hydration-${index}`;
    state.sessions.sessions.push({
      path: `/sessions/hydration-${index}.jsonl`,
      name: `hydration-${index}`,
      cwd: '/sessions',
      modifiedAt: new Date(at).toISOString(),
      messageCount: 1,
      sessionId: rootSessionId,
    });
  }
  const activePath = '/sessions/hydration-0.jsonl';
  state.sessions.activeSessionPath = activePath;
  state.sessions.openTabPaths = [activePath];
  const requestedRootSessionIds: string[] = [];
  const baseReadModel = new CanonicalAnalyticsReadModel({ databasePath, workerScript, execArgv, revisionPollIntervalMs: 25 });
  let active = 0;
  let maximumActive = 0;
  const boundedReadModel = Object.create(baseReadModel) as CanonicalAnalyticsReadModel;
  const originalRead = baseReadModel.readScopedProviderSettlements.bind(baseReadModel);
  boundedReadModel.readScopedProviderSettlements = async (scope, page, signal) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (scope.kind === 'rootSession') requestedRootSessionIds.push(scope.rootSessionId);
    try {
      if (scope.kind === 'rootSession' && scope.rootSessionId === 'root-fail') {
        throw new Error('synthetic one-session read failure');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return await originalRead(scope, page, signal);
    } finally {
      active -= 1;
    }
  };
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-historical',
    workspaceId: 'workspace-historical',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-historical',
    getArchState: () => state,
    now: () => new Date(at + 2_000),
    analyticsCapture: capture,
    analyticsReadModel: boundedReadModel,
  });
  try {
    await stats.start();
    assert.ok(maximumActive <= baseReadModel.getMaxConcurrentQueries());
    assert.deepEqual(requestedRootSessionIds, ['root-hydration-0'], 'startup reads only the active catalog session');
    assert.equal(stats.getSessionUsage(activePath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(activePath).samples.length, 1);
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const usage = stats.getSessionUsage(`/sessions/hydration-${index}.jsonl`);
      assert.equal(usage.authority, 'unknown', `catalog session ${index} remains lazy`);
    }
    const lazyPath = '/sessions/hydration-1.jsonl';
    assert.equal(stats.getSessionUsage(lazyPath).authority, 'unknown');
    for (let attempt = 0; attempt < 100 && stats.getSessionUsage(lazyPath).authority !== 'canonical'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(stats.getSessionUsage(lazyPath).authority, 'canonical');
    assert.equal(stats.getSessionUsage(lazyPath).samples.length, 1);
    const failedPath = '/sessions/hydration-5.jsonl';
    assert.equal(stats.getSessionUsage(failedPath).authority, 'unknown');
    for (let attempt = 0; attempt < 100 && !requestedRootSessionIds.includes('root-fail'); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(requestedRootSessionIds.includes('root-fail'), 'lazy failed session read must be attempted');
    let failedUsage = stats.getSessionUsage(failedPath);
    for (let attempt = 0; attempt < 100 && failedUsage.refreshStatus !== 'error'; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      failedUsage = stats.getSessionUsage(failedPath);
    }
    assert.equal(failedUsage.authority, 'unknown');
    assert.equal(failedUsage.refreshStatus, 'error');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical revision refresh keeps the active session current with a large catalog', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-revision-bound-'));
  const state = createInitialArchState();
  const activePath = '/sessions/active.jsonl';
  state.sessions.activeSessionPath = activePath;
  state.sessions.openTabPaths = [activePath];
  for (let index = 0; index < 320; index += 1) {
    const sessionPath = index === 0 ? activePath : `/sessions/catalog-${index}.jsonl`;
    state.sessions.sessions.push({
      path: sessionPath,
      name: `catalog-${index}`,
      cwd: '/sessions',
      modifiedAt: new Date(1_700_000_000_000 + index).toISOString(),
      messageCount: 1,
      sessionId: index === 0 ? 'root-active' : `root-catalog-${index}`,
    });
  }
  let revision = '1';
  const requestedRootSessionIds: string[] = [];
  let holdNextRead = false;
  let signalReadStarted: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
  let releaseHeldRead: () => void = () => undefined;
  const heldReadReleased = new Promise<void>((resolve) => { releaseHeldRead = resolve; });
  const readModel = {
    getMaxConcurrentQueries: () => 1,
    readRevision: async () => revision,
    readScopedProviderSettlements: async (scope: { rootSessionId: string }) => {
      const snapshotRevision = revision;
      requestedRootSessionIds.push(scope.rootSessionId);
      if (holdNextRead) {
        holdNextRead = false;
        signalReadStarted();
        await heldReadReleased;
      }
      return {
        revision: snapshotRevision,
        settlements: [{
          invocationId: `invocation-${scope.rootSessionId}`,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            providerTotalTokens: 150,
          },
          reportedCostUsd: 0.25,
          generationId: 'generation-revision-bound',
          rootSessionId: scope.rootSessionId,
          executionId: null,
          branchId: null,
          provider: 'fixture-provider',
          model: 'fixture/model',
          dispatchedModel: 'fixture/model',
          reportedModel: 'fixture/model',
          purpose: 'conversation',
          outcome: 'succeeded',
          settledAtMs: 1_700_000_000_000,
          calculatedCostUsd: null,
          calculatedCostComplete: false,
          effectiveCostUsd: 0.25,
          effectiveCostSource: 'reported',
          effectiveCostCoverage: 'known',
          revision: snapshotRevision,
        }],
        truncated: false,
        scope: { kind: 'rootSession' as const, rootSessionId: scope.rootSessionId },
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-revision-bound',
    workspaceId: 'workspace-revision-bound',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const statsHolder: { service?: StatsService } = {};
  const renderedUsageAuthorities: Array<string | undefined> = [];
  const renderedUsageCosts: Array<number | undefined> = [];
  const render = () => {
    const usage = statsHolder.service!.getSessionUsage(activePath);
    renderedUsageAuthorities.push(usage.authority);
    renderedUsageCosts.push(usage.samples[0]?.reportedCostUsd);
  };
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-revision-bound',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
    scheduleRender: render,
  });
  statsHolder.service = stats;
  const internals = stats as unknown as {
    refreshCanonicalSessionUsage(): Promise<void>;
    markCanonicalRevisionForRefresh(nextRevision: string): void;
    canonicalSessionUsageRefresh: Promise<void> | null;
    canonicalSessionUsageByPath: Map<string, { revision: string }>;
  };
  try {
    await stats.start();
    assert.deepEqual(requestedRootSessionIds, ['root-active']);
    assert.equal(stats.getSessionUsage(activePath).authority, 'canonical');
    const renderCountAfterStart = renderedUsageAuthorities.length;
    assert.ok(renderCountAfterStart > 0);
    assert.ok(renderedUsageAuthorities.every((authority) => authority === 'canonical'));
    assert.ok(renderedUsageCosts.every((cost) => cost === 0.25));

    state.sessions.openTabPaths = [activePath, ...[1, 2, 3].map((index) => `/sessions/catalog-${index}.jsonl`)];
    holdNextRead = true;
    revision = '2';
    // Exercise the ordinary revision-refresh path, not a direct manual
    // hydration. The prior complete root snapshot must remain visible while
    // this replacement read is held.
    internals.markCanonicalRevisionForRefresh(revision);
    const refresh = internals.canonicalSessionUsageRefresh!;
    await readStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Model an unrelated reducer event: ExtensionHost.dispatchArchEvent always
    // schedules a render after it applies the event, even while this read is
    // held. The session-cost projection must keep its last complete snapshot.
    render();
    const heldUsage = stats.getSessionUsage(activePath);
    assert.equal(heldUsage.authority, 'canonical');
    assert.equal(heldUsage.freshness, 'stale');
    assert.equal(heldUsage.refreshStatus, 'refreshing');
    assert.equal(heldUsage.samples[0]?.reportedCostUsd, 0.25);
    assert.equal(
      renderedUsageAuthorities.length,
      renderCountAfterStart + 1,
      'an unrelated render must retain the held canonical usage while hydration is pending',
    );
    assert.equal(renderedUsageAuthorities.at(-1), 'canonical');
    assert.equal(renderedUsageCosts.at(-1), 0.25);
    for (let nextRevision = 3; nextRevision <= 12; nextRevision += 1) {
      revision = String(nextRevision);
      internals.markCanonicalRevisionForRefresh(revision);
    }
    releaseHeldRead();
    await refresh;
    assert.equal(renderedUsageAuthorities.length, renderCountAfterStart + 2);
    assert.ok(renderedUsageAuthorities.every((authority) => authority === 'canonical'));
    assert.ok(renderedUsageCosts.every((cost) => cost === 0.25));

    assert.deepEqual(
      requestedRootSessionIds,
      ['root-active', 'root-active', 'root-active', 'root-catalog-1', 'root-catalog-2', 'root-catalog-3'],
      'an invalidated pass skips its remaining tabs and refreshes the active path first at the latest revision',
    );
    assert.equal(internals.canonicalSessionUsageByPath.get(activePath)?.revision, '12');
    assert.equal(stats.getSessionUsage(activePath).freshness, 'fresh');
    assert.equal(stats.getSessionUsage('/sessions/catalog-319.jsonl').authority, 'unknown');
  } finally {
    releaseHeldRead();
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical lazy hydration never starts a query after terminal shutdown', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-shutdown-lazy-'));
  const state = createInitialArchState();
  let queryCount = 0;
  const readModel = {
    getMaxConcurrentQueries: () => 2,
    readScopedProviderSettlements: async () => {
      queryCount += 1;
      throw new Error('post-shutdown query must not start');
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-shutdown-lazy',
    workspaceId: 'workspace-shutdown-lazy',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-shutdown-lazy',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  try {
    await stats.shutdown();
    assert.equal(stats.getSessionUsage('/sessions/late-render.jsonl').authority, 'unknown');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(queryCount, 0, 'a final renderer read must not spawn a helper');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical lazy hydration bounds distinct paths and reclaims epoch tokens', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-lazy-bound-'));
  const state = createInitialArchState();
  let active = 0;
  let maximumActive = 0;
  let queryCount = 0;
  let holdReads = true;
  const blockedResolvers: Array<() => void> = [];
  const readModel = {
    getMaxConcurrentQueries: () => 2,
    readRevision: async () => '1',
    readScopedProviderSettlements: async (scope: { rootSessionId: string }) => {
      queryCount += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (holdReads) {
        await new Promise<void>((resolve) => blockedResolvers.push(resolve));
      }
      active -= 1;
      return {
        revision: '1',
        settlements: [],
        truncated: false,
        scope: { kind: 'rootSession' as const, rootSessionId: scope.rootSessionId },
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-lazy-bound',
    workspaceId: 'workspace-lazy-bound',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-lazy-bound',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const internals = stats as unknown as {
    canonicalSessionPathRefreshes: Map<string, Promise<void>>;
    canonicalSessionPathEpochs: Map<string, number>;
  };
  try {
    await stats.start();
    const paths = Array.from({ length: 320 }, (_, index) => `/sessions/lazy-${index}.jsonl`);
    for (const sessionPath of paths.slice(0, 4)) {
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(queryCount, 2, 'distinct lazy paths must share the bounded read capacity');
    assert.equal(maximumActive, 2);
    assert.equal(internals.canonicalSessionPathRefreshes.size, 2);

    holdReads = false;
    blockedResolvers.splice(0).forEach((resolve) => resolve());
    for (let attempt = 0; attempt < 100 && internals.canonicalSessionPathRefreshes.size > 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(internals.canonicalSessionPathRefreshes.size, 0);

    for (const sessionPath of paths.slice(2)) {
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'unknown');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stats.getSessionUsage(sessionPath).authority === 'canonical'
          && internals.canonicalSessionPathRefreshes.size === 0) break;
      }
      assert.equal(stats.getSessionUsage(sessionPath).authority, 'canonical');
    }
    assert.ok(internals.canonicalSessionPathEpochs.size <= 256, 'epoch tokens must follow bounded cache retention');
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bounded displayed refresh converges with more cached paths than its targets and omitted paths recover on demand', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-canonical-omit-bound-'));
  const state = createInitialArchState();
  const activePath = '/sessions/omit-active.jsonl';
  state.sessions.activeSessionPath = activePath;
  state.sessions.openTabPaths = [activePath];
  const sessionCount = 40;
  for (let index = 0; index < sessionCount; index += 1) {
    const sessionPath = index === 0 ? activePath : `/sessions/omit-catalog-${index}.jsonl`;
    state.sessions.sessions.push({
      path: sessionPath,
      name: `omit-${index}`,
      cwd: '/sessions',
      modifiedAt: new Date(1_700_000_000_000 + index).toISOString(),
      messageCount: 1,
      sessionId: index === 0 ? 'root-omit-active' : `root-omit-catalog-${index}`,
    });
  }
  let revision = '1';
  const readRoots: string[] = [];
  const readModel = {
    getMaxConcurrentQueries: () => 4,
    readRevision: async () => revision,
    readScopedProviderSettlements: async (scope: { rootSessionId: string }) => {
      const snapshotRevision = revision;
      readRoots.push(scope.rootSessionId);
      return {
        revision: snapshotRevision,
        settlements: [{
          invocationId: `invocation-${scope.rootSessionId}`,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            providerTotalTokens: 150,
          },
          reportedCostUsd: 0.25,
          generationId: 'generation-omit-bound',
          rootSessionId: scope.rootSessionId,
          executionId: null,
          branchId: null,
          provider: 'fixture-provider',
          model: 'fixture/model',
          dispatchedModel: 'fixture/model',
          reportedModel: 'fixture/model',
          purpose: 'conversation',
          outcome: 'succeeded',
          settledAtMs: 1_700_000_000_000,
          calculatedCostUsd: null,
          calculatedCostComplete: false,
          effectiveCostUsd: 0.25,
          effectiveCostSource: 'reported',
          effectiveCostCoverage: 'known',
          revision: snapshotRevision,
        }],
        truncated: false,
        scope: { kind: 'rootSession' as const, rootSessionId: scope.rootSessionId },
      };
    },
  } as unknown as CanonicalAnalyticsReadModel;
  const capture = new CanonicalAnalyticsCapture({
    authority: 'canonical',
    generationId: 'generation-omit-bound',
    workspaceId: 'workspace-omit-bound',
    buildId: 'test-build',
    processGeneration: 'test-process',
    sink: { submit: () => undefined },
    detailSink: { submitDetail: () => undefined },
    lifecycleSink: { bindPendingCreate: async () => undefined, deleteSession: async () => undefined },
  });
  const stats = new StatsService({
    dataOutcomesRootPath: path.join(root, 'legacy'),
    workspaceId: 'workspace-omit-bound',
    getArchState: () => state,
    analyticsCapture: capture,
    analyticsReadModel: readModel,
  });
  const internals = stats as unknown as {
    refreshCanonicalSessionUsage(): Promise<void>;
    canonicalSessionUsageRefresh: Promise<void> | null;
    canonicalSessionUsageRetryTimer: unknown;
    canonicalSessionUsageByPath: Map<string, { snapshot: {
      authority?: string;
      freshness?: string;
      refreshStatus?: string;
    } }>;
    analyticsRevisionRefresher?: { getStats(): { revision: string | null } };  };
  const waitUntil = async (predicate: () => boolean, attempts = 600): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(predicate(), 'condition did not converge');
  };
  try {
    await stats.start();
    assert.deepEqual(readRoots, ['root-omit-active'], 'startup reads only the displayed surface');
    // Hydrate the whole catalogue on demand so the cache holds more paths
    // than the bounded displayed pass can ever re-read.
    for (const catalogPath of state.sessions.sessions.map((session) => session.path)) {
      if (catalogPath === activePath) continue;
      await waitUntil(() => {
        stats.getSessionUsage(catalogPath);
        return stats.getSessionUsage(catalogPath).authority === 'canonical';
      });
    }
    assert.equal(internals.canonicalSessionUsageByPath.size, sessionCount);
    const afterHydrationReadCount = readRoots.length;
    assert.equal(new Set(readRoots).size, sessionCount, 'every catalogue path is cached beyond the displayed bound');

    // A peer commit advances the shared revision. Only the displayed surface
    // is re-read; the omitted paths are retained at the older revision.
    revision = '2';
    await waitUntil(() => internals.analyticsRevisionRefresher?.getStats().revision === '2');
    // The revision notification triggers the ordinary bounded pass; with
    // instant fixture reads it may already have settled. Drain it, then run
    // one explicit bounded pass over the retained cache for determinism.
    await waitUntil(() => internals.canonicalSessionUsageRefresh === null);
    await internals.refreshCanonicalSessionUsage();
    assert.equal(stats.getSessionUsage(activePath).freshness, 'fresh');
    assert.ok(
      readRoots.slice(afterHydrationReadCount).every((root) => root === 'root-omit-active'),
      'the bounded pass must not re-read omitted paths',
    );

    // The displayed surface is fully fresh, so the refresh must converge:
    // no 250ms retry timer may survive for paths the pass omits.
    assert.equal(internals.canonicalSessionUsageRetryTimer, undefined, 'a converged refresh must not schedule a retry');
    const afterRefreshReadCount = readRoots.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 3 * 250 + 150));
    assert.equal(readRoots.length, afterRefreshReadCount, 'a converged refresh must not keep re-reading on a timer');
    assert.equal(internals.canonicalSessionUsageRetryTimer, undefined);

    // The omitted paths stay retained (never eager re-read) and the retained
    // entry carries revision-truthful stale metadata, inspected without a
    // renderer read so no hydration is scheduled by the assertion itself.
    const omittedPath = '/sessions/omit-catalog-7.jsonl';
    const retainedEntry = internals.canonicalSessionUsageByPath.get(omittedPath);
    assert.equal(retainedEntry?.snapshot.authority, 'canonical');
    assert.equal(retainedEntry?.snapshot.freshness, 'stale', 'a retained entry at the older revision is explicitly stale');
    assert.equal(retainedEntry?.snapshot.refreshStatus, 'refreshing');
    const staleNeighbour = internals.canonicalSessionUsageByPath.get('/sessions/omit-catalog-8.jsonl');
    assert.equal(staleNeighbour?.snapshot.freshness, 'stale', 'omitted paths stay retained without eager re-reads');
    assert.ok(
      !readRoots.slice(afterHydrationReadCount).includes('root-omit-catalog-8'),
      'omitted paths remain lazy',
    );

    // The omitted path recovers with exactly one on-demand read.
    const beforeDemand = readRoots.length;
    const retained = stats.getSessionUsage(omittedPath);
    assert.equal(retained.authority, 'canonical');
    assert.equal(retained.freshness, 'stale');
    assert.equal(retained.refreshStatus, 'refreshing');
    await waitUntil(() => stats.getSessionUsage(omittedPath).freshness === 'fresh');
    assert.equal(stats.getSessionUsage(omittedPath).samples[0]?.reportedCostUsd, 0.25);
    assert.equal(
      readRoots.slice(beforeDemand).filter((root) => root === 'root-omit-catalog-7').length,
      1,
      'exactly one on-demand read recovered the omitted path',
    );

    // A refresh with no revision change retains the recovered omitted entry
    // as fresh with an idle status instead of a permanent stale badge.
    const directRefreshCount = readRoots.length;
    await internals.refreshCanonicalSessionUsage();
    const retainedFresh = stats.getSessionUsage(omittedPath);
    assert.equal(retainedFresh.freshness, 'fresh');
    assert.equal(retainedFresh.refreshStatus, 'idle');
    assert.equal(internals.canonicalSessionUsageRetryTimer, undefined);
    assert.equal(
      readRoots.slice(directRefreshCount).filter((root) => root === 'root-omit-catalog-7').length,
      0,
      'a fresh omitted entry must not be re-read by the bounded pass',
    );
  } finally {
    await stats.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
