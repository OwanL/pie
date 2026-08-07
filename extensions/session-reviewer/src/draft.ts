import { randomUUID } from 'node:crypto';

import { deriveAttainment } from './attainment.js';
import { deriveCanonicalFromComponents, resolutionString } from './canonical.js';
import { materialDisagreementFields } from './disagreement.js';
import { hashCanonicalJson } from './hash.js';
import type {
  ClassifiedCriterion, ConsolidationDraft, ConsolidationRecord, CriterionDefinition,
  ReviewDisagreementSummary, ReviewProvenance, ReviewProvenanceDraft, ReviewerAdjudication,
  ReviewerAdjudicationDraft, ReviewerAssessment, ReviewerAssessmentDraft, ReviewerProposal,
  ReviewerProposalDraft, SessionReviewDraft, SessionReviewV2, EvidenceManifest,
} from './types.js';

export const CURRENT_SCHEMA_VERSION = 2;
export const CURRENT_RUBRIC_VERSION = 'session-review-v2.1';
export const CURRENT_INDEX_VERSION = 'v1';

type DraftContext = {
  orchestratorSessionId?: string;
  hostVersion?: string | null;
  evidenceManifest?: EvidenceManifest;
};

function now(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}-${randomUUID()}`; }
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`review draft requires ${name}`);
  return value;
}

function proposal(input: ReviewerProposalDraft): ReviewerProposal {
  return {
    ...input,
    reviewerId: required(input.reviewerId, 'proposals[].reviewerId'),
    toolCallId: required(input.toolCallId, 'proposals[].toolCallId'),
    modelId: required(input.modelId, 'proposals[].modelId'),
    provider: required(input.provider, 'proposals[].provider'),
    family: required(input.family, 'proposals[].family'),
    promptHash: required(input.promptHash, 'proposals[].promptHash'),
    requestedBucket: input.requestedBucket,
    bucket: input.bucket,
    bucketDowngraded: input.bucketDowngraded,
    thinkingLevel: input.thinkingLevel ?? null,
    rubricVersion: CURRENT_RUBRIC_VERSION,
    proposalId: input.proposalId ?? id('proposal'),
    proposedAt: input.proposedAt ?? now(),
  };
}

function consolidation(
  input: ConsolidationDraft,
  proposals: [ReviewerProposal, ReviewerProposal],
): ConsolidationRecord {
  const { frozenLedger: _ledger, frozenLedgerSha256: _hash, provenance: inputProvenance, ...runtime } = input;
  return {
    ...runtime,
    reviewerId: required(input.reviewerId, 'consolidation.reviewerId'),
    toolCallId: required(input.toolCallId, 'consolidation.toolCallId'),
    modelId: required(input.modelId, 'consolidation.modelId'),
    provider: required(input.provider, 'consolidation.provider'),
    family: required(input.family, 'consolidation.family'),
    promptHash: required(input.promptHash, 'consolidation.promptHash'),
    requestedBucket: input.requestedBucket,
    bucket: input.bucket,
    bucketDowngraded: input.bucketDowngraded,
    thinkingLevel: input.thinkingLevel ?? null,
    rubricVersion: CURRENT_RUBRIC_VERSION,
    consolidationId: input.consolidationId ?? id('consolidation'),
    consolidatedAt: input.consolidatedAt ?? now(),
    provenance: {
      fromProposals: [proposals[0].proposalId, proposals[1].proposalId],
      dedupNotes: inputProvenance?.dedupNotes ?? [],
    },
  };
}

function assessment(input: ReviewerAssessmentDraft): ReviewerAssessment {
  const { classifications, ...runtime } = input;
  return {
    ...runtime,
    reviewerId: required(input.reviewerId, 'components[].reviewerId'),
    toolCallId: required(input.toolCallId, 'components[].toolCallId'),
    modelId: required(input.modelId, 'components[].modelId'),
    provider: required(input.provider, 'components[].provider'),
    family: required(input.family, 'components[].family'),
    promptHash: required(input.promptHash, 'components[].promptHash'),
    requestedBucket: input.requestedBucket,
    bucket: input.bucket,
    bucketDowngraded: input.bucketDowngraded,
    thinkingLevel: input.thinkingLevel ?? null,
    rubricVersion: CURRENT_RUBRIC_VERSION,
    assessmentId: input.assessmentId ?? id('assessment'),
    assessedAt: input.assessedAt ?? now(),
    classifications: structuredClone(classifications),
  };
}

function adjudication(input: ReviewerAdjudicationDraft): ReviewerAdjudication {
  const { canonicalOverall: _canonicalOverall, ...runtime } = input;
  return {
    ...runtime,
    reviewerId: required(input.reviewerId, 'adjudication.reviewerId'),
    toolCallId: required(input.toolCallId, 'adjudication.toolCallId'),
    modelId: required(input.modelId, 'adjudication.modelId'),
    provider: required(input.provider, 'adjudication.provider'),
    family: required(input.family, 'adjudication.family'),
    promptHash: required(input.promptHash, 'adjudication.promptHash'),
    requestedBucket: input.requestedBucket,
    bucket: input.bucket,
    bucketDowngraded: input.bucketDowngraded,
    thinkingLevel: input.thinkingLevel ?? null,
    rubricVersion: CURRENT_RUBRIC_VERSION,
    adjudicationId: input.adjudicationId ?? id('adjudication'),
    assessedAt: input.assessedAt ?? now(),
    resolvedFields: structuredClone(input.resolvedFields),
  };
}

function fieldValue(component: ReviewerAssessment, field: string): unknown {
  const criterion = /^criterion:(.+)\.(status|reason|evidenceRefs)$/.exec(field);
  if (criterion) {
    const item = component.classifications.criteria.find((candidate) => candidate.criterionId === criterion[1]);
    return item?.[criterion[2] as 'status' | 'reason' | 'evidenceRefs'];
  }
  if (field.startsWith('process.')) return component.classifications.process[field.slice('process.'.length) as keyof typeof component.classifications.process];
  if (field.startsWith('evidence.')) return component.classifications.evidence[field.slice('evidence.'.length) as keyof typeof component.classifications.evidence];
  if (field === 'confidence') return component.classifications.confidence;
  return undefined;
}

function disagreement(
  components: [ReviewerAssessment, ReviewerAssessment],
  canonical: ReturnType<typeof deriveCanonicalFromComponents>,
  adjudicated: boolean,
): ReviewDisagreementSummary {
  const material = new Set(materialDisagreementFields(components[0], components[1]));
  const fields = [...new Set([...material, ...canonical.differingFields.keys()])];
  return {
    material: material.size > 0,
    adjudicated,
    disputedFields: fields.map((field) => {
      const resolution = canonical.differingFields.get(field);
      if (!resolution) throw new Error(`canonical derivation did not resolve disputed field ${field}`);
      return {
        field,
        firstValue: resolutionString(fieldValue(components[0], field)),
        secondValue: resolutionString(fieldValue(components[1], field)),
        resolvedValue: resolutionString(resolution.value),
        resolution: material.has(field) ? 'adjudicator' : resolution.resolution,
      };
    }),
  };
}

function provenance(
  input: ReviewProvenanceDraft,
  proposals: [ReviewerProposal, ReviewerProposal],
  consolidationRecord: ConsolidationRecord,
  components: [ReviewerAssessment, ReviewerAssessment],
  frozenLedgerSha256: string,
  adjudicationRecord: ReviewerAdjudication | undefined,
  context: DraftContext,
): ReviewProvenance {
  const orchestratorSessionId = context.orchestratorSessionId ?? input.orchestratorSessionId;
  if (!orchestratorSessionId?.trim()) throw new Error('review draft requires provenance.orchestratorSessionId');
  const evidenceManifest = input.evidenceManifest ?? context.evidenceManifest;
  if (!evidenceManifest) throw new Error('review draft requires an evidence manifest issued by getEvidence');
  const adjudicationId = adjudicationRecord?.adjudicationId;
  return {
    orchestratorSessionId,
    rubricVersion: CURRENT_RUBRIC_VERSION,
    indexVersion: CURRENT_INDEX_VERSION,
    blindingApplied: true,
    diversityAchieved: components[0].provider !== components[1].provider || components[0].family !== components[1].family,
    evidenceManifest: structuredClone(evidenceManifest),
    pipeline: {
      frozenLedgerSha256,
      proposalIds: [proposals[0].proposalId, proposals[1].proposalId],
      consolidationId: consolidationRecord.consolidationId,
      componentAssessmentIds: [components[0].assessmentId, components[1].assessmentId],
      ...(adjudicationId ? { adjudicationId } : {}),
    },
    ...(adjudicationRecord ? { adjudicatorReviewerId: adjudicationRecord.reviewerId } : {}),
    hostVersion: (context.hostVersion !== undefined ? context.hostVersion : process.env.PIE_EDITOR_VERSION?.trim()) || null,
  };
}

export function isSessionReviewDraft(value: unknown): value is SessionReviewDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.frozenLedger)
    && Array.isArray(candidate.proposals)
    && Array.isArray(candidate.components)
    && !('ledger' in candidate)
    && !('attainment' in candidate);
}

/**
 * Turns compact evaluator input into the canonical record expected by validation.
 * All derived fields and storage metadata are produced here, inside the extension,
 * rather than by the evaluator model.
 */
export function compileReviewDraft(input: SessionReviewDraft, context: DraftContext = {}): SessionReviewV2 {
  const frozenLedger = structuredClone(input.frozenLedger);
  if (input.proposals.length !== 2 || input.components.length !== 2) throw new Error('review draft requires exactly two proposals and two components');
  const proposals: [ReviewerProposal, ReviewerProposal] = [proposal(input.proposals[0]), proposal(input.proposals[1])];
  const consolidationRecord = consolidation(input.consolidation, proposals);
  const components: [ReviewerAssessment, ReviewerAssessment] = [assessment(input.components[0]), assessment(input.components[1])];
  let adjudicationRecord = input.adjudication ? adjudication(input.adjudication) : undefined;
  const canonical = deriveCanonicalFromComponents(components, adjudicationRecord);
  const attainment = deriveAttainment(canonical.ledger);
  const frozenLedgerSha256 = hashCanonicalJson(frozenLedger);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    kind: input.kind ?? 'production',
    reviewId: input.reviewId ?? id('review'),
    sessionId: required(input.sessionId, 'sessionId'),
    sessionPathAtReview: required(input.sessionPathAtReview, 'sessionPathAtReview'),
    ...(input.identityFallback !== undefined ? { identityFallback: input.identityFallback } : {}),
    rubricVersion: CURRENT_RUBRIC_VERSION,
    indexVersion: CURRENT_INDEX_VERSION,
    reviewedAt: input.reviewedAt ?? now(),
    frozenLedger,
    frozenLedgerSha256,
    ledger: canonical.ledger,
    attainment,
    process: canonical.process,
    evidence: canonical.evidence,
    ...(input.humanCheck ? { humanCheck: structuredClone(input.humanCheck) } : {}),
    confidence: canonical.confidence,
    proposals,
    consolidation: consolidationRecord,
    components,
    disagreement: disagreement(components, canonical, !!adjudicationRecord),
    ...(adjudicationRecord ? { adjudication: adjudicationRecord } : {}),
    provenance: provenance(input.provenance, proposals, consolidationRecord, components, frozenLedgerSha256, adjudicationRecord, context),
  };
}
