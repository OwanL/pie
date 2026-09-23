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
 * - A `cost` object without the required billable `input`/`output` rates is
 *   likewise unknown pricing: absent required rates are never normalized into
 *   free (`0`) pricing.
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

/** Rates that replace the base rates for evidence intervals entirely inside
 *  the peak window. All four rates are required: a partial override could
 *  silently mix published and stale rates for the same request. */
export interface ModelPricingPeakWindowOverride {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Typed UTC weekday peak-window applicability metadata (e.g. Ollama DeepSeek
 *  peak pricing, Monday–Friday 12:00–18:00 UTC). Windows never wrap midnight:
 *  `0 <= startMinutesUtc < endMinutesUtc <= 1440`. */
export interface ModelPricingPeakWindow {
  /** UTC weekdays on which the window opens (0=Sunday … 6=Saturday). */
  weekdaysUtc: number[];
  /** Minutes after UTC midnight when the window opens (inclusive). */
  startMinutesUtc: number;
  /** Minutes after UTC midnight when the window closes (exclusive). */
  endMinutesUtc: number;
  /** Rates applying when both closed evidence endpoints lie in the
   *  half-open peak window. */
  override: ModelPricingPeakWindowOverride;
}

export interface ModelTokenPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelTokenPricingTier[];
  /** Optional time-variable applicability schedule. When present, pricing is
   *  only applicable to an evidence interval that lies entirely within one
   *  band (the peak window or off-peak); see {@link resolveApplicablePricing}. */
  peak?: ModelPricingPeakWindow;
  /** True when the provider publishes no cache-read price (`-`). Positive
   *  cache-read usage stays unpriced; zero cache-read usage still prices the
   *  base rates. The `cacheRead` rate remains provenance metadata only. */
  cacheReadUnsupported?: boolean;
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
 * - The required billable `input` or `output` rate is absent or not a valid
 *   number (unknown pricing, never normalized into free)
 * - Any present numeric field is negative, NaN, or non-finite
 * - Any advertised tier lacks a valid `inputTokensAbove` or its required
 *   billable `input`/`output` rates
 *
 * Optional inapplicable cache rates (`cacheRead`/`cacheWrite`) default to 0
 * when absent (genuinely free/not applicable).
 */
export function parseModelPricing(raw: unknown): ModelTokenPricing | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const obj = raw as Record<string, unknown>;

  // Billable input/output rates are required: an absent or malformed rate
  // means unknown pricing (record rejected), never a free model. Only an
  // explicit `0` is genuinely free.
  const input = requiredValidNumber(obj.input);
  const output = requiredValidNumber(obj.output);
  // Optional inapplicable cache channels default to 0 when absent.
  const cacheRead = optionalValidNumber(obj.cacheRead);
  const cacheWrite = optionalValidNumber(obj.cacheWrite);

  // If any field was explicitly set to an invalid value, reject.
  if (input === undefined || output === undefined) return undefined;
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  // Optional applicability metadata: an invalid shape is rejected (unknown
  // applicability), never silently dropped or defaulted.
  if (obj.cacheReadUnsupported !== undefined && typeof obj.cacheReadUnsupported !== 'boolean') {
    return undefined;
  }
  let peak: ModelPricingPeakWindow | undefined;
  if (obj.peak !== undefined) {
    peak = parsePeakWindow(obj.peak);
    if (!peak) return undefined;
  }

  let tiers: ModelTokenPricingTier[] | undefined;
  if (obj.tiers !== undefined) {
    if (!Array.isArray(obj.tiers)) return undefined;
    tiers = [];
    for (const rawTier of obj.tiers) {
      if (!rawTier || typeof rawTier !== 'object' || Array.isArray(rawTier)) return undefined;
      const tier = rawTier as Record<string, unknown>;
      // An advertised tier must carry the same required billable rates as the
      // base pricing; an incomplete tier is rejected, not defaulted to free.
      const inputTokensAbove = requiredValidNumber(tier.inputTokensAbove);
      const tierInput = requiredValidNumber(tier.input);
      const tierOutput = requiredValidNumber(tier.output);
      const tierCacheRead = optionalValidNumber(tier.cacheRead);
      const tierCacheWrite = optionalValidNumber(tier.cacheWrite);
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

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(tiers?.length ? { tiers } : {}),
    ...(peak ? { peak } : {}),
    ...(obj.cacheReadUnsupported === true ? { cacheReadUnsupported: true } : {}),
  };
}

/** Parse and validate an optional typed peak window. Returns `undefined` when
 *  the shape is invalid (bad weekday set, out-of-range minutes, a wrapping or
 *  empty window, or missing/incomplete override rates). */
function parsePeakWindow(raw: unknown): ModelPricingPeakWindow | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const weekdays = obj.weekdaysUtc;
  if (!Array.isArray(weekdays) || weekdays.length === 0) return undefined;
  const seen = new Set<number>();
  for (const day of weekdays) {
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) return undefined;
    seen.add(day);
  }
  const startMinutesUtc = obj.startMinutesUtc;
  const endMinutesUtc = obj.endMinutesUtc;
  if (typeof startMinutesUtc !== 'number' || !Number.isInteger(startMinutesUtc)
    || startMinutesUtc < 0 || startMinutesUtc > 1439) return undefined;
  if (typeof endMinutesUtc !== 'number' || !Number.isInteger(endMinutesUtc)
    || endMinutesUtc < 1 || endMinutesUtc > 1440) return undefined;
  // Windows never wrap midnight; a start at or after the end is unrepresentable.
  if (startMinutesUtc >= endMinutesUtc) return undefined;
  if (!obj.override || typeof obj.override !== 'object' || Array.isArray(obj.override)) return undefined;
  const overrideRaw = obj.override as Record<string, unknown>;
  const overrideInput = requiredValidNumber(overrideRaw.input);
  const overrideOutput = requiredValidNumber(overrideRaw.output);
  const overrideCacheRead = optionalValidNumber(overrideRaw.cacheRead);
  const overrideCacheWrite = optionalValidNumber(overrideRaw.cacheWrite);
  if (overrideInput === undefined || overrideOutput === undefined
    || overrideCacheRead === undefined || overrideCacheWrite === undefined) return undefined;
  return {
    weekdaysUtc: [...seen].sort((left, right) => left - right),
    startMinutesUtc,
    endMinutesUtc,
    override: {
      input: overrideInput,
      output: overrideOutput,
      cacheRead: overrideCacheRead,
      cacheWrite: overrideCacheWrite,
    },
  };
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

// --- Applicability ---

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Provider-request evidence interval in epoch milliseconds. Both endpoints
 *  must be real observed times: the resolver never synthesizes timing. Both
 *  endpoints count as possible billing anchors for applicability. */
export interface PricingIntervalEvidence {
  startedAtMs: number;
  endedAtMs: number;
}

/** Applicability inputs for one priced usage observation. */
export interface PricingApplicability {
  /** Observed request interval, when the consumer captured both endpoints.
   *  Aggregate consumers without interval evidence omit it. */
  interval?: PricingIntervalEvidence;
  /** Known cache-read token count for the observation (defaults to 0). */
  cacheReadTokens?: number;
}

/** Shared pricing eligibility resolver.
 *
 * Returns the band pricing that applies to one usage observation, or
 * `undefined` when the pricing is NOT applicable (the caller must keep the
 * observation explicitly unpriced — never fall back to another rate):
 *
 * - `cacheReadUnsupported` pricing stays unpriced for positive cache-read
 *   usage; zero cache-read usage still prices the base rates.
 * - Scheduled (`peak`) pricing requires valid interval evidence whose closed
 *  span lies within one half-open band: missing, invalid, reversed, or
 *  boundary-crossing intervals are unpriced. Thus, touching a band boundary
 *  counts when that instant belongs to the adjacent band; an instantaneous
 *  interval at a boundary belongs to the band selected by `[start, end)`.
 *  A full week or longer cannot fit within one band; shorter spans are checked
 *  against each applicable daily occurrence.
 * - Without a schedule, timestamps are not required: static pricing applies
 *   to any usage.
 *
 * The returned band keeps the base `tiers` for off-peak usage; a peak interval
 * resolves to the override rates only (the override replaces the rate table).
 */
export function resolveApplicablePricing(
  pricing: ModelTokenPricing,
  applicability: PricingApplicability = {},
): ModelTokenPricing | undefined {
  if (pricing.cacheReadUnsupported === true && (applicability.cacheReadTokens ?? 0) > 0) {
    return undefined;
  }
  const peak = pricing.peak;
  if (!peak) return pricing;
  const interval = applicability.interval;
  if (!interval) return undefined;
  const { startedAtMs, endedAtMs } = interval;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
    || startedAtMs < 0 || endedAtMs < startedAtMs) {
    return undefined;
  }
  return pricingForInterval(pricing, peak, startedAtMs, endedAtMs);
}

/** Resolve the band for one valid, closed evidence interval: peak override
 *  when both endpoints lie in one half-open window occurrence, base pricing
 *  when the closed span does not intersect a peak window, and `undefined`
 *  when the evidence spans different bands. */
function pricingForInterval(
  pricing: ModelTokenPricing,
  peak: ModelPricingPeakWindow,
  startedAtMs: number,
  endedAtMs: number,
): ModelTokenPricing | undefined {
  // A full week necessarily intersects at least one non-empty peak schedule;
  // shorter multi-day intervals can still be entirely off-peak (for example a
  // full Saturday), so inspect those daily occurrences instead of rejecting
  // them merely for lasting a day.
  if (endedAtMs - startedAtMs >= 7 * MS_PER_DAY) return undefined;
  const firstDay = Math.floor(startedAtMs / MS_PER_DAY);
  const lastDay = Math.floor(endedAtMs / MS_PER_DAY);
  for (let day = firstDay; day <= lastDay; day++) {
    // Epoch day 0 (1970-01-01) was a Thursday; JS `getUTCDay()` numbers it 4.
    if (!peak.weekdaysUtc.includes((day + 4) % 7)) continue;
    const occurrenceStartMs = day * MS_PER_DAY + peak.startMinutesUtc * MS_PER_MINUTE;
    const occurrenceEndMs = day * MS_PER_DAY + peak.endMinutesUtc * MS_PER_MINUTE;
    // Evidence endpoints are closed while schedule bands are half-open:
    // touching a band's start counts as possible use of that band, but its
    // exclusive end does not. Both anchors must still resolve to one band.
    if (occurrenceEndMs <= startedAtMs || occurrenceStartMs > endedAtMs) continue;
    if (occurrenceStartMs <= startedAtMs && endedAtMs < occurrenceEndMs) {
      return {
        input: peak.override.input,
        output: peak.override.output,
        cacheRead: peak.override.cacheRead,
        cacheWrite: peak.override.cacheWrite,
      };
    }
    return undefined;
  }
  return pricing;
}

/**
 * Validate a required non-negative finite rate.
 * - Returns the value if it is a valid non-negative finite number.
 * - Returns `undefined` if the field is absent (unknown pricing) or present
 *   but invalid (negative, NaN, Infinity, non-number).
 */
function requiredValidNumber(v: unknown): number | undefined {
  if (typeof v !== "number") return undefined;
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v;
}

/**
 * Validate an optional non-negative finite rate (inapplicable defaults).
 * - Returns the value if it is a valid non-negative finite number.
 * - Returns `0` if the field is absent (not applicable).
 * - Returns `undefined` if the field is present but invalid (negative, NaN,
 *   Infinity, non-number).
 */
function optionalValidNumber(v: unknown): number | undefined {
  return v === undefined ? 0 : requiredValidNumber(v);
}
