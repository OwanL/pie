import assert from 'node:assert/strict';
import test from 'node:test';

import { resolve } from 'node:path';
import { BackendServer } from '../index.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { ColdSessionLeaseAuthority } from '../../../session-storage/lifecycle/cold-session-store';
import { DurableDetailStore } from '../../../session-storage/transcripts/durable-detail-store';

const sourceArtifactDescriptor = createSyntheticSourceTestSdkRuntime(resolve('/sdk')).descriptor;

test('BackendServer disposal retires cold leases after later backend generations', async () => {
  const leases = new ColdSessionLeaseAuthority(7);
  const server = new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
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
  const server = new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
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

test('BackendServer disposal clears durable detail cache and fences pending resolution', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const emitted: unknown[] = [];
  const store = new DurableDetailStore({
    resolve: async () => {
      await blocked;
      return { value: { text: 'late detail' }, sizeBytes: 23, messageId: 'message', toolCallId: 'tool', kind: 'tool-result' };
    },
    emit: (message) => { emitted.push(message); return true; },
  });
  const server = new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
    sdkPath: '/sdk',
    sourceArtifactDescriptor,
    cwd: '/workspace',
    workerEntryPath: '/worker-entry.js',
  }) as unknown as {
    durableDetailStore: DurableDetailStore;
    dispose(): Promise<void>;
  };
  server.durableDetailStore = store;
  const address = { sessionPath: '/session-pending.jsonl', turnId: 'turn', rootToolCallId: 'tool', rootAttemptId: 'attempt', lineage: [] };
  const pending = store.subscribe('pending', 'pending', address, 4096, { backendGeneration: 1, coordinatorGeneration: 1 });
  assert.deepEqual(store.debugState(), { sources: 0, subscriptions: 1, canonicalBytes: 0 });

  const disposal = server.dispose();
  assert.deepEqual(store.debugState(), { sources: 0, subscriptions: 0, canonicalBytes: 0 });
  release();
  await Promise.all([pending, disposal]);
  assert.deepEqual(store.debugState(), { sources: 0, subscriptions: 0, canonicalBytes: 0 });
  assert.deepEqual(emitted, [], 'late resolver completion cannot publish after disposal');
});

test('BackendServer disposal still rejects genuine runtime reconciliation failures', async () => {
  const leases = new ColdSessionLeaseAuthority(7);
  const server = new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
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
