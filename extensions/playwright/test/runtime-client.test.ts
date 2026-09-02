import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PlaywrightRuntimeError, RuntimeClient, RuntimeRegistry } from '../src/runtime-client.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killed = false;
  records: unknown[] = [];
  stdin = { write: (data: string) => { for (const line of data.trim().split('\n')) if (line) this.receive(JSON.parse(line)); return true; } };
  constructor(pid: number, readonly allRecords: unknown[], readonly neverCancel = false) { super(); this.pid = pid; }
  respond(record: unknown) { queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`))); }
  receive(record: any) {
    this.records.push(record); this.allRecords.push({ pid: this.pid, ...record });
    if (record.kind === 'shutdown') { queueMicrotask(() => this.kill()); return; }
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
  kill() { if (this.killed) return false; this.killed = true; queueMicrotask(() => this.emit('close', 1, null)); return true; }
}

function fakeFactory(options: { neverCancel?: boolean } = {}) {
  const children: FakeChild[] = []; const records: unknown[] = [];
  return {
    children, records,
    spawn: () => { const child = new FakeChild(200 + children.length, records, options.neverCancel); children.push(child); return child as never; },
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
  const spawn = () => { const child = new HungShutdown(400 + children.length, fake.records); children.push(child); return child as never; };
  const client = new RuntimeClient(path.join(tmpdir(), 'pw-hung-shutdown.jsonl'), spawn, 25, 20);
  const pending = client.request('hang', {}, { timeoutMs: 10_000 });
  const rejected = assert.rejects(pending, (error: unknown) => (error as PlaywrightRuntimeError).code === 'RUNTIME_REOPEN_REQUIRED');
  await client.shutdown();
  await rejected;
  assert.equal(children[0].killed, true);
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
