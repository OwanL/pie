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
  validateMixedEvidence: (mixed: any, options: { mode: 'full' | 'smoke'; recorderHeapProbeMb?: number }) => {
    valid: boolean;
    errors: string[];
    memoryValid: boolean;
    memoryErrors: string[];
  };
};

const {
  MIXED_FULL_PLAN,
  MIXED_SMOKE_PLAN,
  summarizeMixedTimingSamples,
  validateMixedEvidence,
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
  return {
    mode,
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
      maxWorkerRssBytes: 1_000,
      sampleCount: mode === 'full' ? 2 : 1,
      ...(mode === 'full' ? {
        phases: [
          { label: 'startup', sampleCount: 1, maxWorkerRssBytes: 800, maxWorkerHeapTotalBytes: 900, maxWorkerHeapUsedBytes: 500 },
          { label: 'burst', sampleCount: 1, maxWorkerRssBytes: 1_000, maxWorkerHeapTotalBytes: 1_100, maxWorkerHeapUsedBytes: 700 },
        ],
      } : {}),
    },
    queryHostTopology: {
      hostPeakRssBytes: 2_000,
      hostCpuDeltaMicros: 500,
      hostProcessCpuDeltaMicros: 500,
      queryWorkerRssBytes: null,
      queryWorkerCpuDeltaMicros: null,
      queryWorkerTelemetryAvailable: false,
    },
    candidateArtifacts: {
      provenanceValid: true,
      gitHead: 'a'.repeat(40),
      coordinatedBuildId: 'b'.repeat(20),
      fingerprint: 'c'.repeat(64),
      files: { 'extension/out/analytics-recorder-worker.js': { sha256: 'd'.repeat(64), bytes: 1 } },
    },
    terminalWorkers: {
      complete: true,
      recorder: [{ identity: { pid: 1, spawnedAtMs: 2, instanceId: '00000000-0000-4000-8000-000000000001' } }],
      query: lifecycle.workers,
      queryLifecycle: lifecycle.receipts,
      queryLifecycleComplete: true,
    },
  };
}

test('mixed validation preserves individual lookup median/max and leaves topology memory unqualified', () => {
  const result = validateMixedEvidence(validMixed('full'), { mode: 'full' });
  assert.equal(result.valid, true);
  assert.equal(result.memoryValid, false);
  assert.match(result.memoryErrors.join('; '), /query-worker RSS\/CPU/u);
  assert.deepEqual(summarizeMixedTimingSamples([4, 1, 3, 2]), { samples: 4, medianMs: 2.5, maxMs: 4 });
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
  assert.equal(validateMixedEvidence(mixed, { mode: 'full' }).valid, true);
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
  mixed.nativeProcessTelemetry = {
    enabled: true,
    platform: 'win32',
    qualificationOnly: true,
    overhead: { collectorProcessExcludedFromWorkloadTotals: true, pairedBaselineRequired: true, protocolBytes: 0, protocolWrites: 0 },
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
        registration: { creationWindowMatch: true, creationTime100ns: '1', imagePath: 'node.exe' },
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
  return mixed;
}

test('mixed memory qualifies through runtime and native union coverage of every query worker', () => {
  const mixed = unionCoverageFixture();
  const ordinaryMaxRss = 4_096 + 14;
  const nativePeak = 5_001;
  mixed.queryHostTopology = {
    ...mixed.queryHostTopology,
    queryWorkerRssBytes: nativePeak,
    queryWorkerCpuDeltaMicros: 14 * 15 + 2 * 50,
    queryWorkerTelemetryAvailable: true,
    queryWorkerTelemetryCoverage: {
      workerCount: 16,
      runtimeCoveredCount: 14,
      nativeAvailableCount: 2,
      unionCoveredCount: 16,
      unionComplete: true,
      nativeOnlyWorkers: [],
    },
  };
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
    queryWorkerTelemetryAvailable: true,
    queryWorkerTelemetryCoverage: {
      workerCount: 16,
      runtimeCoveredCount: 14,
      nativeAvailableCount: 2,
      unionCoveredCount: 16,
      unionComplete: true,
      nativeOnlyWorkers: [],
    },
  };
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, true);
  assert.equal(result.memoryValid, false);
  assert.match(result.memoryErrors.join('; '), /does not match the persisted terminal evidence/u);
});

test('mixed memory stays unqualified when a worker is covered by neither source', () => {
  const mixed = unionCoverageFixture();
  mixed.nativeProcessTelemetry.receipts = mixed.nativeProcessTelemetry.receipts.slice(1);
  const result = validateMixedEvidence(mixed, { mode: 'full' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('; '), /native process telemetry.*missing/u);
  assert.match(result.memoryErrors.join('; '), /Union coverage with valid native OS final-counter receipts is 15\/16/u);
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
  assert.match(result.memoryErrors.join('; '), /The highest phase is "burst" at 285000000 bytes/u);
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
