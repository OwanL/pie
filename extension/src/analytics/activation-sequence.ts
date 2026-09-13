import {
  ActivationManifestError,
  type ActivationEvidence,
  type ActivationGenerationIdentity,
  type ActivationManifest,
} from '../../../shared/analytics/activation.js';
import type { ActivationStore } from './activation-store.js';

/** Inputs a one-shot activation must supply as evidence.
 *
 * Both hashes name exact reports, so an activation cannot be recorded without
 * something to point at. They are hashes rather than parsed reports because the
 * owner of the qualification is not the owner of the manifest, and this module
 * deliberately does not re-implement report validation. */
export interface ActivationRequest {
  generationId: string;
  buildId: string;
  /** Lowercase sha256 of the qualification report this generation was admitted by. */
  qualificationSha256: string;
  /** Lowercase sha256 of the isolated candidate-trial report. */
  trialSha256: string;
  /** Canonical ISO instant the generation became active. */
  activatedAt: string;
  /** Optional sha256 of the later P7b storage-cutoff receipt this generation is
   * linked to. P7a analytics activation intentionally does not close sessions. */
  cutoffReceiptSha256?: string | null;
}

export interface ActivationOutcome {
  readonly manifest: ActivationManifest;
  readonly alreadyActive: boolean;
  readonly revision: number;
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requireEvidence(request: ActivationRequest): ActivationGenerationIdentity {
  const hash = (value: string, label: string): string => {
    if (!/^[0-9a-f]{64}$/u.test(value)) {
      throw new ActivationManifestError(`${label} must be a lowercase sha256.`);
    }
    return value;
  };
  if (!/^[0-9a-f-]{36}$/iu.test(request.generationId)) {
    throw new ActivationManifestError('generationId must be a UUID.');
  }
  if (request.buildId.trim().length === 0) {
    throw new ActivationManifestError('buildId must be a non-empty string.');
  }
  if (!isCanonicalInstant(request.activatedAt)) {
    throw new ActivationManifestError('activatedAt must be a canonical ISO instant.');
  }
  return {
    generationId: request.generationId,
    buildId: request.buildId,
    qualificationSha256: hash(request.qualificationSha256, 'qualificationSha256'),
    trialSha256: hash(request.trialSha256, 'trialSha256'),
  };
}

/** Perform the whole candidate -> ready -> active sequence in one call.
 *
 * The contract's states are what make a partial activation safe to interrupt, so
 * each step is a separate revision-CAS'd write rather than one large edit. That
 * matters because the process performing activation is a one-shot helper that
 * may be terminated between steps: stopping after any step leaves a manifest
 * that still validates and still selects a definite authority, and re-running
 * the sequence resumes instead of corrupting the record.
 *
 * - candidate: a generation is recorded but does not yet hold authority
 * - ready: the generation's evidence is complete and it may activate
 * - active: authority switches, successor clears, tombstone is written
 *
 * Idempotent. If the requested generation is already active it returns without
 * writing, so an interrupted run can be safely repeated. A different generation
 * being active is refused rather than overwritten: replacing a live authority is
 * a retirement, which needs its own reviewed path.
 */
export async function activateGeneration(
  store: ActivationStore,
  request: ActivationRequest,
): Promise<ActivationOutcome> {
  const identity = requireEvidence(request);
  const cutoffReceipt = cutoffReceiptSha256(request);

  let current;
  try {
    current = store.read();
  } catch (error) {
    if (error instanceof ActivationManifestError && store.hasInterruptedActivation()) {
      const recovered = await store.recoverInterruptedActivation(identity, cutoffReceipt);
      return { manifest: recovered.manifest!, alreadyActive: false, revision: recovered.manifest!.revision };
    }
    throw error;
  }
  // Every transition below is fenced to the exact bytes observed by the
  // preceding read/update.  This matters even though update() re-reads under
  // its lock: two callers can both observe an absent manifest before either
  // obtains that lock, and only the first caller may create the candidate.
  let currentSha256 = current.sha256;
  const activeGeneration = current.manifest?.activeGeneration ?? null;
  if (activeGeneration) {
    if (activeGeneration.identity.generationId === identity.generationId) {
      if (activeGeneration.identity.buildId !== identity.buildId
        || activeGeneration.identity.qualificationSha256 !== identity.qualificationSha256
        || activeGeneration.identity.trialSha256 !== identity.trialSha256
        || activeGeneration.cutoffReceiptSha256 !== cutoffReceipt) {
        throw new ActivationManifestError(
          'The requested active generation carries different activation evidence; refusing idempotent adoption.',
        );
      }
      return { manifest: current.manifest!, alreadyActive: true, revision: current.manifest!.revision };
    }
    throw new ActivationManifestError(
      `Analytics generation ${activeGeneration.identity.generationId} is already active; `
      + `activating ${identity.generationId} would require retiring it first.`,
    );
  }

  // Step 1: record or adopt the candidate. Adopting an existing candidate for the
  // same identity keeps a resumed run from rewriting identical evidence.
  let manifest = current.manifest;
  const existingSuccessor = manifest?.successor ?? null;
  if (existingSuccessor && existingSuccessor.identity.generationId === identity.generationId) {
    if (existingSuccessor.identity.buildId !== identity.buildId
      || existingSuccessor.identity.qualificationSha256 !== identity.qualificationSha256
      || existingSuccessor.identity.trialSha256 !== identity.trialSha256) {
      throw new ActivationManifestError('The recorded candidate carries different evidence; refusing to rewrite it.');
    }
  } else {
    if (existingSuccessor) {
      throw new ActivationManifestError(
        `Candidate ${existingSuccessor.identity.generationId} is already recorded; `
        + `activating ${identity.generationId} would require retiring it first.`,
      );
    }
    const result = await store.update((previous, previousSha256) => {
      if (!previous) {
        return {
          schemaVersion: 1,
          revision: 1,
          previousSha256: null,
          everActive: false,
          activeGeneration: null,
          successor: candidateEvidence(identity),
          retiredHistory: [],
        };
      }
      return {
        ...previous,
        revision: previous.revision + 1,
        previousSha256,
        successor: candidateEvidence(identity),
      };
    }, { expectedSha256: currentSha256 });
    manifest = result.manifest;
    currentSha256 = result.sha256;
  }

  // Step 2: candidate -> ready. Separate revision so an interruption between
  // steps is observable rather than silently skipped.
  if (manifest!.successor?.state === 'candidate') {
    const result = await store.update((previous, previousSha256) => {
      const successor = previous?.successor;
      if (!previous || !successor) throw new ActivationManifestError('Candidate disappeared between steps.');
      return {
        ...previous,
        revision: previous.revision + 1,
        previousSha256,
        successor: { ...successor, state: 'ready' },
      };
    }, { expectedSha256: currentSha256 });
    manifest = result.manifest;
    currentSha256 = result.sha256;
  }

  // Step 3: ready -> active. This revision writes the tombstone first (inside the
  // store), so the reachable intermediate is tombstone-without-active-manifest,
  // which still fails closed.
  const readySuccessor = manifest!.successor;
  if (!readySuccessor || readySuccessor.state !== 'ready') {
    throw new ActivationManifestError('Activation reached step 3 without a ready candidate.');
  }
  const active: ActivationEvidence = {
    identity: readySuccessor.identity,
    state: 'active',
    activatedAt: request.activatedAt,
    retiredAt: null,
    predecessorGenerationId: null,
    cutoffReceiptSha256: cutoffReceipt,
  };
  const result = await store.update((previous, previousSha256) => {
    if (!previous) throw new ActivationManifestError('Manifest disappeared between steps.');
    return {
      ...previous,
      revision: previous.revision + 1,
      previousSha256,
      everActive: true,
      activeGeneration: active,
      successor: null,
    };
  }, { expectedSha256: currentSha256 });
  return { manifest: result.manifest!, alreadyActive: false, revision: result.manifest!.revision };
}

/** Link the verified P7b cutoff receipt to the already-active generation.
 *
 * P7a activation intentionally runs before storage cutoff, so the activation
 * request normally has no receipt hash. This separate, revision-CAS'd step is
 * the only way to add that later evidence; it is idempotent for the exact same
 * receipt and refuses to replace a different link. */
export async function linkStorageCutoffReceipt(
  store: ActivationStore,
  receiptSha256: string,
  expectedGenerationId?: string,
): Promise<ActivationOutcome> {
  if (!/^[0-9a-f]{64}$/u.test(receiptSha256)) {
    throw new ActivationManifestError('cutoffReceiptSha256 must be a lowercase sha256.');
  }
  if (expectedGenerationId !== undefined && !/^[0-9a-f-]{36}$/iu.test(expectedGenerationId)) {
    throw new ActivationManifestError('expectedGenerationId must be a UUID.');
  }
  const current = store.read();
  const active = current.manifest?.activeGeneration;
  if (!active || !current.sha256) {
    throw new ActivationManifestError('A cutoff receipt can only be linked to an active analytics generation.');
  }
  if (expectedGenerationId !== undefined && active.identity.generationId !== expectedGenerationId) {
    throw new ActivationManifestError('The active analytics generation does not match the requested cutoff link.');
  }
  if (active.cutoffReceiptSha256 !== null && active.cutoffReceiptSha256 !== receiptSha256) {
    throw new ActivationManifestError('The active analytics generation is already linked to another cutoff receipt.');
  }
  if (active.cutoffReceiptSha256 === receiptSha256) {
    return { manifest: current.manifest!, alreadyActive: true, revision: current.manifest!.revision };
  }
  const result = await store.update((previous, previousSha256) => {
    if (!previous?.activeGeneration) {
      throw new ActivationManifestError('The active analytics generation disappeared before the cutoff link.');
    }
    if (previous.activeGeneration.identity.generationId !== active.identity.generationId
      || previous.activeGeneration.cutoffReceiptSha256 !== null) {
      throw new ActivationManifestError('The active analytics generation changed before the cutoff link.');
    }
    return {
      ...previous,
      revision: previous.revision + 1,
      previousSha256,
      activeGeneration: {
        ...previous.activeGeneration,
        cutoffReceiptSha256: receiptSha256,
      },
    };
  }, { expectedSha256: current.sha256 });
  return { manifest: result.manifest!, alreadyActive: false, revision: result.manifest!.revision };
}

function candidateEvidence(identity: ActivationGenerationIdentity): ActivationEvidence {
  return {
    identity,
    state: 'candidate',
    activatedAt: null,
    retiredAt: null,
    predecessorGenerationId: null,
    cutoffReceiptSha256: null,
  };
}

/** Validate an optional cutoff receipt hash.
 *
 * Present must mean a real sha256: a caller passing a path or a truncated value
 * would otherwise record an unverifiable link between the generation and the
 * cutoff it claims to follow. */
function cutoffReceiptSha256(request: ActivationRequest): string | null {
  const value = request.cutoffReceiptSha256;
  if (value === undefined || value === null) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new ActivationManifestError('cutoffReceiptSha256 must be a lowercase sha256 when provided.');
  }
  return value;
}
