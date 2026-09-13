import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSignedAnalyticsHandoffResponse } from '../../../shared/analytics/handoff.js';
import {
  SessionLifecycleStore,
  type AnalyticsHostRecord,
} from '../../src/backend/session-lifecycle-store.js';
import {
  createProductionAnalyticsHostAdapters,
} from '../../src/host/analytics-production-adapters.js';
import type { ProcessOwnerReadResult, RuntimeGenerationIdentity } from '../../src/host/analytics-handoff-discovery.js';

const runtimeIdentity: RuntimeGenerationIdentity = {
  publisher: 'production-publisher',
  name: 'pie',
  version: '1.0.0',
};

function createHost(store: SessionLifecycleStore): AnalyticsHostRecord {
  return store.registerAnalyticsHost({
    hostInstanceId: 'production-host',
    workspaceId: 'production-workspace',
    generationId: 'host-process-generation',
    buildId: 'production-build',
    processId: 901,
    endpointName: 'production-endpoint',
    capabilities: ['authenticated-control', 'writer-fence'],
    registeredAtMs: '10',
  });
}

function processOwners(): ProcessOwnerReadResult {
  return {
    processes: [
      { processId: 901, processCreatedAtMs: 1_000 },
      { processId: 902, processCreatedAtMs: 1_100 },
    ],
    backendOwners: [{
      backendProcessId: 902,
      hostProcessId: 901,
      backendCreatedAtMs: 1_100,
      hostCreatedAtMs: 1_000,
      backendGeneration: 1,
      analyticsGenerationId: 'analytics-generation',
      analyticsHostInstanceId: 'production-host',
    }],
    complete: true,
    reasons: [],
  };
}

test('production adapters reconcile OS/process evidence and authenticated host status', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-production-adapters-'));
  const store = new SessionLifecycleStore(path.join(root, 'lifecycle.sqlite'));
  const registered = createHost(store);
  const key = 'production-key-'.repeat(8);
  try {
    const adapters = createProductionAnalyticsHostAdapters({
      workspaceId: registered.workspaceId,
      registry: store,
      runtimeRootPath: path.join(root, 'runtime'),
      runtimeIdentity,
      analyticsGenerationId: 'analytics-generation',
      keyForHost: () => key,
      now: () => 2_000,
      readRuntimeLeases: async () => ({
        leases: [{
          leaseFileName: `${'a'.repeat(64)}-901-${'0'.repeat(32)}.json`,
          runtimeGeneration: 'a'.repeat(64),
          processId: 901,
          leaseCreatedAtMs: 1_500,
          identity: runtimeIdentity,
        }],
        complete: true,
        reasons: [],
      }),
      readProcessOwners: async () => processOwners(),
      send: async (_endpoint, request) => createSignedAnalyticsHandoffResponse(
        (request as { requestId: string }).requestId,
        key,
        {
          ok: true,
          result: {
            host: {
              ...registered,
              registeredAtMs: registered.registeredAtMs,
              heartbeatAtMs: registered.heartbeatAtMs,
              updatedAtMs: registered.updatedAtMs,
            },
            hosts: [{
              ...registered,
              registeredAtMs: registered.registeredAtMs,
              heartbeatAtMs: registered.heartbeatAtMs,
              updatedAtMs: registered.updatedAtMs,
            }],
            truncated: false,
            inventoryProof: {
              kind: 'registered-hosts-only',
              complete: false,
              reason: 'runtime-generation-and-process-reconciliation-unwired',
            },
            allHostsHandoffAvailable: false,
          },
        },
      ),
    });
    const result = await adapters.discover();
    assert.equal(result.complete, true);
    assert.equal(result.authenticatedHostsComplete, true);
    assert.deepEqual(result.hosts.map(({ hostInstanceId, status }) => ({ hostInstanceId, status })), [
      { hostInstanceId: 'production-host', status: 'reconciled' },
    ]);
    assert.equal(store.listAnalyticsHosts(registered.workspaceId).hosts.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const ownersWithoutDescriptor = (): ProcessOwnerReadResult => ({
  processes: [
    { processId: 901, processCreatedAtMs: 1_000 },
    { processId: 902, processCreatedAtMs: 1_100 },
  ],
  backendOwners: [{
    backendProcessId: 902,
    hostProcessId: 901,
    backendCreatedAtMs: 1_100,
    hostCreatedAtMs: 1_000,
    backendGeneration: 1,
  }],
  complete: true,
  reasons: [],
});

test('production adapters allow an absent analytics descriptor only for first-ever activation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-production-adapters-'));
  const store = new SessionLifecycleStore(path.join(root, 'lifecycle.sqlite'));
  const registered = createHost(store);
  const key = 'production-key-'.repeat(8);
  try {
    const adapters = createProductionAnalyticsHostAdapters({
      workspaceId: registered.workspaceId,
      registry: store,
      runtimeRootPath: path.join(root, 'runtime'),
      runtimeIdentity,
      allowAbsentAnalyticsDescriptor: true,
      keyForHost: () => key,
      now: () => 2_000,
      readRuntimeLeases: async () => ({
        leases: [{
          leaseFileName: `${'a'.repeat(64)}-901-${'0'.repeat(32)}.json`,
          runtimeGeneration: 'a'.repeat(64),
          processId: 901,
          leaseCreatedAtMs: 1_500,
          identity: runtimeIdentity,
        }],
        complete: true,
        reasons: [],
      }),
      readProcessOwners: async () => ownersWithoutDescriptor(),
      send: async (_endpoint, request) => createSignedAnalyticsHandoffResponse(
        (request as { requestId: string }).requestId,
        key,
        {
          ok: true,
          result: {
            host: { ...registered },
            hosts: [{ ...registered }],
            truncated: false,
            inventoryProof: {
              kind: 'registered-hosts-only',
              complete: false,
              reason: 'runtime-generation-and-process-reconciliation-unwired',
            },
            allHostsHandoffAvailable: false,
          },
        },
      ),
    });
    const result = await adapters.discover();
    assert.equal(result.complete, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production adapters keep a present descriptor unreconcilable without a bound generation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-production-adapters-'));
  const store = new SessionLifecycleStore(path.join(root, 'lifecycle.sqlite'));
  const registered = createHost(store);
  const key = 'production-key-'.repeat(8);
  try {
    const adapters = createProductionAnalyticsHostAdapters({
      workspaceId: registered.workspaceId,
      registry: store,
      runtimeRootPath: path.join(root, 'runtime'),
      runtimeIdentity,
      allowAbsentAnalyticsDescriptor: true,
      keyForHost: () => key,
      now: () => 2_000,
      readRuntimeLeases: async () => ({
        leases: [{
          leaseFileName: `${'a'.repeat(64)}-901-${'0'.repeat(32)}.json`,
          runtimeGeneration: 'a'.repeat(64),
          processId: 901,
          leaseCreatedAtMs: 1_500,
          identity: runtimeIdentity,
        }],
        complete: true,
        reasons: [],
      }),
      readProcessOwners: async () => processOwners(),
      send: async (_endpoint, request) => createSignedAnalyticsHandoffResponse(
        (request as { requestId: string }).requestId,
        key,
        {
          ok: true,
          result: {
            host: { ...registered },
            hosts: [{ ...registered }],
            truncated: false,
            inventoryProof: {
              kind: 'registered-hosts-only',
              complete: false,
              reason: 'runtime-generation-and-process-reconciliation-unwired',
            },
            allHostsHandoffAvailable: false,
          },
        },
      ),
    });
    const result = await adapters.discover();
    assert.equal(result.complete, false);
    assert.ok(result.reasons.some((entry) => entry.code === 'backend-analytics-generation-unavailable'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production adapters retain missing authentication as a readiness blocker', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-production-adapters-missing-key-'));
  const store = new SessionLifecycleStore(path.join(root, 'lifecycle.sqlite'));
  const registered = createHost(store);
  try {
    const adapters = createProductionAnalyticsHostAdapters({
      workspaceId: registered.workspaceId,
      registry: store,
      runtimeRootPath: path.join(root, 'runtime'),
      runtimeIdentity,
      analyticsGenerationId: 'analytics-generation',
      keyForHost: () => undefined,
      readRuntimeLeases: async () => ({ leases: [], complete: true, reasons: [] }),
      readProcessOwners: async () => ({
        ...processOwners(),
        processes: processOwners().processes,
      }),
    });
    const result = await adapters.discover();
    assert.equal(result.complete, false);
    assert.equal(result.authenticatedHostsComplete, false);
    assert.ok(result.hosts[0]?.reasons.some(({ code }) => code === 'host-authentication-key-missing'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
