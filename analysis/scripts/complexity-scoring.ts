/**
 * Dependency-free workload-intensity scoring helpers.
 *
 * Shared by the generated leaderboard (`scripts/leaderboard.ts`) and browser dashboard only for
 * descriptive workload context. The stratified ranker and canonical leaderboard use
 * `pre-task-complexity.ts` for ex-ante task bands instead. Post-treatment workload is never a
 * multiplier, adjustment covariate, or difficulty label.
 *
 * Workload intensity = mean percentile rank of 6 per-run signals (line mutations, touched files,
 * tool calls, busy duration, verification count, input tokens), giving a 0–1 descriptive value.
 */
import type { PreparedRunRow } from './contracts.ts';

// --- Workload-intensity primitives (also used by the stratified ranker) ---

export interface ComplexitySignals {
  lineMutations: number;
  touchedFileCount: number;
  toolCallCount: number;
  busyDurationMs: number;
  verificationTotalCount: number;
  inputTokens: number;
}

export function extractSignals(run: PreparedRunRow): ComplexitySignals {
  return {
    lineMutations: run.lineAdditions + run.lineDeletions + run.lineModifications,
    touchedFileCount: run.touchedFileCount,
    toolCallCount: run.toolCallCount,
    busyDurationMs: run.busyDurationMs,
    verificationTotalCount: run.verificationTotalCount,
    inputTokens: run.inputTokens,
  };
}

/**
 * Percentile rank (0–1) of each value against the full population in O(n log n) time.
 * Returns an array parallel to `values`. Ties use the mid-rank convention
 * `(lt + 0.5·eq) / n`, so identical values share the same rank.
 */
export function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const rankByValue = new Map<number, number>();
  const n = sorted.length;

  for (let start = 0; start < n;) {
    let end = start + 1;
    while (end < n && sorted[end] === sorted[start]) end += 1;
    rankByValue.set(sorted[start]!, (start + 0.5 * (end - start)) / n);
    start = end;
  }

  return values.map((value) => rankByValue.get(value) ?? 0);
}

export function computeWorkloadIntensityScores(runs: PreparedRunRow[]): Map<string, number> {
  const signals = runs.map(extractSignals);

  const lineMutationRanks = percentileRanks(signals.map((signal) => signal.lineMutations));
  const touchedFileRanks = percentileRanks(signals.map((signal) => signal.touchedFileCount));
  const toolCallRanks = percentileRanks(signals.map((signal) => signal.toolCallCount));
  const durationRanks = percentileRanks(signals.map((signal) => signal.busyDurationMs));
  const verificationRanks = percentileRanks(signals.map((signal) => signal.verificationTotalCount));
  const inputTokenRanks = percentileRanks(signals.map((signal) => signal.inputTokens));

  const scores = new Map<string, number>();
  for (let index = 0; index < runs.length; index += 1) {
    const score =
      (lineMutationRanks[index]! +
        touchedFileRanks[index]! +
        toolCallRanks[index]! +
        durationRanks[index]! +
        verificationRanks[index]! +
        inputTokenRanks[index]!) /
      6;
    scores.set(runs[index]!.runId, score);
  }
  return scores;
}

/**
 * Compatibility helper for the former workload-weighted leaderboard calculation. The generated
 * leaderboard no longer calls it because post-treatment workload must not alter outcome scores.
 */
export function complexityWeightedMean(
  pairs: { complexity: number; outcome: number }[],
  outcomeExponent = 1,
): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const pair of pairs) sum += pair.complexity * (pair.outcome ** outcomeExponent);
  return sum / pairs.length;
}

/** Compatibility helper indicating whether descriptive workload-intensity values vary. */
export function hasComplexityVariance(complexityScores: number[]): boolean {
  if (complexityScores.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const score of complexityScores) {
    if (score < min) min = score;
    if (score > max) max = score;
  }
  return Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9;
}
