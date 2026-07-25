import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAttainment } from '../src/attainment.js';
import { hashJson } from '../src/evidence.js';
import { validateSessionReviewV2 } from '../src/validation.js';
import { frozenCriterion, metCriterion, validReview } from './fixtures.js';

test('validates a complete V2 vertical slice', () => {
  const review = validReview();
  assert.equal(validateSessionReviewV2(review), review);
});

test('rejects status/reason invariant violations', () => {
  const review = validReview();
  review.ledger[0] = { ...review.ledger[0]!, status: 'met', reason: 'external_blocker' };
  assert.throws(() => validateSessionReviewV2(review), /invalid status\/reason pair/);
});

test('rejects classified fields in the frozen definition ledger', () => {
  const review = validReview();
  (review.frozenLedger[0] as unknown as Record<string, unknown>).status = 'met';
  review.frozenLedgerSha256 = hashJson(review.frozenLedger);
  review.consolidation.frozenLedger = structuredClone(review.frozenLedger);
  review.consolidation.frozenLedgerSha256 = review.frozenLedgerSha256;
  review.provenance.pipeline.frozenLedgerSha256 = review.frozenLedgerSha256;
  assert.throws(() => validateSessionReviewV2(review), /unclassified definition/);
});

test('rejects hash and pipeline provenance drift', () => {
  const badHash = validReview();
  badHash.frozenLedgerSha256 = '0'.repeat(64);
  assert.throws(() => validateSessionReviewV2(badHash), /does not match frozenLedger/);

  const badId = validReview();
  badId.provenance.pipeline.componentAssessmentIds[0] = 'wrong';
  assert.throws(() => validateSessionReviewV2(badId), /artifact IDs/);
});

test('rejects canonical critical findings without ledger effect', () => {
  const review = validReview();
  review.findings = [{
    findingId: 'f1', severity: 'critical', category: 'correctness', statement: 'Broken', evidenceRefs: ['e1'],
    criterionId: 'c1', ledgerEffect: 'none', remediation: 'Fix it',
  }];
  assert.throws(() => validateSessionReviewV2(review), /critical\/major finding requires criterionId and ledger effect|ledgerEffect none/);
});

test('requires material component disagreement to be adjudicated', () => {
  const review = validReview();
  review.components[1].classifications.criteria[0] = {
    ...review.components[1].classifications.criteria[0]!, status: 'unmet', reason: 'omitted',
  };
  assert.throws(() => validateSessionReviewV2(review), /disagreement\.material/);
});

test('rejects unsafe reviewer checks unless declined as mutating', () => {
  const review = validReview();
  review.reviewerChecks = [{
    checkId: 'check-1', kind: 'command', command: 'rm -rf src', cwd: '/repo', result: '', status: 'pass', evidenceRefs: [],
  }];
  review.reviewerChecksSha256 = hashJson(review.reviewerChecks);
  review.provenance.pipeline.reviewerChecksSha256 = review.reviewerChecksSha256;
  assert.throws(() => validateSessionReviewV2(review), /check safety/);
});

test('validates accepted amendments as the only allowed added ledger criteria', () => {
  const review = validReview();
  const definition = { ...structuredClone(frozenCriterion), criterionId: 'c2', statement: 'Avoid a regression.', origin: 'necessary_implied' as const };
  const classification = { ...definition, status: 'unmet' as const, reason: 'regression' as const, evidenceRefs: ['e2'], findingRefs: ['f2'] };
  const proposal = { amendmentId: 'amend-1', definition, motivatingFindingId: 'f2', evidenceRefs: ['e2'] };
  review.components[0].classifications.proposedAmendments = [structuredClone(proposal)];
  review.components[0].classifications.findings = [{ findingId: 'f2', severity: 'major', category: 'regression', statement: 'Regression', evidenceRefs: ['e2'], criterionId: 'c2', ledgerEffect: 'add', remediation: 'Fix' }];
  review.amendments = [{
    ...proposal, proposedByReviewerId: review.components[0].reviewerId, disposition: 'accepted', adjudicatedByReviewerId: 'adjudicator',
    adjudicatedAt: '2026-07-24T10:15:00.000Z', rationale: 'Material regression', classifiedCriterion: classification,
  }];
  review.ledger.push(classification);
  review.findings = [{ findingId: 'f2', severity: 'major', category: 'regression', statement: 'Regression', evidenceRefs: ['e2'], criterionId: 'c2', ledgerEffect: 'add', remediation: 'Fix' }];
  review.attainment = deriveAttainment(review.ledger);
  review.disagreement = { material: true, adjudicated: true, disputedFields: [
    { field: 'amendments', smallValue: '1', mediumValue: '0', resolvedValue: 'accepted', resolution: 'adjudicator' },
    { field: 'finding:f2', smallValue: 'major', mediumValue: 'absent', resolvedValue: 'major', resolution: 'adjudicator' },
    { field: 'findings', smallValue: JSON.stringify(review.components[0].classifications.findings), mediumValue: '[]', resolvedValue: JSON.stringify(review.findings), resolution: 'adjudicator' },
  ] };
  review.adjudication = {
    reviewerId: 'adjudicator', toolCallId: 'call-adjudicator', requestedBucket: 'medium', bucket: 'medium', bucketDowngraded: false, modelId: 'm-adj', provider: 'p-adj', family: 'f-adj', thinkingLevel: null,
    promptHash: 'prompt-adj', rubricVersion: 'rubric-v2', adjudicationId: 'adj-1', assessedAt: '2026-07-24T10:15:00.000Z', resolvedFields: [
      { field: 'findings', value: JSON.stringify(review.findings), rationale: 'Accepted finding', evidenceRefs: ['e2'] },
    ], amendmentIds: ['amend-1'],
    canonicalOverall: { deliveredOverall: review.attainment.deliveredOverall, controllableOverall: review.attainment.controllableOverall },
  };
  review.provenance.pipeline.amendmentIds = ['amend-1'];
  review.provenance.pipeline.adjudicationId = 'adj-1';
  review.provenance.adjudicatorReviewerId = 'adjudicator';
  assert.equal(validateSessionReviewV2(review), review);
});

test('mapped amendments must strictly worsen, and never upgrade, the pre-amendment classification', () => {
  const mappedReview = (preStatus: 'met' | 'partly_met', mappedStatus: 'met' | 'partly_met') => {
    const review = validReview();
    const definition = { ...structuredClone(frozenCriterion), criterionId: 'c2', statement: 'Avoid a regression.', origin: 'necessary_implied' as const };
    const proposal = { amendmentId: 'mapped-1', definition, motivatingFindingId: 'f2', evidenceRefs: ['diff:x'] };
    const componentFinding = { findingId: 'f2', severity: 'major' as const, category: 'regression' as const, statement: 'A required regression guard is absent.', evidenceRefs: ['diff:x'], criterionId: 'c2', ledgerEffect: 'add' as const, remediation: 'Restore the guard.' };
    for (const component of review.components) {
      component.classifications.criteria[0] = { ...component.classifications.criteria[0]!, status: preStatus, reason: preStatus === 'met' ? 'none' : 'omitted' };
    }
    review.components[0].classifications.proposedAmendments = [structuredClone(proposal)];
    review.components[0].classifications.findings = [componentFinding];
    const canonicalFinding = { ...componentFinding, severity: 'minor' as const, criterionId: 'c1', ledgerEffect: 'downgrade' as const };
    const mapped = { ...structuredClone(metCriterion), status: mappedStatus, reason: mappedStatus === 'met' ? 'none' as const : 'omitted' as const, evidenceRefs: ['diff:x'], findingRefs: ['f2'] };
    review.amendments = [{
      ...proposal, proposedByReviewerId: review.components[0].reviewerId, disposition: 'mapped_to_existing', targetCriterionId: 'c1', downgradedClassification: mapped,
      adjudicatedByReviewerId: 'adjudicator', adjudicatedAt: '2026-07-24T10:15:00.000Z', rationale: 'Maps to the existing criterion.',
    }];
    review.ledger = [mapped];
    review.findings = [canonicalFinding];
    review.attainment = deriveAttainment(review.ledger);
    review.disagreement = { material: true, adjudicated: true, disputedFields: [
      { field: 'amendments', smallValue: '1', mediumValue: '0', resolvedValue: 'mapped_to_existing', resolution: 'adjudicator' },
      { field: 'finding:f2', smallValue: 'major', mediumValue: 'absent', resolvedValue: 'minor', resolution: 'adjudicator' },
      { field: 'findings', smallValue: JSON.stringify(review.components[0].classifications.findings), mediumValue: '[]', resolvedValue: JSON.stringify(review.findings), resolution: 'adjudicator' },
    ] };
    review.adjudication = {
      reviewerId: 'adjudicator', toolCallId: 'call-adjudicator', requestedBucket: 'medium', bucket: 'medium', bucketDowngraded: false, modelId: 'm-adj', provider: 'p-adj', family: 'f-adj', thinkingLevel: null,
      promptHash: 'prompt-adj', rubricVersion: 'rubric-v2', adjudicationId: 'adj-mapped', assessedAt: '2026-07-24T10:15:00.000Z',
      resolvedFields: [{ field: 'findings', value: JSON.stringify(review.findings), rationale: 'Map to existing criterion.', evidenceRefs: ['diff:x'] }],
      amendmentIds: ['mapped-1'], canonicalOverall: { deliveredOverall: review.attainment.deliveredOverall, controllableOverall: review.attainment.controllableOverall },
    };
    review.provenance.pipeline.amendmentIds = ['mapped-1'];
    review.provenance.pipeline.adjudicationId = 'adj-mapped';
    review.provenance.adjudicatorReviewerId = 'adjudicator';
    return review;
  };

  assert.equal(validateSessionReviewV2(mappedReview('met', 'partly_met')).reviewId, 'review-1');
  assert.throws(() => validateSessionReviewV2(mappedReview('partly_met', 'met')), /must strictly worsen the pre-amendment criterion classification/);
  assert.throws(() => validateSessionReviewV2(mappedReview('partly_met', 'partly_met')), /must strictly worsen the pre-amendment criterion classification/);
});

test('rejects caller-supplied attainment that differs from deterministic derivation', () => {
  const review = validReview();
  review.attainment.qualityIndexV1 = 1;
  assert.throws(() => validateSessionReviewV2(review), /attainment does not match/);
});

test('rejects canonical vectors and ledger values not bound to component resolution', () => {
  const process = validReview();
  process.process.scopeControl = 'minor_avoidable_drift';
  assert.throws(() => validateSessionReviewV2(process), /canonical process/);

  const ledger = validReview();
  ledger.ledger[0] = { ...ledger.ledger[0]!, status: 'partly_met', reason: 'unknown' };
  ledger.attainment = deriveAttainment(ledger.ledger);
  assert.throws(() => validateSessionReviewV2(ledger), /canonical ledger/);
});

test('accepts and records deterministic conservative vector merges', () => {
  const review = validReview();
  review.components[1].classifications.evidence.execution = 'partial';
  review.evidence.execution = 'partial';
  review.disagreement.disputedFields = [{
    field: 'evidence.execution', smallValue: 'direct', mediumValue: 'partial', resolvedValue: 'partial', resolution: 'deterministic_merge',
  }];
  assert.equal(validateSessionReviewV2(review), review);
});

test('requires exactly one disposition for every proposed amendment', () => {
  const review = validReview();
  review.components[0].classifications.findings = [{
    findingId: 'f-proposed', severity: 'major', category: 'omission', statement: 'Missing necessary behavior.', evidenceRefs: ['e1'], criterionId: 'c2', ledgerEffect: 'add', remediation: 'Add it.',
  }];
  review.components[0].classifications.proposedAmendments = [{
    amendmentId: 'a-undisposed', definition: { ...structuredClone(frozenCriterion), criterionId: 'c2', origin: 'necessary_implied' }, motivatingFindingId: 'f-proposed', evidenceRefs: ['e1'],
  }];
  assert.throws(() => validateSessionReviewV2(review), /every proposed amendment must have exactly one disposition/);
});

test('requires component add findings to carry one matching post-freeze proposal', () => {
  const review = validReview();
  review.components[0].classifications.findings = [{
    findingId: 'orphan-add', severity: 'major', category: 'omission', statement: 'Missing necessary behavior.', evidenceRefs: ['e1'], criterionId: 'c2', ledgerEffect: 'add', remediation: 'Add it.',
  }];
  assert.throws(() => validateSessionReviewV2(review), /exactly one matching material amendment proposal/);
});

test('non-skipped reviewer checks require a toolCallId and outputSha256; declined checks forbid them', () => {
  const missingBinding = validReview();
  missingBinding.reviewerChecks = [{ checkId: 'chk-1', kind: 'static_inspection', target: '/repo/a.ts', query: 'needle', result: '', status: 'pass', evidenceRefs: [] }];
  missingBinding.reviewerChecksSha256 = hashJson(missingBinding.reviewerChecks);
  missingBinding.provenance.pipeline.reviewerChecksSha256 = missingBinding.reviewerChecksSha256;
  assert.throws(() => validateSessionReviewV2(missingBinding), /reviewerChecks\[0\]\.toolCallId/);

  const withBinding = validReview();
  withBinding.reviewerChecks = [{ checkId: 'chk-1', kind: 'static_inspection', target: '/repo/a.ts', query: 'needle', result: '', status: 'pass', evidenceRefs: [], toolCallId: 'tc-1', outputSha256: 'a'.repeat(64) }];
  withBinding.reviewerChecksSha256 = hashJson(withBinding.reviewerChecks);
  withBinding.provenance.pipeline.reviewerChecksSha256 = withBinding.reviewerChecksSha256;
  assert.equal(validateSessionReviewV2(withBinding), withBinding);

  const declinedWithBinding = validReview();
  declinedWithBinding.reviewerChecks = [{ checkId: 'chk-1', kind: 'command', command: 'rm -rf src', cwd: '/repo', result: '', status: 'declined: mutating', evidenceRefs: [], toolCallId: 'tc-1', outputSha256: 'a'.repeat(64) }];
  declinedWithBinding.reviewerChecksSha256 = hashJson(declinedWithBinding.reviewerChecks);
  declinedWithBinding.provenance.pipeline.reviewerChecksSha256 = declinedWithBinding.reviewerChecksSha256;
  assert.throws(() => validateSessionReviewV2(declinedWithBinding), /declined check must not bind/);

  const declinedClean = validReview();
  declinedClean.reviewerChecks = [{ checkId: 'chk-1', kind: 'command', command: 'rm -rf src', cwd: '/repo', result: '', status: 'declined: mutating', evidenceRefs: [] }];
  declinedClean.reviewerChecksSha256 = hashJson(declinedClean.reviewerChecks);
  declinedClean.provenance.pipeline.reviewerChecksSha256 = declinedClean.reviewerChecksSha256;
  assert.equal(validateSessionReviewV2(declinedClean), declinedClean);
});

test('rejects spurious disputed fields that the components never disagreed on', () => {
  const review = validReview();
  review.components[1].classifications.evidence.execution = 'partial';
  review.evidence.execution = 'partial';
  review.disagreement.disputedFields = [
    { field: 'evidence.execution', smallValue: 'direct', mediumValue: 'partial', resolvedValue: 'partial', resolution: 'deterministic_merge' },
    { field: 'evidence.requirements', smallValue: 'clear', mediumValue: 'clear', resolvedValue: 'clear', resolution: 'deterministic_merge' },
  ];
  assert.throws(() => validateSessionReviewV2(review), /spurious disputed field evidence\.requirements/);
});

test('rejects an explicit answer key on cancelled and unanswered human responses', () => {
  const review = validReview();
  review.humanCheck = {
    toolCallId: 'ask-1',
    input: { question: 'Did it render?', options: ['Yes', 'No'], reviewMeta: { purpose: 'review_human_verification', targetSessionId: review.sessionId, targetSessionPath: review.sessionPathAtReview, criterionId: 'c1', domain: 'UI', expectedObservation: 'Correct rendering' } },
    response: { answer: undefined, source: 'cancelled', cancelled: true, status: 'unanswered', recordedAt: '2026-07-24T11:00:00.000Z' },
    interpretation: 'User cancelled.',
  };
  assert.throws(() => validateSessionReviewV2(review), /cannot carry an answer/);

  const omitted = validReview();
  omitted.humanCheck = { ...review.humanCheck, response: { source: 'cancelled', cancelled: true, status: 'unanswered', recordedAt: '2026-07-24T11:00:00.000Z' } };
  // The omitted-answer shape is structurally valid (transcript binding is
  // exercised in runtime-provenance tests).
  assert.equal(validateSessionReviewV2(omitted), omitted);
});

test('hostVersion must be null or a non-empty version string', () => {
  const empty = validReview();
  empty.provenance.hostVersion = '';
  assert.throws(() => validateSessionReviewV2(empty), /hostVersion must be null/);

  const nonString = validReview();
  (nonString.provenance as unknown as { hostVersion: unknown }).hostVersion = 42;
  assert.throws(() => validateSessionReviewV2(nonString), /hostVersion must be null/);
});
