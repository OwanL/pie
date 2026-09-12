import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAnalyticsHandoffPipeName,
  createSignedAnalyticsHandoffRequest,
  verifyAnalyticsHandoffResponse,
} from '../../../shared/analytics/handoff.js';
import { AnalyticsHandoffControl } from '../../src/host/analytics-handoff-control.js';
import { SessionLifecycleStore } from '../../src/backend/session-lifecycle-store.js';

function temporaryStore(): { root: string; store: SessionLifecycleStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-handoff-'));
  return { root, store: new SessionLifecycleStore(path.join(root, 'state', 'session-lifecycle.sqlite')) };
}

async function sendFrame(pipeName: string, frame: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('handoff test response timed out')); }, 5_000);
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

test('authenticated host status is registered in lifecycle storage and rejects replay', async () => {
  const temporary = temporaryStore();
  const key = 'unit-test-handoff-key';
  const identity = {
    hostInstanceId: 'host-unit-1',
    workspaceId: 'workspace-unit-1',
    generationId: 'generation-unit-1',
    buildId: 'build-unit-1',
    processId: process.pid,
    capabilities: ['host-discovery', 'host-status'],
  } as const;
  const pipeName = createAnalyticsHandoffPipeName(identity.workspaceId, identity.hostInstanceId);
  const control = new AnalyticsHandoffControl({
    registry: temporary.store,
    identity,
    key,
    pipeName,
    now: () => 100,
  });
  try {
    await control.start();
    assert.equal(control.isAvailable, true);
    assert.equal(temporary.store.getAnalyticsHost(identity.hostInstanceId)?.state, 'registered');

    const request = createSignedAnalyticsHandoffRequest('status', { workspaceId: identity.workspaceId }, key, {
      requestId: 'request-unit-1',
      nonce: 'nonce-unit-1',
      issuedAtMs: 100,
      expiresAtMs: 5_000,
    });
    const response = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, request), key);
    assert.equal(response.ok, true);
    const result = response.result as { inventoryProof?: { complete?: boolean }; allHostsHandoffAvailable?: boolean };
    assert.equal(result.inventoryProof?.complete, false);
    assert.equal(result.allHostsHandoffAvailable, false);

    for (const [index, hostInstanceId] of ['host-unit-1-a', 'host-unit-1-b'].entries()) {
      temporary.store.registerAnalyticsHost({
        hostInstanceId,
        workspaceId: identity.workspaceId,
        generationId: `generation-unit-extra-${index}`,
        buildId: 'build-unit-1',
        processId: process.pid + index + 1,
        capabilities: ['host-status'],
        registeredAtMs: '100',
      });
    }
    const pagedRequest = createSignedAnalyticsHandoffRequest(
      'status', { workspaceId: identity.workspaceId, limit: 1 }, key,
      { requestId: 'request-page-1', nonce: 'nonce-page-1', issuedAtMs: 100, expiresAtMs: 5_000 },
    );
    const pagedResponse = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, pagedRequest), key);
    assert.equal(pagedResponse.ok, true);
    const page = pagedResponse.result as { hosts?: unknown[]; truncated?: boolean; nextCursor?: string };
    assert.equal(page.hosts?.length, 1);
    assert.equal(page.truncated, true);
    assert.equal(typeof page.nextCursor, 'string');

    const replay = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, request), key);
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? '', /replayed/);
  } finally {
    await control.stop();
    // Endpoint closure is not recorder/backend quiescence evidence.
    assert.equal(temporary.store.getAnalyticsHost(identity.hostInstanceId)?.state, 'stopping');
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('malformed request IDs are rejected without an unhandled response failure', async () => {
  const temporary = temporaryStore();
  const key = 'unit-test-handoff-key';
  const identity = {
    hostInstanceId: 'host-unit-malformed',
    workspaceId: 'workspace-unit-malformed',
    generationId: 'generation-unit-malformed',
    buildId: 'build-unit-malformed',
    processId: process.pid,
    capabilities: ['host-discovery'],
  } as const;
  const pipeName = createAnalyticsHandoffPipeName(identity.workspaceId, identity.hostInstanceId);
  const control = new AnalyticsHandoffControl({
    registry: temporary.store, identity, key, pipeName, now: () => 100,
  });
  try {
    await control.start();
    for (const [index, requestId] of ['x'.repeat(129), 'bad\u0000id'].entries()) {
      const malformed = {
        schema: 1,
        requestId,
        nonce: `nonce-malformed-${index}`,
        issuedAtMs: 100,
        expiresAtMs: 5_000,
        operation: 'heartbeat',
        payload: {},
        mac: 'invalid',
      };
      const response = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, malformed), key);
      assert.equal(response.ok, false);
      assert.equal(response.requestId, 'invalid');
    }

    const valid = createSignedAnalyticsHandoffRequest('heartbeat', {}, key, {
      requestId: 'request-after-malformed', nonce: 'nonce-after-malformed', issuedAtMs: 100, expiresAtMs: 5_000,
    });
    const recovered = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, valid), key);
    assert.equal(recovered.ok, true);
  } finally {
    await control.stop();
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('host without a handoff key registers as unsupported and never opens a pipe', async () => {
  const temporary = temporaryStore();
  const identity = {
    hostInstanceId: 'host-unit-unsupported',
    workspaceId: 'workspace-unit-unsupported',
    generationId: 'generation-unit-unsupported',
    buildId: 'build-unit-unsupported',
    processId: process.pid,
    capabilities: ['host-discovery', 'host-status'],
  } as const;
  const control = new AnalyticsHandoffControl({ registry: temporary.store, identity, now: () => 200 });
  try {
    await control.start();
    assert.equal(control.isAvailable, false);
    assert.match(temporary.store.getAnalyticsHost(identity.hostInstanceId)?.unsupportedReason ?? '', /key/);
    assert.equal(temporary.store.getAnalyticsHost(identity.hostInstanceId)?.endpointName, undefined);
  } finally {
    await control.stop();
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});
