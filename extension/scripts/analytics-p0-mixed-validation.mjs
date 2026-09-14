import { validateTerminalWorkerSummaries } from './analytics-p0-capacity.mjs';
import { validateWindowsProcessEvidence, validateWindowsProcessReceipt } from './windows-process-handle-collector.mjs';

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

export const MIXED_TOPOLOGY_SAMPLE_INTERVAL_MS = 1_000;
const MIXED_TOPOLOGY_MAX_SAMPLE_WINDOW_MS = 600_000;
export const MIXED_RECORDER_RSS_GATE_BYTES = 268_435_456;

function addSafeNonNegativeIntegers(total, value, label) {
  if (!isSafeNonNegativeInteger(total) || !isSafeNonNegativeInteger(value)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  const sum = total + value;
  if (!Number.isSafeInteger(sum)) throw new Error(`${label} overflows the safe integer range`);
  return sum;
}

/** Validate one polled worker telemetry reply's runtime identity, memory and
 * CPU counters. Exported because the qualification harness reuses it for the
 * late refresh writer's explicit runtime endpoints. */
export function requiredWorkerMemorySample(stats, label) {
  const processStats = stats?.process;
  const identity = processStats?.workerIdentity;
  if (!identity || typeof identity.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity.instanceId)
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || !Number.isSafeInteger(identity.spawnedAtMs) || identity.spawnedAtMs <= 0) {
    throw new Error(`${label}: worker identity telemetry is missing or invalid`);
  }
  const fields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
  for (const field of fields) {
    if (!Number.isSafeInteger(processStats[field]) || processStats[field] < 0) {
      throw new Error(`${label}: worker ${field} memory telemetry is missing or invalid`);
    }
  }
  if (!processStats.cpuUsage
    || !Number.isSafeInteger(processStats.cpuUsage.user) || processStats.cpuUsage.user < 0
    || !Number.isSafeInteger(processStats.cpuUsage.system) || processStats.cpuUsage.system < 0) {
    throw new Error(`${label}: worker CPU telemetry is missing or invalid`);
  }
  return {
    identity: { instanceId: identity.instanceId, pid: identity.pid, spawnedAtMs: identity.spawnedAtMs },
    rssBytes: processStats.rss,
    heapTotalBytes: processStats.heapTotal,
    heapUsedBytes: processStats.heapUsed,
    externalBytes: processStats.external,
    arrayBuffersBytes: processStats.arrayBuffers,
    cpuUsage: { user: processStats.cpuUsage.user, system: processStats.cpuUsage.system },
  };
}

/** Observer-independent periodic worker memory sampler used by the
 * qualification harness. The caller supplies the poll seam (full-stats or
 * memory-only observer request); workload, gates and teardown stay identical.
 * The phase label and start timestamp of each sample are captured BEFORE the
 * awaited poll: a phase marked while a poll is in flight belongs to the next
 * sample, and the in-flight sample keeps the exact phase it started under.
 * No sample is relabelled after the fact. */
export function startWorkerMemorySampler(hosts, label, intervalMs = 1_000, { initialPhase = 'unmarked', poll } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error(`${label}: memory sampler requires at least one host`);
  }
  if (typeof poll !== 'function') {
    throw new Error(`${label}: memory sampler requires an explicit poll observer function`);
  }
  const samples = [];
  let inFlight;
  let failure;
  let stopped = false;
  let currentPhase = initialPhase;
  const collect = async () => {
    if (failure) throw failure;
    if (inFlight) return inFlight;
    const phaseAtStart = currentPhase;
    const pollStartedAt = new Date().toISOString();
    inFlight = (async () => {
      const stats = await Promise.all(hosts.map((host) => poll(host)));
      const workers = stats.map((entry, index) => requiredWorkerMemorySample(entry, `${label} sample ${samples.length} host ${index + 1}`));
      samples.push({ pollStartedAt, observedAt: new Date().toISOString(), phase: phaseAtStart, workers });
    })().catch((error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      throw failure;
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const markPhase = (phaseLabel) => {
    if (stopped) throw new Error(`${label}: sampler phase cannot be marked after stop`);
    if (typeof phaseLabel !== 'string' || phaseLabel.length === 0 || phaseLabel.length > 64) {
      throw new Error(`${label}: sampler phase label must be a non-empty string of at most 64 characters`);
    }
    currentPhase = phaseLabel;
  };
  const summarizeSamples = () => {
    const byWorker = new Map();
    let maxWorkerRssBytes = 0;
    let maxWorkerHeapTotalBytes = 0;
    let maxWorkerHeapUsedBytes = 0;
    for (const sample of samples) {
      for (const worker of sample.workers) {
        const key = `${worker.identity.instanceId}:${worker.identity.pid}:${worker.identity.spawnedAtMs}`;
        const summary = byWorker.get(key) ?? {
          identity: worker.identity,
          role: 'recorder',
          sampleCount: 0,
          maxRssBytes: 0,
          maxHeapTotalBytes: 0,
          maxHeapUsedBytes: 0,
          maxExternalBytes: 0,
          maxArrayBuffersBytes: 0,
        };
        summary.sampleCount += 1;
        summary.maxRssBytes = Math.max(summary.maxRssBytes, worker.rssBytes);
        summary.maxHeapTotalBytes = Math.max(summary.maxHeapTotalBytes, worker.heapTotalBytes);
        summary.maxHeapUsedBytes = Math.max(summary.maxHeapUsedBytes, worker.heapUsedBytes);
        summary.maxExternalBytes = Math.max(summary.maxExternalBytes, worker.externalBytes);
        summary.maxArrayBuffersBytes = Math.max(summary.maxArrayBuffersBytes, worker.arrayBuffersBytes);
        byWorker.set(key, summary);
        maxWorkerRssBytes = Math.max(maxWorkerRssBytes, worker.rssBytes);
        maxWorkerHeapTotalBytes = Math.max(maxWorkerHeapTotalBytes, worker.heapTotalBytes);
        maxWorkerHeapUsedBytes = Math.max(maxWorkerHeapUsedBytes, worker.heapUsedBytes);
      }
    }
    const phases = [];
    for (const sample of samples) {
      const last = phases.at(-1);
      if (last && last.label === sample.phase) {
        last.sampleCount += 1;
        for (const worker of sample.workers) {
          last.maxWorkerRssBytes = Math.max(last.maxWorkerRssBytes, worker.rssBytes);
          last.maxWorkerHeapTotalBytes = Math.max(last.maxWorkerHeapTotalBytes, worker.heapTotalBytes);
          last.maxWorkerHeapUsedBytes = Math.max(last.maxWorkerHeapUsedBytes, worker.heapUsedBytes);
        }
      } else {
        phases.push({
          label: sample.phase,
          sampleCount: 1,
          maxWorkerRssBytes: Math.max(...sample.workers.map((worker) => worker.rssBytes)),
          maxWorkerHeapTotalBytes: Math.max(...sample.workers.map((worker) => worker.heapTotalBytes)),
          maxWorkerHeapUsedBytes: Math.max(...sample.workers.map((worker) => worker.heapUsedBytes)),
        });
      }
    }
    return {
      intervalMs,
      sampleCount: samples.length,
      firstPollStartedAt: samples[0]?.pollStartedAt ?? null,
      lastPollStartedAt: samples.at(-1)?.pollStartedAt ?? null,
      firstObservedAt: samples[0]?.observedAt ?? null,
      lastObservedAt: samples.at(-1)?.observedAt ?? null,
      maxWorkerRssBytes,
      maxWorkerHeapTotalBytes,
      maxWorkerHeapUsedBytes,
      phases,
      workers: [...byWorker.values()],
    };
  };
  const timer = setInterval(() => {
    if (stopped) return;
    void collect().catch(() => void 0);
  }, intervalMs);
  void collect().catch(() => void 0);
  return {
    mark: markPhase,
    snapshot() {
      const summary = summarizeSamples();
      return {
        ...summary,
        complete: !failure && summary.sampleCount > 0 && summary.workers.length === hosts.length,
        ...(failure ? { error: failure.message } : {}),
      };
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
      await collect();
      if (failure) throw failure;
      const summary = summarizeSamples();
      if (summary.sampleCount === 0 || summary.workers.length !== hosts.length) {
        throw new Error(`${label}: continuous worker memory telemetry is incomplete`);
      }
      return summary;
    },
  };
}

function workerIdentityKeyOf(identity) {
  return `${identity.instanceId}:${identity.pid}:${identity.spawnedAtMs}`;
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

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Compare the receipt against provenance computed by the owning harness.
 * Candidate evidence is only a receipt; it must not supply the expected
 * inventory, hashes, build identities or source revision used for admission. */
export function validateCandidateArtifactProvenance(candidate, expectedProvenance) {
  const errors = [];
  if (!isPlainRecord(expectedProvenance) || expectedProvenance.valid !== true) {
    errors.push('trusted expected artifact provenance is missing or invalid');
    return { valid: false, errors };
  }
  if (!isPlainRecord(candidate)) {
    return { valid: false, errors: ['candidate artifact provenance is missing'] };
  }
  if (candidate.provenanceValid !== expectedProvenance.valid) {
    errors.push('candidate provenance validity does not match the trusted harness result');
  }
  for (const field of ['gitHead', 'hostBuildId', 'rendererBuildId', 'coordinatedBuildId', 'fingerprint']) {
    if (candidate[field] !== expectedProvenance[field]) {
      errors.push(`candidate artifact ${field} does not match trusted harness provenance`);
    }
  }
  const expectedFiles = expectedProvenance.files;
  const candidateFiles = candidate.files;
  if (!isPlainRecord(expectedFiles) || !isPlainRecord(candidateFiles)) {
    errors.push('candidate artifact file inventory is missing or malformed');
  } else {
    const expectedNames = Object.keys(expectedFiles).sort();
    const candidateNames = Object.keys(candidateFiles).sort();
    if (JSON.stringify(candidateNames) !== JSON.stringify(expectedNames)) {
      errors.push('candidate artifact file inventory does not exactly match trusted harness provenance');
    }
    for (const name of expectedNames) {
      const expectedFile = expectedFiles[name];
      const candidateFile = candidateFiles[name];
      const expectedKeys = isPlainRecord(expectedFile) ? Object.keys(expectedFile).sort() : [];
      const candidateKeys = isPlainRecord(candidateFile) ? Object.keys(candidateFile).sort() : [];
      if (JSON.stringify(candidateKeys) !== JSON.stringify(expectedKeys)
        || !isPlainRecord(candidateFile)
        || candidateFile.sha256 !== expectedFile?.sha256
        || candidateFile.bytes !== expectedFile?.bytes) {
        errors.push(`candidate artifact file entry does not match trusted provenance: ${name}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

const SUPPORTED_STATS_POLL_MODES = new Set(['full-stats', 'memory-only']);

function expectedObserverRequest(statsPollMode) {
  return statsPollMode === 'memory-only' ? 'memorySample' : 'stats';
}

/** A report written before the observer-mode marker existed is admissible only
 * as the historical full-stats default. Once any marker is present, every
 * marker must be present and must describe the same request seam. Keeping this
 * check here (rather than trusting the CLI option) prevents a receipt from one
 * observer mode being re-labelled as another during report admission. */
function validateStatsPollMarkers(mixed, { statsPollMode, reportConfiguration } = {}) {
  const errors = [];
  const configurationMode = reportConfiguration?.statsPollMode;
  const markers = [
    ['report.configuration.statsPollMode', configurationMode],
    ['results.mixed.statsPollMode', mixed?.statsPollMode],
    ['recorderMemory.statsPollMode', mixed?.recorderMemory?.statsPollMode],
    ['recorderMemory.observerRequest', mixed?.recorderMemory?.observerRequest],
  ];
  const presentMarkers = markers.filter(([, value]) => value !== undefined);
  const declaredMode = statsPollMode;
  if (!SUPPORTED_STATS_POLL_MODES.has(declaredMode)) {
    errors.push(`stats poll mode is unknown: ${String(declaredMode)}`);
    return { valid: false, errors, legacyDefault: false };
  }
  if (presentMarkers.length === 0) {
    if (declaredMode !== 'full-stats') {
      errors.push(`stats poll mode markers are missing for declared ${declaredMode} evidence`);
      return { valid: false, errors, legacyDefault: false };
    }
    return { valid: true, errors, legacyDefault: true };
  }

  const modeMarkers = markers.slice(0, 3);
  for (const [label, value] of modeMarkers) {
    if (value === undefined) {
      errors.push(`${label} marker is missing; all observer-mode markers are required once mode evidence is present`);
    } else if (!SUPPORTED_STATS_POLL_MODES.has(value)) {
      errors.push(`${label} marker is unknown: ${String(value)}`);
    } else if (value !== declaredMode) {
      errors.push(`${label} marker declares ${String(value)}, but the run declares ${declaredMode}`);
    }
  }
  const observerMarker = markers[3][1];
  const observerLabel = markers[3][0];
  if (observerMarker === undefined) {
    errors.push(`${observerLabel} marker is missing; all observer-mode markers are required once mode evidence is present`);
  } else if (observerMarker !== 'stats' && observerMarker !== 'memorySample') {
    errors.push(`${observerLabel} marker is unknown: ${String(observerMarker)}`);
  } else if (observerMarker !== expectedObserverRequest(declaredMode)) {
    errors.push(`${observerLabel} marker declares ${String(observerMarker)}, but ${declaredMode} evidence requires ${expectedObserverRequest(declaredMode)}`);
  }
  return { valid: errors.length === 0, errors, legacyDefault: false };
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

/** Validate the recorder sampler's worker coverage independently from its
 * aggregate high-water claims. The aggregate contains maxima, not additive
 * worker totals: every declared recorder identity must be sampled for every
 * sampler tick and the reported maxima must be recomputed from those per-worker
 * maxima. */
function validateRecorderMemoryEvidence(mixed, expected) {
  const errors = [];
  const memory = mixed?.recorderMemory;
  const expectedWorkerCount = expected.hostCount;
  if (![1, 2, 4].includes(expectedWorkerCount)) {
    errors.push(`recorder worker topology must be one of 1, 2 or 4 workers, not ${String(expectedWorkerCount)}`);
  }

  const terminalEntries = mixed?.terminalWorkers?.recorder;
  const refreshEvidence = mixed?.recorderRefreshWorker;
  const refreshDeclared = !!(refreshEvidence && typeof refreshEvidence === 'object' && !Array.isArray(refreshEvidence));
  const refreshIdentityKey = refreshDeclared && validIdentity(refreshEvidence.identity)
    ? workerIdentityKeyOf(refreshEvidence.identity)
    : null;
  const terminalByKey = new Map();
  if (!Array.isArray(terminalEntries) || terminalEntries.length !== expectedWorkerCount + 1) {
    errors.push(`declared recorder worker identities must cover exactly ${expectedWorkerCount} main-cohort workers plus the late refresh writer (${expectedWorkerCount + 1})`);
  } else {
    // Persisted terminal states are admitted through the owning terminal
    // validator, not by identity alone: an entry without its ordered
    // spawned/ready/terminal states, or with a forged terminal code/signal
    // payload, is rejected here.
    const summaryValidation = validateTerminalWorkerSummaries(
      terminalEntries.map((entry) => ({ identity: entry?.identity ?? entry, states: entry?.states })),
    );
    if (!summaryValidation.valid) {
      errors.push(...summaryValidation.errors.map((error) => `persisted terminal state is invalid: ${error}`));
    }
    let refreshTerminalEntries = 0;
    for (const [index, entry] of terminalEntries.entries()) {
      if (entry?.role !== 'recorder') {
        errors.push(`declared recorder worker[${index}] role must be recorder`);
      }
      const identity = entry?.identity ?? entry;
      if (!validIdentity(identity)) {
        errors.push(`declared recorder worker[${index}] identity is invalid`);
        continue;
      }
      const key = workerIdentityKeyOf(identity);
      if (terminalByKey.has(key)) {
        errors.push(`declared recorder worker identity is duplicated: ${identity.instanceId}`);
      } else {
        terminalByKey.set(key, identity);
      }
      if (refreshIdentityKey !== null && key === refreshIdentityKey) refreshTerminalEntries += 1;
    }
    if (refreshIdentityKey === null) {
      errors.push('recorder late refresh worker evidence is missing or has an invalid identity');
    } else if (refreshTerminalEntries !== 1) {
      errors.push(`declared recorder terminal evidence must bind exactly one terminal worker to the late refresh writer identity, found ${refreshTerminalEntries}`);
    }
  }

  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
    errors.push('recorder memory evidence is missing');
    return { valid: false, errors, workerKeys: new Set(), workerSummaries: [] };
  }
  if (memory.expectedWorkerCount !== undefined
    && memory.expectedWorkerCount !== expectedWorkerCount) {
    errors.push(`recorder memory expected worker count must be ${expectedWorkerCount}`);
  }
  if (!isSafeNonNegativeInteger(memory.sampleCount) || memory.sampleCount <= 0) {
    errors.push('recorder memory sample count is missing or invalid');
  } else if (memory.sampleCount < (expected.mode === 'full' ? 2 : 1)) {
    errors.push(`recorder memory sample count must be at least ${expected.mode === 'full' ? 2 : 1}`);
  }

  const workers = memory.workers;
  const workerSummaries = [];
  const sampledByKey = new Map();
  const workerKeys = new Set();
  const requiredWorkerKeys = [
    'identity', 'maxArrayBuffersBytes', 'maxExternalBytes', 'maxHeapTotalBytes',
    'maxHeapUsedBytes', 'maxRssBytes', 'role', 'sampleCount',
  ];
  if (!Array.isArray(workers) || workers.length !== expectedWorkerCount) {
    errors.push(`recorder memory worker samples must cover exactly ${expectedWorkerCount} workers`);
  } else {
    for (const [index, worker] of workers.entries()) {
      const keys = worker && typeof worker === 'object' && !Array.isArray(worker)
        ? Object.keys(worker).sort()
        : [];
      if (JSON.stringify(keys) !== JSON.stringify([...requiredWorkerKeys].sort())) {
        errors.push(`recorder memory worker[${index}] has an invalid shape`);
        continue;
      }
      if (worker.role !== 'recorder') {
        errors.push(`recorder memory worker[${index}] role must be recorder`);
      }
      if (!validIdentity(worker.identity)) {
        errors.push(`recorder memory worker[${index}] identity is invalid`);
        continue;
      }
      const key = workerIdentityKeyOf(worker.identity);
      if (workerKeys.has(key)) {
        errors.push(`recorder memory worker identity is duplicated: ${worker.identity.instanceId}`);
      }
      workerKeys.add(key);
      if (!terminalByKey.has(key)) {
        errors.push(`recorder memory worker ${worker.identity.instanceId} has no matching declared recorder identity`);
      }
      if (!isSafeNonNegativeInteger(worker.sampleCount) || worker.sampleCount <= 0) {
        errors.push(`recorder memory worker ${worker.identity.instanceId} sample count is invalid`);
      } else if (isSafeNonNegativeInteger(memory.sampleCount)
        && worker.sampleCount !== memory.sampleCount) {
        errors.push(`recorder memory worker ${worker.identity.instanceId} sample count does not cover every sampler tick`);
      }
      if (!isSafeNonNegativeInteger(worker.maxRssBytes) || worker.maxRssBytes <= 0) {
        errors.push(`recorder memory worker ${worker.identity.instanceId} RSS high-water is invalid`);
      }
      for (const field of ['maxHeapTotalBytes', 'maxHeapUsedBytes', 'maxExternalBytes', 'maxArrayBuffersBytes']) {
        if (!isSafeNonNegativeInteger(worker[field])) {
          errors.push(`recorder memory worker ${worker.identity.instanceId} ${field} is invalid`);
        }
      }
      if (isSafeNonNegativeInteger(worker.maxHeapTotalBytes)
        && isSafeNonNegativeInteger(worker.maxHeapUsedBytes)
        && worker.maxHeapUsedBytes > worker.maxHeapTotalBytes) {
        errors.push(`recorder memory worker ${worker.identity.instanceId} heap used exceeds heap total`);
      }
      sampledByKey.set(key, worker);
      workerSummaries.push(worker);
    }
  }
  const mainDeclaredKeys = [...terminalByKey.keys()].filter((key) => key !== refreshIdentityKey).sort();
  if (JSON.stringify(mainDeclaredKeys) !== JSON.stringify([...workerKeys].sort())) {
    errors.push('declared recorder identities do not match sampled recorder worker identities');
  }
  if (refreshIdentityKey !== null && workerKeys.has(refreshIdentityKey)) {
    errors.push('recorder late refresh worker identity must be distinct from the sampled main-cohort recorder identities');
  }
  if (Array.isArray(terminalEntries) && terminalEntries.some((entry) => entry?.role !== 'recorder')) {
    errors.push('recorder worker role declaration is invalid');
  }
  const queryKeys = new Set(
    (Array.isArray(mixed?.terminalWorkers?.query) ? mixed.terminalWorkers.query : [])
      .map((entry) => entry?.identity ?? entry)
      .filter(validIdentity)
      .map(workerIdentityKeyOf),
  );
  if ([...terminalByKey.keys()].some((key) => queryKeys.has(key))) {
    errors.push('recorder worker identities (main cohort and late refresh writer) overlap the declared query worker identities');
  }

  const maxRss = workerSummaries.length > 0
    ? Math.max(...workerSummaries.map((worker) => worker.maxRssBytes))
    : undefined;
  if (!isSafeNonNegativeInteger(memory.maxWorkerRssBytes) || memory.maxWorkerRssBytes <= 0) {
    errors.push('recorder memory aggregate maxWorkerRssBytes is missing or invalid');
  } else if (maxRss !== undefined && memory.maxWorkerRssBytes !== maxRss) {
    errors.push(`recorder memory aggregate RSS does not reconcile with per-worker maxima (expected ${maxRss})`);
  }
  for (const [aggregateField, workerField] of [
    ['maxWorkerHeapTotalBytes', 'maxHeapTotalBytes'],
    ['maxWorkerHeapUsedBytes', 'maxHeapUsedBytes'],
  ]) {
    const aggregate = memory[aggregateField];
    const expectedAggregate = workerSummaries.length > 0
      ? Math.max(...workerSummaries.map((worker) => worker[workerField]))
      : undefined;
    if (!isSafeNonNegativeInteger(aggregate)
      || (expectedAggregate !== undefined && aggregate !== expectedAggregate)) {
      errors.push(`recorder memory aggregate ${aggregateField} does not reconcile with per-worker maxima`);
    }
  }

  const claimedCoverage = memory.samplingCoverage;
  if (claimedCoverage !== undefined) {
    if (!claimedCoverage || typeof claimedCoverage !== 'object' || Array.isArray(claimedCoverage)
      || claimedCoverage.valid !== (errors.length === 0)
      || claimedCoverage.workerCount !== expectedWorkerCount
      || claimedCoverage.sampleCount !== memory.sampleCount) {
      errors.push('recorder sampling coverage claim does not match the persisted worker samples');
    }
  }
  const peakQualification = memory.peakQualification;
  if (peakQualification !== undefined
    && (!peakQualification || typeof peakQualification !== 'object' || Array.isArray(peakQualification)
      || peakQualification.qualified !== false
      || peakQualification.measurementKind !== 'periodic-sampler-high-water')) {
    errors.push('recorder peak qualification claim is invalid; sampled coverage is not an absolute peak');
  }
  return { valid: errors.length === 0, errors, workerKeys, workerSummaries, sampledByKey, refreshIdentityKey };
}

/** Validate the recorder topology samples independently from the recorder
 * sampler high-water. A total cohort RSS value is only meaningful when the
 * workers were sampled together; maxima from the main and late cohorts are
 * never added to manufacture a concurrent peak. */
function validateRecorderTopologySamples(mixed, expected, recorderMemoryEvidence) {
  const errors = [];
  const topology = mixed?.queryHostTopology;
  const samples = topology?.topologySamples;
  const coexistingSamples = [];
  if (!Array.isArray(samples) || samples.length < 3) {
    errors.push('recorder topology samples must include started, before-shutdown and a late concurrent cohort sample');
    return { valid: false, errors, coexistingSamples, mainWorkerKeys: new Set(), refreshWorkerKey: null };
  }
  if (topology.topologySampleIntervalMs !== MIXED_TOPOLOGY_SAMPLE_INTERVAL_MS) {
    errors.push(`recorder topology sample interval must be ${MIXED_TOPOLOGY_SAMPLE_INTERVAL_MS} ms`);
  }
  const window = topology.topologySampleWindow;
  const windowKeys = isPlainRecord(window) ? Object.keys(window).sort() : [];
  if (JSON.stringify(windowKeys) !== JSON.stringify(['endAt', 'startAt'])) {
    errors.push('recorder topology sample window must declare exactly startAt and endAt');
  }
  const parseTimestamp = (value, label) => {
    const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
      errors.push(`${label} must be canonical ISO time`);
      return null;
    }
    return milliseconds;
  };
  const windowStartMs = parseTimestamp(window?.startAt, 'recorder topology sample window startAt');
  const windowEndMs = parseTimestamp(window?.endAt, 'recorder topology sample window endAt');
  if (windowStartMs !== null && windowEndMs !== null
    && (windowEndMs < windowStartMs || windowEndMs - windowStartMs > MIXED_TOPOLOGY_MAX_SAMPLE_WINDOW_MS)) {
    errors.push(`recorder topology sample window must be non-negative and at most ${MIXED_TOPOLOGY_MAX_SAMPLE_WINDOW_MS} ms`);
  }

  let previousObservedAtMs = null;
  let previousLabel;
  let mainWorkerKeys;
  let refreshWorkerKey = null;
  let maxWorkerRssBytes = 0;
  const sampleSummaries = [];
  for (const [sampleIndex, sample] of samples.entries()) {
    if (!isPlainRecord(sample)) {
      errors.push(`recorder topology sample[${sampleIndex}] is malformed`);
      continue;
    }
    if (typeof sample.label !== 'string' || sample.label.length === 0 || sample.label === previousLabel) {
      errors.push(`recorder topology sample[${sampleIndex}] label is invalid or duplicated`);
    }
    previousLabel = sample.label;
    const observedAtMs = parseTimestamp(sample.observedAt, `recorder topology sample[${sampleIndex}] observedAt`);
    if (observedAtMs !== null) {
      if (previousObservedAtMs !== null && observedAtMs <= previousObservedAtMs) {
        errors.push(`recorder topology sample[${sampleIndex}] observedAt is not strictly ordered`);
      }
      if (windowStartMs !== null && observedAtMs < windowStartMs) {
        errors.push(`recorder topology sample[${sampleIndex}] precedes the declared sample window`);
      }
      if (windowEndMs !== null && observedAtMs > windowEndMs) {
        errors.push(`recorder topology sample[${sampleIndex}] follows the declared sample window`);
      }
      previousObservedAtMs = observedAtMs;
    }
    if (!isSafeNonNegativeInteger(sample.hostProcessRssBytes) || sample.hostProcessRssBytes <= 0) {
      errors.push(`recorder topology sample[${sampleIndex}] host RSS is invalid`);
    }
    if (!Array.isArray(sample.workers)) {
      errors.push(`recorder topology sample[${sampleIndex}] worker list is missing`);
      continue;
    }
    const mainWorkers = sample.workers.filter((worker) => worker?.role === 'recorder');
    const refreshWorkers = sample.workers.filter((worker) => worker?.role === 'recorder-refresh');
    const unknownRoleWorkers = sample.workers.filter((worker) => !['recorder', 'recorder-refresh'].includes(worker?.role));
    if (mainWorkers.length !== expected.hostCount) {
      errors.push(`recorder topology sample[${sampleIndex}] must contain exactly ${expected.hostCount} main recorder workers`);
    }
    if (refreshWorkers.length > 1 || unknownRoleWorkers.length > 0) {
      errors.push(`recorder topology sample[${sampleIndex}] has invalid recorder cohort roles`);
    }
    if (sample.workers.length !== expected.hostCount + (refreshWorkers.length === 1 ? 1 : 0)) {
      errors.push(`recorder topology sample[${sampleIndex}] worker count does not match its declared roles`);
    }
    const sampleKeys = new Set();
    const validRssValues = [];
    for (const [workerIndex, worker] of sample.workers.entries()) {
      if (!isPlainRecord(worker) || !validIdentity(worker.identity)) {
        errors.push(`recorder topology sample[${sampleIndex}] worker[${workerIndex}] identity is invalid`);
        continue;
      }
      const key = workerIdentityKeyOf(worker.identity);
      if (sampleKeys.has(key)) errors.push(`recorder topology sample[${sampleIndex}] repeats worker ${worker.identity.instanceId}`);
      sampleKeys.add(key);
      if (!isSafeNonNegativeInteger(worker.rssBytes) || worker.rssBytes <= 0) {
        errors.push(`recorder topology sample[${sampleIndex}] worker ${worker.identity.instanceId} RSS is invalid`);
      } else {
        validRssValues.push(worker.rssBytes);
      }
      for (const field of ['heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes']) {
        if (!isSafeNonNegativeInteger(worker[field])) {
          errors.push(`recorder topology sample[${sampleIndex}] worker ${worker.identity.instanceId} ${field} is invalid`);
        }
      }
      if (isSafeNonNegativeInteger(worker.heapTotalBytes)
        && isSafeNonNegativeInteger(worker.heapUsedBytes)
        && worker.heapUsedBytes > worker.heapTotalBytes) {
        errors.push(`recorder topology sample[${sampleIndex}] worker ${worker.identity.instanceId} heap used exceeds heap total`);
      }
      if (!isPlainRecord(worker.cpuUsage)
        || !isSafeNonNegativeInteger(worker.cpuUsage.user)
        || !isSafeNonNegativeInteger(worker.cpuUsage.system)) {
        errors.push(`recorder topology sample[${sampleIndex}] worker ${worker.identity.instanceId} CPU counters are invalid`);
      }
    }
    const currentMainKeys = [...new Set(mainWorkers.map((worker) => validIdentity(worker?.identity) ? workerIdentityKeyOf(worker.identity) : null).filter(Boolean))].sort();
    if (mainWorkerKeys === undefined) mainWorkerKeys = currentMainKeys;
    else if (JSON.stringify(mainWorkerKeys) !== JSON.stringify(currentMainKeys)) errors.push('recorder topology main worker identity set changed between samples');
    if (refreshWorkers.length === 1) {
      if (!validIdentity(refreshWorkers[0].identity)) {
        errors.push(`recorder topology sample[${sampleIndex}] late refresh worker identity is invalid`);
      } else {
        const currentRefreshKey = workerIdentityKeyOf(refreshWorkers[0].identity);
        if (refreshWorkerKey === null) refreshWorkerKey = currentRefreshKey;
        else if (refreshWorkerKey !== currentRefreshKey) errors.push('recorder topology late refresh worker identity changed between samples');
        if (recorderMemoryEvidence.refreshIdentityKey !== null
          && currentRefreshKey !== recorderMemoryEvidence.refreshIdentityKey) {
          errors.push('recorder topology late refresh worker identity does not match terminal evidence');
        }
      }
    }
    if (validRssValues.length > 0) {
      let totalRssBytes = 0;
      try {
        for (const value of validRssValues) totalRssBytes = addSafeNonNegativeIntegers(totalRssBytes, value, `recorder topology sample[${sampleIndex}] total cohort RSS`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      const sampleMaxRssBytes = Math.max(...validRssValues);
      maxWorkerRssBytes = Math.max(maxWorkerRssBytes, sampleMaxRssBytes);
      if (sample.totalWorkerRssBytes !== totalRssBytes) errors.push(`recorder topology sample[${sampleIndex}] worker RSS total does not reconcile`);
      if (sample.totalCohortRssBytes !== totalRssBytes) errors.push(`recorder topology sample[${sampleIndex}] total cohort RSS does not reconcile`);
      if (sample.maxWorkerRssBytes !== sampleMaxRssBytes) errors.push(`recorder topology sample[${sampleIndex}] worker RSS maximum does not reconcile`);
      sampleSummaries.push({
        label: sample.label,
        observedAt: sample.observedAt,
        totalCohortRssBytes: totalRssBytes,
        hasRefresh: refreshWorkers.length === 1,
      });
    }
    if (refreshWorkers.length === 1) {
      const recomputedTotal = sampleSummaries.at(-1)?.totalCohortRssBytes;
      coexistingSamples.push({
        label: sample.label,
        observedAt: sample.observedAt,
        totalCohortRssBytes: recomputedTotal ?? null,
      });
    }
  }
  if (samples[0]?.label !== 'started' || samples.at(-1)?.label !== 'before-shutdown') {
    errors.push('recorder topology samples must span started and before-shutdown boundaries');
  }
  if (samples[0]?.workers?.some((worker) => worker?.role === 'recorder-refresh')
    || samples.at(-1)?.workers?.some((worker) => worker?.role === 'recorder-refresh')) {
    errors.push('late refresh recorder must be sampled only in its coexisting cohort window');
  }
  if (coexistingSamples.length === 0) {
    errors.push('recorder topology is missing a coexisting main and late refresh recorder cohort sample');
  }
  const claimedSamples = topology.recorderTotalCohortRssSamples;
  if (!Array.isArray(claimedSamples)
    || JSON.stringify(claimedSamples) !== JSON.stringify(coexistingSamples)) {
    errors.push('recorder total cohort RSS samples do not reconcile with coexisting topology samples');
  }
  const expectedSampledMax = coexistingSamples.length > 0
    && coexistingSamples.every((sample) => isSafeNonNegativeInteger(sample.totalCohortRssBytes))
    ? Math.max(...coexistingSamples.map((sample) => sample.totalCohortRssBytes))
    : null;
  if (!isSafeNonNegativeInteger(topology.recorderSampledMaxTotalCohortRssBytes)
    || expectedSampledMax === null
    || topology.recorderSampledMaxTotalCohortRssBytes !== expectedSampledMax) {
    errors.push('recorder sampled maximum total cohort RSS does not reconcile with coexisting samples');
  }
  const trustedPerWorkerMax = [
    maxWorkerRssBytes,
    recorderMemoryEvidence?.workerSummaries?.length > 0
      ? Math.max(...recorderMemoryEvidence.workerSummaries.map((worker) => worker.maxRssBytes)) : 0,
    isSafeNonNegativeInteger(mixed.recorderRefreshWorker?.runtimeMemory?.maxRssBytes)
      ? mixed.recorderRefreshWorker.runtimeMemory.maxRssBytes : 0,
  ];
  const expectedPerWorkerMax = Math.max(...trustedPerWorkerMax);
  if (!isSafeNonNegativeInteger(topology.recorderMaxWorkerRssBytes)
    || topology.recorderMaxWorkerRssBytes !== expectedPerWorkerMax) {
    errors.push(`recorderMaxWorkerRssBytes must equal the recomputed per-worker maximum (${expectedPerWorkerMax})`);
  }
  if (windowStartMs !== null && windowEndMs !== null && samples.length > 0) {
    if (samples[0]?.observedAt !== window.startAt || samples.at(-1)?.observedAt !== window.endAt) {
      errors.push('recorder topology sample window must bind exactly to the first and last samples');
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    coexistingSamples,
    mainWorkerKeys: new Set(mainWorkerKeys ?? []),
    refreshWorkerKey,
    sampleSummaries,
  };
}

/** Validate the recorder CPU counter endpoints separately from the memory
 * high-water gate. CPU is cumulative worker-process evidence: identity sets
 * must remain stable, counters must be finite/nonnegative and the aggregate is
 * the sum of per-worker endpoint deltas. No CPU threshold is applied here. */
function validateRecorderCpuEvidence(mixed, expected, recorderMemoryEvidence) {
  const errors = [];
  const topology = mixed?.queryHostTopology;
  const reported = topology?.recorderWorkerCpuDeltaMicros;
  if (!isSafeNonNegativeInteger(reported)) {
    errors.push('recorderWorkerCpuDeltaMicros must be a finite non-negative safe integer');
  }
  const samples = topology?.topologySamples;
  if (!Array.isArray(samples) || samples.length < 2) {
    errors.push('recorder worker CPU endpoint evidence is missing from topology samples');
    return { valid: false, errors };
  }
  if (samples[0]?.label !== 'started' || samples.at(-1)?.label !== 'before-shutdown') {
    errors.push('recorder worker CPU endpoint evidence must span the started and before-shutdown topology samples');
  }

  let endpointKeys;
  const sampleMaps = [];
  for (const [sampleIndex, sample] of samples.entries()) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample) || !Array.isArray(sample.workers)) {
      errors.push(`recorder worker CPU topology sample[${sampleIndex}] is missing the expected worker set`);
      continue;
    }
    const mainWorkers = sample.workers.filter((worker) => worker?.role === 'recorder');
    const refreshWorkers = sample.workers.filter((worker) => worker?.role === 'recorder-refresh');
    if (mainWorkers.length !== expected.hostCount || refreshWorkers.length > 1
      || sample.workers.length !== expected.hostCount + (refreshWorkers.length === 1 ? 1 : 0)) {
      errors.push(`recorder worker CPU topology sample[${sampleIndex}] is missing the expected role-bound worker set`);
    }
    const map = new Map();
    for (const [workerIndex, worker] of mainWorkers.entries()) {
      const identity = worker?.identity;
      if (!validIdentity(identity)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] worker[${workerIndex}] identity is invalid`);
        continue;
      }
      const key = workerIdentityKeyOf(identity);
      if (map.has(key)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] repeats worker ${identity.instanceId}`);
        continue;
      }
      const cpuUsage = worker.cpuUsage;
      if (!cpuUsage || typeof cpuUsage !== 'object' || Array.isArray(cpuUsage)
        || !isSafeNonNegativeInteger(cpuUsage.user)
        || !isSafeNonNegativeInteger(cpuUsage.system)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] worker ${identity.instanceId} CPU counters are invalid`);
        continue;
      }
      if (!recorderMemoryEvidence.workerKeys.has(key)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] worker ${identity.instanceId} has no matching sampled recorder identity`);
      }
      map.set(key, { identity, cpuUsage });
    }
    for (const worker of refreshWorkers) {
      if (!validIdentity(worker?.identity)
        || (recorderMemoryEvidence.refreshIdentityKey !== null
          && workerIdentityKeyOf(worker.identity) !== recorderMemoryEvidence.refreshIdentityKey)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] late refresh identity is invalid or unbound`);
      }
      if (!isPlainRecord(worker?.cpuUsage)
        || !isSafeNonNegativeInteger(worker.cpuUsage.user)
        || !isSafeNonNegativeInteger(worker.cpuUsage.system)) {
        errors.push(`recorder worker CPU topology sample[${sampleIndex}] late refresh CPU counters are invalid`);
      }
    }
    const keys = [...map.keys()].sort();
    if (endpointKeys === undefined) endpointKeys = keys;
    else if (JSON.stringify(endpointKeys) !== JSON.stringify(keys)) {
      errors.push(`recorder worker CPU topology sample[${sampleIndex}] worker identity set changed`);
    }
    sampleMaps.push(map);
  }
  if (sampleMaps.length < 2 || endpointKeys === undefined) {
    errors.push('recorder worker CPU endpoint counters are incomplete');
    return { valid: false, errors };
  }
  if (JSON.stringify(endpointKeys) !== JSON.stringify([...recorderMemoryEvidence.workerKeys].sort())) {
    errors.push('recorder worker CPU endpoint identities do not match declared recorder identities');
  }

  const first = sampleMaps[0];
  const last = sampleMaps.at(-1);
  let expectedDelta = 0;
  for (const key of endpointKeys) {
    const start = first.get(key)?.cpuUsage;
    const end = last.get(key)?.cpuUsage;
    if (!start || !end) {
      errors.push(`recorder worker CPU endpoint is missing for ${key}`);
      continue;
    }
    if (end.user < start.user || end.system < start.system) {
      errors.push(`recorder worker CPU counters decrease between endpoints for ${key}`);
      continue;
    }
    const userDelta = end.user - start.user;
    const systemDelta = end.system - start.system;
    if (!isSafeNonNegativeInteger(userDelta) || !isSafeNonNegativeInteger(systemDelta)) {
      errors.push(`recorder worker CPU endpoint delta is invalid for ${key}`);
      continue;
    }
    let delta;
    try {
      delta = addSafeNonNegativeIntegers(userDelta, systemDelta, `recorder worker CPU delta for ${key}`);
      expectedDelta = addSafeNonNegativeIntegers(expectedDelta, delta, 'recorder worker CPU aggregate delta');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
  }
  if (isSafeNonNegativeInteger(reported) && reported !== expectedDelta) {
    errors.push(`recorderWorkerCpuDeltaMicros does not reconcile with worker CPU endpoints (expected ${expectedDelta})`);
  }
  return { valid: errors.length === 0, errors, expectedDelta };
}

/** Validate the explicitly reported late refresh recorder worker. The main
 * writer cohort gate (sampler coverage, recorderWorkerCpuDeltaMicros and the
 * 256 MiB ordinary-ingestion gate) stays untouched; the late writer created
 * after that cohort is reported separately with its own runtime CPU/RSS
 * endpoints and is never claimed to be simultaneous with a full main-cohort
 * topology sample. The native collector binds query workers only, so runtime
 * stats endpoints are the applicable coverage source here. */
function validateRecorderRefreshWorkerEvidence(mixed, expected, recorderMemoryValidation, recorderCpuValidation) {
  const errors = [];
  const topology = mixed?.queryHostTopology;
  const refresh = mixed?.recorderRefreshWorker;
  if (!refresh || typeof refresh !== 'object' || Array.isArray(refresh)) {
    return { valid: false, errors: ['late refresh worker evidence is missing'], maxRssBytes: null, deltaMicros: null };
  }
  const requiredRefreshKeys = ['cpu', 'expectedPhases', 'identity', 'lateCohort', 'nativeCollectorBound', 'role', 'runtimeMemory', 'states'];
  const keys = refresh && typeof refresh === 'object' && !Array.isArray(refresh) ? Object.keys(refresh).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([...requiredRefreshKeys].sort())) {
    errors.push('evidence has an invalid shape');
  } else {
    if (refresh.role !== 'recorder-refresh'
      || refresh.lateCohort !== true
      || refresh.nativeCollectorBound !== false
      || JSON.stringify(refresh.expectedPhases) !== JSON.stringify(['spawned', 'ready', 'terminal'])) {
      errors.push('must declare the late recorder-refresh cohort, its exact phases and an unbound native collector');
    }
    if (!validIdentity(refresh.identity)) {
      errors.push('identity is invalid');
    } else if (recorderMemoryValidation.refreshIdentityKey !== null
      && workerIdentityKeyOf(refresh.identity) !== recorderMemoryValidation.refreshIdentityKey) {
      errors.push('identity does not match the late refresh writer bound in the terminal recorder evidence');
    }
    const statesValidation = validateTerminalWorkerSummaries([{ identity: refresh.identity, states: refresh.states }]);
    if (!statesValidation.valid) {
      errors.push(...statesValidation.errors.map((error) => `persisted terminal state is invalid: ${error}`));
    }
    const memory = refresh.runtimeMemory;
    const positiveEndpointFields = ['rssBytes', 'heapTotalBytes', 'heapUsedBytes'];
    const nonNegativeEndpointFields = ['externalBytes', 'arrayBuffersBytes'];
    const endpointValid = (endpoint) => !!endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint)
      && positiveEndpointFields.every((field) => isSafeNonNegativeInteger(endpoint[field]) && endpoint[field] > 0)
      && nonNegativeEndpointFields.every((field) => isSafeNonNegativeInteger(endpoint[field]));
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)
      || !isSafeNonNegativeInteger(memory.maxRssBytes) || memory.maxRssBytes <= 0
      || !endpointValid(memory.start) || !endpointValid(memory.final)
      || memory.maxRssBytes !== Math.max(memory.start.rssBytes, memory.final.rssBytes)) {
      errors.push('runtime memory endpoints are missing or do not reconcile with the reported maximum');
    }
    const cpu = refresh.cpu;
    const userDelta = isSafeNonNegativeInteger(cpu?.end?.user) && isSafeNonNegativeInteger(cpu?.start?.user)
      && cpu.end.user >= cpu.start.user ? cpu.end.user - cpu.start.user : null;
    const systemDelta = isSafeNonNegativeInteger(cpu?.end?.system) && isSafeNonNegativeInteger(cpu?.start?.system)
      && cpu.end.system >= cpu.start.system ? cpu.end.system - cpu.start.system : null;
    let expectedCpuDelta = null;
    if (userDelta !== null && systemDelta !== null
      && isSafeNonNegativeInteger(userDelta) && isSafeNonNegativeInteger(systemDelta)) {
      try {
        expectedCpuDelta = addSafeNonNegativeIntegers(userDelta, systemDelta, 'late refresh worker CPU delta');
      } catch {
        expectedCpuDelta = null;
      }
    }
    if (!cpu || typeof cpu !== 'object' || Array.isArray(cpu)
      || !isSafeNonNegativeInteger(cpu.start?.user) || !isSafeNonNegativeInteger(cpu.start?.system)
      || !isSafeNonNegativeInteger(cpu.end?.user) || !isSafeNonNegativeInteger(cpu.end?.system)
      || cpu.end.user < cpu.start.user || cpu.end.system < cpu.start.system
      || !isSafeNonNegativeInteger(cpu.deltaMicros)
      || expectedCpuDelta === null || cpu.deltaMicros !== expectedCpuDelta) {
      errors.push('CPU endpoints are missing, regressing or do not reconcile with the reported delta');
    }
  }
  const refreshValid = errors.length === 0;
  const refreshCpuMicros = refreshValid ? refresh.cpu.deltaMicros : null;
  const refreshMaxRssBytes = refreshValid ? refresh.runtimeMemory.maxRssBytes : null;
  if (refreshValid && topology && typeof topology === 'object' && !Array.isArray(topology)) {
    if (topology.recorderRefreshWorkerCpuDeltaMicros !== refreshCpuMicros) {
      errors.push(`queryHostTopology.recorderRefreshWorkerCpuDeltaMicros must equal the late refresh worker CPU delta (${refreshCpuMicros})`);
    }
    const mainDelta = recorderCpuValidation?.expectedDelta;
    if (isSafeNonNegativeInteger(mainDelta) && isSafeNonNegativeInteger(refreshCpuMicros)) {
      let totalDelta;
      try {
        totalDelta = addSafeNonNegativeIntegers(mainDelta, refreshCpuMicros, 'recorderWorkerCpuDeltaTotalMicros');
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (totalDelta !== undefined && topology.recorderWorkerCpuDeltaTotalMicros !== totalDelta) {
        errors.push(`queryHostTopology.recorderWorkerCpuDeltaTotalMicros must equal the main-cohort delta plus the separately reported late refresh writer delta (${totalDelta})`);
      }
    }
  }
  return { valid: refreshValid && errors.length === 0, errors, maxRssBytes: refreshMaxRssBytes, deltaMicros: refreshCpuMicros };
}

/** Validate the bounded mixed workload result. Functional evidence is kept
 * separate from memory qualification. Query-worker terminal samples are
 * validated when present, while cancellation gaps keep whole-topology memory
 * explicitly unqualified. */
export function validateMixedEvidence(mixed, { mode = 'full', recorderHeapProbeMb, statsPollMode = 'full-stats', reportConfiguration, expectedProvenance } = {}) {
  const errors = [];
  const memoryErrors = [];
  const nativeAvailableByWorker = new Map();
  const expected = mode === 'smoke' ? MIXED_SMOKE_PLAN : MIXED_FULL_PLAN;
  if (!mixed || typeof mixed !== 'object' || Array.isArray(mixed)) {
    return { valid: false, errors: ['mixed results are missing'], memoryValid: false, memoryErrors: ['mixed results are missing'] };
  }
  if (mixed.mode !== mode) errors.push(`mixed mode must be ${mode}`);
  if (!SUPPORTED_STATS_POLL_MODES.has(statsPollMode)) {
    errors.push(`stats poll mode must be full-stats or memory-only, not ${String(statsPollMode)}`);
  }
  const modeMarkerValidation = validateStatsPollMarkers(mixed, { statsPollMode, reportConfiguration });
  if (!modeMarkerValidation.valid) {
    memoryErrors.push(...modeMarkerValidation.errors.map((error) => `observer mode evidence: ${error}; validation receipts cannot be substituted across observer modes`));
  }
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
    // Only individually valid available receipts bound to a persisted worker
    // identity may substitute for runtime samples in whole-topology memory
    // coverage; a malformed receipt invalidates its own coverage without
    // discarding the independent evidence for other workers.
    for (const receipt of Array.isArray(mixed.nativeProcessTelemetry?.receipts)
      ? mixed.nativeProcessTelemetry.receipts : []) {
      if (receipt?.status !== 'available' || !receipt.identity) continue;
      const expected = lifecycleWorkers.find((worker) => workerIdentityKeyOf(worker) === workerIdentityKeyOf(receipt.identity));
      if (expected && validateWindowsProcessReceipt(receipt, expected).valid) {
        nativeAvailableByWorker.set(workerIdentityKeyOf(receipt.identity), receipt);
      }
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
  const provenanceValidation = validateCandidateArtifactProvenance(artifacts, expectedProvenance);
  if (!provenanceValidation.valid) {
    errors.push(...provenanceValidation.errors.map((error) => `candidate artifact provenance: ${error}`));
  }
  if (mixed.terminalWorkers?.complete !== true
    || !validIdentityArray(mixed.terminalWorkers?.recorder)
    || !validIdentityArray(mixed.terminalWorkers?.query)) {
    errors.push('terminal recorder/query worker evidence is incomplete');
  }
  const recorderMemoryValidation = validateRecorderMemoryEvidence(mixed, expected);
  if (!recorderMemoryValidation.valid) {
    memoryErrors.push(...recorderMemoryValidation.errors.map((error) => `recorder worker coverage: ${error}`));
  }

  const topology = mixed.queryHostTopology;
  const recorderCpuValidation = validateRecorderCpuEvidence(mixed, expected, recorderMemoryValidation);
  if (!recorderCpuValidation.valid) {
    memoryErrors.push(...recorderCpuValidation.errors.map((error) => `recorder CPU evidence: ${error}`));
  }
  const recorderRefreshValidation = validateRecorderRefreshWorkerEvidence(mixed, expected, recorderMemoryValidation, recorderCpuValidation);
  if (!recorderRefreshValidation.valid) {
    memoryErrors.push(...recorderRefreshValidation.errors.map((error) => `recorder late refresh worker evidence: ${error}`));
  }
  const recorderTopologyValidation = validateRecorderTopologySamples(mixed, expected, recorderMemoryValidation);
  if (!recorderTopologyValidation.valid) {
    memoryErrors.push(...recorderTopologyValidation.errors.map((error) => `recorder topology RSS evidence: ${error}`));
  }
  if (!topology || !isSafeNonNegativeInteger(topology.hostPeakRssBytes)
    || !isSafeNonNegativeInteger(topology.hostCpuDeltaMicros)) {
    memoryErrors.push('host RSS/CPU topology telemetry is malformed');
  }
  const queryTelemetry = lifecycleValidation.summary?.queryWorkerTelemetry;
  // Recompute whole-topology coverage from the persisted evidence instead of
  // trusting the report's claim. Runtime terminal samples and native OS final
  // counters are complementary sources: forced cancellation has explicit null
  // runtime evidence, and fast one-shot workers can exit before the native
  // collector binds them, so a worker is covered when either source validates.
  const runtimeCoveredByWorker = new Map();
  for (const receipt of Array.isArray(lifecycle) ? lifecycle : []) {
    const terminal = receipt?.events?.find((event) => event?.phase === 'terminal');
    const identity = terminal?.identity;
    if (terminal?.telemetryStatus === 'available' && identity
      && validQueryWorkerTelemetry(terminal.telemetry, identity)) {
      let runtimeCpuDelta;
      try {
        runtimeCpuDelta = addSafeNonNegativeIntegers(
          terminal.telemetry.userCpuTimeMicros,
          terminal.telemetry.systemCpuTimeMicros,
          `query worker ${identity.instanceId} runtime CPU component sum`,
        );
      } catch {
        runtimeCpuDelta = null;
      }
      if (runtimeCpuDelta !== null) {
        runtimeCoveredByWorker.set(workerIdentityKeyOf(identity), {
          rssBytes: terminal.telemetry.maxRssBytes,
          cpuDeltaMicros: runtimeCpuDelta,
        });
      } else {
        memoryErrors.push(`query worker ${identity.instanceId} runtime CPU component sum overflows the safe integer range; overflow is rejected, never reported`);
      }
    }
  }
  const workerKeys = new Set(lifecycleWorkers.map(workerIdentityKeyOf));
  const unionCoveredKeys = new Set([...runtimeCoveredByWorker.keys(), ...nativeAvailableByWorker.keys()]
    .filter((key) => workerKeys.has(key)));
  const unionComplete = workerKeys.size > 0 && [...workerKeys].every((key) => unionCoveredKeys.has(key));
  const available = Number.isSafeInteger(queryTelemetry?.availableCount) ? queryTelemetry.availableCount : 0;
  const unavailable = Number.isSafeInteger(queryTelemetry?.unavailableCount) ? queryTelemetry.unavailableCount : 0;
  const invalid = Number.isSafeInteger(queryTelemetry?.invalidCount) ? queryTelemetry.invalidCount : 0;
  const workerCount = lifecycleWorkers.length;
  const missing = Math.max(0, workerCount - available - unavailable - invalid);
  const nativeReceipts = Array.isArray(mixed.nativeProcessTelemetry?.receipts)
    ? mixed.nativeProcessTelemetry.receipts
    : [];
  const nativeAvailable = nativeReceipts.filter((receipt) => receipt?.status === 'available').length;
  if (topology?.queryWorkerTelemetryAvailable === true) {
    if (!unionComplete) {
      memoryErrors.push(`query-worker RSS/CPU high-water is incomplete: runtime terminal telemetry is available for ${available}/${workerCount} query workers; ${unavailable} unavailable, ${invalid} invalid, and ${missing} missing runtime sample(s). Union coverage with valid native OS final-counter receipts is ${unionCoveredKeys.size}/${workerCount}. Whole-topology memory remains unqualified.`);
    } else {
      const coverage = topology.queryWorkerTelemetryCoverage;
      if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)
        || coverage.workerCount !== workerCount
        || coverage.unionCoveredCount !== unionCoveredKeys.size
        || coverage.unionComplete !== true) {
        memoryErrors.push('claimed query-worker coverage provenance does not match the persisted terminal evidence');
      }
      // Native-only workers must reconcile as an exact identity set derived
      // from the full native union against the persisted runtime identity set
      // — not as an aggregate count: duplicates, missing, extra or mislabelled
      // entries keep whole-topology memory unqualified.
      const expectedNativeOnlyKeys = [...workerKeys]
        .filter((key) => nativeAvailableByWorker.has(key) && !runtimeCoveredByWorker.has(key))
        .sort();
      const declaredNativeOnly = Array.isArray(coverage?.nativeOnlyWorkers) ? coverage.nativeOnlyWorkers : null;
      const declaredNativeOnlyKeys = new Set();
      if (declaredNativeOnly === null) {
        memoryErrors.push('declared native-only worker list is missing or malformed; exact identity sets are required, not aggregate counts');
      } else {
        let nativeOnlyMalformed = false;
        for (const entry of declaredNativeOnly) {
          const identity = entry?.identity ?? entry;
          if (!validIdentity(identity)) {
            memoryErrors.push('declared native-only worker list is missing or malformed; exact identity sets are required, not aggregate counts');
            nativeOnlyMalformed = true;
            break;
          }
          const key = workerIdentityKeyOf(identity);
          if (declaredNativeOnlyKeys.has(key)) {
            memoryErrors.push(`declared native-only worker identity is duplicated: ${identity.instanceId}`);
            nativeOnlyMalformed = true;
            break;
          }
          declaredNativeOnlyKeys.add(key);
        }
        if (!nativeOnlyMalformed) {
          for (const key of declaredNativeOnlyKeys) {
            if (!workerKeys.has(key)) {
              memoryErrors.push(`declared native-only worker identity is extra or unknown: ${key}`);
            } else if (runtimeCoveredByWorker.has(key)) {
              memoryErrors.push(`declared native-only worker ${key} is already covered by a runtime terminal sample`);
            } else if (!nativeAvailableByWorker.has(key)) {
              memoryErrors.push(`declared native-only worker ${key} has no valid native OS final-counter receipt`);
            }
          }
          const missingNativeOnly = expectedNativeOnlyKeys.filter((key) => !declaredNativeOnlyKeys.has(key));
          if (missingNativeOnly.length > 0) {
            memoryErrors.push(`declared native-only worker set is missing ${missingNativeOnly.length} natively covered worker(s): ${missingNativeOnly.join(', ')}`);
          }
        }
        const expectedNativeAvailable = [...workerKeys].filter((key) => nativeAvailableByWorker.has(key)).length;
        if (coverage.nativeAvailableCount !== expectedNativeAvailable
          || coverage.runtimeCoveredCount !== runtimeCoveredByWorker.size) {
          memoryErrors.push('declared native-available/runtime-covered coverage counts do not reconcile with the exact identity sets');
        }
      }
      let expectedRss = 0;
      let expectedCpuDeltaMicros = 0;
      let cpuOverflow = false;
      for (const key of workerKeys) {
        const runtimeSample = runtimeCoveredByWorker.get(key);
        const nativeReceipt = nativeAvailableByWorker.get(key);
        if (!runtimeSample && !nativeReceipt) continue;
        let source;
        if (runtimeSample) {
          source = runtimeSample;
        } else {
          let nativeCpuDelta;
          try {
            nativeCpuDelta = addSafeNonNegativeIntegers(
              nativeReceipt.cpu.userCpuTimeMicros,
              nativeReceipt.cpu.systemCpuTimeMicros,
              `query worker ${key} native CPU component sum`,
            );
          } catch {
            nativeCpuDelta = null;
          }
          source = nativeCpuDelta === null ? null : {
            rssBytes: nativeReceipt.memory.peakWorkingSetBytes,
            cpuDeltaMicros: nativeCpuDelta,
          };
        }
        if (!source || !isSafeNonNegativeInteger(source.cpuDeltaMicros)
          || !isSafeNonNegativeInteger(source.rssBytes)) {
          cpuOverflow = true;
          continue;
        }
        expectedRss = Math.max(expectedRss, source.rssBytes);
        try {
          expectedCpuDeltaMicros = addSafeNonNegativeIntegers(expectedCpuDeltaMicros, source.cpuDeltaMicros, 'query worker CPU aggregate');
        } catch {
          cpuOverflow = true;
        }
      }
      if (!isSafeNonNegativeInteger(topology.queryWorkerCpuDeltaMicros)) {
        cpuOverflow = true;
        memoryErrors.push('claimed query-worker CPU total must be a non-negative safe integer; overflow is rejected, never reported as NaN, null or an unsafe finite value');
      }
      if (cpuOverflow) {
        memoryErrors.push('claimed query-worker CPU total overflows the safe integer range; overflow is rejected rather than reconciled');
      } else if (topology.queryWorkerRssBytes !== expectedRss
        || topology.queryWorkerCpuDeltaMicros !== expectedCpuDeltaMicros) {
        memoryErrors.push(`claimed query-worker RSS/CPU does not match the persisted terminal evidence (expected max RSS ${expectedRss} bytes and total CPU ${expectedCpuDeltaMicros} micros across ${workerCount} covered workers)`);
      }
    }
  } else {
    if (topology?.queryWorkerRssBytes !== null
      || topology?.queryWorkerCpuDeltaMicros !== null
      || topology?.queryWorkerTelemetryAvailable !== false) {
      memoryErrors.push('query-worker RSS/CPU telemetry claim is malformed');
    }
    const nativeCoverage = nativeReceipts.length > 0
      ? ` Native OS final-counter evidence is available for ${nativeAvailable}/${nativeReceipts.length} query workers.`
      : '';
    memoryErrors.push(`query-worker RSS/CPU high-water is incomplete: runtime terminal telemetry is available for ${available}/${workerCount} query workers; ${unavailable} unavailable, ${invalid} invalid, and ${missing} missing runtime sample(s). Union coverage with valid native OS final-counter receipts is ${unionCoveredKeys.size}/${workerCount}.${nativeCoverage} Whole-topology memory remains unqualified.`);
  }
  const recorderMemory = mixed.recorderMemory;
  const recorderSamplingClaimValid = recorderMemory?.sampledHighWaterProven === true
    && recorderMemory?.peakProven === false
    && recorderMemory?.peakMeasurementKind === 'periodic-sampler-high-water'
    && recorderMemory?.qualification === 'measured-recorder-sampled-high-water-only';
  if (!recorderSamplingClaimValid) {
    memoryErrors.push('recorder sampling coverage must be reported separately from an absolute peak: a 1-second sampler cannot prove process peak memory');
  }
  if (recorderMemory?.peakProven === true) {
    memoryErrors.push('recorder peakProven claim is invalid: a 1-second sampler cannot prove an absolute process peak');
  }
  if (mode === 'full' && recorderSamplingClaimValid) {
    const phases = Array.isArray(recorderMemory?.phases) ? recorderMemory.phases : [];
    let phasesValid = phases.length >= 2;
    let phaseSampleTotal = 0;
    let worstPhase = null;
    for (const phase of phases) {
      if (!phase || typeof phase.label !== 'string' || phase.label.length === 0
        || !isSafeNonNegativeInteger(phase.sampleCount) || phase.sampleCount <= 0
        || !isSafeNonNegativeInteger(phase.maxWorkerRssBytes) || phase.maxWorkerRssBytes <= 0) {
        phasesValid = false;
        break;
      }
      try {
        phaseSampleTotal = addSafeNonNegativeIntegers(phaseSampleTotal, phase.sampleCount, 'recorder phase sample count aggregate');
      } catch {
        phasesValid = false;
        break;
      }
      if (!worstPhase || phase.maxWorkerRssBytes > worstPhase.maxWorkerRssBytes) worstPhase = phase;
    }
    if (!phasesValid || phaseSampleTotal !== recorderMemory.sampleCount) {
      memoryErrors.push('recorder phase attribution does not cover the sampled high-water window');
      worstPhase = null;
    }
    if (worstPhase && worstPhase.maxWorkerRssBytes > recorderMemory.maxWorkerRssBytes) {
      memoryErrors.push('recorder phase high-water exceeds the reported sampler high-water');
    }
    const perWorkerMaxCandidates = [
      recorderMemory?.maxWorkerRssBytes,
      recorderRefreshValidation.valid ? recorderRefreshValidation.maxRssBytes : null,
      topology?.recorderMaxWorkerRssBytes,
    ].filter(isSafeNonNegativeInteger);
    const perWorkerMaxRssBytes = perWorkerMaxCandidates.length > 0 ? Math.max(...perWorkerMaxCandidates) : null;
    if (perWorkerMaxRssBytes !== null && perWorkerMaxRssBytes > MIXED_RECORDER_RSS_GATE_BYTES) {
      const phaseDetail = worstPhase
        ? ` The highest main-cohort phase is "${worstPhase.label}" at ${worstPhase.maxWorkerRssBytes} bytes.`
        : '';
      memoryErrors.push(`recorder per-worker sampled high-water RSS ${perWorkerMaxRssBytes} bytes exceeds the ${MIXED_RECORDER_RSS_GATE_BYTES}-byte (256 MiB) ordinary-ingestion gate by ${perWorkerMaxRssBytes - MIXED_RECORDER_RSS_GATE_BYTES} bytes.${phaseDetail} No production-default memory qualification is claimed.`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    memoryValid: memoryErrors.length === 0,
    memoryErrors,
    recorderSamplingCoverage: {
      valid: recorderMemoryValidation.valid && recorderSamplingClaimValid,
      workerCount: expected.hostCount,
      sampleCount: mixed.recorderMemory?.sampleCount ?? null,
    },
    recorderPeakQualification: {
      qualified: false,
      measurementKind: 'periodic-sampler-high-water',
    },
    mode,
    expectedAcceptedRows,
  };
}
