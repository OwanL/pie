import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionLifecycleWriterAdmission } from '../../../../analytics/authority/session-lifecycle-writer-store.js';
import { SessionLifecycleStore } from '../../../../harness/session-storage/lifecycle/session-lifecycle-store.js';
import { AnalyticsRuntime } from '../../composition/analytics-runtime.js';
import { AnalyticsRuntimeError, analyticsWorkspaceId } from '../../../../analytics/authority/analytics-runtime.js';
const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
function canonicalContext(workspaceId = 'workspace-1', hostInstanceId = 'process-1') {
  return { mode: 'canonical-only' as const, generationId: GENERATION_ID, buildId: 'build-1', workspaceId, hostInstanceId };
}
function tempRuntime(timeZone = 'UTC') {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-'));
  const runtime = new AnalyticsRuntime({
    canonicalContext: canonicalContext(), writerAdmission: { acquire: () => () => {} },
    stateDir: path.join(root, 'state'), analyticsDir: path.join(root, 'analytics'),
    recorderWorkerScript: path.join(root, 'missing-recorder-worker.js'),
    queryWorkerScript: path.join(root, 'missing-query-worker.js'),
    buildId: 'build-1', workspaceId: 'workspace-1', processGeneration: 'process-1', timeZone,
  });
  return { root, runtime };
}

test('canonical runtime reaches readiness with real recorder and query workers', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-real-'));
  const stateDir = path.join(root, 'state');
  const loaderUrl = new URL('../../../hosts/vscode/node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const workerPath = (kind: 'recorder' | 'query'): string => {
    const target = path.join(root, `${kind}-worker.mjs`);
    const sourceUrl = kind === 'recorder'
      ? new URL('../../../../analytics/recording/recorder-worker-entry.ts', import.meta.url).href
      : new URL('../../../../analytics/queries/query-worker-entry.ts', import.meta.url).href;
    // Real production entry points, loaded independently of extension/out.
    writeFileSync(target, `await import(${JSON.stringify(loaderUrl)});\nawait import(${JSON.stringify(sourceUrl)});\n`, 'utf8');
    return target;
  };
  const runtime = new AnalyticsRuntime({
    stateDir,
    analyticsDir: path.join(root, 'analytics'),
    recorderWorkerScript: workerPath('recorder'),
    queryWorkerScript: workerPath('query'),
    buildId: 'build-1',
    workspaceId: 'workspace-real',
    processGeneration: 'process-real',
    canonicalContext: canonicalContext('workspace-real', 'process-real'),
    writerAdmission: { acquire: () => () => {} },
    timeZone: 'UTC',
  });
  try {
    const readiness = await runtime.start();
    assert.equal(readiness.authority, 'canonical');
    assert.equal(readiness.recorderReady, true);
    assert.equal(readiness.queryReady, true, 'independent query schema probe must agree with recorder stats');
    assert.ok(Number.isSafeInteger(readiness.recorderSchemaVersion) && readiness.recorderSchemaVersion! > 0);
    assert.equal(readiness.projectionRevision, '0');
    const stats = await runtime.sink!.workerStats();
    assert.equal(stats?.recorder.databaseSchemaVersion, readiness.recorderSchemaVersion);
    assert.equal(readiness.generationId, GENERATION_ID);
    assert.equal(await runtime.fenceWriters(), 0, 'the real recorder drains before acknowledging its fence');
  } finally {
    await runtime.stop();
    assert.equal(runtime.isStopped, true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop joins gated real-worker startup and releases its lifecycle startup lease before returning', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-stop-startup-'));
  const stateDir = path.join(root, 'state');
  const loaderUrl = new URL('../../../hosts/vscode/node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const recorderEntryUrl = new URL('../../../../analytics/recording/recorder-worker-entry.ts', import.meta.url).href;
  const queryEntryUrl = new URL('../../../../analytics/queries/query-worker-entry.ts', import.meta.url).href;
  const gateStarted = path.join(root, 'recorder-gate-started');
  const gateRelease = path.join(root, 'recorder-gate-release');
  const spawnLog = path.join(root, 'recorder-spawns');
  const recorderExited = path.join(root, 'recorder-exited');
  const gatedRecorder = path.join(root, 'gated-recorder-worker.mjs');
  const queryWorker = path.join(root, 'query-worker.mjs');
  writeFileSync(gatedRecorder, [
    `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`,
    `appendFileSync(${JSON.stringify(spawnLog)}, 'spawned\\n');`,
    `process.once('exit', () => writeFileSync(${JSON.stringify(recorderExited)}, 'exited'));`,
    `writeFileSync(${JSON.stringify(gateStarted)}, 'started');`,
    `while (!existsSync(${JSON.stringify(gateRelease)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
    `await import(${JSON.stringify(loaderUrl)});`,
    `await import(${JSON.stringify(recorderEntryUrl)});`,
  ].join('\n'), 'utf8');
  writeFileSync(queryWorker, `await import(${JSON.stringify(loaderUrl)});\nawait import(${JSON.stringify(queryEntryUrl)});\n`, 'utf8');

  const store = new SessionLifecycleStore(path.join(root, 'state', 'session-lifecycle.sqlite'));
  const writerIdentity = {
    hostInstanceId: 'runtime-host-1',
    workspaceId: 'workspace-stop-race',
    generationId: GENERATION_ID,
    buildId: 'build-1',
    processId: process.pid,
  };
  const now = String(Date.now());
  store.registerAnalyticsHost({
    ...writerIdentity,
    capabilities: ['host-discovery', 'authenticated-control', 'writer-fence'],
    state: 'registered',
    registeredAtMs: now,
    heartbeatAtMs: now,
    updatedAtMs: now,
  });
  const writerAdmission = createSessionLifecycleWriterAdmission(store, writerIdentity);
  const runtime = new AnalyticsRuntime({
    stateDir,
    analyticsDir: path.join(root, 'analytics'),
    recorderWorkerScript: gatedRecorder,
    queryWorkerScript: queryWorker,
    buildId: 'build-1',
    workspaceId: writerIdentity.workspaceId,
    processGeneration: 'process-stop-race',
    canonicalContext: canonicalContext(writerIdentity.workspaceId, 'process-stop-race'),
    writerAdmission,
    timeZone: 'UTC',
  });

  let startup: Promise<unknown> | undefined;
  try {
   const startupPromise = runtime.start();
    startup = startupPromise;
    assert.equal(runtime.start(), startupPromise, 'concurrent start calls join the same startup operation');
    const gateDeadline = Date.now() + 5_000;
    while (!existsSync(gateStarted) && Date.now() < gateDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(gateStarted), true, 'the real recorder worker reached its deliberate startup gate');
    assert.equal(store.listAnalyticsWriterLeases(writerIdentity.workspaceId).length, 1,
      'the recorder startup lease is durably held while its worker is gated');

    let stopSettled = false;
    const stopPromise = runtime.stop();
    const stopping = stopPromise.then(() => { stopSettled = true; });
    assert.equal(runtime.stop(), stopPromise, 'concurrent stop calls join the same stop operation');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(stopSettled, false, 'stop must join startup while the helper can still initialize or write');
    assert.equal(store.listAnalyticsWriterLeases(writerIdentity.workspaceId).length, 1,
      'stop must not return or release startup admission while initialization is still gated');

    writeFileSync(gateRelease, 'release');
    await assert.rejects(startupPromise, /stopped during startup/u);
    await stopping;
    assert.equal(existsSync(recorderExited), true, 'stop waits for cleanup of the started recorder helper');
    assert.equal(store.listAnalyticsWriterLeases(writerIdentity.workspaceId).length, 0,
      'all startup admission leases are released before stop returns');
    assert.equal(runtime.sink, undefined);
    assert.equal(runtime.getReadiness(), undefined, 'stopped startup must not publish readiness');

    await assert.rejects(runtime.start(), AnalyticsRuntimeError,
      'a terminally stopped runtime cannot re-enable helper startup');
    assert.equal(readFileSync(spawnLog, 'utf8').trim().split(/\\r?\\n/u).length, 1,
      'a post-stop start attempt must not spawn another recorder worker');
  } finally {
    writeFileSync(gateRelease, 'release');
    await startup?.catch(() => undefined);
    await runtime.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('helper failure fails closed without fallback capture', async () => {
  const { root, runtime } = tempRuntime();
  try {
    assert.equal(runtime.sink, undefined);
    assert.equal(runtime.reads, undefined);
    await assert.rejects(runtime.start());
    assert.equal(runtime.getReadiness(), undefined);
    assert.equal(runtime.getCanonicalContext(), undefined);
    assert.equal(runtime.sink, undefined);
    assert.equal(runtime.reads, undefined);
    assert.equal(runtime.isStopped, true);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyticsWorkspaceId is deterministic and fixed length', () => {
  assert.equal(analyticsWorkspaceId('seed-a'), analyticsWorkspaceId('seed-a'));
  assert.equal(analyticsWorkspaceId('seed-a').length, 32);
  assert.notEqual(analyticsWorkspaceId('seed-a'), analyticsWorkspaceId('seed-b'));
});

test('daily projection preparation is writer-owned, stable-zone, and rechecks a queued window', async () => {
  const { root, runtime } = tempRuntime();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const calls: Array<[string, number | string | bigint, number | string | bigint]> = [];
  const internals = runtime as unknown as {
    recorder: {
      prepareProviderDailyProjection: (...args: [string, number | string | bigint, number | string | bigint, boolean]) => Promise<void>;
      shutdown: () => Promise<void>;
    };
    readiness: { authority: 'canonical' };
  };
  internals.readiness = { authority: 'canonical' };
  internals.recorder = {
    prepareProviderDailyProjection: async (timeZone, start, end) => {
      calls.push([timeZone, start, end]);
      if (calls.length === 1) await first;
    },
    shutdown: async () => undefined,
  };
  const request = (start: number, end: number, timeZone = 'UTC') => ({
    todayStartMs: start, todayEndMs: end, weekStartMs: start, weekEndMs: end,
    dailyWindowStartMs: start, dailyWindowEndMs: end, timeZone,
  });
  try {
    const firstWindow = runtime.prepareProviderDailyProjection(request(1_700_000_000_000, 1_700_604_800_000));
    const secondWindow = runtime.prepareProviderDailyProjection(request(1_700_086_400_000, 1_700_691_200_000));
    const duplicateSecondWindow = runtime.prepareProviderDailyProjection(request(1_700_086_400_000, 1_700_691_200_000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'a different window waits for the in-flight writer command');
    releaseFirst();
    await Promise.all([firstWindow, secondWindow, duplicateSecondWindow]);
    assert.equal(calls.length, 2, 'the queued window is prepared after the first completes');
    await runtime.prepareProviderDailyProjection(request(1_700_086_400_000, 1_700_691_200_000));
    assert.equal(calls.length, 2, 'the same window is coalesced after completion');
    await assert.rejects(
      () => runtime.prepareProviderDailyProjection(request(1_700_086_400_000, 1_700_691_200_000, 'America/New_York')),
      AnalyticsRuntimeError,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
