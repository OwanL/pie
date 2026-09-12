export const ENDURANCE_RATE_TOLERANCE_FRACTION = 0.02;
export const ENDURANCE_REQUIRED_WORKER_MEMORY_FIELDS = Object.freeze([
  'maxRssBytes',
  'maxHeapTotalBytes',
  'maxHeapUsedBytes',
  'maxExternalBytes',
  'maxArrayBuffersBytes',
]);

export const ENDURANCE_FULL_TRIALS = Object.freeze([
  Object.freeze({ label: 'light-1ps-repeat-a', ratePerSecond: 1, sampleCount: 301, hostCount: 1, minimumElapsedMs: 300_000 }),
  Object.freeze({ label: 'light-1ps-repeat-b', ratePerSecond: 1, sampleCount: 301, hostCount: 1, minimumElapsedMs: 300_000 }),
  Object.freeze({ label: 'sustained-50ps-1host-repeat-a', ratePerSecond: 50, sampleCount: 10_000, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'sustained-50ps-1host-repeat-b', ratePerSecond: 50, sampleCount: 10_000, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'sustained-50ps-4hosts-repeat-a', ratePerSecond: 50, sampleCount: 10_000, hostCount: 4, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'sustained-50ps-4hosts-repeat-b', ratePerSecond: 50, sampleCount: 10_000, hostCount: 4, minimumElapsedMs: 0 }),
]);

export const ENDURANCE_SMOKE_TRIALS = Object.freeze([
  Object.freeze({ label: 'smoke-light-1ps-a', ratePerSecond: 1, sampleCount: 3, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'smoke-light-1ps-b', ratePerSecond: 1, sampleCount: 3, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'smoke-sustained-50ps-1host-repeat-a', ratePerSecond: 50, sampleCount: 20, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'smoke-sustained-50ps-1host-repeat-b', ratePerSecond: 50, sampleCount: 20, hostCount: 1, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'smoke-sustained-50ps-4hosts-repeat-a', ratePerSecond: 50, sampleCount: 20, hostCount: 4, minimumElapsedMs: 0 }),
  Object.freeze({ label: 'smoke-sustained-50ps-4hosts-repeat-b', ratePerSecond: 50, sampleCount: 20, hostCount: 4, minimumElapsedMs: 0 }),
]);

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isWorkerInstanceId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function workerKey(identity) {
  return `${identity?.instanceId ?? ''}/${identity?.pid ?? ''}/${identity?.spawnedAtMs ?? ''}`;
}

function validateWorkerMemory(workerMemory, expectedWorkerCount, label, errors, { minimumSamples }) {
  if (!workerMemory || typeof workerMemory !== 'object' || Array.isArray(workerMemory)) {
    errors.push(`${label}: worker memory summary is missing`);
    return;
  }
  if (!Number.isSafeInteger(workerMemory.sampleCount) || workerMemory.sampleCount < minimumSamples) {
    errors.push(`${label}: worker memory sample count must be at least ${minimumSamples}`);
  }
  if (!Array.isArray(workerMemory.workers) || workerMemory.workers.length !== expectedWorkerCount) {
    errors.push(`${label}: worker memory identity count must be ${expectedWorkerCount}`);
    return;
  }
  const seen = new Set();
  for (const [index, worker] of workerMemory.workers.entries()) {
    const identity = worker?.identity;
    if (!identity || !isWorkerInstanceId(identity.instanceId) || !isPositiveSafeInteger(identity.pid)
      || !isPositiveSafeInteger(identity.spawnedAtMs)) {
      errors.push(`${label}: worker ${index} identity is incomplete`);
    }
    const key = workerKey(identity);
    if (seen.has(key)) errors.push(`${label}: worker ${index} identity is duplicated`);
    seen.add(key);
    for (const field of ENDURANCE_REQUIRED_WORKER_MEMORY_FIELDS) {
      if (!isSafeNonNegativeInteger(worker?.[field])) errors.push(`${label}: worker ${index} ${field} is missing or invalid`);
    }
    if (!isSafeNonNegativeInteger(worker?.sampleCount) || worker.sampleCount < minimumSamples) {
      errors.push(`${label}: worker ${index} sample count is incomplete`);
    }
  }
}

/** Recompute offered rate from the recorded sample count and submission wall
 * time. The reported offeredRatePerSecond is treated as a claim and must
 * agree with this derivation before it can be used in an endurance gate. */
export function recomputeEnduranceTrialPacing(trial, target, { toleranceFraction = ENDURANCE_RATE_TOLERANCE_FRACTION } = {}) {
  const submissionElapsedMs = trial?.submissionElapsedMs;
  const sampleCount = trial?.sampleCount;
  const expectedRatePerSecond = target?.ratePerSecond;
  const derivedOfferedRatePerSecond = Number.isFinite(submissionElapsedMs) && submissionElapsedMs > 0
    && isPositiveSafeInteger(sampleCount)
    ? sampleCount / (submissionElapsedMs / 1_000)
    : Number.NaN;
  const reportedOfferedRatePerSecond = trial?.offeredRatePerSecond;
  const reportMatchesDerived = Number.isFinite(reportedOfferedRatePerSecond)
    && Number.isFinite(derivedOfferedRatePerSecond)
    && Math.abs(reportedOfferedRatePerSecond - derivedOfferedRatePerSecond)
      <= Math.max(1e-9, derivedOfferedRatePerSecond * 1e-9);
  const deviationFraction = Number.isFinite(derivedOfferedRatePerSecond) && expectedRatePerSecond > 0
    ? Math.abs(derivedOfferedRatePerSecond - expectedRatePerSecond) / expectedRatePerSecond
    : Number.NaN;
  return {
    expectedRatePerSecond,
    reportedOfferedRatePerSecond,
    derivedOfferedRatePerSecond,
    submissionElapsedMs,
    deviationFraction,
    reportMatchesDerived,
    withinTolerance: Number.isFinite(deviationFraction) && deviationFraction <= toleranceFraction,
    passed: reportMatchesDerived && Number.isFinite(deviationFraction) && deviationFraction <= toleranceFraction,
  };
}

/** Validate the persisted endurance result without trusting its decision or
 * the top-level gate flags. Used both during a run and for a post-hoc receipt
 * over an already published report. */
export function validateEnduranceTrials(endurance, {
  mode = 'full',
  minimumMemorySamples = mode === 'full' ? 2 : 1,
  enforcePacing = mode === 'full',
} = {}) {
  const errors = [];
  const expectedTrials = mode === 'smoke' ? ENDURANCE_SMOKE_TRIALS : ENDURANCE_FULL_TRIALS;
  if (!endurance || typeof endurance !== 'object' || Array.isArray(endurance)) {
    return { valid: false, errors: ['endurance results are missing'], trials: [] };
  }
  if (!Array.isArray(endurance.trials) || endurance.trials.length !== expectedTrials.length) {
    errors.push(`endurance trial count must be ${expectedTrials.length}`);
    return { valid: false, errors, trials: [] };
  }
  const validatedTrials = [];
  const allWorkerKeys = new Set();
  for (const [index, expected] of expectedTrials.entries()) {
    const trial = endurance.trials[index];
    const label = `endurance trial ${index}`;
    if (!trial || trial.target?.label !== expected.label || trial.target?.ratePerSecond !== expected.ratePerSecond
      || trial.target?.sampleCount !== expected.sampleCount || trial.target?.hostCount !== expected.hostCount
      || trial.target?.minimumElapsedMs !== expected.minimumElapsedMs) {
      errors.push(`${label}: target does not match the declared ${mode} plan`);
    }
    if (trial?.sampleCount !== expected.sampleCount) errors.push(`${label}: sample count is not exact`);
    if (trial?.acceptedSampleCount !== expected.sampleCount) errors.push(`${label}: accepted sample count is not exact`);
    if (trial?.endingBacklogRecords !== 0 || trial?.endingBacklogBytes !== 0) errors.push(`${label}: ending backlog is not empty`);
    if (!Number.isFinite(trial?.elapsedMs) || trial.elapsedMs < expected.minimumElapsedMs) errors.push(`${label}: elapsed duration is below the declared minimum`);
    const pacing = recomputeEnduranceTrialPacing(trial, expected);
    if (enforcePacing && !pacing.passed) errors.push(`${label}: offered rate does not match the recorded pacing within tolerance`);
    validateWorkerMemory(trial?.workerMemory, expected.hostCount, label, errors, { minimumSamples: minimumMemorySamples });
    for (const worker of trial?.workerMemory?.workers ?? []) {
      const key = workerKey(worker.identity);
      if (allWorkerKeys.has(key)) errors.push(`${label}: worker identity is duplicated across endurance trials`);
      allWorkerKeys.add(key);
    }
    validatedTrials.push({ label: expected.label, pacing, workerMemory: trial?.workerMemory });
  }
  if (endurance.summary?.lightP99Pooled !== null) errors.push('lightP99Pooled must remain null; light p99 is not pooled');
  if (mode === 'full' && endurance.productionDefaultRecorderHeap !== true) errors.push('full endurance must use the production-default recorder heap');
  return { valid: errors.length === 0, errors, trials: validatedTrials };
}

/** Validate a post-hoc terminal receipt against every worker identity recorded
 * in the original report. The receipt deliberately permits unknown exit codes
 * because process absence observed later cannot reconstruct shutdown logs. */
export function validateEnduranceTerminalReceipt(endurance, receipt, { reportSha256 } = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { valid: false, errors: ['terminal receipt is missing'] };
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'pie-p0-endurance-terminal-receipt-v1') errors.push('terminal receipt schema or kind is invalid');
  if (reportSha256 !== undefined && receipt.originalReportSha256 !== reportSha256) errors.push('terminal receipt report hash does not match the original report');
  if (!Array.isArray(receipt.workers)) {
    errors.push('terminal receipt workers are missing');
    return { valid: false, errors };
  }
  const expected = (endurance?.trials ?? []).flatMap((trial) => trial?.workerMemory?.workers ?? []);
  const expectedByKey = new Map(expected.map((worker) => [workerKey(worker.identity), worker.identity]));
  if (expected.length !== expectedByKey.size) errors.push('original report contains duplicated worker identities');
  const seen = new Set();
  for (const [index, worker] of receipt.workers.entries()) {
    const key = workerKey(worker?.identity);
    if (seen.has(key)) errors.push(`terminal receipt worker ${index} is duplicated`);
    seen.add(key);
    const expectedIdentity = expectedByKey.get(key);
    if (!expectedIdentity) errors.push(`terminal receipt worker ${index} is not present in the original report`);
    if (!worker?.identity || !isWorkerInstanceId(worker.identity.instanceId)
      || !isPositiveSafeInteger(worker.identity.pid) || !isPositiveSafeInteger(worker.identity.spawnedAtMs)) {
      errors.push(`terminal receipt worker ${index} identity is incomplete`);
    }
    if (worker?.processObservedAlive !== false) errors.push(`terminal receipt worker ${index} was not observed absent`);
    if (worker?.observationKind !== 'post-hoc-process-absence') errors.push(`terminal receipt worker ${index} observation kind is not limited post-hoc absence`);
    if (worker?.exitCodeKnown !== false || worker?.signalKnown !== false) errors.push(`terminal receipt worker ${index} claims unknown exit metadata as known`);
  }
  if (seen.size !== expectedByKey.size) errors.push(`terminal receipt must identify all ${expectedByKey.size} recorded workers`);
  return { valid: errors.length === 0, errors, workerCount: expectedByKey.size };
}
