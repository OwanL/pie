import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAttainment } from '../src/attainment.js';
import { hashJson } from '../src/evidence.js';
import { validateSessionReviewV2 } from '../src/validation.js';
import { assessment, proposal, validReview } from './fixtures.js';

test('validates the simplified V2 schema without findings, amendments, or reviewer checks', () => {
  const review = validReview();
  assert.equal(validateSessionReviewV2(review), review);
  assert.deepEqual(Object.keys(review.provenance.pipeline).sort(), ['componentAssessmentIds', 'consolidationId', 'frozenLedgerSha256', 'proposalIds']);
});

test('rejects removed V2 fields at every former schema boundary', () => {
  const cases: Array<[string, (review: ReturnType<typeof validReview>) => void]> = [
    ['review.findings', (review) => { (review as unknown as Record<string, unknown>).findings = []; }],
    ['ledger findingRefs', (review) => { (review.ledger[0] as unknown as Record<string, unknown>).findingRefs = []; }],
    ['proposal candidateChecks', (review) => { (review.proposals[0] as unknown as Record<string, unknown>).candidateChecks = []; }],
    ['assessment proposedAmendments', (review) => { (review.components[0].classifications as unknown as Record<string, unknown>).proposedAmendments = []; }],
    ['pipeline reviewerChecksSha256', (review) => { (review.provenance.pipeline as unknown as Record<string, unknown>).reviewerChecksSha256 = 'a'.repeat(64); }],
  ];
  for (const [name, mutate] of cases) {
    const review = validReview(); mutate(review);
    assert.throws(() => validateSessionReviewV2(review), /simplified V2 schema|unclassified definition/, name);
  }
});

test('rejects status/reason and frozen-definition invariant violations', () => {
  const status = validReview();
  status.ledger[0] = { ...status.ledger[0]!, status: 'met', reason: 'external_blocker' };
  assert.throws(() => validateSessionReviewV2(status), /invalid status\/reason pair/);

  const frozen = validReview();
  (frozen.frozenLedger[0] as unknown as Record<string, unknown>).status = 'met';
  frozen.frozenLedgerSha256 = hashJson(frozen.frozenLedger);
  frozen.consolidation.frozenLedger = structuredClone(frozen.frozenLedger);
  frozen.consolidation.frozenLedgerSha256 = frozen.frozenLedgerSha256;
  frozen.provenance.pipeline.frozenLedgerSha256 = frozen.frozenLedgerSha256;
  assert.throws(() => validateSessionReviewV2(frozen), /unclassified definition/);
});

test('preserves strict hash, rubric, and index versions', () => {
  const badHash = validReview(); badHash.frozenLedgerSha256 = '0'.repeat(64);
  assert.throws(() => validateSessionReviewV2(badHash), /does not match frozenLedger/);
  const badRubric = validReview(); badRubric.rubricVersion = 'rubric-v2';
  assert.throws(() => validateSessionReviewV2(badRubric), /rubricVersion must be session-review-v2.1/);
  const badIndex = validReview(); badIndex.indexVersion = 'v2';
  assert.throws(() => validateSessionReviewV2(badIndex), /indexVersion must be v1/);
});

test('requires material component disagreement to be adjudicated', () => {
  const review = validReview();
  review.components[1].classifications.criteria[0] = { ...review.components[1].classifications.criteria[0]!, status: 'unmet', reason: 'omitted' };
  assert.throws(() => validateSessionReviewV2(review), /disagreement\.material/);
});

test('accepts a downgraded mixed-profile coordinator and adjudicator that resolve a material criterion disagreement', () => {
  const review = validReview();
  review.components[1].classifications.criteria[0] = { ...review.components[1].classifications.criteria[0]!, status: 'unmet', reason: 'omitted' };
  review.ledger[0] = { ...review.ledger[0]!, status: 'unmet', reason: 'omitted' };
  review.attainment = deriveAttainment(review.ledger);
  review.disagreement = { material: true, adjudicated: true, disputedFields: [
    { field: 'criterion:c1.status', firstValue: 'met', secondValue: 'unmet', resolvedValue: 'unmet', resolution: 'adjudicator' },
    { field: 'criterion:c1.reason', firstValue: 'none', secondValue: 'omitted', resolvedValue: 'omitted', resolution: 'adjudicator' },
  ] };
  review.consolidation.bucket = 'small';
  review.consolidation.bucketDowngraded = true;
  review.adjudication = {
    reviewerId: 'reviewer-adjudicator', toolCallId: 'call-adjudicator', requestedBucket: 'medium', bucket: 'small', bucketDowngraded: true,
    modelId: 'model-adjudicator', provider: 'provider-adjudicator', family: 'family-adjudicator', thinkingLevel: null, promptHash: 'prompt-adjudicator', rubricVersion: 'session-review-v2.1',
    adjudicationId: 'adjudication-1', assessedAt: '2026-07-24T10:15:00.000Z',
    resolvedFields: [
      { field: 'criterion:c1.status', value: 'unmet', rationale: 'The omitted artifact is decisive.', evidenceRefs: ['diff:1'] },
      { field: 'criterion:c1.reason', value: 'omitted', rationale: 'The behavior is absent.', evidenceRefs: ['diff:1'] },
    ],
    canonicalOverall: { deliveredOverall: review.attainment.deliveredOverall, controllableOverall: review.attainment.controllableOverall },
  };
  review.provenance.pipeline.adjudicationId = 'adjudication-1';
  review.provenance.adjudicatorReviewerId = 'reviewer-adjudicator';
  assert.equal(validateSessionReviewV2(review), review);

  review.adjudication!.resolvedFields.push({ field: 'obsolete.field', value: 'ignored', rationale: 'obsolete', evidenceRefs: [] });
  assert.throws(() => validateSessionReviewV2(review), /resolvedFields must exactly match computed material fields/);
  review.adjudication!.resolvedFields.pop();
  (review.adjudication as unknown as Record<string, unknown>).amendmentIds = [];
  assert.throws(() => validateSessionReviewV2(review), /simplified V2 schema/);
});

test('canonical derivation merges only criteria, process, evidence, and confidence', () => {
  const review = validReview();
  review.components[1].classifications.criteria[0] = { ...review.components[1].classifications.criteria[0]!, evidenceRefs: ['diff:1'] };
  review.components[1].classifications.process.scopeControl = 'minor_avoidable_drift';
  review.components[1].classifications.evidence.execution = 'partial';
  review.components[1].classifications.confidence = 'medium';
  review.ledger[0] = { ...review.ledger[0]!, evidenceRefs: ['diff:1', 'transcript:1'] };
  review.process.scopeControl = 'minor_avoidable_drift';
  review.evidence.execution = 'partial';
  review.confidence = 'medium';
  review.attainment = deriveAttainment(review.ledger);
  review.disagreement.disputedFields = [
    { field: 'criterion:c1.evidenceRefs', firstValue: '["transcript:1"]', secondValue: '["diff:1"]', resolvedValue: '["diff:1","transcript:1"]', resolution: 'deterministic_merge' },
    { field: 'process.scopeControl', firstValue: 'controlled', secondValue: 'minor_avoidable_drift', resolvedValue: 'minor_avoidable_drift', resolution: 'deterministic_merge' },
    { field: 'evidence.execution', firstValue: 'direct', secondValue: 'partial', resolvedValue: 'partial', resolution: 'deterministic_merge' },
    { field: 'confidence', firstValue: 'high', secondValue: 'medium', resolvedValue: 'medium', resolution: 'deterministic_merge' },
  ];
  assert.equal(validateSessionReviewV2(review), review);
});

test('rejects canonical values not bound to component resolution and spurious disputed fields', () => {
  const process = validReview(); process.process.scopeControl = 'minor_avoidable_drift';
  assert.throws(() => validateSessionReviewV2(process), /canonical process/);
  const spurious = validReview();
  spurious.disagreement.disputedFields = [{ field: 'evidence.requirements', firstValue: 'clear', secondValue: 'clear', resolvedValue: 'clear', resolution: 'deterministic_merge' }];
  assert.throws(() => validateSessionReviewV2(spurious), /spurious disputed field/);
});

test('rejects duplicate proposal and component assessment IDs', () => {
  const duplicateProposals = validReview();
  duplicateProposals.proposals[1].proposalId = duplicateProposals.proposals[0].proposalId;
  assert.throws(() => validateSessionReviewV2(duplicateProposals), /review\.proposals must contain unique IDs/);

  const duplicateAssessments = validReview();
  duplicateAssessments.components[1].assessmentId = duplicateAssessments.components[0].assessmentId;
  assert.throws(() => validateSessionReviewV2(duplicateAssessments), /review\.components must contain unique IDs/);
});

test('retains human-question validation and deterministic attainment', () => {
  const review = validReview();
  review.attainment.qualityIndexV1 = 1;
  assert.throws(() => validateSessionReviewV2(review), /attainment does not match/);

  const human = validReview();
  human.humanCheck = {
    toolCallId: 'ask-1', input: { question: 'Did it render?', options: ['Yes', 'No'], reviewMeta: { purpose: 'review_human_verification', targetSessionId: human.sessionId, targetSessionPath: human.sessionPathAtReview, criterionId: 'c1', domain: 'UI', expectedObservation: 'Correct rendering' } },
    response: { source: 'cancelled', cancelled: true, status: 'unanswered', recordedAt: '2026-07-24T11:00:00.000Z' }, interpretation: 'User cancelled.',
  };
  assert.equal(validateSessionReviewV2(human), human);
});

test('accepts small+small and requires medium coordination for mixed profiles', () => {
  const review = validReview();
  const secondProposal = proposal('small'); secondProposal.proposalId = 'proposal-small-2';
  review.proposals = [proposal('small'), secondProposal];
  const secondAssessment = assessment('small'); secondAssessment.assessmentId = 'assessment-small-2';
  review.components = [assessment('small'), secondAssessment];
  review.consolidation.requestedBucket = 'small'; review.consolidation.bucket = 'small'; review.consolidation.bucketDowngraded = false;
  review.provenance.diversityAchieved = false;
  review.provenance.pipeline.proposalIds = ['proposal-small', 'proposal-small-2'];
  review.provenance.pipeline.componentAssessmentIds = ['assessment-small', 'assessment-small-2'];
  review.consolidation.provenance.fromProposals = ['proposal-small', 'proposal-small-2'];
  assert.equal(validateSessionReviewV2(review), review);

  const mixed = validReview(); mixed.consolidation.requestedBucket = 'small'; mixed.consolidation.bucket = 'small';
  assert.throws(() => validateSessionReviewV2(mixed), /requestedBucket has an unsupported value/);
});

test('uses neutral first/second disputed values for a small-only profile', () => {
  const review = validReview();
  const secondProposal = proposal('small'); secondProposal.proposalId = 'proposal-small-2';
  review.proposals = [proposal('small'), secondProposal];
  const secondAssessment = assessment('small'); secondAssessment.assessmentId = 'assessment-small-2';
  review.components = [assessment('small'), secondAssessment];
  review.components[1].classifications.evidence.execution = 'partial';
  review.evidence.execution = 'partial';
  review.consolidation.requestedBucket = 'small'; review.consolidation.bucket = 'small'; review.consolidation.bucketDowngraded = false;
  review.consolidation.provenance.fromProposals = ['proposal-small', 'proposal-small-2'];
  review.provenance.diversityAchieved = false;
  review.provenance.pipeline.proposalIds = ['proposal-small', 'proposal-small-2'];
  review.provenance.pipeline.componentAssessmentIds = ['assessment-small', 'assessment-small-2'];
  review.disagreement.disputedFields = [
    { field: 'evidence.execution', firstValue: 'direct', secondValue: 'partial', resolvedValue: 'partial', resolution: 'deterministic_merge' },
  ];
  assert.equal(validateSessionReviewV2(review), review);
});
