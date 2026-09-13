import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { validateCapacityCalibration } from '../extension/scripts/analytics-p0-capacity.mjs';

/**
 * The P0 producer currently emits schema 5.  A scenario-passed report is only
 * evidence for that scenario; it is not the overall qualification needed by
 * activation.  The producer must eventually emit `overallP0: qualified` after
 * every required gate has been exercised.
 */
export const QUALIFICATION_REPORT_SCHEMA_VERSION = 5;

/** Candidate-trial handoff envelope.  There is no producer in-tree yet; keep
 * this boundary strict so a scratch rehearsal cannot be mistaken for one. */
export const CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION = 1;
export const CANDIDATE_TRIAL_REPORT_KIND = 'pie-p7a-candidate-trial-v1';
/** The repository has no candidate-trial producer/owning validator yet.  Keep
 * structural rehearsal validation available for tests, but never treat a
 * hand-written envelope as live activation evidence. */
export const CANDIDATE_TRIAL_VALIDATOR_AVAILABLE = false;

/** Reports contain timing samples, but must remain a bounded handoff input. */
export const MAX_ACTIVATION_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** These are the current P0 gate names, including gates the bounded harness
 * records as explicitly unqualified.  A complete qualification must pass all. */
export const REQUIRED_QUALIFICATION_GATES = Object.freeze([
  'exactPrimaryRows',
  'exactDetailRows',
  'handoffP99',
  'responsivenessProxyP95',
  'indexedQuery',
  'largeDetailQuery',
  'temporaryFootprint',
  'inPlaceCorruption',
  'capacityCalibration',
  'reservedFreeDisk',
  'recorderWorkerRss',
  'scaleHistoryRows',
  'tenMillionHistory',
  'enduranceLightLoad',
  'enduranceSustainedLoad',
  'enduranceWorkerMemory',
  'mixedLoad',
  'schemaV2AndFaults',
  'matchedAgentUi',
  'incrementalHostMemory',
  'queryPeakMemory',
  'rateConditions',
]);

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
  { requireQualification = true } = {},
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
  if (!['baseline', 'scale'].includes(configuration.scenario)) invalid(label, 'configuration.scenario is invalid');
  const expectedRows = configuration.scenario === 'baseline' ? 10_000 : 1_000_000;
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
  if (!isObject(provenance.files) || Object.keys(provenance.files).length === 0) {
    invalid(label, 'provenance.files is missing');
  }
  for (const [file, evidence] of Object.entries(provenance.files)) {
    if (!isObject(evidence) || !isSha256(evidence.sha256)
      || !Number.isSafeInteger(evidence.bytes) || evidence.bytes <= 0) {
      invalid(label, `provenance.files[${file}] is incomplete`);
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
  // This distinction is the critical fail-closed rule: a successful bounded
  // scenario remains unqualified until every P0 follow-on has passed.
  if (qualification.decision !== 'scenario-passed') invalid(label, 'qualification decision is not scenario-passed');
  if (requireQualification && qualification.overallP0 !== 'qualified') {
    invalid(label, 'overallP0 is not qualified');
  }
  if (!Array.isArray(qualification.failedGates) || qualification.failedGates.length !== 0) {
    invalid(label, 'qualification.failedGates is not empty');
  }
  if (!isObject(report.gates)) invalid(label, 'gates are missing');
  for (const gateName of REQUIRED_QUALIFICATION_GATES) {
    const gate = report.gates[gateName];
    if (!isObject(gate)) {
      invalid(label, `required gate ${gateName} is not passed with evidence`);
    }
    if (requireQualification && (gate.decision !== 'passed' || gate.actual === null || gate.actual === undefined
      || gate.threshold === null || gate.threshold === undefined)) {
      invalid(label, `required gate ${gateName} is not passed with evidence`);
    }
  }
  if (requireQualification) {
    for (const [gateName, gate] of Object.entries(report.gates)) {
      if (!isObject(gate) || gate.decision !== 'passed') invalid(label, `gate ${gateName} is not passed`);
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

function validateCandidateTrialReport(report, expected, reportPath, reportHash) {
  const label = 'candidate trial report';
  if (!isObject(report)) invalid(label, 'top level must be an object');
  if (report.schemaVersion !== CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION) {
    invalid(label, `schemaVersion must be ${CANDIDATE_TRIAL_REPORT_SCHEMA_VERSION}`);
  }
  if (report.kind !== CANDIDATE_TRIAL_REPORT_KIND) invalid(label, 'kind is not the activation trial envelope');
  if (report.status !== 'passed') invalid(label, 'status must be passed');
  if (!isBoundedString(report.reportPath) || !samePath(report.reportPath, reportPath)) {
    invalid(label, 'reportPath does not identify the supplied bytes');
  }
  if (!isIsoInstant(report.generatedAt) || !isIsoInstant(report.finishedAt)) {
    invalid(label, 'generatedAt/finishedAt must be canonical ISO instants');
  }

  const bindings = report.bindings;
  if (!isObject(bindings) || !isBoundedString(bindings.trialId)) invalid(label, 'bindings.trialId is missing');
  if (bindings.generationId !== expected.generationId) invalid(label, 'generationId binding mismatches the plan');
  if (bindings.buildId !== expected.buildId) invalid(label, 'buildId binding mismatches the plan');
  if (!isGitHead(bindings.sourceHead) || bindings.sourceHead.toLowerCase() !== expected.sourceHead.toLowerCase()) {
    invalid(label, 'sourceHead binding mismatches the plan');
  }
  if (bindings.sourceFingerprint !== expected.sourceFingerprint) {
    invalid(label, 'sourceFingerprint binding mismatches the plan');
  }
  if (bindings.qualificationSha256 !== expected.qualificationSha256) {
    invalid(label, 'qualificationSha256 binding mismatches the qualification bytes');
  }

  if (!isObject(report.checks)) invalid(label, 'checks are missing');
  for (const checkName of REQUIRED_CANDIDATE_TRIAL_CHECKS) {
    const check = report.checks[checkName];
    if (!isObject(check) || check.decision !== 'passed' || !isObject(check.evidence)
      || Object.keys(check.evidence).length === 0) {
      invalid(label, `required check ${checkName} is incomplete`);
    }
  }
  for (const [checkName, check] of Object.entries(report.checks)) {
    if (!isObject(check) || check.decision !== 'passed') invalid(label, `check ${checkName} is not passed`);
  }
  if (!isObject(report.cleanup) || report.cleanup.completed !== true || report.cleanup.rootRemoved !== true) {
    invalid(label, 'cleanup is incomplete');
  }

  return { reportHash, trialId: bindings.trialId };
}

function readAndValidateActivationEvidence(options, { requireQualification, recompute }) {
  const {
    qualificationPath,
    trialPath,
    qualificationReportPath = qualificationPath,
    trialReportPath = trialPath,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
  } = options;
  if (!isBoundedString(generationId)) invalid('activation plan', 'generationId is missing');
  if (!isBoundedString(buildId)) invalid('activation plan', 'buildId is missing');
  if (!isGitHead(sourceHead)) invalid('activation plan', 'sourceHead must be a 40-character Git hash');
  if (!isSha256(sourceFingerprint)) invalid('activation plan', 'sourceFingerprint must be a lowercase sha256');

  const qualification = readBoundedJsonFile(qualificationPath, 'qualification report');
  const qualificationEvidence = validateQualificationReport(
    qualification.value,
    { buildId, sourceHead, sourceFingerprint },
    qualificationReportPath,
    qualification.sha256,
    { requireQualification },
  );
  if (recompute) {
    const recomputationErrors = recomputeQualificationGates(qualification.value);
    if (recomputationErrors.length > 0) invalid('qualification report', recomputationErrors.join('; '));
  }
  const trial = readBoundedJsonFile(trialPath, 'candidate trial report');
  const trialEvidence = validateCandidateTrialReport(
    trial.value,
    {
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      qualificationSha256: qualification.sha256,
    },
    trialReportPath,
    trial.sha256,
  );
  return {
    qualificationSha256: qualificationEvidence.reportHash,
    trialSha256: trialEvidence.reportHash,
    sourceHead: qualificationEvidence.sourceHead,
    sourceFingerprint: qualificationEvidence.sourceFingerprint,
    buildId: qualificationEvidence.buildId,
    scenario: qualificationEvidence.scenario,
    trialId: trialEvidence.trialId,
    qualificationState: qualification.value.qualification.overallP0,
  };
}

/** Validate the exact bounded shapes without opening the live qualification
 * gate.  This is the only path intended for synthetic unit fixtures. */
export function validateActivationEvidenceStructure(options) {
  return readAndValidateActivationEvidence(options, { requireQualification: false, recompute: false });
}

/** Read-only admission inspection for DRY-RUN/PREFLIGHT callers. It returns
 * every blocker that can be established without changing the activation
 * manifest, lifecycle registry, runtime leases, or host processes. */
export function inspectActivationEvidence(options) {
  const blockers = [];
  let structure;
  try {
    structure = validateActivationEvidenceStructure(options);
    if (structure.qualificationState !== 'qualified') {
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
  }, { requireQualification: true, recompute: true });
  if (!CANDIDATE_TRIAL_VALIDATOR_AVAILABLE) {
    invalid('candidate trial report', 'no authoritative candidate-trial producer/validator exists yet');
  }
  return evidence;
}
