import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { killProcessTree, PlaywrightRuntimeError, RuntimeClient, RuntimeRegistry } from '../runtime-client.js';
import { cleanupChildToolRuntimeOwner, createChildToolRuntimeOwner } from '../../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';

const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  records: unknown[] = [];
  stdin = { write: (data: string) => { for (const line of data.trim().split('\n')) if (line) this.receive(JSON.parse(line)); return true; } };
  constructor(pid: number | undefined, readonly allRecords: unknown[], readonly neverCancel = false) { super(); this.pid = pid; }
  respond(record: unknown) { queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`))); }
  receive(record: any) {
    this.records.push(record); this.allRecords.push({ pid: this.pid, ...record });
    if (record.kind === 'shutdown') { queueMicrotask(() => this.exitCleanly()); return; }
    if (record.kind === 'cancel') {
      if (!this.neverCancel) this.respond({ v: 1, kind: 'response', id: record.id, ok: false, error: { code: 'CANCELLED', message: 'cancelled' } });
      return;
    }
    if (record.kind !== 'request') return;
    const { id, method, params } = record;
    if (method === 'hang') return; // never responds
    if (method === 'run_code' && params?.code === 'hang') return; // never responds
    if (method === 'stale') { this.respond({ v: 1, kind: 'response', id: 'old-id', ok: true, result: {} }); return; }
    if (method === 'malformed') { this.respond({ v: 1, kind: 'weird' }); return; }
    if (method === 'fail') { this.respond({ v: 1, kind: 'response', id, ok: false, error: { code: 'STALE_REF', message: 'injected', retryable: true } }); return; }
    this.respond({ v: 1, kind: 'response', id, ok: true, result: { sessionId: params?.sessionId ?? 'echo' } });
  }
  exitCleanly() {
    if (this.killed) return false;
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = null;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
    return true;
  }
  kill() {
    if (this.killed) return false;
    this.killed = true;
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
    this.emit('close', null, 'SIGKILL');
    return true;
  }
}

function fakeFactory(options: { neverCancel?: boolean } = {}) {
  const children: FakeChild[] = []; const records: unknown[] = [];
  return {
    children, records,
    spawn: () => { const child = new FakeChild(undefined, records, options.neverCancel); children.push(child); return child as never; },
  };
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test('runtime starts lazily and round-trips typed results and typed errors', async () => {
  const fake = fakeFactory();
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-lazy.jsonl'), fake.spawn);
  assert.equal(fake.children.length, 0);
  const result = await client.request('observe', { sessionId: 'pw-1' }, { sessionId: 'pw-1' });
  assert.equal(result.sessionId, 'pw-1');
  assert.equal(fake.children.length, 1);
  await assert.rejects(
    () => client.request('fail', {}),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'STALE_REF' && error.retryable === true,
  );
  await client.shutdown();
  assert.equal(fake.children[0].killed, true);
});

test('hang timeout kills sidecar and run_code timeout uses its own code', async () => {
  const fake = fakeFactory();
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-hang.jsonl'), fake.spawn, 25, 25);
  await assert.rejects(
    () => client.request('hang', {}, { timeoutMs: 30 }),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'ACTION_TIMEOUT',
  );
  await waitFor(() => fake.children[0].killed);
  assert.equal(client.state, 'needs_reopen');
  await assert.rejects(
    () => client.request('observe', {}, {}),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_REOPEN_REQUIRED' && /invalid/.test(error.message),
  );
  // open is allowed while needs_reopen and clears the gate only via markReopened.
  await client.request('open', { sessionId: 'fresh' }, { sessionId: 'fresh', allowNeedsReopen: true });
  client.markReopened();
  assert.equal(client.state, 'ready');

  await assert.rejects(
    () => client.request('run_code', { sessionId: 'fresh', code: 'hang' }, { sessionId: 'fresh', timeoutMs: 30 }),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUN_CODE_TIMEOUT',
  );
  await client.shutdown();
});

test('cancellation sends a cancel frame, and an unresponsive sidecar is force-terminated after the grace period', async () => {
  const fake = fakeFactory();
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-cancel.jsonl'), fake.spawn, 25, 25);
  const controller = new AbortController();
  const pending = client.request('hang', {}, { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'CANCELLED');
  assert.ok(fake.records.some((record) => (record as { kind?: string }).kind === 'cancel'));
  assert.equal(fake.children[0].killed, false, 'responsive cancel leaves the sidecar alive');
  assert.equal(client.state, 'ready');
  await client.shutdown();

  const stuckFake = fakeFactory({ neverCancel: true });
  const stuck = new RuntimeClient(path.join(tmpdir(), 'pw-cancel-stuck.jsonl'), stuckFake.spawn, 25, 25);
  const abortStuck = new AbortController();
  const stuckPending = stuck.request('hang', {}, { signal: abortStuck.signal, timeoutMs: 5000 });
  abortStuck.abort();
  await assert.rejects(stuckPending, (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'CANCELLED');
  await waitFor(() => stuckFake.children[0].killed, 1000);
  assert.equal(stuck.state, 'needs_reopen');
  await assert.rejects(() => stuck.request('observe', {}, {}), (error: unknown) => (error as PlaywrightRuntimeError).code === 'RUNTIME_REOPEN_REQUIRED');
  await stuck.shutdown();
});

test('malformed and stale sidecar records are protocol errors that isolate the runtime', async () => {
  const fake = fakeFactory();
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-protocol.jsonl'), fake.spawn, 25, 25);
  await assert.rejects(() => client.request('malformed', {}, { timeoutMs: 1000 }), (error: unknown) => (error as PlaywrightRuntimeError).code === 'SIDECAR_PROTOCOL_ERROR');
  await waitFor(() => client.state === 'needs_reopen');
  await client.request('open', { sessionId: 's' }, { allowNeedsReopen: true });
  client.markReopened();
  await assert.rejects(() => client.request('stale', {}, { timeoutMs: 1000 }), (error: unknown) => (error as PlaywrightRuntimeError).code === 'SIDECAR_PROTOCOL_ERROR');
  await client.shutdown();
});

test('close is permitted while needs_reopen so runtimes can always be torn down', async () => {
  const fake = fakeFactory();
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-close.jsonl'), fake.spawn, 25, 25);
  await assert.rejects(() => client.request('hang', {}, { timeoutMs: 20 }), (error: unknown) => (error as PlaywrightRuntimeError).code === 'ACTION_TIMEOUT');
  const result = await client.request('close', { scope: 'runtime' }, { allowNeedsReopen: true });
  assert.equal(fake.children.length, 2, 'close after runtime loss spawns a fresh sidecar that closes nothing');
  assert.equal(result.sessionId, 'echo');
  await client.shutdown();
});

test('shutdown rejects in-flight requests and hung shutdown force-kills the child', async () => {
  const fake = fakeFactory();
  class HungShutdown extends FakeChild {
    override receive(record: any) {
      if (record.kind === 'shutdown') return; // never exits
      super.receive(record);
    }
  }
  const children: FakeChild[] = [];
  const spawn = () => { const child = new HungShutdown(undefined, fake.records); children.push(child); return child as never; };
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-hung-shutdown.jsonl'), spawn, 25, 20);
  const pending = client.request('hang', {}, { timeoutMs: 10_000 });
  const rejected = assert.rejects(pending, (error: unknown) => (error as PlaywrightRuntimeError).code === 'RUNTIME_REOPEN_REQUIRED');
  await client.shutdown();
  await rejected;
  assert.equal(children[0].killed, true);
});

test('graceful shutdown rejects a sidecar exit that does not confirm cleanup', async () => {
  class FailedShutdown extends FakeChild {
    override receive(record: any) {
      if (record.kind === 'shutdown') {
        this.killed = true;
        this.exitCode = 1;
        queueMicrotask(() => {
          this.emit('exit', 1, null);
          this.emit('close', 1, null);
        });
        return;
      }
      super.receive(record);
    }
  }
  const children: FailedShutdown[] = [];
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-failed-graceful-shutdown.jsonl'), () => {
    const child = new FailedShutdown(undefined, []);
    children.push(child);
    return child as never;
  }, 25, 15);
  await client.request('ping', {});
  await assert.rejects(
    () => client.shutdown(),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
  );
  assert.equal(children[0]!.exitCode, 1);
  await assert.rejects(
    () => client.shutdown(),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
  );
});

test('Windows tree-kill failure remains unresolved even when the sidecar fallback exits', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const taskkill = new EventEmitter() as EventEmitter & { kill(): boolean };
    taskkill.kill = () => true;
    const spawnMock = t.mock.method(childProcess, 'spawn', (() => {
      queueMicrotask(() => taskkill.emit('close', 1, null));
      return taskkill as never;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    const child = new FakeChild(700, []);
    await assert.rejects(
      () => killProcessTree(child as never, 100),
      (error: unknown) => error instanceof PlaywrightRuntimeError
        && error.code === 'RUNTIME_CLEANUP_UNRESOLVED'
        && /tree termination failed/i.test(error.message),
    );
    assert.equal(child.killed, true, 'direct sidecar termination remains the fallback');
    await assert.rejects(
      () => killProcessTree(child as never, 100),
      (error: unknown) => error instanceof PlaywrightRuntimeError
        && error.code === 'RUNTIME_CLEANUP_UNRESOLVED'
        && /tree termination failed/i.test(error.message),
      'a later retry preserves the failed descendant evidence after sidecar exit',
    );
    assert.equal(spawnMock.mock.callCount(), 1, 'an exited sidecar PID is never reused for another taskkill');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
  }
});

test('unsupported host direct sidecar exit does not claim descendant cleanup', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    const child = new FakeChild(7125, []);
    await assert.rejects(
      () => killProcessTree(child as never, 100),
      (error: unknown) => error instanceof PlaywrightRuntimeError
        && error.code === 'RUNTIME_CLEANUP_UNRESOLVED'
        && /unsupported on linux/i.test(error.message),
    );
    assert.equal(child.killed, true, 'direct termination is still attempted without claiming descendant cleanup');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('unresolved child runtime cleanup remains fenced and retained across shutdown retries', async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const taskkill = new EventEmitter() as EventEmitter & { kill(): boolean };
    taskkill.kill = () => true;
    const spawnMock = t.mock.method(childProcess, 'spawn', (() => {
      queueMicrotask(() => taskkill.emit('close', 1, null));
      return taskkill as never;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();

    class ShutdownUnresponsive extends FakeChild {
      override receive(record: any) {
        if (record.kind === 'shutdown') return;
        super.receive(record);
      }
    }
    const children: ShutdownUnresponsive[] = [];
    const registry = new RuntimeRegistry(() => {
      const child = new ShutdownUnresponsive(7124, []);
      children.push(child);
      return child as never;
    });
    const owner = createChildToolRuntimeOwner('unresolved Playwright child');
    const client = registry.getForChild(owner) as RuntimeClient;
    (client as unknown as { shutdownTimeoutMs: number }).shutdownTimeoutMs = 20;
    await client.request('ping', {});

    await assert.rejects(
      () => cleanupChildToolRuntimeOwner(owner),
      (error: unknown) => error instanceof AggregateError
        && /cleanup remains unresolved/i.test(error.message),
    );
    assert.equal(owner.state, 'closing', 'the failed owner remains fenced until cleanup is confirmed');
    assert.equal(registry.size, 1, 'the child runtime stays retained until cleanup is confirmed');
    assert.equal(children[0]!.killed, true);
    await assert.rejects(
      () => client.shutdown(),
      (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
    );
    assert.equal(spawnMock.mock.callCount(), 1, 'shutdown retries do not target the exited sidecar PID again');
    assert.equal(registry.size, 1, 'a failed retry still retains the child runtime record');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform);
  }
});

test('forced cleanup reports unresolved when kill does not produce a confirmed exit', async () => {
  class UnresponsiveChild extends FakeChild {
    override receive(record: any) {
      if (record.kind === 'shutdown') return;
      super.receive(record);
    }
    override kill() { this.killed = true; return true; }
  }
  const children: UnresponsiveChild[] = [];
  const spawn = () => { const child = new UnresponsiveChild(500 + children.length, []); child.pid = undefined; children.push(child); return child as never; };
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-unresolved-cleanup.jsonl'), spawn, 25, 15);
  await client.request('ping', {});

  await assert.rejects(
    () => client.shutdown(),
    (error: unknown) => error instanceof PlaywrightRuntimeError
      && error.code === 'RUNTIME_CLEANUP_UNRESOLVED'
      && /cleanup remains unresolved/i.test(error.message),
  );
  assert.equal(children[0].killed, true);
  await assert.rejects(
    () => client.shutdown(),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
    'a later shutdown cannot claim success while the sidecar still has not exited',
  );
});

test('timeout recovery rejects with unresolved cleanup instead of claiming the runtime restarted', async () => {
  class UnresponsiveChild extends FakeChild {
    override kill() { this.killed = true; return true; }
  }
  const children: UnresponsiveChild[] = [];
  const spawn = () => { const child = new UnresponsiveChild(600 + children.length, []); child.pid = undefined; children.push(child); return child as never; };
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-unresolved-recovery.jsonl'), spawn, 25, 15);

  await assert.rejects(
    () => client.request('hang', {}, { timeoutMs: 5 }),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
  );
  assert.equal(children[0].killed, true);
  await assert.rejects(
    () => client.request('open', {}, { allowNeedsReopen: true }),
    (error: unknown) => error instanceof PlaywrightRuntimeError && error.code === 'RUNTIME_CLEANUP_UNRESOLVED',
  );
});

test('two canonical pie session paths own isolated sidecars; shutdown only removes the owning runtime', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-isolation-'));
  const fake = fakeFactory();
  const registry = new RuntimeRegistry(fake.spawn);
  try {
    const a = path.join(dir, 'a.jsonl'); const b = path.join(dir, 'b.jsonl');
    await writeFile(a, ''); await writeFile(b, '');
    const clientA = await registry.get(a); const clientB = await registry.get(b);
    assert.notEqual(clientA, clientB);
    await clientA.request('ping', {}); await clientB.request('ping', {});
    assert.equal(fake.children.length, 2);
    await registry.shutdownSession(a);
    assert.equal(registry.size, 1);
    assert.equal(fake.children[1].killed, false);
    await clientB.request('ping', {});
    await registry.shutdownAll();
    assert.equal(fake.children[1].killed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('default client launches the colocated JSONL sidecar and shuts it down cleanly', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-sidecar-smoke-'));
  const client = new RuntimeClient(path.join(dir, 'session.jsonl'));
  try {
    assert.deepEqual(await client.request('ping', {}, { timeoutMs: 10_000 }), {});
    assert.ok(client.pid);
    await client.shutdown();
    assert.equal(client.state, 'stopped');
    assert.equal(client.pid, undefined);
  } finally {
    await client.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
