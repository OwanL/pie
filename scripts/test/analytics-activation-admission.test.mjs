import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  ActivationEvidenceError,
  MAX_ACTIVATION_EVIDENCE_BYTES,
  REQUIRED_CANDIDATE_TRIAL_CHECKS,
  REQUIRED_QUALIFICATION_GATES,
  admitActivationEvidence,
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
    assert.throws(() => validateActivationEvidenceStructure(options), ActivationEvidenceError);
    writeFileSync(qualification.path, readFileSync(qualification.path));
    writeFileSync(trial.path, '{"t":1}\n');
    assert.throws(() => validateActivationEvidenceStructure(options), ActivationEvidenceError);
    assert.equal(existsSync(path.join(root, 'analytics-activation-v1.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed, stale, and mismatched bindings fail closed', () => {
  const cases = [
    { name: 'failed gate', qualification: { gates: { exactPrimaryRows: { decision: 'failed', actual: 0, threshold: 1, evidence: {} } } } },
    { name: 'stale source', options: { sourceHead: 'c'.repeat(40) } },
    { name: 'stale build', options: { buildId: 'old-build' } },
    { name: 'wrong generation', trial: { bindings: { generationId: '22222222-2222-4222-8222-222222222222' } } },
    { name: 'incomplete trial check', trial: { checks: { isolatedRoots: { decision: 'unqualified', evidence: {} } } } },
  ];
  for (const entry of cases) {
    const { root, options } = fixture(entry);
    try {
      const combinedOptions = { ...options, ...(entry.options ?? {}) };
      assert.throws(() => validateActivationEvidenceStructure(combinedOptions), ActivationEvidenceError, entry.name);
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
