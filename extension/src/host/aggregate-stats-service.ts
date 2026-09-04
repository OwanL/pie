import { EMPTY_AGGREGATE_STATS, type AggregateStats, type ProviderGateStats } from '../shared/protocol/aggregate-stats';
import type { ArchState } from './core/arch-state';
import type { TokenRateService } from './token-rate-service';
import { RollingAggregateRate } from './rolling-aggregate-rate';
import type { StatsService } from './stats-service';
import {
  accumulateAggregateStats,
  finalizeAggregateStatsLayers,
  localDateString,
  type AggregateStatsAccumulator,
} from './stats-service/aggregate-stats';
import type { RunSnapshot } from './run-analytics';
import type { TokenRateIndicatorState } from '../shared/token-rate';
import type { ModelPricingRecord } from '../../../shared/pricing-core';
import { appendPieLog } from './util/pie-log';
import { toErrorMessage } from './util/error-message';
import { projectLedgerUsageOntoAggregate } from './billable-invocation-ledger/aggregate';
import { AggregatePricingCache } from './aggregate-pricing-cache';
import { CompletedHistoryCache, type CompletedHistoryMtimeFn } from './completed-history-cache';

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
 * active streams without polling disk/backend services at the fast cadence.
 *
 * Side-effectful (wall-clock + `setInterval` + disk reads) by design — it lives
 * outside the pure reducer, mirroring `TokenRateService`.
 */

export interface AggregateStatsServiceDeps {
  getArchState: () => ArchState;
  statsService: StatsService;
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
}

/** Recompute interval. Trades responsiveness vs disk read frequency; the mtime
 *  fast-path makes idle nearly free. */
const RECOMPUTE_MS = 1000;

/** Delay before the first compute after `start()`. The cold-start critical
 *  path (backend spawn + session restore) gets the CPU first; the strip shows
 *  `ready:false` until the first compute lands. */
const FIRST_TICK_DELAY_MS = 3000;

export class AggregateStatsService {
  private readonly deps: AggregateStatsServiceDeps;
  private cached: AggregateStats = EMPTY_AGGREGATE_STATS;
  private readonly pricing: AggregatePricingCache;
  private readonly completedHistory: CompletedHistoryCache;
  private openAccumulator: AggregateStatsAccumulator | null = null;
  private liveRunIds = new Set<string>();
  private liveRevision = 0;
  private lastFinalizedDate: string | null = null;
  private readonly rollingRate = new RollingAggregateRate();
  private timer?: ReturnType<typeof setInterval>;
  private firstTickTimer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private started = false;

  constructor(deps: AggregateStatsServiceDeps) {
    this.deps = deps;
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

    let next = finalizeAggregateStatsLayers(
      completedLayer,
      nextOpenAccumulator,
      nowMs,
      runningSessionPaths,
      ratesBySession,
      openTabCount,
    );
    next.liveTokensPerSecond = rollingRate;
    next.providerGate = this.cached.providerGate;
    next = projectLedgerIfAvailable(this.deps.statsService, next, nowMs);
    if (!aggregateStatsEqual(this.cached, next)) {
      this.cached = next;
      this.deps.onChanged();
    }
  }

  private async tick(): Promise<void> {
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
    next = projectLedgerIfAvailable(this.deps.statsService, next, nowMs);
    if (!aggregateStatsEqual(this.cached, next)) {
      this.cached = next;
      this.deps.onChanged();
    }
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

/** Complete structural equality for protocol aggregates and accumulator caches. */
export function aggregateStatsEqual(a: AggregateStats, b: AggregateStats): boolean {
  return deepEqualValue(a, b);
}

function projectLedgerIfAvailable(statsService: StatsService, aggregate: AggregateStats, nowMs: number): AggregateStats {
  // Some embedding/test adapters implement a StatsService shape without the
  // invocation-ledger getter. Preserve their legacy projection; production
  // always supplies the ledger.
  const getter = (statsService as StatsService & {
    getBillableInvocationRecords?: () => ReturnType<StatsService['getBillableInvocationRecords']>;
  }).getBillableInvocationRecords;
  return getter
    ? projectLedgerUsageOntoAggregate(aggregate, getter.call(statsService), nowMs)
    : aggregate;
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