import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_SCHEMA_VERSION,
  ActivationManifestError,
  activationAuthority,
  createCandidateManifest,
  isCanonicalInstant,
  validateAnalyticsActivationTombstone,
  validateActivationManifest,
} from '../../../shared/analytics/activation.js';

const GENERATION_ID = '2f6e2b1c-9d4a-4e7b-8c3f-1a2b3c4d5e6f';
const PREDECESSOR_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function identity(overrides: Record<string, unknown> = {}) {
  return {
    generationId: GENERATION_ID,
    buildId: 'build-6be7f9bd2d637393bbbe',
    qualificationSha256: SHA,
    trialSha256: SHA_B,
    ...overrides,
  };
}

function activeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    identity: identity(),
    state: 'active',
    activatedAt: '2026-09-12T04:00:00.000Z',
    retiredAt: null,
    predecessorGenerationId: null,
    cutoffReceiptSha256: SHA_B,
    ...overrides,
  };
}

test('a candidate manifest validates and selects legacy authority', () => {
  const manifest = validateActivationManifest(createCandidateManifest(identity()));
  assert.equal(manifest.revision, 1);
  assert.equal(manifest.previousSha256, null);
  assert.equal(manifest.everActive, false);
  assert.equal(manifest.activeGeneration, null);
  assert.equal(manifest.successor?.state, 'candidate');
  assert.equal(activationAuthority(manifest), 'legacy', 'a candidate must not select canonical authority');
  assert.equal(activationAuthority(null), 'legacy', 'an absent manifest selects legacy');
});

test('only an active generation selects canonical authority', () => {
  const manifest = validateActivationManifest({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: activeEvidence(),
    successor: null,
    retiredHistory: [],
  });
  assert.equal(activationAuthority(manifest), 'canonical');
});

test('an ever-active retired or successor-only manifest cannot fall back to legacy', () => {
  const retiredOnly = validateActivationManifest({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: null,
    successor: null,
    retiredHistory: [{
      identity: identity({ generationId: PREDECESSOR_ID }),
      state: 'retired',
      activatedAt: '2026-09-12T03:00:00.000Z',
      retiredAt: '2026-09-12T04:00:00.000Z',
      predecessorGenerationId: null,
      cutoffReceiptSha256: null,
    }],
  });
  assert.throws(() => activationAuthority(retiredOnly), /re-enable legacy authority/u);

  const successorOnly = validateActivationManifest({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 1,
    previousSha256: null,
    everActive: true,
    activeGeneration: null,
    successor: {
      identity: identity({ generationId: PREDECESSOR_ID }),
      state: 'ready',
      activatedAt: null,
      retiredAt: null,
      predecessorGenerationId: null,
      cutoffReceiptSha256: null,
    },
    retiredHistory: [],
  });
  assert.throws(() => activationAuthority(successorOnly), /re-enable legacy authority/u);
});

test('rejects a schema mismatch, bad revision, and missing previous hash', () => {
  const base = {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: activeEvidence(),
    successor: null,
    retiredHistory: [],
  };
  assert.throws(
    () => validateActivationManifest({ ...base, schemaVersion: 99 }),
    /Unsupported activation manifest schema/u,
  );
  assert.throws(() => validateActivationManifest({ ...base, revision: 0 }), /positive safe integer/u);
  assert.throws(() => validateActivationManifest({ ...base, previousSha256: null }), /previous hash/u);
  assert.throws(
    () => validateActivationManifest({ ...base, revision: 1, previousSha256: SHA }),
    /must not have a previous hash/u,
  );
});

test('rejects unexpected keys rather than silently ignoring them', () => {
  assert.throws(
    () => validateActivationManifest({ ...createCandidateManifest(identity()), extra: true }),
    /unexpected keys/u,
  );
  const withExtraEvidenceKey = {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: { ...activeEvidence(), smuggled: 1 },
    successor: null,
    retiredHistory: [],
  };
  assert.throws(() => validateActivationManifest(withExtraEvidenceKey), /unexpected keys/u);
});

test('rejects state and timestamp disagreement', () => {
  const build = (activeGeneration: unknown) => ({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration,
    successor: null,
    retiredHistory: [],
  });
  // active without an instant
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({ activatedAt: null }))),
    /without an activation instant/u,
  );
  // candidate claiming an instant
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 1,
      previousSha256: null,
      everActive: false,
      activeGeneration: null,
      successor: activeEvidence({ state: 'candidate', activatedAt: '2026-09-12T04:00:00.000Z', cutoffReceiptSha256: null }),
      retiredHistory: [],
    }),
    /carries an activation instant/u,
  );
  // non-canonical instant
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({ activatedAt: '2026-09-12T04:00:00Z' }))),
    /canonical ISO instant/u,
  );
  // retired before activation
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({
      state: 'retired',
      activatedAt: '2026-09-12T05:00:00.000Z',
      retiredAt: '2026-09-12T04:00:00.000Z',
    }))),
    /retirement precedes/u,
  );
});

test('a candidate cannot carry a cutoff receipt', () => {
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 1,
      previousSha256: null,
      everActive: false,
      activeGeneration: null,
      successor: {
        identity: identity(),
        state: 'ready',
        activatedAt: null,
        retiredAt: null,
        predecessorGenerationId: null,
        cutoffReceiptSha256: SHA,
      },
      retiredHistory: [],
    }),
    /carries a cutoff receipt/u,
  );
});

test('an active generation may leave the later storage cutoff link null', () => {
  const manifest = validateActivationManifest({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: activeEvidence({ cutoffReceiptSha256: null }),
    successor: null,
    retiredHistory: [],
  });
  assert.equal(manifest.activeGeneration?.cutoffReceiptSha256, null);
});

test('pre-versioned activation tombstones fail closed instead of being upgraded', () => {
  assert.throws(
    () => validateAnalyticsActivationTombstone({ schemaVersion: 1, everActive: true }),
    /Unsupported activation tombstone schema/u,
  );
});

test('everActive must agree with the recorded generations', () => {
  // everActive with nothing recorded would silently re-enable legacy.
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 2,
      previousSha256: SHA,
      everActive: true,
      activeGeneration: null,
      successor: null,
      retiredHistory: [],
    }),
    /fails closed/u,
  );
  // never-active with history recorded is contradictory.
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 2,
      previousSha256: SHA,
      everActive: false,
      activeGeneration: null,
      successor: null,
      retiredHistory: [{
        identity: identity({ generationId: PREDECESSOR_ID }),
        state: 'retired',
        activatedAt: '2026-09-12T03:00:00.000Z',
        retiredAt: '2026-09-12T04:00:00.000Z',
        predecessorGenerationId: null,
        cutoffReceiptSha256: null,
      }],
    }),
    /everActive is false/u,
  );
});

test('an active generation must name a real retired predecessor in order', () => {
  const predecessor = {
    identity: identity({ generationId: PREDECESSOR_ID }),
    state: 'retired',
    activatedAt: '2026-09-12T03:00:00.000Z',
    retiredAt: '2026-09-12T04:00:00.000Z',
    predecessorGenerationId: null,
    cutoffReceiptSha256: null,
  };
  const good = validateActivationManifest({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 3,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: activeEvidence({ predecessorGenerationId: PREDECESSOR_ID }),
    successor: null,
    retiredHistory: [predecessor],
  });
  assert.equal(good.activeGeneration?.predecessorGenerationId, PREDECESSOR_ID);

  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 3,
      previousSha256: SHA,
      everActive: true,
      activeGeneration: activeEvidence({ predecessorGenerationId: PREDECESSOR_ID }),
      successor: null,
      retiredHistory: [],
    }),
    /not in retired history/u,
  );
});

test('a successor must differ from the active generation and be candidate or ready', () => {
  const withSuccessor = (successor: unknown) => ({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 3,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: activeEvidence(),
    successor,
    retiredHistory: [],
  });
  assert.throws(
    () => validateActivationManifest(withSuccessor(activeEvidence())),
    /candidate or ready/u,
  );
  assert.throws(
    () => validateActivationManifest(withSuccessor({
      identity: identity(),
      state: 'candidate',
      activatedAt: null,
      retiredAt: null,
      predecessorGenerationId: null,
      cutoffReceiptSha256: null,
    })),
    /different generation/u,
  );
});

test('retired history is bounded and must be retired', () => {
  const entry = (index: number) => ({
    identity: identity({
      generationId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    }),
    state: 'retired',
    activatedAt: '2026-09-12T03:00:00.000Z',
    retiredAt: '2026-09-12T04:00:00.000Z',
    predecessorGenerationId: null,
    cutoffReceiptSha256: null,
  });
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 3,
      previousSha256: SHA,
      everActive: true,
      activeGeneration: activeEvidence(),
      successor: null,
      retiredHistory: Array.from({ length: 33 }, (_value, index) => entry(index)),
    }),
    /exceeds 32 entries/u,
  );
  assert.throws(
    () => validateActivationManifest({
      schemaVersion: ACTIVATION_SCHEMA_VERSION,
      revision: 3,
      previousSha256: SHA,
      everActive: true,
      activeGeneration: activeEvidence(),
      successor: null,
      // A valid *active* evidence placed in retired history: the entry itself is
      // otherwise well-formed, so only the retired-state requirement can reject.
      retiredHistory: [{ ...entry(1), state: 'active', retiredAt: null, cutoffReceiptSha256: SHA }],
    }),
    /must be in the retired state/u,
  );
});

test('rejects malformed hashes, ids and unbounded strings', () => {
  const build = (evidence: unknown) => ({
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 2,
    previousSha256: SHA,
    everActive: true,
    activeGeneration: evidence,
    successor: null,
    retiredHistory: [],
  });
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({ identity: identity({ qualificationSha256: 'A'.repeat(64) }) }))),
    /canonical form/u,
    'hashes must be lowercase hex',
  );
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({ identity: identity({ generationId: 'not-a-uuid' }) }))),
    /canonical form/u,
  );
  assert.throws(
    () => validateActivationManifest(build(activeEvidence({ identity: identity({ buildId: 'x'.repeat(2_000) }) }))),
    /exceeds 1024 bytes/u,
  );
});

test('isCanonicalInstant accepts only exact round-tripping instants', () => {
  assert.equal(isCanonicalInstant('2026-09-12T04:00:00.000Z'), true);
  assert.equal(isCanonicalInstant('2026-09-12T04:00:00Z'), false);
  assert.equal(isCanonicalInstant('2026-09-12'), false);
  assert.equal(isCanonicalInstant('not a date'), false);
  assert.equal(isCanonicalInstant(0), false);
});
