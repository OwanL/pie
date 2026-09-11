import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCapacityCalibration,
  projectCapacityFromCalibration,
  validateCapacitySnapshotInventory,
  validateCapacityCalibration,
  validateTerminalWorkerEvidence,
  validateTerminalWorkerSummaries,
  summarizeTimingSamples,
  planBoundedLoadBatches,
  buildExpectedTopologySamplePlan,
  validateMemoryTopologySamples,
} from '../../extension/scripts/analytics-p0-capacity.mjs';

const BASELINE_ROWS = 10_000;
const BASELINE_DETAIL_ROWS = 1_000;
const SAFETY_FACTOR = 1.25;

test('summarizes one million timings without a variadic call-stack boundary', () => {
  const values = Array.from({ length: 1_000_000 }, (_, index) => index % 1_000);
  const originalEdges = [...values.slice(0, 16), ...values.slice(-16)];
  assert.deepEqual(summarizeTimingSamples(values), {
    samples: 1_000_000,
    p50Ms: 499,
    p95Ms: 949,
    p99Ms: 989,
    maxMs: 999,
  });
  assert.deepEqual([...values.slice(0, 16), ...values.slice(-16)], originalEdges, 'source samples remain immutable');
});

test('plans a detail fixture larger than the queue as independently drainable batches', () => {
  const sizes = [
    ...Array.from({ length: 1_000 }, () => 2 * 1024),
    ...Array.from({ length: 40 }, () => 2 * 1024 ** 2),
  ];
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) > 64 * 1024 ** 2);
  const batches = planBoundedLoadBatches(sizes, { maxRecords: 1_000, maxBytes: 16 * 1024 ** 2 });
  assert.deepEqual(batches.map(({ start, end }) => sizes.slice(start, end)).flat(), sizes);
  assert.equal(batches[0].records, 1_000);
  assert.equal(batches.at(-1).records, 8);
  for (const batch of batches) {
    assert.ok(batch.records > 0 && batch.records <= 1_000);
    assert.ok(batch.bytes > 0 && batch.bytes <= 16 * 1024 ** 2);
    assert.equal(batch.bytes, sizes.slice(batch.start, batch.end).reduce((sum, size) => sum + size, 0));
  }
  assert.throws(() => planBoundedLoadBatches([16 * 1024 ** 2 + 1], { maxRecords: 1_000, maxBytes: 16 * 1024 ** 2 }), /exceeds/u);
  assert.throws(() => planBoundedLoadBatches([0], { maxRecords: 1_000, maxBytes: 16 * 1024 ** 2 }), /positive/u);
});

test('summarizes the conditional ten-million timing tier without variadic arguments', {
  skip: process.env.PIE_ANALYTICS_P0_TEST_10M !== '1',
}, () => {
  const values = new Uint8Array(10_000_000);
  values[values.length - 1] = 1;
  assert.deepEqual(summarizeTimingSamples(values), {
    samples: 10_000_000,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 1,
  });
});

test('rejects missing and malformed timing evidence', () => {
  for (const values of [[], new DataView(new ArrayBuffer(8)), [0, Number.NaN], [0, Number.POSITIVE_INFINITY], [0, -1], [0, '1']]) {
    assert.throws(() => summarizeTimingSamples(values), /timing sample/u);
  }
});

function topologyWorker(instance, rssBytes) {
  return {
    identity: {
      pid: 100 + instance,
      spawnedAtMs: 1_780_000_000_000 + instance,
      instanceId: `${String(instance).padStart(8, '0')}-1111-4111-8111-111111111111`,
    },
    rssBytes,
  };
}

function topologySample(label, phase, observedAt, producerRssBytes, workers) {
  const totalWorkerRssBytes = workers.reduce((sum, worker) => sum + worker.rssBytes, 0);
  return {
    label,
    phase,
    observedAt,
    producerRssBytes,
    workers,
    totalWorkerRssBytes,
    maxWorkerRssBytes: Math.max(...workers.map((worker) => worker.rssBytes)),
    totalTopologyRssBytes: producerRssBytes + totalWorkerRssBytes,
  };
}

function terminalWorkerSummary(identity) {
  return {
    identity: structuredClone(identity),
    states: [
      { state: 'spawned', code: null, signal: null },
      { state: 'ready', code: null, signal: null },
      { state: 'terminal', code: 0, signal: null },
    ],
  };
}

function validTopologyEvidence(rows = 10_000) {
  const plan = buildExpectedTopologySamplePlan({ rows, maxQueueBytes: 64 * 1024 ** 2 });
  const factWorkers = [1, 2, 3, 4].map((instance) => topologyWorker(instance, 100 * instance));
  const detailWorker = topologyWorker(5, 300);
  const nestedWorker = topologyWorker(6, 250);
  const samples = plan.map((entry, index) => topologySample(
    entry.label,
    entry.phase,
    new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(),
    1_000 + 100 * index,
    entry.phase === 'facts' ? structuredClone(factWorkers)
      : entry.phase === 'variable-details' ? [structuredClone(detailWorker)]
        : [structuredClone(nestedWorker)],
  ));
  return {
    plan,
    samples,
    recorderWorkers: [...factWorkers, detailWorker, nestedWorker]
      .map((worker) => terminalWorkerSummary(worker.identity)),
  };
}

test('recomputes the complete fact and detail topology RSS sample plan', () => {
  const { plan, samples, recorderWorkers } = validTopologyEvidence();
  assert.deepEqual(plan, [
    { label: 'after-fact-flush', phase: 'facts', workerCount: 4 },
    { label: 'after-detail-batch-1000', phase: 'variable-details', workerCount: 1 },
    { label: 'after-nested-detail-drain', phase: 'nested-details', workerCount: 1 },
  ]);
  assert.deepEqual(validateMemoryTopologySamples(samples, { expectedPlan: plan, recorderWorkers }), {
    valid: true,
    errors: [],
    sampleCount: 3,
    maxWorkerRssBytes: 400,
    maxTotalTopologyRssBytes: 2_000,
    sampledWorkerCount: 6,
  });
  assert.throws(
    () => buildExpectedTopologySamplePlan({ rows: 10_010_000, maxQueueBytes: 64 * 1024 ** 2 }),
    /between 10000 and 10000000/u,
  );
});

test('rejects omitted, reordered, malformed, and unreconciled topology evidence', () => {
  const { plan, samples: valid, recorderWorkers } = validTopologyEvidence();
  const cases = [
    ['omitted sample', (samples) => { samples.pop(); }],
    ['reordered sample', (samples) => { samples.reverse(); }],
    ['extra field', (samples) => { samples[0].extra = true; }],
    ['duplicate label', (samples) => { samples[1].label = samples[0].label; }],
    ['noncanonical timestamp', (samples) => { samples[0].observedAt = '2026-09-12T00:00:00Z'; }],
    ['reversed timestamp', (samples) => { samples[1].observedAt = '2026-09-11T23:59:59.000Z'; }],
    ['wrong worker count', (samples) => { samples[0].workers.pop(); }],
    ['duplicate sample worker', (samples) => { samples[0].workers[1] = structuredClone(samples[0].workers[0]); }],
    ['changed worker identity', (samples) => { samples[0].workers[1].identity.instanceId = samples[0].workers[0].identity.instanceId; }],
    ['cross-sample identity mutation', (samples) => { samples[1].workers[0].identity.instanceId = samples[0].workers[0].identity.instanceId; }],
    ['invalid worker RSS', (samples) => { samples[0].workers[0].rssBytes = 0; }],
    ['changed worker total', (samples) => { samples[0].totalWorkerRssBytes += 1; }],
    ['changed worker maximum', (samples) => { samples[0].maxWorkerRssBytes += 1; }],
    ['changed topology total', (samples) => { samples[0].totalTopologyRssBytes += 1; }],
  ];
  for (const [label, mutate] of cases) {
    const samples = structuredClone(valid);
    mutate(samples);
    const result = validateMemoryTopologySamples(samples, { expectedPlan: plan, recorderWorkers });
    assert.equal(result.valid, false, label);
    assert.ok(result.errors.length > 0, label);
  }
});

test('binds topology samples to terminal workers and stable phase identity sets', () => {
  const evidence = validTopologyEvidence(20_000);
  assert.equal(validateMemoryTopologySamples(evidence.samples, {
    expectedPlan: evidence.plan,
    recorderWorkers: evidence.recorderWorkers,
  }).valid, true);

  const cases = [
    ['missing lifecycle', (samples, workers) => { workers.pop(); }],
    ['reordered lifecycle states', (samples, workers) => { workers[0].states.reverse(); }],
    ['unmatched sampled identity', (samples) => {
      samples[0].workers[0].identity.instanceId = '99999999-9999-4999-8999-999999999999';
    }],
    ['substituted fact worker', (samples, workers) => {
      const replacement = topologyWorker(7, samples[1].workers[0].rssBytes);
      samples[1].workers[0] = replacement;
      workers.push(terminalWorkerSummary(replacement.identity));
    }],
    ['detail worker changed between batches', (samples, workers) => {
      const detailIndexes = samples.map((sample, index) => sample.phase === 'variable-details' ? index : -1).filter((index) => index >= 0);
      const replacement = topologyWorker(8, samples[detailIndexes[1]].workers[0].rssBytes);
      samples[detailIndexes[1]].workers[0] = replacement;
      workers.push(terminalWorkerSummary(replacement.identity));
    }],
    ['nested worker reused from detail phase', (samples) => {
      const detail = samples.find((sample) => sample.phase === 'variable-details');
      const nested = samples.find((sample) => sample.phase === 'nested-details');
      nested.workers[0].identity = structuredClone(detail.workers[0].identity);
    }],
  ];
  for (const [label, mutate] of cases) {
    const samples = structuredClone(evidence.samples);
    const workers = structuredClone(evidence.recorderWorkers);
    mutate(samples, workers);
    const result = validateMemoryTopologySamples(samples, {
      expectedPlan: evidence.plan,
      recorderWorkers: workers,
    });
    assert.equal(result.valid, false, label);
    assert.ok(result.errors.length > 0, label);
  }
});

function workerEvents(states = ['spawned', 'ready', 'terminal']) {
  const identity = { pid: 42, spawnedAtMs: 1_780_000_000_000, instanceId: '11111111-1111-4111-8111-111111111111' };
  return states.map((state) => ({ state, identity, code: state === 'terminal' ? 0 : undefined, signal: null }));
}

test('requires exact ordered worker lifecycle evidence and rejects tampering', () => {
  assert.equal(validateTerminalWorkerEvidence(workerEvents()).valid, true);
  assert.equal(validateTerminalWorkerEvidence(workerEvents(['spawned', 'terminal']), { requireReady: false }).valid, true);
  for (const states of [
    ['terminal', 'ready', 'spawned'],
    ['spawned', 'terminal', 'ready'],
    ['spawned', 'ready', 'unknown', 'terminal'],
    ['spawned', 'ready'],
    ['spawned', 'ready', 'terminal', 'terminal'],
  ]) {
    assert.equal(validateTerminalWorkerEvidence(workerEvents(states)).valid, false, states.join(','));
  }
});

test('round-trips exact terminal worker summaries through report JSON', () => {
  const secondIdentity = {
    pid: 43,
    spawnedAtMs: 1_780_000_000_001,
    instanceId: '22222222-2222-4222-8222-222222222222',
  };
  const captured = validateTerminalWorkerEvidence([
    ...workerEvents(),
    ...workerEvents().map((event) => ({ ...event, identity: secondIdentity })),
  ]);
  assert.equal(captured.valid, true);
  const reportSummaries = JSON.parse(JSON.stringify(captured.workers));
  assert.equal(validateTerminalWorkerSummaries(reportSummaries).valid, true);
  assert.equal(validateTerminalWorkerSummaries(reportSummaries).workers.length, 2);
  assert.equal(validateTerminalWorkerSummaries(reportSummaries, { requireReady: false }).valid, false);

  const corruptStart = validateTerminalWorkerEvidence(
    workerEvents(['spawned', 'terminal']),
    { requireReady: false },
  );
  assert.equal(corruptStart.valid, true);
  assert.equal(validateTerminalWorkerSummaries(
    JSON.parse(JSON.stringify(corruptStart.workers)),
    { requireReady: false },
  ).valid, true);

  const cases = [
    ['reordered states', (workers) => { workers[0].states.reverse(); }],
    ['duplicate state', (workers) => { workers[0].states.push(structuredClone(workers[0].states[2])); }],
    ['unknown state', (workers) => { workers[0].states[1].state = 'unknown'; }],
    ['identity mutation', (workers) => { workers[0].identity.pid = 0; }],
    ['missing identity field', (workers) => { delete workers[0].identity.spawnedAtMs; }],
    ['extra identity field', (workers) => { workers[0].identity.extra = true; }],
    ['duplicate identity', (workers) => { workers.push(structuredClone(workers[0])); }],
    ['extra worker field', (workers) => { workers[0].extra = true; }],
    ['extra state field', (workers) => { workers[0].states[0].extra = true; }],
    ['spawned exit code', (workers) => { workers[0].states[0].code = 0; }],
    ['ready exit signal', (workers) => { workers[0].states[1].signal = 'SIGTERM'; }],
    ['terminal malformed code', (workers) => { workers[0].states[2].code = {}; }],
    ['terminal malformed signal', (workers) => {
      workers[0].states[2].code = null;
      workers[0].states[2].signal = 42;
    }],
    ['terminal unknown signal', (workers) => {
      workers[0].states[2].code = null;
      workers[0].states[2].signal = 'not-a-signal';
    }],
    ['terminal dual authority', (workers) => { workers[0].states[2].signal = 'SIGTERM'; }],
    ['terminal missing authority', (workers) => { workers[0].states[2].code = null; }],
    ['terminal negative code', (workers) => { workers[0].states[2].code = -1; }],
    ['terminal unbounded signal', (workers) => {
      workers[0].states[2].code = null;
      workers[0].states[2].signal = 'S'.repeat(129);
    }],
    ['empty state list', (workers) => { workers[0].states = []; }],
    ['missing state list', (workers) => { delete workers[0].states; }],
  ];
  for (const [label, mutate] of cases) {
    const workers = structuredClone(reportSummaries);
    mutate(workers);
    assert.equal(validateTerminalWorkerSummaries(workers).valid, false, label);
  }
});

function snapshot(treeBytes, mainDatabaseBytes, mainFileBytes) {
  return { treeBytes, mainDatabaseBytes, mainFileBytes };
}

function validSnapshots() {
  return {
    beforePrimaryFacts: snapshot(1_000, 0, 0),
    afterPrimaryFacts: snapshot(10_001_000, 10_000_000, 9_500_000),
    afterVariableDetails: snapshot(30_001_000, 30_000_000, 29_500_000),
    finalBeforeFault: snapshot(40_001_000, 30_000_000, 29_500_000),
  };
}

function validCalibration() {
  return buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: validSnapshots(),
    observedTreeBytes: [50_000_000],
    prewriteProjectedTreeBytes: [75_000_000],
  });
}

function validInventory() {
  return {
    label: 'after-primary-facts',
    treeBytes: 162,
    mainDatabaseBytes: 112,
    mainFileBytes: 100,
    files: [
      { path: 'analytics.sqlite', bytes: 100 },
      { path: 'analytics.sqlite-wal', bytes: 10 },
      { path: 'analytics.sqlite-shm', bytes: 2 },
      { path: 'fixed-worker.log', bytes: 50 },
    ],
  };
}

test('validates the complete analytics DB-family inventory and exact tree totals', () => {
  const result = validateCapacitySnapshotInventory(validInventory(), {
    mainDatabaseFile: 'analytics.sqlite',
    expectedLabel: 'after-primary-facts',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects inventory tampering, unsafe paths, invalid bytes, and missing files', () => {
  const cases = [
    ['changed tree total', (inventory) => { inventory.treeBytes += 1; }],
    ['changed family total', (inventory) => { inventory.mainDatabaseBytes += 1; }],
    ['changed main-file total', (inventory) => { inventory.mainFileBytes += 1; }],
    ['case-variant duplicate', (inventory) => { inventory.files.push({ path: 'ANALYTICS.SQLITE', bytes: 1 }); }],
    ['parent traversal', (inventory) => { inventory.files[3].path = '../fixed-worker.log'; }],
    ['terminal parent segment', (inventory) => { inventory.files[3].path = 'nested/..'; }],
    ['terminal current segment', (inventory) => { inventory.files[3].path = 'nested/.'; }],
    ['backslash path', (inventory) => { inventory.files[3].path = 'fixed\\worker.log'; }],
    ['drive path', (inventory) => { inventory.files[3].path = 'C:/fixed-worker.log'; }],
    ['altered raw label', (inventory) => { inventory.label = 'after-variable-details'; }],
    ['negative bytes', (inventory) => { inventory.files[3].bytes = -1; }],
    ['unsafe bytes', (inventory) => { inventory.files[3].bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['unknown bytes', (inventory) => { inventory.files[3].bytes = undefined; }],
    ['missing files', (inventory) => { inventory.files = undefined; }],
    ['empty file inventory', (inventory) => { inventory.files = []; }],
  ];
  for (const [label, mutate] of cases) {
    const inventory = structuredClone(validInventory());
    mutate(inventory);
    const result = validateCapacitySnapshotInventory(inventory, {
      mainDatabaseFile: 'analytics.sqlite',
      expectedLabel: 'after-primary-facts',
    });
    assert.equal(result.valid, false, label);
    assert.ok(result.errors.length > 0, label);
  }
});

test('calibrates separate components before an in-place disposable fault', () => {
  const calibration = validCalibration();
  const validation = validateCapacityCalibration(calibration, {
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
  });

  assert.equal(validation.valid, true);
  assert.equal(calibration.baselineRows, BASELINE_ROWS);
  assert.equal(calibration.detailRows, BASELINE_DETAIL_ROWS);
  assert.equal(calibration.faultModel, 'in-place-terminal-corruption');
  assert.deepEqual(calibration.components, {
    primaryFactBytes: 10_000_000,
    variableDetailBytes: 20_000_000,
    fixedTreeBytes: 20_000_000,
    finalMainDatabaseBytes: 30_000_000,
    finalMainFileBytes: 29_500_000,
    preFaultHighWaterBytes: 50_000_000,
  });
  assert.deepEqual(calibration.prewriteProjectedTreeBytes, [75_000_000]);
  assert.equal(calibration.observedHighWaterBytes, 50_000_000);
  assert.equal(calibration.prewriteHighWaterBytes, 75_000_000);
  assert.equal(calibration.conservativeHighWaterBytes, 75_000_000);
});

test('scales facts/details and takes the maximum contained fault footprint without summing the database twice', () => {
  const projection = projectCapacityFromCalibration(validCalibration(), {
    targetRows: 1_000_000,
    safetyFactor: SAFETY_FACTOR,
  });

  assert.equal(projection.targetRows, 1_000_000);
  assert.equal(projection.rowRatio, 100);
  assert.equal(projection.safetyFactor, SAFETY_FACTOR);
  assert.deepEqual(projection.components, {
    fixedTreeBytes: 20_000_000,
    primaryFactBytes: 1_250_000_000,
    variableDetailBytes: 2_500_000_000,
    projectedMainDatabaseBytes: 3_750_000_000,
  });
  assert.equal(projection.projectedSteadyTreeBytes, 3_770_000_000);
  assert.equal(projection.projectedFaultPeakBytes, 3_770_000_000);
  assert.equal(projection.projectedPeakBytes, 3_770_000_000);
});

test('uses the conservatively projected contained database family when it exceeds component steady state', () => {
  const snapshots = validSnapshots();
  snapshots.finalBeforeFault = snapshot(50_000_000, 35_000_000, 34_500_000);
  const calibration = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots,
    observedTreeBytes: [50_000_000],
    prewriteProjectedTreeBytes: [50_000_000],
  });
  const projection = projectCapacityFromCalibration(calibration, {
    targetRows: 1_000_000,
    safetyFactor: SAFETY_FACTOR,
  });
  assert.equal(projection.projectedSteadyTreeBytes, 3_770_000_000);
  assert.equal(projection.components.projectedMainDatabaseBytes, 4_375_000_000);
  assert.equal(projection.projectedPeakBytes, 4_375_000_000);
});

test('rejects reverse, negative, unknown, and offsetting deltas', () => {
  const reverseTree = validSnapshots();
  reverseTree.afterPrimaryFacts.treeBytes = 900;
  const reverseCalibration = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: reverseTree,
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  });
  assert.equal(validateCapacityCalibration(reverseCalibration, {
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
  }).valid, false);
  assert.throws(
    () => projectCapacityFromCalibration(reverseCalibration, { targetRows: 1_000_000, safetyFactor: SAFETY_FACTOR }),
    /invalid|calibration|delta|snapshot/i,
  );

  const reverseDatabase = validSnapshots();
  reverseDatabase.afterVariableDetails.mainDatabaseBytes = 8_000_000;
  const reverseDatabaseCalibration = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: reverseDatabase,
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  });
  assert.equal(validateCapacityCalibration(reverseDatabaseCalibration, {
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
  }).valid, false);

  const offsetting = validSnapshots();
  offsetting.finalBeforeFault.treeBytes = 1_000;
  const offsettingCalibration = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: offsetting,
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  });
  assert.equal(validateCapacityCalibration(offsettingCalibration, {
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
  }).valid, false);

  for (const field of ['treeBytes', 'mainDatabaseBytes']) {
    const snapshots = validSnapshots();
    snapshots.afterPrimaryFacts[field] = -1;
    assert.throws(() => buildCapacityCalibration({
      baselineRows: BASELINE_ROWS,
      detailRows: BASELINE_DETAIL_ROWS,
      snapshots,
      observedTreeBytes: [],
      prewriteProjectedTreeBytes: [],
    }), /non-negative|safe integer/i);
  }
  const unknown = validSnapshots();
  unknown.afterVariableDetails.treeBytes = undefined;
  assert.throws(() => buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: unknown,
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  }), /non-negative|safe integer/i);
});

test('requires a measured final database before an in-place fault', () => {
  const snapshots = validSnapshots();
  snapshots.finalBeforeFault.mainFileBytes = 0;
  const calibration = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots,
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  });
  const validation = validateCapacityCalibration(calibration, {
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.reason, /main database file/i);
});

test('rejects non-integral or sub-baseline target rows', () => {
  const calibration = validCalibration();
  for (const targetRows of [0, 9_999, 10_001, 1_000_001]) {
    assert.throws(
      () => projectCapacityFromCalibration(calibration, { targetRows, safetyFactor: SAFETY_FACTOR }),
      /multiple|baseline|integer|target/i,
    );
  }
});

test('requires detail ratio and both observed and prewrite capacity evidence', () => {
  const missingEvidence = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS,
    snapshots: validSnapshots(),
    observedTreeBytes: [],
    prewriteProjectedTreeBytes: [],
  });
  assert.equal(missingEvidence.eligible, false);
  assert.match(missingEvidence.errors.join('; '), /observed.*missing/i);
  assert.match(missingEvidence.errors.join('; '), /prewrite.*missing/i);

  const wrongDetailRatio = buildCapacityCalibration({
    baselineRows: BASELINE_ROWS,
    detailRows: BASELINE_DETAIL_ROWS + 1,
    snapshots: validSnapshots(),
    observedTreeBytes: [50_000_000],
    prewriteProjectedTreeBytes: [75_000_000],
  });
  assert.equal(wrongDetailRatio.eligible, false);
  assert.match(wrongDetailRatio.errors.join('; '), /detailRows.*one tenth/i);
});
