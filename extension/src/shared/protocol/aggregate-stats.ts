/**
 * Aggregate statistics across ALL sessions, computed host-side by
 * {@link AggregateStatsService} (mirroring `TokenRateService`'s host-owned pattern)
 * and posted to the webview as {@link ViewState.aggregateStats}.
 *
 * The webview never computes these itself (STATE_CONTRACT § Webview-Local State):
 * the strip is a pure projection of host-owned data. The host recomputes on a
 * slow historical timer plus a cheap event-driven live path. The live path is
 * bounded by open runs and reuses the completed-history layer, so streaming
 * totals/charts update without polling disk or backend metrics at 5 Hz. Equal
 * results retain the cached reference, mirroring `tokenRateBySession`.
 *
 * ## Focus: recent + current
 *
 * The strip surfaces **recent** (today / this-week) and **current** (live /
 * open) activity over long-term all-time totals. All-time figures are retained
 * for tooltip context but are not the headline. Per-provider breakdowns live in
 * each segment's scoped tooltip rather than dedicated inline chips.
 *
 * ## Provider attribution
 *
 * `RunSnapshot` carries the serving provider alongside the model id. Parent-turn
 * usage uses that pair; skill-pruning and subagent usage use their recorded
 * actual pair when available, then fall back to the run pair. This prevents a
 * shared model id (for example GPT-5.6 on OpenAI Codex and GitHub Copilot) from
 * being relabeled or priced as the wrong provider. Legacy snapshots without a
 * provider retain the historical first-priced-provider fallback.
 */

import type { RunOutcome } from './settings.js';

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

/** One day's per-provider cost (local `YYYY-MM-DD`). */
export interface AggregateDailyCost {
  /** Local calendar date (`YYYY-MM-DD`); resets at local midnight. */
  date: string;
  totalCost: number;
  byProvider: AggregateProviderCost[];
  /** Per-model cost for this day (hover detail for the weekly chart). */
  byModel: AggregateDailyModelCost[];
}

/** Per-model cost within a single day (local). */
export interface AggregateDailyModelCost {
  model: string;
  cost: number;
}

/** One day's run count (local `YYYY-MM-DD`) for the sessions-tooltip sparkline. */
export interface AggregateDailyRunCount {
  /** Local calendar date (`YYYY-MM-DD`). */
  date: string;
  runCount: number;
}

/** A single segment (provider or model) of a series point's breakdown. */
export interface AggregateSeriesSegment {
  /** Provider or model id. */
  key: string;
  value: number;
}

/** One point in an intraday timeseries (e.g. today's cumulative cost). The
 *  point carries per-provider and per-model breakdowns so a stacked-area chart
 *  can render provider bands and a hover crosshair can show the per-model
 *  composition at that point.
 *
 *  - **Cumulative series** (cost, tokens): `byProvider`/`byModel` are cumulative
 *    up to and including this point; the chart steps up at each point.
 *  - **Rate series** (throughput): `byProvider`/`byModel` are the bucket's
 *    per-provider/per-model rate (tok/s); the chart draws per-bucket bands. */
export interface AggregateSeriesPoint {
  /** ms epoch the point is anchored at (turn-end time, or bucket start). */
  ms: number;
  /** Per-provider breakdown at this point, sorted descending by value. */
  byProvider: AggregateSeriesSegment[];
  /** Per-model breakdown at this point (hover detail), sorted descending. */
  byModel: AggregateSeriesSegment[];
}

/** One turn of the most-recent run, for the last-run sparkline. */
export interface AggregateLastRunTurn {
  /** ms epoch the turn ended. */
  ms: number;
  /** Output tokens reported for this turn. */
  outputTokens: number;
}

/** Summary of the most recently finalized run across all sessions. */
export interface AggregateLastRun {
  /** Cost (USD) of the run, derived from its tokens × pricing. */
  cost: number;
  /** Wall-clock busy duration in ms (the run's `busyDurationMs`). */
  durationMs: number;
  /** Model id used for the run (null when unrecorded). */
  modelId: string | null;
  /** Resolved provider name (or `'unknown'`). */
  provider: string;
  /** Scored outcome, or null when the run closed unscored. */
  outcome: RunOutcome | null;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run ended (finalizedAt, falling back to updatedAt). */
  endedAt: string;
  /** Input tokens reported across the run's assistant turns. */
  inputTokens: number;
  /** Output tokens reported across the run's assistant turns. */
  outputTokens: number;
  /** Per-turn output tokens for the run (sparkline), ascending by time. */
  turnSeries: AggregateLastRunTurn[];
}

/** Live warm-bash pool metrics, aggregated across all open sessions.
 *  Reported by the warm-bash extension (backend child process) via a
 *  `Symbol.for` globalThis registry and polled host-side each aggregate tick.
 *  `enabled` is false (and counts zero) when warm bash is disabled or no bash
 *  call has built a pool yet — the status strip hides the segment in that case. */
export interface WarmBashStats {
  /** Warm bash is active (the shared pool exists and is not disposed). */
  enabled: boolean;
  /** Count of sessions that have built a warm-bash tool (active users of the shared pool). */
  activeSessions: number;
  /** Configured idle target for the single shared warm pool. */
  poolSize: number;
  /** Idle warm workers ready to serve a command immediately. */
  ready: number;
  /** Workers currently warming (spawned but not yet ready). */
  warming: number;
  /** Fast-path toggle is on for at least one session. */
  fastPathEnabled: boolean;
  /** Commands run via the execFile fast path (no shell at all). */
  totalFastPath: number;
  /** Commands run via the warm pool (pre-warmed shell + marker protocol). */
  totalWarm: number;
  /** Commands run via the fresh-spawn fallback (today's exact path). */
  totalFallback: number;
  /** Warmup attempts that failed (timed out / shell unavailable). */
  totalWarmupFailures: number;
}

/** Empty warm-bash stats (disabled, zero counts) used as the default before the
 *  first host poll lands and as the registry-empty fallback. Stable reference. */
export const EMPTY_WARM_BASH_STATS: WarmBashStats = {
  enabled: false,
  activeSessions: 0,
  poolSize: 0,
  ready: 0,
  warming: 0,
  fastPathEnabled: false,
  totalFastPath: 0,
  totalWarm: 0,
  totalFallback: 0,
  totalWarmupFailures: 0,
};

/** Live per-provider concurrency-gate metrics, reported by the backend's
 *  host-side `ProviderGate` (wraps `globalThis.fetch`) via the
 *  `provider_gate.metrics` RPC. `enabled` is false (and `providers` empty) when
 *  the gate is not installed (no provider has a concurrency config) — the
 *  status strip hides the segment in that case. Mirrors the warm-bash pattern. */
export interface ProviderGateStats {
  /** The provider gate is installed (≥1 provider has a concurrency config). */
  enabled: boolean;
  /** Per-provider live metrics (active/queued/max + afterburn + pause state). */
  providers: ProviderGateProviderMetrics[];
}

/** Per-provider metrics within a {@link ProviderGateStats} snapshot. */
export interface ProviderGateProviderMetrics {
  provider: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrentRequests: number;
  afterburnSeconds: number;
  /** Configured maximum queue wait before provider-gate saturation fails. */
  queueWaitSeconds?: number;
  paused: boolean;
  pausedUntilMs: number;
  strikeCount: number;
}

/** Empty provider-gate stats (disabled, empty providers) — pre-poll default and
 *  not-installed fallback. Stable reference. */
export const EMPTY_PROVIDER_GATE_STATS: ProviderGateStats = {
  enabled: false,
  providers: [],
};

/**
 * Aggregate stats across all runs (completed + open) for the current
 * workspace, with a recent/current focus. All cost figures are in USD.
 */
export interface AggregateStats {
  // ── Recent: today ──
  /** Total spend for the current local day (resets at local midnight). */
  todayCost: number;
  /** Today's spend per provider, sorted descending by cost. */
  todayCostByProvider: AggregateProviderCost[];
  /** Mean output tok/s across completed turns whose sample ended today (local). */
  todayTokensPerSecond: number;
  /** Per-provider throughput for today, sorted descending by output tokens. */
  todayTokensPerSecondByProvider: AggregateProviderThroughput[];
  /** Number of runs that landed (finalized/updated/started) today. */
  todayRunCount: number;
  /** Cumulative input tokens across today's runs. */
  todayInputTokens: number;
  /** Cumulative output tokens across today's runs. */
  todayOutputTokens: number;
  /** Total tool calls across today's runs (recent activity signal). */
  todayToolCallCount: number;
  /** Approximate distinct files touched across today's runs (sum of per-run
   *  touched-file counts; may double-count a file edited across runs). */
  todayTouchedFileCount: number;
  /** Intraday cumulative cost series for today (local), one point per turn,
   *  pruned to [first spend, now]. Stacked by provider; per-model on hover. */
  todayCostSeries: AggregateSeriesPoint[];
  /** Intraday cumulative output-token series for today (local), one point per
   *  turn. Stacked by provider; per-model on hover. */
  todayTokenSeries: AggregateSeriesPoint[];
  /** Intraday per-hour throughput series for today (local), one point per hour
   *  with data. Stacked by provider (tok/s); per-model on hover. */
  todayThroughputSeries: AggregateSeriesPoint[];

  // ── Recent: this week (last 7 days, inclusive of today) ──
  /** Total spend over the last 7 local days (inclusive of today). */
  weekCost: number;
  /** Last-7-days spend per provider, sorted descending by cost. */
  weekCostByProvider: AggregateProviderCost[];
  /** Number of runs in the last 7 days. */
  weekRunCount: number;
  /** Per-day cost for the last 14 days (ascending date) — tooltip context. */
  dailyCost: AggregateDailyCost[];
  /** Per-day run count for the last 14 days (ascending date) — sessions tooltip. */
  dailyRunCount: AggregateDailyRunCount[];

  // ── Current: live / open ──
  /**
   * Sum of live tok/s across currently-running sessions (from
   * `TokenRateService.getRates()`). 0 when no session is generating.
   */
  liveTokensPerSecond: number;
  /** Number of currently-running sessions. */
  runningSessionCount: number;
  /** Number of currently-open session tabs (current UI state, not analytics). */
  openTabCount: number;
  /** Live warm-bash pool metrics (ready/warming counts + execution breakdown),
   *  polled from the backend. See {@link WarmBashStats}. */
  warmBash: WarmBashStats;
  /** Live provider-gate concurrency metrics (active/queued + pause state),
   *  polled from the backend's host-side `ProviderGate`. See
   *  {@link ProviderGateStats}. */
  providerGate: ProviderGateStats;

  // ── All-time (tooltip context only) ──
  /** Total cost across all runs (sum of {@link costByProvider}). */
  totalCost: number;
  /** Cost per provider (all runs), sorted descending by cost. */
  costByProvider: AggregateProviderCost[];
  /** Generation-time-weighted mean output tok/s across ALL completed turns. */
  tokensPerSecond: number;
  /** Per-provider throughput (all runs), sorted descending by output tokens. */
  tokensPerSecondByProvider: AggregateProviderThroughput[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Number of runs included in the aggregate (completed + open). */
  runCount: number;
  /** Number of distinct sessions that ever had a run (all-time). */
  sessionCount: number;
  /** Most recently finalized run across all sessions, or null when none. */
  lastRun: AggregateLastRun | null;

  /** False until the host has completed its first computation. */
  ready: boolean;
}

/** Empty aggregate (zeros) used as the ViewState default before the first
 *  host computation lands. Stable reference so the webview's `EMPTY_VIEW_STATE`
 *  and the projection placeholder never allocate. */
export const EMPTY_AGGREGATE_STATS: AggregateStats = {
  todayCost: 0,
  todayCostByProvider: [],
  todayTokensPerSecond: 0,
  todayTokensPerSecondByProvider: [],
  todayRunCount: 0,
  todayInputTokens: 0,
  todayOutputTokens: 0,
  todayToolCallCount: 0,
  todayTouchedFileCount: 0,
  todayCostSeries: [],
  todayTokenSeries: [],
  todayThroughputSeries: [],
  weekCost: 0,
  weekCostByProvider: [],
  weekRunCount: 0,
  dailyCost: [],
  dailyRunCount: [],
  liveTokensPerSecond: 0,
  runningSessionCount: 0,
  openTabCount: 0,
  warmBash: EMPTY_WARM_BASH_STATS,
  providerGate: EMPTY_PROVIDER_GATE_STATS,
  totalCost: 0,
  costByProvider: [],
  tokensPerSecond: 0,
  tokensPerSecondByProvider: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  runCount: 0,
  sessionCount: 0,
  lastRun: null,
  ready: false,
};
