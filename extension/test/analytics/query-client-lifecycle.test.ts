import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AnalyticsQueryClient } from '../../src/analytics/query-client.js';
import type { AnalyticsQueryLifecycleEvent } from '../../src/analytics/query-client.js';
import type { AnalyticsWorkerLifecycleEvent } from '../../src/analytics/recorder-supervisor.js';
import { SqliteAnalyticsRecorder } from '../../src/analytics/sqlite-recorder.js';

const workerScript = fileURLToPath(new URL('./fixtures/query-client-worker.cjs', import.meta.url));
const sqliteQueryWorkerScript = fileURLToPath(new URL('../../src/analytics/query-worker-entry.ts', import.meta.url));
const sqliteQueryWorkerExecArgv = [
  `--import=${new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href}`,
];

test('query client reports one immutable identity through authoritative worker exit', async () => {
  const events: AnalyticsWorkerLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'unused.sqlite'),
    workerScript,
    onWorkerLifecycle: (event) => events.push(structuredClone(event)),
  });
  assert.deepEqual(await client.query({ type: 'schema' }), { ok: true });
  assert.deepEqual(events.map((event) => event.state), ['spawned', 'ready', 'terminal']);
  assert.deepEqual(events[0]?.identity, events[1]?.identity);
  assert.deepEqual(events[1]?.identity, events[2]?.identity);
  const terminal = events.at(-1);
  if (terminal?.state !== 'terminal') throw new Error('query worker did not emit a terminal lifecycle event');
  assert.equal(terminal.code, 0);
  assert.equal(terminal.signal, null);
  assert.ok((events[0]?.identity.pid ?? 0) > 0);
  assert.ok((events[0]?.identity.spawnedAtMs ?? 0) > 0);
  assert.match(events[0]?.identity.instanceId ?? '', /^[0-9a-f-]{36}$/iu);
});

test('query lifecycle observer failure cannot change query completion', async () => {
  const client = new AnalyticsQueryClient({
    databasePath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'observer-failure.sqlite'),
    workerScript,
    onQueryLifecycle: () => { throw new Error('diagnostic observer failure'); },
  });
  assert.deepEqual(await client.query({ type: 'schema' }), { ok: true });
});

test('query client reports observed active/queued/capacity lifecycle and drains cancellation', async () => {
  const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath: path.join(tmpdir(), 'capacity-observation.sqlite'),
    workerScript,
    maxConcurrentQueries: 2,
    maxQueuedQueries: 1,
    onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map((controller) => client.query({ type: 'schema' }, controller.signal).then(
    () => ({ status: 'fulfilled' as const }),
    () => ({ status: 'rejected' as const }),
  ));
  const outcomesPromise = Promise.all(requests);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.filter((event) => event.phase === 'queued').length, 1);
  assert.equal(lifecycle.filter((event) => event.phase === 'capacity-rejected').length, 1);
  controllers[2]!.abort(new Error('queued cancellation'));
  const outcomes = await outcomesPromise;
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  const byRequest = new Map<number, AnalyticsQueryLifecycleEvent[]>();
  for (const event of lifecycle) {
    const events = byRequest.get(event.requestId) ?? [];
    events.push(event);
    byRequest.set(event.requestId, events);
  }
  assert.deepEqual(byRequest.get(3)?.map((event) => event.phase), ['submitted', 'queued', 'cancelled-before-start', 'settled']);
  assert.deepEqual(byRequest.get(4)?.map((event) => event.phase), ['submitted', 'capacity-rejected', 'settled']);
  assert.equal(Math.max(...lifecycle.map((event) => event.snapshot.activeQueries)), 2);
  assert.equal(Math.max(...lifecycle.map((event) => event.snapshot.queuedQueries)), 1);
  assert.deepEqual(client.getAdmissionSnapshot(), {
    activeQueries: 0,
    queuedQueries: 0,
    maxConcurrentQueries: 2,
    maxQueuedQueries: 1,
  });
});

test('a fresh read-only query worker reports corrupt SQLite and reaches terminal exit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-query-corrupt-lifecycle-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  writeFileSync(databasePath, Buffer.alloc(100, 0x41));
  const events: AnalyticsWorkerLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath,
    workerScript: sqliteQueryWorkerScript,
    onWorkerLifecycle: (event) => events.push(structuredClone(event)),
  });
  try {
    await assert.rejects(client.query({ type: 'schema' }), /database|sqlite|malform|corrupt|file is not/iu);
    assert.equal(events[0]?.state, 'spawned');
    assert.equal(events.at(-1)?.state, 'terminal');
    assert.deepEqual(events[0]?.identity, events.at(-1)?.identity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production query worker includes terminal telemetry on a bounded schema result', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-query-telemetry-production-'));
  const databasePath = path.join(root, 'analytics.sqlite');
  const writer = new SqliteAnalyticsRecorder(databasePath);
  writer.close();
  const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath,
    workerScript: sqliteQueryWorkerScript,
    execArgv: sqliteQueryWorkerExecArgv,
    maxOldSpaceMb: 64,
    onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
  });
  try {
    const schema = await client.query<{ databaseSchemaVersion: number }>({ type: 'schema' });
    assert.equal(schema.databaseSchemaVersion, 9);
    const terminal = lifecycle.find((event) => event.phase === 'terminal');
    assert.ok(terminal);
    assert.equal(terminal.telemetryStatus, 'available');
    assert.ok(terminal.telemetry);
    assert.equal(terminal.telemetry.runtimeSamplePhase, 'after-result-serialization');
    assert.deepEqual(terminal.telemetry.workerIdentity, terminal.identity);
    assert.ok(terminal.telemetry.maxRssBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query terminal telemetry reports identity-bound peak RSS, CPU, current memory, and sample phase', async () => {
  const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath: path.join(tmpdir(), `query-telemetry-success-${Date.now()}.sqlite`),
    workerScript,
    maxOldSpaceMb: 64,
    onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
  });
  const result = await client.query<{ ok: boolean; payload: Buffer }>({ type: 'schema' });
  assert.equal(result.ok, true);
  const terminal = lifecycle.find((event) => event.phase === 'terminal');
  assert.ok(terminal);
  assert.equal(terminal.telemetryStatus, 'available');
  assert.ok(terminal.telemetry);
  assert.deepEqual(terminal.telemetry.workerIdentity, terminal.identity);
  assert.ok(terminal.telemetry.maxRssBytes >= 8 * 1024 * 1024);
  assert.ok(terminal.telemetry.userCpuTimeMicros >= 0);
  assert.ok(terminal.telemetry.systemCpuTimeMicros >= 0);
  assert.ok(terminal.telemetry.currentMemory.rssBytes > 0);
  assert.ok(terminal.telemetry.currentMemory.heapTotalBytes >= terminal.telemetry.currentMemory.heapUsedBytes);
  assert.equal(terminal.telemetry.runtimeSamplePhase, 'after-result-serialization');
});

test('query error terminal telemetry is captured after error encoding without changing rejection semantics', async () => {
  const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
  const client = new AnalyticsQueryClient({
    databasePath: path.join(tmpdir(), `query-telemetry-error-${Date.now()}.sqlite`),
    workerScript,
    maxOldSpaceMb: 64,
    onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
  });
  await assert.rejects(client.query({ type: 'schema' }), /fixture query failure/u);
  const terminal = lifecycle.find((event) => event.phase === 'terminal');
  assert.ok(terminal);
  assert.equal(terminal.telemetryStatus, 'available');
  assert.ok(terminal.telemetry);
  assert.equal(terminal.telemetry.runtimeSamplePhase, 'after-error-message-formatting');
  assert.deepEqual(terminal.telemetry.workerIdentity, terminal.identity);
});

test('malformed or missing query telemetry stays unqualified while the query result is preserved', async () => {
  const cases = [
    ['invalid-identity', 'unavailable-invalid'],
    ['invalid-range', 'unavailable-invalid'],
    ['missing', 'unavailable-missing'],
  ] as const;
  for (const [mode, expectedStatus] of cases) {
    const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
    const client = new AnalyticsQueryClient({
      databasePath: path.join(tmpdir(), `query-telemetry-${mode}-${Date.now()}.sqlite`),
      workerScript,
      maxOldSpaceMb: 64,
      onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
    });
    assert.deepEqual(await client.query({ type: 'schema' }), { ok: true, payload: undefined });
    const terminal = lifecycle.find((event) => event.phase === 'terminal');
    assert.ok(terminal);
    assert.equal(terminal.telemetry, null);
    assert.equal(terminal.telemetryStatus, expectedStatus);
  }
});

test('forced query cancellation and timeout publish null unavailable telemetry', async () => {
  for (const [label, options] of [
    ['cancel', {}],
    ['timeout', { timeoutMs: 50 }],
  ] as const) {
    const lifecycle: AnalyticsQueryLifecycleEvent[] = [];
    const client = new AnalyticsQueryClient({
      databasePath: path.join(tmpdir(), `query-telemetry-cancel-${label}-${Date.now()}.sqlite`),
      workerScript,
      maxOldSpaceMb: 64,
      ...options,
      onQueryLifecycle: (event) => lifecycle.push(structuredClone(event)),
    });
    const controller = new AbortController();
    const query = client.query({ type: 'schema' }, controller.signal);
    // Attach the rejection observer immediately. A 50 ms timeout is allowed
    // to expire during helper startup under the full affected suite, and a
    // later assert.rejects() would otherwise leave a transient unhandled
    // rejection. Cancellation still waits for the meaningful ready fence.
    const queryOutcome = query.then(
      () => ({ status: 'fulfilled' as const }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    if (label === 'cancel') {
      const deadline = Date.now() + 5_000;
      while (!lifecycle.some((event) => event.phase === 'ready') && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(lifecycle.some((event) => event.phase === 'ready'), 'cancellation must wait for helper readiness');
      controller.abort(new Error('test cancellation'));
    }
    const outcome = await queryOutcome;
    if (outcome.status === 'fulfilled') assert.fail('query unexpectedly fulfilled');
    assert.match(String(outcome.error), label === 'cancel' ? /test cancellation/u : /timed out/u);
    const terminal = lifecycle.find((event) => event.phase === 'terminal');
    assert.ok(terminal);
    assert.equal(terminal.telemetry, null);
    assert.equal(terminal.telemetryStatus, 'unavailable-cancelled');
  }
});
