import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAnalyticsHandoffPipeName,
  createPerBootAnalyticsHandoffKey,
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
  let inventoryReads = 0;
  const control = new AnalyticsHandoffControl({
    registry: temporary.store,
    identity,
    key,
    pipeName,
    now: () => 100,
    readInventory: async () => {
      inventoryReads += 1;
      return {
        kind: 'registered-hosts-only',
        complete: false,
        reason: 'runtime-generation-and-process-reconciliation-incomplete',
      };
    },
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
    assert.equal((result.inventoryProof as { reason?: string }).reason, 'runtime-generation-and-process-reconciliation-incomplete');
    assert.equal(inventoryReads, 1);
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
    assert.equal(inventoryReads, 1, 'status discovery is cached within its bounded freshness window');

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

test('per-boot handoff keys are fresh, bounded capabilities', () => {
  const first = createPerBootAnalyticsHandoffKey();
  const second = createPerBootAnalyticsHandoffKey();
  assert.notEqual(first, second);
  assert.ok(first.length >= 32 && first.length <= 128);
  assert.ok(second.length >= 32 && second.length <= 128);
  assert.doesNotMatch(first, /[\r\n]/u);
  assert.equal(first.includes(String.fromCharCode(0)), false);
});

test('inventory timeout is bounded while one unresolved census remains the single flight', async () => {
  const temporary = temporaryStore();
  const key = 'unit-test-handoff-key';
  const identity = {
    hostInstanceId: 'host-unit-inventory-timeout',
    workspaceId: 'workspace-unit-inventory-timeout',
    generationId: 'generation-unit-inventory-timeout',
    buildId: 'build-unit-1',
    processId: process.pid,
    capabilities: ['host-discovery'],
  } as const;
  const pipeName = createAnalyticsHandoffPipeName(identity.workspaceId, identity.hostInstanceId);
  let inventoryReads = 0;
  let releaseInventory!: (proof: {
    kind: 'registered-hosts-only'; complete: false;
    reason: 'runtime-generation-and-process-reconciliation-incomplete';
  }) => void;
  const unresolved = new Promise<{
    kind: 'registered-hosts-only'; complete: false;
    reason: 'runtime-generation-and-process-reconciliation-incomplete';
  }>((resolve) => { releaseInventory = resolve; });
  const control = new AnalyticsHandoffControl({
    registry: temporary.store,
    identity,
    key,
    pipeName,
    now: () => 100,
    inventoryReadTimeoutMs: 25,
    readInventory: async () => {
      inventoryReads += 1;
      return unresolved;
    },
  });
  try {
    await control.start();
    const first = createSignedAnalyticsHandoffRequest('status', { workspaceId: identity.workspaceId }, key, {
      requestId: 'request-inventory-timeout-1', nonce: 'nonce-inventory-timeout-1', issuedAtMs: 100, expiresAtMs: 5_000,
    });
    const second = createSignedAnalyticsHandoffRequest('status', { workspaceId: identity.workspaceId }, key, {
      requestId: 'request-inventory-timeout-2', nonce: 'nonce-inventory-timeout-2', issuedAtMs: 100, expiresAtMs: 5_000,
    });
    const startedAt = Date.now();
    const responses = await Promise.all([sendFrame(pipeName, first), sendFrame(pipeName, second)]);
    assert.ok(Date.now() - startedAt < 1_000, 'callers receive bounded timeout responses');
    for (const value of responses) {
      const response = verifyAnalyticsHandoffResponse(value, key);
      assert.equal(response.ok, true);
      assert.deepEqual((response.result as { inventoryProof: { reasonCodes?: readonly string[] } }).inventoryProof.reasonCodes, ['inventory-discovery-timeout']);
    }
    assert.equal(inventoryReads, 1, 'an unresolved discovery cannot fan out per socket');
    releaseInventory({
      kind: 'registered-hosts-only', complete: false,
      reason: 'runtime-generation-and-process-reconciliation-incomplete',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = createSignedAnalyticsHandoffRequest('status', { workspaceId: identity.workspaceId }, key, {
      requestId: 'request-inventory-timeout-3', nonce: 'nonce-inventory-timeout-3', issuedAtMs: 100, expiresAtMs: 5_000,
    });
    const thirdResponse = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, third), key);
    assert.equal(thirdResponse.ok, true);
    assert.equal((thirdResponse.result as { inventoryProof: { reason: string } }).inventoryProof.reason, 'runtime-generation-and-process-reconciliation-incomplete');
    assert.equal(inventoryReads, 1);
  } finally {
    await control.stop();
    temporary.store.close();
    rmSync(temporary.root, { recursive: true, force: true });
  }
});

test('synchronous inventory reader failure returns structured incomplete status', async () => {
  const temporary = temporaryStore();
  const key = 'unit-test-handoff-key';
  const identity = {
    hostInstanceId: 'host-unit-inventory-error',
    workspaceId: 'workspace-unit-inventory-error',
    generationId: 'generation-unit-inventory-error',
    buildId: 'build-unit-1',
    processId: process.pid,
    capabilities: ['host-discovery'],
  } as const;
  const pipeName = createAnalyticsHandoffPipeName(identity.workspaceId, identity.hostInstanceId);
  const control = new AnalyticsHandoffControl({
    registry: temporary.store,
    identity,
    key,
    pipeName,
    now: () => 100,
    readInventory: () => { throw new Error('injected discovery failure'); },
  });
  try {
    await control.start();
    const request = createSignedAnalyticsHandoffRequest('status', { workspaceId: identity.workspaceId }, key, {
      requestId: 'request-inventory-error', nonce: 'nonce-inventory-error', issuedAtMs: 100, expiresAtMs: 5_000,
    });
    const response = verifyAnalyticsHandoffResponse(await sendFrame(pipeName, request), key);
    assert.equal(response.ok, true);
    assert.deepEqual((response.result as { inventoryProof: { reasonCodes?: readonly string[] } }).inventoryProof.reasonCodes, ['inventory-discovery-error']);
  } finally {
    await control.stop();
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
