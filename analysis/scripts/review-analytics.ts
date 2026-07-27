import { isDeepStrictEqual } from 'node:util';

import { validateSessionReviewV2 } from '../../extensions/session-reviewer/src/validation.ts';
import { sha256Hex } from './hash.ts';
import type {
  ClassifiedCriterion,
  CriterionAttainmentSummary,
  CriterionImportance,
  CriterionReason,
  CriterionStatus,
  OverallAttainment,
  ReviewEvidenceVector,
  ReviewProcessVector,
  ReviewerRuntimeReference,
  SessionReviewV2RejectionReason,
  SessionReviewV2Source,
} from './contracts.ts';

export const SESSION_REVIEW_V2_RUBRIC_VERSION = 'session-review-v2.1';
export const SESSION_REVIEW_V2_INDEX_VERSION = 'v1';

const IMPORTANCES: CriterionImportance[] = ['core', 'supporting', 'optional'];
const STATUSES = new Set<CriterionStatus>(['met', 'partly_met', 'unmet', 'blocked', 'not_assessable', 'superseded']);
const REASONS = new Set<CriterionReason>(['none', 'omitted', 'attempt_failed', 'incorrect_result', 'regression', 'external_blocker', 'user_dependency', 'human_evidence_missing', 'insufficient_artifact_evidence', 'unknown']);
const ACTIVITIES = new Set(['implement', 'debug', 'investigate', 'explain', 'design', 'operate', 'verify', 'other']);
const SURFACES = new Set(['ui', 'application_logic', 'api_integration', 'data', 'tests', 'documentation', 'configuration', 'infrastructure', 'developer_tooling', 'agent_harness', 'external_system', 'communication', 'other']);
const EVIDENCE_MODES = new Set(['static_inspection', 'automated_check', 'runtime_observation', 'human_observation', 'external_confirmation', 'reasoning_or_sources', 'other']);
const PROCESS_VALUES = {
  requirementDiscipline: new Set(['proportionate', 'underclarified', 'overclarified', 'not_assessable']),
  verificationDiscipline: new Set(['proportionate', 'underverified', 'oververified', 'not_applicable', 'not_assessable']),
  scopeControl: new Set(['controlled', 'minor_avoidable_drift', 'material_scope_drift', 'not_assessable']),
  recovery: new Set(['effective', 'partly_effective', 'ineffective', 'not_needed', 'not_assessable']),
  finalClaimAccuracy: new Set(['accurate', 'overclaimed', 'underclaimed', 'unclear', 'no_final_claim']),
} as const;
const EVIDENCE_VALUES = {
  requirements: new Set(['clear', 'partly_clear', 'unclear']),
  artifacts: new Set(['direct', 'partial', 'none', 'not_applicable']),
  execution: new Set(['direct', 'partial', 'reported_only', 'none', 'not_applicable']),
  human: new Set(['not_needed', 'supports', 'contradicts', 'inconclusive', 'unanswered', 'unavailable']),
} as const;
const ALLOWED_REASONS: Record<CriterionStatus, Set<CriterionReason>> = {
  met: new Set(['none']),
  partly_met: new Set(['omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown']),
  unmet: new Set(['omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown']),
  blocked: new Set(['external_blocker', 'user_dependency', 'unknown']),
  not_assessable: new Set(['human_evidence_missing', 'insufficient_artifact_evidence', 'unknown']),
  superseded: new Set(['none']),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function isoDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}
function hashJson(value: unknown): string { return sha256Hex(JSON.stringify(value)); }
function validHash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function unique(values: string[]): boolean { return new Set(values).size === values.length; }

function coerceDefinition(value: unknown): Omit<ClassifiedCriterion, 'status' | 'reason' | 'evidenceRefs'> | null {
  if (!isRecord(value) || ['status', 'reason', 'evidenceRefs', 'findingRefs'].some((key) => key in value) || !isRecord(value.taxonomy)) return null;
  const criterionId = nonEmpty(value.criterionId);
  const statement = nonEmpty(value.statement);
  const surfaces = strings(value.taxonomy.surface);
  const evidenceModes = strings(value.taxonomy.evidenceMode);
  if (!criterionId || !statement || (value.origin !== 'explicit' && value.origin !== 'necessary_implied')
    || !IMPORTANCES.includes(value.importance as CriterionImportance) || !ACTIVITIES.has(String(value.taxonomy.activity))
    || !surfaces?.length || surfaces.some((surface) => !SURFACES.has(surface))
    || !evidenceModes?.length || evidenceModes.some((mode) => !EVIDENCE_MODES.has(mode))) return null;
  return { criterionId, statement, origin: value.origin, importance: value.importance as CriterionImportance, taxonomy: { activity: String(value.taxonomy.activity), surface: surfaces, evidenceMode: evidenceModes } };
}

function definitionOf(value: ClassifiedCriterion): Omit<ClassifiedCriterion, 'status' | 'reason' | 'evidenceRefs'> {
  const { status: _status, reason: _reason, evidenceRefs: _evidenceRefs, ...definition } = value;
  return definition;
}
function classifiesDefinitions(ledger: ClassifiedCriterion[], definitions: Array<ReturnType<typeof coerceDefinition>>): boolean {
  const byId = new Map(ledger.map((entry) => [entry.criterionId, entry]));
  return definitions.every((definition) => {
    const classified = definition ? byId.get(definition.criterionId) : undefined;
    return !!classified && isDeepStrictEqual(definitionOf(classified), definition);
  });
}

function coerceCriterion(value: unknown): ClassifiedCriterion | null {
  if (!isRecord(value) || !isRecord(value.taxonomy)) return null;
  const criterionId = nonEmpty(value.criterionId);
  const statement = nonEmpty(value.statement);
  const surfaces = strings(value.taxonomy.surface);
  const evidenceModes = strings(value.taxonomy.evidenceMode);
  const evidenceRefs = strings(value.evidenceRefs);
  if (!criterionId || statement === null || (value.origin !== 'explicit' && value.origin !== 'necessary_implied')
    || !IMPORTANCES.includes(value.importance as CriterionImportance) || !STATUSES.has(value.status as CriterionStatus)
    || !REASONS.has(value.reason as CriterionReason) || !ACTIVITIES.has(String(value.taxonomy.activity))
    || !surfaces?.length || surfaces.some((surface) => !SURFACES.has(surface))
    || !evidenceModes?.length || evidenceModes.some((mode) => !EVIDENCE_MODES.has(mode)) || !evidenceRefs || 'findingRefs' in value
    || !ALLOWED_REASONS[value.status as CriterionStatus].has(value.reason as CriterionReason)) return null;
  return {
    criterionId,
    statement,
    origin: value.origin,
    importance: value.importance as CriterionImportance,
    taxonomy: { activity: String(value.taxonomy.activity), surface: surfaces, evidenceMode: evidenceModes },
    status: value.status as CriterionStatus,
    reason: value.reason as CriterionReason,
    evidenceRefs,
  };
}

function coerceProcess(value: unknown): ReviewProcessVector | null {
  if (!isRecord(value)) return null;
  const keys = ['requirementDiscipline', 'verificationDiscipline', 'scopeControl', 'recovery', 'finalClaimAccuracy'] as const;
  if (!keys.every((key) => typeof value[key] === 'string' && PROCESS_VALUES[key].has(value[key] as never))) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as ReviewProcessVector;
}
function coerceEvidence(value: unknown): ReviewEvidenceVector | null {
  if (!isRecord(value)) return null;
  const limitations = strings(value.limitations);
  if (!limitations || typeof value.requirements !== 'string' || !EVIDENCE_VALUES.requirements.has(value.requirements)
    || typeof value.artifacts !== 'string' || !EVIDENCE_VALUES.artifacts.has(value.artifacts)
    || typeof value.execution !== 'string' || !EVIDENCE_VALUES.execution.has(value.execution)
    || typeof value.human !== 'string' || !EVIDENCE_VALUES.human.has(value.human)) return null;
  return { requirements: value.requirements, artifacts: value.artifacts, execution: value.execution, human: value.human, limitations };
}
function coerceReviewer(value: unknown, role: ReviewerRuntimeReference['role']): ReviewerRuntimeReference | null {
  if (!isRecord(value)) return null;
  const reviewerId = nonEmpty(value.reviewerId);
  const modelId = nonEmpty(value.modelId);
  const provider = nonEmpty(value.provider);
  const family = nonEmpty(value.family);
  if (!reviewerId || !modelId || !provider || !family || (value.requestedBucket !== 'small' && value.requestedBucket !== 'medium')
    || (value.bucket !== 'small' && value.bucket !== 'medium') || typeof value.bucketDowngraded !== 'boolean'
    || (value.requestedBucket === 'small' && value.bucket !== 'small')
    || value.bucketDowngraded !== (value.bucket !== value.requestedBucket)
    || (value.thinkingLevel !== null && typeof value.thinkingLevel !== 'string')) return null;
  return { role, reviewerId, requestedBucket: value.requestedBucket, bucket: value.bucket as ReviewerRuntimeReference['bucket'], bucketDowngraded: value.bucketDowngraded, modelId, provider, family, thinkingLevel: value.thinkingLevel as string | null };
}

function validateCanonicalEnvelope(value: Record<string, unknown>, ledger: ClassifiedCriterion[]): boolean {
  if (!Number.isInteger(value.schemaVersion) || !isoDate(value.reviewedAt)) return false;

  const frozenRaw = value.frozenLedger;
  if (!Array.isArray(frozenRaw) || !frozenRaw.length || !validHash(value.frozenLedgerSha256)
    || value.frozenLedgerSha256 !== hashJson(frozenRaw)) return false;
  const frozen = frozenRaw.map(coerceDefinition);
  if (frozen.some((entry) => !entry) || !unique(frozen.map((entry) => entry!.criterionId))
    || !unique(ledger.map((entry) => entry.criterionId))) return false;
  if (!classifiesDefinitions(ledger, frozen)
    || ledger.length !== frozen.length
    || ledger.some((entry) => !frozen.some((definition) => definition!.criterionId === entry.criterionId))) return false;
  if (['amendments', 'findings', 'reviewerChecks', 'reviewerChecksSha256'].some((key) => key in value)) return false;

  if (!Array.isArray(value.proposals) || value.proposals.length !== 2) return false;
  const proposalIds: string[] = [];
  const proposalBuckets: string[] = [];
  for (const proposalValue of value.proposals) {
    if (!isRecord(proposalValue) || !coerceReviewer(proposalValue, 'proposal') || !isoDate(proposalValue.proposedAt)
      || !Array.isArray(proposalValue.criteria) || 'findings' in proposalValue || 'candidateChecks' in proposalValue
      || proposalValue.rubricVersion !== value.rubricVersion) return false;
    const proposalId = nonEmpty(proposalValue.proposalId);
    if (!proposalId) return false;
    proposalIds.push(proposalId);
    proposalBuckets.push(String(proposalValue.requestedBucket));
  }
  const sortedProposalBuckets = proposalBuckets.sort();
  const smallOnly = isDeepStrictEqual(sortedProposalBuckets, ['small', 'small']);
  if (!smallOnly && !isDeepStrictEqual(sortedProposalBuckets, ['medium', 'small'])) return false;
  const orchestrationBucket = smallOnly ? 'small' : 'medium';

  if (!isRecord(value.consolidation) || !coerceReviewer(value.consolidation, 'consolidation')) return false;
  const consolidationId = nonEmpty(value.consolidation.consolidationId);
  const consolidationProvenance = isRecord(value.consolidation.provenance) ? value.consolidation.provenance : null;
  if (!consolidationId || !isoDate(value.consolidation.consolidatedAt) || value.consolidation.rubricVersion !== value.rubricVersion
    || value.consolidation.requestedBucket !== orchestrationBucket
    || value.consolidation.frozenLedgerSha256 !== value.frozenLedgerSha256
    || !isDeepStrictEqual(value.consolidation.frozenLedger, frozenRaw) || !consolidationProvenance
    || !Array.isArray(consolidationProvenance.fromProposals)
    || !isDeepStrictEqual([...consolidationProvenance.fromProposals].sort(), [...proposalIds].sort())) return false;

  if (!Array.isArray(value.components) || value.components.length !== 2) return false;
  const componentIds: string[] = [];
  const componentBuckets: string[] = [];
  for (const componentValue of value.components) {
    const classifications = isRecord(componentValue) && isRecord(componentValue.classifications) ? componentValue.classifications : null;
    if (!isRecord(componentValue) || !coerceReviewer(componentValue, 'component') || !isoDate(componentValue.assessedAt)
      || componentValue.rubricVersion !== value.rubricVersion || !classifications
      || !Array.isArray(classifications.criteria) || 'findings' in classifications || 'proposedAmendments' in classifications) return false;
    const assessmentId = nonEmpty(componentValue.assessmentId);
    const classified = classifications.criteria.map(coerceCriterion);
    if (!assessmentId || classified.some((entry) => !entry) || classified.length !== frozen.length) return false;
    if (!classifiesDefinitions(classified as ClassifiedCriterion[], frozen)) return false;
    componentIds.push(assessmentId);
    componentBuckets.push(String(componentValue.requestedBucket));
  }
  if (!unique(componentIds) || !isDeepStrictEqual(componentBuckets.sort(), sortedProposalBuckets)) return false;

  const adjudication = value.adjudication;
  const adjudicationId = isRecord(adjudication) ? nonEmpty(adjudication.adjudicationId) : null;
  if (adjudication !== undefined && (!isRecord(adjudication) || !coerceReviewer(adjudication, 'adjudication') || !adjudicationId
    || adjudication.requestedBucket !== orchestrationBucket
    || adjudication.rubricVersion !== value.rubricVersion || 'amendmentIds' in adjudication
    || !isoDate(adjudication.assessedAt))) return false;
  if (!isRecord(value.disagreement) || value.disagreement.material !== (adjudication !== undefined)
    || value.disagreement.adjudicated !== (adjudication !== undefined)) return false;
  if (!isRecord(value.provenance) || value.provenance.blindingApplied !== true
    || value.provenance.rubricVersion !== value.rubricVersion || value.provenance.indexVersion !== value.indexVersion
    || !isRecord(value.provenance.pipeline)) return false;
  const pipeline = value.provenance.pipeline;
  if (pipeline.frozenLedgerSha256 !== value.frozenLedgerSha256 || 'reviewerChecksSha256' in pipeline || 'amendmentIds' in pipeline
    || !isDeepStrictEqual(pipeline.proposalIds, proposalIds) || pipeline.consolidationId !== consolidationId
    || !isDeepStrictEqual(pipeline.componentAssessmentIds, componentIds)
    || pipeline.adjudicationId !== (adjudicationId ?? undefined)) return false;

  const attainment = deriveReviewAttainment(ledger);
  if (!isDeepStrictEqual(value.attainment, attainment)) return false;
  return true;
}

export type SessionReviewV2CoercionResult =
  | { review: SessionReviewV2Source; rejectionReason: null }
  | { review: null; rejectionReason: SessionReviewV2RejectionReason };

/** Validate one production V2 record while retaining a coarse, stable rejection reason. */
export function inspectSessionReviewV2(value: unknown): SessionReviewV2CoercionResult {
  if (!isRecord(value) || value.kind !== 'production' || value.schemaVersion !== 2) {
    return { review: null, rejectionReason: 'unsupported_schema' };
  }
  if (value.rubricVersion !== SESSION_REVIEW_V2_RUBRIC_VERSION) {
    return { review: null, rejectionReason: 'unsupported_rubric' };
  }
  if (value.indexVersion !== SESSION_REVIEW_V2_INDEX_VERSION) {
    return { review: null, rejectionReason: 'unsupported_index' };
  }
  const reviewId = nonEmpty(value.reviewId);
  const sessionId = nonEmpty(value.sessionId);
  const reviewedAt = nonEmpty(value.reviewedAt);
  const sessionPathAtReview = nonEmpty(value.sessionPathAtReview);
  if (!reviewId || !sessionId || !reviewedAt || !sessionPathAtReview
    || (value.identityFallback !== undefined && typeof value.identityFallback !== 'boolean')) {
    return { review: null, rejectionReason: 'invalid_identity' };
  }
  try {
    validateSessionReviewV2(value);
  } catch {
    return { review: null, rejectionReason: 'invalid_payload' };
  }
  const ledger = Array.isArray(value.ledger) ? value.ledger.map(coerceCriterion) : [];
  const process = coerceProcess(value.process);
  const evidence = coerceEvidence(value.evidence);
  if (!ledger.length || ledger.some((entry) => !entry) || !process || !evidence
    || !validateCanonicalEnvelope(value, ledger as ClassifiedCriterion[])
    || (value.confidence !== 'high' && value.confidence !== 'medium' && value.confidence !== 'low')
    || !isRecord(value.disagreement) || typeof value.disagreement.material !== 'boolean'
    || typeof value.disagreement.adjudicated !== 'boolean' || !Array.isArray(value.disagreement.disputedFields)) {
    return { review: null, rejectionReason: 'invalid_payload' };
  }
  const disputedFields = value.disagreement.disputedFields.flatMap((field) => isRecord(field) && typeof field.field === 'string' && typeof field.resolution === 'string' ? [{ field: field.field, resolution: field.resolution }] : []);
  if (disputedFields.length !== value.disagreement.disputedFields.length
    || !isRecord(value.provenance) || typeof value.provenance.diversityAchieved !== 'boolean'
    || typeof value.provenance.blindingApplied !== 'boolean') {
    return { review: null, rejectionReason: 'invalid_payload' };
  }
  const reviewers: ReviewerRuntimeReference[] = [];
  const add = (entry: unknown, role: ReviewerRuntimeReference['role']): boolean => {
    const reviewer = coerceReviewer(entry, role);
    if (!reviewer) return false;
    reviewers.push(reviewer);
    return true;
  };
  if (!Array.isArray(value.proposals) || !value.proposals.every((entry) => add(entry, 'proposal'))
    || !add(value.consolidation, 'consolidation')
    || !Array.isArray(value.components) || !value.components.every((entry) => add(entry, 'component'))
    || (value.adjudication !== undefined && !add(value.adjudication, 'adjudication'))) {
    return { review: null, rejectionReason: 'invalid_payload' };
  }
  const humanCheckStatus = isRecord(value.humanCheck) && isRecord(value.humanCheck.response) && typeof value.humanCheck.response.status === 'string'
    ? value.humanCheck.response.status : null;
  return {
    review: {
      schemaVersion: Math.trunc(value.schemaVersion), kind: 'production', reviewId, sessionId,
      sessionPathAtReview, identityFallback: value.identityFallback === true,
      rubricVersion: SESSION_REVIEW_V2_RUBRIC_VERSION, indexVersion: SESSION_REVIEW_V2_INDEX_VERSION, reviewedAt,
      ledger: ledger as ClassifiedCriterion[], process, evidence, humanCheckStatus,
      confidence: value.confidence,
      disagreement: { material: value.disagreement.material, adjudicated: value.disagreement.adjudicated, disputedFields },
      reviewers, diversityAchieved: value.provenance.diversityAchieved, blindingApplied: value.provenance.blindingApplied,
    },
    rejectionReason: null,
  };
}

/** Analytics coercion for canonical production records. Calibration and malformed records are excluded. */
export function coerceSessionReviewV2(value: unknown): SessionReviewV2Source | null {
  return inspectSessionReviewV2(value).review;
}

function externallyBlocked(criterion: ClassifiedCriterion): boolean {
  return criterion.status === 'blocked' && criterion.reason === 'external_blocker';
}
function points(criteria: ClassifiedCriterion[]): number {
  return criteria.reduce((sum, criterion) => sum + (criterion.status === 'met' ? 1 : criterion.status === 'partly_met' ? 0.5 : 0), 0);
}
export function summarizeCriterionAttainment(ledger: ClassifiedCriterion[], importance: CriterionImportance): CriterionAttainmentSummary {
  const all = ledger.filter((criterion) => criterion.importance === importance);
  const active = all.filter((criterion) => criterion.status !== 'superseded');
  const assessable = active.filter((criterion) => criterion.status !== 'not_assessable');
  const controllable = assessable.filter((criterion) => !externallyBlocked(criterion));
  return {
    total: active.length, assessable: assessable.length, controllableDenominator: controllable.length,
    met: active.filter((criterion) => criterion.status === 'met').length,
    partlyMet: active.filter((criterion) => criterion.status === 'partly_met').length,
    unmet: active.filter((criterion) => criterion.status === 'unmet').length,
    blocked: active.filter((criterion) => criterion.status === 'blocked').length,
    externalBlocked: active.filter(externallyBlocked).length,
    notAssessable: active.filter((criterion) => criterion.status === 'not_assessable').length,
    superseded: all.filter((criterion) => criterion.status === 'superseded').length,
    deliveredRate: assessable.length ? points(assessable) / assessable.length : 0,
    controllableRate: controllable.length ? points(controllable) / controllable.length : 0,
  };
}

export function deriveOverallAttainment(ledger: ClassifiedCriterion[], view: 'delivered' | 'controllable'): OverallAttainment {
  const active = ledger.filter((criterion) => criterion.status !== 'superseded' && (view === 'delivered' || !externallyBlocked(criterion)));
  const core = active.filter((criterion) => criterion.importance === 'core');
  const supporting = active.filter((criterion) => criterion.importance === 'supporting' && criterion.status !== 'not_assessable');
  if (!core.length || core.every((criterion) => criterion.status === 'not_assessable')) return 'not_assessable';
  const someCoreValue = core.some((criterion) => criterion.status === 'met' || criterion.status === 'partly_met');
  const allCoreMet = core.every((criterion) => criterion.status === 'met');
  if (someCoreValue && allCoreMet && supporting.every((criterion) => criterion.status === 'met')) return 'achieved';
  if (allCoreMet && supporting.some((criterion) => criterion.status === 'partly_met' || criterion.status === 'unmet' || criterion.status === 'blocked')) return 'mostly_achieved';
  if (someCoreValue && !allCoreMet) return 'partly_achieved';
  if (!someCoreValue && core.some((criterion) => criterion.status === 'unmet' || criterion.status === 'blocked')) return 'not_achieved';
  return 'not_assessable';
}

export function deriveQualityIndexV1(ledger: ClassifiedCriterion[], overall: OverallAttainment): number | null {
  if (overall === 'not_assessable') return null;
  const bands = { not_achieved: [0, 24, 24], partly_achieved: [25, 59, 34], mostly_achieved: [60, 84, 24], achieved: [85, 100, 15] } as const;
  const weights: Record<CriterionImportance, number> = { core: 1, supporting: 0.5, optional: 0.25 };
  const controllable = ledger.filter((criterion) => criterion.status !== 'superseded' && criterion.status !== 'not_assessable' && !externallyBlocked(criterion));
  const denominator = controllable.reduce((sum, criterion) => sum + weights[criterion.importance], 0);
  const numerator = controllable.reduce((sum, criterion) => sum + weights[criterion.importance] * (criterion.status === 'met' ? 1 : criterion.status === 'partly_met' ? 0.5 : 0), 0);
  const [floor, ceiling, width] = bands[overall];
  const value = Math.round((floor + width * (denominator ? numerator / denominator : 0)) * 10) / 10;
  return Math.min(ceiling, Math.max(floor, value));
}

export function deriveReviewAttainment(ledger: ClassifiedCriterion[]) {
  const deliveredOverall = deriveOverallAttainment(ledger, 'delivered');
  const controllableOverall = deriveOverallAttainment(ledger, 'controllable');
  return {
    deliveredOverall, controllableOverall,
    core: summarizeCriterionAttainment(ledger, 'core'),
    supporting: summarizeCriterionAttainment(ledger, 'supporting'),
    optional: summarizeCriterionAttainment(ledger, 'optional'),
    qualityIndexV1: deriveQualityIndexV1(ledger, controllableOverall),
  };
}
