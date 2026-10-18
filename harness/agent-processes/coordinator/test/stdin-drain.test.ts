import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function serverForDrain() {
  return new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
    sdkPath: '/sdk',
    sourceArtifactDescriptor: createSyntheticSourceTestSdkRuntime(path.resolve('/sdk')).descriptor,
    cwd: '/cwd',
    workerEntryPath: '/worker-entry.js',
  }) as any;
}

test('stdin EOF cancels stalled optional discovery before draining and full disposal', async () => {
  const server = serverForDrain();
  const discovery = deferred<undefined>();
  const order: string[] = [];
  let inventoryDisposed = false;
  server.initialContextEstimateClient = {
    discover: () => inventoryDisposed ? Promise.resolve(undefined) : discovery.promise,
    dispose: async () => {
      inventoryDisposed = true;
      order.push('inventory.dispose');
      discovery.resolve(undefined);
    },
  };
  const acceptedOpen = server.initialContextEstimateClient.discover().then((inventory: unknown) => {
    assert.equal(inventory, undefined, 'cancelled inventory is omitted, not replaced with stale data');
    assert.equal(server.disposed, false, 'full disposal does not abandon the accepted open');
    order.push('open.finished');
  });
  server.inFlightInputRequests.add(acceptedOpen);
  server.workerSupervisor = { dispose: async () => { order.push('workers.dispose'); } };
  await server.drainInputRequestsAndDispose();
  assert.deepEqual(order, ['inventory.dispose', 'open.finished', 'inventory.dispose', 'workers.dispose']);
  assert.equal(server.initialContextEstimateClient, undefined);
  assert.equal(server.disposed, true);
});

for (const setting of ['model', 'reasoning', 'preference']) {
  test(`stdin EOF still drains a slow accepted ${setting} writer before releasing ownership`, async () => {
    const server = serverForDrain();
    const writer = deferred<void>();
    const inventoryStopped = deferred<void>();
    const order: string[] = [];
    server.initialContextEstimateClient = {
      dispose: async () => { inventoryStopped.resolve(); },
    };
    const acceptedWrite = writer.promise.then(() => {
      assert.equal(server.disposed, false);
      order.push('write.committed');
    });
    server.inFlightInputRequests.add(acceptedWrite);
    server.workerSupervisor = { dispose: async () => { order.push('workers.dispose'); } };
    server.coldSessionStore = { leases: { advanceCoordinatorGeneration: () => { order.push('leases.advance'); } } };
    const shutdown = server.drainInputRequestsAndDispose();
    await inventoryStopped.promise;
    await Promise.resolve();
    assert.deepEqual(order, [], 'EOF does not cancel settings or release leases early');
    assert.equal(server.disposed, false);
    writer.resolve();
    await shutdown;
    assert.deepEqual(order, ['write.committed', 'workers.dispose', 'leases.advance']);
  });
}

for (const retrySucceeds of [false, true]) {
  test(`inventory cleanup failure drains accepted writes and stays fail-closed (retry succeeds: ${retrySucceeds})`, async () => {
    const server = serverForDrain();
    const writer = deferred<void>();
    const cleanupAttempted = deferred<void>();
    const failure = new Error('inventory child lifetime unconfirmed');
    const order: string[] = [];
    let attempts = 0;
    const inventoryClient = {
      dispose: async () => {
        attempts += 1;
        cleanupAttempted.resolve();
        if (attempts === 1 || !retrySucceeds) throw failure;
      },
    };
    server.initialContextEstimateClient = inventoryClient;
    server.inFlightInputRequests.add(writer.promise.then(() => { order.push('write.committed'); }));
    server.workerSupervisor = { dispose: async () => { order.push('workers.dispose'); } };
    const shutdown = server.drainInputRequestsAndDispose();
    const rejected = assert.rejects(shutdown, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure, 'early uncertainty is not swallowed by full disposal');
      return true;
    });
    await cleanupAttempted.promise;
    await Promise.resolve();
    assert.equal(server.disposed, false, 'cleanup failure cannot skip the accepted writer drain');
    assert.deepEqual(order, []);
    writer.resolve();
    await rejected;
    assert.deepEqual(order, ['write.committed', 'workers.dispose']);
    assert.equal(attempts, 2, 'full disposal still owns inventory cleanup');
    assert.equal(server.initialContextEstimateClient, retrySucceeds ? undefined : inventoryClient);
  });
}
