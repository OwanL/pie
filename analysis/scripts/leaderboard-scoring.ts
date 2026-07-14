/**
 * Shared leaderboard scoring constants used by both the Node-side generator and the browser dashboard.
 * Keep this module dependency-free so both build targets can import it safely.
 *
 * The v4 family leaderboard combines separately standardized user, agent-review, and process
 * channels. These legacy dimension weights remain a compatibility description of the user channel;
 * tool/process diagnostics below are not direct composite dimensions. Post-treatment workload and
 * cost remain descriptive and never define task complexity.
 */
/** @deprecated Legacy fixture-size constant. The v4 leaderboard has no minimum-evidence rank gate. */
export const LEADERBOARD_MINIMUM_SCORED_RUNS = 10;

/** @deprecated Legacy compatibility constant. The v4 leaderboard has no rating-coverage gate. */
export const LEADERBOARD_MINIMUM_TASK_SCORING_COVERAGE = 0.40;

/** Fixed regularization strength. Larger values pull small samples more strongly toward the pooled prior. */
export const LEADERBOARD_SHRINKAGE_K = 4;

export const LEADERBOARD_TOKEN_EFFICIENCY_MAX = 50;

/**
 * Compatibility export for the browser dashboard's former workload-weighted mastery calculation.
 * The generated leaderboard does not use an outcome exponent; 1 preserves outcomes unchanged.
 */
export const LEADERBOARD_OUTCOME_EXPONENT = 1;

/**
 * Compatibility export for callers that still form the former mastery blend. Zero disables the
 * post-treatment workload multiplier, leaving the raw outcome estimate unchanged.
 */
export const LEADERBOARD_MASTERY_COMPLEXITY_WEIGHT = 0;

/** Compatibility export: no composite dimension is workload/complexity-emphasized. */
export const LEADERBOARD_DIFFICULTY_EMPHASIZED_DIMS = new Set<string>();

export const LEADERBOARD_WEIGHTS = {
  satisfaction: 8 / 15,
  resolutionRate: 7 / 15,
  fileChurn: 0,
  toolReliability: 0,
  verificationPassRate: 0,
  tokenEfficiency: 0,
} as const;
