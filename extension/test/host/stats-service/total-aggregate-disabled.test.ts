import assert from 'node:assert/strict';
import test from 'node:test';

import { AggregateStatsService } from '../../../src/host/aggregate-stats-service.js';
import { EMPTY_AGGREGATE_STATS } from '../../../src/shared/protocol/aggregate-stats.js';

test('disabled aggregate never arms timers or calls analytics sources', () => {
  let calls = 0;
  let timeoutCalls = 0;
  let intervalCalls = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const fail = (): never => {
    calls += 1;
    throw new Error('disabled aggregate source was called');
  };
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timeoutCalls += 1;
    return realSetTimeout(...args);
  }) as typeof setTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervalCalls += 1;
    return realSetInterval(...args);
  }) as typeof setInterval;
  try {
    const service = new AggregateStatsService({
      enabled: false,
      getArchState: fail,
      statsService: {
        getStorageDir: fail,
        queryPersistedRunAnalytics: async () => fail(),
        getOpenRuns: fail,
        getPendingCompletedRuns: fail,
        getAnalyticsReadModel: fail,
        getBillableInvocationRecords: fail,
      } as never,
      tokenRateService: { getRates: fail } as never,
      getAgentDir: fail,
      fetchProviderGateStats: async () => fail(),
      onChanged: fail,
    });

    service.start();
    service.start();
    service.refreshLive();
    service.dispose();
    assert.deepEqual(service.getAggregateStats(), EMPTY_AGGREGATE_STATS);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(calls, 0);
  assert.equal(timeoutCalls, 0);
  assert.equal(intervalCalls, 0);
});
