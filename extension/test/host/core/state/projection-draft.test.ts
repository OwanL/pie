import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import type { CanonicalActivityStats } from '../../../../src/host/stats-service/types';
import {
  projectCanonicalActivityView,
  projectCanonicalActivityViews,
  selectViewState,
} from '../../../../src/host/core/projection';

test('projection: draftText surfaces the active sessions persisted draft', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      activeSessionPath: '/session/a',
    },
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: {
        '/session/a': 'saved draft for a',
        '/session/b': 'saved draft for b',
      },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, 'saved draft for a');
});

test('projection: draftText is empty when no active session', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: { '/session/a': 'saved draft' },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, '');
});

test('projection: draftText falls back to empty string when active session has no draft', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      activeSessionPath: '/session/c',
    },
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: { '/session/a': 'saved draft' },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, '');
});

test('projection: canonical activity view preserves session identity, coverage, and independent truncation', () => {
  const metadata = {
    databaseSchemaVersion: 12,
    projectionRevision: '41',
    snapshotWatermark: '39',
    generationIds: ['generation-a'],
    generationIdsTruncated: false,
    pendingDetailCoverage: {
      deliveryHistoryCoverage: 'complete' as const,
      completeDetailWatermark: '38',
      retainedDetailLogicalBytes: '100',
      retainedDetailStoredBytes: '80',
    },
    truncation: { rowLimit: false, byteLimit: true, cellLimit: false },
  };
  const stats: CanonicalActivityStats = {
    activity: {
      authority: 'canonical',
      scope: { kind: 'session', rootSessionId: 'root-a' },
      projection: {
        ...metadata,
        revision: '41',
        scope: { kind: 'session', rootSessionId: 'root-a' },
        kinds: [{
          activityKind: 'tool',
          spanCount: 2,
          observedCount: 1,
          estimatedCount: 1,
          unknownCount: 0,
          measuredKnownCount: 2,
          measuredUnknownCount: 0,
          measuredTotalMs: 120,
        }],
        totals: {
          spanCount: 2,
          observedCount: 1,
          estimatedCount: 1,
          unknownCount: 0,
          measuredKnownCount: 2,
          measuredUnknownCount: 0,
          measuredTotalMs: 120,
        },
        truncated: true,
      },
    },
    toolFacets: {
      authority: 'canonical',
      scope: { kind: 'session', rootSessionId: 'root-a' },
      projection: {
        ...metadata,
        revision: '41',
        scope: { kind: 'session', rootSessionId: 'root-a' },
        facets: [{
          generationId: 'generation-a',
          facetId: 'facet-a',
          toolCallId: 'tool-a',
          rootSessionId: 'root-a',
          commands: ['git status'],
          cwd: '/workspace',
          observedPaths: ['src/a.ts'],
          attemptedAddedLines: 3,
          attemptedRemovedLines: 0,
          verification: 'unverified',
        }],
        truncated: false,
      },
    },
  };

  const view = projectCanonicalActivityView('/sessions/a.jsonl', stats);

  assert.equal(view.sessionPath, '/sessions/a.jsonl');
  assert.deepEqual(view.scope, { kind: 'session', rootSessionId: 'root-a' });
  assert.equal(view.revision, '41');
  assert.equal(view.activity.projection?.truncated, true);
  assert.equal(view.activity.coverage?.snapshotWatermark, '39');
  assert.equal(view.activity.coverage?.truncation.byteLimit, true);
  assert.equal(view.toolFacets.projection?.facets[0]?.toolCallId, 'tool-a');
  assert.equal(view.toolFacets.projection?.truncated, false);
});

test('projection: suppressed canonical activity stays explicitly unknown instead of empty', () => {
  const stats: CanonicalActivityStats = {
    activity: {
      authority: 'unknown',
      scope: { kind: 'session', rootSessionId: 'root-private' },
      projection: null,
    },
    toolFacets: {
      authority: 'unknown',
      scope: { kind: 'session', rootSessionId: 'root-private' },
      projection: null,
    },
  };

  const view = projectCanonicalActivityView('/sessions/private.jsonl', stats);

  assert.equal(view.sessionPath, '/sessions/private.jsonl');
  assert.equal(view.revision, null);
  assert.equal(view.activity.projection, null);
  assert.equal(view.activity.coverage, null);
  assert.equal(view.activity.truncated, null);
  assert.equal(view.toolFacets.authority, 'unknown');
});

test('projection: canonical host seam omits legacy fields and bounds visible session reads', () => {
  const statsFor = (sessionPath?: string): CanonicalActivityStats => {
    const scope = sessionPath
      ? { kind: 'session' as const, rootSessionId: `root:${sessionPath}` }
      : { kind: 'global' as const };
    return {
      activity: { authority: 'unknown', scope, projection: null },
      toolFacets: { authority: 'unknown', scope, projection: null },
    };
  };
  const canonicalService = {
    getAnalyticsReadModel: () => ({}) as never,
    getAnalyticsRevisionRefreshStats: () => ({ revision: '41' }),
    getCanonicalActivityStats: statsFor,
  };

  const canonical = projectCanonicalActivityViews(canonicalService, ['/a', '/b'], 1);

  assert.deepEqual(Object.keys(canonical).sort(), [
    'canonicalActivityBySession',
    'canonicalActivityBySessionTruncated',
    'canonicalActivityGlobal',
  ]);
  assert.equal(canonical.canonicalActivityBySessionTruncated, true);
  assert.equal(canonical.canonicalActivityGlobal?.scope.kind, 'global');
  assert.equal(canonical.canonicalActivityBySession?.['/a']?.sessionPath, '/a');
  assert.equal(canonical.canonicalActivityBySession?.['/b'], undefined);

  const legacy = projectCanonicalActivityViews({
    getAnalyticsReadModel: () => undefined,
    getAnalyticsRevisionRefreshStats: () => undefined,
    getCanonicalActivityStats: () => { throw new Error('legacy service must not be read'); },
  }, ['/a'], 1);
  assert.deepEqual(legacy, {});
});
