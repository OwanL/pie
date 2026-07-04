/**
 * Aggregate statistics across ALL sessions, computed host-side by
 * {@link AggregateStatsService} (mirroring `TokenRateService`'s host-owned pattern)
 * and posted to the webview as {@link ViewState.aggregateStats}.
 *
 * The webview never computes these itself (STATE_CONTRACT § Webview-Local State):
 * the strip is a pure projection of host-owned data. The host recomputes on a
 * slow timer (and on run-analytics persistence), so the cached object reference
 * is stable between recomputes — mirroring `tokenRateBySession`'s reference-
 * stability contract (the host spreads the cached ref into each ViewState).
 *
 * ## Provider attribution
 *
 * `RunSnapshot` carries only `modelId` (never the serving provider). A model id
 * can appear under multiple providers in `models.json`. For per-provider
 * breakdown we attribute each run to the **first priced provider** for its
 * `modelId` in `loadModelPricing`'s map — the SAME record the webview's
 * per-session cost display uses (`pricingForModel`), so aggregate totals stay
 * consistent with the per-session cost the user already sees. Runs whose
 * `modelId` is unknown or unpriced attribute to provider `'unknown'` (cost 0).
 */

/**
 * Per-provider cost + token rollup. `provider` is the provider name from
 * `models.json` (or `'unknown'` when the model is unpriced/unknown).
 */
export interface AggregateProviderCost {
  provider: string;
  /** Cost in USD across the runs attributed to this provider. */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Per-provider output-throughput rollup. The rate is a **generation-time-
 * weighted mean** across completed turn samples:
 *
 *   tokensPerSecond = Σ outputTokens / (Σ generationDurationMs / 1000)
 *
 * so a long slow turn correctly dominates the average over a short fast one
 * (rather than a naive mean-of-per-turn-rates that over-weights fast bursts).
 */
export interface AggregateProviderThroughput {
  provider: string;
  tokensPerSecond: number;
  outputTokens: number;
  generationDurationMs: number;
  /** Number of completed turn samples that fed this provider's rate. */
  sampleCount: number;
}

/** One day's per-provider cost (UTC `YYYY-MM-DD`). */
export interface AggregateDailyCost {
  /** UTC calendar date (`YYYY-MM-DD`). */
  date: string;
  totalCost: number;
  byProvider: AggregateProviderCost[];
}

/**
 * Aggregate stats across all runs (completed + open) for the current
 * workspace. All cost figures are in USD.
 */
export interface AggregateStats {
  /** Total cost across all runs (sum of {@link costByProvider}). */
  totalCost: number;
  /** Cost per provider, sorted descending by cost. */
  costByProvider: AggregateProviderCost[];
  /** Total spend for the current UTC day. */
  todayCost: number;
  /** Today's spend per provider, sorted descending by cost. */
  todayCostByProvider: AggregateProviderCost[];
  /** Per-day cost for the last `N` days (ascending date). */
  dailyCost: AggregateDailyCost[];
  /** Generation-time-weighted mean output tokens/sec across all completed turns. */
  tokensPerSecond: number;
  /** Per-provider throughput breakdown, sorted descending by output tokens. */
  tokensPerSecondByProvider: AggregateProviderThroughput[];
  /**
   * Sum of live tok/s across currently-running sessions (from
   * `TokenRateService.getRates()`). 0 when no session is generating.
   */
  liveTokensPerSecond: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Number of runs included in the aggregate (completed + open). */
  runCount: number;
  /** Number of distinct sessions. */
  sessionCount: number;
  /** Number of currently-running sessions. */
  runningSessionCount: number;
  /** False until the host has completed its first computation. */
  ready: boolean;
}

/** Empty aggregate (zeros) used as the ViewState default before the first
 *  host computation lands. Stable reference so the webview's `EMPTY_VIEW_STATE`
 *  and the projection placeholder never allocate. */
export const EMPTY_AGGREGATE_STATS: AggregateStats = {
  totalCost: 0,
  costByProvider: [],
  todayCost: 0,
  todayCostByProvider: [],
  dailyCost: [],
  tokensPerSecond: 0,
  tokensPerSecondByProvider: [],
  liveTokensPerSecond: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  runCount: 0,
  sessionCount: 0,
  runningSessionCount: 0,
  ready: false,
};
