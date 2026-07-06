import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest } from '../src/backend/request-handler';
import { collectWarmBashStats } from '../src/backend/warm-bash-stats';
import { EMPTY_WARM_BASH_STATS, type WarmBashStats } from '../src/shared/protocol/aggregate-stats';

const REGISTRY_KEY = Symbol.for('pi.warmBashStatsRegistry');

interface Registry {
  providers: Map<string, () => WarmBashStats>;
}

function getRegistry(): Registry {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { providers: new Map() };
  return g[REGISTRY_KEY]!;
}

function clearRegistry(): void {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: Registry };
  delete g[REGISTRY_KEY];
}

function fakeStats(overrides: Partial<WarmBashStats> = {}): WarmBashStats {
  return { ...EMPTY_WARM_BASH_STATS, enabled: true, poolSize: 2, ready: 2, ...overrides };
}

test('warm_bash.stats RPC returns EMPTY when no session has registered', async () => {
  clearRegistry();
  const result = await handleBackendRequest({} as any, {
    id: 'test-warm-bash-empty',
    method: 'warm_bash.stats',
    params: undefined,
  }) as WarmBashStats;

  assert.deepEqual(result, EMPTY_WARM_BASH_STATS);
  assert.equal(result.enabled, false);
});

test('warm_bash.stats RPC aggregates metrics across registered sessions', async (t) => {
  clearRegistry();
  const reg = getRegistry();
  reg.providers.set('session-a', () => fakeStats({ poolSize: 2, ready: 2, warming: 0, totalWarm: 5, totalFastPath: 3, fastPathEnabled: true }));
  reg.providers.set('session-b', () => fakeStats({ poolSize: 1, ready: 1, warming: 1, totalWarm: 2, totalFallback: 1, fastPathEnabled: false }));
  t.after(() => clearRegistry());

  const result = await handleBackendRequest({} as any, {
    id: 'test-warm-bash-aggregate',
    method: 'warm_bash.stats',
    params: undefined,
  }) as WarmBashStats;

  assert.equal(result.enabled, true);
  assert.equal(result.poolSize, 3); // 2 + 1
  assert.equal(result.ready, 3); // 2 + 1
  assert.equal(result.warming, 1);
  assert.equal(result.fastPathEnabled, true); // session-a had it on
  assert.equal(result.totalWarm, 7); // 5 + 2
  assert.equal(result.totalFastPath, 3);
  assert.equal(result.totalFallback, 1);
});

test('warm_bash.stats RPC is disabled when all registered sessions are disabled', async (t) => {
  clearRegistry();
  const reg = getRegistry();
  reg.providers.set('session-a', () => ({ ...EMPTY_WARM_BASH_STATS, enabled: false }));
  t.after(() => clearRegistry());

  const result = (await handleBackendRequest({} as any, {
    id: 'test-warm-bash-disabled',
    method: 'warm_bash.stats',
    params: undefined,
  })) as WarmBashStats;

  assert.equal(result.enabled, false);
  assert.equal(result.poolSize, 0);
});

test('collectWarmBashStats reads the same Symbol.for registry as the extension', async (t) => {
  clearRegistry();
  const reg = getRegistry();
  reg.providers.set('probe', () => fakeStats({ poolSize: 4, ready: 4, totalWarmupFailures: 2 }));
  t.after(() => clearRegistry());

  const stats = collectWarmBashStats();
  assert.equal(stats.poolSize, 4);
  assert.equal(stats.ready, 4);
  assert.equal(stats.totalWarmupFailures, 2);
});