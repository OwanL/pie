import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capturedModelFact,
  capturedModelIdentityFacts,
  capturedModelKey,
  capturedModelProvider,
} from '../../usage-accounting/model-identity-facts.js';

test('captured model identity preserves the explicit provider and normalizes its model key', () => {
  assert.deepEqual(capturedModelIdentityFacts('provider/model-v1', 'observed-provider'), {
    modelId: 'provider/model-v1',
    modelKey: 'model-v1',
    provider: 'observed-provider',
  });
  assert.equal(capturedModelProvider('provider/model-v1'), 'provider');
  assert.equal(capturedModelKey('model-v1'), 'model-v1');
  assert.equal(capturedModelIdentityFacts(undefined), undefined);
});

test('captured fact resolution prefers an exact identity before a legacy bare key', () => {
  const facts = new Map([
    ['model-v1', 'legacy'],
    ['provider/model-v1', 'captured'],
  ]);
  assert.deepEqual(capturedModelFact('provider/model-v1', facts), {
    factKey: 'provider/model-v1',
    facts: 'captured',
  });
  assert.deepEqual(capturedModelFact('other/model-v1', facts), {
    factKey: 'model-v1',
    facts: 'legacy',
  });
  assert.equal(capturedModelFact('unknown/model-v2', facts), undefined);
});
