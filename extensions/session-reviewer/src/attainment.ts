import type { ClassifiedCriterion, CriterionAttainmentSummary, CriterionImportance, OverallAttainment, SessionReviewV2 } from './types.js';

const IMPORTANCES: CriterionImportance[] = ['core', 'supporting', 'optional'];

function externallyBlocked(c: ClassifiedCriterion): boolean {
  return c.status === 'blocked' && c.reason === 'external_blocker';
}

export function summarizeAttainment(ledger: ClassifiedCriterion[], importance: CriterionImportance): CriterionAttainmentSummary {
  const all = ledger.filter((c) => c.importance === importance);
  const active = all.filter((c) => c.status !== 'superseded');
  const assessable = active.filter((c) => c.status !== 'not_assessable');
  const controllable = assessable.filter((c) => !externallyBlocked(c));
  const points = (items: ClassifiedCriterion[]) => items.reduce((sum, c) => sum + (c.status === 'met' ? 1 : c.status === 'partly_met' ? 0.5 : 0), 0);
  return {
    total: active.length,
    assessable: assessable.length,
    controllableDenominator: controllable.length,
    met: active.filter((c) => c.status === 'met').length,
    partlyMet: active.filter((c) => c.status === 'partly_met').length,
    unmet: active.filter((c) => c.status === 'unmet').length,
    blocked: active.filter((c) => c.status === 'blocked').length,
    externalBlocked: active.filter(externallyBlocked).length,
    notAssessable: active.filter((c) => c.status === 'not_assessable').length,
    superseded: all.filter((c) => c.status === 'superseded').length,
    deliveredRate: assessable.length ? points(assessable) / assessable.length : 0,
    controllableRate: controllable.length ? points(controllable) / controllable.length : 0,
  };
}

export function deriveOverall(ledger: ClassifiedCriterion[], view: 'delivered' | 'controllable'): OverallAttainment {
  const active = ledger.filter((c) => c.status !== 'superseded' && (view === 'delivered' || !externallyBlocked(c)));
  const core = active.filter((c) => c.importance === 'core');
  const supporting = active.filter((c) => c.importance === 'supporting' && c.status !== 'not_assessable');
  if (core.length === 0 || core.every((c) => c.status === 'not_assessable')) return 'not_assessable';
  const someCoreValue = core.some((c) => c.status === 'met' || c.status === 'partly_met');
  const allCoreMet = core.every((c) => c.status === 'met');
  if (someCoreValue && allCoreMet && supporting.every((c) => c.status === 'met')) return 'achieved';
  if (allCoreMet && supporting.some((c) => c.status === 'partly_met' || c.status === 'unmet' || c.status === 'blocked')) return 'mostly_achieved';
  if (someCoreValue && !allCoreMet) return 'partly_achieved';
  if (!someCoreValue && core.some((c) => c.status === 'unmet' || c.status === 'blocked')) return 'not_achieved';
  return 'not_assessable';
}

export function qualityIndexV1(ledger: ClassifiedCriterion[], controllableOverall: OverallAttainment): number | null {
  if (controllableOverall === 'not_assessable') return null;
  const bands: Record<Exclude<OverallAttainment, 'not_assessable'>, [number, number, number]> = {
    not_achieved: [0, 24, 24],
    partly_achieved: [25, 59, 34],
    mostly_achieved: [60, 84, 24],
    achieved: [85, 100, 15],
  };
  const weights: Record<CriterionImportance, number> = { core: 1, supporting: 0.5, optional: 0.25 };
  const controllable = ledger.filter((c) => c.status !== 'superseded' && c.status !== 'not_assessable' && !externallyBlocked(c));
  const denominator = controllable.reduce((sum, c) => sum + weights[c.importance], 0);
  const numerator = controllable.reduce((sum, c) => sum + weights[c.importance] * (c.status === 'met' ? 1 : c.status === 'partly_met' ? 0.5 : 0), 0);
  const fraction = denominator ? numerator / denominator : 0;
  const [floor, ceiling, width] = bands[controllableOverall];
  const value = Math.round((floor + width * fraction) * 10) / 10;
  return Math.min(ceiling, Math.max(floor, value));
}

export function deriveAttainment(ledger: ClassifiedCriterion[]): SessionReviewV2['attainment'] {
  const deliveredOverall = deriveOverall(ledger, 'delivered');
  const controllableOverall = deriveOverall(ledger, 'controllable');
  const summaries = Object.fromEntries(IMPORTANCES.map((importance) => [importance, summarizeAttainment(ledger, importance)])) as Record<CriterionImportance, CriterionAttainmentSummary>;
  return {
    deliveredOverall,
    controllableOverall,
    core: summaries.core,
    supporting: summaries.supporting,
    optional: summaries.optional,
    qualityIndexV1: qualityIndexV1(ledger, controllableOverall),
  };
}
