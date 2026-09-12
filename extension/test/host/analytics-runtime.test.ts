import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_SCHEMA_VERSION,
  ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
  ActivationManifestError,
  validateAnalyticsLoadedGenerationReceipt,
} from '../../../shared/analytics/activation.js';
import { ActivationStore } from '../../src/analytics/activation-store.js';
import { activateGeneration } from '../../src/analytics/activation-sequence.js';
import {
  AnalyticsRuntime,
  analyticsWorkspaceId,
  LOADED_GENERATION_FILENAME,
  writeLoadedGenerationReceiptAtomically,
} from '../../src/host/analytics-runtime.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ACTIVATED_AT = '2026-09-12T04:00:00.000Z';

function tempRuntime(activationSnapshot?: ReturnType<ActivationStore['read']>, timeZone = 'UTC') {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-'));
  const stateDir = path.join(root, 'state');
  const analyticsDir = path.join(root, 'analytics');
  const runtime = new AnalyticsRuntime({
    stateDir,
    analyticsDir,
    // The workers are never started under legacy authority, so the paths only
    // need to be plausible; a canonical start is covered by the failure tests.
    recorderWorkerScript: path.join(root, 'missing-recorder-worker.js'),
    queryWorkerScript: path.join(root, 'missing-query-worker.js'),
    buildId: 'build-1',
    workspaceId: 'workspace-1',
    processGeneration: 'process-1',
    activationSnapshot,
    timeZone,
  });
  return { root, stateDir, analyticsDir, runtime };
}

async function writeManifest(stateDir: string, manifest: unknown): Promise<void> {
  const store = new ActivationStore({ stateDir });
  await store.update(() => manifest as never, { expectedSha256: null });
}

test('canonical runtime reaches readiness with real recorder and query workers', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-real-'));
  const stateDir = path.join(root, 'state');
  const loaderUrl = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const workerPath = (kind: 'recorder' | 'query'): string => {
    const target = path.join(root, `${kind}-worker.mjs`);
    const sourceUrl = new URL(`../../src/analytics/${kind}-worker-entry.ts`, import.meta.url).href;
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
    restartNonce: 'real-runtime-test',
    timeZone: 'UTC',
  });
  try {
    await activateGeneration(new ActivationStore({ stateDir }), {
      generationId: GENERATION_ID,
      buildId: 'build-1',
      qualificationSha256: SHA,
      trialSha256: SHA_B,
      activatedAt: ACTIVATED_AT,
      cutoffReceiptSha256: null,
    });
    const readiness = await runtime.start();
    assert.equal(readiness.authority, 'canonical');
    assert.equal(readiness.recorderReady, true);
    assert.equal(readiness.queryReady, true, 'independent query schema probe must agree with recorder stats');
    assert.ok(Number.isSafeInteger(readiness.recorderSchemaVersion) && readiness.recorderSchemaVersion! > 0);
    assert.equal(readiness.projectionRevision, '0');
    const stats = await runtime.sink!.workerStats();
    assert.equal(stats?.recorder.databaseSchemaVersion, readiness.recorderSchemaVersion);
    assert.equal(runtime.backendDescriptor()?.generationId, GENERATION_ID);
    runtime.recordLoadedGeneration();
    const receipt = validateAnalyticsLoadedGenerationReceipt(JSON.parse(readFileSync(path.join(stateDir, LOADED_GENERATION_FILENAME), 'utf8')));
    assert.equal(receipt.generationId, GENERATION_ID);
    assert.equal(receipt.restartNonce, 'real-runtime-test');
  } finally {
    await runtime.stop();
    assert.equal(runtime.isStopped, true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('under legacy authority the runtime starts no helper and creates no database', async () => {
  const { root, runtime, analyticsDir } = tempRuntime();
  try {
    const readiness = await runtime.start();
    assert.equal(readiness.authority, 'legacy', 'an absent manifest must select legacy');
    assert.equal(readiness.recorderReady, false, 'no recorder may start under legacy authority');
    assert.equal(readiness.queryReady, false);
    assert.equal(readiness.generationId, null);
    assert.equal(readiness.manifestRevision, null);
    assert.equal(
      existsSync(analyticsDir),
      false,
      'legacy authority must not create the canonical analytics directory',
    );
    assert.deepEqual(runtime.backendDescriptorArguments(), [], 'no descriptor under legacy authority');
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate or ready manifest still selects legacy and starts nothing', async () => {
  const { root, runtime, stateDir } = tempRuntime();
  try {
    await writeManifest(stateDir, {
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 1,
      previousSha256: null,
      everActive: false,
      activeGeneration: null,
      successor: {
        identity: { generationId: GENERATION_ID, buildId: 'build-1', qualificationSha256: SHA, trialSha256: SHA_B },
        state: 'ready',
        activatedAt: null,
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: null,
      },
      retiredHistory: [],
    });
    const readiness = await runtime.start();
    assert.equal(readiness.authority, 'legacy', 'only an active generation switches authority');
    assert.equal(readiness.recorderReady, false);
    assert.equal(readiness.manifestRevision, 1, 'the revision is still reported for observability');
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed manifest fails startup closed rather than selecting legacy', async () => {
  const { root, runtime, stateDir } = tempRuntime();
  try {
    const store = new ActivationStore({ stateDir });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(store.manifestPath, '{ "schemaVersion": 1 }', 'utf8');
    await assert.rejects(() => runtime.start(), ActivationManifestError);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest transition between host construction and runtime start fails closed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-runtime-transition-'));
  const stateDir = path.join(root, 'state');
  const activationSnapshot = new ActivationStore({ stateDir }).read();
  const runtime = new AnalyticsRuntime({
    stateDir,
    analyticsDir: path.join(root, 'analytics'),
    recorderWorkerScript: path.join(root, 'missing-recorder-worker.js'),
    queryWorkerScript: path.join(root, 'missing-query-worker.js'),
    buildId: 'build-1',
    workspaceId: 'workspace-1',
    processGeneration: 'process-1',
    activationSnapshot,
  });
  try {
    await writeManifest(stateDir, {
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 1,
      previousSha256: null,
      everActive: true,
      activeGeneration: {
        identity: { generationId: GENERATION_ID, buildId: 'build-1', qualificationSha256: SHA, trialSha256: SHA_B },
        state: 'active',
        activatedAt: ACTIVATED_AT,
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: SHA_B,
      },
      successor: null,
      retiredHistory: [],
    });
    await assert.rejects(
      () => runtime.start(),
      /changed during host startup/u,
      'legacy construction must not become canonical after the descriptor was captured',
    );
    assert.equal(runtime.backendDescriptorArguments().length, 0);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an active manifest naming a different build refuses to start capture', async () => {
  const { root, runtime, stateDir } = tempRuntime();
  try {
    await writeManifest(stateDir, {
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 1,
      previousSha256: null,
      everActive: true,
      activeGeneration: {
        identity: { generationId: GENERATION_ID, buildId: 'a-different-build', qualificationSha256: SHA, trialSha256: SHA_B },
        state: 'active',
        activatedAt: ACTIVATED_AT,
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: SHA_B,
      },
      successor: null,
      retiredHistory: [],
    });
    await assert.rejects(
      () => runtime.start(),
      /does not match the loaded build/u,
      'running code that differs from the recorded generation must fail closed',
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('activeDescriptor throws rather than inventing an identity', () => {
  const { root, runtime } = tempRuntime();
  try {
    assert.throws(() => runtime.activeDescriptor(), ActivationManifestError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stop is idempotent and terminal', async () => {
  const { root, runtime } = tempRuntime();
  try {
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    assert.equal(runtime.isStopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyticsWorkspaceId is deterministic and fixed length', () => {
  const first = analyticsWorkspaceId('seed-a');
  assert.equal(first, analyticsWorkspaceId('seed-a'));
  assert.equal(first.length, 32);
  assert.notEqual(first, analyticsWorkspaceId('seed-b'));
});

test('loaded-generation receipts use the shared bounded schema and atomic replacement', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-loaded-receipt-'));
  const payload = {
    schemaVersion: ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
    generationId: GENERATION_ID,
    buildId: 'build-1',
    manifestRevision: 4,
    manifestSha256: SHA,
    workspaceId: 'workspace-1',
    hostInstanceId: 'host-1',
    restartNonce: 'restart-1',
    loadedAt: '2026-09-12T04:00:00.000Z',
  } as const;
  try {
    writeLoadedGenerationReceiptAtomically(root, payload);
    const file = path.join(root, LOADED_GENERATION_FILENAME);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), payload);
    assert.deepEqual(readdirSync(root), [LOADED_GENERATION_FILENAME]);
    assert.deepEqual(validateAnalyticsLoadedGenerationReceipt(payload), payload);
    assert.throws(
      () => validateAnalyticsLoadedGenerationReceipt({ ...payload, restartNonce: 'bad nonce' }),
      /restartNonce is invalid/u,
    );
    assert.throws(
      () => validateAnalyticsLoadedGenerationReceipt({ ...payload, loadedAt: '2026-09-12' }),
      /loadedAt is not a canonical/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sink and reads accessors stay undefined until a helper is actually started', async () => {
  const { root, runtime } = tempRuntime();
  try {
    // Before start, and under legacy authority afterwards, there is no helper to
    // hand to capture. The host relies on this: it passes a forwarding sink that
    // resolves the recorder lazily, and an early producer must fail loudly rather
    // than have its record dropped into a helper that was never started.
    assert.equal(runtime.sink, undefined, 'no sink before start');
    assert.equal(runtime.reads, undefined, 'no reads before start');

    await runtime.start();
    assert.equal(runtime.getReadiness()?.authority, 'legacy');
    assert.equal(runtime.sink, undefined, 'legacy authority must not expose a sink');
    assert.equal(runtime.reads, undefined, 'legacy authority must not expose reads');
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
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
      ActivationManifestError,
    );
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
