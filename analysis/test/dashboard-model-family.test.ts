import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSourceAnalytics } from '../scripts/prepare.ts';
import { buildSiteDataBundle } from '../scripts/site-data.ts';
import { applyFilters, DEFAULT_FILTERS } from '../site/app.ts';
import { deepClone, loadFixture } from './helpers.ts';

async function crossProviderFixture() {
  const fixture = deepClone(await loadFixture());
  const base = fixture.completedRuns[0]!;
  fixture.completedRuns = [
    { ...deepClone(base), runId: 'umans-a', taskGroupId: 'task-a', modelId: 'umans-glm-5.2', status: 'closed' as const, finalizationReason: 'closed' as const },
    { ...deepClone(base), runId: 'ollama-a', taskGroupId: 'task-b', modelId: 'glm-5.2:cloud', status: 'closed' as const, finalizationReason: 'closed' as const },
    { ...deepClone(base), runId: 'gpt-a', taskGroupId: 'task-c', modelId: 'gpt-5.2', status: 'closed' as const, finalizationReason: 'closed' as const },
  ];
  fixture.openRuns = [];
  return fixture;
}

test('model quality and timeline collapse provider ids into canonical families', async () => {
  const prepared = prepareSourceAnalytics(await crossProviderFixture());
  const bundle = buildSiteDataBundle(prepared);
  const glm = bundle.modelQuality.rows.find((row) => row.modelId === 'glm-5.2');
  assert.ok(glm);
  assert.equal(glm.runCount, 2);
  assert.deepEqual(glm.providerModelIds, ['glm-5.2:cloud', 'umans-glm-5.2']);
  assert.ok(!bundle.modelQuality.rows.some((row) => row.modelId === 'umans-glm-5.2'));
  assert.deepEqual(bundle.timeline.rows[0]?.modelMix, { 'glm-5.2': 2, 'gpt-5.2': 1 });
});

test('model filter uses the same canonical family key', async () => {
  const prepared = prepareSourceAnalytics(await crossProviderFixture());
  const filtered = applyFilters(prepared.runs, { ...DEFAULT_FILTERS, modelId: 'glm-5.2' });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((run) => run.modelFamily === 'glm-5.2'));
});
