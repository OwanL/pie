import assert from 'node:assert/strict';
import test from 'node:test';

import { materialDisagreementFields, processDisagreementMaterial } from '../src/disagreement.js';
import { validReview } from './fixtures.js';

test('off-scale status and human evidence disagreements are material', () => {
  const review = validReview();
  const [small, medium] = review.components;
  medium.classifications.criteria[0] = { ...medium.classifications.criteria[0]!, status: 'blocked', reason: 'unknown' };
  medium.classifications.evidence.human = 'unavailable';
  assert.deepEqual(materialDisagreementFields(small, medium).sort(), ['criterion:c1.status', 'evidence.human']);
});

test('adjacent supporting status disagreement is non-material but two-step is material', () => {
  const review = validReview();
  const [small, medium] = review.components;
  small.classifications.criteria[0]!.importance = 'supporting';
  medium.classifications.criteria[0]!.importance = 'supporting';
  medium.classifications.criteria[0]!.status = 'partly_met';
  medium.classifications.criteria[0]!.reason = 'unknown';
  assert.deepEqual(materialDisagreementFields(small, medium), []);
  medium.classifications.criteria[0]!.status = 'unmet';
  assert.deepEqual(materialDisagreementFields(small, medium), ['criterion:c1.status']);
});

test('opposite and incomparable process values escalate while adjacent values do not', () => {
  assert.equal(processDisagreementMaterial('scopeControl', 'controlled', 'minor_avoidable_drift'), false);
  assert.equal(processDisagreementMaterial('scopeControl', 'controlled', 'material_scope_drift'), true);
  assert.equal(processDisagreementMaterial('verificationDiscipline', 'underverified', 'not_applicable'), true);
  assert.equal(processDisagreementMaterial('finalClaimAccuracy', 'accurate', 'overclaimed'), true);
});

test('evidence coverage escalates two-step and off-scale gaps and merges only adjacent values', () => {
  const review = validReview();
  const [small, medium] = review.components;
  medium.classifications.evidence.requirements = 'partly_clear';
  medium.classifications.evidence.execution = 'partial';
  medium.classifications.evidence.artifacts = 'partial';
  assert.deepEqual(materialDisagreementFields(small, medium), []);

  medium.classifications.evidence.requirements = 'unclear';
  medium.classifications.evidence.execution = 'reported_only';
  medium.classifications.evidence.artifacts = 'none';
  assert.deepEqual(materialDisagreementFields(small, medium).sort(), ['evidence.artifacts', 'evidence.execution', 'evidence.requirements']);

  small.classifications.evidence.artifacts = 'none';
  medium.classifications.evidence.artifacts = 'not_applicable';
  assert.ok(materialDisagreementFields(small, medium).includes('evidence.artifacts'));
});
