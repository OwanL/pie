import {
  SITE_DATA_SCHEMA_VERSION,
  type LeaderboardDimension,
  type ModelLeaderboardData,
  type ModelLeaderboardProviderBreakdown,
  type ModelLeaderboardRow,
  type PreparedAnalyticsData,
  type PreparedRunRow,
  type TaskComplexityBand,
} from './contracts.ts';
import { LEADERBOARD_WEIGHTS as WEIGHTS } from './leaderboard-scoring.ts';
import { computeWorkloadIntensityScores } from './complexity-scoring.ts';
import {
  computeGenericPreTaskComplexityProfile,
  extractPreTaskSignals,
  selectPreTaskComplexityRepresentativeRuns,
  type PreTaskComplexityTask,
} from './pre-task-complexity.ts';

const BANDS: TaskComplexityBand[] = ['low', 'medium', 'high'];
const K = { review: 8, process: 20 } as const;
const SOURCE_WEIGHTS = { review: 1, process: 0 } as const;
const NEUTRAL = 0.5;

type Source = keyof typeof K;
type EvidenceTier = ModelLeaderboardRow['evidenceTier'];
interface Observation {
  family: string;
  source: Source;
  value: number;
  share: number;
  taskId: string;
  band: TaskComplexityBand;
  transcriptOnly: boolean;
  mixed: boolean;
  complexityScore: number;
}
interface FamilyStats {
  family: string;
  canonicalRuns: PreparedRunRow[];
  observations: Observation[];
  transcriptSessions: Set<string>;
  thinking: Map<string, { runCount: number; attributionMass: number }>;
  providers: Map<string, { runCount: number; transcriptSessionIds: Set<string>; transcriptEvidenceMass: number }>;
}

function clamp(value: number, min = 0, max = 1): number { return Math.min(max, Math.max(min, value)); }
function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function median(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
  return round(value, digits);
}
function familyOf(run: PreparedRunRow): string { return run.modelFamily?.trim() || run.modelId?.trim() || '(unknown)'; }
function thinkingOf(value: string | null): string { return value?.trim() || '(unspecified)'; }
function taskOf(run: PreparedRunRow): string { return run.taskGroupId || run.runId; }
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
function laterRun(left: PreparedRunRow, right: PreparedRunRow): PreparedRunRow {
  const delta = timestamp(left.startedAt) - timestamp(right.startedAt);
  return delta > 0 || (delta === 0 && left.runId.localeCompare(right.runId) > 0) ? left : right;
}
function latestByTaskAndFamily(runs: PreparedRunRow[]): PreparedRunRow[] {
  const selected = new Map<string, PreparedRunRow>();
  for (const run of runs) {
    const key = `${taskOf(run)}\u0000${familyOf(run)}`;
    const current = selected.get(key);
    selected.set(key, current ? laterRun(run, current) : run);
  }
  return [...selected.values()];
}
function weightedAvailable(parts: Array<{ value: number | null; weight: number }>): number | null {
  const available = parts.filter((part): part is { value: number; weight: number } => part.value !== null);
  const weight = available.reduce((sum, part) => sum + part.weight, 0);
  return weight ? available.reduce((sum, part) => sum + part.value * part.weight, 0) / weight : null;
}
function canonicalProcessValue(run: PreparedRunRow): number | null {
  const verification = run.verificationTotalCount > 0 ? (run.verificationState === 'passing' ? 1 : 0) : null;
  const terminal = run.backendErrorCount > 0
    ? 0
    : run.finalizationReason === 'closed' || run.finalizationReason === 'new_task' ? 1 : null;
  const tools = run.toolCallCount > 0
    ? 1 - Math.min(1, run.toolFailureCount / Math.max(1, run.toolCallCount))
    : null;
  return weightedAvailable([
    { value: verification, weight: 0.5 },
    { value: terminal, weight: 0.3 },
    { value: tools, weight: 0.2 },
  ]);
}
function logit(value: number): number { const p = clamp(value, 0.01, 0.99); return Math.log(p / (1 - p)); }
function logistic(value: number): number { return 1 / (1 + Math.exp(-value)); }
function sourceCount(observations: Observation[], source: Source): number {
  return observations.filter((o) => o.source === source).length;
}

function nativeDimension(values: number[], native: (value: number) => number): LeaderboardDimension {
  const observed = mean(values);
  return { value: observed === null ? null : round(native(observed), 3), lowerBound: null, shrunk: null, n: values.length };
}

/** Browser-compatible fallback. Historical transcripts and sidecar reviews are available through createModelLeaderboard. */
export function createModelLeaderboardFromRuns(runs: PreparedRunRow[]): ModelLeaderboardData {
  return buildLeaderboard({ runs, sessionReviewsV2: [], historicalSessions: [] });
}

export function createModelLeaderboard(prepared: PreparedAnalyticsData): ModelLeaderboardData {
  return buildLeaderboard(prepared);
}

function buildLeaderboard(prepared: Pick<PreparedAnalyticsData, 'runs' | 'sessionReviewsV2' | 'historicalSessions'>): ModelLeaderboardData {
  const completed = prepared.runs.filter((run) => run.status !== 'open');
  const currentHarnessCompleted = completed.filter((run) => run.isCurrentHarness === true);
  const stable = completed.filter((run) => !run.mixedModelConfig && !run.mixedTreatmentConfig);
  const currentHarnessStable = currentHarnessCompleted.filter((run) => !run.mixedModelConfig && !run.mixedTreatmentConfig);
  const canonicalRepresentatives = latestByTaskAndFamily(stable);
  const currentHarnessCanonicalRepresentatives = latestByTaskAndFamily(currentHarnessStable);
  const canonicalRepresentativeRunIds = new Set(canonicalRepresentatives.map((run) => run.runId));
  const currentHarnessCanonicalTaskIdsByFamily = new Map<string, Set<string>>();
  for (const run of currentHarnessCanonicalRepresentatives) {
    const tasks = currentHarnessCanonicalTaskIdsByFamily.get(familyOf(run)) ?? new Set<string>();
    tasks.add(taskOf(run));
    currentHarnessCanonicalTaskIdsByFamily.set(familyOf(run), tasks);
  }

  const preTasks: PreTaskComplexityTask[] = selectPreTaskComplexityRepresentativeRuns(stable).map((run) => ({
    taskId: `canonical:${taskOf(run)}`,
    ...extractPreTaskSignals(run),
  }));
  for (const session of prepared.historicalSessions.filter((item) => item.transcriptOnly)) {
    preTasks.push({
      taskId: `transcript:${session.sessionPathHash}`,
      initialUserMessageChars: session.firstUserMessageChars,
      attachmentCount: 0,
      contextFileCount: 0,
    });
  }
  const complexity = computeGenericPreTaskComplexityProfile(preTasks);
  const targetCounts: Record<TaskComplexityBand, number> = { low: 0, medium: 0, high: 0 };
  for (const band of complexity.bands.values()) targetCounts[band] += 1;
  const targetTotal = preTasks.length;
  const targetWeights: Record<TaskComplexityBand, number> = {
    low: targetTotal ? targetCounts.low / targetTotal : 0,
    medium: targetTotal ? targetCounts.medium / targetTotal : 1,
    high: targetTotal ? targetCounts.high / targetTotal : 0,
  };

  const observations: Observation[] = [];
  // Runtime process observations are deliberately current-harness-only. The
  // review channel above still uses the full historical run population.
  for (const run of currentHarnessCanonicalRepresentatives) {
    const family = familyOf(run);
    const taskId = `canonical:${taskOf(run)}`;
    const band = complexity.bands.get(taskId) ?? 'medium';
    const process = canonicalProcessValue(run);
    if (process !== null) observations.push({ family, source: 'process', value: process, share: 1, taskId: taskOf(run), band, transcriptOnly: false, mixed: false, complexityScore: complexity.scores.get(taskId) ?? NEUTRAL });
  }

  // Accepted V2 production reviews form the sole quality channel. Reviewer
  // orchestration may be mixed-bucket or small-only; both profiles are retained.
  const stableRunsBySessionId = new Map<string, PreparedRunRow[]>();
  for (const run of stable) {
    const sessionRuns = stableRunsBySessionId.get(run.sessionId) ?? [];
    sessionRuns.push(run);
    stableRunsBySessionId.set(run.sessionId, sessionRuns);
  }
  const historicalBySessionId = new Map(prepared.historicalSessions.map((session) => [session.sessionId, session]));
  const transcriptOnlyReviewFamiliesBySessionId = new Map<string, Set<string>>();
  for (const review of prepared.sessionReviewsV2) {
    const quality = review.attainment.qualityIndexV1;
    if (quality === null || review.identityFallback || !review.blindingApplied) continue;

    const history = historicalBySessionId.get(review.sessionId);
    const historicalAttributions = (history?.attributions ?? [])
      .filter((attribution) => attribution.modelFamily !== '(unknown)' && attribution.share > 0)
      .map((attribution) => ({ family: attribution.modelFamily, share: attribution.share }));
    let attributions: Array<{ family: string; share: number }> = [];
    let matchedFamilies = new Set<string>();
    let band: TaskComplexityBand = 'medium';
    let complexityScore = NEUTRAL;

    if (review.joinKey === 'session_id') {
      // Joined reviews must still attach to the latest canonical representative;
      // otherwise a reviewed superseded retry would double-count one task.
      const sessionStableRuns = stableRunsBySessionId.get(review.sessionId) ?? [];
      const matchedRuns = sessionStableRuns.filter((run) => canonicalRepresentativeRunIds.has(run.runId));
      if (!matchedRuns.length) continue;
      matchedFamilies = new Set(matchedRuns.map(familyOf).filter((family) => family !== '(unknown)'));
      const allStableRunFamilies = new Set(sessionStableRuns.map(familyOf).filter((family) => family !== '(unknown)'));
      // Successful transcript work can name a contributing family whose run
      // snapshot is absent. Preserve it, but do not revive a family whose run is
      // present and was deliberately removed as a superseded retry.
      attributions = historicalAttributions.filter((attribution) => matchedFamilies.has(attribution.family) || !allStableRunFamilies.has(attribution.family));
      if (!attributions.length) {
        const families = [...matchedFamilies];
        attributions = families.map((family) => ({ family, share: 1 / families.length }));
      }
      const representative = matchedRuns.reduce<PreparedRunRow | undefined>((latest, run) => latest ? laterRun(run, latest) : run, undefined);
      if (representative) {
        const taskKey = `canonical:${taskOf(representative)}`;
        band = complexity.bands.get(taskKey) ?? 'medium';
        complexityScore = complexity.scores.get(taskKey) ?? NEUTRAL;
      }
    } else if (review.joinKey === 'unmatched' && history && historicalAttributions.length) {
      // A stable-ID reviewed transcript is direct model-attribution evidence even
      // when its run snapshot is absent. Successful-token shares avoid counting
      // transient model selections, while the review remains unmatched for every
      // run-dependent correlation and canonical-task coverage metric.
      attributions = historicalAttributions;
      const taskKey = `transcript:${history.sessionPathHash}`;
      band = complexity.bands.get(taskKey) ?? 'medium';
      complexityScore = complexity.scores.get(taskKey) ?? NEUTRAL;
    } else {
      continue;
    }

    const total = attributions.reduce((sum, attribution) => sum + attribution.share, 0);
    if (!total) continue;
    for (const attribution of attributions) {
      const transcriptOnly = !matchedFamilies.has(attribution.family);
      if (transcriptOnly) {
        const families = transcriptOnlyReviewFamiliesBySessionId.get(review.sessionId) ?? new Set<string>();
        families.add(attribution.family);
        transcriptOnlyReviewFamiliesBySessionId.set(review.sessionId, families);
      }
      const taskId = transcriptOnly && history ? history.sessionPathHash : review.sessionId;
      observations.push({ family: attribution.family, source: 'review', value: quality / 100, share: attribution.share / total, taskId, band, transcriptOnly, mixed: attributions.length > 1, complexityScore });
    }
  }


  const families = new Map<string, FamilyStats>();
  const getFamily = (family: string): FamilyStats => {
    let value = families.get(family);
    if (!value) {
      value = { family, canonicalRuns: [], observations: [], transcriptSessions: new Set(), thinking: new Map(), providers: new Map() };
      families.set(family, value);
    }
    return value;
  };
  // Seed runtime-only diagnostics from the current harness. Historical families
  // remain visible only when a V2 review observation below supplies quality
  // evidence; legacy runtime alone must not create empty leaderboard rows.
  for (const run of currentHarnessCompleted) {
    const stats = getFamily(familyOf(run));
    stats.canonicalRuns.push(run);
    const thinking = thinkingOf(run.thinkingLevel);
    const t = stats.thinking.get(thinking) ?? { runCount: 0, attributionMass: 0 };
    t.runCount += 1; t.attributionMass += 1; stats.thinking.set(thinking, t);
    const provider = run.modelId?.trim() || '(unknown)';
    const p = stats.providers.get(provider) ?? { runCount: 0, transcriptSessionIds: new Set(), transcriptEvidenceMass: 0 };
    p.runCount += 1;
    stats.providers.set(provider, p);
  }
  for (const observation of observations) {
    const stats = getFamily(observation.family);
    stats.observations.push(observation);
    if (observation.transcriptOnly) stats.transcriptSessions.add(observation.taskId);
  }
  for (const session of prepared.historicalSessions.filter((item) => transcriptOnlyReviewFamiliesBySessionId.has(item.sessionId))) {
    const reviewFamilies = transcriptOnlyReviewFamiliesBySessionId.get(session.sessionId)!;
    for (const attribution of session.attributions.filter((a) => a.modelFamily !== '(unknown)' && a.share > 0
      && reviewFamilies.has(a.modelFamily))) {
      const stats = getFamily(attribution.modelFamily);
      // Count every unique transcript-only session attributed to a family regardless of
      // process-value availability (processEvidenceMass stays separate, from observations).
      stats.transcriptSessions.add(session.sessionPathHash);
      const thinking = thinkingOf(attribution.thinkingLevel);
      const t = stats.thinking.get(thinking) ?? { runCount: 0, attributionMass: 0 };
      t.attributionMass += attribution.share; stats.thinking.set(thinking, t);
      // Provider breakdown runCount stays canonical only — transcripts do not increment it.
      // Transcript-only sessions and fractional evidence mass are tracked separately so
      // transcript data remains visible without inflating canonical counts.
      const p = stats.providers.get(attribution.modelId) ?? { runCount: 0, transcriptSessionIds: new Set(), transcriptEvidenceMass: 0 };
      p.transcriptSessionIds.add(session.sessionPathHash);
      p.transcriptEvidenceMass += attribution.share;
      stats.providers.set(attribution.modelId, p);
    }
  }

  for (const stats of families.values()) {
    if (stats.providers.size === 0) {
      stats.providers.set('(unknown)', { runCount: 0, transcriptSessionIds: new Set(), transcriptEvidenceMass: 0 });
    }
  }

  const sourceOverall = {} as Record<Source, number>;
  const sourceBandPrior = {} as Record<Source, Record<TaskComplexityBand, number>>;
  for (const source of ['review', 'process'] as Source[]) {
    const all = observations.filter((o) => o.source === source);
    const mass = all.reduce((sum, o) => sum + o.share, 0);
    sourceOverall[source] = mass ? all.reduce((sum, o) => sum + o.share * o.value, 0) / mass : NEUTRAL;
    sourceBandPrior[source] = { low: sourceOverall[source], medium: sourceOverall[source], high: sourceOverall[source] };
    for (const band of BANDS) {
      const cell = all.filter((o) => o.band === band);
      const cellMass = cell.reduce((sum, o) => sum + o.share, 0);
      if (cellMass) sourceBandPrior[source][band] = cell.reduce((sum, o) => sum + o.share * o.value, 0) / cellMass;
    }
  }

  interface SourceEstimate { theta: number; direct: number | null; mass: number; variance: number }
  const estimates = new Map<string, Record<Source, SourceEstimate>>();
  for (const stats of families.values()) {
    const bySource = {} as Record<Source, SourceEstimate>;
    for (const source of ['review', 'process'] as Source[]) {
      const directObs = stats.observations.filter((o) => o.source === source);
      const directMass = directObs.reduce((sum, o) => sum + o.share, 0);
      const direct = directMass ? directObs.reduce((sum, o) => sum + o.share * o.value, 0) / directMass : null;
      if (source === 'review') {
        const reviewSum = directObs.reduce((sum, observation) => sum + observation.share * observation.value, 0);
        const theta = (reviewSum + K.review * sourceOverall.review) / (directMass + K.review);
        const variance = theta * (1 - theta) / (directMass + K.review + 1);
        bySource[source] = { theta: clamp(theta), direct, mass: directMass, variance };
        continue;
      }
      let theta = 0;
      let variance = 0;
      for (const band of BANDS) {
        const weight = targetWeights[band];
        if (!weight) continue;
        const cell = directObs.filter((o) => o.band === band);
        const mass = cell.reduce((sum, o) => sum + o.share, 0);
        const sum = cell.reduce((total, o) => total + o.share * o.value, 0);
        const posterior = (sum + K[source] * sourceBandPrior[source][band]) / (mass + K[source]);
        theta += weight * posterior;
        variance += weight * weight * posterior * (1 - posterior) / (mass + K[source] + 1);
      }
      bySource[source] = { theta: clamp(theta), direct, mass: directMass, variance };
    }
    estimates.set(stats.family, bySource);
  }

  const pooled = {} as Record<Source, number>;
  const spread = {} as Record<Source, number>;
  for (const source of ['review', 'process'] as Source[]) {
    let pooledTheta = source === 'review' ? sourceOverall.review : 0;
    if (source !== 'review') for (const band of BANDS) pooledTheta += targetWeights[band] * sourceBandPrior[source][band];
    pooled[source] = clamp(pooledTheta || NEUTRAL);
    const logits = [...estimates.values()].map((value) => logit(value[source].theta));
    const center = logit(pooled[source]);
    spread[source] = logits.length ? Math.sqrt(logits.reduce((sum, value) => sum + (value - center) ** 2, 0) / logits.length) : 0;
  }

  const workload = computeWorkloadIntensityScores(currentHarnessCompleted);
  const eligibleReviewedSessionIds = new Set(prepared.sessionReviewsV2
    .filter((review) => review.attainment.qualityIndexV1 !== null
      && !review.identityFallback
      && review.blindingApplied
      && review.joinKey === 'session_id'
      && (stableRunsBySessionId.get(review.sessionId) ?? []).some((run) => canonicalRepresentativeRunIds.has(run.runId)))
    .map((review) => review.sessionId));
  const latentByFamily = new Map<string, number>();
  const rows: ModelLeaderboardRow[] = [];
  for (const stats of families.values()) {
    const source = estimates.get(stats.family)!;
    let latent = 0;
    let latentVariance = 0;
    for (const key of ['review', 'process'] as Source[]) {
      const divisor = Math.max(0.5, spread[key]);
      const z = (logit(source[key].theta) - logit(pooled[key])) / divisor;
      latent += SOURCE_WEIGHTS[key] * z;
      const derivative = 1 / (clamp(source[key].theta, 0.01, 0.99) * (1 - clamp(source[key].theta, 0.01, 0.99)) * divisor);
      latentVariance += SOURCE_WEIGHTS[key] ** 2 * source[key].variance * derivative ** 2;
    }
    latentByFamily.set(stats.family, latent);
    const score = logistic(latent);
    const sd = Math.sqrt(Math.max(0, latentVariance));
    const reviewMass = source.review.mass;
    const evidenceTier: EvidenceTier = reviewMass >= 3 ? 'review-backed' : reviewMass > 0 ? 'thin-review' : 'telemetry-only';
    const reviewObservations = stats.observations.filter((observation) => observation.source === 'review');
    const canonicalTasks = new Set(canonicalRepresentatives.filter((run) => familyOf(run) === stats.family).map(taskOf));
    const currentHarnessCanonicalTasks = currentHarnessCanonicalTaskIdsByFamily.get(stats.family) ?? new Set<string>();
    const transcriptReviewTasks = new Set(reviewObservations.filter((observation) => observation.transcriptOnly).map((observation) => observation.taskId));
    const attributableTaskCount = canonicalTasks.size + transcriptReviewTasks.size;
    const toolValues = stats.canonicalRuns.filter((run) => run.toolCallCount > 0).map((run) => 1 - Math.min(1, run.toolFailureCount / run.toolCallCount));
    const verificationValues = stats.canonicalRuns.filter((run) => run.verificationTotalCount > 0).map((run) => run.verificationState === 'passing' ? 1 : 0);
    const costs = stats.canonicalRuns.map((run) => run.totalEstimatedCostUsd).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const meanReviewedComplexity = reviewMass
      ? reviewObservations.reduce((sum, observation) => sum + observation.complexityScore * observation.share, 0) / reviewMass
      : null;
    const bandCounts: Record<TaskComplexityBand, number> = { low: 0, medium: 0, high: 0 };
    for (const observation of reviewObservations) bandCounts[observation.band] += observation.share;
    const subagentRuns = stats.canonicalRuns.filter((run) => run.subagentCallCount > 0);
    const mixedAttributionMass = reviewObservations.filter((observation) => observation.mixed).reduce((sum, observation) => sum + observation.share, 0);
    const dimensions = {
      fileChurn: nativeDimension(stats.canonicalRuns.map((run) => run.editRevisitRate).filter((v): v is number => v !== null), (v) => v),
      toolReliability: nativeDimension(toolValues, (v) => v),
      verificationPassRate: nativeDimension(verificationValues, (v) => v),
      tokenEfficiency: nativeDimension(stats.canonicalRuns.map((run) => run.tokenEfficiency).filter((v): v is number => v !== null).map((v) => Math.min(50, v)), (v) => v),
    };
    dimensions.fileChurn.shrunk = dimensions.fileChurn.value === null ? null : round(1 - dimensions.fileChurn.value);
    dimensions.toolReliability.shrunk = toolValues.length ? round(mean(toolValues)!) : null;
    dimensions.verificationPassRate.shrunk = verificationValues.length ? round(mean(verificationValues)!) : null;
    dimensions.tokenEfficiency.shrunk = dimensions.tokenEfficiency.value === null ? null : round(1 - Math.min(1, dimensions.tokenEfficiency.value / 50));
    const evidenceWeight = reviewMass / (reviewMass + K.review);
    rows.push({
      modelId: stats.family, thinkingLevel: '(all)',
      thinkingLevels: [...stats.thinking.entries()].map(([thinkingLevel, value]) => ({ thinkingLevel, runCount: value.runCount, attributionMass: round(value.attributionMass) })).sort((a, b) => b.attributionMass - a.attributionMass || a.thinkingLevel.localeCompare(b.thinkingLevel)),
      runCount: stats.canonicalRuns.length,
      effectiveTaskCount: round(reviewMass),
      attributableRunCount: stats.canonicalRuns.filter((run) => !run.mixedModelConfig && !run.mixedTreatmentConfig).length,
      attributableTaskCount,
      scoringCoverage: attributableTaskCount ? round(reviewMass / attributableTaskCount) : null,
      scoringCoverageGateFailed: false,
      mixedModelExcludedCount: completed.filter((run) => familyOf(run) === stats.family && eligibleReviewedSessionIds.has(run.sessionId) && run.mixedModelConfig).length,
      mixedTreatmentExcludedCount: completed.filter((run) => familyOf(run) === stats.family && eligibleReviewedSessionIds.has(run.sessionId) && !run.mixedModelConfig && run.mixedTreatmentConfig).length,
      v2ReviewCount: round(reviewMass),
      meanQualityIndexV1: source.review.direct === null ? null : round(source.review.direct * 100, 1),
      reviewEvidenceCount: sourceCount(stats.observations, 'review'), reviewEvidenceMass: round(reviewMass),
      processEvidenceCount: sourceCount(stats.observations, 'process'), processEvidenceMass: round(source.process.mass),
      canonicalTaskCount: currentHarnessCanonicalTasks.size, transcriptOnlySessionCount: stats.transcriptSessions.size,
      mixedAttributionMass: round(mixedAttributionMass), evidenceTier,
      reviewChannelScore: source.review.direct === null ? null : round(source.review.theta),
      processChannelScore: source.process.direct === null ? null : round(source.process.theta),
      compositeScore: stats.family === '(unknown)' || reviewMass === 0 ? null : round(score),
      scoreInterval80: stats.family === '(unknown)' || reviewMass === 0 ? null : { lower: round(logistic(latent - 1.282 * sd)), upper: round(logistic(latent + 1.282 * sd)), level: 0.8, bestRank: 0, worstRank: 0 },
      unadjustedCompositeScore: reviewMass === 0 ? null : round(score), caseMixAdjustment: null, caseMixAdjusted: false, caseMixBandOverlapGateFailed: false,
      rank: null, evidenceWeight: round(evidenceWeight), reliabilityFactor: round(evidenceWeight), dimensions,
      medianCostUsd: median(costs, 4), meanPreTaskComplexity: meanReviewedComplexity === null ? null : round(meanReviewedComplexity),
      taskComplexityBandCounts: { low: round(bandCounts.low), medium: round(bandCounts.medium), high: round(bandCounts.high) }, caseMixOverlap: 1,
      meanWorkloadIntensity: stats.canonicalRuns.length ? round(mean(stats.canonicalRuns.map((run) => workload.get(run.runId) ?? NEUTRAL))!) : null,
      meanTaskComplexity: stats.canonicalRuns.length ? round(mean(stats.canonicalRuns.map((run) => workload.get(run.runId) ?? NEUTRAL))!) : null,
      difficultyEmphasized: false,
      subagentRunCount: subagentRuns.length,
      subagentUsageRate: stats.canonicalRuns.length ? round(subagentRuns.length / stats.canonicalRuns.length) : null,
      avgSubagentTasksPerRun: subagentRuns.length ? round(mean(subagentRuns.map((run) => run.subagentTaskCount))!, 2) : null,
      medianDurationMs: median(stats.canonicalRuns.map((run) => run.busyDurationMs)),
      medianTokenEfficiency: median(stats.canonicalRuns.map((run) => run.tokenEfficiency).filter((v): v is number => v !== null), 3),
      providers: [...stats.providers.entries()].map(([modelId, value]): ModelLeaderboardProviderBreakdown => ({ modelId, runCount: value.runCount, transcriptOnlySessionCount: value.transcriptSessionIds.size, transcriptEvidenceMass: round(value.transcriptEvidenceMass) })).sort((a, b) => b.runCount - a.runCount || a.modelId.localeCompare(b.modelId)),
    });
  }

  rows.sort((a, b) => {
    // Unranked rows (compositeScore === null, e.g. the '(unknown)' family) sort after ranked rows
    // so the rank sequence is contiguous and no ranked row follows an unranked one.
    const aRanked = a.compositeScore !== null ? 1 : 0;
    const bRanked = b.compositeScore !== null ? 1 : 0;
    if (aRanked !== bRanked) return bRanked - aRanked;
    return (latentByFamily.get(b.modelId) ?? -Infinity) - (latentByFamily.get(a.modelId) ?? -Infinity)
      || b.reviewEvidenceMass - a.reviewEvidenceMass
      || a.modelId.localeCompare(b.modelId);
  });
  const rankedRows = rows.filter((row) => row.compositeScore !== null);
  rankedRows.forEach((row, index) => { row.rank = index + 1; });
  for (const row of rankedRows) {
    const interval = row.scoreInterval80!;
    interval.bestRank = Math.min(rankedRows.length, 1 + rankedRows.filter((other) => other !== row && other.scoreInterval80!.lower > interval.upper).length);
    interval.worstRank = Math.min(rankedRows.length, 1 + rankedRows.filter((other) => other !== row && other.scoreInterval80!.upper >= interval.lower).length);
  }

  return {
    schemaVersion: SITE_DATA_SCHEMA_VERSION,
    sourceLabels: { review: 'V2 qualityIndexV1', process: 'Objective runtime process telemetry' },
    rows,
    sourceWeights: SOURCE_WEIGHTS,
    sourcePriors: { review: round(pooled.review), process: round(pooled.process) },
    sourceLogitSpreads: { review: round(spread.review), process: round(spread.process) },
    shrinkage: K,
    weights: WEIGHTS,
    minimumEffectiveTasks: 0,
    minimumTaskScoringCoverage: 0,
    caseMix: {
      method: 'direct_standardization', applied: false,
      minimumRatedTasksPerBand: 0, minimumModelRatedTasksPerBand: 0, minimumTargetBandWeight: 0,
      targetBandWeights: { low: round(targetWeights.low), medium: round(targetWeights.medium), high: round(targetWeights.high) },
      activeSignals: complexity.activeSignals,
      initialUserMessageCoverage: round(complexity.initialUserMessageCoverage),
      notes: ['Ex-ante task bands remain diagnostic. V2 quality rank is not case-mix adjusted and cannot inherit runtime population weights.'],
    },
    notes: [
      'Rows are canonical model families across all thinking levels. Families appear only with attributable stable-ID V2 review mass or completed current-harness runtime telemetry. Only review-backed families are ranked; runtime fields use completed current-harness runs only.',
      'The model/harness rank is review-only: it uses only deterministically derived V2 qualityIndexV1 criterion attainment. Runtime process, coverage, confidence, blockers, cost, and latency have zero ranking weight.',
      'V2 reviews use stable sessionId attribution. Canonical run joins collapse retries deterministically to the latest stable run per task and family; successful transcript token shares supplement contributing families whose run snapshot is absent and preserve unmatched stable-ID review quality. Transcript-only family shares remain excluded from run-dependent metrics and canonical task counts. Path-fallback, identityFallback, and unblinded reviews are excluded. Mixed-model attribution shares sum to one review.',
      'Accepted mixed-bucket and small-only V2 reviewer profiles participate under the same qualityIndexV1 rules.',
      'Ex-ante complexity bands remain diagnostic only. The V2 rank is not case-mix adjusted, so runtime population composition cannot change V2 quality strength.',
      'The 80% interval is an approximation: beta-style posterior variance for the V2 review channel is propagated through its standardized logit, then through the logistic transform with z=1.282. Rank ranges come from interval overlap.',
      'Ranks reflect point-estimate order within the observed cohort. Models whose 80% score intervals overlap have unresolved relative order — the rank range column shows the possible positions each model could occupy.',
      'Ranks are observational and relative to the currently observed family cohort and ex-ante task mix, not universal benchmark capability.',
    ],
  };
}
