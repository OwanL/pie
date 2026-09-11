import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCapacityCalibration,
  projectCapacityFromCalibration,
  validateCapacitySnapshotInventory,
  validateCapacityCalibration,
  validateTerminalWorkerEvidence,
} from '../../extension/scripts/analytics-p0-capacity.mjs';

const BASELINE_ROWS = 10_000;
const BASELINE_DETAIL_ROWS = 1_000;
const SAFETY_FACTOR = 1.25;

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
