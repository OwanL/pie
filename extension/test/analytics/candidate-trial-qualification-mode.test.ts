import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCandidateTrialQualificationRecomputation,
  candidateTrialQualificationMode,
} from '../../src/analytics/candidate-trial-report.js';

/** Reference overall qualification summary objects, shaped exactly as the
 * authoritative aggregator emits them. */
function qualificationWith(decision: Record<string, unknown>): Parameters<typeof candidateTrialQualificationMode>[0] {
  return { qualification: decision } as Parameters<typeof candidateTrialQualificationMode>[0];
}

test('a fully qualified overall report binds as full-qualified', () => {
  const mode = candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-qualified',
    overallP0: 'qualified',
  }));
  assert.equal(mode, 'full-qualified');
});

test('an explicitly provisional-qualified report with an honest unqualified overall decision binds provisionally', () => {
  const mode = candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-unqualified',
    overallP0: 'unqualified',
    provisionalEnvelope: { kind: 'pie-p0-provisional-envelope-v1' },
    provisionalP0: 'provisional-qualified',
  }));
  assert.equal(mode, 'provisional-qualified');
});

test('a faked fully qualified overall decision underneath a provisional claim is refused', () => {
  assert.throws(() => candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-qualified',
    overallP0: 'qualified',
    provisionalEnvelope: { kind: 'pie-p0-provisional-envelope-v1' },
    provisionalP0: 'provisional-qualified',
  })), /honest unqualified overall decision/u);
});

test('a provisional state that is not provisionally qualified is refused', () => {
  assert.throws(() => candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-unqualified',
    overallP0: 'unqualified',
    provisionalEnvelope: { kind: 'pie-p0-provisional-envelope-v1' },
    provisionalP0: 'provisional-unqualified',
  })), /not provisional-qualified/u);
});

test('an unqualified report without an explicit provisional state is refused', () => {
  assert.throws(() => candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-unqualified',
    overallP0: 'unqualified',
  })), /not a qualified overall report/u);
});

test('a mismatched qualified decision pair is refused', () => {
  assert.throws(() => candidateTrialQualificationMode(qualificationWith({
    decision: 'overall-unqualified',
    overallP0: 'qualified',
  })), /not a qualified overall report/u);
});

test('a claimed fully qualified report cannot bypass authoritative recomputation', () => {
  assert.throws(() => assertCandidateTrialQualificationRecomputation(qualificationWith({
    decision: 'overall-qualified',
    overallP0: 'qualified',
  }), {
    buildId: 'candidate-build',
    sourceHead: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
  }), /does not recompute as qualified/u);
});

test('a claimed provisional report cannot bypass authoritative recomputation', () => {
  assert.throws(() => assertCandidateTrialQualificationRecomputation(qualificationWith({
    decision: 'overall-unqualified',
    overallP0: 'unqualified',
    provisionalP0: 'provisional-qualified',
  }), {
    buildId: 'candidate-build',
    sourceHead: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
  }), /does not recompute as provisionally qualified/u);
});