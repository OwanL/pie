import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActivationManifestError } from '../../../shared/analytics/activation.js';
import { ActivationStore } from '../../src/analytics/activation-store.js';
import { activateGeneration } from '../../src/analytics/activation-sequence.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const OTHER_GENERATION_ID = '3a7f3c2d-0e5b-4f8c-9d4a-2b3c4d5e6f70';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ACTIVATED_AT = '2026-09-12T04:00:00.000Z';

function tempStore(): { root: string; store: ActivationStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-sequence-'));
  return { root, store: new ActivationStore({ stateDir: root }) };
}

function request(overrides: Partial<Parameters<typeof activateGeneration>[1]> = {}) {
  return {
    generationId: GENERATION_ID,
    buildId: 'build-1',
    qualificationSha256: SHA,
    trialSha256: SHA_B,
    activatedAt: ACTIVATED_AT,
    ...overrides,
  };
}

test('activation walks candidate, ready then active and switches authority', async () => {
  const { root, store } = tempStore();
  try {
    assert.equal(store.read().authority, 'legacy');

    const outcome = await activateGeneration(store, request());
    assert.equal(outcome.alreadyActive, false);
    const read = store.read();
    assert.equal(read.authority, 'canonical');
    assert.equal(read.manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
    assert.equal(read.manifest?.activeGeneration?.activatedAt, ACTIVATED_AT);
    assert.equal(read.manifest?.activeGeneration?.state, 'active');
    assert.equal(read.manifest?.successor, null, 'the successor slot must clear on activation');
    assert.equal(read.manifest?.everActive, true);
    // Three steps, so three revisions beyond the absent state.
    assert.equal(read.manifest?.revision, 3);
    // The tombstone is what forbids a later silent return to legacy.
    assert.equal(read.tombstonePresent, true);
    assert.equal(existsSync(store.tombstonePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation is idempotent for the already-active generation', async () => {
  const { root, store } = tempStore();
  try {
    const first = await activateGeneration(store, request());
    const revisionAfterFirst = first.revision;
    const second = await activateGeneration(store, request());
    assert.equal(second.alreadyActive, true);
    assert.equal(second.revision, revisionAfterFirst, 'a repeat must not write another revision');
    assert.equal(store.read().manifest?.revision, revisionAfterFirst);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resuming after the candidate step completes rather than duplicating evidence', async () => {
  const { root, store } = tempStore();
  try {
    // Simulate an interruption: write only the candidate, as the first step would.
    await store.update((current) => {
      assert.equal(current, null);
      return {
        schemaVersion: 1,
        revision: 1,
        previousSha256: null,
        everActive: false,
        activeGeneration: null,
        successor: {
          identity: {
            generationId: GENERATION_ID,
            buildId: 'build-1',
            qualificationSha256: SHA,
            trialSha256: SHA_B,
          },
          state: 'candidate',
          activatedAt: null,
          retiredAt: null,
          predecessorGenerationId: null,
          cutoffReceiptSha256: null,
        },
        retiredHistory: [],
      };
    });

    const outcome = await activateGeneration(store, request());
    assert.equal(outcome.alreadyActive, false);
    assert.equal(store.read().authority, 'canonical');
    assert.equal(store.read().manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different generation cannot displace an active one', async () => {
  const { root, store } = tempStore();
  try {
    await activateGeneration(store, request());
    await assert.rejects(
      () => activateGeneration(store, request({ generationId: OTHER_GENERATION_ID })),
      (error: unknown) => {
        assert.ok(error instanceof ActivationManifestError);
        assert.match(error.message, /already active/);
        return true;
      },
    );
    // The live authority must be untouched by the refusal.
    assert.equal(store.read().manifest?.activeGeneration?.identity.generationId, GENERATION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a recorded candidate with different evidence is refused rather than rewritten', async () => {
  const { root, store } = tempStore();
  try {
    await store.update(() => ({
      schemaVersion: 1,
      revision: 1,
      previousSha256: null,
      everActive: false,
      activeGeneration: null,
      successor: {
        identity: {
          generationId: GENERATION_ID,
          buildId: 'build-1',
          qualificationSha256: SHA,
          trialSha256: SHA_B,
        },
        state: 'candidate',
        activatedAt: null,
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: null,
      },
      retiredHistory: [],
    }));
    await assert.rejects(
      () => activateGeneration(store, request({ trialSha256: 'c'.repeat(64) })),
      /different evidence/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed activation evidence is rejected before any write', async () => {
  const { root, store } = tempStore();
  try {
    for (const overrides of [
      { qualificationSha256: 'not-a-hash' },
      { trialSha256: 'A'.repeat(64) },
      { generationId: 'not-a-uuid' },
      { buildId: '  ' },
      { activatedAt: '2026-09-12T04:00:00Z' },
    ]) {
      await assert.rejects(() => activateGeneration(store, request(overrides)), ActivationManifestError);
    }
    assert.equal(existsSync(store.manifestPath), false, 'a rejected request must not create a manifest');
    assert.equal(store.read().authority, 'legacy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a supplied cutoff receipt is recorded and a malformed one is refused', async () => {
  const { root, store } = tempStore();
  const receiptSha = 'd'.repeat(64);
  try {
    // Analytics activation and storage cutoff are separate ordered gates, so the
    // link is optional but must be a real hash when present - otherwise the
    // manifest would claim a cutoff it cannot be checked against.
    for (const malformed of ['not-a-hash', 'D'.repeat(64), receiptSha.slice(0, 63)]) {
      await assert.rejects(
        () => activateGeneration(store, request({ cutoffReceiptSha256: malformed })),
        ActivationManifestError,
      );
    }
    assert.equal(store.read().authority, 'legacy', 'no refused request may activate');

    const outcome = await activateGeneration(store, request({ cutoffReceiptSha256: receiptSha }));
    assert.equal(outcome.alreadyActive, false);
    assert.equal(store.read().manifest?.activeGeneration?.cutoffReceiptSha256, receiptSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation without a cutoff records null rather than inventing a receipt', async () => {
  const { root, store } = tempStore();
  try {
    await activateGeneration(store, request());
    assert.equal(
      store.read().manifest?.activeGeneration?.cutoffReceiptSha256,
      null,
      'a generation activated before any cutoff must not name one',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
