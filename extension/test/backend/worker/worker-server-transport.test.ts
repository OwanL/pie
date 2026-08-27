import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SDK_PATCH_IDENTITY_VERSION } from '../../../src/backend/sdk-patch-barrier';
import {
  WORKER_IPC_VERSION,
  type WorkerIpcFrame,
} from '../../../src/backend/worker-protocol';
import { WorkerServer } from '../../../src/backend/worker-server';

const identity = {
  coordinatorGeneration: 2,
  workerId: 'server-worker',
  workerGeneration: 3,
  sessionPath: '/root.jsonl',
  rootSessionPath: '/root.jsonl',
  leasePath: '/root.jsonl',
  leaseRevision: 1,
  ipcReadFd: 3,
  ipcWriteFd: 4,
};

const frameBase = {
  ipcVersion: WORKER_IPC_VERSION,
  coordinatorGeneration: identity.coordinatorGeneration,
  workerId: identity.workerId,
  workerGeneration: identity.workerGeneration,
  workerPid: 9876,
  rootSessionPath: identity.rootSessionPath,
  leasePath: identity.leasePath,
  leaseRevision: identity.leaseRevision,
  sessionPath: identity.rootSessionPath,
};

const sdkPatchIdentity = {
  identityVersion: SDK_PATCH_IDENTITY_VERSION,
  sdkPath: '/sdk',
  sdkVersion: 'fixture',
  terminalDurability: { patchVersion: 1, relativePath: 'agent-session.js', sha256: 'a'.repeat(64) },
  retryClassifier: { patchVersion: 1, relativePath: 'retry.js', sha256: 'b'.repeat(64) },
  coldCreateDurability: { patchVersion: 2, relativePath: 'session-manager.js', sha256: 'c'.repeat(64) },
  sessionOwnershipAdapter: { patchVersion: 1, relativePath: 'session-manager.js', sha256: 'c'.repeat(64) },
  sessionReplacementAdapter: { patchVersion: 7, relativePath: 'agent-session-runtime.js', sha256: 'd'.repeat(64) },
};

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  // Generous Windows CI headroom: these polls wait for causal frame receipt
  // from real spawned workers under full-suite load, not for a latency bound.
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for worker server transport frame.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('worker server admits soft interrupt on the priority path while a runtime command is active', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const frames: WorkerIpcFrame[] = [];
  let buffered = '';
  outbound.setEncoding('utf8');
  outbound.on('data', (chunk: string) => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      frames.push(JSON.parse(buffered.slice(0, newline)) as WorkerIpcFrame);
      buffered = buffered.slice(newline + 1);
    }
  });
  let releaseCommand!: () => void;
  const commandBlocked = new Promise<void>((resolve) => { releaseCommand = resolve; });
  let interrupted = false;
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: () => undefined as never,
  }, { readable: inbound, writable: outbound }, {
    validateBootstrap: () => undefined,
    onFrame: async (frame) => {
      if (frame.kind === 'runtime.command') await commandBlocked;
    },
    onInterrupt: () => { interrupted = true; },
  });
  server.start();
  const send = (seq: number, body: Record<string, unknown>): void => {
    inbound.write(`${JSON.stringify({ ...frameBase, seq, ...body })}\n`);
  };
  try {
    send(1, { kind: 'bootstrap', heartbeatIntervalMs: 60_000, sdkPatchIdentity });
    await waitUntil(() => frames.some((frame) => frame.kind === 'ready'));
    send(2, {
      kind: 'runtime.command', requestId: 'active-command', operation: 'message.send',
      payload: { params: { sessionPath: identity.leasePath, text: 'wait' }, publicRequestId: 'public-active' },
    });
    send(3, { kind: 'interrupt', requestId: 'stop-active', targetRequestId: 'active-command', reason: 'user stop' });
    await waitUntil(() => frames.some((frame) => frame.kind === 'response'
      && frame.requestId === 'stop-active'));
    assert.equal(interrupted, true);
    assert.equal(frames.some((frame) => frame.kind === 'response'
      && frame.requestId === 'active-command'), false);
  } finally {
    releaseCommand();
    inbound.destroy();
    outbound.destroy();
  }
});

test('worker server callback/request plumbing correlates Phase 4 frames and fences sync domains independently', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const frames: WorkerIpcFrame[] = [];
  let buffered = '';
  outbound.setEncoding('utf8');
  outbound.on('data', (chunk: string) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      frames.push(JSON.parse(buffered.slice(0, newline)) as WorkerIpcFrame);
      buffered = buffered.slice(newline + 1);
    }
  });
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: inbound, writable: outbound }, {
    validateBootstrap: () => undefined,
    onFrame: (frame, workerServer) => {
      if (frame.kind === 'sync') {
        workerServer.sendFrame({
          kind: 'sync.ack',
          requestId: frame.requestId,
          domain: frame.domain,
          revision: frame.revision,
        });
      }
    },
  });
  server.start();
  const send = (seq: number, body: Record<string, unknown>): void => {
    inbound.write(`${JSON.stringify({ ...frameBase, seq, ...body })}\n`);
  };

  try {
    send(1, { kind: 'bootstrap', heartbeatIntervalMs: 60_000, sdkPatchIdentity });
    await waitUntil(() => frames.some((frame) => frame.kind === 'ready'));

    const grantedPromise = server.requestFrame({
      kind: 'provider.acquire',
      request: { provider: 'fixture', model: 'model', turnId: 'turn-1', attemptId: 'attempt-1' },
    }, 'provider.granted');
    await waitUntil(() => frames.some((frame) => frame.kind === 'provider.acquire'));
    const acquire = frames.find((frame) => frame.kind === 'provider.acquire');
    assert.ok(acquire?.kind === 'provider.acquire');
    send(2, {
      kind: 'provider.granted',
      requestId: acquire.requestId,
      lease: { leaseId: 'lease-1', provider: 'fixture', model: 'model', grantedAt: 1 },
    });
    assert.equal((await grantedPromise).lease.leaseId, 'lease-1');

    const cancelledPromise = server.requestFrame({
      kind: 'provider.acquire',
      request: { provider: 'fixture', model: 'queued', turnId: 'turn-2', attemptId: 'attempt-2' },
    }, 'provider.granted', 'queued-admission');
    await waitUntil(() => frames.some((frame) => frame.kind === 'provider.acquire'
      && frame.requestId === 'queued-admission'));
    send(3, { kind: 'provider.cancelled', requestId: 'queued-admission', reason: 'interrupted while queued' });
    await assert.rejects(cancelledPromise, (error: Error) => error.name === 'AbortError');

    send(4, { kind: 'sync', requestId: 'settings-5', domain: 'settings', revision: 5, payload: { values: {} } });
    send(5, { kind: 'sync', requestId: 'catalog-1', domain: 'catalog', revision: 1, payload: { models: [] } });
    await waitUntil(() => frames.filter((frame) => frame.kind === 'sync.ack').length === 2);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === 'sync.ack').map((frame) => frame.kind === 'sync.ack' && [frame.domain, frame.revision]),
      [['settings', 5], ['catalog', 1]],
    );

    send(6, { kind: 'sync', requestId: 'settings-stale', domain: 'settings', revision: 4, payload: { values: {} } });
    await waitUntil(() => frames.some((frame) => frame.kind === 'fatal'));
    const fatal = frames.find((frame) => frame.kind === 'fatal');
    assert.ok(fatal?.kind === 'fatal');
    assert.match(fatal.error.message, /settings.*beyond 5/);
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});

test('worker server reports rejected runtime frames before exiting', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const frames: WorkerIpcFrame[] = [];
  let buffered = '';
  outbound.setEncoding('utf8');
  outbound.on('data', (chunk: string) => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      frames.push(JSON.parse(buffered.slice(0, newline)) as WorkerIpcFrame);
      buffered = buffered.slice(newline + 1);
    }
  });
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: inbound, writable: outbound }, { validateBootstrap: () => undefined });
  server.start();
  const send = (seq: number, body: Record<string, unknown>): void => {
    inbound.write(`${JSON.stringify({ ...frameBase, seq, ...body })}\n`);
  };

  try {
    send(1, { kind: 'bootstrap', heartbeatIntervalMs: 60_000, sdkPatchIdentity });
    await waitUntil(() => frames.some((frame) => frame.kind === 'ready'));

    assert.equal(server.sendFrame({
      kind: 'runtime.event',
      event: 'tool.started',
      payload: { input: 'x'.repeat(300 * 1024) },
    }), false);
    await waitUntil(() => frames.some((frame) => frame.kind === 'fatal'));
    const fatal = frames.find((frame) => frame.kind === 'fatal');
    assert.ok(fatal?.kind === 'fatal');
    assert.match(fatal.error.message, /rejected \(oversize\)/);
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});
