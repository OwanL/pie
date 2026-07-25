import { deriveAttainment } from '../src/attainment.js';
import { hashJson } from '../src/evidence.js';
import type {
  ClassifiedCriterion, CriterionDefinition, EvidenceManifest, ReviewerAssessment, ReviewerProposal, ReviewEvidenceVector, SessionReviewV2,
} from '../src/types.js';

export const frozenCriterion: CriterionDefinition = {
  criterionId: 'c1',
  statement: 'Implement the requested behavior.',
  origin: 'explicit',
  importance: 'core',
  taxonomy: { activity: 'implement', surface: ['application_logic'], evidenceMode: ['static_inspection'] },
};
export const metCriterion: ClassifiedCriterion = {
  ...frozenCriterion,
  status: 'met',
  reason: 'none',
  evidenceRefs: ['transcript:1'],
  findingRefs: [],
};
export const processVector = {
  requirementDiscipline: 'proportionate',
  verificationDiscipline: 'proportionate',
  scopeControl: 'controlled',
  recovery: 'not_needed',
  finalClaimAccuracy: 'accurate',
} as const;
export const evidenceVector: ReviewEvidenceVector = {
  requirements: 'clear',
  artifacts: 'direct',
  execution: 'direct',
  human: 'not_needed',
  limitations: [],
};

function reviewerRuntime<T extends 'small' | 'medium'>(requestedBucket: T, suffix: string) {
  return {
    reviewerId: `reviewer-${suffix}`,
    toolCallId: `call-${suffix}`,
    requestedBucket,
    bucket: requestedBucket,
    bucketDowngraded: false,
    modelId: `model-${suffix}`,
    provider: requestedBucket === 'small' ? 'provider-a' : 'provider-b',
    family: requestedBucket === 'small' ? 'family-a' : 'family-b',
    thinkingLevel: null,
    promptHash: `prompt-${suffix}`,
    rubricVersion: 'rubric-v2',
  } as const;
}
function proposal(requestedBucket: 'small' | 'medium'): ReviewerProposal {
  const suffix = `proposal-${requestedBucket}`;
  return {
    ...reviewerRuntime(requestedBucket, suffix),
    proposalId: suffix,
    proposedAt: '2026-07-24T10:00:00.000Z',
    criteria: [structuredClone(frozenCriterion)],
    findings: [],
    candidateChecks: [],
  };
}
function assessment(requestedBucket: 'small' | 'medium'): ReviewerAssessment {
  const suffix = `assessment-${requestedBucket}`;
  return {
    ...reviewerRuntime(requestedBucket, suffix),
    assessmentId: suffix,
    assessedAt: '2026-07-24T10:10:00.000Z',
    classifications: {
      criteria: [structuredClone(metCriterion)],
      process: structuredClone(processVector),
      evidence: structuredClone(evidenceVector),
      findings: [],
      confidence: 'high',
      proposedOverall: 'achieved',
      proposedAmendments: [],
    },
  };
}

export function evidenceManifest(overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    rawJsonlSha256: 'a'.repeat(64),
    rawJsonlBytes: 100,
    rawJsonlMtime: '2026-07-24T09:00:00.000Z',
    transcriptExcerptSha256: 'b'.repeat(64),
    artifacts: [],
    limitations: [],
    blinding: {
      stripped: ['modelId', 'provider', 'thinkingLevel', 'family', 'reputation', 'settingsVersion'],
      redactedTurnFields: ['message.model'],
      notes: ['blinded'],
    },
    ...overrides,
  };
}

export function validReview(overrides: Partial<SessionReviewV2> = {}): SessionReviewV2 {
  const frozenLedger = [structuredClone(frozenCriterion)];
  const ledger = [structuredClone(metCriterion)];
  const proposals: [ReviewerProposal, ReviewerProposal] = [proposal('small'), proposal('medium')];
  const components: [ReviewerAssessment, ReviewerAssessment] = [assessment('small'), assessment('medium')];
  const frozenLedgerSha256 = hashJson(frozenLedger);
  const reviewerChecks: SessionReviewV2['reviewerChecks'] = [];
  const reviewerChecksSha256 = hashJson(reviewerChecks);
  const manifest = evidenceManifest();
  const review: SessionReviewV2 = {
    schemaVersion: 2,
    kind: 'production',
    reviewId: 'review-1',
    sessionId: 'session-1',
    sessionPathAtReview: '/sessions/session-1.jsonl',
    rubricVersion: 'rubric-v2',
    indexVersion: 'v1',
    reviewedAt: '2026-07-24T10:20:00.000Z',
    frozenLedger,
    frozenLedgerSha256,
    ledger,
    amendments: [],
    attainment: deriveAttainment(ledger),
    process: structuredClone(processVector),
    evidence: structuredClone(evidenceVector),
    findings: [],
    confidence: 'high',
    proposals,
    consolidation: {
      ...reviewerRuntime('medium', 'consolidator'),
      consolidationId: 'consolidation-1',
      consolidatedAt: '2026-07-24T10:05:00.000Z',
      frozenLedger: structuredClone(frozenLedger),
      frozenLedgerSha256,
      provenance: { fromProposals: ['proposal-small', 'proposal-medium'], dedupNotes: [] },
    },
    reviewerChecks,
    reviewerChecksSha256,
    components,
    disagreement: { material: false, disputedFields: [], adjudicated: false },
    provenance: {
      orchestratorSessionId: 'reviewer-session',
      rubricVersion: 'rubric-v2',
      indexVersion: 'v1',
      blindingApplied: true,
      diversityAchieved: true,
      evidenceManifest: manifest,
      pipeline: {
        frozenLedgerSha256,
        reviewerChecksSha256,
        proposalIds: ['proposal-small', 'proposal-medium'],
        consolidationId: 'consolidation-1',
        componentAssessmentIds: ['assessment-small', 'assessment-medium'],
        amendmentIds: [],
      },
      hostVersion: process.env.PIE_EDITOR_VERSION?.trim() || null,
    },
  };
  return { ...review, ...overrides };
}
