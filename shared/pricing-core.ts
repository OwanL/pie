/**
 * Shared model token-pricing core: types, parser, and normalization.
 *
 * This is the IDENTICAL core extracted from the three previously-triplicated
 * pricing modules (`extensions/subagent/pricing.ts`, `extension/src/backend/pricing.ts`,
 * `analysis/scripts/pricing.ts`). Only the behavior-preserving common core lives
 * here; per-package loaders and cost functions (which differ by consumer policy)
 * remain as thin shims in each consumer.
 *
 * ## Units & semantics
 *
 * - All costs are in **USD per 1M tokens**.
 * - `0` = genuinely free, local, or included.
 * - Missing `cost` field = unknown pricing (triggers fallback).
 * - Negative or non-finite prices are rejected.
 *
 * ## Normalization
 *
 * Token prices are converted to the selector's legacy cost scale (0–30+) via:
 *
 *   blended = (3 × input + 1 × output) / 4
 *   normalized = 10 × √(blended / baselineUsdPer1M)
 *
 * The 3:1 input:output ratio is representative of agentic coding workloads.
 * The baseline ($6.00/1M blended) is anchored to claude-sonnet-4.6 pricing
 * ($3.00/M input, $15.00/M output), which maps to the legacy `cost=10` baseline.
 *
 * This module is pure JavaScript (no Node- or browser-only APIs) and is authored
 * under `verbatimModuleSyntax` so it is portable to all three consumers (NodeNext
 * native, bundler). Type-only symbols use `export type` / `export interface`.
 */

// --- Types ---

/**
 * Real token pricing in USD per 1M tokens.
 *
 * - `input` and `output` are required to be non-negative and finite.
 * - `cacheRead` and `cacheWrite` default to 0 when absent or not applicable.
 */
export interface ModelTokenPricingTier {
  /** Use these rates when the request prompt footprint exceeds this value. */
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelTokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelTokenPricingTier[];
}

/**
 * A pricing record keyed by model id, including the provider for disambiguation.
 */
export interface ModelPricingRecord {
  id: string;
  provider: string;
  pricing?: ModelTokenPricing;
}

/**
 * Cost source used by {@link resolveModelCost}.
 */
export type CostSource = "pricing" | "legacy" | "aggregate";

/**
 * Resolved cost for a model, with traceability.
 */
export interface ResolvedCost {
  /** Normalized cost on the 0–30+ selector scale. */
  normalizedCost: number;
  /** Which source provided the cost value. */
  usedSource: CostSource;
}

// --- Constants ---

/** Token ratio for agentic coding workloads: 3 input tokens per 1 output token. */
const INPUT_WEIGHT = 3;
const OUTPUT_WEIGHT = 1;

/**
 * Baseline blended USD-per-1M tokens.
 * Anchored to claude-sonnet-4.6: $3.00/M input, $15.00/M output.
 * blended = (3 × 3.00 + 1 × 15.00) / 4 = $6.00/1M
 */
const BASELINE_USD_PER_1M = 6.0;

/** Scale factor mapping the baseline to the legacy cost=10 reference. */
const NORMALIZATION_SCALE = 10;

// --- Parser ---

/**
 * Parse and validate a raw `cost` object from `models.json`.
 *
 * Returns `undefined` if:
 * - The input is not a plain object
 * - Any numeric field is negative, NaN, or non-finite
 * - The `input` or `output` subfields are not valid numbers
 *
 * Missing subfields are defaulted to 0 (genuinely free/included).
 */
export function parseModelPricing(raw: unknown): ModelTokenPricing | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;

  // Missing subfields default to 0 (free/included).
  // Explicitly invalid values (negative, NaN, Infinity) cause rejection.
  const input = maybeValidNumber(obj.input);
  const output = maybeValidNumber(obj.output);
  const cacheRead = maybeValidNumber(obj.cacheRead);
  const cacheWrite = maybeValidNumber(obj.cacheWrite);

  // If any field was explicitly set to an invalid value, reject.
  if (input === undefined || output === undefined) return undefined;
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  let tiers: ModelTokenPricingTier[] | undefined;
  if (obj.tiers !== undefined) {
    if (!Array.isArray(obj.tiers)) return undefined;
    tiers = [];
    for (const rawTier of obj.tiers) {
      if (!rawTier || typeof rawTier !== 'object' || Array.isArray(rawTier)) return undefined;
      const tier = rawTier as Record<string, unknown>;
      if (typeof tier.inputTokensAbove !== 'number') return undefined;
      const inputTokensAbove = maybeValidNumber(tier.inputTokensAbove);
      const tierInput = maybeValidNumber(tier.input);
      const tierOutput = maybeValidNumber(tier.output);
      const tierCacheRead = maybeValidNumber(tier.cacheRead);
      const tierCacheWrite = maybeValidNumber(tier.cacheWrite);
      if (inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined
        || tierCacheRead === undefined || tierCacheWrite === undefined) return undefined;
      tiers.push({
        inputTokensAbove,
        input: tierInput,
        output: tierOutput,
        cacheRead: tierCacheRead,
        cacheWrite: tierCacheWrite,
      });
    }
    tiers.sort((left, right) => left.inputTokensAbove - right.inputTokensAbove);
  }

  return { input, output, cacheRead, cacheWrite, ...(tiers?.length ? { tiers } : {}) };
}

/** Resolve request-level long-context rates. Prompt footprint includes every
 * input/cache channel because all of them occupy the provider request. */
export function pricingForPromptTokens(
  pricing: ModelTokenPricing,
  inputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): ModelTokenPricing {
  const promptTokens = Math.max(0, inputTokens) + Math.max(0, cacheReadTokens) + Math.max(0, cacheWriteTokens);
  let selected: ModelTokenPricingTier | undefined;
  for (const tier of pricing.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove) selected = tier;
  }
  return selected ?? pricing;
}

/**
 * Validate a raw value as a non-negative finite number.
 * - Returns the value if it is a valid non-negative finite number.
 * - Returns `0` if the field is absent (undefined).
 * - Returns `undefined` if the field is present but invalid (negative, NaN, Infinity, non-number).
 */
function maybeValidNumber(v: unknown): number | undefined {
  if (v === undefined) return 0;
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v;
}

// --- Normalization ---

/**
 * Convert real token prices to the selector's 0–30+ cost penalty scale.
 *
 * Uses a representative 3:1 input:output token ratio, producing a blended
 * USD-per-1M value, then maps it to the legacy scale via a square-root
 * transform anchored at the baseline ($6.00/1M → cost=10).
 *
 * Returns 0 for free/local models. No upper clamp is applied.
 */
export function estimateNormalizedCost(pricing: ModelTokenPricing): number {
  const blended = (INPUT_WEIGHT * pricing.input + OUTPUT_WEIGHT * pricing.output)
    / (INPUT_WEIGHT + OUTPUT_WEIGHT);

  if (blended <= 0) return 0;

  return NORMALIZATION_SCALE * Math.sqrt(blended / BASELINE_USD_PER_1M);
}

// --- Cost Resolution ---

/**
 * Resolve a model's effective cost using the fallback order:
 *
 * 1. Real pricing from `models.json` (normalized via {@link estimateNormalizedCost})
 * 2. Legacy `cost` field from `model-profiles.yaml`
 * 3. Capability aggregate (sum of precision + creativity + thoroughness + reasoning)
 *
 * @param modelId - Model id to look up
 * @param pricingRecords - Map of model id → pricing records from `models.json`
 * @param legacyCost - Optional legacy cost from `model-profiles.yaml`
 * @param capabilityAggregate - Fallback aggregate (usually capability sum)
 */
export function resolveModelCost(
  modelId: string,
  pricingRecords: Map<string, ModelPricingRecord[]>,
  legacyCost?: number,
  capabilityAggregate?: number,
): ResolvedCost {
  // 1. Try real pricing
  const records = pricingRecords.get(modelId);
  if (records && records.length > 0) {
    const priced = records.find((r) => r.pricing !== undefined);
    if (priced?.pricing) {
      return {
        normalizedCost: estimateNormalizedCost(priced.pricing),
        usedSource: "pricing",
      };
    }
  }

  // 2. Try legacy profile cost
  if (legacyCost !== undefined && Number.isFinite(legacyCost)) {
    return {
      normalizedCost: Math.max(0, legacyCost),
      usedSource: "legacy",
    };
  }

  // 3. Fall back to capability aggregate
  const aggregate = capabilityAggregate ?? 0;
  return {
    normalizedCost: Math.max(0, aggregate),
    usedSource: "aggregate",
  };
}