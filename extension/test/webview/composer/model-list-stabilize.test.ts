import test from 'node:test';
import assert from 'node:assert/strict';

import type { ModelInfo } from '../../../src/shared/protocol';
import { pickStableModelList } from '../../../src/webview/panel/utils/model-list-stabilize';

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-a',
    name: 'Model A',
    provider: 'provider-a',
    reasoning: true,
    inputKinds: ['text'],
    ...overrides,
  };
}

test('model-list stabilization adopts same-length catalog when thinking levels change', () => {
  const stable = [model({ thinkingLevels: ['off', 'low'] })];
  const candidate = [model({ thinkingLevels: ['off', 'medium', 'high'] })];

  const selected = pickStableModelList(stable, candidate);

  assert.strictEqual(selected, candidate, 'reasoning capability changes must invalidate the cached catalog');
});

test('model-list stabilization reuses same-length catalog when thinking levels are unchanged', () => {
  const stable = [model({ thinkingLevels: ['off', 'low'] })];
  const candidate = [model({ thinkingLevels: ['off', 'low'] })];

  assert.strictEqual(pickStableModelList(stable, candidate), stable);
});
