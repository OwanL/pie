import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../analytics-activation-admission.mjs';

const generationId = '11111111-1111-4111-8111-111111111111';
const buildId = 'build-candidate-1';
const sourceHead = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);

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

function trialReport(root, qualificationBytes, overrides = {}) {
  const trialPath = path.join(root, 'candidate-trial.json');
  const report = {
    schemaVersion: 1,
    kind: 'pie-p7a-candidate-trial-v1',
    status: 'passed',
    reportPath: trialPath,
    generatedAt: '2026-09-12T00:00:00.000Z',
    finishedAt: '2026-09-12T00:01:00.000Z',
    bindings: {
      trialId: 'trial-activation-test',
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      qualificationSha256: sha256(qualificationBytes),
    },
    checks: Object.fromEntries(REQUIRED_CANDIDATE_TRIAL_CHECKS.map((name) => [name, {
      decision: 'passed',
      evidence: { observed: true },
    }])),
    cleanup: { completed: true, rootRemoved: true },
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
    assert.throws(() => validateActivationEvidenceStructure(options), /candidate trial report: schemaVersion/u);
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
    { name: 'wrong generation', mutate: (report) => { report.bindings.generationId = '22222222-2222-4222-8222-222222222222'; }, expected: /generationId binding mismatches/u },
    { name: 'incomplete trial check', mutate: (report) => { report.checks.isolatedRoots.decision = 'unqualified'; }, expected: /required check isolatedRoots is incomplete/u },
  ];
  for (const entry of cases) {
    const { root, options, trial } = fixture();
    try {
      validateActivationEvidenceStructure(options);
      if (entry.mutate) {
        entry.mutate(trial.report);
        writeJson(trial.path, trial.report);
      }
      const combinedOptions = { ...options, ...(entry.options ?? {}) };
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

// The pure candidate-trial verifier recomputes only the checks whose criteria
// are grounded in owning contracts and existing receipts; every other required
// check yields an explicit unqualified reason, never a boolean pass.
const UNRECOMPUTABLE_CHECKS = REQUIRED_CANDIDATE_TRIAL_CHECKS.filter(
  (name) => !Object.hasOwn(CANDIDATE_TRIAL_EVIDENCE_SCHEMAS, name),
);

function computableTrialChecks(qualificationBytes) {
  const checks = Object.fromEntries(REQUIRED_CANDIDATE_TRIAL_CHECKS.map((name) => [name, {
    decision: 'passed',
    evidence: { observed: true },
  }]));
  checks.matchedSourceBuildConfig = {
    decision: 'passed',
    evidence: {
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
      qualificationSha256: sha256(qualificationBytes),
    },
  };
  checks.cleanup = { decision: 'passed', evidence: { completed: true, rootRemoved: true } };
  return checks;
}

function recomputableTrialFixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-trial-verifier-'));
  try {
    const qualification = qualificationReport(root);
    const trial = trialReport(root, qualification.bytes, {
      checks: computableTrialChecks(qualification.bytes),
      ...overrides,
    });
    return {
      root,
      qualification,
      trial,
      expected: {
        generationId,
        buildId,
        sourceHead,
        sourceFingerprint,
        qualificationSha256: sha256(qualification.bytes),
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('candidate-trial verifier qualifies only checks with computable receipt criteria', () => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    const errors = recomputeCandidateTrialChecks(trial.report, expected);
    assert.deepEqual(errors, UNRECOMPUTABLE_CHECKS.map(
      (name) => `${name} has no authoritative producer criteria in the current repository`,
    ));
    assert.equal(errors.length, 5);
    assert.deepEqual(recomputeCandidateTrialChecks(trial.report, expected), errors, 'recomputation is deterministic');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('matchedSourceBuildConfig evidence must restate the exact recomputed bindings', () => {
  const cases = [
    { name: 'missing key', mutate: (evidence) => { delete evidence.sourceFingerprint; }, expected: /matchedSourceBuildConfig evidence keys do not match its bounded schema/u },
    { name: 'extra key', mutate: (evidence) => { evidence.harnessVersion = 'extra'; }, expected: /matchedSourceBuildConfig evidence keys do not match its bounded schema/u },
    { name: 'wrong generation', mutate: (evidence) => { evidence.generationId = '22222222-2222-4222-8222-222222222222'; }, expected: /evidence\.generationId does not match the plan generation/u },
    { name: 'wrong build', mutate: (evidence) => { evidence.buildId = 'old-build'; }, expected: /evidence\.buildId does not match the plan build/u },
    { name: 'wrong source head', mutate: (evidence) => { evidence.sourceHead = 'c'.repeat(40); }, expected: /evidence\.sourceHead does not match the plan source head/u },
    { name: 'wrong fingerprint', mutate: (evidence) => { evidence.sourceFingerprint = 'd'.repeat(64); }, expected: /evidence\.sourceFingerprint does not match the plan source fingerprint/u },
    { name: 'wrong qualification hash', mutate: (evidence) => { evidence.qualificationSha256 = 'e'.repeat(64); }, expected: /evidence\.qualificationSha256 does not match the recomputed qualification bytes hash/u },
    { name: 'empty evidence', mutate: (evidence) => { for (const key of Object.keys(evidence)) delete evidence[key]; }, expected: /matchedSourceBuildConfig evidence keys do not match its bounded schema/u },
    { name: 'evidence removed', mutate: (evidence, check) => { check.evidence = undefined; }, expected: /matchedSourceBuildConfig evidence is missing/u },
  ];
  for (const entry of cases) {
    const { root, trial, expected } = recomputableTrialFixture();
    try {
      entry.mutate(trial.report.checks.matchedSourceBuildConfig.evidence, trial.report.checks.matchedSourceBuildConfig);
      const errors = recomputeCandidateTrialChecks(trial.report, expected);
      assert.equal(errors.length, 6, entry.name);
      assert.match(errors.join('; '), entry.expected, entry.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    trial.report.checks.matchedSourceBuildConfig.evidence.sourceHead = sourceHead.toUpperCase();
    const errors = recomputeCandidateTrialChecks(trial.report, expected);
    assert.match(errors.join('; '), /no authoritative producer criteria/u);
    assert.doesNotMatch(errors.join('; '), /matchedSourceBuildConfig/u, 'source head binding is case-insensitive like the envelope');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup evidence must mirror the report cleanup receipt exactly', () => {
  const cases = [
    { name: 'extra key', mutate: (evidence) => { evidence.rootPath = 'C:/tmp/trial'; }, expected: /cleanup evidence keys do not match its bounded schema/u },
    { name: 'completed false', mutate: (evidence) => { evidence.completed = false; }, expected: /cleanup evidence does not match the report cleanup receipt/u },
    { name: 'rootRemoved false', mutate: (evidence) => { evidence.rootRemoved = false; }, expected: /cleanup evidence does not match the report cleanup receipt/u },
    { name: 'report cleanup contradicted', mutate: (evidence, report) => { report.cleanup.completed = false; }, expected: /cleanup evidence does not match the report cleanup receipt/u },
  ];
  for (const entry of cases) {
    const { root, trial, expected } = recomputableTrialFixture();
    try {
      entry.mutate(trial.report.checks.cleanup.evidence, trial.report);
      const errors = recomputeCandidateTrialChecks(trial.report, expected);
      assert.equal(errors.length, 6, entry.name);
      assert.match(errors.join('; '), entry.expected, entry.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('unknown extra and missing trial checks fail closed without assumed qualification', () => {
  const { root, trial, expected } = recomputableTrialFixture();
  try {
    const pristine = structuredClone(trial.report);
    trial.report.checks.extraObservation = { decision: 'passed', evidence: { observed: true } };
    const errors = recomputeCandidateTrialChecks(trial.report, expected);
    assert.match(errors.join('; '), /unknown candidate trial check extraObservation is not in the required set/u);

    const missing = structuredClone(pristine);
    delete missing.checks.cleanup;
    assert.deepEqual(
      recomputeCandidateTrialChecks(missing, expected),
      UNRECOMPUTABLE_CHECKS.map((name) => `${name} has no authoritative producer criteria in the current repository`)
        .concat(['required candidate trial check cleanup is missing from the report']),
    );

    const unqualified = structuredClone(pristine);
    unqualified.checks.cleanup.decision = 'unqualified';
    assert.match(
      recomputeCandidateTrialChecks(unqualified, expected).join('; '),
      /required candidate trial check cleanup is not passed/u,
    );

    assert.deepEqual(
      recomputeCandidateTrialChecks(pristine, {}),
      ['candidate trial recompute bindings are incomplete'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production admission still rejects recomputable trial evidence and writes no manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-activation-admission-recompute-'));
  try {
    const qualification = qualificationReport(root);
    const trial = trialReport(root, qualification.bytes, { checks: computableTrialChecks(qualification.bytes) });
    const options = {
      qualificationPath: qualification.path,
      trialPath: trial.path,
      generationId,
      buildId,
      sourceHead,
      sourceFingerprint,
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
    assert.equal(inspection.candidateTrialValidatorAvailable, false);
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
