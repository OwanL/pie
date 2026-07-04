import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadModelPricing } from '../backend/pricing';
import type { ModelPricingRecord } from '../../../shared/pricing-core';
import type { AggregateStats } from '../shared/protocol/aggregate-stats';
import { EMPTY_AGGREGATE_STATS } from '../shared/protocol/aggregate-stats';
import type { ArchState } from './core/arch-state';
import type { TokenRateService } from './token-rate-service';
import type { StatsService } from './stats-service';
import { computeAggregateStats } from './stats-service/aggregate-stats';
import type { RunSnapshot } from './run-analytics';
import { appendPieLog } from './util/pie-log';

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
  /** Called when the posted aggregate changed, so the host can schedule a
   *  debounced snapshot post to the webview. */
  onChanged: () => void;
}

/** Recompute interval. Trades responsiveness vs disk read frequency; the mtime
 *  fast-path makes idle nearly free. */
const RECOMPUTE_MS = 2000;

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
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async recompute(): Promise<void> {
    const archState = this.deps.getArchState();
    const runningSessionPaths = archState.sessions.runningSessionPaths;
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

    let next: AggregateStats;
    if (dataUnchanged) {
      // Only refresh the live fields cheaply from the in-memory rate map.
      next = {
        ...this.cached,
        liveTokensPerSecond: sumLiveRate(runningSessionPaths, ratesBySession),
        runningSessionCount: runningSessionPaths.length,
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
      next = computeAggregateStats(runs, pricingMap, nowMs, runningSessionPaths, ratesBySession);
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
    } catch {
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
    } catch {
      // Missing models.json → no pricing (cost falls back to 0).
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

function sumLiveRate(
  runningSessionPaths: string[],
  ratesBySession: Record<string, { rate?: number }>,
): number {
  let sum = 0;
  for (const sessionPath of runningSessionPaths) {
    const rate = ratesBySession[sessionPath]?.rate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      sum += rate;
    }
  }
  return sum;
}

/**
 * Shallow equality for the "changed?" gate. Compares the fields a user would
 * perceive as different (cost, tokens, counts, live rate, per-provider arrays
 * by content). Per-provider arrays are compared by length + first-entry
 * provider/cost (cheap); a genuinely different breakdown triggers a post.
 */
function aggregateEqual(a: AggregateStats, b: AggregateStats): boolean {
  if (a === b) return true;
  if (
    a.totalCost !== b.totalCost
    || a.todayCost !== b.todayCost
    || a.tokensPerSecond !== b.tokensPerSecond
    || a.liveTokensPerSecond !== b.liveTokensPerSecond
    || a.totalInputTokens !== b.totalInputTokens
    || a.totalOutputTokens !== b.totalOutputTokens
    || a.totalCacheReadTokens !== b.totalCacheReadTokens
    || a.totalCacheWriteTokens !== b.totalCacheWriteTokens
    || a.runCount !== b.runCount
    || a.sessionCount !== b.sessionCount
    || a.runningSessionCount !== b.runningSessionCount
    || a.ready !== b.ready
  ) {
    return false;
  }
  if (a.costByProvider.length !== b.costByProvider.length) return false;
  for (let i = 0; i < a.costByProvider.length; i += 1) {
    const x = a.costByProvider[i]!;
    const y = b.costByProvider[i]!;
    if (x.provider !== y.provider || x.cost !== y.cost) return false;
  }
  return true;
}
