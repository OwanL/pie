import { CURRENT_HARNESS_REVISION, type HarnessCohortStatus } from './contracts.ts';

/**
 * Pure harness-cohort classifier.
 *
 * Attributes each run to a harness cohort from its stamped `harnessRevision`
 * (and, when the revision is absent, its start time). Deterministic and
 * side-effect free so it can be unit-tested in isolation and reused by
 * prepare.ts and any future dashboard filters.
 *
 * Eras (all instants are UTC):
 * - `startedAt < 2026-07-26T00:00:00Z`: before harness stamping existed and
 *   before the selected current-harness era — un-stamped runs here are the
 *   **legacy** cohort. The boundary follows the observed July harness rollout
 *   and is a policy boundary, not an inferred property of each old run.
 * - `2026-07-26T00:00:00Z <= startedAt < 2026-08-14T00:00:00Z`: the
 *   **historical current** era — the current harness recorded runs without
 *   identity, so missing revision is acceptable and classifies as `current`.
 *   The boundary is inclusive: a run starting exactly at
 *   `2026-07-26T00:00:00Z` is still `current`.
 * - `startedAt >= 2026-08-14T00:00:00Z`: identity is required — an un-stamped
 *   run cannot be attributed to the current harness and classifies as
 *   **unknown**.
 *
 * A present revision always wins over the time-based eras: matching the
 * current revision classifies as `current`, any other revision as
 * `incompatible`.
 */

/** Inclusive lower bound of the historical-current era. */
export const HISTORICAL_CURRENT_BOUNDARY = '2026-07-26T00:00:00Z';
/** Instant from which harness identity is required on every run. */
export const IDENTITY_REQUIRED_BOUNDARY = '2026-08-14T00:00:00Z';

const HISTORICAL_CURRENT_BOUNDARY_MS = Date.parse(HISTORICAL_CURRENT_BOUNDARY);
const IDENTITY_REQUIRED_BOUNDARY_MS = Date.parse(IDENTITY_REQUIRED_BOUNDARY);

export interface HarnessCohort {
  status: HarnessCohortStatus;
  isCurrentHarness: boolean;
  harnessRevision: string | null;
  harnessFingerprint: string | null;
}

export interface HarnessCohortInput {
  startedAt: string;
  harnessRevision?: string;
  harnessFingerprint?: string;
}

export function classifyHarnessCohort(run: HarnessCohortInput): HarnessCohort {
  const revision = run.harnessRevision?.trim();
  const fingerprint = run.harnessFingerprint?.trim() || null;

  if (revision) {
    if (revision === CURRENT_HARNESS_REVISION) {
      return { status: 'current', isCurrentHarness: true, harnessRevision: revision, harnessFingerprint: fingerprint };
    }
    return { status: 'incompatible', isCurrentHarness: false, harnessRevision: revision, harnessFingerprint: fingerprint };
  }

  const startedMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedMs)) {
    // Cannot establish the era — do not guess at attribution.
    return { status: 'unknown', isCurrentHarness: false, harnessRevision: null, harnessFingerprint: null };
  }
  if (startedMs < HISTORICAL_CURRENT_BOUNDARY_MS) {
    return { status: 'legacy', isCurrentHarness: false, harnessRevision: null, harnessFingerprint: null };
  }
  if (startedMs >= IDENTITY_REQUIRED_BOUNDARY_MS) {
    return { status: 'unknown', isCurrentHarness: false, harnessRevision: null, harnessFingerprint: null };
  }
  return { status: 'current', isCurrentHarness: true, harnessRevision: null, harnessFingerprint: null };
}
