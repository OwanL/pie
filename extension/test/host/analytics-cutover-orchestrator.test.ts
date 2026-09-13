import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActivationStore } from '../../src/analytics/activation-store.js';
import { activateGeneration } from '../../src/analytics/activation-sequence.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
  type StorageCutoffWriterFenceReceipt,
} from '../../src/backend/storage-cutoff.js';
import { SessionFilesystemMutationBarrier, SessionLifecycleCleaner } from '../../src/backend/session-filesystem-lifecycle.js';
import { SessionLifecycleStore, type AnalyticsWriterIdentity } from '../../src/backend/session-lifecycle-store.js';
import {
  ANALYTICS_CUTOVER_JOURNAL_FILENAME,
  AnalyticsCutoverOrchestrator,
  analyticsCutoverInventorySha256,
  type AnalyticsCutoverAuthorization,
  type AnalyticsCutoverOptions,
  type AnalyticsCutoverRuntime,
} from '../../src/host/analytics-cutover-orchestrator.js';
import {
  AnalyticsAllHostHandoffCoordinator,
  createSignedAnalyticsWriterFenceAcknowledgement,
  createSignedAnalyticsWriterFenceError,
  verifyAnalyticsWriterFenceRequest,
  type AnalyticsAllHostHandoffReceipt,
  type AnalyticsAllHostFenceParticipant,
} from '../../src/host/analytics-all-host-handoff.js';
import type { AnalyticsHostDiscoveryResult } from '../../src/host/analytics-handoff-discovery.js';

const NOW = 1_800_000_000_000;
const ACTIVATED_AT = '2027-01-15T08:00:00.000Z';
const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const QUALIFICATION_SHA = 'a'.repeat(64);
const TRIAL_SHA = 'b'.repeat(64);
const TERMINAL_EVIDENCE_SHA = 'c'.repeat(64);
const COMMIT_SHA = 'd'.repeat(40);
const WORKSPACE_ID = 'workspace-cutover-test';

function authorizeStorageCutoff(): () => void {
  const previous = process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  return () => {
    if (previous === undefined) delete process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
    else process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = previous;
  };
}

function activationRequest() {
  return {
    generationId: GENERATION_ID,
    buildId: 'build-cutover-test',
    qualificationSha256: QUALIFICATION_SHA,
    trialSha256: TRIAL_SHA,
    activatedAt: ACTIVATED_AT,
    cutoffReceiptSha256: null,
  } as const;
}

function prerequisites() {
  return {
    p0: {
      status: 'qualified' as const,
      commitSha: COMMIT_SHA,
      qualificationSha256: QUALIFICATION_SHA,
      trialSha256: TRIAL_SHA,
    },
    p7a: {
      analyticsReady: true as const,
      privacyDeleteReady: true as const,
      queryReady: true as const,
      selectedDesignQualified: true as const,
    },
    p7b: {
      lifecycleOwnerReady: true as const,
      legacyScrubBoundaryReady: true as const,
      rootSwitchReady: true as const,
      expiryInPlaceReady: true as const,
    },
    terminalHandoff: {
      status: 'ready' as const,
      evidenceSha256: TERMINAL_EVIDENCE_SHA,
    },
  };
}

function authorization(): AnalyticsCutoverAuthorization {
  return {
    schemaVersion: 1,
    plan: 'analytics-rework-plan-17',
    approved: true,
    commitSha: COMMIT_SHA,
  };
}

function activationFence(operationId: string): AnalyticsAllHostHandoffReceipt {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    operationId,
    purpose: 'analytics-activation',
    fenceEpoch: 1,
    status: 'fenced',
    hostInstanceIds: ['host-old'],
    acknowledgedHostInstanceIds: ['host-old'],
  };
}

function storageHost(): AnalyticsWriterIdentity {
  return {
    hostInstanceId: 'host-storage',
    workspaceId: WORKSPACE_ID,
    generationId: 'storage-generation',
    buildId: 'storage-build',
    processId: process.pid,
  };
}

function seedStorageFence(store: SessionLifecycleStore, operationId: string): StorageCutoffWriterFenceReceipt {
  const identity = storageHost();
  store.registerAnalyticsHost({
    ...identity,
    endpointName: 'storage-host-pipe',
    capabilities: ['authenticated-control', 'writer-fence'],
    registeredAtMs: String(NOW),
  });
  const begun = store.beginAnalyticsWriterFence({
    workspaceId: WORKSPACE_ID,
    operationId,
    purpose: 'storage-cutoff',
    expectedHosts: [identity],
    nowMs: NOW,
  });
  store.acknowledgeAnalyticsWriterFence({
    workspaceId: WORKSPACE_ID,
    operationId,
    fenceEpoch: begun.fenceEpoch,
    identity,
    activeWriterCount: 0,
    nowMs: NOW,
  });
  const complete = store.completeAnalyticsWriterFence(WORKSPACE_ID, operationId, NOW);
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    operationId,
    purpose: 'storage-cutoff',
    fenceEpoch: complete.fenceEpoch,
    status: 'fenced',
    hostInstanceIds: [identity.hostInstanceId],
    acknowledgedHostInstanceIds: [identity.hostInstanceId],
  };
}

function createRealMultiHostStorageHandoff(
  registry: SessionLifecycleStore,
  rejectingHostInstanceId?: string,
): AnalyticsAllHostHandoffCoordinator {
  const hosts = [
    {
      hostInstanceId: 'host-multi-a',
      workspaceId: WORKSPACE_ID,
      generationId: 'host-generation-a',
      buildId: 'host-build-a',
      processId: 50_001,
      endpointName: 'storage-host-a',
      capabilities: ['authenticated-control', 'writer-fence'] as const,
    },
    {
      hostInstanceId: 'host-multi-b',
      workspaceId: WORKSPACE_ID,
      generationId: 'host-generation-b',
      buildId: 'host-build-b',
      processId: 50_002,
      endpointName: 'storage-host-b',
      capabilities: ['authenticated-control', 'writer-fence'] as const,
    },
  ];
  const keys = new Map(hosts.map((host) => [host.hostInstanceId, `test-key-${host.hostInstanceId}`]));
  for (const host of hosts) {
    registry.registerAnalyticsHost({
      ...host,
      capabilities: ['authenticated-control', 'writer-fence'] as const,
      registeredAtMs: String(NOW),
    });
  }
  const discovery: AnalyticsHostDiscoveryResult = {
    workspaceId: WORKSPACE_ID,
    observedAtMs: NOW,
    registryComplete: true,
    runtimeLeasesComplete: true,
    processOwnersComplete: true,
    hosts: hosts.map(({ hostInstanceId, processId }) => ({
      hostInstanceId,
      processId,
      state: 'registered' as const,
      status: 'reconciled' as const,
      reasons: [],
    })),
    unregisteredRuntimeLeases: [],
    unregisteredBackendOwners: [],
    reasons: [],
    complete: true,
  };
  const participants: AnalyticsAllHostFenceParticipant[] = hosts.map((host) => ({
    identity: host,
    key: keys.get(host.hostInstanceId)!,
    send: async (request) => {
      const key = keys.get(host.hostInstanceId)!;
      const verified = verifyAnalyticsWriterFenceRequest(request, key);
      if (host.hostInstanceId === rejectingHostInstanceId) {
        return createSignedAnalyticsWriterFenceError(request.requestId, 'stale writer remains admitted', key);
      }
      return createSignedAnalyticsWriterFenceAcknowledgement(
        verified,
        host,
        { admissionRevoked: true, writersDrained: true, activeWriterCount: 0 },
        key,
      );
    },
  }));
  return new AnalyticsAllHostHandoffCoordinator({
    workspaceId: WORKSPACE_ID,
    registry,
    discover: async () => discovery,
    participants,
    purpose: 'storage-cutoff',
    now: () => NOW,
    requestTimeoutMs: 1_000,
  });
}

function temporaryResources() {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-cutover-'));
  const stateDir = path.join(root, 'state');
  const registry = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
  const barrier = new SessionFilesystemMutationBarrier({
    store: registry,
    lockRoot: path.join(stateDir, 'session-mutation-locks'),
  });
  const cleaner = new SessionLifecycleCleaner({
    store: registry,
    barrier,
    roots: { sessions: path.join(root, 'sessions') },
    now: () => NOW,
  });
  return {
    root,
    stateDir,
    registry,
    cleaner,
    activationStore: new ActivationStore({ stateDir }),
  };
}

function runtimeFor(
  activationStore: ActivationStore,
  calls: string[],
  failStorage = false,
): AnalyticsCutoverRuntime {
  return {
    completeAnalyticsActivation: async ({ operationId, manifest }) => {
      calls.push(`analytics-runtime:${operationId}`);
      const manifestSha256 = activationStore.read().sha256!;
      return {
        verified: true,
        generationId: manifest.activeGeneration!.identity.generationId,
        buildId: manifest.activeGeneration!.identity.buildId,
        manifestRevision: manifest.revision,
        manifestSha256,
        hosts: [{ hostInstanceId: 'host-new', processId: process.pid, backendGeneration: 2 }],
        admissionReopened: true,
      };
    },
    completeStorageCutoff: async ({ operationId }) => {
      calls.push(`storage-runtime:${operationId}`);
      if (failStorage) throw new Error('simulated terminal storage handoff interruption');
      return {
        verified: true,
        hosts: [{ hostInstanceId: 'host-storage-new', processId: process.pid + 1, backendGeneration: 3 }],
        admissionReopened: true,
      };
    },
  };
}

function baseOptions(
  resources: ReturnType<typeof temporaryResources>,
  mode: AnalyticsCutoverOptions['mode'],
  calls: string[],
): AnalyticsCutoverOptions {
  return {
    enabled: true,
    mode,
    operationId: 'cutover-operation-1',
    workspaceId: WORKSPACE_ID,
    stateDir: resources.stateDir,
    authorization: authorization(),
    prerequisites: prerequisites(),
    activationStore: resources.activationStore,
    registry: resources.registry,
    cleaner: resources.cleaner,
    ...(mode !== 'storage-cutoff' ? { activationRequest: activationRequest() } : {}),
    expectedActiveGenerationId: GENERATION_ID,
    analyticsHandoff: {
      run: async (operationId) => {
        calls.push(`analytics-fence:${operationId}`);
        return activationFence(operationId);
      },
    },
    storageHandoff: {
      ensureFenced: async (operationId) => {
        calls.push(`storage-fence:${operationId}`);
        return seedStorageFence(resources.registry, operationId);
      },
    },
    collectInventory: async (fence) => {
      calls.push('inventory');
      const sessionIds = ['session-a', 'session-b'];
      return {
        source: 'test-session-lifecycle-authority',
        complete: true,
        sessionIds,
        fenceOperationId: fence.operationId,
        fenceEpoch: fence.fenceEpoch,
        inventorySha256: analyticsCutoverInventorySha256(sessionIds),
      };
    },
    runtime: runtimeFor(resources.activationStore, calls),
    now: () => NOW,
  };
}

function closeResources(resources: ReturnType<typeof temporaryResources>): void {
  resources.registry.close();
  rmSync(resources.root, { recursive: true, force: true });
}

test('cutover is disabled by default and does not create authority', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  try {
    const options = baseOptions(resources, 'analytics-activation', calls);
    const { enabled: _enabled, ...disabledOptions } = options;
    await assert.rejects(
      () => new AnalyticsCutoverOrchestrator(disabledOptions).run(),
      /disabled by default/u,
    );
    assert.deepEqual(calls, []);
    assert.equal(resources.activationStore.read().authority, 'legacy');
    assert.equal(existsSync(path.join(resources.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME)), false);
  } finally {
    closeResources(resources);
  }
});

test('analytics-only activation fences and preserves open sessions', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  try {
    resources.registry.registerTranscript('session-open', 'sessions/open.jsonl', NOW - 1_000);
    const result = await new AnalyticsCutoverOrchestrator(
      baseOptions(resources, 'analytics-activation', calls),
    ).run();

    assert.equal(result.status, 'complete');
    assert.equal(result.storage, undefined);
    assert.equal(resources.registry.get('session-open')?.closedAtMs, undefined);
    assert.equal(resources.activationStore.read().manifest?.activeGeneration?.cutoffReceiptSha256, null);
    assert.deepEqual(calls, [
      'analytics-fence:cutover-operation-1:analytics-activation',
      'analytics-runtime:cutover-operation-1:analytics-activation',
    ]);

    const revision = resources.activationStore.read().manifest!.revision;
    const retry = await new AnalyticsCutoverOrchestrator(
      baseOptions(resources, 'analytics-activation', calls),
    ).run();
    assert.equal(retry.status, 'complete');
    assert.equal(resources.activationStore.read().manifest?.revision, revision);
    assert.equal(calls.filter((call) => call.startsWith('analytics-fence:')).length, 1);
    assert.equal(calls.filter((call) => call.startsWith('analytics-runtime:')).length, 2);
  } finally {
    closeResources(resources);
  }
});

test('storage-only cutoff is independently resumable against the active generation', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  const restoreAuthorization = authorizeStorageCutoff();
  try {
    await activateGeneration(resources.activationStore, activationRequest());
    resources.registry.registerTranscript('session-a', 'sessions/a.jsonl', NOW - 1_000);
    resources.registry.registerTranscript('session-b', 'sessions/b.jsonl', NOW - 1_000);
    const options = baseOptions(resources, 'storage-cutoff', calls);
    const result = await new AnalyticsCutoverOrchestrator(options).run();
    assert.equal(result.status, 'complete');
    assert.deepEqual([...result.storage!.closedSessionIds].sort(), ['session-a', 'session-b']);
    assert.equal(resources.activationStore.read().manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
    const retry = await new AnalyticsCutoverOrchestrator(baseOptions(resources, 'storage-cutoff', calls)).run();
    assert.equal(retry.status, 'complete');
    assert.equal(resources.registry.get('session-a')?.closedAtMs, String(NOW));
    assert.equal(resources.registry.get('session-b')?.closedAtMs, String(NOW));
    assert.deepEqual(calls, [
      'storage-fence:cutover-operation-1',
      'inventory',
      'storage-runtime:cutover-operation-1',
      'storage-runtime:cutover-operation-1',
    ]);
  } finally {
    restoreAuthorization();
    closeResources(resources);
  }
});

test('both phases are ordered, resumable, and do not double-close sessions', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  const restoreAuthorization = authorizeStorageCutoff();
  try {
    resources.registry.registerTranscript('session-a', 'sessions/a.jsonl', NOW - 1_000);
    resources.registry.registerTranscript('session-b', 'sessions/b.jsonl', NOW - 1_000);
    const multiHostStorageHandoff = createRealMultiHostStorageHandoff(resources.registry);
    const firstOptions = {
      ...baseOptions(resources, 'both', calls),
      storageHandoff: {
        ensureFenced: async (operationId: string) => {
          calls.push(`storage-fence:${operationId}`);
          return multiHostStorageHandoff.ensureFenced(operationId);
        },
      },
      runtime: runtimeFor(resources.activationStore, calls, true),
    } satisfies AnalyticsCutoverOptions;
    await assert.rejects(
      () => new AnalyticsCutoverOrchestrator(firstOptions).run(),
      /simulated terminal storage handoff interruption/u,
    );
    assert.equal(resources.registry.get('session-a')?.closedAtMs, String(NOW));
    assert.equal(resources.registry.get('session-b')?.closedAtMs, String(NOW));
    assert.equal(resources.activationStore.read().manifest?.activeGeneration?.cutoffReceiptSha256 !== null, true);

    const secondOptions = baseOptions(resources, 'both', calls);
    const result = await new AnalyticsCutoverOrchestrator(secondOptions).run();
    assert.equal(result.status, 'complete');
    assert.deepEqual([...result.storage!.closedSessionIds].sort(), ['session-a', 'session-b']);
    const third = await new AnalyticsCutoverOrchestrator(baseOptions(resources, 'both', calls)).run();
    assert.equal(third.status, 'complete');
    assert.equal(resources.registry.get('session-a')?.closedAtMs, String(NOW));
    assert.equal(resources.registry.get('session-b')?.closedAtMs, String(NOW));
    assert.deepEqual(calls, [
      'analytics-fence:cutover-operation-1:analytics-activation',
      'analytics-runtime:cutover-operation-1:analytics-activation',
      'storage-fence:cutover-operation-1',
      'inventory',
      'storage-runtime:cutover-operation-1',
      'analytics-runtime:cutover-operation-1:analytics-activation',
      'storage-runtime:cutover-operation-1',
      'analytics-runtime:cutover-operation-1:analytics-activation',
      'storage-runtime:cutover-operation-1',
    ]);
    assert.equal(readFileSync(path.join(resources.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME), 'utf8').includes('"phase": "complete"'), true);
  } finally {
    restoreAuthorization();
    closeResources(resources);
  }
});

test('an authenticated stale-writer acknowledgement blocks storage cutoff', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  const restoreAuthorization = authorizeStorageCutoff();
  try {
    await activateGeneration(resources.activationStore, activationRequest());
    resources.registry.registerTranscript('session-open', 'sessions/open.jsonl', NOW - 1_000);
    const multiHostHandoff = createRealMultiHostStorageHandoff(resources.registry, 'host-multi-b');
    const options = {
      ...baseOptions(resources, 'storage-cutoff', calls),
      storageHandoff: {
        ensureFenced: async (operationId: string) => {
          calls.push(`storage-fence:${operationId}`);
          return multiHostHandoff.ensureFenced(operationId);
        },
      },
    } satisfies AnalyticsCutoverOptions;
    await assert.rejects(
      () => new AnalyticsCutoverOrchestrator(options).run(),
      /stale writer remains admitted/u,
    );
    assert.equal(resources.registry.get('session-open')?.closedAtMs, undefined);
    assert.equal(existsSync(path.join(resources.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME)), false);
  } finally {
    restoreAuthorization();
    closeResources(resources);
  }
});

test('incomplete fenced inventory fails before any lifecycle close', async () => {
  const resources = temporaryResources();
  const calls: string[] = [];
  const restoreAuthorization = authorizeStorageCutoff();
  try {
    await activateGeneration(resources.activationStore, activationRequest());
    resources.registry.registerTranscript('session-open', 'sessions/open.jsonl', NOW - 1_000);
    const options = {
      ...baseOptions(resources, 'storage-cutoff', calls),
      collectInventory: async (fence: StorageCutoffWriterFenceReceipt) => ({
        source: 'incomplete-test-inventory',
        complete: false,
        sessionIds: [],
        fenceOperationId: fence.operationId,
        fenceEpoch: fence.fenceEpoch,
        inventorySha256: analyticsCutoverInventorySha256([]),
      } as never),
    } satisfies AnalyticsCutoverOptions;
    await assert.rejects(
      () => new AnalyticsCutoverOrchestrator(options).run(),
      /inventory is incomplete/u,
    );
    assert.equal(resources.registry.get('session-open')?.closedAtMs, undefined);
    assert.equal(existsSync(path.join(resources.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME)), false);
  } finally {
    restoreAuthorization();
    closeResources(resources);
  }
});
