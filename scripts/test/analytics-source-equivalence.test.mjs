import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import {
  CANDIDATE_TRIAL_EVIDENCE_SCHEMAS,
  REQUIRED_CANDIDATE_TRIAL_CHECKS,
  REQUIRED_QUALIFICATION_GATES,
  validateActivationEvidenceStructure,
} from '../analytics-activation-admission.mjs';

const generationId = '11111111-1111-4111-8111-111111111111';
const measuredBuildId = '84d09cb7b9daa44155d0';
const candidateBuildId = '7a2dab4f62b70d9b2a1f';
const sourceHead = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);
const workspaceId = 'workspace-equivalence-test';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function qualificationReport(root) {
  const qualificationPath = path.join(root, 'qualification.json');
  const gate = (actual = 1) => ({ actual, threshold: 'test-bound', decision: 'passed', evidence: { observed: true } });
  const gates = Object.fromEntries(REQUIRED_QUALIFICATION_GATES.map((name) => [name, gate(name === 'inPlaceCorruption' ? 'completed' : undefined)]));
  const report = {
    schemaVersion: 5,
    harnessVersion: 'p0-baseline-scale-v7-recorder-heap-ceiling',
    status: 'passed',
    generatedAt: '2026-09-12T00:00:00.000Z',
    finishedAt: '2026-09-12T00:01:00.000Z',
    configuration: { scenario: 'scale', rows: 1_000_000, seed: 'equivalence-test', reportPath: qualificationPath },
    provenance: {
      valid: true,
      gitHead: sourceHead,
      coordinatedBuildId: measuredBuildId,
      fingerprint: sourceFingerprint,
      files: { 'candidate.js': { sha256: 'c'.repeat(64), bytes: 1 } },
    },
    measurement: { completed: true, exactPrimaryRows: 1_000_000, exactDetailRows: 100_003 },
    cleanup: { completed: true, rootRemoved: true },
    results: {},
    gates,
    qualification: { scenario: 'scale', decision: 'scenario-passed', failedGates: [], overallP0: 'unqualified' },
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(qualificationPath, bytes);
  return { path: qualificationPath, bytes };
}

/** A minimal source-equivalence receipt whose production entries point at a
 * real tracked repository file with its real current hash, so the admission
 * recomputation exercises actual disk reads. */
function receiptFixture(root, overrides = {}) {
  const currentSha = (repoRelative) => createHash('sha256')
    .update(readFileSync(path.join(repositoryRoot, repoRelative))).digest('hex');
  const productionTarget = 'shared/traversal-policy.ts';
  const receipt = {
    schemaVersion: 1,
    kind: 'pie-analytics-source-equivalence-v1',
    generatedAt: '2026-09-15T21:00:00.000Z',
    measured: {
      sourceHead,
      buildId: measuredBuildId,
      sourceFingerprint,
      waveDir: root,
      qualificationReport: path.join(root, 'qualification.json'),
      qualificationReportSha256: 'd'.repeat(64),
      provenance: { gitHead: sourceHead, coordinatedBuildId: measuredBuildId, fingerprint: sourceFingerprint },
    },
    candidate: { sourceHead: sourceHead, buildId: candidateBuildId, rendererBuildId: candidateBuildId },
    productionRuntime: { [productionTarget]: { measuredSha256: currentSha(productionTarget), candidateSha256: currentSha(productionTarget), verified: 'identical' } },
    dependencies: {
      'extension/package.json': {
        measuredSha256: currentSha('extension/package.json'),
        candidateSha256: currentSha('extension/package.json'),
        verified: 'identical',
      },
    },
    toolingState: {
      'extension/scripts/analytics-p0-overall-qualification.mjs': {
        measuredSha256: 'e'.repeat(64),
        candidateSha256: currentSha('extension/scripts/analytics-p0-overall-qualification.mjs'),
        basis: 'committed report-tooling change',
      },
    },
    outputInventory: {
      hostBuildMarker: candidateBuildId,
      rendererBuildMarker: candidateBuildId,
      artifacts: { 'extension/out/analytics-candidate-trial.js': currentSha('extension/out/analytics-candidate-trial.js') },
    },
    ...overrides,
  };
  const receiptPath = path.join(root, 'receipt.json');
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(receiptPath, bytes);
  return { path: receiptPath, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function trialReportFixture(root, qualification, receiptBinding) {
  mkdirSync(path.join(root, 'webview', 'panel'), { recursive: true });
  writeFileSync(path.join(root, 'pie-build-id.txt'), `${candidateBuildId}\n`);
  writeFileSync(path.join(root, 'webview', 'panel', 'pie-build-id.txt'), `${candidateBuildId}\n`);
  const trialId = 'trial-equivalence-test';
  const identity = {
    trialId,
    generationId,
    buildId: measuredBuildId,
    sourceHead,
    sourceFingerprint,
    qualificationSha256: sha256(qualification.bytes),
  };
  const artifact = (name) => {
    const filePath = path.join(root, name);
    const bytes = Buffer.from(`fixture artifact: ${name}\n`);
    writeFileSync(filePath, bytes);
    return { path: filePath, sha256: sha256(bytes), bytes: bytes.byteLength };
  };
  const trialPlanSha256 = createHash('sha256').update(JSON.stringify(
    [1, 'pie-p7a-candidate-trial-authority-v1', identity, workspaceId],
  )).digest('hex');
  const report = {
    schemaVersion: 1,
    kind: 'pie-p7a-candidate-trial-v1',
    producerVersion: 'p7a-candidate-trial-v1',
    status: 'passed',
    reportPath: path.join(root, 'trial.json'),
    generatedAt: '2026-09-12T00:01:00.000Z',
    finishedAt: '2026-09-12T00:01:30.000Z',
    bindings: identity,
    candidateBinding: receiptBinding
      ? { candidateBuildId: receiptBinding.candidateBuildId, equivalenceReceiptSha256: receiptBinding.receiptSha256 }
      : null,
    checks: Object.fromEntries([
      ['matchedSourceBuildConfig', { decision: 'passed', evidence: {
        qualification: { path: qualification.path, sha256: identity.qualificationSha256, bytes: qualification.bytes.byteLength },
        trialId, generationId, buildId: measuredBuildId, sourceHead, sourceFingerprint, workspaceId,
        trialPlanSha256,
        producer: artifact('analytics-candidate-trial.js'),
        recorderWorker: artifact('analytics-recorder-worker.js'),
        queryWorker: artifact('analytics-query-worker.js'),
      } }],
      ...REQUIRED_CANDIDATE_TRIAL_CHECKS.filter((name) => name !== 'matchedSourceBuildConfig')
        .map((name) => [name, { decision: 'passed', evidence: Object.fromEntries(
          CANDIDATE_TRIAL_EVIDENCE_SCHEMAS[name].map((key) => [key, key === 'protectedRoots' ? [path.join(root, 'live')] : `e-${key}`]),
        ) }]),
    ]),
    cleanup: { trialId, completed: true, rootRemoved: true, stoppedAt: '2026-09-12T00:01:29.000Z', failureReasons: [] },
    errors: [],
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const reportPath = path.join(root, 'trial.json');
  writeFileSync(reportPath, bytes);
  return { path: reportPath, bytes };
}

let receiptBinding;
function optionsFor(root, overrides = {}) {
  const qualification = qualificationReport(root);
  const receipt = receiptFixture(root);
  receiptBinding = { candidateBuildId, receiptSha256: receipt.sha256, receiptPath: receipt.path };
  const trial = trialReportFixture(root, qualification, receiptBinding);
  return {
    qualificationPath: qualification.path,
    trialPath: trial.path,
    generationId,
    buildId: measuredBuildId,
    sourceHead,
    sourceFingerprint,
    workspaceId,
    candidateBuildId,
    sourceEquivalenceReceipt: { path: receipt.path, sha256: receipt.sha256 },
    ...overrides,
  };
}

test('an exact receipt binding admits the measured identity on the current candidate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-ok-'));
  try {
    const options = optionsFor(root);
    const structure = validateActivationEvidenceStructure(options);
    assert.equal(structure.trialId, 'trial-equivalence-test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt whose bytes do not match the plan-recorded sha256 is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-sha-'));
  try {
    const options = optionsFor(root);
    assert.throws(
      () => validateActivationEvidenceStructure({
        ...options,
        sourceEquivalenceReceipt: {
          path: options.sourceEquivalenceReceipt.path,
          sha256: 'f'.repeat(64),
        },
      }),
      /candidateBinding does not match the plan receipt binding|receipt bytes do not match/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt production entry that no longer matches the current tree is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-prod-'));
  try {
    const options = optionsFor(root);
    const receiptPath = options.sourceEquivalenceReceipt.path;
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const target = Object.keys(parsed.productionRuntime)[0];
    parsed.productionRuntime[target] = {
      measuredSha256: '0'.repeat(64), candidateSha256: '0'.repeat(64), verified: 'identical',
    };
    writeFileSync(receiptPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const tamperedSha = createHash('sha256').update(readFileSync(receiptPath)).digest('hex');
    const trialParsed = JSON.parse(readFileSync(options.trialPath, 'utf8'));
    trialParsed.candidateBinding.equivalenceReceiptSha256 = tamperedSha;
    writeFileSync(options.trialPath, `${JSON.stringify(trialParsed, null, 2)}\n`);
    assert.throws(
      () => validateActivationEvidenceStructure({
        ...options,
        sourceEquivalenceReceipt: {
          path: receiptPath,
          sha256: tamperedSha,
        },
      }),
      /source equivalence receipt entry does not match the current tree/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidateBinding mismatching the plan receipt binding is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-bind-'));
  try {
    const receipt = receiptFixture(root);
    const options = optionsFor(root);
    const trialParsed = JSON.parse(readFileSync(path.join(root, 'trial.json'), 'utf8'));
    trialParsed.candidateBinding = { candidateBuildId: '9'.repeat(20), equivalenceReceiptSha256: receipt.sha256 };
    writeFileSync(path.join(root, 'trial.json'), `${JSON.stringify(trialParsed, null, 2)}\n`);
    assert.throws(
      () => validateActivationEvidenceStructure(options),
      /candidateBinding does not match the plan receipt binding/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidateBuildId equal to the measured build id is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-id-'));
  try {
    assert.throws(
      () => validateActivationEvidenceStructure({
        ...optionsFor(root),
        candidateBuildId: measuredBuildId,
      }),
      /distinct 20-hex coordinated build id/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidateBuildId without a receipt binding is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-solo-'));
  try {
    const options = optionsFor(root);
    delete options.sourceEquivalenceReceipt;
    assert.throws(
      () => validateActivationEvidenceStructure(options),
      /candidateBuildId requires a sourceEquivalenceReceipt binding/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidateBinding present without an approved receipt binding is rejected', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-equivalence-orphan-'));
  try {
    const options = optionsFor(root);
    delete options.sourceEquivalenceReceipt;
    delete options.candidateBuildId;
    const trialParsed = JSON.parse(readFileSync(path.join(root, 'trial.json'), 'utf8'));
    trialParsed.candidateBinding = { candidateBuildId, equivalenceReceiptSha256: '1'.repeat(64) };
    writeFileSync(path.join(root, 'trial.json'), `${JSON.stringify(trialParsed, null, 2)}\n`);
    assert.throws(
      () => validateActivationEvidenceStructure(options),
      /candidateBinding is present without an approved source-equivalence receipt binding/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});