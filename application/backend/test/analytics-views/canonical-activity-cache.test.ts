import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalActivityCache,
  type CanonicalActivityReadResult,
} from '../../analytics-views/canonical-activity-cache';
import type {
  CanonicalActivityProjection,
  CanonicalProjectionScope,
  CanonicalToolFacetProjection,
} from '../../analytics-views/types';
import type { AnalyticsQuerySnapshotMetadata } from '../../../../analytics/recording/sqlite-recorder.js';

type ProjectionOptions = {
  scope?: CanonicalProjectionScope;
  scopeKey?: string;
  revision?: string;
  activityKind?: string | null;
  facetId?: string | null;
};

function scopeKey(scope: CanonicalProjectionScope): string {
  return JSON.stringify(scope);
}

function snapshotMetadata(revision: string): AnalyticsQuerySnapshotMetadata {
  return {
    databaseSchemaVersion: 12,
    projectionRevision: revision,
    snapshotWatermark: 1,
    generationIds: ['generation-a'],
    generationIdsTruncated: false,
    pendingDetailCoverage: {
      deliveryHistoryCoverage: 'complete',
      completeDetailWatermark: 1,
      retainedDetailLogicalBytes: 0,
      retainedDetailStoredBytes: 0,
    },
    truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
  };
}

function createResult(options: ProjectionOptions = {}): CanonicalActivityReadResult {
  const scope = options.scope ?? { kind: 'global' };
  const revision = options.revision ?? 'revision-a';
  const metadata = snapshotMetadata(revision);
  const counts = {
    spanCount: 0,
    observedCount: 0,
    estimatedCount: 0,
    unknownCount: 0,
    measuredKnownCount: 0,
    measuredUnknownCount: 0,
    measuredTotalMs: 0,
  };
  const activity: CanonicalActivityProjection | null = options.activityKind === null
    ? null
    : {
      ...metadata,
      revision,
      scope,
      kinds: options.activityKind === undefined ? [] : [{ ...counts, activityKind: options.activityKind }],
      totals: counts,
      truncated: false,
    };
  const toolFacets: CanonicalToolFacetProjection | null = options.facetId === null
    ? null
    : {
      ...metadata,
      revision,
      scope,
      facets: options.facetId === undefined ? [] : [{
        generationId: 'generation-a',
        facetId: options.facetId,
        toolCallId: null,
        rootSessionId: scope.kind === 'session' ? scope.rootSessionId : null,
        commands: null,
        cwd: null,
        observedPaths: null,
        attemptedAddedLines: null,
        attemptedRemovedLines: null,
        verification: null,
      }],
      truncated: false,
    };

  return {
    revision,
    scope,
    scopeKey: options.scopeKey ?? scopeKey(scope),
    activity,
    toolFacets,
  };
}

function sessionScope(rootSessionId: string): CanonicalProjectionScope {
  return { kind: 'session', rootSessionId };
}

test('canonical activity cache isolates global and path entries and scope misses do not touch LRU', () => {
  const cache = new CanonicalActivityCache();
  const global = createResult({ scope: { kind: 'global' }, activityKind: 'global-kind' });
  const pathAScope = sessionScope('root-a');
  const pathBScope = sessionScope('root-b');
  const pathAKey = scopeKey(pathAScope);
  const pathBKey = scopeKey(pathBScope);

  cache.store(undefined, global, 1);
  cache.store('/workspace/a.jsonl', createResult({
    scope: pathAScope,
    activityKind: 'path-a-kind',
  }), 2);
  cache.store('/workspace/b.jsonl', createResult({
    scope: pathBScope,
    activityKind: 'path-b-kind',
  }), 3);

  assert.equal(cache.get(undefined)?.activity.projection?.kinds[0]?.activityKind, 'global-kind');
  assert.equal(cache.get('/workspace/a.jsonl', pathAKey)?.activity.projection?.kinds[0]?.activityKind, 'path-a-kind');
  assert.equal(cache.get('/workspace/b.jsonl', pathBKey)?.activity.projection?.kinds[0]?.activityKind, 'path-b-kind');
  assert.equal(cache.get('/workspace/missing.jsonl', pathAKey), undefined, 'path misses do not fall back to global');

  const lastUsedBeforeMiss = cache.values().map((entry) => entry.lastUsed);
  assert.equal(cache.get('/workspace/a.jsonl', pathBKey), undefined, 'a different root scope is filtered out');
  assert.deepEqual(cache.values().map((entry) => entry.lastUsed), lastUsedBeforeMiss);

  assert.equal(cache.get('/workspace/a.jsonl', pathAKey)?.scopeKey, pathAKey);
  assert.equal(cache.get('/workspace/a.jsonl', 'stale-scope-key'), undefined);
  assert.equal(cache.get('/workspace/a.jsonl', pathAKey)?.activity.projection?.kinds[0]?.activityKind, 'path-a-kind');
  assert.equal(cache.get(undefined)?.activity.projection?.kinds[0]?.activityKind, 'global-kind');
  assert.equal(cache.has('/workspace/a.jsonl'), true);
});

test('canonical activity and tool-facet unknown projections are qualified independently', () => {
  const cache = new CanonicalActivityCache();
  const scope = sessionScope('root-unknown');
  const key = scopeKey(scope);

  cache.store('/workspace/activity-unknown.jsonl', createResult({
    scope,
    activityKind: null,
    facetId: 'known-facet',
  }), 1);
  cache.store('/workspace/facets-unknown.jsonl', createResult({
    scope,
    activityKind: 'known-activity',
    facetId: null,
  }), 2);

  const activityUnknown = cache.get('/workspace/activity-unknown.jsonl', key);
  assert.equal(activityUnknown?.activity.authority, 'unknown');
  assert.equal(activityUnknown?.activity.projection, null);
  assert.equal(activityUnknown?.toolFacets.authority, 'canonical');
  assert.equal(activityUnknown?.toolFacets.projection?.facets[0]?.facetId, 'known-facet');

  const facetsUnknown = cache.get('/workspace/facets-unknown.jsonl', key);
  assert.equal(facetsUnknown?.activity.authority, 'canonical');
  assert.equal(facetsUnknown?.activity.projection?.kinds[0]?.activityKind, 'known-activity');
  assert.equal(facetsUnknown?.toolFacets.authority, 'unknown');
  assert.equal(facetsUnknown?.toolFacets.projection, null);
});

test('global entry shares the 256-entry LRU and a hit protects it from eviction', () => {
  const cache = new CanonicalActivityCache();
  cache.store(undefined, createResult({ activityKind: 'global' }), 1);
  for (let index = 0; index < 255; index += 1) {
    const rootSessionId = `root-${index}`;
    cache.store(`/workspace/${index}.jsonl`, createResult({
      scope: sessionScope(rootSessionId),
    }), index + 2);
  }
  assert.equal(cache.values().length, 256);

  assert.ok(cache.get(undefined), 'touch the oldest global entry');
  cache.store('/workspace/newest.jsonl', createResult({
    scope: sessionScope('root-newest'),
  }), 257);

  assert.equal(cache.values().length, 256);
  assert.equal(cache.get(undefined)?.activity.projection?.kinds[0]?.activityKind, 'global');
  assert.equal(cache.has('/workspace/0.jsonl'), false, 'the untouched least-recent path was evicted');
  assert.equal(cache.has('/workspace/newest.jsonl'), true);
});

test('aggregate serialized-size bound evicts oldest entries across paths', () => {
  const cache = new CanonicalActivityCache();
  const largeKind = 'x'.repeat(600_000);
  for (let index = 0; index < 4; index += 1) {
    const rootSessionId = `large-${index}`;
    cache.store(`/workspace/large-${index}.jsonl`, createResult({
      scope: sessionScope(rootSessionId),
      activityKind: `${index}${largeKind}`,
    }), index);
  }

  assert.equal(cache.has('/workspace/large-0.jsonl'), false);
  assert.equal(cache.has('/workspace/large-1.jsonl'), true);
  assert.equal(cache.has('/workspace/large-2.jsonl'), true);
  assert.equal(cache.has('/workspace/large-3.jsonl'), true);
  assert.equal(cache.values().length, 3);
});

test('replacement subtracts the old entry size and clear resets aggregate byte accounting', () => {
  const cache = new CanonicalActivityCache();
  const mediumKind = 'r'.repeat(550_000);
  const aPath = '/workspace/replacement-a.jsonl';
  const bPath = '/workspace/replacement-b.jsonl';
  const aScope = sessionScope('replacement-a');
  const bScope = sessionScope('replacement-b');

  cache.store(aPath, createResult({ scope: aScope, activityKind: mediumKind }), 1);
  cache.store(bPath, createResult({ scope: bScope, revision: 'before-replacement', activityKind: mediumKind }), 2);
  cache.store(bPath, createResult({ scope: bScope, revision: 'after-replacement' }), 3);
  cache.store('/workspace/replacement-c.jsonl', createResult({
    scope: sessionScope('replacement-c'),
    activityKind: mediumKind,
  }), 4);
  cache.store('/workspace/replacement-d.jsonl', createResult({
    scope: sessionScope('replacement-d'),
    activityKind: mediumKind,
  }), 5);

  assert.equal(cache.has(aPath), true, 'replacing B releases the old serialized bytes');
  assert.equal(cache.get(bPath, scopeKey(bScope))?.revision, 'after-replacement');
  assert.equal(cache.has('/workspace/replacement-c.jsonl'), true);
  assert.equal(cache.has('/workspace/replacement-d.jsonl'), true);

  cache.clear();
  assert.equal(cache.values().length, 0);
  assert.equal(cache.get(aPath, scopeKey(aScope)), undefined);

  const clearKind = 'c'.repeat(650_000);
  for (const name of ['clear-b', 'clear-c', 'clear-d']) {
    cache.store(`/workspace/${name}.jsonl`, createResult({
      scope: sessionScope(name),
      activityKind: clearKind,
    }), 6);
  }
  assert.deepEqual(
    cache.values().map((entry) => entry.activity.scope.kind === 'session'
      ? entry.activity.scope.rootSessionId
      : 'global').sort(),
    ['clear-b', 'clear-c', 'clear-d'],
  );
});

test('oversized canonical result is retained only as unknown projections', () => {
  const cache = new CanonicalActivityCache();
  const scope = sessionScope('oversized');
  const key = scopeKey(scope);
  cache.store('/workspace/oversized.jsonl', createResult({
    scope,
    activityKind: 'o'.repeat(2_200_000),
    facetId: 'facet-would-also-be-discarded',
  }), 1);

  const entry = cache.get('/workspace/oversized.jsonl', key);
  assert.ok(entry);
  assert.equal(entry.activity.authority, 'unknown');
  assert.equal(entry.activity.projection, null);
  assert.equal(entry.toolFacets.authority, 'unknown');
  assert.equal(entry.toolFacets.projection, null);
  assert.deepEqual(entry.activity.scope, scope);
  assert.deepEqual(entry.toolFacets.scope, scope);
});
