import type { ReviewEvidenceVector, ReviewFinding, ReviewerAssessment, ReviewProcessVector } from './types.js';

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
  if (field === 'finalClaimAccuracy') return true;
  if (field === 'scopeControl' && pair(a, b) === 'controlled|material_scope_drift') return true;
  if (field === 'recovery' && pair(a, b) === 'effective|ineffective') return true;
  return false;
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
  const aRank = ranks?.[a];
  const bRank = ranks?.[b];
  return aRank === undefined || bRank === undefined || Math.abs(aRank - bRank) >= 2;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with']);
function normalizedRefs(refs: string[]): Set<string> {
  return new Set(refs.map((ref) => ref.trim().toLowerCase()).filter(Boolean));
}
function findingWords(statement: string): string[] {
  return statement.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .map((word) => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
}
function statementSimilarity(a: ReviewFinding, b: ReviewFinding): number {
  const aWords = new Set(findingWords(a.statement));
  const bWords = new Set(findingWords(b.statement));
  if (!aWords.size || !bWords.size) return 0;
  const intersection = [...aWords].filter((word) => bWords.has(word)).length;
  const union = new Set([...aWords, ...bWords]).size;
  const containment = intersection / Math.min(aWords.size, bWords.size);
  return Math.max(intersection / union, containment >= 0.8 && intersection >= 2 ? containment : 0);
}
/** Stable issue identity ignores caller-local IDs and anchors on criterion, category, and evidence. */
export function findingSimilarity(a: ReviewFinding, b: ReviewFinding): number {
  if (a.category !== b.category || a.criterionId !== b.criterionId) return 0;
  const aRefs = normalizedRefs(a.evidenceRefs);
  const bRefs = normalizedRefs(b.evidenceRefs);
  const shared = [...aRefs].filter((ref) => bRefs.has(ref)).length;
  if (aRefs.size && bRefs.size && shared === 0) return 0;
  const evidenceScore = shared ? shared / new Set([...aRefs, ...bRefs]).size : 0;
  return Math.max(statementSimilarity(a, b), evidenceScore);
}
export function findingsSemanticallyMatch(a: ReviewFinding, b: ReviewFinding): boolean {
  return findingSimilarity(a, b) >= 0.66;
}
export interface FindingMatch { left?: ReviewFinding; right?: ReviewFinding }
export function matchFindings(left: ReviewFinding[], right: ReviewFinding[]): FindingMatch[] {
  const candidates = left.map((finding) => right.map((other, index) => ({
    index,
    score: findingSimilarity(finding, other),
    statementScore: statementSimilarity(finding, other),
  })).filter(({ score }) => score > 0));
  const reverseCandidateCounts = right.map((_, rightIndex) => candidates.filter((items) => items.some(({ index }) => index === rightIndex)).length);
  const unmatched = new Set(right.map((_, index) => index));
  const matches: FindingMatch[] = [];
  for (const [leftIndex, finding] of left.entries()) {
    const available = candidates[leftIndex]!.filter(({ index }) => unmatched.has(index));
    const uniqueStable = available.length === 1 && reverseCandidateCounts[available[0]!.index] === 1;
    const lexical = available.filter(({ statementScore }) => statementScore >= 0.66)
      .sort((a, b) => b.statementScore - a.statementScore || b.score - a.score || a.index - b.index);
    const selected = uniqueStable && available[0]!.statementScore > 0 ? available[0] : lexical[0];
    if (selected) {
      unmatched.delete(selected.index);
      matches.push({ left: finding, right: right[selected.index] });
    } else matches.push({ left: finding });
  }
  for (const index of unmatched) matches.push({ right: right[index] });
  return matches;
}

/** Pure implementation of every material-disagreement trigger in §10 Pass 6. */
export function materialDisagreementFields(a: ReviewerAssessment, b: ReviewerAssessment): string[] {
  const fields: string[] = [];
  const bCriteria = new Map(b.classifications.criteria.map((criterion) => [criterion.criterionId, criterion]));
  for (const criterion of a.classifications.criteria) {
    const other = bCriteria.get(criterion.criterionId);
    if (!other || statusMaterial(criterion.importance, criterion.status, other.status)) fields.push(`criterion:${criterion.criterionId}.status`);
  }
  const materialFinding = (finding: ReviewFinding) => finding.severity === 'critical' || finding.severity === 'major' || finding.category === 'regression';
  for (const match of matchFindings(a.classifications.findings, b.classifications.findings)) {
    const key = match.left?.findingId ?? match.right!.findingId;
    if (!match.left || !match.right) {
      if (materialFinding((match.left ?? match.right)!)) fields.push(`finding:${key}`);
    } else if (match.left.severity !== match.right.severity && (materialFinding(match.left) || materialFinding(match.right))) fields.push(`finding:${key}.severity`);
  }
  for (const field of ['requirements', 'artifacts', 'execution', 'human'] as const) {
    if (evidenceDisagreementMaterial(field, a.classifications.evidence[field], b.classifications.evidence[field])) fields.push(`evidence.${field}`);
  }
  if (a.classifications.proposedAmendments.length || b.classifications.proposedAmendments.length) fields.push('amendments');
  for (const field of Object.keys(a.classifications.process) as (keyof ReviewProcessVector)[]) {
    if (processDisagreementMaterial(field, a.classifications.process[field], b.classifications.process[field])) fields.push(`process.${field}`);
  }
  return [...new Set(fields)];
}
