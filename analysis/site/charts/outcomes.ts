import type { ChartEntry, ChartContext } from '../lib.ts';
import { CHART_COLORS, escapeHtml, modelColorScale, renderJoinUnmatchedReasonsHtml } from '../lib.ts';
import type {
  OutcomeCorrelationData,
  OutcomeCorrelationDimension,
  OutcomeCorrelationDimensionName,
} from '../../scripts/contracts.ts';

/** Per-group sample count below which a group is flagged low-N. */
const LOW_N_THRESHOLD = 5;

const DIMENSION_ORDER: OutcomeCorrelationDimensionName[] = [
  'verificationUsage',
  'compaction',
  'thinkingLevel',
  'promptSizeBand',
  'pruningMode',
  'subagentParentModel',
];

export function dimensionTitle(dimension: OutcomeCorrelationDimension): string {
  switch (dimension.dimension) {
    case 'verificationUsage': return 'Verification usage';
    case 'compaction': return 'History compaction';
    case 'thinkingLevel': return 'Thinking level';
    case 'promptSizeBand': return 'Prompt size band';
    case 'pruningMode': return 'Pruning mode';
    case 'subagentParentModel': return 'Subagent parent model';
    default: return dimension.dimension;
  }
}

interface GroupPoint {
  value: string;
  mean: number;
  lower: number | null;
  upper: number | null;
  n: number;
  lowN: boolean;
  ciAvailable: boolean;
  nLabel: string;
}

function groupPoints(dimension: OutcomeCorrelationDimension): GroupPoint[] {
  return dimension.groups.map((group) => {
    const ci = group.meanCi95;
    const lowN = group.sessionCount < LOW_N_THRESHOLD;
    return {
      value: group.value,
      mean: group.meanQualityIndexV1,
      lower: ci?.lower ?? null,
      upper: ci?.upper ?? null,
      n: group.sessionCount,
      lowN,
      ciAvailable: ci !== null,
      nLabel: `n=${group.sessionCount}${lowN ? ' · low-N' : ''}`,
    };
  });
}

function differencesNote(dimension: OutcomeCorrelationDimension): string {
  if (dimension.differences.length === 0) {
    return dimension.groups.length <= 1
      ? 'Single behavioral group — no comparison available for this cohort.'
      : 'Multiple groups but no mean-difference interval could be estimated.';
  }
  const lines = dimension.differences.map((diff) => {
    const ci = diff.differenceCi95;
    const crossesZero = ci === null || (ci.lower <= 0 && ci.upper >= 0);
    const ciText = ci ? `95% CI ${ci.lower.toFixed(1)} to ${ci.upper.toFixed(1)}` : 'CI unavailable';
    const verdict = crossesZero ? 'not statistically clear' : 'statistically clear';
    const direction = diff.observedMeanDifference >= 0 ? 'higher' : 'lower';
    return `${diff.comparisonValue}: ${diff.observedMeanDifference >= 0 ? '+' : ''}${diff.observedMeanDifference.toFixed(1)} pts ${direction} than ${diff.referenceValue} (${ciText}, n=${diff.comparisonSessionCount} vs ${diff.referenceSessionCount}) — ${verdict}`;
  });
  return lines.join(' · ');
}

/**
 * Build a Vega-Lite spec for one correlation dimension: group means as points
 * with 95% CI error bars, sample-size labels, and low-N flags. Returns null
 * when the dimension has no groups.
 */
export function outcomeDimensionSpec(dimension: OutcomeCorrelationDimension): Record<string, unknown> | null {
  const points = groupPoints(dimension);
  if (points.length === 0) return null;

  // Keep one datum per group. Separate mean/CI layers can otherwise render
  // the same group twice when a confidence interval is available.
  const values = points.map((point) => ({ ...point }));

  const lowNCount = points.filter((p) => p.lowN).length;
  const description = `${dimensionTitle(dimension)}: ${dimension.description} Group means of qualityIndexV1 with 95% Student-t confidence intervals. ${lowNCount > 0 ? `${lowNCount} group(s) have fewer than ${LOW_N_THRESHOLD} sessions.` : ''}`;

  return {
    width: 'container',
    height: 220,
    description,
    data: { values },
    layer: [
      {
        transform: [{ filter: 'datum.ciAvailable' }],
        mark: { type: 'rule' as const, size: 3, opacity: 0.7 },
        encoding: {
          x: { field: 'value', type: 'nominal' as const, title: null, sort: points.map((p) => p.value), axis: { labelAngle: 0, labelLimit: 120 } },
          y: { field: 'lower', type: 'quantitative' as const, title: 'qualityIndexV1 (mean ± 95% CI)', scale: { domain: [0, 100] } },
          y2: { field: 'upper' },
          color: { field: 'value', type: 'nominal' as const, scale: modelColorScale(points.map((p) => p.value)), legend: null },
          tooltip: [
            { field: 'value', type: 'nominal' as const, title: 'Group' },
            { field: 'mean', type: 'quantitative' as const, title: 'Mean', format: '.1f' },
            { field: 'lower', type: 'quantitative' as const, title: 'CI lower', format: '.1f' },
            { field: 'upper', type: 'quantitative' as const, title: 'CI upper', format: '.1f' },
            { field: 'n', type: 'quantitative' as const, title: 'Sessions' },
          ],
        },
      },
      {
        mark: { type: 'circle' as const, filled: true, size: 160 },
        encoding: {
          x: { field: 'value', type: 'nominal' as const, sort: points.map((p) => p.value), title: null, axis: null },
          y: { field: 'mean', type: 'quantitative' as const, scale: { domain: [0, 100] } },
          color: { field: 'value', type: 'nominal' as const, scale: modelColorScale(points.map((p) => p.value)), legend: null },
          tooltip: [
            { field: 'value', type: 'nominal' as const, title: 'Group' },
            { field: 'mean', type: 'quantitative' as const, title: 'Mean qualityIndexV1', format: '.1f' },
            { field: 'n', type: 'quantitative' as const, title: 'Sessions' },
          ],
        },
      },
      {
        mark: { type: 'text' as const, dy: 16, fontSize: 10, fontWeight: 600 },
        encoding: {
          x: { field: 'value', type: 'nominal' as const, sort: points.map((p) => p.value), title: null, axis: null },
          y: { field: 'mean', type: 'quantitative' as const, scale: { domain: [0, 100] } },
          text: { field: 'nLabel', type: 'nominal' as const },
          color: {
            condition: { test: 'datum.lowN', value: CHART_COLORS.gold },
            value: CHART_COLORS.muted,
          },
        },
      },
    ],
  };
}

async function renderOutcomeDimension(ctx: ChartContext, name: OutcomeCorrelationDimensionName): Promise<void> {
  const correlations = ctx.outcomeCorrelations;
  const noteId = `outcome-${name}-note`;
  if (!correlations) {
    ctx.setNote(noteId, 'outcome-correlations.json is unavailable.', ctx.renderToken);
    await ctx.renderSpec(`chart-outcome-${name}`, null, 'Outcome-correlations bundle unavailable.', ctx.renderToken);
    return;
  }
  const dimension = correlations.dimensions.find((d) => d.dimension === name);
  if (!dimension) {
    ctx.setNote(noteId, `${name} dimension missing from the bundle.`, ctx.renderToken);
    await ctx.renderSpec(`chart-outcome-${name}`, null, `${name} dimension missing.`, ctx.renderToken);
    return;
  }
  const lowNGroups = dimension.groups.filter((g) => g.sessionCount < LOW_N_THRESHOLD).length;
  const untracked = dimension.untrackedSessionCount;
  ctx.setNote(
    noteId,
    `${dimensionTitle(dimension)} — ${differencesNote(dimension)}${lowNGroups > 0 ? ` · ${lowNGroups} low-N group(s)` : ''}${untracked > 0 ? ` · ${untracked} untracked session(s) excluded` : ''}. Observational, not causal.`,
    ctx.renderToken,
  );
  const spec = outcomeDimensionSpec(dimension);
  await ctx.renderSpec(
    `chart-outcome-${name}`,
    spec,
    `No reviewed sessions for the ${dimensionTitle(dimension)} dimension.`,
    ctx.renderToken,
  );
}

export const outcomeCharts: ChartEntry[] = DIMENSION_ORDER.map((name) => ({
  id: `chart-outcome-${name}`,
  runCohort: 'artifact' as const,
  render: async (ctx: ChartContext) => renderOutcomeDimension(ctx, name),
}));

/**
 * Build the evidence-reliability summary HTML (join loss, dominant-model skew,
 * ceiling saturation). Pure so it can be tested alongside the actionability
 * derivation.
 */
export function evidenceReliabilityHtml(
  correlations: OutcomeCorrelationData | null,
  evidence: import('../../scripts/contracts.ts').EvidenceReliabilityData | null,
  joinCoverage: import('../../scripts/contracts.ts').ReviewJoinCoverage | null,
): string {
  if (!correlations && !evidence && !joinCoverage) {
    return '<p class="empty-state">Evidence-reliability bundles unavailable.</p>';
  }
  const parts: string[] = [];
  if (joinCoverage) {
    const lossRate = joinCoverage.totalReviews > 0 ? joinCoverage.unmatchedCount / joinCoverage.totalReviews : 0;
    parts.push(`<article class="reliability-card"><h4>Review join loss</h4><p class="reliability-figure">${joinCoverage.unmatchedCount}/${joinCoverage.totalReviews} (${(lossRate * 100).toFixed(0)}%)</p><p class="reliability-detail">reviews could not be joined to a run and are excluded from behavior analysis. ${renderJoinUnmatchedReasonsHtml(joinCoverage.unmatchedByReason)}.</p></article>`);
  }
  if (correlations) {
    parts.push(`<article class="reliability-card"><h4>Analyzable cohort</h4><p class="reliability-figure">${correlations.analyzableSessionCount}</p><p class="reliability-detail">reviewed sessions with a non-null qualityIndexV1 that joined ≥1 run. ${correlations.unmatchedExcludedCount} unmatched excluded from every dimension.</p></article>`);
  }
  if (evidence) {
    const dominant = evidence.dominantFamily;
    parts.push(`<article class="reliability-card"><h4>Dominant-model skew</h4><p class="reliability-figure">${dominant ? `${(dominant.share * 100).toFixed(0)}%` : '—'}</p><p class="reliability-detail">${dominant ? `${escapeHtml(dominant.family)} dominates attributed sessions (${dominant.reviewedSessionCount} sessions).` : 'No attributed family.'} ${evidence.effectiveReviewedFamilies} effective reviewed families.</p></article>`);
    const ceiling = evidence.ceilingSaturation;
    parts.push(`<article class="reliability-card"><h4>Ceiling saturation</h4><p class="reliability-figure">${(ceiling.perfectRate * 100).toFixed(0)}%</p><p class="reliability-detail">perfect-score rate; ${(ceiling.achievedBandRate * 100).toFixed(0)}% in the top 'achieved' band. ${ceiling.distinctQualityIndexValues} distinct values; median ${ceiling.medianQualityIndexV1 ?? '—'}.</p></article>`);
  }
  return `<div class="reliability-grid">${parts.join('')}</div>`;
}
