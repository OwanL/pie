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
  createAnalyticsHostWriterFence,
  createSessionLifecycleWriterAdmission,
  createSignedAnalyticsWriterFenceRequest,
  verifyAnalyticsWriterFenceResponse,
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
    temporary.store.markAnalyticsHostState(
      host.identity.hostInstanceId,
      host.identity.processId,
      host.identity.generationId,
      'stopped',
      NOW,
    );
    const successor = makeHost(2, workspaceId);
    temporary.store.registerAnalyticsHost(successor.record);
    assert.equal(temporary.store.reopenAnalyticsWriterAdmission({
      workspaceId,
      operationId: 'admission-fence',
      purpose: 'analytics-activation',
      admittedHosts: [successor.identity],
      nowMs: NOW,
    }).fenceEpoch, 2);
    assert.equal(fencedManager.appendMessage('after-reopen-with-stale-admission'), FENCED_ENTRY_ID);
  } finally {
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});
