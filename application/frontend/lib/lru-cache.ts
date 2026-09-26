/**
 * Minimal bounded LRU (least-recently-used) cache backed by a `Map`, which
 * iterates in insertion order. A hit is moved to the tail (most-recently-used);
 * on overflow the head (least-recently-used) is evicted.
 *
 * Extracted from `renderMarkdown` so the eviction / refresh logic can be unit-
 * tested in isolation — the markdown path pulls in `marked` + `DOMPurify`,
 * which need a DOM and cannot be reliably spy'd on under tsx (static and
 * dynamic imports of the same package resolve to different module instances).
 *
 * Note: `get` uses `undefined` as the sentinel for "not present", so this cache
 * is intended for value types that never legitimately store `undefined` (the
 * markdown cache stores non-`undefined` HTML strings).
 */
interface LruCacheOptions<K, V> {
  /** Optional total weight bound (for example, estimated retained bytes). */
  maxWeight?: number;
  /** Required when maxWeight is set. Must return a finite non-negative weight. */
  weight?: (key: K, value: V) => number;
}

interface CacheEntry<V> {
  value: V;
  weight: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly weightOf?: (key: K, value: V) => number;
  private totalWeightValue = 0;
  readonly maxSize: number;
  readonly maxWeight?: number;

  constructor(maxSize: number, options: LruCacheOptions<K, V> = {}) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new RangeError(`LruCache maxSize must be a positive finite number (got ${maxSize})`);
    }
    if (options.maxWeight !== undefined && (!Number.isFinite(options.maxWeight) || options.maxWeight < 1)) {
      throw new RangeError(`LruCache maxWeight must be a positive finite number (got ${options.maxWeight})`);
    }
    if (options.maxWeight !== undefined && options.weight === undefined) {
      throw new TypeError('LruCache weight is required when maxWeight is set');
    }
    this.maxSize = maxSize;
    this.maxWeight = options.maxWeight;
    this.weightOf = options.weight;
  }

  get size(): number {
    return this.map.size;
  }

  get totalWeight(): number {
    return this.totalWeightValue;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Returns the cached value and refreshes its recency, or `undefined`. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    // Move to tail (most-recently-used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Inserts/updates an entry, evicting LRU entries until both bounds hold. */
  set(key: K, value: V): void {
    const weight = this.weightOf?.(key, value) ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`LruCache entry weight must be finite and non-negative (got ${weight})`);
    }

    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.map.delete(key);
      this.totalWeightValue -= existing.weight;
    }

    // An entry that cannot fit by itself is deliberately not retained.
    if (this.maxWeight !== undefined && weight > this.maxWeight) return;

    this.map.set(key, { value, weight });
    this.totalWeightValue += weight;
    while (this.map.size > this.maxSize || (this.maxWeight !== undefined && this.totalWeightValue > this.maxWeight)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest !== undefined) this.totalWeightValue -= oldest.weight;
    }
  }

  clear(): void {
    this.map.clear();
    this.totalWeightValue = 0;
  }
}
