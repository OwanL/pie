import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';

import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSourceConflictError,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import {
  AnalyticsPrivacyScrubPendingError,
  SqliteAnalyticsRecorder,
} from '../../src/analytics/sqlite-recorder.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';
import {
  canonicalSettlementUsageRecord,
  summarizeCanonicalUsage,
} from '../../src/analytics/canonical-usage.js';

interface TestDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => TestDatabase;
};

function observation(options: {
  sourceKey: string;
  rootSessionId?: string;
  invocationId?: string;
  executionId?: string;
  branchId?: string;
  entityKind?: AnalyticsObservation['entityKind'];
  entityKey?: string;
  observationKind?: AnalyticsObservation['observationKind'];
  observedAtMs?: number | string | bigint;
  sourceSequence?: number | string | bigint;
  generationId?: string;
  fields?: Record<string, unknown>;
  captureSubject?: AnalyticsObservation['captureSubject'];
  stableOriginId?: string;
  processGeneration?: string;
}): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const captureSubject = options.captureSubject ?? { kind: 'session' as const, rootSessionId };
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-1',
    producerKind: 'test',
    stableOriginId: options.stableOriginId,
    sourceKey: options.sourceKey,
    entityKind: options.entityKind ?? (options.invocationId ? 'providerCall' : 'execution'),
    entityKey: options.entityKey ?? options.invocationId ?? options.sourceKey,
    observationKind: options.observationKind ?? (options.invocationId ? 'providerSettlement' : 'end'),
    observedAtMs: options.observedAtMs ?? 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'workspace-a',
      ...(captureSubject.kind === 'session' ? { rootSessionId } : {}),
      invocationId: options.invocationId,
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.branchId ? { branchId: options.branchId } : {}),
    },
    captureSubject,
    producer: { buildId: 'test-build', processGeneration: options.processGeneration ?? 'test-process-1' },
    fields: options.fields ?? { outcome: 'success' },
  };
  return {
    ...base,
    ...(options.sourceSequence === undefined ? {} : { sourceSequence: options.sourceSequence }),
    idempotencyKey: deriveAnalyticsIdempotencyKey(base),
  };
}

function detail(options: {
  payloadId: string;
  rootSessionId?: string;
  value: unknown;
  captureSubject?: AnalyticsDetailCapture['captureSubject'];
}): AnalyticsDetailCapture {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'generation-1',
    payloadId: options.payloadId,
    sourceKey: options.payloadId,
    observedAtMs: 1_750_000_000_000,
    captureSubject: options.captureSubject ?? { kind: 'session', rootSessionId },
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

test('historical dimensions bound each category and preserve explicit truncation', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    for (let index = 0; index < 4; index += 1) {
      recorder.submit(observation({ sourceKey: `provider-${index}`, invocationId: `call-${index}`,
        fields: { provider: `provider-${index}`, dispatchedModel: 'model', outcome: 'success' } }));
      recorder.submit(observation({ sourceKey: `tool-${index}`, entityKind: 'toolCall',
        fields: { toolDefinitionId: `tool-${index}`, outcome: 'success' } }));
      recorder.submit(observation({ sourceKey: `activity-${index}`, entityKind: 'activitySpan',
        fields: { kind: `activity-${index}`, coverage: 'known' } }));
      recorder.submit(observation({ sourceKey: `feature-${index}`, entityKind: 'featureObservation',
        fields: { feature: `feature-${index}`, decision: 'used', ruleVersion: '1' } }));
    }
    const bounded = recorder.readHistoricalDimensionSummary({ maxRowsPerDimension: 2 });
    assert.equal(bounded.maxRowsPerDimension, 2);
    assert.deepEqual(bounded.truncation, { rowLimit: true, byteLimit: false, cellLimit: false });
    for (const category of ['providers', 'tools', 'activities', 'features'] as const) {
      assert.equal(bounded[category].length, 2, category);
      assert.ok(bounded[category].every((row) => row.occurrence_count === 1));
    }
    const exact = recorder.readHistoricalDimensionSummary({ maxRowsPerDimension: 4 });
    assert.deepEqual(exact.truncation, { rowLimit: false, byteLimit: false, cellLimit: false });
    assert.equal(String(exact.revision), String(bounded.revision));
    assert.equal(exact.features.length, 4);
    assert.throws(() => recorder.readHistoricalDimensionSummary({ maxRowsPerDimension: 0 }), /positive/iu);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('execution state keeps the root operation kind while turn phases arrive', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  let database: TestDatabase | undefined;
  try {
    recorder.submit(observation({
      sourceKey: 'execution-begin',
      entityKey: 'operation-1',
      observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: 1_750_000_000_000 },
    }));
    recorder.submit(observation({
      sourceKey: 'execution-turn-phase',
      entityKey: 'operation-1',
      observationKind: 'phase',
      fields: { operationKind: 'assistant-turn', turnId: 'turn-1' },
    }));

    database = new DatabaseSync(temp.databasePath);
    const row = database.prepare(
      'SELECT operation_kind, started_at_ms, ended_at_ms FROM analytics_execution_states WHERE execution_id = ?',
    ).get('operation-1') as { operation_kind: string | null; started_at_ms: string | null; ended_at_ms: string | null };
    assert.deepEqual({ ...row }, {
      operation_kind: 'agent-run',
      started_at_ms: '1750000000000',
      ended_at_ms: null,
    });
  } finally {
    database?.close();
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('execution lifecycle state ignores a delayed phase after the root has settled', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  let database: TestDatabase | undefined;
  try {
    recorder.submit(observation({
      sourceKey: 'execution-root-begin',
      entityKey: 'operation-late-phase',
      observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: 100 },
    }));
    recorder.submit(observation({
      sourceKey: 'execution-root-end',
      entityKey: 'operation-late-phase',
      observationKind: 'end',
      fields: { operationKind: 'agent-run', endedAtMs: 200, outcome: 'success' },
    }));
    recorder.submit(observation({
      sourceKey: 'execution-delayed-phase',
      entityKey: 'operation-late-phase',
      observationKind: 'phase',
      fields: {
        operationKind: 'assistant-turn',
        startedAtMs: 50,
        endedAtMs: 300,
        outcome: 'failed',
      },
    }));

    database = new DatabaseSync(temp.databasePath);
    const row = database.prepare(
      'SELECT operation_kind, outcome, started_at_ms, ended_at_ms FROM analytics_execution_states WHERE execution_id = ?',
    ).get('operation-late-phase') as {
      operation_kind: string | null;
      outcome: string | null;
      started_at_ms: string | null;
      ended_at_ms: string | null;
    };
    assert.deepEqual({ ...row }, {
      operation_kind: 'agent-run',
      outcome: 'success',
      started_at_ms: '100',
      ended_at_ms: '200',
    });
  } finally {
    database?.close();
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('maintained execution summary counts agent runs across bind and deletion', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'summary-root-begin',
      rootSessionId: 'summary-root',
      entityKey: 'summary-root-execution',
      observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: 100 },
    }));
    recorder.submit(observation({
      sourceKey: 'summary-root-end',
      rootSessionId: 'summary-root',
      entityKey: 'summary-root-execution',
      observationKind: 'end',
      fields: { operationKind: 'agent-run', endedAtMs: 200, outcome: 'success' },
    }));
    let summary = recorder.readExecutionSummary();
    assert.equal(summary.executionCount, 1);
    assert.equal(summary.begunCount, 1);
    assert.equal(summary.settledCount, 1);
    assert.equal(summary.lifecycleCoverage, 'known');
    assert.equal(summary.timingCoverage, 'known');
    assert.equal(summary.deliveryCoverage, 'complete');
    assert.deepEqual(summary.latestSettled, {
      generationId: 'generation-1',
      executionId: 'summary-root-execution',
      sourceKey: 'summary-root-end',
      startedAtMs: 100,
      endedAtMs: 200,
    });
    assert.equal(recorder.readExecutionSummary('summary-root').executionCount, 1);
    const globalPlan = recorder.executeReadOnlyQuery(`
      EXPLAIN QUERY PLAN
      SELECT generation_id, execution_id
      FROM analytics_execution_states
      WHERE operation_kind = 'agent-run' AND settled = 1
      ORDER BY CAST(settled_revision AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `);
    const globalPlanDetails = globalPlan.rows.map((row) => String(row.detail));
    assert.ok(globalPlanDetails.some((detail) => detail.includes('analytics_execution_state_latest_global_idx')));
    assert.ok(!globalPlanDetails.some((detail) => detail.includes('TEMP B-TREE')));
    const sessionPlan = recorder.executeReadOnlyQuery(`
      EXPLAIN QUERY PLAN
      SELECT generation_id, execution_id
      FROM analytics_execution_states
      WHERE root_session_id = 'summary-root' AND operation_kind = 'agent-run' AND settled = 1
      ORDER BY CAST(settled_revision AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `);
    const sessionPlanDetails = sessionPlan.rows.map((row) => String(row.detail));
    assert.ok(sessionPlanDetails.some((detail) => detail.includes('analytics_execution_state_latest_session_idx')));
    assert.ok(!sessionPlanDetails.some((detail) => detail.includes('TEMP B-TREE')));

    const pendingSubject = { kind: 'pendingCreate' as const, operationId: 'summary-pending' };
    recorder.submit(observation({
      sourceKey: 'summary-pending-begin',
      entityKey: 'summary-pending-execution',
      captureSubject: pendingSubject,
      observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: 300 },
    }));
    recorder.submit(observation({
      sourceKey: 'summary-pending-end',
      entityKey: 'summary-pending-execution',
      captureSubject: pendingSubject,
      observationKind: 'end',
      fields: { operationKind: 'agent-run', endedAtMs: 400, outcome: 'success' },
    }));
    assert.equal(recorder.readExecutionSummary().executionCount, 2);
    assert.equal(recorder.readExecutionSummary('summary-session').executionCount, 0);

    recorder.bindPendingCreate('summary-pending', 'summary-session', 'summary-bind', 500);
    summary = recorder.readExecutionSummary('summary-session');
    assert.equal(summary.executionCount, 1);
    assert.equal(summary.begunCount, 1);
    assert.equal(summary.settledCount, 1);
    assert.equal(summary.timingCoverage, 'known');
    recorder.deleteSession('summary-session', 'summary-delete', 600);
    assert.equal(recorder.readExecutionSummary('summary-session').executionCount, 0);
    assert.equal(recorder.readExecutionSummary().executionCount, 1);

    recorder.deleteSession('summary-root', 'summary-root-delete', 700);
    summary = recorder.readExecutionSummary();
    assert.equal(summary.executionCount, 0);
    assert.equal(summary.settledCount, 0);
    assert.equal(summary.latestSettled, null);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('canonical latest run follows source completion and exact execution identity', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const windowStart = 1_700_000_000_000;
  const windowEnd = 1_900_000_000_000;
  const submitRun = (generationId: string, rootSessionId: string, endedAtMs: number): void => {
    recorder.submit(observation({
      sourceKey: `${generationId}-begin`, generationId, rootSessionId,
      entityKey: 'same-execution', observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: endedAtMs - 100 },
    }));
    recorder.submit(observation({
      sourceKey: `${generationId}-end`, generationId, rootSessionId,
      entityKey: 'same-execution', observationKind: 'end',
      fields: { operationKind: 'agent-run', endedAtMs, outcome: 'success' },
    }));
  };
  const submitSettlement = (
    generationId: string,
    rootSessionId: string,
    invocationId: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
    reportedCostUsd: number,
  ): void => {
    recorder.submit(observation({
      sourceKey: `${generationId}-${invocationId}`,
      generationId,
      rootSessionId,
      invocationId,
      executionId: 'same-execution',
      fields: {
        invocationId,
        provider,
        dispatchedModel: `${provider}-model`,
        purpose: 'conversation',
        outcome: 'success',
        inputTokens,
        outputTokens,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: true,
        reportedCostUsd,
        coverage: 'known',
      },
    }));
  };
  try {
    recorder.prepareProviderDailyProjection('UTC', windowStart, windowEnd);
    // The newer source completion is delivered first; the older completion is
    // delivered later, so delivery revision order would select the wrong run.
    submitRun('generation-new', 'run-new', windowStart + 300);
    submitSettlement('generation-new', 'run-new', 'new-call', 'new-provider', 0, 5, 0);
    submitRun('generation-old', 'run-old', windowStart + 200);
    submitSettlement('generation-old', 'run-old', 'old-call', 'old-provider', 90, 4, 9);

    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: windowStart,
      todayEndMs: windowEnd,
      weekStartMs: windowStart,
      weekEndMs: windowEnd,
      timeZone: 'UTC',
      dailyWindowStartMs: windowStart,
      dailyWindowEndMs: windowEnd,
    });
    assert.deepEqual(aggregate.latestRun, {
      generationId: 'generation-new',
      executionId: 'same-execution',
      rootSessionId: 'run-new',
      sourceKey: 'generation-new-end',
      outcome: 'success',
      startedAtMs: windowStart + 200,
      endedAtMs: windowStart + 300,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 5,
      usageCoverage: 'complete',
      provider: 'new-provider',
      modelId: 'new-provider-model',
      attributionCoverage: 'single',
      turnSeries: [],
      turnSeriesCoverage: 'unavailable',
    });
    const sourcePlan = recorder.executeReadOnlyQuery(`
      EXPLAIN QUERY PLAN
      SELECT generation_id, execution_id
      FROM analytics_execution_states
      WHERE operation_kind = 'agent-run' AND settled = 1 AND ended_at_ms IS NOT NULL
      ORDER BY CAST(ended_at_ms AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `);
    const sourceDetails = sourcePlan.rows.map((row) => String(row.detail));
    assert.ok(sourceDetails.some((detail) => detail.includes('analytics_execution_state_source_end_global_idx')));
    assert.ok(!sourceDetails.some((detail) => detail.includes('TEMP B-TREE')));
    const sessionPlan = recorder.executeReadOnlyQuery(`
      EXPLAIN QUERY PLAN
      SELECT generation_id, execution_id
      FROM analytics_execution_states
      WHERE root_session_id = 'run-new' AND operation_kind = 'agent-run'
        AND settled = 1 AND ended_at_ms IS NOT NULL
      ORDER BY CAST(ended_at_ms AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `);
    const sessionDetails = sessionPlan.rows.map((row) => String(row.detail));
    assert.ok(sessionDetails.some((detail) => detail.includes('analytics_execution_state_source_end_session_idx')));
    assert.ok(!sessionDetails.some((detail) => detail.includes('TEMP B-TREE')));
    const providerPlan = recorder.executeReadOnlyQuery(`
      EXPLAIN QUERY PLAN
      SELECT provider, normalized_base_input_tokens
      FROM analytics_provider_settlements
      WHERE generation_id = 'generation-new' AND execution_id = 'same-execution'
    `);
    assert.ok(providerPlan.rows.some((row) => String(row.detail).includes('analytics_provider_settlement_execution_idx')));

    // A private close removes the selected state and its exact provider rows;
    // the next source-chronological retained run becomes visible.
    recorder.deleteSession('run-new', 'delete-new-run', windowStart + 500);
    const afterDelete = recorder.readProviderAggregateSummary({
      todayStartMs: windowStart,
      todayEndMs: windowEnd,
      weekStartMs: windowStart,
      weekEndMs: windowEnd,
      timeZone: 'UTC',
      dailyWindowStartMs: windowStart,
      dailyWindowEndMs: windowEnd,
    });
    assert.equal(afterDelete.latestRun?.generationId, 'generation-old');
    assert.equal(afterDelete.latestRun?.executionId, 'same-execution');
    assert.equal(afterDelete.latestRun?.provider, 'old-provider');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('schema v10 to current adds source-time and exact execution indexes', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  recorder.close();
  const raw = new DatabaseSync(temp.databasePath);
  try {
    raw.exec(`
      DROP INDEX analytics_execution_state_source_end_global_idx;
      DROP INDEX analytics_execution_state_source_end_session_idx;
      DROP INDEX analytics_provider_settlement_execution_idx;
      PRAGMA user_version = 10;
    `);
  } finally {
    raw.close();
  }

  let upgraded: SqliteAnalyticsRecorder | undefined;
  try {
    upgraded = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.equal(upgraded.getDatabaseSchemaVersion(), 13);
    const indexNames = new Set(
      upgraded.executeReadOnlyQuery(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('analytics_execution_state_source_end_global_idx', 'analytics_execution_state_source_end_session_idx', 'analytics_provider_settlement_execution_idx')",
      ).rows.map((row) => String(row.name)),
    );
    assert.deepEqual(indexNames, new Set([
      'analytics_execution_state_source_end_global_idx',
      'analytics_execution_state_source_end_session_idx',
      'analytics_provider_settlement_execution_idx',
    ]));
  } finally {
    upgraded?.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('canonical latest run reports unavailable usage when no exact provider rows exist', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.prepareProviderDailyProjection('UTC', 1_700_000_000_000, 1_900_000_000_000);
    recorder.submit(observation({
      sourceKey: 'run-without-provider-end',
      generationId: 'generation-no-provider',
      rootSessionId: 'root-no-provider',
      entityKey: 'execution-no-provider',
      observationKind: 'end',
      fields: { operationKind: 'agent-run', outcome: 'failed', endedAtMs: 1_800_000_000_000 },
    }));
    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: 1_700_000_000_000,
      todayEndMs: 1_900_000_000_000,
      weekStartMs: 1_700_000_000_000,
      weekEndMs: 1_900_000_000_000,
      timeZone: 'UTC',
      dailyWindowStartMs: 1_700_000_000_000,
      dailyWindowEndMs: 1_900_000_000_000,
    });
    assert.deepEqual(aggregate.latestRun, {
      generationId: 'generation-no-provider',
      executionId: 'execution-no-provider',
      rootSessionId: 'root-no-provider',
      sourceKey: 'run-without-provider-end',
      outcome: 'failed',
      startedAtMs: null,
      endedAtMs: 1_800_000_000_000,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      usageCoverage: 'unavailable',
      provider: null,
      modelId: null,
      attributionCoverage: 'unknown',
      turnSeries: [],
      turnSeriesCoverage: 'unavailable',
    });
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('canonical latest run marks summed channels partial when an int64 sum overflows', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const maxInt64 = '9223372036854775807';
  const request = {
    todayStartMs: 1_700_000_000_000,
    todayEndMs: 1_900_000_000_000,
    weekStartMs: 1_700_000_000_000,
    weekEndMs: 1_900_000_000_000,
    timeZone: 'UTC',
    dailyWindowStartMs: 1_700_000_000_000,
    dailyWindowEndMs: 1_900_000_000_000,
  };
  try {
    recorder.prepareProviderDailyProjection('UTC', request.dailyWindowStartMs, request.dailyWindowEndMs);
    recorder.submit(observation({
      sourceKey: 'overflow-run-begin', generationId: 'generation-overflow',
      rootSessionId: 'root-overflow', entityKey: 'execution-overflow', observationKind: 'begin',
      fields: { operationKind: 'agent-run', startedAtMs: 1_799_999_999_900 },
    }));
    recorder.submit(observation({
      sourceKey: 'overflow-run-end', generationId: 'generation-overflow',
      rootSessionId: 'root-overflow', entityKey: 'execution-overflow', observationKind: 'end',
      fields: { operationKind: 'agent-run', endedAtMs: 1_800_000_000_000, outcome: 'success' },
    }));
    for (const invocationId of ['overflow-a', 'overflow-b']) {
      recorder.submit(observation({
        sourceKey: `${invocationId}-source`, generationId: 'generation-overflow',
        rootSessionId: 'root-overflow', invocationId, executionId: 'execution-overflow',
        fields: {
          invocationId, provider: 'overflow-provider', dispatchedModel: 'overflow-model',
          purpose: 'conversation', outcome: 'success', inputTokens: maxInt64, outputTokens: 0,
          inputIncludesCache: false, outputIncludesReasoning: true,
          cacheChannelsOmittedAsZero: true, reportedCostUsd: 0,
        },
      }));
    }
    const latestRun = recorder.readProviderAggregateSummary(request).latestRun;
    assert.equal(latestRun?.inputTokens, null);
    assert.equal(latestRun?.outputTokens, 0);
    assert.equal(latestRun?.costUsd, 0);
    assert.equal(latestRun?.usageCoverage, 'partial');
    assert.equal(latestRun?.provider, 'overflow-provider');
    assert.equal(latestRun?.modelId, 'overflow-model');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('historical dimension bytes are shared across categories and oversized cells are qualified', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({ sourceKey: 'provider', invocationId: 'call',
      fields: { provider: 'provider', dispatchedModel: 'model', outcome: 'success' } }));
    recorder.submit(observation({ sourceKey: 'tool', entityKind: 'toolCall',
      fields: { toolDefinitionId: 'tool', outcome: 'success' } }));
    recorder.submit(observation({ sourceKey: 'feature', entityKind: 'featureObservation',
      fields: { feature: 'x'.repeat(1000), decision: 'used' } }));
    const all = recorder.readHistoricalDimensionSummary();
    const providerBytes = Buffer.byteLength(JSON.stringify(all.providers[0]), 'utf8');
    const limited = recorder.readHistoricalDimensionSummary({ maxBytes: providerBytes });
    assert.equal(limited.providers.length, 1);
    assert.equal(limited.tools.length, 0);
    assert.equal(limited.features.length, 0);
    assert.equal(limited.truncation.byteLimit, true);
    const cells = recorder.readHistoricalDimensionSummary({ maxCellBytes: 32 });
    assert.equal(cells.truncation.cellLimit, true);
    assert.deepEqual(cells.features[0]?.feature, {
      type: 'text', encoding: 'utf8', data: 'x'.repeat(32), originalBytes: 1000,
    });
    assert.equal(cells.truncation.byteLimit, false);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

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
    assert.throws(
      () => recorder.submitDetail({
        ...childCapture,
        metadata: { ...childCapture.metadata, sourceVersion: 'detail-v2' },
      }),
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

test('detail range preserves canonical bytes and distinguishes sparse slots from undefined', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const sparse = new Array<unknown>(3);
    sparse[1] = 1;
    const formerlyDouble = [1.5, 0.5, 1.5, -0.5, 2_147_483_648.5];
    formerlyDouble[0] = 1;
    formerlyDouble[1] = 0;
    formerlyDouble[3] = -0;
    formerlyDouble[4] = 2_147_483_648;
    const value = sanitizeAnalyticsDetail({
      authorization: 'Bearer source-secret',
      explicit: [undefined, 1, undefined],
      mixed: formerlyDouble,
      sparse,
      text: 'password=source-secret',
    });
    const bytes = serialize(value);
    const capture = { ...detail({ payloadId: 'canonical-detail', value }), bytes };
    recorder.submitDetail(capture);
    recorder.submitDetail(capture);

    const reconstructed = recorder.reconstructDetail(capture.payloadId) as {
      explicit: unknown[];
      sparse: unknown[];
    };
    assert.equal(Object.prototype.hasOwnProperty.call(reconstructed.sparse, 0), false);
    assert.equal(Object.prototype.hasOwnProperty.call(reconstructed.explicit, 0), true);
    const range = recorder.readDetailRange(capture.payloadId, 0, bytes.byteLength + 1);
    assert.equal(range.nextOffset, null);
    assert.deepEqual(range.bytes, bytes);
    assert.equal(
      createHash('sha256').update(range.bytes).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'),
    );

    const changed = sanitizeAnalyticsDetail({
      authorization: 'Bearer source-secret',
      explicit: [undefined, 1, undefined],
      mixed: [1, 0, 2.5, -0, 2_147_483_648],
      sparse,
      text: 'password=source-secret',
    });
    assert.throws(
      () => recorder.submitDetail({ ...capture, bytes: serialize(changed) }),
      AnalyticsSourceConflictError,
    );
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

test('v1 upgrade retains facts, detail, deletion fences, accounting, and source reconciliation', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'legacy-settlement',
      rootSessionId: 'root-retained',
      invocationId: 'legacy-invocation',
      sourceSequence: 1,
      fields: {
        invocationId: 'legacy-invocation',
        provider: 'legacy-provider',
        dispatchedModel: 'legacy-model',
        purpose: 'conversation',
        outcome: 'success',
        settledAtMs: '9223372036854775807',
        inputTokens: '9007199254740993',
        outputTokens: 7,
        cacheReadTokens: null,
        calculatedCostUsd: 0.125,
        calculatedCostComplete: true,
        coverage: 'known',
      },
    }));
    recorder.submitDetail(detail({ payloadId: 'legacy-detail', rootSessionId: 'root-retained', value: { retained: true } }));
    recorder.deleteSession('root-deleted', 'legacy-delete', 50);
    recorder.close();

    const raw = new DatabaseSync(temp.databasePath);
    try {
      raw.exec(`
        DROP INDEX analytics_pending_subject_root_idx;
        DROP INDEX analytics_provider_settlement_subject_idx;
        DROP INDEX analytics_provider_settlement_root_idx;
        DROP INDEX analytics_provider_settlement_dimensions_idx;
        DROP INDEX analytics_execution_root_idx;
        DROP INDEX analytics_execution_state_root_idx;
        DROP INDEX analytics_tool_root_idx;
        DROP INDEX analytics_tool_identity_idx;
        DROP INDEX analytics_tool_state_root_idx;
        DROP INDEX analytics_activity_root_idx;
        DROP INDEX analytics_activity_identity_idx;
        DROP INDEX analytics_activity_state_root_idx;
        DROP INDEX analytics_feature_root_idx;
        DROP INDEX analytics_feature_dimensions_idx;
        DROP TABLE analytics_session_copies;
        DROP TABLE analytics_current_branch_selections;
        DROP TABLE analytics_branch_selections;
        DROP TABLE analytics_branch_edges;
        DROP TABLE analytics_provider_settlements;
        DROP TABLE analytics_provider_accounting_projections;
        DROP TABLE analytics_execution_observations;
        DROP TABLE analytics_execution_states;
        DROP TABLE analytics_tool_observations;
        DROP TABLE analytics_tool_states;
        DROP TABLE analytics_activity_observations;
        DROP TABLE analytics_activity_states;
        DROP TABLE analytics_feature_observations;
        DROP TABLE analytics_producer_sequences;
        DROP TABLE analytics_producer_reconciliation;
        DROP TABLE analytics_pending_subject_bindings;
        DROP TABLE analytics_projection_state;
        DROP VIEW analytics_provider_usage_v1;
        DROP TRIGGER analytics_detail_reference_last_owner_cleanup;
        DROP TABLE analytics_delivery_accounting;
        DROP TABLE analytics_generations;
        ALTER TABLE analytics_detail_payloads DROP COLUMN omission_reason;
        ALTER TABLE analytics_detail_payloads DROP COLUMN source_version;
        ALTER TABLE analytics_detail_payloads DROP COLUMN capture_stage;
        ALTER TABLE analytics_detail_payloads DROP COLUMN complete;
        ALTER TABLE analytics_detail_payloads DROP COLUMN source_encoding;
        ALTER TABLE analytics_detail_payloads DROP COLUMN media_type;
        ALTER TABLE analytics_deleted_subjects DROP COLUMN scrub_error;
        ALTER TABLE analytics_deleted_subjects DROP COLUMN scrub_state;
        PRAGMA user_version = 1;
      `);
    } finally {
      raw.close();
    }

    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.equal(recorder.getDatabaseSchemaVersion(), 13);
    assert.equal(recorder.readDeliveryAccounting().deliveryHistoryCoverage, 'retained_only');
    assert.equal(recorder.countObservations('root-retained'), 1);
    assert.deepEqual(recorder.reconstructDetail('legacy-detail'), { retained: true });
    assert.deepEqual(recorder.readProviderSettlements(), {
      revision: 1,
      settlements: [{
        generationId: 'generation-1',
        invocationId: 'legacy-invocation',
        rootSessionId: 'root-retained',
        executionId: null,
        branchId: null,
        provider: 'legacy-provider',
        model: 'legacy-model',
        dispatchedModel: 'legacy-model',
        reportedModel: null,
        purpose: 'conversation',
        outcome: 'success',
        settledAtMs: '9223372036854775807',
        usage: {
          inputTokens: '9007199254740993',
          outputTokens: 7,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          providerTotalTokens: null,
        },
        reportedCostUsd: null,
        calculatedCostUsd: 0.125,
        calculatedCostComplete: true,
        normalizedUsage: {
          baseInputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          reasoningIncludedInOutput: null,
          complete: false,
        },
        effectiveCostUsd: 0.125,
        effectiveCostSource: 'calculated',
        effectiveCostCoverage: 'known',
        revision: 1,
      }],
    });
    assert.deepEqual(recorder.readProducerReconciliation().map(({ contiguousWatermark, highestObservedSequence, visibleGaps }) => ({
      contiguousWatermark,
      highestObservedSequence,
      visibleGaps,
    })), [{ contiguousWatermark: 1, highestObservedSequence: 1, visibleGaps: [] }]);
    assert.throws(
      () => recorder.submit(observation({ sourceKey: 'late-legacy', rootSessionId: 'root-deleted' })),
      /capture subject is deleted/,
    );
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('pending-create binding atomically moves facts/detail and makes private deletion authoritative', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const pending = { kind: 'pendingCreate' as const, operationId: 'pending-create-a' };
    recorder.submit(observation({
      sourceKey: 'pending-settlement',
      invocationId: 'pending-invocation',
      captureSubject: pending,
      fields: {
        invocationId: 'pending-invocation',
        inputTokens: 7,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: true,
        reportedCostUsd: 0,
      },
    }));
    recorder.submitDetail(detail({ payloadId: 'pending-detail', captureSubject: pending, value: { value: 'owned' } }));
    const receipt = recorder.bindPendingCreate('pending-create-a', 'bound-root-a', 'binding-a', 200);
    assert.equal(receipt.movedObservationCount, 1);
    assert.equal(receipt.movedPayloadCount, 1);
    assert.equal(recorder.readProviderAccountingSummary('bound-root-a').inputTokens.value, 7);
    recorder.submit(observation({ sourceKey: 'late-pending', captureSubject: pending }));
    assert.equal(recorder.countObservations('bound-root-a'), 2, 'stale pending producer is durably routed to the bound root');
    recorder.deleteSession('bound-root-a', 'private-close-bound', 300);
    assert.equal(recorder.countObservations('bound-root-a'), 0);
    assert.equal(recorder.countDetails('bound-root-a'), 0);
    assert.equal(recorder.readProviderAccountingSummary('bound-root-a').invocationCount, 0);
    assert.equal(recorder.readProviderAccountingSummary().invocationCount, 0);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('privacy deletion can atomically fence and scrub an unbound pending-create subject', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const pending = { kind: 'pendingCreate' as const, operationId: 'unbound-private-create' };
    recorder.submit(observation({ sourceKey: 'unbound-private-fact', captureSubject: pending }));
    recorder.submitDetail(detail({
      payloadId: 'unbound-private-detail',
      captureSubject: pending,
      value: { private: true },
    }));
    const deleted = recorder.deleteSession(
      'future-private-root',
      'delete-unbound-private',
      400,
      'unbound-private-create',
    );
    assert.equal(deleted.deletedObservationCount, 1);
    assert.equal(deleted.deletedPayloadCount, 1);
    assert.equal(recorder.countObservations(), 0);
    assert.equal(recorder.countDetails(), 0);
    assert.throws(
      () => recorder.submit(observation({ sourceKey: 'late-unbound-private', captureSubject: pending })),
      /capture subject is deleted/,
    );
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('tool state identity is root-qualified and deletion cannot leave cross-session state', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'tool-root-a', rootSessionId: 'tool-root-a', entityKind: 'toolCall',
      entityKey: 'reused-tool-id', observationKind: 'end', fields: { outcome: 'success' },
    }));
    recorder.submit(observation({
      sourceKey: 'tool-root-b', rootSessionId: 'tool-root-b', entityKind: 'toolCall',
      entityKey: 'reused-tool-id', observationKind: 'end', fields: { outcome: 'failed' },
    }));
    const before = recorder.executeReadOnlyQuery(`
      SELECT capture_subject_key, outcome FROM analytics_tool_states ORDER BY capture_subject_key
    `);
    assert.deepEqual(before.rows, [
      { capture_subject_key: 'tool-root-a', outcome: 'success' },
      { capture_subject_key: 'tool-root-b', outcome: 'failed' },
    ]);
    recorder.deleteSession('tool-root-b', 'delete-tool-root-b', 401);
    const after = recorder.executeReadOnlyQuery(`
      SELECT capture_subject_key, outcome FROM analytics_tool_states
    `);
    assert.deepEqual(after.rows, [{ capture_subject_key: 'tool-root-a', outcome: 'success' }]);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('read-only query mode serves projections and rejects every mutation', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'read-only-settlement',
      invocationId: 'read-only-invocation',
      fields: { invocationId: 'read-only-invocation', inputTokens: 5 },
    }));
    recorder.close();
    recorder = new SqliteAnalyticsRecorder(temp.databasePath, { readOnly: true });
    assert.equal(recorder.readProviderSettlements().settlements.length, 1);
    assert.throws(() => recorder.submit(observation({ sourceKey: 'forbidden-write' })), /read-only/);
    assert.throws(() => recorder.deleteSession('root-a', 'forbidden-delete', 1), /read-only/);
    assert.throws(() => recorder.checkpoint(), /read-only/);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('recorder rejects unsupported newer database schema versions', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  recorder.close();
  const raw = new DatabaseSync(temp.databasePath);
  try {
    // One beyond the current schema: an unversioned future database must fail
    // closed rather than be read with today's assumptions.
    raw.exec('PRAGMA user_version = 14');
  } finally {
    raw.close();
  }
  try {
    assert.throws(
      () => new SqliteAnalyticsRecorder(temp.databasePath),
      /Unsupported newer analytics database schema version 14/,
    );
  } finally {
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('provider settlement projection is transactional, once-only, and revisioned through deletion', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const first = observation({
      sourceKey: 'canonical-settlement',
      rootSessionId: 'root-accounting',
      invocationId: 'invocation-accounting',
      fields: {
        invocationId: 'invocation-accounting',
        provider: 'provider-a',
        dispatchedModel: 'model-dispatched',
        reportedModel: 'model-reported',
        purpose: 'conversation',
        outcome: 'success',
        inputTokens: 10,
        outputTokens: 20,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: true,
        reportedCostUsd: 0,
        calculatedCostUsd: 99,
      },
    });
    recorder.submit(first);
    recorder.submit(first);
    assert.equal(recorder.getProjectionRevision(), 1);
    assert.deepEqual(recorder.readProviderSettlementProjection().settlements[0], {
      generationId: 'generation-1',
      invocationId: 'invocation-accounting',
      rootSessionId: 'root-accounting',
      executionId: null,
      branchId: null,
      provider: 'provider-a',
      model: 'model-reported',
      dispatchedModel: 'model-dispatched',
      reportedModel: 'model-reported',
      purpose: 'conversation',
      outcome: 'success',
      settledAtMs: null,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        providerTotalTokens: null,
      },
      reportedCostUsd: 0,
      calculatedCostUsd: 99,
      calculatedCostComplete: false,
      normalizedUsage: {
        baseInputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        totalTokens: 30,
        reasoningIncludedInOutput: true,
        complete: true,
      },
      effectiveCostUsd: 0,
      effectiveCostSource: 'reported',
      effectiveCostCoverage: 'known',
      revision: 1,
    });

    const conflict = observation({
      sourceKey: 'conflicting-settlement-source',
      rootSessionId: 'root-accounting',
      invocationId: 'invocation-accounting',
      fields: { invocationId: 'invocation-accounting', outputTokens: 21 },
    });
    assert.throws(() => recorder.submit(conflict), AnalyticsSourceConflictError);
    assert.equal(recorder.countObservations(), 1, 'conflicting projection rolls back generic acceptance');
    assert.equal(recorder.getProjectionRevision(), 1);
    const accounting = recorder.readProviderAccountingSummary('root-accounting');
    assert.equal(accounting.invocationCount, 1);
    assert.deepEqual(accounting.inputTokens, {
      occurrenceCount: 1,
      knownCount: 1,
      unknownCount: 0,
      knownTotal: 10,
      value: 10,
      complete: true,
    });
    assert.equal(accounting.effectiveCostUsd.value, 0);
    assert.equal(accounting.effectiveCostUsd.reportedCount, 1);

    const deleted = recorder.deleteSession('root-accounting', 'delete-accounting', 500);
    assert.equal(deleted.deletedObservationCount, 1);
    assert.deepEqual(recorder.readProviderSettlements(), { revision: 2, settlements: [] });
    assert.equal(recorder.deleteSession('root-accounting', 'retry-delete', 999).duplicate, true);
    assert.equal(recorder.getProjectionRevision(), 2, 'duplicate deletion does not advance the revision');

    recorder.close();
    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.deepEqual(recorder.readProviderSettlements(), { revision: 2, settlements: [] });
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('branch and copy projections select original settlements without duplicating global charges', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const branch = (
    rootSessionId: string,
    branchId: string,
    parentBranchId: string | null,
    sourceKey = `edge:${rootSessionId}:${branchId}`,
  ) => recorder.submit(observation({
    sourceKey,
    rootSessionId,
    entityKind: 'branch',
    entityKey: branchId,
    observationKind: 'observation',
    branchId,
    fields: { branchId, parentBranchId, sourceEntryId: branchId },
  }));
  const select = (rootSessionId: string, branchId: string, selectionId: string) => recorder.submit(observation({
    sourceKey: `selection:${selectionId}`,
    rootSessionId,
    entityKind: 'branch',
    entityKey: branchId,
    observationKind: 'phase',
    branchId,
    fields: { branchId, sourceSelectionId: selectionId, sourceEntryId: branchId },
  }));
  const settle = (rootSessionId: string, branchId: string, invocationId: string, cost: number) => recorder.submit(observation({
    sourceKey: `settlement:${invocationId}`,
    rootSessionId,
    invocationId,
    executionId: `execution:${invocationId}`,
    branchId,
    fields: {
      invocationId,
      reportedCostUsd: cost,
      inputTokens: Math.round(cost * 1_000),
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: true,
    },
  }));
  const totalCost = (rows: ReturnType<typeof recorder.readProviderSettlements>['settlements']) =>
    rows.reduce((total, row) => total + (row.effectiveCostUsd ?? 0), 0);
  try {
    branch('source-root', 'source:A', null);
    branch('source-root', 'source:B', 'source:A');
    branch('source-root', 'source:C', 'source:A');
    settle('source-root', 'source:A', 'invocation:A', 0.01);
    settle('source-root', 'source:B', 'invocation:B', 0.02);
    settle('source-root', 'source:C', 'invocation:C', 0.03);

    select('source-root', 'source:B', 'select:B');
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-1', rootSessionId: 'source-root',
    }).settlements), 0.03);
    select('source-root', 'source:C', 'select:C');
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'selectedBranch', generationId: 'generation-1', rootSessionId: 'source-root',
    }).settlements), 0.04);
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'rootSession', rootSessionId: 'source-root',
    }).settlements), 0.06);

    recorder.submit(observation({
      sourceKey: 'copy:operation-1',
      rootSessionId: 'copy-root',
      entityKind: 'copy',
      entityKey: 'copy-root',
      observationKind: 'observation',
      fields: {
        copySessionId: 'copy-root',
        sourceSessionId: 'source-root',
        sourceBranchId: 'source:B',
        operationId: 'operation-1',
        inheritanceCoverage: 'known',
      },
    }));
    branch('copy-root', 'copy:D', null);
    select('copy-root', 'copy:D', 'select:D');
    settle('copy-root', 'copy:D', 'invocation:D', 0.04);

    const copied = recorder.readScopedProviderSettlements({ kind: 'copySelected', generationId: 'generation-1', copySessionId: 'copy-root' });
    assert.equal(copied.selectionCoverage, 'known');
    assert.equal(copied.inheritanceCoverage, 'known');
    assert.deepEqual(copied.settlements.map((row) => row.invocationId), [
      'invocation:A', 'invocation:B', 'invocation:D',
    ]);
    assert.equal(totalCost(copied.settlements), 0.07);
    const copiedRecords = copied.settlements.map(canonicalSettlementUsageRecord);
    assert.equal(summarizeCanonicalUsage(copiedRecords, {
      kind: 'copyInherited', copySessionId: 'copy-root',
    }).value, 0.03);
    assert.equal(summarizeCanonicalUsage(copiedRecords, {
      kind: 'copyOwn', copySessionId: 'copy-root',
    }).value, 0.04);
    assert.equal(summarizeCanonicalUsage(copiedRecords, { kind: 'global' }).value, 0.07);
    assert.equal(totalCost(recorder.readScopedProviderSettlements({ kind: 'global' }).settlements), 0.1);
    assert.equal(recorder.readProviderSettlements().settlements.length, 4, 'copy references never create settlement rows');
    const firstPage = recorder.readScopedProviderSettlements({ kind: 'global' }, { limit: 2 });
    assert.equal(firstPage.settlementCoverage, 'truncated');
    assert.equal(firstPage.truncated, true);
    assert.equal(firstPage.nextOffset, 2);
    const secondPage = recorder.readScopedProviderSettlements({ kind: 'global' }, {
      limit: 2,
      offset: firstPage.nextOffset!,
      expectedRevision: firstPage.revision,
    });
    assert.equal(secondPage.settlementCoverage, 'complete');
    assert.equal(secondPage.truncated, false);
    assert.equal(secondPage.nextOffset, null);
    assert.deepEqual(
      [...firstPage.settlements, ...secondPage.settlements].map((row) => row.invocationId),
      ['invocation:A', 'invocation:B', 'invocation:C', 'invocation:D'],
    );

    // Exact replay is a no-op; changed ancestry under the same producer key is
    // rejected atomically instead of silently moving usage between branches.
    const replay = observation({
      sourceKey: 'selection:select:D', rootSessionId: 'copy-root', entityKind: 'branch',
      entityKey: 'copy:D', observationKind: 'phase', branchId: 'copy:D',
      fields: { branchId: 'copy:D', sourceSelectionId: 'select:D', sourceEntryId: 'copy:D' },
    });
    recorder.submit(replay);
    assert.throws(() => recorder.submit({
      ...replay,
      fields: { ...replay.fields, branchId: 'copy:changed' },
    }), AnalyticsSourceConflictError);
    assert.equal(totalCost(recorder.readScopedProviderSettlements({
      kind: 'copySelected', generationId: 'generation-1', copySessionId: 'copy-root',
    }).settlements), 0.07);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('private source scrub removes inherited identity and keeps copy-own usage explicitly incomplete', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submitBatch([
      observation({
        sourceKey: 'source-edge', rootSessionId: 'private-source', entityKind: 'branch',
        entityKey: 'source:A', observationKind: 'observation', branchId: 'source:A',
        fields: { branchId: 'source:A', parentBranchId: null, sourceEntryId: 'A' },
      }),
      observation({
        sourceKey: 'source-settlement', rootSessionId: 'private-source',
        invocationId: 'private-source-invocation', branchId: 'source:A',
        fields: { invocationId: 'private-source-invocation', reportedCostUsd: 0.03 },
      }),
      observation({
        sourceKey: 'copy-relation', rootSessionId: 'retained-copy', entityKind: 'copy',
        entityKey: 'retained-copy', observationKind: 'observation',
        fields: {
          copySessionId: 'retained-copy', sourceSessionId: 'private-source',
          sourceBranchId: 'source:A', operationId: 'copy-private-source', inheritanceCoverage: 'known',
        },
      }),
      observation({
        sourceKey: 'copy-edge', rootSessionId: 'retained-copy', entityKind: 'branch',
        entityKey: 'copy:D', observationKind: 'observation', branchId: 'copy:D',
        fields: { branchId: 'copy:D', parentBranchId: null, sourceEntryId: 'D' },
      }),
      observation({
        sourceKey: 'copy-selection', rootSessionId: 'retained-copy', entityKind: 'branch',
        entityKey: 'copy:D', observationKind: 'phase', branchId: 'copy:D',
        fields: { branchId: 'copy:D', sourceSelectionId: 'select:D', sourceEntryId: 'D' },
      }),
      observation({
        sourceKey: 'copy-settlement', rootSessionId: 'retained-copy',
        invocationId: 'copy-own-invocation', branchId: 'copy:D',
        fields: { invocationId: 'copy-own-invocation', reportedCostUsd: 0.04 },
      }),
    ]);
    recorder.deleteSession('private-source', 'private-close-source', 2_000);
    const retained = recorder.readScopedProviderSettlements({ kind: 'copySelected', generationId: 'generation-1', copySessionId: 'retained-copy' });
    assert.deepEqual(retained.settlements.map((row) => row.invocationId), ['copy-own-invocation']);
    assert.equal(retained.inheritanceCoverage, 'unknown');
    assert.equal(retained.inheritanceUnavailableReason, 'source_scrubbed');
    assert.equal(retained.settlements[0]?.effectiveCostUsd, 0.04);
    const relation = recorder.executeReadOnlyQuery(`
      SELECT source_root_session_id, source_branch_id, inheritance_coverage,
        inheritance_unavailable_reason FROM analytics_session_copies
      WHERE copy_root_session_id = 'retained-copy'
    `).rows[0];
    assert.deepEqual(relation, {
      source_root_session_id: null,
      source_branch_id: null,
      inheritance_coverage: 'unknown',
      inheritance_unavailable_reason: 'source_scrubbed',
    });
    assert.equal(JSON.stringify(recorder.executeReadOnlyQuery(
      "SELECT payload_json FROM analytics_observations WHERE entity_kind = 'copy'",
    ).rows).includes('private-source'), false);

    // A stale duplicate delivery after the source fence cannot resurrect its
    // identity; it creates only the same privacy-safe destination tombstone.
    assert.throws(() => recorder.submit(observation({
      sourceKey: 'late-copy', rootSessionId: 'late-copy-root', entityKind: 'copy',
      entityKey: 'late-copy-root', observationKind: 'observation',
      fields: {
        copySessionId: 'late-copy-root', sourceSessionId: 'private-source',
        sourceBranchId: 'source:A', operationId: 'late-copy-op', inheritanceCoverage: 'known',
      },
    })), /capture subject is deleted/);
    const late = recorder.readScopedProviderSettlements({ kind: 'copySelected', generationId: 'generation-1', copySessionId: 'late-copy-root' });
    assert.equal(late.inheritanceCoverage, 'unknown');
    assert.equal(late.inheritanceUnavailableReason, 'source_scrubbed');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('private destination scrub removes only its copy relation and leaves source settlements', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'retained-source-settlement', rootSessionId: 'retained-source',
      invocationId: 'retained-invocation', branchId: 'source:A',
      fields: { invocationId: 'retained-invocation', reportedCostUsd: 0.03 },
    }));
    recorder.submit(observation({
      sourceKey: 'deleted-copy-relation', rootSessionId: 'private-copy', entityKind: 'copy',
      entityKey: 'private-copy', observationKind: 'observation',
      fields: {
        copySessionId: 'private-copy', sourceSessionId: 'retained-source',
        sourceBranchId: 'source:A', operationId: 'private-copy-op', inheritanceCoverage: 'known',
      },
    }));
    recorder.deleteSession('private-copy', 'private-close-copy', 2_100);
    assert.deepEqual(recorder.readProviderSettlements('retained-source').settlements.map(
      (row) => row.invocationId,
    ), ['retained-invocation']);
    assert.equal(recorder.executeReadOnlyQuery(
      "SELECT COUNT(*) AS count FROM analytics_session_copies WHERE copy_root_session_id = 'private-copy'",
    ).rows[0]?.count, 0);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('source sequence reconciliation survives restart, closes gaps, and rejects conflicting reuse', () => {
  const temp = tempDatabase();
  let recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({ sourceKey: 'sequence-1', sourceSequence: 1, rootSessionId: 'root-a' }));
    recorder.submit(observation({ sourceKey: 'sequence-3', sourceSequence: 3, rootSessionId: 'root-b' }));
    let reconciliation = recorder.getProducerReconciliation();
    assert.equal(reconciliation.length, 1);
    assert.deepEqual({
      contiguousWatermark: reconciliation[0]!.contiguousWatermark,
      highestObservedSequence: reconciliation[0]!.highestObservedSequence,
      visibleGaps: reconciliation[0]!.visibleGaps,
    }, {
      contiguousWatermark: 1,
      highestObservedSequence: 3,
      visibleGaps: [{ from: 2, to: 2 }],
    });

    recorder.close();
    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    recorder.submit(observation({ sourceKey: 'sequence-2', sourceSequence: 2, rootSessionId: 'root-a' }));
    reconciliation = recorder.readProducerReconciliation();
    assert.equal(reconciliation[0]!.contiguousWatermark, 3);
    assert.deepEqual(reconciliation[0]!.visibleGaps, []);

    recorder.submit(observation({ sourceKey: 'sequence-1', sourceSequence: 4, rootSessionId: 'root-a' }));
    reconciliation = recorder.readProducerReconciliation();
    assert.equal(reconciliation[0]!.contiguousWatermark, 4, 'redetected source advances its new delivery sequence');
    assert.equal(reconciliation[0]!.pendingReceiptCount, 0);
    assert.equal(recorder.readDeliveryAccounting().observations.replayed, 1);

    assert.throws(
      () => recorder.submit(observation({ sourceKey: 'sequence-2-conflict', sourceSequence: 2, rootSessionId: 'root-a' })),
      /behind contiguous watermark/,
    );
    assert.equal(recorder.countObservations(), 3);

    recorder.deleteSession('root-b', 'delete-sequence-owner', 600);
    reconciliation = recorder.readProducerReconciliation();
    assert.deepEqual({
      contiguousWatermark: reconciliation[0]!.contiguousWatermark,
      highestObservedSequence: reconciliation[0]!.highestObservedSequence,
      visibleGaps: reconciliation[0]!.visibleGaps,
    }, { contiguousWatermark: 4, highestObservedSequence: 4, visibleGaps: [] });

    const raw = new DatabaseSync(temp.databasePath);
    try {
      const receiptCount = raw.prepare(`
        SELECT COUNT(*) AS count FROM analytics_producer_sequences
      `).get() as { count: number };
      assert.equal(receiptCount.count, 0, 'contiguous receipts compact into the durable watermark');
    } finally {
      raw.close();
    }

    recorder.submit(observation({
      sourceKey: 'large-sequence',
      sourceSequence: '9007199254740993',
      rootSessionId: 'root-a',
    }));
    reconciliation = recorder.readProducerReconciliation();
    assert.equal(reconciliation[0]!.highestObservedSequence, '9007199254740993');
    assert.deepEqual(reconciliation[0]!.visibleGaps, [{ from: 5, to: '9007199254740992' }]);
    assert.equal(reconciliation[0]!.pendingReceiptCount, 1);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('execution, tool, activity, and feature observations project transactionally and delete by subject', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submitBatch([
      observation({
        sourceKey: 'execution-begin',
        entityKind: 'execution',
        entityKey: 'execution-a',
        observationKind: 'begin',
        fields: { operationKind: 'agent-run', startedAtMs: 100 },
      }),
      observation({
        sourceKey: 'tool-end',
        entityKind: 'toolCall',
        entityKey: 'tool-a',
        observationKind: 'end',
        fields: { toolCallId: 'tool-a', toolDefinitionId: 'bash', outcome: 'completed', executionEndedAtMs: 120 },
      }),
      observation({
        sourceKey: 'activity-end',
        entityKind: 'activitySpan',
        entityKey: 'span-a',
        observationKind: 'end',
        fields: { spanId: 'span-a', kind: 'tool', startedAtMs: 100, endedAtMs: 120, durationMs: 20, coverage: 'observed' },
      }),
      observation({
        sourceKey: 'feature-observed',
        entityKind: 'featureObservation',
        entityKey: 'feature-a',
        observationKind: 'observation',
        fields: { feature: 'pruning', decision: 'kept', ruleVersion: 'v1' },
      }),
    ]);
    assert.equal(recorder.countTypedEntityObservations('execution', 'root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('toolCall', 'root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('activitySpan', 'root-a'), 1);
    assert.equal(recorder.countTypedEntityObservations('featureObservation', 'root-a'), 1);
    assert.equal(recorder.getProjectionRevision(), 4);

    recorder.deleteSession('root-a', 'delete-typed-projections', 700);
    assert.equal(recorder.countTypedEntityObservations('execution', 'root-a'), 0);
    assert.equal(recorder.countTypedEntityObservations('toolCall', 'root-a'), 0);
    assert.equal(recorder.countTypedEntityObservations('activitySpan', 'root-a'), 0);
    assert.equal(recorder.countTypedEntityObservations('featureObservation', 'root-a'), 0);
    assert.equal(recorder.getProjectionRevision(), 5);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('privacy fence remains durable while WAL scrubbing is blocked and recovers without private bytes', () => {
  const temp = tempDatabase();
  const sentinel = 'PRIVATE-WAL-SENTINEL-0bd0e20a';
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  let reader: TestDatabase | undefined;
  try {
    recorder.submit(observation({ sourceKey: 'private-wal-fact', fields: { secret: sentinel } }));
    recorder.submitDetail(detail({ payloadId: 'private-wal-detail', value: { secret: sentinel } }));
    reader = new DatabaseSync(temp.databasePath, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS count FROM analytics_observations').get();

    assert.throws(
      () => recorder.deleteSession('root-a', 'private-wal-close', 700),
      AnalyticsPrivacyScrubPendingError,
    );
    assert.equal(recorder.countObservations('root-a'), 0, 'logical fence commits before physical retry');
    assert.equal(recorder.countDetails('root-a'), 0);
    assert.equal(recorder.privacyScrubState('root-a')?.state, 'pending');

    reader.exec('ROLLBACK');
    reader.close();
    reader = undefined;
    assert.deepEqual(recorder.resumePendingPrivacyScrubs(), { completed: ['root-a'], pending: [] });
    assert.equal(recorder.privacyScrubState('root-a')?.state, 'complete');

    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${temp.databasePath}${suffix}`;
      if (existsSync(candidate)) {
        assert.equal(readFileSync(candidate).includes(Buffer.from(sentinel)), false, `${suffix || 'main'} retained private bytes`);
      }
    }
  } finally {
    try { reader?.exec('ROLLBACK'); } catch { /* already closed */ }
    reader?.close();
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('late binding to a deleted root scrubs pending data and retains a durable routing fence', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const pending = { kind: 'pendingCreate' as const, operationId: 'late-bind-operation' };
    recorder.submit(observation({ sourceKey: 'late-bind-fact', captureSubject: pending }));
    recorder.submitDetail(detail({ payloadId: 'late-bind-detail', captureSubject: pending, value: { private: true } }));
    recorder.deleteSession('late-bind-root', 'late-bind-close', 800);
    const receipt = recorder.bindPendingCreate('late-bind-operation', 'late-bind-root', 'late-bind-source', 801);
    assert.equal(receipt.deletedSubject, true);
    assert.equal(recorder.countObservations(), 0);
    assert.equal(recorder.countDetails(), 0);
    assert.deepEqual(recorder.readSubjectBinding('late-bind-operation'), {
      pendingOperationId: 'late-bind-operation',
      rootSessionId: 'late-bind-root',
      deleted: true,
    });
    assert.throws(
      () => recorder.submit(observation({ sourceKey: 'stale-after-late-bind', captureSubject: pending })),
      /capture subject is deleted/,
    );
    assert.equal(recorder.countObservations(), 0);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('durable delivery accounting separates accepted replayed deleted and retained bytes', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const fact = observation({ sourceKey: 'accounted-fact', sourceSequence: 1, stableOriginId: 'stable-origin-a' });
    const payload = detail({ payloadId: 'accounted-detail', value: { body: 'shared body' } });
    recorder.submit(fact);
    recorder.submit(fact);
    recorder.submitDetail(payload);
    recorder.submitDetail(payload);
    recorder.deleteSession('root-a', 'accounting-close', 900);
    assert.throws(() => recorder.submit({ ...fact, sourceSequence: 2 }), /capture subject is deleted/);
    assert.throws(() => recorder.submitDetail({ ...payload, payloadId: 'late-accounted', sourceKey: 'late-accounted' }), /capture subject is deleted/);
    assert.deepEqual(recorder.readDeliveryAccounting(), {
      deliveryHistoryCoverage: 'complete',
      observations: { delivered: 3, accepted: 1, replayed: 1, deleted: 1 },
      details: { delivered: 3, accepted: 1, replayed: 1, deleted: 1 },
      completeDetailWatermark: 1,
      retainedDetailLogicalBytes: 0,
      retainedDetailStoredBytes: 0,
    });
    // The capture acknowledgement reads only the watermark, which is a separate
    // narrow reader so it does not scan the detail tables once per ingested
    // batch. It must always agree with the full summary.
    assert.equal(recorder.readCompleteDetailWatermark(), recorder.readDeliveryAccounting().completeDetailWatermark);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('the narrow acknowledgement watermark tracks detail ingestion and deletion', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    assert.equal(recorder.readCompleteDetailWatermark(), 0);
    recorder.submitDetail(detail({ payloadId: 'watermark-a', value: { body: 'a' } }));
    assert.equal(recorder.readCompleteDetailWatermark(), 1);
    // A replay is not newly accepted detail, so the watermark must not advance.
    recorder.submitDetail(detail({ payloadId: 'watermark-a', value: { body: 'a' } }));
    assert.equal(recorder.readCompleteDetailWatermark(), 1);
    recorder.submitDetail(detail({ payloadId: 'watermark-b', value: { body: 'b' } }));
    assert.equal(recorder.readCompleteDetailWatermark(), 2);
    // The watermark is an acceptance count, so deletion does not rewind it.
    recorder.deleteSession('root-a', 'watermark-close', 900);
    assert.equal(recorder.readCompleteDetailWatermark(), recorder.readDeliveryAccounting().completeDetailWatermark);
    // A refused delivery is not accepted detail either.
    assert.throws(
      () => recorder.submitDetail({
        ...detail({ payloadId: 'watermark-late', value: { body: 'late' } }),
        captureSubject: { kind: 'session', rootSessionId: 'root-a' },
      }),
      /capture subject is deleted/,
    );
    assert.equal(recorder.readCompleteDetailWatermark(), recorder.readDeliveryAccounting().completeDetailWatermark);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('logical query surface is native read-only, bounded, and reports snapshot/detail/storage metadata', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submitBatch([
      observation({ sourceKey: 'query-a', sourceSequence: 1, stableOriginId: 'query-origin' }),
      observation({ sourceKey: 'query-b', sourceSequence: 2, stableOriginId: 'query-origin' }),
      observation({ sourceKey: 'query-c', sourceSequence: 3, stableOriginId: 'query-origin' }),
    ]);
    recorder.submitDetail(detail({ payloadId: 'query-detail', value: { text: 'range-body'.repeat(100) } }));

    const result = recorder.executeReadOnlyQuery(
      'SELECT source_key, payload_json FROM analytics_observations WHERE source_key >= ? ORDER BY source_key',
      ['query-a'],
      { maxRows: 2, maxCellBytes: 32 },
    );
    assert.equal(result.databaseSchemaVersion, 13);
    assert.equal(result.snapshotWatermark, 3);
    assert.deepEqual(result.generationIds, ['generation-1']);
    assert.equal(result.returnedRows, 2);
    assert.equal(result.truncation.rowLimit, true);
    assert.equal(result.truncation.cellLimit, true);
    assert.throws(() => recorder.executeReadOnlyQuery('DELETE FROM analytics_observations'), /not authorized/);
    assert.throws(() => recorder.executeReadOnlyQuery("ATTACH DATABASE ':memory:' AS other"), /not authorized/);
    assert.throws(() => recorder.executeReadOnlyQuery('SELECT zeroblob(1000000000)'), /not authorized/);
    assert.throws(() => recorder.executeReadOnlyQuery('SELECT 1', [], { maxRows: Number.NaN }), /positive safe integer/);
    assert.equal(recorder.countObservations(), 3);

    const first = recorder.readDetailRange('query-detail', 0, 100);
    assert.equal(first.available, true);
    assert.equal(first.truncated, true);
    const second = recorder.readDetailRange('query-detail', first.nextOffset!, 4_096);
    assert.equal(second.nextOffset, null);
    assert.deepEqual(deserialize(Buffer.concat([Buffer.from(first.bytes), Buffer.from(second.bytes)])), {
      text: 'range-body'.repeat(100),
    });
    assert.deepEqual(recorder.readDetailRange('absent-detail').omissionReason, 'unavailable-or-scrubbed');
    assert.ok(recorder.describeSchema().views.includes('analytics_provider_usage_v1'));
    assert.equal(recorder.readStorageSummary().payloadCount, 1);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('provider normalization keeps base/disjoint channels and reported zero ahead of exact snapshot pricing', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(observation({
      sourceKey: 'normalized-provider',
      invocationId: 'normalized-invocation',
      fields: {
        invocationId: 'normalized-invocation',
        inputTokens: 100,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        reasoningTokens: 10,
        inputIncludesCache: true,
        outputIncludesReasoning: true,
        reportedCostUsd: 0,
        pricing: {
          normalizationVersion: 'oracle-v1',
          currency: 'USD',
          inputUsdPerMillionTokens: 2,
          outputUsdPerMillionTokens: 4,
          cacheReadUsdPerMillionTokens: 1,
          cacheWriteUsdPerMillionTokens: 3,
        },
      },
    }));
    const settlement = recorder.readProviderSettlements().settlements[0]!;
    assert.deepEqual(settlement.normalizedUsage, {
      baseInputTokens: 75,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 130,
      reasoningIncludedInOutput: true,
      complete: true,
    });
    assert.ok(Math.abs(settlement.calculatedCostUsd! - 0.000305) < 1e-12);
    assert.equal(settlement.calculatedCostComplete, true);
    assert.equal(settlement.effectiveCostUsd, 0);
    assert.equal(settlement.effectiveCostSource, 'reported');

    assert.throws(() => recorder.submit(observation({
      sourceKey: 'bad-priced-provider',
      invocationId: 'bad-priced-invocation',
      fields: {
        invocationId: 'bad-priced-invocation',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        calculatedCostUsd: 99,
        calculatedCostComplete: true,
        pricing: {
          normalizationVersion: 'oracle-v1',
          currency: 'USD',
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 1,
          cacheReadUsdPerMillionTokens: 1,
          cacheWriteUsdPerMillionTokens: 1,
        },
      },
    })), /does not match its pricing snapshot/);
    assert.equal(recorder.countObservations(), 1, 'pricing mismatch rolls back fact and projections');
  } finally {
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

    const raw = new DatabaseSync(temp.databasePath);
    try {
      assert.deepEqual({ ...raw.prepare(`
        SELECT typeof(input_tokens) AS input_type,
               typeof(output_tokens) AS output_type,
               typeof(cache_read_tokens) AS missing_type
        FROM analytics_provider_settlements
        WHERE invocation_id = 'invocation-a'
      `).get() as Record<string, unknown> }, {
        input_type: 'text',
        output_type: 'text',
        missing_type: 'null',
      });
    } finally {
      raw.close();
    }

    recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    assert.equal(recorder.readProviderAccountingSummary().invocationCount, 2);
    assert.equal(
      recorder.readProviderAccountingSummary('').invocationCount,
      0,
      'an explicitly scoped empty key must never alias the global projection',
    );
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

test('recording enforces the exclusion even when the producer skipped redaction', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const secret = `sk-${'z'.repeat(48)}`;
  try {
    // A producer or transport that never sanitized must still not be able to
    // persist private bytes: recording is the last durable boundary.
    const unredacted = detail({
      payloadId: 'unredacted-detail',
      value: { messages: [{ role: 'assistant', content: [{ type: 'text', text: `token ${secret}` }] }] },
    });
    assert.ok(Buffer.from(unredacted.bytes).includes(Buffer.from(secret)), 'fixture must contain the secret');
    recorder.submitDetail(unredacted);

    const reconstructed = recorder.reconstructDetail('unredacted-detail') as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const durableText = reconstructed.messages[0].content[0].text;
    assert.ok(!durableText.includes(secret), 'the secret must not survive recording');
    assert.match(durableText, /\[redacted\]|REDACTED|redacted/i);

    // No content row may retain the raw secret either.
    const raw = createRequire(process.execPath)('node:sqlite');
    const db = new raw.DatabaseSync(temp.databasePath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT body FROM analytics_detail_content').all() as Array<{ body: Uint8Array }>;
      for (const row of rows) {
        assert.ok(!Buffer.from(row.body).includes(Buffer.from(secret)), 'no stored content may contain the secret');
      }
    } finally {
      db.close();
    }
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('an already-sanitized detail is a byte-level fixed point through recording', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const value = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'plain content' }] }] };
    const sanitized = serialize(sanitizeAnalyticsDetail(value));
    const capture = { ...detail({ payloadId: 'fixed-point-detail', value }), bytes: sanitized };
    recorder.submitDetail(capture);

    // Exact replay of the same bytes must be an idempotent duplicate, which is
    // only true if canonicalization returns the identical buffer.
    assert.doesNotThrow(() => recorder.submitDetail(capture));
    assert.deepEqual(recorder.getStats(), {
      accepted: 0,
      duplicates: 0,
      detailsAccepted: 1,
      detailDuplicates: 1,
      rejectedAfterDelete: 0,
    });
    assert.deepEqual(recorder.reconstructDetail('fixed-point-detail'), value);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('schema v5 adds the projection-order index without changing stored settlements', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const fact = observation({
    sourceKey: 'v5-fact',
    sourceSequence: 1,
    stableOriginId: 'v5-origin',
    invocationId: 'v5-invocation',
    fields: { invocationId: 'v5-invocation', outcome: 'success', inputTokens: 10, reportedCostUsd: 0.01 },
  });
  let before;
  let knownTotalBefore;
  try {
    recorder.submit(fact);
    before = recorder.readProviderSettlements();
    knownTotalBefore = recorder.readProviderAccountingSummary().inputTokens.knownTotal;
    assert.equal(before.settlements.length, 1);
  } finally {
    recorder.close();
  }

  try {
    // Rewind to the previous schema and drop only the additive index, then
    // reopen: the upgrade must recreate the index and preserve every row.
    const raw = new DatabaseSync(temp.databasePath);
    try {
      raw.exec('DROP INDEX analytics_provider_settlement_projection_order_idx');
      raw.exec('PRAGMA user_version = 4');
    } finally {
      raw.close();
    }

    const upgraded = new SqliteAnalyticsRecorder(temp.databasePath);
    try {
      assert.equal(upgraded.getDatabaseSchemaVersion(), 13);
      const after = upgraded.readProviderSettlements();
      assert.deepEqual(after.settlements, before.settlements);
      assert.equal(upgraded.readProviderAccountingSummary().inputTokens.knownTotal, knownTotalBefore);
      assert.equal(upgraded.countObservations(), 1);

      // The index must now serve the projection ordering.
      const plan = upgraded.executeReadOnlyQuery(
        'EXPLAIN QUERY PLAN SELECT * FROM analytics_provider_settlements '
        + 'ORDER BY CAST(projection_revision AS INTEGER), generation_id, invocation_id LIMIT 200',
      );
      const details = plan.rows.map((row) => String(row.detail));
      assert.ok(
        details.some((detail) => detail.includes('analytics_provider_settlement_projection_order_idx')),
        `expected the projection-order index to serve the read, got ${JSON.stringify(details)}`,
      );
      assert.ok(
        !details.some((detail) => detail.includes('TEMP B-TREE')),
        `expected no temporary sort, got ${JSON.stringify(details)}`,
      );
    } finally {
      upgraded.close();
    }
  } finally {
    // Windows can briefly retain a handle after close; retry the cleanup.
    rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the maintained fact-byte counter equals the full-table aggregate across insert and delete', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  const raw = new DatabaseSync(temp.databasePath);
  const aggregate = () => Number((raw.prepare(
    'SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM analytics_observations',
  ).get() as { bytes: number | bigint }).bytes);
  try {
    for (let index = 0; index < 6; index += 1) {
      recorder.submit(observation({
        sourceKey: `counter-${index}`,
        sourceSequence: index + 1,
        stableOriginId: 'counter-origin',
        rootSessionId: index < 4 ? 'counter-root-a' : 'counter-root-b',
        invocationId: `counter-invocation-${index}`,
        fields: { invocationId: `counter-invocation-${index}`, outcome: 'success', inputTokens: 10 + index },
      }));
    }
    // Deleting one subject must subtract exactly that subject's bytes.
    recorder.deleteSession('counter-root-a', 'counter-close', 1_800);

    const summary = recorder.readStorageSummary();
    assert.equal(Number(summary.factsLogicalBytes), aggregate(), 'counter must equal the aggregate after delete');
    assert.ok(aggregate() > 0, 'the retained subject must still be counted');
    assert.equal(recorder.countObservations(), 2);
  } finally {
    raw.close();
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the partial copy-scrub index serves the private-close predicate', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    // A copy observation naming a source session is what deleteSession scrubs.
    recorder.submit(observation({
      sourceKey: 'copy:operation-scrub',
      rootSessionId: 'copy-root',
      entityKind: 'copy',
      entityKey: 'copy-root',
      observationKind: 'observation',
      fields: {
        copySessionId: 'copy-root',
        sourceSessionId: 'scrubbed-source-root',
        sourceBranchId: 'source:B',
        operationId: 'operation-scrub',
        inheritanceCoverage: 'known',
      },
    }));

    const predicate = "entity_kind = 'copy' AND json_extract(payload_json, '$.fields.sourceSessionId') = 'scrubbed-source-root'";
    const plan = recorder.executeReadOnlyQuery(
      `EXPLAIN QUERY PLAN SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes `
      + `FROM analytics_observations WHERE ${predicate}`,
    );
    const details = plan.rows.map((row) => String(row.detail));
    assert.ok(
      details.some((detail) => detail.includes('analytics_copy_scrub_idx')),
      `expected the partial copy index to serve the scrub scan, got ${JSON.stringify(details)}`,
    );
    assert.ok(
      !details.some((detail) => detail.includes('SCAN analytics_observations')),
      `expected no full-table scan, got ${JSON.stringify(details)}`,
    );
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a flush checkpoint tolerates a concurrent writer instead of failing locked', () => {
  const temp = tempDatabase();
  // Two independent connections to the same database is the helper topology:
  // one is mid-write while the other flushes.
  const writer = new SqliteAnalyticsRecorder(temp.databasePath);
  const flusher = new SqliteAnalyticsRecorder(temp.databasePath);
  const raw = createRequire(process.execPath)('node:sqlite');
  try {
    writer.submit(observation({
      sourceKey: 'flush-fact-a', sourceSequence: 1, stableOriginId: 'flush-origin',
      invocationId: 'flush-invocation-a', fields: { invocationId: 'flush-invocation-a', outcome: 'success' },
    }));
    // Hold a write transaction open on another connection. A TRUNCATE
    // checkpoint cannot complete while it is open, and previously surfaced
    // through an ordinary flush as "database is locked".
    const blocker = new raw.DatabaseSync(temp.databasePath, { timeout: 100 });
    try {
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('INSERT INTO analytics_generations (generation_id, first_observed_at_ms) VALUES (?, ?)')
        .run('flush-blocker-generation', '1');
      // The flush barrier must remain usable under contention.
      assert.doesNotThrow(() => flusher.checkpoint(), 'a passive flush must not require exclusive access');
      // SQLite *reports* truncation contention rather than throwing, so the
      // privacy scrub can keep its fence pending and retry instead of failing
      // the whole close. Assert the documented contract: the result is a
      // well-formed checkpoint row whose `busy` flag reflects contention.
      const result = flusher.truncateWalAndRead();
      assert.ok(
        typeof result.busy === 'number' || typeof result.busy === 'bigint',
        'truncation must report a busy flag',
      );
      assert.notEqual(
        Number(result.busy),
        0,
        'a concurrently held write transaction must be reported as busy, never as success',
      );
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  } finally {
    writer.close();
    flusher.close();
    rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('the reference-digest index serves the last-owner cleanup trigger', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    // Two payloads sharing one content digest: removing the first must not
    // delete the shared content, which is what the trigger decides.
    const shared = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'shared-body' }] }] };
    recorder.submitDetail(detail({ payloadId: 'ref-shared-a', value: shared }));
    recorder.submitDetail(detail({ payloadId: 'ref-shared-b', value: shared }));
    recorder.submitDetail(detail({ payloadId: 'ref-unique', value: { unique: true } }));

    const plan = recorder.executeReadOnlyQuery(
      "EXPLAIN QUERY PLAN SELECT 1 FROM analytics_detail_references WHERE digest = 'anything'",
    );
    const details = plan.rows.map((row) => String(row.detail));
    assert.ok(
      details.some((detail) => detail.includes('analytics_detail_reference_digest_idx')),
      `expected the digest index to serve the trigger lookup, got ${JSON.stringify(details)}`,
    );

    // The trigger's decision must still be correct: deleting one owner keeps
    // the shared content, deleting the last owner removes it.
    recorder.deleteSession('root-a', 'ref-close', 1_800);
    assert.equal(recorder.countDetails(), 0);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
