import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildOverallQualificationReport } from '../../extension/scripts/analytics-p0-overall-qualification.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const producer = path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-schema-faults.mjs');

function runProducer(reportPath, seed = 'schema-faults-test') {
  return spawnSync(process.execPath, [producer, '--seed', seed, '--report', reportPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function sourceFingerprint(provenance) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    gitHead: provenance.gitHead,
    hostBuildId: provenance.hostBuildId,
    rendererBuildId: provenance.rendererBuildId,
    files: Object.fromEntries(Object.entries(provenance.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, receipt]) => [name, receipt.sha256 ?? null])),
  })).digest('hex');
}

test('schema-fault producer measures the built recorder/query fault matrix and removes its root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-p0-schema-fault-test-'));
  try {
    const reportPath = path.join(root, 'schema-faults.json');
    const run = runProducer(reportPath);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.schemaVersion, 5);
    assert.equal(report.kind, 'pie-p0-schema-faults-v1');
    assert.equal(report.configuration.scenario, 'schema-faults');
    assert.equal(report.configuration.reportPath, reportPath);
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.qualification, {
      scenario: 'schema-faults',
      decision: 'scenario-passed',
      failedGates: [],
      overallP0: 'unqualified',
    });
    assert.equal(report.measurement.completed, true);
    assert.deepEqual(report.measurement.queryWorkers, { spawned: 2, terminal: 2, complete: true });
    assert.equal(report.cleanup.completed, true);
    assert.equal(report.cleanup.rootCreated, true);
    assert.equal(report.cleanup.rootRemoved, true);
    assert.equal(existsSync(report.cleanup.rootPath), false);

    const value = report.results.schemaFaults;
    assert.deepEqual(Object.keys(value).sort(), ['corruption', 'partialWrite', 'upgrade']);
    assert.deepEqual(Object.keys(value.upgrade).sort(), [
      'deletedSubjectRejected', 'deletionMarkersAfter', 'deletionMarkersBefore',
      'fromVersion', 'postUpgradeCaptureAccepted', 'projectionRevisionAfter',
      'projectionRevisionBefore', 'retainedDetailsAfter', 'retainedDetailsBefore',
      'retainedFactsAfter', 'retainedFactsBefore', 'toVersion',
    ].sort());
    assert.equal(value.upgrade.fromVersion, 2);
    assert.ok(value.upgrade.toVersion > value.upgrade.fromVersion);
    assert.equal(value.upgrade.retainedFactsAfter, value.upgrade.retainedFactsBefore);
    assert.equal(value.upgrade.retainedDetailsAfter, value.upgrade.retainedDetailsBefore);
    assert.equal(value.upgrade.deletionMarkersAfter, value.upgrade.deletionMarkersBefore);
    assert.ok(value.upgrade.projectionRevisionAfter >= value.upgrade.projectionRevisionBefore);
    assert.equal(value.upgrade.postUpgradeCaptureAccepted, true);
    assert.equal(value.upgrade.deletedSubjectRejected, true);
    assert.deepEqual(value.partialWrite, {
      firstSubjectCommitted: true,
      secondSubjectRejected: true,
      replayCompleted: true,
      duplicateReplayNoOp: true,
      expectedRowsAfterReplay: 2,
      actualRowsAfterReplay: 2,
    });
    assert.deepEqual(value.corruption, {
      recorderRejected: true,
      queryRejected: true,
      workersTerminal: true,
    });

    assert.equal(report.provenance.valid, true);
    assert.equal(report.provenance.hostBuildId, report.provenance.rendererBuildId);
    assert.equal(report.provenance.coordinatedBuildId, report.provenance.hostBuildId);
    assert.equal(report.provenance.fingerprint, sourceFingerprint(report.provenance));
    assert.ok(report.provenance.files['extension/out/analytics-sqlite-recorder.js']);
    assert.ok(report.provenance.files['extension/out/analytics-query-worker.js']);
    assert.match(report.provenance.scenarioHarness.sha256, /^[0-9a-f]{64}$/u);

    const overall = buildOverallQualificationReport({
      reportPath: path.join(root, 'overall.json'),
      seed: 'schema-faults-test',
      sourceHead: report.provenance.gitHead,
      buildId: report.provenance.coordinatedBuildId,
      sourceFingerprint: report.provenance.fingerprint,
      evidenceReports: { schemaFaults: reportPath },
    });
    assert.equal(overall.gates.schemaV2AndFaults.decision, 'passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema-fault producer refuses to overwrite prior evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-p0-schema-fault-new-report-'));
  try {
    const reportPath = path.join(root, 'existing.json');
    writeFileSync(reportPath, 'prior-evidence');
    const run = runProducer(reportPath, 'schema-fault-existing-test');
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /report must name a new file/iu);
    assert.equal(readFileSync(reportPath, 'utf8'), 'prior-evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
