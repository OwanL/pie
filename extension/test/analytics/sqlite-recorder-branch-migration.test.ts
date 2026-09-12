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
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

interface RawDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): { get(...parameters: unknown[]): unknown };
}

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string) => RawDatabase;
};

function legacyProvider(sourceKey: string, invocationId: string, inputTokens: number): AnalyticsObservation {
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: 'legacy-generation',
    producerKind: 'legacy-test',
    stableOriginId: 'legacy-origin',
    sourceKey,
    entityKind: 'providerCall' as const,
    entityKey: invocationId,
    observationKind: 'providerSettlement' as const,
    observedAtMs: 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'legacy-workspace',
      rootSessionId: 'legacy-root',
      invocationId,
    },
    captureSubject: { kind: 'session' as const, rootSessionId: 'legacy-root' },
    producer: { buildId: 'legacy-build', processGeneration: 'legacy-process' },
    fields: {
      invocationId,
      provider: 'legacy-provider',
      dispatchedModel: 'legacy-model',
      purpose: 'conversation',
      outcome: 'success',
      inputTokens,
      outputTokens: 11,
      cacheReadTokens: null,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      cacheChannelsOmittedAsZero: false,
      calculatedCostUsd: 0.25,
      calculatedCostComplete: true,
      coverage: 'known',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function downgradeV4ToV3(raw: RawDatabase): void {
  raw.exec(`
    DROP VIEW analytics_provider_usage_v1;
    DROP INDEX analytics_provider_settlement_branch_idx;
    DROP INDEX analytics_branch_edge_subject_idx;
    DROP INDEX analytics_branch_edge_root_idx;
    DROP INDEX analytics_branch_selection_subject_idx;
    DROP INDEX analytics_current_branch_root_idx;
    DROP INDEX analytics_session_copy_subject_idx;
    DROP INDEX analytics_session_copy_source_idx;
    DROP TABLE analytics_branch_edges;
    DROP TABLE analytics_branch_selections;
    DROP TABLE analytics_current_branch_selections;
    DROP TABLE analytics_session_copies;
    ALTER TABLE analytics_provider_settlements DROP COLUMN execution_id;
    ALTER TABLE analytics_provider_settlements DROP COLUMN branch_id;
    CREATE VIEW analytics_provider_usage_v1 AS
      SELECT generation_id, invocation_id, root_session_id AS owning_root_session_id,
        provider, dispatched_model, reported_model, effective_model, purpose, outcome,
        settled_at_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, provider_total_tokens,
        normalized_base_input_tokens, normalized_output_tokens,
        normalized_cache_read_tokens, normalized_cache_write_tokens,
        normalized_total_tokens, normalized_usage_complete, reasoning_included_in_output,
        reported_cost_usd, calculated_cost_usd,
        calculated_cost_complete, effective_cost_usd, effective_cost_source,
        effective_cost_coverage, projection_revision
      FROM analytics_provider_settlements;
    PRAGMA user_version = 3;
  `);
}

function downgradeV3ToV2(raw: RawDatabase): void {
  raw.exec(`
    DROP VIEW analytics_provider_usage_v1;
    DROP TRIGGER analytics_detail_reference_last_owner_cleanup;
    DROP INDEX analytics_execution_state_subject_idx;
    DROP INDEX analytics_tool_state_subject_idx;
    DROP INDEX analytics_activity_state_subject_idx;
    DROP TABLE analytics_delivery_accounting;
    DROP TABLE analytics_generations;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_base_input_tokens;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_output_tokens;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_cache_read_tokens;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_cache_write_tokens;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_total_tokens;
    ALTER TABLE analytics_provider_settlements DROP COLUMN normalized_usage_complete;
    ALTER TABLE analytics_provider_settlements DROP COLUMN reasoning_included_in_output;
    ALTER TABLE analytics_detail_payloads DROP COLUMN omission_reason;
    ALTER TABLE analytics_detail_payloads DROP COLUMN source_version;
    ALTER TABLE analytics_detail_payloads DROP COLUMN capture_stage;
    ALTER TABLE analytics_detail_payloads DROP COLUMN complete;
    ALTER TABLE analytics_detail_payloads DROP COLUMN source_encoding;
    ALTER TABLE analytics_detail_payloads DROP COLUMN media_type;
    ALTER TABLE analytics_deleted_subjects DROP COLUMN scrub_error;
    ALTER TABLE analytics_deleted_subjects DROP COLUMN scrub_state;
    PRAGMA user_version = 2;
  `);
}

function createLegacyFixture(version: 2 | 3): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), `pie-analytics-branch-migration-v${version}-`));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  recorder.submit(legacyProvider('legacy-settlement', 'legacy-invocation', 7));
  recorder.close();

  const raw = new DatabaseSync(databasePath);
  try {
    // The V2/V3 table and column shape is anchored to the historical recorder
    // at 074b54dc (the last committed schema-3 implementation). Reverse the
    // later V4 DDL (and V3 additions for V2), then assert the historical shape
    // below; this is deliberately more than relabeling a current database.
    downgradeV4ToV3(raw);
    if (version === 2) downgradeV3ToV2(raw);
    const userVersion = raw.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
    assert.equal(Number(userVersion.user_version), version);
    const hasTable = (name: string): boolean => Boolean(raw.prepare(
      'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
    ).get(name));
    const hasColumn = (table: string, name: string): boolean => Boolean(raw.prepare(
      'SELECT name FROM pragma_table_info(?) WHERE name = ?',
    ).get(table, name));
    assert.equal(hasTable('analytics_provider_settlements'), true);
    assert.equal(hasColumn('analytics_provider_settlements', 'execution_id'), false);
    assert.equal(hasColumn('analytics_provider_settlements', 'branch_id'), false);
    if (version === 2) {
      assert.equal(hasColumn('analytics_provider_settlements', 'normalized_usage_complete'), false);
      assert.equal(hasTable('analytics_delivery_accounting'), false);
      assert.equal(hasTable('analytics_generations'), false);
    } else {
      assert.equal(hasColumn('analytics_provider_settlements', 'normalized_usage_complete'), true);
      assert.equal(hasTable('analytics_delivery_accounting'), true);
      assert.equal(hasTable('analytics_generations'), true);
    }
  } finally {
    raw.close();
  }
  return { root, databasePath };
}

function assertPreservedLegacyUsage(recorder: SqliteAnalyticsRecorder): void {
  assert.equal(recorder.getDatabaseSchemaVersion(), 8);
  const read = recorder.readProviderSettlements();
  assert.equal(read.settlements.length, 1);
  assert.equal(read.settlements[0]?.invocationId, 'legacy-invocation');
  assert.equal(read.settlements[0]?.executionId, null);
  assert.equal(read.settlements[0]?.branchId, null);
  assert.equal(read.settlements[0]?.usage.inputTokens, 7);
  assert.equal(read.settlements[0]?.usage.outputTokens, 11);

  const accounting = recorder.readProviderAccountingSummary();
  assert.equal(accounting.invocationCount, 1);
  assert.equal(accounting.inputTokens.knownCount, 1);
  assert.equal(accounting.inputTokens.knownTotal, 7);
  assert.equal(accounting.outputTokens.knownCount, 1);
  assert.equal(accounting.outputTokens.knownTotal, 11);

  const selected = recorder.readScopedProviderSettlements({
    kind: 'selectedBranch',
    generationId: 'legacy-generation',
    rootSessionId: 'legacy-root',
  });
  assert.equal(selected.selectionCoverage, 'unknown');
  assert.deepEqual(selected.settlements, []);
}

for (const version of [2, 3] as const) {
  test(`schema-v${version} provider rows and totals migrate to v4 without fabricated branch identity`, () => {
    const fixture = createLegacyFixture(version);
    let recorder: SqliteAnalyticsRecorder | undefined;
    try {
      recorder = new SqliteAnalyticsRecorder(fixture.databasePath);
      assertPreservedLegacyUsage(recorder);
    } finally {
      recorder?.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test('fresh recorder creates branch and session-copy tables', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-branch-migration-v4-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const recorder = new SqliteAnalyticsRecorder(databasePath);
  assert.equal(recorder.getDatabaseSchemaVersion(), 8);
  recorder.close();
  const raw = new DatabaseSync(databasePath);
  try {
    const expectedTables = [
      'analytics_branch_edges',
      'analytics_branch_selections',
      'analytics_current_branch_selections',
      'analytics_session_copies',
    ];
    for (const name of expectedTables) {
      const row = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
      ).get(name) as { name: string } | undefined;
      assert.equal(row?.name, name);
    }
    // The v5 additive index must exist on a fresh database too.
    const index = raw.prepare(
      'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = ?',
    ).get('analytics_provider_settlement_projection_order_idx') as { name: string } | undefined;
    assert.equal(index?.name, 'analytics_provider_settlement_projection_order_idx');
  } finally {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});
