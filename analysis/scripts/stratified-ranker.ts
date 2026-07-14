/**
 * Stratified leaderboard for subagent model selection (v2).
 *
 * Computes on-demand from the analytics data store:
 *   1. Per-run ex-ante complexity scores (message size, attachments, context files)
 *   2. Splits runs into complexity terciles (low / medium / high)
 *   3. Computes outcome scores per model per band (point estimates)
 *   4. Rank by quality composite only (cost is not a ranking factor)
 *   5. Assigns models to buckets (small / medium / frontier)
 *
 * This remains an offline/advisory experiment; runtime bucket selection does not read it.
 * The canonical dashboard strength ranking lives in leaderboard.ts.
 */

import {
  type PreparedAnalyticsData,
  type PreparedRunRow,
} from "./contracts.ts";
import { prepareSourceAnalytics } from "./prepare.ts";
import { loadSourceAnalytics } from "./source.ts";

// --- Types ---

/** Simplified model config entry (from model-profiles.yaml v2 schema). */
export interface SimpleModelConfig {
  id: string;
  eligible: boolean;
  thinking: ThinkingLevel[];
  disabled_reason: string | null;
  cost: number;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface BucketAssignments {
  small: string[];
  medium: string[];
  frontier: string[];
}

// --- Constants ---

/** Minimum scored runs before the ranker returns non-empty assignments. */
export const BOOTSTRAP_MIN_RUNS = 40;

/** Minimum scored runs a model must have in a band before it can be ranked in that bucket. */
export const MIN_SCORED_RUNS_PER_MODEL = 3;

/** Token efficiency cap (matches leaderboard-scoring.ts). */
const TOKEN_EFFICIENCY_MAX = 50;

/** Number of complexity bands (terciles). */
const BAND_COUNT = 3;

const BAND_NAMES = ["low", "medium", "high"] as const;
type BandName = (typeof BAND_NAMES)[number];

/** Bucket each band maps to. */
const BAND_TO_BUCKET: Record<BandName, keyof BucketAssignments> = {
  low: "small",
  medium: "medium",
  high: "frontier",
};

// --- Ex-ante complexity scoring ---
// Never use post-treatment workload (tokens, tools, duration, mutations, verification) to define
// difficulty bands: those values are downstream of model assignment and would bias the ranker.

import { computePreTaskComplexityScores as computeComplexityScores } from './pre-task-complexity.ts';

export { computePreTaskComplexityScores as computeComplexityScores, extractPreTaskSignals as extractSignals } from './pre-task-complexity.ts';
export type { PreTaskComplexitySignals as ComplexitySignals } from './pre-task-complexity.ts';
export { percentileRanks } from './complexity-scoring.ts';

// --- Band assignment ---

export interface BandAssignment {
  band: BandName;
  runs: PreparedRunRow[];
}

export function assignBands(
  runs: PreparedRunRow[],
  complexityScores: Map<string, number>,
): BandAssignment[] {
  const scored = runs
    .filter((r) => (
      r.scored
      && r.satisfaction !== null
      && r.outcomeSource === 'user'
      && !r.mixedModelConfig
      && !r.mixedTreatmentConfig
    ))
    .map((r) => ({ run: r, score: complexityScores.get(r.runId) ?? 0 }));

  if (scored.length === 0) {
    return BAND_NAMES.map((band) => ({ band, runs: [] }));
  }

  // Sort by complexity score ascending
  scored.sort((a, b) => a.score - b.score);

  const bandSize = Math.ceil(scored.length / BAND_COUNT);
  const bands: BandAssignment[] = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const start = b * bandSize;
    const end = Math.min(start + bandSize, scored.length);
    bands.push({
      band: BAND_NAMES[b],
      runs: scored.slice(start, end).map((s) => s.run),
    });
  }

  return bands;
}

// --- Outcome scoring ---

function resolutionScore(resolution: PreparedRunRow["resolution"]): number {
  if (resolution === "resolved") return 1;
  if (resolution === "partially_resolved") return 0.5;
  return 0;
}

export interface ModelOutcomeScores {
  modelId: string;
  runCount: number;
  satisfaction: number; // 1–5 mean
  resolutionRate: number; // 0–1 mean
  fileChurn: number; // 0–1, inverted mean editRevisitRate (higher = less churn = better)
  toolReliability: number; // 0–1 proportion
  verificationAdoption: number; // 0–1 proportion
  tokenEfficiency: number; // median, inverted (0–1, higher = better)
  compositeScore: number; // 0–1 quality composite
  /**
   * Representative cost for the family group, resolved by `assignModelsToBuckets`
   * from per-run provider ids (mean of each run's own cost). Undefined when the
   * outcome was constructed directly (e.g. in tests); `rankModelsInBand` then
   * falls back to its own cost-map lookup. Not part of the quality composite.
   */
  cost?: number;
}

export function computeOutcomeScores(
  modelRuns: PreparedRunRow[],
): ModelOutcomeScores | null {
  const scored = modelRuns.filter(
    (r) => r.scored
      && r.satisfaction !== null
      && r.outcomeSource === 'user'
      && !r.mixedModelConfig
      && !r.mixedTreatmentConfig,
  );
  if (scored.length === 0) return null;

  // Label is the canonical model family (provider-agnostic), matching the
  // family-grouping key used in assignModelsToBuckets; falls back to the
  // provider-specific modelId, then unknown.
  const modelId = scored[0].modelFamily ?? scored[0].modelId ?? "(unknown)";

  // Satisfaction (1–5 mean)
  const satisfactionValues = scored.map((r) => r.satisfaction!);
  const satisfaction =
    satisfactionValues.reduce((a, b) => a + b, 0) / satisfactionValues.length;

  // Resolution rate (0–1 mean)
  const resolutionValues = scored.map((r) => resolutionScore(r.resolution));
  const resolutionRate =
    resolutionValues.reduce((a, b) => a + b, 0) / resolutionValues.length;

  // File churn (inverted editRevisitRate mean): 0 churn → 1 (best), 1 churn → 0 (worst).
  // Runs with null editRevisitRate are dropped from this dimension's denominator,
  // mirroring how null tokenEfficiency values are excluded; when every run is null
  // the dimension defaults to the worst (0), matching the all-null tokenEfficiency path.
  const editRevisitValues = scored
    .map((r) => r.editRevisitRate)
    .filter((v): v is number => v !== null);
  const meanEditRevisit =
    editRevisitValues.length > 0
      ? editRevisitValues.reduce((a, b) => a + b, 0) / editRevisitValues.length
      : 1; // all-null → worst (all churn)
  const fileChurn = 1 - meanEditRevisit;

  // Tool reliability (0–1 proportion)
  const toolReliability =
    scored.filter((r) => r.toolFailureCount === 0).length / scored.length;

  // Verification adoption (0–1 proportion)
  const verificationAdoption =
    scored.filter((r) => r.verificationTotalCount > 0).length / scored.length;

  // Token efficiency (median, inverted)
  const tokenEfficiencyValues = scored
    .map((r) => r.tokenEfficiency)
    .filter((v): v is number => v !== null);
  const sorted = [...tokenEfficiencyValues].sort((a, b) => a - b);
  const median =
    sorted.length > 0
      ? sorted[Math.floor(sorted.length / 2)]
      : TOKEN_EFFICIENCY_MAX;
  // Invert: lower tokens-per-line = better efficiency
  const tokenEfficiencyNorm = 1 - Math.min(median, TOKEN_EFFICIENCY_MAX) / TOKEN_EFFICIENCY_MAX;

  // Quality composite (6 dimensions, equal weights). fileChurn replaces the
  // former firstAttemptSuccess dimension (1-prompt success is not a quality
  // signal; file churn is the indicative negative) — still 6 dims at 1/6 each.
  const compositeScore =
    ((satisfaction - 1) / 4) * (1 / 6) + // normalize 1–5 → 0–1
    resolutionRate * (1 / 6) +
    fileChurn * (1 / 6) +
    toolReliability * (1 / 6) +
    verificationAdoption * (1 / 6) +
    tokenEfficiencyNorm * (1 / 6);

  return {
    modelId,
    runCount: scored.length,
    satisfaction,
    resolutionRate,
    fileChurn,
    toolReliability,
    verificationAdoption,
    tokenEfficiency: tokenEfficiencyNorm,
    compositeScore,
  };
}

// --- Ranking ---

interface RankedModelEntry {
  modelId: string;
  compositeScore: number;
}

/**
 * Rank models within a band purely by raw model performance (the quality
 * composite). Cost is intentionally NOT a ranking factor — not even a
 * tiebreaker — so a cheaper model never leapfrogs a higher-quality one.
 * Exact composite-score ties are broken deterministically by model id so the
 * order is stable across runs.
 */
export function rankModelsInBand(
  outcomes: ModelOutcomeScores[],
): string[] {
  const entries: RankedModelEntry[] = outcomes.map((o) => ({
    modelId: o.modelId,
    compositeScore: o.compositeScore,
  }));

  entries.sort(
    (a, b) => b.compositeScore - a.compositeScore
      || a.modelId.localeCompare(b.modelId),
  );

  return entries.map((e) => e.modelId);
}

// --- Bucket assignment ---

interface ModelBandResult {
  modelId: string;
  band: BandName;
  compositeScore: number;
  runCount: number;
}

/**
 * Representative cost for a model-family group.
 *
 * Family grouping collapses multiple provider-specific model ids into one group
 * (e.g. "umans-glm-5.2" and "glm-5.2:cloud" → family "glm-5.2"); each provider
 * id may carry a different cost in `model-profiles.yaml`. We resolve cost per-run
 * — looking up each run's own `modelId` in the cost map and averaging the hits —
 * so the family's cost reflects the providers actually observed rather than an
 * arbitrary default. When no run resolves (none of the provider ids are in the
 * cost map) we fall back to the family label itself, then the default (10), so
 * the cost map always resolves deterministically.
 *
 * DECISION: per-run mean was chosen over "first provider id" or "family
 * default" because a family that spans providers with different costs (e.g. a
 * cheap and a pricey host of the same model) should land between them, not at
 * either extreme. `firstAttemptSuccess` is intentionally NOT part of this — it
 * remains on PreparedRunRow for the global leaderboard / interruptions chart.
 */
function resolveFamilyCost(
  runs: PreparedRunRow[],
  costMap: Map<string, number>,
  family: string,
): number {
  const perRun = runs
    .map((r) => r.modelId)
    .filter((id): id is string => id !== null)
    .map((id) => costMap.get(id))
    .filter((c): c is number => c !== undefined);
  if (perRun.length > 0) {
    return perRun.reduce((a, b) => a + b, 0) / perRun.length;
  }
  return costMap.get(family) ?? 10;
}

export function assignModelsToBuckets(
  bands: BandAssignment[],
  modelConfig: SimpleModelConfig[],
): BucketAssignments {
  // Cost map keyed by provider-specific model id (cfg.id). Used to resolve a
  // representative per-family cost now that groups are family-keyed.
  const costMap = new Map<string, number>();
  for (const cfg of modelConfig) {
    costMap.set(cfg.id, cfg.cost);
  }

  // Collect all model-band outcomes
  const allResults: ModelBandResult[] = [];

  for (const band of bands) {
    // Group runs by canonical model family (provider-agnostic), mirroring
    // leaderboard.ts; falls back to the provider-specific modelId, then unknown.
    const byModel = new Map<string, PreparedRunRow[]>();
    for (const run of band.runs) {
      const mid = run.modelFamily ?? run.modelId ?? "(unknown)";
      if (!byModel.has(mid)) byModel.set(mid, []);
      byModel.get(mid)!.push(run);
    }

    for (const [modelId, runs] of byModel) {
      const outcomes = computeOutcomeScores(runs);
      if (!outcomes) continue;
      if (outcomes.runCount < MIN_SCORED_RUNS_PER_MODEL) continue;
      allResults.push({
        modelId,
        band: band.band,
        compositeScore: outcomes.compositeScore,
        runCount: outcomes.runCount,
      });
    }
  }

  // Each model appears in only its best band (highest composite score)
  const bestBand = new Map<string, { band: BandName; score: number }>();
  for (const r of allResults) {
    const existing = bestBand.get(r.modelId);
    if (!existing || r.compositeScore > existing.score) {
      bestBand.set(r.modelId, { band: r.band, score: r.compositeScore });
    }
  }

  // Group by bucket
  const buckets: BucketAssignments = { small: [], medium: [], frontier: [] };
  const bucketEntries = new Map<keyof BucketAssignments, ModelOutcomeScores[]>();

  for (const band of bands) {
    const byModel = new Map<string, PreparedRunRow[]>();
    for (const run of band.runs) {
      const mid = run.modelFamily ?? run.modelId ?? "(unknown)";
      if (!byModel.has(mid)) byModel.set(mid, []);
      byModel.get(mid)!.push(run);
    }

    for (const [modelId, runs] of byModel) {
      const best = bestBand.get(modelId);
      if (!best || best.band !== band.band) continue;

      const outcomes = computeOutcomeScores(runs);
      if (!outcomes) continue;
      if (outcomes.runCount < MIN_SCORED_RUNS_PER_MODEL) continue;

      // Resolve the family's representative cost from per-run provider ids so
      // cost-based re-ranking stays coherent across the family-grouping boundary.
      outcomes.cost = resolveFamilyCost(runs, costMap, modelId);

      const bucket = BAND_TO_BUCKET[band.band];
      if (!bucketEntries.has(bucket)) bucketEntries.set(bucket, []);
      bucketEntries.get(bucket)!.push(outcomes);
    }
  }

  // Rank within each bucket
  for (const [bucket, outcomes] of bucketEntries) {
    buckets[bucket] = rankModelsInBand(outcomes);
  }

  return buckets;
}

// --- Eligibility filter ---

/**
 * Filter bucket assignments to only include eligible models.
 * Models with `eligible: false` in config are removed.
 * Models in analytics data but not in config are included (with warning).
 */
export function filterEligible(
  buckets: BucketAssignments,
  modelConfig: SimpleModelConfig[],
): BucketAssignments {
  const eligibleSet = new Set(
    modelConfig.filter((c) => c.eligible).map((c) => c.id),
  );
  // Also include models in analytics but not in config (treated as eligible)
  const configIds = new Set(modelConfig.map((c) => c.id));
  const allBucketIds = new Set([
    ...buckets.small,
    ...buckets.medium,
    ...buckets.frontier,
  ]);
  for (const id of allBucketIds) {
    if (!configIds.has(id)) {
      // Model in data but not in config — include with warning
      eligibleSet.add(id);
    }
  }

  return {
    small: buckets.small.filter((id) => eligibleSet.has(id)),
    medium: buckets.medium.filter((id) => eligibleSet.has(id)),
    frontier: buckets.frontier.filter((id) => eligibleSet.has(id)),
  };
}

// --- Public API ---

/**
 * Compute bucket assignments from the analytics data store.
 *
 * @param analyticsDir - Path to the analytics data directory (containing exports/ or JSONL files)
 * @param modelConfig - Simple model config entries from model-profiles.yaml
 * @returns Bucket assignments (empty if < 40 scored runs exist)
 */
export async function computeBucketAssignments(
  analyticsDir: string,
  modelConfig: SimpleModelConfig[],
): Promise<BucketAssignments> {
  // Load analytics data
  let prepared: PreparedAnalyticsData;
  try {
    const loaded = await loadSourceAnalytics({ storageDir: analyticsDir });
    prepared = prepareSourceAnalytics(loaded.source);
  } catch {
    // If loading fails, return empty assignments (fallback to active model)
    return { small: [], medium: [], frontier: [] };
  }

  const scoredRuns = prepared.runs.filter((r) => (
    r.scored
    && r.satisfaction !== null
    && r.outcomeSource === 'user'
    && !r.mixedModelConfig
    && !r.mixedTreatmentConfig
  ));

  // Bootstrap gate: need at least 40 scored runs
  if (scoredRuns.length < BOOTSTRAP_MIN_RUNS) {
    return { small: [], medium: [], frontier: [] };
  }

  // 1. Compute complexity scores
  const complexityScores = computeComplexityScores(prepared.runs);

  // 2. Split into terciles
  const bands = assignBands(prepared.runs, complexityScores);

  // 3-5. Compute outcomes, rank, assign to buckets
  const buckets = assignModelsToBuckets(bands, modelConfig);

  // Filter by eligibility
  return filterEligible(buckets, modelConfig);
}
