import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { createSyntheticSourceTestSdkRuntime } from '../../../test/fixtures/sdk-runtime-selection.js';
import type { WorkerClientOptions, WorkerClientScheduler, WorkerClientSnapshot } from '../../rpc/worker-client.js';
import { WorkerSupervisor, type SupervisedWorkerClient } from '../worker-supervisor.js';
import type { WorkerResponseResult } from '../../rpc/worker-protocol.js';

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
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.current).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

class FakeClient implements SupervisedWorkerClient {
  readonly interruptResult = pending<WorkerResponseResult>();
  readonly exitResult = pending<{ code: number | null; signal: NodeJS.Signals | null }>();
  forceKills = 0;
  shutdownCalls = 0;
  started = false;
  constructor(readonly options: WorkerClientOptions) {}
  async start(): Promise<{ mode: 'phase2'; startedAt: number }> { this.started = true; return { mode: 'phase2', startedAt: 1 }; }
  async ping(): Promise<WorkerResponseResult> { return { kind: 'pong' }; }
  interrupt(): Promise<WorkerResponseResult> { return this.interruptResult.promise; }
  async shutdown(): Promise<WorkerResponseResult> { this.shutdownCalls += 1; return { kind: 'shutting-down' }; }
  async forceKill(): Promise<void> { this.forceKills += 1; this.exitResult.resolve({ code: null, signal: 'SIGKILL' }); }
  waitForConfirmedExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> { return this.exitResult.promise; }
  getSnapshot(): WorkerClientSnapshot { return { status: 'ready', pid: 1234, stdoutTail: '', stderrTail: '' }; }
}

const sdkRuntime = createSyntheticSourceTestSdkRuntime(path.resolve('/sdk'));

async function createHarness() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-supervisor-'));
  const artifact = path.join(temp, 'worker-entry.js');
  await fs.writeFile(artifact, '// fixture');
  const clock = new FakeClock();
  const clients: FakeClient[] = [];
  const supervisor = new WorkerSupervisor({
    workerEntryPath: artifact,
    coordinatorGeneration: 1,
    sdkRuntime,
    scheduler: clock,
    softInterruptGraceMs: 100,
    shutdownGraceMs: 100,
    exitConfirmationMs: 100,
    clientFactory: (options) => {
      const client = new FakeClient(options);
      clients.push(client);
      return client;
    },
  });
  await supervisor.initialize();
  return { temp, clock, clients, supervisor };
}

test('fake clock escalates a missed soft-interrupt grace to tree kill without replay', async () => {
  const harness = await createHarness();
  try {
    await harness.supervisor.startWorker('/session-a.jsonl');
    const interrupt = harness.supervisor.interrupt('/session-a.jsonl', 'request-a', 'user');
    harness.clock.advance(101);
    assert.deepEqual(await interrupt, { soft: false });
    assert.equal(harness.clients[0]?.forceKills, 1);
    assert.equal(harness.supervisor.getWorker('/session-a.jsonl'), undefined);
    assert.equal(harness.clients.length, 1, 'forced interruption never auto-replays into a replacement');
  } finally {
    await harness.supervisor.dispose().catch(() => undefined);
    await fs.rm(harness.temp, { recursive: true, force: true });
  }
});

test('restart waits for confirmed old exit and advances the worker generation', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.supervisor.startWorker('/session-a.jsonl');
    const restart = harness.supervisor.restartWorker('/session-a.jsonl');
    await Promise.resolve();
    assert.equal(harness.clients.length, 1, 'replacement is not forked before old exit confirmation');
    harness.clients[0]!.exitResult.resolve({ code: 0, signal: null });
    const second = await restart;
    assert.equal(harness.clients.length, 2);
    assert.equal(second.workerGeneration, first.workerGeneration + 1);
    harness.clients[1]!.exitResult.resolve({ code: 0, signal: null });
  } finally {
    await harness.supervisor.dispose().catch(() => undefined);
    await fs.rm(harness.temp, { recursive: true, force: true });
  }
});

test('concurrent and subsequent disposal callers share failed cleanup and retain the owning generation', async () => {
  const harness = await createHarness();
  try {
    const worker = await harness.supervisor.startWorker('/session-a.jsonl');
    const client = harness.clients[0]!;
    const deathCheck = pending<{ code: number | null; signal: NodeJS.Signals | null }>();
    client.waitForConfirmedExit = async () => {
      await deathCheck.promise;
      throw new Error('exit remains unconfirmed');
    };
    client.forceKill = async () => { client.forceKills += 1; };
    const first = harness.supervisor.dispose();
    const second = harness.supervisor.dispose();
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    const firstRejected = assert.rejects(first, /could not confirm exit for 1 worker/);
    const secondRejected = assert.rejects(second, /could not confirm exit for 1 worker/);
    await Promise.resolve();
    assert.equal(secondSettled, false, 'concurrent disposal must wait for the same death confirmation');
    assert.equal(client.shutdownCalls, 1);
    deathCheck.resolve({ code: null, signal: null });
    await Promise.all([firstRejected, secondRejected]);
    await assert.rejects(harness.supervisor.dispose(), /could not confirm exit for 1 worker/);
    assert.equal(harness.supervisor.getWorker('/session-a.jsonl'), worker, 'uncertain death retains generation ownership');
    await assert.rejects(harness.supervisor.startWorker('/session-a.jsonl'), /disposed/);
    assert.equal(client.shutdownCalls, 1, 'later disposal replays failure, not a second cleanup');
    assert.equal(client.forceKills, 1);
  } finally {
    await harness.supervisor.dispose().catch(() => undefined);
    await fs.rm(harness.temp, { recursive: true, force: true });
  }
});

test('disposal fences a start awaiting ownership preparation before constructing a child', async () => {
  const harness = await createHarness();
  const preparation = pending<{ leasePath: string; leaseRevision: number }>();
  let prepared = false;
  let cleaned = false;
  try {
    // Ownership belongs to the caller, as in the router's failed-promotion
    // hook: stop any child first, then reconcile the prepared lease.
    const start = harness.supervisor.startWorker('/session-a.jsonl', async () => {
      const assignment = await preparation.promise;
      prepared = true;
      return assignment;
    }).catch(async (error) => {
      await harness.supervisor.stopWorker('/canonical-session-a.jsonl', 'failed promotion');
      assert.equal(prepared, true);
      cleaned = true;
      throw error;
    });
    const rejected = assert.rejects(start, /disposed/);
    await harness.supervisor.dispose();
    assert.equal(harness.clients.length, 0);
    preparation.resolve({ leasePath: '/canonical-session-a.jsonl', leaseRevision: 2 });
    await rejected;
    assert.equal(cleaned, true, 'rejection reaches caller-owned lease cleanup');
    assert.equal(harness.clients.length, 0, 'no client is constructed after disposal');
    assert.deepEqual(harness.supervisor.listWorkers(), []);
    await assert.rejects(harness.supervisor.startWorker('/session-b.jsonl'), /disposed/);
    await harness.supervisor.dispose();
  } finally {
    await harness.supervisor.dispose().catch(() => undefined);
    await fs.rm(harness.temp, { recursive: true, force: true });
  }
});

test('disposal also fences a start without an ownership callback across its await', async () => {
  const harness = await createHarness();
  try {
    const start = harness.supervisor.startWorker('/session-a.jsonl');
    const rejected = assert.rejects(start, /disposed/);
    await harness.supervisor.dispose();
    await rejected;
    assert.equal(harness.clients.length, 0);
    assert.deepEqual(harness.supervisor.listWorkers(), []);
  } finally {
    await harness.supervisor.dispose().catch(() => undefined);
    await fs.rm(harness.temp, { recursive: true, force: true });
  }
});

test('mcpConfigPathFor resolves the per-session MCP override path at spawn time', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-supervisor-mcp-'));
  let supervisor: WorkerSupervisor | undefined;
  try {
    const artifact = path.join(temp, 'worker-entry.js');
    await fs.writeFile(artifact, '// fixture');
    const clock = new FakeClock();
    const clients: FakeClient[] = [];
    const overridePaths: Record<string, string> = {
      '/session-with-override.jsonl': path.join(temp, 'with.mcp-overrides.json'),
    };
    supervisor = new WorkerSupervisor({
      workerEntryPath: artifact,
      coordinatorGeneration: 1,
      sdkRuntime,
      scheduler: clock,
      softInterruptGraceMs: 100,
      shutdownGraceMs: 100,
      exitConfirmationMs: 100,
      mcpConfigPathFor: (sessionPath) => overridePaths[sessionPath],
      clientFactory: (options) => {
        const client = new FakeClient(options);
        clients.push(client);
        return client;
      },
    });
    await supervisor.initialize();

    await supervisor.startWorker('/session-with-override.jsonl');
    assert.equal((clients[0]?.options as WorkerClientOptions).mcpConfigPath, overridePaths['/session-with-override.jsonl'],
      'a session with an override artifact spawns with --mcp-config material');

    await supervisor.startWorker('/session-plain.jsonl');
    for (const client of clients) {
      client.exitResult.resolve({ code: 0, signal: null });
    }
    assert.equal((clients[1]?.options as WorkerClientOptions).mcpConfigPath, undefined,
      'a session without overrides falls back to default config discovery');
    assert.ok(clients[1]?.options);
  } finally {
    await supervisor?.dispose().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
