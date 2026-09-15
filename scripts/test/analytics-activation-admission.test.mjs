import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  ActivationEvidenceError,
  CANDIDATE_TRIAL_EVIDENCE_SCHEMAS,
  MAX_ACTIVATION_EVIDENCE_BYTES,
  REQUIRED_CANDIDATE_TRIAL_CHECKS,
  REQUIRED_QUALIFICATION_GATES,
  admitActivationEvidence,
  inspectActivationEvidence,
  recomputeCandidateTrialChecks,
  validateActivationEvidenceStructure,
  validateCandidateTrialArtifactFiles,
} from '../analytics-activation-admission.mjs';

const generationId = '11111111-1111-4111-8111-111111111111';
const buildId = 'build-candidate-1';
const sourceHead = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);
const workspaceId = 'workspace-activation-test';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(filePath, bytes);
  return bytes;
}

function qualificationReport(root, overrides = {}) {
  const qualificationPath = path.join(root, 'qualification.json');
  const rows = 1_000_000;
  const gate = (actual = 1) => ({ actual, threshold: 'test-bound', decision: 'passed', evidence: { observed: true } });
  const gates = Object.fromEntries(REQUIRED_QUALIFICATION_GATES.map((name) => [name, gate(name === 'inPlaceCorruption' ? 'completed' : undefined)]));
  const report = {
    schemaVersion: 5,
    harnessVersion: 'p0-baseline-scale-v7-recorder-heap-ceiling',
    status: 'passed',
    generatedAt: '2026-09-12T00:00:00.000Z',
    finishedAt: '2026-09-12T00:01:00.000Z',
    configuration: { scenario: 'scale', rows, seed: 'activation-test', reportPath: qualificationPath },
    provenance: {
      valid: true,
      gitHead: sourceHead,
      coordinatedBuildId: buildId,
      fingerprint: sourceFingerprint,
      files: { 'candidate.js': { sha256: 'c'.repeat(64), bytes: 1 } },
    },
    measurement: { completed: true, exactPrimaryRows: rows, exactDetailRows: 100_003 },
    cleanup: { completed: true, rootRemoved: true },
    results: {},
    gates,
    qualification: { scenario: 'scale', decision: 'scenario-passed', failedGates: [], overallP0: 'unqualified' },
    ...overrides,
  };
  const bytes = writeJson(qualificationPath, report);
  return { path: qualificationPath, bytes, report };
}

function candidatePlanSha256(identity, workspaceId) {
  return sha256(JSON.stringify([1, 'pie-p7a-candidate-trial-authority-v1', identity, workspaceId]));
}

function candidateChecks(root, qualificationBytes) {
  const trialId = 'trial-activation-test';
  mkdirSync(path.join(root, 'live'), { recursive: true });
  mkdirSync(path.join(root, 'webview', 'panel'), { recursive: true });
  writeFileSync(path.join(root, 'pie-build-id.txt'), `${buildId}\n`);
  writeFileSync(path.join(root, 'webview', 'panel', 'pie-build-id.txt'), `${buildId}\n`);
  const identity = {
    trialId,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    qualificationSha256: sha256(qualificationBytes),
  };
  const receipt = (name) => {
    const filePath = path.join(root, name);
    const bytes = Buffer.from(`fixture artifact: ${name}\n`);
    writeFileSync(filePath, bytes);
    return { path: filePath, sha256: sha256(bytes), bytes: bytes.byteLength };
  };
  const trialRoot = path.join(root, 'trial-owned');
  const cleanupReceipt = {
    trialId,
    completed: true,
    rootRemoved: true,
    stoppedAt: '2026-09-12T00:00:59.000Z',
    failureReasons: [],
  };
  return {
    cleanupReceipt,
    checks: {
      matchedSourceBuildConfig: {
        decision: 'passed',
        evidence: {
          qualification: { path: path.join(root, 'qualification.json'), sha256: identity.qualificationSha256, bytes: qualificationBytes.byteLength },
          trialId,
          generationId,
          buildId,
          sourceHead,
          sourceFingerprint,
          workspaceId,
          trialPlanSha256: candidatePlanSha256(identity, workspaceId),
          producer: receipt('analytics-candidate-trial.js'),
          recorderWorker: receipt('analytics-recorder-worker.js'),
          queryWorker: receipt('analytics-query-worker.js'),
        },
      },
      isolatedRoots: {
        decision: 'passed',
        evidence: {
          rootDir: trialRoot,
          stateDir: path.join(trialRoot, 'state'),
          analyticsDir: path.join(trialRoot, 'analytics'),
          osTempRoot: tmpdir(),
          protectedRoots: [path.join(root, 'live')],
          rootUnderOsTemp: true,
          childrenContained: true,
          protectedRootsDisjoint: true,
        },
      },
      hostBackendRecorderQueryLifecycle: {
        decision: 'passed',
        evidence: {
          readiness: {
            authority: 'candidate-trial', manifestRevision: null, manifestSha256: null,
            generationId, recorderSchemaVersion: 13, projectionRevision: '0', recorderReady: true, queryReady: true,
          },
          descriptor: {
            kind: 'candidate-trial', trialId, generationId, buildId, workspaceId,
            hostInstanceId: 'candidate-host-test', trialPlanSha256: candidatePlanSha256(identity, workspaceId),
            trialAuthorityRevision: 1,
          },
          runtimeStartRepublished: true,
          backendDescriptorAbsent: true,
          loadedReceiptSuppressed: true,
          recorderWorker: { pid: 1234 },
          captureStatuses: { begin: 'submitted', end: 'submitted', phase: 'submitted' },
        },
      },
      canonicalConsumers: {
        decision: 'passed',
        evidence: {
          executionRevision: '2', executionCount: 1, begunCount: 1, settledCount: 1,
          lifecycleCoverage: 'known', storageRevision: '2', queryWorkers: { spawned: 5, terminal: 5 },
        },
      },
      crossHostRevision: {
        decision: 'passed',
        evidence: {
          firstHostRevision: '2', secondHostInitialRevision: '2', secondHostObservedRevision: '3',
          changed: true, revisionPollIntervalMs: 25, maxWaitMs: 3_000,
        },
      },
      durableAndRejectedAcknowledgements: {
        decision: 'passed',
        evidence: {
          durableStatus: 'durable', durableReconciliationCount: 1,
          rejectedStatus: 'rejected', rejectedCode: 'subject_deleted',
        },
      },
      cleanup: {
        decision: 'passed',
        evidence: {
          pendingAfterFence: 0, postFenceSubmissionRejected: true,
          manifestCreatedBeforeCleanup: false, tombstoneCreatedBeforeCleanup: false,
          cleanupReceipt, rootRemovedObserved: true, cleanupError: null,
        },
      },
    },
  };
}

function trialReport(root, qualificationBytes, overrides = {}) {
  const trialPath = path.join(root, 'candidate-trial.json');
  const candidate = candidateChecks(root, qualificationBytes);
  const report = {
    schemaVersion: 1,
    kind: 'pie-p7a-candidate-trial-v1',
    producerVersion: 'p7a-candidate-trial-v1',
    status: 'passed',
    reportPath: trialPath,
    generatedAt: '2026-09-12T00:00:00.000Z',
    finishedAt: '2026-09-12T00:01:00.000Z',
    bindings: {
      trialId: 'trial-activation-test', generationId, buildId, sourceHead, sourceFingerprint,
      qualificationSha256: sha256(qualificationBytes),
    },
    checks: candidate.checks,
    cleanup: candidate.cleanupReceipt,
    errors: [],
    ...overrides,
  };
  const bytes = writeJson(trialPath, report);
  return { path: trialPath, bytes, report };
}

function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-admission-'));
  const qualification = qualificationReport(root, overrides.qualification);
  const trial = trialReport(root, qualification.bytes, overrides.trial);
  const options = {
    qualificationPath: qualification.path,
    trialPath: trial.path,
    generationId,
    buildId,
    sourceHead,
    sourceFingerprint,
    workspaceId,
  };
  return { root, qualification, trial, options };
}

test('structural fixture binds exact source, build, generation, and report hashes', () => {
  const { root, options } = fixture();
  try {
    const admitted = validateActivationEvidenceStructure(options);
    assert.equal(admitted.qualificationState, 'unqualified', 'fixture is structural only, never live qualification');
    assert.match(admitted.qualificationSha256, /^[0-9a-f]{64}$/u);
    assert.match(admitted.trialSha256, /^[0-9a-f]{64}$/u);
    assert.equal(admitted.sourceHead, sourceHead);
    assert.equal(admitted.buildId, buildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live admission rejects the current scenario-passed but overall-unqualified report', () => {
  const { root, options } = fixture();
  try {
    assert.throws(
      () => admitActivationEvidence(options),
      (error) => error instanceof ActivationEvidenceError && /overallP0 is not qualified/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deferred ten-million gate may stay unqualified in a qualified overall report', () => {
  const { root, options, qualification } = fixture();
  try {
    validateActivationEvidenceStructure(options);
    const report = structuredClone(qualification.report);
    report.kind = 'pie-p0-overall-qualification-v1';
    report.configuration = {
      scenario: 'overall', rows: null, seed: 'activation-test', reportPath: qualification.path,
    };
    report.qualification = {
      scenario: 'overall', decision: 'overall-qualified', failedGates: [],
      unqualifiedGates: ['tenMillionHistory'], overallP0: 'qualified',
    };
    report.gates.tenMillionHistory = {
      actual: null, threshold: 'exactly 10,000,000 primary rows; a projection or skip is not a pass',
      decision: 'unqualified', reason: 'deferred unqualified with the measured capacity reason', evidence: {},
    };
    writeJson(qualification.path, report);

    // The deferred-unqualified gate passes the strict per-gate admission loop;
    // the failure must come from the overall recomputation of the missing
    // evidence, not from the deferred gate itself.
    assert.throws(() => admitActivationEvidence(options), (error) => {
      if (!(error instanceof ActivationEvidenceError)) return false;
      return !/gate tenMillionHistory is not passed/u.test(error.message);
    });

    // Any other unqualified gate still fails the strict loop.
    const narrowed = structuredClone(report);
    narrowed.gates.mixedLoad = { actual: null, threshold: 'test-bound', decision: 'unqualified', evidence: {} };
    narrowed.qualification.unqualifiedGates = ['tenMillionHistory', 'mixedLoad'];
    writeJson(qualification.path, narrowed);
    assert.throws(
      () => admitActivationEvidence(options),
      (error) => error instanceof ActivationEvidenceError && /gate mixedLoad is not passed/u.test(error.message),
    );

    // A failed deferred gate is never an accepted skip either.
    const failed = structuredClone(report);
    failed.gates.tenMillionHistory.decision = 'failed';
    failed.qualification.unqualifiedGates = [];
    writeJson(qualification.path, failed);
    assert.throws(
      () => admitActivationEvidence(options),
      (error) => error instanceof ActivationEvidenceError && /gate tenMillionHistory is not passed/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live admission does not trust an overall-qualified flag over recomputed results', () => {
  const { root, options } = fixture({
    qualification: {
      qualification: { scenario: 'scale', decision: 'scenario-passed', failedGates: [], overallP0: 'qualified' },
    },
  });
  try {
    assert.throws(
      () => admitActivationEvidence(options),
      (error) => error instanceof ActivationEvidenceError && /recomputed evidence|owning gate predicate/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed and partial rehearsal reports are rejected', () => {
  const { root, options, qualification, trial } = fixture();
  try {
    writeFileSync(qualification.path, '{"q":1}\n');
    assert.throws(() => validateActivationEvidenceStructure(options), /qualification report: schemaVersion/u);
    writeFileSync(qualification.path, qualification.bytes);
    validateActivationEvidenceStructure(options);
    writeFileSync(trial.path, '{"t":1}\n');
    assert.throws(() => validateActivationEvidenceStructure(options), /candidate trial report:/u);
    assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each failed qualification gate is rejected without deleting the other gate evidence', () => {
  const { root, options, qualification } = fixture();
  try {
    validateActivationEvidenceStructure(options);
    for (const gateName of REQUIRED_QUALIFICATION_GATES) {
      const report = structuredClone(qualification.report);
      report.qualification.overallP0 = 'qualified';
      report.gates[gateName].decision = 'failed';
      writeJson(qualification.path, report);
      assert.throws(
        () => admitActivationEvidence(options),
        (error) => error instanceof ActivationEvidenceError
          && error.message === `qualification report: required gate ${gateName} is not passed with evidence`,
        gateName,
      );
    }
    assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale and mismatched bindings fail closed at the intended validation boundary', () => {
  const cases = [
    { name: 'stale source', options: { sourceHead: 'c'.repeat(40) }, expected: /provenance.gitHead does not match/u },
    { name: 'stale build', options: { buildId: 'old-build' }, expected: /provenance.coordinatedBuildId does not match/u },
    { name: 'wrong workspace', options: { workspaceId: 'other-workspace' }, expected: /workspaceId evidence mismatches/u },
    { name: 'wrong generation', mutate: (report) => { report.bindings.generationId = '22222222-2222-4222-8222-222222222222'; }, expected: /generationId binding mismatches/u },
    { name: 'incomplete trial check', mutate: (report) => { report.checks.isolatedRoots.decision = 'unqualified'; }, expected: /required check isolatedRoots is incomplete/u },
    {
      name: 'reserved report identity',
      mutate: (report, root) => { report.reportPath = path.join(root, 'analytics-activation-v1.json'); },
      options: (root) => ({ trialReportPath: path.join(root, 'analytics-activation-v1.json') }),
      expected: /reserved activation filename/u,
    },
    {
      name: 'report inside protected root',
      mutate: (report, root) => { report.reportPath = path.join(root, 'live', 'trial.json'); },
      options: (root) => ({ trialReportPath: path.join(root, 'live', 'trial.json') }),
      expected: /overlaps a protected/u,
    },
  ];
  for (const entry of cases) {
    const { root, options, trial } = fixture();
    try {
      validateActivationEvidenceStructure(options);
      if (entry.mutate) {
        entry.mutate(trial.report, root);
        writeJson(trial.path, trial.report);
      }
      const optionOverrides = typeof entry.options === 'function' ? entry.options(root) : (entry.options ?? {});
      const combinedOptions = { ...options, ...optionOverrides };
      assert.throws(() => validateActivationEvidenceStructure(combinedOptions), entry.expected, entry.name);
      assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false, entry.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('oversized evidence is rejected before JSON parsing', () => {
  const { root, options } = fixture();
  try {
    writeFileSync(options.qualificationPath, Buffer.alloc(MAX_ACTIVATION_EVIDENCE_BYTES + 1, 0x20));
    assert.throws(() => validateActivationEvidenceStructure(options), /exceeds/u);
    assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function recomputableTrialFixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-trial-verifier-'));
  try {
    const qualification = qualificationReport(root);
    const trial = trialReport(root, qualification.bytes, overrides);
    return {
      root,
      qualification,
      trial,
      expected: {
        generationId,
        buildId,
        sourceHead,
        sourceFingerprint,
        workspaceId,
        qualificationSha256: sha256(qualification.bytes),
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('candidate-trial verifier authoritatively recomputes all seven checks', () => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    assert.deepEqual(Object.keys(CANDIDATE_TRIAL_EVIDENCE_SCHEMAS), REQUIRED_CANDIDATE_TRIAL_CHECKS);
    assert.deepEqual(recomputeCandidateTrialChecks(trial.report, expected), []);
    assert.deepEqual(recomputeCandidateTrialChecks(trial.report, expected), [], 'recomputation is deterministic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each runtime receipt predicate fails closed independently', () => {
  const cases = [
    ['isolatedRoots', (evidence) => { evidence.childrenContained = false; }],
    ['hostBackendRecorderQueryLifecycle', (evidence) => { evidence.backendDescriptorAbsent = false; }],
    ['hostBackendRecorderQueryLifecycle', (evidence) => { evidence.descriptor.workspaceId = 'mixed-trial'; }],
    ['canonicalConsumers', (evidence) => { evidence.queryWorkers.terminal = 4; }],
    ['crossHostRevision', (evidence) => { evidence.changed = false; }],
    ['crossHostRevision', (evidence) => { evidence.secondHostObservedRevision = '1'; }],
    ['crossHostRevision', (evidence) => { evidence.secondHostObservedRevision = '9223372036854775808'; }],
    ['crossHostRevision', (_evidence, report) => { report.checks.canonicalConsumers.evidence.storageRevision = '1'; }],
    ['durableAndRejectedAcknowledgements', (evidence) => { evidence.rejectedCode = 'accepted'; }],
  ];
  for (const [name, mutate] of cases) {
    const { root, trial, expected } = recomputableTrialFixture();
    try {
      mutate(trial.report.checks[name].evidence, trial.report);
      const errors = recomputeCandidateTrialChecks(trial.report, expected);
      assert.equal(errors.length, 1, name);
      assert.match(errors[0], new RegExp(name), name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('matchedSourceBuildConfig binds the exact qualification, source, build, plan, and artifacts', () => {
  const cases = [
    { name: 'missing key', mutate: (evidence) => { delete evidence.sourceFingerprint; }, expected: /evidence keys are invalid/u },
    { name: 'wrong generation', mutate: (evidence) => { evidence.generationId = '22222222-2222-4222-8222-222222222222'; }, expected: /identity or artifact receipts/u },
    { name: 'wrong qualification hash', mutate: (evidence) => { evidence.qualification.sha256 = 'e'.repeat(64); }, expected: /qualification receipt/u },
    { name: 'wrong plan hash', mutate: (evidence) => { evidence.trialPlanSha256 = 'e'.repeat(64); }, expected: /plan hash/u },
    { name: 'unbounded artifact', mutate: (evidence) => { evidence.producer.bytes = MAX_ACTIVATION_EVIDENCE_BYTES + 1; }, expected: /identity or artifact receipts/u },
  ];
  for (const entry of cases) {
    const { root, trial, expected } = recomputableTrialFixture();
    try {
      entry.mutate(trial.report.checks.matchedSourceBuildConfig.evidence);
      assert.match(recomputeCandidateTrialChecks(trial.report, expected).join('; '), entry.expected, entry.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('authoritative admission reopens and hashes exact runner and worker artifacts', () => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    assert.doesNotThrow(() => validateCandidateTrialArtifactFiles(trial.report, expected));
    writeFileSync(path.join(root, 'pie-build-id.txt'), 'stale-build\n');
    assert.throws(() => validateCandidateTrialArtifactFiles(trial.report, expected), /build markers/u);
    writeFileSync(path.join(root, 'pie-build-id.txt'), `${buildId}\n`);
    writeFileSync(trial.report.checks.matchedSourceBuildConfig.evidence.producer.path, 'tampered\n');
    assert.throws(
      () => validateCandidateTrialArtifactFiles(trial.report, expected),
      /producer receipt size|producer artifact hash/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative admission rejects an expected-name artifact symlink', (t) => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    const queryPath = trial.report.checks.matchedSourceBuildConfig.evidence.queryWorker.path;
    const target = path.join(root, 'outside-query-worker.js');
    writeFileSync(target, 'outside artifact\n');
    unlinkSync(queryPath);
    try {
      symlinkSync(target, queryPath, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('file symlinks are not available on this host');
        return;
      }
      throw error;
    }
    assert.throws(
      () => validateCandidateTrialArtifactFiles(trial.report, expected),
      /not the real coordinated-build artifact/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup preserves fencing, manifest suppression, root removal, and failure receipts', () => {
  const cases = [
    (report) => { report.checks.cleanup.evidence.postFenceSubmissionRejected = false; },
    (report) => { report.checks.cleanup.evidence.manifestCreatedBeforeCleanup = true; },
    (report) => { report.checks.cleanup.evidence.cleanupReceipt.failureReasons.push('helper-stop failed'); },
    (report) => { report.cleanup.completed = false; },
  ];
  for (const mutate of cases) {
    const { root, trial, expected } = recomputableTrialFixture();
    try {
      mutate(trial.report);
      assert.match(recomputeCandidateTrialChecks(trial.report, expected).join('; '), /cleanup evidence/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('unknown, missing, and unpassed trial checks fail closed', () => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    const pristine = structuredClone(trial.report);
    trial.report.checks.extraObservation = { decision: 'passed', evidence: { observed: true } };
    assert.match(recomputeCandidateTrialChecks(trial.report, expected).join('; '), /unknown candidate trial check/u);

    const missing = structuredClone(pristine);
    delete missing.checks.cleanup;
    assert.deepEqual(recomputeCandidateTrialChecks(missing, expected), [
      'required candidate trial check cleanup is missing from the report',
    ]);

    const unqualified = structuredClone(pristine);
    unqualified.checks.cleanup.decision = 'unqualified';
    assert.match(recomputeCandidateTrialChecks(unqualified, expected).join('; '), /cleanup is not passed/u);
    assert.deepEqual(recomputeCandidateTrialChecks(pristine, {}), ['candidate trial recompute bindings are incomplete']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production admission exposes the validator but rejects an unqualified P0 report without a manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-admission-recompute-'));
  try {
    const qualification = qualificationReport(root);
    const trial = trialReport(root, qualification.bytes);
    const options = {
      qualificationPath: qualification.path,
      trialPath: trial.path,
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      workspaceId,
    };
    // The structural fixture boundary is unchanged: recomputable evidence is
    // still only a shape check and never live qualification.
    const structure = validateActivationEvidenceStructure(options);
    assert.equal(structure.qualificationState, 'unqualified');
    assert.throws(
      () => admitActivationEvidence(options),
      (error) => error instanceof ActivationEvidenceError && /overallP0 is not qualified/u.test(error.message),
    );
    const inspection = inspectActivationEvidence(options);
    assert.equal(inspection.ready, false);
    assert.equal(inspection.candidateTrialValidatorAvailable, true);
    assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false);
    assert.equal(existsSync(path.join(root, 'analytics-ever-active-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('helper records no manifest when raw rehearsal evidence is supplied', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-helper-admission-'));
  try {
    const qualificationPath = path.join(root, 'q.json');
    const trialPath = path.join(root, 't.json');
    const stateDir = path.join(root, 'state');
    const reportPath = path.join(root, 'report.json');
    writeFileSync(qualificationPath, '{"q":1}\n');
    writeFileSync(trialPath, '{"t":1}\n');
    writeJson(path.join(root, 'plan.json'), {
      stateDir,
      qualificationReport: qualificationPath,
      trialReport: trialPath,
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      workspaceId,
      reportPath,
    });
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/analytics-activation-helper.mjs'),
      '--plan', path.join(root, 'plan.json'),
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /qualification report/u);
    assert.equal(existsSync(path.join(stateDir, 'analytics-activation-v1.json')), false);
    assert.equal(existsSync(path.join(stateDir, 'analytics-ever-active-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
