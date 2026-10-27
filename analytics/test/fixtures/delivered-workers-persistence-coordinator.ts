// Source coordinator policy + delivered helper bytes; never starts HostRuntime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AnalyticsObservation } from '../../contracts/contracts.js';

type WorkerEvidence = { script: string; pid: number; ready?: { pid: number; spawnedAtMs: number; instanceId: string }; terminal?: { code: number | null; signal: string | null } };
async function main() {
  const require = createRequire(import.meta.url);
  const [packageRoot, root, phase, buildId, reportPath] = process.argv.slice(2);
  const workerPaths = ['analytics-recorder-worker.js', 'analytics-query-worker.js'].map(name => path.join(packageRoot, 'out', name));
  const children: WorkerEvidence[] = [];
  const exited: Promise<void>[] = [];
  const attempts: string[] = [];
  const deny = (name: string) => function () { process.exitCode = 1; attempts.push(name); throw new Error(`Probe denied ${name}`); };
  const cp = require('node:child_process');
  const fork = cp.fork;
  // Observational wrapper forwards actual forks unchanged. No fake IPC/readiness.
  cp.fork = (script: string, ...args: unknown[]) => {
    if (!workerPaths.includes(script)) deny(`Unexpected helper: ${script}`)();
    const child = fork(script, ...args);
    const evidence: WorkerEvidence = { script, pid: child.pid };
    children.push(evidence);
    child.on('message', (message: { type?: string; workerIdentity?: WorkerEvidence['ready'] }) => {
      if (message.type === 'ready') evidence.ready = message.workerIdentity;
    });
    // Query cleanup removes listeners at exit. Observe exit before handing the
    // child to that owner; the outer watchdog separately confirms tree settlement.
    exited.push(new Promise<void>(resolve => child.once('exit', (code: number | null, signal: string | null) => { evidence.terminal = { code, signal }; resolve(); })));
    return child;
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = deny(name);
  require('node:worker_threads').Worker = deny('Worker');
  require('node:net').Socket.prototype.connect = deny('Socket.connect');
  globalThis.fetch = deny('fetch') as typeof fetch;
  syncBuiltinESMExports();
  let success = false;
  process.on('exit', () => {
    const report = { phase, success: success && attempts.length === 0 && children.every(child => child.terminal?.code === 0 && child.terminal.signal === null), attempts, children };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (!report.success) process.exitCode = 1;
  });
  const { AnalyticsRuntime } = require('../../../application/backend/composition/analytics-runtime.ts');
  const { SessionLifecycleStore } = require('../../../harness/session-storage/lifecycle/session-lifecycle-store.ts');
  const { createSessionLifecycleWriterAdmission } = require('../../authority/session-lifecycle-writer-store.ts');
  const { recoverStaleAnalyticsHosts } = require('../../authority/analytics-host-recovery.ts');
  const { resolveCanonicalCaptureNamespace } = require('../../recording/capture-namespace.ts');
  const { canonicalAnalyticsDatabasePath } = require('../../queries/query-entry.ts');
  const { deriveAnalyticsIdempotencyKey } = require('../../contracts/contracts.ts');
  const { resolvePieDataPaths } = require('../../../lib/data-root/pie-data-root.ts');
  const data = resolvePieDataPaths();
  assert.equal(data.rootDir, path.join(root, 'pie-data'));
  const databasePath = canonicalAnalyticsDatabasePath(data.analyticsDir);
  const store = new SessionLifecycleStore(path.join(data.stateDir, 'session-lifecycle.sqlite'));
  const workspaceId = 'delivered-helper-probe';
  const generationId = resolveCanonicalCaptureNamespace(databasePath);
  const identity = { workspaceId, generationId, buildId, processId: process.pid, hostInstanceId: `private-${phase}-${process.pid}` };
  let runtime: InstanceType<typeof AnalyticsRuntime> | undefined;
  try {
    await recoverStaleAnalyticsHosts({ registry: store, workspaceId, now: Date.now, readProcessCensus: async () => { throw new Error('Clean private registry must not require census/recovery'); } });
    store.registerAnalyticsHost({ ...identity, capabilities: ['host-discovery'], registeredAtMs: String(Date.now()) });
    const admission = createSessionLifecycleWriterAdmission(store, identity);
    runtime = new AnalyticsRuntime({ canonicalContext: { mode: 'canonical-only', generationId, buildId, workspaceId, hostInstanceId: identity.hostInstanceId }, stateDir: data.stateDir, analyticsDir: data.analyticsDir, recorderWorkerScript: workerPaths[0], queryWorkerScript: workerPaths[1], buildId, workspaceId, processGeneration: identity.hostInstanceId, writerAdmission: admission, timeZone: 'UTC' });
    const ready = await runtime.start();
    assert.ok(ready.recorderReady && ready.queryReady);
    assert.equal(ready.generationId, generationId);
    const read = () => runtime!.reads.query({ type: 'query', sql: 'SELECT source_key, generation_id FROM analytics_observations WHERE source_key = ?', parameters: ['private-durable-fact'] });
    if (phase === 'reopen') {
      const persisted = await read();
      assert.equal(persisted.rows.length, 1);
      assert.equal(persisted.rows[0].generation_id, generationId);
    }
    // Fixed producer provenance makes replay across coordinators exactly identical.
    const base: Omit<AnalyticsObservation, 'idempotencyKey'> = { schemaVersion: 1, generationId, producerKind: 'test', stableOriginId: 'private-probe-origin', sourceSequence: 1, sourceKey: 'private-durable-fact', entityKind: 'execution', entityKey: 'private-execution', observationKind: 'end', observedAtMs: 1_780_000_000_000, scope: { workspaceCoverage: 'known', workspaceId, rootSessionId: 'synthetic-root' }, captureSubject: { kind: 'session', rootSessionId: 'synthetic-root' }, producer: { buildId, processGeneration: 'synthetic-producer' }, fields: { outcome: 'synthetic-success' } };
    const observation = { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
    const disposition = new Promise<{ status: string }>(resolve => runtime!.sink.submitTracked(observation, resolve));
    await runtime.sink.flush();
    assert.equal((await disposition).status, 'durable');
    const captured = await read();
    assert.equal(captured.rows.length, 1, 'replay must not duplicate persisted fact');
    assert.equal(captured.rows[0].generation_id, generationId);
    const stats = await runtime.sink.workerStats();
    assert.ok(children.some(child => child.ready?.instanceId === stats.process.workerIdentity.instanceId));
    await runtime.fenceWriters();
    await runtime.stop();
    await Promise.all(exited);
    assert.ok(children.length >= 3, 'recorder and readiness/read disposable queries must really run');
    for (const child of children) {
      assert.equal(child.ready?.pid, child.pid);
      assert.ok(child.ready?.instanceId);
      assert.deepEqual(child.terminal, { code: 0, signal: null });
    }
    assert.equal(store.listAnalyticsWriterLeases(workspaceId).length, 0);
    store.markAnalyticsHostState(identity.hostInstanceId, identity.processId, generationId, 'stopped', Date.now());
    success = true;
  } finally {
    await runtime?.stop();
    store.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
