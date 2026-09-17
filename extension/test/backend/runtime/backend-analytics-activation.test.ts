import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_SCHEMA_VERSION,
  createCandidateManifest,
  type AnalyticsBackendDescriptor,
} from '../../../../shared/analytics/activation.js';
import { resolvePieDataPaths } from '../../../../shared/pie-data-root.js';
import { ActivationStore } from '../../../src/analytics/activation-store.js';
import { BackendServer, analyticsWriterBuildId } from '../../../src/backend/server.js';
import { SessionLifecycleStore, type AnalyticsWriterIdentity } from '../../../src/backend/session-lifecycle-store.js';
import { PIE_BUILD_ID } from '../../../src/shared/build-identity.js';

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
  }) as unknown as {
    agentDir: string;
    validateAnalyticsActivation(): void;
  };
  server.agentDir = root;
  return server;
}

/** Commit the active revision-1 manifest a completed production activation
 * leaves behind: one active generation, a cleared successor, and the write-once
 * tombstone the store writes as part of the ever-active transition. */
async function activateFixtureGeneration(store: ActivationStore, options: {
  generationId: string;
  buildId: string;
  qualificationSha256: string;
  trialSha256: string;
  activatedAt: string;
  cutoffReceiptSha256: string | null;
}): Promise<void> {
  await store.update(() => ({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 1,
    previousSha256: null,
    everActive: true,
    activeGeneration: {
      identity: {
        generationId: options.generationId,
        buildId: options.buildId,
        qualificationSha256: options.qualificationSha256,
        trialSha256: options.trialSha256,
      },
      state: 'active',
      activatedAt: options.activatedAt,
      retiredAt: null,
      predecessorGenerationId: null,
      cutoffReceiptSha256: options.cutoffReceiptSha256,
    },
    successor: null,
    retiredHistory: [],
  }), { expectedSha256: null });
}

test('backend analytics activation validates exact active generation and rejects stale authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-analytics-activation-'));
  const previousDataRoot = process.env.PIE_DATA_DIR;
  const dataRoot = path.join(root, 'runtime-data');
  process.env.PIE_DATA_DIR = dataRoot;
  try {
    const stateDir = resolvePieDataPaths({ dataDir: dataRoot, agentDir: root }).stateDir;
    const store = new ActivationStore({ stateDir });
    await activateFixtureGeneration(store, {
      generationId: GENERATION_ID,
      buildId: 'build-1',
      qualificationSha256: SHA,
      trialSha256: SHA_B,
      activatedAt: '2026-09-12T04:00:00.000Z',
      cutoffReceiptSha256: SHA_B,
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

test('the backend writer identity uses the loaded host-boot marker, not the manifest build id', async () => {
  // Durable writer admission compares the backend's identity against the
  // registered lifecycle host row byte-for-byte, and that row carries the
  // loaded runtime's coordinated marker (`PIE_BUILD_ID`). Under the two-space
  // convention the manifest's analytics build id is a different value, so
  // deriving the writer identity from the descriptor would make every writer
  // inadmissible and stall startup.
  const root = mkdtempSync(path.join(tmpdir(), 'pie-backend-analytics-writer-space-'));
  const previousDataRoot = process.env.PIE_DATA_DIR;
  const dataRoot = path.join(root, 'runtime-data');
  process.env.PIE_DATA_DIR = dataRoot;
  try {
    const stateDir = resolvePieDataPaths({ dataDir: dataRoot, agentDir: root }).stateDir;
    const store = new ActivationStore({ stateDir });
    const manifestBuildId = 'qualification-build-id';
    assert.notEqual(
      manifestBuildId,
      PIE_BUILD_ID,
      'the fixture must distinguish the two spaces for this test to mean anything',
    );
    await activateFixtureGeneration(store, {
      generationId: GENERATION_ID,
      buildId: manifestBuildId,
      qualificationSha256: SHA,
      trialSha256: SHA_B,
      activatedAt: '2026-09-12T04:00:00.000Z',
      cutoffReceiptSha256: null,
    });
    const active = store.read();
    const descriptor: AnalyticsBackendDescriptor = {
      generationId: GENERATION_ID,
      buildId: manifestBuildId,
      manifestRevision: active.manifest!.revision,
      manifestSha256: active.sha256!,
      workspaceId: 'workspace-1',
      hostInstanceId: 'host-1',
    };
    const server = serverFor(root, descriptor);
    server.validateAnalyticsActivation();
    // The writer-identity derivation is the production seam; the server only
    // materializes it on the SDK-load path, so assert the seam directly.
    assert.equal(
      analyticsWriterBuildId(),
      PIE_BUILD_ID,
      'the writer identity must carry the loaded host-boot marker',
    );
    const identity: AnalyticsWriterIdentity = {
      hostInstanceId: descriptor.hostInstanceId,
      workspaceId: descriptor.workspaceId,
      generationId: descriptor.hostInstanceId,
      buildId: analyticsWriterBuildId(),
      processId: process.pid,
    };

    // Prove the identity is actually admissible against a registry row
    // registered the way the extension host registers one.
    const lifecycle = new SessionLifecycleStore(path.join(stateDir, 'session-lifecycle.sqlite'));
    try {
      lifecycle.registerAnalyticsHost({
        hostInstanceId: identity.hostInstanceId,
        workspaceId: identity.workspaceId,
        generationId: identity.generationId,
        buildId: PIE_BUILD_ID,
        processId: identity.processId,
        capabilities: ['host-discovery', 'host-status', 'authenticated-control', 'writer-fence'],
        registeredAtMs: String(Date.now()),
      });
      lifecycle.assertAnalyticsWriterAdmitted(identity, 0);
    } finally {
      lifecycle.close();
    }
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
