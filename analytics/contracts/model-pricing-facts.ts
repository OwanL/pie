/**
 * Financial pricing facts shared by provider pricing and analytics.
 *
 * This contract owns the data exchanged across the pricing/accounting boundary.
 * Catalog loading, pricing applicability, and cost calculation remain with
 * their respective runtime owners.
 */

/** Real token pricing in USD per 1M tokens.
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
   *  band (the peak window or off-peak). */
  peak?: ModelPricingPeakWindow;
  /** True when the provider publishes no cache-read price (`-`). Positive
   *  cache-read usage stays unpriced; zero cache-read usage still prices the
   *  base rates. The `cacheRead` rate remains provenance metadata only. */
  cacheReadUnsupported?: boolean;
}

/** A pricing record keyed by model id, including the provider for disambiguation. */
export interface ModelPricingRecord {
  id: string;
  provider: string;
  pricing?: ModelTokenPricing;
}

/** Provider-request evidence interval in epoch milliseconds. Both endpoints
 *  must be real observed times: the resolver never synthesizes timing. Both
 *  endpoints count as possible billing anchors for applicability. */
export interface PricingIntervalEvidence {
  startedAtMs: number;
  endedAtMs: number;
}

/** Loaded provider/model pricing facts plus the catalog identity they were
 *  captured from. `catalogVersion` is the sha256 of the active `models.json`
 *  content, matching the legacy settlement rate-snapshot provenance. */
export interface CapturedPricingFacts {
  readonly catalogVersion: string;
  readonly map: ReadonlyMap<string, ModelPricingRecord[]>;
}

/** Loaded pricing catalog plus the stat signature that produced it. */
export interface PricingCatalog {
  signature: string;
  map: Map<string, ModelPricingRecord[]>;
}
