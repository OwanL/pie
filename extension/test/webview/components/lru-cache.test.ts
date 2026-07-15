/**
 * Unit tests for the extracted LRU cache used by `renderMarkdown`.
 * Pure (no DOM, no marked/DOMPurify), so the eviction / refresh logic can be
 * exercised precisely — the markdown path itself can't be spy'd under tsx
 * because static and dynamic imports of `marked`/`dompurify` resolve to
 * different module instances.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LruCache } from '../../../src/webview/panel/utils/lru-cache';

test('LruCache get returns undefined for a missing key', () => {
  const cache = new LruCache<string, string>(3);
  assert.equal(cache.get('missing'), undefined);
});

test('LruCache set then get returns the value and reports size/has', () => {
  const cache = new LruCache<string, string>(3);
  cache.set('a', '1');
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.size, 1);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
});

test('LruCache evicts the least-recently-used entry on overflow', () => {
  const cache = new LruCache<string, string>(3);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  cache.set('d', '4'); // over capacity -> evict LRU ('a')
  assert.equal(cache.size, 3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
});

test('LruCache get refreshes recency so a touched entry survives eviction', () => {
  const cache = new LruCache<string, string>(3);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  cache.get('a'); // refresh 'a' -> now most-recently-used
  cache.set('d', '4'); // over capacity -> evict LRU ('b', not 'a')
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
});

test('LruCache set on an existing key updates the value and refreshes recency', () => {
  const cache = new LruCache<string, string>(3);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  cache.set('a', 'updated'); // refresh + update 'a'
  assert.equal(cache.get('a'), 'updated');
  cache.set('d', '4'); // evict LRU ('b')
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
});

test('LruCache clear empties the cache', () => {
  const cache = new LruCache<string, string>(3);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('a'), undefined);
});

test('LruCache maxSize is exposed', () => {
  const cache = new LruCache<string, string>(5);
  assert.equal(cache.maxSize, 5);
});

test('LruCache evicts multiple old entries to remain within a weight budget', () => {
  const cache = new LruCache<string, string>(10, {
    maxWeight: 6,
    weight: (_key, value) => value.length,
  });
  cache.set('a', '12');
  cache.set('b', '345');
  cache.set('c', '678');
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.totalWeight, 6);
});

test('LruCache does not retain an entry larger than its total weight budget', () => {
  const cache = new LruCache<string, string>(10, {
    maxWeight: 3,
    weight: (_key, value) => value.length,
  });
  cache.set('small', '12');
  cache.set('huge', '1234');
  assert.equal(cache.has('small'), true, 'an oversized insertion does not evict useful cached entries');
  assert.equal(cache.has('huge'), false);
  assert.equal(cache.totalWeight, 2);
  cache.clear();
  assert.equal(cache.totalWeight, 0);
});

test('LruCache rejects invalid weight configuration and entry weights', () => {
  assert.throws(() => new LruCache<string, string>(2, { maxWeight: 0, weight: () => 1 }), RangeError);
  assert.throws(() => new LruCache<string, string>(2, { maxWeight: 2 }), TypeError);
  const cache = new LruCache<string, string>(2, { maxWeight: 2, weight: () => Number.NaN });
  assert.throws(() => cache.set('a', '1'), RangeError);
});

test('LruCache rejects a non-positive or non-finite maxSize', () => {
  assert.throws(() => new LruCache<string, string>(0), RangeError);
  assert.throws(() => new LruCache<string, string>(-1), RangeError);
  assert.throws(() => new LruCache<string, string>(Number.NaN), RangeError);
  assert.throws(() => new LruCache<string, string>(Number.POSITIVE_INFINITY), RangeError);
});
