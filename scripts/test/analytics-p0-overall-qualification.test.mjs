import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

import {
  buildOverallQualificationReport,
  computeQualificationSourceFingerprint,
  recomputeOverallQualification,
  validateOverallQualificationRecomputation,
} from '../../extension/scripts/analytics-p0-overall-qualification.mjs';

const sourceFiles = Object.freeze({
  'extension/out/analytics-recorder-worker.js': Object.freeze({ sha256: 'b'.repeat(64), bytes: 123 }),
  'extension/scripts/analytics-p0-schema-faults.mjs': Object.freeze({ sha256: 'c'.repeat(64), bytes: 456 }),
  'extension/scripts/analytics-p0-matched-host.mjs': Object.freeze({ sha256: 'd'.repeat(64), bytes: 789 }),
});
const sourceIdentity = Object.freeze({
  gitHead: 'a'.repeat(40),
  hostBuildId: 'qualification-test-build',
  rendererBuildId: 'qualification-test-build',
  files: sourceFiles,
});
const bindings = Object.freeze({
  sourceHead: sourceIdentity.gitHead,
  buildId: sourceIdentity.hostBuildId,
  sourceFingerprint: computeQualificationSourceFingerprint(sourceIdentity),
});

function componentReport(filePath, scenario, results) {
  return {
    schemaVersion: 5,
    ...(scenario === 'schema-faults' ? { kind: 'pie-p0-schema-faults-v1' } : {}),
    ...(scenario === 'matched-host' ? { kind: 'pie-p0-matched-host-v1' } : {}),
    harnessVersion: 'test-component-v1',
    status: 'passed',
    configuration: { scenario, rows: null, seed: 'overall-test', reportPath: filePath },
    provenance: {
      valid: true,
      gitHead: bindings.sourceHead,
      hostBuildId: bindings.buildId,
      rendererBuildId: bindings.buildId,
      coordinatedBuildId: bindings.buildId,
      fingerprint: bindings.sourceFingerprint,
      files: sourceFiles,
    },
    results,
    measurement: { completed: true },
    cleanup: { completed: true, rootRemoved: true },
    qualification: {
      scenario,
      decision: 'scenario-passed',
      failedGates: [],
      overallP0: 'unqualified',
    },
  };
}

function withRoot(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-p0-overall-test-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('missing scenario reports remain explicitly unqualified', () => withRoot((root) => {
  const report = buildOverallQualificationReport({
    reportPath: path.join(root, 'overall.json'),
    seed: 'overall-test',
    ...bindings,
    evidenceReports: {},
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.qualification.overallP0, 'unqualified');
  assert.equal(report.qualification.failedGates.length, 0);
  assert.ok(report.qualification.unqualifiedGates.includes('tenMillionHistory'));
  assert.match(report.gates.tenMillionHistory.reason, /missing required evidence: tenMillion/);
  assert.equal(validateOverallQualificationRecomputation(report, bindings).valid, true);
}));

test('schema/fault and matched-host gates are recomputed from raw receipts', () => withRoot((root) => {
  const schemaPath = path.join(root, 'schema.json');
  const hostPath = path.join(root, 'host.json');
  writeFileSync(schemaPath, JSON.stringify(componentReport(schemaPath, 'schema-faults', {
    schemaFaults: {
      upgrade: {
        fromVersion: 2,
        toVersion: 13,
        retainedFactsBefore: 7,
        retainedFactsAfter: 7,
        retainedDetailsBefore: 2,
        retainedDetailsAfter: 2,
        deletionMarkersBefore: 1,
        deletionMarkersAfter: 1,
        projectionRevisionBefore: 4,
        projectionRevisionAfter: 5,
        postUpgradeCaptureAccepted: true,
        deletedSubjectRejected: true,
      },
      partialWrite: {
        firstSubjectCommitted: true,
        secondSubjectRejected: true,
        replayCompleted: true,
        duplicateReplayNoOp: true,
        expectedRowsAfterReplay: 2,
        actualRowsAfterReplay: 2,
      },
      corruption: { recorderRejected: true, queryRejected: true, workersTerminal: true },
    },
  })));
  writeFileSync(hostPath, JSON.stringify(componentReport(hostPath, 'matched-host', {
    matchedHost: {
      sameWorkload: true,
      sameHostBuildConfig: true,
      disabled: {
        sampleCount: 10,
        agentTurnaroundP95Ms: 100,
        cancellationP95Ms: 50,
        failoverP95Ms: 60,
        uiInteractionP95Ms: 20,
        streamPaintP95Ms: 30,
        activeCaptureCpuOneCorePercent: 5,
      },
      enabled: {
        sampleCount: 10,
        agentTurnaroundP95Ms: 99,
        cancellationP95Ms: 49,
        failoverP95Ms: 59,
        uiInteractionP95Ms: 19,
        streamPaintP95Ms: 29,
        localSummaryFreshnessP95Ms: 200,
        localSummaryFreshnessP99Ms: 400,
        crossHostSummaryFreshnessMs: 900,
        idleAnalyticsCpuOneCorePercent: 0.25,
        activeCaptureCpuOneCorePercent: 14,
        incrementalRetainedHostBytes: 8 * 1024 ** 2,
      },
    },
  })));

  const report = buildOverallQualificationReport({
    reportPath: path.join(root, 'overall.json'),
    seed: 'overall-test',
    ...bindings,
    evidenceReports: { schemaFaults: schemaPath, matchedHost: hostPath },
  });

  assert.equal(report.gates.schemaV2AndFaults.decision, 'passed');
  assert.equal(report.gates.matchedAgentUi.decision, 'passed');
  assert.equal(report.gates.incrementalHostMemory.decision, 'passed');
  assert.equal(report.qualification.overallP0, 'unqualified');
  assert.equal(validateOverallQualificationRecomputation(report, bindings).valid, true);

  const host = JSON.parse(readFileSync(hostPath, 'utf8'));
  host.results.matchedHost.enabled.incrementalRetainedHostBytes = 32 * 1024 ** 2;
  writeFileSync(hostPath, JSON.stringify(host));
  const tampered = validateOverallQualificationRecomputation(report, bindings);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.errors.some((error) => /evidence bytes do not match/.test(error)));
}));

test('incomplete schema counts and source manifests cannot qualify', () => withRoot((root) => {
  const schemaPath = path.join(root, 'schema-incomplete.json');
  const component = componentReport(schemaPath, 'schema-faults', {
    schemaFaults: {
      upgrade: {
        fromVersion: 1,
        toVersion: 2,
        projectionRevisionBefore: 1,
        projectionRevisionAfter: 2,
        postUpgradeCaptureAccepted: true,
        deletedSubjectRejected: true,
      },
      partialWrite: {
        firstSubjectCommitted: true,
        secondSubjectRejected: true,
        replayCompleted: true,
        duplicateReplayNoOp: true,
      },
      corruption: { recorderRejected: true, queryRejected: true, workersTerminal: true },
    },
  });
  component.provenance.fingerprint = createHash('sha256').update(JSON.stringify({
    harnessVersion: component.harnessVersion,
    gitHead: component.provenance.gitHead,
    hostBuildId: component.provenance.hostBuildId,
    rendererBuildId: component.provenance.rendererBuildId,
    files: Object.fromEntries(Object.entries(component.provenance.files)
      .map(([name, receipt]) => [name, receipt.sha256])),
  })).digest('hex');
  writeFileSync(schemaPath, JSON.stringify(component));
  const incomplete = buildOverallQualificationReport({
    reportPath: path.join(root, 'incomplete-overall.json'),
    seed: 'overall-test',
    ...bindings,
    evidenceReports: { schemaFaults: schemaPath },
  });
  assert.equal(incomplete.gates.schemaV2AndFaults.decision, 'failed');
  assert.deepEqual(incomplete.qualification.evidenceErrors, []);

  component.provenance.files = {};
  writeFileSync(schemaPath, JSON.stringify(component));
  const unbound = buildOverallQualificationReport({
    reportPath: path.join(root, 'unbound-overall.json'),
    seed: 'overall-test',
    ...bindings,
    evidenceReports: { schemaFaults: schemaPath },
  });
  assert.equal(unbound.gates.schemaV2AndFaults.decision, 'unqualified');
  assert.ok(unbound.qualification.evidenceErrors.some((error) => /source manifest is incomplete/.test(error)));
}));

test('ten-million validation is an admitted but fail-closed no-workload scenario', () => withRoot((root) => {
  const output = path.join(root, 'ten-million-validation.json');
  const run = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'extension', 'scripts', 'analytics-p0-qualification.mjs'),
    '--scenario', 'ten-million',
    '--validate',
    '--seed', 'ten-million-validation-test',
    '--report', output,
  ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'blocked');
  assert.equal(report.configuration.scenario, 'ten-million');
  assert.equal(report.configuration.rows, 10_000_000);
  assert.equal(report.measurement.completed, false);
  assert.equal(report.results.capacityProjection.decision, 'blocked-capacity');
  assert.ok(report.validation.reasons.some((reason) => /baseline measurement/.test(reason)));
  assert.ok(!report.matrix.intentionallyNotClaimed.includes('10M rows'));
}));

test('reported gate edits do not survive admission recomputation', () => withRoot((root) => {
  const report = buildOverallQualificationReport({
    reportPath: path.join(root, 'overall.json'),
    seed: 'overall-test',
    ...bindings,
    evidenceReports: {},
  });
  report.gates.tenMillionHistory = {
    actual: 10_000_000,
    threshold: 'forged',
    decision: 'passed',
    evidence: {},
  };
  report.qualification.unqualifiedGates = report.qualification.unqualifiedGates.filter((name) => name !== 'tenMillionHistory');
  report.qualification.overallP0 = 'qualified';
  report.qualification.decision = 'overall-qualified';

  const recomputed = recomputeOverallQualification(report, bindings);
  assert.equal(recomputed.gates.tenMillionHistory.decision, 'unqualified');
  const validation = validateOverallQualificationRecomputation(report, bindings);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /tenMillionHistory: reported gate/.test(error)));
}));
