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
  /** Serving provider; model ids are not globally unique across providers. */
  provider: string;
  model: string;
  cost: number;
}

/** One day's run count (local `YYYY-MM-DD`) for the sessions-tooltip sparkline. */
export interface AggregateDailyRunCount {
  /** Local calendar date (`YYYY-MM-DD`). */
  date: string;
  runCount: number;
}

/** Productivity rollup for a window (today / 7-day / a single day of the work
 *  trend). Counters are exact sums over the window's runs; sample-based fields
 *  also expose their coverage so runs recorded before a metric existed stay
 *  untracked instead of silently reading as zeros. */
export interface AggregateProductivityStats {
  /** User prompts (sends) in the window. Retained for analytics compatibility. */
  sendCount: number;
  /** Sum of flattened composer-prompt and answered ask_user character samples
   * after applying the shared trailing-14-day percentile cap. */
  adjustedUserInputChars: number;
  /** Known numeric character samples contributing to the adjusted sum. */
  knownUserInputCharSampleCount: number;
  /** Expected user-input events, including null markers for unavailable or
   * malformed lengths. The total is exact iff known count reaches this count. */
  expectedUserInputCharSampleCount: number;
  /** Known samples in this window whose raw length exceeded the shared cap. */
  cappedUserInputCharSampleCount: number;
  /** Shared trailing-14-day cap in Unicode code points; null with no known samples. */
  userInputCharCap: number | null;
  /** Runs in the window that recorded `initialUserMessageChars`. 0 means no
   *  tracked samples in the window (average unknown), not a zero average. */
  promptCharSamples: number;
  /** Total user prompt length in Unicode characters across tracked samples. */
  promptChars: number;
  /** Mean tracked user prompt length in characters; null when no run in the
   *  window recorded its prompt length. */
  averagePromptChars: number | null;
  /** Runs in the window that recorded estimated prompt tokens (new runs only). */
  promptTokenSamples: number;
  /** Total estimated user prompt tokens across tracked runs (privacy-safe BPE
   *  estimate captured at send time; the prompt text is never stored). */
  promptTokens: number;
  /** Provider model-input tokens across the window's recorded usage. */
  inputTokens: number;
  /** Filesystem path references (file/dir mentions) in the window. Tracked for
   *  every run; 0 means none were recorded, not that tracking is missing. */
  filesystemPathRefCount: number;
  /** Image attachments in the window. */
  imageInputCount: number;
  /** Image attachment bytes in the window (never mixed with non-image input). */
  imageInputBytes: number;
  /** ask_user questions answered in the window's tracked runs. */
  askUserAnsweredCount: number;
  /** ask_user questions cancelled in the window's tracked runs. Missing legacy
   *  counters are untracked (see {@link askUserTrackedRuns}), never zero. */
  askUserCancelledCount: number;
  /** Runs in the window that track ask_user outcomes. 0 = coverage unknown
   *  (all runs predate ask_user tracking), not "no questions asked". */
  askUserTrackedRuns: number;
}

/** Empty productivity rollup. Stable reference for the ViewState default and
 *  zero-activity work-trend days. */
export const EMPTY_PRODUCTIVITY_STATS: AggregateProductivityStats = {
  sendCount: 0,
  adjustedUserInputChars: 0,
  knownUserInputCharSampleCount: 0,
  expectedUserInputCharSampleCount: 0,
  cappedUserInputCharSampleCount: 0,
  userInputCharCap: null,
  promptCharSamples: 0,
  promptChars: 0,
  averagePromptChars: null,
  promptTokenSamples: 0,
  promptTokens: 0,
  inputTokens: 0,
  filesystemPathRefCount: 0,
  imageInputCount: 0,
  imageInputBytes: 0,
  askUserAnsweredCount: 0,
  askUserCancelledCount: 0,
  askUserTrackedRuns: 0,
};

/** One day's work-trend point (local `YYYY-MM-DD`) for the Work tooltip.
 *  Historical facts only: distinct sessions that were used and the peak number
 *  of concurrently working sessions. Open-tab history is never claimed. */
export interface AggregateDailyWorkTrend {
  /** Local calendar date (`YYYY-MM-DD`). */
  date: string;
  /** Distinct sessions with a run landing on this day. */
  sessionsUsed: number;
  /** Peak concurrently working sessions observed this day: the best available
   *  `TurnThroughputSample.concurrentBusySessions`, else a conservative 1 when
   *  a busy run was observed without samples. 0 = no busy evidence that day. */
  peakWorkingSessions: number;
  /** Per-day productivity rollup (see {@link AggregateProductivityStats}). */
  productivity: AggregateProductivityStats;
}

/** A single segment (provider or model) of a series point's breakdown. */
export interface AggregateSeriesSegment {
  /** Provider id. */
  key: string;
  value: number;
}

/** A provider-qualified model segment. The tuple is the identity: the same
 * model id served by two providers remains two distinct chart entries. */
export interface AggregateModelSeriesSegment extends AggregateSeriesSegment {
  provider: string;
  model: string;
}

/** One point in an intraday timeseries (e.g. today's cumulative cost). The
 *  point carries per-provider and per-model breakdowns so a stacked-area chart
 *  can render provider bands and a hover crosshair can show the per-model
 *  composition at that point.
 *
 *  - **Cumulative series** (cost, tokens): `byProvider`/`byModel` are cumulative
 *    up to and including this point; the chart uses non-overshooting monotone
 *    curves between the exact samples.
 *  - **Rate series** (throughput): `byProvider`/`byModel` are the bucket's
 *    per-provider/per-model rate (tok/s); the chart draws per-bucket bands. */
export interface AggregateSeriesPoint {
  /** ms epoch the point is anchored at (turn-end time, or bucket start). */
  ms: number;
  /** Per-provider breakdown at this point, sorted descending by value. */
  byProvider: AggregateSeriesSegment[];
  /** Provider-qualified per-model breakdown at this point, sorted descending. */
  byModel: AggregateModelSeriesSegment[];
}

/** One turn of the most-recent run, for the last-run sparkline. */
export interface AggregateLastRunTurn {
  /** ms epoch the turn ended. */
  ms: number;
  /** Output tokens reported for this turn. */
  outputTokens: number;
}

/** Summary of the most recently finalized run across all sessions. */
/** Host aggregation of terminal subagent lifecycle evidence. Every source
 * bucket is explicit so unavailable fields cannot silently turn into zeros. */
export interface AggregateSubagentLifecycleStats {
  /** Parsed terminal attempt records. */
  attemptCount: number;
  outcomeCounts: Record<'success' | 'failure' | 'aborted', number>;
  /** Attempt timing is only summed within its stated provenance bucket. */
  attemptDuration: {
    reportedMs: number;
    reportedCount: number;
    measuredMs: number;
    measuredCount: number;
    estimatedMs: number;
    estimatedCount: number;
    unknownCount: number;
  };
  /** Stop/activity outcomes reported by child attempts. These do not identify
   * the parent tool-call settlement source. */
  attemptSettlements: { reportedCount: number; unknownCount: number; byOutcome: Record<string, number> };
  /** Parent settlement provenance is unavailable from attempt telemetry. */
  parentSettlement: { unknownCount: number };
  retries: {
    attemptCount: number;
    backoff: { reportedMs: number; reportedCount: number; estimatedMs: number; estimatedCount: number; unknownCount: number };
  };
  /** Cleanup telemetry coverage/outcomes. Unknown does not mean an attempt was
   * orphaned; it only means no cleanup telemetry was reported. */
  cleanupTelemetry: { reportedCount: number; unknownCount: number; byOutcome: Record<string, number> };
  /** Measured phase duration coverage. Unknown counts attempts whose phase map
   * was unavailable/malformed; it is not a count for every absent phase. */
  phaseDurations: {
    measuredMsByPhase: Record<string, number>;
    measuredCountByPhase: Record<string, number>;
    unknownAttemptCount: number;
  };
  /** Terminal subagent calls from runs that did not preserve parseable attempt
   * records. This is unknown coverage, not zero attempts. */
  unknownAttemptRecordCallCount: number;
}

export const EMPTY_SUBAGENT_LIFECYCLE_STATS: AggregateSubagentLifecycleStats = {
  attemptCount: 0,
  outcomeCounts: { success: 0, failure: 0, aborted: 0 },
  attemptDuration: { reportedMs: 0, reportedCount: 0, measuredMs: 0, measuredCount: 0, estimatedMs: 0, estimatedCount: 0, unknownCount: 0 },
  attemptSettlements: { reportedCount: 0, unknownCount: 0, byOutcome: {} },
  parentSettlement: { unknownCount: 0 },
  retries: { attemptCount: 0, backoff: { reportedMs: 0, reportedCount: 0, estimatedMs: 0, estimatedCount: 0, unknownCount: 0 } },
  cleanupTelemetry: { reportedCount: 0, unknownCount: 0, byOutcome: {} },
  phaseDurations: { measuredMsByPhase: {}, measuredCountByPhase: {}, unknownAttemptCount: 0 },
  unknownAttemptRecordCallCount: 0,
};

export interface AggregateLastRun {
  /** Cost (USD) of the run, derived from its tokens × pricing. */
  cost: number;
  /** Wall-clock busy duration in ms (the run's `busyDurationMs`). */
  durationMs: number;
  /** Model id used for the run (null when unrecorded). */
  modelId: string | null;
  /** Resolved provider name (or `'unknown'`). */
  provider: string;
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
  /** Intraday cumulative input-token series for today (local), using recorded
   * usage timestamps. Stacked by provider; provider-qualified models on hover. */
  todayInputTokenSeries: AggregateSeriesPoint[];
  /** Intraday cumulative output-token series for today (local), one point per
   * turn. Stacked by provider; provider-qualified models on hover. */
  todayTokenSeries: AggregateSeriesPoint[];
  /** Intraday per-hour throughput series for today (local), one point per hour
   *  with data. Stacked by provider (tok/s); per-model on hover. */
  todayThroughputSeries: AggregateSeriesPoint[];
  /** Today's productivity summary (see {@link AggregateProductivityStats}). */
  todayProductivity: AggregateProductivityStats;

  // ── Recent: this week (last 7 days, inclusive of today) ──
  /** Total spend over the last 7 local days (inclusive of today). */
  weekCost: number;
  /** Last-7-days spend per provider, sorted descending by cost. */
  weekCostByProvider: AggregateProviderCost[];
  /** Number of runs in the last 7 days. */
  weekRunCount: number;
  /** 7-day productivity summary (see {@link AggregateProductivityStats}). */
  weekProductivity: AggregateProductivityStats;
  /** Granular cumulative cost over the rolling seven-local-day window, built
   * from timestamped usage samples and stacked by provider. */
  weekCostSeries: AggregateSeriesPoint[];
  /** Per-day cost for the last 14 days (ascending date) — tooltip context. */
  dailyCost: AggregateDailyCost[];
  /** Per-day run count for the last 14 days (ascending date) — sessions tooltip. */
  dailyRunCount: AggregateDailyRunCount[];
  /** Per-day work trend for the last 14 days (ascending date, leading idle
   *  days pruned): distinct sessions used and peak concurrently working
   *  sessions — historical run evidence, never open-tab history. */
  dailyWorkTrend: AggregateDailyWorkTrend[];

  // ── Current: live / open ──
  /** Sum of the primary per-session active-generation speeds. This uses each
   * running session's generation-time window and excludes TTFT, tools, and
   * between-turn waits. */
  activeGenerationTokensPerSecond: number;
  /**
   * Aggregate output rate over the trailing 30 seconds of wall time. Includes
   * every session and decays through tool calls, idle gaps, and run completion.
   * This is the end-to-end/experienced metric, retained separately from the
   * active-generation speed above.
   */
  liveTokensPerSecond: number;
  /** Number of currently-running sessions. */
  runningSessionCount: number;
  /** Number of currently-open session tabs (current UI state, not analytics). */
  openTabCount: number;
  /** Terminal subagent lifecycle evidence across completed and open runs. */
  subagentLifecycle: AggregateSubagentLifecycleStats;
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
  /** Ledger completeness provenance. Absent only for pre-M3 host snapshots. */
  billableAccounting?: {
    invocationCount: number;
    todayUnknownInvocationCount: number;
    todayUnpricedInvocationCount: number;
    todayInstrumentationGapInvocationCount: number;
    weekUnknownInvocationCount: number;
    weekUnpricedInvocationCount: number;
    weekInstrumentationGapInvocationCount: number;
    unknownInvocationCount: number;
    unpricedInvocationCount: number;
    instrumentationGapInvocationCount: number;
  };
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
  todayInputTokenSeries: [],
  todayTokenSeries: [],
  todayThroughputSeries: [],
  todayProductivity: EMPTY_PRODUCTIVITY_STATS,
  weekCost: 0,
  weekCostByProvider: [],
  weekRunCount: 0,
  weekProductivity: EMPTY_PRODUCTIVITY_STATS,
  weekCostSeries: [],
  dailyCost: [],
  dailyRunCount: [],
  dailyWorkTrend: [],
  activeGenerationTokensPerSecond: 0,
  liveTokensPerSecond: 0,
  runningSessionCount: 0,
  openTabCount: 0,
  subagentLifecycle: EMPTY_SUBAGENT_LIFECYCLE_STATS,
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
