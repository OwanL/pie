import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The test runner imports this plain ESM validation module directly.
import * as mixedValidationModule from '../../scripts/analytics-p0-mixed-validation.mjs';

type MixedValidation = {
  MIXED_FULL_PLAN: {
    fixtureRows: number;
    hostCount: number;
    paced: { ratePerSecond: number; sampleCount: number };
    burst: { ratePerSecond: number; durationMs: number; sampleCount: number };
    broadScanCount: number;
    indexedLookupCount: number;
    detailRangeCount: number;
    refreshReadCount: number;
    saturationQueryCount: number;
    saturationMaxConcurrentQueries: number;
    saturationQueueCapacity: number;
  };
  MIXED_SMOKE_PLAN: typeof mixedValidationModule.MIXED_FULL_PLAN;
  summarizeMixedTimingSamples: (values: number[]) => { samples: number; medianMs: number; maxMs: number };
  startWorkerMemorySampler: (
    hosts: any[],
    label: string,
    intervalMs?: number,
    options?: { initialPhase?: string; poll: (host: any) => Promise<any> },
  ) => {
    mark: (label: string) => void;
    snapshot: () => Record<string, unknown>;
    stop: () => Promise<{
      intervalMs: number;
      sampleCount: number;
      firstPollStartedAt: string | null;
      lastPollStartedAt: string | null;
      firstObservedAt: string | null;
      lastObservedAt: string | null;
      maxWorkerRssBytes: number;
      maxWorkerHeapTotalBytes: number;
      maxWorkerHeapUsedBytes: number;
      phases: { label: string; sampleCount: number; maxWorkerRssBytes: number }[];
      workers: { identity: { instanceId: string; pid: number; spawnedAtMs: number }; role: string; sampleCount: number }[];
    }>;
  };
  validateMixedEvidence: (mixed: any, options: { mode: 'full' | 'smoke'; recorderHeapProbeMb?: number; statsPollMode?: 'full-stats' | 'memory-only'; reportConfiguration?: { statsPollMode?: 'full-stats' | 'memory-only' }; expectedProvenance?: any }) => {
    valid: boolean;
    errors: string[];
    memoryValid: boolean;
    memoryErrors: string[];
    recorderSamplingCoverage: { valid: boolean; workerCount: number; sampleCount: number | null };
    recorderPeakQualification: { qualified: boolean; measurementKind: string };
  };
  validateCandidateArtifactProvenance: (candidate: any, expected: any) => { valid: boolean; errors: string[] };
};

const {
  MIXED_FULL_PLAN,
  MIXED_SMOKE_PLAN,
  summarizeMixedTimingSamples,
  startWorkerMemorySampler,
  validateMixedEvidence: validateMixedEvidenceRaw,
  validateCandidateArtifactProvenance,
} = mixedValidationModule as unknown as MixedValidation;

function identity(index: number) {
  return {
    pid: index + 1,
    spawnedAtMs: index + 2,
    instanceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  };
}

function snapshot(activeQueries: number, queuedQueries: number, maxQueuedQueries: number) {
  return {
    activeQueries,
    queuedQueries,
    maxConcurrentQueries: 2,
    maxQueuedQueries,
  };
}

function lifecycleReceipt(
  clientId: string,
  requestId: number,
  requestType: 'query' | 'detail' | 'providerSettlements' | 'qualificationSpin',
  worker: ReturnType<typeof identity> | null,
  { queued = false, capacityRejected = false, activeQueries = 1, queuedQueries = 0, outcome = 'resolved' as 'resolved' | 'rejected' } = {},
) {
  const events: any[] = [
    { clientId, requestId, requestType, phase: 'submitted', snapshot: snapshot(activeQueries, queuedQueries, requestType === 'qualificationSpin' ? 1 : 14) },
  ];
  if (capacityRejected) {
    events.push({ clientId, requestId, requestType, phase: 'capacity-rejected', snapshot: snapshot(2, 1, 1) });
  } else if (!worker) {
    if (queued) events.push({ clientId, requestId, requestType, phase: 'queued', snapshot: snapshot(2, 1, 1) });
    events.push({ clientId, requestId, requestType, phase: 'cancelled-before-start', snapshot: snapshot(2, 0, 1) });
  } else {
    events.push({ clientId, requestId, requestType, phase: 'admitted', admission: queued ? 'queued' : 'active', snapshot: snapshot(activeQueries, 0, requestType === 'qualificationSpin' ? 1 : 14) });
    events.push({ clientId, requestId, requestType, phase: 'spawned', identity: worker, snapshot: snapshot(activeQueries, 0, requestType === 'qualificationSpin' ? 1 : 14) });
    events.push({ clientId, requestId, requestType, phase: 'ready', identity: worker, snapshot: snapshot(activeQueries, 0, requestType === 'qualificationSpin' ? 1 : 14) });
    events.push({ clientId, requestId, requestType, phase: 'terminal', identity: worker, code: 0, signal: null, snapshot: snapshot(activeQueries, 0, requestType === 'qualificationSpin' ? 1 : 14) });
  }
  const settledQueue = capacityRejected ? queuedQueries : 0;
  events.push({ clientId, requestId, requestType, phase: 'settled', outcome, snapshot: snapshot(activeQueries, settledQueue, requestType === 'qualificationSpin' ? 1 : 14) });
  return { clientId, requestId, events };
}

function lifecycleReceipts(plan: typeof MIXED_FULL_PLAN) {
  const queryClientId = '00000000-0000-4000-8000-000000000101';
  const saturationClientId = '00000000-0000-4000-8000-000000000102';
  const receipts: any[] = [];
  let nextWorker = 0;
  for (let requestId = 1; requestId <= plan.broadScanCount + plan.indexedLookupCount; requestId += 1) {
    receipts.push(lifecycleReceipt(queryClientId, requestId, 'query', identity(nextWorker++)));
  }
  receipts.push(lifecycleReceipt(queryClientId, 12, 'detail', identity(nextWorker++)));
  receipts.push(lifecycleReceipt(queryClientId, 13, 'providerSettlements', identity(nextWorker++)));
  receipts.push(lifecycleReceipt(queryClientId, 14, 'providerSettlements', identity(nextWorker++)));
  receipts.push(lifecycleReceipt(saturationClientId, 1, 'qualificationSpin', identity(nextWorker++), { activeQueries: 1, outcome: 'rejected' }));
  receipts.push(lifecycleReceipt(saturationClientId, 2, 'qualificationSpin', identity(nextWorker++), { activeQueries: 2, outcome: 'rejected' }));
  receipts.push(lifecycleReceipt(saturationClientId, 3, 'qualificationSpin', null, { queued: true, queuedQueries: 1, outcome: 'rejected' }));
  receipts.push(lifecycleReceipt(saturationClientId, 4, 'qualificationSpin', null, { capacityRejected: true, queuedQueries: 1, outcome: 'rejected' }));
  return { receipts, workers: receipts.flatMap((receipt) => receipt.events.filter((event: any) => event.phase === 'spawned').map((event: any) => event.identity)) };
}

function validMixed(mode: 'full' | 'smoke' = 'full') {
  const plan = mode === 'full' ? MIXED_FULL_PLAN : MIXED_SMOKE_PLAN;
  const lifecycle = lifecycleReceipts(plan);
  const timings = Array.from({ length: plan.indexedLookupCount }, (_, index) => index + 1);
  const recorderWorkers = Array.from({ length: plan.hostCount }, (_, index) => ({
    role: 'recorder',
    identity: identity(100 + index),
    states: [
      { state: 'spawned', code: null, signal: null },
      { state: 'ready', code: null, signal: null },
      { state: 'terminal', code: 0, signal: null },
    ],
  }));
  const recorderMemoryWorkers = recorderWorkers.map((worker, index) => ({
    role: 'recorder',
    identity: worker.identity,
    sampleCount: mode === 'full' ? 2 : 1,
    maxRssBytes: 800 + index * 100,
    maxHeapTotalBytes: 900 + index * 100,
    maxHeapUsedBytes: 500 + index * 50,
    maxExternalBytes: 100 + index,
    maxArrayBuffersBytes: 10 + index,
  }));
  const recorderRefreshIdentity = identity(200);
  function recorderTopologySample(label: string, observedAt: string, cpuOffset: number, includeRefresh: boolean) {
    const workers: any[] = recorderWorkers.map((worker, index) => ({
      role: 'recorder',
      identity: worker.identity,
      rssBytes: 700 + index * 100,
      heapTotalBytes: 800 + index * 100,
      heapUsedBytes: 400 + index * 50,
      externalBytes: 90 + index,
      arrayBuffersBytes: 9 + index,
      cpuUsage: { user: 100 + index * 10 + cpuOffset, system: 200 + index * 10 + cpuOffset },
    }));
    if (includeRefresh) {
      workers.push({
        role: 'recorder-refresh',
        identity: recorderRefreshIdentity,
        rssBytes: 950,
        heapTotalBytes: 980,
        heapUsedBytes: 540,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        cpuUsage: { user: 10, system: 10 },
      });
    }
    const totalCohortRssBytes = workers.reduce((sum, worker) => sum + worker.rssBytes, 0);
    return {
      label,
      observedAt,
      hostProcessRssBytes: 2_000,
      workers,
      totalWorkerRssBytes: totalCohortRssBytes,
      totalCohortRssBytes,
      maxWorkerRssBytes: Math.max(...workers.map((worker) => worker.rssBytes)),
    };
  }
  const recorderTopologySamples = [
    recorderTopologySample('started', '2026-09-13T00:00:00.000Z', 0, false),
    recorderTopologySample('late-refresh', '2026-09-13T00:00:01.000Z', 15, true),
    recorderTopologySample('before-shutdown', '2026-09-13T00:00:02.000Z', 30, false),
  ];
  const recorderWorkerCpuDeltaMicros = plan.hostCount * 60;
  const recorderRefreshWorker = {
    role: 'recorder-refresh',
    identity: recorderRefreshIdentity,
    states: [
      { state: 'spawned', code: null, signal: null },
      { state: 'ready', code: null, signal: null },
      { state: 'terminal', code: 0, signal: null },
    ],
    expectedPhases: ['spawned', 'ready', 'terminal'],
    lateCohort: true,
    nativeCollectorBound: false,
    runtimeMemory: {
      start: { rssBytes: 900, heapTotalBytes: 950, heapUsedBytes: 520, externalBytes: 110, arrayBuffersBytes: 11 },
      final: { rssBytes: 950, heapTotalBytes: 980, heapUsedBytes: 540, externalBytes: 120, arrayBuffersBytes: 12 },
      maxRssBytes: 950,
    },
    cpu: {
      start: { user: 5, system: 5 },
      end: { user: 10, system: 10 },
      deltaMicros: 10,
    },
  } as const;
  return {
    mode,
    statsPollMode: undefined as 'full-stats' | 'memory-only' | undefined,
    fixtureRows: plan.fixtureRows,
    hostCount: plan.hostCount,
    productionDefaultRecorderHeap: true,
    recorderHeapCeilingMb: null as number | null,
    recorderHeapMode: 'production-default',
    acceptedRows: plan.fixtureRows + plan.paced.sampleCount + plan.burst.sampleCount,
    acceptedBytes: 10_000,
    endingBacklogRecords: 0,
    endingBacklogBytes: 0,
    dailyProjection: {
      writerPrepared: true,
      preparedBeforePacedAndBurst: true,
      timeZone: 'UTC',
      todayStartMs: 1_780_000_000_000,
      windowStartMs: 1_779_481_600_000,
      windowEndMs: 1_780_086_400_000,
      beforePaced: {
        sourceProviderSettlementRows: 1,
        dailyRows: 1,
        dailyOccurrenceCount: '1',
        todayOccurrenceCount: '1',
        weekOccurrenceCount: '1',
        todayInputTokens: '100',
        weekInputTokens: '100',
      },
      afterBurst: {
        sourceProviderSettlementRows: 2,
        dailyRows: 1,
        dailyOccurrenceCount: '2',
        todayOccurrenceCount: '2',
        weekOccurrenceCount: '2',
        todayInputTokens: '200',
        weekInputTokens: '200',
      },
    },
    pacedIngest: {
      sampleCount: plan.paced.sampleCount,
      ratePerSecond: plan.paced.ratePerSecond,
      submissionElapsedMs: plan.paced.sampleCount * 1_000 / plan.paced.ratePerSecond,
    },
    burstIngest: {
      sampleCount: plan.burst.sampleCount,
      ratePerSecond: plan.burst.ratePerSecond,
      targetDurationMs: plan.burst.durationMs,
      submissionElapsedMs: Math.max(1, plan.burst.durationMs),
      offeredRatePerSecond: plan.burst.ratePerSecond,
      elapsedMs: Math.max(1, plan.burst.durationMs),
    },
    broadScan: { completed: true, count: 1, returnedRows: 250 },
    indexedLookups: {
      count: timings.length,
      timingsMs: timings,
      summary: summarizeMixedTimingSamples(timings),
    },
    querySaturation: {
      requested: plan.saturationQueryCount,
      maxConcurrentQueries: 2,
      maxQueuedQueries: plan.saturationQueueCapacity,
      observedMaxActiveWorkers: 2,
      observedMaxQueuedQueries: plan.saturationQueueCapacity,
      queueCapacityReached: true,
      capacityRejected: 1,
      workerLifecycleComplete: true,
      rejected: plan.saturationQueryCount,
      resolved: 0,
      unsettled: 0,
      completed: true,
    },
    fullReconstruction: { verified: true, payloadBytes: 32_768 },
    nonWritingRefresh: {
      completed: true,
      readerWriting: false,
      afterCommitVisible: true,
      afterDeleteVisible: false,
    },
    recorderMemory: {
      peakProven: false,
      sampledHighWaterProven: true,
      peakMeasurementKind: 'periodic-sampler-high-water',
      qualification: 'measured-recorder-sampled-high-water-only',
      expectedWorkerCount: plan.hostCount,
      maxWorkerRssBytes: 1_100,
      maxWorkerHeapTotalBytes: 1_200,
      maxWorkerHeapUsedBytes: 650,
      sampleCount: mode === 'full' ? 2 : 1,
      workers: recorderMemoryWorkers,
      samplingCoverage: {
        valid: true,
        workerCount: plan.hostCount,
        sampleCount: mode === 'full' ? 2 : 1,
      },
      peakQualification: {
        qualified: false,
        measurementKind: 'periodic-sampler-high-water',
      },
      statsPollMode: undefined as 'full-stats' | 'memory-only' | undefined,
      observerRequest: undefined as 'stats' | 'memorySample' | undefined,
      ...(mode === 'full' ? {
        phases: [
          { label: 'startup', sampleCount: 1, maxWorkerRssBytes: 800, maxWorkerHeapTotalBytes: 900, maxWorkerHeapUsedBytes: 500 },
          { label: 'burst', sampleCount: 1, maxWorkerRssBytes: 1_100, maxWorkerHeapTotalBytes: 1_000, maxWorkerHeapUsedBytes: 700 },
        ],
      } : {}),
    },
    queryHostTopology: {
      hostPeakRssBytes: 2_000,
      hostCpuDeltaMicros: 500,
      recorderWorkerCpuDeltaMicros,
      recorderRefreshWorkerCpuDeltaMicros: 10,
      recorderWorkerCpuDeltaTotalMicros: recorderWorkerCpuDeltaMicros + 10,
      hostProcessCpuDeltaMicros: 500,
      recorderMaxWorkerRssBytes: 1_100,
      recorderTotalCohortRssSamples: [
        { label: 'late-refresh', observedAt: '2026-09-13T00:00:01.000Z', totalCohortRssBytes: 4_350 },
      ],
      recorderSampledMaxTotalCohortRssBytes: 4_350,
      topologySampleIntervalMs: 1_000,
      topologySampleWindow: {
        startAt: '2026-09-13T00:00:00.000Z',
        endAt: '2026-09-13T00:00:02.000Z',
      },
      queryWorkerRssBytes: null,
      queryWorkerCpuDeltaMicros: null,
      queryWorkerTelemetryAvailable: false,
      topologySamples: recorderTopologySamples,
    },
    recorderRefreshWorker,
    candidateArtifacts: {
      provenanceValid: true,
      gitHead: 'a'.repeat(40),
      hostBuildId: 'host-build-20260913-0001',
      rendererBuildId: 'renderer-build-20260913-0001',
      coordinatedBuildId: 'coordinated-build-20260913-0001',
      fingerprint: 'c'.repeat(64),
      files: {
        'extension/out/analytics-recorder-worker.js': { sha256: 'd'.repeat(64), bytes: 12_345 },
        'extension/out/analytics-query-worker.js': { sha256: 'e'.repeat(64), bytes: 23_456 },
        'extension/scripts/analytics-p0-mixed-validation.mjs': { sha256: 'f'.repeat(64), bytes: 34_567 },
      },
    },
    terminalWorkers: {
      complete: true,
      recorder: [
        ...recorderWorkers,
        { role: 'recorder', identity: recorderRefreshWorker.identity, states: [...recorderRefreshWorker.states] },
      ],
      query: lifecycle.workers,
      queryLifecycle: lifecycle.receipts,
      queryLifecycleComplete: true,
    },
  };
}

const EXPECTED_PROVENANCE = {
  valid: true,
  gitHead: 'a'.repeat(40),
  hostBuildId: 'host-build-20260913-0001',
  rendererBuildId: 'renderer-build-20260913-0001',
  coordinatedBuildId: 'coordinated-build-20260913-0001',
  fingerprint: 'c'.repeat(64),
  files: {
    'extension/out/analytics-recorder-worker.js': { sha256: 'd'.repeat(64), bytes: 12_345 },
    'extension/out/analytics-query-worker.js': { sha256: 'e'.repeat(64), bytes: 23_456 },
    'extension/scripts/analytics-p0-mixed-validation.mjs': { sha256: 'f'.repeat(64), bytes: 34_567 },
  },
};

const validateMixedEvidence = (mixed: any, options: any = {}) => validateMixedEvidenceRaw(mixed, {
  expectedProvenance: EXPECTED_PROVENANCE,
  ...options,
});

test('mixed validation preserves individual lookup median/max and leaves topology memory unqualified', () => {
  const result = validateMixedEvidence(validMixed('full'), { mode: 'full' });
  assert.equal(result.valid, true);
  assert.equal(result.memoryValid, false);
  assert.match(result.memoryErrors.join('; '), /query-worker RSS\/CPU/u);
  assert.deepEqual(summarizeMixedTimingSamples([4, 1, 3, 2]), { samples: 4, medianMs: 2.5, maxMs: 4 });
});

test('mixed validation accepts legitimate zero external, array-buffer and CPU metrics', () => {
  const mixed: any = validMixed('full');
  for (const endpoint of [mixed.recorderRefreshWorker.runtimeMemory.start, mixed.recorderRefreshWorker.runtimeMemory.final]) {
    endpoint.externalBytes = 0;
    endpoint.arrayBuffersBytes = 0;
  }
  mixed.recorderRefreshWorker.cpu = {
    start: { user: 0, system: 0 },
    end: { user: 0, system: 0 },
    deltaMicros: 0,
  };
  mixed.queryHostTopology.recorderRefreshWorkerCpuDeltaMicros = 0;
  mixed.queryHostTopology.recorderWorkerCpuDeltaTotalMicros = mixed.queryHostTopology.recorderWorkerCpuDeltaMicros;
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.memoryErrors.some((error) => /runtime memory endpoints|CPU endpoints/u.test(error)), false);
});

test('mixed topology reports concurrent cohort totals and rejects unsafe aggregate or forged claims', () => {
  const overflow: any = validMixed('full');
  const overflowSample = overflow.queryHostTopology.topologySamples[1];
  overflowSample.workers[0].rssBytes = Number.MAX_SAFE_INTEGER;
  overflowSample.workers[1].rssBytes = Number.MAX_SAFE_INTEGER;
  const overflowResult = validateMixedEvidence(overflow, { mode: 'full' });
  assert.equal(overflowResult.memoryValid, false);
  assert.match(overflowResult.memoryErrors.join('; '), /overflows the safe integer range/u);

  const tampered: any = validMixed('full');
  tampered.queryHostTopology.topologySamples[1].totalCohortRssBytes += 1;
  const tamperedResult = validateMixedEvidence(tampered, { mode: 'full' });
  assert.equal(tamperedResult.memoryValid, false);
  assert.match(tamperedResult.memoryErrors.join('; '), /total cohort RSS does not reconcile/u);

  const wrongRole: any = validMixed('full');
  wrongRole.queryHostTopology.topologySamples[1].workers.at(-1).role = 'query';
  const wrongRoleResult = validateMixedEvidence(wrongRole, { mode: 'full' });
  assert.equal(wrongRoleResult.memoryValid, false);
  assert.match(wrongRoleResult.memoryErrors.join('; '), /invalid recorder cohort roles/u);

  const missingConcurrent: any = validMixed('full');
  const concurrentSample = missingConcurrent.queryHostTopology.topologySamples[1];
  concurrentSample.workers = concurrentSample.workers.filter((worker: any) => worker.role !== 'recorder-refresh');
  concurrentSample.totalWorkerRssBytes = 3_400;
  concurrentSample.totalCohortRssBytes = 3_400;
  concurrentSample.maxWorkerRssBytes = 1_000;
  missingConcurrent.queryHostTopology.recorderTotalCohortRssSamples = [];
  missingConcurrent.queryHostTopology.recorderSampledMaxTotalCohortRssBytes = 0;
  const missingConcurrentResult = validateMixedEvidence(missingConcurrent, { mode: 'full' });
  assert.equal(missingConcurrentResult.memoryValid, false);
  assert.match(missingConcurrentResult.memoryErrors.join('; '), /missing a coexisting main and late refresh recorder cohort sample/u);
});

test('mixed receipt provenance requires the trusted exact inventory, hashes and source/build bindings', () => {
  const valid = validMixed('full');
  const receiptOnlyResult = validateMixedEvidenceRaw(valid, { mode: 'full' });
  assert.equal(receiptOnlyResult.valid, false);
  assert.match(receiptOnlyResult.errors.join('; '), /trusted expected artifact provenance/u);
  assert.equal(validateCandidateArtifactProvenance(valid.candidateArtifacts, EXPECTED_PROVENANCE).valid, true);
  const assertMismatch = (mutate: (candidate: any) => void) => {
    const mixed: any = validMixed('full');
    mutate(mixed.candidateArtifacts);
    const result = validateMixedEvidence(mixed, { mode: 'full', expectedProvenance: EXPECTED_PROVENANCE });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('; '), /candidate artifact provenance/u);
  };
  assertMismatch((candidate) => { delete candidate.files['extension/out/analytics-query-worker.js']; });
  assertMismatch((candidate) => { candidate.files['extension/out/extra.js'] = { sha256: '1'.repeat(64), bytes: 1 }; });
  assertMismatch((candidate) => { candidate.files['extension/out/analytics-recorder-worker.js'].sha256 = '1'.repeat(64); });
  assertMismatch((candidate) => { candidate.gitHead = '9'.repeat(40); });
  assertMismatch((candidate) => { candidate.hostBuildId = 'host-build-changed'; });
  assertMismatch((candidate) => { candidate.rendererBuildId = 'renderer-build-changed'; });
  assertMismatch((candidate) => { candidate.coordinatedBuildId = 'coordinated-build-changed'; });
});

test('mixed full pacing meets the sustained sample floor while smoke stays bounded', () => {
  assert.equal(MIXED_FULL_PLAN.paced.sampleCount, 10_000);
  assert.equal(MIXED_SMOKE_PLAN.paced.sampleCount, 20);
});

test('mixed validation rejects incomplete indexed timing evidence', () => {
  const mixed = validMixed('full');
  mixed.indexedLookups.timingsMs = mixed.indexedLookups.timingsMs.slice(0, 9);
  mixed.indexedLookups.count = 9;
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /indexed lookup timings/u);
});

test('mixed validation rejects a finally-captured partial failure envelope', () => {
  const mixed: any = validMixed('full');
  mixed.complete = false;
  mixed.partial = true;
  mixed.partialFailureEvidence = {
    complete: false,
    phase: 'mixed-burst-after-5000',
    failure: { name: 'AnalyticsRecorderWorkerRequestError', message: 'database is locked', requestId: 7, requestType: 'captureBatch' },
    delivery: { acknowledgedRows: 10_000, acknowledgedBytes: 1_000 },
    recorder: { lifecycleComplete: false, lifecycle: [], hosts: [] },
    query: { lifecycleComplete: false, workerLifecycle: [], requestLifecycle: [] },
    recorderMemory: { complete: false, sampleCount: 1, workers: [] },
    nativeProcessTelemetry: { complete: false, receipts: [], rejections: [] },
  };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /explicitly incomplete/u);
});

test('mixed setup failure writes partial evidence and retires owned helpers', { timeout: 15_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-mixed-finally-failure-'));
  const reportPath = path.join(root, 'mixed-failure.json');
  const scriptPath = fileURLToPath(new URL('../../scripts/analytics-p0-qualification.mjs', import.meta.url));
  try {
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--scenario', 'mixed',
      '--smoke',
      '--mixed-utc-day', '2026-09-13',
      '--seed', 'mixed-finally-failure-test',
      '--report', reportPath,
    ], {
      cwd: path.resolve(path.dirname(scriptPath), '../..'),
      env: { ...process.env, PIE_ANALYTICS_P0_RECORDER_HEAP_MB: '16' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, `injected setup failure must fail: ${result.stderr}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.results.mixed.complete, false);
    assert.equal(report.results.mixed.partial, true);
    assert.equal(report.results.mixed.partialFailureEvidence.complete, false);
    assert.equal(report.results.mixed.partialFailureEvidence.query.cleanup.completed, true);
    assert.equal(report.cleanup.completed, true);
    assert.equal(report.cleanup.helpers.remaining, 0, 'finally must retire helpers created before setup failure');
    assert.equal(report.cleanup.ownedScenarioWorkers.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mixed validation requires writer-prepared dated projection growth', () => {
  const mixed = validMixed('full');
  mixed.dailyProjection.afterBurst.dailyOccurrenceCount = '1';
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /daily projection evidence/u);
});

test('mixed validation rejects an unprepared or stale projection window', () => {
  const unprepared = validMixed('full');
  unprepared.dailyProjection.writerPrepared = false;
  const unpreparedResult = validateMixedEvidence(unprepared, { mode: 'full' });
  assert.equal(unpreparedResult.valid, false);
  assert.match(unpreparedResult.errors.join('; '), /writer preparation\/window/u);

  const stale = validMixed('full');
  stale.dailyProjection.windowStartMs += 86_400_000;
  const staleResult = validateMixedEvidence(stale, { mode: 'full' });
  assert.equal(staleResult.valid, false);
  assert.match(staleResult.errors.join('; '), /writer preparation\/window/u);
});

test('mixed validation rejects unresolved saturation and a visible deleted refresh', () => {
  const mixed = validMixed('full');
  mixed.querySaturation.rejected = 3;
  mixed.querySaturation.unsettled = 1;
  mixed.nonWritingRefresh.afterDeleteVisible = true;
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /saturation cancellation/u);
  assert.match(result.errors.join('; '), /non-writing refresh/u);
});

test('mixed validation rejects a declared queue cap without observed active and queued workers', () => {
  const mixed = validMixed('full');
  mixed.querySaturation.observedMaxActiveWorkers = 1;
  mixed.querySaturation.observedMaxQueuedQueries = 0;
  mixed.querySaturation.queueCapacityReached = false;
  mixed.querySaturation.capacityRejected = 0;
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /saturation cancellation/u);
});

test('mixed validation rejects unmeasured burst pacing and incomplete worker lifecycle evidence', () => {
  const mixed = validMixed('full');
  mixed.burstIngest.offeredRatePerSecond = 1;
  mixed.terminalWorkers.query[0].instanceId = 'invalid-worker-identity';
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /burst offered rate/u);
  assert.match(result.errors.join('; '), /terminal recorder\/query/u);
});

test('mixed validation rejects a burst whose measured duration misses the plan', () => {
  const mixed = validMixed('full');
  mixed.burstIngest.submissionElapsedMs = 1;
  mixed.burstIngest.offeredRatePerSecond = mixed.burstIngest.sampleCount / 0.001;
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /submission duration/u);
});

test('mixed validation rejects a report that omits the validated query lifecycle receipt', () => {
  const mixed = validMixed('full');
  const receipt = mixed.terminalWorkers.queryLifecycle[0];
  receipt.events.splice(1, 0, receipt.events[2]);
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /query lifecycle/u);
});

test('mixed validation rejects forged queue snapshots and missing request terminals', () => {
  const mixed = validMixed('full');
  const saturationReceipt = mixed.terminalWorkers.queryLifecycle.find((receipt: any) => receipt.events.some((event: any) => event.phase === 'queued'));
  saturationReceipt.events.find((event: any) => event.phase === 'queued').snapshot.queuedQueries = 0;
  const missingTerminal = mixed.terminalWorkers.queryLifecycle.find((receipt: any) => receipt.events[0].requestType === 'detail');
  missingTerminal.events = missingTerminal.events.filter((event: any) => event.phase !== 'terminal');
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /query lifecycle/u);
});

test('mixed validation rejects forged terminal telemetry and non-null cancellation samples', () => {
  const mixed = validMixed('full');
  const ordinaryReceipt = mixed.terminalWorkers.queryLifecycle[0];
  const ordinaryTerminal = ordinaryReceipt.events.find((event: any) => event.phase === 'terminal');
  ordinaryTerminal.telemetryStatus = 'available';
  ordinaryTerminal.telemetry = {
    workerIdentity: { ...ordinaryTerminal.identity, pid: ordinaryTerminal.identity.pid + 1 },
    maxRssBytes: 8 * 1024 * 1024,
    userCpuTimeMicros: 1,
    systemCpuTimeMicros: 1,
    currentMemory: { rssBytes: 1, heapTotalBytes: 1, heapUsedBytes: 1, externalBytes: 0, arrayBuffersBytes: 0 },
    runtimeSamplePhase: 'after-result-serialization',
  };
  const saturationReceipt = mixed.terminalWorkers.queryLifecycle.find((receipt: any) => receipt.events.some((event: any) => event.phase === 'queued'));
  saturationReceipt.events.push({
    ...saturationReceipt.events.at(-1),
    phase: 'terminal',
    identity: identity(99),
    code: 0,
    signal: null,
    telemetryStatus: 'unavailable-cancelled',
    telemetry: {},
  });
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /terminal telemetry/u);
});

test('mixed validation binds Windows native receipts to every persisted query worker', () => {
  const mixed: any = validMixed('full');
  mixed.nativeProcessTelemetry = { enabled: true, platform: 'win32', receipts: [] };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /native process telemetry.*missing/u);
});

test('mixed smoke remains functional-only and rejects a non-default full heap', () => {
  const smoke = validMixed('smoke');
  const smokeResult = validateMixedEvidence(smoke, { mode: 'smoke' });
  assert.equal(smokeResult.valid, true);
  const full = validMixed('full');
  full.productionDefaultRecorderHeap = false;
  const fullResult = validateMixedEvidence(full, { mode: 'full' });
  assert.equal(fullResult.valid, false);
  assert.match(fullResult.errors.join('; '), /production-default recorder heap/u);
});

test('mixed full accepts only an explicitly bound qualification-only heap probe', () => {
  const probe = validMixed('full');
  probe.productionDefaultRecorderHeap = false;
  probe.recorderHeapCeilingMb = 128;
  probe.recorderHeapMode = 'qualification-only-probe';
  assert.equal(validateMixedEvidence(probe, { mode: 'full', recorderHeapProbeMb: 128 }).valid, true);

  const omitted = validateMixedEvidence(probe, { mode: 'full' });
  assert.equal(omitted.valid, false);
  assert.match(omitted.errors.join('; '), /production-default recorder heap/u);

  const mismatched = validateMixedEvidence(probe, { mode: 'full', recorderHeapProbeMb: 129 });
  assert.equal(mismatched.valid, false);
  assert.match(mismatched.errors.join('; '), /does not match/u);
});

test('mixed recorder evidence distinguishes sampled high-water from a proven process peak', () => {
  const mixed = validMixed('full');
  assert.equal(mixed.recorderMemory.peakProven, false);
  assert.equal(mixed.recorderMemory.sampledHighWaterProven, true);
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.recorderSamplingCoverage, { valid: true, workerCount: 4, sampleCount: 2 });
  assert.deepEqual(result.recorderPeakQualification, { qualified: false, measurementKind: 'periodic-sampler-high-water' });
});

test('mixed observer mode markers must agree in both directions and cannot be partial', () => {
  const contradictory: any = validMixed('full');
  contradictory.statsPollMode = 'memory-only';
  contradictory.recorderMemory.statsPollMode = 'full-stats';
  contradictory.recorderMemory.observerRequest = 'stats';
  const contradictoryResult = validateMixedEvidence(contradictory, {
    mode: 'full',
    statsPollMode: 'memory-only',
    reportConfiguration: { statsPollMode: 'memory-only' },
  });
  assert.equal(contradictoryResult.memoryValid, false);
  assert.match(contradictoryResult.memoryErrors.join('; '), /results\.mixed\.statsPollMode|recorderMemory\.statsPollMode/u);

  const partial: any = validMixed('full');
  partial.statsPollMode = 'full-stats';
  partial.recorderMemory.statsPollMode = 'full-stats';
  partial.recorderMemory.observerRequest = undefined;
  const partialResult = validateMixedEvidence(partial, {
    mode: 'full',
    statsPollMode: 'full-stats',
    reportConfiguration: { statsPollMode: 'full-stats' },
  });
  assert.equal(partialResult.memoryValid, false);
  assert.match(partialResult.memoryErrors.join('; '), /observerRequest.*missing/u);

  const unknown: any = validMixed('full');
  unknown.statsPollMode = 'bogus';
  unknown.recorderMemory.statsPollMode = 'bogus';
  unknown.recorderMemory.observerRequest = 'stats';
  const unknownResult = validateMixedEvidence(unknown, { mode: 'full', reportConfiguration: { statsPollMode: 'bogus' } as any });
  assert.equal(unknownResult.memoryValid, false);
  assert.match(unknownResult.memoryErrors.join('; '), /unknown/u);
});

test('mixed recorder memory requires genuine declared identity, role and topology coverage', () => {
  const duplicate: any = validMixed('full');
  duplicate.recorderMemory.workers[1] = { ...duplicate.recorderMemory.workers[0] };
  const duplicateResult = validateMixedEvidence(duplicate, { mode: 'full' });
  assert.equal(duplicateResult.memoryValid, false);
  assert.match(duplicateResult.memoryErrors.join('; '), /duplicated|do not match|coverage/u);

  const missing: any = validMixed('full');
  missing.recorderMemory.workers = missing.recorderMemory.workers.slice(0, 3);
  const missingResult = validateMixedEvidence(missing, { mode: 'full' });
  assert.equal(missingResult.memoryValid, false);
  assert.match(missingResult.memoryErrors.join('; '), /exactly 4 workers|coverage/u);

  const forged: any = validMixed('full');
  forged.recorderMemory.workers[0].identity = identity(999);
  forged.recorderMemory.workers[0].role = 'query';
  const forgedResult = validateMixedEvidence(forged, { mode: 'full' });
  assert.equal(forgedResult.memoryValid, false);
  assert.match(forgedResult.memoryErrors.join('; '), /role must be recorder|no matching declared recorder identity/u);
});

test('mixed recorder CPU evidence rejects invalid counters and endpoint identity proof', () => {
  for (const invalid of [Number.NaN, null, -1, 'not-a-counter']) {
    const mixed: any = validMixed('full');
    mixed.queryHostTopology.recorderWorkerCpuDeltaMicros = invalid;
    const result = validateMixedEvidence(mixed, { mode: 'full' });
    assert.equal(result.memoryValid, false, `invalid CPU value ${String(invalid)} must not qualify`);
    assert.match(result.memoryErrors.join('; '), /recorderWorkerCpuDeltaMicros.*finite non-negative/u);
  }

  const missing: any = validMixed('full');
  delete missing.queryHostTopology.recorderWorkerCpuDeltaMicros;
  const missingResult = validateMixedEvidence(missing, { mode: 'full' });
  assert.equal(missingResult.memoryValid, false);
  assert.match(missingResult.memoryErrors.join('; '), /recorderWorkerCpuDeltaMicros/u);

  const forgedEndpoint: any = validMixed('full');
  forgedEndpoint.queryHostTopology.topologySamples[1].workers[0].identity = identity(998);
  const forgedEndpointResult = validateMixedEvidence(forgedEndpoint, { mode: 'full' });
  assert.equal(forgedEndpointResult.memoryValid, false);
  assert.match(forgedEndpointResult.memoryErrors.join('; '), /CPU.*no matching sampled recorder identity|endpoint identities/u);
});

test('mixed memory error reports native final-counter coverage when runtime samples are unavailable', () => {
  const mixed: any = validMixed('full');
  const nativeIdentity = mixed.terminalWorkers.query[0].identity;
  mixed.nativeProcessTelemetry = {
    enabled: true,
    platform: 'win32',
    qualificationOnly: true,
    overhead: { collectorProcessExcludedFromWorkloadTotals: true, pairedBaselineRequired: true, protocolBytes: 0, protocolWrites: 0 },
    rejections: [],
    receipts: [{
      requestKey: '00000000-0000-4000-8000-000000000101:1',
      identity: nativeIdentity,
      status: 'available',
      reason: null,
      memory: { peakWorkingSetBytes: 4_096, units: 'bytes' },
      cpu: { userCpuTimeMicros: 1, systemCpuTimeMicros: 1, units: 'microseconds' },
      final: { handleRetainedThroughExit: true, exitTime100ns: '1', observationKind: 'retained-through-exit' },
      handleRetainedThroughExit: true,
      handleClosed: true,
      registration: { creationWindowMatch: true, creationTime100ns: '1', imagePath: 'node.exe' },
    }],
  };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /native process telemetry/u);
  assert.match(result.memoryErrors.join('; '), /runtime terminal telemetry is available for 0\/16/u);
  assert.match(result.memoryErrors.join('; '), /Union coverage with valid native OS final-counter receipts is 0\/16/u);
  assert.match(result.memoryErrors.join('; '), /Native OS final-counter evidence is available for 1\/1/u);
});

function unionCoverageFixture() {
  const mixed: any = validMixed('full');
  const lifecycle: any[] = mixed.terminalWorkers.queryLifecycle;
  for (const receipt of lifecycle) {
    const terminal = receipt.events.find((event: any) => event.phase === 'terminal');
    if (!terminal) continue;
    if (receipt.events[0].requestType === 'qualificationSpin') {
      terminal.telemetryStatus = 'unavailable-cancelled';
      terminal.telemetry = null;
    } else {
      terminal.telemetryStatus = 'available';
      terminal.telemetry = {
        workerIdentity: terminal.identity,
        maxRssBytes: 4_096 + receipt.requestId,
        userCpuTimeMicros: 10,
        systemCpuTimeMicros: 5,
        currentMemory: { rssBytes: 4_000, heapTotalBytes: 4_000, heapUsedBytes: 3_000, externalBytes: 0, arrayBuffersBytes: 0 },
        runtimeSamplePhase: 'after-result-serialization',
      };
    }
  }
  const spinReceipts = lifecycle.filter((receipt: any) => receipt.events[0].requestType === 'qualificationSpin'
    && receipt.events.some((event: any) => event.phase === 'spawned'));
  const spinWorkers = spinReceipts
    .map((receipt: any) => receipt.events.find((event: any) => event.phase === 'spawned').identity);
  // The real collector emits a receipt for every registered worker; fast
  // one-shot workers whose race was lost stay honestly unavailable and rely
  // on their runtime terminal samples.
  const ordinaryReceipts = lifecycle.filter((receipt: any) => receipt.events[0].requestType !== 'qualificationSpin');
  const nativeOnlyWorkers = spinWorkers.map((worker: any) => ({ ...worker, source: 'native-os-final' }));
  mixed.nativeProcessTelemetry = {
    enabled: true,
    platform: 'win32',
    qualificationOnly: true,
    expectedImagePath: 'node.exe',
    configuredMinActiveHandles: 2,
    actualActiveHandles: 5,
    actualPeakActiveHandles: 8,
    overhead: { collectorProcessExcludedFromWorkloadTotals: true, pairedBaselineRequired: true, protocolBytes: 0, protocolWrites: 0 },
    protocolErrors: [],
    rejections: [],
    receipts: [
      ...spinWorkers.map((identity: any, index: number) => ({
        requestKey: `saturation-client:${index + 1}`,
        identity,
        status: 'available',
        reason: null,
        memory: { peakWorkingSetBytes: 5_000 + index, units: 'bytes' },
        cpu: { userCpuTimeMicros: 20, systemCpuTimeMicros: 30, units: 'microseconds' },
        final: { exitTime100ns: '1', handleRetainedThroughExit: true, observationKind: 'retained-through-exit' },
        handleRetainedThroughExit: true,
        handleClosed: true,
        registration: {
          creationWindowMatch: true,
          creationTime100ns: '1',
          imagePath: 'node.exe',
          imagePathNormalized: 'node.exe',
          imagePathSource: 'owned-handle',
          imagePathMatch: true,
          imagePathProof: 'owned-handle-normalized-match',
        },
        concurrency: { activeHandlesAtReceipt: 5, peakActiveHandles: 8, configuredMinActiveHandles: 2 },
      })),
      ...ordinaryReceipts.map((receipt: any) => ({
        requestKey: `ordinary-client:${receipt.requestId}`,
        identity: receipt.events.find((event: any) => event.phase === 'spawned').identity,
        status: 'unavailable',
        reason: 'open-process-failed',
        memory: null,
        cpu: null,
        handleRetainedThroughExit: false,
        handleClosed: true,
      })),
    ],
  };
  // The fixture's own union claim: runtime max RSS 4110 (requestId 14),
  // native peak 5001, CPU 14 runtime workers x 15 micros plus 2 native x 50.
  mixed.queryHostTopology = {
    ...mixed.queryHostTopology,
    queryWorkerRssBytes: 5_001,
    queryWorkerCpuDeltaMicros: 14 * 15 + 2 * 50,
    queryWorkerTelemetryAvailable: true,
    queryWorkerTelemetryCoverage: {
      workerCount: 16,
      runtimeCoveredCount: 14,
      nativeAvailableCount: 2,
      unionCoveredCount: 16,
      unionComplete: true,
      nativeOnlyWorkers,
    },
  };
  return mixed;
}

test('mixed memory qualifies through runtime and native union coverage of every query worker', () => {
  const mixed = unionCoverageFixture();
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.memoryValid, true, result.memoryErrors.join('; '));
});

test('mixed memory rejects claimed union RSS/CPU that the persisted evidence does not support', () => {
  const mixed = unionCoverageFixture();
  mixed.queryHostTopology = {
    ...mixed.queryHostTopology,
    queryWorkerRssBytes: 999,
    queryWorkerCpuDeltaMicros: 1,
  };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, true);
  assert.equal(result.memoryValid, false);
  assert.match(result.memoryErrors.join('; '), /does not match the persisted terminal evidence/u);
});

test('native-only worker coverage reconciles as an exact identity set, not aggregate counts', () => {
  const duplicated = unionCoverageFixture();
  duplicated.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers = [
    ...duplicated.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers,
    duplicated.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers[0],
  ];
  const duplicatedResult = validateMixedEvidence(duplicated, { mode: 'full' });
  assert.equal(duplicatedResult.memoryValid, false);
  assert.match(duplicatedResult.memoryErrors.join('; '), /native-only worker identity is duplicated/u);

  const missing = unionCoverageFixture();
  missing.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers = [];
  const missingResult = validateMixedEvidence(missing, { mode: 'full' });
  assert.equal(missingResult.memoryValid, false);
  assert.match(missingResult.memoryErrors.join('; '), /native-only worker set is missing 2/u);

  const extra = unionCoverageFixture();
  extra.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers = [
    ...extra.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers,
    { ...identity(999), source: 'native-os-final' },
  ];
  const extraResult = validateMixedEvidence(extra, { mode: 'full' });
  assert.equal(extraResult.memoryValid, false);
  assert.match(extraResult.memoryErrors.join('; '), /native-only worker identity is extra or unknown/u);

  const mislabelled = unionCoverageFixture();
  const runtimeCoveredReceipt = mislabelled.terminalWorkers.queryLifecycle.find((receipt: any) => receipt.events[0].requestType === 'query');
  const runtimeCoveredIdentity = runtimeCoveredReceipt.events.find((event: any) => event.phase === 'spawned').identity;
  mislabelled.queryHostTopology.queryWorkerTelemetryCoverage.nativeOnlyWorkers = [
    { ...runtimeCoveredIdentity, source: 'native-os-final' },
  ];
  const mislabelledResult = validateMixedEvidence(mislabelled, { mode: 'full' });
  assert.equal(mislabelledResult.memoryValid, false);
  assert.match(mislabelledResult.memoryErrors.join('; '), /already covered by a runtime terminal sample/u);

  const inflatedCounts = unionCoverageFixture();
  inflatedCounts.queryHostTopology.queryWorkerTelemetryCoverage.nativeAvailableCount = 99;
  const inflatedCountsResult = validateMixedEvidence(inflatedCounts, { mode: 'full' });
  assert.equal(inflatedCountsResult.memoryValid, false);
  assert.match(inflatedCountsResult.memoryErrors.join('; '), /coverage counts do not reconcile with the exact identity sets/u);
});

test('query-worker CPU totals reject safe-integer overflow instead of emitting unsafe values', () => {
  const runtimeOverflow = unionCoverageFixture();
  const firstRuntimeReceipt = runtimeOverflow.terminalWorkers.queryLifecycle.find((receipt: any) => receipt.events[0].requestType === 'query');
  const firstRuntimeTerminal = firstRuntimeReceipt.events.find((event: any) => event.phase === 'terminal');
  firstRuntimeTerminal.telemetry.systemCpuTimeMicros = Number.MAX_SAFE_INTEGER;
  const runtimeOverflowResult = validateMixedEvidence(runtimeOverflow, { mode: 'full' });
  assert.equal(runtimeOverflowResult.memoryValid, false);
  assert.match(runtimeOverflowResult.memoryErrors.join('; '), /overflows the safe integer range/u);

  const claimedUnsafe = unionCoverageFixture();
  claimedUnsafe.queryHostTopology.queryWorkerCpuDeltaMicros = Number.MAX_SAFE_INTEGER + 1;
  const claimedUnsafeResult = validateMixedEvidence(claimedUnsafe, { mode: 'full' });
  assert.equal(claimedUnsafeResult.memoryValid, false);
  assert.match(claimedUnsafeResult.memoryErrors.join('; '), /must be a non-negative safe integer; overflow is rejected/u);
});

test('mixed memory stays unqualified when a worker is covered by neither source', () => {
  const mixed = unionCoverageFixture();
  mixed.nativeProcessTelemetry.receipts = mixed.nativeProcessTelemetry.receipts.slice(1);
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /native process telemetry.*missing/u);
  assert.match(result.memoryErrors.join('; '), /Union coverage with valid native OS final-counter receipts is 15\/16/u);
});

test('sampler phase labels attach at poll start and are never relabelled in flight', { timeout: 15_000 }, async () => {
  const workerStats = {
    process: {
      workerIdentity: identity(300),
      rss: 1_000,
      heapTotal: 1_100,
      heapUsed: 500,
      external: 10,
      arrayBuffers: 1,
      cpuUsage: { user: 3, system: 4 },
    },
  };
  let resolvePoll!: (value: unknown) => void;
  const deferredPoll = new Promise((resolve) => { resolvePoll = resolve; });
  const hosts = [{ poll: () => deferredPoll }];
  const sampler = startWorkerMemorySampler(hosts, 'phase-test', 60_000, {
    initialPhase: 'at-start',
    poll: (host: { poll: () => Promise<unknown> }) => host.poll(),
  });
  // The initial poll is in flight; a phase marked while it is in flight must
  // not relabel that sample, and the next poll picks up the new phase.
  sampler.mark('while-in-flight');
  resolvePoll(workerStats);
  const summary = await sampler.stop();
  assert.equal(summary.sampleCount, 2);
  assert.deepEqual(summary.phases.map((phase: any) => phase.label), ['at-start', 'while-in-flight']);
  assert.equal(summary.phases[0].sampleCount, 1);
  assert.ok(new Date(summary.firstPollStartedAt as string).getTime() <= new Date(summary.lastPollStartedAt as string).getTime());
  assert.ok(new Date(summary.lastPollStartedAt as string).getTime() <= new Date(summary.lastObservedAt as string).getTime());
});

test('mixed late refresh recorder evidence must be explicit, bound and reconciled', () => {
  const missing: any = validMixed('full');
  delete missing.recorderRefreshWorker;
  const missingResult = validateMixedEvidence(missing, { mode: 'full' });
  assert.equal(missingResult.memoryValid, false);
  assert.match(missingResult.memoryErrors.join('; '), /late refresh worker evidence is missing/u);

  const forgedStates: any = validMixed('full');
  forgedStates.recorderRefreshWorker.states[2] = { state: 'terminal', code: null, signal: null };
  const forgedStatesResult = validateMixedEvidence(forgedStates, { mode: 'full' });
  assert.equal(forgedStatesResult.memoryValid, false);
  assert.match(forgedStatesResult.memoryErrors.join('; '), /terminal state requires exactly one valid exit code or signal/u);

  const identityMismatch: any = validMixed('full');
  identityMismatch.recorderRefreshWorker.identity = identity(400);
  const identityMismatchResult = validateMixedEvidence(identityMismatch, { mode: 'full' });
  assert.equal(identityMismatchResult.memoryValid, false);
  assert.match(identityMismatchResult.memoryErrors.join('; '), /must bind exactly one terminal worker to the late refresh writer identity, found 0/u);

  const unboundTopology: any = validMixed('full');
  unboundTopology.queryHostTopology.recorderRefreshWorkerCpuDeltaMicros = 99;
  const unboundTopologyResult = validateMixedEvidence(unboundTopology, { mode: 'full' });
  assert.equal(unboundTopologyResult.memoryValid, false);
  assert.match(unboundTopologyResult.memoryErrors.join('; '), /recorderRefreshWorkerCpuDeltaMicros must equal/u);

  const perWorkerMaxMismatch: any = validMixed('full');
  perWorkerMaxMismatch.queryHostTopology.recorderMaxWorkerRssBytes = 2;
  const perWorkerMaxResult = validateMixedEvidence(perWorkerMaxMismatch, { mode: 'full' });
  assert.equal(perWorkerMaxResult.memoryValid, false);
  assert.match(perWorkerMaxResult.memoryErrors.join('; '), /recorderMaxWorkerRssBytes must equal the recomputed per-worker maximum/u);

  const totalDeltaMismatch: any = validMixed('full');
  totalDeltaMismatch.queryHostTopology.recorderWorkerCpuDeltaTotalMicros = 1;
  const totalDeltaResult = validateMixedEvidence(totalDeltaMismatch, { mode: 'full' });
  assert.equal(totalDeltaResult.memoryValid, false);
  assert.match(totalDeltaResult.memoryErrors.join('; '), /recorderWorkerCpuDeltaTotalMicros must equal/u);
});

test('mixed recorder high-water above the 256 MiB ordinary-ingestion gate fails memory with phase evidence', () => {
  const mixed: any = validMixed('full');
  mixed.recorderMemory = {
    ...mixed.recorderMemory,
    maxWorkerRssBytes: 285_000_000,
    phases: [
      { label: 'startup', sampleCount: 1, maxWorkerRssBytes: 80_000_000, maxWorkerHeapTotalBytes: 90_000_000, maxWorkerHeapUsedBytes: 50_000_000 },
      { label: 'burst', sampleCount: 1, maxWorkerRssBytes: 285_000_000, maxWorkerHeapTotalBytes: 150_000_000, maxWorkerHeapUsedBytes: 30_000_000 },
    ],
  };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.memoryValid, false);
  assert.match(result.memoryErrors.join('; '), /exceeds the 268435456-byte \(256 MiB\) ordinary-ingestion gate by 16564544 bytes/u);
  assert.match(result.memoryErrors.join('; '), /The highest main-cohort phase is "burst" at 285000000 bytes/u);
  assert.match(result.memoryErrors.join('; '), /No production-default memory qualification is claimed/u);
});

test('mixed full recorder memory requires phase attribution that covers the sampled window', () => {
  const mixed: any = validMixed('full');
  delete mixed.recorderMemory.phases;
  const missingResult = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(missingResult.memoryValid, false);
  assert.match(missingResult.memoryErrors.join('; '), /recorder phase attribution does not cover/u);

  const inconsistent: any = validMixed('full');
  inconsistent.recorderMemory.phases[1].sampleCount = 2;
  const inconsistentResult = validateMixedEvidence(inconsistent, { mode: 'full' });
  assert.equal(inconsistentResult.memoryValid, false);
  assert.match(inconsistentResult.memoryErrors.join('; '), /recorder phase attribution does not cover/u);
});

test('mixed memory receipts cannot be substituted across observer modes', () => {
  const declaredMemoryOnly = validMixed('full');
  const mismatched = validateMixedEvidence(declaredMemoryOnly, { mode: 'full', statsPollMode: 'memory-only' });
  assert.equal(mismatched.memoryValid, false);
  assert.match(mismatched.memoryErrors.join('; '), /cannot be substituted across observer modes/u);

  const receiptWithoutMarker = validMixed('full');
  delete receiptWithoutMarker.recorderMemory.statsPollMode;
  const legacyDefault = validateMixedEvidence(receiptWithoutMarker, { mode: 'full' });
  assert.equal(
    legacyDefault.memoryErrors.some((error) => error.includes('cannot be substituted across observer modes')),
    false,
    'a receipt from before the marker existed must stay valid as the historical full-stats default',
  );

  const matching = validMixed('full');
  matching.statsPollMode = 'memory-only';
  matching.recorderMemory.statsPollMode = 'memory-only';
  matching.recorderMemory.observerRequest = 'memorySample';
  const accepted = validateMixedEvidence(matching, {
    mode: 'full',
    statsPollMode: 'memory-only',
    reportConfiguration: { statsPollMode: 'memory-only' },
  });
  assert.equal(
    accepted.memoryErrors.some((error) => error.includes('cannot be substituted across observer modes')),
    false,
  );
});

test('stats-poll-mode preflight rejects invalid values and non-mixed scenarios before spawning', { timeout: 20_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-mixed-stats-poll-mode-'));
  const scriptPath = fileURLToPath(new URL('../../scripts/analytics-p0-qualification.mjs', import.meta.url));
  const spawnOptions = {
    cwd: path.resolve(path.dirname(scriptPath), '../..'),
    encoding: 'utf8' as const,
    timeout: 15_000,
  };
  try {
    const invalidValue = spawnSync(process.execPath, [
      scriptPath,
      '--scenario', 'mixed',
      '--mixed-utc-day', '2026-09-13',
      '--seed', 'arg-check',
      '--report', path.join(root, 'invalid-value.json'),
      '--stats-poll-mode', 'bogus',
    ], spawnOptions);
    assert.equal(invalidValue.status, 1, `invalid value must fail preflight: ${invalidValue.stderr}`);
    assert.match(invalidValue.stderr, /--stats-poll-mode must be one of/u);

    const wrongScenario = spawnSync(process.execPath, [
      scriptPath,
      '--scenario', 'endurance',
      '--smoke',
      '--seed', 'arg-check',
      '--report', path.join(root, 'wrong-scenario.json'),
      '--stats-poll-mode', 'memory-only',
    ], spawnOptions);
    assert.equal(wrongScenario.status, 1, `non-mixed scenario must fail preflight: ${wrongScenario.stderr}`);
    assert.match(wrongScenario.stderr, /--stats-poll-mode is valid only for the mixed scenario/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stats-poll-mode memory-only is accepted for mixed validate mode and recorded in configuration', { timeout: 30_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-mixed-stats-poll-accept-'));
  const scriptPath = fileURLToPath(new URL('../../scripts/analytics-p0-qualification.mjs', import.meta.url));
  try {
    const reportPath = path.join(root, 'validated-memory-only.json');
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--scenario', 'mixed',
      '--mixed-utc-day', '2026-09-13',
      '--seed', 'stats-poll-mode-accept',
      '--report', reportPath,
      '--validate',
      '--stats-poll-mode', 'memory-only',
    ], {
      cwd: path.resolve(path.dirname(scriptPath), '../..'),
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.configuration.scenario, 'mixed');
    assert.equal(report.configuration.statsPollMode, 'memory-only', 'the accepted mode must be recorded in the report configuration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
