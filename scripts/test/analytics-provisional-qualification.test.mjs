import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFERRED_OVERALL_QUALIFICATION_GATES,
  PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS,
  PROVISIONAL_QUALIFICATION_ENVELOPE,
  REQUIRED_OVERALL_QUALIFICATION_GATES,
  evaluateProvisionalOverallQualification,
  validateOverallQualificationRecomputation,
} from '../../extension/scripts/analytics-p0-overall-qualification.mjs';

const passingGate = (actual = 1) => ({ actual, threshold: 't', decision: 'passed', evidence: { reports: [] } });
const failedGate = (actual, reason = 'owning predicate failed') => ({
  actual, threshold: 't', decision: 'failed', evidence: { reports: [] }, reason,
});
const unqualifiedGate = (reason = 'missing required evidence') => ({
  actual: null, threshold: 't', decision: 'unqualified', evidence: { reports: [] }, reason,
});

function passedGateTable({ realProducerBoundary }) {
  const gates = {};
  for (const name of REQUIRED_OVERALL_QUALIFICATION_GATES) {
    gates[name] = name === 'realProducerBoundary' ? realProducerBoundary : passingGate();
  }
  gates.tenMillionHistory = unqualifiedGate('deferred unqualified with the measured capacity reason');
  return gates;
}

const latencyOnlyActual = {
  status: 'submitted', handoffMs: 9.54649999999998, nestedDepth: 2,
  failoverAttemptsRetained: 2, cancellationOrCapacityStatus: 'rejected',
  rejectionHandoffMs: 0.3190999999999917, delayedAcknowledgementDidNotGate: true,
  mutationAfterHandoffDidNotAlterCapture: true, credentialFilteredBeforeSerialization: true,
};

test('the approved exception envelope admits exactly the named measured gates', () => {
  const gates = passedGateTable({ realProducerBoundary: failedGate(latencyOnlyActual) });
  gates.recorderWorkerRss = failedGate(307_400_704);
  gates.mixedWorkerMemory = failedGate({ memoryValid: false });
  gates.queryPeakMemory = failedGate(null);
  gates.matchedAgentUi = unqualifiedGate('missing required evidence: matchedHost');
  gates.incrementalHostMemory = unqualifiedGate('missing required evidence: matchedHost');
  const provisional = evaluateProvisionalOverallQualification(gates, [], false);
  assert.equal(provisional.qualified, true);
  assert.deepEqual(provisional.exceptions, [
    'recorderWorkerRss', 'mixedWorkerMemory', 'queryPeakMemory', 'matchedAgentUi', 'incrementalHostMemory',
  ]);
  assert.deepEqual(PROVISIONAL_QUALIFICATION_ENVELOPE.measurementExceptions, provisional.exceptions);
  assert.equal(PROVISIONAL_QUALIFICATION_ENVELOPE.realProducerBoundary, 'latency-only');
  assert.deepEqual(DEFERRED_OVERALL_QUALIFICATION_GATES, ['tenMillionHistory']);
});

test('a failed non-exception gate is refused under the provisional envelope', () => {
  const gates = passedGateTable({ realProducerBoundary: failedGate(latencyOnlyActual) });
  gates.inPlaceCorruption = failedGate({ phase: 'failed' });
  const provisional = evaluateProvisionalOverallQualification(gates, [], false);
  assert.equal(provisional.qualified, false);
  assert.ok(provisional.otherOpenGates.includes('inPlaceCorruption'));
});

test('failed privacy/nonblocking/cleanup correctness outside the envelope is refused', () => {
  for (const field of ['credentialFilteredBeforeSerialization', 'delayedAcknowledgementDidNotGate', 'mutationAfterHandoffDidNotAlterCapture']) {
    const gates = passedGateTable({
      realProducerBoundary: failedGate({ ...latencyOnlyActual, [field]: false }),
    });
    const provisional = evaluateProvisionalOverallQualification(gates, [], false);
    assert.equal(provisional.qualified, false, `${field} failure must refuse provisional qualification`);
    assert.equal(provisional.realProducerBoundaryLatencyOnly, false);
  }
  const wrongStatus = passedGateTable({
    realProducerBoundary: failedGate({ ...latencyOnlyActual, status: 'dropped' }),
  });
  assert.equal(evaluateProvisionalOverallQualification(wrongStatus, [], false).qualified, false);
  const missingNested = passedGateTable({
    realProducerBoundary: failedGate({ ...latencyOnlyActual, nestedDepth: 1 }),
  });
  assert.equal(evaluateProvisionalOverallQualification(missingNested, [], false).qualified, false);
  const missingFailover = passedGateTable({
    realProducerBoundary: failedGate({ ...latencyOnlyActual, failoverAttemptsRetained: 1 }),
  });
  assert.equal(evaluateProvisionalOverallQualification(missingNested, [], false).qualified, false);
});

test('evidence errors, failed deferred gates, and passed realProducerBoundary are handled honestly', () => {
  const gates = passedGateTable({ realProducerBoundary: failedGate(latencyOnlyActual) });
  gates.recorderWorkerRss = failedGate(307_400_704);
  assert.equal(evaluateProvisionalOverallQualification(gates, ['scale: status must be passed'], false).qualified, false);
  assert.equal(evaluateProvisionalOverallQualification(gates, [], true).qualified, false);
  const fullyPassed = passedGateTable({ realProducerBoundary: passingGate({}) });
  fullyPassed.tenMillionHistory = { actual: null, threshold: 't', decision: 'unqualified', evidence: {}, reason: 'deferred' };
  assert.equal(evaluateProvisionalOverallQualification(fullyPassed, [], false).qualified, true);
});

test('an edited provisional envelope or exception list fails recomputation fail closed', () => {
  const base = {
    kind: 'pie-p0-overall-qualification-v1',
    schemaVersion: 5,
    configuration: { scenario: 'overall' },
    gates: {},
    qualification: {
      scenario: 'overall', decision: 'overall-unqualified', overallP0: 'unqualified',
      provisionalP0: 'provisional-qualified',
      provisionalEnvelope: { ...PROVISIONAL_QUALIFICATION_ENVELOPE, measurementExceptions: ['recorderWorkerRss'] },
      provisionalExceptions: ['recorderWorkerRss'],
    },
  };
  const edited = validateOverallQualificationRecomputation(base, {});
  assert.equal(edited.valid, false);
  assert.ok(edited.errors.some((error) => /provisionalEnvelope does not match the approved provisional exception envelope/u.test(error)));

  const wrongExceptions = {
    ...base,
    qualification: {
      ...base.qualification,
      provisionalEnvelope: PROVISIONAL_QUALIFICATION_ENVELOPE,
      provisionalExceptions: ['recorderWorkerRss'],
    },
  };
  const mismatched = validateOverallQualificationRecomputation(wrongExceptions, {});
  assert.equal(mismatched.valid, false);
  assert.ok(mismatched.errors.some((error) => /provisionalExceptions do not match recomputed approved-exception gates/u.test(error)));
});

test('no fabricated passed status: exception gates stay failed or unqualified', () => {
  const gates = passedGateTable({ realProducerBoundary: failedGate(latencyOnlyActual) });
  gates.recorderWorkerRss = failedGate(307_400_704);
  gates.matchedAgentUi = unqualifiedGate('missing required evidence: matchedHost');
  const provisional = evaluateProvisionalOverallQualification(gates, [], false);
  assert.equal(gates.recorderWorkerRss.decision, 'failed');
  assert.equal(gates.matchedAgentUi.decision, 'unqualified');
  assert.ok(PROVISIONAL_OVERALL_MEASUREMENT_EXCEPTIONS.every((name) => gates[name]?.decision !== undefined));
});