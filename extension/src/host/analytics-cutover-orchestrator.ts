import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  ActivationManifestError,
  type ActivationManifest,
} from '../../../shared/analytics/activation.js';
import {
  AnalyticsAllHostHandoffCoordinator,
  type AnalyticsAllHostHandoffReceipt,
} from './analytics-all-host-handoff.js';
import {
  linkStorageCutoffReceipt,
  activateGeneration,
  type ActivationOutcome,
  type ActivationRequest,
} from '../analytics/activation-sequence.js';
import { ActivationStore } from '../analytics/activation-store.js';
import {
  STORAGE_CUTOFF_AUTHORIZATION_ENV,
  STORAGE_CUTOFF_AUTHORIZATION_VALUE,
  inspectStorageCutoff,
  performStorageCutoff,
  storageCutoffReceiptSha256,
  type StorageCutoffReceipt,
  type StorageCutoffWriterFenceReceipt,
} from '../backend/storage-cutoff.js';
import type { SessionLifecycleCleaner } from '../backend/session-filesystem-lifecycle.js';
import type { SessionLifecycleStore } from '../backend/session-lifecycle-store.js';
import { atomicWriteText } from '../shared/atomic-write.js';
import { withFileUpdateLock } from '../shared/settings-json-update.js';

/** This is a command-level authorization, not an environment bypass. It is
 * recorded with the operation and must be accompanied by the full commit and
 * evidence gates below. */
export const ANALYTICS_CUTOVER_PLAN_REFERENCE = 'analytics-rework-plan-17' as const;
export const ANALYTICS_CUTOVER_JOURNAL_FILENAME = 'analytics-cutover-operation-v1.json' as const;
export const ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_CUTOVER_MAX_HOSTS = 512;
export const ANALYTICS_CUTOVER_MAX_OPERATION_ID_LENGTH = 512;
export const ANALYTICS_CUTOVER_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

export type AnalyticsCutoverMode = 'analytics-activation' | 'storage-cutoff' | 'both';

type HexSha256 = string;

export interface AnalyticsCutoverAuthorization {
  readonly schemaVersion: 1;
  readonly plan: typeof ANALYTICS_CUTOVER_PLAN_REFERENCE;
  /** The approval is deliberately a structured command input. No secret or
   * environment value is accepted as a substitute for this exact marker. */
  readonly approved: true;
  /** Full source commit that owns the reviewed cutover implementation. */
  readonly commitSha: string;
}

/** P0/P7 evidence is supplied by the qualification and review owners. The
 * orchestrator binds the P0 report hashes to the activation request and the
 * approval commit; it does not reinterpret or regenerate those reports. */
export interface AnalyticsCutoverPrerequisites {
  readonly p0: {
    readonly status: 'qualified';
    readonly commitSha: string;
    readonly qualificationSha256: HexSha256;
    readonly trialSha256: HexSha256;
  };
  readonly p7a: {
    readonly analyticsReady: true;
    readonly privacyDeleteReady: true;
    readonly queryReady: true;
    readonly selectedDesignQualified: true;
  };
  readonly p7b?: {
    readonly lifecycleOwnerReady: true;
    readonly legacyScrubBoundaryReady: true;
    readonly rootSwitchReady: true;
    readonly expiryInPlaceReady: true;
  };
  readonly terminalHandoff:
    | {
      readonly status: 'ready';
      readonly evidenceSha256: HexSha256;
    }
    | {
      /** The production runtime will create and verify terminal evidence after
       * activation. This is never sufficient without that callback's proof. */
      readonly status: 'pending';
    };
}

export interface AnalyticsCutoverInventoryEvidence {
  /** The source must identify an owner, rather than being an unqualified
   * directory walk. The source is persisted for later operational review. */
  readonly source: string;
  readonly complete: true;
  readonly sessionIds: readonly string[];
  /** The collector must bind its result to the exact completed fence. */
  readonly fenceOperationId: string;
  readonly fenceEpoch: number;
  readonly inventorySha256: HexSha256;
}

export interface AnalyticsCutoverHostVerification {
  readonly verified: true;
  readonly generationId: string;
  readonly buildId: string;
  readonly manifestRevision: number;
  readonly manifestSha256: HexSha256;
  readonly hosts: readonly {
    readonly hostInstanceId: string;
    readonly processId: number;
    readonly backendGeneration: number;
  }[];
  /** The callback owns controlled restart and admission release. It must not
   * report success until the newly loaded hosts are the only admitted writers. */
  readonly admissionReopened: true;
  /** Hash of the exact terminal restart receipt when production created it.
   * Legacy injected runtimes may omit this only when the prerequisite already
   * carried independently authorized terminal evidence. */
  readonly terminalEvidenceSha256?: HexSha256;
}

export interface AnalyticsCutoverStorageVerification {
  readonly verified: true;
  readonly hosts: readonly {
    readonly hostInstanceId: string;
    readonly processId: number;
    readonly backendGeneration: number;
  }[];
  /** P7b cannot finish while the old fenced hosts remain the active writer
   * population. The callback switches the new root/ownership policy and proves
   * that admission was reopened only after that switch. */
  readonly admissionReopened: true;
}

export interface AnalyticsCutoverRuntime {
  /** Explicitly identifies the production callback that can create terminal
   * restart evidence after activation. A pending prerequisite is rejected
   * unless this marker is present. */
  readonly terminalHandoffProduction?: true;
  /** Terminal handoff: stop/restart affected hosts independently, then verify
   * analytics-loaded-generation evidence and reopen only the new admission. */
  completeAnalyticsActivation(input: {
    operationId: string;
    fence: AnalyticsAllHostHandoffReceipt;
    manifest: ActivationManifest;
  }): Promise<AnalyticsCutoverHostVerification>;
  /** Switch new-session ownership after the durable cutoff receipt. This is a
   * separate callback so P7a never closes sessions and P7b cannot claim
   * completion while old writers remain fenced. */
  completeStorageCutoff(input: {
    operationId: string;
    fence: StorageCutoffWriterFenceReceipt;
    receipt: StorageCutoffReceipt;
    manifest: ActivationManifest;
  }): Promise<AnalyticsCutoverStorageVerification>;
}

export interface AnalyticsCutoverOptions {
  /** False/omitted is the normal production behavior. `true` is an explicit
   * command input and is still insufficient without authorization and gates. */
  readonly enabled?: boolean;
  readonly mode: AnalyticsCutoverMode;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly stateDir: string;
  readonly authorization: AnalyticsCutoverAuthorization;
  readonly prerequisites: AnalyticsCutoverPrerequisites;
  readonly activationStore: ActivationStore;
  readonly registry: SessionLifecycleStore;
  readonly cleaner: SessionLifecycleCleaner;
  readonly analyticsHandoff?: Pick<AnalyticsAllHostHandoffCoordinator, 'run'>;
  readonly storageHandoff?: Pick<AnalyticsAllHostHandoffCoordinator, 'ensureFenced'>;
  readonly activationRequest?: ActivationRequest;
  /** Storage-only recovery must name the active generation it is allowed to
   * cut off; a canonical manifest alone is not enough authority. */
  readonly expectedActiveGenerationId?: string;
  /** Called only after a durable storage writer fence is complete. */
  readonly collectInventory?: (
    fence: StorageCutoffWriterFenceReceipt,
  ) => Promise<AnalyticsCutoverInventoryEvidence>;
  readonly runtime: AnalyticsCutoverRuntime;
  readonly now?: () => number;
}

export interface AnalyticsCutoverResult {
  readonly operationId: string;
  readonly mode: AnalyticsCutoverMode;
  readonly status: 'complete';
  readonly activation?: ActivationOutcome;
  readonly storage?: StorageCutoffReceipt;
  readonly loadedGeneration?: AnalyticsCutoverHostVerification;
  readonly storageVerification?: AnalyticsCutoverStorageVerification;
}

interface AnalyticsCutoverJournal {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly mode: AnalyticsCutoverMode;
  readonly plan: typeof ANALYTICS_CUTOVER_PLAN_REFERENCE;
  readonly authorizationCommitSha: string;
  readonly activationRequest?: {
    readonly generationId: string;
    readonly buildId: string;
    readonly qualificationSha256: HexSha256;
    readonly trialSha256: HexSha256;
    readonly activatedAt: string;
    readonly cutoffReceiptSha256?: HexSha256 | null;
  };
  readonly phase:
    | 'analytics-fenced'
    | 'analytics-committed'
    | 'analytics-verified'
    | 'storage-fenced'
    | 'storage-receipt-ready'
    | 'complete';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly analyticsFence?: AnalyticsAllHostHandoffReceipt;
  readonly storageFence?: StorageCutoffWriterFenceReceipt;
  readonly inventory?: {
    readonly source: string;
    readonly sessionIds: readonly string[];
    readonly fenceOperationId: string;
    readonly fenceEpoch: number;
    readonly inventorySha256: HexSha256;
  };
  readonly activation?: {
    readonly generationId: string;
    readonly manifestRevision: number;
    readonly manifestSha256: HexSha256;
    readonly verification?: AnalyticsCutoverHostVerification;
  };
  readonly storage?: {
    readonly receiptSha256?: HexSha256;
    readonly verification?: AnalyticsCutoverStorageVerification;
  };
  readonly lastError?: string;
}

const CUTOVER_PHASES = new Set<AnalyticsCutoverJournal['phase']>([
  'analytics-fenced',
  'analytics-committed',
  'analytics-verified',
  'storage-fenced',
  'storage-receipt-ready',
  'complete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertSha256(value: unknown, label: string): asserts value is HexSha256 {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase sha256.`);
  }
}

function assertCanonicalInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO instant.`);
  }
}

function assertBoundedString(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertCommitSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new Error(`${label} must be a full 40-character commit sha.`);
  }
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid.`);
  }
}

function canonicalInventory(sessionIds: readonly string[]): string[] {
  if (!Array.isArray(sessionIds)) throw new Error('Cutover inventory must be an array.');
  const result = [...sessionIds];
  result.forEach((sessionId, index) => assertBoundedString(sessionId, `Cutover inventory[${index}]`));
  if (new Set(result).size !== result.length) throw new Error('Cutover inventory contains duplicate session ids.');
  result.sort();
  return result;
}

export function analyticsCutoverInventorySha256(sessionIds: readonly string[]): HexSha256 {
  return sha256(`${JSON.stringify(canonicalInventory(sessionIds))}\n`);
}

function assertHostVerificationShape(value: AnalyticsCutoverHostVerification): void {
  if (!isRecord(value) || value.verified !== true || value.admissionReopened !== true) {
    throw new Error('Analytics terminal handoff did not return verified reopened admission.');
  }
  assertUuid(value.generationId, 'loaded generationId');
  assertBoundedString(value.buildId, 'loaded buildId');
  assertSafeInteger(value.manifestRevision, 'loaded manifestRevision', 1);
  assertSha256(value.manifestSha256, 'loaded manifestSha256');
  if (!Array.isArray(value.hosts) || value.hosts.length === 0 || value.hosts.length > ANALYTICS_CUTOVER_MAX_HOSTS) {
    throw new Error('Loaded analytics host verification is empty or exceeds the host bound.');
  }
  const hostIds = new Set<string>();
  const processIds = new Set<number>();
  for (const host of value.hosts) {
    if (!isRecord(host)) throw new Error('Loaded analytics host verification is malformed.');
    assertBoundedString(host.hostInstanceId, 'loaded hostInstanceId');
    assertSafeInteger(host.processId, 'loaded processId', 1);
    assertSafeInteger(host.backendGeneration, 'loaded backendGeneration', 1);
    if (hostIds.has(host.hostInstanceId) || processIds.has(host.processId)) {
      throw new Error('Loaded analytics host verification contains duplicate identities.');
    }
    hostIds.add(host.hostInstanceId);
    processIds.add(host.processId);
  }
  if (value.terminalEvidenceSha256 !== undefined) {
    assertSha256(value.terminalEvidenceSha256, 'terminalEvidenceSha256');
  }
}

function assertHostVerification(
  value: AnalyticsCutoverHostVerification,
  manifest: ActivationManifest,
  manifestSha256: string,
): AnalyticsCutoverHostVerification {
  assertHostVerificationShape(value);
  const active = manifest.activeGeneration;
  if (!active
    || value.generationId !== active.identity.generationId
    || value.buildId !== active.identity.buildId
    || value.manifestRevision !== manifest.revision
    || value.manifestSha256 !== manifestSha256) {
    throw new Error('Loaded analytics generation does not match the committed manifest.');
  }
  return value;
}

function assertStorageVerificationShape(value: AnalyticsCutoverStorageVerification): void {
  if (!isRecord(value) || value.verified !== true || value.admissionReopened !== true) {
    throw new Error('Storage cutoff handoff did not return verified reopened admission.');
  }
  if (!Array.isArray(value.hosts) || value.hosts.length === 0 || value.hosts.length > ANALYTICS_CUTOVER_MAX_HOSTS) {
    throw new Error('Storage cutoff host verification is empty or exceeds the host bound.');
  }
  const hostIds = new Set<string>();
  const processIds = new Set<number>();
  for (const host of value.hosts) {
    if (!isRecord(host)) throw new Error('Storage cutoff host verification is malformed.');
    assertBoundedString(host.hostInstanceId, 'storage hostInstanceId');
    assertSafeInteger(host.processId, 'storage processId', 1);
    assertSafeInteger(host.backendGeneration, 'storage backendGeneration', 1);
    if (hostIds.has(host.hostInstanceId) || processIds.has(host.processId)) {
      throw new Error('Storage cutoff host verification contains duplicate identities.');
    }
    hostIds.add(host.hostInstanceId);
    processIds.add(host.processId);
  }
}

function assertStorageVerification(
  value: AnalyticsCutoverStorageVerification,
): AnalyticsCutoverStorageVerification {
  assertStorageVerificationShape(value);
  return value;
}

function assertWriterFenceReceipt(
  value: unknown,
  workspaceId: string,
  operationId: string,
  purpose: 'analytics-activation' | 'storage-cutoff',
): asserts value is AnalyticsAllHostHandoffReceipt | StorageCutoffWriterFenceReceipt {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.workspaceId !== workspaceId
    || value.operationId !== operationId
    || value.purpose !== purpose
    || value.status !== 'fenced'
    || !Array.isArray(value.hostInstanceIds)
    || !Array.isArray(value.acknowledgedHostInstanceIds)
    || value.hostInstanceIds.length === 0
    || value.hostInstanceIds.length > ANALYTICS_CUTOVER_MAX_HOSTS
    || JSON.stringify(value.hostInstanceIds) !== JSON.stringify([...value.hostInstanceIds].sort())
    || JSON.stringify(value.acknowledgedHostInstanceIds) !== JSON.stringify([...value.acknowledgedHostInstanceIds].sort())
    || JSON.stringify(value.hostInstanceIds) !== JSON.stringify(value.acknowledgedHostInstanceIds)) {
    throw new Error(`The ${purpose} handoff receipt is incomplete or mismatched.`);
  }
  assertSafeInteger(value.fenceEpoch, `${purpose} fenceEpoch`, 1);
  const ids = value.hostInstanceIds;
  for (const id of ids) assertBoundedString(id, `${purpose} hostInstanceId`);
  if (new Set(ids).size !== ids.length) throw new Error(`${purpose} handoff receipt contains duplicate hosts.`);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID.`);
}

function assertActivationRequest(request: ActivationRequest): void {
  assertUuid(request.generationId, 'activation generationId');
  assertBoundedString(request.buildId, 'activation buildId');
  assertSha256(request.qualificationSha256, 'activation qualificationSha256');
  assertSha256(request.trialSha256, 'activation trialSha256');
  assertCanonicalInstant(request.activatedAt, 'activation activatedAt');
  if (request.cutoffReceiptSha256 !== undefined && request.cutoffReceiptSha256 !== null) {
    assertSha256(request.cutoffReceiptSha256, 'activation cutoffReceiptSha256');
  }
}

function assertAuthorization(
  authorization: AnalyticsCutoverAuthorization,
  prerequisites: AnalyticsCutoverPrerequisites,
  runtime: AnalyticsCutoverRuntime,
): void {
  if (!isRecord(authorization)
    || authorization.schemaVersion !== 1
    || authorization.plan !== ANALYTICS_CUTOVER_PLAN_REFERENCE
    || authorization.approved !== true) {
    throw new Error('Production analytics cutover is not explicitly authorized.');
  }
  assertCommitSha(authorization.commitSha, 'cutover authorization commitSha');
  if (!isRecord(prerequisites) || !isRecord(prerequisites.p0) || prerequisites.p0.status !== 'qualified') {
    throw new Error('P0 qualification evidence is missing.');
  }
  assertCommitSha(prerequisites.p0.commitSha, 'P0 qualification commitSha');
  if (prerequisites.p0.commitSha.toLowerCase() !== authorization.commitSha.toLowerCase()) {
    throw new Error('P0 qualification evidence is from a different commit than the cutover authorization.');
  }
  assertSha256(prerequisites.p0.qualificationSha256, 'P0 qualificationSha256');
  assertSha256(prerequisites.p0.trialSha256, 'P0 trialSha256');
  if (!isRecord(prerequisites.p7a)
    || prerequisites.p7a.analyticsReady !== true
    || prerequisites.p7a.privacyDeleteReady !== true
    || prerequisites.p7a.queryReady !== true
    || prerequisites.p7a.selectedDesignQualified !== true) {
    throw new Error('P7a prerequisites are incomplete.');
  }
  if (!isRecord(prerequisites.terminalHandoff)
    || (prerequisites.terminalHandoff.status !== 'ready' && prerequisites.terminalHandoff.status !== 'pending')) {
    throw new Error('Terminal handoff evidence is missing.');
  }
  if (prerequisites.terminalHandoff.status === 'ready') {
    assertSha256(prerequisites.terminalHandoff.evidenceSha256, 'terminal handoff evidenceSha256');
  } else if (runtime.terminalHandoffProduction !== true) {
    throw new Error('Pending terminal handoff evidence requires the production terminal handoff callback.');
  }
}

function assertMode(value: unknown): asserts value is AnalyticsCutoverMode {
  if (value !== 'analytics-activation' && value !== 'storage-cutoff' && value !== 'both') {
    throw new Error('Analytics cutover mode is invalid.');
  }
}

function phaseOperationId(operationId: string): string {
  const value = `${operationId}:analytics-activation`;
  if (value.length > ANALYTICS_CUTOVER_MAX_OPERATION_ID_LENGTH) {
    throw new Error('Analytics cutover operationId is too long for its phase operation.');
  }
  return value;
}

function validateOptions(options: AnalyticsCutoverOptions): void {
  if (options.enabled !== true) {
    throw new Error('Production analytics cutover is disabled by default; explicit execution is required.');
  }
  assertMode(options.mode);
  assertBoundedString(options.operationId, 'cutover operationId', ANALYTICS_CUTOVER_MAX_OPERATION_ID_LENGTH);
  assertBoundedString(options.workspaceId, 'cutover workspaceId');
  assertBoundedString(options.stateDir, 'cutover stateDir', 4_096);
  assertAuthorization(options.authorization, options.prerequisites, options.runtime);
  if (options.prerequisites.p0.qualificationSha256 !== options.activationRequest?.qualificationSha256
    && options.mode !== 'storage-cutoff') {
    throw new Error('Activation request qualification evidence does not match the qualified P0 report.');
  }
  if (options.prerequisites.p0.trialSha256 !== options.activationRequest?.trialSha256
    && options.mode !== 'storage-cutoff') {
    throw new Error('Activation request trial evidence does not match the qualified P0 report.');
  }
  if (options.mode === 'storage-cutoff' && options.activationRequest !== undefined) {
    throw new Error('Storage-only cutoff must not include an analytics activation request.');
  }
  if (options.mode !== 'storage-cutoff') {
    if (!options.activationRequest) throw new Error('Analytics activation request is required for this mode.');
    assertActivationRequest(options.activationRequest);
    if (options.mode === 'both' && options.activationRequest.cutoffReceiptSha256 !== undefined
      && options.activationRequest.cutoffReceiptSha256 !== null) {
      throw new Error('P7a activation cannot claim a P7b cutoff receipt before the cutoff runs.');
    }
    if (!options.analyticsHandoff) throw new Error('Analytics activation requires an all-host handoff coordinator.');
  }
  if (options.mode !== 'analytics-activation') {
    if (!options.storageHandoff) throw new Error('Storage cutoff requires an all-host handoff coordinator.');
    if (!options.collectInventory) throw new Error('Storage cutoff requires an authoritative inventory collector.');
    if (!options.prerequisites.p7b
      || options.prerequisites.p7b.lifecycleOwnerReady !== true
      || options.prerequisites.p7b.legacyScrubBoundaryReady !== true
      || options.prerequisites.p7b.rootSwitchReady !== true
      || options.prerequisites.p7b.expiryInPlaceReady !== true) {
      throw new Error('P7b prerequisites are incomplete.');
    }
    if (process.env[STORAGE_CUTOFF_AUTHORIZATION_ENV] !== STORAGE_CUTOFF_AUTHORIZATION_VALUE) {
      throw new Error(`Storage cutoff requires ${STORAGE_CUTOFF_AUTHORIZATION_ENV}=${STORAGE_CUTOFF_AUTHORIZATION_VALUE}.`);
    }
  }
  // A storage-only run still requires an existing canonical authority. It must
  // not turn a missing activation into an implicit cutover.
  if (options.mode === 'storage-cutoff') {
    if (!isUuid(options.expectedActiveGenerationId)) {
      throw new Error('Storage cutoff requires an expected active generation UUID.');
    }
    const activation = options.activationStore.read();
    if (activation.authority !== 'canonical' || !activation.manifest?.activeGeneration) {
      throw new Error('Storage cutoff requires an already-active canonical analytics generation.');
    }
    if (activation.manifest.activeGeneration.identity.generationId !== options.expectedActiveGenerationId) {
      throw new Error('Storage cutoff active generation does not match the authorized generation.');
    }
  } else if (options.expectedActiveGenerationId !== undefined
    && options.activationRequest
    && options.expectedActiveGenerationId !== options.activationRequest.generationId) {
    throw new Error('Expected active generation does not match the activation request.');
  }
}

function readJournal(stateDir: string): AnalyticsCutoverJournal | undefined {
  const journalPath = path.join(stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME);
  if (!existsSync(journalPath)) return undefined;
  let raw: unknown;
  try {
    const size = statSync(journalPath).size;
    if (size > ANALYTICS_CUTOVER_MAX_JOURNAL_BYTES) throw new Error('cutover journal exceeds its bounded size.');
    raw = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Analytics cutover journal is unreadable; refusing recovery: ${errorMessage(error)}`);
  }
  if (!isRecord(raw)
    || raw.schemaVersion !== ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION
    || typeof raw.operationId !== 'string'
    || typeof raw.workspaceId !== 'string'
    || typeof raw.mode !== 'string'
    || !CUTOVER_PHASES.has(raw.phase as AnalyticsCutoverJournal['phase'])
    || raw.plan !== ANALYTICS_CUTOVER_PLAN_REFERENCE
    || typeof raw.authorizationCommitSha !== 'string'
    || typeof raw.startedAt !== 'string'
    || typeof raw.updatedAt !== 'string') {
    throw new Error('Analytics cutover journal is malformed; refusing recovery.');
  }
  assertBoundedString(raw.operationId, 'cutover journal operationId', ANALYTICS_CUTOVER_MAX_OPERATION_ID_LENGTH);
  assertBoundedString(raw.workspaceId, 'cutover journal workspaceId');
  assertMode(raw.mode);
  assertCommitSha(raw.authorizationCommitSha, 'cutover journal authorizationCommitSha');
  assertCanonicalInstant(raw.startedAt, 'cutover journal startedAt');
  assertCanonicalInstant(raw.updatedAt, 'cutover journal updatedAt');
  const journal = raw as unknown as AnalyticsCutoverJournal;
  if (journal.analyticsFence !== undefined) {
    assertWriterFenceReceipt(
      journal.analyticsFence,
      journal.workspaceId,
      phaseOperationId(journal.operationId),
      'analytics-activation',
    );
  }
  if (journal.storageFence !== undefined) {
    assertWriterFenceReceipt(journal.storageFence, journal.workspaceId, journal.operationId, 'storage-cutoff');
  }
  if (journal.inventory !== undefined) {
    if (!isRecord(journal.inventory)) throw new Error('Cutover journal inventory is malformed.');
    assertBoundedString(journal.inventory.source, 'cutover journal inventory source', 1_024);
    const ids = canonicalInventory(journal.inventory.sessionIds);
    if (JSON.stringify(journal.inventory.sessionIds) !== JSON.stringify(ids)) {
      throw new Error('Cutover journal inventory is not canonical; refusing recovery.');
    }
    assertBoundedString(journal.inventory.fenceOperationId, 'cutover journal inventory fenceOperationId');
    assertSafeInteger(journal.inventory.fenceEpoch, 'cutover journal inventory fenceEpoch', 1);
    if (journal.storageFence
      && (journal.inventory.fenceOperationId !== journal.storageFence.operationId
        || journal.inventory.fenceEpoch !== journal.storageFence.fenceEpoch)) {
      throw new Error('Cutover journal inventory is not bound to its storage fence; refusing recovery.');
    }
    assertSha256(journal.inventory.inventorySha256, 'cutover journal inventorySha256');
    if (analyticsCutoverInventorySha256(ids) !== journal.inventory.inventorySha256) {
      throw new Error('Cutover journal inventory digest is invalid; refusing recovery.');
    }
  }
  if (journal.activation !== undefined) {
    if (!isRecord(journal.activation)) throw new Error('Cutover journal activation evidence is malformed.');
    assertUuid(journal.activation.generationId, 'cutover journal generationId');
    assertSafeInteger(journal.activation.manifestRevision, 'cutover journal manifestRevision', 1);
    assertSha256(journal.activation.manifestSha256, 'cutover journal manifestSha256');
    if (journal.activation.verification !== undefined) {
      if (!isRecord(journal.activation.verification)) throw new Error('Cutover journal loaded-generation evidence is malformed.');
      assertHostVerificationShape(journal.activation.verification);
    }
  }
  if (journal.storage !== undefined) {
    if (!isRecord(journal.storage)) throw new Error('Cutover journal storage evidence is malformed.');
    if (journal.storage.receiptSha256 !== undefined) assertSha256(journal.storage.receiptSha256, 'cutover journal receiptSha256');
    if (journal.storage.verification !== undefined) {
      if (!isRecord(journal.storage.verification)) throw new Error('Cutover journal storage verification is malformed.');
      assertStorageVerificationShape(journal.storage.verification);
    }
  }
  if (journal.lastError !== undefined) assertBoundedString(journal.lastError, 'cutover journal lastError', 2_048);
  if (journal.activationRequest !== undefined) {
    if (!isRecord(journal.activationRequest)) throw new Error('Cutover journal activation request is malformed.');
    assertActivationRequest(journal.activationRequest as ActivationRequest);
  }
  assertJournalPhaseConsistency(journal);
  return journal;
}

function assertJournalPhaseConsistency(journal: AnalyticsCutoverJournal): void {
  const activationMode = journal.mode !== 'storage-cutoff';
  const storageMode = journal.mode !== 'analytics-activation';
  const storagePhase = journal.phase === 'storage-fenced' || journal.phase === 'storage-receipt-ready';
  const storageEvidencePhase = storagePhase || (journal.phase === 'complete' && storageMode);
  const activationEvidencePhase = journal.phase !== 'analytics-fenced';
  const activationVerificationPhase = journal.phase === 'analytics-verified'
    || (journal.phase === 'complete' && activationMode)
    || (storagePhase && activationMode);
  const storageReceiptPhase = journal.phase === 'storage-receipt-ready'
    || (journal.phase === 'complete' && storageMode);

  if ((journal.mode === 'analytics-activation' && storagePhase)
    || (journal.mode === 'storage-cutoff'
      && journal.phase !== 'complete'
      && !storagePhase)) {
    throw new Error('Analytics cutover journal has an invalid mode/phase combination; refusing recovery.');
  }
  if (activationMode !== (journal.analyticsFence !== undefined)) {
    throw new Error('Analytics cutover journal has inconsistent analytics fence phases; refusing recovery.');
  }
  if (!storageMode && (journal.storageFence || journal.inventory || journal.storage)) {
    throw new Error('Analytics-only cutover journal contains storage evidence; refusing recovery.');
  }
  if (journal.storageFence !== undefined && journal.inventory === undefined) {
    throw new Error('Storage fence evidence is missing its authoritative inventory; refusing recovery.');
  }
  if (storageEvidencePhase && (!journal.storageFence || !journal.inventory)) {
    throw new Error('Analytics cutover journal has inconsistent storage fence phases; refusing recovery.');
  }
  if (activationMode !== (journal.activationRequest !== undefined)) {
    throw new Error('Analytics cutover journal has an unexpected activation request; refusing recovery.');
  }
  if (activationMode !== (journal.activation !== undefined) && activationEvidencePhase) {
    throw new Error('Analytics cutover journal is missing activation evidence; refusing recovery.');
  }
  if (!activationMode && journal.activation !== undefined) {
    throw new Error('Storage-only cutover journal contains activation evidence; refusing recovery.');
  }
  if (activationMode && !activationEvidencePhase && journal.activation !== undefined) {
    throw new Error('Analytics cutover journal has activation evidence before its fence phase; refusing recovery.');
  }
  if (activationVerificationPhase && activationMode && !journal.activation?.verification) {
    throw new Error('Analytics cutover journal is missing loaded-generation verification; refusing recovery.');
  }
  if (storageReceiptPhase && !journal.storage?.receiptSha256) {
    throw new Error('Analytics cutover journal is missing its storage receipt evidence; refusing recovery.');
  }
  if (!storageReceiptPhase && journal.storage !== undefined) {
    throw new Error('Analytics cutover journal has storage receipt evidence before its receipt phase; refusing recovery.');
  }
  if (journal.phase === 'complete') {
    if (storageMode && !journal.storage?.verification) {
      throw new Error('Storage cutover journal is terminal without ownership verification; refusing recovery.');
    }
    if (!activationMode && journal.activation) {
      throw new Error('Storage-only cutover journal contains terminal activation evidence; refusing recovery.');
    }
  }
}

async function writeJournal(stateDir: string, journal: AnalyticsCutoverJournal): Promise<void> {
  await atomicWriteText(path.join(stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME), canonicalJson(journal));
}

function activationRequestFromJournal(journal: AnalyticsCutoverJournal): ActivationRequest | undefined {
  return journal.activationRequest === undefined ? undefined : {
    generationId: journal.activationRequest.generationId,
    buildId: journal.activationRequest.buildId,
    qualificationSha256: journal.activationRequest.qualificationSha256,
    trialSha256: journal.activationRequest.trialSha256,
    activatedAt: journal.activationRequest.activatedAt,
    cutoffReceiptSha256: journal.activationRequest.cutoffReceiptSha256,
  };
}

function assertJournalMatchesOptions(
  journal: AnalyticsCutoverJournal,
  options: AnalyticsCutoverOptions,
): void {
  if (journal.operationId !== options.operationId || journal.workspaceId !== options.workspaceId || journal.mode !== options.mode) {
    throw new Error('Analytics cutover journal belongs to another operation, workspace, or mode.');
  }
  if (journal.authorizationCommitSha.toLowerCase() !== options.authorization.commitSha.toLowerCase()) {
    throw new Error('Analytics cutover authorization commit does not match the durable operation journal.');
  }
  const requested = options.activationRequest;
  const recorded = activationRequestFromJournal(journal);
  if (requested || recorded) {
    if (!requested || !recorded
      || requested.generationId !== recorded.generationId
      || requested.buildId !== recorded.buildId
      || requested.qualificationSha256 !== recorded.qualificationSha256
      || requested.trialSha256 !== recorded.trialSha256
      || requested.activatedAt !== recorded.activatedAt
      || (requested.cutoffReceiptSha256 ?? null) !== (recorded.cutoffReceiptSha256 ?? null)) {
      throw new Error('Analytics cutover activation evidence changed during recovery.');
    }
  }
}

function timestamp(now: () => number): string {
  const value = now();
  assertSafeInteger(value, 'cutover clock', 0);
  return new Date(value).toISOString();
}

function activationJournalRequest(request: ActivationRequest): AnalyticsCutoverJournal['activationRequest'] {
  return {
    generationId: request.generationId,
    buildId: request.buildId,
    qualificationSha256: request.qualificationSha256,
    trialSha256: request.trialSha256,
    activatedAt: request.activatedAt,
    cutoffReceiptSha256: request.cutoffReceiptSha256 ?? null,
  };
}

function sameReceiptHash(receipt: StorageCutoffReceipt, expected: string | undefined): boolean {
  return expected !== undefined && storageCutoffReceiptSha256(receipt) === expected;
}

function assertActiveGenerationMatchesRequest(
  manifest: ActivationManifest,
  request: ActivationRequest,
  expectedCutoffReceiptSha256: string | null,
): void {
  const active = manifest.activeGeneration;
  if (!active
    || active.identity.generationId !== request.generationId
    || active.identity.buildId !== request.buildId
    || active.identity.qualificationSha256 !== request.qualificationSha256
    || active.identity.trialSha256 !== request.trialSha256
    || active.cutoffReceiptSha256 !== expectedCutoffReceiptSha256) {
    throw new ActivationManifestError('The active analytics generation does not match the authorized activation evidence.');
  }
}

/**
 * Explicit, resumable production cutover coordinator.
 *
 * This class has no default production construction path. Callers must inject
 * the actual all-host census/handoff and terminal process owner; registration
 * or a status response alone cannot satisfy those seams. Every destructive
 * operation is delegated to the existing ActivationStore and storage-cutoff
 * authorities, so this layer only orders and durably records the phases.
 */
export class AnalyticsCutoverOrchestrator {
  private readonly now: () => number;
  private readonly journalPath: string;

  constructor(private readonly options: AnalyticsCutoverOptions) {
    this.now = options.now ?? Date.now;
    this.journalPath = path.join(options.stateDir, ANALYTICS_CUTOVER_JOURNAL_FILENAME);
  }

  async run(): Promise<AnalyticsCutoverResult> {
    validateOptions(this.options);
    mkdirSync(this.options.stateDir, { recursive: true });
    return await withFileUpdateLock(this.journalPath, async () => this.runLocked(), { timeoutMs: 15_000 });
  }

  private async runLocked(): Promise<AnalyticsCutoverResult> {
    let journal = readJournal(this.options.stateDir);
    if (journal) assertJournalMatchesOptions(journal, this.options);

    let activation: ActivationOutcome | undefined;
    let loadedGeneration: AnalyticsCutoverHostVerification | undefined;
    let storage: StorageCutoffReceipt | undefined;
    let storageVerification: AnalyticsCutoverStorageVerification | undefined;

    if (this.options.mode !== 'storage-cutoff') {
      const request = this.options.activationRequest!;
      const activationOperationId = phaseOperationId(this.options.operationId);
      let analyticsFence: AnalyticsAllHostHandoffReceipt;
      if (journal?.analyticsFence) {
        assertWriterFenceReceipt(journal.analyticsFence, this.options.workspaceId, activationOperationId, 'analytics-activation');
        analyticsFence = journal.analyticsFence;
      } else {
        analyticsFence = await this.options.analyticsHandoff!.run(activationOperationId);
        assertWriterFenceReceipt(analyticsFence, this.options.workspaceId, activationOperationId, 'analytics-activation');
        journal = journal ?? {
          schemaVersion: ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION,
          operationId: this.options.operationId,
          workspaceId: this.options.workspaceId,
          mode: this.options.mode,
          plan: ANALYTICS_CUTOVER_PLAN_REFERENCE,
          authorizationCommitSha: this.options.authorization.commitSha,
          activationRequest: activationJournalRequest(request),
          phase: 'analytics-fenced',
          startedAt: timestamp(this.now),
          updatedAt: timestamp(this.now),
          analyticsFence,
        };
        journal = { ...journal, analyticsFence, phase: 'analytics-fenced', updatedAt: timestamp(this.now), lastError: undefined };
        await writeJournal(this.options.stateDir, journal);
      }

      const currentActivation = this.options.activationStore.read();
      const recordedCutoffReceiptSha256 = journal?.storage?.receiptSha256
        ?? request.cutoffReceiptSha256
        ?? null;
      if (journal?.activation?.generationId === request.generationId && currentActivation.manifest?.activeGeneration) {
        // A journaled generation is only an optimization for the durable
        // activation sequence. Re-check every piece of evidence, including a
        // post-P7b receipt link, before adopting it on recovery.
        assertActiveGenerationMatchesRequest(currentActivation.manifest, request, recordedCutoffReceiptSha256);
        activation = {
          manifest: currentActivation.manifest,
          alreadyActive: true,
          revision: currentActivation.manifest.revision,
        };
      } else {
        activation = await activateGeneration(this.options.activationStore, request);
      }
      const committed = this.options.activationStore.read();
      if (committed.authority !== 'canonical' || !committed.manifest?.activeGeneration || !committed.sha256) {
        throw new ActivationManifestError('Analytics activation did not produce a canonical active manifest.');
      }
      if (committed.manifest.activeGeneration.identity.generationId !== request.generationId
        || committed.manifest.activeGeneration.identity.buildId !== request.buildId) {
        throw new ActivationManifestError('Analytics activation committed a different generation.');
      }
      journal = {
        ...(journal ?? {
          schemaVersion: ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION,
          operationId: this.options.operationId,
          workspaceId: this.options.workspaceId,
          mode: this.options.mode,
          plan: ANALYTICS_CUTOVER_PLAN_REFERENCE,
          authorizationCommitSha: this.options.authorization.commitSha,
          activationRequest: activationJournalRequest(request),
          phase: 'analytics-fenced' as const,
          startedAt: timestamp(this.now),
          updatedAt: timestamp(this.now),
        }),
        phase: 'analytics-committed',
        updatedAt: timestamp(this.now),
        activationRequest: activationJournalRequest(request),
        analyticsFence,
        activation: {
          generationId: committed.manifest.activeGeneration.identity.generationId,
          manifestRevision: committed.manifest.revision,
          manifestSha256: committed.sha256,
        },
        storage: undefined,
        lastError: undefined,
      };
      const committedJournal = journal;
      if (!committedJournal) throw new Error('Analytics cutover journal could not be initialized.');
      await writeJournal(this.options.stateDir, committedJournal);

      // A journaled verification is only a recovery breadcrumb. It is not
      // proof that restarted processes are alive now, so every retry performs
      // the terminal handoff/loaded-generation check again. The callback must
      // be idempotent for an already-completed handoff.
      loadedGeneration = assertHostVerification(
        await this.options.runtime.completeAnalyticsActivation({
          operationId: activationOperationId,
          fence: analyticsFence,
          manifest: committed.manifest,
        }),
        committed.manifest,
        committed.sha256,
      );
      if (this.options.prerequisites.terminalHandoff.status === 'pending'
        && loadedGeneration.terminalEvidenceSha256 === undefined) {
        throw new Error('Production terminal handoff did not return exact restart receipt evidence.');
      }
      if (this.options.prerequisites.terminalHandoff.status === 'ready'
        && loadedGeneration.terminalEvidenceSha256 !== undefined
        && loadedGeneration.terminalEvidenceSha256 !== this.options.prerequisites.terminalHandoff.evidenceSha256) {
        throw new Error('Production terminal handoff evidence does not match the authorized receipt hash.');
      }
      if (!committedJournal.activation) throw new Error('Analytics cutover activation evidence is missing from its journal.');
      journal = {
        ...committedJournal,
        phase: 'analytics-verified',
        updatedAt: timestamp(this.now),
        activation: { ...committedJournal.activation, verification: loadedGeneration },
        lastError: undefined,
      };
      await writeJournal(this.options.stateDir, journal);
    }

    if (this.options.mode !== 'analytics-activation') {
      const active = this.options.activationStore.read();
      if (active.authority !== 'canonical' || !active.manifest?.activeGeneration || !active.sha256) {
        throw new ActivationManifestError('Storage cutoff cannot run without canonical active analytics authority.');
      }
      let storageFence: StorageCutoffWriterFenceReceipt;
      if (journal?.storageFence) {
        assertWriterFenceReceipt(journal.storageFence, this.options.workspaceId, this.options.operationId, 'storage-cutoff');
        storageFence = journal.storageFence;
      } else {
        storageFence = await this.options.storageHandoff!.ensureFenced(this.options.operationId);
        assertWriterFenceReceipt(storageFence, this.options.workspaceId, this.options.operationId, 'storage-cutoff');
      }

      let inventory = journal?.inventory;
      if (!inventory) {
        const evidence = await this.options.collectInventory!(storageFence);
        if (!isRecord(evidence) || evidence.complete !== true) {
          throw new Error('Authoritative storage-cutoff inventory is incomplete.');
        }
        assertBoundedString(evidence.source, 'storage cutoff inventory source', 1_024);
        if (evidence.fenceOperationId !== storageFence.operationId || evidence.fenceEpoch !== storageFence.fenceEpoch) {
          throw new Error('Storage-cutoff inventory was not collected under the completed writer fence.');
        }
        const sessionIds = canonicalInventory(evidence.sessionIds);
        assertSha256(evidence.inventorySha256, 'storage cutoff inventorySha256');
        if (analyticsCutoverInventorySha256(sessionIds) !== evidence.inventorySha256) {
          throw new Error('Storage-cutoff inventory evidence digest is invalid.');
        }
        inventory = {
          source: evidence.source,
          sessionIds,
          fenceOperationId: evidence.fenceOperationId,
          fenceEpoch: evidence.fenceEpoch,
          inventorySha256: evidence.inventorySha256,
        };
      }

      if (!inventory) throw new Error('Storage cutoff inventory could not be initialized.');
      journal = {
        ...(journal ?? {
          schemaVersion: ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION,
          operationId: this.options.operationId,
          workspaceId: this.options.workspaceId,
          mode: this.options.mode,
          plan: ANALYTICS_CUTOVER_PLAN_REFERENCE,
          authorizationCommitSha: this.options.authorization.commitSha,
          phase: 'storage-fenced' as const,
          startedAt: timestamp(this.now),
          updatedAt: timestamp(this.now),
        }),
        phase: 'storage-fenced',
        updatedAt: timestamp(this.now),
        storageFence,
        inventory,
        storage: undefined,
        lastError: undefined,
      };
      const frozenStorageJournal = journal;
      if (!frozenStorageJournal) throw new Error('Storage cutoff journal could not be initialized.');
      await writeJournal(this.options.stateDir, frozenStorageJournal);

      storage = await performStorageCutoff({
        store: this.options.registry,
        cleaner: this.options.cleaner,
        stateDir: this.options.stateDir,
        inventory: inventory.sessionIds,
        inventoryValidated: true,
        operationId: this.options.operationId,
        writerFence: { ensureFenced: async () => storageFence },
        now: this.now,
      });
      const receiptSha256 = storageCutoffReceiptSha256(storage);
      journal = {
        ...frozenStorageJournal,
        phase: 'storage-receipt-ready',
        updatedAt: timestamp(this.now),
        storage: { receiptSha256 },
        lastError: storage.failures.length === 0 ? undefined : `Storage cutoff has ${storage.failures.length} failure(s).`,
      };
      const receiptJournal = journal;
      if (!receiptJournal?.storage?.receiptSha256) throw new Error('Storage cutoff receipt evidence is missing from its journal.');
      await writeJournal(this.options.stateDir, receiptJournal);
      if (storage.failures.length !== 0) {
        throw new Error(`Storage cutoff receipt contains ${storage.failures.length} failure(s); refusing completion.`);
      }
      if (!sameReceiptHash(storage, receiptJournal.storage.receiptSha256)) {
        throw new Error('Storage cutoff receipt hash does not match the orchestration journal.');
      }

      // The link is deliberately after a complete, exact receipt. A P7a
      // activation record therefore never pretends that P7b already happened.
      await linkStorageCutoffReceipt(
        this.options.activationStore,
        receiptSha256,
        active.manifest.activeGeneration.identity.generationId,
      );
      const linkedRead = this.options.activationStore.read();
      if (!linkedRead.manifest?.activeGeneration || linkedRead.manifest.activeGeneration.cutoffReceiptSha256 !== receiptSha256) {
        throw new ActivationManifestError('Storage cutoff receipt link was not durably committed.');
      }
      // As with analytics activation, persisted verification is not a live
      // process census. Re-run the idempotent ownership switch on recovery;
      // only its current proof may move the orchestration to `complete`.
      storageVerification = assertStorageVerification(
        await this.options.runtime.completeStorageCutoff({
          operationId: this.options.operationId,
          fence: storageFence,
          receipt: storage,
          manifest: linkedRead.manifest,
        }),
      );
      journal = {
        ...journal,
        phase: 'complete',
        updatedAt: timestamp(this.now),
        storage: { receiptSha256, verification: storageVerification },
        lastError: undefined,
      };
      await writeJournal(this.options.stateDir, journal);
    }

    if (this.options.mode === 'analytics-activation') {
      journal = {
        ...(journal ?? {
          schemaVersion: ANALYTICS_CUTOVER_JOURNAL_SCHEMA_VERSION,
          operationId: this.options.operationId,
          workspaceId: this.options.workspaceId,
          mode: this.options.mode,
          plan: ANALYTICS_CUTOVER_PLAN_REFERENCE,
          authorizationCommitSha: this.options.authorization.commitSha,
          phase: 'analytics-verified' as const,
          startedAt: timestamp(this.now),
          updatedAt: timestamp(this.now),
        }),
        phase: 'complete',
        updatedAt: timestamp(this.now),
        lastError: undefined,
      };
      await writeJournal(this.options.stateDir, journal);
    }

    // A recovery invocation may find the storage receipt complete but the
    // process died before returning the values to its caller. Revalidate the
    // receipt/journal pair rather than treating the phase record as authority.
    if (this.options.mode !== 'analytics-activation' && storage && journal?.inventory) {
      const inspection = inspectStorageCutoff({
        stateDir: this.options.stateDir,
        inventory: journal.inventory.sessionIds,
        inventoryValidated: true,
        operationId: this.options.operationId,
      });
      if (storageCutoffReceiptSha256(inspection.receipt) !== journal.storage?.receiptSha256) {
        throw new Error('Storage cutoff inspection disagrees with the orchestration journal.');
      }
      storage = inspection.receipt;
    }

    if (this.options.mode === 'analytics-activation' && journal?.phase !== 'complete') {
      throw new Error('Analytics cutover did not reach its durable terminal phase.');
    }
    if (this.options.mode !== 'analytics-activation' && journal?.phase !== 'complete') {
      throw new Error('Storage cutover did not reach its durable terminal phase.');
    }
    return {
      operationId: this.options.operationId,
      mode: this.options.mode,
      status: 'complete',
      ...(activation ? { activation } : {}),
      ...(storage ? { storage } : {}),
      ...(loadedGeneration ? { loadedGeneration } : {}),
      ...(storageVerification ? { storageVerification } : {}),
    };
  }
}
