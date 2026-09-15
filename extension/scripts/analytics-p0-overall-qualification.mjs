#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateCapacityCalibration } from './analytics-p0-capacity.mjs';
import { validateEnduranceTrials } from './analytics-p0-endurance-validation.mjs';
import { validateMixedEvidence } from './analytics-p0-mixed-validation.mjs';

export const OVERALL_QUALIFICATION_KIND = 'pie-p0-overall-qualification-v1';
export const OVERALL_QUALIFICATION_HARNESS_VERSION = 'p0-overall-v1';
export const OVERALL_QUALIFICATION_SCHEMA_VERSION = 5;
export const MAX_QUALIFICATION_EVIDENCE_BYTES = 8 * 1024 * 1024;

export const OVERALL_EVIDENCE_ROLES = Object.freeze([
  'baseline',
  'scale',
  'tenMillion',
  'endurance',
  'mixedFullStats',
  'mixedMemoryOnly',
  'schemaFaults',
  'matchedHost',
]);

/** These are admission gates, not scenario-success labels. Every gate below
 * has a recomputation from raw, hash-bound report evidence.
 *
 * The required history envelope is the recorded user decision (2026-09-15):
 * the executed 10,000-row baseline and 1,000,000-row scale tiers. The
 * ten-million history tier is deferred, not removed: see
 * DEFERRED_OVERALL_QUALIFICATION_GATES. */
export const REQUIRED_OVERALL_QUALIFICATION_GATES = Object.freeze([
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
  'enduranceLightLoad',
  'enduranceSustainedLoad',
  'enduranceWorkerMemory',
  'mixedLoad',
  'mixedWorkerMemory',
  'schemaV2AndFaults',
  'matchedAgentUi',
  'incrementalHostMemory',
  'queryPeakMemory',
  'rateConditions',
  'realProducerBoundary',
]);

/** The recorded selected qualification envelope: executed baseline (10k) and
 * scale (1M) history tiers are required; the ten-million tier is deferred.
 * Overall reports must carry this object unchanged, so an edited envelope
 * fails recomputation. */
export const SELECTED_P0_HISTORY_ENVELOPE = Object.freeze({
  requiredHistoryTiers: Object.freeze(['baseline-10000', 'scale-1000000']),
  deferredHistoryTiers: Object.freeze(['tenMillion-10000000']),
});

/** Deferred gates stay recomputable and honest. A deferred gate may remain
 * explicitly unqualified when its tier was not executed and the bound scale
 * evidence shows the measured capacity reason, but it is never 'passed' by a
 * skip, and a 'failed' deferred gate blocks overall qualification like any
 * other gate. */
export const DEFERRED_OVERALL_QUALIFICATION_GATES = Object.freeze(['tenMillionHistory']);

/** Every recomputed overall gate: the required admission gates plus the
 * deferred ones. */
export const OVERALL_QUALIFICATION_GATE_NAMES = Object.freeze([
  ...REQUIRED_OVERALL_QUALIFICATION_GATES,
  ...DEFERRED_OVERALL_QUALIFICATION_GATES,
]);

/** Approved provisional-cutover measurement exceptions (user decision,
 * 2026-09-16): exactly these measurement gates may stay honestly failed or
 * unqualified in a PROVISIONALLY qualified overall report. Their measured
 * outcomes are never rewritten to 'passed', and any other failed or
 * unqualified required gate still blocks provisional qualification.
 * realProducerBoundary is NOT in this list: only its latency predicates
 * (handoffMs, rejectionHandoffMs) are excepted, while its privacy,
 * non-waiting, mutation-retention, failover and nested-depth correctness
 * fields remain mandatory. */
export const PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS = Object.freeze([
  'recorderWorkerRss',
  'mixedWorkerMemory',
  'queryPeakMemory',
  'matchedAgentUi',
  'incrementalHostMemory',
]);

/** The exact, frozen provisional envelope. An overall report claiming a
 * provisional decision must carry this object byte-identically (sameJson), so
 * an edited exception set fails recomputation and admission. */
export const PROVISIONAL_QUALIFICATION_ENVELOPE = Object.freeze({
  schemaVersion: 1,
  kind: 'pie-p0-provisional-envelope-v1',
  measurementExceptions: PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS,
  realProducerBoundary: 'latency-only',
  deferredHistoryTiers: DEFERRED_OVERALL_QUALIFICATION_GATES,
});

const PROVISIONAL_REAL_PRODUCER_BOUNDARY_CORRECTNESS = (value) =>
  value?.status === 'submitted' && value?.nestedDepth >= 2
  && value?.failoverAttemptsRetained >= 2 && value?.cancellationOrCapacityStatus === 'rejected'
  && value?.delayedAcknowledgementDidNotGate === true
  && value?.mutationAfterHandoffDidNotAlterCapture === true
  && value?.credentialFilteredBeforeSerialization === true
  && Number.isFinite(value?.handoffMs) && Number.isFinite(value?.rejectionHandoffMs);

const ROLE_SCENARIOS = Object.freeze({
  baseline: ['baseline'],
  scale: ['scale'],
  tenMillion: ['ten-million'],
  endurance: ['endurance'],
  mixedFullStats: ['mixed'],
  mixedMemoryOnly: ['mixed'],
  schemaFaults: ['schema-faults'],
  matchedHost: ['matched-host'],
});

const ROLE_REQUIRED_SOURCE_FILE = Object.freeze({
  schemaFaults: 'extension/scripts/analytics-p0-schema-faults.mjs',
  matchedHost: 'extension/scripts/analytics-p0-matched-host.mjs',
});

const ROLE_REQUIRED_KIND = Object.freeze({
  schemaFaults: 'pie-p0-schema-faults-v1',
  matchedHost: 'pie-p0-matched-host-v1',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isGitHead(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

function boundedString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function safeNonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function computeQualificationSourceFingerprint({ gitHead, hostBuildId, rendererBuildId, files }) {
  if (!isGitHead(gitHead) || !boundedString(hostBuildId) || hostBuildId !== rendererBuildId
    || !isObject(files) || Object.keys(files).length === 0) {
    throw new Error('qualification source manifest is incomplete');
  }
  const hashes = {};
  for (const [file, receipt] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!boundedString(file) || path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')
      || !isObject(receipt) || !isSha256(receipt.sha256)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) {
      throw new Error(`qualification source manifest entry is invalid: ${file}`);
    }
    hashes[file] = receipt.sha256;
  }
  return sha256(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    gitHead,
    hostBuildId,
    rendererBuildId,
    files: hashes,
  })));
}

function computeLegacyScenarioFingerprint(report) {
  const provenance = report.provenance;
  if (!boundedString(report.harnessVersion) || !isObject(provenance?.files)) return null;
  return sha256(Buffer.from(JSON.stringify({
    harnessVersion: report.harnessVersion,
    gitHead: provenance.gitHead,
    hostBuildId: provenance.hostBuildId,
    rendererBuildId: provenance.rendererBuildId,
    files: Object.fromEntries(Object.entries(provenance.files)
      .map(([name, receipt]) => [name, receipt?.sha256 ?? null])),
  })));
}

/** Read and hash exact evidence bytes under the same 8 MiB per-file bound as
 * activation admission. The descriptor in the overall report is checked
 * against these bytes again at admission time. */
export function readOverallEvidenceFile(filePath, label = 'qualification evidence') {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label}: path must be absolute`);
  }
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`${label}: path is not a regular file`);
    if (!Number.isSafeInteger(before.size) || before.size > MAX_QUALIFICATION_EVIDENCE_BYTES) {
      throw new Error(`${label}: file exceeds the ${MAX_QUALIFICATION_EVIDENCE_BYTES}-byte bound`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error(`${label}: file ended before its declared size`);
      offset += count;
    }
    if (fstatSync(fd).size !== before.size) throw new Error(`${label}: file changed while it was being read`);
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`${label}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { bytes: before.size, sha256: sha256(bytes), value };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function evidenceFor(roles, loaded) {
  return {
    reports: roles.flatMap((role) => {
      const entry = loaded.get(role);
      return entry ? [{ role, sha256: entry.sha256 }] : [];
    }),
  };
}

function gate(actual, threshold, passed, roles, loaded, reason) {
  if (passed === null) {
    return { actual: null, threshold, decision: 'unqualified', reason, evidence: evidenceFor(roles, loaded) };
  }
  return {
    actual,
    threshold,
    decision: passed ? 'passed' : 'failed',
    evidence: evidenceFor(roles, loaded),
    ...(passed ? {} : { reason }),
  };
}

function missingGate(threshold, roles, loaded) {
  const missing = roles.filter((role) => !loaded.has(role));
  return gate(null, threshold, null, roles, loaded, `missing required evidence: ${missing.join(', ')}`);
}

function reportGate(threshold, roles, loaded, evaluate) {
  if (roles.some((role) => !loaded.has(role))) return missingGate(threshold, roles, loaded);
  try {
    const result = evaluate(Object.fromEntries(roles.map((role) => [role, loaded.get(role).report])));
    return gate(result.actual, threshold, result.passed, roles, loaded, result.reason ?? 'owning predicate failed');
  } catch (error) {
    return gate(null, threshold, false, roles, loaded, error instanceof Error ? error.message : String(error));
  }
}

function validateComponentEnvelope(role, report, descriptor, expected, provisionalExceptions) {
  const errors = [];
  if (!isObject(report)) return [`${role}: top level must be an object`];
  if (report.schemaVersion !== OVERALL_QUALIFICATION_SCHEMA_VERSION) errors.push(`${role}: schemaVersion must be 5`);
  const qualification = report.qualification;
  const failedGates = Array.isArray(qualification?.failedGates) ? qualification.failedGates : null;
  if (Array.isArray(provisionalExceptions) && failedGates && failedGates.length > 0
    && failedGates.every((name) => provisionalExceptions.includes(name))) {
    // Provisional envelope: a component report whose ONLY failed gates are
    // approved measurement exceptions still binds as evidence. Its failed
    // status stays honest; the raw results behind the OTHER gates remain the
    // recomputation source. Any failed correctness, privacy, deletion,
    // identity, cleanup or non-exception gate still rejects the binding.
    if (report.status !== 'failed') errors.push(`${role}: provisionally bound scenario report must record status failed`);
    if (qualification?.decision !== 'scenario-failed' || qualification?.overallP0 !== 'unqualified') {
      errors.push(`${role}: provisionally bound scenario report must record an honest scenario-failed, unqualified decision`);
    }
  } else {
    if (report.status !== 'passed') errors.push(`${role}: status must be passed`);
    if (qualification?.decision !== 'scenario-passed' || qualification?.overallP0 !== 'unqualified'
      || !failedGates || failedGates.length !== 0) {
      errors.push(`${role}: scenario qualification is not a clean scenario-passed result`);
    }
  }
  if (!isObject(report.configuration) || !ROLE_SCENARIOS[role]?.includes(report.configuration.scenario)) {
    errors.push(`${role}: configuration.scenario is invalid`);
  }
  if (!samePath(report.configuration?.reportPath, descriptor.path)) errors.push(`${role}: configuration.reportPath mismatches the evidence path`);
  if (report.measurement?.completed !== true) errors.push(`${role}: measurement is incomplete`);
  if (report.cleanup?.completed !== true || report.cleanup?.rootRemoved !== true) errors.push(`${role}: cleanup is incomplete`);
  const provenance = report.provenance;
  if (provenance?.valid !== true) errors.push(`${role}: provenance is not valid`);
  if (!isGitHead(provenance?.gitHead) || provenance.gitHead.toLowerCase() !== expected.sourceHead.toLowerCase()) {
    errors.push(`${role}: source head mismatches the overall binding`);
  }
  if (provenance?.coordinatedBuildId !== expected.buildId
    || provenance?.hostBuildId !== expected.buildId || provenance?.rendererBuildId !== expected.buildId) {
    errors.push(`${role}: coordinated host/renderer build IDs mismatch the overall binding`);
  }
  let recomputedFingerprint;
  try {
    recomputedFingerprint = computeQualificationSourceFingerprint(provenance ?? {});
  } catch (error) {
    errors.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Reports produced before the aggregate existed included their scenario
  // harnessVersion in provenance.fingerprint. Accept that claimed fingerprint
  // only when it recomputes exactly, while binding aggregation/admission to the
  // scenario-independent source manifest fingerprint.
  const legacyFingerprint = computeLegacyScenarioFingerprint(report);
  const claimedFingerprintValid = isSha256(provenance?.fingerprint)
    && (provenance.fingerprint === recomputedFingerprint || provenance.fingerprint === legacyFingerprint);
  if (!claimedFingerprintValid || recomputedFingerprint !== expected.sourceFingerprint) {
    errors.push(`${role}: source fingerprint mismatches the recomputed source manifest and overall binding`);
  }
  const requiredSourceFile = ROLE_REQUIRED_SOURCE_FILE[role];
  if (requiredSourceFile && !isSha256(provenance?.files?.[requiredSourceFile]?.sha256)) {
    errors.push(`${role}: authoritative producer is absent from the source manifest (${requiredSourceFile})`);
  }
  const requiredKind = ROLE_REQUIRED_KIND[role];
  if (requiredKind && report.kind !== requiredKind) errors.push(`${role}: report kind must be ${requiredKind}`);
  if (role === 'baseline' && report.configuration?.rows !== 10_000) errors.push('baseline: rows must be 10000');
  if (role === 'scale' && report.configuration?.rows !== 1_000_000) errors.push('scale: rows must be 1000000');
  if (role === 'tenMillion' && report.configuration?.rows !== 10_000_000) errors.push('tenMillion: rows must be 10000000');
  if (role === 'endurance' && (report.configuration?.mode !== 'full' || report.results?.endurance?.mode !== 'full')) {
    errors.push('endurance: full mode is required');
  }
  if (role === 'mixedFullStats' && (report.configuration?.mode !== 'full' || report.configuration?.statsPollMode !== 'full-stats')) {
    errors.push('mixedFullStats: full mode with full-stats polling is required');
  }
  if (role === 'mixedMemoryOnly' && (report.configuration?.mode !== 'full' || report.configuration?.statsPollMode !== 'memory-only')) {
    errors.push('mixedMemoryOnly: full mode with memory-only polling is required');
  }
  return errors;
}

function loadEvidence(report, expected) {
  const errors = [];
  const loaded = new Map();
  const descriptors = report.evidence?.reports;
  if (!isObject(descriptors)) return { loaded, errors: ['overall evidence.reports is missing'] };
  for (const role of OVERALL_EVIDENCE_ROLES) {
    const descriptor = descriptors[role];
    if (descriptor === undefined) continue;
    if (!isObject(descriptor) || !boundedString(descriptor.path) || !path.isAbsolute(descriptor.path)
      || !isSha256(descriptor.sha256) || !safeNonNegative(descriptor.bytes)) {
      errors.push(`${role}: evidence descriptor is malformed`);
      continue;
    }
    try {
      const read = readOverallEvidenceFile(descriptor.path, `${role} report`);
      if (read.sha256 !== descriptor.sha256 || read.bytes !== descriptor.bytes) {
        errors.push(`${role}: evidence bytes do not match the overall manifest`);
        continue;
      }
      // The provisional component-binding relaxation is only active when the
      // aggregate itself declares the exact approved provisional envelope.
      const provisionalClaim = sameJson(report.qualification?.provisionalEnvelope, PROVISIONAL_QUALIFICATION_ENVELOPE)
        ? PROVISIONAL_QUALIFICATION_ENVELOPE.measurementExceptions : null;
      const envelopeErrors = validateComponentEnvelope(role, read.value, descriptor, expected, provisionalClaim);
      if (envelopeErrors.length > 0) {
        errors.push(...envelopeErrors);
        continue;
      }
      loaded.set(role, { ...read, report: read.value, descriptor });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const role of Object.keys(descriptors)) {
    if (!OVERALL_EVIDENCE_ROLES.includes(role)) errors.push(`unknown overall evidence role ${role}`);
  }
  return { loaded, errors };
}

const TEN_MILLION_HISTORY_THRESHOLD = 'exactly 10,000,000 primary rows; a projection or skip is not a pass';

/** Recompute the deferred ten-million history gate. When the ten-million role
 * is bound, the gate passes only for an executed, exactly-10,000,000-row
 * workload. When it is not bound, the deferral is accepted only if the bound
 * scale report's own measured projection exceeds both predeclared temporary
 * bounds; otherwise the deferral is unjustified and the gate fails. An
 * unexecuted tier is never marked passed. */
function tenMillionHistoryGate(loaded) {
  if (loaded.has('tenMillion')) {
    return reportGate(TEN_MILLION_HISTORY_THRESHOLD, ['tenMillion'], loaded, ({ tenMillion }) => ({
      actual: tenMillion.results?.tableRows?.primaryFacts,
      passed: tenMillion.results?.tableRows?.primaryFacts === 10_000_000
        && tenMillion.results?.largeTierDecision?.tenMillionExecuted === true,
    }));
  }
  const scale = loaded.get('scale')?.report;
  if (!scale) {
    return gate(null, TEN_MILLION_HISTORY_THRESHOLD, null, ['scale'], loaded,
      'missing required evidence: scale; the measured capacity deferral of the ten-million tier cannot be justified');
  }
  const decision = scale.results?.largeTierDecision;
  const measuredRows = decision?.measuredRows;
  const bytesPerFact = decision?.measuredBytesPerPrimaryFact;
  const estimated = decision?.estimatedTenMillionBytes;
  const limitBytes = scale.matrix?.bounds?.effectiveTemporaryLimitBytes;
  const capBytes = scale.matrix?.bounds?.maxTemporaryBytes;
  const justified = decision?.tenMillionExecuted === false
    && measuredRows === 1_000_000
    && finiteNonNegative(bytesPerFact) && bytesPerFact > 0
    && finiteNonNegative(estimated) && finiteNonNegative(limitBytes) && finiteNonNegative(capBytes)
    && estimated > limitBytes && estimated > capBytes;
  const actual = {
    measuredRows: measuredRows === 1_000_000 ? measuredRows : null,
    measuredBytesPerPrimaryFact: finiteNonNegative(bytesPerFact) ? bytesPerFact : null,
    estimatedTenMillionBytes: finiteNonNegative(estimated) ? estimated : null,
    temporaryLimitBytes: finiteNonNegative(limitBytes) ? limitBytes : null,
    temporaryCapBytes: finiteNonNegative(capBytes) ? capBytes : null,
    tenMillionExecuted: decision?.tenMillionExecuted === false ? false : null,
  };
  if (!justified) {
    return gate(actual, TEN_MILLION_HISTORY_THRESHOLD, false, ['scale'], loaded,
      'the bound scale report does not show a measured ten-million projection above both predeclared temporary bounds; the deferral is unjustified and the ten-million tier is required');
  }
  return gate(actual, TEN_MILLION_HISTORY_THRESHOLD, null, ['scale'], loaded,
    `deferred unqualified: measured ${bytesPerFact} bytes per primary fact at ${measuredRows} rows projects ${estimated} bytes for 10,000,000 facts, above the predeclared ${capBytes}-byte temporary-data cap (effective limit ${limitBytes} bytes); the tier was not executed and stays unqualified`);
}

function maxOf(values) {
  return values.length > 0 && values.every(finiteNonNegative) ? Math.max(...values) : Number.NaN;
}

function resourceValue(report, field, aggregate) {
  const samples = report.results?.resourceEnvelope?.samples;
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every((sample) => finiteNonNegative(sample?.[field]))) return Number.NaN;
  return aggregate(...samples.map((sample) => sample[field]));
}

function evaluateRateConditions(scale) {
  const values = scale.results?.rateConditions;
  const wanted = new Map([[1, 5_000], [2, 5_000], [4, 5_000]]);
  if (!Array.isArray(values) || values.length !== wanted.size) return { actual: null, passed: false };
  const actual = {};
  let passed = true;
  for (const condition of values) {
    const expectedCount = wanted.get(condition?.hostCount);
    const derivedRate = finiteNonNegative(condition?.submissionElapsedMs) && condition.submissionElapsedMs > 0
      ? condition.sampleCount / (condition.submissionElapsedMs / 1_000) : Number.NaN;
    const withinRate = Number.isFinite(derivedRate) && Math.abs(derivedRate - 1_000) / 1_000 <= 0.02;
    const complete = expectedCount === condition?.sampleCount && condition?.ratePerSecond === 1_000
      && condition?.acceptedSampleCount === condition.sampleCount
      && condition?.endingBacklogRecords === 0 && condition?.endingBacklogBytes === 0
      && condition?.handoff?.p99Ms <= 9 && withinRate;
    actual[String(condition?.hostCount)] = {
      sampleCount: condition?.sampleCount,
      acceptedSampleCount: condition?.acceptedSampleCount,
      derivedOfferedRatePerSecond: derivedRate,
      endingBacklogRecords: condition?.endingBacklogRecords,
      handoffP99Ms: condition?.handoff?.p99Ms,
    };
    passed &&= complete;
    wanted.delete(condition?.hostCount);
  }
  return { actual, passed: passed && wanted.size === 0 };
}

function evaluateSchemaFaults(report) {
  const value = report.results?.schemaFaults;
  const upgrade = value?.upgrade;
  const partial = value?.partialWrite;
  const corruption = value?.corruption;
  const numericReceipts = [
    upgrade?.fromVersion, upgrade?.toVersion,
    upgrade?.retainedFactsBefore, upgrade?.retainedFactsAfter,
    upgrade?.retainedDetailsBefore, upgrade?.retainedDetailsAfter,
    upgrade?.deletionMarkersBefore, upgrade?.deletionMarkersAfter,
    upgrade?.projectionRevisionBefore, upgrade?.projectionRevisionAfter,
    partial?.expectedRowsAfterReplay, partial?.actualRowsAfterReplay,
  ];
  const passed = numericReceipts.every(safeNonNegative)
    && upgrade.fromVersion === 2 && upgrade.toVersion >= 13
    && upgrade.retainedFactsBefore > 0 && upgrade.retainedDetailsBefore > 0
    && upgrade.deletionMarkersBefore > 0 && partial.expectedRowsAfterReplay > 0
    && upgrade.retainedFactsBefore === upgrade.retainedFactsAfter
    && upgrade.retainedDetailsBefore === upgrade.retainedDetailsAfter
    && upgrade.deletionMarkersBefore === upgrade.deletionMarkersAfter
    && upgrade.projectionRevisionAfter >= upgrade.projectionRevisionBefore
    && upgrade.postUpgradeCaptureAccepted === true && upgrade.deletedSubjectRejected === true
    && partial?.firstSubjectCommitted === true && partial?.secondSubjectRejected === true
    && partial?.replayCompleted === true && partial?.duplicateReplayNoOp === true
    && partial?.expectedRowsAfterReplay === partial?.actualRowsAfterReplay
    && corruption?.recorderRejected === true && corruption?.queryRejected === true
    && corruption?.workersTerminal === true;
  return { actual: value ?? null, passed };
}

function evaluateMatchedHost(report) {
  const value = report.results?.matchedHost;
  const disabled = value?.disabled;
  const enabled = value?.enabled;
  const metricNames = ['agentTurnaroundP95Ms', 'cancellationP95Ms', 'failoverP95Ms', 'uiInteractionP95Ms', 'streamPaintP95Ms'];
  const matchedCounts = safeNonNegative(disabled?.sampleCount) && disabled.sampleCount >= 10
    && enabled?.sampleCount === disabled.sampleCount;
  const noRegression = metricNames.every((name) => finiteNonNegative(disabled?.[name])
    && finiteNonNegative(enabled?.[name]) && enabled[name] <= disabled[name]);
  const freshness = enabled?.localSummaryFreshnessP95Ms <= 250
    && enabled?.localSummaryFreshnessP99Ms <= 500
    && enabled?.crossHostSummaryFreshnessMs <= 1_000;
  const cpu = enabled?.idleAnalyticsCpuOneCorePercent < 0.5
    && enabled?.activeCaptureCpuOneCorePercent - disabled?.activeCaptureCpuOneCorePercent <= 10;
  return {
    actual: { matchedCounts, noRegression, freshness, cpu },
    passed: matchedCounts && noRegression && freshness && cpu
      && value?.sameWorkload === true && value?.sameHostBuildConfig === true,
  };
}

/** Re-open every hash-bound component report and recompute the complete P0
 * gate table. Scenario gate booleans are never used as the source of truth. */
export function recomputeOverallQualification(report, expected) {
  const errors = [];
  if (!isObject(report) || report.kind !== OVERALL_QUALIFICATION_KIND
    || report.schemaVersion !== OVERALL_QUALIFICATION_SCHEMA_VERSION
    || report.configuration?.scenario !== 'overall') {
    return {
      qualified: false, gates: {}, errors: ['not a schema-5 overall P0 qualification report'],
      provisional: { qualified: false, exceptions: [], otherOpenGates: [...REQUIRED_OVERALL_QUALIFICATION_GATES], realProducerBoundaryLatencyOnly: false },
    };
  }
  const bindings = {
    sourceHead: expected?.sourceHead ?? report.provenance?.gitHead,
    buildId: expected?.buildId ?? report.provenance?.coordinatedBuildId,
    sourceFingerprint: expected?.sourceFingerprint ?? report.provenance?.fingerprint,
  };
  if (!isGitHead(bindings.sourceHead) || !boundedString(bindings.buildId) || !isSha256(bindings.sourceFingerprint)) {
    return {
      qualified: false, gates: {}, errors: ['overall qualification bindings are incomplete'],
      provisional: { qualified: false, exceptions: [], otherOpenGates: [...REQUIRED_OVERALL_QUALIFICATION_GATES], realProducerBoundaryLatencyOnly: false },
    };
  }
  const evidence = loadEvidence(report, bindings);
  errors.push(...evidence.errors);
  const loaded = evidence.loaded;
  if (!sameJson(report.selectedEnvelope, SELECTED_P0_HISTORY_ENVELOPE)) {
    errors.push('selectedEnvelope does not match the recorded 10k/1M qualification envelope');
  }
  const gates = {};
  // The selected required history envelope is the executed baseline (10k) and
  // scale (1M) tiers. The deferred ten-million role joins the tier gates only
  // when its report is actually bound; an unexecuted tier is never silently
  // required and never silently passed.
  const boundTiers = Object.freeze(['baseline', 'scale', ...(loaded.has('tenMillion') ? ['tenMillion'] : [])]);
  const expectedTierRows = { baseline: 10_000, scale: 1_000_000, tenMillion: 10_000_000 };
  const expectedTierDetails = { baseline: 1_003, scale: 100_003, tenMillion: 1_000_003 };
  const tierReports = (r) => boundTiers.map((role) => r[role]);

  gates.exactPrimaryRows = reportGate('exact primary rows at every bound history tier', boundTiers, loaded, (r) => {
    const actual = Object.fromEntries(boundTiers.map((role) => [role, r[role].results?.tableRows?.primaryFacts]));
    return { actual, passed: boundTiers.every((role) => actual[role] === expectedTierRows[role]) };
  });
  gates.exactDetailRows = reportGate('10% linked detail plus three lifecycle fixtures at every bound history tier', boundTiers, loaded, (r) => {
    const actual = Object.fromEntries(boundTiers.map((role) => [role, r[role].results?.tableRows?.detailPayloads]));
    return { actual, passed: boundTiers.every((role) => actual[role] === expectedTierDetails[role]) };
  });
  gates.handoffP99 = reportGate('maximum p99 <= 9 ms across every bound history tier', boundTiers, loaded, (r) => {
    const actual = maxOf(tierReports(r).map((entry) => entry.results?.factHandoff?.p99Ms));
    return { actual, passed: actual <= 9 };
  });
  gates.responsivenessProxyP95 = reportGate('standalone proxy p95 <= 25 ms at every bound history tier; not a matched UI claim', boundTiers, loaded, (r) => {
    const actual = maxOf(tierReports(r).map((entry) => entry.results?.responsivenessProxy?.lag?.p95Ms));
    return { actual, passed: actual <= 25 };
  });
  gates.indexedQuery = reportGate('indexed drill-down <= 250 ms at every bound history tier', boundTiers, loaded, (r) => {
    const actual = maxOf(tierReports(r).map((entry) => entry.results?.queries?.indexedSessionMs));
    return { actual, passed: actual <= 250 };
  });
  gates.largeDetailQuery = reportGate('2 MiB detail reconstruction <= 9000 ms at every bound history tier', boundTiers, loaded, (r) => {
    const actual = maxOf(tierReports(r).map((entry) => entry.results?.queries?.twoMiBDetailMs));
    return { actual, passed: actual <= 9_000 };
  });
  gates.temporaryFootprint = reportGate('each bound tier stays within its predeclared effective temporary-data limit', boundTiers, loaded, (r) => {
    const actual = Object.fromEntries(boundTiers.map((role) => [role, resourceValue(r[role], 'physicalBytes', Math.max)]));
    const passed = boundTiers.every((role) => finiteNonNegative(actual[role]) && actual[role] <= r[role].matrix?.bounds?.effectiveTemporaryLimitBytes);
    return { actual, passed };
  });
  gates.reservedFreeDisk = reportGate('each bound tier preserves its predeclared free-disk reserve', boundTiers, loaded, (r) => {
    const actual = Object.fromEntries(boundTiers.map((role) => [role, resourceValue(r[role], 'freeBytes', Math.min)]));
    const passed = boundTiers.every((role) => finiteNonNegative(actual[role]) && actual[role] >= r[role].matrix?.bounds?.minUnusedDiskBytes);
    return { actual, passed };
  });
  gates.inPlaceCorruption = reportGate('contained corruption completes with a terminal fresh reader', ['baseline'], loaded, ({ baseline }) => {
    const fault = baseline.results?.destructiveFault;
    return { actual: fault?.phase ?? null, passed: fault?.phase === 'completed' && fault?.corruptionWorkerTerminal === true };
  });
  gates.capacityCalibration = reportGate('eligible versioned component calibration', ['baseline'], loaded, ({ baseline }) => {
    const validation = validateCapacityCalibration(baseline.results?.capacityCalibration, { baselineRows: 10_000, detailRows: 1_000 });
    return { actual: { eligible: baseline.results?.capacityCalibration?.eligible, errors: validation.errors }, passed: validation.valid };
  });
  gates.scaleHistoryRows = reportGate('exactly 1,000,000 primary rows', ['scale'], loaded, ({ scale }) => ({ actual: scale.results?.tableRows?.primaryFacts, passed: scale.results?.tableRows?.primaryFacts === 1_000_000 }));
  gates.tenMillionHistory = tenMillionHistoryGate(loaded);
  gates.realProducerBoundary = reportGate('real nested producer handoff <= 9 ms, detached, redacted, non-waiting, failover and rejection retained', ['baseline'], loaded, ({ baseline }) => {
    const value = baseline.results?.realProducerBoundary;
    const passed = value?.status === 'submitted' && value?.handoffMs <= 9 && value?.nestedDepth >= 2
      && value?.failoverAttemptsRetained >= 2 && value?.cancellationOrCapacityStatus === 'rejected'
      && value?.rejectionHandoffMs <= 9 && value?.delayedAcknowledgementDidNotGate === true
      && value?.mutationAfterHandoffDidNotAlterCapture === true && value?.credentialFilteredBeforeSerialization === true;
    return { actual: value ?? null, passed };
  });
  gates.rateConditions = reportGate('1,000 fact/s for 5,000 samples at 1, 2, and 4 hosts; <=2% pacing error and drained backlog', ['scale'], loaded, ({ scale }) => evaluateRateConditions(scale));

  const enduranceRoles = ['endurance'];
  const enduranceResult = () => reportGate('full independent endurance trials validate from raw timing and worker receipts', enduranceRoles, loaded, ({ endurance }) => {
    const validation = validateEnduranceTrials(endurance.results?.endurance, { mode: 'full' });
    return { actual: { valid: validation.valid, errors: validation.errors }, passed: validation.valid };
  });
  gates.enduranceLightLoad = enduranceResult();
  gates.enduranceSustainedLoad = enduranceResult();
  gates.enduranceWorkerMemory = enduranceResult();

  const mixedRoles = ['mixedFullStats', 'mixedMemoryOnly'];
  const mixedValidation = (reportValue, mode) => validateMixedEvidence(reportValue.results?.mixed, {
    mode: 'full',
    statsPollMode: mode,
    reportConfiguration: reportValue.configuration,
    expectedProvenance: reportValue.provenance,
  });
  gates.mixedLoad = reportGate('paired full mixed workload; full-stats is authoritative and memory-only is diagnostic', mixedRoles, loaded, (r) => {
    const full = mixedValidation(r.mixedFullStats, 'full-stats');
    const diagnostic = mixedValidation(r.mixedMemoryOnly, 'memory-only');
    const paired = r.mixedFullStats.configuration.seed === r.mixedMemoryOnly.configuration.seed
      && r.mixedFullStats.configuration.mixedUtcDay === r.mixedMemoryOnly.configuration.mixedUtcDay
      && r.mixedFullStats.results?.mixed?.acceptedRows === r.mixedMemoryOnly.results?.mixed?.acceptedRows;
    return { actual: { fullValid: full.valid, diagnosticValid: diagnostic.valid, paired }, passed: full.valid && diagnostic.valid && paired };
  });
  gates.mixedWorkerMemory = reportGate('authoritative full-stats mixed worker-memory validation', mixedRoles, loaded, (r) => {
    const full = mixedValidation(r.mixedFullStats, 'full-stats');
    return { actual: { memoryValid: full.memoryValid, errors: full.memoryErrors }, passed: full.memoryValid };
  });
  gates.queryPeakMemory = reportGate('conservative concurrent query-worker upper bound <= 512 MiB', ['mixedFullStats'], loaded, ({ mixedFullStats }) => {
    const topology = mixedFullStats.results?.mixed?.queryHostTopology;
    const active = mixedFullStats.results?.mixed?.querySaturation?.observedMaxActiveWorkers;
    const actual = finiteNonNegative(topology?.queryWorkerRssBytes) && safeNonNegative(active)
      ? topology.queryWorkerRssBytes * active : Number.NaN;
    return { actual, passed: topology?.queryWorkerTelemetryAvailable === true && actual <= 512 * 1024 ** 2 };
  });
  gates.recorderWorkerRss = reportGate('production-default recorder worker high-water <= 256 MiB in history, endurance, and mixed workloads', [...boundTiers, 'endurance', 'mixedFullStats'], loaded, (r) => {
    const history = tierReports(r).map((entry) => entry.results?.memory?.maxWorkerRssBytes);
    const enduranceWorkers = r.endurance.results?.endurance?.trials?.flatMap((trial) => trial.workerMemory?.workers ?? []).map((worker) => worker.maxRssBytes) ?? [];
    const mixed = r.mixedFullStats.results?.mixed?.queryHostTopology?.recorderMaxWorkerRssBytes;
    const actual = maxOf([...history, ...enduranceWorkers, mixed]);
    const productionDefault = tierReports(r).every((entry) => entry.environment?.recorderHeapMode === 'production-default')
      && r.endurance.results?.endurance?.productionDefaultRecorderHeap === true
      && r.mixedFullStats.results?.mixed?.productionDefaultRecorderHeap === true;
    return { actual: { maxWorkerRssBytes: actual, productionDefault }, passed: productionDefault && actual <= 256 * 1024 ** 2 };
  });
  gates.schemaV2AndFaults = reportGate('upgrade retention, deletion fencing, partial replay, corruption rejection, and terminal cleanup', ['schemaFaults'], loaded, ({ schemaFaults }) => evaluateSchemaFaults(schemaFaults));
  gates.matchedAgentUi = reportGate('matched actual-host enabled measurements do not exceed disabled p95 values and meet freshness/CPU budgets', ['matchedHost'], loaded, ({ matchedHost }) => evaluateMatchedHost(matchedHost));
  gates.incrementalHostMemory = reportGate('actual-host retained analytics state <= 16 MiB per host', ['matchedHost'], loaded, ({ matchedHost }) => {
    const actual = matchedHost.results?.matchedHost?.enabled?.incrementalRetainedHostBytes;
    return { actual, passed: finiteNonNegative(actual) && actual <= 16 * 1024 ** 2 };
  });

  for (const gateName of OVERALL_QUALIFICATION_GATE_NAMES) {
    if (!gates[gateName]) errors.push(`${gateName}: no recomputation rule`);
  }
  const failedDeferred = DEFERRED_OVERALL_QUALIFICATION_GATES.some((name) => gates[name]?.decision === 'failed');
  const qualified = errors.length === 0
    && !failedDeferred
    && REQUIRED_OVERALL_QUALIFICATION_GATES.every((name) => gates[name]?.decision === 'passed');
  return {
    qualified,
    gates,
    errors,
    provisional: evaluateProvisionalOverallQualification(gates, errors, failedDeferred),
  };
}

/** Recompute the provisional (cutover-envelope) qualification from the same
 * gate table. This never rewrites a measured outcome: an exception gate stays
 * 'failed' or 'unqualified' with its measured actual value, the overall report
 * keeps overallP0 'unqualified', and provisional qualification is recorded as
 * a separate, distinct state. Fail closed unless: no evidence errors, no
 * failed deferred gate, every non-exception required gate passed, each
 * exception gate honestly measured-or-missing, and realProducerBoundary
 * correct in every non-latency field (latency only is excepted). */
export function evaluateProvisionalOverallQualification(gates, errors, failedDeferred) {
  const exceptionGates = PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS.filter(
    (name) => gates[name]?.decision === 'failed' || gates[name]?.decision === 'unqualified');
  const realProducerBoundary = gates.realProducerBoundary;
  const producerCorrectWithoutLatency = realProducerBoundary?.decision === 'passed'
    || (realProducerBoundary?.decision === 'failed'
      && PROVISIONAL_REAL_PRODUCER_BOUNDARY_CORRECTNESS(realProducerBoundary.actual));
  const otherOpenGates = REQUIRED_OVERALL_QUALIFICATION_GATES.filter(
    (name) => gates[name]?.decision !== 'passed'
      && !PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS.includes(name)
      && !(name === 'realProducerBoundary' && producerCorrectWithoutLatency));
  const provisionalQualified = errors.length === 0
    && !failedDeferred
    && otherOpenGates.length === 0;
  return {
    qualified: provisionalQualified && producerCorrectWithoutLatency,
    exceptions: exceptionGates,
    otherOpenGates,
    realProducerBoundaryLatencyOnly: producerCorrectWithoutLatency,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

/** Admission uses this after reopening the component reports. It rejects any
 * producer-supplied gate value, decision, threshold, evidence binding, or
 * qualification summary that differs from recomputation. */
export function validateOverallQualificationRecomputation(report, expected) {
  const recomputed = recomputeOverallQualification(report, expected);
  const errors = [...recomputed.errors];
  for (const gateName of OVERALL_QUALIFICATION_GATE_NAMES) {
    if (!sameJson(report.gates?.[gateName], recomputed.gates[gateName])) {
      errors.push(`${gateName}: reported gate does not match recomputed evidence`);
    }
  }
  for (const gateName of Object.keys(report.gates ?? {})) {
    if (!OVERALL_QUALIFICATION_GATE_NAMES.includes(gateName)) errors.push(`unknown overall gate ${gateName}`);
  }
  const failed = OVERALL_QUALIFICATION_GATE_NAMES.filter((name) => recomputed.gates[name]?.decision === 'failed');
  const unqualified = OVERALL_QUALIFICATION_GATE_NAMES.filter((name) => recomputed.gates[name]?.decision !== 'passed' && !failed.includes(name));
  if (!sameJson(report.qualification?.failedGates, failed)) errors.push('qualification.failedGates does not match recomputation');
  if (!sameJson(report.qualification?.unqualifiedGates, unqualified)) errors.push('qualification.unqualifiedGates does not match recomputation');
  const expectedOverall = recomputed.qualified ? 'qualified' : 'unqualified';
  const expectedDecision = recomputed.qualified ? 'overall-qualified' : 'overall-unqualified';
  if (report.qualification?.overallP0 !== expectedOverall || report.qualification?.decision !== expectedDecision) {
    errors.push('qualification decision does not match recomputation');
  }
  if (report.qualification?.provisionalP0 !== undefined) {
    if (!sameJson(report.qualification?.provisionalEnvelope, PROVISIONAL_QUALIFICATION_ENVELOPE)) {
      errors.push('provisionalEnvelope does not match the approved provisional exception envelope');
    }
    const expectedExceptions = [...recomputed.provisional.exceptions].sort();
    const claimedExceptions = [...(report.qualification?.provisionalExceptions ?? [])].sort();
    if (!sameJson(claimedExceptions, expectedExceptions)) {
      errors.push('provisionalExceptions do not match recomputed approved-exception gates');
    }
    const expectedProvisionalState = recomputed.provisional.qualified ? 'provisional-qualified' : 'provisional-unqualified';
    if (report.qualification?.provisionalP0 !== expectedProvisionalState) {
      errors.push('qualification.provisionalP0 does not match recomputation');
    }
  }
  return {
    ...recomputed,
    errors,
    valid: errors.length === 0,
  };
}

export function buildOverallQualificationReport({ reportPath, seed, sourceHead, buildId, sourceFingerprint, evidenceReports, provisional = false }) {
  if (!path.isAbsolute(reportPath) || !boundedString(seed) || !isGitHead(sourceHead)
    || !boundedString(buildId) || !isSha256(sourceFingerprint)) {
    throw new Error('overall qualification output bindings are incomplete');
  }
  const generatedAt = new Date().toISOString();
  const descriptors = {};
  for (const role of OVERALL_EVIDENCE_ROLES) {
    const inputPath = evidenceReports?.[role];
    if (inputPath === undefined) continue;
    const read = readOverallEvidenceFile(path.resolve(inputPath), `${role} report`);
    descriptors[role] = { path: path.resolve(inputPath), sha256: read.sha256, bytes: read.bytes };
  }
  const report = {
    schemaVersion: OVERALL_QUALIFICATION_SCHEMA_VERSION,
    kind: OVERALL_QUALIFICATION_KIND,
    harnessVersion: OVERALL_QUALIFICATION_HARNESS_VERSION,
    status: 'passed',
    generatedAt,
    finishedAt: generatedAt,
    configuration: { scenario: 'overall', rows: null, seed, reportPath: path.resolve(reportPath) },
    // Component reports carry the measured source-file manifest. The aggregate
    // binds that common source identity and each component's exact bytes.
    provenance: { valid: true, gitHead: sourceHead, coordinatedBuildId: buildId, fingerprint: sourceFingerprint },
    evidence: { reports: descriptors },
    selectedEnvelope: SELECTED_P0_HISTORY_ENVELOPE,
    results: { evidenceReportCount: Object.keys(descriptors).length },
    gates: {},
    measurement: { completed: true, evidenceReportCount: Object.keys(descriptors).length },
    cleanup: { completed: true, rootCreated: false, rootRemoved: true },
    qualification: {
      scenario: 'overall', decision: 'overall-unqualified', failedGates: [], unqualifiedGates: [...OVERALL_QUALIFICATION_GATE_NAMES], overallP0: 'unqualified',
      // Declared before recomputation so component evidence binding sees the
      // provisional relaxation; recomputation re-validates it byte-exactly.
      ...(provisional ? { provisionalEnvelope: PROVISIONAL_QUALIFICATION_ENVELOPE } : {}),
    },
  };
  const recomputed = recomputeOverallQualification(report, { sourceHead, buildId, sourceFingerprint });
  report.gates = recomputed.gates;
  report.qualification = {
    scenario: 'overall',
    decision: recomputed.qualified ? 'overall-qualified' : 'overall-unqualified',
    failedGates: OVERALL_QUALIFICATION_GATE_NAMES.filter((name) => recomputed.gates[name]?.decision === 'failed'),
    unqualifiedGates: OVERALL_QUALIFICATION_GATE_NAMES.filter((name) => recomputed.gates[name]?.decision !== 'passed' && recomputed.gates[name]?.decision !== 'failed'),
    overallP0: recomputed.qualified ? 'qualified' : 'unqualified',
    evidenceErrors: recomputed.errors,
  };
  report.finishedAt = new Date().toISOString();
  if (provisional) {
    if (report.qualification.overallP0 === 'qualified') {
      throw new Error('provisional flag is redundant for a fully qualified overall report; re-emit without it');
    }
    if (!recomputed.provisional.qualified) {
      throw new Error(`provisional envelope is not satisfied: ${[
        ...recomputed.errors,
        ...recomputed.provisional.otherOpenGates.map((name) => `${name} is not passed and is not an approved exception`),
        ...(recomputed.provisional.realProducerBoundaryLatencyOnly ? [] : ['realProducerBoundary failed beyond its latency-only exception']),
      ].join('; ')}`);
    }
    report.qualification.provisionalEnvelope = PROVISIONAL_QUALIFICATION_ENVELOPE;
    report.qualification.provisionalExceptions = [...recomputed.provisional.exceptions].sort();
    report.qualification.provisionalP0 = 'provisional-qualified';
  }
  return report;
}

function parseArguments(argv) {
  const names = new Map([
    ['--baseline', 'baseline'], ['--scale', 'scale'], ['--ten-million', 'tenMillion'],
    ['--endurance', 'endurance'], ['--mixed-full-stats', 'mixedFullStats'],
    ['--mixed-memory-only', 'mixedMemoryOnly'], ['--schema-faults', 'schemaFaults'],
    ['--matched-host', 'matchedHost'],
  ]);
  const options = { evidenceReports: {} };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name)) throw new Error(`Duplicate option: ${name}`);
    seen.add(name);
    if (name === '--provisional') { options.provisional = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (names.has(name)) options.evidenceReports[names.get(name)] = path.resolve(value);
    else if (name === '--report') options.reportPath = path.resolve(value);
    else if (name === '--seed') options.seed = value;
    else if (name === '--source-head') options.sourceHead = value;
    else if (name === '--build-id') options.buildId = value;
    else if (name === '--source-fingerprint') options.sourceFingerprint = value;
    else throw new Error(`Unsupported option: ${name}`);
  }
  if (!options.reportPath || !path.isAbsolute(options.reportPath) || !options.reportPath.toLowerCase().endsWith('.json')) throw new Error('--report must be an absolute new .json path');
  if (existsSync(options.reportPath)) throw new Error('--report must name a new file');
  return options;
}

function writeAtomically(filePath, report) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    // Publish without a check-then-replace race: link creation fails if another
    // process has already claimed the evidence path.
    linkSync(temporary, filePath);
  } finally {
    try { unlinkSync(temporary); } catch { /* temporary may not have been created */ }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = buildOverallQualificationReport(options);
  writeAtomically(options.reportPath, report);
  console.log(JSON.stringify({ reportPath: options.reportPath, overallP0: report.qualification.overallP0, provisionalP0: report.qualification.provisionalP0 ?? null, provisionalExceptions: report.qualification.provisionalExceptions ?? null, failedGates: report.qualification.failedGates, unqualifiedGates: report.qualification.unqualifiedGates, evidenceErrors: report.qualification.evidenceErrors }, null, 2));
  if (report.qualification.overallP0 !== 'qualified' && report.qualification.provisionalP0 !== 'provisional-qualified') process.exitCode = 2;
}

if (path.basename(process.argv[1] ?? '') === 'analytics-p0-overall-qualification.mjs'
  && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
