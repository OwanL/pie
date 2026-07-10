import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadModelPricing } from '../backend/pricing';
import type { ModelPricingRecord } from '../../../shared/pricing-core';
import { EMPTY_AGGREGATE_STATS, type AggregateDailyCost, type AggregateDailyRunCount, type AggregateProviderCost, type AggregateProviderThroughput, type AggregateSeriesPoint, type AggregateStats, type ProviderGateStats, type WarmBashStats } from '../shared/protocol/aggregate-stats';
import type { ArchState } from './core/arch-state';
import type { TokenRateService } from './token-rate-service';
import type { StatsService } from './stats-service';
import { computeAggregateStats } from './stats-service/aggregate-stats';
import type { RunSnapshot } from './run-analytics';
import type { TokenRateIndicatorState } from '../shared/token-rate';
import { appendPieLog } from './util/pie-log';
import { toErrorMessage } from './util/error-message';

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
 * A {@link RECOMPUTE_MS} interval recomputes the disk-backed rollup (cost /
 * tokens / throughput). An mtime fast-path stats the JSONL + checkpoint files
 * and skips the full re-read when nothing has been persisted since the last
 * compute AND no session is currently running — so idle cost is ~two `stat`
 * calls per tick rather than re-parsing the whole run history. While sessions
 * are running, every tick recomputes (so live cost ticks up as turns land and
 * the live-tok/s aggregate stays fresh).
 *
 * The live `tokensPerSecond` aggregate (sum of running sessions' rates) is read
 * from `TokenRateService.getRates()` each tick — cheap and always current.
 *
 * Side-effectful (wall-clock + `setInterval` + disk reads) by design — it lives
 * outside the pure reducer, mirroring `TokenRateService`.
 */

export interface AggregateStatsServiceDeps {
  getArchState: () => ArchState;
  statsService: StatsService;
  tokenRateService: TokenRateService;
  /** Resolve the agent dir containing `models.json`. Called each tick so a
   *  runtime `pie.agentDir` change is picked up. Returns null when unresolved. */
  getAgentDir: () => string | null;
  /** Poll live warm-bash pool metrics from the backend (in-memory registry read
   *  via the `warm_bash.stats` RPC). Resolves to {@link EMPTY_WARM_BASH_STATS}
   *  on any failure so the strip hides the segment rather than freezing. */
  fetchWarmBashStats: () => Promise<WarmBashStats>;
  /** Poll live provider-gate concurrency metrics from the backend
   *  (in-memory `ProviderGate` read via the `provider_gate.metrics` RPC).
   *  Resolves to {@link EMPTY_PROVIDER_GATE_STATS} on any failure so the
   *  strip hides the segment rather than freezing. */
  fetchProviderGateStats: () => Promise<ProviderGateStats>;
  /** Called when the posted aggregate changed, so the host can schedule a
   *  debounced snapshot post to the webview. */
  onChanged: () => void;
}

/** Recompute interval. Trades responsiveness vs disk read frequency; the mtime
 *  fast-path makes idle nearly free. */
const RECOMPUTE_MS = 1000;

interface PricingCache {
  mtimeMs: number;
  map: Map<string, ModelPricingRecord[]>;
}

interface DataSignature {
  snapshotsMtimeMs: number;
  checkpointMtimeMs: number;
}

export class AggregateStatsService {
  private readonly deps: AggregateStatsServiceDeps;
  private cached: AggregateStats = EMPTY_AGGREGATE_STATS;
  private pricingCache: PricingCache | null = null;
  private lastDataSignature: DataSignature | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private started = false;

  constructor(deps: AggregateStatsServiceDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Fire one immediate compute so the strip isn't blank until the first tick.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, RECOMPUTE_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The current aggregate (zeros + `ready:false` until the first compute lands). */
  getAggregateStats(): AggregateStats {
    return this.cached;
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
    const archState = this.deps.getArchState();
    const runningSessionPaths = archState.sessions.runningSessionPaths;
    const openTabCount = archState.sessions.openTabPaths.length;
    const ratesBySession = this.deps.tokenRateService.getRates();
    const nowMs = Date.now();

    // Disk-backed rollup. Skip the JSONL+checkpoint re-read when nothing has
    // been persisted since the last compute AND nothing is running (a running
    // session may be mid-turn with un-persisted samples; keep recomputing so
    // live cost ticks up promptly as turns land).
    const storageDir = this.deps.statsService.getStorageDir();
    const signature = await this.readDataSignature(storageDir);
    const dataUnchanged = this.lastDataSignature !== null
      && signature !== null
      && signaturesEqual(this.lastDataSignature, signature)
      && runningSessionPaths.length === 0;

    // Live warm-bash metrics from the backend (in-memory, same-process registry
    // read via RPC). Cheap; polled every tick so ready/warming counts stay
    // current. Failures retain the cached value so a transient RPC hiccup
    // never freezes the segment.
    let warmBash = this.cached.warmBash;
    try {
      warmBash = await this.deps.fetchWarmBashStats();
    } catch (error) {
      appendPieLog('warn', 'aggregate-stats', 'warm_bash.stats poll failed; retaining cached', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Live provider-gate metrics from the backend (in-memory ProviderGate
    // singleton read via RPC). Cheap; polled every tick so active/queued
    // counts + pause state stay current. Failures retain the cached value.
    let providerGate = this.cached.providerGate;
    try {
      providerGate = await this.deps.fetchProviderGateStats();
    } catch (error) {
      appendPieLog('warn', 'aggregate-stats', 'provider_gate.metrics poll failed; retaining cached', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let next: AggregateStats;
    if (dataUnchanged) {
      // Only refresh the live/current fields cheaply from in-memory state.
      next = {
        ...this.cached,
        liveTokensPerSecond: sumLiveRate(runningSessionPaths, ratesBySession),
        runningSessionCount: runningSessionPaths.length,
        openTabCount,
        warmBash,
        providerGate,
      };
    } else {
      const pricingMap = this.loadPricingCached();
      const { completedRuns, openRuns } = await this.deps.statsService.queryRunAnalytics();
      const runs: RunSnapshot[] = completedRuns;
      // Open runs (in-flight) are not yet in the JSONL; include them so the
      // live session's accumulating tokens/cost appear immediately.
      for (const run of openRuns) {
        if (run) runs.push(run);
      }
      next = computeAggregateStats(runs, pricingMap, nowMs, runningSessionPaths, ratesBySession, openTabCount);
      next.warmBash = warmBash;
      next.providerGate = providerGate;
      this.lastDataSignature = signature;
    }

    if (!aggregateEqual(this.cached, next)) {
      this.cached = next;
      this.deps.onChanged();
    } else {
      this.cached = next;
    }
  }

  /** Stats the JSONL + the checkpoint generation marker. The marker
   *  (`open-runs.gen`) is rewritten on EVERY checkpoint write regardless of the
   *  active A/B slot, so its mtime reliably signals an open-runs update (unlike
   *  a hardcoded `open-runs.a.json`, whose mtime freezes once the slot flips to
   *  B). Returns null only if the storage dir itself is unreadable. */
  private async readDataSignature(storageDir: string): Promise<DataSignature | null> {
    try {
      const snapshotsPath = path.join(storageDir, 'run-snapshots.jsonl');
      const genPath = path.join(storageDir, 'open-runs.gen');
      const [snapshotsMtimeMs, checkpointMtimeMs] = await Promise.all([
        mtimeMs(snapshotsPath),
        mtimeMs(genPath),
      ]);
      // Both absent → treat as an empty store with a stable signature so the
      // fast-path engages (no point re-reading nothing).
      return { snapshotsMtimeMs, checkpointMtimeMs };
    } catch (error) {
      appendPieLog('debug', 'aggregate-stats', 'data signature read failed; retaining cached signature', {
        error: toErrorMessage(error),
      });
      return null;
    }
  }

  /** Load + cache the model pricing map by `models.json` mtime (mirror the
   *  subagent-profiles cache pattern). Returns an empty map when the agent
   *  dir or `models.json` is absent. */
  private loadPricingCached(): Map<string, ModelPricingRecord[]> {
    const agentDir = this.deps.getAgentDir();
    if (!agentDir) {
      this.pricingCache = null;
      return new Map();
    }
    const modelsJsonPath = path.join(agentDir, 'models.json');
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(modelsJsonPath).mtimeMs;
    } catch (error) {
      // Missing models.json → no pricing (cost falls back to 0).
      appendPieLog('debug', 'aggregate-stats', 'models.json stat failed; no pricing available', {
        error: toErrorMessage(error),
      });
      this.pricingCache = null;
      return new Map();
    }
    if (this.pricingCache && this.pricingCache.mtimeMs === mtimeMs) {
      return this.pricingCache.map;
    }
    const map = loadModelPricing(modelsJsonPath);
    this.pricingCache = { mtimeMs, map };
    return map;
  }
}

function mtimeMs(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    fs.stat(filePath, (err, stats) => {
      if (err) {
        // Resolve to -1 for "absent" so the signature stays comparable across
        // ticks (a missing file is a stable state, not an error).
        resolve(-1);
        return;
      }
      resolve(stats.mtimeMs);
    });
  });
}

function signaturesEqual(a: DataSignature | null, b: DataSignature | null): boolean {
  if (!a || !b) return false;
  return a.snapshotsMtimeMs === b.snapshotsMtimeMs && a.checkpointMtimeMs === b.checkpointMtimeMs;
}

/** Compact signature for an intraday series so the changed-gate can detect a
 *  new turn (length + last point ms + cumulative total) without a full O(n)
 *  comparison each tick. */
function seriesSignature(s: AggregateSeriesPoint[]): string {
  if (s.length === 0) return '0';
  const last = s[s.length - 1]!;
  const total = last.byProvider.reduce((sum, p) => sum + p.value, 0);
  return `${s.length}:${last.ms}:${total.toFixed(6)}`;
}

/** Compact content signatures for the daily/per-provider tooltip-driving arrays,
 *  so the changed-gate posts when their contents shift even if a derived
 *  headline total happens to be unchanged. */
function dailyCostSig(d: AggregateDailyCost[]): string {
  return d.map((x) => `${x.date}:${x.totalCost.toFixed(6)}`).join(',');
}

function dailyRunCountSig(d: AggregateDailyRunCount[]): string {
  return d.map((x) => `${x.date}:${x.runCount}`).join(',');
}

function providerCostSig(p: AggregateProviderCost[]): string {
  return p.map((x) => `${x.provider}:${x.cost.toFixed(6)}`).join(',');
}

function throughputSig(p: AggregateProviderThroughput[]): string {
  return p.map((x) => `${x.provider}:${x.tokensPerSecond.toFixed(3)}:${x.outputTokens}`).join(',');
}

/** Sum of live tok/s across currently-running sessions, counting ONLY sessions
 *  that are actively generating. A paused session's held rate is excluded so a
 *  long tool call does not inflate the aggregate — the same predicate as the
 *  live-rate loop in {@link computeAggregateStats}. The param is widened to
 *  {@link TokenRateIndicatorState} (from `TokenRateService.getRates()`) so the
 *  `state` field is available to filter on. Exported for unit testing. */
export function sumLiveRate(
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
): number {
  let sum = 0;
  for (const sessionPath of runningSessionPaths) {
    const state = ratesBySession[sessionPath];
    if (
      state
      && state.state === 'generating'
      && typeof state.rate === 'number'
      && Number.isFinite(state.rate)
      && state.rate > 0
    ) {
      sum += state.rate;
    }
  }
  return sum;
}

/**
 * Shallow equality for the "changed?" gate. Compares the fields a user would
 * perceive as different (recent + current + all-time cost/tokens/counts,
 * live rate, per-provider arrays by content). Per-provider arrays are compared
 * by length + first-entry provider/cost (cheap); a genuinely different
 * breakdown triggers a post.
 */
function aggregateEqual(a: AggregateStats, b: AggregateStats): boolean {
  if (a === b) return true;
  if (
    // Recent + current (the headline fields — most likely to change):
    a.todayCost !== b.todayCost
    || a.weekCost !== b.weekCost
    || a.todayTokensPerSecond !== b.todayTokensPerSecond
    || a.tokensPerSecond !== b.tokensPerSecond
    || a.liveTokensPerSecond !== b.liveTokensPerSecond
    || a.todayRunCount !== b.todayRunCount
    || a.weekRunCount !== b.weekRunCount
    || a.runningSessionCount !== b.runningSessionCount
    || a.openTabCount !== b.openTabCount
    // All-time context:
    || a.totalCost !== b.totalCost
    || a.totalInputTokens !== b.totalInputTokens
    || a.totalOutputTokens !== b.totalOutputTokens
    || a.totalCacheReadTokens !== b.totalCacheReadTokens
    || a.totalCacheWriteTokens !== b.totalCacheWriteTokens
    || a.runCount !== b.runCount
    || a.sessionCount !== b.sessionCount
    || a.todayRunCount !== b.todayRunCount
    || a.todayInputTokens !== b.todayInputTokens
    || a.todayOutputTokens !== b.todayOutputTokens
    || a.todayToolCallCount !== b.todayToolCallCount
    || a.todayTouchedFileCount !== b.todayTouchedFileCount
    || a.ready !== b.ready
    // Warm-bash live metrics (ready/warming flaps + exec counters are
    // perceptible changes worth a post).
    || a.warmBash.enabled !== b.warmBash.enabled
    || a.warmBash.poolSize !== b.warmBash.poolSize
    || a.warmBash.ready !== b.warmBash.ready
    || a.warmBash.warming !== b.warmBash.warming
    || a.warmBash.fastPathEnabled !== b.warmBash.fastPathEnabled
    || a.warmBash.totalFastPath !== b.warmBash.totalFastPath
    || a.warmBash.totalWarm !== b.warmBash.totalWarm
    || a.warmBash.totalFallback !== b.warmBash.totalFallback
    || a.warmBash.totalWarmupFailures !== b.warmBash.totalWarmupFailures
    // Provider-gate live metrics (active/queued flaps + pause state changes
    // are perceptible changes worth a post).
    || a.providerGate.enabled !== b.providerGate.enabled
    || a.providerGate.providers.length !== b.providerGate.providers.length
  ) {
    return false;
  }
  // Provider-gate per-provider metrics (active/queued/max + afterburn + pause).
  for (let i = 0; i < a.providerGate.providers.length; i += 1) {
    const x = a.providerGate.providers[i]!;
    const y = b.providerGate.providers[i]!;
    if (
      x.provider !== y.provider
      || x.activeRequests !== y.activeRequests
      || x.queuedRequests !== y.queuedRequests
      || x.maxConcurrentRequests !== y.maxConcurrentRequests
      || x.afterburnSeconds !== y.afterburnSeconds
      || x.queueWaitSeconds !== y.queueWaitSeconds
      || x.paused !== y.paused
      || x.pausedUntilMs !== y.pausedUntilMs
      || x.strikeCount !== y.strikeCount
    ) {
      return false;
    }
  }
  // Per-provider cost lists (today + all-time) by length + first entries.
  if (a.costByProvider.length !== b.costByProvider.length) return false;
  for (let i = 0; i < a.costByProvider.length; i += 1) {
    const x = a.costByProvider[i]!;
    const y = b.costByProvider[i]!;
    if (x.provider !== y.provider || x.cost !== y.cost) return false;
  }
  if (a.todayCostByProvider.length !== b.todayCostByProvider.length) return false;
  for (let i = 0; i < a.todayCostByProvider.length; i += 1) {
    const x = a.todayCostByProvider[i]!;
    const y = b.todayCostByProvider[i]!;
    if (x.provider !== y.provider || x.cost !== y.cost) return false;
  }
  // Intraday series (today cost/tokens/throughput) + daily run count. A
  // zero-cost turn (free model) grows the token/throughput series without
  // moving todayCost, so compare a compact signature (length + last point).
  if (seriesSignature(a.todayCostSeries) !== seriesSignature(b.todayCostSeries)) return false;
  if (seriesSignature(a.todayTokenSeries) !== seriesSignature(b.todayTokenSeries)) return false;
  if (seriesSignature(a.todayThroughputSeries) !== seriesSignature(b.todayThroughputSeries)) return false;
  // Daily series + per-provider breakdowns that drive tooltip graphs. Compare
  // compact content signatures (not just length) so a run landing on an
  // existing day / a per-provider token shift posts even when the headline
  // totals they derive from happen to be unchanged.
  if (dailyCostSig(a.dailyCost) !== dailyCostSig(b.dailyCost)) return false;
  if (dailyRunCountSig(a.dailyRunCount) !== dailyRunCountSig(b.dailyRunCount)) return false;
  if (providerCostSig(a.weekCostByProvider) !== providerCostSig(b.weekCostByProvider)) return false;
  if (throughputSig(a.todayTokensPerSecondByProvider) !== throughputSig(b.todayTokensPerSecondByProvider)) return false;
  if (throughputSig(a.tokensPerSecondByProvider) !== throughputSig(b.tokensPerSecondByProvider)) return false;
  // Last run: compare by identity + cost + endedAt (a different most-recent run
  // is a perceptible change worth a post).
  const la = a.lastRun;
  const lb = b.lastRun;
  if ((la === null) !== (lb === null)) return false;
  if (la && lb) {
    if (la.cost !== lb.cost
      || la.durationMs !== lb.durationMs
      || la.modelId !== lb.modelId
      || la.endedAt !== lb.endedAt
      || la.outcome?.satisfaction !== lb.outcome?.satisfaction
      || la.turnSeries.length !== lb.turnSeries.length) {
      return false;
    }
  }
  return true;
}
