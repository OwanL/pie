#!/usr/bin/env node
/** Authoritative P7a disposable candidate-trial report producer.
 *
 * This runner exercises the production trial authority, recorder supervisor,
 * canonical capture, and bounded query helpers. It owns only one unique
 * OS-temp root and writes only the requested final report after that root has
 * been removed. It never constructs an ActivationStore.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ACTIVATION_MANIFEST_FILENAME,
  ACTIVATION_TOMBSTONE_FILENAME,
} from '../../../shared/analytics/activation.js';
import {
  ANALYTICS_SCHEMA_VERSION,
  deriveAnalyticsIdempotencyKey,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import {
  CANDIDATE_TRIAL_AUTHORITY_KIND,
  CANDIDATE_TRIAL_SCHEMA_VERSION,
  type CandidateTrialPlan,
} from '../../../shared/analytics/candidate-trial.js';
import { authorizeCandidateTrialRoot } from './candidate-trial-authority.js';
import { CanonicalAnalyticsReadModel, canonicalAnalyticsDatabasePath } from './query-entry.js';
import type { AnalyticsQueryLifecycleEvent } from './query-client.js';
import type { AnalyticsRecorderCaptureDisposition } from './recorder-supervisor.js';
import { startCandidateTrialRuntime } from '../host/analytics-runtime.js';
// @ts-expect-error The authoritative Node MJS validator has no TypeScript declaration.
import { validateOverallQualificationRecomputation } from '../../scripts/analytics-p0-overall-qualification.mjs';

export const CANDIDATE_TRIAL_REPORT_KIND = 'pie-p7a-candidate-trial-v1' as const;
export const CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_TRIAL_PRODUCER_VERSION = 'p7a-candidate-trial-v1' as const;
export const MAX_CANDIDATE_TRIAL_INPUT_BYTES = 8 * 1024 * 1024;

export interface CandidateTrialReportOptions {
  qualificationReportPath: string;
  reportPath: string;
  generationId: string;
  buildId: string;
  sourceHead: string;
  sourceFingerprint: string;
  workspaceId: string;
  canonicalDataRoot: string;
  liveRoots: readonly string[];
  recorderWorkerScript: string;
  queryWorkerScript: string;
  producerPath: string;
  /** Current candidate coordinated build id when it intentionally differs
   * from the measured qualification identity; requires the equivalence
   * receipt. */
  candidateBuildId?: string;
  /** Exact artifact/source equivalence receipt binding the measured evidence
   * identity to the current candidate build. */
  equivalenceReceiptPath?: string;
}

type JsonObject = Record<string, unknown>;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBoundedJson(filePath: string, label: string): { bytes: number; sha256: string; value: JsonObject } {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute.`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0
      || before.size > MAX_CANDIDATE_TRIAL_INPUT_BYTES) {
      throw new Error(`${label} must be a non-empty regular file within the evidence bound.`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`${label} ended while being read.`);
      offset += count;
    }
    if (fstatSync(descriptor).size !== before.size) throw new Error(`${label} changed while being read.`);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} is not an object.`);
    return { bytes: before.size, sha256: sha256(bytes), value: parsed as JsonObject };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedFile(filePath: string, label: string, maxBytes = MAX_CANDIDATE_TRIAL_INPUT_BYTES): Buffer {
  const resolved = path.resolve(filePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolved, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new Error(`${label} is not a bounded non-empty regular file: ${resolved}`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`${label} ended while being read.`);
      offset += count;
    }
    if (fstatSync(descriptor).size !== before.size) throw new Error(`${label} changed while being read.`);
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function receipt(filePath: string): { path: string; sha256: string; bytes: number } {
  const resolved = path.resolve(filePath);
  const bytes = readBoundedFile(resolved, 'Candidate-trial artifact');
  return { path: resolved, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** How a schema-valid overall qualification report may bind a candidate
 * trial: either fully qualified, or — only when the report itself explicitly
 * declares the approved provisional state alongside an honest unqualified
 * overall decision — provisionally qualified. Declaring a provisional state
 * that is not provisionally qualified, or claiming a provisional state on a
 * faked fully qualified overall decision, is refused. The measured gate
 * outcomes are never rewritten; the provisional binding still recomputes
 * through the authoritative validator, which enforces the byte-exact approved
 * envelope and the recomputed exception set. */
export type CandidateTrialQualificationMode = 'full-qualified' | 'provisional-qualified';

export function candidateTrialQualificationMode(qualification: JsonObject): CandidateTrialQualificationMode {
  const decision = qualification.qualification as JsonObject | undefined;
  if (decision?.provisionalP0 === 'provisional-qualified') {
    if (decision.overallP0 !== 'unqualified' || decision.decision !== 'overall-unqualified') {
      throw new Error('Candidate-trial qualification must keep an honest unqualified overall decision while provisionally qualified.');
    }
    return 'provisional-qualified';
  }
  if (decision?.provisionalP0 !== undefined) {
    throw new Error('Candidate-trial qualification declares a provisionalP0 that is not provisional-qualified.');
  }
  if (decision?.overallP0 === 'qualified' && decision.decision === 'overall-qualified') {
    return 'full-qualified';
  }
  throw new Error('Candidate-trial qualification report is not a qualified overall report with the exact requested identity.');
}

export function assertCandidateTrialQualificationRecomputation(
  qualification: JsonObject,
  expected: { buildId: string; sourceHead: string; sourceFingerprint: string },
): CandidateTrialQualificationMode {
  const mode = candidateTrialQualificationMode(qualification);
  const recomputed = validateOverallQualificationRecomputation(qualification, expected);
  const recomputationSatisfied = recomputed.valid
    && (mode === 'full-qualified' ? recomputed.qualified === true : recomputed.provisional?.qualified === true);
  if (!recomputationSatisfied) {
    throw new Error(`Candidate-trial qualification evidence does not recompute as ${
      mode === 'full-qualified' ? 'qualified' : 'provisionally qualified under the approved provisional envelope'
    }: ${recomputed.errors.join('; ') || 'required gates are not all passed'}`);
  }
  return mode;
}

/** Verify the exact artifact/source equivalence receipt binding the measured
 * qualification identity to the current candidate build. Recomputes every
 * recorded hash from the current tree; any unverifiable or changed production
 * entry fails closed. Only the receipt's own sha256 binding is trusted; every
 * file claim is re-verified here. */
function verifySourceEquivalenceReceipt(
  options: CandidateTrialReportOptions,
  context: { artifactRoot: string; candidateBuildId: string },
): { candidateBuildId: string; equivalenceReceiptSha256: string } {
  const repositoryRoot = path.resolve(context.artifactRoot, '..', '..');
  const receipt = readBoundedJson(options.equivalenceReceiptPath!, 'Candidate-trial equivalence receipt');
  const value = receipt.value;
  if (value.schemaVersion !== 1 || value.kind !== 'pie-analytics-source-equivalence-v1') {
    throw new Error('Candidate-trial equivalence receipt kind/schema is not the authoritative receipt.');
  }
  const measured = value.measured as JsonObject | undefined;
  if (!measured || measured.buildId !== options.buildId
    || measured.sourceHead !== options.sourceHead || measured.sourceFingerprint !== options.sourceFingerprint) {
    throw new Error('Candidate-trial equivalence receipt does not bind the measured qualification identity.');
  }
  const candidate = value.candidate as JsonObject | undefined;
  if (!candidate || candidate.buildId !== context.candidateBuildId) {
    throw new Error('Candidate-trial equivalence receipt does not bind the current candidate build identity.');
  }
  const currentFileSha256 = (relative: string): string => {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
      throw new Error('Candidate-trial equivalence receipt contains an invalid file path.');
    }
    const filePath = path.join(repositoryRoot, relative);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(filePath, 'r');
      const bytes = Buffer.alloc(8 * 1024 * 1024);
      const count = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count <= 0 || fstatSync(descriptor).size > bytes.length) {
        throw new Error(`Candidate-trial equivalence receipt file exceeds the bounded size: ${relative}`);
      }
      return sha256(bytes.subarray(0, count));
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  const productionRuntime = value.productionRuntime as JsonObject | undefined;
  if (!productionRuntime || Object.keys(productionRuntime).length === 0) {
    throw new Error('Candidate-trial equivalence receipt carries no verified production runtime manifest.');
  }
  for (const [file, entry] of Object.entries(productionRuntime)) {
    const record = entry as JsonObject | undefined;
    if (!record || record.verified !== 'identical' || !isHash(record.measuredSha256) || !isHash(record.candidateSha256)
      || record.measuredSha256 !== record.candidateSha256) {
      throw new Error(`Candidate-trial equivalence receipt production entry is not verified identical: ${file}`);
    }
    if (currentFileSha256(file) !== record.measuredSha256) {
      throw new Error(`Candidate-trial equivalence receipt production entry does not match the current tree: ${file}`);
    }
  }
  const dependencies = value.dependencies as JsonObject | undefined;
  if (!dependencies || Object.keys(dependencies).length === 0) {
    throw new Error('Candidate-trial equivalence receipt carries no dependency identity manifest.');
  }
  for (const [file, entry] of Object.entries(dependencies)) {
    const record = entry as JsonObject | undefined;
    if (!record || record.verified !== 'identical' || !isHash(record.measuredSha256)
      || currentFileSha256(file) !== record.measuredSha256) {
      throw new Error(`Candidate-trial equivalence receipt dependency identity does not match the current tree: ${file}`);
    }
  }
  const toolingState = value.toolingState as JsonObject | undefined;
  if (!toolingState || Object.keys(toolingState).length === 0) {
    throw new Error('Candidate-trial equivalence receipt carries no allowlisted tooling delta manifest.');
  }
  for (const [file, entry] of Object.entries(toolingState)) {
    const record = entry as JsonObject | undefined;
    if (!record || typeof record.basis !== 'string' || record.basis.length === 0
      || !isHash(record.candidateSha256) || currentFileSha256(file) !== record.candidateSha256) {
      throw new Error(`Candidate-trial equivalence receipt tooling delta does not match the current tree: ${file}`);
    }
  }
  const outputInventory = value.outputInventory as JsonObject | undefined;
  const artifacts = outputInventory?.artifacts as JsonObject | undefined;
  if (!artifacts || Object.keys(artifacts).length === 0) {
    throw new Error('Candidate-trial equivalence receipt carries no output inventory.');
  }
  for (const artifact of [options.producerPath, options.recorderWorkerScript, options.queryWorkerScript]) {
    const name = path.basename(artifact);
    const entries = Object.entries(artifacts).filter(([relative]) => path.basename(relative) === name);
    if (entries.length !== 1 || !isHash(entries[0]![1])
      || currentFileSha256(entries[0]![0]) !== entries[0]![1]) {
      throw new Error(`Candidate-trial equivalence receipt does not verify the trial artifact ${name}.`);
    }
  }
  return { candidateBuildId: context.candidateBuildId, equivalenceReceiptSha256: receipt.sha256 };
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

async function assertIdentityInputs(options: CandidateTrialReportOptions, qualification: JsonObject): Promise<{ candidateBuildId: string; equivalenceReceiptSha256: string } | undefined> {
  if (!path.isAbsolute(options.reportPath) || !options.reportPath.toLowerCase().endsWith('.json')) {
    throw new Error('Candidate-trial --report must be an absolute new .json path.');
  }
  if (existsSync(options.reportPath)) throw new Error('Candidate-trial report path must not already exist.');
  const reportName = path.basename(options.reportPath).toLowerCase();
  if (reportName === ACTIVATION_MANIFEST_FILENAME || reportName === ACTIVATION_TOMBSTONE_FILENAME) {
    throw new Error('Candidate-trial report path must not use a reserved activation filename.');
  }
  const reportParent = path.resolve(path.dirname(options.reportPath));
  const reportParentReal = path.normalize(realpathSync(reportParent));
  if (process.platform === 'win32'
    ? reportParent.toLowerCase() !== reportParentReal.toLowerCase()
    : reportParent !== reportParentReal) {
    throw new Error('Candidate-trial report parent must not traverse a symlink or junction alias.');
  }
  if (!/^[0-9a-f]{40}$/u.test(options.sourceHead) || !/^[0-9a-f]{64}$/u.test(options.sourceFingerprint)) {
    throw new Error('Candidate-trial source identity is invalid.');
  }
  if (!/^[0-9a-f-]{36}$/u.test(options.generationId) || !options.buildId.trim()
    || !options.workspaceId.trim()) {
    throw new Error('Candidate-trial generation/build/workspace identity is invalid.');
  }
  const provenance = qualification.provenance as JsonObject | undefined;
  let candidateBinding: { candidateBuildId: string; equivalenceReceiptSha256: string } | undefined;
  if (qualification.kind !== 'pie-p0-overall-qualification-v1' || qualification.schemaVersion !== 5
    || qualification.status !== 'passed' || provenance?.valid !== true
    || provenance.gitHead !== options.sourceHead || provenance.coordinatedBuildId !== options.buildId
    || provenance.fingerprint !== options.sourceFingerprint) {
    throw new Error('Candidate-trial qualification report is not a qualified overall report with the exact requested identity.');
  }
  candidateTrialQualificationMode(qualification);
  const configured = qualification.configuration as JsonObject | undefined;
  if (configured?.scenario !== 'overall'
    || typeof configured.reportPath !== 'string'
    || !samePath(configured.reportPath, options.qualificationReportPath)) {
    throw new Error('Candidate-trial qualification report path binding is invalid.');
  }
  const artifactPaths = [
    [options.producerPath, 'analytics-candidate-trial.js'],
    [options.recorderWorkerScript, 'analytics-recorder-worker.js'],
    [options.queryWorkerScript, 'analytics-query-worker.js'],
  ] as const;
  const artifactRoots = artifactPaths.map(([artifactPath, expectedName]) => {
    if (path.basename(artifactPath).toLowerCase() !== expectedName) {
      throw new Error(`Candidate-trial artifact must identify ${expectedName}.`);
    }
    const stats = lstatSync(artifactPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Candidate-trial ${expectedName} must be a real regular file.`);
    }
    return path.normalize(realpathSync(path.dirname(artifactPath)));
  });
  if (artifactRoots.some((artifactRoot) => artifactRoot !== artifactRoots[0])) {
    throw new Error('Candidate-trial producer and workers must come from one coordinated build directory.');
  }
  const artifactRoot = artifactRoots[0]!;
  for (const [artifactPath, expectedName] of artifactPaths) {
    const expectedPath = path.join(artifactRoot, expectedName);
    const artifactReal = path.normalize(realpathSync(artifactPath));
    const matches = process.platform === 'win32'
      ? artifactReal.toLowerCase() === expectedPath.toLowerCase()
      : artifactReal === expectedPath;
    if (!matches) throw new Error(`Candidate-trial ${expectedName} resolves outside the coordinated build directory.`);
  }
  const hostBuildId = readBoundedFile(
    path.join(artifactRoot, 'pie-build-id.txt'),
    'Candidate-trial host build identity',
    1_024,
  ).toString('utf8').trim();
  const rendererBuildId = readBoundedFile(
    path.join(artifactRoot, 'webview', 'panel', 'pie-build-id.txt'),
    'Candidate-trial renderer build identity',
    1_024,
  ).toString('utf8').trim();
  if (hostBuildId !== options.buildId || rendererBuildId !== options.buildId) {
    if (!options.candidateBuildId || !options.equivalenceReceiptPath) {
      throw new Error('Candidate-trial built identity differs from the measured qualification identity; --candidate-build-id and --equivalence-receipt are required.');
    }
    if (options.candidateBuildId !== hostBuildId || hostBuildId !== rendererBuildId) {
      throw new Error('Candidate-trial --candidate-build-id does not match the coordinated current build identity.');
    }
    candidateBinding = verifySourceEquivalenceReceipt(options, { artifactRoot, candidateBuildId: options.candidateBuildId });
  }
  assertCandidateTrialQualificationRecomputation(qualification, {
    buildId: options.buildId,
    sourceHead: options.sourceHead,
    sourceFingerprint: options.sourceFingerprint,
  });
  return candidateBinding;
}

function trialObservation(options: {
  generationId: string;
  buildId: string;
  rootSessionId: string;
  sourceKey: string;
  sourceSequence: number;
}): AnalyticsObservation<object> {
  const base: Omit<AnalyticsObservation<object>, 'idempotencyKey'> = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generationId: options.generationId,
    producerKind: 'host',
    sourceSequence: options.sourceSequence,
    sourceKey: options.sourceKey,
    stableOriginId: `candidate-trial:${options.rootSessionId}`,
    entityKind: 'execution',
    entityKey: `execution:${options.sourceKey}`,
    observationKind: 'end',
    observedAtMs: Date.now(),
    scope: { workspaceCoverage: 'known', workspaceId: 'candidate-trial', rootSessionId: options.rootSessionId },
    captureSubject: { kind: 'session', rootSessionId: options.rootSessionId },
    producer: { buildId: options.buildId, processGeneration: `candidate-trial:${process.pid}` },
    fields: { outcome: 'succeeded', endedAtMs: Date.now() },
  };
  return { ...base, idempotencyKey: deriveAnalyticsIdempotencyKey(base) };
}

function tracked(
  submit: (callback: (value: AnalyticsRecorderCaptureDisposition) => void) => void,
): Promise<AnalyticsRecorderCaptureDisposition> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Candidate-trial recorder disposition timed out.')), 10_000);
    try {
      submit((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function writeReport(filePath: string, report: unknown): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    descriptor = openSync(temporary, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve primary failure */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort for owned temp file */ }
    throw error;
  }
}

function assertArtifactReceiptsCurrent(receipts: Record<string, { path: string; sha256: string; bytes: number }>): void {
  for (const [label, expected] of Object.entries(receipts)) {
    const current = receipt(expected.path);
    if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) {
      throw new Error(`Candidate-trial ${label} artifact changed during the trial.`);
    }
  }
}

function pathFacts(rootDir: string, stateDir: string, analyticsDir: string, protectedRoots: readonly string[]) {
  const normalizedRoot = path.resolve(rootDir);
  const osTempRoot = path.resolve(os.tmpdir());
  const normalizedProtected = protectedRoots.map((value) => path.resolve(value));
  return {
    rootDir: normalizedRoot,
    stateDir: path.resolve(stateDir),
    analyticsDir: path.resolve(analyticsDir),
    osTempRoot,
    protectedRoots: normalizedProtected,
    rootUnderOsTemp: containsPath(osTempRoot, normalizedRoot) && normalizedRoot !== osTempRoot,
    childrenContained: [stateDir, analyticsDir].every((value) => containsPath(normalizedRoot, path.resolve(value))),
    protectedRootsDisjoint: normalizedProtected.every((value) =>
      !containsPath(value, normalizedRoot) && !containsPath(normalizedRoot, value)),
  };
}

export async function produceCandidateTrialReport(options: CandidateTrialReportOptions): Promise<JsonObject> {
  const generatedAt = new Date().toISOString();
  const qualification = readBoundedJson(options.qualificationReportPath, 'Candidate-trial qualification report');
  const candidateBinding = await assertIdentityInputs(options, qualification.value);
  const trialId = `trial-${randomUUID()}`;
  const plan: CandidateTrialPlan = {
    schemaVersion: CANDIDATE_TRIAL_SCHEMA_VERSION,
    kind: CANDIDATE_TRIAL_AUTHORITY_KIND,
    identity: {
      trialId,
      generationId: options.generationId,
      buildId: options.buildId,
      sourceHead: options.sourceHead,
      sourceFingerprint: options.sourceFingerprint,
      qualificationSha256: qualification.sha256,
    },
    workspaceId: options.workspaceId,
  };
  if (options.liveRoots.length > 63) throw new Error('Candidate-trial accepts at most 63 live roots plus the canonical data owner.');
  const protectedRoots = [...new Set([...options.liveRoots, options.canonicalDataRoot]
    .map((value) => path.normalize(realpathSync(value))))];
  if (protectedRoots.some((protectedRoot) => containsPath(protectedRoot, options.reportPath))) {
    throw new Error('Candidate-trial report path must be outside every live and canonical data root.');
  }
  const artifactReceipts = {
    producer: receipt(options.producerPath),
    recorderWorker: receipt(options.recorderWorkerScript),
    queryWorker: receipt(options.queryWorkerScript),
  };
  const authority = authorizeCandidateTrialRoot(plan, {
    buildId: options.buildId,
    sourceHead: options.sourceHead,
    sourceFingerprint: options.sourceFingerprint,
    liveRoots: options.liveRoots,
    canonicalDataRoot: options.canonicalDataRoot,
  });
  const grant = authority.grant;
  const rootFacts = pathFacts(
    grant.resolvedPaths.rootDir,
    grant.resolvedPaths.stateDir,
    grant.resolvedPaths.analyticsDir,
    protectedRoots,
  );
  const manifestPath = path.join(grant.resolvedPaths.stateDir, ACTIVATION_MANIFEST_FILENAME);
  const tombstonePath = path.join(grant.resolvedPaths.stateDir, ACTIVATION_TOMBSTONE_FILENAME);
  let runtime: Awaited<ReturnType<typeof startCandidateTrialRuntime>> | undefined;
  let workloadError: string | undefined;
  let cleanupError: string | undefined;
  let workloadEvidence: JsonObject = {};
  let cleanupReceipt: JsonObject | undefined;

  try {
    runtime = await startCandidateTrialRuntime(authority, {
      recorderWorkerScript: options.recorderWorkerScript,
      queryWorkerScript: options.queryWorkerScript,
      hostInstanceId: `candidate-host-${randomUUID()}`,
      timeZone: 'UTC',
    });
    const readiness = await runtime.start();
    assertArtifactReceiptsCurrent(artifactReceipts);
    const descriptor = runtime.candidateTrialDescriptor();
    const recorder = runtime.sink;
    if (!recorder) throw new Error('Candidate-trial recorder was not exposed to the dedicated producer.');
    const recorderPid = recorder.workerPid;
    if (!recorderPid) throw new Error('Candidate-trial recorder worker identity is unavailable.');

    const sessionId = `candidate-session-${randomUUID()}`;
    const context = { sessionId, sessionPath: path.join(grant.resolvedPaths.rootDir, 'candidate-session.jsonl') };
    const now = Date.now();
    const beginStatus = runtime.capture.captureExecution(
      context,
      `execution-${trialId}`,
      'begin',
      `candidate-begin-${trialId}`,
      now,
      { startedAtMs: now, operationKind: 'agent-run' },
    );
    const endStatus = runtime.capture.captureExecution(
      context,
      `execution-${trialId}`,
      'end',
      `candidate-end-${trialId}`,
      now + 1,
      { startedAtMs: now, endedAtMs: now + 1, outcome: 'succeeded', operationKind: 'agent-run' },
    );
    await recorder.flush();

    const queryEvents: AnalyticsQueryLifecycleEvent[] = [];
    const readModel = new CanonicalAnalyticsReadModel({
      databasePath: canonicalAnalyticsDatabasePath(grant.resolvedPaths.analyticsDir),
      workerScript: options.queryWorkerScript,
      revisionPollIntervalMs: 25,
      onQueryLifecycle: (event) => queryEvents.push(structuredClone(event)),
    });
    const executionSummary = await readModel.readExecutionSummary(sessionId);
    const storageSummary = await readModel.readStorageSummary();
    const initialRevision = await readModel.readRevision();

    const crossHostReadModel = new CanonicalAnalyticsReadModel({
      databasePath: canonicalAnalyticsDatabasePath(grant.resolvedPaths.analyticsDir),
      workerScript: options.queryWorkerScript,
      revisionPollIntervalMs: 25,
      onQueryLifecycle: (event) => queryEvents.push(structuredClone(event)),
    });
    const crossHostInitialRevision = await crossHostReadModel.readRevision();
    const phaseStatus = runtime.capture.captureExecution(
      context,
      `execution-${trialId}`,
      'phase',
      `candidate-phase-${trialId}`,
      now + 2,
      { operationKind: 'candidate-trial', acceptanceEvidence: 'cross-host-revision' },
    );
    await recorder.flush();
    const observedRevision = await crossHostReadModel.waitForRevision(crossHostInitialRevision, { maxWaitMs: 3_000 });

    const acknowledgementRoot = `candidate-ack-${randomUUID()}`;
    const durableObservation = trialObservation({
      generationId: options.generationId,
      buildId: options.buildId,
      rootSessionId: acknowledgementRoot,
      sourceKey: `candidate-durable-${trialId}`,
      sourceSequence: 1,
    });
    const durable = await tracked((callback) => recorder.submitTracked(durableObservation, callback));
    await recorder.flush();
    await runtime.capture.closeSession(acknowledgementRoot, 'on', Date.now());
    const rejected = await tracked((callback) => recorder.submitTracked(trialObservation({
      generationId: options.generationId,
      buildId: options.buildId,
      rootSessionId: acknowledgementRoot,
      sourceKey: `candidate-rejected-${trialId}`,
      sourceSequence: 2,
    }), callback));
    await recorder.flush();

    const pendingAfterFence = await runtime.fenceWriters();
    let postFenceSubmissionRejected = false;
    try {
      recorder.submit(trialObservation({
        generationId: options.generationId,
        buildId: options.buildId,
        rootSessionId: sessionId,
        sourceKey: `candidate-post-fence-${trialId}`,
        sourceSequence: 3,
      }));
    } catch {
      postFenceSubmissionRejected = true;
    }
    const manifestCreatedBeforeCleanup = existsSync(manifestPath);
    const tombstoneCreatedBeforeCleanup = existsSync(tombstonePath);
    const terminalQueryWorkers = queryEvents.filter((event) => event.phase === 'terminal').length;
    const spawnedQueryWorkers = queryEvents.filter((event) => event.phase === 'spawned').length;

    workloadEvidence = {
      matchedSourceBuildConfig: {
        qualification: { path: path.resolve(options.qualificationReportPath), sha256: qualification.sha256, bytes: qualification.bytes },
        trialId,
        generationId: options.generationId,
        buildId: options.buildId,
        sourceHead: options.sourceHead,
        sourceFingerprint: options.sourceFingerprint,
        workspaceId: options.workspaceId,
        trialPlanSha256: grant.planSha256,
        producer: artifactReceipts.producer,
        recorderWorker: artifactReceipts.recorderWorker,
        queryWorker: artifactReceipts.queryWorker,
      },
      isolatedRoots: rootFacts,
      hostBackendRecorderQueryLifecycle: {
        readiness,
        descriptor,
        runtimeStartRepublished: (await runtime.start()).authority === 'candidate-trial',
        backendDescriptorAbsent: runtime.backendDescriptor() === undefined,
        loadedReceiptSuppressed: true,
        recorderWorker: { pid: recorderPid },
        captureStatuses: { begin: beginStatus, end: endStatus, phase: phaseStatus },
      },
      canonicalConsumers: {
        executionRevision: String(executionSummary.revision),
        executionCount: executionSummary.executionCount,
        begunCount: executionSummary.begunCount,
        settledCount: executionSummary.settledCount,
        lifecycleCoverage: executionSummary.lifecycleCoverage,
        storageRevision: String(storageSummary.projectionRevision),
        queryWorkers: { spawned: spawnedQueryWorkers, terminal: terminalQueryWorkers },
      },
      crossHostRevision: {
        firstHostRevision: initialRevision,
        secondHostInitialRevision: crossHostInitialRevision,
        secondHostObservedRevision: observedRevision,
        changed: observedRevision !== crossHostInitialRevision,
        revisionPollIntervalMs: 25,
        maxWaitMs: 3_000,
      },
      durableAndRejectedAcknowledgements: {
        durableStatus: durable.status,
        durableReconciliationCount: durable.status === 'durable' ? durable.producerReconciliation.length : 0,
        rejectedStatus: rejected.status,
        rejectedCode: rejected.status === 'rejected' ? rejected.code : null,
      },
      cleanup: {
        pendingAfterFence,
        postFenceSubmissionRejected,
        manifestCreatedBeforeCleanup,
        tombstoneCreatedBeforeCleanup,
      },
    };
  } catch (error) {
    workloadError = error instanceof Error ? error.message : String(error);
    const startupReceipt = (error as Error & { candidateTrialCleanupReceipt?: unknown }).candidateTrialCleanupReceipt;
    if (startupReceipt && typeof startupReceipt === 'object') cleanupReceipt = startupReceipt as JsonObject;
  } finally {
    try {
      if (runtime) {
        await runtime.stop();
        cleanupReceipt = runtime.cleanupReceipt as unknown as JsonObject | undefined;
      } else if (!cleanupReceipt) {
        cleanupReceipt = await authority.dispose() as unknown as JsonObject;
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
      cleanupReceipt = (runtime?.cleanupReceipt ?? cleanupReceipt ?? await authority.dispose()) as unknown as JsonObject;
    }
  }
  if (cleanupReceipt?.completed !== true && !cleanupError) {
    const reasons = Array.isArray(cleanupReceipt?.failureReasons) ? cleanupReceipt.failureReasons.join('; ') : 'unknown cleanup failure';
    cleanupError = `Candidate-trial cleanup failed: ${reasons}`;
  }
  if (!workloadError) {
    try {
      assertArtifactReceiptsCurrent(artifactReceipts);
    } catch (error) {
      workloadError = error instanceof Error ? error.message : String(error);
    }
  }

  const rootRemovedObserved = !existsSync(grant.resolvedPaths.rootDir);
  const cleanupComplete = cleanupReceipt?.completed === true
    && cleanupReceipt.rootRemoved === true
    && rootRemovedObserved
    && !cleanupError;
  const evidenceByCheck = workloadEvidence as Record<string, JsonObject>;
  evidenceByCheck.cleanup = {
    ...(evidenceByCheck.cleanup ?? {}),
    cleanupReceipt: cleanupReceipt ?? null,
    rootRemovedObserved,
    cleanupError: cleanupError ?? null,
  };
  const predicateByCheck: Record<string, boolean> = {
    matchedSourceBuildConfig: Boolean(evidenceByCheck.matchedSourceBuildConfig),
    isolatedRoots: rootFacts.rootUnderOsTemp && rootFacts.childrenContained && rootFacts.protectedRootsDisjoint,
    hostBackendRecorderQueryLifecycle: evidenceByCheck.hostBackendRecorderQueryLifecycle?.backendDescriptorAbsent === true,
    canonicalConsumers: Number(evidenceByCheck.canonicalConsumers?.executionCount) >= 1
      && Number(evidenceByCheck.canonicalConsumers?.begunCount) >= 1
      && Number(evidenceByCheck.canonicalConsumers?.settledCount) >= 1,
    crossHostRevision: evidenceByCheck.crossHostRevision?.changed === true,
    durableAndRejectedAcknowledgements:
      evidenceByCheck.durableAndRejectedAcknowledgements?.durableStatus === 'durable'
      && Number(evidenceByCheck.durableAndRejectedAcknowledgements?.durableReconciliationCount) > 0
      && evidenceByCheck.durableAndRejectedAcknowledgements?.rejectedStatus === 'rejected'
      && evidenceByCheck.durableAndRejectedAcknowledgements?.rejectedCode === 'subject_deleted',
    cleanup: cleanupComplete
      && evidenceByCheck.cleanup?.pendingAfterFence === 0
      && evidenceByCheck.cleanup?.postFenceSubmissionRejected === true
      && evidenceByCheck.cleanup?.manifestCreatedBeforeCleanup === false
      && evidenceByCheck.cleanup?.tombstoneCreatedBeforeCleanup === false,
  };
  const checks = Object.fromEntries(Object.entries(predicateByCheck).map(([name, decision]) => [
    name,
    { decision: decision ? 'passed' : 'failed', evidence: evidenceByCheck[name] ?? {} },
  ]));
  const passed = !workloadError && Object.values(predicateByCheck).every(Boolean);
  const report: JsonObject = {
    schemaVersion: CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION,
    kind: CANDIDATE_TRIAL_REPORT_KIND,
    producerVersion: CANDIDATE_TRIAL_PRODUCER_VERSION,
    status: passed ? 'passed' : 'failed',
    reportPath: path.resolve(options.reportPath),
    generatedAt,
    finishedAt: new Date().toISOString(),
    bindings: plan.identity as unknown as JsonObject,
    candidateBinding: candidateBinding ?? null,
    checks,
    cleanup: cleanupReceipt ?? null,
    errors: [workloadError, cleanupError].filter((value): value is string => Boolean(value)),
  };
  writeReport(options.reportPath, report);
  return report;
}

function parseArguments(argv: readonly string[]): CandidateTrialReportOptions {
  const values = new Map<string, string>();
  const liveRoots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[++index];
    if (!name.startsWith('--') || !value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--live-root') {
      if (liveRoots.length >= 63) throw new Error('Candidate-trial accepts at most 63 --live-root values.');
      liveRoots.push(path.resolve(value));
    }
    else if (name === '--candidate-build-id') {
      if (values.has('candidateBuildId')) throw new Error(`Duplicate candidate-trial option: ${name}`);
      values.set('candidateBuildId', value);
    }
    else if (name === '--equivalence-receipt') {
      if (values.has('equivalenceReceiptPath')) throw new Error(`Duplicate candidate-trial option: ${name}`);
      values.set('equivalenceReceiptPath', path.resolve(value));
    }
    else if (values.has(name)) throw new Error(`Duplicate candidate-trial option: ${name}`);
    else values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Candidate-trial ${name} is required.`);
    return value;
  };
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const extensionRoot = path.basename(moduleDirectory) === 'out'
    ? path.resolve(moduleDirectory, '..')
    : path.resolve(moduleDirectory, '..', '..');
  const outRoot = path.resolve(extensionRoot, 'out');
  const canonicalDataRoot = path.resolve(required('--canonical-data-root'));
  return {
    qualificationReportPath: path.resolve(required('--qualification')),
    reportPath: path.resolve(required('--report')),
    generationId: required('--generation-id'),
    buildId: required('--build-id'),
    sourceHead: required('--source-head').toLowerCase(),
    sourceFingerprint: required('--source-fingerprint').toLowerCase(),
    workspaceId: required('--workspace-id'),
    canonicalDataRoot,
    liveRoots,
    recorderWorkerScript: path.resolve(values.get('--recorder-worker') ?? path.join(outRoot, 'analytics-recorder-worker.js')),
    queryWorkerScript: path.resolve(values.get('--query-worker') ?? path.join(outRoot, 'analytics-query-worker.js')),
    producerPath: path.resolve(process.argv[1] ?? path.join(outRoot, 'analytics-candidate-trial.js')),
    ...(values.has('candidateBuildId') ? { candidateBuildId: values.get('candidateBuildId') } : {}),
    ...(values.has('equivalenceReceiptPath') ? { equivalenceReceiptPath: values.get('equivalenceReceiptPath') } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const report = await produceCandidateTrialReport(options);
  console.log(JSON.stringify({ reportPath: options.reportPath, status: report.status, errors: report.errors }, null, 2));
  if (report.status !== 'passed') process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
