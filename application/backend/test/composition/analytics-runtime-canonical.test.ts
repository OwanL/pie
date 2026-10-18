import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnalyticsRuntimeError } from '../../../../analytics/authority/analytics-runtime.js';
import { AnalyticsRuntime } from '../../composition/analytics-runtime.js';
import { AnalyticsRecorderSupervisor } from '../../../../analytics/recording/recorder-supervisor.js';
import { AnalyticsQueryClient } from '../../../../analytics/queries/query-client.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-canonical-context-'));
  const context = {
    mode: 'canonical-only' as const,
    generationId: 'existing-store-namespace',
    buildId: 'build-1',
    workspaceId: 'workspace-1',
    hostInstanceId: 'host-1',
  };
  const options = {
    canonicalContext: context,
    stateDir: path.join(root, 'state'),
    analyticsDir: path.join(root, 'analytics'),
    recorderWorkerScript: 'unused-recorder',
    queryWorkerScript: 'unused-query',
    buildId: context.buildId,
    workspaceId: context.workspaceId,
    processGeneration: context.hostInstanceId,
    writerAdmission: { acquire: () => () => {} },
    timeZone: 'UTC',
  };
  return { root, context, options };
}

test('canonical-only startup publishes the supplied namespace without activation evidence or legacy writes', async (t) => {
  const { root, context, options } = fixture();
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'start', async () => {});
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'workerStats', async () => ({ recorder: { databaseSchemaVersion: 1 } }));
  const shutdown = t.mock.method(AnalyticsRecorderSupervisor.prototype, 'shutdown', async () => {});
  t.mock.method(AnalyticsQueryClient.prototype, 'query', async (request: { type: string }) => request.type === 'schema'
    ? { databaseSchemaVersion: 1 } : { rows: [{ revision: '7' }] });
  const runtime = new AnalyticsRuntime(options);
  try {
    assert.equal(runtime.getCanonicalContext(), undefined);
    context.generationId = 'mutated-after-construction';
    const first = runtime.start();
    assert.equal(runtime.start(), first);
    const readiness = await first;
    assert.equal(readiness.authority, 'canonical');
    assert.equal(readiness.generationId, 'existing-store-namespace');
    assert.deepEqual(Object.keys(readiness).sort(), ['authority', 'generationId', 'projectionRevision', 'queryReady', 'recorderReady', 'recorderSchemaVersion']);
    assert.equal(readiness.recorderReady && readiness.queryReady, true);
    assert.equal(readiness.projectionRevision, '7');
    assert.equal(path.normalize(runtime.databasePath), path.join(options.analyticsDir, 'analytics.sqlite'));
    assert.equal(Object.isFrozen(runtime.getCanonicalContext()), true);
    assert.equal(existsSync(options.stateDir), false);
    assert.equal(existsSync(options.analyticsDir), false, 'mocked helpers must not touch any database');
    await runtime.stop();
    assert.equal(runtime.getCanonicalContext(), undefined);
    assert.equal(shutdown.mock.callCount(), 1);
    await assert.rejects(runtime.start(), /stopped/);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical-only startup requires lifecycle admission and rejects mixed evidence or identities', () => {
  const { root, options } = fixture();
  try {
    assert.throws(() => new AnalyticsRuntime({ ...options, writerAdmission: undefined } as never), /writer admission/);
    assert.throws(() => new AnalyticsRuntime({ ...options, canonicalContext: undefined } as never), AnalyticsRuntimeError);
    for (const mismatch of [{ buildId: 'other-build' }, { workspaceId: 'other-workspace' }, { processGeneration: 'other-host' }]) {
      assert.throws(() => new AnalyticsRuntime({ ...options, ...mismatch }), /runtime identity/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical-only probe failure shuts down helpers and never exposes capture identity', async (t) => {
  const { root, options } = fixture();
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'start', async () => {});
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'workerStats', async () => ({ recorder: { databaseSchemaVersion: 1 } }));
  const shutdown = t.mock.method(AnalyticsRecorderSupervisor.prototype, 'shutdown', async () => {});
  t.mock.method(AnalyticsQueryClient.prototype, 'query', async () => { throw new Error('probe failed'); });
  const runtime = new AnalyticsRuntime(options);
  try {
    await assert.rejects(runtime.start(), /probe failed/);
    assert.equal(runtime.sink, undefined);
    assert.equal(runtime.reads, undefined);
    assert.equal(runtime.getCanonicalContext(), undefined);
    assert.equal(runtime.isStopped, true);
    assert.equal(shutdown.mock.callCount(), 1);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical-only stop joins startup and forbids late readiness', async (t) => {
  const { root, options } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'start', () => gate);
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'workerStats', async () => ({ recorder: { databaseSchemaVersion: 1 } }));
  const shutdown = t.mock.method(AnalyticsRecorderSupervisor.prototype, 'shutdown', async () => {});
  t.mock.method(AnalyticsQueryClient.prototype, 'query', async (request: { type: string }) => request.type === 'schema'
    ? { databaseSchemaVersion: 1 } : { rows: [] });
  const runtime = new AnalyticsRuntime(options);
  try {
    const startup = runtime.start();
    const rejected = assert.rejects(startup, /stopped during startup/);
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await Promise.all([rejected, stopping]);
    assert.equal(runtime.getReadiness(), undefined);
    assert.equal(runtime.getCanonicalContext(), undefined);
    assert.equal(runtime.sink, undefined);
    assert.equal(shutdown.mock.callCount(), 1);
  } finally {
    release();
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('old manifests, tombstones and receipts remain inert and byte-for-byte unchanged', async (t) => {
  const { root, options } = fixture();
  const files = ['analytics-activation-v1.json', 'analytics-ever-active-v1.json', 'analytics-loaded-generation-v1.json', 'analytics-terminal-restart-v1.json'];
  mkdirSync(options.stateDir, { recursive: true });
  const bytes = Buffer.from('invalid obsolete evidence\n');
  for (const file of files) writeFileSync(path.join(options.stateDir, file), bytes);
  const start = t.mock.method(AnalyticsRecorderSupervisor.prototype, 'start', async () => {});
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'workerStats', async () => ({ recorder: { databaseSchemaVersion: 1 } }));
  t.mock.method(AnalyticsRecorderSupervisor.prototype, 'shutdown', async () => {});
  t.mock.method(AnalyticsQueryClient.prototype, 'query', async (request: { type: string }) => request.type === 'schema'
    ? { databaseSchemaVersion: 1 } : { rows: [] });
  const runtime = new AnalyticsRuntime(options);
  try {
    assert.equal((await runtime.start()).authority, 'canonical');
    assert.equal(start.mock.callCount(), 1);
    await runtime.stop();
    assert.deepEqual(readdirSync(options.stateDir).sort(), files.sort());
    for (const file of files) assert.deepEqual(readFileSync(path.join(options.stateDir, file)), bytes);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
