import { localCalendarDayKey } from '../../../shared/analytics/metrics.js';

/** The projection deliberately depends on the small subset of node:sqlite
 * needed by both the migration writer and the recorder. Keeping this module
 * independent from SqliteAnalyticsRecorder also makes the read path easy to
 * audit: readProviderModelGroups only prepares SELECTs. */
export interface ProviderProjectionDatabase {
  exec(sql: string): void;
  prepare(sql: string): ProviderProjectionStatement;
}

export interface ProviderProjectionStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): Iterable<unknown>;
}

export type ProviderProjectionCoverage = 'known' | 'unknown' | 'not_applicable';

export interface ProviderProjectionSettlement {
  provider: string | null;
  model: string | null;
  purpose: string | null;
  settledAtMs: string | null;
  workspaceKey?: string | null;
  workspaceCoverage?: ProviderProjectionCoverage | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheReadTokens: string | null;
  cacheWriteTokens: string | null;
  reasoningTokens: string | null;
  providerTotalTokens: string | null;
  effectiveCostUsd: number | null;
  effectiveCostSource: 'reported' | 'calculated' | null;
  effectiveCostCoverage?: ProviderProjectionCoverage | null;
}

export interface ProviderProjectionAggregateRequest {
  timeZone: string;
  todayDay: string;
  weekDays: readonly string[];
  maxGroups: number;
  windowStartMs?: string;
  windowEndMs?: string;
}

export interface ProviderProjectionAggregateRow extends Record<string, unknown> {
  provider: string;
  model: string;
  session_count: number;
  all_cost: number;
  all_input: string;
  all_output: string;
  all_cache_read: string;
  all_cache_write: string;
  all_unknown: number;
  all_unpriced: number;
  all_gap: number;
  today_cost: number;
  today_input: string;
  today_output: string;
  today_cache_read: string;
  today_cache_write: string;
  today_unknown: number;
  today_unpriced: number;
  today_gap: number;
  week_cost: number;
  week_input: string;
  week_output: string;
  week_cache_read: string;
  week_cache_write: string;
  week_unknown: number;
  week_unpriced: number;
  week_gap: number;
}

interface ProjectionSummary {
  occurrenceCount: string;
  channels: Record<string, { knownCount: string; unknownCount: string; knownTotal: string }>;
  cost: {
    knownCount: string;
    unknownCount: string;
    unpricedCount: string;
    reportedCount: string;
    calculatedCount: string;
    knownTotal: number;
  };
  instrumentationGapCount: string;
}

const CHANNELS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'providerTotalTokens',
] as const;

function emptySummary(): ProjectionSummary {
  return {
    occurrenceCount: '0',
    channels: Object.fromEntries(CHANNELS.map((channel) => [channel, {
      knownCount: '0', unknownCount: '0', knownTotal: '0',
    }])) as ProjectionSummary['channels'],
    cost: {
      knownCount: '0', unknownCount: '0', unpricedCount: '0',
      reportedCount: '0', calculatedCount: '0', knownTotal: 0,
    },
    instrumentationGapCount: '0',
  };
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asCoverage(value: unknown): ProviderProjectionCoverage {
  return value === 'known' || value === 'not_applicable' ? value : 'unknown';
}

function canonicalKey(value: string | null | undefined): string {
  return value ?? '';
}

function dimensionKey(settlement: ProviderProjectionSettlement): string[] {
  const coverage = asCoverage(settlement.workspaceCoverage);
  const workspace = coverage === 'known' ? canonicalKey(settlement.workspaceKey) : '';
  return [
    canonicalKey(settlement.provider),
    canonicalKey(settlement.model),
    canonicalKey(settlement.purpose),
    coverage,
    workspace,
  ];
}

function parseSummary(value: unknown): ProjectionSummary {
  if (typeof value !== 'string') throw new Error('Provider projection summary is not JSON.');
  const parsed = JSON.parse(value) as ProjectionSummary;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.occurrenceCount !== 'string') {
    throw new Error('Provider projection summary is malformed.');
  }
  return parsed;
}

function addCount(current: string, direction: 1 | -1): string {
  const value = BigInt(current) + BigInt(direction);
  if (value < 0n) throw new Error('Provider projection underflow.');
  return value.toString();
}

function updateSummary(summary: ProjectionSummary, settlement: ProviderProjectionSettlement, direction: 1 | -1): void {
  summary.occurrenceCount = addCount(summary.occurrenceCount, direction);
  const values: Record<string, string | null> = {
    inputTokens: settlement.inputTokens,
    outputTokens: settlement.outputTokens,
    cacheReadTokens: settlement.cacheReadTokens,
    cacheWriteTokens: settlement.cacheWriteTokens,
    reasoningTokens: settlement.reasoningTokens,
    providerTotalTokens: settlement.providerTotalTokens,
  };
  for (const channel of CHANNELS) {
    const target = summary.channels[channel]!;
    const value = values[channel];
    if (value === null) target.unknownCount = addCount(target.unknownCount, direction);
    else {
      target.knownCount = addCount(target.knownCount, direction);
      const total = BigInt(target.knownTotal) + BigInt(value) * BigInt(direction);
      if (total < 0n) throw new Error(`Provider projection ${channel} underflow.`);
      target.knownTotal = total.toString();
    }
  }
  if (settlement.effectiveCostUsd === null) {
    if (asCoverage(settlement.effectiveCostCoverage) === 'not_applicable') {
      summary.cost.unpricedCount = addCount(summary.cost.unpricedCount, direction);
    } else summary.cost.unknownCount = addCount(summary.cost.unknownCount, direction);
  } else {
    summary.cost.knownCount = addCount(summary.cost.knownCount, direction);
    summary.cost.knownTotal += settlement.effectiveCostUsd * direction;
    if (settlement.effectiveCostSource === 'reported') {
      summary.cost.reportedCount = addCount(summary.cost.reportedCount, direction);
    } else if (settlement.effectiveCostSource === 'calculated') {
      summary.cost.calculatedCount = addCount(summary.cost.calculatedCount, direction);
    }
  }
  const gap = settlement.effectiveCostUsd === null
    || CHANNELS.some((channel) => values[channel] === null);
  if (gap) summary.instrumentationGapCount = addCount(summary.instrumentationGapCount, direction);
}

function rollupRow(
  database: ProviderProjectionDatabase,
  table: 'analytics_provider_model_totals' | 'analytics_provider_model_daily',
  keys: readonly string[],
  settlement: ProviderProjectionSettlement,
  revision: string,
  direction: 1 | -1,
): void {
  const where = table === 'analytics_provider_model_totals'
    ? 'provider_key = ? AND model_key = ? AND purpose_key = ? AND workspace_coverage = ? AND workspace_key = ?'
    : 'time_zone = ? AND local_day = ? AND provider_key = ? AND model_key = ? AND purpose_key = ? AND workspace_coverage = ? AND workspace_key = ?';
  const row = database.prepare(`SELECT summary_json FROM ${table} WHERE ${where}`).get(...keys) as { summary_json: string } | undefined;
  const summary = row ? parseSummary(row.summary_json) : emptySummary();
  updateSummary(summary, settlement, direction);
  const allKeys = table === 'analytics_provider_model_totals'
    ? ['global', '*', ...keys]
    : [keys[0], keys[1], 'global', '*', ...keys.slice(2)];
  const placeholders = allKeys.map(() => '?').join(', ');
  if (summary.occurrenceCount === '0') {
    database.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys);
    return;
  }
  database.prepare(`
    INSERT INTO ${table} (
      ${table === 'analytics_provider_model_totals'
        ? 'scope_kind, scope_key, provider_key, model_key, purpose_key, workspace_coverage, workspace_key'
        : 'time_zone, local_day, scope_kind, scope_key, provider_key, model_key, purpose_key, workspace_coverage, workspace_key'},
      summary_json, projection_revision
    ) VALUES (${placeholders}, ?, ?)
    ON CONFLICT DO UPDATE SET summary_json = excluded.summary_json,
      projection_revision = excluded.projection_revision
  `).run(...allKeys, JSON.stringify(summary), revision);
}

function isWithinWindow(settledAtMs: string, startMs: string, endMs: string): boolean {
  const value = BigInt(settledAtMs);
  return value >= BigInt(startMs) && value < BigInt(endMs);
}

export function createProviderProjectionSchema(database: ProviderProjectionDatabase): void {
  const columns = database.prepare('PRAGMA table_info(analytics_provider_settlements)').all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'workspace_key')) {
    database.exec("ALTER TABLE analytics_provider_settlements ADD COLUMN workspace_key TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'workspace_coverage')) {
    database.exec("ALTER TABLE analytics_provider_settlements ADD COLUMN workspace_coverage TEXT NOT NULL DEFAULT 'unknown' CHECK (workspace_coverage IN ('known', 'unknown', 'not_applicable'))");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS analytics_provider_settlement_settled_at_int_idx
      ON analytics_provider_settlements(CAST(settled_at_ms AS INTEGER))
      WHERE settled_at_ms IS NOT NULL;
    CREATE TABLE IF NOT EXISTS analytics_provider_model_totals (
      scope_kind TEXT NOT NULL CHECK (scope_kind = 'global'),
      scope_key TEXT NOT NULL CHECK (scope_key = '*'),
      provider_key TEXT NOT NULL,
      model_key TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      workspace_coverage TEXT NOT NULL CHECK (workspace_coverage IN ('known', 'unknown', 'not_applicable')),
      workspace_key TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(scope_kind, scope_key, provider_key, model_key, purpose_key, workspace_coverage, workspace_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS analytics_provider_model_daily (
      time_zone TEXT NOT NULL,
      local_day TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind = 'global'),
      scope_key TEXT NOT NULL CHECK (scope_key = '*'),
      provider_key TEXT NOT NULL,
      model_key TEXT NOT NULL,
      purpose_key TEXT NOT NULL,
      workspace_coverage TEXT NOT NULL CHECK (workspace_coverage IN ('known', 'unknown', 'not_applicable')),
      workspace_key TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(time_zone, local_day, scope_kind, scope_key, provider_key, model_key, purpose_key, workspace_coverage, workspace_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_provider_model_daily_lookup_idx
      ON analytics_provider_model_daily(time_zone, local_day, provider_key, model_key);
    CREATE TABLE IF NOT EXISTS analytics_provider_daily_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      time_zone TEXT,
      window_start_ms TEXT,
      window_end_ms TEXT,
      state TEXT NOT NULL CHECK (state IN ('uninitialized', 'ready', 'rebuilding')),
      projection_revision TEXT NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO analytics_provider_daily_state
      (singleton, time_zone, window_start_ms, window_end_ms, state, projection_revision)
      VALUES (1, NULL, NULL, NULL, 'uninitialized', '0');
    CREATE TABLE IF NOT EXISTS analytics_provider_session_presence (
      root_session_id TEXT PRIMARY KEY,
      settlement_count TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS analytics_provider_aggregate_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_count TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO analytics_provider_aggregate_state(singleton, session_count, projection_revision)
      VALUES (1, '0', '0');
  `);
}

function settlementFromRow(row: Record<string, unknown>): ProviderProjectionSettlement {
  return {
    provider: asString(row.provider),
    model: asString(row.effective_model),
    purpose: asString(row.purpose),
    settledAtMs: asString(row.settled_at_ms),
    workspaceKey: asString(row.workspace_key),
    workspaceCoverage: asCoverage(row.workspace_coverage),
    inputTokens: asString(row.normalized_base_input_tokens),
    outputTokens: asString(row.normalized_output_tokens),
    cacheReadTokens: asString(row.normalized_cache_read_tokens),
    cacheWriteTokens: asString(row.normalized_cache_write_tokens),
    reasoningTokens: asString(row.reasoning_tokens),
    providerTotalTokens: asString(row.normalized_total_tokens),
    effectiveCostUsd: row.effective_cost_usd === null || row.effective_cost_usd === undefined
      ? null : Number(row.effective_cost_usd),
    effectiveCostSource: row.effective_cost_source === 'reported' || row.effective_cost_source === 'calculated'
      ? row.effective_cost_source : null,
    effectiveCostCoverage: asCoverage(row.effective_cost_coverage),
  };
}

interface WindowAggregate {
  cost: number;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  unknown: bigint;
  unpriced: bigint;
  gap: bigint;
}

function emptyWindowAggregate(): WindowAggregate {
  return { cost: 0, input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n, unknown: 0n, unpriced: 0n, gap: 0n };
}

function addWindowSummary(target: WindowAggregate, summary: ProjectionSummary): void {
  target.cost += summary.cost.knownTotal;
  target.input += BigInt(summary.channels.inputTokens?.knownTotal ?? '0');
  target.output += BigInt(summary.channels.outputTokens?.knownTotal ?? '0');
  target.cacheRead += BigInt(summary.channels.cacheReadTokens?.knownTotal ?? '0');
  target.cacheWrite += BigInt(summary.channels.cacheWriteTokens?.knownTotal ?? '0');
  target.unknown += BigInt(summary.cost.unknownCount ?? '0');
  target.unpriced += BigInt(summary.cost.unpricedCount ?? '0');
  target.gap += BigInt(summary.instrumentationGapCount ?? '0');
}

function countNumber(value: bigint, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Provider projection ${name} exceeds the safe count range.`);
  return result;
}

export function applyProviderProjection(
  database: ProviderProjectionDatabase,
  settlement: ProviderProjectionSettlement,
  revision: string,
  direction: 1 | -1,
  includeTotals = true,
): void {
  const keys = dimensionKey(settlement);
  if (includeTotals) rollupRow(database, 'analytics_provider_model_totals', keys, settlement, revision, direction);
  const state = database.prepare(`SELECT time_zone, window_start_ms, window_end_ms, state FROM analytics_provider_daily_state WHERE singleton = 1`).get() as {
    time_zone: string | null; window_start_ms: string | null; window_end_ms: string | null; state: string;
  };
  if (settlement.settledAtMs === null) {
    // Undated is retained independently of any active calendar window.
    if ((state.state === 'ready' || state.state === 'rebuilding') && state.time_zone) {
      rollupRow(database, 'analytics_provider_model_daily', [
        state.time_zone, 'undated', ...keys,
      ], settlement, revision, direction);
    }
  } else if ((state.state === 'ready' || state.state === 'rebuilding') && state.time_zone && state.window_start_ms && state.window_end_ms
    && isWithinWindow(settlement.settledAtMs, state.window_start_ms, state.window_end_ms)) {
    const day = localCalendarDayKey(settlement.settledAtMs, state.time_zone);
    rollupRow(database, 'analytics_provider_model_daily', [state.time_zone, day, ...keys], settlement, revision, direction);
  }
}

export function settlementFromDatabaseRow(row: Record<string, unknown>): ProviderProjectionSettlement {
  return settlementFromRow(row);
}

export function readProviderModelGroups(
  database: ProviderProjectionDatabase,
  request: ProviderProjectionAggregateRequest,
): { rows: ProviderProjectionAggregateRow[]; truncated: boolean; sessionCount: number } {
  if (!request.timeZone || request.weekDays.length !== 7) throw new Error('Provider aggregate calendar request is incomplete.');
  const state = database.prepare(`SELECT time_zone, window_start_ms, window_end_ms, state FROM analytics_provider_daily_state WHERE singleton = 1`).get() as {
    time_zone: string | null; window_start_ms: string | null; window_end_ms: string | null; state: string;
  };
  if (state.state !== 'ready' || state.time_zone !== request.timeZone) {
    throw new Error(`Provider daily projection is not prepared for timezone ${request.timeZone}.`);
  }
  if ((request.windowStartMs !== undefined && state.window_start_ms !== request.windowStartMs)
    || (request.windowEndMs !== undefined && state.window_end_ms !== request.windowEndMs)) {
    throw new Error('Provider daily projection window changed before the aggregate read.');
  }
  // SQLite JSON extraction is intentionally not used for token sums: INTEGER
  // affinity would overflow or round a valid signed-64-bit total. The query
  // scans only maintained dimension rows and combines their decimal strings as
  // BigInts in this bounded helper.
  const keyRows = database.prepare(`
    SELECT provider_key, model_key
    FROM analytics_provider_model_totals
    WHERE scope_kind = 'global' AND scope_key = '*'
    GROUP BY provider_key, model_key
    ORDER BY provider_key, model_key
    LIMIT ?
  `).all(request.maxGroups + 1) as Array<{ provider_key: string; model_key: string }>;
  const truncated = keyRows.length > request.maxGroups;
  const selected = truncated ? keyRows.slice(0, request.maxGroups) : keyRows;
  // Row-value VALUES avoids a deeply nested OR expression at the supported
  // 4096-group bound. Scope predicates match the leading primary-key columns,
  // and the row streams keep many purpose/workspace dimensions out of the
  // helper's JS heap at once.
  const pairPredicate = selected.length === 0
    ? '0'
    : `(provider_key, model_key) IN (VALUES ${selected.map(() => '(?, ?)').join(', ')})`;
  const pairParameters = selected.flatMap((row) => [row.provider_key, row.model_key]);
  const totalRows = database.prepare(`
    SELECT provider_key, model_key, summary_json
    FROM analytics_provider_model_totals
    WHERE scope_kind = 'global' AND scope_key = '*' AND ${pairPredicate}
  `).iterate(...pairParameters) as Iterable<Record<string, unknown>>;
  const dailyRows = database.prepare(`
    SELECT provider_key, model_key, local_day, summary_json
    FROM analytics_provider_model_daily
    WHERE time_zone = ? AND local_day IN (${request.weekDays.map(() => '?').join(', ')})
      AND scope_kind = 'global' AND scope_key = '*'
      AND (${pairPredicate})
  `).iterate(request.timeZone, ...request.weekDays, ...pairParameters) as Iterable<Record<string, unknown>>;
  const allByKey = new Map<string, WindowAggregate>();
  const todayByKey = new Map<string, WindowAggregate>();
  const weekByKey = new Map<string, WindowAggregate>();
  const keyOf = (row: Record<string, unknown>): string => `${row.provider_key}\u0000${row.model_key}`;
  for (const row of totalRows) {
    const key = keyOf(row);
    const aggregate = allByKey.get(key) ?? emptyWindowAggregate();
    addWindowSummary(aggregate, parseSummary(row.summary_json));
    allByKey.set(key, aggregate);
  }
  for (const row of dailyRows) {
    const key = keyOf(row);
    const summary = parseSummary(row.summary_json);
    const week = weekByKey.get(key) ?? emptyWindowAggregate();
    addWindowSummary(week, summary);
    weekByKey.set(key, week);
    if (row.local_day === request.todayDay) {
      const today = todayByKey.get(key) ?? emptyWindowAggregate();
      addWindowSummary(today, summary);
      todayByKey.set(key, today);
    }
  }
  const stateCount = database.prepare(`SELECT session_count FROM analytics_provider_aggregate_state WHERE singleton = 1`).get() as { session_count: string } | undefined;
  const sessionCount = countNumber(BigInt(stateCount?.session_count ?? '0'), 'session count');
  return {
    truncated,
    sessionCount,
    rows: selected.map((row) => {
      const key = `${row.provider_key}\u0000${row.model_key}`;
      const all = allByKey.get(key) ?? emptyWindowAggregate();
      const today = todayByKey.get(key) ?? emptyWindowAggregate();
      const week = weekByKey.get(key) ?? emptyWindowAggregate();
      return {
        provider: row.provider_key || 'unknown', model: row.model_key || 'unknown', session_count: sessionCount,
        all_cost: all.cost, all_input: all.input.toString(), all_output: all.output.toString(),
        all_cache_read: all.cacheRead.toString(), all_cache_write: all.cacheWrite.toString(),
        all_unknown: countNumber(all.unknown, 'all unknown'), all_unpriced: countNumber(all.unpriced, 'all unpriced'), all_gap: countNumber(all.gap, 'all gap'),
        today_cost: today.cost, today_input: today.input.toString(), today_output: today.output.toString(),
        today_cache_read: today.cacheRead.toString(), today_cache_write: today.cacheWrite.toString(),
        today_unknown: countNumber(today.unknown, 'today unknown'), today_unpriced: countNumber(today.unpriced, 'today unpriced'), today_gap: countNumber(today.gap, 'today gap'),
        week_cost: week.cost, week_input: week.input.toString(), week_output: week.output.toString(),
        week_cache_read: week.cacheRead.toString(), week_cache_write: week.cacheWrite.toString(),
        week_unknown: countNumber(week.unknown, 'week unknown'), week_unpriced: countNumber(week.unpriced, 'week unpriced'), week_gap: countNumber(week.gap, 'week gap'),
      };
    }),
  };
}

export function prepareProviderDailyProjection(
  database: ProviderProjectionDatabase,
  timeZone: string,
  windowStartMs: string,
  windowEndMs: string,
  revision: string,
  allowTimeZoneChange = false,
): void {
  // Validate the IANA identifier before changing state. The formatter is also
  // the canonical DST/calendar implementation used for each settlement.
  localCalendarDayKey(windowStartMs, timeZone);
  if (BigInt(windowStartMs) >= BigInt(windowEndMs)) throw new RangeError('Provider daily projection window is empty.');
  const current = database.prepare(`SELECT time_zone, state FROM analytics_provider_daily_state WHERE singleton = 1`).get() as {
    time_zone: string | null; state: string;
  };
  if (current.time_zone && current.time_zone !== timeZone && !allowTimeZoneChange) {
    throw new Error(`Provider daily projection is already configured for timezone ${current.time_zone}.`);
  }
  if (current.time_zone && current.time_zone !== timeZone && allowTimeZoneChange) {
    // Undated rows have no calendar key of their own, so move their zone
    // namespace before the state switch. This preserves their maintained
    // counts without replaying immutable history and lets later deletes use
    // the new active-zone key safely.
    database.prepare(`
      UPDATE analytics_provider_model_daily
      SET time_zone = ?
      WHERE time_zone = ? AND local_day = 'undated'
    `).run(timeZone, current.time_zone);
  }
  // Rebuild only dated rows from the immutable settlement source. Undated
  // contributions are maintained independently by the settlement writer and
  // survive a calendar-window rollover; replaying all null timestamps here
  // would turn every ordinary refresh into an unbounded history scan.
  const seedUndated = current.state === 'uninitialized' || !current.time_zone;
  database.exec(`DELETE FROM analytics_provider_model_daily WHERE local_day <> 'undated'`);
  database.prepare(`UPDATE analytics_provider_daily_state SET time_zone = ?, window_start_ms = ?, window_end_ms = ?, state = 'rebuilding', projection_revision = ? WHERE singleton = 1`)
    .run(timeZone, windowStartMs, windowEndMs, revision);
  if (seedUndated) {
    const undatedRows = database.prepare(`
      SELECT provider, effective_model, purpose, settled_at_ms, workspace_key, workspace_coverage,
        normalized_base_input_tokens, normalized_output_tokens, normalized_cache_read_tokens,
        normalized_cache_write_tokens, reasoning_tokens, normalized_total_tokens,
        effective_cost_usd, effective_cost_source, effective_cost_coverage
      FROM analytics_provider_settlements
      WHERE settled_at_ms IS NULL
    `).iterate() as Iterable<Record<string, unknown>>;
    for (const row of undatedRows) {
      applyProviderProjection(database, settlementFromRow(row), revision, 1, false);
    }
  }
  // Keep the dated statement independent of the NULL branch so SQLite can use
  // the expression index for the exact production window query.
  const rows = database.prepare(`
    SELECT provider, effective_model, purpose, settled_at_ms, workspace_key, workspace_coverage,
      normalized_base_input_tokens, normalized_output_tokens, normalized_cache_read_tokens,
      normalized_cache_write_tokens, reasoning_tokens, normalized_total_tokens,
      effective_cost_usd, effective_cost_source, effective_cost_coverage
    FROM analytics_provider_settlements
    WHERE settled_at_ms IS NOT NULL
      AND CAST(settled_at_ms AS INTEGER) >= ? AND CAST(settled_at_ms AS INTEGER) < ?
  `).iterate(windowStartMs, windowEndMs) as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    const settlement = settlementFromRow(row);
    applyProviderProjection(database, settlement, revision, 1, false);
  }
  database.prepare(`UPDATE analytics_provider_daily_state SET state = 'ready', projection_revision = ? WHERE singleton = 1`).run(revision);
}

export function rebuildProviderProjection(database: ProviderProjectionDatabase): void {
  database.exec(`DELETE FROM analytics_provider_model_totals; DELETE FROM analytics_provider_model_daily; DELETE FROM analytics_provider_session_presence;`);
  database.prepare(`UPDATE analytics_provider_aggregate_state SET session_count = '0', projection_revision = '0' WHERE singleton = 1`).run();
  const rows = database.prepare(`SELECT provider, effective_model, purpose, settled_at_ms, workspace_key, workspace_coverage,
      normalized_base_input_tokens, normalized_output_tokens, normalized_cache_read_tokens,
      normalized_cache_write_tokens, reasoning_tokens, normalized_total_tokens,
      effective_cost_usd, effective_cost_source, effective_cost_coverage
    FROM analytics_provider_settlements ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    const settlement = settlementFromRow(row);
    applyProviderProjection(database, settlement, '0', 1);
  }
  // Let SQLite group the immutable source rather than retaining one JS map
  // entry per historical session during a migration rebuild.
  database.exec(`
    INSERT INTO analytics_provider_session_presence(root_session_id, settlement_count)
      SELECT root_session_id, COUNT(*)
      FROM analytics_provider_settlements
      WHERE root_session_id IS NOT NULL
      GROUP BY root_session_id;
  `);
  const sessionCount = database.prepare(`SELECT COUNT(*) AS count FROM analytics_provider_session_presence`).get() as { count: number | bigint };
  database.prepare(`UPDATE analytics_provider_aggregate_state SET session_count = ?, projection_revision = '0' WHERE singleton = 1`).run(String(sessionCount.count));
}

export function incrementProviderSessionPresence(database: ProviderProjectionDatabase, rootSessionId: string, revision: string): void {
  const row = database.prepare(`SELECT settlement_count FROM analytics_provider_session_presence WHERE root_session_id = ?`).get(rootSessionId) as { settlement_count: string } | undefined;
  if (row) database.prepare(`UPDATE analytics_provider_session_presence SET settlement_count = ? WHERE root_session_id = ?`).run(addCount(row.settlement_count, 1), rootSessionId);
  else {
    database.prepare(`INSERT INTO analytics_provider_session_presence(root_session_id, settlement_count) VALUES (?, '1')`).run(rootSessionId);
    const state = database.prepare(`SELECT session_count FROM analytics_provider_aggregate_state WHERE singleton = 1`).get() as { session_count: string };
    database.prepare(`UPDATE analytics_provider_aggregate_state SET session_count = ?, projection_revision = ? WHERE singleton = 1`).run(addCount(state.session_count, 1), revision);
  }
}

export function decrementProviderSessionPresence(database: ProviderProjectionDatabase, rootSessionId: string, revision: string): void {
  const row = database.prepare(`SELECT settlement_count FROM analytics_provider_session_presence WHERE root_session_id = ?`).get(rootSessionId) as { settlement_count: string } | undefined;
  if (!row) return;
  const next = BigInt(row.settlement_count) - 1n;
  if (next > 0n) database.prepare(`UPDATE analytics_provider_session_presence SET settlement_count = ? WHERE root_session_id = ?`).run(next.toString(), rootSessionId);
  else {
    database.prepare(`DELETE FROM analytics_provider_session_presence WHERE root_session_id = ?`).run(rootSessionId);
    const state = database.prepare(`SELECT session_count FROM analytics_provider_aggregate_state WHERE singleton = 1`).get() as { session_count: string };
    database.prepare(`UPDATE analytics_provider_aggregate_state SET session_count = ?, projection_revision = ? WHERE singleton = 1`).run(addCount(state.session_count, -1), revision);
  }
}
