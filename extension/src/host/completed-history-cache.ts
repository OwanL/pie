import * as fsAsync from 'node:fs/promises';
import * as path from 'node:path';

import type { RunAnalyticsQueryResult } from './run-analytics/query';
import { coerceRunSnapshot, type RunSnapshot } from './run-analytics';
import {
  accumulateAggregateStats,
  mergeAccumulatorInto,
  prepareAggregateStatsLayer,
  localDateString,
  type AggregateStatsAccumulator,
  type AggregateStatsLayerInstrumentation,
  type PreparedAggregateStatsLayer,
} from './stats-service/aggregate-stats';
import { appendPieLog } from './util/pie-log';
import { toErrorMessage } from './util/error-message';
import type { PricingCatalog } from './aggregate-pricing-cache';

/** Completed-run history authority consumed by the cache. Structural so the
 *  aggregate strip and tests can supply any compatible run analytics façade. */
export interface CompletedHistorySource {
  getStorageDir(): string;
  queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult>;
}

export type CompletedHistoryMtimeFn = (
  path: string,
  cb: (err: NodeJS.ErrnoException | null, stats: { mtimeMs: number; size?: number }) => void,
) => void;

interface DataSignature {
  /** Mtime of the completed-run JSONL (the only file completed aggregates
   *  depend on). The checkpoint (`open-runs.gen`) is deliberately excluded
   *  so live checkpoint churn never forces a full completed-history reread. */
  snapshotsMtimeMs: number;
  /** Byte size of the completed-run JSONL. Together with the mtime it drives
   *  the incremental append path: a strictly larger size means new lines were
   *  appended (parse only the suffix), while a smaller/equal size with a new
   *  mtime means the file was rewritten (full re-read). */
  snapshotsSize: number;
}

export interface CompletedHistoryRefresh {
  /** True when completed accumulation content changed (data refresh or
   *  pricing/pending-override rebuild) and the layer must be re-prepared. */
  rebuilt: boolean;
  /** Completed runs contributing to the accumulator (pending overrides excluded). */
  effectiveCompletedRunCount: number;
}

/**
 * Owns the completed-run history cache for the aggregate strip: mtime/size
 * signatures over `run-snapshots.jsonl`, suffix-only incremental parsing,
 * per-run accumulators keyed for pending-override and pricing rebuilds, and
 * the prepared completed layer reused by fast open-run refreshes.
 *
 * Unbounded completed-history entries are only visited while preparing a new
 * layer; open-run ticks reuse {@link currentLayer} without touching history.
 */
export class CompletedHistoryCache {
  private readonly source: CompletedHistorySource;
  private readonly mtimeFn?: CompletedHistoryMtimeFn;
  private lastDataSignature: DataSignature | null = null;
  private completedRunsCache: RunSnapshot[] = [];
  private completedRunIdsCache = new Set<string>();
  /** Per-run accumulators keyed by runId, so a pending-override rebuild (or a
   *  re-appended runId) can re-merge the completed layer without re-accumulating
   *  every historical run. Rebuilt wholesale when the pricing signature changes. */
  private runAccumulators: Map<string, AggregateStatsAccumulator> | null = null;
  private runAccumulatorsPricingSignature: string | null = null;
  private completedAccumulator: AggregateStatsAccumulator | null = null;
  private completedAccumulatorKey: string | null = null;
  private completedLayer: PreparedAggregateStatsLayer | null = null;
  private completedLayerKey: string | null = null;

  constructor(deps: { source: CompletedHistorySource; mtimeFn?: CompletedHistoryMtimeFn }) {
    this.source = deps.source;
    this.mtimeFn = deps.mtimeFn;
  }

  /** Run IDs currently held in the completed cache (persisted or cached-pending). */
  get completedRunIds(): ReadonlySet<string> {
    return this.completedRunIdsCache;
  }

  /** The prepared completed layer from the last slow refresh, or null before
   *  the first compute. Fast open-run refreshes reuse this without re-visiting
   *  completed history. */
  currentLayer(): PreparedAggregateStatsLayer | null {
    return this.completedLayer;
  }

  /**
   * Refresh the completed-run cache from disk (full re-read vs suffix-only
   * incremental parse) and rebuild the completed accumulator when its pricing
   * or pending-override key changed. Returns whether accumulation content
   * changed, driving layer re-preparation.
   */
  async refresh(
    pricing: PricingCatalog,
    pendingRunIds: ReadonlySet<string>,
  ): Promise<CompletedHistoryRefresh> {
    const dataSignature = await this.readDataSignature(this.source.getStorageDir());
    let rebuilt = false;
    const completedDataUnchanged = this.lastDataSignature !== null
      && dataSignature !== null
      && signaturesEqual(this.lastDataSignature, dataSignature);
    if (!completedDataUnchanged) {
      rebuilt = await this.refreshCompletedRuns(this.source.getStorageDir(), dataSignature, pricing, pendingRunIds);
      this.lastDataSignature = dataSignature;
    }

    const completedKey = `${pricing.signature}:overrides=${[...pendingRunIds].sort().join(',')}`;
    if (this.completedAccumulator === null || this.completedAccumulatorKey !== completedKey) {
      this.completedAccumulator = this.buildCompletedAccumulatorFromCache(pendingRunIds, pricing);
      this.completedAccumulatorKey = completedKey;
      rebuilt = true;
    }
    const effectiveCompletedRuns = pendingRunIds.size === 0
      ? this.completedRunsCache
      : this.completedRunsCache.filter((run) => !pendingRunIds.has(run.runId));
    return { rebuilt, effectiveCompletedRunCount: effectiveCompletedRuns.length };
  }

  /**
   * Prepare (or reuse) the completed layer for `nowMs`. The layer is rebuilt
   * when `force` is set (accumulator content changed), when it does not exist,
   * or when the accumulator/date key changed; otherwise the cached layer is
   * returned and unbounded completed-history entries are never visited.
   */
  ensureLayer(
    nowMs: number,
    options: { force?: boolean; onCompletedSourceEntryVisited?: AggregateStatsLayerInstrumentation['onCompletedSourceEntryVisited'] } = {},
  ): PreparedAggregateStatsLayer {
    const layerKey = `${this.completedAccumulatorKey ?? 'volatile'}:${localDateString(nowMs)}`;
    if (options.force || this.completedLayer === null || this.completedLayerKey !== layerKey) {
      this.completedLayer = prepareAggregateStatsLayer(this.completedAccumulator!, nowMs, {
        onCompletedSourceEntryVisited: options.onCompletedSourceEntryVisited,
      });
      this.completedLayerKey = layerKey;
    }
    return this.completedLayer;
  }

  /**
   * Refresh the completed-run cache from the JSONL. Full re-read when the
   * file was rewritten (or on first load); suffix-only incremental parse when
   * the file merely grew (the normal append path). Returns true when the
   * completed accumulator content changed.
   */
  private async refreshCompletedRuns(
    storageDir: string,
    dataSignature: DataSignature | null,
    pricing: PricingCatalog,
    pendingRunIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const last = this.lastDataSignature;
    if (last === null || dataSignature === null) {
      return await this.fullReloadCompletedRuns();
    }
    if (dataSignature.snapshotsSize < last.snapshotsSize) {
      // Rewritten (retention prune) — the offset cache is invalid.
      return await this.fullReloadCompletedRuns();
    }
    if (dataSignature.snapshotsSize === last.snapshotsSize) {
      // Same size: unchanged unless the mtime moved (rewrite with same size).
      if (dataSignature.snapshotsMtimeMs === last.snapshotsMtimeMs) return false;
      return await this.fullReloadCompletedRuns();
    }
    // Strictly larger: appended lines only — parse the suffix.
    return await this.incrementalAppendCompletedRuns(storageDir, last.snapshotsSize, pricing, pendingRunIds);
  }
  /** Replace the completed cache from the authoritative query (JSONL + checkpoint merge). */
  private async fullReloadCompletedRuns(): Promise<boolean> {
    const { completedRuns } = await this.source.queryPersistedRunAnalytics();
    this.completedRunsCache = completedRuns;
    this.completedRunIdsCache = new Set(completedRuns.map((run) => run.runId));
    // Per-run accumulators + completed accumulator are rebuilt by the
    // completed-key check in refresh (the null key forces exactly one build).
    this.runAccumulators = null;
    this.runAccumulatorsPricingSignature = null;
    this.completedAccumulator = null;
    this.completedAccumulatorKey = null;
    return true;
  }

  /**
   * Parse only the appended suffix of the completed-run JSONL and fold the new
   * runs into the cache + completed accumulator. A re-appended runId (crash
   * retry / re-finalize) falls back to a full rebuild from the per-run cache
   * so the stale entry is never double-counted.
   */
  private async incrementalAppendCompletedRuns(
    storageDir: string,
    fromOffset: number,
    pricing: PricingCatalog,
    pendingRunIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const newRuns = await this.readAppendedSnapshotLines(storageDir, fromOffset);
    if (newRuns.length === 0) return false;

    const deduped = new Map<string, RunSnapshot>();
    let replaced = false;
    for (const run of newRuns) {
      if (this.completedRunIdsCache.has(run.runId)) replaced = true;
      deduped.set(run.runId, run);
    }
    for (const [runId, run] of deduped) {
      if (this.completedRunIdsCache.has(runId)) {
        const index = this.completedRunsCache.findIndex((entry) => entry.runId === runId);
        if (index >= 0) this.completedRunsCache[index] = run;
      } else {
        this.completedRunsCache.push(run);
        this.completedRunIdsCache.add(runId);
      }
    }

    if (replaced || this.completedAccumulator === null || this.runAccumulators === null) {
      // Refresh the per-run entries for the new/replaced runs, then rebuild so
      // the stale entry is never double-counted.
      this.ensureRunAccumulators(pricing);
      for (const [runId, run] of deduped) {
        this.runAccumulators!.set(runId, accumulateAggregateStats([run], pricing.map));
      }
      this.completedAccumulator = this.buildCompletedAccumulatorFromCache(pendingRunIds, pricing);
      return true;
    }
    // Fast path: cache every newly persisted run, but merge only runs that are
    // no longer represented by an authoritative pending snapshot. Caching a
    // pending run is essential: once the pending bridge clears, the unchanged
    // JSONL signature will not trigger another suffix read.
    for (const [runId, run] of deduped) {
      const runAccumulator = accumulateAggregateStats([run], pricing.map);
      this.runAccumulators.set(runId, runAccumulator);
      if (pendingRunIds.has(runId)) continue;
      mergeAccumulatorInto(this.completedAccumulator, runAccumulator);
    }
    return true;
  }

  /** Read + parse the byte suffix of the completed-run JSONL (append-only). */
  private async readAppendedSnapshotLines(storageDir: string, fromOffset: number): Promise<RunSnapshot[]> {
    const filePath = path.join(storageDir, 'run-snapshots.jsonl');
    let handle: fsAsync.FileHandle | null = null;
    try {
      handle = await fsAsync.open(filePath, 'r');
      const { size } = await handle.stat();
      if (size <= fromOffset) return [];
      const buffer = Buffer.alloc(size - fromOffset);
      await handle.read(buffer, 0, buffer.length, fromOffset);
      return parseSnapshotLines(buffer.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Rebuild the completed accumulator from the per-run cache, excluding any
   *  pending run (its authoritative snapshot lives in the open accumulator). */
  private buildCompletedAccumulatorFromCache(
    pendingRunIds: ReadonlySet<string>,
    pricing: PricingCatalog,
  ): AggregateStatsAccumulator {
    this.ensureRunAccumulators(pricing);
    const target = accumulateAggregateStats([], pricing.map);
    for (const [runId, accumulator] of this.runAccumulators!) {
      if (pendingRunIds.has(runId)) continue;
      mergeAccumulatorInto(target, accumulator);
    }
    return target;
  }

  /** Rebuild the per-run accumulator cache when it is missing or the pricing
   *  signature changed (pricing is applied while accumulating). */
  private ensureRunAccumulators(pricing: PricingCatalog): void {
    if (this.runAccumulators !== null && this.runAccumulatorsPricingSignature === pricing.signature) {
      return;
    }
    this.runAccumulators = new Map();
    for (const run of this.completedRunsCache) {
      this.runAccumulators.set(run.runId, accumulateAggregateStats([run], pricing.map));
    }
    this.runAccumulatorsPricingSignature = pricing.signature;
  }

  /** Mtime + size of the completed-run JSONL. The checkpoint (`open-runs.gen`)
   *  is deliberately excluded so live checkpoint churn never forces a full
   *  completed-history reread. Returns null only if the storage dir itself is
   *  unreadable. */
  private async readDataSignature(storageDir: string): Promise<DataSignature | null> {
    try {
      const snapshotsPath = path.join(storageDir, 'run-snapshots.jsonl');
      const stat = await this.statFile(snapshotsPath);
      // Absent → treat as an empty store with a stable signature (-1) so the
      // fast-path engages (no point re-reading nothing).
      return { snapshotsMtimeMs: stat.mtimeMs, snapshotsSize: stat.size };
    } catch (error) {
      appendPieLog('debug', 'aggregate-stats', 'data signature read failed; retaining cached signature', {
        error: toErrorMessage(error),
      });
      return null;
    }
  }

  /** Resolve an `fs.stat` callback — production uses the module's `mtimeMs`,
   *  tests may override via `mtimeFn`. A missing `size` (legacy mocks)
   *  resolves to -1, which disables the incremental append path. */
  private statFile(path: string): Promise<{ mtimeMs: number; size: number }> {
    const stat = this.mtimeFn ?? ((p, cb) => {
      fsAsync.stat(p).then(
        (stats) => cb(null, { mtimeMs: stats.mtimeMs, size: stats.size }),
        (err) => cb(err as NodeJS.ErrnoException, { mtimeMs: -1, size: -1 }),
      );
    });
    return new Promise((resolve) => {
      stat(path, (err, stats) => {
        if (err) resolve({ mtimeMs: -1, size: -1 });
        else resolve({ mtimeMs: stats.mtimeMs, size: stats.size ?? -1 });
      });
    });
  }
}

function signaturesEqual(a: DataSignature | null, b: DataSignature | null): boolean {
  if (!a || !b) return false;
  return a.snapshotsMtimeMs === b.snapshotsMtimeMs && a.snapshotsSize === b.snapshotsSize;
}

/** Parse a chunk of `run-snapshots.jsonl` into coerced run snapshots, mirroring
 *  `queryRunAnalyticsStore`'s envelope filtering exactly. Malformed lines are
 *  skipped (the retention pass rewrites the file atomically, so a torn line can
 *  only appear mid-append and is retried on the next tick). */
function parseSnapshotLines(text: string): RunSnapshot[] {
  const runs: RunSnapshot[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: unknown; run?: unknown };
      if (parsed.kind !== 'run_snapshot') continue;
      const snapshot = coerceRunSnapshot(parsed.run);
      if (snapshot) runs.push(snapshot);
    } catch {
      // Skip malformed lines; the next tick's signature check self-heals.
    }
  }
  return runs;
}