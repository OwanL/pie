import { isDeepStrictEqual } from 'node:util';

import { evidenceDisagreementMaterial, materialDisagreementFields, processDisagreementMaterial } from './disagreement.js';
import type {
  ClassifiedCriterion, CriterionReason, CriterionStatus, ReviewConfidence, ReviewEvidenceVector,
  ReviewProcessVector, ReviewerAdjudication, ReviewerAssessment,
} from './types.js';

const statusRank: Partial<Record<CriterionStatus, number>> = { met: 2, partly_met: 1, unmet: 0 };
const confidenceRank: Record<ReviewConfidence, number> = { high: 2, medium: 1, low: 0 };

type Resolution = ReviewerAdjudication['resolvedFields'][number];
export interface CanonicalDerivation {
  ledger: ClassifiedCriterion[];
  process: ReviewProcessVector;
  evidence: ReviewEvidenceVector;
  confidence: ReviewConfidence;
  differingFields: Map<string, { value: unknown; resolution: 'deterministic_merge' | 'adjudicator' }>;
}
function serialized(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value); }
function union(left: string[], right: string[]): string[] { return [...new Set([...left, ...right])].sort(); }
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
function preferredReason(reasons: CriterionReason[]): CriterionReason {
  const specific = reasons.filter((reason) => reason !== 'unknown');
  return [...(specific.length ? specific : reasons)].sort()[0]!;
}
function processMerge<K extends keyof ReviewProcessVector>(field: K, a: ReviewProcessVector[K], b: ReviewProcessVector[K]): ReviewProcessVector[K] {
  if (a === b) return a;
  const conservative: Partial<Record<keyof ReviewProcessVector, Record<string, string>>> = {
    requirementDiscipline: { 'proportionate|underclarified': 'underclarified' },
    verificationDiscipline: { 'proportionate|underverified': 'underverified' },
    scopeControl: { 'controlled|minor_avoidable_drift': 'minor_avoidable_drift', 'material_scope_drift|minor_avoidable_drift': 'material_scope_drift' },
    recovery: { 'effective|partly_effective': 'partly_effective', 'ineffective|partly_effective': 'ineffective' },
  };
  const result = conservative[field]?.[[a, b].sort().join('|')];
  if (!result) throw new Error(`no deterministic process merge for ${String(field)}: ${a}/${b}`);
  return result as ReviewProcessVector[K];
}
function evidenceMerge<K extends 'requirements' | 'artifacts' | 'execution'>(field: K, a: ReviewEvidenceVector[K], b: ReviewEvidenceVector[K]): ReviewEvidenceVector[K] {
  const ranks: Record<string, number> = field === 'requirements'
    ? { clear: 2, partly_clear: 1, unclear: 0 }
    : field === 'artifacts' ? { direct: 1, partial: 0 } : { direct: 2, partial: 1, reported_only: 0 };
  const aRank = ranks[a]; const bRank = ranks[b];
  if (aRank === undefined || bRank === undefined || Math.abs(aRank - bRank) !== 1) throw new Error(`no deterministic evidence merge for ${field}: ${a}/${b}`);
  return aRank < bRank ? a : b;
}

/** Derives only the canonical ledger, process, evidence, and confidence values. */
export function deriveCanonicalFromComponents(
  components: [ReviewerAssessment, ReviewerAssessment],
  adjudication: ReviewerAdjudication | undefined,
): CanonicalDerivation {
  const [first, second] = components;
  const resolutions = resolutionMap(adjudication);
  const material = new Set(materialDisagreementFields(first, second));
  const differingFields = new Map<string, { value: unknown; resolution: 'deterministic_merge' | 'adjudicator' }>();
  const secondCriteria = new Map(second.classifications.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const ledger = first.classifications.criteria.map((left) => {
    const right = secondCriteria.get(left.criterionId)!;
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
    return { ...structuredClone(left), status, reason, evidenceRefs: union(left.evidenceRefs, right.evidenceRefs) };
  });

  const process = {} as ReviewProcessVector;
  for (const field of Object.keys(first.classifications.process) as (keyof ReviewProcessVector)[]) {
    const a = first.classifications.process[field]; const b = second.classifications.process[field];
    if (a === b) process[field] = a as never;
    else {
      const name = `process.${field}`; const isMaterial = processDisagreementMaterial(field, a, b);
      const value = isMaterial ? adjudicatedString(resolutions, name) : processMerge(field, a, b);
      process[field] = value as never;
      differingFields.set(name, { value, resolution: isMaterial ? 'adjudicator' : 'deterministic_merge' });
    }
  }

  const evidence = {} as ReviewEvidenceVector;
  for (const field of ['requirements', 'artifacts', 'execution', 'human'] as const) {
    const a = first.classifications.evidence[field]; const b = second.classifications.evidence[field];
    if (a === b) evidence[field] = a as never;
    else {
      const name = `evidence.${field}`; const isMaterial = evidenceDisagreementMaterial(field, a, b);
      const value = isMaterial ? adjudicatedString(resolutions, name) : evidenceMerge(field as never, a as never, b as never);
      evidence[field] = value as never;
      differingFields.set(name, { value, resolution: isMaterial ? 'adjudicator' : 'deterministic_merge' });
    }
  }
  evidence.limitations = union(first.classifications.evidence.limitations, second.classifications.evidence.limitations);
  if (!isDeepStrictEqual(first.classifications.evidence.limitations, second.classifications.evidence.limitations)) differingFields.set('evidence.limitations', { value: evidence.limitations, resolution: 'deterministic_merge' });

  const confidence = confidenceRank[first.classifications.confidence] <= confidenceRank[second.classifications.confidence]
    ? first.classifications.confidence : second.classifications.confidence;
  if (first.classifications.confidence !== second.classifications.confidence) differingFields.set('confidence', { value: confidence, resolution: 'deterministic_merge' });

  return { ledger, process, evidence, confidence, differingFields };
}

export function resolutionString(value: unknown): string { return serialized(value); }
