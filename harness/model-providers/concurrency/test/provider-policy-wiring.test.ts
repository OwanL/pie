import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderGate } from '../provider-gate.js';
import { resolveProviderMaxConcurrentRequests } from '../provider-concurrency.js';
import { mergeProviderPolicies, providerPoliciesFromConfigs } from '../../../agent-processes/coordinator/server.js';

test('provider max resolver prioritizes saved preferences, catalog defaults, and safety fallback', () => {
  assert.deepEqual(resolveProviderMaxConcurrentRequests(undefined, 3), {
    value: 3,
    source: 'configured-default',
  });
  assert.deepEqual(resolveProviderMaxConcurrentRequests(0, 3), {
    value: 0,
    source: 'saved-preference',
  });
  assert.deepEqual(resolveProviderMaxConcurrentRequests(undefined, undefined), {
    value: 1,
    source: 'safety-fallback',
  });
});

test('Unlimited provider policy survives catalog extraction and sparse preference overlays', () => {
  const configs = ProviderGate.resolveConfigs({
    providers: {
      unlimited: { concurrency: { maxConcurrentRequests: 0, afterburnSeconds: 45 } },
    },
  });
  const base = providerPoliciesFromConfigs(configs);
  assert.equal((base.unlimited as { maxConcurrentRequests?: number }).maxConcurrentRequests, 0);
  assert.equal((base.unlimited as { maxConcurrentRequestsSource?: string }).maxConcurrentRequestsSource, 'configured-default');
  assert.equal((mergeProviderPolicies(base, {}).unlimited as { maxConcurrentRequests?: number }).maxConcurrentRequests, 0);
  assert.equal((mergeProviderPolicies(base, {}).unlimited as { maxConcurrentRequestsSource?: string }).maxConcurrentRequestsSource, 'configured-default');
  const unlimitedOverride = mergeProviderPolicies(base, { unlimited: { maxConcurrentRequests: 0 } }).unlimited as {
    maxConcurrentRequests?: number;
    maxConcurrentRequestsSource?: string;
  };
  assert.equal(unlimitedOverride.maxConcurrentRequests, 0);
  assert.equal(unlimitedOverride.maxConcurrentRequestsSource, 'saved-preference');
  assert.equal(
    (mergeProviderPolicies(base, {}).unlimited as { maxConcurrentRequestsSource?: string }).maxConcurrentRequestsSource,
    'configured-default',
    'clearing preferences restores catalog provenance',
  );
});

test('saved Unlimited override resets to the catalog capacity and provenance when cleared', () => {
  const base = providerPoliciesFromConfigs(ProviderGate.resolveConfigs({
    providers: { finite: { concurrency: { maxConcurrentRequests: 3 } } },
  }));
  const unlimited = mergeProviderPolicies(base, { finite: { maxConcurrentRequests: 0 } }).finite as {
    maxConcurrentRequests?: number;
    maxConcurrentRequestsSource?: string;
  };
  assert.deepEqual(unlimited, {
    ...(base.finite as object),
    maxConcurrentRequests: 0,
    maxConcurrentRequestsSource: 'saved-preference',
  });
  assert.deepEqual(mergeProviderPolicies(base, {}).finite, base.finite);
});

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
    maxConcurrentRequestsSource: 'configured-default',
    queueWaitSeconds: 30,
    headerWaitSeconds: 120,
    streamIdleTimeoutSeconds: 120,
    afterburnSeconds: 0,
  });
  assert.deepEqual(base.ollama, {
    maxConcurrentRequests: 3,
    maxConcurrentRequestsSource: 'configured-default',
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
    maxConcurrentRequestsSource: 'saved-preference',
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
