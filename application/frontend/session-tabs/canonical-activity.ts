import type {
  CanonicalActivityCounts,
  CanonicalActivityProjectionView,
  CanonicalActivityView,
  CanonicalAnalyticsCoverage,
  CanonicalToolFacetProjectionView,
  SessionSummary,
} from '../../lib/protocol/index.js';
import { isRecord } from '../../../lib/validation/type-guards';

// Canonical root-session activity/facet display projection.
// Independent of token usage and cost accounting; consumes host-qualified reads.
//
// A passive consumer of the host's optional `canonicalActivityBySession`
// cache read. It owns NO calculation: it renders the host-qualified canonical
// projection for the active session only, keeps unknown/suppressed/truncated
// states explicit, and never presents root-session totals as a selected-branch
// claim (the host owns branch/epoch freshness).

/** One per-activity-kind row of the canonical session activity summary. */
export interface CanonicalActivityKindSummary {
  kind: string;
  spanCount: number;
  measuredTotalMs: number;
}

export interface CanonicalActivitySectionSummary {
  totalSpans: number;
  /** Additive measured work over known spans — NOT a wall-clock union. */
  measuredTotalMs: number;
  observedCount: number;
  estimatedCount: number;
  unknownCount: number;
  measuredKnownCount: number;
  measuredUnknownCount: number;
  kinds: CanonicalActivityKindSummary[];
  /** Explicit incompleteness notes from host coverage/truncation metadata. */
  notes: string[];
}

export interface CanonicalToolFacetSectionSummary {
  facetCount: number;
  /** Facets with at least one known attempted-change line count. */
  attemptedChangeCount: number;
/** Per-channel exact sums over KNOWN values only: `null` = no known values in
 *  the channel (rendered '?', never a zero-filled subtotal); a safe-integer
 *  `number` while the exact sum fits, otherwise the exact decimal `string` of
 *  the bigint sum. */
  attemptedAddedLines: number | string | null;
  attemptedRemovedLines: number | string | null;
  /** Facets whose attempted line counts are unknown or unsafe to sum. */
  withoutLineCounts: number;
  verifiedCount: number;
  unverifiedCount: number;
  /** Facets whose verification is null, `not_applicable`, or `unknown`. */
  otherVerificationCount: number;
  notes: string[];
}

export interface CanonicalSessionActivitySummary {
  /** Explicit scope note — root-session scope, never a selected-branch claim. */
  scopeNote: string;
  /** True when the bounded visible-session address set omitted paths and the
   *  active session had no canonical entry. Claimed only under a valid stable
   *  root identity — the same gate `bindCanonicalEntry` applies — so an
   *  unavailable identity never asserts an address-set omission. */
  omitted: boolean;
  /** True when the active session has no canonical entry at all. */
  missing: boolean;
  /** null = the independently qualified read is unknown/suppressed/invalidated. */
  activity: CanonicalActivitySectionSummary | null;
  /** null = the independently qualified read is unknown/suppressed/invalidated. */
  toolFacets: CanonicalToolFacetSectionSummary | null;
}

/** Explicit scope label: root-session scope never claims selected-branch
 *  ownership; selected-branch totals are separately unsupported, not shown. */
export const CANONICAL_SCOPE_NOTE = 'Root session (all branches) · selected-branch totals not shown';

/** Discrete count fields the summary reads; every one must be a nonnegative
 *  safe integer (matching the host validator's rule exactly). */
const ACTIVITY_COUNT_FIELDS = [
  'spanCount', 'observedCount', 'estimatedCount', 'unknownCount',
  'measuredKnownCount', 'measuredUnknownCount',
] as const;

function countsSignature(counts: CanonicalActivityCounts): string {
  return [
    counts.spanCount, counts.observedCount, counts.estimatedCount, counts.unknownCount,
    counts.measuredKnownCount, counts.measuredUnknownCount, counts.measuredTotalMs,
  ].join(':');
}

function scopeSignature(scope: CanonicalActivityView['scope'] | undefined): string {
  if (!scope || typeof scope !== 'object') return '?';
  return scope.kind === 'global' ? 'global' : `session:${scope.rootSessionId}`;
}

function coverageSignature(coverage: CanonicalAnalyticsCoverage | null): string {
  if (!coverage) return '-';
  const pending = coverage.pendingDetailCoverage;
  return [
    String(coverage.databaseSchemaVersion),
    String(coverage.projectionRevision),
    String(coverage.snapshotWatermark),
    String(coverage.generationIds.length),
    coverage.generationIdsTruncated ? 'g' : '',
    pending.deliveryHistoryCoverage,
    coverage.truncation.rowLimit ? 'r' : '',
    coverage.truncation.byteLimit ? 'b' : '',
    coverage.truncation.cellLimit ? 'c' : '',
  ].join(':');
}

/** Bounded content signature for the memo-gated canonical summary. Signs every
 *  display-affecting input — the active session's path, the expected stable
 *  root identity it binds to, entry/read/projection scope, revisions, counts,
 *  facet qualifications, and coverage metadata — so equal-content structured
 *  clones keep the previous reference while any address/root/scope/coverage
 *  change requalifies the summary. Unbound entries (absent or identity-)
 *  mismatched) get a stable marker that still depends on the identity inputs. */
export function canonicalActivitySignature(
  sessionPath: string | null,
  expectedRootSessionId: string | null,
  bySession: Record<string, CanonicalActivityView> | undefined,
  bySessionTruncated: boolean | undefined,
): string {
  if (!bySession) return 'legacy';
  const raw = sessionPath !== null ? (bySession as Record<string, unknown>)[sessionPath] : undefined;
  const entry = raw === undefined || raw === null
    ? null
    : bindCanonicalEntry(raw, sessionPath as string, expectedRootSessionId);
  if (!entry) {
    return [
      'unbound',
      sessionPath ?? '',
      expectedRootSessionId ?? '',
      raw === undefined || raw === null ? 'absent' : 'unbound-entry',
      bySessionTruncated === true ? 't' : 'f',
    ].join('|');
  }
  return [
    sessionPath,
    expectedRootSessionId ?? '',
    entry.revision === null || entry.revision === undefined ? '' : String(entry.revision),
    scopeSignature(entry.scope),
    canonicalReadSignature(entry.activity, entry.scope, 'kinds'),
    canonicalReadSignature(entry.toolFacets, entry.scope, 'facets'),
    bySessionTruncated === true ? 't' : 'f',
  ].join('|');
}

/** Signature for one qualified canonical read. Usable reads sign every
 *  display-affecting field; unusable reads get a stable reason marker so a
 *  later repair requalifies the memo. */
function canonicalReadSignature(
  read: unknown,
  entryScope: CanonicalActivityView['scope'],
  rowField: 'kinds' | 'facets',
): string {
  const qualified = qualifyCanonicalRead<CanonicalActivityProjectionView | CanonicalToolFacetProjectionView>(
    read,
    entryScope,
    rowField,
  );
  if (!qualified.qualified) return `unknown:${qualified.token}`;
  const readRecord = read as CanonicalActivityView['activity'];
  const projection = qualified.projection;
  const parts = [
    'canonical',
    scopeSignature(readRecord.scope),
    scopeSignature(projection.scope),
    String(readRecord.truncated),
    String(projection.revision),
    projection.truncated ? 't' : 'f',
    coverageSignature(projection.coverage),
  ];
  if (rowField === 'kinds') {
    const activity = projection as CanonicalActivityProjectionView;
    parts.push(
      countsSignature(activity.totals),
      activity.kinds
        .map((kind) => `${typeof kind.activityKind === 'string' ? kind.activityKind : ''}=${countsSignature(kind)}`)
        .join(','),
    );
  } else {
    const facetProjection = projection as CanonicalToolFacetProjectionView;
    parts.push(
      String(facetProjection.facets.length),
      facetProjection.facets
        .map((facet) => `${String(facet.attemptedAddedLines)}|${String(facet.attemptedRemovedLines)}|${facet.verification ?? ''}`)
        .join(','),
    );
  }
  return parts.join(':');
}

/** The ONE crash-safe qualified-read normalization for the canonical consumer.
 *  It owns every optional/malformed gate BEFORE any dereference — absent read,
 *  non-canonical authority, scope mismatch against the entry, missing or
 *  malformed projection, non-object rows, nonnegative safe-integer count
 *  violations, and missing/malformed coverage metadata (including the bounded
 *  generation list). Any violation fails the whole read closed to an explicit
 *  unknown with a stable reason token; the host validator's diagnostics are
 *  never trusted to have run. Both the signature and the summary builder call
 *  this single normalizer, so they cannot drift apart. */
type CanonicalReadQualification<TProjection> =
  | { qualified: true; projection: TProjection }
  | { qualified: false; token: 'absent' | 'unknown-authority' | 'scope-mismatch' | 'malformed' };

function qualifyCanonicalRead<TProjection>(
  read: unknown,
  entryScope: CanonicalActivityView['scope'],
  rowField: 'kinds' | 'facets',
): CanonicalReadQualification<TProjection> {
  if (!isRecord(read)) return { qualified: false, token: 'absent' };
  if (read.authority !== 'canonical') return { qualified: false, token: 'unknown-authority' };
  if (!readScopeMatches(entryScope, read.scope)) return { qualified: false, token: 'scope-mismatch' };
  const projection = read.projection;
  if (!isRecord(projection)) return { qualified: false, token: 'malformed' };
  if (!readScopeMatches(entryScope, projection.scope)) return { qualified: false, token: 'scope-mismatch' };
  if (typeof read.truncated !== 'boolean' || typeof projection.truncated !== 'boolean') {
    return { qualified: false, token: 'malformed' };
  }
  const rows = projection[rowField];
  if (!Array.isArray(rows) || !rows.every(isRecord)) return { qualified: false, token: 'malformed' };
  if (rowField === 'kinds') {
    if (!usableActivityCounts(projection.totals)) return { qualified: false, token: 'malformed' };
    for (const row of rows) {
      if (!usableActivityCounts(row)) return { qualified: false, token: 'malformed' };
    }
  }
  if (!usableCanonicalCoverage(projection.coverage)) return { qualified: false, token: 'malformed' };
  return { qualified: true, projection: projection as TProjection };
}

/** Activity counts the summary consumes: six discrete nonnegative safe-integer
 *  counts plus a nonnegative finite measured-work total (the host stores it as
 *  a REAL duration — fractional milliseconds display, negative ones cannot). */
function usableActivityCounts(counts: unknown): boolean {
  if (!isRecord(counts)) return false;
  for (const field of ACTIVITY_COUNT_FIELDS) {
    const value = counts[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
  }
  const measured = counts.measuredTotalMs;
  return typeof measured === 'number' && Number.isFinite(measured) && measured >= 0;
}

/** Coverage metadata the notes/signature consume: the bounded generation list
 *  plus its flag, the pending-detail coverage label, and the three truncation
 *  flags. A missing or malformed field fails the read closed instead of
 *  crashing a later dereference. */
function usableCanonicalCoverage(coverage: unknown): boolean {
  if (!isRecord(coverage)) return false;
  if (!Array.isArray(coverage.generationIds)) return false;
  if (typeof coverage.generationIdsTruncated !== 'boolean') return false;
  const truncation = coverage.truncation;
  if (!isRecord(truncation)
    || typeof truncation.rowLimit !== 'boolean'
    || typeof truncation.byteLimit !== 'boolean'
    || typeof truncation.cellLimit !== 'boolean') {
    return false;
  }
  const pending = coverage.pendingDetailCoverage;
  if (!isRecord(pending)
    || (pending.deliveryHistoryCoverage !== 'complete'
      && pending.deliveryHistoryCoverage !== 'retained_only')) {
    return false;
  }
  return true;
}

/** A nested read (and its projection) must carry the SAME scope as its entry:
 *  a session entry can never host a global-labelled projection, and the
 *  root-session id must match. Mismatching reads fail closed to unknown. */
function readScopeMatches(
  entryScope: CanonicalActivityView['scope'] | undefined,
  readScope: unknown,
): boolean {
  if (!isRecord(readScope) || !isRecord(entryScope)) return false;
  if (entryScope.kind === 'global') return readScope.kind === 'global';
  return readScope.kind === 'session' && readScope.rootSessionId === entryScope.rootSessionId;
}

function activityCoverageNotes(coverage: CanonicalAnalyticsCoverage | null): string[] {
  const notes: string[] = [];
  if (!coverage) return notes;
  const limits = [
    coverage.truncation.rowLimit ? 'row' : null,
    coverage.truncation.byteLimit ? 'byte' : null,
    coverage.truncation.cellLimit ? 'cell' : null,
  ].filter((limit): limit is string => limit !== null);
  if (limits.length > 0) notes.push(`Bounded read: ${limits.join(' + ')} limit(s) reached`);
  if (coverage.generationIdsTruncated) notes.push('Generation list truncated');
  if (coverage.pendingDetailCoverage.deliveryHistoryCoverage === 'retained_only') {
    notes.push('Delivery-history detail: retained rows only');
  }
  return notes;
}

function summarizeActivity(
  projection: CanonicalActivityProjectionView,
): CanonicalActivitySectionSummary {
  return {
    totalSpans: projection.totals.spanCount,
    measuredTotalMs: projection.totals.measuredTotalMs,
    observedCount: projection.totals.observedCount,
    estimatedCount: projection.totals.estimatedCount,
    unknownCount: projection.totals.unknownCount,
    measuredKnownCount: projection.totals.measuredKnownCount,
    measuredUnknownCount: projection.totals.measuredUnknownCount,
    kinds: projection.kinds.map((kind) => ({
      kind: typeof kind.activityKind === 'string' ? kind.activityKind : 'unknown',
      spanCount: kind.spanCount,
      measuredTotalMs: kind.measuredTotalMs,
    })),
    notes: [
      projection.truncated ? 'Kind rows truncated (bounded read)' : '',
      ...activityCoverageNotes(projection.coverage),
    ].filter((note) => note !== ''),
  };
}

/** One attempted-change channel. `null` stays unknown (never summed as 0);
 *  nonnegative safe integers and arbitrary-length decimal strings (the host's
 *  exact int64 serialization — no digit-count cap) are known values; negative,
 *  fractional, or malformed values stay unknown rather than being truncated,
 *  wrapped, or zero-filled. */
function attemptedLineValue(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Exact accumulated count in its display value: a safe-integer number while
 *  it fits, otherwise the exact decimal string of the bigint sum. Sums never
 *  overflow into an unknown — every known value stays representable exactly. */
function exactCountValue(total: bigint): number | string {
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString();
}

function summarizeToolFacets(
  projection: CanonicalToolFacetProjectionView,
): CanonicalToolFacetSectionSummary {
  let attemptedChangeCount = 0;
  let addedSum: bigint | null = null;
  let removedSum: bigint | null = null;
  let withoutLineCounts = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  let otherVerificationCount = 0;
  for (const facet of projection.facets) {
    const added = attemptedLineValue(facet.attemptedAddedLines);
    const removed = attemptedLineValue(facet.attemptedRemovedLines);
    if (added === null && removed === null) {
      withoutLineCounts += 1;
    } else {
      attemptedChangeCount += 1;
    }
    // Exact bigint addition: no safe-range cap, no wrap, no unknown fallback.
    if (added !== null) addedSum = (addedSum ?? 0n) + added;
    if (removed !== null) removedSum = (removedSum ?? 0n) + removed;
    if (facet.verification === 'verified') verifiedCount += 1;
    else if (facet.verification === 'unverified') unverifiedCount += 1;
    else otherVerificationCount += 1;
  }
  return {
    facetCount: projection.facets.length,
    attemptedChangeCount,
    attemptedAddedLines: addedSum === null ? null : exactCountValue(addedSum),
    attemptedRemovedLines: removedSum === null ? null : exactCountValue(removedSum),
    withoutLineCounts,
    verifiedCount,
    unverifiedCount,
    otherVerificationCount,
    notes: [
      projection.truncated ? 'Facet rows truncated (bounded read)' : '',
      ...activityCoverageNotes(projection.coverage),
    ].filter((note) => note !== ''),
  };
}

/** The active session's stable root identity from CURRENT view session
 *  metadata — the host-owned `SessionSummary.sessionId` (the same stable header
 *  id the host derives analytics root identities from). Returns null when the
 *  identity is unavailable or a path-hash fallback: the webview must never
 *  infer a root identity from the visible pathname, so identity-fallback
 *  sessions fail closed instead of binding. */
export function activeCanonicalRootSessionId(
  activeSession: Pick<SessionSummary, 'sessionId' | 'identityFallback'> | null | undefined,
): string | null {
  if (!activeSession || activeSession.identityFallback === true) return null;
  const sessionId = activeSession.sessionId?.trim();
  return sessionId ? sessionId : null;
}

/** Bind the active session's canonical entry: the record must be an object
 *  addressed at the active session's visible path AND carry the expected
 *  stable root identity in an explicit session scope. A path-matched entry
 *  describing a different root — or any binding with an unavailable identity —
 *  never binds, so root-B data can never render for root-A. */
function bindCanonicalEntry(
  entry: unknown,
  sessionPath: string,
  expectedRootSessionId: string | null,
): CanonicalActivityView | null {
  const record = entry as unknown as CanonicalActivityView | null;
  if (!isRecord(entry) || record?.sessionPath !== sessionPath) return null;
  if (expectedRootSessionId === null) return null;
  const scope = record?.scope;
  if (!isRecord(scope) || scope.kind !== 'session' || scope.rootSessionId !== expectedRootSessionId) {
    return null;
  }
  return record;
}

/** Build the display summary for the active session's canonical activity/facet
 *  read. Returns null when the host omitted the canonical fields (legacy
 *  analytics authority) — nothing canonical is rendered and no legacy UI
 *  changes. The entry is bound to the active session's stable root identity
 *  before anything renders; the global entry is deliberately never substituted
 *  for a session. */
export function buildCanonicalSessionActivitySummary(
  sessionPath: string | null,
  expectedRootSessionId: string | null,
  bySession: Record<string, CanonicalActivityView> | undefined,
  bySessionTruncated: boolean | undefined,
): CanonicalSessionActivitySummary | null {
  if (!bySession || sessionPath === null) return null;
  const raw = (bySession as Record<string, unknown>)[sessionPath];
  if (raw === undefined || raw === null) {
    // Omission is claimed only when the active session's stable root identity
    // is available — the same gate `bindCanonicalEntry` applies. With an
    // unavailable identity the read fails closed and no address-set omission
    // is claimed: a truncation flag alone cannot bind the missing entry.
    return {
      scopeNote: CANONICAL_SCOPE_NOTE,
      omitted: bySessionTruncated === true && expectedRootSessionId !== null,
      missing: true,
      activity: null,
      toolFacets: null,
    };
  }
  if (!bindCanonicalEntry(raw, sessionPath, expectedRootSessionId)) {
    // Present but unbindable (address mismatch, or the active session's stable
    // root identity is unavailable/mismatched): fail closed to an explicit
    // unavailable read. The entry itself exists, so no address-set omission is
    // claimed — but another root's data is never rendered.
    return {
      scopeNote: CANONICAL_SCOPE_NOTE,
      omitted: false,
      missing: true,
      activity: null,
      toolFacets: null,
    };
  }
  const entry = raw as unknown as CanonicalActivityView;
  const activity = qualifyCanonicalRead<CanonicalActivityProjectionView>(entry.activity, entry.scope, 'kinds');
  const toolFacets = qualifyCanonicalRead<CanonicalToolFacetProjectionView>(entry.toolFacets, entry.scope, 'facets');
  return {
    scopeNote: CANONICAL_SCOPE_NOTE,
    omitted: false,
    missing: false,
    activity: activity.qualified ? summarizeActivity(activity.projection) : null,
    toolFacets: toolFacets.qualified ? summarizeToolFacets(toolFacets.projection) : null,
  };
}

/** Compact duration: `45s` / `1.2m` / `2.3h` (`0` → `0s`). */
export function formatMeasuredDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${trimMeasured(min)}m`;
  return `${trimMeasured(min / 60)}h`;
}

function trimMeasured(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
