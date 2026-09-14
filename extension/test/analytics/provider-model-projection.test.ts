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
import { localCalendarDayKey, localCalendarWeekDateKeys } from '../../../shared/analytics/metrics.js';
import {
  readProviderModelGroups,
  applyProviderProjection,
  createProviderProjectionSchema,
  prepareProviderDailyProjection,
  rebuildProviderProjection,
  PROVIDER_PROJECTION_STATEMENT_KEYS,
  PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
  type ProviderProjectionDatabase,
  type ProviderProjectionSettlement,
} from '../../src/analytics/provider-model-projection.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

interface RawDatabase {
  close(): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

interface ProjectionHandleStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): Iterable<unknown>;
}

interface ProjectionHandleDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): ProjectionHandleStatement;
}

const projectionSqlite = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => ProjectionHandleDatabase;
};

/** Records every raw prepare while delegating to a real in-memory database. */
class RecordingProjectionDatabase {
  readonly rawPreparedSql: string[] = [];
  constructor(private readonly inner: ProjectionHandleDatabase) {}
  exec(sql: string): void { this.inner.exec(sql); }
  prepare(sql: string) {
    this.rawPreparedSql.push(sql);
    return this.inner.prepare(sql);
  }
}

/** Structural stand-in for the recorder's writer statement cache: records the
 * exact (key, sql) requests and executes them against the real database. */
function recordingStatementSource(inner: ProjectionHandleDatabase) {
  const requested: Array<{ key: string; sql: string }> = [];
  return {
    requested,
    prepare(key: string, sql: string) {
      requested.push({ key, sql });
      return inner.prepare(sql);
    },
  };
}

const PROJECTION_SQL_TEXTS = [
  PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_READ_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL,
  PROVIDER_PROJECTION_DAILY_SUMMARY_UPSERT_SQL,
  PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
];

function projectionSettlement(overrides: Partial<ProviderProjectionSettlement> = {}): ProviderProjectionSettlement {
  return {
    provider: 'provider-a',
    model: 'model-a',
    purpose: 'conversation',
    settledAtMs: String(Date.UTC(2024, 2, 11, 6)),
    workspaceKey: 'workspace-a',
    workspaceCoverage: 'known',
    inputTokens: '10',
    outputTokens: '5',
    cacheReadTokens: '1',
    cacheWriteTokens: '1',
    reasoningTokens: null,
    providerTotalTokens: '17',
    effectiveCostUsd: 0.25,
    effectiveCostSource: 'reported',
    effectiveCostCoverage: 'known',
    ...overrides,
  };
}

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => RawDatabase;
};

function settlement(options: {
  sourceKey: string;
  invocationId: string;
  rootSessionId?: string;
  settledAtMs?: number | null;
  workspaceCoverage?: 'known' | 'unknown' | 'not_applicable';
  workspaceId?: string;
  purpose?: string;
  inputTokens?: number | string;
  providerTotalTokens?: number | string;
  reportedCostUsd?: number;
  effectiveCostCoverage?: 'known' | 'unknown' | 'not_applicable';
  completeTokens?: boolean;
}): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const base: Omit<AnalyticsObservation, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'projection-test-generation',
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: 'providerCall',
    entityKey: options.invocationId,
    observationKind: 'providerSettlement',
    observedAtMs: options.settledAtMs ?? 1_700_000_000_000,
    scope: {
      workspaceCoverage: options.workspaceCoverage ?? 'known',
      ...(options.workspaceCoverage === 'unknown' ? {} : { workspaceId: options.workspaceId ?? 'workspace-a' }),
      rootSessionId,
      invocationId: options.invocationId,
    },
    captureSubject: { kind: 'session', rootSessionId },
    producer: { buildId: 'projection-test', processGeneration: 'projection-test-process' },
    fields: {
      invocationId: options.invocationId,
      provider: 'provider-a',
      dispatchedModel: 'model-a',
      purpose: options.purpose ?? 'conversation',
      outcome: 'succeeded',
      settledAtMs: options.settledAtMs ?? null,
      inputTokens: options.inputTokens ?? 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      providerTotalTokens: options.providerTotalTokens
        ?? (typeof options.inputTokens === 'string'
          ? (BigInt(options.inputTokens) + 7n).toString()
          : (options.inputTokens ?? 10) + 7),
      ...(options.completeTokens ? {
        inputIncludesCache: false,
        outputIncludesReasoning: true,
        cacheChannelsOmittedAsZero: false,
      } : {}),
      ...(options.reportedCostUsd === undefined ? {} : { reportedCostUsd: options.reportedCostUsd }),
      ...(options.effectiveCostCoverage === undefined ? {} : { effectiveCostCoverage: options.effectiveCostCoverage }),
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function tempDatabase(): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-provider-projection-'));
  return { root, file: path.join(root, 'analytics.sqlite') };
}

test('provider/model projection preserves dimensions, uses numeric time index, and reverses close', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.file);
  try {
    const start = Date.UTC(2024, 2, 9);
    const end = Date.UTC(2024, 2, 18);
    recorder.submitBatch([
      settlement({ sourceKey: 'known', invocationId: 'known', settledAtMs: Date.UTC(2024, 2, 10, 6), reportedCostUsd: 0.25 }),
      settlement({ sourceKey: 'unknown', invocationId: 'unknown', rootSessionId: 'root-b', settledAtMs: Date.UTC(2024, 2, 10, 12), workspaceCoverage: 'unknown', reportedCostUsd: 0.5 }),
      settlement({ sourceKey: 'undated', invocationId: 'undated', settledAtMs: null, purpose: 'retry' }),
      settlement({
        sourceKey: 'large', invocationId: 'large', settledAtMs: Date.UTC(2024, 2, 11, 6),
        inputTokens: '9007199254740993', providerTotalTokens: '9007199254741000', completeTokens: true,
      }),
      settlement({
        sourceKey: 'unpriced', invocationId: 'unpriced', settledAtMs: Date.UTC(2024, 2, 11, 7),
        effectiveCostCoverage: 'not_applicable',
      }),
    ]);
    recorder.prepareProviderDailyProjection('America/New_York', start, end);
    recorder.prepareProviderDailyProjection('America/New_York', start, end);

    const aggregate = recorder.readProviderAggregateSummary({
      todayStartMs: Date.UTC(2024, 2, 10, 5), todayEndMs: Date.UTC(2024, 2, 11, 4),
      weekStartMs: start, weekEndMs: end, timeZone: 'America/New_York', dailyWindowStartMs: start, dailyWindowEndMs: end,
    });
    assert.equal(aggregate.groups.length, 1);
    assert.equal(aggregate.groups[0]?.all_cost, 0.75);
    assert.equal(aggregate.groups[0]?.all_input, '9007199254740993');
    assert.equal(aggregate.groups[0]?.all_unpriced, 1);
    assert.equal(aggregate.groups[0]?.today_cost, 0.75);
    assert.equal(aggregate.groups[0]?.week_cost, 0.75);
    assert.throws(() => recorder.readProviderAggregateSummary({
      todayStartMs: start, todayEndMs: end, weekStartMs: start, weekEndMs: end, timeZone: 'UTC',
    }), /not prepared/u);

    recorder.deleteSession('root-a', 'projection-delete', Date.UTC(2024, 3, 1));
    const afterDelete = recorder.readProviderAggregateSummary({
      todayStartMs: start, todayEndMs: end, weekStartMs: start, weekEndMs: end, timeZone: 'America/New_York',
      dailyWindowStartMs: start, dailyWindowEndMs: end,
    });
    assert.equal(afterDelete.groups[0]?.all_cost, 0.5);
    assert.equal(afterDelete.groups[0]?.session_count, 1);
  } finally {
    recorder.close();
  }

  const raw = new DatabaseSync(temp.file);
  try {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN
      SELECT rowid FROM analytics_provider_settlements
      WHERE settled_at_ms IS NOT NULL
        AND CAST(settled_at_ms AS INTEGER) >= ?
        AND CAST(settled_at_ms AS INTEGER) < ?`).all(0, Date.now()) as Array<{ detail?: string }>;
    assert.ok(plan.some((row) => String(row.detail).includes('analytics_provider_settlement_settled_at_int_idx')));
  } finally {
    raw.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('projection grouping sums multiple valid int64 rows beyond the int64 total range exactly', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.file);
  const day = Date.UTC(2024, 2, 11);
  try {
    recorder.submitBatch([
      settlement({
        sourceKey: 'int64-a', invocationId: 'int64-a', settledAtMs: day,
        inputTokens: '9007199254740993', providerTotalTokens: '9007199254741000', completeTokens: true,
      }),
      settlement({
        sourceKey: 'int64-b', invocationId: 'int64-b', settledAtMs: day + 1_000,
        inputTokens: '9223372036854775790', providerTotalTokens: '9223372036854775797', completeTokens: true,
      }),
    ]);
    recorder.prepareProviderDailyProjection('UTC', day - 86_400_000, day + 86_400_000);
  } finally {
    recorder.close();
  }
  const raw = new DatabaseSync(temp.file);
  try {
    const projection = readProviderModelGroups(raw as unknown as Parameters<typeof readProviderModelGroups>[0], {
      timeZone: 'UTC',
      todayDay: localCalendarDayKey(day, 'UTC'),
      weekDays: localCalendarWeekDateKeys(day, 'UTC'),
      maxGroups: 10,
      windowStartMs: String(day - 86_400_000),
      windowEndMs: String(day + 86_400_000),
    });
    assert.equal(projection.rows[0]?.all_input, '9232379236109516783');
  } finally {
    raw.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('undated projection rows survive an explicit timezone migration and reverse on close', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.file);
  const start = Date.UTC(2024, 2, 9);
  const end = Date.UTC(2024, 2, 18);
  try {
    recorder.submit(settlement({ sourceKey: 'undated-zone', invocationId: 'undated-zone', settledAtMs: null }));
    recorder.prepareProviderDailyProjection('America/New_York', start, end);
    recorder.prepareProviderDailyProjection('UTC', start, end, true);
    recorder.deleteSession('root-a', 'undated-zone-close', Date.UTC(2024, 3, 1));
  } finally {
    recorder.close();
  }
  const raw = new DatabaseSync(temp.file);
  try {
    const undated = raw.prepare(`
      SELECT time_zone, summary_json
      FROM analytics_provider_model_daily
      WHERE local_day = 'undated'
    `).all() as Array<{ time_zone?: string; summary_json?: string }>;
    assert.deepEqual(undated, []);
  } finally {
    raw.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('projection write path uses the structural statement source with fixed keys while migration and read paths stay raw', () => {
  const inner = new projectionSqlite.DatabaseSync(':memory:');
  const recording = new RecordingProjectionDatabase(inner);
  const source = recordingStatementSource(inner);
  const rawOnlyContainsNoneOf = (sqlTexts: string[], rawSql: string[]) => {
    for (const sql of sqlTexts) assert.equal(rawSql.includes(sql), false, `unexpected raw prepare of projection SQL`);
  };
  try {
    // Minimal source table: createProviderProjectionSchema alters and indexes
    // analytics_provider_settlements, so the standalone fixture provides the
    // settlement columns the projection scans.
    inner.exec(`
      CREATE TABLE analytics_provider_settlements (
        root_session_id TEXT,
        observation_registry_key TEXT,
        provider TEXT,
        effective_model TEXT,
        purpose TEXT,
        settled_at_ms TEXT,
        workspace_key TEXT NOT NULL DEFAULT '',
        workspace_coverage TEXT NOT NULL DEFAULT 'unknown',
        normalized_base_input_tokens TEXT,
        normalized_output_tokens TEXT,
        normalized_cache_read_tokens TEXT,
        normalized_cache_write_tokens TEXT,
        reasoning_tokens TEXT,
        normalized_total_tokens TEXT,
        effective_cost_usd REAL,
        effective_cost_source TEXT,
        effective_cost_coverage TEXT
      )
    `);
    createProviderProjectionSchema(recording);

    // Steady-state write path with a statement source: every projection statement
    // is requested through the source under its fixed key with its exact SQL.
    applyProviderProjection(recording, projectionSettlement(), '1', 1, true, source);
    const expectedFirstRequests: Array<{ key: string; sql: string }> = [
      { key: PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryRead, sql: PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL },
      { key: PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryUpsert, sql: PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL },
      { key: PROVIDER_PROJECTION_STATEMENT_KEYS.dailyStateRead, sql: PROVIDER_PROJECTION_DAILY_STATE_READ_SQL },
    ];
    assert.deepEqual(source.requested, expectedFirstRequests);
    rawOnlyContainsNoneOf(PROJECTION_SQL_TEXTS, recording.rawPreparedSql);

    // Seed the source table with one undated and one dated settlement so the
    // rebuild replays them through the statement source.
    inner.exec(`
      INSERT INTO analytics_provider_settlements (
        provider, effective_model, purpose, settled_at_ms, workspace_key, workspace_coverage,
        normalized_base_input_tokens, normalized_output_tokens, normalized_cache_read_tokens,
        normalized_cache_write_tokens, reasoning_tokens, normalized_total_tokens,
        effective_cost_usd, effective_cost_source, effective_cost_coverage
      ) VALUES
        ('provider-a', 'model-a', 'conversation', NULL, 'workspace-a', 'known',
         '10', '5', '1', '1', NULL, '17', 0.25, 'reported', 'known'),
        ('provider-a', 'model-a', 'conversation', '${Date.UTC(2024, 2, 11, 6)}', 'workspace-a', 'known',
         '10', '5', '1', '1', NULL, '17', 0.25, 'reported', 'known')
    `);
    prepareProviderDailyProjection(
      recording,
      'UTC',
      String(Date.UTC(2024, 2, 9)),
      String(Date.UTC(2024, 2, 18)),
      '2',
      false,
      source,
    );
    rawOnlyContainsNoneOf(PROJECTION_SQL_TEXTS, recording.rawPreparedSql);

    // The daily summary read/upsert pair is first requested while seeding the
    // undated bucket during the rebuild.
    assert.ok(source.requested.some((request) => request.key === PROVIDER_PROJECTION_STATEMENT_KEYS.dailySummaryRead));
    assert.ok(source.requested.some((request) => request.key === PROVIDER_PROJECTION_STATEMENT_KEYS.dailySummaryUpsert));

    // Repeat a separate dimension and reverse it to zero so the delete
    // statements are requested once each, still only through the source.
    const requestedBeforeReverse = source.requested.length;
    applyProviderProjection(recording, projectionSettlement({ provider: 'provider-b', model: 'model-b' }), '2', 1, true, source);
    applyProviderProjection(recording, projectionSettlement({ provider: 'provider-b', model: 'model-b' }), '3', 1, true, source);
    applyProviderProjection(recording, projectionSettlement({ provider: 'provider-b', model: 'model-b' }), '4', -1, true, source);
    applyProviderProjection(recording, projectionSettlement({ provider: 'provider-b', model: 'model-b' }), '5', -1, true, source);
    const newRequests: Array<{ key: string; sql: string }> = source.requested.slice(requestedBeforeReverse);
    assert.deepEqual(
      newRequests.filter((request) => request.key === PROVIDER_PROJECTION_STATEMENT_KEYS.totalsSummaryDelete).map((request) => request.sql),
      [PROVIDER_PROJECTION_TOTALS_SUMMARY_DELETE_SQL],
    );
    assert.deepEqual(
      newRequests.filter((request) => request.key === PROVIDER_PROJECTION_STATEMENT_KEYS.dailySummaryDelete).map((request) => request.sql),
      [PROVIDER_PROJECTION_DAILY_SUMMARY_DELETE_SQL],
    );
    rawOnlyContainsNoneOf(PROJECTION_SQL_TEXTS, recording.rawPreparedSql);
    // Reversing to zero removed the maintained rows for the reversed dimension.
    const remaining = inner.prepare(`SELECT COUNT(*) AS count FROM analytics_provider_model_totals WHERE provider_key = 'provider-b'`).get() as { count: number };
    assert.equal(Number(remaining.count), 0);

    // Without a statement source (migration/rebuild path) the same fixed texts
    // are prepared raw, exactly as owned by the constants.
    applyProviderProjection(recording, projectionSettlement(), '5', 1);
    for (const sql of [
      PROVIDER_PROJECTION_DAILY_STATE_READ_SQL,
      PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL,
      PROVIDER_PROJECTION_TOTALS_SUMMARY_UPSERT_SQL,
    ]) {
      assert.equal(recording.rawPreparedSql.includes(sql), true, `expected raw prepare of ${sql}`);
    }
    rebuildProviderProjection(recording);
    assert.equal(recording.rawPreparedSql.includes(PROVIDER_PROJECTION_TOTALS_SUMMARY_READ_SQL), true);

    // The read path keeps preparing its dynamic SQL raw even on the same
    // database; the source never sees it.
    const requestedBeforeRead = source.requested.length;
    const rawCountBeforeRead = recording.rawPreparedSql.length;
    readProviderModelGroups(recording as unknown as Parameters<typeof readProviderModelGroups>[0], {
      timeZone: 'UTC',
      todayDay: localCalendarDayKey(Date.UTC(2024, 2, 11), 'UTC'),
      weekDays: localCalendarWeekDateKeys(Date.UTC(2024, 2, 11), 'UTC'),
      maxGroups: 10,
      windowStartMs: String(Date.UTC(2024, 2, 9)),
      windowEndMs: String(Date.UTC(2024, 2, 18)),
    });
    assert.equal(source.requested.length, requestedBeforeRead);
    assert.equal(recording.rawPreparedSql.length > rawCountBeforeRead, true);
    assert.equal(recording.rawPreparedSql.includes(PROVIDER_PROJECTION_DAILY_STATE_READ_SQL), true);
  } finally {
    inner.close();
  }
});

test('same-zone calendar rollover replaces dated rows while retaining undated state', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.file);
  const firstStart = Date.UTC(2024, 2, 9);
  const firstEnd = Date.UTC(2024, 2, 12);
  const secondStart = Date.UTC(2024, 2, 11);
  const secondEnd = Date.UTC(2024, 2, 14);
  try {
    recorder.submitBatch([
      settlement({ sourceKey: 'rollover-dated', invocationId: 'rollover-dated', settledAtMs: Date.UTC(2024, 2, 10, 6) }),
      settlement({ sourceKey: 'rollover-undated', invocationId: 'rollover-undated', settledAtMs: null }),
    ]);
    recorder.prepareProviderDailyProjection('America/New_York', firstStart, firstEnd);
    recorder.prepareProviderDailyProjection('America/New_York', secondStart, secondEnd);
  } finally {
    recorder.close();
  }
  const raw = new DatabaseSync(temp.file);
  try {
    const rows = raw.prepare(`
      SELECT local_day, summary_json
      FROM analytics_provider_model_daily
      WHERE time_zone = 'America/New_York'
      ORDER BY local_day
    `).all() as Array<{ local_day?: string; summary_json?: string }>;
    assert.equal(rows.length > 0, true);
    assert.equal(rows.some((row) => row.local_day === 'undated'), true);
    assert.equal(rows.some((row) => row.local_day === '2024-03-10'), false);
  } finally {
    raw.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});
