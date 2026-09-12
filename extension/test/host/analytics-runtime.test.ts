import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

function tempRuntime(activationSnapshot?: ReturnType<ActivationStore['read']>) {
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
  });
  return { root, stateDir, analyticsDir, runtime };
}

async function writeManifest(stateDir: string, manifest: unknown): Promise<void> {
  const store = new ActivationStore({ stateDir });
  await store.update(() => manifest as never, { expectedSha256: null });
}

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
