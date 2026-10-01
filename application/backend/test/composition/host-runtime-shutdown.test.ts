import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRuntime } from '../../composition/host-runtime.js';

test('HostRuntime reports uncertain backend lifetime only after complete teardown', async () => {
  for (const confirmed of [true, false]) {
    const calls: string[] = [];
    // No host/backend/SDK activation or analytics storage: all producers fake.
    const runtime = Object.assign(Object.create(HostRuntime.prototype), {
      startupPromise: null,
      shutdownPromise: null,
      analyticsHandoffControl: {
        stop: async () => { calls.push('handoff-stop'); },
        markStopped: async () => { calls.push('handoff-stopped'); },
      },
      browserServer: { dispose: () => { calls.push('browser'); } },
      effectRunner: { dispose: () => { calls.push('effects'); } },
      tokenRateService: { dispose: () => { calls.push('rates'); } },
      aggregateStatsService: { dispose: () => { calls.push('aggregate'); } },
      statsService: { shutdown: async () => { calls.push('stats'); } },
      backend: {
        stop: async () => { calls.push('coordinator-exit'); },
        dispose: () => { calls.push('backend-dispose'); },
        isRuntimeLifetimeTeardownConfirmed: () => { calls.push('lifetime-evidence'); return confirmed; },
      },
      analyticsTransport: {
        shutdown: async () => { calls.push('transport-stop'); },
        dispose: () => { calls.push('transport-dispose'); },
      },
      analyticsRuntime: { stop: async () => { calls.push('analytics'); } },
      analyticsHandoffRegistry: { close: () => { calls.push('registry'); } },
      service: { dispose: () => { calls.push('service'); } },
    }) as HostRuntime;
    if (confirmed) await runtime.shutdown();
    else await assert.rejects(runtime.shutdown(), /generation lease must be retained/);
    assert.deepEqual(calls, [
      'handoff-stop', 'browser', 'effects', 'rates', 'aggregate', 'stats',
      'coordinator-exit', 'transport-stop', 'backend-dispose', 'analytics',
      'handoff-stopped', 'transport-dispose', 'registry', 'service', 'lifetime-evidence',
    ]);
    if (confirmed) await runtime.shutdown();
    else await assert.rejects(runtime.shutdown(), /generation lease must be retained/);
    assert.equal(calls.filter((call) => call === 'service').length, 1);
  }
});
