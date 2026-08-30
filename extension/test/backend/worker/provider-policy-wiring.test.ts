import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderGate } from '../../../src/backend/provider-gate';
import { mergeProviderPolicies, providerPoliciesFromConfigs } from '../../../src/backend/server';

test('isolated provider policy keeps models.json capacity and overlays sparse runtime preferences', () => {
  const configs = ProviderGate.resolveConfigs({
    providers: {
      'github-copilot': {
        concurrency: { maxConcurrentRequests: 2, queueWaitSeconds: 30 },
      },
      ollama: {
        baseUrl: 'http://localhost:11434/v1',
        concurrency: { maxConcurrentRequests: 3, queueWaitSeconds: 20, headerWaitSeconds: 45 },
      },
    },
  });
  const base = providerPoliciesFromConfigs(configs);

  assert.deepEqual(base['github-copilot'], {
    maxConcurrentRequests: 2,
    queueWaitSeconds: 30,
    headerWaitSeconds: 120,
    streamIdleTimeoutSeconds: 120,
    afterburnSeconds: 0,
  });
  assert.deepEqual(base.ollama, {
    maxConcurrentRequests: 3,
    queueWaitSeconds: 20,
    headerWaitSeconds: 45,
    streamIdleTimeoutSeconds: 120,
    afterburnSeconds: 0,
    baseUrl: 'http://localhost:11434/v1',
  });

  assert.deepEqual(mergeProviderPolicies(base, {}), base, 'empty preferences must not restore the authority default of one');
  assert.deepEqual(mergeProviderPolicies(base, {
    'github-copilot': { maxConcurrentRequests: 4 },
  })['github-copilot'], {
    maxConcurrentRequests: 4,
    queueWaitSeconds: 30,
    headerWaitSeconds: 120,
    streamIdleTimeoutSeconds: 120,
    afterburnSeconds: 0,
  });
  assert.equal(
    (mergeProviderPolicies(base, { ollama: { headerWaitSeconds: 0 } }).ollama as { headerWaitSeconds?: number }).headerWaitSeconds,
    45,
    'zero restores the current models.json header default instead of retaining a stale override',
  );
});
