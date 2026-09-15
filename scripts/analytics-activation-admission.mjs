import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateCapacityCalibration } from '../extension/scripts/analytics-p0-capacity.mjs';
import {
  DEFERRED_OVERALL_QUALIFICATION_GATES,
  OVERALL_QUALIFICATION_KIND,
  PROVISIONAL_QUALIFICATION_ENVELOPE,
  REQUIRED_OVERALL_QUALIFICATION_GATES,
  validateOverallQualificationRecomputation,
} from '../extension/scripts/analytics-p0-overall-qualification.mjs';

/**
 * The P0 producer currently emits schema 5.  A scenario-passed report is only
 * evidence for that scenario; it is not the overall qualification needed by
 * activation.  The producer must eventually emit `overallP0: qualified` after
 * every required gate has been exercised.
 */
export const QUALIFICATION_REPORT_SCHEMA_VERSION = 5;

/** Authoritative P7a candidate-trial envelope emitted only after the distinct
 * trial authority has stopped its production helpers and removed its root. */
export const CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION = 1;
export const CANDIDATE_TRIAL_REPORT_KIND = 'pie-p7a-candidate-trial-v1';
export const CANDIDATE_TRIAL_VALIDATOR_AVAILABLE = true;

/** Reports contain timing samples, but must remain a bounded handoff input. */
export const MAX_ACTIVATION_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** These are the required P0 gate names, including gates the bounded harness
 * records as explicitly unqualified. A complete qualification must pass all
 * of them. DEFERRED_QUALIFICATION_GATES names the one gate whose tier the
 * recorded envelope defers: it may stay explicitly unqualified in an otherwise
 * qualified overall report (with its measured capacity reason recomputed from
 * evidence), never 'passed' by a skip, and a failed deferred gate still
 * blocks admission. */
export const REQUIRED_QUALIFICATION_GATES = REQUIRED_OVERALL_QUALIFICATION_GATES;
export const DEFERRED_QUALIFICATION_GATES = DEFERRED_OVERALL_QUALIFICATION_GATES;

/** The matched candidate trial in the scratch design requires these bounded
 * source/runtime/cleanup proofs before it can be used as activation evidence. */
export const REQUIRED_CANDIDATE_TRIAL_CHECKS = Object.freeze([
  'matchedSourceBuildConfig',
  'isolatedRoots',
  'hostBackendRecorderQueryLifecycle',
  'canonicalConsumers',
  'crossHostRevision',
  'durableAndRejectedAcknowledgements',
  'cleanup',
]);

export class ActivationEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActivationEvidenceError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isGitHead(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

function isBoundedString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function invalid(label, detail) {
  throw new ActivationEvidenceError(`${label}: ${detail}`);
}

/** Read one JSON evidence file without allowing a size race to turn into an
 * unbounded allocation.  The second stat also rejects a file replaced while
 * it was being read; callers hash these exact bytes into the manifest. */
export function readBoundedJsonFile(filePath, label, maxBytes = MAX_ACTIVATION_EVIDENCE_BYTES) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) invalid(label, 'path must be absolute');
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const initial = fstatSync(fd);
    if (!initial.isFile()) invalid(label, 'path is not a regular file');
    if (!Number.isSafeInteger(initial.size) || initial.size > maxBytes) {
      invalid(label, `file exceeds the ${maxBytes}-byte bound`);
    }
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) invalid(label, 'file ended before its declared size');
      offset += count;
    }
    const final = fstatSync(fd);
    if (final.size !== initial.size) invalid(label, 'file changed while it was being read');
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      invalid(label, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      value,
    };
  } catch (error) {
    if (error instanceof ActivationEvidenceError) throw error;
    throw new ActivationEvidenceError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validateQualificationReport(
  report,
  expected,
  reportPath,
  reportHash,
  { requireQualification = true, provisional = false } = {},
) {
  const label = 'qualification report';
  if (!isObject(report)) invalid(label, 'top level must be an object');
  if (report.schemaVersion !== QUALIFICATION_REPORT_SCHEMA_VERSION) {
    invalid(label, `schemaVersion must be ${QUALIFICATION_REPORT_SCHEMA_VERSION}`);
  }
  if (report.status !== 'passed') invalid(label, 'status must be passed');
  if (!isBoundedString(report.harnessVersion)) invalid(label, 'harnessVersion is missing');

  const configuration = report.configuration;
  if (!isObject(configuration)) invalid(label, 'configuration is missing');
  const overall = report.kind === OVERALL_QUALIFICATION_KIND;
  if (!['baseline', 'scale', 'overall'].includes(configuration.scenario)) invalid(label, 'configuration.scenario is invalid');
  if (overall !== (configuration.scenario === 'overall')) invalid(label, 'overall report kind/scenario is mismatched');
  const expectedRows = configuration.scenario === 'baseline' ? 10_000
    : configuration.scenario === 'scale' ? 1_000_000 : null;
  if (configuration.rows !== expectedRows) invalid(label, `configuration.rows must be ${expectedRows}`);
  if (!isBoundedString(configuration.seed)) invalid(label, 'configuration.seed is missing');
  if (!isBoundedString(configuration.reportPath) || !samePath(configuration.reportPath, reportPath)) {
    invalid(label, 'configuration.reportPath does not identify the supplied bytes');
  }

  const provenance = report.provenance;
  if (!isObject(provenance) || provenance.valid !== true) invalid(label, 'provenance is not valid');
  if (!isGitHead(provenance.gitHead) || provenance.gitHead.toLowerCase() !== expected.sourceHead.toLowerCase()) {
    invalid(label, 'provenance.gitHead does not match the candidate source head');
  }
  if (provenance.coordinatedBuildId !== expected.buildId) {
    invalid(label, 'provenance.coordinatedBuildId does not match the candidate build');
  }
  if (!isSha256(provenance.fingerprint) || provenance.fingerprint !== expected.sourceFingerprint) {
    invalid(label, 'provenance.fingerprint does not match the candidate source fingerprint');
  }
  // Scenario reports bind the measured source files directly. An overall
  // report instead binds and re-opens hash-addressed scenario reports below.
  if (!overall) {
    if (!isObject(provenance.files) || Object.keys(provenance.files).length === 0) {
      invalid(label, 'provenance.files is missing');
    }
    for (const [file, evidence] of Object.entries(provenance.files)) {
      if (!isObject(evidence) || !isSha256(evidence.sha256)
        || !Number.isSafeInteger(evidence.bytes) || evidence.bytes <= 0) {
        invalid(label, `provenance.files[${file}] is incomplete`);
      }
    }
  }

  if (!isObject(report.measurement) || report.measurement.completed !== true) {
    invalid(label, 'measurement is incomplete');
  }
  if (!isIsoInstant(report.generatedAt) || !isIsoInstant(report.finishedAt)) {
    invalid(label, 'generatedAt/finishedAt must be canonical ISO instants');
  }
  if (!isObject(report.cleanup) || report.cleanup.completed !== true || report.cleanup.rootRemoved !== true) {
    invalid(label, 'cleanup is incomplete');
  }

  const qualification = report.qualification;
  if (!isObject(qualification) || qualification.scenario !== configuration.scenario) {
    invalid(label, 'qualification scenario is missing or mismatched');
  }
  // This distinction is the critical fail-closed rule: successful component
  // scenarios are inputs; only the recomputed aggregate can be overall-qualified.
  const expectedDecision = overall
    ? (qualification.overallP0 === 'qualified' ? 'overall-qualified' : 'overall-unqualified')
    : 'scenario-passed';
  if (qualification.decision !== expectedDecision) invalid(label, 'qualification decision is invalid');
  if (requireQualification && provisional && !overall) {
    invalid(label, 'provisional admission requires the overall qualification report');
  }
  if (requireQualification && qualification.overallP0 !== 'qualified'
    && !(provisional && overall && qualification.provisionalP0 === 'provisional-qualified'
      && JSON.stringify(qualification.provisionalEnvelope) === JSON.stringify(PROVISIONAL_QUALIFICATION_ENVELOPE))) {
    invalid(label, provisional
      ? 'overallP0 is not qualified and no valid provisional-qualified envelope is recorded'
      : 'overallP0 is not qualified');
  }
  if (!Array.isArray(qualification.failedGates)
    || (!overall && qualification.failedGates.length !== 0)) {
    invalid(label, 'qualification.failedGates is invalid');
  }
  if (overall && !Array.isArray(qualification.unqualifiedGates)) {
    invalid(label, 'qualification.unqualifiedGates is invalid');
  }
  if (!isObject(report.gates)) invalid(label, 'gates are missing');
  const strictExceptionGates = requireQualification && provisional && overall
    ? new Set([...PROVISIONAL_QUALIFICATION_ENVELOPE.measurementExceptions, 'realProducerBoundary'])
    : new Set();
  for (const gateName of REQUIRED_QUALIFICATION_GATES) {
    const gate = report.gates[gateName];
    if (!isObject(gate)) {
      invalid(label, `required gate ${gateName} is not passed with evidence`);
    }
    if (requireQualification && (gate.decision !== 'passed' || gate.actual === null || gate.actual === undefined
      || gate.threshold === null || gate.threshold === undefined)
      && !strictExceptionGates.has(gateName)) {
      invalid(label, `required gate ${gateName} is not passed with evidence`);
    }
  }
  if (requireQualification) {
    // Under the provisional envelope, exactly the approved exception gates may
    // stay honestly failed or unqualified; every other gate must still be
    // passed (or a deferred-unqualified deferred gate).
    const exceptionGates = provisional && overall
      ? new Set([...PROVISIONAL_QUALIFICATION_ENVELOPE.measurementExceptions, 'realProducerBoundary'])
      : new Set();
    for (const [gateName, gate] of Object.entries(report.gates)) {
      const deferredUnqualified = gate.decision === 'unqualified'
        && DEFERRED_QUALIFICATION_GATES.includes(gateName);
      const exceptionOutcome = exceptionGates.has(gateName)
        && (gate.decision === 'failed' || gate.decision === 'unqualified');
      if (!isObject(gate) || (gate.decision !== 'passed' && !deferredUnqualified && !exceptionOutcome)) {
        invalid(label, `gate ${gateName} is not passed`);
      }
    }
  }

  return {
    reportHash,
    scenario: configuration.scenario,
    sourceHead: provenance.gitHead,
    sourceFingerprint: provenance.fingerprint,
    buildId: provenance.coordinatedBuildId,
  };
}

function recomputeQualificationGates(report) {
  const configuration = report.configuration;
  const results = report.results;
  const measurement = report.measurement;
  const samples = Array.isArray(results?.resourceEnvelope?.samples)
    ? results.resourceEnvelope.samples
    : [];
  const maxPhysicalBytes = samples.length === 0
    ? undefined
    : Math.max(...samples.map((sample) => sample?.physicalBytes));
  const minFreeBytes = samples.length === 0
    ? undefined
    : Math.min(...samples.map((sample) => sample?.freeBytes));
  const expectedDetailRows = Math.floor(configuration.rows / 10) + 3;
  const rules = new Map([
    // The producer's final table is the measured source; `measurement` is a
    // summary and must not be allowed to override it.
    ['exactPrimaryRows', { actual: results?.tableRows?.primaryFacts, passed: results?.tableRows?.primaryFacts === configuration.rows }],
    ['exactDetailRows', { actual: results?.tableRows?.detailPayloads, passed: results?.tableRows?.detailPayloads === expectedDetailRows }],
    ['handoffP99', { actual: results?.factHandoff?.p99Ms, passed: results?.factHandoff?.p99Ms <= 9 }],
    ['responsivenessProxyP95', { actual: results?.responsivenessProxy?.lag?.p95Ms, passed: results?.responsivenessProxy?.lag?.p95Ms <= 25 }],
    ['indexedQuery', { actual: results?.queries?.indexedSessionMs, passed: results?.queries?.indexedSessionMs <= 250 }],
    ['largeDetailQuery', { actual: results?.queries?.twoMiBDetailMs, passed: results?.queries?.twoMiBDetailMs <= 9_000 }],
    ['temporaryFootprint', { actual: maxPhysicalBytes, passed: maxPhysicalBytes <= 16 * 1024 ** 3 }],
    ['inPlaceCorruption', {
      actual: results?.destructiveFault?.phase,
      passed: results?.destructiveFault?.phase === 'completed'
        && results?.destructiveFault?.corruptionWorkerTerminal === true,
    }],
    ['reservedFreeDisk', { actual: minFreeBytes, passed: minFreeBytes >= 20 * 1024 ** 3 }],
    ['recorderWorkerRss', {
      actual: results?.memory?.maxWorkerRssBytes,
      passed: results?.memory?.maxWorkerRssBytes <= 256 * 1024 ** 2,
    }],
    ['scaleHistoryRows', {
      actual: results?.tableRows?.primaryFacts,
      passed: configuration.scenario === 'scale' && results?.tableRows?.primaryFacts >= 1_000_000,
    }],
    ['capacityCalibration', (() => {
      const validation = validateCapacityCalibration(results?.capacityCalibration, {
        baselineRows: configuration.rows,
        detailRows: Math.floor(configuration.rows / 10),
      });
      return { actual: results?.capacityCalibration?.eligible, passed: validation.valid };
    })()],
  ]);
  const errors = [];
  for (const gateName of REQUIRED_QUALIFICATION_GATES) {
    const rule = rules.get(gateName);
    if (!rule) {
      errors.push(`${gateName} has no authoritative recomputation in the current P0 producer`);
      continue;
    }
    const gate = report.gates[gateName];
    if (!rule.passed) errors.push(`${gateName} does not satisfy its owning gate predicate`);
    if (!Object.is(gate.actual, rule.actual)) {
      errors.push(`${gateName}.actual does not match recomputed evidence`);
    }
  }
  return errors;
}

function candidateKeysMatch(value, expectedKeys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function candidateContainsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isCandidateArtifactReceipt(value) {
  return candidateKeysMatch(value, ['path', 'sha256', 'bytes'])
    && isBoundedString(value.path) && path.isAbsolute(value.path)
    && isSha256(value.sha256) && Number.isSafeInteger(value.bytes)
    && value.bytes > 0 && value.bytes <= MAX_ACTIVATION_EVIDENCE_BYTES;
}

export function validateCandidateTrialArtifactFiles(report, expected) {
  const isolated = report.checks.isolatedRoots.evidence;
  try {
    const reportReal = path.normalize(realpathSync(report.reportPath));
    for (const protectedRoot of isolated.protectedRoots) {
      const protectedReal = path.normalize(realpathSync(protectedRoot));
      if (candidateContainsPath(protectedReal, reportReal)) {
        invalid('candidate trial report', 'reportPath physically overlaps a protected live or canonical root');
      }
    }
  } catch (error) {
    if (error instanceof ActivationEvidenceError) throw error;
    invalid('candidate trial report', `report or protected-root realpath is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const matched = report.checks.matchedSourceBuildConfig.evidence;
  const artifacts = [
    ['producer', matched.producer, 'analytics-candidate-trial.js'],
    ['recorder worker', matched.recorderWorker, 'analytics-recorder-worker.js'],
    ['query worker', matched.queryWorker, 'analytics-query-worker.js'],
  ];
  let artifactRoots;
  try {
    artifactRoots = artifacts.map(([, receipt]) => path.normalize(realpathSync(path.dirname(receipt.path))));
  } catch (error) {
    invalid('candidate trial report', `artifact build directory is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (artifactRoots.some((artifactRoot) => !samePath(artifactRoot, artifactRoots[0]))) {
    invalid('candidate trial report', 'producer and worker receipts are not from one coordinated build directory');
  }
  for (const [label, receipt, expectedName] of artifacts) {
    if (path.basename(receipt.path).toLowerCase() !== expectedName) {
      invalid('candidate trial report', `${label} receipt does not identify ${expectedName}`);
    }
    try {
      const stats = lstatSync(receipt.path);
      const expectedPath = path.join(artifactRoots[0], expectedName);
      if (stats.isSymbolicLink() || !stats.isFile()
        || !samePath(path.normalize(realpathSync(receipt.path)), expectedPath)) {
        invalid('candidate trial report', `${label} receipt is not the real coordinated-build artifact`);
      }
    } catch (error) {
      if (error instanceof ActivationEvidenceError) throw error;
      invalid('candidate trial report', `${label} artifact identity is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let fd;
    try {
      fd = openSync(receipt.path, 'r');
      const initial = fstatSync(fd);
      if (!initial.isFile() || initial.size !== receipt.bytes
        || initial.size <= 0 || initial.size > MAX_ACTIVATION_EVIDENCE_BYTES) {
        invalid('candidate trial report', `${label} receipt size does not match a bounded regular file`);
      }
      const bytes = Buffer.alloc(initial.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) invalid('candidate trial report', `${label} artifact ended before its declared size`);
        offset += count;
      }
      if (fstatSync(fd).size !== initial.size) {
        invalid('candidate trial report', `${label} artifact changed while it was being read`);
      }
      if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
        invalid('candidate trial report', `${label} artifact hash does not match its receipt`);
      }
    } catch (error) {
      if (error instanceof ActivationEvidenceError) throw error;
      invalid('candidate trial report', `${label} artifact is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const readBuildMarker = (markerPath, label) => {
    let fd;
    try {
      fd = openSync(markerPath, 'r');
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size <= 0 || stats.size > 1_024) {
        invalid('candidate trial report', `${label} is not a bounded build marker`);
      }
      const bytes = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) invalid('candidate trial report', `${label} ended before its declared size`);
        offset += count;
      }
      if (fstatSync(fd).size !== stats.size) invalid('candidate trial report', `${label} changed while being read`);
      return bytes.toString('utf8').trim();
    } catch (error) {
      if (error instanceof ActivationEvidenceError) throw error;
      invalid('candidate trial report', `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const buildRoot = artifactRoots[0];
  if (readBuildMarker(path.join(buildRoot, 'pie-build-id.txt'), 'host build marker') !== expected.buildId
    || readBuildMarker(path.join(buildRoot, 'webview', 'panel', 'pie-build-id.txt'), 'renderer build marker') !== expected.buildId) {
    invalid('candidate trial report', 'artifact build markers do not match the activation build');
  }
}

function isCandidateWorkerIdentity(value) {
  return candidateKeysMatch(value, ['pid']) && Number.isSafeInteger(value.pid) && value.pid > 0;
}

function isCandidateCleanupReceipt(value, trialId) {
  return candidateKeysMatch(value, ['trialId', 'completed', 'rootRemoved', 'stoppedAt', 'failureReasons'])
    && value.trialId === trialId && value.completed === true && value.rootRemoved === true
    && isIsoInstant(value.stoppedAt) && Array.isArray(value.failureReasons) && value.failureReasons.length === 0;
}

function validateCandidateTrialReport(report, expected, reportPath, reportHash) {
  const label = 'candidate trial report';
  if (!candidateKeysMatch(report, [
    'schemaVersion', 'kind', 'producerVersion', 'status', 'reportPath', 'generatedAt', 'finishedAt',
    'bindings', 'checks', 'cleanup', 'errors',
  ])) invalid(label, 'top-level keys do not match the bounded authoritative schema');
  if (report.schemaVersion !== CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION) {
    invalid(label, `schemaVersion must be ${CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION}`);
  }
  if (report.kind !== CANDIDATE_TRIAL_REPORT_KIND || report.producerVersion !== 'p7a-candidate-trial-v1') {
    invalid(label, 'producer identity is not the authoritative candidate-trial producer');
  }
  if (report.status !== 'passed' || !Array.isArray(report.errors) || report.errors.length !== 0) {
    invalid(label, 'status or errors do not describe a clean passed run');
  }
  if (!isBoundedString(report.reportPath) || !samePath(report.reportPath, reportPath)) {
    invalid(label, 'reportPath does not identify the supplied bytes');
  }
  if (!isIsoInstant(report.generatedAt) || !isIsoInstant(report.finishedAt)
    || Date.parse(report.finishedAt) < Date.parse(report.generatedAt)) {
    invalid(label, 'generatedAt/finishedAt must be ordered canonical ISO instants');
  }

  const bindings = report.bindings;
  if (!candidateKeysMatch(bindings, [
    'trialId', 'generationId', 'buildId', 'sourceHead', 'sourceFingerprint', 'qualificationSha256',
  ]) || !isBoundedString(bindings.trialId)) invalid(label, 'bindings do not match the bounded schema');
  if (bindings.generationId !== expected.generationId) invalid(label, 'generationId binding mismatches the plan');
  if (bindings.buildId !== expected.buildId) invalid(label, 'buildId binding mismatches the plan');
  if (!isGitHead(bindings.sourceHead) || bindings.sourceHead.toLowerCase() !== expected.sourceHead.toLowerCase()) {
    invalid(label, 'sourceHead binding mismatches the plan');
  }
  if (bindings.sourceFingerprint !== expected.sourceFingerprint) invalid(label, 'sourceFingerprint binding mismatches the plan');
  if (bindings.qualificationSha256 !== expected.qualificationSha256) {
    invalid(label, 'qualificationSha256 binding mismatches the qualification bytes');
  }
  if (!candidateKeysMatch(report.checks, REQUIRED_CANDIDATE_TRIAL_CHECKS)) {
    invalid(label, 'checks do not match the exact required candidate-trial set');
  }
  for (const checkName of REQUIRED_CANDIDATE_TRIAL_CHECKS) {
    const check = report.checks[checkName];
    if (!candidateKeysMatch(check, ['decision', 'evidence']) || check.decision !== 'passed'
      || !isObject(check.evidence) || Object.keys(check.evidence).length === 0) {
      invalid(label, `required check ${checkName} is incomplete`);
    }
  }
  if (report.checks.matchedSourceBuildConfig.evidence.workspaceId !== expected.workspaceId) {
    invalid(label, 'workspaceId evidence mismatches the activation plan');
  }
  const reportName = path.basename(report.reportPath).toLowerCase();
  if (reportName === 'analytics-activation-v1.json' || reportName === 'analytics-ever-active-v1.json') {
    invalid(label, 'reportPath uses a reserved activation filename');
  }
  const protectedRoots = report.checks.isolatedRoots.evidence.protectedRoots;
  if (Array.isArray(protectedRoots)
    && protectedRoots.some((protectedRoot) => typeof protectedRoot === 'string'
      && candidateContainsPath(protectedRoot, report.reportPath))) {
    invalid(label, 'reportPath overlaps a protected live or canonical root');
  }
  if (!isCandidateCleanupReceipt(report.cleanup, bindings.trialId)) invalid(label, 'cleanup is incomplete');
  return { reportHash, trialId: bindings.trialId };
}

export const CANDIDATE_TRIAL_EVIDENCE_SCHEMAS = Object.freeze({
  matchedSourceBuildConfig: Object.freeze([
    'qualification', 'trialId', 'generationId', 'buildId', 'sourceHead', 'sourceFingerprint',
    'workspaceId', 'trialPlanSha256', 'producer', 'recorderWorker', 'queryWorker',
  ]),
  isolatedRoots: Object.freeze([
    'rootDir', 'stateDir', 'analyticsDir', 'osTempRoot', 'protectedRoots',
    'rootUnderOsTemp', 'childrenContained', 'protectedRootsDisjoint',
  ]),
  hostBackendRecorderQueryLifecycle: Object.freeze([
    'readiness', 'descriptor', 'runtimeStartRepublished', 'backendDescriptorAbsent',
    'loadedReceiptSuppressed', 'recorderWorker', 'captureStatuses',
  ]),
  canonicalConsumers: Object.freeze([
    'executionRevision', 'executionCount', 'begunCount', 'settledCount', 'lifecycleCoverage',
    'storageRevision', 'queryWorkers',
  ]),
  crossHostRevision: Object.freeze([
    'firstHostRevision', 'secondHostInitialRevision', 'secondHostObservedRevision',
    'changed', 'revisionPollIntervalMs', 'maxWaitMs',
  ]),
  durableAndRejectedAcknowledgements: Object.freeze([
    'durableStatus', 'durableReconciliationCount', 'rejectedStatus', 'rejectedCode',
  ]),
  cleanup: Object.freeze([
    'pendingAfterFence', 'postFenceSubmissionRejected', 'manifestCreatedBeforeCleanup',
    'tombstoneCreatedBeforeCleanup', 'cleanupReceipt', 'rootRemovedObserved', 'cleanupError',
  ]),
});

function evidenceKeysMatchSchema(evidence, name) {
  return candidateKeysMatch(evidence, CANDIDATE_TRIAL_EVIDENCE_SCHEMAS[name]);
}

function recomputeMatchedSourceBuildConfigEvidence(evidence, report, expected) {
  if (!evidenceKeysMatchSchema(evidence, 'matchedSourceBuildConfig')) return 'matchedSourceBuildConfig evidence keys are invalid';
  const qualification = evidence.qualification;
  if (!candidateKeysMatch(qualification, ['path', 'sha256', 'bytes']) || !path.isAbsolute(qualification.path)
    || qualification.sha256 !== expected.qualificationSha256 || !Number.isSafeInteger(qualification.bytes)
    || qualification.bytes <= 0 || qualification.bytes > MAX_ACTIVATION_EVIDENCE_BYTES) {
    return 'matchedSourceBuildConfig qualification receipt does not match the exact qualification bytes';
  }
  if (evidence.trialId !== report.bindings.trialId || evidence.generationId !== expected.generationId
    || evidence.buildId !== expected.buildId || evidence.sourceHead !== expected.sourceHead.toLowerCase()
    || evidence.sourceFingerprint !== expected.sourceFingerprint || evidence.workspaceId !== expected.workspaceId
    || !isSha256(evidence.trialPlanSha256) || !isCandidateArtifactReceipt(evidence.producer)
    || !isCandidateArtifactReceipt(evidence.recorderWorker) || !isCandidateArtifactReceipt(evidence.queryWorker)) {
    return 'matchedSourceBuildConfig identity or artifact receipts do not match the activation bindings';
  }
  const planIdentity = {
    trialId: evidence.trialId,
    generationId: evidence.generationId,
    buildId: evidence.buildId,
    sourceHead: evidence.sourceHead,
    sourceFingerprint: evidence.sourceFingerprint,
    qualificationSha256: expected.qualificationSha256,
  };
  const recomputedPlan = createHash('sha256').update(JSON.stringify([
    1, 'pie-p7a-candidate-trial-authority-v1', planIdentity, evidence.workspaceId,
  ])).digest('hex');
  if (recomputedPlan !== evidence.trialPlanSha256) return 'matchedSourceBuildConfig trial plan hash does not recompute';
  return null;
}

function recomputeIsolatedRootsEvidence(evidence) {
  if (!evidenceKeysMatchSchema(evidence, 'isolatedRoots')) return 'isolatedRoots evidence keys are invalid';
  const paths = ['rootDir', 'stateDir', 'analyticsDir', 'osTempRoot'];
  if (paths.some((name) => !isBoundedString(evidence[name]) || !path.isAbsolute(evidence[name]))
    || !Array.isArray(evidence.protectedRoots) || evidence.protectedRoots.length < 1
    || evidence.protectedRoots.length > 64 || evidence.protectedRoots.some((value) => !isBoundedString(value) || !path.isAbsolute(value))) {
    return 'isolatedRoots path receipts are invalid or unbounded';
  }
  const root = path.resolve(evidence.rootDir);
  const isolated = candidateContainsPath(evidence.osTempRoot, root) && !samePath(evidence.osTempRoot, root)
    && samePath(evidence.stateDir, path.join(root, 'state'))
    && samePath(evidence.analyticsDir, path.join(root, 'analytics'))
    && evidence.protectedRoots.every((protectedRoot) =>
      !candidateContainsPath(protectedRoot, root) && !candidateContainsPath(root, protectedRoot));
  if (!isolated || evidence.rootUnderOsTemp !== true || evidence.childrenContained !== true
    || evidence.protectedRootsDisjoint !== true) return 'isolatedRoots containment receipts do not recompute';
  return null;
}

function recomputeHostLifecycleEvidence(evidence, report, expected) {
  if (!evidenceKeysMatchSchema(evidence, 'hostBackendRecorderQueryLifecycle')) return 'hostBackendRecorderQueryLifecycle evidence keys are invalid';
  const readiness = evidence.readiness;
  const descriptor = evidence.descriptor;
  if (!candidateKeysMatch(readiness, [
    'authority', 'manifestRevision', 'manifestSha256', 'generationId', 'recorderSchemaVersion',
    'projectionRevision', 'recorderReady', 'queryReady',
  ]) || readiness.authority !== 'candidate-trial' || readiness.manifestRevision !== null
    || readiness.manifestSha256 !== null || readiness.generationId !== expected.generationId
    || !Number.isSafeInteger(readiness.recorderSchemaVersion) || readiness.recorderSchemaVersion <= 0
    || !isBoundedString(readiness.projectionRevision) || readiness.recorderReady !== true || readiness.queryReady !== true) {
    return 'hostBackendRecorderQueryLifecycle readiness does not prove the distinct trial authority';
  }
  const matched = report.checks.matchedSourceBuildConfig.evidence;
  if (!candidateKeysMatch(descriptor, [
    'kind', 'trialId', 'generationId', 'buildId', 'workspaceId', 'hostInstanceId',
    'trialPlanSha256', 'trialAuthorityRevision',
  ]) || descriptor.kind !== 'candidate-trial' || descriptor.trialId !== report.bindings.trialId
    || descriptor.generationId !== expected.generationId || descriptor.buildId !== expected.buildId
    || descriptor.workspaceId !== matched.workspaceId || !isBoundedString(descriptor.hostInstanceId)
    || descriptor.trialPlanSha256 !== matched.trialPlanSha256 || descriptor.trialAuthorityRevision !== 1
    || evidence.runtimeStartRepublished !== true || evidence.backendDescriptorAbsent !== true
    || evidence.loadedReceiptSuppressed !== true || !isCandidateWorkerIdentity(evidence.recorderWorker)
    || !candidateKeysMatch(evidence.captureStatuses, ['begin', 'end', 'phase'])
    || Object.values(evidence.captureStatuses).some((status) => status !== 'submitted')) {
    return 'hostBackendRecorderQueryLifecycle runtime, descriptor, recorder, or capture evidence is invalid';
  }
  return null;
}

function recomputeCanonicalConsumersEvidence(evidence) {
  if (!evidenceKeysMatchSchema(evidence, 'canonicalConsumers')) return 'canonicalConsumers evidence keys are invalid';
  const revisions = [evidence.executionRevision, evidence.storageRevision];
  if (revisions.some((value) => typeof value !== 'string' || !/^\d{1,20}$/u.test(value)
    || BigInt(value) > 9_223_372_036_854_775_807n)
    || !Number.isSafeInteger(evidence.executionCount) || evidence.executionCount < 1
    || !Number.isSafeInteger(evidence.begunCount) || evidence.begunCount < 1
    || !Number.isSafeInteger(evidence.settledCount) || evidence.settledCount < 1
    || evidence.lifecycleCoverage !== 'known'
    || !candidateKeysMatch(evidence.queryWorkers, ['spawned', 'terminal'])
    || !Number.isSafeInteger(evidence.queryWorkers.spawned) || evidence.queryWorkers.spawned < 1
    || evidence.queryWorkers.terminal !== evidence.queryWorkers.spawned) {
    return 'canonicalConsumers bounded read models or query-worker lifecycle are incomplete';
  }
  return null;
}

function recomputeCrossHostRevisionEvidence(evidence, report) {
  if (!evidenceKeysMatchSchema(evidence, 'crossHostRevision')) return 'crossHostRevision evidence keys are invalid';
  for (const key of ['firstHostRevision', 'secondHostInitialRevision', 'secondHostObservedRevision']) {
    if (typeof evidence[key] !== 'string' || !/^\d{1,20}$/u.test(evidence[key])
      || BigInt(evidence[key]) > 9_223_372_036_854_775_807n) return 'crossHostRevision revision receipt is invalid';
  }
  const firstRevision = BigInt(evidence.firstHostRevision);
  const initialRevision = BigInt(evidence.secondHostInitialRevision);
  const observedRevision = BigInt(evidence.secondHostObservedRevision);
  const canonical = report.checks.canonicalConsumers.evidence;
  if (evidence.changed !== true || firstRevision !== initialRevision || observedRevision <= initialRevision
    || canonical?.executionRevision !== evidence.firstHostRevision
    || canonical?.storageRevision !== evidence.firstHostRevision
    || evidence.revisionPollIntervalMs !== 25 || evidence.maxWaitMs !== 3_000) {
    return 'crossHostRevision did not observe a bounded second-host revision change';
  }
  return null;
}

function recomputeAcknowledgementEvidence(evidence) {
  if (!evidenceKeysMatchSchema(evidence, 'durableAndRejectedAcknowledgements')) {
    return 'durableAndRejectedAcknowledgements evidence keys are invalid';
  }
  if (evidence.durableStatus !== 'durable' || !Number.isSafeInteger(evidence.durableReconciliationCount)
    || evidence.durableReconciliationCount < 1 || evidence.rejectedStatus !== 'rejected'
    || evidence.rejectedCode !== 'subject_deleted') {
    return 'durableAndRejectedAcknowledgements does not contain both authoritative recorder dispositions';
  }
  return null;
}

function recomputeCleanupEvidence(evidence, report) {
  if (!evidenceKeysMatchSchema(evidence, 'cleanup')) return 'cleanup evidence keys are invalid';
  if (evidence.pendingAfterFence !== 0 || evidence.postFenceSubmissionRejected !== true
    || evidence.manifestCreatedBeforeCleanup !== false || evidence.tombstoneCreatedBeforeCleanup !== false
    || evidence.rootRemovedObserved !== true || evidence.cleanupError !== null
    || !isCandidateCleanupReceipt(evidence.cleanupReceipt, report.bindings.trialId)
    || JSON.stringify(evidence.cleanupReceipt) !== JSON.stringify(report.cleanup)) {
    return 'cleanup evidence does not prove fencing, manifest suppression, terminal helper stop, and root removal';
  }
  return null;
}

const RECOMPUTABLE_CANDIDATE_TRIAL_CHECKS = new Map([
  ['matchedSourceBuildConfig', recomputeMatchedSourceBuildConfigEvidence],
  ['isolatedRoots', recomputeIsolatedRootsEvidence],
  ['hostBackendRecorderQueryLifecycle', recomputeHostLifecycleEvidence],
  ['canonicalConsumers', recomputeCanonicalConsumersEvidence],
  ['crossHostRevision', recomputeCrossHostRevisionEvidence],
  ['durableAndRejectedAcknowledgements', recomputeAcknowledgementEvidence],
  ['cleanup', recomputeCleanupEvidence],
]);

/** Deterministically recompute the required candidate-trial checks from the
 * exact supplied report and receipts.  Returns one explicit error string per
 * failed, missing, unknown, or not-yet-authoritative check; it never
 * substitutes a boolean pass for a check that lacks an authoritative producer
 * or receipt criteria in this repository, and it performs no I/O, manifest
 * access, or runtime effects. */
export function recomputeCandidateTrialChecks(report, expected) {
  if (!isObject(report) || !isObject(report.checks)) {
    return ['candidate trial report checks are missing'];
  }
  if (!isObject(expected) || !isBoundedString(expected.generationId) || !isBoundedString(expected.buildId)
    || !isBoundedString(expected.workspaceId) || !isGitHead(expected.sourceHead) || !isSha256(expected.sourceFingerprint)
    || !isSha256(expected.qualificationSha256)) {
    return ['candidate trial recompute bindings are incomplete'];
  }
  const errors = [];
  for (const checkName of REQUIRED_CANDIDATE_TRIAL_CHECKS) {
    const check = report.checks[checkName];
    if (!isObject(check)) {
      errors.push(`required candidate trial check ${checkName} is missing from the report`);
      continue;
    }
    if (check.decision !== 'passed') {
      errors.push(`required candidate trial check ${checkName} is not passed`);
      continue;
    }
    const recompute = RECOMPUTABLE_CANDIDATE_TRIAL_CHECKS.get(checkName);
    if (!recompute) {
      errors.push(`${checkName} has no authoritative producer criteria in the current repository`);
      continue;
    }
    if (!isObject(check.evidence)) {
      errors.push(`${checkName} evidence is missing`);
      continue;
    }
    const error = recompute(check.evidence, report, expected);
    if (error) errors.push(error);
  }
  for (const checkName of Object.keys(report.checks)) {
    if (!REQUIRED_CANDIDATE_TRIAL_CHECKS.includes(checkName)) {
      errors.push(`unknown candidate trial check ${checkName} is not in the required set`);
    }
  }
  return errors;
}

function readAndValidateActivationEvidence(options, { requireQualification, recompute, provisional = false }) {
  const {
    qualificationPath,
    trialPath,
    qualificationReportPath = qualificationPath,
    trialReportPath = trialPath,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    workspaceId,
  } = options;
  if (!isBoundedString(generationId)) invalid('activation plan', 'generationId is missing');
  if (!isBoundedString(buildId)) invalid('activation plan', 'buildId is missing');
  if (!isBoundedString(workspaceId)) invalid('activation plan', 'workspaceId is missing');
  if (!isGitHead(sourceHead)) invalid('activation plan', 'sourceHead must be a 40-character Git hash');
  if (!isSha256(sourceFingerprint)) invalid('activation plan', 'sourceFingerprint must be a lowercase sha256');

  const qualification = readBoundedJsonFile(qualificationPath, 'qualification report');
  const qualificationEvidence = validateQualificationReport(
    qualification.value,
    { buildId, sourceHead, sourceFingerprint },
    qualificationReportPath,
    qualification.sha256,
    { requireQualification, provisional },
  );
  if (recompute) {
    if (qualification.value.kind === OVERALL_QUALIFICATION_KIND) {
      const validation = validateOverallQualificationRecomputation(qualification.value, {
        buildId,
        sourceHead,
        sourceFingerprint,
      });
      const accepted = provisional
        ? validation.valid && (validation.qualified || validation.provisional?.qualified === true)
        : validation.valid && validation.qualified;
      if (!accepted) {
        invalid('qualification report', validation.errors.length > 0
          ? validation.errors.join('; ')
          : provisional
            ? 'overall evidence does not qualify, fully or under the approved provisional envelope'
            : 'overall evidence does not qualify');
      }
    } else {
      const recomputationErrors = recomputeQualificationGates(qualification.value);
      if (recomputationErrors.length > 0) invalid('qualification report', recomputationErrors.join('; '));
    }
  }
  const trial = readBoundedJsonFile(trialPath, 'candidate trial report');
  const expectedBindings = {
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    workspaceId,
    qualificationSha256: qualification.sha256,
  };
  const trialEvidence = validateCandidateTrialReport(
    trial.value,
    expectedBindings,
    trialReportPath,
    trial.sha256,
  );
  if (recompute) {
    // Strictly after the P0 gate recomputation: re-open the exact emitted
    // runner/worker artifacts before deterministically checking their receipts.
    validateCandidateTrialArtifactFiles(trial.value, expectedBindings);
    const trialRecomputationErrors = recomputeCandidateTrialChecks(trial.value, expectedBindings);
    if (trialRecomputationErrors.length > 0) {
      invalid('candidate trial report', trialRecomputationErrors.join('; '));
    }
  }
  return {
    qualificationSha256: qualificationEvidence.reportHash,
    trialSha256: trialEvidence.reportHash,
    sourceHead: qualificationEvidence.sourceHead,
    sourceFingerprint: qualificationEvidence.sourceFingerprint,
    buildId: qualificationEvidence.buildId,
    scenario: qualificationEvidence.scenario,
    trialId: trialEvidence.trialId,
    qualificationState: qualification.value.qualification.overallP0,
    provisionalP0: qualification.value.qualification.provisionalP0 ?? null,
    qualificationMode: qualification.value.qualification.overallP0 === 'qualified'
      ? 'qualified'
      : qualification.value.qualification.provisionalP0 === 'provisional-qualified' ? 'provisional' : null,
  };
}

/** Validate the exact bounded shapes without opening the live qualification
 * gate.  This is the only path intended for synthetic unit fixtures. */
export function validateActivationEvidenceStructure(options) {
  return readAndValidateActivationEvidence(options, { requireQualification: false, recompute: false, provisional: options.provisional === true });
}

/** Read-only admission inspection for DRY-RUN/PREFLIGHT callers. It returns
 * every blocker that can be established without changing the activation
 * manifest, lifecycle registry, runtime leases, or host processes. */
export function inspectActivationEvidence(options) {
  const blockers = [];
  let structure;
  try {
    structure = validateActivationEvidenceStructure(options);
    const provisionalAccepted = options.provisional === true
      && (structure.qualificationState === 'qualified' || structure.provisionalP0 === 'provisional-qualified');
    if (structure.qualificationState !== 'qualified' && !provisionalAccepted) {
      blockers.push(`P0 qualification is ${structure.qualificationState ?? 'missing'}; overallP0 must be qualified`);
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    admitActivationEvidence(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!blockers.includes(message)) blockers.push(message);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    evidence: structure ?? null,
    candidateTrialValidatorAvailable: CANDIDATE_TRIAL_VALIDATOR_AVAILABLE,
  };
}

/**
 * Read, hash, and validate both activation inputs.  This function has no
 * manifest/store dependency and must complete before the helper calls any
 * activation mutation.  The returned hashes are the exact bytes validated. */
export function admitActivationEvidence({
  qualificationPath,
  trialPath,
  qualificationReportPath = qualificationPath,
  trialReportPath = trialPath,
  generationId,
  buildId,
  sourceHead,
  sourceFingerprint,
  workspaceId,
  provisional = false,
}) {
  const evidence = readAndValidateActivationEvidence({
    qualificationPath,
    trialPath,
    qualificationReportPath,
    trialReportPath,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    workspaceId,
  }, { requireQualification: true, recompute: true, provisional: provisional === true });
  if (!CANDIDATE_TRIAL_VALIDATOR_AVAILABLE) {
    invalid('candidate trial report', 'no authoritative candidate-trial producer/validator exists yet');
  }
  return evidence;
}
