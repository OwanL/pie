import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serialize } from 'node:v8';
import { createRequire } from 'node:module';

import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSourceConflictError,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsDetailCapture,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { localCalendarDayKey, localCalendarWeekDateKeys } from '../../../shared/analytics/metrics.js';
import {
  PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_STATEMENT_KEYS,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
} from '../../src/analytics/provider-model-projection.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

const PROJECTION_KEY_LIST = Object.values(PROVIDER_PROJECTION_STATEMENT_KEYS);
const PROJECTION_TEXT = {
  stateRead: PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
  totalsRead: PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
  totalsUpsert: PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
  totalsDelete: PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
  dailyRead: PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
  dailyUpsert: PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
  dailyDelete: PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
} as const;
const WRITE_PATH_KEYS = [
  PROVIDER_PROJECTION_STATEMENT_KEYS.dailyStateRead,
  PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryRead,
  PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryUpsert,
  PROVIDER_PROJECTION_STATEMENT_KEYS.dailySummaryRead,
  PROVIDER_PROJECTION_STATEMENT_KEYS.dailySummaryUpsert,
];
const PROJECTION_SQL_TEXTS = [
  PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
];

interface RawSqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface RawSqliteDatabase {
  close(): void;
  prepare(sql: string): RawSqliteStatement;
}
interface RawSqliteDatabaseCtor {
  prototype: { prepare: (this: RawSqliteDatabase, sql: string) => RawSqliteStatement };
  new (location: string, options?: { readOnly?: boolean }): RawSqliteDatabase;
}

function providerObservation(options: {
  sourceKey: string;
  invocationId: string;
  reportedCostUsd?: number;
  inputTokens?: number;
  rootSessionId?: string;
  captureSubject?: AnalyticsObservation['captureSubject'];
  settledAtMs?: number;
  purpose?: string;
  outcome?: string;
  effectiveCostCoverage?: 'known' | 'unknown' | 'not_applicable';
  omitUsage?: boolean;
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
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.settledAtMs === undefined ? {} : { settledAtMs: options.settledAtMs }),
      ...(options.effectiveCostCoverage === undefined ? {} : { effectiveCostCoverage: options.effectiveCostCoverage }),
      ...(options.omitUsage ? {} : {
        ...(options.reportedCostUsd === undefined ? {} : { reportedCostUsd: options.reportedCostUsd }),
        ...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: true,
      }),
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

interface FixtureSettlement {
  index: number;
  root: string;
  purpose?: string;
  input: number | null;
  cost: number | null;
  costCoverage?: 'known' | 'unknown' | 'not_applicable';
  settledAtMs: number | null;
  missingUsage?: boolean;
  outcome?: string;
}

const DAY_MS = 86_400_000;
const WINDOW_START = Date.UTC(2024, 2, 9);
const WINDOW_END = Date.UTC(2024, 2, 23);
const TODAY_DAY = localCalendarDayKey(Date.UTC(2024, 2, 12), 'UTC');
const WEEK_DAYS = new Set(localCalendarWeekDateKeys(Date.UTC(2024, 2, 12), 'UTC'));

function fixtureList(): FixtureSettlement[] {
  const fixtures: FixtureSettlement[] = [];
  for (let index = 0; index < 10_100; index++) {
    if (index === 96) {
      fixtures.push({ index, root: 'root-u', input: 7, cost: 0.75, settledAtMs: null });
    } else if (index === 97) {
      fixtures.push({ index, root: 'root-f', input: null, cost: null, settledAtMs: null, missingUsage: true, outcome: 'failed' });
    } else if (index === 98) {
      fixtures.push({
        index, root: 'root-c', input: 30, cost: null, costCoverage: 'not_applicable',
        settledAtMs: Date.UTC(2024, 2, 12, 12), outcome: 'cancelled',
      });
    } else {
      fixtures.push({
        index,
        root: `root-${index % 5}`,
        ...(index % 5 === 0 ? { purpose: 'ephemeral' } : {}),
        input: 10 + (index % 97),
        cost: ((index % 4) + 1) / 4,
        settledAtMs: Date.UTC(2024, 2, 10) + (index % 5) * DAY_MS + (index % 3) * 3_600_000,
      });
    }
  }
  fixtures.push({ index: 10_100, root: 'root-post', input: 11, cost: 1.25, settledAtMs: Date.UTC(2024, 2, 13, 6) });
  fixtures.push({ index: 10_101, root: 'root-late', input: 44, cost: 1.5, settledAtMs: Date.UTC(2024, 2, 13, 7) });
  fixtures.push({ index: 10_102, root: 'root-reopen', input: 21, cost: 0.5, settledAtMs: Date.UTC(2024, 2, 13, 8) });
  return fixtures;
}

function observationOf(fixture: FixtureSettlement): AnalyticsObservation {
  return providerObservation({
    sourceKey: `bulk-source-${fixture.index}`,
    invocationId: `bulk-invocation-${fixture.index}`,
    ...(fixture.cost === null ? {} : { reportedCostUsd: fixture.cost }),
    ...(fixture.missingUsage || fixture.input === null ? {} : { inputTokens: fixture.input }),
    rootSessionId: fixture.root,
    ...(fixture.purpose === undefined ? {} : { purpose: fixture.purpose }),
    ...(fixture.outcome === undefined ? {} : { outcome: fixture.outcome }),
    ...(fixture.settledAtMs === null ? {} : { settledAtMs: fixture.settledAtMs }),
    ...(fixture.costCoverage === undefined ? {} : { effectiveCostCoverage: fixture.costCoverage }),
    ...(fixture.missingUsage ? { omitUsage: true } : {}),
  });
}

interface ExpectedBookkeeping {
  retained: number;
  roots: number;
  inputTotal: string;
  costTotal: number;
  weekInput: string;
  weekCost: number;
  todayInput: string;
  todayCost: number;
}

function expectedBookkeeping(fixtures: FixtureSettlement[], retained: (fixture: FixtureSettlement) => boolean): ExpectedBookkeeping {
  let inputTotal = 0n;
  let costTotal = 0;
  let weekInput = 0n;
  let weekCost = 0;
  let todayInput = 0n;
  let todayCost = 0;
  const roots = new Set<string>();
  for (const fixture of fixtures) {
    if (!retained(fixture)) continue;
    roots.add(fixture.root);
    if (fixture.input !== null) inputTotal += BigInt(fixture.input);
    if (fixture.cost !== null) costTotal += fixture.cost;
    if (fixture.settledAtMs === null) continue;
    const day = localCalendarDayKey(fixture.settledAtMs, 'UTC');
    if (!WEEK_DAYS.has(day)) continue;
    if (fixture.input !== null) weekInput += BigInt(fixture.input);
    if (fixture.cost !== null) weekCost += fixture.cost;
    if (day !== TODAY_DAY) continue;
    if (fixture.input !== null) todayInput += BigInt(fixture.input);
    if (fixture.cost !== null) todayCost += fixture.cost;
  }
  return {
    retained: fixtures.filter(retained).length,
    roots: roots.size,
    inputTotal: inputTotal.toString(),
    costTotal,
    weekInput: weekInput.toString(),
    weekCost,
    todayInput: todayInput.toString(),
    todayCost,
  };
}

let parityReads = 0;

function assertLedgerParity(recorder: SqliteAnalyticsRecorder, expected: ExpectedBookkeeping): void {
  parityReads += 1;
  const accounting = recorder.readProviderAccountingSummary();
  assert.equal(accounting.invocationCount, expected.retained);
  assert.equal(Number(accounting.inputTokens.knownTotal), Number(expected.inputTotal));
  assert.equal(Number(accounting.effectiveCostUsd.knownTotal), expected.costTotal);
  const aggregate = recorder.readProviderAggregateSummary({
    todayStartMs: Date.UTC(2024, 2, 12),
    todayEndMs: Date.UTC(2024, 2, 13),
    weekStartMs: WINDOW_START,
    weekEndMs: WINDOW_END,
    timeZone: 'UTC',
    dailyWindowStartMs: WINDOW_START,
    dailyWindowEndMs: WINDOW_END,
  });
  assert.equal(aggregate.groups.length, 1);
  const group = aggregate.groups[0]!;
  assert.equal(group.provider, 'statement-reuse-provider');
  assert.equal(group.model, 'statement-reuse-model');
  assert.equal(group.session_count, expected.roots);
  assert.equal(group.all_input, expected.inputTotal);
  assert.equal(group.all_cost, expected.costTotal);
  assert.equal(group.week_input, expected.weekInput);
  assert.equal(group.week_cost, expected.weekCost);
  assert.equal(group.today_input, expected.todayInput);
  assert.equal(group.today_cost, expected.todayCost);
}

interface ExpectedChannelSummary { knownCount: string; unknownCount: string; knownTotal: string }
interface ExpectedSummary {
  occurrenceCount: string;
  channels: Record<string, ExpectedChannelSummary>;
  cost: {
    knownCount: string; unknownCount: string; unpricedCount: string;
    reportedCount: string; calculatedCount: string; knownTotal: number;
  };
  instrumentationGapCount: string;
}

const CHANNEL_COLUMNS: Array<[channel: string, column: string]> = [
  ['inputTokens', 'normalized_base_input_tokens'],
  ['outputTokens', 'normalized_output_tokens'],
  ['cacheReadTokens', 'normalized_cache_read_tokens'],
  ['cacheWriteTokens', 'normalized_cache_write_tokens'],
  ['reasoningTokens', 'reasoning_tokens'],
  ['providerTotalTokens', 'normalized_total_tokens'],
];

function emptyExpectedSummary(): ExpectedSummary {
  return {
    occurrenceCount: '0',
    channels: Object.fromEntries(CHANNEL_COLUMNS.map(([channel]) => [channel, {
      knownCount: '0', unknownCount: '0', knownTotal: '0',
    }])) as ExpectedSummary['channels'],
    cost: {
      knownCount: '0', unknownCount: '0', unpricedCount: '0',
      reportedCount: '0', calculatedCount: '0', knownTotal: 0,
    },
    instrumentationGapCount: '0',
  };
}

function bump(value: string, direction: 1 | -1): string {
  return (BigInt(value) + BigInt(direction)).toString();
}

function accumulateLedgerRow(expected: ExpectedSummary, row: Record<string, unknown>): void {
  expected.occurrenceCount = bump(expected.occurrenceCount, 1);
  let anyMissing = false;
  for (const [channel, column] of CHANNEL_COLUMNS) {
    const target = expected.channels[channel]!;
    const value = row[column];
    if (value === null || value === undefined) {
      anyMissing = true;
      target.unknownCount = bump(target.unknownCount, 1);
    } else {
      target.knownCount = bump(target.knownCount, 1);
      target.knownTotal = (BigInt(target.knownTotal) + BigInt(String(value))).toString();
    }
  }
  const cost = row.effective_cost_usd;
  if (cost === null || cost === undefined) {
    anyMissing = true;
    if (row.effective_cost_coverage === 'not_applicable') expected.cost.unpricedCount = bump(expected.cost.unpricedCount, 1);
    else expected.cost.unknownCount = bump(expected.cost.unknownCount, 1);
  } else {
    expected.cost.knownCount = bump(expected.cost.knownCount, 1);
    expected.cost.knownTotal += Number(cost);
    if (row.effective_cost_source === 'reported') expected.cost.reportedCount = bump(expected.cost.reportedCount, 1);
    else if (row.effective_cost_source === 'calculated') expected.cost.calculatedCount = bump(expected.cost.calculatedCount, 1);
  }
  if (anyMissing) expected.instrumentationGapCount = bump(expected.instrumentationGapCount, 1);
}

test('bounds all seven projection statements to one cached prepare per connection across 100 and 10000 settlements', () => {
  const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as { DatabaseSync: RawSqliteDatabaseCtor };
  const originalPrepare = DatabaseSync.prototype.prepare;
  const prepareCounts = new Map<string, number>();
  const snapshot = () => new Map(prepareCounts);
  let writePathProjectionPrepares = 0;
  const expectProjectionDeltas = (before: Map<string, number>, expected: Partial<Record<keyof typeof PROJECTION_TEXT, number>>) => {
    let phaseTotal = 0;
    for (const [name, sql] of Object.entries(PROJECTION_TEXT)) {
      const actual = (prepareCounts.get(sql) ?? 0) - (before.get(sql) ?? 0);
      const wanted = expected[name as keyof typeof PROJECTION_TEXT] ?? 0;
      assert.equal(actual, wanted, `${name} projection prepares`);
      phaseTotal += wanted;
    }
    writePathProjectionPrepares += phaseTotal;
  };
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-projection-reuse-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const otherPath = path.join(root, 'other.sqlite');
  const fixtures = fixtureList();
  const retainedAfterDeletion = (fixture: FixtureSettlement) => fixture.root !== 'root-0';
  const statementCacheOf = (recorder: SqliteAnalyticsRecorder) => (recorder as unknown as {
    writerStatements: {
      getStats(): { entries: number; keys: readonly string[] };
      prepare(key: string, sql: string): unknown;
    };
  }).writerStatements;
  const assertBudget = (label: string, recorder: SqliteAnalyticsRecorder, keys: readonly string[]) => {
    const cache = statementCacheOf(recorder).getStats();
    assert.equal(cache.entries <= 68, true, `${label}: cache total ${cache.entries} must stay <= 68`);
    for (const key of keys) {
      assert.equal(cache.keys.includes(key), true, `${label}: projection key ${key} must be cached`);
    }
  };
  const parityRequest = {
    todayStartMs: Date.UTC(2024, 2, 12),
    todayEndMs: Date.UTC(2024, 2, 13),
    weekStartMs: WINDOW_START,
    weekEndMs: WINDOW_END,
    timeZone: 'UTC',
    dailyWindowStartMs: WINDOW_START,
    dailyWindowEndMs: WINDOW_END,
  } as const;
  const bookkeepingThrough = (count: number, retained: (fixture: FixtureSettlement) => boolean = () => true) =>
    expectedBookkeeping(fixtures.slice(0, count), retained);

  DatabaseSync.prototype.prepare = function (this: RawSqliteDatabase, sql: string): RawSqliteStatement {
    prepareCounts.set(sql, (prepareCounts.get(sql) ?? 0) + 1);
    return originalPrepare.call(this, sql);
  };
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  try {
    // Phase 1: 100 settlements (95 dated across five days, one undated, one
    // failed with missing usage, one cancelled unpriced) plus the daily
    // preparation rebuild. Every projection statement is prepared once.
    let before = snapshot();
    recorder.submitBatch(fixtures.slice(0, 100).map(observationOf));
    recorder.prepareProviderDailyProjection('UTC', WINDOW_START, WINDOW_END);
    expectProjectionDeltas(before, {
      stateRead: 1, totalsRead: 1, totalsUpsert: 1, dailyRead: 1, dailyUpsert: 1,
      totalsDelete: 0, dailyDelete: 0,
    });
    assert.equal(writePathProjectionPrepares, 5);
    assertBudget('after 100 settlements', recorder, WRITE_PATH_KEYS);
    assert.deepEqual(recorder.getStats(), {
      accepted: 100, duplicates: 0, detailsAccepted: 0, detailDuplicates: 0, rejectedAfterDelete: 0,
    });
    assertLedgerParity(recorder, bookkeepingThrough(100));

    // Idempotent replay: the ordinary, failed and cancelled settlements each
    // replay exactly once and leave every maintained total unchanged.
    before = snapshot();
    recorder.submit(observationOf(fixtures[0]!));
    recorder.submit(observationOf(fixtures[97]!));
    recorder.submit(observationOf(fixtures[98]!));
    expectProjectionDeltas(before, {});
    assert.deepEqual(recorder.getStats(), {
      accepted: 100, duplicates: 3, detailsAccepted: 0, detailDuplicates: 0, rejectedAfterDelete: 0,
    });
    assertLedgerParity(recorder, bookkeepingThrough(100));

    // Phase 2: 10000 further settlements on the same database and connection.
    // The projection budget must not grow at all with the settlement count.
    before = snapshot();
    for (let start = 100; start < 10_100; start += 500) {
      recorder.submitBatch(fixtures.slice(start, start + 500).map(observationOf));
    }
    expectProjectionDeltas(before, {});
    assertLedgerParity(recorder, bookkeepingThrough(10_100));
    assert.equal(writePathProjectionPrepares, 5);

    // Rolled-back conflicting batch: totals and accounting stay at the
    // pre-batch snapshot, and the cached statements keep working afterwards.
    const preRollback = bookkeepingThrough(10_100);
    before = snapshot();
    assert.throws(
      () => recorder.submitBatch([
        providerObservation({ sourceKey: 'rollback-fresh', invocationId: 'rollback-invocation', reportedCostUsd: 1, inputTokens: 10 }),
        providerObservation({ sourceKey: 'rollback-conflict', invocationId: 'rollback-invocation', reportedCostUsd: 9, inputTokens: 90 }),
      ]),
      AnalyticsSourceConflictError,
    );
    assert.deepEqual(recorder.getStats(), {
      accepted: 10_100, duplicates: 3, detailsAccepted: 0, detailDuplicates: 0, rejectedAfterDelete: 0,
    });
    expectProjectionDeltas(before, {});
    assertLedgerParity(recorder, preRollback);

    // The same cached statements keep working after the rollback.
    before = snapshot();
    recorder.submit(observationOf(fixtures[10_100]!));
    expectProjectionDeltas(before, {});
    assertLedgerParity(recorder, bookkeepingThrough(10_101));

    // Guard checks: the key/SQL allowlist is closed and collision-checked.
    assert.throws(
      () => statementCacheOf(recorder).prepare('projection.bogus.key', 'SELECT 1'),
      /Unknown analytics writer statement key/u,
    );
    assert.throws(
      () => statementCacheOf(recorder).prepare(PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryRead, 'SELECT 1'),
      /changed SQL/u,
    );

    // Deletion: root-0 owns the 'ephemeral' dimension exclusively, so the
    // private close drives both dimension rows to zero and prepares each
    // delete statement exactly once. Cumulative projection prepares for this
    // connection stay bounded at 7.
    before = snapshot();
    recorder.deleteSession('root-0', 'statement-reuse-close', Date.UTC(2024, 4, 1));
    expectProjectionDeltas(before, { totalsDelete: 1, dailyDelete: 1 });
    // Cumulative write-path projection prepares on this connection stay
    // bounded at exactly 7; the six rollup texts were each prepared once and
    // the state read only grows on the raw read path (one per parity read).
    assert.equal(writePathProjectionPrepares, 7);
    for (const sql of [
      PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
      PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
      PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
      PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
      PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
      PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
    ]) {
      assert.equal(prepareCounts.get(sql), 1);
    }
    assert.equal(prepareCounts.get(PROVIDER_PROJECTION_DAILY_STATE_READ_SQL), 1 + parityReads);
    // The privacy fence cleared the whole cache at the end of the deletion.
    assert.equal(statementCacheOf(recorder).getStats().entries, 0);
    assertLedgerParity(recorder, bookkeepingThrough(10_101, retainedAfterDeletion));

    // The same connection keeps working after the fence; the projection
    // statements are re-prepared cleanly into the cleared cache.
    before = snapshot();
    recorder.submit(observationOf(fixtures[10_101]!));
    expectProjectionDeltas(before, {
      stateRead: 1, totalsRead: 1, totalsUpsert: 1, dailyRead: 1, dailyUpsert: 1,
    });
    assertBudget('after post-deletion settlement', recorder, WRITE_PATH_KEYS);
    assertLedgerParity(recorder, bookkeepingThrough(10_102, retainedAfterDeletion));
  } finally {
    assert.doesNotThrow(() => recorder.close());
    assert.doesNotThrow(() => recorder.close());
    DatabaseSync.prototype.prepare = originalPrepare;
  }

  // Ledger-driven oracle: every maintained summary must equal the summary
  // recomputed from the retained settlements table itself.
  const retainedFinal = fixtures.slice(0, 10_102).filter(retainedAfterDeletion);
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const dimensionOf = (row: Record<string, unknown>): string =>
      `${row.provider_key ?? ''}\u0000${row.model_key ?? ''}\u0000${row.purpose_key ?? ''}\u0000${row.workspace_coverage ?? ''}\u0000${row.workspace_key ?? ''}`;
    const ledgerRows = raw.prepare(`
      SELECT provider, effective_model, purpose, workspace_coverage, workspace_key, settled_at_ms,
        normalized_base_input_tokens, normalized_output_tokens, normalized_cache_read_tokens,
        normalized_cache_write_tokens, reasoning_tokens, normalized_total_tokens,
        effective_cost_usd, effective_cost_source, effective_cost_coverage
      FROM analytics_provider_settlements
    `).all() as Array<Record<string, unknown>>;
    assert.equal(ledgerRows.length, retainedFinal.length);
    const totalsExpected = new Map<string, ExpectedSummary>();
    const dailyExpected = new Map<string, ExpectedSummary>();
    for (const row of ledgerRows) {
      const dimension = dimensionOf({
        provider_key: row.provider, model_key: row.effective_model, purpose_key: row.purpose,
        workspace_coverage: row.workspace_coverage, workspace_key: row.workspace_key,
      });
      const totals = totalsExpected.get(dimension) ?? emptyExpectedSummary();
      accumulateLedgerRow(totals, row);
      totalsExpected.set(dimension, totals);
      const day = row.settled_at_ms === null ? 'undated' : localCalendarDayKey(String(row.settled_at_ms), 'UTC');
      const dailyKey = `UTC\u0000${day}\u0000${dimension}`;
      const daily = dailyExpected.get(dailyKey) ?? emptyExpectedSummary();
      accumulateLedgerRow(daily, row);
      dailyExpected.set(dailyKey, daily);
    }
    const totalsRows = raw.prepare(`
      SELECT provider_key, model_key, purpose_key, workspace_coverage, workspace_key, summary_json
      FROM analytics_provider_model_totals
    `).all() as Array<Record<string, unknown>>;
    assert.equal(totalsRows.length, totalsExpected.size);
    for (const row of totalsRows) {
      assert.deepEqual(JSON.parse(String(row.summary_json)), totalsExpected.get(dimensionOf(row)));
    }
    const dailyRows = raw.prepare(`
      SELECT time_zone, local_day, provider_key, model_key, purpose_key, workspace_coverage, workspace_key, summary_json
      FROM analytics_provider_model_daily
    `).all() as Array<Record<string, unknown>>;
    assert.equal(dailyRows.length, dailyExpected.size);
    for (const row of dailyRows) {
      const key = `${row.time_zone}\u0000${row.local_day}\u0000${dimensionOf(row)}`;
      assert.deepEqual(JSON.parse(String(row.summary_json)), dailyExpected.get(key));
    }
  } finally {
    raw.close();
  }

  // Reopen: the new connection gets its own cache, reads the persisted totals
  // unchanged, and re-prepares the five write-path projection statements fresh.
  DatabaseSync.prototype.prepare = function (this: RawSqliteDatabase, sql: string): RawSqliteStatement {
    prepareCounts.set(sql, (prepareCounts.get(sql) ?? 0) + 1);
    return originalPrepare.call(this, sql);
  };
  const reopened = new SqliteAnalyticsRecorder(databasePath);
  try {
    assertLedgerParity(reopened, bookkeepingThrough(10_102, retainedAfterDeletion));
    const before = snapshot();
    reopened.submit(observationOf(fixtures[10_102]!));
    expectProjectionDeltas(before, {
      stateRead: 1, totalsRead: 1, totalsUpsert: 1, dailyRead: 1, dailyUpsert: 1,
    });
    assertBudget('after reopened settlement', reopened, WRITE_PATH_KEYS);
    assertLedgerParity(reopened, bookkeepingThrough(10_103, retainedAfterDeletion));
  } finally {
    assert.doesNotThrow(() => reopened.close());
    DatabaseSync.prototype.prepare = originalPrepare;
  }

  // A second recorder on a different database shares nothing.
  const other = new SqliteAnalyticsRecorder(otherPath);
  try {
    assert.equal(other.readProviderSettlements().settlements.length, 0);
    assert.equal(other.readProviderAccountingSummary().invocationCount, 0);
  } finally {
    assert.doesNotThrow(() => other.close());
    rmSync(root, { recursive: true, force: true });
  }
});
