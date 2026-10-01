import type {
  CanonicalActivityProjection,
  CanonicalActivityProjectionSnapshot,
  CanonicalProjectionScope,
  CanonicalToolFacetProjection,
  CanonicalToolFacetProjectionSnapshot,
} from './types';

const MAX_CANONICAL_ACTIVITY_CACHE_ENTRIES = 256;
const MAX_CANONICAL_ACTIVITY_CACHE_BYTES = 4 * 1024 * 1024;

/** One completed canonical activity/tool-facet read for the global scope or
 * one visible session path. Produced by the bounded `readCanonicalActivityScope`
 * query in StatsService; the cache never issues reads itself. */
export type CanonicalActivityReadResult = {
  revision: string;
  scope: CanonicalProjectionScope;
  scopeKey: string;
  activity: CanonicalActivityProjection | null;
  toolFacets: CanonicalToolFacetProjection | null;
  activityError?: unknown;
  toolFacetsError?: unknown;
};

export type CanonicalActivityCacheEntry = {
  activity: CanonicalActivityProjectionSnapshot;
  toolFacets: CanonicalToolFacetProjectionSnapshot;
  revision: string;
  scopeKey: string;
  epoch: number;
  estimatedBytes: number;
  lastUsed: number;
};

/** Bounded host-side cache for persisted canonical activity/tool-facet
 * projections: one global entry plus per-visible-path session entries, with
 * deterministic serialized-size byte accounting and a shared LRU use counter.
 *
 * The cache stores and evicts only. It holds no authority of its own:
 * scheduling, the revision/epoch acceptance fence, disposal, and privacy-close
 * guards stay with StatsService, which passes the already-accepted read and
 * epoch into {@link CanonicalActivityCache.store}. */
export class CanonicalActivityCache {
  private readonly entriesByPath = new Map<string, CanonicalActivityCacheEntry>();
  private globalEntry: CanonicalActivityCacheEntry | null = null;
  private cacheBytes = 0;
  private useSequence = 0;

  /** Scope-checked lookup for one surface read. `undefined` selects the
   * global entry; a session path must pass `scopeKey` =
   * `JSON.stringify(canonicalProjectionScope(sessionPath))`, and a stored
   * entry from a different root is filtered out. A matching entry has its
   * LRU use counter advanced at lookup time, exactly like the previous
   * caller-side touch. */
  get(
    sessionPath: string | undefined,
    scopeKey?: string,
  ): CanonicalActivityCacheEntry | undefined {
    const entry = sessionPath === undefined
      ? this.globalEntry ?? undefined
      : this.entriesByPath.get(sessionPath);
    if (entry && sessionPath !== undefined && entry.scopeKey !== scopeKey) return undefined;
    if (entry) entry.lastUsed = ++this.useSequence;
    return entry;
  }

  /** Whether a path currently has a stored session entry (regardless of
   * scope), used by refresh bookkeeping to keep in-flight epochs alive. */
  has(sessionPath: string): boolean {
    return this.entriesByPath.has(sessionPath);
  }

  /** Drop every global and session entry and reset the byte accounting. */
  clear(): void {
    this.entriesByPath.clear();
    this.globalEntry = null;
    this.cacheBytes = 0;
  }

  /** Store one accepted read for the global scope (`sessionPath ===
   * undefined`) or one session path, evicting the entry it replaces and then
   * the LRU-oldest entries across both stores until the entry/byte bounds
   * hold. The caller owns the disposal/epoch/private-close acceptance guard.
   * The entry keeps the epoch that accepted it so diagnostics can pair an
   * entry with its refresh generation. */
  store(
    sessionPath: string | undefined,
    result: CanonicalActivityReadResult,
    epoch: number,
  ): void {
    this.remove(sessionPath);
    const activity: CanonicalActivityProjectionSnapshot = {
      authority: result.activity ? 'canonical' : 'unknown',
      scope: result.activity?.scope ?? result.scope,
      projection: result.activity,
    };
    const toolFacets: CanonicalToolFacetProjectionSnapshot = {
      authority: result.toolFacets ? 'canonical' : 'unknown',
      scope: result.toolFacets?.scope ?? result.scope,
      projection: result.toolFacets,
    };
    const entry: CanonicalActivityCacheEntry = {
      activity,
      toolFacets,
      revision: result.revision,
      scopeKey: result.scopeKey,
      epoch,
      estimatedBytes: 0,
      lastUsed: ++this.useSequence,
    };
    entry.estimatedBytes = this.estimateEntryBytes(entry);
    // The helper already caps each result. Keep an additional host-side bound
    // so a malformed/future adapter cannot retain an unbounded object.
    if (entry.estimatedBytes > MAX_CANONICAL_ACTIVITY_CACHE_BYTES) {
      entry.activity = { authority: 'unknown', scope: result.scope, projection: null };
      entry.toolFacets = { authority: 'unknown', scope: result.scope, projection: null };
      entry.estimatedBytes = this.estimateEntryBytes(entry);
    }
    if (sessionPath === undefined) this.globalEntry = entry;
    else this.entriesByPath.set(sessionPath, entry);
    this.cacheBytes += entry.estimatedBytes;

    while (this.entriesByPath.size + (this.globalEntry ? 1 : 0)
      > MAX_CANONICAL_ACTIVITY_CACHE_ENTRIES
      || this.cacheBytes > MAX_CANONICAL_ACTIVITY_CACHE_BYTES) {
      let oldestPath: string | undefined;
      let oldestEntry: CanonicalActivityCacheEntry | null = this.globalEntry;
      if (oldestEntry) oldestPath = undefined;
      for (const [path, candidate] of this.entriesByPath) {
        if (!oldestEntry || candidate.lastUsed < oldestEntry.lastUsed) {
          oldestEntry = candidate;
          oldestPath = path;
        }
      }
      if (!oldestEntry) break;
      this.remove(oldestPath);
    }
  }

  /** Snapshot of the global entry (first, when present) and every session
   * entry in insertion order, for revision reconciliation and diagnostics.
   * Callers must not mutate the returned entries. */
  values(): readonly CanonicalActivityCacheEntry[] {
    return [
      ...(this.globalEntry ? [this.globalEntry] : []),
      ...this.entriesByPath.values(),
    ];
  }

  private remove(sessionPath: string | undefined): void {
    if (sessionPath === undefined) {
      if (!this.globalEntry) return;
      this.cacheBytes = Math.max(0, this.cacheBytes - this.globalEntry.estimatedBytes);
      this.globalEntry = null;
      return;
    }
    const entry = this.entriesByPath.get(sessionPath);
    if (!entry) return;
    this.entriesByPath.delete(sessionPath);
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.estimatedBytes);
  }

  private estimateEntryBytes(entry: CanonicalActivityCacheEntry): number {
    try {
      // This is a deterministic serialized-size proxy used only to bound the
      // host cache; it is not a heap measurement or a qualification claim.
      return JSON.stringify(entry).length * 2;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}