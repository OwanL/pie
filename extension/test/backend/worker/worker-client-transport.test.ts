import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

import { WorkerClient, type WorkerClientScheduler } from '../../../src/backend/worker-client';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/phase2-worker-fixture.mjs');
const sdkPatchIdentity = {
  identityVersion: 3 as const,
  sdkPath: path.resolve('extension/node_modules/@earendil-works/pi-coding-agent'),
  sdkVersion: 'fixture',
  terminalDurability: { patchVersion: 1, relativePath: 'dist/core/agent-session.js', sha256: 'a'.repeat(64) },
  retryClassifier: { patchVersion: 1, relativePath: 'dist/utils/retry.js', sha256: 'b'.repeat(64) },
  coldCreateDurability: { patchVersion: 2, relativePath: 'dist/core/session-manager.js', sha256: 'c'.repeat(64) },
  sessionOwnershipAdapter: { patchVersion: 1, relativePath: 'dist/core/session-manager.js', sha256: 'c'.repeat(64) },
  sessionReplacementAdapter: { patchVersion: 7, relativePath: 'dist/core/agent-session-runtime.js', sha256: 'd'.repeat(64) },
};

class FakeClock implements WorkerClientScheduler {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.current; }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete(timer as unknown as number); }
  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.current) { this.timers.delete(id); timer.callback(); }
    }
  }
}

function createClient(mode: string, extra: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}): WorkerClient {
  return new WorkerClient({
    workerEntryPath: fixture,
    coordinatorGeneration: 1,
    workerId: `fixture-${mode}`,
    workerGeneration: 1,
    sessionPath: path.resolve(`session-${mode}.jsonl`),
    sdkPatchIdentity,
    heartbeatIntervalMs: 1_000,
    startupTimeoutMs: 5_000,
    diagnosticByteLimit: 1_024,
    env: { PIE_WORKER_FIXTURE_MODE: mode },
    ...extra,
  });
}

async function cleanup(client: WorkerClient): Promise<void> {
  if (client.getSnapshot().status === 'exited') return;
  await client.forceKill().catch(() => undefined);
  await client.waitForConfirmedExit(5_000).catch(() => undefined);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for process condition.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('worker client inherited-FD integration', { concurrency: false }, () => {
test('real inherited-FD transport keeps JSON-looking, partial, and bounded-large stdout/stderr diagnostic-only', async () => {
  const client = createClient('noise');
  try {
    await client.start();
    assert.deepEqual(await client.ping(), { kind: 'pong' });
    const snapshot = client.getSnapshot();
    assert.ok(Buffer.byteLength(snapshot.stdoutTail) <= 1_024);
    assert.ok(Buffer.byteLength(snapshot.stderrTail) <= 1_024);
    assert.match(snapshot.stdoutTail, /STDOUT-END$/);
    assert.match(snapshot.stderrTail, /STDERR-END$/);
    assert.deepEqual(await client.shutdown('test complete'), { kind: 'shutting-down' });
    await client.waitForConfirmedExit(5_000);
  } finally {
    await cleanup(client);
  }
});

test('missed heartbeat transitions to unresponsive without blocking correlated control', async () => {
  const clock = new FakeClock();
  const client = createClient('noise', { scheduler: clock, missedHeartbeatMs: 50 });
  try {
    await client.start();
    clock.advance(51);
    assert.equal(client.getSnapshot().status, 'unresponsive');
    assert.deepEqual(await client.ping(), { kind: 'pong' });
    assert.deepEqual(await client.shutdown('heartbeat test complete'), { kind: 'shutting-down' });
    await client.waitForConfirmedExit(5_000);
  } finally {
    await cleanup(client);
  }
});

test('generic Phase 4 callbacks and dedicated response correlation share the bounded transport', async () => {
  const frames: string[] = [];
  const sessionPath = path.resolve('session-phase4.jsonl');
  const client = createClient('phase4', {
    sessionPath,
    onFrame: (frame) => {
      frames.push(frame.kind);
      if (frame.kind === 'provider.acquire') {
        assert.equal(client.sendFrame({
          kind: 'provider.granted',
          requestId: frame.requestId,
          lease: { leaseId: 'coordinator-lease-1', provider: frame.request.provider, model: frame.request.model, grantedAt: 1 },
        }), true);
      }
    },
  });
  try {
    await client.start();
    const runtimeReady = await client.requestFrame({
      kind: 'runtime.promote',
      operationId: 'operation-1',
      payload: {
        sdkPath: sdkPatchIdentity.sdkPath,
        agentDir: path.resolve('agent'),
        startupCwd: process.cwd(),
        sessionDir: path.resolve('sessions'),
        sessionPath,
        creationReason: 'resume',
        writeLease: {
          coordinatorGeneration: 1,
          workerId: 'fixture-phase4',
          workerGeneration: 1,
          canonicalSessionPath: sessionPath,
          ownershipRevision: 1,
          nonce: 'lease',
        },
        openedPayload: { runtimeReady: false },
        modelSettings: { defaultModel: 'fixture' },
      },
    }, 'runtime.ready');
    assert.equal(runtimeReady.runtimeMetadata.mode, 'phase4');
    const commandResponse = await client.requestFrame({
      kind: 'runtime.command',
      operation: 'message.send',
      payload: { params: { text: 'hello' }, publicRequestId: 'public-command' },
    }, 'response');
    assert.equal(commandResponse.ok && commandResponse.result.kind === 'runtime.command'
      ? commandResponse.result.payload && (commandResponse.result.payload as { acceptedOperation?: string }).acceptedOperation
      : undefined, 'message.send');
    const settingsAck = await client.requestFrame({
      kind: 'sync',
      domain: 'settings',
      revision: 7,
      payload: { values: { defaultModel: 'fixture' } },
    }, 'sync.ack');
    assert.deepEqual({ domain: settingsAck.domain, revision: settingsAck.revision }, { domain: 'settings', revision: 7 });
    await waitUntil(() => frames.includes('runtime.event'));
    assert.deepEqual(frames, ['provider.acquire', 'runtime.event']);
  } finally {
    await cleanup(client);
  }
});

test('real inherited-FD transport drops a stale sequence without poisoning later response correlation', async () => {
  const client = createClient('stale');
  try {
    await client.start();
    assert.deepEqual(await client.ping(), { kind: 'pong' });
  } finally {
    await cleanup(client);
  }
});

test('real inherited-FD transport fails closed on a mismatched correlated response variant', async () => {
  const client = createClient('mismatched-response');
  try {
    await client.start();
    await assert.rejects(client.ping(), /returned interrupted; expected pong/);
    await client.waitForConfirmedExit(5_000);
  } finally {
    await cleanup(client);
  }
});

test('real inherited-FD transport fails closed on an uncorrelated response', async () => {
  const client = createClient('unknown-response');
  try {
    await client.start();
    await assert.rejects(client.ping(), /unknown requestId/);
    await client.waitForConfirmedExit(5_000);
  } finally {
    await cleanup(client);
  }
});

test('valid ready JSON without LF is never dispatched at EOF and fails worker readiness', async () => {
  const client = createClient('eof-ready');
  try {
    await assert.rejects(client.start(), /LF delimiter/);
    await client.waitForConfirmedExit(5_000);
    assert.equal(client.getSnapshot().status, 'exited');
    assert.match(client.getSnapshot().failure ?? '', /LF delimiter/);
  } finally {
    await cleanup(client);
  }
});

test('valid response JSON without LF is never settled at EOF and fails the worker generation', async () => {
  const client = createClient('eof-response');
  try {
    await client.start();
    await assert.rejects(client.ping(), /LF delimiter/);
    await client.waitForConfirmedExit(5_000);
    assert.equal(client.getSnapshot().status, 'exited');
    assert.match(client.getSnapshot().failure ?? '', /LF delimiter/);
  } finally {
    await cleanup(client);
  }
});

for (const mode of ['malformed', 'gap', 'oversize', 'raw-fd-oversize', 'close'] as const) {
  test(`real inherited-FD transport fails the worker generation on ${mode} IPC`, async () => {
    const client = createClient(mode);
    try {
      await assert.rejects(client.start(), /(Worker|worker) (protocol|IPC)|Malformed worker IPC|before process exit/);
      await client.waitForConfirmedExit(5_000);
      assert.equal(client.getSnapshot().status, 'exited');
    } finally {
      await cleanup(client);
    }
  });
}

for (const scenario of ['graceful', 'crash'] as const) {
  test(`${scenario} worker exit removes a real descendant process tree`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), `pie-worker-tree-${scenario}-`));
    const marker = path.join(temp, 'descendant.pid');
    const mode = scenario === 'crash' ? 'crash-descendant' : 'descendant';
    const client = createClient(mode, { env: { PIE_WORKER_FIXTURE_MODE: mode, PIE_WORKER_DESCENDANT_MARKER: marker } });
    let descendantPid: number | undefined;
    try {
      await client.start();
      await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the runtime must spawn its descendant after readiness');
      // Windows process spawn + marker write need generous headroom under
      // full-suite load; the causal ordering is what the test proves.
      await waitUntil(() => {
        try { descendantPid = Number(require('node:fs').readFileSync(marker, 'utf8')); return Number.isSafeInteger(descendantPid); } catch { return false; }
      }, 15_000);
      assert.ok(descendantPid, 'the post-ready runtime descendant PID was recorded before the crash');
      if (scenario === 'graceful') {
        assert.equal(isAlive(descendantPid), true);
        assert.deepEqual(await client.shutdown('graceful tree test'), { kind: 'shutting-down' });
      }
      await client.waitForConfirmedExit(8_000);
      await waitUntil(() => !isAlive(descendantPid!), 15_000);
    } finally {
      await cleanup(client);
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
}

test('forced worker termination removes a real descendant process tree', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-worker-tree-'));
  const marker = path.join(temp, 'descendant.pid');
  const client = createClient('descendant', { env: { PIE_WORKER_FIXTURE_MODE: 'descendant', PIE_WORKER_DESCENDANT_MARKER: marker } });
  let descendantPid: number | undefined;
  try {
    await client.start();
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'the runtime must spawn its descendant after readiness');
    await waitUntil(() => {
      try { descendantPid = Number(require('node:fs').readFileSync(marker, 'utf8')); return Number.isSafeInteger(descendantPid); } catch { return false; }
    }, 15_000);
    assert.ok(descendantPid && isAlive(descendantPid));
    await client.forceKill();
    await client.waitForConfirmedExit(5_000);
    await waitUntil(() => !isAlive(descendantPid!), 15_000);
  } finally {
    await cleanup(client);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
});
