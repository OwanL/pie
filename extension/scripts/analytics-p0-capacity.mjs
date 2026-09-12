const CALIBRATION_SCHEMA_VERSION = 2;

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Summarize a complete immutable timing sample with nearest-rank
 * percentiles. Sorting once preserves the existing percentile definition and
 * reading the final element avoids passing a scale-sized array as variadic
 * function arguments. */
export function summarizeTimingSamples(values) {
  const isIndexedTypedArray = ArrayBuffer.isView(values) && typeof values.length === 'number';
  if ((!Array.isArray(values) && !isIndexedTypedArray)
    || !Number.isSafeInteger(values.length)
    || values.length <= 0) {
    throw new Error('timing samples must be a non-empty array or typed array');
  }
  const sorted = Array.from(values);
  for (const [index, value] of sorted.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`timing sample[${index}] must be a finite non-negative number`);
    }
  }
  sorted.sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

/** Split a finite fixture load into deterministic batches bounded by both
 * record count and the caller's conservative per-record byte estimate. The
 * qualification driver drains each returned batch before admitting the next;
 * this does not change production queue limits or measured submit latency. */
export function planBoundedLoadBatches(recordBytes, { maxRecords, maxBytes }) {
  if (!Array.isArray(recordBytes)) throw new Error('recordBytes must be an array');
  const recordLimit = requirePositiveInteger(maxRecords, 'maxRecords');
  const byteLimit = requirePositiveInteger(maxBytes, 'maxBytes');
  const batches = [];
  let start = 0;
  let bytes = 0;
  for (const [index, value] of recordBytes.entries()) {
    const size = requirePositiveInteger(value, `recordBytes[${index}]`);
    if (size > byteLimit) throw new Error(`recordBytes[${index}] exceeds maxBytes`);
    const records = index - start;
    if (records > 0 && (records >= recordLimit || bytes + size > byteLimit)) {
      batches.push({ start, end: index, records, bytes });
      start = index;
      bytes = 0;
    }
    bytes += size;
  }
  if (start < recordBytes.length) {
    batches.push({ start, end: recordBytes.length, records: recordBytes.length - start, bytes });
  }
  return batches;
}

/** Reconstruct the finite recorder-topology sample plan from the declared row
 * count and unchanged queue bound. This lets baseline admission prove that no
 * fact or detail drain sample was omitted from a persisted report. */
export function buildExpectedTopologySamplePlan({ rows, maxQueueBytes }) {
  const factRows = requirePositiveInteger(rows, 'rows');
  const queueBytes = requirePositiveInteger(maxQueueBytes, 'maxQueueBytes');
  if (factRows < 10_000 || factRows > 10_000_000 || factRows % 10_000 !== 0) {
    throw new Error('rows must be a multiple of 10000 between 10000 and 10000000');
  }
  const detailRows = Math.floor(factRows / 10);
  const smallDetails = Math.floor(detailRows * 0.95);
  const mediumDetails = Math.floor(detailRows * 0.049);
  const largeDetails = detailRows - smallDetails - mediumDetails;
  const detailBytes = [
    ...Array.from({ length: smallDetails }, () => 2 * 1024),
    ...Array.from({ length: mediumDetails }, () => 32 * 1024),
    ...Array.from({ length: largeDetails }, () => 2 * 1024 ** 2),
  ];
  const factSamples = [];
  for (let completed = 10_000; completed < factRows; completed += 10_000) {
    factSamples.push({ label: `after-fact-batch-${completed}`, phase: 'facts', workerCount: 4 });
  }
  factSamples.push({ label: 'after-fact-flush', phase: 'facts', workerCount: 4 });
  const detailSamples = planBoundedLoadBatches(detailBytes, {
    maxRecords: 1_000,
    maxBytes: queueBytes / 4,
  }).map((batch) => ({
    label: `after-detail-batch-${batch.end}`,
    phase: 'variable-details',
    workerCount: 1,
  }));
  return [
    ...factSamples,
    ...detailSamples,
    { label: 'after-nested-detail-drain', phase: 'nested-details', workerCount: 1 },
  ];
}

/** Validate and recompute bounded recorder-topology RSS evidence. Producer RSS
 * is the observed high-water through the sample window; each worker RSS value
 * comes from that worker's stats response after the corresponding drain. */
export function validateMemoryTopologySamples(samples, { expectedPlan, recorderWorkers } = {}) {
  const errors = [];
  if (!Array.isArray(samples) || samples.length === 0) {
    return { valid: false, errors: ['memory topology samples are missing'] };
  }
  if (expectedPlan !== undefined && (!Array.isArray(expectedPlan) || expectedPlan.length === 0)) {
    return { valid: false, errors: ['expected memory topology sample plan is invalid'] };
  }
  if (Array.isArray(expectedPlan) && samples.length !== expectedPlan.length) {
    errors.push(`memory topology sample count must be exactly ${expectedPlan.length}`);
  }
  const terminalValidation = validateTerminalWorkerSummaries(recorderWorkers);
  if (!terminalValidation.valid) {
    errors.push(`memory topology recorder lifecycle is invalid: ${terminalValidation.errors.join('; ')}`);
  }
  const terminalByInstance = new Map(terminalValidation.workers.map((worker) => [worker.identity.instanceId, worker.identity]));
  const seenLabels = new Set();
  const workerIdentities = new Map();
  const phaseIdentitySets = new Map();
  const identityPhases = new Map();
  let maxWorkerRssBytes = 0;
  let maxTotalTopologyRssBytes = 0;
  let previousObservedAtMs = -1;
  for (const [index, sample] of samples.entries()) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || JSON.stringify(Object.keys(sample).sort()) !== JSON.stringify([
        'label', 'maxWorkerRssBytes', 'observedAt', 'phase', 'producerRssBytes',
        'totalTopologyRssBytes', 'totalWorkerRssBytes', 'workers',
      ])) {
      errors.push(`memory topology sample[${index}] has an invalid shape`);
      continue;
    }
    const expected = expectedPlan?.[index];
    if (typeof sample.label !== 'string' || sample.label.length === 0 || Buffer.byteLength(sample.label, 'utf8') > 128) {
      errors.push(`memory topology sample[${index}] label is invalid`);
    } else if (seenLabels.has(sample.label)) {
      errors.push(`memory topology sample label is duplicated: ${sample.label}`);
    } else {
      seenLabels.add(sample.label);
    }
    if (expected && (sample.label !== expected.label || sample.phase !== expected.phase)) {
      errors.push(`memory topology sample[${index}] does not match expected ${expected.phase}/${expected.label}`);
    }
    let observedAtMs = Number.NaN;
    if (typeof sample.observedAt === 'string') observedAtMs = Date.parse(sample.observedAt);
    if (!Number.isFinite(observedAtMs)
      || new Date(observedAtMs).toISOString() !== sample.observedAt) {
      errors.push(`memory topology sample[${index}] timestamp is not canonical ISO`);
    } else if (observedAtMs < previousObservedAtMs) {
      errors.push(`memory topology sample[${index}] timestamp precedes the prior sample`);
    } else {
      previousObservedAtMs = observedAtMs;
    }
    if (!Number.isSafeInteger(sample.producerRssBytes) || sample.producerRssBytes <= 0) {
      errors.push(`memory topology sample[${index}] producer RSS is invalid`);
    }
    if (!Array.isArray(sample.workers) || sample.workers.length === 0
      || (expected && sample.workers.length !== expected.workerCount)) {
      errors.push(`memory topology sample[${index}] worker count is invalid`);
      continue;
    }
    const sampleInstances = new Set();
    let workerTotal = 0;
    let workerMaximum = 0;
    // Required worker fields, plus optional heap detail. The heap fields were
    // added to separate a retained heap from V8 reserving address space, which
    // RSS alone cannot distinguish; they are validated below when present.
    const requiredWorkerKeys = ['identity', 'rssBytes'];
    const optionalWorkerKeys = ['heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes'];
    for (const [workerIndex, worker] of sample.workers.entries()) {
      const workerKeys = worker && typeof worker === 'object' && !Array.isArray(worker)
        ? Object.keys(worker).sort()
        : [];
      const workerShapeValid = requiredWorkerKeys.every((key) => workerKeys.includes(key))
        && workerKeys.every((key) => requiredWorkerKeys.includes(key) || optionalWorkerKeys.includes(key));
      if (!worker || typeof worker !== 'object' || Array.isArray(worker) || !workerShapeValid) {
        errors.push(`memory topology sample[${index}] worker[${workerIndex}] has an invalid shape`);
        continue;
      }
      const identity = worker.identity;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(['instanceId', 'pid', 'spawnedAtMs'])
        || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
        || !Number.isSafeInteger(identity.spawnedAtMs) || identity.spawnedAtMs <= 0
        || typeof identity.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.instanceId)) {
        errors.push(`memory topology sample[${index}] worker[${workerIndex}] identity is invalid`);
        continue;
      }
      if (sampleInstances.has(identity.instanceId)) {
        errors.push(`memory topology sample[${index}] repeats worker ${identity.instanceId}`);
      }
      sampleInstances.add(identity.instanceId);
      const recordedIdentity = workerIdentities.get(identity.instanceId);
      if (recordedIdentity
        && (recordedIdentity.pid !== identity.pid || recordedIdentity.spawnedAtMs !== identity.spawnedAtMs)) {
        errors.push(`memory topology worker identity changed for ${identity.instanceId}`);
      }
      workerIdentities.set(identity.instanceId, { ...identity });
      const terminalIdentity = terminalByInstance.get(identity.instanceId);
      if (!terminalIdentity
        || terminalIdentity.pid !== identity.pid
        || terminalIdentity.spawnedAtMs !== identity.spawnedAtMs) {
        errors.push(`memory topology sample[${index}] worker ${identity.instanceId} has no matching terminal lifecycle`);
      }
      const priorPhase = identityPhases.get(identity.instanceId);
      if (priorPhase !== undefined && priorPhase !== sample.phase) {
        errors.push(`memory topology worker ${identity.instanceId} appears in both ${priorPhase} and ${sample.phase}`);
      }
      identityPhases.set(identity.instanceId, sample.phase);
      if (!Number.isSafeInteger(worker.rssBytes) || worker.rssBytes <= 0) {
        errors.push(`memory topology sample[${index}] worker[${workerIndex}] RSS is invalid`);
        continue;
      }
      // Optional heap detail. RSS alone cannot distinguish a retained heap from
      // V8 reserving address space, which is the open question behind the
      // recorderWorkerRss gate, so record it and validate its internal
      // consistency when present.
      for (const field of ['heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes']) {
        const value = worker[field];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0) {
          errors.push(`memory topology sample[${index}] worker[${workerIndex}] ${field} is invalid`);
        }
      }
      if (Number.isSafeInteger(worker.heapUsedBytes) && Number.isSafeInteger(worker.heapTotalBytes)
        && worker.heapUsedBytes > worker.heapTotalBytes) {
        errors.push(`memory topology sample[${index}] worker[${workerIndex}] heapUsed exceeds heapTotal`);
      }
      if (Number.isSafeInteger(worker.rssBytes) && Number.isSafeInteger(worker.heapTotalBytes)
        && worker.heapTotalBytes > worker.rssBytes) {
        errors.push(`memory topology sample[${index}] worker[${workerIndex}] heapTotal exceeds RSS`);
      }
      workerTotal += worker.rssBytes;
      workerMaximum = Math.max(workerMaximum, worker.rssBytes);
      if (!Number.isSafeInteger(workerTotal)) errors.push(`memory topology sample[${index}] worker RSS total exceeds safe integer range`);
    }
    const phaseSet = [...sampleInstances].sort().join(',');
    const expectedPhaseSet = phaseIdentitySets.get(sample.phase);
    if (expectedPhaseSet !== undefined && expectedPhaseSet !== phaseSet) {
      errors.push(`memory topology ${sample.phase} worker identity set changed between samples`);
    }
    phaseIdentitySets.set(sample.phase, phaseSet);
    const topologyTotal = sample.producerRssBytes + workerTotal;
    if (sample.totalWorkerRssBytes !== workerTotal) errors.push(`memory topology sample[${index}] worker RSS total does not reconcile`);
    if (sample.maxWorkerRssBytes !== workerMaximum) errors.push(`memory topology sample[${index}] worker RSS maximum does not reconcile`);
    if (sample.totalTopologyRssBytes !== topologyTotal) errors.push(`memory topology sample[${index}] total RSS does not reconcile`);
    if (!Number.isSafeInteger(topologyTotal)) errors.push(`memory topology sample[${index}] total RSS exceeds safe integer range`);
    maxWorkerRssBytes = Math.max(maxWorkerRssBytes, workerMaximum);
    maxTotalTopologyRssBytes = Math.max(maxTotalTopologyRssBytes, topologyTotal);
  }
  return {
    valid: errors.length === 0,
    errors,
    sampleCount: samples.length,
    maxWorkerRssBytes,
    maxTotalTopologyRssBytes,
    sampledWorkerCount: workerIdentities.size,
  };
}

export function validateTerminalWorkerEvidence(events, { requireReady = true } = {}) {
  const errors = [];
  if (!Array.isArray(events) || events.length === 0) {
    return { valid: false, errors: ['worker lifecycle evidence is missing'], workers: [] };
  }
  const byInstance = new Map();
  for (const [index, event] of events.entries()) {
    const identity = event?.identity;
    if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0
      || !Number.isSafeInteger(identity?.spawnedAtMs) || identity.spawnedAtMs <= 0
      || typeof identity?.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.instanceId)) {
      errors.push(`worker lifecycle event[${index}] identity is invalid`);
      continue;
    }
    const record = byInstance.get(identity.instanceId) ?? { identity: { ...identity }, states: [] };
    if (record.identity.pid !== identity.pid || record.identity.spawnedAtMs !== identity.spawnedAtMs) {
      errors.push(`worker lifecycle identity changed for ${identity.instanceId}`);
    }
    record.states.push({ state: event.state, code: event.code ?? null, signal: event.signal ?? null });
    byInstance.set(identity.instanceId, record);
  }
  const expectedStates = requireReady ? ['spawned', 'ready', 'terminal'] : ['spawned', 'terminal'];
  for (const record of byInstance.values()) {
    const actualStates = record.states.map((event) => event.state);
    if (JSON.stringify(actualStates) !== JSON.stringify(expectedStates)) {
      errors.push(`worker lifecycle ${record.identity.instanceId} must be exactly ${expectedStates.join(',')}`);
    }
  }
  if (byInstance.size === 0) errors.push('worker lifecycle evidence has no valid worker identities');
  return { valid: errors.length === 0, errors, workers: [...byInstance.values()] };
}

/** Validate the grouped lifecycle shape persisted in a qualification report.
 * This is deliberately separate from validateTerminalWorkerEvidence: the live
 * collector receives one event per transition, while report admission receives
 * one immutable identity with an ordered states array. */
export function validateTerminalWorkerSummaries(workers, { requireReady = true } = {}) {
  const errors = [];
  if (!Array.isArray(workers) || workers.length === 0) {
    return { valid: false, errors: ['worker lifecycle summaries are missing'], workers: [] };
  }
  const expectedStates = requireReady ? ['spawned', 'ready', 'terminal'] : ['spawned', 'terminal'];
  const seen = new Set();
  const normalized = [];
  for (const [index, worker] of workers.entries()) {
    if (!worker || typeof worker !== 'object' || Array.isArray(worker)
      || JSON.stringify(Object.keys(worker).sort()) !== JSON.stringify(['identity', 'states'])) {
      errors.push(`worker lifecycle summary[${index}] must contain exactly identity and states`);
      continue;
    }
    const identity = worker?.identity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(['instanceId', 'pid', 'spawnedAtMs'])
      || !Number.isSafeInteger(identity?.pid) || identity.pid <= 0
      || !Number.isSafeInteger(identity?.spawnedAtMs) || identity.spawnedAtMs <= 0
      || typeof identity?.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.instanceId)) {
      errors.push(`worker lifecycle summary[${index}] identity is invalid`);
      continue;
    }
    if (seen.has(identity.instanceId)) {
      errors.push(`worker lifecycle summary identity is duplicated: ${identity.instanceId}`);
      continue;
    }
    seen.add(identity.instanceId);
    if (!Array.isArray(worker.states)) {
      errors.push(`worker lifecycle summary ${identity.instanceId} states are missing`);
      continue;
    }
    const states = worker.states.map((event, stateIndex) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(['code', 'signal', 'state'])) {
        errors.push(`worker lifecycle summary ${identity.instanceId} state[${stateIndex}] must contain exactly state, code and signal`);
        return { state: undefined, code: null, signal: null };
      }
      const state = { state: event.state, code: event.code, signal: event.signal };
      if (event.state === 'spawned' || event.state === 'ready') {
        if (event.code !== null || event.signal !== null) {
          errors.push(`worker lifecycle summary ${identity.instanceId} ${event.state} state cannot claim terminal code or signal`);
        }
      } else if (event.state === 'terminal') {
        const validCode = Number.isSafeInteger(event.code) && event.code >= 0;
        const validSignal = typeof event.signal === 'string'
          && /^SIG[A-Z0-9]+$/.test(event.signal)
          && Buffer.byteLength(event.signal, 'utf8') <= 128;
        if (Number(validCode) + Number(validSignal) !== 1) {
          errors.push(`worker lifecycle summary ${identity.instanceId} terminal state requires exactly one valid exit code or signal`);
        }
      }
      return state;
    });
    if (JSON.stringify(states.map((event) => event.state)) !== JSON.stringify(expectedStates)) {
      errors.push(`worker lifecycle summary ${identity.instanceId} must be exactly ${expectedStates.join(',')}`);
    }
    normalized.push({ identity: { ...identity }, states });
  }
  if (normalized.length === 0) errors.push('worker lifecycle evidence has no valid worker identities');
  return { valid: errors.length === 0, errors, workers: normalized };
}

function requireSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`${label} is required`);
  return {
    label,
    treeBytes: requireNonNegativeInteger(snapshot.treeBytes, `${label}.treeBytes`),
    mainDatabaseBytes: requireNonNegativeInteger(snapshot.mainDatabaseBytes, `${label}.mainDatabaseBytes`),
    mainFileBytes: requireNonNegativeInteger(snapshot.mainFileBytes, `${label}.mainFileBytes`),
  };
}

export function validateCapacitySnapshotInventory(snapshot, { mainDatabaseFile, expectedLabel }) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object') return { valid: false, errors: ['capacity snapshot is missing'] };
  if (typeof mainDatabaseFile !== 'string' || mainDatabaseFile.length === 0 || mainDatabaseFile.includes('/')) {
    return { valid: false, errors: ['mainDatabaseFile must be a root-relative file name'] };
  }
  if (!Array.isArray(snapshot.files)) return { valid: false, errors: ['capacity snapshot file inventory is missing'] };
  if (expectedLabel !== undefined && snapshot.label !== expectedLabel) {
    errors.push(`capacity snapshot label must be ${expectedLabel}`);
  }
  const seen = new Set();
  let treeBytes = 0;
  let mainDatabaseBytes = 0;
  let mainFileBytes = 0;
  for (const [index, entry] of snapshot.files.entries()) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`capacity snapshot file[${index}] is invalid`);
      continue;
    }
    const relativePath = entry.path;
    const pathSegments = typeof relativePath === 'string' ? relativePath.split('/') : [];
    if (typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath.includes('\\')
      || relativePath.includes('//')
      || relativePath.includes(':')
      || relativePath.includes('\0')
      || relativePath.startsWith('/')
      || relativePath.startsWith('./')
      || relativePath.endsWith('/')
      || pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      errors.push(`capacity snapshot file[${index}] path is not a normalized relative path`);
      continue;
    }
    const identityPath = relativePath.toLowerCase();
    if (seen.has(identityPath)) errors.push(`capacity snapshot file path is duplicated: ${relativePath}`);
    seen.add(identityPath);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      errors.push(`capacity snapshot file ${relativePath} bytes are invalid`);
      continue;
    }
    treeBytes += entry.bytes;
    if (relativePath === mainDatabaseFile
      || relativePath === `${mainDatabaseFile}-wal`
      || relativePath === `${mainDatabaseFile}-shm`) {
      mainDatabaseBytes += entry.bytes;
    }
    if (relativePath === mainDatabaseFile) mainFileBytes = entry.bytes;
    if (!Number.isSafeInteger(treeBytes) || !Number.isSafeInteger(mainDatabaseBytes)) {
      errors.push('capacity snapshot inventory byte totals exceed safe integer range');
      break;
    }
  }
  if (treeBytes !== snapshot.treeBytes) errors.push('capacity snapshot tree bytes do not match its file inventory');
  if (mainDatabaseBytes !== snapshot.mainDatabaseBytes) errors.push('capacity snapshot main database-family bytes do not match its file inventory');
  if (mainFileBytes !== snapshot.mainFileBytes) errors.push('capacity snapshot main file bytes do not match its file inventory');
  return { valid: errors.length === 0, errors, reason: errors.length > 0 ? errors.join('; ') : undefined };
}

export function buildCapacityCalibration({
  baselineRows,
  detailRows,
  snapshots,
  observedTreeBytes = [],
  prewriteProjectedTreeBytes = [],
}) {
  const rows = requirePositiveInteger(baselineRows, 'baselineRows');
  const details = requirePositiveInteger(detailRows, 'detailRows');
  if (!snapshots || typeof snapshots !== 'object') throw new Error('snapshots are required');

  const beforePrimaryFacts = requireSnapshot(snapshots.beforePrimaryFacts, 'before-primary-facts');
  const afterPrimaryFacts = requireSnapshot(snapshots.afterPrimaryFacts, 'after-primary-facts');
  const afterVariableDetails = requireSnapshot(snapshots.afterVariableDetails, 'after-variable-details');
  const finalBeforeFault = requireSnapshot(snapshots.finalBeforeFault, 'final-before-fault');
  const observedTrees = observedTreeBytes.map((value, index) => (
    requireNonNegativeInteger(value, `observedTreeBytes[${index}]`)
  ));
  const projectedPrewrites = prewriteProjectedTreeBytes.map((value, index) => (
    requireNonNegativeInteger(value, `prewriteProjectedTreeBytes[${index}]`)
  ));

  const primaryFactBytes = afterPrimaryFacts.mainDatabaseBytes - beforePrimaryFacts.mainDatabaseBytes;
  const variableDetailBytes = afterVariableDetails.mainDatabaseBytes - afterPrimaryFacts.mainDatabaseBytes;
  const preFaultHighWaterBytes = Math.max(
    beforePrimaryFacts.treeBytes,
    afterPrimaryFacts.treeBytes,
    afterVariableDetails.treeBytes,
    finalBeforeFault.treeBytes,
    ...observedTrees,
  );
  const fixedTreeBytes = preFaultHighWaterBytes - primaryFactBytes - variableDetailBytes;
  const observedHighWaterBytes = preFaultHighWaterBytes;
  const prewriteHighWaterBytes = Math.max(0, ...projectedPrewrites);
  const conservativeHighWaterBytes = Math.max(observedHighWaterBytes, prewriteHighWaterBytes);
  const errors = [];
  const orderedSnapshots = [beforePrimaryFacts, afterPrimaryFacts, afterVariableDetails, finalBeforeFault];
  if (details * 10 !== rows) errors.push('detailRows must equal one tenth of baselineRows');
  if (observedTrees.length === 0) errors.push('observed proof-tree measurements are missing');
  if (projectedPrewrites.length === 0) errors.push('prewrite proof-tree projections are missing');
  for (const snapshot of orderedSnapshots) {
    if (snapshot.mainDatabaseBytes > snapshot.treeBytes) errors.push(`${snapshot.label} main database-family exceeds its proof tree`);
    if (snapshot.mainFileBytes > snapshot.mainDatabaseBytes) errors.push(`${snapshot.label} main file exceeds its database family`);
  }
  for (let index = 1; index < orderedSnapshots.length; index++) {
    if (orderedSnapshots[index].treeBytes < orderedSnapshots[index - 1].treeBytes) {
      errors.push(`${orderedSnapshots[index].label} tree bytes moved backwards`);
    }
  }
  if (primaryFactBytes <= 0) errors.push('primary fact database-family increment was not positive');
  if (variableDetailBytes <= 0) errors.push('variable detail database-family increment was not positive');
  if (finalBeforeFault.mainDatabaseBytes < afterVariableDetails.mainDatabaseBytes) {
    errors.push('final main database-family bytes moved backwards after variable detail capture');
  }
  if (fixedTreeBytes < 0) errors.push('fixed tree bytes would require offsetting a variable component');
  if (finalBeforeFault.mainFileBytes <= 0) errors.push('final main database file was not measured');

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    units: 'bytes',
    faultModel: 'in-place-terminal-corruption',
    baselineRows: rows,
    detailRows: details,
    snapshots: {
      beforePrimaryFacts,
      afterPrimaryFacts,
      afterVariableDetails,
      finalBeforeFault,
    },
    observedTreeBytes: observedTrees,
    components: {
      primaryFactBytes,
      variableDetailBytes,
      fixedTreeBytes,
      finalMainDatabaseBytes: finalBeforeFault.mainDatabaseBytes,
      finalMainFileBytes: finalBeforeFault.mainFileBytes,
      preFaultHighWaterBytes,
    },
    prewriteProjectedTreeBytes: projectedPrewrites,
    observedHighWaterBytes,
    prewriteHighWaterBytes,
    conservativeHighWaterBytes,
    eligible: errors.length === 0,
    errors,
  };
}

export function validateCapacityCalibration(calibration, { baselineRows, detailRows }) {
  const errors = [];
  if (!calibration || typeof calibration !== 'object') {
    const missing = ['capacity calibration is missing'];
    return { valid: false, errors: missing, reason: missing.join('; ') };
  }
  if (calibration.schemaVersion !== CALIBRATION_SCHEMA_VERSION) errors.push('capacity calibration schema version is unsupported');
  if (calibration.units !== 'bytes') errors.push('capacity calibration units must be bytes');
  if (calibration.faultModel !== 'in-place-terminal-corruption') errors.push('capacity calibration fault model is unsupported');
  if (calibration.baselineRows !== baselineRows) errors.push('capacity calibration baseline row count does not match');
  if (calibration.detailRows !== detailRows) errors.push('capacity calibration detail row count does not match');

  try {
    const rebuilt = buildCapacityCalibration({
      baselineRows,
      detailRows,
      snapshots: calibration.snapshots,
      observedTreeBytes: calibration.observedTreeBytes,
      prewriteProjectedTreeBytes: calibration.prewriteProjectedTreeBytes,
    });
    if (!rebuilt.eligible) errors.push(...rebuilt.errors);
    for (const [name, value] of Object.entries(rebuilt.components)) {
      if (calibration.components?.[name] !== value) errors.push(`capacity calibration component ${name} is inconsistent`);
    }
    if (calibration.observedHighWaterBytes !== rebuilt.observedHighWaterBytes) {
      errors.push('capacity calibration observed high-water value is inconsistent');
    }
    if (calibration.prewriteHighWaterBytes !== rebuilt.prewriteHighWaterBytes) {
      errors.push('capacity calibration prewrite high-water value is inconsistent');
    }
    if (calibration.conservativeHighWaterBytes !== rebuilt.conservativeHighWaterBytes) {
      errors.push('capacity calibration conservative high-water value is inconsistent');
    }
    if (calibration.eligible !== rebuilt.eligible) errors.push('capacity calibration eligibility is inconsistent');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, errors, reason: errors.length > 0 ? errors.join('; ') : undefined };
}

export function projectCapacityFromCalibration(calibration, { targetRows, safetyFactor }) {
  const rows = requirePositiveInteger(targetRows, 'targetRows');
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) throw new Error('safetyFactor must be a finite number >= 1');
  const validation = validateCapacityCalibration(calibration, {
    baselineRows: calibration?.baselineRows,
    detailRows: calibration?.detailRows,
  });
  if (!validation.valid) throw new Error(`capacity calibration is invalid: ${validation.errors.join('; ')}`);
  if (rows < calibration.baselineRows || rows % calibration.baselineRows !== 0) {
    throw new Error('targetRows must be an integer multiple of baselineRows and cannot be smaller');
  }

  const rowRatio = rows / calibration.baselineRows;
  const primaryFactBytes = Math.ceil(calibration.components.primaryFactBytes * rowRatio * safetyFactor);
  const variableDetailBytes = Math.ceil(calibration.components.variableDetailBytes * rowRatio * safetyFactor);
  const projectedSteadyTreeBytes = calibration.components.fixedTreeBytes + primaryFactBytes + variableDetailBytes;
  const projectedMainDatabaseBytes = Math.ceil(
    calibration.components.finalMainDatabaseBytes * rowRatio * safetyFactor,
  );
  const projectedFaultPeakBytes = Math.max(projectedSteadyTreeBytes, projectedMainDatabaseBytes);
  return {
    units: 'bytes',
    faultModel: calibration.faultModel,
    targetRows: rows,
    rowRatio,
    safetyFactor,
    components: {
      fixedTreeBytes: calibration.components.fixedTreeBytes,
      primaryFactBytes,
      variableDetailBytes,
      projectedMainDatabaseBytes,
    },
    projectedSteadyTreeBytes,
    projectedFaultPeakBytes,
    projectedPeakBytes: Math.max(
      calibration.conservativeHighWaterBytes,
      projectedSteadyTreeBytes,
      projectedFaultPeakBytes,
    ),
  };
}
