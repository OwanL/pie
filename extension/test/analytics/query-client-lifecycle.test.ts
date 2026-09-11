import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AnalyticsQueryClient } from '../../src/analytics/query-client.js';
import type { AnalyticsWorkerLifecycleEvent } from '../../src/analytics/recorder-supervisor.js';

const workerScript = fileURLToPath(new URL('./fixtures/query-client-worker.cjs', import.meta.url));
const sqliteQueryWorkerScript = fileURLToPath(new URL('../../src/analytics/query-worker-entry.ts', import.meta.url));

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
  assert.ok((events[0]?.identity.pid ?? 0) > 0);
  assert.ok((events[0]?.identity.spawnedAtMs ?? 0) > 0);
  assert.match(events[0]?.identity.instanceId ?? '', /^[0-9a-f-]{36}$/iu);
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
