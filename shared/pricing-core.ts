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
