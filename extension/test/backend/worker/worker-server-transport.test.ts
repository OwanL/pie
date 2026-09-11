import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SDK_PATCH_IDENTITY_VERSION } from '../../../src/backend/sdk-patch-barrier';
import {
  WORKER_IPC_VERSION,
  type WorkerIpcFrame,
} from '../../../src/backend/worker-protocol';
import { liveSemanticDroppableRejection, WorkerServer } from '../../../src/backend/worker-server';

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

test('worker server joins an exact equal-revision sync retry and applies it once', async () => {
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
  let releaseApply!: () => void;
  const applyBlocked = new Promise<void>((resolve) => { releaseApply = resolve; });
  let applyCount = 0;
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: () => undefined as never,
  }, { readable: inbound, writable: outbound }, {
    validateBootstrap: () => undefined,
    onFrame: async (frame) => {
      if (frame.kind !== 'sync') return;
      applyCount += 1;
      await applyBlocked;
    },
  });
  server.start();
  const send = (seq: number, body: Record<string, unknown>): void => {
    inbound.write(`${JSON.stringify({ ...frameBase, seq, ...body })}\n`);
  };
  try {
    send(1, { kind: 'bootstrap', heartbeatIntervalMs: 60_000, sdkPatchIdentity });
    await waitUntil(() => frames.some((frame) => frame.kind === 'ready'));
    const sync = { domain: 'runtimePrefs', revision: 7, payload: { values: { autonomousMode: true } } };
    send(2, { kind: 'sync', requestId: 'prefs-original', ...sync });
    await waitUntil(() => applyCount === 1);
    send(3, { kind: 'sync', requestId: 'prefs-retry', ...sync });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(frames.some((frame) => frame.kind === 'sync.ack'), false);

    releaseApply();
    await waitUntil(() => frames.filter((frame) => frame.kind === 'sync.ack').length === 2);
    assert.equal(applyCount, 1);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === 'sync.ack').map((frame) => frame.kind === 'sync.ack' && frame.requestId),
      ['prefs-original', 'prefs-retry'],
    );
  } finally {
    releaseApply();
    inbound.destroy();
    outbound.destroy();
  }
});

test('a late analytics rebound after its non-gating timeout is fenced without closing the worker', async () => {
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
  }, { readable: inbound, writable: outbound }, {
    validateBootstrap: () => undefined,
    analyticsSubjectRebindTimeoutMs: 10,
    onFrame: (frame, activeServer) => {
      if (frame.kind !== 'sync') return;
      activeServer.sendFrame({
        kind: 'sync.ack',
        requestId: frame.requestId,
        domain: frame.domain,
        revision: frame.revision,
      });
    },
  });
  server.start();
  const send = (seq: number, body: Record<string, unknown>): void => {
    inbound.write(`${JSON.stringify({ ...frameBase, seq, ...body })}\n`);
  };

  try {
    send(1, { kind: 'bootstrap', heartbeatIntervalMs: 60_000, sdkPatchIdentity });
    await waitUntil(() => frames.some((frame) => frame.kind === 'ready'));

    const rebind = server.requestAnalyticsSubjectRebind({ kind: 'session', rootSessionId: 'replacement-root' });
    await waitUntil(() => frames.some((frame) => frame.kind === 'analytics.rebind'));
    const request = frames.find((frame) => frame.kind === 'analytics.rebind');
    assert.ok(request?.kind === 'analytics.rebind');
    await assert.rejects(rebind, /timed out/);

    send(2, {
      kind: 'analytics.rebound',
      requestId: request.requestId,
      captureSubject: request.captureSubject,
    });
    send(3, { kind: 'sync', requestId: 'post-rebound-sync', domain: 'settings', revision: 1, payload: { values: {} } });
    await waitUntil(() => frames.some((frame) => frame.kind === 'sync.ack'
      && frame.requestId === 'post-rebound-sync'));
    assert.deepEqual(exitCodes, []);
    assert.equal(frames.some((frame) => frame.kind === 'fatal'), false);
  } finally {
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
    onFrame: () => undefined,
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
      lease: { leaseId: 'lease-1', provider: 'fixture', model: 'model', grantedAt: 1, headerWaitMs: 120_000, streamIdleTimeoutMs: 120_000 },
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

    const rejectedPromise = server.requestFrame({
      kind: 'provider.acquire',
      request: { provider: 'fixture', model: 'saturated', turnId: 'turn-3', attemptId: 'attempt-3' },
    }, 'provider.granted', 'saturated-admission');
    await waitUntil(() => frames.some((frame) => frame.kind === 'provider.acquire'
      && frame.requestId === 'saturated-admission'));
    send(4, {
      kind: 'provider.rejected', requestId: 'saturated-admission',
      error: { name: 'ProviderGateSaturatedError', message: 'retry later', retryable: true, httpStatus: 429 },
    });
    await assert.rejects(rejectedPromise, (error: Error & { isRetryable?: boolean; httpStatus?: number }) => {
      assert.equal(error.name, 'ProviderGateSaturatedError');
      assert.equal(error.message, 'retry later');
      assert.equal(error.isRetryable, true);
      assert.equal(error.httpStatus, 429);
      return true;
    });

    send(5, { kind: 'sync', requestId: 'settings-5', domain: 'settings', revision: 5, payload: { values: {} } });
    send(6, { kind: 'sync', requestId: 'catalog-1', domain: 'catalog', revision: 1, payload: { models: [] } });
    await waitUntil(() => frames.filter((frame) => frame.kind === 'sync.ack').length === 2);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === 'sync.ack').map((frame) => frame.kind === 'sync.ack' && [frame.domain, frame.revision]),
      [['settings', 5], ['catalog', 1]],
    );

    send(7, { kind: 'sync', requestId: 'settings-stale', domain: 'settings', revision: 4, payload: { values: {} } });
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

test('worker server close(1) writes one bounded redacted stderr diagnosis', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  outbound.resume();
  const exitCodes: number[] = [];
  let stderr = '';
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
  }, { readable: inbound, writable: outbound }, { validateBootstrap: () => undefined });
  server.start();

  try {
    server.failRuntime(new Error(`authorization=worker-secret ${'x'.repeat(32 * 1024)}`));
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
    assert.match(stderr, /\[pie-worker\] close\(1\):/);
    assert.match(stderr, /authorization=\[redacted\]/);
    assert.doesNotMatch(stderr, /worker-secret/);
    assert.ok(Buffer.byteLength(stderr, 'utf8') <= 9 * 1024, 'worker close diagnosis is bounded');
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});

test('worker server exits when its fatal frame is itself rejected', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: inbound, writable: outbound }, { validateBootstrap: () => undefined });
  server.start();

  try {
    server.failRuntime(new Error('x'.repeat(300 * 1024)));
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});

/** Write target whose descriptor is blocked: every write is recorded and its
 * callback is retained until the test drains it, reproducing the production
 * backpressure window behind which the ordinary queue accumulates. */
class BlockedWorkerWriteTarget {
  destroyed = false;
  writableEnded = false;
  readonly written: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];

  write(data: string, callback: (error?: Error | null) => void): boolean {
    this.written.push(data);
    this.callbacks.push(callback);
    return false;
  }

  once(): this { return this; }

  end(callback?: () => void): this {
    if (callback) callback();
    return this;
  }

  /** Complete every retained write callback; each completion pumps the next
   * queued frame synchronously, so a loop drains the writer completely. */
  drain(): void {
    while (this.callbacks.length > 0) this.callbacks.shift()!(null);
  }
}

type SentRuntimeFrame = WorkerIpcFrame & { event?: string; payload?: { seq?: number } };

function parseFrames(lines: readonly string[]): SentRuntimeFrame[] {
  return lines.map((line) => JSON.parse(line) as SentRuntimeFrame);
}

test('worker server drops a backpressured live.semantic enqueue instead of failing the worker', async () => {
  const inbound = new PassThrough();
  const target = new BlockedWorkerWriteTarget();
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: inbound, writable: target as never }, { validateBootstrap: () => undefined });
  server.start();

  try {
    // Fill the 2 MiB ordinary-lane reserve behind the blocked descriptor.
    const acceptedSeqs: number[] = [];
    let droppedSeq = 0;
    for (let seq = 1; seq <= 24; seq += 1) {
      const ok = server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'x'.repeat(200 * 1024), seq } as never);
      if (!ok) {
        droppedSeq = seq;
        break;
      }
      acceptedSeqs.push(seq);
    }
    assert.ok(droppedSeq >= 4, `the ordinary lane must reach its 2 MiB reserve (dropped at ${droppedSeq})`);
    assert.ok(acceptedSeqs.length >= 3);

    // The dropped envelope must not schedule an exit or fail the runtime.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(exitCodes, []);

    // The lane stays functional: a small semantic envelope and an ordinary
    // non-semantic runtime event are both admitted behind the backlog.
    assert.equal(
      server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'recovered', seq: droppedSeq + 1 } as never),
      true,
    );
    assert.equal(server.sendFrame({
      kind: 'runtime.event',
      event: 'tool.progress',
      payload: { requestId: 'request-1' },
    }), true);

    // Drain the descriptor: everything that was admitted is written in FIFO
    // order with contiguous transport sequences; the dropped envelope is
    // simply absent and no fatal frame is ever queued.
    target.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(exitCodes, []);
    const frames = parseFrames(target.written);
    assert.equal(frames.some((frame) => frame.kind === 'fatal'), false);
    const liveFrames = frames.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'live.semantic');
    assert.deepEqual(
      liveFrames.map((frame) => (frame.payload as { seq?: number }).seq),
      [...acceptedSeqs, droppedSeq + 1],
      'the inner semantic sequence keeps its gap; the worker must not renumber or synthesize',
    );
    assert.deepEqual(frames.map((frame) => frame.seq), Array.from({ length: frames.length }, (_, index) => index + 1),
      'transport sequences stay contiguous across a dropped envelope');
    assert.equal(frames.some((frame) => frame.kind === 'runtime.event' && frame.event === 'tool.progress'), true);
  } finally {
    inbound.destroy();
  }
});

test('worker server drops an oversized live.semantic frame instead of failing the worker', async () => {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const frames: SentRuntimeFrame[] = [];
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

  try {
    // The 256 KiB ordinary-frame ceiling rejects this draft before enqueue.
    assert.equal(
      server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'x'.repeat(300 * 1024), seq: 5 } as never),
      false,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(exitCodes, []);
    assert.equal(frames.some((frame) => frame.kind === 'fatal'), false);

    // The seam remains usable for subsequent bounded envelopes.
    assert.equal(
      server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'ok', seq: 6 } as never),
      true,
    );
    await waitUntil(() => frames.length > 0);
    const liveFrames = frames.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'live.semantic');
    assert.equal(liveFrames.length, 1);
    assert.equal(liveFrames[0]!.payload?.seq, 6,
      'the dropped oversized envelope keeps its semantic seq gap (5 missing)');
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});

test('worker server keeps an invalid live.semantic draft fail-closed', async () => {
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

  try {
    let invalidPayload: Record<string, unknown> = { kind: 'turn.text', delta: 'ok' };
    for (let depth = 0; depth < 70; depth += 1) invalidPayload = { nested: invalidPayload };
    assert.equal(server.sendLiveSemanticFrame(invalidPayload as never), false);
    await waitUntil(() => frames.some((frame) => frame.kind === 'fatal'));
    const fatal = frames.find((frame) => frame.kind === 'fatal');
    assert.ok(fatal?.kind === 'fatal');
    assert.match(fatal.error.message, /rejected \(invalid\)/);
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    inbound.destroy();
    outbound.destroy();
  }
});

test('worker server keeps an unavailable live.semantic enqueue fail-closed', async () => {
  const target = new BlockedWorkerWriteTarget();
  target.destroyed = true;
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: new PassThrough(), writable: target as never }, { validateBootstrap: () => undefined });

  assert.equal(server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'ok' } as never), false);
  await waitUntil(() => exitCodes.length > 0);
  assert.deepEqual(exitCodes, [1]);
});

test('worker server keeps a failed live.semantic write callback fail-closed', async () => {
  const inbound = new PassThrough();
  const target = new BlockedWorkerWriteTarget();
  const exitCodes: number[] = [];
  const server = new WorkerServer(identity, {
    pid: frameBase.workerPid,
    exit: (code = 0) => {
      exitCodes.push(code);
      return undefined as never;
    },
  }, { readable: inbound, writable: target as never }, { validateBootstrap: () => undefined });
  server.start();

  try {
    assert.equal(
      server.sendLiveSemanticFrame({ kind: 'turn.text', delta: 'x'.repeat(200 * 1024), seq: 1 } as never),
      true,
    );
    const failure = new Error('descriptor write failed');
    target.callbacks.shift()!(failure);
    await waitUntil(() => exitCodes.length > 0);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    inbound.destroy();
  }
});

test('the recoverable-drop policy admits only capacity and oversize rejections', () => {
  assert.equal(liveSemanticDroppableRejection('capacity'), true);
  assert.equal(liveSemanticDroppableRejection('oversize'), true);
  assert.equal(liveSemanticDroppableRejection('invalid'), false);
  assert.equal(liveSemanticDroppableRejection('unavailable'), false);
});
