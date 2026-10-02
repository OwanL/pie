import assert from 'node:assert/strict';
import test from 'node:test';

import { resolve } from 'node:path';
import { BackendServer } from '../index.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { ColdSessionLeaseAuthority } from '../../../session-storage/lifecycle/cold-session-store';

const sourceArtifactDescriptor = createSyntheticSourceTestSdkRuntime(resolve('/sdk')).descriptor;

test('BackendServer disposal retires cold leases after later backend generations', async () => {
  const leases = new ColdSessionLeaseAuthority(7);
  const server = new BackendServer({
    sdkPath: '/sdk',
    sourceArtifactDescriptor,
    cwd: '/workspace',
    workerEntryPath: '/worker-entry.js',
    backendGeneration: 7,
  }) as unknown as {
    coldSessionStore: { leases: ColdSessionLeaseAuthority };
    dispose(): Promise<void>;
  };
  server.coldSessionStore = { leases };

  await server.dispose();

  assert.equal(leases.coordinatorGeneration, 8);
});

test('BackendServer disposal keeps hot ownership fences current through runtime teardown', async () => {
  const sessionPath = '/session-hot.jsonl';
  const leases = new ColdSessionLeaseAuthority(7, {
    canonicalPathKey: (value) => value,
    fingerprint: () => 'fixture',
  });
  const [hotFence] = leases.reserveCanonicalPaths(
    [sessionPath],
    'hot:worker-1',
    { hideFromCatalog: false },
  );
  assert.ok(hotFence);
  const order: string[] = [];
  const server = new BackendServer({
    sdkPath: '/sdk',
    sourceArtifactDescriptor,
    cwd: '/workspace',
    workerEntryPath: '/worker-entry.js',
    backendGeneration: 7,
  }) as unknown as {
    coldSessionStore: { leases: ColdSessionLeaseAuthority };
    workerRuntimeRouter: { dispose(): Promise<void> };
    workerSupervisor: { dispose(): Promise<void> };
    dispose(): Promise<void>;
  };
  server.coldSessionStore = { leases };
  server.workerRuntimeRouter = {
    dispose: async () => {
      order.push(`runtime:${leases.coordinatorGeneration}`);
      leases.releaseCanonicalPaths([hotFence]);
    },
  };
  server.workerSupervisor = {
    dispose: async () => {
      order.push(`supervisor:${leases.coordinatorGeneration}`);
    },
  };

  await server.dispose();

  assert.deepEqual(order, ['runtime:7', 'supervisor:7']);
  assert.equal(leases.coordinatorGeneration, 8);
});

test('BackendServer disposal still rejects genuine runtime reconciliation failures', async () => {
  const leases = new ColdSessionLeaseAuthority(7);
  const server = new BackendServer({
    sdkPath: '/sdk',
    sourceArtifactDescriptor,
    cwd: '/workspace',
    workerEntryPath: '/worker-entry.js',
    backendGeneration: 7,
  }) as unknown as {
    coldSessionStore: { leases: ColdSessionLeaseAuthority };
    workerRuntimeRouter: { dispose(): Promise<void> };
    dispose(): Promise<void>;
  };
  server.coldSessionStore = { leases };
  server.workerRuntimeRouter = {
    dispose: async () => {
      throw new Error('genuine ownership reconciliation failure');
    },
  };

  await assert.rejects(server.dispose(), /genuine ownership reconciliation failure/);
  assert.equal(leases.coordinatorGeneration, 8, 'the final cold-work fence still advances after teardown failure');
});
