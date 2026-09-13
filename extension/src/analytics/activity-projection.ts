import { AnalyticsSourceConflictError } from '../../../shared/analytics/contracts.js';

/** Bounded canonical activity projection (schema version 12).
 *
 * The recorder owns immutable activity observations and the typed activity
 * state rows; this module owns the maintained rollup used by bounded reads:
 *
 * - `analytics_activity_projection_members` mirrors one merged state per
 *   `(generation, span)` plus the clock domain that owns the measured
 *   duration, so wall-union queries keep the real anchors and additive work
 *   keeps its provenance.
 * - `analytics_activity_summary` keeps additive measured work and isolated
 *   known/unknown counts per `(scope, kind)`. It never computes a wall union:
 *   parallel or nested spans may exceed elapsed wall time, and the union is a
 *   separate query over the member anchors.
 *
 * The module is independent from `SqliteAnalyticsRecorder` and keeps every
 * statement a plain `prepare`, mirroring `provider-model-projection.ts`, so
 * the read path stays auditable without the recorder class.
 */

export interface ActivityProjectionDatabase {
  exec(sql: string): void;
  prepare(sql: string): ActivityProjectionStatement;
}

export interface ActivityProjectionStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): Iterable<unknown>;
}

/** One merged activity span state. `startedAtMs`/`endedAtMs` stay
 * wall-clock-utc correlation anchors exactly as delivered; a measured
 * duration remains valid even when those anchors are missing or reversed. */
export interface ActivityProjectionSpanState {
  generationId: string;
  spanId: string;
  captureSubjectKind: string;
  captureSubjectKey: string;
  rootSessionId: string | null;
  kind: string | null;
  clockDomain: string | null;
  startedAtMs: string | null;
  endedAtMs: string | null;
  durationMs: number | null;
  coverage: string | null;
}

export interface ActivityProjectionReadRequest {
  /** Session scope; omitted selects the global scope. */
  rootSessionId?: string;
  maxKinds?: number;
}

export interface ActivityProjectionCounts {
  spanCount: number;
  observedCount: number;
  estimatedCount: number;
  unknownCount: number;
  measuredKnownCount: number;
  measuredUnknownCount: number;
  /** Additive measured work: the sum of delivered span durations. Parallel or
   * nested spans can exceed elapsed wall time; this is not a wall union. */
  measuredTotalMs: number;
}

export interface ActivityProjectionKindRow extends ActivityProjectionCounts {
  activityKind: string | null;
}

export interface ActivityProjectionReadModel {
  revision: number | string;
  scope: { kind: 'global' } | { kind: 'session'; rootSessionId: string };
  kinds: ActivityProjectionKindRow[];
  totals: ActivityProjectionCounts;
  truncated: boolean;
}

interface ContributionDelta {
  spanCount: number;
  observedCount: number;
  estimatedCount: number;
  unknownCount: number;
  measuredKnownCount: number;
  measuredUnknownCount: number;
  measuredTotalMs: number;
}

const ACTIVITY_COVERAGE_GROUPS = ['observed', 'estimated', 'unknown'] as const;
const ACTIVITY_COVERAGE_GROUP_SET: ReadonlySet<string> = new Set(ACTIVITY_COVERAGE_GROUPS);
type ActivityCoverageGroup = (typeof ACTIVITY_COVERAGE_GROUPS)[number];

function coverageGroup(coverage: string | null): ActivityCoverageGroup {
  return ACTIVITY_COVERAGE_GROUP_SET.has(coverage ?? '') ? coverage as ActivityCoverageGroup : 'unknown';
}

/** Additive contribution of one span state to its `(scope, kind)` summary. */
interface SpanContribution extends ContributionDelta {
  kindKey: string;
}

function spanContribution(state: ActivityProjectionSpanState): SpanContribution {
  const measuredKnown = state.durationMs !== null ? 1 : 0;
  const group = coverageGroup(state.coverage);
  return {
    kindKey: state.kind ?? '',
    spanCount: 1,
    observedCount: group === 'observed' ? 1 : 0,
    estimatedCount: group === 'estimated' ? 1 : 0,
    unknownCount: group === 'unknown' ? 1 : 0,
    measuredKnownCount: measuredKnown,
    measuredUnknownCount: measuredKnown === 1 ? 0 : 1,
    measuredTotalMs: state.durationMs ?? 0,
  };
}

function contributionFor(contribution: SpanContribution | null, kindKey: string): ContributionDelta | null {
  if (!contribution || contribution.kindKey !== kindKey) return null;
  return contribution;
}

function signedDelta(kindKey: string, previous: SpanContribution | null, next: SpanContribution | null): ContributionDelta | null {
  const before = contributionFor(previous, kindKey);
  const after = contributionFor(next, kindKey);
  if (!before && !after) return null;
  const zero: ContributionDelta = {
    spanCount: 0, observedCount: 0, estimatedCount: 0, unknownCount: 0,
    measuredKnownCount: 0, measuredUnknownCount: 0, measuredTotalMs: 0,
  };
  const delta = { ...zero };
  for (const key of Object.keys(zero) as Array<keyof ContributionDelta>) {
    delta[key] = (after?.[key] ?? 0) - (before?.[key] ?? 0);
  }
  const isEmpty = Object.values(delta).every((value) => value === 0);
  return isEmpty ? null : delta;
}

function zeroSummary(): {
  spanCount: bigint; observedCount: bigint; estimatedCount: bigint; unknownCount: bigint;
  measuredKnownCount: bigint; measuredUnknownCount: bigint; measuredTotalMs: number;
} {
  return {
    spanCount: 0n, observedCount: 0n, estimatedCount: 0n, unknownCount: 0n,
    measuredKnownCount: 0n, measuredUnknownCount: 0n, measuredTotalMs: 0,
  };
}

function applySummaryDelta(
  database: ActivityProjectionDatabase,
  scopeKind: 'global' | 'session',
  scopeKey: string,
  kindKey: string,
  delta: ContributionDelta,
  revision: string,
): void {
  const row = database.prepare(`
    SELECT span_count, observed_count, estimated_count, unknown_count,
      measured_known_count, measured_unknown_count, measured_total_ms
    FROM analytics_activity_summary
    WHERE scope_kind = ? AND scope_key = ? AND activity_kind = ?
  `).get(scopeKind, scopeKey, kindKey) as Record<string, unknown> | undefined;
  const current = row ? {
    spanCount: BigInt(String(row.span_count)),
    observedCount: BigInt(String(row.observed_count)),
    estimatedCount: BigInt(String(row.estimated_count)),
    unknownCount: BigInt(String(row.unknown_count)),
    measuredKnownCount: BigInt(String(row.measured_known_count)),
    measuredUnknownCount: BigInt(String(row.measured_unknown_count)),
    measuredTotalMs: Number(row.measured_total_ms),
  } : zeroSummary();
  const next = {
    spanCount: current.spanCount + BigInt(delta.spanCount),
    observedCount: current.observedCount + BigInt(delta.observedCount),
    estimatedCount: current.estimatedCount + BigInt(delta.estimatedCount),
    unknownCount: current.unknownCount + BigInt(delta.unknownCount),
    measuredKnownCount: current.measuredKnownCount + BigInt(delta.measuredKnownCount),
    measuredUnknownCount: current.measuredUnknownCount + BigInt(delta.measuredUnknownCount),
    measuredTotalMs: current.measuredTotalMs + delta.measuredTotalMs,
  };
  for (const key of ['spanCount', 'observedCount', 'estimatedCount', 'unknownCount', 'measuredKnownCount', 'measuredUnknownCount'] as const) {
    if (next[key] < 0n) throw new Error(`Activity projection ${key} underflow.`);
  }
  if (next.measuredTotalMs < 0) {
    if (next.measuredTotalMs < -1e-9) throw new Error('Activity projection measuredTotalMs underflow.');
    next.measuredTotalMs = 0;
  }
  if (next.spanCount === 0n) {
    if (row) {
      database.prepare(`
        DELETE FROM analytics_activity_summary
        WHERE scope_kind = ? AND scope_key = ? AND activity_kind = ?
      `).run(scopeKind, scopeKey, kindKey);
    }
    return;
  }
  database.prepare(`
    INSERT INTO analytics_activity_summary (
      scope_kind, scope_key, activity_kind, span_count,
      observed_count, estimated_count, unknown_count,
      measured_known_count, measured_unknown_count, measured_total_ms, projection_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_kind, scope_key, activity_kind) DO UPDATE SET
      span_count = excluded.span_count,
      observed_count = excluded.observed_count,
      estimated_count = excluded.estimated_count,
      unknown_count = excluded.unknown_count,
      measured_known_count = excluded.measured_known_count,
      measured_unknown_count = excluded.measured_unknown_count,
      measured_total_ms = excluded.measured_total_ms,
      projection_revision = excluded.projection_revision
  `).run(
    scopeKind, scopeKey, kindKey, next.spanCount.toString(),
    next.observedCount.toString(), next.estimatedCount.toString(), next.unknownCount.toString(),
    next.measuredKnownCount.toString(), next.measuredUnknownCount.toString(),
    next.measuredTotalMs, revision,
  );
}

/** Apply the net summary delta between the previous and next span states.
 * Global scope counts every retained span once regardless of ownership;
 * session scope follows the attributed root, so the pending-create -> session
 * promotion adds the session contribution in either arrival order. */
function applyContributionDelta(
  database: ActivityProjectionDatabase,
  previous: ActivityProjectionSpanState | null,
  next: ActivityProjectionSpanState,
  revision: string,
): void {
  const previousContribution = previous ? spanContribution(previous) : null;
  const nextContribution = spanContribution(next);
  const kindKeys = new Set<string>([
    previousContribution?.kindKey ?? nextContribution.kindKey,
    nextContribution.kindKey,
  ]);
  for (const kindKey of kindKeys) {
    const delta = signedDelta(kindKey, previousContribution, nextContribution);
    if (delta) applySummaryDelta(database, 'global', '*', kindKey, delta, revision);
  }
  const previousRoot = previous?.rootSessionId ?? null;
  const nextRoot = next.rootSessionId;
  if (previousRoot !== null && previousRoot !== nextRoot && previousContribution) {
    const delta = signedDelta(previousContribution.kindKey, previousContribution, null);
    if (delta) applySummaryDelta(database, 'session', previousRoot, previousContribution.kindKey, delta, revision);
  }
  if (nextRoot !== null) {
    const sessionPrevious = previousRoot === nextRoot ? previousContribution : null;
    const delta = signedDelta(nextContribution.kindKey, sessionPrevious, nextContribution);
    if (delta) applySummaryDelta(database, 'session', nextRoot, nextContribution.kindKey, delta, revision);
  }
}

function conflict(generationId: string, spanId: string, existing: ActivityProjectionSpanState, incoming: ActivityProjectionSpanState): AnalyticsSourceConflictError {
  return new AnalyticsSourceConflictError(
    `activitySpan:${generationId}:${spanId}`,
    `${existing.captureSubjectKind}:${existing.captureSubjectKey}`,
    `${incoming.captureSubjectKind}:${incoming.captureSubjectKey}`,
  );
}

/** Merge an incoming span observation into an existing span state.
 *
 * Trusted capture-subject ownership is order-independent: a pending-create
 * span and its later bound session subject are the same trusted owner once
 * the recorder's binding maps the operation to that root, and the bind may
 * commit before or after either observation. Any other differing trusted
 * subject for the same `(generation, span)` identity is rejected visibly.
 * Terminal measured facts are never overwritten by an earlier observation
 * replayed out of order; conflicting non-null facts are rejected. */
function mergeActivitySpan(
  existing: ActivityProjectionSpanState | null,
  incoming: ActivityProjectionSpanState,
  bindingRootForPending: (pendingOperationId: string) => string | null,
): { merged: ActivityProjectionSpanState } {
  if (!existing) return { merged: { ...incoming } };
  const sameSubject = existing.captureSubjectKind === incoming.captureSubjectKind
    && existing.captureSubjectKey === incoming.captureSubjectKey;
  if (!sameSubject) {
    const pendingOperationId = existing.captureSubjectKind === 'pendingCreate'
      ? existing.captureSubjectKey
      : incoming.captureSubjectKind === 'pendingCreate'
        ? incoming.captureSubjectKey
        : null;
    // Only a recorded pending-create binding can join a pending subject with
    // a session subject. An incoming session observation proves the bind
    // committed; an incoming pending-create observation for an already
    // session-owned span arrives unbound and stays a conflict.
    const sessionKey = existing.captureSubjectKind === 'session'
      ? existing.captureSubjectKey
      : incoming.captureSubjectKind === 'session'
        ? incoming.captureSubjectKey
        : null;
    const boundRoot = pendingOperationId === null ? null : bindingRootForPending(pendingOperationId);
    const promoted = pendingOperationId !== null && boundRoot !== null
      && sessionKey !== null && boundRoot === sessionKey;
    if (!promoted) {
      throw conflict(incoming.generationId, incoming.spanId, existing, incoming);
    }
  }

  const conflictKey = `activitySpan:${incoming.generationId}:${incoming.spanId}`;
  if (existing.kind !== null && incoming.kind !== null && existing.kind !== incoming.kind) {
    throw new AnalyticsSourceConflictError(
      conflictKey,
      `kind:${existing.kind}`,
      `kind:${incoming.kind}`,
    );
  }
  if (existing.startedAtMs !== null && incoming.startedAtMs !== null
    && existing.startedAtMs !== incoming.startedAtMs) {
    throw new AnalyticsSourceConflictError(
      conflictKey,
      `startedAtMs:${existing.startedAtMs}`,
      `startedAtMs:${incoming.startedAtMs}`,
    );
  }
  if (existing.endedAtMs !== null && incoming.endedAtMs !== null
    && existing.endedAtMs !== incoming.endedAtMs) {
    throw new AnalyticsSourceConflictError(
      conflictKey,
      `endedAtMs:${existing.endedAtMs}`,
      `endedAtMs:${incoming.endedAtMs}`,
    );
  }
  if (existing.durationMs !== null && incoming.durationMs !== null
    && existing.durationMs !== incoming.durationMs) {
    throw new AnalyticsSourceConflictError(
      conflictKey,
      `durationMs:${existing.durationMs}`,
      `durationMs:${incoming.durationMs}`,
    );
  }

  // A measured duration is terminal measured evidence: its value, coverage and
  // clock domain win over an observation without one, in either arrival order.
  const incomingMeasured = incoming.durationMs !== null;
  const existingMeasured = existing.durationMs !== null;
  // Only a recorded promotion (pending -> bound session) or an equal trusted
  // subject survives the checks above, so the surviving subject owns the root.
  const promoted = !sameSubject;
  const merged: ActivityProjectionSpanState = {
    generationId: incoming.generationId,
    spanId: incoming.spanId,
    captureSubjectKind: incoming.captureSubjectKind === 'session' || !promoted
      ? incoming.captureSubjectKind : existing.captureSubjectKind,
    captureSubjectKey: incoming.captureSubjectKind === 'session' || !promoted
      ? incoming.captureSubjectKey : existing.captureSubjectKey,
    rootSessionId: promoted
      ? incoming.rootSessionId
      : incoming.rootSessionId ?? existing.rootSessionId,
    kind: incoming.kind ?? existing.kind,
    clockDomain: incomingMeasured ? incoming.clockDomain
      : existingMeasured ? existing.clockDomain
        : incoming.clockDomain ?? existing.clockDomain,
    startedAtMs: incoming.startedAtMs ?? existing.startedAtMs,
    endedAtMs: incoming.endedAtMs ?? existing.endedAtMs,
    durationMs: incomingMeasured ? incoming.durationMs : existing.durationMs,
    coverage: incomingMeasured ? incoming.coverage
      : existingMeasured ? existing.coverage
        : incoming.coverage ?? existing.coverage,
  };
  return { merged };
}

function memberFromRow(row: Record<string, unknown>): ActivityProjectionSpanState {
  return {
    generationId: String(row.generation_id),
    spanId: String(row.span_id),
    captureSubjectKind: String(row.capture_subject_kind),
    captureSubjectKey: String(row.capture_subject_key),
    rootSessionId: row.root_session_id === null || row.root_session_id === undefined
      ? null : String(row.root_session_id),
    kind: row.activity_kind === null || row.activity_kind === undefined ? null : String(row.activity_kind),
    clockDomain: row.clock_domain === null || row.clock_domain === undefined ? null : String(row.clock_domain),
    startedAtMs: row.started_at_ms === null || row.started_at_ms === undefined ? null : String(row.started_at_ms),
    endedAtMs: row.ended_at_ms === null || row.ended_at_ms === undefined ? null : String(row.ended_at_ms),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    coverage: row.coverage === null || row.coverage === undefined ? null : String(row.coverage),
  };
}

/** Accept one activity span observation into the projection and return the
 * merged state for the recorder's state row. Called inside the recorder's
 * write transaction, after subject resolution, so a pending-create observation
 * that already reached its bound session subject arrives session-owned. */
export function applyActivityProjection(
  database: ActivityProjectionDatabase,
  incoming: ActivityProjectionSpanState,
  revision: string,
): { merged: ActivityProjectionSpanState } {
  const existingRow = database.prepare(`
    SELECT generation_id, span_id, capture_subject_kind, capture_subject_key, root_session_id,
      activity_kind, clock_domain, started_at_ms, ended_at_ms, duration_ms, coverage
    FROM analytics_activity_projection_members
    WHERE generation_id = ? AND span_id = ?
  `).get(incoming.generationId, incoming.spanId) as Record<string, unknown> | undefined;
  const existing = existingRow ? memberFromRow(existingRow) : null;
  const { merged } = mergeActivitySpan(existing, incoming, (pendingOperationId) => {
    const binding = database.prepare(`
      SELECT root_session_id FROM analytics_pending_subject_bindings WHERE pending_operation_id = ?
    `).get(pendingOperationId) as { root_session_id: string } | undefined;
    return binding ? String(binding.root_session_id) : null;
  });
  applyContributionDelta(database, existing, merged, revision);
  database.prepare(`
    INSERT INTO analytics_activity_projection_members (
      generation_id, span_id, capture_subject_kind, capture_subject_key, root_session_id,
      activity_kind, clock_domain, started_at_ms, ended_at_ms, duration_ms, coverage,
      projection_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id, span_id) DO UPDATE SET
      capture_subject_kind = excluded.capture_subject_kind,
      capture_subject_key = excluded.capture_subject_key,
      root_session_id = excluded.root_session_id,
      activity_kind = excluded.activity_kind,
      clock_domain = excluded.clock_domain,
      started_at_ms = excluded.started_at_ms,
      ended_at_ms = excluded.ended_at_ms,
      duration_ms = excluded.duration_ms,
      coverage = excluded.coverage,
      projection_revision = excluded.projection_revision
  `).run(
    merged.generationId, merged.spanId, merged.captureSubjectKind, merged.captureSubjectKey,
    merged.rootSessionId, merged.kind, merged.clockDomain, merged.startedAtMs, merged.endedAtMs,
    merged.durationMs, merged.coverage, revision,
  );
  return { merged };
}

/** Move a bound pending-create subject's retained spans into its session:
 * ownership columns and the session-scope summary contribution change together.
 * Spans already promoted (the bind committed first) are absent from the
 * pending subject and stay untouched, so either arrival order converges. */
export function movePendingActivityProjection(
  database: ActivityProjectionDatabase,
  pendingOperationId: string,
  rootSessionId: string,
  revision: string,
): void {
  const rows = database.prepare(`
    SELECT generation_id, span_id, capture_subject_kind, capture_subject_key, root_session_id,
      activity_kind, clock_domain, started_at_ms, ended_at_ms, duration_ms, coverage
    FROM analytics_activity_projection_members
    WHERE capture_subject_kind = 'pendingCreate' AND capture_subject_key = ?
  `).all(pendingOperationId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const state = memberFromRow(row);
    const promoted: ActivityProjectionSpanState = {
      ...state,
      captureSubjectKind: 'session',
      captureSubjectKey: rootSessionId,
      rootSessionId,
    };
    applyContributionDelta(database, state, promoted, revision);
    database.prepare(`
      UPDATE analytics_activity_projection_members
      SET capture_subject_kind = 'session', capture_subject_key = ?, root_session_id = ?,
        projection_revision = ?
      WHERE generation_id = ? AND span_id = ?
    `).run(rootSessionId, rootSessionId, revision, state.generationId, state.spanId);
  }
}

/** The recorder's root-attribution filter. The leading session predicate and
 * the bound pending-create branch both resolve through the capture-subject
 * index, so root deletion never degrades to a full member scan. */
export function activityProjectionSubjectFilter(): string {
  return `(
    capture_subject_kind = 'session' AND capture_subject_key = ?
  ) OR (
    capture_subject_kind = 'pendingCreate' AND capture_subject_key IN (
      SELECT pending_operation_id FROM analytics_pending_subject_bindings WHERE root_session_id = ?
    )
  )`;
}

/** Remove one root's retained spans and subtract exactly their contributions.
 * Runs in the caller's transaction: an interrupted removal either publishes
 * the full summary correction or leaves the rows in place for the idempotent
 * retry, and a re-run finds no members and changes nothing. */
export function removeActivityProjectionForRoot(
  database: ActivityProjectionDatabase,
  rootSessionId: string,
  revision: string,
): void {
  const filter = activityProjectionSubjectFilter();
  const rows = database.prepare(`
    SELECT generation_id, span_id, capture_subject_kind, capture_subject_key, root_session_id,
      activity_kind, clock_domain, started_at_ms, ended_at_ms, duration_ms, coverage
    FROM analytics_activity_projection_members
    WHERE ${filter}
  `).all(rootSessionId, rootSessionId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  // Accumulate the per-scope summary deltas before deleting, so the correction
  // is derived from the rows this removal is actually deleting.
  const totals = new Map<string, ContributionDelta>();
  const accumulate = (scopeKind: 'global' | 'session', scopeKey: string, contribution: SpanContribution): void => {
    const key = JSON.stringify([scopeKind, scopeKey, contribution.kindKey]);
    const current = totals.get(key);
    const next: ContributionDelta = {
      spanCount: -contribution.spanCount,
      observedCount: -contribution.observedCount,
      estimatedCount: -contribution.estimatedCount,
      unknownCount: -contribution.unknownCount,
      measuredKnownCount: -contribution.measuredKnownCount,
      measuredUnknownCount: -contribution.measuredUnknownCount,
      measuredTotalMs: -contribution.measuredTotalMs,
    };
    if (!current) {
      totals.set(key, next);
      return;
    }
    for (const column of Object.keys(current) as Array<keyof ContributionDelta>) {
      current[column] += next[column];
    }
  };
  for (const row of rows) {
    const state = memberFromRow(row);
    const contribution = spanContribution(state);
    accumulate('global', '*', contribution);
    if (state.rootSessionId !== null) accumulate('session', state.rootSessionId, contribution);
  }
  database.prepare(`DELETE FROM analytics_activity_projection_members WHERE ${filter}`)
    .run(rootSessionId, rootSessionId);
  for (const [key, delta] of totals) {
    const [scopeKind, scopeKey, kindKey] = JSON.parse(key) as ['global' | 'session', string, string];
    applySummaryDelta(
      database,
      scopeKind as 'global' | 'session',
      scopeKey,
      kindKey,
      delta,
      revision,
    );
  }
}

export function createActivityProjectionSchema(database: ActivityProjectionDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS analytics_activity_projection_members (
      generation_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      activity_kind TEXT,
      clock_domain TEXT,
      started_at_ms TEXT,
      ended_at_ms TEXT,
      duration_ms REAL,
      coverage TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, span_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_activity_projection_member_subject_idx
      ON analytics_activity_projection_members(capture_subject_kind, capture_subject_key);
    CREATE INDEX IF NOT EXISTS analytics_activity_projection_member_root_idx
      ON analytics_activity_projection_members(root_session_id, projection_revision);
    CREATE TABLE IF NOT EXISTS analytics_activity_summary (
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'session')),
      scope_key TEXT NOT NULL,
      activity_kind TEXT NOT NULL,
      span_count TEXT NOT NULL,
      observed_count TEXT NOT NULL,
      estimated_count TEXT NOT NULL,
      unknown_count TEXT NOT NULL,
      measured_known_count TEXT NOT NULL,
      measured_unknown_count TEXT NOT NULL,
      measured_total_ms REAL NOT NULL,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(scope_kind, scope_key, activity_kind)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_activity_observation_subject_idx
      ON analytics_activity_observations(capture_subject_kind, capture_subject_key);
  `);
}

function safeSummaryCount(value: unknown, name: string): number {
  const parsed = Number(BigInt(String(value)));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Activity projection ${name} exceeds the safe count range.`);
  }
  return parsed;
}

function decodeCounts(row: Record<string, unknown>): ActivityProjectionCounts {
  return {
    spanCount: safeSummaryCount(row.span_count, 'span_count'),
    observedCount: safeSummaryCount(row.observed_count, 'observed_count'),
    estimatedCount: safeSummaryCount(row.estimated_count, 'estimated_count'),
    unknownCount: safeSummaryCount(row.unknown_count, 'unknown_count'),
    measuredKnownCount: safeSummaryCount(row.measured_known_count, 'measured_known_count'),
    measuredUnknownCount: safeSummaryCount(row.measured_unknown_count, 'measured_unknown_count'),
    measuredTotalMs: typeof row.measured_total_ms === 'number' && Number.isFinite(row.measured_total_ms)
      && row.measured_total_ms >= 0 ? row.measured_total_ms : 0,
  };
}

function emptyTotalsRow(): Record<string, unknown> {
  return {
    span_count: '0', observed_count: '0', estimated_count: '0', unknown_count: '0',
    measured_known_count: '0', measured_unknown_count: '0', measured_total_ms: 0,
  };
}

/** Read one scope's bounded maintained summary. Never rebuilds from history:
 * immutable activity observations remain available to raw SQL for any query
 * the maintained summary does not answer. */
export function readActivityProjection(
  database: ActivityProjectionDatabase,
  request: ActivityProjectionReadRequest,
  revision: number | string,
): ActivityProjectionReadModel {
  const scope = request.rootSessionId === undefined
    ? { kind: 'global' as const, key: '*' }
    : { kind: 'session' as const, key: request.rootSessionId };
  const maxKinds = request.maxKinds ?? 64;
  const kindRows = database.prepare(`
    SELECT activity_kind, span_count, observed_count, estimated_count, unknown_count,
      measured_known_count, measured_unknown_count, measured_total_ms
    FROM analytics_activity_summary
    WHERE scope_kind = ? AND scope_key = ?
    ORDER BY activity_kind
    LIMIT ?
  `).all(scope.kind, scope.key, maxKinds + 1) as Array<Record<string, unknown>>;
  const truncated = kindRows.length > maxKinds;
  const selected = truncated ? kindRows.slice(0, maxKinds) : kindRows;
  const totalsRow = database.prepare(`
    SELECT CAST(COALESCE(SUM(CAST(span_count AS INTEGER)), 0) AS TEXT) AS span_count,
      CAST(COALESCE(SUM(CAST(observed_count AS INTEGER)), 0) AS TEXT) AS observed_count,
      CAST(COALESCE(SUM(CAST(estimated_count AS INTEGER)), 0) AS TEXT) AS estimated_count,
      CAST(COALESCE(SUM(CAST(unknown_count AS INTEGER)), 0) AS TEXT) AS unknown_count,
      CAST(COALESCE(SUM(CAST(measured_known_count AS INTEGER)), 0) AS TEXT) AS measured_known_count,
      CAST(COALESCE(SUM(CAST(measured_unknown_count AS INTEGER)), 0) AS TEXT) AS measured_unknown_count,
      COALESCE(SUM(measured_total_ms), 0) AS measured_total_ms
    FROM analytics_activity_summary
    WHERE scope_kind = ? AND scope_key = ?
  `).get(scope.kind, scope.key) as Record<string, unknown> | undefined;
  return {
    revision,
    scope: scope.kind === 'global'
      ? { kind: 'global' }
      : { kind: 'session', rootSessionId: scope.key },
    kinds: selected.map((row) => ({
      activityKind: row.activity_kind === null || row.activity_kind === undefined
        ? null : String(row.activity_kind) === '' ? null : String(row.activity_kind),
      ...decodeCounts(row),
    })),
    totals: decodeCounts(totalsRow ?? emptyTotalsRow()),
    truncated,
  };
}