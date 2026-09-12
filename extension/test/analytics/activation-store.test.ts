import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_MANIFEST_FILENAME,
  ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
  ACTIVATION_TOMBSTONE_FILENAME,
  ActivationManifestError,
  createCandidateManifest,
  type ActivationManifest,
} from '../../../shared/analytics/activation.js';
import { ActivationStore } from '../../src/analytics/activation-store.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const NEXT_GENERATION_ID = '3a7f3c2d-0e5b-4f8c-9d4a-2b3c4d5e6f70';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ACTIVATED_AT = '2026-09-12T04:00:00.000Z';

function tempStore(): { root: string; store: ActivationStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-store-'));
  return { root, store: new ActivationStore({ stateDir: root }) };
}

function identity() {
  return { generationId: GENERATION_ID, buildId: 'build-1', qualificationSha256: SHA, trialSha256: SHA_B };
}

/** Advance the candidate to active with the revision and previous hash the
 * store's compare-and-swap requires. */
function activate(current: ActivationManifest, previousSha256: string): ActivationManifest {
  const successor = current.successor;
  if (!successor) throw new Error('fixture requires a successor');
  return {
    ...current,
    revision: current.revision + 1,
    previousSha256,
    everActive: true,
    activeGeneration: {
      ...successor,
      state: 'active',
      activatedAt: ACTIVATED_AT,
      cutoffReceiptSha256: SHA_B,
    },
    successor: null,
  };
}

test('an absent manifest selects legacy and creates nothing', () => {
  const { root, store } = tempStore();
  try {
    const read = store.read();
    assert.equal(read.manifest, null);
    assert.equal(read.sha256, null);
    assert.equal(read.authority, 'legacy');
    assert.equal(read.tombstonePresent, false);
    assert.equal(existsSync(store.manifestPath), false, 'reading must not create files');
    assert.equal(existsSync(store.tombstonePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate manifest round-trips and still selects legacy authority', async () => {
  const { root, store } = tempStore();
  try {
    const written = await store.update((current) => {
      assert.equal(current, null);
      return createCandidateManifest(identity());
    }, { expectedSha256: null });
    assert.equal(written.manifest?.successor?.state, 'candidate');
    assert.equal(written.authority, 'legacy', 'a candidate must not switch authority');
    assert.equal(written.sha256?.length, 64);
    // A tombstone must not exist until something actually activates.
    assert.equal(existsSync(store.tombstonePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation writes the tombstone and selects canonical authority', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    const activated = await store.update((current) => activate(current!, candidateSha), {});
    assert.equal(activated.authority, 'canonical');
    assert.equal(activated.manifest?.activeGeneration?.state, 'active');
    assert.equal(activated.tombstonePresent, true, 'the tombstone must exist after activation');
    const tombstone = JSON.parse(readFileSync(store.tombstonePath, 'utf8'));
    assert.equal(tombstone.everActive, true);
    assert.equal(tombstone.firstActiveGenerationId, GENERATION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a valid successor remains canonical while the immutable tombstone names the first generation', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    await store.update((current, previousSha256) => {
      const successor = current!.successor!;
      return {
        ...current!,
        revision: current!.revision + 1,
        previousSha256,
        everActive: true,
        activeGeneration: {
          ...successor,
          state: 'active',
          activatedAt: ACTIVATED_AT,
          cutoffReceiptSha256: SHA_B,
        },
        successor: null,
      };
    });
    const first = store.read().manifest!.activeGeneration!;
    await store.update((current, previousSha256) => ({
      ...current!,
      revision: current!.revision + 1,
      previousSha256,
      activeGeneration: {
        identity: {
          generationId: NEXT_GENERATION_ID,
          buildId: 'build-2',
          qualificationSha256: SHA_B,
          trialSha256: SHA,
        },
        state: 'active',
        activatedAt: '2026-09-12T05:00:00.000Z',
        retiredAt: null,
        predecessorGenerationId: first.identity.generationId,
        cutoffReceiptSha256: null,
      },
      successor: null,
      retiredHistory: [{
        ...first,
        state: 'retired',
        retiredAt: '2026-09-12T05:00:00.000Z',
      }],
    }));
    const read = store.read();
    assert.equal(read.authority, 'canonical');
    assert.equal(read.manifest?.activeGeneration?.identity.generationId, NEXT_GENERATION_ID);
    assert.equal(read.manifest?.retiredHistory[0]?.identity.generationId, GENERATION_ID);
    assert.equal(read.tombstonePresent, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a stale expectedSha256 rather than overwriting a concurrent writer', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const current = store.read();
    await assert.rejects(
      store.update((manifest) => ({ ...manifest!, revision: manifest!.revision + 1 }), {
        expectedSha256: SHA, // deliberately wrong
      }),
      /changed under the lock/u,
    );
    // The committed bytes must be untouched by the rejected write.
    assert.equal(store.read().sha256, current.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a revision that does not advance by exactly one', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    await assert.rejects(
      store.update((manifest) => ({ ...manifest!, revision: manifest!.revision + 2 }), {}),
      /must advance to 2/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a previousSha256 that does not name the replaced bytes', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    await assert.rejects(
      store.update((manifest) => ({ ...manifest!, revision: manifest!.revision + 1, previousSha256: SHA }), {}),
      /previousSha256 must match/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a post-activation downgrade before replacing committed bytes', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    await store.update((current) => activate(current!, candidateSha), {});
    const before = store.read();
    await assert.rejects(
      () => store.update((current, previousSha256) => ({
        ...current!,
        revision: current!.revision + 1,
        previousSha256,
        everActive: false,
        activeGeneration: null,
        successor: null,
        retiredHistory: [],
      }), {}),
      /forbids writing/u,
    );
    const after = store.read();
    assert.equal(after.sha256, before.sha256, 'rejected authority mutation must preserve committed bytes');
    assert.equal(after.manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects in-place active identity or activation-time changes before replacing bytes', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    await store.update((current) => activate(current!, candidateSha), {});
    const before = readFileSync(store.manifestPath);
    for (const activeGeneration of [
      {
        ...store.read().manifest!.activeGeneration!,
        identity: { ...store.read().manifest!.activeGeneration!.identity, buildId: 'tampered-build' },
      },
      {
        ...store.read().manifest!.activeGeneration!,
        activatedAt: '2026-09-12T05:00:00.000Z',
      },
    ]) {
      await assert.rejects(
        () => store.update((current, previousSha256) => ({
          ...current!,
          revision: current!.revision + 1,
          previousSha256,
          activeGeneration,
        }), {}),
        /identity or activation time cannot change/u,
      );
      assert.deepEqual(readFileSync(store.manifestPath), before, 'rejected mutation must preserve exact bytes');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an active replacement without matching predecessor evidence before replacing bytes', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    await store.update((current) => activate(current!, candidateSha), {});
    const before = readFileSync(store.manifestPath);
    const currentActive = store.read().manifest!.activeGeneration!;
    const nextIdentity = {
      generationId: NEXT_GENERATION_ID,
      buildId: 'build-2',
      qualificationSha256: SHA_B,
      trialSha256: SHA,
    };
    for (const activeGeneration of [
      {
        identity: nextIdentity,
        state: 'active' as const,
        activatedAt: '2026-09-12T05:00:00.000Z',
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: null,
      },
      {
        identity: nextIdentity,
        state: 'active' as const,
        activatedAt: '2026-09-12T05:00:00.000Z',
        retiredAt: null,
        predecessorGenerationId: currentActive.identity.generationId,
        cutoffReceiptSha256: null,
      },
    ]) {
      await assert.rejects(
        () => store.update((current, previousSha256) => ({
          ...current!,
          revision: current!.revision + 1,
          previousSha256,
          activeGeneration,
          successor: null,
          retiredHistory: activeGeneration.predecessorGenerationId === null
            ? []
            : [{
              ...currentActive,
              state: 'retired' as const,
              identity: { ...currentActive.identity, buildId: 'mismatched-build' },
              retiredAt: '2026-09-12T05:00:00.000Z',
            }],
        }), {}),
        /current active generation as its predecessor|matching retired evidence|predecessor that is not in retired history/u,
      );
      assert.deepEqual(readFileSync(store.manifestPath), before, 'rejected replacement must preserve exact bytes');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a manifest revision older than the immutable tombstone', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    await store.update((current) => activate(current!, candidateSha), {});
    const tombstone = JSON.parse(readFileSync(store.tombstonePath, 'utf8')) as Record<string, unknown>;
    tombstone.manifestRevision = (tombstone.manifestRevision as number) + 1;
    writeFileSync(store.tombstonePath, `${JSON.stringify(tombstone)}\n`, 'utf8');
    assert.throws(
      () => store.read(),
      /revision precedes the immutable first-activation tombstone/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed or oversized manifest fails closed instead of selecting legacy', async () => {
  const { root, store } = tempStore();
  try {
    writeFileSync(store.manifestPath, '{ not json', 'utf8');
    assert.throws(() => store.read(), ActivationManifestError);
    writeFileSync(store.manifestPath, 'x'.repeat(70_000), 'utf8');
    assert.throws(() => store.read(), /exceeds 65536 bytes/u);
    // A structurally valid but contract-violating manifest is also fatal.
    writeFileSync(store.manifestPath, JSON.stringify({ schemaVersion: 1 }), 'utf8');
    assert.throws(() => store.read(), ActivationManifestError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an everActive manifest without its tombstone fails closed', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    const candidateSha = store.read().sha256!;
    await store.update((current) => activate(current!, candidateSha), {});
    // Losing the tombstone must not reopen legacy writes.
    rmSync(store.tombstonePath, { force: true });
    assert.throws(() => store.read(), /tombstone is missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tombstone with no manifest fails closed and requires explicit recovery', () => {
  const { root, store } = tempStore();
  try {
    // This is the deliberate safe intermediate of a first activation. It must
    // never be interpreted as a return to legacy authority.
    writeFileSync(store.tombstonePath, JSON.stringify({ schemaVersion: 1, everActive: true }), 'utf8');
    assert.throws(
      () => store.read(),
      /refusing to re-enable legacy authority/u,
    );
    assert.equal(store.hasInterruptedActivation(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tombstone-only recovery refuses to reconstruct an authority after history loss', async () => {
  const { root, store } = tempStore();
  try {
    writeFileSync(store.tombstonePath, `${JSON.stringify({
      schemaVersion: ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
      everActive: true,
      firstActiveGenerationId: GENERATION_ID,
      identity: identity(),
      manifestRevision: 2,
      previousSha256: SHA,
      activatedAt: ACTIVATED_AT,
      cutoffReceiptSha256: SHA_B,
      recordedAt: ACTIVATED_AT,
    })}\n`, 'utf8');
    await assert.rejects(
      () => store.recoverInterruptedActivation(identity(), SHA_B),
      /exact ready predecessor/u,
    );
    assert.equal(existsSync(store.manifestPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted activation recovery adopts only a matching immutable tombstone', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => createCandidateManifest(identity()), { expectedSha256: null });
    await store.update((current, previousSha256) => ({
      ...current!,
      revision: current!.revision + 1,
      previousSha256,
      successor: { ...current!.successor!, state: 'ready' },
    }));
    const ready = store.read();
    const readyBytes = readFileSync(store.manifestPath);
    const tombstone = {
      schemaVersion: ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
      everActive: true,
      firstActiveGenerationId: GENERATION_ID,
      identity: identity(),
      manifestRevision: ready.manifest!.revision + 1,
      previousSha256: ready.sha256,
      activatedAt: ACTIVATED_AT,
      cutoffReceiptSha256: SHA_B,
      recordedAt: ACTIVATED_AT,
    };
    writeFileSync(store.tombstonePath, `${JSON.stringify(tombstone)}\n`, 'utf8');
    await assert.rejects(
      () => store.recoverInterruptedActivation({ ...identity(), generationId: '3a7f3c2d-0e5b-4f8c-9d4a-2b3c4d5e6f70' }, SHA_B),
      /identity does not match/u,
    );
    assert.deepEqual(readFileSync(store.manifestPath), readyBytes, 'mismatched evidence must not repair the authority');
    const recovered = await store.recoverInterruptedActivation(identity(), SHA_B);
    assert.equal(recovered.authority, 'canonical');
    assert.equal(recovered.manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
    assert.equal(recovered.manifest?.activeGeneration?.cutoffReceiptSha256, SHA_B);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the manifest is written to the derived state directory, never searched for', () => {
  const { root, store } = tempStore();
  try {
    assert.equal(path.dirname(store.manifestPath), root);
    assert.equal(path.basename(store.manifestPath), ACTIVATION_MANIFEST_FILENAME);
    assert.equal(path.basename(store.tombstonePath), ACTIVATION_TOMBSTONE_FILENAME);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
