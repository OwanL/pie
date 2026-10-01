import assert from 'node:assert/strict';
import test from 'node:test';
import { shutdownOwnedStandaloneHost, teardownAfterStandaloneStartupFailure } from '..';

test('standalone synthetic lease release requires explicit complete backend lifetime evidence', async () => {
  for (const confirmed of [true, false, undefined]) {
    for (const startupFailure of [false, true]) {
      const calls: string[] = [];
      const surfaces = {
        runtime: {
          shutdown: async () => { calls.push('runtime'); },
          backend: {
            stop: async () => { calls.push('coordinator-exit'); },
            dispose: () => { calls.push('backend-dispose'); },
            ...(confirmed === undefined ? {} : { isRuntimeLifetimeTeardownConfirmed: () => confirmed === true }),
          },
        },
        browserServer: { stop: async () => { calls.push('browser'); }, dispose: () => undefined },
        ownership: {
          release: async () => { calls.push('ownership-release'); },
          abort: () => { calls.push('ownership-abort'); },
        } as never,
        restoreEnvironment: () => { calls.push('restore'); },
        runtimeLease: { release: async () => { calls.push('lease-release'); } } as never,
      };
      if (startupFailure) {
        const failure = new Error('synthetic startup failure');
        await assert.rejects(teardownAfterStandaloneStartupFailure(surfaces, failure), (error) => error === failure);
      } else {
        await shutdownOwnedStandaloneHost(surfaces);
      }
      assert.equal(calls.includes('lease-release'), confirmed === true,
        `coordinator exit alone cannot release a lease (${confirmed}, startup=${startupFailure})`);
      assert.ok(calls.includes(startupFailure ? 'ownership-abort' : 'ownership-release'));
      assert.ok(calls.includes('restore'));
      if (confirmed === true) {
        assert.ok(calls.indexOf('lease-release') > calls.indexOf('browser'));
        assert.ok(calls.indexOf('lease-release') > calls.indexOf('coordinator-exit'));
      }
    }
  }
  // Flat/caller-owned output has no lease and preserves coordinator ownership
  // handling even when injected lifetime evidence is unavailable.
  await shutdownOwnedStandaloneHost({
    runtime: { shutdown: async () => undefined, backend: { stop: async () => undefined, dispose: () => undefined } },
    browserServer: { stop: async () => undefined, dispose: () => undefined },
    ownership: { release: async () => undefined, abort: () => undefined } as never,
    restoreEnvironment: () => undefined,
  });
});
