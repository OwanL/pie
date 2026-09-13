import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAnalyticsHandoffPipeName,
  type AnalyticsHandoffHostIdentity,
} from '../../../shared/analytics/handoff.js';
import {
  ANALYTICS_WRITER_FENCE_MAX_CENSUS_AGE_MS,
  AnalyticsAllHostHandoffCoordinator,
  assertFreshAnalyticsWriterFenceRequest,
  createAnalyticsHostWriterFence,
  createSessionLifecycleWriterAdmission,
  createSignedAnalyticsWriterFenceAcknowledgement,
  createSignedAnalyticsWriterFenceRequest,
  verifyAnalyticsWriterFenceRequest,
  verifyAnalyticsWriterFenceResponse,
  type AnalyticsAllHostFenceParticipant,
  type AnalyticsHostWriterFenceHandler,
  type AnalyticsWriterFenceHostIdentity,
} from '../../src/host/analytics-all-host-handoff.js';
import { AnalyticsHandoffControl } from '../../src/host/analytics-handoff-control.js';
import {
  SessionLifecycleStore,
  type AnalyticsHostRecord,
} from '../../src/backend/session-lifecycle-store.js';
import {
  createSessionManagerFence,
  createSessionManagerFenceRegistry,
  FENCED_ENTRY_ID,
} from '../../src/backend/session-manager-fence.js';
import { SessionOwnershipAuthority } from '../../src/backend/session-ownership-authority.js';
import {
  SessionFilesystemMutationBarrier,
  SessionLifecycleCleaner,
} from '../../src/backend/session-filesystem-lifecycle.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
  performStorageCutoff,
} from '../../src/backend/storage-cutoff.js';

const NOW = 100;

type Host = {
  identity: AnalyticsHandoffHostIdentity;
  key: string;
  record: AnalyticsHostRecord;
};

function makeHost(index: number, workspaceId: string): Host {
  const identity: AnalyticsHandoffHostIdentity = {
    hostInstanceId: `host-${index}`,
    workspaceId,
    generationId: `generation-${index}`,
    buildId: 'build-test',
    processId: 10_000 + index,
    capabilities: ['host-discovery'],
  };
  return {
    identity,
    key: `writer-fence-key-${index}`,
    record: {
      ...identity,
      endpointName: `endpoint-${index}`,
      capabilities: ['host-discovery', 'authenticated-control', 'writer-fence'],
      state: 'registered',
      registeredAtMs: String(NOW),
      heartbeatAtMs: String(NOW),
      updatedAtMs: String(NOW),
    },
  };
}

function registerHosts(store: SessionLifecycleStore, hosts: readonly Host[]): void {
  for (const host of hosts) store.registerAnalyticsHost(host.record);
}

function discoveryFor(workspaceId: string, hosts: readonly Host[], overrides: Partial<{
  complete: boolean;
  registryComplete: boolean;
  runtimeLeasesComplete: boolean;
  processOwnersComplete: boolean;
}> = {}) {
  return {
    workspaceId,
    observedAtMs: NOW,
    registryComplete: overrides.registryComplete ?? true,
    runtimeLeasesComplete: overrides.runtimeLeasesComplete ?? true,
    processOwnersComplete: overrides.processOwnersComplete ?? true,
    hosts: hosts.map((host) => ({
      hostInstanceId: host.identity.hostInstanceId,
      processId: host.identity.processId,
      state: 'registered' as const,
      status: 'reconciled' as const,
      reasons: [],
    })),
    unregisteredRuntimeLeases: [],
    unregisteredBackendOwners: [],
    reasons: [],
    complete: overrides.complete ?? true,
  };
}

function directParticipant(
  host: Host,
  handler?: AnalyticsHostWriterFenceHandler,
  onSend?: () => void,
): AnalyticsAllHostFenceParticipant {
  let admissionRevoked = false;
  const localHandler = handler ?? createAnalyticsHostWriterFence({
    activeWriterCount: () => 0,
    identity: host.identity,
    revokeAdmission: () => { admissionRevoked = true; },
    isAdmissionRevoked: () => admissionRevoked,
  });
  return {
    identity: host.identity,
    key: host.key,
    send: async (request) => {
      onSend?.();
      const verified = verifyAnalyticsWriterFenceRequest(request, host.key);
      assertFreshAnalyticsWriterFenceRequest(verified, NOW);
      const acknowledgement = await localHandler.freeze(verified);
      return createSignedAnalyticsWriterFenceAcknowledgement(
        verified,
        host.identity as AnalyticsWriterFenceHostIdentity,
        acknowledgement,
        host.key,
      );
    },
  };
}

async function sendPipe(pipeName: string, frame: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('writer-fence test response timed out'));
    }, 5_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on('data', (chunk: string) => { data += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.trim()) as unknown); } catch (error) { reject(error); }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function temporaryStore(prefix: string): { root: string; store: SessionLifecycleStore } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    root,
    store: new SessionLifecycleStore(path.join(root, 'state', 'session-lifecycle.sqlite')),
  };
}

test('the authenticated control endpoint fences its local manager set', async () => {
  const temporary = temporaryStore('pie-all-host-control-');
  const host = makeHost(1, 'workspace-control');
  const calls: string[] = [];
  const manager = {
    appendMessage: (message: unknown) => { calls.push(String(message)); return 'entry-1'; },
  };
  const managerFence = createSessionManagerFence(manager as never);
  const managerRegistry = createSessionManagerFenceRegistry();
  managerRegistry.register(managerFence.fence);
  const control = new AnalyticsHandoffControl({
    registry: temporary.store,
    identity: host.identity,
    key: host.key,
    pipeName: createAnalyticsHandoffPipeName(host.identity.workspaceId, host.identity.hostInstanceId),
    now: () => NOW,
    writerFence: createAnalyticsHostWriterFence({ identity: host.identity, registry: managerRegistry }),
  });
  try {
    await control.start();
    const request = createSignedAnalyticsWriterFenceRequest({
      workspaceId: host.identity.workspaceId,
      operationId: 'control-freeze',
      purpose: 'analytics-activation',
      fenceEpoch: 1,
    }, host.key, { requestId: 'control-request', nonce: 'control-nonce', issuedAtMs: NOW, expiresAtMs: 1_000 });
    const response = verifyAnalyticsWriterFenceResponse(await sendPipe(control.endpointName!, request), host.key);
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.deepEqual(response.host, {
        hostInstanceId: host.identity.hostInstanceId,
        workspaceId: host.identity.workspaceId,
        generationId: host.identity.generationId,
        buildId: host.identity.buildId,
        processId: host.identity.processId,
      });
    }
    assert.equal(managerFence.manager.appendMessage('after-freeze'), FENCED_ENTRY_ID);
    assert.deepEqual(calls, []);
    assert.equal(temporary.store.getAnalyticsHost(host.identity.hostInstanceId)?.capabilities.includes('writer-fence'), true);
  } finally {
    await control.stop();
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('a complete authenticated activation fence preserves open session lifecycle state', async () => {
  const temporary = temporaryStore('pie-all-host-activation-');
  const workspaceId = 'workspace-activation';
  const hosts = [makeHost(1, workspaceId), makeHost(2, workspaceId)];
  registerHosts(temporary.store, hosts);
  temporary.store.registerTranscript('session-open', 'sessions/open.jsonl', NOW);
  const coordinator = new AnalyticsAllHostHandoffCoordinator({
    workspaceId,
    registry: temporary.store,
    discover: async () => discoveryFor(workspaceId, hosts),
    participants: hosts.map((host) => directParticipant(host)),
    purpose: 'analytics-activation',
    now: () => NOW,
  });
  try {
    const receipt = await coordinator.run('activation-op-1');
    assert.equal(receipt.status, 'fenced');
    assert.deepEqual(receipt.hostInstanceIds, ['host-1', 'host-2']);
    assert.deepEqual(temporary.store.getAnalyticsWriterFence(workspaceId), {
      workspaceId,
      operationId: 'activation-op-1',
      purpose: 'analytics-activation',
      fenceEpoch: 1,
      state: 'fenced',
      expectedHosts: hosts.map((host) => ({
        hostInstanceId: host.identity.hostInstanceId,
        workspaceId,
        generationId: host.identity.generationId,
        buildId: host.identity.buildId,
        processId: host.identity.processId,
      })),
      acknowledgedHostInstanceIds: ['host-1', 'host-2'],
      startedAtMs: String(NOW),
      updatedAtMs: String(NOW),
    });
    assert.equal(temporary.store.get('session-open')?.closedAtMs ?? null, null);
  } finally {
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('an interrupted fence resumes its durable acknowledgements without reopening admission', async () => {
  const temporary = temporaryStore('pie-all-host-retry-');
  const workspaceId = 'workspace-retry';
  const hosts = [makeHost(1, workspaceId), makeHost(2, workspaceId)];
  registerHosts(temporary.store, hosts);
  let secondAttempts = 0;
  const firstParticipant = directParticipant(hosts[0]!);
  const failingSecond: AnalyticsAllHostFenceParticipant = {
    ...directParticipant(hosts[1]!),
    send: async () => {
      secondAttempts += 1;
      throw new Error('simulated endpoint interruption');
    },
  };
  const initial = new AnalyticsAllHostHandoffCoordinator({
    workspaceId,
    registry: temporary.store,
    discover: async () => discoveryFor(workspaceId, hosts),
    participants: [firstParticipant, failingSecond],
    purpose: 'analytics-activation',
    now: () => NOW,
  });
  try {
    await assert.rejects(initial.run('activation-op-retry'), /interruption/u);
    assert.equal(temporary.store.getAnalyticsWriterFence(workspaceId)?.state, 'fencing');
    assert.deepEqual(temporary.store.getAnalyticsWriterFence(workspaceId)?.acknowledgedHostInstanceIds, ['host-1']);

    const resumed = new AnalyticsAllHostHandoffCoordinator({
      workspaceId,
      registry: temporary.store,
      discover: async () => discoveryFor(workspaceId, hosts),
      participants: hosts.map((host) => directParticipant(host)),
      purpose: 'analytics-activation',
      now: () => NOW,
    });
    const receipt = await resumed.run('activation-op-retry');
    assert.equal(receipt.status, 'fenced');
    assert.equal(secondAttempts, 1);
    assert.deepEqual(temporary.store.getAnalyticsWriterFence(workspaceId)?.acknowledgedHostInstanceIds, ['host-1', 'host-2']);
  } finally {
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('incomplete, duplicate, and unauthenticated census evidence fails closed', async () => {
  const temporary = temporaryStore('pie-all-host-reject-');
  const workspaceId = 'workspace-reject';
  const hosts = [makeHost(1, workspaceId), makeHost(2, workspaceId)];
  registerHosts(temporary.store, hosts);
  const incomplete = new AnalyticsAllHostHandoffCoordinator({
    workspaceId,
    registry: temporary.store,
    discover: async () => discoveryFor(workspaceId, hosts, { complete: false }),
    participants: hosts.map((host) => directParticipant(host)),
    purpose: 'analytics-activation',
    now: () => NOW,
  });
  try {
    await assert.rejects(incomplete.run('reject-incomplete'), /incomplete or ambiguous/u);
    assert.equal(temporary.store.getAnalyticsWriterFence(workspaceId), undefined);

    const duplicateDiscovery = discoveryFor(workspaceId, hosts);
    duplicateDiscovery.hosts = [duplicateDiscovery.hosts[0]!, duplicateDiscovery.hosts[0]!];
    const duplicate = new AnalyticsAllHostHandoffCoordinator({
      workspaceId,
      registry: temporary.store,
      discover: async () => duplicateDiscovery,
      participants: hosts.map((host) => directParticipant(host)),
      purpose: 'analytics-activation',
      now: () => NOW,
    });
    await assert.rejects(duplicate.run('reject-duplicate'), /duplicate/u);

    const staleDiscovery = discoveryFor(workspaceId, hosts);
    staleDiscovery.observedAtMs = NOW - ANALYTICS_WRITER_FENCE_MAX_CENSUS_AGE_MS - 1;
    const stale = new AnalyticsAllHostHandoffCoordinator({
      workspaceId,
      registry: temporary.store,
      discover: async () => staleDiscovery,
      participants: hosts.map((host) => directParticipant(host)),
      purpose: 'analytics-activation',
      now: () => NOW,
    });
    await assert.rejects(stale.run('reject-stale'), /incomplete or ambiguous/u);

    const badKeyParticipant: AnalyticsAllHostFenceParticipant = {
      ...directParticipant(hosts[0]!),
      key: 'wrong-key-for-host',
    };
    const unauthenticated = new AnalyticsAllHostHandoffCoordinator({
      workspaceId,
      registry: temporary.store,
      discover: async () => discoveryFor(workspaceId, hosts),
      participants: [badKeyParticipant, directParticipant(hosts[1]!)],
      purpose: 'analytics-activation',
      now: () => NOW,
    });
    await assert.rejects(unauthenticated.run('reject-auth'), /authenticate/u);
    assert.equal(temporary.store.getAnalyticsWriterFence(workspaceId)?.state, 'fencing');
    assert.deepEqual(temporary.store.getAnalyticsWriterFence(workspaceId)?.acknowledgedHostInstanceIds, []);
  } finally {
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('the durable admission epoch rejects stale managers and ownership leases', async () => {
  const temporary = temporaryStore('pie-all-host-admission-');
  const workspaceId = 'workspace-admission';
  const host = makeHost(1, workspaceId);
  registerHosts(temporary.store, [host]);
  const admission = createSessionLifecycleWriterAdmission(temporary.store, {
    hostInstanceId: host.identity.hostInstanceId,
    workspaceId,
    generationId: host.identity.generationId,
    buildId: host.identity.buildId,
    processId: host.identity.processId,
  });
  const calls: string[] = [];
  const manager = {
    appendMessage: (message: unknown) => { calls.push(String(message)); return 'entry-1'; },
  } as never;
  const { manager: fencedManager } = createSessionManagerFence(manager, { admission });
  const authority = new SessionOwnershipAuthority({ writerAdmission: admission });
  const sessionPath = path.join(temporary.root, 'sessions', 'admission.jsonl');
  const owner = {
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
  };
  try {
    assert.equal(fencedManager.appendMessage('before-fence'), 'entry-1');
    const lease = await authority.registerHot(sessionPath, owner);
    temporary.store.beginAnalyticsWriterFence({
      workspaceId,
      operationId: 'admission-fence',
      purpose: 'analytics-activation',
      expectedHosts: [{
        hostInstanceId: host.identity.hostInstanceId,
        workspaceId,
        generationId: host.identity.generationId,
        buildId: host.identity.buildId,
        processId: host.identity.processId,
      }],
      nowMs: NOW,
    });
    assert.throws(
      () => temporary.store.registerAnalyticsHost(makeHost(2, workspaceId).record),
      /registration is closed/u,
    );
    assert.equal(fencedManager.appendMessage('after-fence'), FENCED_ENTRY_ID);
    assert.deepEqual(calls, ['before-fence']);
    const adapter = authority.createAdapter(owner);
    assert.throws(
      () => adapter.assertWriteLease(lease, sessionPath, 'stale-after-fence'),
      /Analytics writer admission is fencing/u,
    );
    temporary.store.acknowledgeAnalyticsWriterFence({
      workspaceId,
      operationId: 'admission-fence',
      fenceEpoch: 1,
      identity: {
        hostInstanceId: host.identity.hostInstanceId,
        workspaceId,
        generationId: host.identity.generationId,
        buildId: host.identity.buildId,
        processId: host.identity.processId,
      },
      activeWriterCount: 0,
      nowMs: NOW,
    });
    temporary.store.completeAnalyticsWriterFence(workspaceId, 'admission-fence', NOW);
    assert.equal(temporary.store.reopenAnalyticsWriterAdmission({
      workspaceId,
      operationId: 'admission-fence',
      purpose: 'analytics-activation',
      nowMs: NOW,
    }).fenceEpoch, 2);
    assert.equal(fencedManager.appendMessage('after-reopen-with-stale-admission'), FENCED_ENTRY_ID);
  } finally {
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('storage cutoff refuses to close until its authenticated fence is complete', async () => {
  const temporary = temporaryStore('pie-all-host-cutoff-');
  const workspaceId = 'workspace-cutoff';
  const hosts = [makeHost(1, workspaceId)];
  registerHosts(temporary.store, hosts);
  temporary.store.registerTranscript('session-cutoff', 'sessions/cutoff.jsonl', NOW);
  const coordinator = new AnalyticsAllHostHandoffCoordinator({
    workspaceId,
    registry: temporary.store,
    discover: async () => discoveryFor(workspaceId, hosts),
    participants: hosts.map((host) => directParticipant(host)),
    purpose: 'storage-cutoff',
    now: () => NOW,
  });
  const stateDir = path.join(temporary.root, 'state');
  const barrier = new SessionFilesystemMutationBarrier({
    store: temporary.store,
    lockRoot: path.join(stateDir, 'session-mutation-locks'),
  });
  const cleaner = new SessionLifecycleCleaner({
    store: temporary.store,
    barrier,
    roots: { sessions: path.join(temporary.root, 'sessions') },
  });
  const priorAuthorization = process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
  process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  try {
    const receipt = await performStorageCutoff({
      store: temporary.store,
      cleaner,
      stateDir,
      inventory: ['session-cutoff'],
      inventoryValidated: true,
      operationId: 'cutoff-op-1',
      writerFence: coordinator,
      now: () => NOW,
    });
    assert.deepEqual(receipt.closedSessionIds, ['session-cutoff']);
    assert.equal(receipt.writerFence?.purpose, 'storage-cutoff');
    assert.ok(temporary.store.get('session-cutoff')?.closedAtMs);
  } finally {
    if (priorAuthorization === undefined) delete process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV];
    else process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] = priorAuthorization;
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});
