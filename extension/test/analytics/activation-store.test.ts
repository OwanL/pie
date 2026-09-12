import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ACTIVATION_MANIFEST_FILENAME,
  ACTIVATION_TOMBSTONE_FILENAME,
  ActivationManifestError,
  createCandidateManifest,
  type ActivationManifest,
} from '../../../shared/analytics/activation.js';
import { ActivationStore } from '../../src/analytics/activation-store.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
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

test('a tombstone with no manifest reports legacy authority without failing', () => {
  const { root, store } = tempStore();
  try {
    // This is the deliberate safe intermediate of a first activation.
    writeFileSync(store.tombstonePath, JSON.stringify({ schemaVersion: 1, everActive: true }), 'utf8');
    const read = store.read();
    assert.equal(read.manifest, null);
    assert.equal(read.tombstonePresent, true);
    assert.equal(read.authority, 'legacy', 'no manifest means legacy, and the tombstone still fences it');
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
