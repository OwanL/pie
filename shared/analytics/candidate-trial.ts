/** P7 disposable candidate-trial authority: pure identity contract.
 *
 * The candidate trial is a DISTINCT in-memory authority, deliberately outside
 * the activation manifest model: it never creates an activation manifest or
 * tombstone, and its identity can never be carried by
 * {@link AnalyticsBackendDescriptor} or `ActivationGenerationIdentity`
 * (both defined in `./activation.js`). A trial grant authorizes exactly one
 * uniquely owned disposable OS-temp root, exactly once, for a bounded
 * lifetime, and is never production activation evidence.
 */
import { createHash } from 'node:crypto';

import { ActivationManifestError } from './activation.js';

export const CANDIDATE_TRIAL_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_TRIAL_AUTHORITY_KIND = 'pie-p7a-candidate-trial-authority-v1' as const;
/** Descriptor kind for the trial. Deliberately distinct from every manifest-derived value. */
export const CANDIDATE_TRIAL_DESCRIPTOR_KIND = 'candidate-trial' as const;
/** Default bounded trial lifetime; the ceiling is a hard factory validation bound. */
export const CANDIDATE_TRIAL_DEFAULT_MAX_LIFETIME_MS: number = 15 * 60_000;
export const CANDIDATE_TRIAL_MAX_LIFETIME_CEILING_MS: number = 60 * 60_000;

/** Pre-run trial identity. It binds the trial to one source head/fingerprint,
 * one build, and the qualification bytes it claims to extend. It deliberately
 * has no `trialSha256`: that field is minted only by production admission from
 * the exact final trial report bytes, after this trial is destroyed. */
export interface CandidateTrialPlanIdentity {
  /** Bounded correlation nonce (restart-nonce charset). */
  readonly trialId: string;
  readonly generationId: string;
  readonly buildId: string;
  /** Full 40-hex git commit head the trial source was built from. */
  readonly sourceHead: string;
  /** 64-hex source fingerprint bound by the integrator. */
  readonly sourceFingerprint: string;
  /** 64-hex sha256 of the qualification report the candidate extends. */
  readonly qualificationSha256: string;
}

export interface CandidateTrialPlan {
  readonly schemaVersion: typeof CANDIDATE_TRIAL_SCHEMA_VERSION;
  readonly kind: typeof CANDIDATE_TRIAL_AUTHORITY_KIND;
  readonly identity: CandidateTrialPlanIdentity;
  readonly workspaceId: string;
}

/** Trial identity exposed to callers that explicitly ask for it. It carries no
 * manifest revision/hash and no trialSha256, so it cannot be confused with (or
 * assigned to) a manifest-derived `AnalyticsBackendDescriptor`. */
export interface CandidateTrialDescriptor {
  readonly kind: typeof CANDIDATE_TRIAL_DESCRIPTOR_KIND;
  readonly trialId: string;
  readonly generationId: string;
  readonly buildId: string;
  readonly workspaceId: string;
  readonly hostInstanceId: string;
  /** sha256 of the exact pre-run plan bytes; never a manifest hash. */
  readonly trialPlanSha256: string;
  /** Monotonic in-memory authority revision owned by the trial factory. */
  readonly trialAuthorityRevision: number;
}

/** Paths inside the factory-owned disposable root. `state` and `analytics` use
 * the canonical Pie data-root names, but they are created only inside the
 * trial's own root and the activation state file is never written there. */
export interface CandidateTrialResolvedPaths {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly analyticsDir: string;
}

export interface CandidateTrialAuthorityGrant {
  readonly kind: typeof CANDIDATE_TRIAL_AUTHORITY_KIND;
  readonly schemaVersion: typeof CANDIDATE_TRIAL_SCHEMA_VERSION;
  readonly identity: CandidateTrialPlanIdentity;
  readonly workspaceId: string;
  /** sha256 over the canonical JSON of the exact validated plan. */
  readonly planSha256: string;
  readonly authorityRevision: number;
  readonly authorizedAt: string;
  readonly maxLifetimeMs: number;
  readonly resolvedPaths: CandidateTrialResolvedPaths;
}

const NONCE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA_40_PATTERN = /^[0-9a-f]{40}$/u;
const SHA_64_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ActivationManifestError('Candidate-trial authority value is not an object.');
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024
    || value !== value.trim()) {
    throw new ActivationManifestError(`Candidate-trial ${label} is invalid.`);
  }
  return value;
}

function sha64(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_64_PATTERN.test(value)) {
    throw new ActivationManifestError(`Candidate-trial ${label} is not a lowercase 64-hex sha256.`);
  }
  return value;
}

/** Canonical ISO instant, mirroring the activation contract's timestamp rule. */
function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ActivationManifestError(`Candidate-trial ${label} is not a canonical UTC ISO instant.`);
  }
  return value;
}

/** Validate the immutable pre-run plan. Exact keys, bounded values. */
export function validateCandidateTrialPlan(value: unknown): CandidateTrialPlan {
  const record = asRecord(value);
  if (record.schemaVersion !== CANDIDATE_TRIAL_SCHEMA_VERSION) {
    throw new ActivationManifestError(`Candidate-trial plan schemaVersion must be ${CANDIDATE_TRIAL_SCHEMA_VERSION}.`);
  }
  if (record.kind !== CANDIDATE_TRIAL_AUTHORITY_KIND) {
    throw new ActivationManifestError(`Candidate-trial plan kind must be ${CANDIDATE_TRIAL_AUTHORITY_KIND}.`);
  }
  const identity = asRecord(record.identity);
  for (const key of Object.keys(identity)) {
    if (key !== 'trialId' && key !== 'generationId' && key !== 'buildId'
      && key !== 'sourceHead' && key !== 'sourceFingerprint' && key !== 'qualificationSha256') {
      throw new ActivationManifestError(`Candidate-trial plan identity has an unexpected field: ${key}.`);
    }
  }
  const trialId = boundedString(identity.trialId, 'identity.trialId');
  if (!NONCE_PATTERN.test(trialId)) {
    throw new ActivationManifestError('Candidate-trial identity.trialId has an invalid format or exceeds 128 bytes.');
  }
  const generationId = boundedString(identity.generationId, 'identity.generationId');
  if (!UUID_PATTERN.test(generationId)) {
    throw new ActivationManifestError('Candidate-trial identity.generationId is not a lowercase UUID.');
  }
  const buildId = boundedString(identity.buildId, 'identity.buildId');
  const sourceHead = boundedString(identity.sourceHead, 'identity.sourceHead');
  if (!SHA_40_PATTERN.test(sourceHead)) {
    throw new ActivationManifestError('Candidate-trial identity.sourceHead is not a lowercase 40-hex commit.');
  }
  const sourceFingerprint = sha64(identity.sourceFingerprint, 'identity.sourceFingerprint');
  const qualificationSha256 = sha64(identity.qualificationSha256, 'identity.qualificationSha256');
  const workspaceId = boundedString(record.workspaceId, 'workspaceId');
  for (const key of Object.keys(record)) {
    if (key !== 'schemaVersion' && key !== 'kind' && key !== 'identity' && key !== 'workspaceId') {
      throw new ActivationManifestError(`Candidate-trial plan has an unexpected field: ${key}.`);
    }
  }
  const validated: CandidateTrialPlan = Object.freeze({
    schemaVersion: CANDIDATE_TRIAL_SCHEMA_VERSION,
    kind: CANDIDATE_TRIAL_AUTHORITY_KIND,
    identity: Object.freeze({
      trialId,
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      qualificationSha256,
    }),
    workspaceId,
  });
  return validated;
}

/** sha256 over the canonical JSON encoding of the exact validated plan. */
export function candidateTrialPlanSha256(plan: CandidateTrialPlan): string {
  const encoded = JSON.stringify([
    CANDIDATE_TRIAL_SCHEMA_VERSION,
    CANDIDATE_TRIAL_AUTHORITY_KIND,
    plan.identity,
    plan.workspaceId,
  ]);
  return createHash('sha256').update(encoded).digest('hex');
}

/** Validate a grant value (shape only; lifetime/ownership enforcement is the
 * factory's job). Grants are produced exclusively by the trial authority. */
export function validateCandidateTrialAuthorityGrant(value: unknown): CandidateTrialAuthorityGrant {
  const record = asRecord(value);
  if (record.schemaVersion !== CANDIDATE_TRIAL_SCHEMA_VERSION
    || record.kind !== CANDIDATE_TRIAL_AUTHORITY_KIND) {
    throw new ActivationManifestError('Candidate-trial grant kind/schemaVersion is invalid.');
  }
  const plan = validateCandidateTrialPlan({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    identity: record.identity,
    workspaceId: record.workspaceId,
  });
  const planSha256 = sha64(record.planSha256, 'planSha256');
  const authorityRevision = record.authorityRevision;
  if (!Number.isSafeInteger(authorityRevision) || (authorityRevision as number) < 1) {
    throw new ActivationManifestError('Candidate-trial grant authorityRevision is invalid.');
  }
  const authorizedAt = canonicalIso(record.authorizedAt, 'authorizedAt');
  const maxLifetimeMs = record.maxLifetimeMs;
  if (!Number.isSafeInteger(maxLifetimeMs) || (maxLifetimeMs as number) <= 0
    || (maxLifetimeMs as number) > CANDIDATE_TRIAL_MAX_LIFETIME_CEILING_MS) {
    throw new ActivationManifestError('Candidate-trial grant maxLifetimeMs is outside the bounded range.');
  }
  const resolvedPaths = asRecord(record.resolvedPaths);
  const rootDir = boundedString(resolvedPaths.rootDir, 'resolvedPaths.rootDir');
  const stateDir = boundedString(resolvedPaths.stateDir, 'resolvedPaths.stateDir');
  const analyticsDir = boundedString(resolvedPaths.analyticsDir, 'resolvedPaths.analyticsDir');
  return Object.freeze({
    kind: CANDIDATE_TRIAL_AUTHORITY_KIND,
    schemaVersion: CANDIDATE_TRIAL_SCHEMA_VERSION,
    identity: plan.identity,
    workspaceId: plan.workspaceId,
    planSha256,
    authorityRevision: authorityRevision as number,
    authorizedAt,
    maxLifetimeMs: maxLifetimeMs as number,
    resolvedPaths: Object.freeze({ rootDir, stateDir, analyticsDir }),
  });
}

/** Validate the trial descriptor. It must never gain manifest-derived fields. */
export function validateCandidateTrialDescriptor(value: unknown): CandidateTrialDescriptor {
  const record = asRecord(value);
  if (record.kind !== CANDIDATE_TRIAL_DESCRIPTOR_KIND) {
    throw new ActivationManifestError(`Candidate-trial descriptor kind must be ${CANDIDATE_TRIAL_DESCRIPTOR_KIND}.`);
  }
  const trialId = boundedString(record.trialId, 'descriptor.trialId');
  if (!NONCE_PATTERN.test(trialId)) {
    throw new ActivationManifestError('Candidate-trial descriptor trialId is invalid.');
  }
  const generationId = boundedString(record.generationId, 'descriptor.generationId');
  if (!UUID_PATTERN.test(generationId)) {
    throw new ActivationManifestError('Candidate-trial descriptor generationId is not a lowercase UUID.');
  }
  const buildId = boundedString(record.buildId, 'descriptor.buildId');
  const workspaceId = boundedString(record.workspaceId, 'descriptor.workspaceId');
  const hostInstanceId = boundedString(record.hostInstanceId, 'descriptor.hostInstanceId');
  const trialPlanSha256 = sha64(record.trialPlanSha256, 'descriptor.trialPlanSha256');
  const trialAuthorityRevision = record.trialAuthorityRevision;
  if (!Number.isSafeInteger(trialAuthorityRevision) || (trialAuthorityRevision as number) < 1) {
    throw new ActivationManifestError('Candidate-trial descriptor trialAuthorityRevision is invalid.');
  }
  for (const forbidden of ['manifestRevision', 'manifestSha256', 'trialSha256']) {
    if (forbidden in record) {
      throw new ActivationManifestError(`Candidate-trial descriptor must not carry ${forbidden}.`);
    }
  }
  return Object.freeze({
    kind: CANDIDATE_TRIAL_DESCRIPTOR_KIND,
    trialId,
    generationId,
    buildId,
    workspaceId,
    hostInstanceId,
    trialPlanSha256,
    trialAuthorityRevision: trialAuthorityRevision as number,
  });
}