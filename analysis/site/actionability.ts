/**
 * Pure derivation of the top-level "What to do differently" insight cards.
 *
 * Consumes the schema-v7 observational bundles (`outcome-correlations.json`,
 * `evidence-reliability.json`, and the review↔run `joinCoverage` aggregate) and
 * returns a structured list of insight cards. Every card carries quantified
 * evidence, a sample-size/uncertainty line, and observational-not-causal
 * language. When the evidence is too sparse or skewed to support a behavioral
 * recommendation, no actionable card is emitted — instead a `no-recommendation`
 * card explains exactly why.
 *
 * This module is DOM-free so it can be unit-tested directly.
 */
import type {
  EvidenceReliabilityData,
  OutcomeCorrelationData,
  OutcomeCorrelationDimension,
  OutcomeCorrelationDifference,
  ReviewJoinCoverage,
} from '../scripts/contracts.ts';

import { escapeHtml, renderJoinUnmatchedReasonsText } from './lib.ts';

export type InsightTone = 'actionable' | 'caveat' | 'reliability' | 'no-recommendation';

export interface InsightCard {
  id: string;
  tone: InsightTone;
  title: string;
  finding: string;
  evidence: string;
  caveat: string;
}

export interface ActionabilityResult {
  cards: InsightCard[];
  evidenceTooSkewed: boolean;
  skewReasons: string[];
}

/** Below this per-group sample count a difference is flagged low-N. */
export const MIN_GROUP_N = 5;
/** Below this analyzable-session count no behavioral recommendation is made. */
export const MIN_ANALYZABLE_SESSIONS = 10;
/** A single family above this share of reviewed sessions skews model evidence. */
export const DOMINANT_SHARE_THRESHOLD = 0.7;
/** Below this many effective reviewed families, model comparisons are thin. */
export const MIN_EFFECTIVE_FAMILIES = 3;
/** Above this perfect-score rate the index cannot distinguish good from great. */
export const CEILING_PERFECT_THRESHOLD = 0.5;

function fmtDiff(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}`;
}

function fmtCi(lower: number, upper: number): string {
  return `${Math.round(lower * 10) / 10} to ${Math.round(upper * 10) / 10}`;
}

function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** A difference is statistically clear when its 95% CI excludes zero. */
export function differenceExcludesZero(diff: OutcomeCorrelationDifference): boolean {
  if (diff.differenceCi95 === null) return false;
  return diff.differenceCi95.lower > 0 || diff.differenceCi95.upper < 0;
}

function lowN(diff: OutcomeCorrelationDifference): boolean {
  return diff.referenceSessionCount < MIN_GROUP_N || diff.comparisonSessionCount < MIN_GROUP_N;
}

/** Human-readable label for a correlation dimension. */
export function dimensionLabel(dimension: OutcomeCorrelationDimension): string {
  switch (dimension.dimension) {
    case 'verificationUsage': return 'Verification usage';
    case 'compaction': return 'History compaction';
    case 'thinkingLevel': return 'Thinking level';
    case 'promptSizeBand': return 'Prompt size';
    case 'pruningMode': return 'Pruning mode';
    case 'subagentParentModel': return 'Subagent parent model';
    default: return dimension.dimension;
  }
}

/** The largest-magnitude difference for a dimension, or null when none exist. */
export function largestDifference(dimension: OutcomeCorrelationDimension): OutcomeCorrelationDifference | null {
  if (dimension.differences.length === 0) return null;
  return [...dimension.differences].sort(
    (a, b) => Math.abs(b.observedMeanDifference) - Math.abs(a.observedMeanDifference),
  )[0] ?? null;
}

interface ReliabilityAssessment {
  tooSkewed: boolean;
  reasons: string[];
  dominantShare: number | null;
  effectiveFamilies: number | null;
  ceilingPerfect: number | null;
  analyzable: number | null;
}

/** Assess whether the evidence base is too sparse or skewed for recommendations. */
export function assessReliability(
  reliability: EvidenceReliabilityData | null,
  correlations: OutcomeCorrelationData | null,
): ReliabilityAssessment {
  const reasons: string[] = [];
  const analyzable = correlations?.analyzableSessionCount ?? null;
  const dominantShare = reliability?.dominantFamily?.share ?? null;
  const effectiveFamilies = reliability?.effectiveReviewedFamilies ?? null;
  const ceilingPerfect = reliability?.ceilingSaturation?.perfectRate ?? null;

  if (analyzable !== null && analyzable < MIN_ANALYZABLE_SESSIONS) {
    reasons.push(`only ${analyzable} analyzable reviewed sessions (need ≥${MIN_ANALYZABLE_SESSIONS})`);
  }
  if (dominantShare !== null && dominantShare > DOMINANT_SHARE_THRESHOLD) {
    reasons.push(`one model family dominates ${pct(dominantShare, 0)} of reviewed sessions`);
  }
  if (effectiveFamilies !== null && effectiveFamilies < MIN_EFFECTIVE_FAMILIES) {
    reasons.push(`only ${effectiveFamilies} effective reviewed families (need ≥${MIN_EFFECTIVE_FAMILIES})`);
  }
  if (ceilingPerfect !== null && ceilingPerfect > CEILING_PERFECT_THRESHOLD) {
    reasons.push(`${pct(ceilingPerfect, 0)} of sessions hit a perfect score (ceiling saturation)`);
  }

  return {
    tooSkewed: reasons.length > 0,
    reasons,
    dominantShare,
    effectiveFamilies,
    ceilingPerfect,
    analyzable,
  };
}

function behavioralCard(
  dimension: OutcomeCorrelationDimension,
  diff: OutcomeCorrelationDifference,
  evidenceTooSkewed: boolean,
): InsightCard {
  const label = dimensionLabel(dimension);
  const higher = diff.observedMeanDifference > 0;
  const ci = diff.differenceCi95;
  const clear = differenceExcludesZero(diff);
  const smallN = lowN(diff);
  const direction = higher ? 'higher' : 'lower';
  const finding = ci
    ? `${diff.comparisonValue} sessions scored ${fmtDiff(diff.observedMeanDifference)} points ${direction} than ${diff.referenceValue} (95% CI ${fmtCi(ci.lower, ci.upper)}).`
    : `${diff.comparisonValue} vs ${diff.referenceValue}: observed difference ${fmtDiff(diff.observedMeanDifference)} (CI not estimable).`;

  const evidence = `n=${diff.comparisonSessionCount} vs n=${diff.referenceSessionCount}${smallN ? ' · low-N' : ''}${ci ? '' : ' · CI unavailable'}`;

  const parts: string[] = ['Observational — grouping, not a controlled treatment; does not prove the behavior caused the outcome.'];
  if (!clear) parts.push('The 95% CI crosses zero, so this could be noise rather than a real difference.');
  if (smallN) parts.push(`At least one group has fewer than ${MIN_GROUP_N} sessions — treat as a hint, not a signal.`);
  if (evidenceTooSkewed) parts.push('Overall evidence is too skewed to turn this into a recommendation.');

  const tone: InsightTone = clear && !smallN && !evidenceTooSkewed ? 'actionable' : 'caveat';
  const titlePrefix = clear ? 'Associated with' : 'No clear signal —';
  return {
    id: `behavior-${dimension.dimension}`,
    tone,
    title: `${label}: ${titlePrefix} ${higher ? 'higher' : 'lower'} quality`,
    finding,
    evidence,
    caveat: parts.join(' '),
  };
}

function noSignalCard(dimension: OutcomeCorrelationDimension): InsightCard {
  return {
    id: `behavior-${dimension.dimension}`,
    tone: 'caveat',
    title: `${dimensionLabel(dimension)}: no clear difference`,
    finding: `No statistically clear qualityIndexV1 difference across ${dimension.groups.length} group(s) (all 95% difference intervals cross zero).`,
    evidence: `${dimension.includedSessionCount} sessions${dimension.untrackedSessionCount > 0 ? ` · ${dimension.untrackedSessionCount} untracked` : ''}`,
    caveat: 'Observational only. A wide interval here means the data cannot distinguish the groups, not that they are equal.',
  };
}

function joinLossCard(joinCoverage: ReviewJoinCoverage): InsightCard | null {
  if (joinCoverage.totalReviews === 0) return null;
  const lossRate = joinCoverage.unmatchedCount / joinCoverage.totalReviews;
  const reasons = renderJoinUnmatchedReasonsText(joinCoverage.unmatchedByReason);
  return {
    id: 'reliability-join-loss',
    tone: 'reliability',
    title: 'Review join loss',
    finding: `${joinCoverage.unmatchedCount} of ${joinCoverage.totalReviews} reviews (${pct(lossRate, 0)}) could not be joined to a run and are excluded from behavior analysis.`,
    evidence: `joined ${joinCoverage.joinedCount} · unmatched ${joinCoverage.unmatchedCount} · ${reasons}`,
    caveat: 'Unmatched reviews are counted toward ceiling saturation but cannot be attributed to a behavior or model. No fuzzy path matching is used to recover a join.',
  };
}

function dominantSkewCard(reliability: EvidenceReliabilityData): InsightCard | null {
  const dominant = reliability.dominantFamily;
  if (!dominant) return null;
  return {
    id: 'reliability-dominant-skew',
    tone: 'reliability',
    title: 'Dominant-model skew',
    finding: `${dominant.family} accounts for ${pct(dominant.share, 0)} of attributed reviewed sessions (${dominant.reviewedSessionCount} sessions).`,
    evidence: `${reliability.effectiveReviewedFamilies} effective reviewed families · ${reliability.attributedSessionCount} attributed sessions`,
    caveat: 'When one family dominates, model-vs-model comparisons rest on thin evidence for the others. Family attribution uses equal fractional split across a session\'s joined-run families.',
  };
}

function ceilingCard(reliability: EvidenceReliabilityData): InsightCard | null {
  const ceiling = reliability.ceilingSaturation;
  return {
    id: 'reliability-ceiling',
    tone: 'reliability',
    title: 'Ceiling saturation',
    finding: `${pct(ceiling.perfectRate, 0)} of reviewed sessions hit a perfect qualityIndexV1; ${pct(ceiling.achievedBandRate, 0)} sit in the top 'achieved' band.`,
    evidence: `median index ${ceiling.medianQualityIndexV1 ?? '—'} · ${ceiling.distinctQualityIndexValues} distinct values`,
    caveat: 'High ceiling saturation means the index cannot distinguish good from great outcomes, so small quality differences are not meaningful.',
  };
}

function noRecommendationCard(reasons: string[]): InsightCard {
  return {
    id: 'no-recommendation',
    tone: 'no-recommendation',
    title: 'No behavioral recommendation — evidence too sparse or skewed',
    finding: `No "what to do differently" recommendation is made because: ${reasons.join('; ')}.`,
    evidence: 'See the reliability cards below for the specific limits.',
    caveat: 'This is intentional: acting on sparse or skewed observational data risks chasing noise. Collect more reviewed sessions across more model families before drawing behavioral conclusions.',
  };
}

/**
 * Derive the full set of insight cards. Reliability/no-recommendation cards are
 * always emitted when their data is present; behavioral cards are downgraded to
 * caveats (rather than removed) when the evidence base is too skewed.
 */
export function deriveActionabilityInsights(args: {
  correlations: OutcomeCorrelationData | null;
  reliability: EvidenceReliabilityData | null;
  joinCoverage: ReviewJoinCoverage | null;
}): ActionabilityResult {
  const { correlations, reliability, joinCoverage } = args;
  const assessment = assessReliability(reliability, correlations);
  const cards: InsightCard[] = [];

  // Behavioral cards (one per dimension with a comparison).
  if (correlations) {
    for (const dimension of correlations.dimensions) {
      const diff = largestDifference(dimension);
      if (diff) {
        cards.push(behavioralCard(dimension, diff, assessment.tooSkewed));
      } else if (dimension.groups.length >= 2) {
        cards.push(noSignalCard(dimension));
      }
      // Single-group dimensions (e.g. everyone on 'auto' pruning) carry no
      // comparison and are intentionally omitted from the insight cards.
    }
  }

  // Reliability cards surface join loss, skew, and ceiling saturation.
  if (joinCoverage) {
    const card = joinLossCard(joinCoverage);
    if (card) cards.push(card);
  }
  if (reliability) {
    const skew = dominantSkewCard(reliability);
    if (skew) cards.push(skew);
    const ceiling = ceilingCard(reliability);
    if (ceiling) cards.push(ceiling);
  }

  if (assessment.tooSkewed) {
    cards.push(noRecommendationCard(assessment.reasons));
  }

  return { cards, evidenceTooSkewed: assessment.tooSkewed, skewReasons: assessment.reasons };
}

/** Render insight cards into HTML. Kept here so the derivation and its labels stay in sync. */
export function renderInsightCards(result: ActionabilityResult): string {
  if (result.cards.length === 0) {
    return '<p class="empty-state">No insight bundles available. Insight cards require outcome-correlations.json and evidence-reliability.json.</p>';
  }
  const toneLabel: Record<InsightTone, string> = {
    actionable: 'Observation',
    caveat: 'Uncertain',
    reliability: 'Evidence limit',
    'no-recommendation': 'No recommendation',
  };
  return `<div class="insight-grid">${result.cards.map((card) => `
    <article class="insight-card insight-${card.tone}" aria-label="${escapeHtml(card.title)}">
      <p class="insight-tone">${toneLabel[card.tone]}</p>
      <h3>${escapeHtml(card.title)}</h3>
      <p class="insight-finding">${escapeHtml(card.finding)}</p>
      <p class="insight-evidence">${escapeHtml(card.evidence)}</p>
      <p class="insight-caveat">${escapeHtml(card.caveat)}</p>
    </article>`).join('')}
  </div>`;
}
