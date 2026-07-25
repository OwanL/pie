import { isDeepStrictEqual } from 'node:util';

import { deriveAttainment } from './attainment.js';
import { deriveCanonicalFromComponents, resolutionString } from './canonical.js';
import { checkSafety } from './check-safety.js';
import { materialDisagreementFields } from './disagreement.js';
import { hashJson } from './evidence.js';
import type {
  ClassifiedCriterion, CriterionDefinition, CriterionReason, CriterionStatus, ReviewEvidenceVector,
  ReviewFinding, ReviewerAssessment, ReviewerRuntime, SessionReviewV2,
} from './types.js';

const values = <T extends string>(...items: T[]) => new Set<T>(items);
const origins = values('explicit', 'necessary_implied');
const importances = values('core', 'supporting', 'optional');
const statuses = values<CriterionStatus>('met', 'partly_met', 'unmet', 'blocked', 'not_assessable', 'superseded');
const reasons = values<CriterionReason>('none', 'omitted', 'attempt_failed', 'incorrect_result', 'regression', 'external_blocker', 'user_dependency', 'human_evidence_missing', 'insufficient_artifact_evidence', 'unknown');
const activities = values('implement', 'debug', 'investigate', 'explain', 'design', 'operate', 'verify', 'other');
const surfaces = values('ui', 'application_logic', 'api_integration', 'data', 'tests', 'documentation', 'configuration', 'infrastructure', 'developer_tooling', 'agent_harness', 'external_system', 'communication', 'other');
const evidenceModes = values('static_inspection', 'automated_check', 'runtime_observation', 'human_observation', 'external_confirmation', 'reasoning_or_sources', 'other');
const findingSeverities = values('critical', 'major', 'minor', 'nit');
const findingCategories = values('correctness', 'regression', 'omission', 'scope_drift', 'verification_gap', 'security', 'performance', 'maintainability', 'attribution_error', 'other');
const overallValues = values('achieved', 'mostly_achieved', 'partly_achieved', 'not_achieved', 'not_assessable');
const confidenceValues = values('high', 'medium', 'low');
const downgradeRank: Partial<Record<CriterionStatus, number>> = { met: 2, partly_met: 1, unmet: 0 };
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
  const text = string(value, path);
  if (!Number.isFinite(Date.parse(text))) fail(`${path} must be an ISO-compatible date`);
}
function unique(items: string[], path: string): void {
  if (new Set(items).size !== items.length) fail(`${path} must contain unique IDs`);
}

const allowedReasons: Record<CriterionStatus, Set<CriterionReason>> = {
  met: values('none'),
  partly_met: values('omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown'),
  unmet: values('omitted', 'attempt_failed', 'incorrect_result', 'regression', 'unknown'),
  blocked: values('external_blocker', 'user_dependency', 'unknown'),
  not_assessable: values('human_evidence_missing', 'insufficient_artifact_evidence', 'unknown'),
  superseded: values('none'),
};

function definition(value: unknown, path: string, frozen = false): CriterionDefinition {
  const v = object(value, path);
  const criterionId = string(v.criterionId, `${path}.criterionId`);
  string(v.statement, `${path}.statement`);
  member(v.origin, origins, `${path}.origin`);
  member(v.importance, importances, `${path}.importance`);
  const taxonomy = object(v.taxonomy, `${path}.taxonomy`);
  member(taxonomy.activity, activities, `${path}.taxonomy.activity`);
  const surface = stringArray(taxonomy.surface, `${path}.taxonomy.surface`);
  const mode = stringArray(taxonomy.evidenceMode, `${path}.taxonomy.evidenceMode`);
  if (!surface.length || surface.some((item) => !surfaces.has(item as never))) fail(`${path}.taxonomy.surface is invalid or empty`);
  if (!mode.length || mode.some((item) => !evidenceModes.has(item as never))) fail(`${path}.taxonomy.evidenceMode is invalid or empty`);
  if (frozen && ['status', 'reason', 'evidenceRefs', 'findingRefs'].some((key) => key in v)) fail(`${path} must be an unclassified definition`);
  return value as CriterionDefinition;
}

function classified(value: unknown, path: string): ClassifiedCriterion {
  const result = definition(value, path) as ClassifiedCriterion;
  const v = value as unknown as Record<string, unknown>;
  const status = member(v.status, statuses, `${path}.status`);
  const reason = member(v.reason, reasons, `${path}.reason`);
  if (!allowedReasons[status].has(reason)) fail(`${path} has invalid status/reason pair ${status}/${reason}`);
  stringArray(v.evidenceRefs, `${path}.evidenceRefs`);
  stringArray(v.findingRefs, `${path}.findingRefs`);
  return result;
}

function finding(value: unknown, path: string, _canonical: boolean): ReviewFinding {
  const v = object(value, path);
  string(v.findingId, `${path}.findingId`);
  const severity = member(v.severity, findingSeverities, `${path}.severity`);
  member(v.category, findingCategories, `${path}.category`);
  string(v.statement, `${path}.statement`);
  stringArray(v.evidenceRefs, `${path}.evidenceRefs`);
  member(v.ledgerEffect, values('downgrade', 'add', 'none'), `${path}.ledgerEffect`);
  string(v.remediation, `${path}.remediation`);
  if (v.criterionId !== undefined) string(v.criterionId, `${path}.criterionId`);
  if ((severity === 'critical' || severity === 'major') && (typeof v.criterionId !== 'string' || v.ledgerEffect === 'none')) {
    fail(`${path} critical/major finding requires criterionId and ledger effect`);
  }
  if (v.ledgerEffect === 'none' && severity !== 'minor' && severity !== 'nit') fail(`${path} ledgerEffect none is only valid for minor/nit`);
  return value as ReviewFinding;
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
  return value as ReviewEvidenceVector;
}

function runtime(value: unknown, path: string, requested: 'reviewer' | 'medium'): ReviewerRuntime {
  const v = object(value, path);
  string(v.reviewerId, `${path}.reviewerId`);
  string(v.toolCallId, `${path}.toolCallId`);
  const requestedBucket = member(v.requestedBucket, requested === 'medium' ? values('medium') : values('small', 'medium'), `${path}.requestedBucket`);
  const bucket = member(v.bucket, values('small', 'medium', 'frontier'), `${path}.bucket`);
  if (bucket === 'frontier' || (requestedBucket === 'small' && bucket !== 'small')) fail(`${path}.bucket is not a valid downgrade from ${requestedBucket}`);
  if (typeof v.bucketDowngraded !== 'boolean' || v.bucketDowngraded !== (bucket !== requestedBucket)) fail(`${path}.bucketDowngraded does not match requested/effective bucket`);
  for (const key of ['modelId', 'provider', 'family', 'promptHash', 'rubricVersion'] as const) string(v[key], `${path}.${key}`);
  if (v.thinkingLevel !== null && typeof v.thinkingLevel !== 'string') fail(`${path}.thinkingLevel must be string or null`);
  return value as unknown as ReviewerRuntime;
}

function humanQuestionCandidate(value: unknown, path: string): void {
  const v = object(value, path);
  string(v.criterionId, `${path}.criterionId`); string(v.domain, `${path}.domain`);
  string(v.expectedObservation, `${path}.expectedObservation`); string(v.proposedQuestion, `${path}.proposedQuestion`);
  if (!stringArray(v.options, `${path}.options`).length) fail(`${path}.options must not be empty`);
}

function checkSpec(value: unknown, path: string): void {
  const v = object(value, path);
  string(v.checkId, `${path}.checkId`);
  if (v.criterionId !== undefined) string(v.criterionId, `${path}.criterionId`);
  const kind = member(v.kind, values('command', 'automated_check', 'static_inspection'), `${path}.kind`);
  if (kind === 'static_inspection') {
    string(v.target, `${path}.target`); string(v.query, `${path}.query`);
    if ('command' in v || 'cwd' in v) fail(`${path} static inspection cannot carry command/cwd`);
  } else {
    string(v.command, `${path}.command`); string(v.cwd, `${path}.cwd`);
    if ('target' in v || 'query' in v) fail(`${path} command check cannot carry target/query`);
  }
}

function validateAssessment(value: unknown, path: string, frozen: CriterionDefinition[]): ReviewerAssessment {
  runtime(value, path, 'reviewer');
  const v = value as unknown as Record<string, unknown>;
  string(v.assessmentId, `${path}.assessmentId`); date(v.assessedAt, `${path}.assessedAt`);
  const classifications = object(v.classifications, `${path}.classifications`);
  if (!Array.isArray(classifications.criteria)) fail(`${path}.classifications.criteria must be an array`);
  const criteria = classifications.criteria.map((item, i) => classified(item, `${path}.classifications.criteria[${i}]`));
  validateClassifiesFrozen(criteria, frozen, `${path}.classifications.criteria`);
  processVector(classifications.process, `${path}.classifications.process`);
  evidenceVector(classifications.evidence, `${path}.classifications.evidence`);
  if (!Array.isArray(classifications.findings)) fail(`${path}.classifications.findings must be an array`);
  const findings = classifications.findings.map((item, i) => finding(item, `${path}.classifications.findings[${i}]`, false));
  unique(findings.map((item) => item.findingId), `${path}.classifications.findings`);
  member(classifications.confidence, confidenceValues, `${path}.classifications.confidence`);
  member(classifications.proposedOverall, overallValues, `${path}.classifications.proposedOverall`);
  if (!Array.isArray(classifications.proposedAmendments)) fail(`${path}.classifications.proposedAmendments must be an array`);
  const amendmentRecords: Array<{ amendmentId: string; definition: CriterionDefinition; motivatingFindingId: string }> = [];
  for (const [i, item] of classifications.proposedAmendments.entries()) {
    const amendment = object(item, `${path}.classifications.proposedAmendments[${i}]`);
    const amendmentId = string(amendment.amendmentId, `${path}.classifications.proposedAmendments[${i}].amendmentId`);
    const proposedDefinition = definition(amendment.definition, `${path}.classifications.proposedAmendments[${i}].definition`, true);
    const motivatingFindingId = string(amendment.motivatingFindingId, `${path}.classifications.proposedAmendments[${i}].motivatingFindingId`);
    stringArray(amendment.evidenceRefs, `${path}.classifications.proposedAmendments[${i}].evidenceRefs`);
    if (proposedDefinition.origin !== 'necessary_implied' || frozen.some((item) => item.criterionId === proposedDefinition.criterionId)) fail(`${path}.classifications.proposedAmendments[${i}] must propose a new necessary-implied criterion`);
    amendmentRecords.push({ amendmentId, definition: proposedDefinition, motivatingFindingId });
  }
  unique(amendmentRecords.map((item) => item.amendmentId), `${path}.classifications.proposedAmendments`);
  const criteriaById = new Map(criteria.map((item) => [item.criterionId, item]));
  for (const reviewFinding of findings) {
    const proposals = amendmentRecords.filter((item) => item.motivatingFindingId === reviewFinding.findingId);
    if (reviewFinding.ledgerEffect === 'add') {
      if ((reviewFinding.severity !== 'critical' && reviewFinding.severity !== 'major') || proposals.length !== 1 || proposals[0]!.definition.criterionId !== reviewFinding.criterionId) fail(`${path} add finding ${reviewFinding.findingId} must have exactly one matching material amendment proposal`);
    } else if (proposals.length) fail(`${path} amendment proposal must be motivated by an add finding`);
    if ((reviewFinding.severity === 'critical' || reviewFinding.severity === 'major') && reviewFinding.ledgerEffect === 'downgrade') {
      const target = reviewFinding.criterionId ? criteriaById.get(reviewFinding.criterionId) : undefined;
      if (!target || target.status === 'met' || target.status === 'superseded') fail(`${path} material finding ${reviewFinding.findingId} must downgrade its classified criterion`);
      if (reviewFinding.severity === 'critical' && target.importance !== 'core') fail(`${path} critical finding ${reviewFinding.findingId} must affect a core criterion`);
      if (reviewFinding.severity === 'major' && target.importance === 'optional') fail(`${path} major finding ${reviewFinding.findingId} cannot affect only an optional criterion`);
    }
  }
  for (const amendment of amendmentRecords) if (!findings.some((item) => item.findingId === amendment.motivatingFindingId)) fail(`${path} amendment ${amendment.amendmentId} references an unknown finding`);
  return value as ReviewerAssessment;
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
  const { status: _status, reason: _reason, evidenceRefs: _evidenceRefs, findingRefs: _findingRefs, ...definitionOnly } = c;
  return definitionOnly;
}
function componentFieldValue(component: ReviewerAssessment, field: string): unknown {
  const criterion = /^criterion:([^.]*)\.(status|reason|evidenceRefs|findingRefs)$/.exec(field);
  if (criterion) return (component.classifications.criteria.find((item) => item.criterionId === criterion[1]) as unknown as Record<string, unknown> | undefined)?.[criterion[2]!];
  if (field.startsWith('process.')) return (component.classifications.process as unknown as Record<string, unknown>)[field.slice('process.'.length)];
  if (field.startsWith('evidence.')) return (component.classifications.evidence as unknown as Record<string, unknown>)[field.slice('evidence.'.length)];
  if (field === 'findings') return component.classifications.findings;
  if (field === 'confidence') return component.classifications.confidence;
  return undefined;
}

function validateManifest(value: unknown, path: string): void {
  const v = object(value, path);
  hash(v.rawJsonlSha256, `${path}.rawJsonlSha256`);
  if (!Number.isInteger(v.rawJsonlBytes) || (v.rawJsonlBytes as number) < 0) fail(`${path}.rawJsonlBytes must be non-negative integer`);
  date(v.rawJsonlMtime, `${path}.rawJsonlMtime`);
  hash(v.transcriptExcerptSha256, `${path}.transcriptExcerptSha256`);
  if (!Array.isArray(v.artifacts)) fail(`${path}.artifacts must be an array`);
  v.artifacts.forEach((item, i) => {
    const artifact = object(item, `${path}.artifacts[${i}]`);
    string(artifact.path, `${path}.artifacts[${i}].path`); hash(artifact.sha256, `${path}.artifacts[${i}].sha256`);
    hash(artifact.excerptSha256, `${path}.artifacts[${i}].excerptSha256`);
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
  stringArray(blinding.redactedTurnFields, `${path}.blinding.redactedTurnFields`);
  stringArray(blinding.notes, `${path}.blinding.notes`);
  for (const key of ['modelId', 'provider', 'thinkingLevel', 'family']) if (!stripped.includes(key)) fail(`${path}.blinding.stripped must include ${key}`);
}

/** Throws with a precise invariant failure and returns the narrowed record. */
export function validateSessionReviewV2(value: unknown): SessionReviewV2 {
  const v = object(value, 'review');
  if (!Number.isInteger(v.schemaVersion) || (v.schemaVersion as number) < 2) fail('schemaVersion must be >= 2');
  member(v.kind, values('production', 'calibration'), 'review.kind');
  for (const key of ['reviewId', 'sessionId', 'sessionPathAtReview', 'rubricVersion'] as const) string(v[key], `review.${key}`);
  date(v.reviewedAt, 'review.reviewedAt');
  if (v.identityFallback !== undefined && typeof v.identityFallback !== 'boolean') fail('identityFallback must be boolean');
  if (v.indexVersion !== undefined && v.indexVersion !== 'v1') fail('indexVersion must be v1 when supplied');
  if (!Array.isArray(v.frozenLedger)) fail('frozenLedger must be an array');
  const frozen = v.frozenLedger.map((item, i) => definition(item, `review.frozenLedger[${i}]`, true));
  unique(frozen.map((c) => c.criterionId), 'review.frozenLedger');
  const frozenHash = hash(v.frozenLedgerSha256, 'review.frozenLedgerSha256');
  if (frozenHash !== hashJson(v.frozenLedger)) fail('frozenLedgerSha256 does not match frozenLedger');
  if (!Array.isArray(v.ledger)) fail('ledger must be an array');
  const ledger = v.ledger.map((item, i) => classified(item, `review.ledger[${i}]`));
  unique(ledger.map((c) => c.criterionId), 'review.ledger');

  if (!Array.isArray(v.proposals) || v.proposals.length !== 2) fail('proposals must contain exactly two records');
  for (const [i, item] of v.proposals.entries()) {
    runtime(item, `review.proposals[${i}]`, 'reviewer');
    const proposal = object(item, `review.proposals[${i}]`);
    string(proposal.proposalId, `review.proposals[${i}].proposalId`); date(proposal.proposedAt, `review.proposals[${i}].proposedAt`);
    if (!Array.isArray(proposal.criteria)) fail(`review.proposals[${i}].criteria must be an array`);
    proposal.criteria.forEach((c, j) => definition(c, `review.proposals[${i}].criteria[${j}]`, true));
    if (!Array.isArray(proposal.findings)) fail(`review.proposals[${i}].findings must be an array`);
    proposal.findings.forEach((f, j) => finding(f, `review.proposals[${i}].findings[${j}]`, false));
    if (!Array.isArray(proposal.candidateChecks)) fail(`review.proposals[${i}].candidateChecks must be an array`);
    proposal.candidateChecks.forEach((c, j) => checkSpec(c, `review.proposals[${i}].candidateChecks[${j}]`));
    if (proposal.candidateHumanQuestion !== undefined) humanQuestionCandidate(proposal.candidateHumanQuestion, `review.proposals[${i}].candidateHumanQuestion`);
    if (proposal.rubricVersion !== v.rubricVersion) fail(`review.proposals[${i}].rubricVersion mismatch`);
  }
  const proposalRoles = (v.proposals as unknown as ReviewerRuntime[]).map((p) => p.requestedBucket).sort();
  if (!isDeepStrictEqual(proposalRoles, ['medium', 'small'])) fail('proposals must contain one small- and one medium-requested reviewer');

  runtime(v.consolidation, 'review.consolidation', 'medium');
  const consolidation = object(v.consolidation, 'review.consolidation');
  string(consolidation.consolidationId, 'review.consolidation.consolidationId'); date(consolidation.consolidatedAt, 'review.consolidation.consolidatedAt');
  if (consolidation.rubricVersion !== v.rubricVersion) fail('review.consolidation.rubricVersion mismatch');
  if (consolidation.selectedHumanQuestion !== undefined) humanQuestionCandidate(consolidation.selectedHumanQuestion, 'review.consolidation.selectedHumanQuestion');
  hash(consolidation.frozenLedgerSha256, 'review.consolidation.frozenLedgerSha256');
  if (!isDeepStrictEqual(consolidation.frozenLedger, v.frozenLedger) || consolidation.frozenLedgerSha256 !== frozenHash) fail('consolidation frozen ledger/hash must exactly match canonical frozen ledger/hash');
  const consolidationProvenance = object(consolidation.provenance, 'review.consolidation.provenance');
  if (!Array.isArray(consolidationProvenance.fromProposals) || consolidationProvenance.fromProposals.length !== 2) fail('consolidation provenance must reference two proposals');
  stringArray(consolidationProvenance.dedupNotes, 'review.consolidation.provenance.dedupNotes');
  const proposalIds = (v.proposals as unknown as { proposalId: string }[]).map((p) => p.proposalId);
  if (!isDeepStrictEqual([...consolidationProvenance.fromProposals as string[]].sort(), [...proposalIds].sort())) fail('consolidation proposal references do not match');

  if (!Array.isArray(v.reviewerChecks)) fail('reviewerChecks must be an array');
  for (const [i, item] of v.reviewerChecks.entries()) {
    checkSpec(item, `review.reviewerChecks[${i}]`);
    const check = object(item, `review.reviewerChecks[${i}]`);
    member(check.status, values('pass', 'fail', 'inconclusive', 'declined: mutating'), `review.reviewerChecks[${i}].status`);
    if (typeof check.result !== 'string') fail(`review.reviewerChecks[${i}].result must be a string`);
    stringArray(check.evidenceRefs, `review.reviewerChecks[${i}].evidenceRefs`);
    const safety = checkSafety(item as never);
    if ((safety.safe && check.status === 'declined: mutating') || (!safety.safe && check.status !== 'declined: mutating')) fail(`review.reviewerChecks[${i}] status violates check safety result`);
    // Executed checks must bind their result/status/evidence to a real prior
    // orchestrator tool call and its immutable output; skipped (declined)
    // checks must carry no such binding. The transcript binding itself is
    // enforced in validateRuntimeProvenance (do not trust the caller).
    if (check.status === 'declined: mutating') {
      if ('toolCallId' in check || 'outputSha256' in check) fail(`review.reviewerChecks[${i}] declined check must not bind a tool call or output`);
    } else {
      string(check.toolCallId, `review.reviewerChecks[${i}].toolCallId`);
      hash(check.outputSha256, `review.reviewerChecks[${i}].outputSha256`);
    }
  }
  const checksHash = hash(v.reviewerChecksSha256, 'review.reviewerChecksSha256');
  if (checksHash !== hashJson(v.reviewerChecks)) fail('reviewerChecksSha256 does not match reviewerChecks');

  if (!Array.isArray(v.components) || v.components.length !== 2) fail('components must contain exactly two records');
  const components = v.components.map((item, i) => validateAssessment(item, `review.components[${i}]`, frozen));
  const componentRoles = components.map((c) => c.requestedBucket).sort();
  if (!isDeepStrictEqual(componentRoles, ['medium', 'small'])) fail('components must contain one small- and one medium-requested reviewer');
  if (components.some((component) => component.rubricVersion !== v.rubricVersion)) fail('component rubricVersion mismatch');
  const proposedAmendments = new Map<string, { proposal: Record<string, unknown>; reviewerId: string; findingIds: Set<string> }>();
  for (const component of components) {
    const findingIds = new Set(component.classifications.findings.map((finding) => finding.findingId));
    for (const proposal of component.classifications.proposedAmendments) {
      if (proposedAmendments.has(proposal.amendmentId)) fail(`duplicate proposed amendment ID ${proposal.amendmentId}`);
      proposedAmendments.set(proposal.amendmentId, { proposal: proposal as unknown as Record<string, unknown>, reviewerId: component.reviewerId, findingIds });
    }
  }

  if (!Array.isArray(v.amendments)) fail('amendments must be an array');
  const expectedLedger = new Map<string, ClassifiedCriterion>();
  for (const item of ledger) expectedLedger.set(item.criterionId, item);
  const frozenIds = new Set(frozen.map((c) => c.criterionId));
  const amendmentIds: string[] = [];
  for (const [i, item] of v.amendments.entries()) {
    const amendment = object(item, `review.amendments[${i}]`);
    const amendmentId = string(amendment.amendmentId, `review.amendments[${i}].amendmentId`); amendmentIds.push(amendmentId);
    const proposed = proposedAmendments.get(amendmentId);
    if (!proposed) fail(`review.amendments[${i}] was not proposed by a component`);
    const amendmentDefinition = definition(amendment.definition, `review.amendments[${i}].definition`, true);
    const motivatingFindingId = string(amendment.motivatingFindingId, `review.amendments[${i}].motivatingFindingId`); stringArray(amendment.evidenceRefs, `review.amendments[${i}].evidenceRefs`);
    const proposedBy = string(amendment.proposedByReviewerId, `review.amendments[${i}].proposedByReviewerId`); string(amendment.adjudicatedByReviewerId, `review.amendments[${i}].adjudicatedByReviewerId`);
    if (proposedBy !== proposed.reviewerId || !proposed.findingIds.has(motivatingFindingId) || !isDeepStrictEqual(proposed.proposal.definition, amendment.definition) || proposed.proposal.motivatingFindingId !== motivatingFindingId || !isDeepStrictEqual(proposed.proposal.evidenceRefs, amendment.evidenceRefs)) fail(`review.amendments[${i}] does not match its component proposal/finding`);
    date(amendment.adjudicatedAt, `review.amendments[${i}].adjudicatedAt`); string(amendment.rationale, `review.amendments[${i}].rationale`);
    const disposition = member(amendment.disposition, values('accepted', 'mapped_to_existing', 'finding_downgraded', 'rejected'), `review.amendments[${i}].disposition`);
    if (disposition === 'accepted') {
      const added = classified(amendment.classifiedCriterion, `review.amendments[${i}].classifiedCriterion`);
      if (!isDeepStrictEqual(stripClassification(added), amendmentDefinition) || frozenIds.has(added.criterionId)) fail(`review.amendments[${i}] accepted classification is invalid`);
      if (!isDeepStrictEqual(expectedLedger.get(added.criterionId), added)) fail(`review.amendments[${i}] accepted classification missing from ledger`);
    } else if (disposition === 'mapped_to_existing') {
      const target = string(amendment.targetCriterionId, `review.amendments[${i}].targetCriterionId`);
      const downgraded = classified(amendment.downgradedClassification, `review.amendments[${i}].downgradedClassification`);
      if (!frozenIds.has(target) || downgraded.criterionId !== target || !isDeepStrictEqual(expectedLedger.get(target), downgraded)) fail(`review.amendments[${i}] mapped classification is invalid`);
    } else if (disposition === 'finding_downgraded') {
      member(amendment.downgradedSeverity, values('minor', 'nit'), `review.amendments[${i}].downgradedSeverity`);
    }
  }
  unique(amendmentIds, 'review.amendments');
  if (amendmentIds.length !== proposedAmendments.size || amendmentIds.some((id) => !proposedAmendments.has(id))) fail('every proposed amendment must have exactly one disposition');
  const allowedLedgerIds = new Set([...frozenIds, ...(v.amendments as unknown as Array<Record<string, unknown>>).filter((a) => a.disposition === 'accepted').map((a) => (a.classifiedCriterion as ClassifiedCriterion).criterionId)]);
  if (ledger.length !== allowedLedgerIds.size || ledger.some((c) => !allowedLedgerIds.has(c.criterionId))) fail('ledger must contain only frozen criteria plus accepted amendments');
  for (const frozenDefinition of frozen) {
    const item = expectedLedger.get(frozenDefinition.criterionId);
    if (!item || !isDeepStrictEqual(stripClassification(item), frozenDefinition)) fail(`ledger definition mismatch for ${frozenDefinition.criterionId}`);
  }

  processVector(v.process, 'review.process'); evidenceVector(v.evidence, 'review.evidence'); member(v.confidence, confidenceValues, 'review.confidence');
  if (!Array.isArray(v.findings)) fail('findings must be an array');
  const canonicalFindings = v.findings.map((item, i) => finding(item, `review.findings[${i}]`, true));
  unique(canonicalFindings.map((f) => f.findingId), 'review.findings');
  const canonicalFindingMap = new Map(canonicalFindings.map((finding) => [finding.findingId, finding]));
  for (const f of canonicalFindings) {
    if (f.criterionId && !expectedLedger.has(f.criterionId)) fail(`finding ${f.findingId} references unknown criterion`);
    if (f.severity === 'critical' && f.criterionId && expectedLedger.get(f.criterionId)?.importance !== 'core') fail(`critical finding ${f.findingId} must affect a core criterion`);
    if (f.severity === 'major' && f.criterionId && expectedLedger.get(f.criterionId)?.importance === 'optional') fail(`major finding ${f.findingId} cannot affect only an optional criterion`);
    if ((f.severity === 'critical' || f.severity === 'major') && f.criterionId) {
      const target = expectedLedger.get(f.criterionId)!;
      if (target.status === 'met' || target.status === 'superseded') fail(`material finding ${f.findingId} does not downgrade its criterion`);
    }
  }
  for (const criterion of ledger) {
    unique(criterion.findingRefs, `review.ledger criterion ${criterion.criterionId}.findingRefs`);
    for (const findingId of criterion.findingRefs) {
      const referenced = canonicalFindingMap.get(findingId);
      if (!referenced || referenced.criterionId !== criterion.criterionId) fail(`criterion ${criterion.criterionId} has invalid finding reference ${findingId}`);
    }
  }
  for (const finding of canonicalFindings) {
    if (finding.criterionId && !expectedLedger.get(finding.criterionId)!.findingRefs.includes(finding.findingId)) fail(`finding ${finding.findingId} is not linked from its criterion`);
  }
  for (const amendment of v.amendments as unknown as Array<Record<string, unknown>>) {
    const motivatingId = amendment.motivatingFindingId as string;
    const canonicalFinding = canonicalFindingMap.get(motivatingId);
    if (amendment.disposition === 'accepted') {
      const added = amendment.classifiedCriterion as ClassifiedCriterion;
      if (!canonicalFinding || canonicalFinding.ledgerEffect !== 'add' || canonicalFinding.criterionId !== added.criterionId) fail(`accepted amendment ${amendment.amendmentId as string} has inconsistent canonical finding`);
    } else if (amendment.disposition === 'mapped_to_existing') {
      if (!canonicalFinding || canonicalFinding.ledgerEffect !== 'downgrade' || canonicalFinding.criterionId !== amendment.targetCriterionId) fail(`mapped amendment ${amendment.amendmentId as string} has inconsistent canonical finding`);
    } else if (amendment.disposition === 'finding_downgraded') {
      if (!canonicalFinding || canonicalFinding.severity !== amendment.downgradedSeverity || canonicalFinding.ledgerEffect !== 'none') fail(`downgraded amendment ${amendment.amendmentId as string} has inconsistent canonical finding`);
    } else if (canonicalFinding) fail(`rejected amendment ${amendment.amendmentId as string} retained its canonical finding`);
  }

  const disagreement = object(v.disagreement, 'review.disagreement');
  if (typeof disagreement.material !== 'boolean' || typeof disagreement.adjudicated !== 'boolean' || !Array.isArray(disagreement.disputedFields)) fail('disagreement shape is invalid');
  const computedMaterial = materialDisagreementFields(components[0]!, components[1]!);
  if (disagreement.material !== (computedMaterial.length > 0)) fail('disagreement.material does not match component assessments');
  const recordedFieldRecords = new Map<string, Record<string, unknown>>();
  for (const [i, item] of (disagreement.disputedFields as Array<Record<string, unknown>>).entries()) {
    const field = object(item, `review.disagreement.disputedFields[${i}]`);
    const name = string(field.field, `review.disagreement.disputedFields[${i}].field`);
    if (recordedFieldRecords.has(name)) fail(`duplicate disputed field ${name}`);
    for (const key of ['smallValue', 'mediumValue', 'resolvedValue'] as const) string(field[key], `review.disagreement.disputedFields[${i}].${key}`);
    member(field.resolution, values('small', 'medium', 'adjudicator', 'deterministic_merge'), `review.disagreement.disputedFields[${i}].resolution`);
    recordedFieldRecords.set(name, field);
  }
  for (const field of computedMaterial) {
    const recorded = recordedFieldRecords.get(field);
    if (!recorded) fail(`material disputed field ${field} is not recorded`);
    if (recorded.resolution !== 'adjudicator') fail(`material disputed field ${field} must be resolved by the adjudicator`);
  }
  if (disagreement.material !== !!v.adjudication || disagreement.adjudicated !== !!v.adjudication) fail('material disagreement must have exactly one adjudication');
  if (v.adjudication) {
    runtime(v.adjudication, 'review.adjudication', 'medium');
    const adjudication = object(v.adjudication, 'review.adjudication');
    string(adjudication.adjudicationId, 'review.adjudication.adjudicationId'); date(adjudication.assessedAt, 'review.adjudication.assessedAt');
    if (adjudication.rubricVersion !== v.rubricVersion) fail('review.adjudication.rubricVersion mismatch');
    if (!Array.isArray(adjudication.resolvedFields)) fail('review.adjudication.resolvedFields must be an array');
    adjudication.resolvedFields.forEach((item, i) => {
      const resolved = object(item, `review.adjudication.resolvedFields[${i}]`);
      string(resolved.field, `review.adjudication.resolvedFields[${i}].field`); string(resolved.value, `review.adjudication.resolvedFields[${i}].value`);
      string(resolved.rationale, `review.adjudication.resolvedFields[${i}].rationale`); stringArray(resolved.evidenceRefs, `review.adjudication.resolvedFields[${i}].evidenceRefs`);
    });
    const canonicalOverall = object(adjudication.canonicalOverall, 'review.adjudication.canonicalOverall');
    member(canonicalOverall.deliveredOverall, overallValues, 'review.adjudication.canonicalOverall.deliveredOverall');
    member(canonicalOverall.controllableOverall, overallValues, 'review.adjudication.canonicalOverall.controllableOverall');
    const adjudicationAmendments = stringArray(adjudication.amendmentIds, 'review.adjudication.amendmentIds');
    if (!isDeepStrictEqual([...adjudicationAmendments].sort(), [...amendmentIds].sort())) fail('adjudication amendment IDs do not match amendments');
  } else if (amendmentIds.length) fail('amendments require adjudication');

  let canonical;
  let preAmendmentCanonical;
  try {
    canonical = deriveCanonicalFromComponents(components as [ReviewerAssessment, ReviewerAssessment], v.adjudication as never, v.amendments as never);
    preAmendmentCanonical = deriveCanonicalFromComponents(components as [ReviewerAssessment, ReviewerAssessment], v.adjudication as never, []);
  } catch (error) { fail((error as Error).message); }
  const preAmendmentById = new Map(preAmendmentCanonical.ledger.map((criterion) => [criterion.criterionId, criterion]));
  for (const amendment of v.amendments as unknown as Array<Record<string, unknown>>) {
    if (amendment.disposition !== 'mapped_to_existing') continue;
    const previous = preAmendmentById.get(amendment.targetCriterionId as string);
    const next = amendment.downgradedClassification as ClassifiedCriterion;
    const previousRank = previous ? downgradeRank[previous.status] : undefined;
    const nextRank = downgradeRank[next.status];
    if (previousRank === undefined || nextRank === undefined || nextRank >= previousRank) {
      fail(`mapped amendment ${amendment.amendmentId as string} must strictly worsen the pre-amendment criterion classification`);
    }
  }
  if (!isDeepStrictEqual(v.ledger, canonical.ledger)) fail('canonical ledger is not derived from component agreement, deterministic merge, or adjudication');
  if (!isDeepStrictEqual(v.process, canonical.process)) fail('canonical process is not derived from component agreement, deterministic merge, or adjudication');
  if (!isDeepStrictEqual(v.evidence, canonical.evidence)) fail('canonical evidence is not derived from component agreement, deterministic merge, or adjudication');
  if (!isDeepStrictEqual(v.findings, canonical.findings)) fail('canonical findings are not derived from component agreement, deterministic merge, or adjudication');
  if (v.confidence !== canonical.confidence) fail('canonical confidence is not derived from component agreement or deterministic merge');
  const smallComponent = components.find((component) => component.requestedBucket === 'small')!;
  const mediumComponent = components.find((component) => component.requestedBucket === 'medium')!;
  for (const [field, expected] of canonical.differingFields) {
    const recorded = recordedFieldRecords.get(field);
    if (!recorded) fail(`disputed field ${field} is not recorded`);
    const smallValue = componentFieldValue(smallComponent, field);
    const mediumValue = componentFieldValue(mediumComponent, field);
    if (recorded.resolution !== expected.resolution || recorded.resolvedValue !== resolutionString(expected.value) || recorded.smallValue !== resolutionString(smallValue) || recorded.mediumValue !== resolutionString(mediumValue)) fail(`disputed field ${field} does not match its component values/canonical resolution`);
  }
  // Reject spurious disputed fields: every recorded field must be either a
  // material disagreement (requiring adjudication) or a deterministically
  // differing field with a recorded merge. A caller cannot invent fields that
  // the components never disagreed on.
  const allowedDisputedFields = new Set<string>([...computedMaterial, ...canonical.differingFields.keys()]);
  for (const name of recordedFieldRecords.keys()) {
    if (!allowedDisputedFields.has(name)) fail(`spurious disputed field ${name} is not a material or deterministically differing field`);
  }

  const attainment = object(v.attainment, 'review.attainment');
  const derivedAttainment = deriveAttainment(ledger);
  if (!isDeepStrictEqual(attainment, derivedAttainment)) fail('attainment does not match deterministic derivation');
  if (v.adjudication && !isDeepStrictEqual((v.adjudication as unknown as Record<string, unknown>).canonicalOverall, { deliveredOverall: derivedAttainment.deliveredOverall, controllableOverall: derivedAttainment.controllableOverall })) fail('adjudication canonicalOverall does not match deterministic derivation');

  const provenance = object(v.provenance, 'review.provenance');
  string(provenance.orchestratorSessionId, 'review.provenance.orchestratorSessionId');
  if (provenance.hostVersion !== null && (typeof provenance.hostVersion !== 'string' || !provenance.hostVersion.trim())) fail('review.provenance.hostVersion must be null or a non-empty version string');
  if (provenance.rubricVersion !== v.rubricVersion) fail('provenance rubricVersion mismatch');
  if (provenance.indexVersion !== v.indexVersion) fail('provenance indexVersion mismatch');
  if (provenance.blindingApplied !== true) fail('provenance.blindingApplied must be true');
  validateManifest(provenance.evidenceManifest, 'review.provenance.evidenceManifest');
  const diversity = components[0]!.family !== components[1]!.family || components[0]!.provider !== components[1]!.provider;
  if (provenance.diversityAchieved !== diversity) fail('provenance.diversityAchieved does not match effective reviewers');
  const pipeline = object(provenance.pipeline, 'review.provenance.pipeline');
  if (pipeline.frozenLedgerSha256 !== frozenHash || pipeline.reviewerChecksSha256 !== checksHash) fail('pipeline hashes do not match');
  if (!isDeepStrictEqual(pipeline.proposalIds, proposalIds) || pipeline.consolidationId !== consolidation.consolidationId || !isDeepStrictEqual(pipeline.componentAssessmentIds, components.map((c) => c.assessmentId)) || !isDeepStrictEqual(pipeline.amendmentIds, amendmentIds)) fail('pipeline artifact IDs do not match stored artifacts');
  const adjudicationId = v.adjudication ? (v.adjudication as unknown as { adjudicationId: string }).adjudicationId : undefined;
  if (pipeline.adjudicationId !== adjudicationId) fail('pipeline adjudication ID mismatch');
  if (v.adjudication) {
    const adjudicator = v.adjudication as unknown as { reviewerId: string };
    if (provenance.adjudicatorReviewerId !== adjudicator.reviewerId || (v.amendments as unknown as Array<Record<string, unknown>>).some((amendment) => amendment.adjudicatedByReviewerId !== adjudicator.reviewerId)) fail('adjudicator reviewer provenance mismatch');
  } else if (provenance.adjudicatorReviewerId !== undefined) fail('adjudicatorReviewerId requires adjudication');

  if (v.humanCheck !== undefined) {
    const human = object(v.humanCheck, 'review.humanCheck'); string(human.toolCallId, 'review.humanCheck.toolCallId'); string(human.interpretation, 'review.humanCheck.interpretation');
    const input = object(human.input, 'review.humanCheck.input'); string(input.question, 'review.humanCheck.input.question');
    if (!stringArray(input.options, 'review.humanCheck.input.options').length) fail('review.humanCheck.input.options must not be empty');
    const meta = object(input.reviewMeta, 'review.humanCheck.input.reviewMeta');
    if (meta.purpose !== 'review_human_verification' || meta.targetSessionId !== v.sessionId || meta.targetSessionPath !== v.sessionPathAtReview || !expectedLedger.has(string(meta.criterionId, 'review.humanCheck.input.reviewMeta.criterionId'))) fail('humanCheck reviewMeta does not target this review/criterion');
    const response = object(human.response, 'review.humanCheck.response');
    date(response.recordedAt, 'review.humanCheck.response.recordedAt');
    const source = member(response.source, values('option', 'custom', 'cancelled', 'unanswered'), 'review.humanCheck.response.source');
    if (source === 'option' || source === 'custom') {
      if (response.cancelled !== false) fail('answered humanCheck response cannot be cancelled');
      string(response.answer, 'review.humanCheck.response.answer');
      member(response.status, values('answered', 'inconclusive', 'unavailable'), 'review.humanCheck.response.status');
    } else {
      if ('answer' in response) fail('unanswered humanCheck response cannot carry an answer');
      if (source === 'cancelled' && (response.cancelled !== true || response.status !== 'unanswered')) fail('cancelled humanCheck response is inconsistent');
      if (source === 'unanswered' && (response.cancelled !== false || (response.status !== 'unanswered' && response.status !== 'unavailable'))) fail('unanswered humanCheck response is inconsistent');
    }
  }
  return value as SessionReviewV2;
}
