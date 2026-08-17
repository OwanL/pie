import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { WorkerClientOptions, WorkerClientScheduler, WorkerClientSnapshot } from '../../../src/backend/worker-client';
import { WorkerSupervisor, type SupervisedWorkerClient } from '../../../src/backend/worker-supervisor';
import type { WorkerResponseResult } from '../../../src/backend/worker-protocol';

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

const sdkPatchIdentity = {
  identityVersion: 3 as const,
  sdkPath: '/sdk',
  sdkVersion: 'fixture',
  terminalDurability: { patchVersion: 1, relativePath: 'agent.js', sha256: 'a'.repeat(64) },
  retryClassifier: { patchVersion: 1, relativePath: 'retry.js', sha256: 'b'.repeat(64) },
  coldCreateDurability: { patchVersion: 2, relativePath: 'session-manager.js', sha256: 'c'.repeat(64) },
  sessionOwnershipAdapter: { patchVersion: 1, relativePath: 'session-manager.js', sha256: 'c'.repeat(64) },
  sessionReplacementAdapter: { patchVersion: 7, relativePath: 'agent-session-runtime.js', sha256: 'd'.repeat(64) },
};

async function createHarness() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-supervisor-'));
  const artifact = path.join(temp, 'worker-entry.js');
  await fs.writeFile(artifact, '// fixture');
  const clock = new FakeClock();
  const clients: FakeClient[] = [];
  const supervisor = new WorkerSupervisor({
    workerEntryPath: artifact,
    coordinatorGeneration: 1,
    sdkPatchIdentity,
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
