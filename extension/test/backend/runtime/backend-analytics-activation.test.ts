import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCandidateManifest,
  type AnalyticsBackendDescriptor,
} from '../../../../shared/analytics/activation.js';
import { resolvePieDataPaths } from '../../../../shared/pie-data-root.js';
import { ActivationStore } from '../../../src/analytics/activation-store.js';
import { activateGeneration } from '../../../src/analytics/activation-sequence.js';
import { BackendServer } from '../../../src/backend/server.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function serverFor(root: string, analyticsActivation?: AnalyticsBackendDescriptor): {
  agentDir: string;
  validateAnalyticsActivation(): void;
} {
  const server = new BackendServer({
    sdkPath: '/unused',
    cwd: root,
    workerEntryPath: '/worker-entry.js',
    ...(analyticsActivation ? { analyticsActivation } : {}),
  }) as unknown as { agentDir: string; validateAnalyticsActivation(): void };
  server.agentDir = root;
  return server;
}

test('backend analytics activation validates exact active generation and rejects stale authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-analytics-activation-'));
  const previousDataRoot = process.env.PIE_DATA_DIR;
  const dataRoot = path.join(root, 'runtime-data');
  process.env.PIE_DATA_DIR = dataRoot;
  try {
    const stateDir = resolvePieDataPaths({ dataDir: dataRoot, agentDir: root }).stateDir;
    const store = new ActivationStore({ stateDir });
    await activateGeneration(store, {
      generationId: GENERATION_ID,
      buildId: 'build-1',
      qualificationSha256: SHA,
      trialSha256: SHA_B,
      activatedAt: '2026-09-12T04:00:00.000Z',
    });
    const active = store.read();
    const descriptor: AnalyticsBackendDescriptor = {
      generationId: GENERATION_ID,
      buildId: 'build-1',
      manifestRevision: active.manifest!.revision,
      manifestSha256: active.sha256!,
      workspaceId: 'workspace-1',
      hostInstanceId: 'host-1',
    };
    serverFor(root, descriptor).validateAnalyticsActivation();

    assert.throws(
      () => serverFor(root, { ...descriptor, buildId: 'stale-build' }).validateAnalyticsActivation(),
      /build does not match/u,
    );
    assert.throws(
      () => serverFor(root).validateAnalyticsActivation(),
      /descriptor is missing/u,
    );

    await store.update((current, currentSha256) => ({
      ...current!,
      revision: current!.revision + 1,
      previousSha256: currentSha256,
    }));
    assert.throws(
      () => serverFor(root, descriptor).validateAnalyticsActivation(),
      /manifest revision is stale/u,
    );
  } finally {
    if (previousDataRoot === undefined) delete process.env.PIE_DATA_DIR;
    else process.env.PIE_DATA_DIR = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend analytics activation rejects a candidate generation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-analytics-candidate-'));
  const previousDataRoot = process.env.PIE_DATA_DIR;
  const dataRoot = path.join(root, 'runtime-data');
  process.env.PIE_DATA_DIR = dataRoot;
  try {
    const stateDir = resolvePieDataPaths({ dataDir: dataRoot, agentDir: root }).stateDir;
    const store = new ActivationStore({ stateDir });
    await store.update(() => createCandidateManifest({
      generationId: GENERATION_ID,
      buildId: 'build-1',
      qualificationSha256: SHA,
      trialSha256: SHA_B,
    }), { expectedSha256: null });
    assert.throws(
      () => serverFor(root, {
        generationId: GENERATION_ID,
        buildId: 'build-1',
        manifestRevision: 1,
        manifestSha256: store.read().sha256!,
        workspaceId: 'workspace-1',
        hostInstanceId: 'host-1',
      }).validateAnalyticsActivation(),
      /no active generation/u,
    );
  } finally {
    if (previousDataRoot === undefined) delete process.env.PIE_DATA_DIR;
    else process.env.PIE_DATA_DIR = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
