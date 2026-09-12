import { validateWindowsProcessEvidence } from './windows-process-handle-collector.mjs';

export const MIXED_FULL_PLAN = Object.freeze({
  mode: 'full',
  fixtureRows: 10_000,
  hostCount: 4,
  paced: Object.freeze({ ratePerSecond: 50, sampleCount: 10_000 }),
  burst: Object.freeze({ ratePerSecond: 1_000, durationMs: 5_000, sampleCount: 5_000 }),
  broadScanCount: 1,
  indexedLookupCount: 10,
  detailRangeCount: 1,
  refreshReadCount: 2,
  saturationQueryCount: 4,
  saturationMaxConcurrentQueries: 2,
  saturationQueueCapacity: 1,
});

export const MIXED_SMOKE_PLAN = Object.freeze({
  mode: 'smoke',
  fixtureRows: 50,
  hostCount: 1,
  paced: Object.freeze({ ratePerSecond: 20, sampleCount: 20 }),
  burst: Object.freeze({ ratePerSecond: 100, durationMs: 200, sampleCount: 20 }),
  broadScanCount: 1,
  indexedLookupCount: 10,
  detailRangeCount: 1,
  refreshReadCount: 2,
  saturationQueryCount: 4,
  saturationMaxConcurrentQueries: 2,
  saturationQueueCapacity: 1,
});

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const MIN_RECORDER_HEAP_PROBE_MB = 64;
const MAX_RECORDER_HEAP_PROBE_MB = 512;

function isSupportedRecorderHeapProbe(value) {
  return Number.isSafeInteger(value)
    && value >= MIN_RECORDER_HEAP_PROBE_MB
    && value <= MAX_RECORDER_HEAP_PROBE_MB;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDecimalInteger(value) {
  return (typeof value === 'string' && /^\d+$/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function requireTimingSamples(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty timing array`);
  for (const [index, value] of values.entries()) {
    if (!isFiniteNonNegative(value)) throw new Error(`${label}[${index}] must be finite and non-negative`);
  }
  return [...values].sort((a, b) => a - b);
}

/** Summarize individual indexed lookup timings. Deliberately emits median and
 * maximum only; a pooled p99 would hide the per-query distribution and is not
 * a declared mixed-load gate. */
export function summarizeMixedTimingSamples(values) {
  const sorted = requireTimingSamples(values, 'mixed timing samples');
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    samples: sorted.length,
    medianMs,
    maxMs: sorted.at(-1),
  };
}

function validIdentityArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((worker) => {
    const identity = worker?.identity ?? worker;
    return typeof identity?.instanceId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity.instanceId)
      && Number.isSafeInteger(identity.pid) && identity.pid > 0
      && Number.isSafeInteger(identity.spawnedAtMs) && identity.spawnedAtMs > 0;
  });
}

function validIdentity(identity) {
  return typeof identity?.instanceId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity.instanceId)
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && Number.isSafeInteger(identity.spawnedAtMs) && identity.spawnedAtMs > 0;
}

function validQueryWorkerTelemetry(telemetry, identity) {
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)
    || !validIdentity(telemetry.workerIdentity)
    || telemetry.workerIdentity.instanceId !== identity.instanceId
    || telemetry.workerIdentity.pid !== identity.pid
    || telemetry.workerIdentity.spawnedAtMs !== identity.spawnedAtMs
    || !['after-result-serialization', 'after-error-message-formatting'].includes(telemetry.runtimeSamplePhase)
    || !isSafeNonNegativeInteger(telemetry.maxRssBytes) || telemetry.maxRssBytes <= 0
    || !isSafeNonNegativeInteger(telemetry.userCpuTimeMicros)
    || !isSafeNonNegativeInteger(telemetry.systemCpuTimeMicros)
    || !telemetry.currentMemory || typeof telemetry.currentMemory !== 'object'
    || Array.isArray(telemetry.currentMemory)) return false;
  for (const field of ['rssBytes', 'heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes']) {
    if (!isSafeNonNegativeInteger(telemetry.currentMemory[field])) return false;
  }
  return telemetry.currentMemory.rssBytes > 0;
}

function validSnapshot(snapshot) {
  return snapshot && typeof snapshot === 'object'
    && Number.isSafeInteger(snapshot.activeQueries) && snapshot.activeQueries >= 0
    && Number.isSafeInteger(snapshot.queuedQueries) && snapshot.queuedQueries >= 0
    && Number.isSafeInteger(snapshot.maxConcurrentQueries) && snapshot.maxConcurrentQueries > 0
    && Number.isSafeInteger(snapshot.maxQueuedQueries) && snapshot.maxQueuedQueries >= 0
    && snapshot.activeQueries <= snapshot.maxConcurrentQueries
    && snapshot.queuedQueries <= snapshot.maxQueuedQueries;
}

/** Grouped lifecycle receipts are the persisted authority for mixed evidence.
 * Validation recomputes request completion, worker coverage, queue capacity,
 * and ordered transitions from these receipts; a transient boolean cannot
 * make an incomplete run qualify. */
export function validateQueryLifecycleReceipts(receipts, { expected } = {}) {
  const errors = [];
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { valid: false, errors: ['query lifecycle receipts are missing'], workerIdentities: [], summary: null };
  }
  const expectedCounts = {
    query: (expected?.broadScanCount ?? 0) + (expected?.indexedLookupCount ?? 0),
    detail: expected?.detailRangeCount ?? 0,
    providerSettlements: expected?.refreshReadCount ?? 0,
    qualificationSpin: expected?.saturationQueryCount ?? 0,
  };
  const counts = new Map();
  const seenRequests = new Set();
  const workerIdentities = [];
  let queryWorkerTelemetryAvailableCount = 0;
  let queryWorkerTelemetryUnavailableCancelledCount = 0;
  let queryWorkerTelemetryUnavailableCount = 0;
  let queryWorkerTelemetryInvalidCount = 0;
  const saturation = [];
  const addError = (message) => errors.push(message);
  for (const [index, receipt] of receipts.entries()) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || !Array.isArray(receipt.events) || receipt.events.length === 0
      || typeof receipt.clientId !== 'string' || receipt.clientId.length === 0
      || !Number.isSafeInteger(receipt.requestId) || receipt.requestId <= 0) {
      addError(`query lifecycle receipt[${index}] has an invalid identity or event list`);
      continue;
    }
    const requestKey = `${receipt.clientId}:${receipt.requestId}`;
    if (seenRequests.has(requestKey)) addError(`query lifecycle request is duplicated: ${requestKey}`);
    seenRequests.add(requestKey);
    const requestType = receipt.events[0]?.requestType;
    if (!['query', 'detail', 'providerSettlements', 'qualificationSpin'].includes(requestType)) {
      addError(`query lifecycle receipt[${index}] request type is invalid`);
    } else {
      counts.set(requestType, (counts.get(requestType) ?? 0) + 1);
      if (requestType === 'qualificationSpin') saturation.push(receipt);
    }
    const phases = [];
    let workerIdentity;
    for (const [eventIndex, event] of receipt.events.entries()) {
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || event.clientId !== receipt.clientId || event.requestId !== receipt.requestId
        || event.requestType !== requestType || typeof event.phase !== 'string'
        || !validSnapshot(event.snapshot)) {
        addError(`query lifecycle ${requestKey} event[${eventIndex}] is malformed or out of scope`);
        continue;
      }
      phases.push(event.phase);
      if (event.identity !== undefined) {
        if (!['spawned', 'ready', 'terminal'].includes(event.phase) || !validIdentity(event.identity)) {
          addError(`query lifecycle ${requestKey} event[${eventIndex}] has an invalid worker identity`);
        } else if (event.phase === 'spawned') {
          workerIdentity = event.identity;
        } else if (workerIdentity && (workerIdentity.instanceId !== event.identity.instanceId
          || workerIdentity.pid !== event.identity.pid || workerIdentity.spawnedAtMs !== event.identity.spawnedAtMs)) {
          addError(`query lifecycle ${requestKey} worker identity changed`);
        }
      } else if (['spawned', 'ready', 'terminal'].includes(event.phase)) {
        addError(`query lifecycle ${requestKey} ${event.phase} event has no worker identity`);
      }
      if (event.phase === 'terminal') {
        const hasCode = Number.isSafeInteger(event.code) && event.code >= 0;
        const hasSignal = typeof event.signal === 'string' && event.signal.length > 0;
        if (hasCode === hasSignal) addError(`query lifecycle ${requestKey} terminal result is invalid`);
        const telemetryStatuses = [
          'available',
          'unavailable-cancelled',
          'unavailable-terminated',
          'unavailable-missing',
          'unavailable-invalid',
          'unavailable-runtime',
        ];
        if (event.telemetryStatus !== undefined) {
          if (!telemetryStatuses.includes(event.telemetryStatus)) {
            addError(`query lifecycle ${requestKey} terminal telemetry status is invalid`);
          } else if (event.telemetryStatus === 'available') {
            if (!workerIdentity || !validQueryWorkerTelemetry(event.telemetry, workerIdentity)) {
              addError(`query lifecycle ${requestKey} terminal telemetry is invalid or identity-mismatched`);
              queryWorkerTelemetryInvalidCount += 1;
            } else {
              queryWorkerTelemetryAvailableCount += 1;
            }
          } else {
            if (event.telemetry !== null) {
              addError(`query lifecycle ${requestKey} unavailable telemetry must be null`);
              queryWorkerTelemetryInvalidCount += 1;
            } else if (event.telemetryStatus === 'unavailable-cancelled') {
              queryWorkerTelemetryUnavailableCancelledCount += 1;
              queryWorkerTelemetryUnavailableCount += 1;
            } else {
              queryWorkerTelemetryUnavailableCount += 1;
            }
          }
        } else if (event.telemetry !== undefined) {
          addError(`query lifecycle ${requestKey} terminal telemetry status is missing`);
          queryWorkerTelemetryInvalidCount += 1;
        }
      }
    }
    if (phases[0] !== 'submitted' || phases.at(-1) !== 'settled') {
      addError(`query lifecycle ${requestKey} must start submitted and end settled`);
      continue;
    }
    const settled = receipt.events.at(-1);
    if (!['resolved', 'rejected'].includes(settled.outcome)) addError(`query lifecycle ${requestKey} settlement outcome is missing`);
    const hasQueued = phases.includes('queued');
    const hasAdmitted = phases.includes('admitted');
    const hasSpawned = phases.includes('spawned');
    const hasReady = phases.includes('ready');
    const hasTerminal = phases.includes('terminal');
    const expectedPhases = hasSpawned
      ? ['submitted', ...(hasQueued ? ['queued'] : []), 'admitted', 'spawned', 'ready', 'terminal', 'settled']
      : phases.includes('capacity-rejected')
        ? ['submitted', 'capacity-rejected', 'settled']
        : ['submitted', ...(hasQueued ? ['queued'] : []), ...(phases.includes('cancelled-before-start') ? ['cancelled-before-start'] : []), 'settled'];
    if (JSON.stringify(phases) !== JSON.stringify(expectedPhases)) {
      addError(`query lifecycle ${requestKey} has invalid ordered phases`);
    }
    if (hasSpawned !== hasAdmitted || hasSpawned !== hasReady || hasSpawned !== hasTerminal) {
      addError(`query lifecycle ${requestKey} has incomplete admission/worker coverage`);
    }
    if (phases.includes('capacity-rejected') && settled.outcome !== 'rejected') {
      addError(`query lifecycle ${requestKey} capacity rejection did not settle rejected`);
    }
    if (requestType === 'qualificationSpin' && settled.outcome !== 'rejected') {
      addError(`query lifecycle ${requestKey} saturation request did not settle rejected`);
    }
    if (requestType !== 'qualificationSpin' && settled.outcome !== 'resolved') {
      addError(`query lifecycle ${requestKey} ordinary request did not settle resolved`);
    }
    const admittedEvent = receipt.events.find((event) => event.phase === 'admitted');
    if (admittedEvent && !['active', 'queued'].includes(admittedEvent.admission)) {
      addError(`query lifecycle ${requestKey} admission kind is missing`);
    }
    if (settled.outcome === 'resolved' && !hasTerminal) {
      addError(`query lifecycle ${requestKey} resolved without a terminal worker`);
    }
    if (workerIdentity) workerIdentities.push(workerIdentity);
  }
  for (const [requestType, expectedCount] of Object.entries(expectedCounts)) {
    if ((counts.get(requestType) ?? 0) !== expectedCount) {
      addError(`query lifecycle ${requestType} receipt count must be ${expectedCount}`);
    }
  }
  const workerIdentityKeys = new Set();
  for (const identity of workerIdentities) {
    const key = `${identity.instanceId}:${identity.pid}:${identity.spawnedAtMs}`;
    if (workerIdentityKeys.has(key)) addError(`query lifecycle worker identity is duplicated: ${identity.instanceId}`);
    workerIdentityKeys.add(key);
  }
  const allSnapshots = receipts.flatMap((receipt) => receipt.events.map((event) => event.snapshot).filter(Boolean));
  const maxConcurrent = new Set(saturation.flatMap((receipt) => receipt.events.map((event) => event.snapshot.maxConcurrentQueries)));
  const maxQueued = new Set(saturation.flatMap((receipt) => receipt.events.map((event) => event.snapshot.maxQueuedQueries)));
  const observedMaxActiveWorkers = Math.max(0, ...saturation.flatMap((receipt) => receipt.events.map((event) => event.snapshot.activeQueries)));
  const observedMaxQueuedQueries = Math.max(0, ...saturation.flatMap((receipt) => receipt.events.map((event) => event.snapshot.queuedQueries)));
  const capacityRejected = saturation.filter((receipt) => receipt.events.some((event) => event.phase === 'capacity-rejected')).length;
  const queuedCancelled = saturation.filter((receipt) => receipt.events.some((event) => event.phase === 'cancelled-before-start')).length;
  const saturationSettled = saturation.filter((receipt) => receipt.events.at(-1)?.phase === 'settled').length;
  const saturationRejected = saturation.filter((receipt) => receipt.events.at(-1)?.outcome === 'rejected').length;
  const saturationResolved = saturation.filter((receipt) => receipt.events.at(-1)?.outcome === 'resolved').length;
  if (maxConcurrent.size !== 1 || [...maxConcurrent][0] !== expected?.saturationMaxConcurrentQueries) {
    addError('saturation lifecycle does not preserve its configured concurrency capacity');
  }
  if (maxQueued.size !== 1 || [...maxQueued][0] !== expected?.saturationQueueCapacity) {
    addError('saturation lifecycle does not preserve its configured queue capacity');
  }
  const expectedCapacityRejected = (expected?.saturationQueryCount ?? 0)
    - (expected?.saturationMaxConcurrentQueries ?? 0) - (expected?.saturationQueueCapacity ?? 0);
  if (capacityRejected !== expectedCapacityRejected || queuedCancelled !== expected?.saturationQueueCapacity) {
    addError('saturation lifecycle does not show the expected capacity rejection and queued cancellation');
  }
  if (allSnapshots.some((snapshot) => snapshot.activeQueries > snapshot.maxConcurrentQueries
    || snapshot.queuedQueries > snapshot.maxQueuedQueries)) {
    addError('query lifecycle contains an admission snapshot beyond its configured capacity');
  }
  return {
    valid: errors.length === 0,
    errors,
    workerIdentities,
    summary: {
      requestCount: receipts.length,
      workerCount: workerIdentities.length,
      observedMaxActiveWorkers,
      observedMaxQueuedQueries,
      capacityRejected,
      queuedCancelled,
      saturationSettled,
      saturationRejected,
      saturationResolved,
      queryWorkerTelemetry: {
        availableCount: queryWorkerTelemetryAvailableCount,
        unavailableCancelledCount: queryWorkerTelemetryUnavailableCancelledCount,
        unavailableCount: queryWorkerTelemetryUnavailableCount,
        invalidCount: queryWorkerTelemetryInvalidCount,
        complete: workerIdentities.length > 0
          && queryWorkerTelemetryAvailableCount === workerIdentities.length
          && queryWorkerTelemetryUnavailableCount === 0
          && queryWorkerTelemetryInvalidCount === 0,
      },
    },
  };
}

/** Validate the bounded mixed workload result. Functional evidence is kept
 * separate from memory qualification. Query-worker terminal samples are
 * validated when present, while cancellation gaps keep whole-topology memory
 * explicitly unqualified. */
export function validateMixedEvidence(mixed, { mode = 'full', recorderHeapProbeMb } = {}) {
  const errors = [];
  const memoryErrors = [];
  const expected = mode === 'smoke' ? MIXED_SMOKE_PLAN : MIXED_FULL_PLAN;
  if (!mixed || typeof mixed !== 'object' || Array.isArray(mixed)) {
    return { valid: false, errors: ['mixed results are missing'], memoryValid: false, memoryErrors: ['mixed results are missing'] };
  }
  if (mixed.mode !== mode) errors.push(`mixed mode must be ${mode}`);
  if (mixed.complete === false || mixed.partial === true) {
    errors.push('mixed evidence is explicitly incomplete and cannot qualify');
  }
  if (mixed.fixtureRows !== expected.fixtureRows) errors.push(`mixed fixture rows must be ${expected.fixtureRows}`);
  if (mixed.hostCount !== expected.hostCount) errors.push(`mixed host count must be ${expected.hostCount}`);
  if (recorderHeapProbeMb !== undefined) {
    if (mode !== 'full') errors.push('recorder heap probes are valid only for full mixed load');
    if (!isSupportedRecorderHeapProbe(recorderHeapProbeMb)) {
      errors.push(`recorder heap probe must be a safe integer from ${MIN_RECORDER_HEAP_PROBE_MB} to ${MAX_RECORDER_HEAP_PROBE_MB} MiB`);
    }
    if (mixed.productionDefaultRecorderHeap !== false) errors.push('full mixed heap probe must be marked qualification-only');
    if (mixed.recorderHeapMode !== 'qualification-only-probe') errors.push('mixed heap probe mode is not marked qualification-only');
    if (mixed.recorderHeapCeilingMb !== recorderHeapProbeMb) errors.push('mixed heap probe value does not match the recorded recorder heap ceiling');
  } else if (mixed.productionDefaultRecorderHeap !== true && mode === 'full') {
    errors.push('full mixed load must use the production-default recorder heap');
  }

  const expectedAcceptedRows = expected.fixtureRows + expected.paced.sampleCount + expected.burst.sampleCount;
  if (mixed.acceptedRows !== expectedAcceptedRows) errors.push(`accepted rows must be ${expectedAcceptedRows}`);
  if (!isSafeNonNegativeInteger(mixed.acceptedBytes) || mixed.acceptedBytes <= 0) errors.push('accepted bytes must be a positive safe integer');
  if (mixed.endingBacklogRecords !== 0 || mixed.endingBacklogBytes !== 0) errors.push('mixed ending backlog must be empty');

  const dailyProjection = mixed.dailyProjection;
  const beforeProjection = dailyProjection?.beforePaced;
  const afterProjection = dailyProjection?.afterBurst;
  if (dailyProjection?.writerPrepared !== true
    || dailyProjection.preparedBeforePacedAndBurst !== true
    || dailyProjection.timeZone !== 'UTC'
    || !Number.isSafeInteger(dailyProjection.todayStartMs)
    || !Number.isSafeInteger(dailyProjection.windowStartMs)
    || !Number.isSafeInteger(dailyProjection.windowEndMs)
    || dailyProjection.windowStartMs >= dailyProjection.todayStartMs
    || dailyProjection.todayStartMs >= dailyProjection.windowEndMs
    || dailyProjection.todayStartMs - dailyProjection.windowStartMs !== 6 * 86_400_000
    || dailyProjection.windowEndMs - dailyProjection.todayStartMs !== 86_400_000) {
    errors.push('mixed daily projection writer preparation/window evidence is missing');
  }
  if (!beforeProjection || !afterProjection
    || !isDecimalInteger(beforeProjection.sourceProviderSettlementRows)
    || !isDecimalInteger(beforeProjection.dailyOccurrenceCount)
    || !isDecimalInteger(beforeProjection.todayOccurrenceCount)
    || !isDecimalInteger(beforeProjection.weekOccurrenceCount)
    || !isDecimalInteger(beforeProjection.todayInputTokens)
    || !isDecimalInteger(beforeProjection.weekInputTokens)
    || !isDecimalInteger(afterProjection.sourceProviderSettlementRows)
    || !isDecimalInteger(afterProjection.dailyOccurrenceCount)
    || !isDecimalInteger(afterProjection.todayOccurrenceCount)
    || !isDecimalInteger(afterProjection.weekOccurrenceCount)
    || !isDecimalInteger(afterProjection.todayInputTokens)
    || !isDecimalInteger(afterProjection.weekInputTokens)
    || BigInt(String(beforeProjection.dailyOccurrenceCount)) <= 0n
    || BigInt(String(afterProjection.dailyOccurrenceCount)) <= BigInt(String(beforeProjection.dailyOccurrenceCount))
    || String(beforeProjection.sourceProviderSettlementRows) !== String(beforeProjection.dailyOccurrenceCount)
    || String(afterProjection.sourceProviderSettlementRows) !== String(afterProjection.dailyOccurrenceCount)
    || String(beforeProjection.todayOccurrenceCount) !== String(beforeProjection.dailyOccurrenceCount)
    || String(afterProjection.todayOccurrenceCount) !== String(afterProjection.dailyOccurrenceCount)
    || String(beforeProjection.todayOccurrenceCount) !== String(beforeProjection.weekOccurrenceCount)
    || String(afterProjection.todayOccurrenceCount) !== String(afterProjection.weekOccurrenceCount)
    || BigInt(String(beforeProjection.todayInputTokens)) <= 0n
    || BigInt(String(afterProjection.todayInputTokens)) <= BigInt(String(beforeProjection.todayInputTokens))
    || String(beforeProjection.todayInputTokens) !== String(beforeProjection.weekInputTokens)
    || String(afterProjection.todayInputTokens) !== String(afterProjection.weekInputTokens)
    || !isSafeNonNegativeInteger(beforeProjection.dailyRows) || beforeProjection.dailyRows <= 0
    || !isSafeNonNegativeInteger(afterProjection.dailyRows) || afterProjection.dailyRows <= 0) {
    errors.push('mixed daily projection evidence must show dated rows and an increased paced/burst occurrence count');
  }

  const paced = mixed.pacedIngest;
  if (!paced || paced.sampleCount !== expected.paced.sampleCount || paced.ratePerSecond !== expected.paced.ratePerSecond) {
    errors.push('paced ingest does not match the declared plan');
  }
  if (!isFiniteNonNegative(paced?.submissionElapsedMs) || paced.submissionElapsedMs <= 0) errors.push('paced ingest elapsed time is missing');
  const derivedPacedRate = isFiniteNonNegative(paced?.submissionElapsedMs) && paced.submissionElapsedMs > 0
    ? paced.sampleCount / (paced.submissionElapsedMs / 1_000) : Number.NaN;
  const pacedTolerance = mode === 'smoke' ? 0.15 : 0.05;
  if (!Number.isFinite(derivedPacedRate) || Math.abs(derivedPacedRate - expected.paced.ratePerSecond) / expected.paced.ratePerSecond > pacedTolerance) {
    errors.push(`paced offered rate is outside the ${pacedTolerance * 100}% bounded tolerance`);
  }

  const burst = mixed.burstIngest;
  if (!burst || burst.sampleCount !== expected.burst.sampleCount || burst.ratePerSecond !== expected.burst.ratePerSecond
    || burst.targetDurationMs !== expected.burst.durationMs) {
    errors.push('burst ingest does not match the declared plan');
  }
  if (!isFiniteNonNegative(burst?.submissionElapsedMs) || burst.submissionElapsedMs <= 0) {
    errors.push('burst submission elapsed time is missing');
  }
  const derivedBurstRate = isFiniteNonNegative(burst?.submissionElapsedMs) && burst.submissionElapsedMs > 0
    ? burst.sampleCount / (burst.submissionElapsedMs / 1_000) : Number.NaN;
  const burstTolerance = mode === 'smoke' ? 0.2 : 0.1;
  const burstDurationTolerance = mode === 'smoke' ? 0.25 : 0.1;
  if (!Number.isFinite(burst?.targetDurationMs) || burst.targetDurationMs <= 0
    || !Number.isFinite(burst?.submissionElapsedMs)
    || Math.abs(burst.submissionElapsedMs - burst.targetDurationMs) / burst.targetDurationMs > burstDurationTolerance) {
    errors.push(`burst submission duration is outside the ${burstDurationTolerance * 100}% bounded tolerance`);
  }
  if (!Number.isFinite(derivedBurstRate)
    || Math.abs(derivedBurstRate - expected.burst.ratePerSecond) / expected.burst.ratePerSecond > burstTolerance
    || !isFiniteNonNegative(burst?.offeredRatePerSecond)
    || Math.abs(burst.offeredRatePerSecond - derivedBurstRate) / expected.burst.ratePerSecond > 0.01) {
    errors.push(`burst offered rate is outside the ${burstTolerance * 100}% bounded tolerance or is not derived from submission timing`);
  }
  if (!isFiniteNonNegative(burst?.elapsedMs) || burst.elapsedMs <= 0) errors.push('burst elapsed time is missing');

  if (mixed.broadScan?.completed !== true || mixed.broadScan.count !== expected.broadScanCount || mixed.broadScan.returnedRows <= 0) {
    errors.push('one bounded broad scan was not completed with rows');
  }
  const indexed = mixed.indexedLookups;
  if (indexed?.count !== expected.indexedLookupCount || !Array.isArray(indexed?.timingsMs)
    || indexed.timingsMs.length !== expected.indexedLookupCount) {
    errors.push(`indexed lookup timings must contain ${expected.indexedLookupCount} individual samples`);
  } else {
    try {
      const summary = summarizeMixedTimingSamples(indexed.timingsMs);
      if (indexed.summary?.samples !== summary.samples
        || indexed.summary?.medianMs !== summary.medianMs
        || indexed.summary?.maxMs !== summary.maxMs) {
        errors.push('indexed lookup summary does not match the individual timings');
      }
      if (Object.hasOwn(indexed.summary ?? {}, 'p99Ms') || Object.hasOwn(indexed, 'p99Ms')) {
        errors.push('mixed indexed lookup evidence must not report pooled p99');
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const saturation = mixed.querySaturation;
  const lifecycle = mixed.terminalWorkers?.queryLifecycle;
  const lifecycleValidation = validateQueryLifecycleReceipts(lifecycle, { expected });
  if (!lifecycleValidation.valid) {
    errors.push(...lifecycleValidation.errors.map((error) => `query lifecycle: ${error}`));
  }
  const lifecycleWorkers = lifecycleValidation.workerIdentities;
  const reportedWorkers = mixed.terminalWorkers?.query;
  const reportedWorkerKeys = Array.isArray(reportedWorkers)
    ? reportedWorkers.map((worker) => worker?.identity ?? worker).filter(validIdentity)
      .map((identity) => `${identity.instanceId}:${identity.pid}:${identity.spawnedAtMs}`)
    : [];
  const lifecycleWorkerKeys = lifecycleWorkers.map((identity) => `${identity.instanceId}:${identity.pid}:${identity.spawnedAtMs}`);
  if (JSON.stringify([...reportedWorkerKeys].sort()) !== JSON.stringify([...lifecycleWorkerKeys].sort())) {
    errors.push('reported query worker identities do not match persisted lifecycle receipts');
  }
  if (mixed.nativeProcessTelemetry !== undefined) {
    const nativeValidation = validateWindowsProcessEvidence(mixed.nativeProcessTelemetry, lifecycleWorkers);
    if (!nativeValidation.valid) {
      errors.push(...nativeValidation.errors.map((error) => `native process telemetry: ${error}`));
    }
  }
  if (saturation?.requested !== expected.saturationQueryCount
    || saturation.maxConcurrentQueries !== expected.saturationMaxConcurrentQueries
    || saturation.maxQueuedQueries !== expected.saturationQueueCapacity
    || !Number.isSafeInteger(saturation.observedMaxActiveWorkers) || saturation.observedMaxActiveWorkers !== lifecycleValidation.summary?.observedMaxActiveWorkers
    || !Number.isSafeInteger(saturation.observedMaxQueuedQueries) || saturation.observedMaxQueuedQueries !== lifecycleValidation.summary?.observedMaxQueuedQueries
    || saturation.queueCapacityReached !== (lifecycleValidation.summary?.observedMaxQueuedQueries > 0)
    || !Number.isSafeInteger(saturation.capacityRejected) || saturation.capacityRejected !== lifecycleValidation.summary?.capacityRejected
    || saturation.workerLifecycleComplete !== lifecycleValidation.valid
    || saturation.completed !== (lifecycleValidation.summary?.saturationSettled === expected.saturationQueryCount)
    || saturation.rejected !== lifecycleValidation.summary?.saturationRejected
    || saturation.resolved !== lifecycleValidation.summary?.saturationResolved
    || saturation.unsettled !== expected.saturationQueryCount - (lifecycleValidation.summary?.saturationSettled ?? 0)) {
    errors.push('query saturation cancellation did not reach its observed queue capacity with validated worker lifecycle');
  }
  const refresh = mixed.nonWritingRefresh;
  if (refresh?.completed !== true || refresh.readerWriting !== false
    || refresh.afterCommitVisible !== true || refresh.afterDeleteVisible !== false) {
    errors.push('non-writing refresh did not observe commit and delete boundaries');
  }
  if (mixed.fullReconstruction?.verified !== true || mixed.fullReconstruction?.payloadBytes <= 0) {
    errors.push('full detail reconstruction was not verified');
  }

  const artifacts = mixed.candidateArtifacts;
  if (artifacts?.provenanceValid !== true || typeof artifacts?.gitHead !== 'string'
    || !/^[0-9a-f]{40}$/iu.test(artifacts.gitHead)
    || typeof artifacts?.coordinatedBuildId !== 'string'
    || typeof artifacts?.fingerprint !== 'string' || !/^[0-9a-f]{64}$/iu.test(artifacts.fingerprint)
    || !artifacts.files || typeof artifacts.files !== 'object') {
    errors.push('candidate artifact provenance is incomplete');
  }
  if (mixed.terminalWorkers?.complete !== true
    || !validIdentityArray(mixed.terminalWorkers?.recorder)
    || !validIdentityArray(mixed.terminalWorkers?.query)) {
    errors.push('terminal recorder/query worker evidence is incomplete');
  }

  const topology = mixed.queryHostTopology;
  if (!topology || !isSafeNonNegativeInteger(topology.hostPeakRssBytes)
    || !isSafeNonNegativeInteger(topology.hostCpuDeltaMicros)) {
    memoryErrors.push('host RSS/CPU topology telemetry is malformed');
  }
  const queryTelemetry = lifecycleValidation.summary?.queryWorkerTelemetry;
  if (topology?.queryWorkerTelemetryAvailable === true) {
    if (!isSafeNonNegativeInteger(topology.queryWorkerRssBytes) || topology.queryWorkerRssBytes <= 0
      || !isSafeNonNegativeInteger(topology.queryWorkerCpuDeltaMicros)
      || !queryTelemetry?.complete) {
      memoryErrors.push('query-worker RSS/CPU telemetry is incomplete; whole-topology memory remains unqualified');
    }
  } else {
    if (topology?.queryWorkerRssBytes !== null
      || topology?.queryWorkerCpuDeltaMicros !== null
      || topology?.queryWorkerTelemetryAvailable !== false) {
      memoryErrors.push('query-worker RSS/CPU telemetry claim is malformed');
    }
    const available = Number.isSafeInteger(queryTelemetry?.availableCount) ? queryTelemetry.availableCount : 0;
    const unavailable = Number.isSafeInteger(queryTelemetry?.unavailableCount) ? queryTelemetry.unavailableCount : 0;
    const invalid = Number.isSafeInteger(queryTelemetry?.invalidCount) ? queryTelemetry.invalidCount : 0;
    const workerCount = lifecycleWorkers.length;
    const missing = Math.max(0, workerCount - available - unavailable - invalid);
    const nativeReceipts = Array.isArray(mixed.nativeProcessTelemetry?.receipts)
      ? mixed.nativeProcessTelemetry.receipts
      : [];
    const nativeAvailable = nativeReceipts.filter((receipt) => receipt?.status === 'available').length;
    const nativeCoverage = nativeReceipts.length > 0
      ? ` Native OS final-counter evidence is available for ${nativeAvailable}/${nativeReceipts.length} query workers.`
      : '';
    memoryErrors.push(`query-worker RSS/CPU high-water is incomplete: runtime terminal telemetry is available for ${available}/${workerCount} query workers; ${unavailable} unavailable, ${invalid} invalid, and ${missing} missing runtime sample(s).${nativeCoverage} Whole-topology memory remains unqualified.`);
  }
  const recorderSampledHighWater = mixed.recorderMemory?.sampledHighWaterProven === true
    || mixed.recorderMemory?.peakProven === true;
  if (!recorderSampledHighWater
    || !isSafeNonNegativeInteger(mixed.recorderMemory?.maxWorkerRssBytes)
    || mixed.recorderMemory.maxWorkerRssBytes <= 0
    || !isSafeNonNegativeInteger(mixed.recorderMemory?.sampleCount)
    || mixed.recorderMemory.sampleCount < (mode === 'full' ? 2 : 1)) {
    memoryErrors.push('continuous recorder worker RSS high-water telemetry is incomplete');
  }
  return {
    valid: errors.length === 0,
    errors,
    memoryValid: memoryErrors.length === 0,
    memoryErrors,
    mode,
    expectedAcceptedRows,
  };
}
