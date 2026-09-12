/**
 * Canonical analytics activation manifest contract.
 *
 * This is the authority switch between the legacy analytics implementation and
 * the canonical store. It is deliberately explicit and fail-closed:
 *
 * - An **absent** manifest selects the legacy authority.
 * - A **malformed** or unreadable manifest fails host startup closed rather than
 *   silently falling back to legacy, because a half-written or corrupt
 *   authority record must never be interpreted as "not yet activated".
 * - Once the write-once `ever-active` tombstone exists, losing or trimming the
 *   main manifest can never re-enable legacy writes.
 *
 * The module is pure validation and shaping: file I/O, locking and atomic writes
 * belong to the store that owns the directory, so this contract stays usable from
 * the doctor, tests and the host without importing runtime state.
 */

/** File names are derived from the resolved state directory, never searched for. */
export const ACTIVATION_MANIFEST_FILENAME = 'analytics-activation-v1.json';
export const ACTIVATION_TOMBSTONE_FILENAME = 'analytics-ever-active-v1.json';

/** Bounds. Every string and every list is bounded so a corrupt or hostile file
 * cannot make startup allocate without limit. */
export const ACTIVATION_MAX_FILE_BYTES = 65_536;
export const ACTIVATION_MAX_HISTORY_ENTRIES = 32;
export const ACTIVATION_MAX_STRING_BYTES = 1_024;

export const ACTIVATION_SCHEMA_VERSION = 1;
/** Version 2 adds the complete first-activation recovery evidence. Version 1
 * tombstones are deliberately unsupported rather than ambiguously upgraded. */
export const ACTIVATION_TOMBSTONE_SCHEMA_VERSION = 2 as const;

export type AnalyticsAuthority = 'legacy' | 'canonical';
export type ActivationGenerationState = 'candidate' | 'ready' | 'active' | 'retired';

/**
 * Immutable identity passed from a canonical extension host to its backend.
 * The manifest revision and byte hash fence the descriptor to the exact
 * authority snapshot the host started with; they are deliberately carried
 * alongside the generation/build identity rather than re-derived in the
 * child process.
 */
export interface AnalyticsBackendDescriptor {
  readonly generationId: string;
  readonly buildId: string;
  readonly manifestRevision: number;
  readonly manifestSha256: string;
  readonly workspaceId: string;
  readonly hostInstanceId: string;
}

/** Post-readiness evidence written by the host process that actually loaded a
 * canonical generation. The host identity and optional restart nonce prevent a
 * stale marker from being mistaken for evidence from a later restart. */
export const ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION = 1 as const;
export interface AnalyticsLoadedGenerationReceipt {
  readonly schemaVersion: typeof ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION;
  readonly generationId: string;
  readonly buildId: string;
  readonly manifestRevision: number;
  readonly manifestSha256: string;
  readonly workspaceId: string;
  readonly hostInstanceId: string;
  readonly restartNonce: string | null;
  readonly loadedAt: string;
}

/** A generation is identified by a UUID plus the exact build it was validated
 * against. Neither is inferred from the current process. */
export interface ActivationGenerationIdentity {
  readonly generationId: string;
  readonly buildId: string;
  /** Lowercase sha256 of the qualification report the generation was admitted by. */
  readonly qualificationSha256: string;
  /** Lowercase sha256 of the isolated candidate-trial report. */
  readonly trialSha256: string;
}

export interface ActivationEvidence {
  readonly identity: ActivationGenerationIdentity;
  readonly state: ActivationGenerationState;
  /** Canonical ISO instant, null while candidate/ready. */
  readonly activatedAt: string | null;
  readonly retiredAt: string | null;
  /** Predecessor generation this one replaced, null for the first generation. */
  readonly predecessorGenerationId: string | null;
  /** Optional later P7b storage-cutoff receipt linked to this generation. */
  readonly cutoffReceiptSha256: string | null;
}

export interface ActivationManifest {
  readonly schemaVersion: number;
  /** Monotonic revision; increases by exactly one per accepted write. */
  readonly revision: number;
  /** sha256 of the exact bytes of the previous revision, null at revision 1. */
  readonly previousSha256: string | null;
  /** Mirrors the tombstone. Once true it never returns to false. */
  readonly everActive: boolean;
  /** Exactly zero or one active generation. */
  readonly activeGeneration: ActivationEvidence | null;
  /** Optional single successor that has not replaced current authority. */
  readonly successor: ActivationEvidence | null;
  /** Bounded audit history. Trimming this list cannot affect authority. */
  readonly retiredHistory: readonly ActivationEvidence[];
}

export class ActivationManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationManifestError';
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ANALYTICS_RESTART_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** True when `value` is a canonical ISO instant that round-trips exactly. */
export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

/** The immutable evidence written before the first active manifest revision.
 *
 * This is intentionally a complete identity rather than only a generation id:
 * after a crash between the tombstone and manifest writes, recovery may adopt
 * the tombstone only when the caller supplies the exact same candidate evidence.
 */
export interface AnalyticsActivationTombstone {
  readonly schemaVersion: typeof ACTIVATION_TOMBSTONE_SCHEMA_VERSION;
  readonly everActive: true;
  readonly firstActiveGenerationId: string;
  readonly identity: ActivationGenerationIdentity;
  /** Revision and predecessor hash of the active manifest being installed. */
  readonly manifestRevision: number;
  readonly previousSha256: string | null;
  readonly activatedAt: string;
  readonly cutoffReceiptSha256: string | null;
  readonly recordedAt: string;
}

/** Restart nonces are helper-issued correlation values. Keep their grammar
 * bounded so a receipt cannot carry arbitrary environment text. */
export function isAnalyticsRestartNonce(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 128
    && ANALYTICS_RESTART_NONCE_PATTERN.test(value);
}

function assertBoundedString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActivationManifestError(`${label} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, 'utf8') > ACTIVATION_MAX_STRING_BYTES) {
    throw new ActivationManifestError(`${label} exceeds ${ACTIVATION_MAX_STRING_BYTES} bytes.`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ActivationManifestError(`${label} is not in the required canonical form.`);
  }
  return value;
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ActivationManifestError(`${label} has unexpected keys: ${actual.join(', ')}.`);
  }
}

/** Validate the small post-readiness receipt written by the loaded host. This
 * is shared with readers so the marker cannot be accepted merely because it
 * parses as JSON. */
export function validateAnalyticsLoadedGenerationReceipt(value: unknown): AnalyticsLoadedGenerationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationManifestError('Loaded generation receipt must be an object.');
  }
  assertExactKeys(value, [
    'schemaVersion', 'generationId', 'buildId', 'manifestRevision', 'manifestSha256',
    'workspaceId', 'hostInstanceId', 'restartNonce', 'loadedAt',
  ], 'Loaded generation receipt');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION) {
    throw new ActivationManifestError('Unsupported loaded generation receipt schema.');
  }
  const restartNonce = raw.restartNonce === null
    ? null
    : raw.restartNonce;
  if (restartNonce !== null && !isAnalyticsRestartNonce(restartNonce)) {
    throw new ActivationManifestError('Loaded generation receipt restartNonce is invalid.');
  }
  if (!isCanonicalInstant(raw.loadedAt)) {
    throw new ActivationManifestError('Loaded generation receipt loadedAt is not a canonical ISO instant.');
  }
  if (!Number.isSafeInteger(raw.manifestRevision) || (raw.manifestRevision as number) < 1) {
    throw new ActivationManifestError('Loaded generation receipt manifestRevision must be positive.');
  }
  return {
    schemaVersion: ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
    generationId: assertBoundedString(raw.generationId, 'Loaded generation receipt generationId', UUID_PATTERN),
    buildId: assertBoundedString(raw.buildId, 'Loaded generation receipt buildId'),
    manifestRevision: raw.manifestRevision as number,
    manifestSha256: assertBoundedString(raw.manifestSha256, 'Loaded generation receipt manifestSha256', SHA256_PATTERN),
    workspaceId: assertBoundedString(raw.workspaceId, 'Loaded generation receipt workspaceId'),
    hostInstanceId: assertBoundedString(raw.hostInstanceId, 'Loaded generation receipt hostInstanceId'),
    restartNonce,
    loadedAt: raw.loadedAt,
  };
}

function validateEvidence(value: unknown, label: string): ActivationEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationManifestError(`${label} must be an object.`);
  }
  assertExactKeys(value, [
    'identity', 'state', 'activatedAt', 'retiredAt', 'predecessorGenerationId', 'cutoffReceiptSha256',
  ], label);
  const raw = value as Record<string, unknown>;
  const identity = raw.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new ActivationManifestError(`${label}.identity must be an object.`);
  }
  assertExactKeys(identity, ['generationId', 'buildId', 'qualificationSha256', 'trialSha256'], `${label}.identity`);
  const identityRaw = identity as Record<string, unknown>;
  const state = raw.state;
  if (state !== 'candidate' && state !== 'ready' && state !== 'active' && state !== 'retired') {
    throw new ActivationManifestError(`${label}.state is not a known generation state.`);
  }
  const activatedAt = raw.activatedAt === null ? null : raw.activatedAt;
  const retiredAt = raw.retiredAt === null ? null : raw.retiredAt;
  if (activatedAt !== null && !isCanonicalInstant(activatedAt)) {
    throw new ActivationManifestError(`${label}.activatedAt is not a canonical ISO instant.`);
  }
  if (retiredAt !== null && !isCanonicalInstant(retiredAt)) {
    throw new ActivationManifestError(`${label}.retiredAt is not a canonical ISO instant.`);
  }
  // State and timestamps must agree; a generation cannot be active without an
  // activation instant, and cannot be retired without a retirement instant.
  if (state === 'active' || state === 'retired') {
    if (activatedAt === null) throw new ActivationManifestError(`${label} is ${state} without an activation instant.`);
  } else if (activatedAt !== null) {
    throw new ActivationManifestError(`${label} is ${state} but carries an activation instant.`);
  }
  if (state === 'retired' && retiredAt === null) {
    throw new ActivationManifestError(`${label} is retired without a retirement instant.`);
  }
  if (state !== 'retired' && retiredAt !== null) {
    throw new ActivationManifestError(`${label} is ${state} but carries a retirement instant.`);
  }
  if (state === 'retired' && activatedAt !== null && retiredAt !== null
    && Date.parse(retiredAt) < Date.parse(activatedAt)) {
    throw new ActivationManifestError(`${label} retirement precedes its activation.`);
  }
  const predecessorGenerationId = raw.predecessorGenerationId === null
    ? null
    : assertBoundedString(raw.predecessorGenerationId, `${label}.predecessorGenerationId`, UUID_PATTERN);
  const cutoffReceiptSha256 = raw.cutoffReceiptSha256 === null
    ? null
    : assertBoundedString(raw.cutoffReceiptSha256, `${label}.cutoffReceiptSha256`, SHA256_PATTERN);
  // An active generation must have fenced every writer; a candidate must not
  // claim it has.
  if (state !== 'active' && state !== 'retired' && cutoffReceiptSha256 !== null) {
    throw new ActivationManifestError(`${label} is ${state} but carries a cutoff receipt.`);
  }
  return {
    identity: {
      generationId: assertBoundedString(identityRaw.generationId, `${label}.identity.generationId`, UUID_PATTERN),
      buildId: assertBoundedString(identityRaw.buildId, `${label}.identity.buildId`),
      qualificationSha256: assertBoundedString(identityRaw.qualificationSha256, `${label}.identity.qualificationSha256`, SHA256_PATTERN),
      trialSha256: assertBoundedString(identityRaw.trialSha256, `${label}.identity.trialSha256`, SHA256_PATTERN),
    },
    state,
    activatedAt,
    retiredAt,
    predecessorGenerationId,
    cutoffReceiptSha256,
  };
}

/** Validate a parsed candidate against the full activation contract.
 * Throws {@link ActivationManifestError} on any deviation; never repairs. */
export function validateActivationManifest(value: unknown): ActivationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationManifestError('Activation manifest must be an object.');
  }
  assertExactKeys(value, [
    'schemaVersion', 'revision', 'previousSha256', 'everActive',
    'activeGeneration', 'successor', 'retiredHistory',
  ], 'Activation manifest');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== ACTIVATION_SCHEMA_VERSION) {
    throw new ActivationManifestError(
      `Unsupported activation manifest schema ${String(raw.schemaVersion)}; expected ${ACTIVATION_SCHEMA_VERSION}.`,
    );
  }
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) {
    throw new ActivationManifestError('Activation manifest revision must be a positive safe integer.');
  }
  const previousSha256 = raw.previousSha256 === null
    ? null
    : assertBoundedString(raw.previousSha256, 'previousSha256', SHA256_PATTERN);
  if ((raw.revision as number) === 1 && previousSha256 !== null) {
    throw new ActivationManifestError('The first manifest revision must not have a previous hash.');
  }
  if ((raw.revision as number) > 1 && previousSha256 === null) {
    throw new ActivationManifestError('Manifest revisions after the first must record the previous hash.');
  }
  if (typeof raw.everActive !== 'boolean') {
    throw new ActivationManifestError('everActive must be a boolean.');
  }
  const activeGeneration = raw.activeGeneration === null ? null : validateEvidence(raw.activeGeneration, 'activeGeneration');
  if (activeGeneration && activeGeneration.state !== 'active') {
    throw new ActivationManifestError('activeGeneration must be in the active state.');
  }
  const successor = raw.successor === null ? null : validateEvidence(raw.successor, 'successor');
  if (successor && successor.state !== 'candidate' && successor.state !== 'ready') {
    throw new ActivationManifestError('successor must be a candidate or ready generation.');
  }
  if (activeGeneration && successor && successor.identity.generationId === activeGeneration.identity.generationId) {
    throw new ActivationManifestError('The successor must be a different generation from the active one.');
  }
  if (!Array.isArray(raw.retiredHistory)) {
    throw new ActivationManifestError('retiredHistory must be an array.');
  }
  if (raw.retiredHistory.length > ACTIVATION_MAX_HISTORY_ENTRIES) {
    throw new ActivationManifestError(
      `retiredHistory exceeds ${ACTIVATION_MAX_HISTORY_ENTRIES} entries.`,
    );
  }
  const retiredHistory = raw.retiredHistory.map((entry, index) => {
    const evidence = validateEvidence(entry, `retiredHistory[${index}]`);
    if (evidence.state !== 'retired') {
      throw new ActivationManifestError(`retiredHistory[${index}] must be in the retired state.`);
    }
    return evidence;
  });
  // Once the tombstone is set, the installation must never present itself as
  // never-activated: that would silently re-enable legacy writes.
  if (raw.everActive === true && activeGeneration === null && successor === null && retiredHistory.length === 0) {
    throw new ActivationManifestError(
      'everActive is set but no generation is recorded; the manifest fails closed.',
    );
  }
  if (raw.everActive === false && (activeGeneration !== null || retiredHistory.length > 0)) {
    throw new ActivationManifestError('everActive is false but generations are recorded.');
  }
  if (activeGeneration && activeGeneration.predecessorGenerationId !== null) {
    const predecessor = retiredHistory.find(
      (entry) => entry.identity.generationId === activeGeneration.predecessorGenerationId,
    );
    if (!predecessor) {
      throw new ActivationManifestError('The active generation names a predecessor that is not in retired history.');
    }
    if (predecessor.retiredAt !== null && activeGeneration.activatedAt !== null
      && Date.parse(predecessor.retiredAt) < Date.parse(activeGeneration.activatedAt)) {
      throw new ActivationManifestError('Predecessor retirement precedes successor activation.');
    }
  }
  return {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: raw.revision as number,
    previousSha256,
    everActive: raw.everActive,
    activeGeneration,
    successor,
    retiredHistory,
  };
}

/** Validate the immutable pre-manifest activation marker. A marker is not an
 * authority by itself; it is only usable by the explicit interrupted-activation
 * recovery path after the requested evidence is matched exactly. */
export function validateAnalyticsActivationTombstone(value: unknown): AnalyticsActivationTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivationManifestError('Activation tombstone must be an object.');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== ACTIVATION_TOMBSTONE_SCHEMA_VERSION) {
    throw new ActivationManifestError(
      `Unsupported activation tombstone schema ${String(raw.schemaVersion)}; expected ${ACTIVATION_TOMBSTONE_SCHEMA_VERSION}.`,
    );
  }
  assertExactKeys(value, [
    'schemaVersion', 'everActive', 'firstActiveGenerationId', 'identity', 'manifestRevision', 'previousSha256',
    'activatedAt', 'cutoffReceiptSha256', 'recordedAt',
  ], 'Activation tombstone');
  if (raw.everActive !== true) {
    throw new ActivationManifestError('Activation tombstone everActive marker is invalid.');
  }
  const identity = raw.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new ActivationManifestError('Activation tombstone identity must be an object.');
  }
  assertExactKeys(identity, ['generationId', 'buildId', 'qualificationSha256', 'trialSha256'], 'Activation tombstone identity');
  const identityRaw = identity as Record<string, unknown>;
  const normalizedIdentity: ActivationGenerationIdentity = {
    generationId: assertBoundedString(identityRaw.generationId, 'Activation tombstone identity.generationId', UUID_PATTERN),
    buildId: assertBoundedString(identityRaw.buildId, 'Activation tombstone identity.buildId'),
    qualificationSha256: assertBoundedString(
      identityRaw.qualificationSha256,
      'Activation tombstone identity.qualificationSha256',
      SHA256_PATTERN,
    ),
    trialSha256: assertBoundedString(identityRaw.trialSha256, 'Activation tombstone identity.trialSha256', SHA256_PATTERN),
  };
  const firstActiveGenerationId = assertBoundedString(
    raw.firstActiveGenerationId,
    'Activation tombstone firstActiveGenerationId',
    UUID_PATTERN,
  );
  if (firstActiveGenerationId !== normalizedIdentity.generationId) {
    throw new ActivationManifestError('Activation tombstone firstActiveGenerationId does not match its identity.');
  }
  if (!Number.isSafeInteger(raw.manifestRevision) || (raw.manifestRevision as number) < 1) {
    throw new ActivationManifestError('Activation tombstone manifestRevision must be a positive safe integer.');
  }
  const previousSha256 = raw.previousSha256 === null
    ? null
    : assertBoundedString(raw.previousSha256, 'Activation tombstone previousSha256', SHA256_PATTERN);
  if ((raw.manifestRevision as number) === 1 && previousSha256 !== null) {
    throw new ActivationManifestError('Activation tombstone revision 1 must not carry a previous hash.');
  }
  if ((raw.manifestRevision as number) > 1 && previousSha256 === null) {
    throw new ActivationManifestError('Activation tombstone revisions after the first must carry a previous hash.');
  }
  if (!isCanonicalInstant(raw.activatedAt)) {
    throw new ActivationManifestError('Activation tombstone activatedAt is not a canonical ISO instant.');
  }
  if (!isCanonicalInstant(raw.recordedAt)) {
    throw new ActivationManifestError('Activation tombstone recordedAt is not a canonical ISO instant.');
  }
  const cutoffReceiptSha256 = raw.cutoffReceiptSha256 === null
    ? null
    : assertBoundedString(raw.cutoffReceiptSha256, 'Activation tombstone cutoffReceiptSha256', SHA256_PATTERN);
  return {
    schemaVersion: ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
    everActive: true,
    firstActiveGenerationId,
    identity: normalizedIdentity,
    manifestRevision: raw.manifestRevision as number,
    previousSha256,
    activatedAt: raw.activatedAt,
    cutoffReceiptSha256,
    recordedAt: raw.recordedAt,
  };
}

/** The authority this manifest selects. An absent manifest selects legacy;
 * an ever-active manifest without an active generation is an interrupted or
 * retired authority state and must fail closed rather than select legacy. */
export function activationAuthority(manifest: ActivationManifest | null): AnalyticsAuthority {
  if (manifest?.everActive && !manifest.activeGeneration) {
    throw new ActivationManifestError(
      'An ever-active analytics manifest has no active generation; refusing to re-enable legacy authority.',
    );
  }
  return manifest?.activeGeneration ? 'canonical' : 'legacy';
}

/** A fresh revision-1 manifest for the first candidate generation. */
export function createCandidateManifest(identity: ActivationGenerationIdentity): ActivationManifest {
  return {
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    revision: 1,
    previousSha256: null,
    everActive: false,
    activeGeneration: null,
    successor: { identity, state: 'candidate', activatedAt: null, retiredAt: null, predecessorGenerationId: null, cutoffReceiptSha256: null },
    retiredHistory: [],
  };
}
