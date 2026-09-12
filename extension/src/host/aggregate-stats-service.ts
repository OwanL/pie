import {
  EMPTY_AGGREGATE_STATS,
  type AggregateProviderCost,
  type AggregateStats,
  type ProviderGateStats,
} from '../shared/protocol/aggregate-stats';
import type { ArchState } from './core/arch-state';
import type { TokenRateService } from './token-rate-service';
import { RollingAggregateRate } from './rolling-aggregate-rate';
import type { StatsServicePort } from './stats-service';
import {
  accumulateAggregateStats,
  finalizeAggregateStatsLayers,
  localDateString,
  type AggregateStatsAccumulator,
} from './stats-service/aggregate-stats';
import {
  addLocalCalendarDaysMs,
  localCalendarDayStartMs,
} from '../../../shared/analytics/metrics.js';
import type { RunSnapshot } from './run-analytics';
import type { TokenRateIndicatorState } from '../shared/token-rate';
import type { ModelPricingRecord } from '../../../shared/pricing-core';
import { appendPieLog } from './util/pie-log';
import { toErrorMessage } from './util/error-message';
import type { BillableInvocationRecord } from '../shared/billable-invocation';
import {
  applyLedgerUsageOverlay,
  buildLedgerUsageProjection,
  type LedgerUsageOverlay,
} from './billable-invocation-ledger/aggregate';
import { AggregatePricingCache } from './aggregate-pricing-cache';
import { CompletedHistoryCache, type CompletedHistoryMtimeFn } from './completed-history-cache';
import type { CanonicalAnalyticsReadModel } from '../analytics/query-entry.js';
import type { ProviderAccountingSummary } from '../analytics/sqlite-recorder.js';

/**
 * Measures aggregate usage stats across ALL sessions host-side — total + per-
 * provider cost (with a daily series), token totals, and generation-throughput
 * (mean tok/s with a per-provider breakdown) — and posts them to the webview as
 * `ViewState.aggregateStats`.
 *
 * Mirrors `TokenRateService`'s host-owned pattern (STATE_CONTRACT § Webview-
 * Local State): the webview is a pure projection and never computes aggregates
 * itself. The cached object reference is stable between recomputes so the
 * webview's `memo()` barriers hold across snapshot posts (the host spreads the
 * cached ref into each ViewState, exactly like `tokenRateBySession`).
 *
 * ## Refresh model
 *
 * A {@link RECOMPUTE_MS} interval refreshes history and backend metrics.
 * Completed-run history and pricing live in {@link CompletedHistoryCache} and
 * {@link AggregatePricingCache}; this service owns only the refresh cadence,
 * the open-run layer, the rolling rate, and ledger projection. Independently,
 * TokenRateService signals aggregate-relevant changes every 200 ms; that path
 * rebuilds only the small in-memory open-run layer and reuses completed history.
 * Live throughput, counts, token totals, and charts therefore move during all
 * active streams without rereading completed history or rebuilding ledger
 * snapshots at the fast cadence; the ledger authority check remains cheap and
 * signature-gated.
 *
 * Side-effectful (wall-clock + `setInterval` + disk reads) by design — it lives
 * outside the pure reducer, mirroring `TokenRateService`.
 */

export interface AggregateStatsServiceDeps {
  getArchState: () => ArchState;
  statsService: StatsServicePort;
  /** Process-local rehearsal gate. Normal operation is enabled by default. */
  enabled?: boolean;
  tokenRateService: TokenRateService;
  /** Resolve the agent dir containing `models.json` and the generated
   *  historical pricing catalog. Called each tick so a runtime `pie.agentDir`
   *  change is picked up. Returns null when unresolved. */
  getAgentDir: () => string | null;
  /** Poll live provider-gate concurrency metrics from the backend
   *  (in-memory `ProviderGate` read via the `provider_gate.metrics` RPC).
   *  Resolves to {@link EMPTY_PROVIDER_GATE_STATS} on any failure so the
   *  strip hides the segment rather than freezing. */
  fetchProviderGateStats: () => Promise<ProviderGateStats>;
  /** Called when the posted aggregate changed, so the host can schedule a
   *  debounced snapshot post to the webview. */
  onChanged: () => void;
  /** File-system stat callback used by the completed-history cache-mutation
   *  detector. Defaults to `fs.stat` in production; tests inject a mock to
   *  control mtime values. `size` is optional for backward-compatible mocks;
   *  when absent the incremental append path is disabled (every change falls
   *  back to a full re-read), which keeps mocked tests on the deterministic
   *  full path. */
  mtimeFn?: CompletedHistoryMtimeFn;
  /** Test/benchmark seam for proving which run set was accumulated. */
  onAccumulatorBuilt?: (scope: 'completed' | 'open', runCount: number) => void;
  /** Test/benchmark seam proving unbounded completed-history entries are only
   * visited while preparing a new completed layer, never on open-run ticks. */
  onCompletedSourceEntryVisited?: (kind: 'day' | 'cost_sample' | 'token_sample' | 'throughput_hour') => void;
  /** Clock seam for deterministic date-boundary tests. */
  now?: () => Date;
  /** Stable canonical local-day zone selected by AnalyticsRuntime. */
  analyticsTimeZone?: string;
}

/** Recompute interval. Trades responsiveness vs disk read frequency; the mtime
 *  fast-path makes idle nearly free. */
const RECOMPUTE_MS = 1000;

/** Delay before the first compute after `start()`. The cold-start critical
 *  path (backend spawn + session restore) gets the CPU first; the strip shows
 *  `ready:false` until the first compute lands. */
const FIRST_TICK_DELAY_MS = 3000;

interface LedgerOverlayCacheEntry {
  records: readonly BillableInvocationRecord[];
  overlay: LedgerUsageOverlay;
  validFromMs: number;
  validUntilMs: number;
}

interface LedgerOverlayCacheState {
  entry: LedgerOverlayCacheEntry | null;
}

export class AggregateStatsService {
  private readonly deps: AggregateStatsServiceDeps;
  private readonly enabled: boolean;
  private cached: AggregateStats = EMPTY_AGGREGATE_STATS;
  private readonly pricing: AggregatePricingCache;
  private readonly completedHistory: CompletedHistoryCache;
  private openAccumulator: AggregateStatsAccumulator | null = null;
  private liveRunIds = new Set<string>();
  private liveRevision = 0;
  private lastFinalizedDate: string | null = null;
  private readonly rollingRate = new RollingAggregateRate();
  /** Only ledger-owned arrays/totals are cached. The surrounding aggregate is
   * rebuilt so live working/time productivity fields never become stale. */
  private readonly ledgerOverlayCache: LedgerOverlayCacheState = { entry: null };
  private timer?: ReturnType<typeof setInterval>;
  private firstTickTimer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private started = false;

  constructor(deps: AggregateStatsServiceDeps) {
    this.deps = deps;
    this.enabled = deps.enabled ?? true;
    this.pricing = new AggregatePricingCache({ getAgentDir: deps.getAgentDir });
    this.completedHistory = new CompletedHistoryCache({
      source: {
        getStorageDir: () => deps.statsService.getStorageDir(),
        queryPersistedRunAnalytics: () => deps.statsService.queryPersistedRunAnalytics(),
      },
      mtimeFn: deps.mtimeFn,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) return;
    // Defer the first compute so the cold-start critical path (backend spawn +
    // session restore) gets the CPU first; the strip shows `ready:false` until
    // the first compute lands. The interval still runs from now, so the first
    // tick is simply the interval's first fire (or the deferred timer, whichever
    // comes first).
    this.firstTickTimer = setTimeout(() => {
      this.firstTickTimer = undefined;
      void this.tick();
    }, FIRST_TICK_DELAY_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, RECOMPUTE_MS);
  }

  dispose(): void {
    if (this.firstTickTimer !== undefined) {
      clearTimeout(this.firstTickTimer);
      this.firstTickTimer = undefined;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The current aggregate (zeros + `ready:false` until the first compute lands). */
  getAggregateStats(): AggregateStats {
    return this.cached;
  }

  /**
   * Refresh mutable open-run analytics from the token-rate service's 200 ms
   * tick. This path is synchronous and bounded by the number of open runs: it
   * never stats/reads history and never polls backend metrics.
   */
  refreshLive(): void {
    if (!this.enabled) return;
    this.liveRevision += 1;
    const archState = this.deps.getArchState();
    const ratesBySession = this.deps.tokenRateService.getRates();
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const openRuns = this.deps.statsService.getOpenRuns();
    const pendingCompletedRuns = this.deps.statsService.getPendingCompletedRuns();
    const rollingRate = this.observeRollingRate(nowMs, openRuns, pendingCompletedRuns, ratesBySession);
    const completedLayer = this.completedHistory.currentLayer();
    if (completedLayer === null || this.lastFinalizedDate === null) return;

    const runningSessionPaths = archState.sessions.runningSessionPaths;
    const openTabCount = archState.sessions.openTabPaths.length;
    const currentDate = localDateString(nowMs);
    if (currentDate !== this.lastFinalizedDate) {
      void this.tick();
      return;
    }

    const pricingCatalog = this.pricing.cached;
    if (!pricingCatalog) return;
    const nextLiveRunIds = liveRunIdSet(openRuns, pendingCompletedRuns);
    // A run that just moved pending → persisted is not in the cached completed
    // layer until the slow mtime refresh lands. Keep the last good aggregate
    // instead of briefly dropping the whole run from every total/chart.
    for (const runId of this.liveRunIds) {
      if (!nextLiveRunIds.has(runId) && !this.completedHistory.completedRunIds.has(runId)) {
        void this.tick();
        return;
      }
    }
    const nextOpenAccumulator = this.buildOpenAccumulator(
      pricingCatalog.map,
      ratesBySession,
      openRuns,
      pendingCompletedRuns,
    );
    this.deps.onAccumulatorBuilt?.('open', openRuns.length + pendingCompletedRuns.length);
    this.openAccumulator = nextOpenAccumulator;
    this.liveRunIds = nextLiveRunIds;

    const next = finalizeAggregateStatsLayers(
      completedLayer,
      nextOpenAccumulator,
      nowMs,
      runningSessionPaths,
      ratesBySession,
      openTabCount,
    );
    next.liveTokensPerSecond = rollingRate;
    next.providerGate = this.cached.providerGate;
    // Preserve the cheap live path: it does not rebuild the ledger projection.
    // The authority getter still runs so its lock/signature/privacy fence is
    // honored; an immutable records identity reuses the small ledger overlay.
    const nextWithLedger = projectLedgerIfAvailable(
      this.deps.statsService,
      next,
      nowMs,
      this.ledgerOverlayCache,
    );
    if (!aggregateStatsEqual(this.cached, nextWithLedger)) {
      this.cached = nextWithLedger;
      this.deps.onChanged();
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.recompute();
    } catch (error) {
      // Transient I/O / parse failures (EACCES, EIO, a coerce throw) must not
      // crash the timer loop or orphan the `inFlight` guard. Retain the last
      // good cached value (assigned only after a successful compute) so the
      // strip keeps showing stale-but-valid data and self-heals next tick.
      appendPieLog('warn', 'aggregate-stats', 'recompute failed; retaining cached stats', {
        error: toErrorMessage(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async recompute(): Promise<void> {
    const liveRevisionAtStart = this.liveRevision;
    const archState = this.deps.getArchState();
    const runningSessionPaths = archState.sessions.runningSessionPaths;
    const openTabCount = archState.sessions.openTabPaths.length;
    const ratesBySession = this.deps.tokenRateService.getRates();
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const currentDate = localDateString(nowMs);
    const openRuns = this.deps.statsService.getOpenRuns();
    // Finalization stages the authoritative closed snapshot synchronously before
    // the open run disappears. Use that snapshot as the persistence bridge so
    // status, outcome, finalizedAt, and day bucketing are never stale.
    const pendingCompletedRuns = this.deps.statsService.getPendingCompletedRuns();
    const rollingRate = this.observeRollingRate(nowMs, openRuns, pendingCompletedRuns, ratesBySession);

    const canonicalReadModel = this.deps.statsService.getAnalyticsReadModel?.();
    if (canonicalReadModel) {
      await this.recomputeCanonical(
        canonicalReadModel,
        nowMs,
        runningSessionPaths,
        openTabCount,
        rollingRate,
        liveRevisionAtStart,
      );
      return;
    }

    const pricing = await this.pricing.load();
    const pendingRunIds = new Set(pendingCompletedRuns.map((run) => run.runId));

    const { rebuilt: completedRebuilt, effectiveCompletedRunCount } =
      await this.completedHistory.refresh(pricing, pendingRunIds);
    if (completedRebuilt) {
      this.deps.onAccumulatorBuilt?.('completed', effectiveCompletedRunCount);
    }

    // Live accumulation is intentionally rebuilt every tick from only the
    // small mutable set plus authoritative finalized snapshots awaiting append.
    // Historical runs are not walked when an open run changes. While a turn is
    // streaming, add its tokenizer estimate; provider-reported usage replaces
    // the estimate as soon as the turn/tool completes.
    const nextOpenAccumulator = this.buildOpenAccumulator(
      pricing.map,
      ratesBySession,
      openRuns,
      pendingCompletedRuns,
    );
    this.deps.onAccumulatorBuilt?.('open', openRuns.length + pendingCompletedRuns.length);
    const openChanged = this.openAccumulator === null
      || !deepEqualValue(this.openAccumulator, nextOpenAccumulator);
    this.openAccumulator = nextOpenAccumulator;
    this.liveRunIds = liveRunIdSet(openRuns, pendingCompletedRuns);

    let providerGate = this.cached.providerGate;
    try {
      providerGate = await this.deps.fetchProviderGateStats();
    } catch (error) {
      appendPieLog('warn', 'aggregate-stats', 'provider_gate.metrics poll failed; retaining cached', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const historicalChanged = completedRebuilt
      || openChanged
      || this.lastFinalizedDate !== currentDate
      || !this.cached.ready;
    let next: AggregateStats;
    if (historicalChanged) {
      const completedLayer = this.completedHistory.ensureLayer(nowMs, {
        force: completedRebuilt,
        onCompletedSourceEntryVisited: this.deps.onCompletedSourceEntryVisited,
      });
      next = finalizeAggregateStatsLayers(
        completedLayer,
        nextOpenAccumulator,
        nowMs,
        runningSessionPaths,
        ratesBySession,
        openTabCount,
      );
      next.liveTokensPerSecond = rollingRate;
      next.providerGate = providerGate;
      this.lastFinalizedDate = currentDate;
    } else {
      // Live-only refresh: preserve every historical array/object reference.
      next = {
        ...this.cached,
        liveTokensPerSecond: rollingRate,
        runningSessionCount: new Set(runningSessionPaths).size,
        openTabCount,
        providerGate,
      };
    }

    // A token-rate tick may have refreshed live inputs while this slow path was
    // awaiting disk/backend metrics. Never overwrite that newer projection
    // with the stale rates/open-run snapshot captured above.
    if (this.liveRevision !== liveRevisionAtStart) {
      this.refreshLive();
      return;
    }
    next = projectLedgerIfAvailable(this.deps.statsService, next, nowMs, this.ledgerOverlayCache);
    if (!aggregateStatsEqual(this.cached, next)) {
      this.cached = next;
      this.deps.onChanged();
    }
  }

  /** Canonical authority has durable provider settlements but no RunSnapshot
   * transcript replay. Use the maintained accounting summary plus bounded SQL
   * provider/model groups; leave run-only fields at their explicit empty values
   * until a canonical run summary projection exists. A truncated group result
   * is rejected so an apparently plausible partial history never reaches UI. */
  private async recomputeCanonical(
    readModel: CanonicalAnalyticsReadModel,
    nowMs: number,
    runningSessionPaths: string[],
    openTabCount: number,
    rollingRate: number,
    liveRevisionAtStart: number,
  ): Promise<void> {
    let providerGate = this.cached.providerGate;
    try {
      // Poll the live gate before the durable read. The aggregate transaction
      // is then the last slow await in this path, so a steady stream of gate
      // updates cannot make every otherwise-consistent snapshot stale.
      providerGate = await this.deps.fetchProviderGateStats();
    } catch (error) {
      appendPieLog('warn', 'aggregate-stats', 'provider_gate.metrics poll failed; retaining cached', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // The revision refresher already performs the bounded cross-host poll.
    // Use its last observed value as a synchronous fence around this read;
    // starting another helper query here both adds latency and can starve
    // publication while peers are committing benign updates.
    const observedRevisionBeforeRead = this.observedCanonicalRevision();
    // Accounting and provider/model groups are read by one bounded recorder
    // transaction. This prevents a provider grouping result from being paired
    // with a newer or older maintained accounting projection.
    const todayStartMs = localCalendarDayStartMs(nowMs, this.deps.analyticsTimeZone ?? 'UTC');
    const dailyWindowStartMs = addLocalCalendarDaysMs(todayStartMs, -6, this.deps.analyticsTimeZone ?? 'UTC');
    const dailyWindowEndMs = addLocalCalendarDaysMs(todayStartMs, 1, this.deps.analyticsTimeZone ?? 'UTC');
    const aggregate = await readModel.readProviderAggregateSummary({
      todayStartMs,
      todayEndMs: nowMs,
      weekStartMs: dailyWindowStartMs,
      weekEndMs: nowMs,
      timeZone: this.deps.analyticsTimeZone,
      dailyWindowStartMs,
      dailyWindowEndMs,
      maxGroups: CANONICAL_AGGREGATE_MAX_GROUP_ROWS,
      maxResultBytes: CANONICAL_AGGREGATE_MAX_RESULT_BYTES,
    });
    if (aggregate.truncation.rowLimit || aggregate.truncation.byteLimit || aggregate.truncation.cellLimit) {
      throw new Error('Canonical aggregate provider grouping exceeded its bounded read limit.');
    }
    const { accounting, groups, executionSummary } = aggregate;
    const overlay = canonicalAccountingOverlay(accounting, groups);
    const sessionCount = groups.length === 0
      ? 0
      : metricInteger(groups[0]?.session_count, 'global session count');
    const runningSessionCount = new Set(runningSessionPaths).size;
    const next = applyLedgerUsageOverlay({
      ...EMPTY_AGGREGATE_STATS,
      runningSessionCount,
      openTabCount,
      liveTokensPerSecond: rollingRate,
      activeGenerationTokensPerSecond: this.cached.activeGenerationTokensPerSecond,
      // Count only maintained root agent-run execution identities. Provider
      // invocations and assistant-turn facets are separate projections.
      runCount: executionSummary.executionCount,
      sessionCount,
      ready: true,
      providerGate: this.cached.providerGate,
    }, overlay);
    next.providerGate = providerGate;
    const observedRevisionAfterRead = this.observedCanonicalRevision();
    const observedRevision = observedRevisionAfterRead ?? observedRevisionBeforeRead;
    if (observedRevision !== null && !canonicalRevisionAtLeast(aggregate.revision, observedRevision)) {
      appendPieLog('debug', 'aggregate-stats', 'canonical aggregate snapshot became stale before publish', {
        snapshotRevision: String(aggregate.revision),
        observedRevision,
      });
      return;
    }
    if (this.liveRevision !== liveRevisionAtStart) {
      // The durable canonical result remains internally consistent even when
      // a 200 ms token-rate tick ran while it was loading. Merge the latest
      // bounded live fields synchronously instead of discarding the historical
      // snapshot (canonical mode has no completed-history layer for
      // refreshLive() to rebuild).
      const latestArchState = this.deps.getArchState();
      next.runningSessionCount = new Set(latestArchState.sessions.runningSessionPaths).size;
      next.openTabCount = latestArchState.sessions.openTabPaths.length;
      next.liveTokensPerSecond = this.rollingRate.getRate();
    }
    if (!aggregateStatsEqual(this.cached, next)) {
      this.cached = next;
      this.deps.onChanged();
    }
  }

  private observedCanonicalRevision(): string | null {
    return this.deps.statsService.getAnalyticsRevisionRefreshStats?.()?.revision ?? null;
  }

  private observeRollingRate(
    nowMs: number,
    openRuns: RunSnapshot[],
    pendingCompletedRuns: RunSnapshot[],
    ratesBySession: Record<string, TokenRateIndicatorState>,
  ): number {
    const byRun = new Map<string, {
      runId: string;
      reportedOutputTokens: number;
      liveOutputTokens?: number;
      terminalOutputTokensEstimate?: number;
      terminal?: boolean;
    }>();
    for (const run of openRuns) {
      const rateState = ratesBySession[run.sessionPath];
      byRun.set(run.runId, {
        runId: run.runId,
        reportedOutputTokens: run.outputTokens,
        liveOutputTokens: rateState?.liveOutputTokens,
        terminalOutputTokensEstimate: rateState?.terminalOutputTokensEstimate,
      });
    }
    // A terminal snapshot is authoritative: the first terminal observation
    // applies RollingAggregateRate's one-time signed settlement correction, so
    // replacing a possibly-larger live estimate can neither double-count nor
    // leave the cumulative rate overstated. The session's terminal estimate
    // rides along so a no-usage burst that completed between sampler ticks is
    // still reconciled into the run's terminal total (the estimate is exposed
    // only for a turn without provider usage, so it cannot double-count the
    // reported output it is added to).
    for (const run of pendingCompletedRuns) {
      const rateState = ratesBySession[run.sessionPath];
      byRun.set(run.runId, {
        runId: run.runId,
        reportedOutputTokens: run.outputTokens,
        terminalOutputTokensEstimate: rateState?.terminalOutputTokensEstimate,
        terminal: true,
      });
    }
    return this.rollingRate.observe(nowMs, [...byRun.values()]);
  }

  private buildOpenAccumulator(
    pricing: Map<string, ModelPricingRecord[]>,
    ratesBySession: Record<string, TokenRateIndicatorState>,
    openRuns: RunSnapshot[],
    pendingCompletedRuns: RunSnapshot[],
  ): AggregateStatsAccumulator {
    const pendingRunIds = new Set(pendingCompletedRuns.map((run) => run.runId));
    const effectiveOpenById = new Map<string, RunSnapshot>();
    for (const run of openRuns) {
      if (this.completedHistory.completedRunIds.has(run.runId) || pendingRunIds.has(run.runId)) continue;
      const liveOutputTokens = ratesBySession[run.sessionPath]?.liveOutputTokens ?? 0;
      effectiveOpenById.set(run.runId, liveOutputTokens > 0
        ? { ...run, outputTokens: run.outputTokens + liveOutputTokens }
        : run);
    }
    // Pending finalized snapshots are authoritative until their append lands,
    // including when a stale snapshot with the same runId is already persisted.
    for (const run of pendingCompletedRuns) effectiveOpenById.set(run.runId, run);
    return accumulateAggregateStats([...effectiveOpenById.values()], pricing);
  }
}

const CANONICAL_AGGREGATE_MAX_GROUP_ROWS = 10_000;
const CANONICAL_AGGREGATE_MAX_RESULT_BYTES = 2 * 1024 * 1024;

function canonicalAccountingOverlay(
  accounting: ProviderAccountingSummary,
  rows: Array<Record<string, unknown>>,
): LedgerUsageOverlay {
  const allByProvider = providerGroups(rows, 'all');
  const todayByProvider = providerGroups(rows, 'today');
  const weekByProvider = providerGroups(rows, 'week');
  const today = groupedTotals(rows, 'today');
  const week = groupedTotals(rows, 'week');
  const all = groupedTotals(rows, 'all');
  const totalCost = metricNumber(accounting.effectiveCostUsd.knownTotal, 'global effective cost');
  const totalInputTokens = metricNumber(accounting.inputTokens.knownTotal, 'global input tokens');
  const totalOutputTokens = metricNumber(accounting.outputTokens.knownTotal, 'global output tokens');
  const totalCacheReadTokens = metricNumber(accounting.cacheReadTokens.knownTotal, 'global cache-read tokens');
  const totalCacheWriteTokens = metricNumber(accounting.cacheWriteTokens.knownTotal, 'global cache-write tokens');
  if (accounting.invocationCount > 0 && rows.length === 0) {
    throw new Error('Canonical accounting has invocations but no provider grouping rows.');
  }
  return {
    todayCost: today.cost,
    todayCostByProvider: todayByProvider,
    todayInputTokens: today.input,
    todayOutputTokens: today.output,
    todayCostSeries: [],
    todayInputTokenSeries: [],
    todayTokenSeries: [],
    todayProductivityInputTokens: today.input,
    weekCost: week.cost,
    weekCostByProvider: weekByProvider,
    weekCostSeries: [],
    weekProductivityInputTokens: week.input,
    dailyCost: [],
    totalCost,
    costByProvider: allByProvider,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    billableAccounting: {
      invocationCount: accounting.invocationCount,
      todayUnknownInvocationCount: today.unknown,
      todayUnpricedInvocationCount: today.unpriced,
      todayInstrumentationGapInvocationCount: today.gap,
      weekUnknownInvocationCount: week.unknown,
      weekUnpricedInvocationCount: week.unpriced,
      weekInstrumentationGapInvocationCount: week.gap,
      unknownInvocationCount: all.unknown,
      unpricedInvocationCount: all.unpriced,
      instrumentationGapInvocationCount: all.gap,
    },
  };
}

function providerGroups(rows: Array<Record<string, unknown>>, prefix: string): AggregateProviderCost[] {
  const grouped = new Map<string, AggregateProviderCost>();
  for (const row of rows) {
    const provider = String(row.provider ?? 'unknown');
    const current = grouped.get(provider) ?? {
      provider,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    current.cost += metricNumber(row[`${prefix}_cost`], `${prefix} provider cost`);
    current.inputTokens += metricNumber(row[`${prefix}_input`], `${prefix} provider input tokens`);
    current.outputTokens += metricNumber(row[`${prefix}_output`], `${prefix} provider output tokens`);
    current.cacheReadTokens += metricNumber(row[`${prefix}_cache_read`], `${prefix} provider cache-read tokens`);
    current.cacheWriteTokens += metricNumber(row[`${prefix}_cache_write`], `${prefix} provider cache-write tokens`);
    grouped.set(provider, current);
  }
  return [...grouped.values()].sort((left, right) => right.cost - left.cost || left.provider.localeCompare(right.provider));
}

function groupedTotals(rows: Array<Record<string, unknown>>, prefix: string): {
  cost: number;
  input: number;
  output: number;
  unknown: number;
  unpriced: number;
  gap: number;
} {
  const total = { cost: 0, input: 0, output: 0, unknown: 0, unpriced: 0, gap: 0 };
  for (const row of rows) {
    total.cost += metricNumber(row[`${prefix}_cost`], `${prefix} cost`);
    total.input += metricNumber(row[`${prefix}_input`], `${prefix} input tokens`);
    total.output += metricNumber(row[`${prefix}_output`], `${prefix} output tokens`);
    total.unknown += metricInteger(row[`${prefix}_unknown`], `${prefix} unknown count`);
    total.unpriced += metricInteger(row[`${prefix}_unpriced`], `${prefix} unpriced count`);
    total.gap += metricInteger(row[`${prefix}_gap`], `${prefix} instrumentation gap count`);
  }
  return total;
}

function metricNumber(value: unknown, name: string): number {
  if (value === null || value === undefined) return 0;
  const result = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(result) || result < 0 || !Number.isSafeInteger(result) && Number.isInteger(result)) {
    throw new Error(`Canonical ${name} is not a finite representable number.`);
  }
  return result;
}

function metricInteger(value: unknown, name: string): number {
  const result = metricNumber(value, name);
  if (!Number.isSafeInteger(result)) throw new Error(`Canonical ${name} exceeds the safe integer range.`);
  return result;
}

function canonicalRevisionAtLeast(left: number | string, right: number | string): boolean {
  try {
    return BigInt(left) >= BigInt(right);
  } catch {
    // The read model validates revisions as decimal strings. Keep a defensive
    // lexical fallback for test doubles that use another representation.
    return String(left) >= String(right);
  }
}


/** Complete structural equality for protocol aggregates and accumulator caches. */
export function aggregateStatsEqual(a: AggregateStats, b: AggregateStats): boolean {
  return deepEqualValue(a, b);
}

function projectLedgerIfAvailable(
  statsService: StatsServicePort,
  aggregate: AggregateStats,
  nowMs: number,
  cache: LedgerOverlayCacheState,
): AggregateStats {
  // Some embedding/test adapters implement a StatsService shape without the
  // invocation-ledger getter. Preserve their legacy projection; production
  // always supplies the ledger. When present, the getter is called on every
  // refresh so its authority lock/signature/privacy fence cannot be bypassed.
  const getter = (statsService as StatsServicePort & {
    getBillableInvocationRecords?: () => ReturnType<StatsServicePort['getBillableInvocationRecords']>;
  }).getBillableInvocationRecords;
  if (!getter) return aggregate;

  const records = getter.call(statsService);
  const cached = cache.entry;
  if (cached
    && cached.records === records
    && nowMs >= cached.validFromMs
    && nowMs < cached.validUntilMs) {
    return applyLedgerUsageOverlay(aggregate, cached.overlay);
  }

  const projection = buildLedgerUsageProjection(records, nowMs);
  cache.entry = {
    records,
    overlay: projection.overlay,
    validFromMs: projection.validFromMs,
    validUntilMs: projection.validUntilMs,
  };
  return applyLedgerUsageOverlay(aggregate, projection.overlay);
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqualValue(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualValue(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) {
    return false;
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)
      || !deepEqualValue(aRecord[key], bRecord[key])) return false;
  }
  return true;
}

function liveRunIdSet(openRuns: RunSnapshot[], pendingCompletedRuns: RunSnapshot[]): Set<string> {
  return new Set([...openRuns, ...pendingCompletedRuns].map((run) => run.runId));
}
