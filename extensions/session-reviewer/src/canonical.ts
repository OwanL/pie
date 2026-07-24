import { isDeepStrictEqual } from 'node:util';

import { evidenceDisagreementMaterial, matchFindings, materialDisagreementFields, processDisagreementMaterial } from './disagreement.js';
import type {
  ClassifiedCriterion, CriterionAmendment, CriterionReason, CriterionStatus, ReviewConfidence, ReviewEvidenceVector,
  ReviewFinding, ReviewProcessVector, ReviewerAdjudication, ReviewerAssessment,
} from './types.js';

const statusRank: Partial<Record<CriterionStatus, number>> = { met: 2, partly_met: 1, unmet: 0 };
const severityRank = { critical: 3, major: 2, minor: 1, nit: 0 } as const;
const confidenceRank: Record<ReviewConfidence, number> = { high: 2, medium: 1, low: 0 };

type Resolution = ReviewerAdjudication['resolvedFields'][number];
export interface CanonicalDerivation {
  ledger: ClassifiedCriterion[];
  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  findings: ReviewFinding[];
  confidence: ReviewConfidence;
  differingFields: Map<string, { value: unknown; resolution: 'deterministic_merge' | 'adjudicator' }>;
}
function serialized(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value); }
function union(left: string[], right: string[]): string[] { return [...new Set([...left, ...right])].sort(); }
function chooseLonger(a: string, b: string): string { return a.length === b.length ? [a, b].sort()[0]! : a.length > b.length ? a : b; }

function resolutionMap(adjudication: ReviewerAdjudication | undefined): Map<string, Resolution> {
  const map = new Map<string, Resolution>();
  for (const resolution of adjudication?.resolvedFields ?? []) {
    if (map.has(resolution.field)) throw new Error(`duplicate adjudicator resolved field ${resolution.field}`);
    map.set(resolution.field, resolution);
  }
  return map;
}
function adjudicated<T>(map: Map<string, Resolution>, field: string, parse: (value: string) => T): T {
  const resolution = map.get(field);
  if (!resolution) throw new Error(`adjudicator must resolve material field ${field}`);
  try { return parse(resolution.value); }
  catch { throw new Error(`adjudicator resolved field ${field} has an invalid value`); }
}
function adjudicatedString(map: Map<string, Resolution>, field: string): string { return adjudicated(map, field, (value) => value); }
function adjudicatedJson<T>(map: Map<string, Resolution>, field: string): T { return adjudicated(map, field, (value) => JSON.parse(value) as T); }
function preferredReason(reasons: CriterionReason[]): CriterionReason {
  const specific = reasons.filter((reason) => reason !== 'unknown');
  return [...(specific.length ? specific : reasons)].sort()[0]!;
}

function mergeFinding(left: ReviewFinding, right: ReviewFinding): ReviewFinding {
  const severity = severityRank[left.severity] >= severityRank[right.severity] ? left.severity : right.severity;
  const effectRank = { add: 2, downgrade: 1, none: 0 } as const;
  const ledgerEffect = effectRank[left.ledgerEffect] >= effectRank[right.ledgerEffect] ? left.ledgerEffect : right.ledgerEffect;
  return {
    findingId: left.findingId,
    severity,
    category: left.category,
    statement: chooseLonger(left.statement, right.statement),
    evidenceRefs: union(left.evidenceRefs, right.evidenceRefs),
    ...(left.criterionId || right.criterionId ? { criterionId: left.criterionId ?? right.criterionId } : {}),
    ledgerEffect,
    remediation: chooseLonger(left.remediation, right.remediation),
  };
}
function deterministicFindings(small: ReviewerAssessment, medium: ReviewerAssessment): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const match of matchFindings(small.classifications.findings, medium.classifications.findings)) {
    if (match.left && match.right) findings.push(mergeFinding(match.left, match.right));
    else findings.push(structuredClone((match.left ?? match.right)!));
  }
  return findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
}
function processMerge<K extends keyof ReviewProcessVector>(field: K, a: ReviewProcessVector[K], b: ReviewProcessVector[K]): ReviewProcessVector[K] {
  if (a === b) return a;
  const conservative: Partial<Record<keyof ReviewProcessVector, Record<string, string>>> = {
    requirementDiscipline: { 'proportionate|underclarified': 'underclarified' },
    verificationDiscipline: { 'proportionate|underverified': 'underverified' },
    scopeControl: { 'controlled|minor_avoidable_drift': 'minor_avoidable_drift', 'material_scope_drift|minor_avoidable_drift': 'material_scope_drift' },
    recovery: { 'effective|partly_effective': 'partly_effective', 'ineffective|partly_effective': 'ineffective' },
  };
  const key = [a, b].sort().join('|');
  const result = conservative[field]?.[key];
  if (!result) throw new Error(`no deterministic process merge for ${String(field)}: ${a}/${b}`);
  return result as ReviewProcessVector[K];
}
function evidenceMerge<K extends 'requirements' | 'artifacts' | 'execution'>(field: K, a: ReviewEvidenceVector[K], b: ReviewEvidenceVector[K]): ReviewEvidenceVector[K] {
  const ranks: Record<string, number> = field === 'requirements'
    ? { clear: 2, partly_clear: 1, unclear: 0 }
    : field === 'artifacts' ? { direct: 1, partial: 0 } : { direct: 2, partial: 1, reported_only: 0 };
  const aRank = ranks[a];
  const bRank = ranks[b];
  if (aRank === undefined || bRank === undefined || Math.abs(aRank - bRank) !== 1) {
    throw new Error(`no deterministic evidence merge for ${field}: ${a}/${b}`);
  }
  return aRank < bRank ? a : b;
}

export function deriveCanonicalFromComponents(
  components: [ReviewerAssessment, ReviewerAssessment],
  adjudication: ReviewerAdjudication | undefined,
  amendments: CriterionAmendment[],
): CanonicalDerivation {
  const small = components.find((component) => component.requestedBucket === 'small')!;
  const medium = components.find((component) => component.requestedBucket === 'medium')!;
  const resolutions = resolutionMap(adjudication);
  const material = new Set(materialDisagreementFields(small, medium));
  const differingFields = new Map<string, { value: unknown; resolution: 'deterministic_merge' | 'adjudicator' }>();
  const mediumCriteria = new Map(medium.classifications.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const ledger: ClassifiedCriterion[] = small.classifications.criteria.map((left) => {
    const right = mediumCriteria.get(left.criterionId)!;
    let status = left.status;
    let reason = left.reason;
    if (left.status !== right.status) {
      const field = `criterion:${left.criterionId}.status`;
      if (material.has(field)) {
        status = adjudicatedString(resolutions, field) as CriterionStatus;
        reason = adjudicatedString(resolutions, `criterion:${left.criterionId}.reason`) as CriterionReason;
        differingFields.set(field, { value: status, resolution: 'adjudicator' });
        differingFields.set(`criterion:${left.criterionId}.reason`, { value: reason, resolution: 'adjudicator' });
      } else {
        status = (statusRank[left.status] ?? -1) <= (statusRank[right.status] ?? -1) ? left.status : right.status;
        reason = status === left.status ? left.reason : right.reason;
        differingFields.set(field, { value: status, resolution: 'deterministic_merge' });
        differingFields.set(`criterion:${left.criterionId}.reason`, { value: reason, resolution: 'deterministic_merge' });
      }
    } else if (left.reason !== right.reason) {
      reason = preferredReason([left.reason, right.reason]);
      differingFields.set(`criterion:${left.criterionId}.reason`, { value: reason, resolution: 'deterministic_merge' });
    }
    if (!isDeepStrictEqual(left.evidenceRefs, right.evidenceRefs)) differingFields.set(`criterion:${left.criterionId}.evidenceRefs`, { value: union(left.evidenceRefs, right.evidenceRefs), resolution: 'deterministic_merge' });
    return { ...structuredClone(left), status, reason, evidenceRefs: union(left.evidenceRefs, right.evidenceRefs), findingRefs: [] };
  });

  const process = {} as ReviewProcessVector;
  for (const field of Object.keys(small.classifications.process) as (keyof ReviewProcessVector)[]) {
    const a = small.classifications.process[field];
    const b = medium.classifications.process[field];
    if (a === b) process[field] = a as never;
    else {
      const name = `process.${field}`;
      const value = processDisagreementMaterial(field, a, b) ? adjudicatedString(resolutions, name) : processMerge(field, a, b);
      process[field] = value as never;
      differingFields.set(name, { value, resolution: processDisagreementMaterial(field, a, b) ? 'adjudicator' : 'deterministic_merge' });
    }
  }

  const evidence = {} as ReviewEvidenceVector;
  for (const field of ['requirements', 'artifacts', 'execution', 'human'] as const) {
    const a = small.classifications.evidence[field];
    const b = medium.classifications.evidence[field];
    if (a === b) evidence[field] = a as never;
    else {
      const name = `evidence.${field}`;
      const value = evidenceDisagreementMaterial(field, a, b) ? adjudicatedString(resolutions, name) : evidenceMerge(field as never, a as never, b as never);
      evidence[field] = value as never;
      differingFields.set(name, { value, resolution: evidenceDisagreementMaterial(field, a, b) ? 'adjudicator' : 'deterministic_merge' });
    }
  }
  evidence.limitations = union(small.classifications.evidence.limitations, medium.classifications.evidence.limitations);
  if (!isDeepStrictEqual(small.classifications.evidence.limitations, medium.classifications.evidence.limitations)) differingFields.set('evidence.limitations', { value: evidence.limitations, resolution: 'deterministic_merge' });

  const findingsNeedAdjudication = [...material].some((field) => field.startsWith('finding:') || field === 'amendments');
  const findings = findingsNeedAdjudication
    ? adjudicatedJson<ReviewFinding[]>(resolutions, 'findings')
    : deterministicFindings(small, medium);
  if (!isDeepStrictEqual(small.classifications.findings, medium.classifications.findings)) differingFields.set('findings', { value: findings, resolution: findingsNeedAdjudication ? 'adjudicator' : 'deterministic_merge' });

  const confidence = confidenceRank[small.classifications.confidence] <= confidenceRank[medium.classifications.confidence]
    ? small.classifications.confidence : medium.classifications.confidence;
  if (small.classifications.confidence !== medium.classifications.confidence) differingFields.set('confidence', { value: confidence, resolution: 'deterministic_merge' });

  const byId = new Map(ledger.map((criterion) => [criterion.criterionId, criterion]));
  for (const amendment of amendments) {
    if (amendment.disposition === 'accepted') byId.set(amendment.classifiedCriterion.criterionId, structuredClone(amendment.classifiedCriterion));
    else if (amendment.disposition === 'mapped_to_existing') {
      const previous = byId.get(amendment.targetCriterionId);
      const previousRank = previous ? statusRank[previous.status] : undefined;
      const nextRank = statusRank[amendment.downgradedClassification.status];
      if (previousRank === undefined || nextRank === undefined || nextRank >= previousRank) {
        throw new Error(`mapped amendment ${amendment.amendmentId} must strictly worsen the pre-amendment criterion classification`);
      }
      byId.set(amendment.targetCriterionId, structuredClone(amendment.downgradedClassification));
    }
  }
  for (const criterion of byId.values()) criterion.findingRefs = findings.filter((finding) => finding.criterionId === criterion.criterionId).map((finding) => finding.findingId).sort();

  return { ledger: [...byId.values()], process, evidence, findings, confidence, differingFields };
}

export function resolutionString(value: unknown): string { return serialized(value); }
