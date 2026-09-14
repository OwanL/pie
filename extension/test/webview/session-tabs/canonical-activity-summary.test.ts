/**
 * Pins the webview's canonical root-session activity/facet consumer logic in
 * `extension/src/webview/panel/session-tabs/token-usage.ts`
 * (`buildCanonicalSessionActivitySummary` + `canonicalActivitySignature`).
 *
 * The consumer is passive: it binds the active session's entry to its stable
 * root identity (never inferred from the pathname), selects ONLY the active
 * session's entry, keeps unknown/suppressed/truncated states explicit, never
 * substitutes the global entry, and never turns absent values into zeros.
 * Successive "live ViewState" snapshots and session switches are simulated by
 * calling the builder with the exact structured values the host posts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { CanonicalActivityView, SessionSummary } from '../../../src/shared/protocol';
import {
  activeCanonicalRootSessionId,
  buildCanonicalSessionActivitySummary,
  canonicalActivitySignature,
  formatMeasuredDuration,
} from '../../../src/webview/panel/session-tabs/token-usage';

const SESSION_A = '/workspace/sessions/a.jsonl';
const SESSION_B = '/workspace/sessions/b.jsonl';
const ROOT_A = 'root-a';
const ROOT_B = 'root-b';

function canonicalCoverageMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseSchemaVersion: 12,
    projectionRevision: '41',
    snapshotWatermark: '39',
    generationIds: ['generation-a'],
    generationIdsTruncated: false,
    pendingDetailCoverage: {
      deliveryHistoryCoverage: 'complete',
      completeDetailWatermark: '38',
      retainedDetailLogicalBytes: '100',
      retainedDetailStoredBytes: '80',
    },
    truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
    ...overrides,
  };
}

/** One valid root-A canonical entry as the host posts it. Deliberately built
 *  as plain JSON and cast once: fixtures simulate the wire, including
 *  deliberately invalid runtime values in focused tests. */
function canonicalEntry(overrides: Record<string, unknown> = {}): CanonicalActivityView {
  return {
    sessionPath: SESSION_A,
    revision: '41',
    scope: { kind: 'session', rootSessionId: ROOT_A },
    activity: {
      authority: 'canonical',
      scope: { kind: 'session', rootSessionId: ROOT_A },
      revision: '41',
      coverage: canonicalCoverageMetadata(),
      truncated: false,
      projection: {
        revision: '41',
        scope: { kind: 'session', rootSessionId: ROOT_A },
        kinds: [
          {
            activityKind: 'conversation',
            spanCount: 8,
            observedCount: 7,
            estimatedCount: 1,
            unknownCount: 0,
            measuredKnownCount: 8,
            measuredUnknownCount: 0,
            measuredTotalMs: 186_000,
          },
          {
            activityKind: 'tool',
            spanCount: 2,
            observedCount: 1,
            estimatedCount: 0,
            unknownCount: 1,
            measuredKnownCount: 1,
            measuredUnknownCount: 1,
            measuredTotalMs: 120,
          },
        ],
        totals: {
          spanCount: 10,
          observedCount: 8,
          estimatedCount: 1,
          unknownCount: 1,
          measuredKnownCount: 9,
          measuredUnknownCount: 1,
          measuredTotalMs: 186_120,
        },
        truncated: false,
        coverage: canonicalCoverageMetadata(),
      },
    },
    toolFacets: {
      authority: 'canonical',
      scope: { kind: 'session', rootSessionId: ROOT_A },
      revision: '41',
      coverage: canonicalCoverageMetadata(),
      truncated: false,
      projection: {
        revision: '41',
        scope: { kind: 'session', rootSessionId: ROOT_A },
        facets: [
          {
            generationId: 'generation-a',
            facetId: 'facet-a',
            toolCallId: 'tool-a',
            rootSessionId: ROOT_A,
            commands: ['git status'],
            cwd: '/workspace',
            observedPaths: ['src/a.ts'],
            attemptedAddedLines: 3,
            attemptedRemovedLines: 0,
            verification: 'unverified',
          },
          {
            generationId: 'generation-b',
            facetId: 'facet-b',
            toolCallId: 'tool-b',
            rootSessionId: ROOT_A,
            commands: null,
            cwd: null,
            observedPaths: null,
            attemptedAddedLines: '120000000000000000000',
            attemptedRemovedLines: null,
            verification: 'unknown',
          },
        ],
        truncated: false,
        coverage: canonicalCoverageMetadata(),
      },
    },
    ...overrides,
  } as unknown as CanonicalActivityView;
}

/** Narrow escape hatch for deliberately invalid runtime fixtures: the host
 *  cannot type a negative/fractional/malformed field, so tests mutate the raw
 *  record through `unknown` exactly where the fixture is intentionally bad. */
function facetRows(entry: CanonicalActivityView): Array<Record<string, unknown>> {
  return (entry.toolFacets!.projection as unknown as { facets: Array<Record<string, unknown>> }).facets;
}

function activityProjection(entry: CanonicalActivityView): Record<string, unknown> {
  return entry.activity!.projection as unknown as Record<string, unknown>;
}

/** Re-address an entry (and all nested read/projection scopes) at another
 *  root — simulating a second session's host-posted entry. */
function rebindRoot(entry: CanonicalActivityView, rootSessionId: string): CanonicalActivityView {
  const rebound = structuredClone(entry);
  (rebound.scope as unknown as { rootSessionId: string }).rootSessionId = rootSessionId;
  const reads = [rebound.activity, rebound.toolFacets] as unknown as Array<Record<string, unknown>>;
  for (const read of reads) {
    if (!read) continue;
    (read.scope as unknown as { rootSessionId: string }).rootSessionId = rootSessionId;
    const projection = read.projection as Record<string, unknown> | null;
    if (projection) (projection.scope as unknown as { rootSessionId: string }).rootSessionId = rootSessionId;
  }
  return rebound;
}

function summaryOf(entry: CanonicalActivityView, expectedRootSessionId: string | null = ROOT_A) {
  return buildCanonicalSessionActivitySummary(SESSION_A, expectedRootSessionId, { [SESSION_A]: entry }, false);
}

function signatureOf(entry: CanonicalActivityView, expectedRootSessionId: string | null = ROOT_A): string {
  return canonicalActivitySignature(SESSION_A, expectedRootSessionId, { [SESSION_A]: entry }, false);
}

const BASE_SIG = canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: canonicalEntry() }, false);

test('legacy authority (fields absent) renders nothing canonical', () => {
  assert.equal(buildCanonicalSessionActivitySummary(SESSION_A, ROOT_A, undefined, undefined), null);
  assert.equal(canonicalActivitySignature(SESSION_A, ROOT_A, undefined, undefined), 'legacy');
});

test('no active session renders nothing canonical even when fields are present', () => {
  assert.equal(buildCanonicalSessionActivitySummary(null, ROOT_A, { [SESSION_A]: canonicalEntry() }, false), null);
});

test('a bound entry (path + stable root identity) renders for the active session', () => {
  const summary = summaryOf(canonicalEntry());
  assert.equal(summary!.missing, false);
  assert.equal(summary!.activity!.totalSpans, 10);
  assert.notEqual(summary!.toolFacets, null);
});

test('a path-matched entry describing a different root fails closed — root-B never renders for root-A', () => {
  const foreign = canonicalEntry({ scope: { kind: 'session', rootSessionId: ROOT_B } });
  const summary = summaryOf(foreign);
  assert.equal(summary!.missing, true);
  assert.equal(summary!.omitted, false, 'the entry exists, so no address-set omission is claimed');
  assert.equal(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);
});

test('an unavailable active root identity fails closed even for a matching entry', () => {
  // null = the webview could not derive the stable identity from current view
  // session metadata (missing id, identity fallback, no active session record).
  const summary = summaryOf(canonicalEntry(), null);
  assert.equal(summary!.missing, true);
  assert.equal(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);
});

test('activeCanonicalRootSessionId derives the stable identity from view session metadata, never from the path', () => {
  const session = { sessionId: ' stable-root-id ', identityFallback: false } as SessionSummary;
  assert.equal(activeCanonicalRootSessionId(session), 'stable-root-id');
  assert.equal(activeCanonicalRootSessionId({ ...session, identityFallback: true }), null);
  assert.equal(activeCanonicalRootSessionId({ identityFallback: false } as SessionSummary), null);
  assert.equal(activeCanonicalRootSessionId(null), null);
});

test('live ViewState update: a changed read requalifies the summary', () => {
  const before = summaryOf(canonicalEntry());
  const updated = canonicalEntry();
  (updated.activity!.projection!.totals as { measuredTotalMs: number }).measuredTotalMs = 200_000;
  const after = summaryOf(updated);

  assert.equal(before!.activity!.measuredTotalMs, 186_120);
  assert.equal(after!.activity!.measuredTotalMs, 200_000);
  assert.notEqual(
    canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: canonicalEntry() }, false),
    canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: updated }, false),
  );
});

test('equal-content structured clones keep an identical signature', () => {
  const view = { [SESSION_A]: canonicalEntry() };
  const clone = structuredClone(view);
  assert.equal(
    canonicalActivitySignature(SESSION_A, ROOT_A, view, false),
    canonicalActivitySignature(SESSION_A, ROOT_A, clone, false),
  );
});

test('session switch selects only the active session entry and never the global one', () => {
  const entryA = canonicalEntry();
  const entryB = rebindRoot(canonicalEntry({ sessionPath: SESSION_B, revision: '7' }), ROOT_B);
  const bySession = { [SESSION_A]: entryA, [SESSION_B]: entryB };

  const summaryA = buildCanonicalSessionActivitySummary(SESSION_A, ROOT_A, bySession, false);
  const summaryB = buildCanonicalSessionActivitySummary(SESSION_B, ROOT_B, bySession, false);

  assert.equal(summaryA!.activity!.totalSpans, 10);
  assert.equal(summaryB!.activity!.totalSpans, 10);
  // The two entries must be independently addressed (signature differs).
  assert.notEqual(
    canonicalActivitySignature(SESSION_A, ROOT_A, bySession, false),
    canonicalActivitySignature(SESSION_B, ROOT_B, bySession, false),
  );

  // A global entry is never substituted for a session address.
  const onlyGlobal = {
    canonicalActivityGlobal: canonicalEntry({ sessionPath: null }),
  } as unknown as Record<string, CanonicalActivityView>;
  const missing = buildCanonicalSessionActivitySummary(SESSION_A, ROOT_A, onlyGlobal, false);
  assert.equal(missing!.missing, true);
});

test('active session omitted from the bounded address set is explicit', () => {
  const truncated = buildCanonicalSessionActivitySummary(SESSION_B, ROOT_B, { [SESSION_A]: canonicalEntry() }, true);
  assert.equal(truncated!.missing, true);
  assert.equal(truncated!.omitted, true);
  assert.equal(truncated!.activity, null);
  assert.equal(truncated!.toolFacets, null);

  const notTruncated = buildCanonicalSessionActivitySummary(SESSION_B, ROOT_B, { [SESSION_A]: canonicalEntry() }, false);
  assert.equal(notTruncated!.missing, true);
  assert.equal(notTruncated!.omitted, false);
});

test('omission is claimed only under a valid stable root identity — an unavailable identity never claims omission', () => {
  // Repro: null identity + empty address set + truncated=true must NOT label
  // the entry omitted. With an unavailable identity the webview cannot bind
  // the session, so claiming the host dropped its entry from the bounded
  // address set would be a false UI claim.
  const unavailable = buildCanonicalSessionActivitySummary(SESSION_A, null, {}, true);
  assert.equal(unavailable!.missing, true);
  assert.equal(unavailable!.omitted, false);
  assert.equal(unavailable!.activity, null);
  assert.equal(unavailable!.toolFacets, null);
  assert.equal(buildCanonicalSessionActivitySummary(SESSION_A, null, {}, false)!.omitted, false);

  // A valid stable identity + a truncated address set keeps the real omission.
  const valid = buildCanonicalSessionActivitySummary(SESSION_B, ROOT_B, { [SESSION_A]: canonicalEntry() }, true);
  assert.equal(valid!.missing, true);
  assert.equal(valid!.omitted, true);
});

test('unknown authority stays explicitly unknown — no zeros, no empty result', () => {
  const suppressed = canonicalEntry({
    revision: null,
    activity: {
      authority: 'unknown',
      scope: { kind: 'session', rootSessionId: ROOT_A },
      projection: null,
      revision: null,
      coverage: null,
      truncated: null,
    },
    toolFacets: {
      authority: 'unknown',
      scope: { kind: 'session', rootSessionId: ROOT_A },
      projection: null,
      revision: null,
      coverage: null,
      truncated: null,
    },
  });
  const summary = summaryOf(suppressed);

  assert.equal(summary!.missing, false);
  assert.equal(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);
  assert.equal(summary!.scopeNote, 'Root session (all branches) · selected-branch totals not shown');
});

test('activity and tool facets are independently qualified', () => {
  const mixed = canonicalEntry({
    toolFacets: {
      authority: 'unknown',
      scope: { kind: 'session', rootSessionId: ROOT_A },
      projection: null,
      revision: null,
      coverage: null,
      truncated: null,
    },
  });
  const summary = summaryOf(mixed);
  assert.notEqual(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);
});

test('a missing activity or toolFacets read never throws the signature or the summary', () => {
  const holey = canonicalEntry();
  delete (holey as unknown as Record<string, unknown>).activity;
  delete (holey as unknown as Record<string, unknown>).toolFacets;

  const summary = summaryOf(holey);
  assert.equal(summary!.missing, false);
  assert.equal(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);

  const sig = canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: holey }, false);
  assert.match(sig, /unknown:absent/);
  assert.notEqual(sig, BASE_SIG);
});

test('malformed coverage (missing generation list, truncation, pending detail) fails closed, crash-free', () => {
  const cases: Array<Record<string, unknown>> = [
    { generationIds: undefined },
    { generationIdsTruncated: 'yes' },
    { truncation: undefined },
    { truncation: { rowLimit: 'yes', byteLimit: false, cellLimit: false } },
    { pendingDetailCoverage: { deliveryHistoryCoverage: 'maybe' } },
    { pendingDetailCoverage: undefined },
  ];
  for (const coverageOverrides of cases) {
    const broken = canonicalEntry();
    (activityProjection(broken) as { coverage: unknown }).coverage = canonicalCoverageMetadata(coverageOverrides);
    const summary = summaryOf(broken);
    assert.equal(summary!.activity, null, `coverage ${JSON.stringify(coverageOverrides)} must fail closed`);
    assert.notEqual(summary!.toolFacets, null);
    // The signature stays crash-free and marks the read malformed.
    assert.match(
      canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: broken }, false),
      /unknown:malformed/,
    );
  }
});

test('negative and fractional activity counts fail closed to unknown — never rendered', () => {
  const broken = canonicalEntry();
  const totals = activityProjection(broken).totals as Record<string, unknown>;
  totals.spanCount = -2;
  totals.observedCount = 1.5;
  const summary = summaryOf(broken);
  assert.equal(summary!.activity, null);
  assert.notEqual(summary!.toolFacets, null);

  const kindRow = (activityProjection(broken).kinds as Array<Record<string, unknown>>);
  const repaired = canonicalEntry();
  (activityProjection(repaired).totals as Record<string, unknown>).spanCount = 10;
  assert.notEqual(summaryOf(repaired)!.activity, null);

  const negativeKind = canonicalEntry();
  (activityProjection(negativeKind).kinds as Array<Record<string, unknown>>)[1]!.spanCount = -1;
  assert.equal(summaryOf(negativeKind)!.activity, null);
  assert.equal(typeof kindRow, 'object');

  const negativeMeasured = canonicalEntry();
  (activityProjection(negativeMeasured).totals as Record<string, unknown>).measuredTotalMs = -5;
  assert.equal(summaryOf(negativeMeasured)!.activity, null);
});

test('fractional measured work displays; it is a duration, not a discrete count', () => {
  const fractional = canonicalEntry();
  (activityProjection(fractional).totals as { measuredTotalMs: number }).measuredTotalMs = 186_120.5;
  const summary = summaryOf(fractional);
  assert.notEqual(summary!.activity, null);
  assert.equal(summary!.activity!.measuredTotalMs, 186_120.5);
});

test('truncated and incomplete reads produce explicit notes, never silent totals', () => {
  const truncated = canonicalEntry({
    activity: ((): CanonicalActivityView['activity'] => {
      const read = structuredClone(canonicalEntry().activity!);
      read.projection!.truncated = true;
      read.projection!.coverage = {
        ...read.projection!.coverage,
        generationIdsTruncated: true,
        truncation: { rowLimit: true, byteLimit: true, cellLimit: false },
        pendingDetailCoverage: {
          ...read.projection!.coverage.pendingDetailCoverage,
          deliveryHistoryCoverage: 'retained_only',
        },
      } as never;
      return read;
    })(),
  });
  const summary = summaryOf(truncated);
  const notes = summary!.activity!.notes.join(' | ');
  assert.match(notes, /Kind rows truncated/);
  assert.match(notes, /row \+ byte limit/);
  assert.match(notes, /Generation list truncated/);
  assert.match(notes, /retained rows only/);
});

test('attempted-change facets are unverified proxies; oversized int64 strings are known exact values', () => {
  const summary = summaryOf(canonicalEntry());
  const facets = summary!.toolFacets!;
  assert.equal(facets.facetCount, 2);
  assert.equal(facets.attemptedChangeCount, 2);
  // Exact bigint addition across a 21-digit host int64 string and a number:
  // '120000000000000000000' + 3 stays exact, never truncated or zero-filled.
  assert.equal(facets.attemptedAddedLines, '120000000000000000003');
  assert.equal(facets.attemptedRemovedLines, 0);
  assert.equal(facets.withoutLineCounts, 0);
  assert.equal(facets.verifiedCount, 0);
  assert.equal(facets.unverifiedCount, 1);
  assert.equal(facets.otherVerificationCount, 1);
});

test('host int64 decimal strings longer than 15 digits are valid and summed exactly', () => {
  const entry = canonicalEntry();
  const facets = facetRows(entry);
  facets.length = 0;
  facets.push({
    generationId: 'generation-big', facetId: 'facet-big', toolCallId: null, rootSessionId: ROOT_A,
    commands: null, cwd: null, observedPaths: null,
    attemptedAddedLines: '9007199254740992', // exactly 2^53 — formerly capped at 15 digits
    attemptedRemovedLines: null, verification: 'unverified',
  });
  facets.push({
    generationId: 'generation-big', facetId: 'facet-big2', toolCallId: null, rootSessionId: ROOT_A,
    commands: null, cwd: null, observedPaths: null,
    attemptedAddedLines: 7, attemptedRemovedLines: '120000000000000000000', verification: 'verified',
  });
  const facetsSummary = summaryOf(entry)!.toolFacets!;
  assert.equal(facetsSummary.attemptedChangeCount, 2);
  // 9007199254740992 + 7 exceeds the safe-integer range: the exact decimal
  // string is displayed, never a float-rounded or fabricated 0 value.
  assert.equal(facetsSummary.attemptedAddedLines, '9007199254740999');
  assert.equal(facetsSummary.attemptedRemovedLines, '120000000000000000000');
});

test('negative and fractional attempted line counts stay unknown, never summed', () => {
  const entry = canonicalEntry();
  const facets = facetRows(entry);
  facets.length = 0;
  facets.push({
    generationId: 'generation-x', facetId: 'facet-x', toolCallId: null, rootSessionId: ROOT_A,
    commands: null, cwd: null, observedPaths: null,
    attemptedAddedLines: -3, attemptedRemovedLines: 2.5, verification: 'unverified',
  });
  const facetsSummary = summaryOf(entry)!.toolFacets!;
  assert.equal(facetsSummary.attemptedChangeCount, 0);
  assert.equal(facetsSummary.withoutLineCounts, 1);
  assert.equal(facetsSummary.attemptedAddedLines, null);
  assert.equal(facetsSummary.attemptedRemovedLines, null);
});

test('partial attempted lines keep per-channel coverage: +3/null sums added only', () => {
  const entry = canonicalEntry();
  const facets = facetRows(entry);
  facets.length = 0;
  facets.push({
    generationId: 'generation-p', facetId: 'facet-p', toolCallId: null, rootSessionId: ROOT_A,
    commands: null, cwd: null, observedPaths: null,
    attemptedAddedLines: 3, attemptedRemovedLines: null, verification: 'unverified',
  });
  const facetsSummary = summaryOf(entry)!.toolFacets!;
  assert.equal(facetsSummary.attemptedChangeCount, 1);
  assert.equal(facetsSummary.attemptedAddedLines, 3);
  // The removed channel has NO known values: it stays unknown (rendered '?'),
  // never a fabricated −0.
  assert.equal(facetsSummary.attemptedRemovedLines, null);
  assert.equal(facetsSummary.withoutLineCounts, 0);
});

test('kinds rows that are not objects fail closed to unknown and recover on a live fix', () => {
  const broken = canonicalEntry();
  (broken.activity!.projection as { kinds: unknown[] }).kinds = [null];
  const summary = summaryOf(broken);
  // The malformed canonical read is explicit unknown — no crash, no partial zeros.
  assert.equal(summary!.activity, null);
  assert.notEqual(summary!.toolFacets, null);

  // The signature stays crash-free and marks the read invalid (stable marker).
  const brokenSig = canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: broken }, false);
  assert.match(brokenSig, /unknown:malformed/);

  // A live ViewState repair requalifies the summary.
  const repaired = summaryOf(canonicalEntry());
  assert.notEqual(repaired!.activity, null);
});

test('a session entry never hosts a global-labelled nested projection (fail closed)', () => {
  const readScopeGlobal = canonicalEntry();
  (readScopeGlobal.activity as unknown as { scope: unknown }).scope = { kind: 'global' };
  const summary = summaryOf(readScopeGlobal);
  assert.equal(summary!.activity, null);
  assert.notEqual(summary!.toolFacets, null);

  // A projection-level global scope fails closed the same way.
  const projectionScopeGlobal = canonicalEntry();
  (projectionScopeGlobal.activity!.projection as { scope: unknown }).scope = { kind: 'global' };
  assert.equal(summaryOf(projectionScopeGlobal)!.activity, null);

  // Scope changes invalidate the memo signature (live update re-renders).
  assert.notEqual(
    canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: canonicalEntry() }, false),
    canonicalActivitySignature(SESSION_A, ROOT_A, { [SESSION_A]: readScopeGlobal }, false),
  );
});

test('an entry whose sessionPath does not match its address key fails closed to missing', () => {
  const entry = canonicalEntry({ sessionPath: '/workspace/sessions/other.jsonl' });
  const summary = summaryOf(entry);
  assert.equal(summary!.missing, true);
  assert.equal(summary!.activity, null);
  assert.equal(summary!.toolFacets, null);
});

test('signature invalidates on root identity, scope, coverage metadata, and read-truncation changes', () => {
  const sigOf = (entry: CanonicalActivityView, expectedRootSessionId = ROOT_A) =>
    canonicalActivitySignature(SESSION_A, expectedRootSessionId, { [SESSION_A]: entry }, false);

  // The expected root identity itself is part of the signature: a root change
  // (active session identity changed under the same path) can never reuse a
  // valid memo.
  assert.notEqual(BASE_SIG, sigOf(canonicalEntry(), ROOT_B));

  const otherRoot = canonicalEntry();
  otherRoot.scope = { kind: 'session', rootSessionId: 'root-other' };
  assert.notEqual(BASE_SIG, sigOf(otherRoot));

  const schemaChanged = canonicalEntry();
  ((activityProjection(schemaChanged).coverage as { databaseSchemaVersion: number })).databaseSchemaVersion = 13;
  assert.notEqual(BASE_SIG, sigOf(schemaChanged));

  const readTruncated = canonicalEntry();
  (readTruncated.activity as { truncated: boolean }).truncated = true;
  assert.notEqual(BASE_SIG, sigOf(readTruncated));

  const kindChanged = canonicalEntry();
  (activityProjection(kindChanged).kinds as Array<{ spanCount: number }>)[0]!.spanCount = 9;
  assert.notEqual(BASE_SIG, sigOf(kindChanged));

  const facetChanged = canonicalEntry();
  facetRows(facetChanged)[0]!.verification = 'verified';
  assert.notEqual(BASE_SIG, sigOf(facetChanged));

  // An unbound entry (mismatched root) gets a distinct, stable marker that
  // still depends on the expected identity.
  const unboundSig = canonicalActivitySignature(SESSION_A, ROOT_B, { [SESSION_A]: canonicalEntry() }, false);
  assert.match(unboundSig, /unbound\|/);
  assert.notEqual(unboundSig, canonicalActivitySignature(SESSION_A, 'root-c', { [SESSION_A]: canonicalEntry() }, false));
});

test('empty canonical results under qualified authority stay empty (complete empty read)', () => {
  const empty = canonicalEntry();
  const read = empty.activity!;
  read.projection = {
    ...read.projection!,
    kinds: [],
    totals: {
      spanCount: 0, observedCount: 0, estimatedCount: 0, unknownCount: 0,
      measuredKnownCount: 0, measuredUnknownCount: 0, measuredTotalMs: 0,
    },
  } as never;
  const summary = summaryOf(empty);
  assert.equal(summary!.activity!.totalSpans, 0);
  assert.equal(summary!.activity!.kinds.length, 0);
});

test('formatMeasuredDuration stays compact and non-negative', () => {
  assert.equal(formatMeasuredDuration(0), '0s');
  assert.equal(formatMeasuredDuration(45_000), '45s');
  assert.equal(formatMeasuredDuration(75_000), '1.3m');
  assert.equal(formatMeasuredDuration(8_100_000), '2.3h');
});