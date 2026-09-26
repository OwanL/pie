export const DEFAULT_COLD_BROWSE_CACHE_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_COLD_BROWSE_CACHE_MAX_ENTRIES = 4;

interface ColdBrowseProjectionCacheEntry<T> {
  readonly key: string;
  readonly sessionPathKey: string;
  readonly value: T;
  readonly sourceBytes: number;
}

export interface ColdBrowseProjectionCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly inflightJoins: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly entries: number;
  readonly inflight: number;
  readonly currentSourceBytes: number;
  readonly maxSourceBytes: number;
  readonly maxEntries: number;
}

/**
 * Process-local weighted LRU for immutable durable browse projections. The
 * production exact-v3 cache lives in the helper; the coordinator retains this
 * class only for correctness fallbacks that cannot be offloaded.
 *
 * `Map` insertion order is the recency list. A newly inserted projection is
 * always retained, even when it alone exceeds the configured budget; all
 * older entries are evicted first. This makes one unusually large current
 * session useful without allowing it to pin additional projections beside it.
 */
export class ColdBrowseProjectionCache<T> {
  private readonly entries = new Map<string, ColdBrowseProjectionCacheEntry<T>>();
  private currentSourceBytes = 0;
  private hits = 0;
  private misses = 0;
  private inflightJoins = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(
    readonly maxSourceBytes = DEFAULT_COLD_BROWSE_CACHE_MAX_SOURCE_BYTES,
    readonly maxEntries = DEFAULT_COLD_BROWSE_CACHE_MAX_ENTRIES,
  ) {
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 0) {
      throw new Error('Cold browse cache byte budget must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Cold browse cache entry budget must be a positive safe integer.');
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  recordMiss(): void {
    this.misses += 1;
  }

  recordInflightJoin(): void {
    this.inflightJoins += 1;
  }

  set(options: {
    key: string;
    sessionPathKey: string;
    value: T;
    sourceBytes: number;
  }): void {
    const sourceBytes = normalizeByteWeight(options.sourceBytes, 'source');
    this.deleteKey(options.key, false);
    const entry: ColdBrowseProjectionCacheEntry<T> = {
      ...options,
      sourceBytes,
    };
    this.entries.set(options.key, entry);
    this.currentSourceBytes += sourceBytes;

    while ((this.currentSourceBytes > this.maxSourceBytes || this.entries.size > this.maxEntries)
      && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.deleteKey(oldestKey, true);
    }
  }

  /** Remove projections made unreachable by a new fingerprint/revision for an
   * exact canonical path. This is eager memory reclamation, not an LRU budget
   * eviction, so it is reported separately. */
  invalidatePath(sessionPathKey: string, exceptKey?: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionPathKey === sessionPathKey && key !== exceptKey) {
        this.deleteKey(key, false);
        this.invalidations += 1;
      }
    }
  }

  clear(): void {
    if (this.entries.size > 0) this.invalidations += this.entries.size;
    this.entries.clear();
    this.currentSourceBytes = 0;
  }

  snapshotStats(inflight: number): ColdBrowseProjectionCacheStats {
    return Object.freeze({
      hits: this.hits,
      misses: this.misses,
      inflightJoins: this.inflightJoins,
      evictions: this.evictions,
      invalidations: this.invalidations,
      entries: this.entries.size,
      inflight,
      currentSourceBytes: this.currentSourceBytes,
      maxSourceBytes: this.maxSourceBytes,
      maxEntries: this.maxEntries,
    });
  }

  private deleteKey(key: string, eviction: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.currentSourceBytes -= entry.sourceBytes;
    if (eviction) this.evictions += 1;
  }
}

function normalizeByteWeight(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Cold browse cache ${label} byte weight must be a non-negative safe integer.`);
  }
  return value;
}
