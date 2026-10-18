import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePieDataPaths } from '../../lib/data-root/pie-data-root.js';
import { BackendAnalyticsActivation } from '../../analytics/authority/backend-analytics-activation.js';
import type { AnalyticsBackendContext } from '../../analytics/authority/backend-analytics-context.js';
import { SessionLifecycleStore } from '../../harness/session-storage/lifecycle/session-lifecycle-store.js';
import { PIE_BUILD_ID } from '../../lib/build-identity.js';

const context: AnalyticsBackendContext = {
  mode: 'canonical-only', generationId: 'capture-namespace', buildId: 'capture-build',
  workspaceId: 'workspace-1', hostInstanceId: 'host-1',
};

function fixture(t: test.TestContext, suppliedContext: unknown = context, hostPid = process.pid) {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-canonical-context-'));
  const closeStores: (() => void)[] = [];
  const previousDataRoot = process.env.PIE_DATA_DIR;
  process.env.PIE_DATA_DIR = path.join(root, 'runtime-data');
  t.after(() => {
    activation.close();
    for (const close of closeStores) close();
    if (previousDataRoot === undefined) delete process.env.PIE_DATA_DIR;
    else process.env.PIE_DATA_DIR = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const stateDir = resolvePieDataPaths({ dataDir: process.env.PIE_DATA_DIR, agentDir: root }).stateDir;
  const activation = new BackendAnalyticsActivation({
    agentDir: () => root, buildId: PIE_BUILD_ID, hostPid: () => hostPid,
    openWriterStore: (directory) => new SessionLifecycleStore(path.join(directory, 'session-lifecycle.sqlite')),
  }, { context: suppliedContext as AnalyticsBackendContext });
  return { root, stateDir, activation, closeStores };
}

test('canonical backend context is mandatory and exact, regardless of historical artifacts', (t) => {
  const { stateDir, activation } = fixture(t);
  mkdirSync(stateDir, { recursive: true });
  const artifacts = ['analytics-activation-v1.json', 'analytics-ever-active-v1.json', 'analytics-host-loaded.json'];
  for (const name of artifacts) writeFileSync(path.join(stateDir, name), 'invalid historical bytes');
  activation.validate();
  assert.deepEqual(activation.captureDescriptor, context);
  for (const name of artifacts) assert.equal(readFileSync(path.join(stateDir, name), 'utf8'), 'invalid historical bytes');
});

for (const invalid of [null, {}, { ...context, mode: 'legacy' }, { ...context, hostInstanceId: '' },
  { ...context, manifestRevision: 1 }, { generationId: 'legacy-descriptor' }]) {
  test(`rejects invalid canonical context ${JSON.stringify(invalid)}`, (t) => {
    const { activation } = fixture(t, invalid);
    assert.throws(() => activation.validate(), /context/i);
    assert.throws(() => activation.openWriterAdmission(), /context/i);
    assert.equal(activation.admission, undefined);
  });
}

test('canonical writer requires a positive host process identity', (t) => {
  const { activation } = fixture(t, context, 0);
  assert.throws(() => activation.openWriterAdmission(), /positive host process identity/i);
});

test('canonical writer uses loaded build identity and durable leases, fences and epochs', async (t) => {
  const { stateDir, activation, closeStores } = fixture(t);
  const lifecycle = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
  closeStores.push(() => lifecycle.close());
  const identity = {
    hostInstanceId: context.hostInstanceId, workspaceId: context.workspaceId,
    generationId: context.hostInstanceId, buildId: PIE_BUILD_ID, processId: process.pid,
  };
  activation.openWriterAdmission();
  assert.deepEqual(activation.identity, identity);
  assert.notEqual(activation.identity!.buildId, context.buildId);
  assert.throws(() => activation.admission!.assertAdmitted(), /host|registered/i);
  lifecycle.registerAnalyticsHost({ ...identity,
    capabilities: ['host-discovery', 'host-status', 'authenticated-control', 'writer-fence'],
    registeredAtMs: String(Date.now()),
  });
  activation.admission!.assertAdmitted();
  const releaseA = activation.admission!.acquire();
  const releaseB = activation.admission!.acquire();
  assert.equal(lifecycle.listAnalyticsWriterLeases(context.workspaceId).length, 1);
  assert.equal(await activation.waitForWriterLeases(0), 1);
  const fence = lifecycle.beginAnalyticsWriterFence({
    workspaceId: context.workspaceId, operationId: 'fence-1', purpose: 'analytics-activation',
    expectedHosts: [identity], nowMs: Date.now(),
  });
  assert.throws(() => activation.admission!.acquire(), /fenc|admission|epoch/i);
  releaseA(); releaseA();
  assert.equal(lifecycle.listAnalyticsWriterLeases(context.workspaceId).length, 1);
  releaseB();
  assert.equal(await activation.waitForWriterLeases(0), 0);
  lifecycle.acknowledgeAnalyticsWriterFence({
    workspaceId: context.workspaceId, operationId: 'fence-1', fenceEpoch: fence.fenceEpoch,
    identity, activeWriterCount: 0, nowMs: Date.now(),
  });
  lifecycle.completeAnalyticsWriterFence(context.workspaceId, 'fence-1', Date.now());
  lifecycle.reopenAnalyticsWriterAdmission({
    workspaceId: context.workspaceId, operationId: 'fence-1', purpose: 'analytics-activation',
    admittedHosts: [identity], nowMs: Date.now(),
  });
  assert.throws(() => activation.admission!.assertAdmitted(), /epoch|stale/i);
  activation.close();
  assert.equal(activation.admission, undefined);
  assert.equal(activation.identity, undefined);
});
