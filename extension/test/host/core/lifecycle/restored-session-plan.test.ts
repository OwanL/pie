import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRestoredSessionPlan, filterRestorableStoredTabs } from '../../../../src/host/core/restored-session-plan';

test('buildRestoredSessionPlan prefers the stored active session when it is still open', () => {
  const plan = buildRestoredSessionPlan(
    ['/workspace/a.jsonl', '/workspace/b.jsonl', '/workspace/c.jsonl'],
    '/workspace/b.jsonl',
  );

  assert.equal(plan.startupPath, '/workspace/b.jsonl');
  assert.deepEqual(plan.preloadPaths, ['/workspace/a.jsonl', '/workspace/c.jsonl']);
});

test('buildRestoredSessionPlan falls back to the first open tab when the stored active session is missing', () => {
  const plan = buildRestoredSessionPlan(
    ['/workspace/a.jsonl', '/workspace/b.jsonl'],
    '/workspace/missing.jsonl',
  );

  assert.equal(plan.startupPath, '/workspace/a.jsonl');
  assert.deepEqual(plan.preloadPaths, ['/workspace/b.jsonl']);
});

test('buildRestoredSessionPlan returns an empty plan when there are no restored tabs', () => {
  const plan = buildRestoredSessionPlan([], '/workspace/a.jsonl');

  assert.equal(plan.startupPath, null);
  assert.deepEqual(plan.preloadPaths, []);
});

test('filterRestorableStoredTabs drops missing restored tabs before startup planning', () => {
  const filtered = filterRestorableStoredTabs(
    [
      { path: '/workspace/a.jsonl', name: 'Keep A' },
      { path: '/workspace/missing.jsonl', name: 'Missing' },
      '__pending__:1',
      'C:\\workspace\\__pending__:2',
      '/workspace/__pending__:3',
      '/workspace/b.jsonl',
      '/workspace/b.jsonl',
    ],
    (sessionPath) => sessionPath !== '/workspace/missing.jsonl',
  );

  assert.deepEqual(filtered.openTabPaths, ['/workspace/a.jsonl', '/workspace/b.jsonl']);
  assert.deepEqual(filtered.droppedPaths, ['/workspace/missing.jsonl']);
  assert.deepEqual(filtered.rawTabs, [
    { path: '/workspace/a.jsonl', name: 'Keep A' },
    '/workspace/b.jsonl',
  ]);
});
