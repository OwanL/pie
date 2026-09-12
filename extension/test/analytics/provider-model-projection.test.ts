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
import { readProviderModelGroups } from '../../src/analytics/provider-model-projection.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

interface RawDatabase {
  close(): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
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
