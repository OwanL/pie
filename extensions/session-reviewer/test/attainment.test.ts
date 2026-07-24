import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAttainment, deriveOverall, qualityIndexV1 } from '../src/attainment.js';
import type { ClassifiedCriterion } from '../src/types.js';
import { metCriterion } from './fixtures.js';

function criterion(id: string, importance: ClassifiedCriterion['importance'], status: ClassifiedCriterion['status'], reason: ClassifiedCriterion['reason']): ClassifiedCriterion {
  return { ...structuredClone(metCriterion), criterionId: id, importance, status, reason };
}

test('all-core external blocker diverges delivered and controllable views', () => {
  const ledger = [criterion('c1', 'core', 'blocked', 'external_blocker')];
  const result = deriveAttainment(ledger);
  assert.equal(result.deliveredOverall, 'not_achieved');
  assert.equal(result.controllableOverall, 'not_assessable');
  assert.equal(result.qualityIndexV1, null);
  assert.equal(result.core.externalBlocked, 1);
  assert.equal(result.core.controllableDenominator, 0);
});

test('non-external blocked criteria remain in the controllable denominator', () => {
  const ledger = [criterion('c1', 'core', 'blocked', 'user_dependency')];
  const result = deriveAttainment(ledger);
  assert.equal(result.controllableOverall, 'not_achieved');
  assert.equal(result.core.controllableDenominator, 1);
  assert.equal(result.core.controllableRate, 0);
});

test('one not-assessable core among met cores is partly achieved', () => {
  const ledger = [
    criterion('c1', 'core', 'met', 'none'),
    criterion('c2', 'core', 'not_assessable', 'human_evidence_missing'),
  ];
  assert.equal(deriveOverall(ledger, 'delivered'), 'partly_achieved');
});

test('supporting not-assessable does not block achieved and optional gaps never determine overall', () => {
  const ledger = [
    criterion('c1', 'core', 'met', 'none'),
    criterion('c2', 'supporting', 'not_assessable', 'insufficient_artifact_evidence'),
    criterion('c3', 'optional', 'unmet', 'omitted'),
  ];
  assert.equal(deriveOverall(ledger, 'delivered'), 'achieved');
});

test('quality index stays inside the core-driven band', () => {
  const ledger = [criterion('c1', 'core', 'partly_met', 'unknown')];
  const score = qualityIndexV1(ledger, 'partly_achieved');
  assert.ok(score !== null && score >= 25 && score <= 59);
  assert.equal(score, 42);
});
