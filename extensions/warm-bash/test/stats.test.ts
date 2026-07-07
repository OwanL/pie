import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WarmBashStats, WarmBashStatsProvider } from '../src/stats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statsUrl = pathToFileURL(path.resolve(__dirname, '../src/stats.ts')).href;

type StatsModule = {
  EMPTY_WARM_BASH_STATS: WarmBashStats;
  registerWarmBashStats: (sessionId: string, provider: WarmBashStatsProvider) => () => void;
  collectWarmBashStats: () => WarmBashStats;
};

async function load(): Promise<StatsModule> {
  return (await import(statsUrl)) as unknown as StatsModule;
}

describe('warm-bash stats aggregation', () => {
  let module: StatsModule;

  test.before(async () => {
    module = await load();
  });

  test('collectWarmBashStats() returns EMPTY_WARM_BASH_STATS when nothing registered', () => {
    assert.deepEqual(module.collectWarmBashStats(), module.EMPTY_WARM_BASH_STATS);
  });

  test('registerWarmBashStats overrides per-session and unregister restores prior value', () => {
    const sessionA = 'session-a';
    const providerA = () => ({
      enabled: true,
      poolSize: 3,
      ready: 2,
      warming: 1,
      fastPathEnabled: true,
      totalFastPath: 10,
      totalWarm: 20,
      totalFallback: 5,
      totalWarmupFailures: 1,
    });

    const unregisterA = module.registerWarmBashStats(sessionA, providerA);
    const collectedA = module.collectWarmBashStats();
    assert.equal(collectedA.enabled, true);
    assert.equal(collectedA.poolSize, 3);
    assert.equal(collectedA.ready, 2);
    assert.equal(collectedA.warming, 1);
    assert.equal(collectedA.fastPathEnabled, true);
    assert.equal(collectedA.totalFastPath, 10);
    assert.equal(collectedA.totalWarm, 20);
    assert.equal(collectedA.totalFallback, 5);
    assert.equal(collectedA.totalWarmupFailures, 1);

    // Override the same session with a different provider.
    const providerA2 = () => ({
      enabled: false,
      poolSize: 1,
      ready: 1,
      warming: 0,
      fastPathEnabled: false,
      totalFastPath: 0,
      totalWarm: 1,
      totalFallback: 0,
      totalWarmupFailures: 0,
    });
    const unregisterA2 = module.registerWarmBashStats(sessionA, providerA2);
    const collectedA2 = module.collectWarmBashStats();
    assert.equal(collectedA2.enabled, false);
    assert.equal(collectedA2.poolSize, 1);
    assert.equal(collectedA2.totalWarm, 1);

    unregisterA2();
    // After overriding registration then unregistering the override, the session
    // should be removed entirely (the registry stores one provider per session).
    assert.deepEqual(module.collectWarmBashStats(), module.EMPTY_WARM_BASH_STATS);

    // Calling the first unregister after the override should be a no-op.
    unregisterA();
    assert.deepEqual(module.collectWarmBashStats(), module.EMPTY_WARM_BASH_STATS);
  });

  test('multiple sessions do not cross-contaminate and aggregate correctly', () => {
    const sessionA = 'multi-a';
    const sessionB = 'multi-b';

    const unregisterA = module.registerWarmBashStats(sessionA, () => ({
      enabled: true,
      poolSize: 2,
      ready: 1,
      warming: 1,
      fastPathEnabled: true,
      totalFastPath: 4,
      totalWarm: 8,
      totalFallback: 2,
      totalWarmupFailures: 0,
    }));

    const unregisterB = module.registerWarmBashStats(sessionB, () => ({
      enabled: false,
      poolSize: 3,
      ready: 2,
      warming: 1,
      fastPathEnabled: false,
      totalFastPath: 1,
      totalWarm: 3,
      totalFallback: 6,
      totalWarmupFailures: 2,
    }));

    const collected = module.collectWarmBashStats();
    // enabled and fastPathEnabled are ORed across sessions.
    assert.equal(collected.enabled, true);
    assert.equal(collected.fastPathEnabled, true);
    // Numeric fields are summed.
    assert.equal(collected.poolSize, 5);
    assert.equal(collected.ready, 3);
    assert.equal(collected.warming, 2);
    assert.equal(collected.totalFastPath, 5);
    assert.equal(collected.totalWarm, 11);
    assert.equal(collected.totalFallback, 8);
    assert.equal(collected.totalWarmupFailures, 2);

    unregisterA();
    const afterA = module.collectWarmBashStats();
    assert.equal(afterA.enabled, false);
    assert.equal(afterA.fastPathEnabled, false);
    assert.equal(afterA.poolSize, 3);
    assert.equal(afterA.ready, 2);
    assert.equal(afterA.totalWarm, 3);

    unregisterB();
    assert.deepEqual(module.collectWarmBashStats(), module.EMPTY_WARM_BASH_STATS);
  });

  test('EMPTY_WARM_BASH_STATS has the exact zeroed shape shown to users', () => {
    assert.deepEqual(module.EMPTY_WARM_BASH_STATS, {
      enabled: false,
      poolSize: 0,
      ready: 0,
      warming: 0,
      fastPathEnabled: false,
      totalFastPath: 0,
      totalWarm: 0,
      totalFallback: 0,
      totalWarmupFailures: 0,
    });
  });
});
