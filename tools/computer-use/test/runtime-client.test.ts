import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RuntimeClient, RuntimeRegistry } from '../src/runtime-client.js';

interface FakeBehavior { hangEmergency: boolean; failedKeys: Set<string>; failedButtons: Set<string> }

class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); pid: number; killed = false; records: any[] = [];
  stdin = { write: (data: string) => { for (const line of data.trim().split('\n')) if (line) this.receive(JSON.parse(line)); return true; } };
  constructor(pid: number, readonly allRecords: any[], readonly behavior: FakeBehavior, readonly hangShutdown = false) { super(); this.pid = pid; }
  respond(record: any) { queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`))); }
  receive(record: any) {
    this.records.push(record); this.allRecords.push({ pid: this.pid, ...record });
    if (record.kind === 'shutdown') { if (!this.hangShutdown) queueMicrotask(() => this.kill()); return; }
    if (record.kind === 'cancel') { this.respond({ v: 1, kind: 'response', id: record.id, ok: false, error: { code: 'CANCELLED', message: 'cancelled', held: { keys: [], buttons: [] } } }); return; }
    if (record.kind !== 'request') return;
    const { id, method, params } = record;
    if (method === 'hang') return;
    if (method === 'stale') { this.respond({ v: 1, kind: 'response', id: 'old-id', ok: true, result: {} }); return; }
    if (method === 'fail') { this.respond({ v: 1, kind: 'response', id, ok: false, error: { code: 'REQUEST_FAILED', message: 'injected' } }); return; }
    if (method === 'fail_with_held') { this.respond({ v: 1, kind: 'response', id, ok: false, error: { code: 'RELEASE_FAILED', message: 'injected', held: params.held } }); return; }
    if (method === 'act') {
      if (params.input?.kind === 'wait') return;
      const keys = params.input?.kind === 'key_down' ? [params.input.key] : [];
      this.respond({ v: 1, kind: 'response', id, ok: true, result: { sessionId: params.sessionId, held: { keys, buttons: [] } } }); return;
    }
    if (method === 'open') { this.respond({ v: 1, kind: 'response', id, ok: true, result: { sessionId: params.sessionId, targetId: 't', held: { keys: [], buttons: [] } } }); return; }
    if (method === 'release_all') {
      const held = this.remaining(params.held); this.respond({ v: 1, kind: 'response', id, ok: true, result: { sessionId: params.sessionId, held } }); return;
    }
    if (method === 'emergency_release') {
      if (this.behavior.hangEmergency) return;
      const heldBySession = params.heldBySession.map((item: any) => ({ sessionId: item.sessionId, held: this.remaining(item.held) }));
      const held = {
        keys: [...new Set(heldBySession.flatMap((item: any) => item.held.keys))],
        buttons: [...new Set(heldBySession.flatMap((item: any) => item.held.buttons))],
      };
      this.respond({ v: 1, kind: 'response', id, ok: true, result: { held, heldBySession } }); return;
    }
    this.respond({ v: 1, kind: 'response', id, ok: true, result: { held: { keys: [], buttons: [] } } });
  }
  remaining(held: any) {
    return {
      keys: (held?.keys ?? []).filter((key: string) => this.behavior.failedKeys.has(key)),
      buttons: (held?.buttons ?? []).filter((button: string) => this.behavior.failedButtons.has(button)),
    };
  }
  kill() { if (this.killed) return false; this.killed = true; queueMicrotask(() => this.emit('close', 1, null)); return true; }
}

function fakeFactory(options: { hangFirstShutdown?: boolean; hangEmergency?: boolean; failedKeys?: string[]; failedButtons?: string[] } = {}) {
  const children: FakeChild[] = []; const records: any[] = [];
  const behavior: FakeBehavior = { hangEmergency: options.hangEmergency === true, failedKeys: new Set(options.failedKeys), failedButtons: new Set(options.failedButtons) };
  return {
    children, records, behavior,
    spawn: () => { const child = new FakeChild(100 + children.length, records, behavior, options.hangFirstShutdown === true && children.length === 0); children.push(child); return child as any; },
  };
}
async function waitFor(predicate: () => boolean, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test('runtime starts lazily and cancellation clears cumulative and in-flight potential held state', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-a.jsonl', fake.spawn);
  assert.equal(fake.children.length, 0);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  assert.equal(fake.children.length, 1); assert.deepEqual(client.getHeld('s').keys, ['W']);
  const controller = new AbortController();
  const pending = client.request('act', { sessionId: 's', input: { kind: 'wait' } }, { sessionId: 's', potential: { keys: [], buttons: ['left'] }, signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, (error: any) => error.code === 'CANCELLED');
  assert.deepEqual(client.getHeld('s'), { keys: [], buttons: [] });
  await client.shutdown();
});

test('error held state is authoritative while errors without held state conservatively merge acknowledged and potential input', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-error-held.jsonl', fake.spawn);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  await assert.rejects(
    () => client.request('fail', {}, { sessionId: 's', potential: { keys: ['D'], buttons: ['left'] } }),
    (error: any) => error.code === 'REQUEST_FAILED',
  );
  assert.deepEqual(client.getHeld('s'), { keys: ['W', 'D'], buttons: ['left'] });
  await assert.rejects(
    () => client.request('fail_with_held', { held: { keys: ['W'], buttons: [] } }, { sessionId: 's', potential: { keys: ['A'], buttons: ['right'] } }),
    (error: any) => error.code === 'RELEASE_FAILED' && error.held.keys[0] === 'W',
  );
  assert.deepEqual(client.getHeld('s'), { keys: ['W'], buttons: [] });
  await client.shutdown();
});

test('nonempty release_all and emergency_release results reject and preserve exact retry ledgers', async () => {
  const fake = fakeFactory({ failedKeys: ['W'] }); const client = new RuntimeClient('/tmp/session-release-result.jsonl', fake.spawn, 30, 30);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  await assert.rejects(
    () => client.request('release_all', { sessionId: 's', held: { keys: ['W'], buttons: [] } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } }),
    (error: any) => error.code === 'RELEASE_FAILED',
  );
  assert.deepEqual(client.getHeld('s'), { keys: ['W'], buttons: [] });
  await assert.rejects(
    () => client.request('emergency_release', { heldBySession: [{ sessionId: 's', held: { keys: ['W'], buttons: [] } }] }, { allowNeedsReopen: true }),
    (error: any) => error.code === 'RELEASE_FAILED',
  );
  assert.deepEqual(client.getHeld('s'), { keys: ['W'], buttons: [] });
  fake.behavior.failedKeys.clear(); await client.shutdown();
  assert.deepEqual(client.getHeld('s'), { keys: [], buttons: [] });
});

test('force-kill while cumulative and potential input is held launches an emergency child and releases the union', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-held.jsonl', fake.spawn);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  const pending = client.request('hang', { sessionId: 's' }, { sessionId: 's', potential: { keys: ['D'], buttons: ['left'] }, timeoutMs: 1000 });
  fake.children[0].kill();
  await assert.rejects(pending, /exited/i);
  await waitFor(() => fake.records.some((record) => record.method === 'emergency_release'));
  const emergency = fake.records.find((record) => record.method === 'emergency_release');
  const held = emergency.params.heldBySession[0].held;
  assert.deepEqual(new Set(held.keys), new Set(['W', 'D'])); assert.deepEqual(held.buttons, ['left']);
  assert.equal(client.state, 'needs_reopen');
  await assert.rejects(() => client.request('act', {}, { sessionId: 's' }), (error: any) => error.code === 'RUNTIME_RESTART_REQUIRED');
  await client.request('open', { sessionId: 's' }, { sessionId: 's', allowNeedsReopen: true }); client.markReopened();
  assert.equal(client.state, 'ready'); await client.shutdown();
});

test('hung shutdown force-kills the old sidecar and releases its session-held union from a fresh child', async () => {
  const fake = fakeFactory({ hangFirstShutdown: true }); const client = new RuntimeClient('/tmp/session-hung-shutdown.jsonl', fake.spawn);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  const pending = client.request('hang', { sessionId: 's' }, { sessionId: 's', potential: { keys: ['D'], buttons: ['left'] }, timeoutMs: 10000 });
  const rejected = assert.rejects(pending, (error: any) => error.code === 'RUNTIME_STOPPED');
  await client.shutdown(); await rejected;
  assert.equal(fake.children.length, 2); assert.equal(fake.children[0].killed, true);
  const emergency = fake.records.find((record) => record.pid === fake.children[1].pid && record.method === 'emergency_release');
  assert.deepEqual(emergency.params.heldBySession, [{ sessionId: 's', held: { keys: ['W', 'D'], buttons: ['left'] } }]);
});

test('request timeout rejects pending work, performs emergency cleanup, and requires explicit reopen', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-timeout.jsonl', fake.spawn);
  await assert.rejects(() => client.request('hang', { sessionId: 's' }, { sessionId: 's', potential: { keys: ['W'], buttons: [] }, timeoutMs: 15 }), (error: any) => error.code === 'REQUEST_TIMEOUT');
  await waitFor(() => fake.children.length === 2);
  assert.equal(client.state, 'needs_reopen'); await client.shutdown();
});

test('a hung emergency child cannot cycle on recovery, rejects siblings, and settles within its independent bound', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-hung-emergency.jsonl', fake.spawn, 25, 25);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  fake.behavior.hangEmergency = true;
  const started = Date.now();
  const original = client.request('hang', { sessionId: 's' }, { sessionId: 's', potential: { keys: ['D'], buttons: ['left'] }, timeoutMs: 10 });
  await assert.rejects(original, (error: any) => error.code === 'REQUEST_TIMEOUT');
  await waitFor(() => fake.records.some((record) => record.method === 'emergency_release'));
  const sibling = client.request(
    'emergency_release',
    { heldBySession: [{ sessionId: 's', held: { keys: ['W', 'D'], buttons: ['left'] } }] },
    { timeoutMs: 25, allowNeedsReopen: true },
  );
  await assert.rejects(sibling, (error: any) => error.code === 'REQUEST_TIMEOUT' || error.code === 'SIDECAR_EXITED');
  await waitFor(() => client.state === 'stopped');
  assert.ok(Date.now() - started < 500, 'recovery settles without waiting on its own promise');
  assert.equal(fake.children[1].killed, true);
  assert.deepEqual(client.getHeld('s'), { keys: ['W', 'D'], buttons: ['left'] });

  await client.shutdown();
  assert.deepEqual(client.getHeld('s'), { keys: ['W', 'D'], buttons: ['left'] }, 'failed shutdown emergency preserves the ledger');
  fake.behavior.hangEmergency = false;
  await client.shutdown();
  assert.deepEqual(client.getHeld('s'), { keys: [], buttons: [] }, 'a later shutdown retries the preserved ledger');
});

test('failed emergency release gates open and close until every parent-held ledger is confirmed released', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-gated-ownership.jsonl', fake.spawn, 20, 20);
  await client.request('act', { sessionId: 's', input: { kind: 'key_down', key: 'W' } }, { sessionId: 's', potential: { keys: ['W'], buttons: [] } });
  fake.behavior.hangEmergency = true;
  await assert.rejects(
    () => client.request('hang', { sessionId: 's' }, { sessionId: 's', potential: { keys: ['D'], buttons: ['left'] }, timeoutMs: 10 }),
    (error: any) => error.code === 'REQUEST_TIMEOUT',
  );
  await waitFor(() => client.state === 'stopped');
  const requestsBeforeGates = fake.records.length;
  await assert.rejects(() => client.request('open', { sessionId: 'fresh' }, { sessionId: 'fresh', allowNeedsReopen: true }), (error: any) => error.code === 'RELEASE_FAILED');
  await assert.rejects(() => client.request('close', { sessionId: 's' }, { sessionId: 's', allowNeedsReopen: true }), (error: any) => error.code === 'RELEASE_FAILED');
  assert.equal(fake.records.length, requestsBeforeGates, 'gated ownership operations never reach a fresh sidecar');
  assert.deepEqual(client.getHeld('s'), { keys: ['W', 'D'], buttons: ['left'] });

  fake.behavior.hangEmergency = false;
  await client.releaseAllHeldKnown();
  assert.equal(client.hasHeldInput, false);
  await client.request('open', { sessionId: 'fresh' }, { sessionId: 'fresh', allowNeedsReopen: true });
  await client.request('close', { sessionId: 'fresh' }, { sessionId: 'fresh', allowNeedsReopen: true });
  await client.shutdown();
});

test('releaseAllHeldKnown attempts every ledger and clears only confirmed session releases', async () => {
  const fake = fakeFactory({ failedKeys: ['W'] }); const client = new RuntimeClient('/tmp/session-release-all-known.jsonl', fake.spawn, 20, 20);
  await client.request('act', { sessionId: 'a', input: { kind: 'key_down', key: 'W' } }, { sessionId: 'a', potential: { keys: ['W'], buttons: [] } });
  await client.request('act', { sessionId: 'b', input: { kind: 'key_down', key: 'D' } }, { sessionId: 'b', potential: { keys: ['D'], buttons: [] } });
  await assert.rejects(() => client.releaseAllHeldKnown(), (error: any) => error.code === 'RELEASE_FAILED');
  assert.deepEqual(client.getHeld('a'), { keys: ['W'], buttons: [] });
  assert.deepEqual(client.getHeld('b'), { keys: [], buttons: [] });
  assert.ok(fake.records.some((record) => record.method === 'release_all' && record.params.sessionId === 'a'));
  assert.ok(fake.records.some((record) => record.method === 'release_all' && record.params.sessionId === 'b'));
  fake.behavior.failedKeys.clear(); await client.releaseAllHeldKnown(); await client.shutdown();
});

test('stale sidecar response is explicit and triggers isolated restart', async () => {
  const fake = fakeFactory(); const client = new RuntimeClient('/tmp/session-stale.jsonl', fake.spawn);
  await assert.rejects(() => client.request('stale', {}, { timeoutMs: 1000 }), (error: any) => error.code === 'STALE_RESPONSE');
  await waitFor(() => fake.children.length === 2); assert.equal(client.state, 'needs_reopen'); await client.shutdown();
});

test('two canonical pie session paths own isolated children and shutdown only their runtime', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-isolation-')); const fake = fakeFactory(); const registry = new RuntimeRegistry(fake.spawn);
  try {
    const a = path.join(dir, 'a.jsonl'); const b = path.join(dir, 'b.jsonl'); await writeFile(a, ''); await writeFile(b, '');
    const clientA = await registry.get(a); const clientB = await registry.get(b);
    assert.notEqual(clientA, clientB); await clientA.request('ping', {}, { allowNeedsReopen: true }); await clientB.request('ping', {}, { allowNeedsReopen: true });
    assert.equal(fake.children.length, 2); await registry.shutdownSession(a); assert.equal(registry.size, 1); assert.equal(fake.children[1].killed, false);
    await clientB.request('ping', {}, { allowNeedsReopen: true }); await registry.shutdownAll(); assert.equal(fake.children[1].killed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
