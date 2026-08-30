import { isDeepStrictEqual } from 'node:util';

import { deriveAttainment } from './attainment.js';
import { deriveCanonicalFromComponents, resolutionString } from './canonical.js';
import { materialDisagreementFields } from './disagreement.js';
import { hashCanonicalJson, hashJson } from './hash.js';
import type {
  ClassifiedCriterion, CriterionDefinition, CriterionReason, CriterionStatus, ReviewEvidenceVector,
  ReviewerAssessment, ReviewerRuntime, SessionReviewV2,
} from './types.js';

const values = <T extends string>(...items: T[]) => new Set<T>(items);
const origins = values('explicit', 'necessary_implied');
const importances = values('core', 'supporting', 'optional');
const statuses = values<CriterionStatus>('met', 'partly_met', 'unmet', 'blocked', 'not_assessable', 'superseded');
const reasons = values<CriterionReason>('none', 'omitted', 'attempt_failed', 'incorrect_result', 'regression', 'external_blocker', 'user_dependency', 'human_evidence_missing', 'insufficient_artifact_evidence', 'unknown');
const activities = values('implement', 'debug', 'investigate', 'explain', 'design', 'operate', 'verify', 'other');
const surfaces = values('ui', 'application_logic', 'api_integration', 'data', 'tests', 'documentation', 'configuration', 'infrastructure', 'developer_tooling', 'agent_harness', 'external_system', 'communication', 'other');
const evidenceModes = values('static_inspection', 'automated_check', 'runtime_observation', 'human_observation', 'external_confirmation', 'reasoning_or_sources', 'other');
const overallValues = values('achieved', 'mostly_achieved', 'partly_achieved', 'not_achieved', 'not_assessable');
const confidenceValues = values('high', 'medium', 'low');
const hex64 = /^[a-f0-9]{64}$/;

function fail(message: string): never { throw new Error(`Invalid SessionReviewV2: ${message}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value;
}
function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail(`${path} must be an array of strings`);
  return value as string[];
}
function member<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) fail(`${path} has an unsupported value`);
  return value as T;
}
function hash(value: unknown, path: string): string {
  const result = string(value, path);
  if (!hex64.test(result)) fail(`${path} must be a lowercase SHA-256 hex digest`);
  return result;
}
function date(value: unknown, path: string): void {
  if (!Number.isFinite(Date.parse(string(value, path)))) fail(`${path} must be an ISO-compatible date`);
}
function unique(items: string[], path: string): void {
  if (new Set(items).size !== items.length) fail(`${path} must contain unique IDs`);
}
function rejectObsolete(value: Record<string, unknown>, path: string, fields: string[]): void {
  for (const field of fields) if (field in value) fail(`${path}.${field} is not part of the simplified V2 schema`);
}

const allowedReasons: Record<CriterionStatus, Set<CriterionReason>> = {
  met: values('none'),
  partly_met: values('omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown'),
  unmet: values('omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown'),
  blocked: values('external_blocker', 'user_dependency', 'unknown'),
  not_assessable: values('human_evidence_missing', 'insufficient_artifact_evidence', 'unknown'),
  superseded: values('none'),
};
export function validateCriterionStatusReason(statusValue: unknown, reasonValue: unknown, path = 'criterion'): void {
  const status = member(statusValue, statuses, `${path}.status`);
  const reason = member(reasonValue, reasons, `${path}.reason`);
  if (!allowedReasons[status].has(reason)) fail(`${path} has invalid status/reason pair ${status}/${reason}`);
}
function definition(value: unknown, path: string, frozen = false): CriterionDefinition {
  const v = object(value, path);
  const criterionId = string(v.criterionId, `${path}.criterionId`);
  string(v.statement, `${path}.statement`); member(v.origin, origins, `${path}.origin`); member(v.importance, importances, `${path}.importance`);
  const taxonomy = object(v.taxonomy, `${path}.taxonomy`);
  member(taxonomy.activity, activities, `${path}.taxonomy.activity`);
  const surface = stringArray(taxonomy.surface, `${path}.taxonomy.surface`);
  const mode = stringArray(taxonomy.evidenceMode, `${path}.taxonomy.evidenceMode`);
  if (!surface.length || surface.some((item) => !surfaces.has(item as never))) fail(`${path}.taxonomy.surface is invalid or empty`);
  if (!mode.length || mode.some((item) => !evidenceModes.has(item as never))) fail(`${path}.taxonomy.evidenceMode is invalid or empty`);
  if (frozen && ['status', 'reason', 'evidenceRefs', 'findingRefs'].some((key) => key in v)) fail(`${path} must be an unclassified definition`);
  return { ...v, criterionId } as CriterionDefinition;
}
function classified(value: unknown, path: string): ClassifiedCriterion {
  const v = object(value, path);
  rejectObsolete(v, path, ['findingRefs']);
  const result = definition(v, path) as ClassifiedCriterion;
  validateCriterionStatusReason(v.status, v.reason, path);
  stringArray(v.evidenceRefs, `${path}.evidenceRefs`);
  return result;
}
function processVector(value: unknown, path: string): void {
  const v = object(value, path);
  member(v.requirementDiscipline, values('proportionate', 'underclarified', 'overclarified', 'not_assessable'), `${path}.requirementDiscipline`);
  member(v.verificationDiscipline, values('proportionate', 'underverified', 'oververified', 'not_applicable', 'not_assessable'), `${path}.verificationDiscipline`);
  member(v.scopeControl, values('controlled', 'minor_avoidable_drift', 'material_scope_drift', 'not_assessable'), `${path}.scopeControl`);
  member(v.recovery, values('effective', 'partly_effective', 'ineffective', 'not_needed', 'not_assessable'), `${path}.recovery`);
  member(v.finalClaimAccuracy, values('accurate', 'overclaimed', 'underclaimed', 'unclear', 'no_final_claim'), `${path}.finalClaimAccuracy`);
}
function evidenceVector(value: unknown, path: string): ReviewEvidenceVector {
  const v = object(value, path);
  member(v.requirements, values('clear', 'partly_clear', 'unclear'), `${path}.requirements`);
  member(v.artifacts, values('direct', 'partial', 'none', 'not_applicable'), `${path}.artifacts`);
  member(v.execution, values('direct', 'partial', 'reported_only', 'none', 'not_applicable'), `${path}.execution`);
  member(v.human, values('not_needed', 'supports', 'contradicts', 'inconclusive', 'unanswered', 'unavailable'), `${path}.human`);
  stringArray(v.limitations, `${path}.limitations`);
  return v as unknown as ReviewEvidenceVector;
}
function runtime(value: unknown, path: string, requiredBucket?: 'small' | 'medium'): ReviewerRuntime {
  const v = object(value, path);
  string(v.reviewerId, `${path}.reviewerId`); string(v.toolCallId, `${path}.toolCallId`);
  const requestedBucket = member(v.requestedBucket, requiredBucket ? values(requiredBucket) : values('small', 'medium'), `${path}.requestedBucket`);
  const bucket = member(v.bucket, values('small', 'medium', 'frontier'), `${path}.bucket`);
  if (bucket === 'frontier' || (requestedBucket === 'small' && bucket !== 'small')) fail(`${path}.bucket is not a valid downgrade from ${requestedBucket}`);
  if (typeof v.bucketDowngraded !== 'boolean' || v.bucketDowngraded !== (bucket !== requestedBucket)) fail(`${path}.bucketDowngraded does not match requested/effective bucket`);
  for (const key of ['modelId', 'provider', 'family', 'promptHash', 'rubricVersion'] as const) string(v[key], `${path}.${key}`);
  if (v.rubricVersion !== 'session-review-v2.1') fail(`${path}.rubricVersion must be session-review-v2.1`);
  if (v.thinkingLevel !== null && typeof v.thinkingLevel !== 'string') fail(`${path}.thinkingLevel must be string or null`);
  return v as unknown as ReviewerRuntime;
}
function reviewProfile(runtimes: readonly ReviewerRuntime[], path: string): 'small' | 'medium' {
  const buckets = runtimes.map((runtime) => runtime.requestedBucket).sort();
  if (isDeepStrictEqual(buckets, ['small', 'small'])) return 'small';
  if (isDeepStrictEqual(buckets, ['medium', 'small'])) return 'medium';
  fail(`${path} must use either a small+small or small+medium reviewer profile`);
}
function coordinatorRuntime(value: unknown, path: string, requiredBucket: 'small' | 'medium'): ReviewerRuntime {
  // Mixed profiles request medium, which selector policy may downgrade to small.
  // A requested small role is already constrained by runtime() to effective small.
  return runtime(value, path, requiredBucket);
}
function humanQuestionCandidate(value: unknown, path: string): void {
  const v = object(value, path);
  string(v.criterionId, `${path}.criterionId`); string(v.domain, `${path}.domain`); string(v.expectedObservation, `${path}.expectedObservation`); string(v.proposedQuestion, `${path}.proposedQuestion`);
  if (!stringArray(v.options, `${path}.options`).length) fail(`${path}.options must not be empty`);
}
function validateClassifiesFrozen(criteria: ClassifiedCriterion[], frozen: CriterionDefinition[], path: string): void {
  unique(criteria.map((c) => c.criterionId), path);
  if (criteria.length !== frozen.length) fail(`${path} must classify every frozen criterion exactly once`);
  const map = new Map(criteria.map((c) => [c.criterionId, c]));
  for (const expected of frozen) {
    const actual = map.get(expected.criterionId);
    if (!actual || !isDeepStrictEqual(stripClassification(actual), expected)) fail(`${path} definition mismatch for ${expected.criterionId}`);
  }
}
function stripClassification(c: ClassifiedCriterion): CriterionDefinition {
  const { status: _status, reason: _reason, evidenceRefs: _evidenceRefs, ...definitionOnly } = c;
  return definitionOnly;
}
function validateAssessment(value: unknown, path: string, frozen: CriterionDefinition[]): ReviewerAssessment {
  runtime(value, path);
  const v = object(value, path);
  string(v.assessmentId, `${path}.assessmentId`); date(v.assessedAt, `${path}.assessedAt`);
  const classifications = object(v.classifications, `${path}.classifications`);
  rejectObsolete(classifications, `${path}.classifications`, ['findings', 'proposedAmendments']);
  if (!Array.isArray(classifications.criteria)) fail(`${path}.classifications.criteria must be an array`);
  const criteria = classifications.criteria.map((item, i) => classified(item, `${path}.classifications.criteria[${i}]`));
  validateClassifiesFrozen(criteria, frozen, `${path}.classifications.criteria`);
  processVector(classifications.process, `${path}.classifications.process`);
  evidenceVector(classifications.evidence, `${path}.classifications.evidence`);
  member(classifications.confidence, confidenceValues, `${path}.classifications.confidence`);
  if (classifications.proposedOverall !== undefined) member(classifications.proposedOverall, overallValues, `${path}.classifications.proposedOverall`);
  return v as unknown as ReviewerAssessment;
}
function componentFieldValue(component: ReviewerAssessment, field: string): unknown {
  const criterion = /^criterion:(.+)\.(status|reason|evidenceRefs)$/.exec(field);
  if (criterion) return (component.classifications.criteria.find((item) => item.criterionId === criterion[1]) as unknown as Record<string, unknown> | undefined)?.[criterion[2]!];
  if (field.startsWith('process.')) return (component.classifications.process as unknown as Record<string, unknown>)[field.slice('process.'.length)];
  if (field.startsWith('evidence.')) return (component.classifications.evidence as unknown as Record<string, unknown>)[field.slice('evidence.'.length)];
  if (field === 'confidence') return component.classifications.confidence;
  return undefined;
}
function validateManifest(value: unknown, path: string): void {
  const v = object(value, path);
  hash(v.rawJsonlSha256, `${path}.rawJsonlSha256`);
  if (!Number.isInteger(v.rawJsonlBytes) || (v.rawJsonlBytes as number) < 0) fail(`${path}.rawJsonlBytes must be non-negative integer`);
  date(v.rawJsonlMtime, `${path}.rawJsonlMtime`); hash(v.transcriptExcerptSha256, `${path}.transcriptExcerptSha256`);
  if (!Array.isArray(v.artifacts)) fail(`${path}.artifacts must be an array`);
  v.artifacts.forEach((item, i) => {
    const artifact = object(item, `${path}.artifacts[${i}]`);
    string(artifact.path, `${path}.artifacts[${i}].path`); hash(artifact.sha256, `${path}.artifacts[${i}].sha256`); hash(artifact.excerptSha256, `${path}.artifacts[${i}].excerptSha256`);
    if (!Number.isInteger(artifact.bytes) || (artifact.bytes as number) < 0) fail(`${path}.artifacts[${i}].bytes is invalid`);
    if (!Number.isInteger(artifact.excerptBytes) || (artifact.excerptBytes as number) < 0 || (artifact.excerptBytes as number) > 8 * 1024) fail(`${path}.artifacts[${i}].excerptBytes is invalid`);
    if (typeof artifact.excerptTruncated !== 'boolean') fail(`${path}.artifacts[${i}].excerptTruncated must be boolean`);
    member(artifact.kind, values('diff', 'file', 'generated', 'untracked'), `${path}.artifacts[${i}].kind`);
  });
  if (v.artifacts.length > 20) fail(`${path}.artifacts exceeds the 20-item evidence limit`);
  if ((v.artifacts as Array<Record<string, unknown>>).reduce((total, artifact) => total + (artifact.excerptBytes as number), 0) > 32 * 1024) fail(`${path}.artifacts exceeds the total excerpt byte limit`);
  stringArray(v.limitations, `${path}.limitations`);
  const blinding = object(v.blinding, `${path}.blinding`);
  const stripped = stringArray(blinding.stripped, `${path}.blinding.stripped`);
  stringArray(blinding.redactedTurnFields, `${path}.blinding.redactedTurnFields`); stringArray(blinding.notes, `${path}.blinding.notes`);
  for (const key of ['modelId', 'provider', 'thinkingLevel', 'family']) if (!stripped.includes(key)) fail(`${path}.blinding.stripped must include ${key}`);
}

/** Phase-boundary validators used by the compaction-safe recovery path. They
 * share the canonical record validator's exact enums and definition matching,
 * so an invalid reviewer response is rejected before the next role runs. */
export function validateCriterionDefinitions(value: unknown, path = 'criteria'): CriterionDefinition[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  const result = value.map((item, index) => definition(item, `${path}[${index}]`, true));
  unique(result.map((criterion) => criterion.criterionId), path);
  return result;
}
export function validateClassifiedCriteria(value: unknown, frozen: CriterionDefinition[], path = 'criteria'): ClassifiedCriterion[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  const result = value.map((item, index) => classified(item, `${path}[${index}]`));
  validateClassifiesFrozen(result, frozen, path);
  return result;
}
export function validateReviewProcessVector(value: unknown, path = 'process'): void { processVector(value, path); }
export function validateReviewEvidenceVector(value: unknown, path = 'evidence'): ReviewEvidenceVector { return evidenceVector(value, path); }
export function validateReviewConfidence(value: unknown, path = 'confidence'): void { member(value, confidenceValues, path); }
export function validateReviewHumanQuestionCandidate(value: unknown, path = 'candidateHumanQuestion'): void { humanQuestionCandidate(value, path); }

/** Throws with a precise invariant failure and returns the narrowed record. */
export function validateSessionReviewV2(value: unknown): SessionReviewV2 {
  const v = object(value, 'review');
  rejectObsolete(v, 'review', ['amendments', 'findings', 'reviewerChecks', 'reviewerChecksSha256']);
  if (v.schemaVersion !== 2) fail('schemaVersion must be 2'); member(v.kind, values('production', 'calibration'), 'review.kind');
  for (const key of ['reviewId', 'sessionId', 'sessionPathAtReview', 'rubricVersion'] as const) string(v[key], `review.${key}`);
  if (v.rubricVersion !== 'session-review-v2.1') fail('rubricVersion must be session-review-v2.1'); date(v.reviewedAt, 'review.reviewedAt');
  if (v.identityFallback !== undefined && typeof v.identityFallback !== 'boolean') fail('identityFallback must be boolean');
  if (v.indexVersion !== 'v1') fail('indexVersion must be v1');
  if (!Array.isArray(v.frozenLedger)) fail('frozenLedger must be an array');
  const frozen = v.frozenLedger.map((item, i) => definition(item, `review.frozenLedger[${i}]`, true));
  unique(frozen.map((c) => c.criterionId), 'review.frozenLedger');
  const frozenHash = hash(v.frozenLedgerSha256, 'review.frozenLedgerSha256');
  // New records use key-order-independent canonical JSON. Continue accepting
  // legacy records hashed from their original JSON.stringify insertion order.
  if (frozenHash !== hashCanonicalJson(v.frozenLedger) && frozenHash !== hashJson(v.frozenLedger)) fail('frozenLedgerSha256 does not match frozenLedger');
  if (!Array.isArray(v.ledger)) fail('ledger must be an array');
  const ledger = v.ledger.map((item, i) => classified(item, `review.ledger[${i}]`));
  validateClassifiesFrozen(ledger, frozen, 'review.ledger');

  if (!Array.isArray(v.proposals) || v.proposals.length !== 2) fail('proposals must contain exactly two records');
  for (const [i, item] of v.proposals.entries()) {
    runtime(item, `review.proposals[${i}]`); const proposal = object(item, `review.proposals[${i}]`);
    rejectObsolete(proposal, `review.proposals[${i}]`, ['findings', 'candidateChecks']);
    string(proposal.proposalId, `review.proposals[${i}].proposalId`); date(proposal.proposedAt, `review.proposals[${i}].proposedAt`);
    if (!Array.isArray(proposal.criteria)) fail(`review.proposals[${i}].criteria must be an array`);
    proposal.criteria.forEach((c, j) => definition(c, `review.proposals[${i}].criteria[${j}]`, true));
    if (proposal.candidateHumanQuestion !== undefined) humanQuestionCandidate(proposal.candidateHumanQuestion, `review.proposals[${i}].candidateHumanQuestion`);
    if (proposal.rubricVersion !== v.rubricVersion) fail(`review.proposals[${i}].rubricVersion mismatch`);
  }
  const proposalIds = (v.proposals as unknown as { proposalId: string }[]).map((p) => p.proposalId);
  unique(proposalIds, 'review.proposals');
  const coordinatorBucket = reviewProfile(v.proposals as unknown as ReviewerRuntime[], 'proposals');
  coordinatorRuntime(v.consolidation, 'review.consolidation', coordinatorBucket);
  const consolidation = object(v.consolidation, 'review.consolidation');
  string(consolidation.consolidationId, 'review.consolidation.consolidationId'); date(consolidation.consolidatedAt, 'review.consolidation.consolidatedAt');
  if (consolidation.rubricVersion !== v.rubricVersion) fail('review.consolidation.rubricVersion mismatch');
  if (consolidation.selectedHumanQuestion !== undefined) humanQuestionCandidate(consolidation.selectedHumanQuestion, 'review.consolidation.selectedHumanQuestion');
  if (consolidation.frozenLedger !== undefined || consolidation.frozenLedgerSha256 !== undefined) {
    if (!Array.isArray(consolidation.frozenLedger)) fail('review.consolidation.frozenLedger must be an array when supplied');
    hash(consolidation.frozenLedgerSha256, 'review.consolidation.frozenLedgerSha256');
    if (!isDeepStrictEqual(consolidation.frozenLedger, v.frozenLedger) || consolidation.frozenLedgerSha256 !== frozenHash) fail('consolidation frozen ledger/hash must exactly match canonical frozen ledger/hash');
  }
  const consolidationProvenance = object(consolidation.provenance, 'review.consolidation.provenance');
  if (!Array.isArray(consolidationProvenance.fromProposals) || consolidationProvenance.fromProposals.length !== 2) fail('consolidation provenance must reference two proposals');
  stringArray(consolidationProvenance.dedupNotes, 'review.consolidation.provenance.dedupNotes');
  if (!isDeepStrictEqual([...consolidationProvenance.fromProposals as string[]].sort(), [...proposalIds].sort())) fail('consolidation proposal references do not match');

  if (!Array.isArray(v.components) || v.components.length !== 2) fail('components must contain exactly two records');
  const components = v.components.map((item, i) => validateAssessment(item, `review.components[${i}]`, frozen));
  const componentAssessmentIds = components.map((component) => component.assessmentId);
  unique(componentAssessmentIds, 'review.components');
  if (reviewProfile(components, 'components') !== coordinatorBucket) fail('components must use the same reviewer profile as proposals');
  if (components.some((component) => component.rubricVersion !== v.rubricVersion)) fail('component rubricVersion mismatch');

  processVector(v.process, 'review.process'); evidenceVector(v.evidence, 'review.evidence'); member(v.confidence, confidenceValues, 'review.confidence');
  const disagreement = object(v.disagreement, 'review.disagreement');
  if (typeof disagreement.material !== 'boolean' || typeof disagreement.adjudicated !== 'boolean' || !Array.isArray(disagreement.disputedFields)) fail('disagreement shape is invalid');
  const computedMaterial = materialDisagreementFields(components[0]!, components[1]!);
  if (disagreement.material !== (computedMaterial.length > 0)) fail('disagreement.material does not match component assessments');
  const recordedFieldRecords = new Map<string, Record<string, unknown>>();
  for (const [i, item] of (disagreement.disputedFields as Array<Record<string, unknown>>).entries()) {
    const field = object(item, `review.disagreement.disputedFields[${i}]`); const name = string(field.field, `review.disagreement.disputedFields[${i}].field`);
    if (recordedFieldRecords.has(name)) fail(`duplicate disputed field ${name}`);
    for (const key of ['firstValue', 'secondValue', 'resolvedValue'] as const) string(field[key], `review.disagreement.disputedFields[${i}].${key}`);
    member(field.resolution, values('adjudicator', 'deterministic_merge'), `review.disagreement.disputedFields[${i}].resolution`);
    recordedFieldRecords.set(name, field);
  }
  for (const field of computedMaterial) {
    const recorded = recordedFieldRecords.get(field);
    if (!recorded) fail(`material disputed field ${field} is not recorded`);
    if (recorded.resolution !== 'adjudicator') fail(`material disputed field ${field} must be resolved by the adjudicator`);
  }
  if (disagreement.material !== !!v.adjudication || disagreement.adjudicated !== !!v.adjudication) fail('material disagreement must have exactly one adjudication');
  if (v.adjudication) {
    coordinatorRuntime(v.adjudication, 'review.adjudication', coordinatorBucket);
    const adjudication = object(v.adjudication, 'review.adjudication'); rejectObsolete(adjudication, 'review.adjudication', ['amendmentIds']);
    string(adjudication.adjudicationId, 'review.adjudication.adjudicationId'); date(adjudication.assessedAt, 'review.adjudication.assessedAt');
    if (adjudication.rubricVersion !== v.rubricVersion) fail('review.adjudication.rubricVersion mismatch');
    if (!Array.isArray(adjudication.resolvedFields)) fail('review.adjudication.resolvedFields must be an array');
    const resolvedFieldNames = new Set<string>();
    adjudication.resolvedFields.forEach((item, i) => {
      const resolved = object(item, `review.adjudication.resolvedFields[${i}]`);
      const name = string(resolved.field, `review.adjudication.resolvedFields[${i}].field`);
      if (resolvedFieldNames.has(name)) fail(`duplicate adjudicated field ${name}`);
      resolvedFieldNames.add(name);
      string(resolved.value, `review.adjudication.resolvedFields[${i}].value`);
      string(resolved.rationale, `review.adjudication.resolvedFields[${i}].rationale`); stringArray(resolved.evidenceRefs, `review.adjudication.resolvedFields[${i}].evidenceRefs`);
    });
    const expectedResolvedFields = new Set(computedMaterial.flatMap((field) => {
      const criterionStatus = /^criterion:(.+)\.status$/.exec(field);
      return criterionStatus ? [field, `criterion:${criterionStatus[1]}.reason`] : [field];
    }));
    if (resolvedFieldNames.size !== expectedResolvedFields.size || [...expectedResolvedFields].some((field) => !resolvedFieldNames.has(field))) {
      fail('adjudication resolvedFields must exactly match computed material fields');
    }
    if (adjudication.canonicalOverall !== undefined) {
      const canonicalOverall = object(adjudication.canonicalOverall, 'review.adjudication.canonicalOverall');
      member(canonicalOverall.deliveredOverall, overallValues, 'review.adjudication.canonicalOverall.deliveredOverall'); member(canonicalOverall.controllableOverall, overallValues, 'review.adjudication.canonicalOverall.controllableOverall');
    }
  }

  let canonical;
  try { canonical = deriveCanonicalFromComponents(components as [ReviewerAssessment, ReviewerAssessment], v.adjudication as never); }
  catch (error) { fail((error as Error).message); }
  if (!isDeepStrictEqual(v.ledger, canonical.ledger)) fail('canonical ledger is not derived from component agreement, deterministic merge, or adjudication');
  if (!isDeepStrictEqual(v.process, canonical.process)) fail('canonical process is not derived from component agreement, deterministic merge, or adjudication');
  if (!isDeepStrictEqual(v.evidence, canonical.evidence)) fail('canonical evidence is not derived from component agreement, deterministic merge, or adjudication');
  if (v.confidence !== canonical.confidence) fail('canonical confidence is not derived from component agreement or deterministic merge');
  const [firstComponent, secondComponent] = components;
  for (const [field, expected] of canonical.differingFields) {
    const recorded = recordedFieldRecords.get(field);
    if (!recorded) fail(`disputed field ${field} is not recorded`);
    const firstValue = componentFieldValue(firstComponent, field); const secondValue = componentFieldValue(secondComponent, field);
    if (recorded.resolution !== expected.resolution || recorded.resolvedValue !== resolutionString(expected.value) || recorded.firstValue !== resolutionString(firstValue) || recorded.secondValue !== resolutionString(secondValue)) fail(`disputed field ${field} does not match its component values/canonical resolution`);
  }
  const allowedDisputedFields = new Set<string>([...computedMaterial, ...canonical.differingFields.keys()]);
  for (const name of recordedFieldRecords.keys()) if (!allowedDisputedFields.has(name)) fail(`spurious disputed field ${name} is not a material or deterministically differing field`);

  const attainment = object(v.attainment, 'review.attainment'); const derivedAttainment = deriveAttainment(ledger);
  if (!isDeepStrictEqual(attainment, derivedAttainment)) fail('attainment does not match deterministic derivation');
  if (v.adjudication && (v.adjudication as unknown as Record<string, unknown>).canonicalOverall !== undefined && !isDeepStrictEqual((v.adjudication as unknown as Record<string, unknown>).canonicalOverall, { deliveredOverall: derivedAttainment.deliveredOverall, controllableOverall: derivedAttainment.controllableOverall })) fail('adjudication canonicalOverall does not match deterministic derivation');

  const provenance = object(v.provenance, 'review.provenance');
  string(provenance.orchestratorSessionId, 'review.provenance.orchestratorSessionId');
  if (provenance.hostVersion !== null && (typeof provenance.hostVersion !== 'string' || !provenance.hostVersion.trim())) fail('review.provenance.hostVersion must be null or a non-empty version string');
  if (provenance.rubricVersion !== v.rubricVersion) fail('provenance rubricVersion mismatch'); if (provenance.indexVersion !== v.indexVersion) fail('provenance indexVersion mismatch');
  if (provenance.blindingApplied !== true) fail('provenance.blindingApplied must be true'); validateManifest(provenance.evidenceManifest, 'review.provenance.evidenceManifest');
  const diversity = components[0]!.family !== components[1]!.family || components[0]!.provider !== components[1]!.provider;
  if (provenance.diversityAchieved !== diversity) fail('provenance.diversityAchieved does not match effective reviewers');
  const pipeline = object(provenance.pipeline, 'review.provenance.pipeline');
  rejectObsolete(pipeline, 'review.provenance.pipeline', ['reviewerChecksSha256', 'amendmentIds']);
  if (pipeline.frozenLedgerSha256 !== frozenHash) fail('pipeline frozen ledger hash does not match');
  if (!isDeepStrictEqual(pipeline.proposalIds, proposalIds) || pipeline.consolidationId !== consolidation.consolidationId || !isDeepStrictEqual(pipeline.componentAssessmentIds, componentAssessmentIds)) fail('pipeline artifact IDs do not match stored artifacts');
  const adjudicationId = v.adjudication ? (v.adjudication as unknown as { adjudicationId: string }).adjudicationId : undefined;
  if (pipeline.adjudicationId !== adjudicationId) fail('pipeline adjudication ID mismatch');
  if (v.adjudication) {
    const adjudicator = v.adjudication as unknown as { reviewerId: string };
    if (provenance.adjudicatorReviewerId !== adjudicator.reviewerId) fail('adjudicator reviewer provenance mismatch');
  } else if (provenance.adjudicatorReviewerId !== undefined) fail('adjudicatorReviewerId requires adjudication');

  if (v.humanCheck !== undefined) {
    const human = object(v.humanCheck, 'review.humanCheck'); string(human.toolCallId, 'review.humanCheck.toolCallId'); string(human.interpretation, 'review.humanCheck.interpretation');
    const input = object(human.input, 'review.humanCheck.input'); string(input.question, 'review.humanCheck.input.question');
    if (!stringArray(input.options, 'review.humanCheck.input.options').length) fail('review.humanCheck.input.options must not be empty');
    const meta = object(input.reviewMeta, 'review.humanCheck.input.reviewMeta');
    if (meta.purpose !== 'review_human_verification' || meta.targetSessionId !== v.sessionId || meta.targetSessionPath !== v.sessionPathAtReview || !new Map(ledger.map((criterion) => [criterion.criterionId, criterion])).has(string(meta.criterionId, 'review.humanCheck.input.reviewMeta.criterionId'))) fail('humanCheck reviewMeta does not target this review/criterion');
    const response = object(human.response, 'review.humanCheck.response'); date(response.recordedAt, 'review.humanCheck.response.recordedAt');
    const source = member(response.source, values('option', 'custom', 'cancelled', 'unanswered'), 'review.humanCheck.response.source');
    if (source === 'option' || source === 'custom') {
      if (response.cancelled !== false) fail('answered humanCheck response cannot be cancelled'); string(response.answer, 'review.humanCheck.response.answer'); member(response.status, values('answered', 'inconclusive', 'unavailable'), 'review.humanCheck.response.status');
    } else {
      if ('answer' in response) fail('unanswered humanCheck response cannot carry an answer');
      if (source === 'cancelled' && (response.cancelled !== true || response.status !== 'unanswered')) fail('cancelled humanCheck response is inconsistent');
      if (source === 'unanswered' && (response.cancelled !== false || (response.status !== 'unanswered' && response.status !== 'unavailable'))) fail('unanswered humanCheck response is inconsistent');
    }
  }
  return v as unknown as SessionReviewV2;
}
