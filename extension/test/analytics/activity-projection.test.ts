import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSourceConflictError,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { activityProjectionSubjectFilter } from '../../src/analytics/activity-projection.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
  };
};

interface ActivityObservationOptions {
  sourceKey: string;
  spanId: string;
  observationKind: 'begin' | 'end';
  rootSessionId?: string;
  captureSubject?: AnalyticsObservation['captureSubject'];
  generationId?: string;
  observedAtMs?: number;
  kind?: string;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  durationMs?: number | null;
  clockDomain?: string | null;
  coverage?: 'observed' | 'estimated' | 'unknown';
}

function activityObservation(options: ActivityObservationOptions): AnalyticsObservation {
  const rootSessionId = options.rootSessionId ?? 'root-a';
  const captureSubject = options.captureSubject ?? { kind: 'session' as const, rootSessionId };
  const base = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId ?? 'generation-1',
    producerKind: 'test',
    sourceKey: options.sourceKey,
    entityKind: 'activitySpan' as const,
    entityKey: options.spanId,
    observationKind: options.observationKind,
    observedAtMs: options.observedAtMs ?? 1_750_000_000_000,
    scope: {
      workspaceCoverage: 'known' as const,
      workspaceId: 'workspace-a',
      ...(captureSubject.kind === 'session' ? { rootSessionId } : {}),
    },
    captureSubject,
    producer: { buildId: 'test-build', processGeneration: 'test-process-1' },
    fields: {
      spanId: options.spanId,
      kind: options.kind ?? 'tool',
      startedAtMs: options.startedAtMs ?? null,
      endedAtMs: options.endedAtMs ?? null,
      durationMs: options.durationMs ?? null,
      clockDomain: options.clockDomain ?? 'wall-clock-utc',
      coverage: options.coverage ?? 'unknown',
    },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-activity-'));
  return { root, databasePath: path.join(root, 'analytics.sqlite') };
}

interface MemberRow {
  generation_id: string;
  span_id: string;
  capture_subject_kind: string;
  capture_subject_key: string;
  root_session_id: string | null;
  activity_kind: string | null;
  clock_domain: string | null;
  started_at_ms: string | null;
  ended_at_ms: string | null;
  duration_ms: number | null;
  coverage: string | null;
}

function memberRows(recorder: SqliteAnalyticsRecorder): MemberRow[] {
  return recorder.executeReadOnlyQuery(`
    SELECT generation_id, span_id, capture_subject_kind, capture_subject_key, root_session_id,
      activity_kind, clock_domain, started_at_ms, ended_at_ms, duration_ms, coverage
    FROM analytics_activity_projection_members
    ORDER BY span_id
  `).rows as unknown as MemberRow[];
}

function member(recorder: SqliteAnalyticsRecorder, spanId: string): MemberRow {
  const rows = memberRows(recorder).filter((row) => row.span_id === spanId);
  assert.equal(rows.length, 1, `expected exactly one member row for ${spanId}`);
  return rows[0]!;
}

/** Named regression: additive work vs wall union, and scoped unknown counts
 * stay isolated from known totals. */
test('activity projection sums additive measured work and isolates unknown counts per scope', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    // Two overlapping tool spans on the same session: additive work is the sum
    // of measured durations (15 s), not the wall union of the anchors (10 s).
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-a:end', spanId: 'tool-a', observationKind: 'end',
      kind: 'tool', startedAtMs: 0, endedAtMs: 10_000, durationMs: 10_000,
      clockDomain: 'wall-clock-utc', coverage: 'observed',
    }));
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-b:end', spanId: 'tool-b', observationKind: 'end',
      kind: 'tool', startedAtMs: 3_000, endedAtMs: 8_000, durationMs: 5_000,
      clockDomain: 'wall-clock-utc', coverage: 'observed',
    }));
    // An unknown retry duration contributes an unknown count, never a zero.
    recorder.submit(activityObservation({
      sourceKey: 'activity:retry-wait:end', spanId: 'retry-wait-a', observationKind: 'end',
      kind: 'retry_wait', startedAtMs: 1_000, endedAtMs: 2_000, durationMs: null,
      clockDomain: 'wall-clock-utc', coverage: 'unknown',
    }));
    // An estimated span keeps its separate coverage count.
    recorder.submit(activityObservation({
      sourceKey: 'activity:busy-a:end', spanId: 'busy-a', observationKind: 'end',
      rootSessionId: 'root-b', kind: 'busy', startedAtMs: 0, endedAtMs: 2_000,
      durationMs: 2_000, clockDomain: 'wall-clock-utc', coverage: 'estimated',
    }));

    const global = recorder.readActivityProjection();
    assert.equal(global.scope.kind, 'global');
    assert.equal(global.truncated, false);
    assert.deepEqual(global.totals, {
      spanCount: 4, observedCount: 2, estimatedCount: 1, unknownCount: 1,
      measuredKnownCount: 3, measuredUnknownCount: 1, measuredTotalMs: 17_000,
    });
    const toolRow = global.kinds.find((row) => row.activityKind === 'tool');
    assert.ok(toolRow);
    assert.deepEqual({ ...toolRow, activityKind: 'tool' }, {
      activityKind: 'tool', spanCount: 2, observedCount: 2, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 2, measuredUnknownCount: 0, measuredTotalMs: 15_000,
    });
    const retryRow = global.kinds.find((row) => row.activityKind === 'retry_wait');
    assert.ok(retryRow);
    // The unknown duration stays isolated: it is not folded into the measured
    // total, and the kind's spanCount is not presented as fully measured.
    assert.deepEqual({ ...retryRow, activityKind: 'retry_wait' }, {
      activityKind: 'retry_wait', spanCount: 1, observedCount: 0, estimatedCount: 0, unknownCount: 1,
      measuredKnownCount: 0, measuredUnknownCount: 1, measuredTotalMs: 0,
    });

    const rootA = recorder.readActivityProjection({ rootSessionId: 'root-a' });
    assert.equal(rootA.scope.kind, 'session');
    assert.deepEqual(rootA.totals, {
      spanCount: 3, observedCount: 2, estimatedCount: 0, unknownCount: 1,
      measuredKnownCount: 2, measuredUnknownCount: 1, measuredTotalMs: 15_000,
    });
    const rootB = recorder.readActivityProjection({ rootSessionId: 'root-b' });
    assert.deepEqual(rootB.totals, {
      spanCount: 1, observedCount: 0, estimatedCount: 1, unknownCount: 0,
      measuredKnownCount: 1, measuredUnknownCount: 0, measuredTotalMs: 2_000,
    });
    // An empty scope has zero occurrences, not unknown ones.
    const empty = recorder.readActivityProjection({ rootSessionId: 'root-empty' });
    assert.deepEqual(empty.totals, {
      spanCount: 0, observedCount: 0, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 0, measuredUnknownCount: 0, measuredTotalMs: 0,
    });
    assert.deepEqual(empty.kinds, []);

    // The member anchors stay untouched so an explicit wall-union query would
    // compute 10 s for the overlapping tool spans, while the summary keeps the
    // additive 15 s. The projection never conflates the two semantics.
    const anchors = memberRows(recorder).filter((row) => row.activity_kind === 'tool')
      .map((row) => ({ started: Number(row.started_at_ms), ended: Number(row.ended_at_ms) }));
    assert.deepEqual(anchors, [
      { started: 0, ended: 10_000 }, { started: 3_000, ended: 8_000 },
    ]);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

/** Named regression: trusted capture-subject ownership is order-independent
 * and conflicting owners are rejected visibly. */
test('activity span ownership merges across pending-create binding in any arrival order and rejects conflicts', () => {
  const buildOrder = (
    order: 'begin-first' | 'begin-after-bind' | 'end-first',
    root: string,
    databasePath: string,
  ): { global: number; session: number; member: MemberRow | undefined } => {
    const recorder = new SqliteAnalyticsRecorder(databasePath);
    try {
      const pending = { kind: 'pendingCreate' as const, operationId: `${root}-op` };
      const bound = { kind: 'session' as const, rootSessionId: root };
      if (order === 'begin-after-bind') {
        recorder.bindPendingCreate(`${root}-op`, root, `${root}-bind-source`, 100);
        recorder.submit(activityObservation({
          sourceKey: `${root}:begin`, spanId: 'order-span', observationKind: 'begin',
          rootSessionId: root, captureSubject: bound, kind: 'tool', startedAtMs: 100, coverage: 'observed',
        }));
        recorder.submit(activityObservation({
          sourceKey: `${root}:end`, spanId: 'order-span', observationKind: 'end',
          rootSessionId: root, captureSubject: bound, kind: 'tool', startedAtMs: 100, endedAtMs: 600,
          durationMs: 500, clockDomain: 'monotonic-same-process', coverage: 'observed',
        }));
      } else if (order === 'begin-first') {
        recorder.submit(activityObservation({
          sourceKey: `${root}:begin`, spanId: 'order-span', observationKind: 'begin',
          captureSubject: pending, kind: 'tool', startedAtMs: 100, coverage: 'observed',
        }));
        recorder.bindPendingCreate(`${root}-op`, root, `${root}-bind-source`, 300);
        recorder.submit(activityObservation({
          sourceKey: `${root}:end`, spanId: 'order-span', observationKind: 'end',
          rootSessionId: root, captureSubject: bound, kind: 'tool', startedAtMs: 100, endedAtMs: 600,
          durationMs: 500, clockDomain: 'monotonic-same-process', coverage: 'observed',
        }));
      } else {
        recorder.submit(activityObservation({
          sourceKey: `${root}:end`, spanId: 'order-span', observationKind: 'end',
          captureSubject: pending, kind: 'tool', startedAtMs: 100, endedAtMs: 600,
          durationMs: 500, clockDomain: 'monotonic-same-process', coverage: 'observed',
        }));
        recorder.bindPendingCreate(`${root}-op`, root, `${root}-bind-source`, 300);
        recorder.submit(activityObservation({
          sourceKey: `${root}:begin`, spanId: 'order-span', observationKind: 'begin',
          rootSessionId: root, captureSubject: bound, kind: 'tool', startedAtMs: 100, coverage: 'observed',
        }));
      }
      const read = recorder.readActivityProjection({ rootSessionId: root });
      const member = (memberRows(recorder).find((row) => row.span_id === 'order-span')) ?? undefined;
      return { global: recorder.readActivityProjection().totals.spanCount, session: read.totals.spanCount, member };
    } finally {
      recorder.close();
    }
  };

  const beginFirst = tempDatabase();
  const beginAfterBind = tempDatabase();
  const endFirst = tempDatabase();
  try {
    const first = buildOrder('begin-first', 'root-order', beginFirst.databasePath);
    const afterBind = buildOrder('begin-after-bind', 'root-order', beginAfterBind.databasePath);
    const reversed = buildOrder('end-first', 'root-order', endFirst.databasePath);
    for (const outcome of [first, afterBind, reversed]) {
      assert.equal(outcome.global, 1);
      assert.equal(outcome.session, 1);
      assert.deepEqual(outcome.member, {
        generation_id: 'generation-1',
        span_id: 'order-span',
        capture_subject_kind: 'session',
        capture_subject_key: 'root-order',
        root_session_id: 'root-order',
        activity_kind: 'tool',
        clock_domain: 'monotonic-same-process',
        started_at_ms: '100',
        ended_at_ms: '600',
        duration_ms: 500,
        coverage: 'observed',
      });
    }

    // A different trusted subject for the same span identity is a visible
    // conflict, never a silent re-ownership.
    const conflict = tempDatabase();
    try {
      const recorder = new SqliteAnalyticsRecorder(conflict.databasePath);
      try {
        recorder.submit(activityObservation({
          sourceKey: 'conflict-span:end', spanId: 'conflict-span', observationKind: 'end',
          rootSessionId: 'root-a', kind: 'tool', durationMs: 500, coverage: 'observed',
        }));
        assert.throws(
          () => recorder.submit(activityObservation({
            sourceKey: 'conflict-span:end-other', spanId: 'conflict-span', observationKind: 'end',
            rootSessionId: 'root-b', kind: 'tool', durationMs: 500, coverage: 'observed',
          })),
          (error: unknown) => error instanceof AnalyticsSourceConflictError
            && error.registryKey === 'activitySpan:generation-1:conflict-span',
        );
        assert.equal(recorder.readActivityProjection({ rootSessionId: 'root-a' }).totals.spanCount, 1);
        assert.equal(recorder.readActivityProjection({ rootSessionId: 'root-b' }).totals.spanCount, 0);
        assert.equal(recorder.readActivityProjection().totals.spanCount, 1);
        // An unbound pending-create subject cannot merge into a session-owned span.
        assert.throws(
          () => recorder.submit(activityObservation({
            sourceKey: 'conflict-span:end-pending', spanId: 'conflict-span', observationKind: 'end',
            captureSubject: { kind: 'pendingCreate', operationId: 'unbound-op' },
            kind: 'tool', durationMs: 500, coverage: 'observed',
          })),
          AnalyticsSourceConflictError,
        );
        // Conflicting measured facts under the same owner are also rejected.
        assert.throws(
          () => recorder.submit(activityObservation({
            sourceKey: 'conflict-span:end-different', spanId: 'conflict-span', observationKind: 'end',
            rootSessionId: 'root-a', kind: 'tool', durationMs: 900, coverage: 'observed',
          })),
          AnalyticsSourceConflictError,
        );
        assert.equal(recorder.readActivityProjection().totals.measuredTotalMs, 500);
      } finally {
        recorder.close();
      }
    } finally {
      rmSync(conflict.root, { recursive: true, force: true });
    }
  } finally {
    for (const fixture of [beginFirst, beginAfterBind, endFirst]) {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

/** Named regression: a measured monotonic duration is additive work even when
 * its wall anchors are reversed or missing. */
test('measured monotonic durations survive reversed or missing wall anchors', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    // Reversed wall anchors with a measured monotonic duration: the duration is
    // preserved, the anchors stay exactly as delivered, and coverage stays observed.
    recorder.submit(activityObservation({
      sourceKey: 'activity:retry-wait-reversed:end', spanId: 'retry-wait-reversed', observationKind: 'end',
      rootSessionId: 'root-a', kind: 'retry_wait', startedAtMs: 5_000, endedAtMs: 1_000,
      durationMs: 4_000, clockDomain: 'monotonic-same-process', coverage: 'observed',
    }));
    // A measured monotonic duration with no wall anchors at all.
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-mono:end', spanId: 'tool-mono', observationKind: 'end',
      rootSessionId: 'root-a', kind: 'tool', startedAtMs: null, endedAtMs: null,
      durationMs: 2_500, clockDomain: 'monotonic-same-process', coverage: 'observed',
    }));
    // A wall-derived duration against reversed bounds is unknown, never a
    // clamped zero or an invented duration.
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-reversed-wall:end', spanId: 'tool-reversed-wall', observationKind: 'end',
      rootSessionId: 'root-a', kind: 'tool', startedAtMs: 100, endedAtMs: 50,
      durationMs: null, clockDomain: 'wall-clock-utc', coverage: 'unknown',
    }));

    const read = recorder.readActivityProjection({ rootSessionId: 'root-a' });
    assert.deepEqual(read.totals, {
      spanCount: 3, observedCount: 2, estimatedCount: 0, unknownCount: 1,
      measuredKnownCount: 2, measuredUnknownCount: 1, measuredTotalMs: 6_500,
    });
    const reversedMember = member(recorder, 'retry-wait-reversed');
    assert.equal(reversedMember.clock_domain, 'monotonic-same-process');
    assert.equal(reversedMember.started_at_ms, '5000');
    assert.equal(reversedMember.ended_at_ms, '1000');
    assert.equal(reversedMember.duration_ms, 4_000);
    assert.equal(reversedMember.coverage, 'observed');
    const anchorless = member(recorder, 'tool-mono');
    assert.equal(anchorless.clock_domain, 'monotonic-same-process');
    assert.equal(anchorless.started_at_ms, null);
    assert.equal(anchorless.ended_at_ms, null);
    assert.equal(anchorless.duration_ms, 2_500);
    const wallUnknown = member(recorder, 'tool-reversed-wall');
    assert.equal(wallUnknown.duration_ms, null);
    assert.equal(wallUnknown.coverage, 'unknown');
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

/** Named regression: schema 11 -> 12 migrates stored activity facts without
 * fabricating timestamps or clock domains and without collapsing late-merged
 * evidence; a reopen after migration never re-seeds. */
test('schema 11 activity facts migrate with preserved anchors, recovered clock domains, and stable reopen', () => {
  const temp = tempDatabase();
  let totalsBeforeMigration: Record<string, unknown>;
  let sessionTotalsBeforeMigration: Record<string, unknown>;
  {
    const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
    try {
      // Facts a schema-11 database already retained: a measured monotonic retry
      // span with reversed anchors, an open begin-only span with no duration,
      // and a wall span with an unknown duration.
      recorder.submit(activityObservation({
        sourceKey: 'activity:retry-wait-mono:end', spanId: 'retry-wait-mono', observationKind: 'end',
        rootSessionId: 'root-a', kind: 'retry_wait', startedAtMs: 5_000, endedAtMs: 1_000,
        durationMs: 4_000, clockDomain: 'monotonic-same-process', coverage: 'observed',
      }));
      recorder.submit(activityObservation({
        sourceKey: 'activity:busy-open:begin', spanId: 'busy-open', observationKind: 'begin',
        rootSessionId: 'root-a', kind: 'busy', startedAtMs: 900, endedAtMs: null,
        durationMs: null, clockDomain: 'wall-clock-utc', coverage: 'observed',
      }));
      recorder.submit(activityObservation({
        sourceKey: 'activity:tool-unknown:end', spanId: 'tool-unknown', observationKind: 'end',
        rootSessionId: 'root-b', kind: 'tool', startedAtMs: 10, endedAtMs: 20,
        durationMs: null, clockDomain: 'wall-clock-utc', coverage: 'unknown',
      }));
      totalsBeforeMigration = { ...recorder.readActivityProjection().totals } as Record<string, unknown>;
      sessionTotalsBeforeMigration = {
        ...recorder.readActivityProjection({ rootSessionId: 'root-a' }).totals,
      } as Record<string, unknown>;
    } finally {
      recorder.close();
    }
  }

  // Downgrade the projection structure to a schema-11 database: the stored
  // activity facts in analytics_activity_states are what migration has to
  // preserve, and no projection rows may survive the downgrade.
  const raw = new DatabaseSync(temp.databasePath);
  try {
    raw.exec(`
      DROP TABLE analytics_activity_projection_members;
      DROP TABLE analytics_activity_summary;
      DROP INDEX IF EXISTS analytics_activity_observation_subject_idx;
      PRAGMA user_version = 11;
    `);
  } finally {
    raw.close();
  }

  const reopened = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    assert.equal(reopened.getDatabaseSchemaVersion(), 13);
    assert.deepEqual(reopened.readActivityProjection().totals, totalsBeforeMigration);
    assert.deepEqual(
      reopened.readActivityProjection({ rootSessionId: 'root-a' }).totals,
      sessionTotalsBeforeMigration,
    );
    // The measured clock domain is recovered from the observation that carried
    // the measured duration; an open span without any measured duration keeps
    // an unknown clock domain instead of a fabricated wall-clock label.
    const mono = member(reopened, 'retry-wait-mono');
    assert.equal(mono.clock_domain, 'monotonic-same-process');
    assert.equal(mono.duration_ms, 4_000);
    assert.equal(mono.started_at_ms, '5000');
    assert.equal(mono.ended_at_ms, '1000');
    const open = member(reopened, 'busy-open');
    assert.equal(open.clock_domain, null);
    assert.equal(open.ended_at_ms, null);
    assert.equal(open.duration_ms, null);
    assert.equal(open.coverage, 'observed');
    const unknownSpan = member(reopened, 'tool-unknown');
    assert.equal(unknownSpan.duration_ms, null);
    assert.equal(unknownSpan.coverage, 'unknown');
    // Late evidence merged before the upgrade stays merged: the begin-only
    // member keeps its observed open-state instead of collapsing to unknown.
    assert.equal(reopened.readActivityProjection().totals.measuredUnknownCount, 2);

    // Reopening again must not re-seed or double-count.
    reopened.close();
    const again = new SqliteAnalyticsRecorder(temp.databasePath);
    try {
      assert.equal(again.getDatabaseSchemaVersion(), 13);
      assert.deepEqual(again.readActivityProjection().totals, totalsBeforeMigration);
    } finally {
      again.close();
    }
  } finally {
    reopened.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

/** Named regression: private-close removal is transactional, resumable and
 * publishes its revision; late pending-create evidence on a deleted subject is
 * removed too. */
test('private close removes activity members and summary contributions transactionally and idempotently', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    const pending = { kind: 'pendingCreate' as const, operationId: 'late-delete-op' };
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-delivered:end', spanId: 'tool-delivered', observationKind: 'end',
      rootSessionId: 'root-delete', kind: 'tool', startedAtMs: 0, endedAtMs: 1_000,
      durationMs: 1_000, clockDomain: 'wall-clock-utc', coverage: 'observed',
    }));
    recorder.submit(activityObservation({
      sourceKey: 'activity:retry-wait-delivered:end', spanId: 'retry-wait-delivered', observationKind: 'end',
      // Kind is free text; embedded separators must not corrupt deletion summary keys.
      rootSessionId: 'root-delete', kind: 'retry\u0000wait', startedAtMs: null, endedAtMs: null,
      durationMs: null, clockDomain: 'wall-clock-utc', coverage: 'unknown',
    }));
    // An unrelated root must survive the deletion untouched.
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-kept:end', spanId: 'tool-kept', observationKind: 'end',
      rootSessionId: 'root-kept', kind: 'tool', startedAtMs: 0, endedAtMs: 2_000,
      durationMs: 2_000, clockDomain: 'wall-clock-utc', coverage: 'observed',
    }));
    // An unbound pending span also lands in the global scope only.
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-late:end', spanId: 'tool-late', observationKind: 'end',
      captureSubject: pending, kind: 'tool', durationMs: 500, coverage: 'observed',
    }));
    const beforeRevision = recorder.readActivityProjection().projectionRevision;
    assert.deepEqual(recorder.readActivityProjection().totals, {
      spanCount: 4, observedCount: 3, estimatedCount: 0, unknownCount: 1,
      measuredKnownCount: 3, measuredUnknownCount: 1, measuredTotalMs: 3_500,
    });

    const receipt = recorder.deleteSession('root-delete', 'delete-root-delete', 5_000);
    assert.equal(receipt.deletedObservationCount, 2);
    assert.equal(receipt.duplicate, false);
    const after = recorder.readActivityProjection();
    assert.equal(after.projectionRevision !== beforeRevision, true);
    assert.deepEqual(after.totals, {
      spanCount: 2, observedCount: 2, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 2, measuredUnknownCount: 0, measuredTotalMs: 2_500,
    });
    assert.equal(recorder.readActivityProjection({ rootSessionId: 'root-delete' }).totals.spanCount, 0);
    assert.deepEqual(
      memberRows(recorder).filter((row) => row.root_session_id === 'root-delete'),
      [],
    );
    // The maintained summary stays exactly equal to the member rows it
    // summarizes after removal (transactional coherence, not a stale rollup).
    assert.deepEqual(recorder.executeReadOnlyQuery(`
      SELECT (SELECT COUNT(*) FROM analytics_activity_projection_members) AS members,
        (SELECT CAST(COALESCE(SUM(CAST(span_count AS INTEGER)), 0) AS TEXT)
          FROM analytics_activity_summary WHERE scope_kind = 'global') AS summarized
    `).rows[0], { members: 2, summarized: '2' });

    // A duplicate delete is idempotent: the fence reports the original counts
    // and no summary underflows or resurrects.
    const duplicate = recorder.deleteSession('root-delete', 'delete-root-delete', 6_000);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(recorder.readActivityProjection().totals, {
      spanCount: 2, observedCount: 2, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 2, measuredUnknownCount: 0, measuredTotalMs: 2_500,
    });

    // Late pending-create evidence for the deleted subject is bound and then
    // removed, not resurrected.
    const bind = recorder.bindPendingCreate('late-delete-op', 'root-delete', 'late-delete-source', 7_000);
    assert.equal(bind.deletedSubject, true);
    assert.deepEqual(recorder.readActivityProjection().totals, {
      spanCount: 1, observedCount: 1, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 1, measuredUnknownCount: 0, measuredTotalMs: 2_000,
    });

    // A fresh root keeps recording after the deletion with correct deltas.
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-after:end', spanId: 'tool-after', observationKind: 'end',
      rootSessionId: 'root-next', kind: 'tool', durationMs: 500, coverage: 'observed',
    }));
    assert.equal(recorder.readActivityProjection().totals.spanCount, 2);
    assert.equal(recorder.readActivityProjection({ rootSessionId: 'root-next' }).totals.spanCount, 1);
  } finally {
    recorder.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

/** Named regression: the leading root-deletion member lookups are index-led. */
test('root deletion member lookups use the subject index without a full scan', () => {
  const temp = tempDatabase();
  const recorder = new SqliteAnalyticsRecorder(temp.databasePath);
  try {
    recorder.submit(activityObservation({
      sourceKey: 'activity:tool-indexed:end', spanId: 'tool-indexed', observationKind: 'end',
      rootSessionId: 'root-indexed', kind: 'tool', durationMs: 1_000, coverage: 'observed',
    }));
  } finally {
    recorder.close();
  }
  // EXPLAIN QUERY PLAN compiles without executing, so a raw read-only
  // connection can plan the recorder's actual deletion statements; the
  // recorder's own read path denies mutation statements by design.
  const raw = new DatabaseSync(temp.databasePath, { readOnly: true });
  try {
    const filter = activityProjectionSubjectFilter();
    const planFor = (table: string, index: string): { search: boolean; scan: boolean } => {
      const rows = raw.prepare(`
        EXPLAIN QUERY PLAN
        DELETE FROM ${table}
        WHERE ${filter}
      `).all('root-indexed', 'root-indexed') as Array<{ detail?: unknown }>;
      const details = rows.map((row) => String(row.detail ?? ''));
      return {
        search: details.some((detail) => detail.includes(index)),
        scan: details.some((detail) => new RegExp(`SCAN ${table}(?![A-Za-z_])`).test(detail)),
      };
    };
    const memberPlan = planFor(
      'analytics_activity_projection_members', 'analytics_activity_projection_member_subject_idx',
    );
    assert.equal(memberPlan.search, true,
      'expected the member subject index in the deletion plan');
    assert.equal(memberPlan.scan, false);
    const observationPlan = planFor(
      'analytics_activity_observations', 'analytics_activity_observation_subject_idx',
    );
    assert.equal(observationPlan.search, true);
    assert.equal(observationPlan.scan, false);
  } finally {
    raw.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});