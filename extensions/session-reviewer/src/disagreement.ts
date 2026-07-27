import type { ReviewEvidenceVector, ReviewerAssessment, ReviewProcessVector } from './types.js';

const gradedStatus: Record<string, number> = { met: 2, partly_met: 1, unmet: 0 };
const offScaleStatuses = new Set(['blocked', 'not_assessable', 'superseded']);
function statusMaterial(importance: string, a: string, b: string): boolean {
  if (a === b) return false;
  if (importance === 'core') return true;
  if (offScaleStatuses.has(a) || offScaleStatuses.has(b)) return true;
  return Math.abs((gradedStatus[a] ?? 99) - (gradedStatus[b] ?? -99)) >= 2;
}

const incomparableByField: Record<keyof ReviewProcessVector, Set<string>> = {
  requirementDiscipline: new Set(['not_assessable']),
  verificationDiscipline: new Set(['not_assessable', 'not_applicable']),
  scopeControl: new Set(['not_assessable']),
  recovery: new Set(['not_assessable', 'not_needed']),
  finalClaimAccuracy: new Set(['no_final_claim']),
};
const oppositePairs: Record<keyof ReviewProcessVector, Set<string>> = {
  requirementDiscipline: new Set(['overclarified|proportionate', 'overclarified|underclarified']),
  verificationDiscipline: new Set(['oververified|proportionate', 'oververified|underverified']),
  scopeControl: new Set(['controlled|material_scope_drift']),
  recovery: new Set(['effective|ineffective']),
  finalClaimAccuracy: new Set(['accurate|overclaimed', 'accurate|underclaimed', 'overclaimed|underclaimed']),
};
function pair(a: string, b: string): string { return [a, b].sort().join('|'); }
export function processDisagreementMaterial<K extends keyof ReviewProcessVector>(field: K, a: ReviewProcessVector[K], b: ReviewProcessVector[K]): boolean {
  if (a === b) return false;
  if (incomparableByField[field].has(a) || incomparableByField[field].has(b)) return true;
  if (oppositePairs[field].has(pair(a, b))) return true;
  return field === 'finalClaimAccuracy';
}

const evidenceOrder: Partial<Record<keyof Omit<ReviewEvidenceVector, 'limitations'>, Record<string, number>>> = {
  requirements: { clear: 2, partly_clear: 1, unclear: 0 },
  artifacts: { direct: 1, partial: 0 },
  execution: { direct: 2, partial: 1, reported_only: 0 },
};
export function evidenceDisagreementMaterial<K extends keyof Omit<ReviewEvidenceVector, 'limitations'>>(field: K, a: ReviewEvidenceVector[K], b: ReviewEvidenceVector[K]): boolean {
  if (a === b) return false;
  if (field === 'human') return true;
  const ranks = evidenceOrder[field];
  const aRank = ranks?.[a]; const bRank = ranks?.[b];
  return aRank === undefined || bRank === undefined || Math.abs(aRank - bRank) >= 2;
}

/** Pure implementation of material criterion, evidence, and process disagreement triggers. */
export function materialDisagreementFields(a: ReviewerAssessment, b: ReviewerAssessment): string[] {
  const fields: string[] = [];
  const bCriteria = new Map(b.classifications.criteria.map((criterion) => [criterion.criterionId, criterion]));
  for (const criterion of a.classifications.criteria) {
    const other = bCriteria.get(criterion.criterionId);
    if (!other || statusMaterial(criterion.importance, criterion.status, other.status)) fields.push(`criterion:${criterion.criterionId}.status`);
  }
  for (const field of ['requirements', 'artifacts', 'execution', 'human'] as const) {
    if (evidenceDisagreementMaterial(field, a.classifications.evidence[field], b.classifications.evidence[field])) fields.push(`evidence.${field}`);
  }
  for (const field of Object.keys(a.classifications.process) as (keyof ReviewProcessVector)[]) {
    if (processDisagreementMaterial(field, a.classifications.process[field], b.classifications.process[field])) fields.push(`process.${field}`);
  }
  return [...new Set(fields)];
}
