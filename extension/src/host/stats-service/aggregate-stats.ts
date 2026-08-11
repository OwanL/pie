/**
 * Pure aggregate-stats computation, extracted from {@link AggregateStatsService}
 * so it is unit-testable in isolation (no I/O, no timers).
 *
 * Given the raw {@link RunSnapshot}s (completed + open), a model-pricing map,
 * the set of currently-running session paths, the live per-session rate
 * states, and the open-tab count, it rolls up cost / tokens / throughput per
 * provider and overall — with a recent/current focus (today + this-week cost,
 * today throughput, live rate, open/running counts) plus all-time context for
 * tooltips.
 *
 * Provider attribution policy: see {@link ../../shared/protocol/aggregate-stats.ts}.
 */

import type { ModelPricingRecord, ModelTokenPricing } from '../../backend/pricing';
import { pricingForPromptTokens } from '../../../../shared/pricing-core.js';
import { resolvePricingCatalogKey, stripProviderPrefix } from '../../shared/model-id';
import type {
  AggregateDailyCost,
  AggregateDailyModelCost,
  AggregateDailyRunCount,
  AggregateLastRun,
  AggregateLastRunTurn,
  AggregateProviderCost,
  AggregateProviderThroughput,
  AggregateSeriesPoint,
  AggregateSeriesSegment,
  AggregateStats,
  AggregateSubagentLifecycleStats,
} from '../../shared/protocol';
import { EMPTY_PROVIDER_GATE_STATS } from '../../shared/protocol/aggregate-stats';
import type { TokenRateIndicatorState } from '../../shared/token-rate';
import type { RunSnapshot } from '../run-analytics';

/** How many trailing days (inclusive of today) the daily-cost series covers. */
export const DAILY_COST_WINDOW_DAYS = 14;
/** Length of the rolling "this week" cost window (inclusive of today). */
export const WEEK_WINDOW_DAYS = 7;

/** Maximum number of points in an intraday cumulative series (cost or tokens).
 *  One point is reserved for the trailing "now" value; the remaining points are
 *  time buckets formed by accumulating raw samples. */
export const MAX_INTRADAY_CHART_POINTS = 240;

interface ProviderAccumulator {
  provider: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Throughput accumulators (completed turns only):
  throughputOutputTokens: number;
  throughputGenerationMs: number;
  sampleCount: number;
}

interface DayAccumulator {
  date: string;
  byProvider: Map<string, ProviderAccumulator>;
  /** Per-model cost within this day (for the weekly chart's per-model hover). */
  byModel: Map<string, number>;
  /** Number of runs bucketed to this day. */
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  touchedFileCount: number;
}

/** A timestamped sample for a date's intraday cost series. */
interface TodayCostSample {
  ms: number;
  provider: string;
  model: string;
  cost: number;
}

/** A timestamped sample for a date's intraday output-token series. */
interface TodayTokenSample {
  ms: number;
  provider: string;
  model: string;
  tokens: number;
}

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface AttributedUsage extends TokenCounts {
  model: string;
  provider: string;
  occurredAtMs: number;
  cost: number;
}

/** Per-hour throughput accumulator for today's intraday throughput chart. */
interface HourThroughput {
  byProvider: Map<string, { out: number; genMs: number }>;
  byModel: Map<string, { out: number; genMs: number }>;
}

/** Minimal throughput accumulator for a (date, provider) bucket. */
interface ThroughputAcc {
  provider: string;
  outputTokens: number;
  generationDurationMs: number;
  sampleCount: number;
}

/** Window dates used for today / this-week bucketing. */
interface DateWindow {
  todayDate: string;
  weekStartMs: number;
  weekDates: Set<string>;
}

/**
 * Mergeable, wall-clock-independent aggregate state for a set of runs.
 *
 * Pricing is intentionally applied while accumulating, so callers must rebuild
 * an accumulator when the pricing signature changes. Date windows and live UI
 * state are applied only by {@link finalizeAggregateStats}.
 */
export interface AggregateStatsAccumulator {
  byProvider: Map<string, ProviderAccumulator>;
  byDay: Map<string, DayAccumulator>;
  throughputByDay: Map<string, Map<string, ThroughputAcc>>;
  sessionPaths: Set<string>;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalThroughputOutputTokens: number;
  totalThroughputGenerationMs: number;
  costSamplesByDay: Map<string, TodayCostSample[]>;
  tokenSamplesByDay: Map<string, TodayTokenSample[]>;
  throughputByHourByDay: Map<string, Map<number, HourThroughput>>;
  lastRunEndedMs: number;
  lastRun: AggregateLastRun | null;
  runCount: number;
  subagentLifecycle: AggregateSubagentLifecycleStats;
}

/** Optional pure-computation instrumentation used by regression tests/benchmarks. */
export interface AggregateStatsInstrumentation {
  onRunAccumulated?: (run: RunSnapshot) => void;
}

/** Instrumentation for proving that preparation is the only operation which
 * visits unbounded completed-history day/sample collections. */
export interface AggregateStatsLayerInstrumentation {
  onCompletedSourceEntryVisited?: (kind: 'day' | 'cost_sample' | 'token_sample' | 'throughput_hour') => void;
}

/**
 * A completed-history layer narrowed to the protocol's fixed date/chart
 * windows. It can be overlaid with a mutable open-run accumulator without
 * walking completed historical days or raw intraday samples again.
 */
export interface PreparedAggregateStatsLayer {
  accumulator: AggregateStatsAccumulator;
  completedSessionPaths: ReadonlySet<string>;
  costSamplesCompacted: boolean;
  tokenSamplesCompacted: boolean;
}

/** Today-specific cost and throughput rollups. */
interface TodayStats {
  todayCost: number;
  todayCostByProvider: AggregateProviderCost[];
  todayTokensPerSecond: number;
  todayTokensPerSecondByProvider: AggregateProviderThroughput[];
}

/** Week cost rollup. */
interface WeekStats {
  weekCost: number;
  weekCostByProvider: AggregateProviderCost[];
}

/** Live aggregate tok/s and running-session count. */
interface LiveStats {
  liveTokensPerSecond: number;
  runningSessionCount: number;
}

function createSubagentLifecycleStats(): AggregateSubagentLifecycleStats {
  return {
    attemptCount: 0,
    outcomeCounts: { success: 0, failure: 0, aborted: 0 },
    attemptDuration: { reportedMs: 0, reportedCount: 0, measuredMs: 0, measuredCount: 0, estimatedMs: 0, estimatedCount: 0, unknownCount: 0 },
    attemptSettlements: { reportedCount: 0, unknownCount: 0, byOutcome: {} },
    parentSettlement: { unknownCount: 0 },
    retries: { attemptCount: 0, backoff: { reportedMs: 0, reportedCount: 0, estimatedMs: 0, estimatedCount: 0, unknownCount: 0 } },
    cleanupTelemetry: { reportedCount: 0, unknownCount: 0, byOutcome: {} },
    phaseDurations: { measuredMsByPhase: {}, measuredCountByPhase: {}, unknownAttemptCount: 0 },
    unknownAttemptRecordCallCount: 0,
  };
}

function addSubagentLifecycleStats(
  target: AggregateSubagentLifecycleStats,
  source: AggregateSubagentLifecycleStats,
): void {
  target.attemptCount += source.attemptCount;
  for (const outcome of ['success', 'failure', 'aborted'] as const) target.outcomeCounts[outcome] += source.outcomeCounts[outcome];
  for (const key of ['reportedMs', 'reportedCount', 'measuredMs', 'measuredCount', 'estimatedMs', 'estimatedCount', 'unknownCount'] as const) {
    target.attemptDuration[key] += source.attemptDuration[key];
  }
  for (const key of ['reportedCount', 'unknownCount'] as const) {
    target.attemptSettlements[key] += source.attemptSettlements[key];
    target.cleanupTelemetry[key] += source.cleanupTelemetry[key];
  }
  target.parentSettlement.unknownCount += source.parentSettlement.unknownCount;
  for (const [outcome, count] of Object.entries(source.attemptSettlements.byOutcome)) target.attemptSettlements.byOutcome[outcome] = (target.attemptSettlements.byOutcome[outcome] ?? 0) + count;
  for (const [outcome, count] of Object.entries(source.cleanupTelemetry.byOutcome)) target.cleanupTelemetry.byOutcome[outcome] = (target.cleanupTelemetry.byOutcome[outcome] ?? 0) + count;
  for (const [phase, duration] of Object.entries(source.phaseDurations.measuredMsByPhase)) target.phaseDurations.measuredMsByPhase[phase] = (target.phaseDurations.measuredMsByPhase[phase] ?? 0) + duration;
  for (const [phase, count] of Object.entries(source.phaseDurations.measuredCountByPhase)) target.phaseDurations.measuredCountByPhase[phase] = (target.phaseDurations.measuredCountByPhase[phase] ?? 0) + count;
  target.phaseDurations.unknownAttemptCount += source.phaseDurations.unknownAttemptCount;
  target.retries.attemptCount += source.retries.attemptCount;
  for (const key of ['reportedMs', 'reportedCount', 'estimatedMs', 'estimatedCount', 'unknownCount'] as const) target.retries.backoff[key] += source.retries.backoff[key];
  target.unknownAttemptRecordCallCount += source.unknownAttemptRecordCallCount;
}

function accumulateSubagentLifecycle(run: RunSnapshot, target: AggregateSubagentLifecycleStats): void {
  const samples = run.subagentAttemptSamples ?? [];
  // New tracker ingestion persists this count even when other calls in the run
  // had valid records. Historical snapshots lack it, so retain their conservative
  // call-count fallback instead of treating a mixed run as fully covered.
  target.unknownAttemptRecordCallCount += run.unknownSubagentAttemptRecordSourceIds?.length
    ?? (run.toolUsage?.subagentCallCount ?? 0);
  for (const sample of samples) {
    target.attemptCount += 1;
    target.outcomeCounts[sample.outcome] += 1;
    if (sample.durationMs === null || sample.durationSource === 'unknown') {
      target.attemptDuration.unknownCount += 1;
    } else if (sample.durationSource === 'measured') {
      target.attemptDuration.measuredMs += sample.durationMs;
      target.attemptDuration.measuredCount += 1;
    } else if (sample.durationSource === 'estimated') {
      target.attemptDuration.estimatedMs += sample.durationMs;
      target.attemptDuration.estimatedCount += 1;
    } else {
      target.attemptDuration.reportedMs += sample.durationMs;
      target.attemptDuration.reportedCount += 1;
    }
    if (sample.attemptSettlementOutcome && sample.attemptSettlementSource === 'reported') {
      target.attemptSettlements.reportedCount += 1;
      target.attemptSettlements.byOutcome[sample.attemptSettlementOutcome] = (target.attemptSettlements.byOutcome[sample.attemptSettlementOutcome] ?? 0) + 1;
    } else {
      target.attemptSettlements.unknownCount += 1;
    }
    // Attempt stop/activity outcomes cannot establish how the parent tool call
    // settled. Keep that unavailable provenance explicit for every attempt.
    target.parentSettlement.unknownCount += 1;
    if (sample.phaseDurationsMs === null || sample.phaseDurationsSource === 'unknown') {
      target.phaseDurations.unknownAttemptCount += 1;
    } else {
      for (const [phase, duration] of Object.entries(sample.phaseDurationsMs)) {
        target.phaseDurations.measuredMsByPhase[phase] = (target.phaseDurations.measuredMsByPhase[phase] ?? 0) + duration;
        target.phaseDurations.measuredCountByPhase[phase] = (target.phaseDurations.measuredCountByPhase[phase] ?? 0) + 1;
      }
    }
    if (sample.retryIndex > 0) {
      target.retries.attemptCount += 1;
      if (sample.backoffMs === null || sample.backoffSource === 'unknown') {
        target.retries.backoff.unknownCount += 1;
      } else if (sample.backoffSource === 'estimated') {
        target.retries.backoff.estimatedMs += sample.backoffMs;
        target.retries.backoff.estimatedCount += 1;
      } else {
        target.retries.backoff.reportedMs += sample.backoffMs;
        target.retries.backoff.reportedCount += 1;
      }
    }
    if (sample.cleanupOutcome && sample.cleanupSource === 'reported') {
      target.cleanupTelemetry.reportedCount += 1;
      target.cleanupTelemetry.byOutcome[sample.cleanupOutcome] = (target.cleanupTelemetry.byOutcome[sample.cleanupOutcome] ?? 0) + 1;
    } else {
      target.cleanupTelemetry.unknownCount += 1;
    }
  }
}

function createProviderAccumulator(provider: string): ProviderAccumulator {
  return {
    provider,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    throughputOutputTokens: 0,
    throughputGenerationMs: 0,
    sampleCount: 0,
  };
}

function canonicalModel(modelId: string | undefined, pricingMap: Map<string, ModelPricingRecord[]>): string {
  // Provider-qualified ids (e.g. `ollama/glm-5.2:cloud`) resolve to their bare
  // catalog key so subagent/child usage is labeled and priced under the real
  // model instead of folding into 'unknown'.
  return resolvePricingCatalogKey(modelId, (key) => pricingMap.has(key)) ?? 'unknown';
}

/** Resolve the provider name for a model id (first priced provider), or `'unknown'`. */
export function providerForModel(
  modelId: string | undefined,
  pricingMap: Map<string, ModelPricingRecord[]>,
  preferredProvider?: string,
): string {
  // A recorded provider is authoritative even when the model id is unknown to
  // the catalog: an unregistered/unpriced id must not erase which provider
  // actually served the usage (it would otherwise land in 'unknown' with real
  // reported cost attached).
  if (preferredProvider) return preferredProvider;
  if (!modelId) return 'unknown';
  const key = resolvePricingCatalogKey(modelId, (candidate) => pricingMap.has(candidate));
  if (!key) return 'unknown';
  const records = pricingMap.get(key)!;
  if (!records || records.length === 0) return 'unknown';
  const providers = new Set(records.map((record) => record.provider));
  if (providers.size !== 1) return 'unknown';
  return records[0]!.provider;
}

/** Resolve the token pricing for a model id (first priced record), or `null`. */
export function pricingForModel(
  modelId: string | undefined,
  pricingMap: Map<string, ModelPricingRecord[]>,
  preferredProvider?: string,
): ModelTokenPricing | null {
  if (!modelId) return null;
  const key = resolvePricingCatalogKey(modelId, (candidate) => pricingMap.has(candidate));
  if (!key) return null;
  const records = pricingMap.get(key)!;
  if (!records) return null;
  if (preferredProvider) {
    return records.find((record) => record.provider === preferredProvider)?.pricing ?? null;
  }
  const providers = new Set(records.map((record) => record.provider));
  if (providers.size !== 1) return null;
  return records.find((record) => record.pricing !== undefined)?.pricing ?? null;
}

/** Cost (USD) from cumulative token counts and per-1M-token pricing. */
function costFromTokens(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  pricing: ModelTokenPricing | null,
): number {
  if (!pricing) return 0;
  const effective = pricingForPromptTokens(pricing, inputTokens, cacheReadTokens, cacheWriteTokens);
  return (
    (inputTokens / 1_000_000) * effective.input
    + (outputTokens / 1_000_000) * effective.output
    + (cacheReadTokens / 1_000_000) * effective.cacheRead
    + (cacheWriteTokens / 1_000_000) * effective.cacheWrite
  );
}

function usageTotal(usage: TokenCounts): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function equalUsage(left: TokenCounts, right: TokenCounts): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
}

function subtractUsage(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
  };
}

function providerForSample(
  sampleModelId: string | undefined,
  sampleProvider: string | undefined,
  runModelId: string | undefined,
  runProvider: string | undefined,
): string | undefined {
  if (sampleProvider) return sampleProvider;
  // Compare provider-qualified ids against the bare run id so a prefixed
  // duplicate of the run model (`openai-codex/gpt-5.6-sol` vs `gpt-5.6-sol`)
  // inherits the run provider like the identical bare id would.
  return !sampleModelId || stripProviderPrefix(sampleModelId) === runModelId ? runProvider : undefined;
}

function usageForModel(
  model: string,
  occurredAtMs: number,
  counts: TokenCounts,
  pricingMap: Map<string, ModelPricingRecord[]>,
  preferredProvider?: string,
  reportedCostUsd?: number,
): AttributedUsage {
  // Unknown/stale model IDs are folded into one stable bucket. This keeps every
  // model/provider breakdown bounded by the current pricing catalog plus one,
  // rather than by the number of distinct IDs in historical snapshots. The
  // canonicalization is prefix-tolerant, and the recorded provider stays
  // authoritative even when the id cannot be resolved (see providerForModel).
  const attributedModel = canonicalModel(model, pricingMap);
  const pricing = pricingForModel(attributedModel, pricingMap, preferredProvider);
  return {
    ...counts,
    model: attributedModel,
    provider: providerForModel(attributedModel, pricingMap, preferredProvider),
    occurredAtMs,
    cost: typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0
      ? reportedCostUsd
      : costFromTokens(
          counts.inputTokens,
          counts.outputTokens,
          counts.cacheReadTokens,
          counts.cacheWriteTokens,
          pricing,
        ),
  };
}

/**
 * Build canonical billable usage for a run. Parent-turn and pruning-prepass
 * usage are direct. Subagent totals come from the existing ToolUsageRollup;
 * auxiliary samples only split those totals by actual child model/time, so
 * they cannot double-count usage or the forwarded throughput samples.
 */
function attributedRunUsage(
  run: RunSnapshot,
  pricingMap: Map<string, ModelPricingRecord[]>,
  fallbackMs: number,
): AttributedUsage[] {
  const runModel = run.modelId ?? 'unknown';
  const usage: AttributedUsage[] = [];
  let parentRemaining: TokenCounts = {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
  };
  // Per-turn samples carry the provider/model that actually served that turn.
  // Reconcile them against canonical run totals so mixed-model runs remain
  // discrete without allowing duplicate/malformed samples to inflate usage.
  for (const sample of run.turnThroughputSamples) {
    if (usageTotal(parentRemaining) === 0) break;
    const counts: TokenCounts = {
      inputTokens: Math.min(parentRemaining.inputTokens, sample.inputTokens ?? 0),
      outputTokens: Math.min(parentRemaining.outputTokens, sample.outputTokens),
      cacheReadTokens: Math.min(parentRemaining.cacheReadTokens, sample.cacheReadTokens ?? 0),
      cacheWriteTokens: Math.min(parentRemaining.cacheWriteTokens, sample.cacheWriteTokens ?? 0),
    };
    if (usageTotal(counts) === 0) continue;
    const occurredAtMs = Date.parse(sample.endedAt);
    usage.push(usageForModel(
      sample.modelId ?? runModel,
      Number.isNaN(occurredAtMs) ? fallbackMs : occurredAtMs,
      counts,
      pricingMap,
      providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
      sample.reportedCostUsd,
    ));
    parentRemaining = subtractUsage(parentRemaining, counts);
  }
  if (usageTotal(parentRemaining) > 0) {
    usage.push(usageForModel(runModel, fallbackMs, parentRemaining, pricingMap, run.provider));
  }
  const auxiliary = run.auxiliaryLlmUsage ?? [];
  const seen = new Set<string>();

  for (const sample of auxiliary) {
    if (sample.kind === 'subagent') continue;
    const dedupKey = `${sample.kind}:${sample.sourceId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const counts = {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    };
    if (usageTotal(counts) === 0 && sample.reportedCostUsd === undefined) continue;
    const occurredAtMs = Date.parse(sample.occurredAt);
    usage.push(usageForModel(
      sample.modelId ?? runModel,
      Number.isNaN(occurredAtMs) ? fallbackMs : occurredAtMs,
      counts,
      pricingMap,
      providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
      sample.reportedCostUsd,
    ));
  }

  let remaining: TokenCounts = {
    inputTokens: run.toolUsage?.subagentInputTokens ?? 0,
    outputTokens: run.toolUsage?.subagentOutputTokens ?? 0,
    cacheReadTokens: run.toolUsage?.subagentCacheReadTokens ?? 0,
    cacheWriteTokens: run.toolUsage?.subagentCacheWriteTokens ?? 0,
  };
  for (const sample of auxiliary) {
    if (sample.kind !== 'subagent' || usageTotal(remaining) === 0) continue;
    const dedupKey = `${sample.kind}:${sample.sourceId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const counts: TokenCounts = {
      inputTokens: Math.min(remaining.inputTokens, sample.inputTokens),
      outputTokens: Math.min(remaining.outputTokens, sample.outputTokens),
      cacheReadTokens: Math.min(remaining.cacheReadTokens, sample.cacheReadTokens),
      cacheWriteTokens: Math.min(remaining.cacheWriteTokens, sample.cacheWriteTokens),
    };
    if (usageTotal(counts) === 0) continue;
    const occurredAtMs = Date.parse(sample.occurredAt);
    const sampleCounts: TokenCounts = {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    };
    usage.push(usageForModel(
      sample.modelId ?? runModel,
      Number.isNaN(occurredAtMs) ? fallbackMs : occurredAtMs,
      counts,
      pricingMap,
      providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
      equalUsage(counts, sampleCounts) ? sample.reportedCostUsd : undefined,
    ));
    remaining = subtractUsage(remaining, counts);
  }

  if (usageTotal(remaining) > 0) {
    // Historical snapshots have aggregate subagent totals but no attribution
    // samples. A unique non-parent throughput model is the best available child
    // attribution; otherwise conservatively fall back to the parent run model.
    const hintedModels = new Set(
      run.turnThroughputSamples
        .map((sample) => sample.modelId)
        .filter((modelId): modelId is string => !!modelId && modelId !== run.modelId),
    );
    const fallbackModel = hintedModels.size === 1 ? [...hintedModels][0]! : runModel;
    usage.push(usageForModel(
      fallbackModel,
      fallbackMs,
      remaining,
      pricingMap,
      providerForSample(fallbackModel, undefined, run.modelId, run.provider),
    ));
  }

  return usage;
}

function distributeUsageForSeries(
  run: RunSnapshot,
  usage: AttributedUsage[],
  fallbackMs: number,
  includeSample: (ms: number) => boolean,
  pricingMap: Map<string, ModelPricingRecord[]>,
): { cost: TodayCostSample[]; tokens: TodayTokenSample[] } {
  const groups = new Map<string, AttributedUsage>();
  for (const item of usage) {
    const billingKey = `${item.provider}\u0000${item.model}`;
    const current = groups.get(billingKey);
    if (!current) {
      groups.set(billingKey, { ...item });
      continue;
    }
    current.inputTokens += item.inputTokens;
    current.outputTokens += item.outputTokens;
    current.cacheReadTokens += item.cacheReadTokens;
    current.cacheWriteTokens += item.cacheWriteTokens;
    current.cost += item.cost;
    current.occurredAtMs = Math.max(current.occurredAtMs, item.occurredAtMs);
  }

  const cost: TodayCostSample[] = [];
  const tokens: TodayTokenSample[] = [];
  for (const group of groups.values()) {
    const samples = run.turnThroughputSamples
      .map((sample) => ({ sample, ms: Date.parse(sample.endedAt) }))
      .filter(({ sample, ms }) => !Number.isNaN(ms)
        && includeSample(ms)
        && canonicalModel(sample.modelId ?? run.modelId, pricingMap) === group.model
        && providerForModel(
          sample.modelId ?? run.modelId,
          pricingMap,
          providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
        ) === group.provider);
    const sampleOutput = samples.reduce((sum, entry) => sum + entry.sample.outputTokens, 0);
    if (samples.length === 0) {
      const ms = includeSample(group.occurredAtMs) ? group.occurredAtMs : fallbackMs;
      if (group.cost > 0) cost.push({ ms, provider: group.provider, model: group.model, cost: group.cost });
      if (group.outputTokens > 0) tokens.push({ ms, provider: group.provider, model: group.model, tokens: group.outputTokens });
      continue;
    }
    for (const entry of samples) {
      const share = sampleOutput > 0
        ? entry.sample.outputTokens / sampleOutput
        : 1 / samples.length;
      if (group.cost > 0) cost.push({ ms: entry.ms, provider: group.provider, model: group.model, cost: group.cost * share });
      if (group.outputTokens > 0) tokens.push({ ms: entry.ms, provider: group.provider, model: group.model, tokens: group.outputTokens * share });
    }
  }
  return { cost, tokens };
}

/** Local calendar date (`YYYY-MM-DD`) for a millisecond epoch timestamp.
 *  Uses the host's local timezone so "today" / "this week" reset at local
 *  midnight (not UTC midnight) — matching the user's wall-clock expectation
 *  of when a daily spend budget rolls over. */
function localDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Pick the most relevant timestamp (ms epoch) for day-bucketing a run. */
function runDayMs(snapshot: RunSnapshot): number {
  const finalized = snapshot.finalizedAt ? Date.parse(snapshot.finalizedAt) : NaN;
  if (!Number.isNaN(finalized)) return finalized;
  const updated = Date.parse(snapshot.updatedAt);
  if (!Number.isNaN(updated)) return updated;
  return Date.parse(snapshot.startedAt);
}

function toProviderCost(acc: ProviderAccumulator): AggregateProviderCost {
  return {
    provider: acc.provider,
    cost: canonicalCostValue(acc.cost),
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
  };
}

function toProviderThroughput(acc: ProviderAccumulator): AggregateProviderThroughput {
  const tokensPerSecond = acc.throughputGenerationMs > 0
    ? acc.throughputOutputTokens / (acc.throughputGenerationMs / 1000)
    : 0;
  return {
    provider: acc.provider,
    tokensPerSecond,
    outputTokens: acc.throughputOutputTokens,
    generationDurationMs: acc.throughputGenerationMs,
    sampleCount: acc.sampleCount,
  };
}

function throughputAccToEntry(acc: ThroughputAcc): AggregateProviderThroughput {
  const tokensPerSecond = acc.generationDurationMs > 0
    ? acc.outputTokens / (acc.generationDurationMs / 1000)
    : 0;
  return {
    provider: acc.provider,
    tokensPerSecond,
    outputTokens: acc.outputTokens,
    generationDurationMs: acc.generationDurationMs,
    sampleCount: acc.sampleCount,
  };
}

function sortCostDesc(a: AggregateProviderCost, b: AggregateProviderCost): number {
  return b.cost - a.cost || a.provider.localeCompare(b.provider);
}

function sortThroughputDesc(a: AggregateProviderThroughput, b: AggregateProviderThroughput): number {
  return b.outputTokens - a.outputTokens || a.provider.localeCompare(b.provider);
}

/** Build the set of dates in the rolling week window plus the week start timestamp. */
function buildDateWindows(nowMs: number): DateWindow {
  const todayDate = localDateString(nowMs);
  const weekStartMs = nowMs - (WEEK_WINDOW_DAYS - 1) * 86_400_000;
  const weekDates = new Set<string>();
  for (let i = 0; i < WEEK_WINDOW_DAYS; i += 1) {
    weekDates.add(localDateString(weekStartMs + i * 86_400_000));
  }
  return { todayDate, weekStartMs, weekDates };
}

/**
 * Single pass over all runs that accumulates per-provider, per-day,
 * per-day-throughput, intraday sample, and most-recent-run state without
 * consulting the current wall clock.
 */
export function accumulateAggregateStats(
  runs: RunSnapshot[],
  pricingMap: Map<string, ModelPricingRecord[]>,
  instrumentation?: AggregateStatsInstrumentation,
): AggregateStatsAccumulator {
  const byProvider = new Map<string, ProviderAccumulator>();
  const byDay = new Map<string, DayAccumulator>();
  // Throughput is bucketed by each sample's end-date. Date-window selection is
  // deferred until finalization, keeping this accumulator independent of now.
  const throughputByDay = new Map<string, Map<string, ThroughputAcc>>();
  const sessionPaths = new Set<string>();
  const costSamplesByDay = new Map<string, TodayCostSample[]>();
  const tokenSamplesByDay = new Map<string, TodayTokenSample[]>();
  const throughputByHourByDay = new Map<string, Map<number, HourThroughput>>();

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalThroughputOutputTokens = 0;
  let totalThroughputGenerationMs = 0;
  const subagentLifecycle = createSubagentLifecycleStats();

  // Most-recent run (max finalized/updated/started timestamp across all runs).
  let lastRun: AggregateLastRun | null = null;
  let lastRunEndedMs = -1;

  const providerAcc = (provider: string): ProviderAccumulator => {
    let acc = byProvider.get(provider);
    if (!acc) {
      acc = createProviderAccumulator(provider);
      byProvider.set(provider, acc);
    }
    return acc;
  };

  const dayThroughput = (date: string, provider: string): ThroughputAcc => {
    let dayMap = throughputByDay.get(date);
    if (!dayMap) {
      dayMap = new Map();
      throughputByDay.set(date, dayMap);
    }
    let acc = dayMap.get(provider);
    if (!acc) {
      acc = { provider, outputTokens: 0, generationDurationMs: 0, sampleCount: 0 };
      dayMap.set(provider, acc);
    }
    return acc;
  };

  for (const run of runs) {
    instrumentation?.onRunAccumulated?.(run);
    if (run.sessionPath) sessionPaths.add(run.sessionPath);
    const dayMs = runDayMs(run);
    accumulateSubagentLifecycle(run, subagentLifecycle);
    const usage = attributedRunUsage(run, pricingMap, dayMs);
    const runCost = usage.reduce((sum, item) => sum + item.cost, 0);
    const runInputTokens = usage.reduce((sum, item) => sum + item.inputTokens, 0);
    const runOutputTokens = usage.reduce((sum, item) => sum + item.outputTokens, 0);

    for (const item of usage) {
      const acc = providerAcc(item.provider);
      acc.cost += item.cost;
      acc.inputTokens += item.inputTokens;
      acc.outputTokens += item.outputTokens;
      acc.cacheReadTokens += item.cacheReadTokens;
      acc.cacheWriteTokens += item.cacheWriteTokens;
      totalCost += item.cost;
      totalInputTokens += item.inputTokens;
      totalOutputTokens += item.outputTokens;
      totalCacheReadTokens += item.cacheReadTokens;
      totalCacheWriteTokens += item.cacheWriteTokens;
    }

    // Throughput is derived only from completed turn samples. Auxiliary usage
    // affects billable token/cost totals but never creates a second throughput
    // observation; forwarded subagent samples are already present here once.
    for (const sample of run.turnThroughputSamples) {
      if (sample.status !== 'completed' || sample.generationDurationMs <= 0) continue;
      const sampleProvider = providerForModel(
        sample.modelId ?? run.modelId,
        pricingMap,
        providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
      );
      const sampleAcc = providerAcc(sampleProvider);
      sampleAcc.throughputOutputTokens += sample.outputTokens;
      sampleAcc.throughputGenerationMs += sample.generationDurationMs;
      sampleAcc.sampleCount += 1;
      totalThroughputOutputTokens += sample.outputTokens;
      totalThroughputGenerationMs += sample.generationDurationMs;
      const sampleMs = Date.parse(sample.endedAt);
      if (!Number.isNaN(sampleMs)) {
        const tAcc = dayThroughput(localDateString(sampleMs), sampleProvider);
        tAcc.outputTokens += sample.outputTokens;
        tAcc.generationDurationMs += sample.generationDurationMs;
        tAcc.sampleCount += 1;
      }
    }

    // Daily cost/token buckets retain the existing run-end calendar semantics,
    // while each usage slice keeps its own provider/model attribution.
    if (!Number.isNaN(dayMs)) {
      const date = localDateString(dayMs);
      let day = byDay.get(date);
      if (!day) {
        day = {
          date,
          byProvider: new Map(),
          byModel: new Map(),
          runCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: 0,
          touchedFileCount: 0,
        };
        byDay.set(date, day);
      }
      for (const item of usage) {
        let dayAcc = day.byProvider.get(item.provider);
        if (!dayAcc) {
          dayAcc = createProviderAccumulator(item.provider);
          day.byProvider.set(item.provider, dayAcc);
        }
        dayAcc.cost += item.cost;
        dayAcc.inputTokens += item.inputTokens;
        dayAcc.outputTokens += item.outputTokens;
        dayAcc.cacheReadTokens += item.cacheReadTokens;
        dayAcc.cacheWriteTokens += item.cacheWriteTokens;
        day.byModel.set(item.model, (day.byModel.get(item.model) ?? 0) + item.cost);
      }
      day.runCount += 1;
      day.inputTokens += runInputTokens;
      day.outputTokens += runOutputTokens;
      day.toolCallCount += run.toolUsage?.totalCount ?? 0;
      day.touchedFileCount += run.fileMutation?.touchedFileCount ?? 0;

      // Preserve the existing run-end date semantics for intraday cost/token
      // samples, but retain every date so "today" is chosen only at finalize.
      const series = distributeUsageForSeries(
        run,
        usage,
        dayMs,
        (ms) => localDateString(ms) === date,
        pricingMap,
      );
      if (series.cost.length > 0) {
        const existing = costSamplesByDay.get(date);
        if (existing) existing.push(...series.cost);
        else costSamplesByDay.set(date, series.cost);
      }
      if (series.tokens.length > 0) {
        const existing = tokenSamplesByDay.get(date);
        if (existing) existing.push(...series.tokens);
        else tokenSamplesByDay.set(date, series.tokens);
      }
    }

    for (const sample of run.turnThroughputSamples) {
      const sMs = Date.parse(sample.endedAt);
      if (Number.isNaN(sMs)) continue;
      if (sample.status !== 'completed' || sample.generationDurationMs <= 0) continue;
      const date = localDateString(sMs);
      const sProvider = providerForModel(
        sample.modelId ?? run.modelId,
        pricingMap,
        providerForSample(sample.modelId, sample.provider, run.modelId, run.provider),
      );
      const sModel = canonicalModel(sample.modelId ?? run.modelId, pricingMap);
      const hourDate = new Date(sMs);
      hourDate.setMinutes(0, 0, 0);
      const hourMs = hourDate.getTime();
      let byHour = throughputByHourByDay.get(date);
      if (!byHour) {
        byHour = new Map();
        throughputByHourByDay.set(date, byHour);
      }
      let hour = byHour.get(hourMs);
      if (!hour) {
        hour = { byProvider: new Map(), byModel: new Map() };
        byHour.set(hourMs, hour);
      }
      let p = hour.byProvider.get(sProvider);
      if (!p) { p = { out: 0, genMs: 0 }; hour.byProvider.set(sProvider, p); }
      p.out += sample.outputTokens;
      p.genMs += sample.generationDurationMs;
      let m = hour.byModel.get(sModel);
      if (!m) { m = { out: 0, genMs: 0 }; hour.byModel.set(sModel, m); }
      m.out += sample.outputTokens;
      m.genMs += sample.generationDurationMs;
    }

    // Track the most-recent run by its end timestamp. Its token sparkline is
    // normalized to canonical usage, so prepass/subagent output is included
    // without counting forwarded child throughput samples twice.
    if (!Number.isNaN(dayMs) && dayMs > lastRunEndedMs) {
      lastRunEndedMs = dayMs;
      const series = distributeUsageForSeries(run, usage, dayMs, () => true, pricingMap);
      const lastRunTurnSeries: AggregateLastRunTurn[] = series.tokens
        .map((sample) => ({ ms: sample.ms, outputTokens: sample.tokens }))
        .sort((a, b) => a.ms - b.ms);
      lastRun = {
        cost: canonicalCostValue(runCost),
        durationMs: run.busyDurationMs ?? 0,
        modelId: run.modelId ?? null,
        provider: providerForModel(run.modelId, pricingMap, run.provider),
        startedAt: run.startedAt,
        endedAt: run.finalizedAt ?? run.updatedAt,
        inputTokens: runInputTokens,
        outputTokens: runOutputTokens,
        turnSeries: lastRunTurnSeries,
      };
    }
  }

  return {
    byProvider,
    byDay,
    throughputByDay,
    sessionPaths,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalThroughputOutputTokens,
    totalThroughputGenerationMs,
    costSamplesByDay,
    tokenSamplesByDay,
    throughputByHourByDay,
    lastRunEndedMs,
    lastRun,
    runCount: runs.length,
    subagentLifecycle,
  };
}

function addProviderAccumulator(target: ProviderAccumulator, source: ProviderAccumulator): void {
  target.cost += source.cost;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.throughputOutputTokens += source.throughputOutputTokens;
  target.throughputGenerationMs += source.throughputGenerationMs;
  target.sampleCount += source.sampleCount;
}

function mergeProviderMap(
  target: Map<string, ProviderAccumulator>,
  source: Map<string, ProviderAccumulator>,
): void {
  for (const [provider, sourceAcc] of source) {
    let targetAcc = target.get(provider);
    if (!targetAcc) {
      targetAcc = createProviderAccumulator(provider);
      target.set(provider, targetAcc);
    }
    addProviderAccumulator(targetAcc, sourceAcc);
  }
}

function createEmptyAccumulator(): AggregateStatsAccumulator {
  return {
    byProvider: new Map(),
    byDay: new Map(),
    throughputByDay: new Map(),
    sessionPaths: new Set(),
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalThroughputOutputTokens: 0,
    totalThroughputGenerationMs: 0,
    costSamplesByDay: new Map(),
    tokenSamplesByDay: new Map(),
    throughputByHourByDay: new Map(),
    lastRunEndedMs: -1,
    lastRun: null,
    runCount: 0,
    subagentLifecycle: createSubagentLifecycleStats(),
  };
}

/** Merge one accumulator's contribution into an existing target in place.
 *  Used by the aggregate service to fold newly-appended runs into a cached
 *  completed accumulator without re-accumulating the whole history. */
export function mergeAccumulatorInto(
  target: AggregateStatsAccumulator,
  source: AggregateStatsAccumulator,
): void {
  mergeProviderMap(target.byProvider, source.byProvider);
  for (const [date, sourceDay] of source.byDay) {
    let targetDay = target.byDay.get(date);
    if (!targetDay) {
      targetDay = {
        date,
        byProvider: new Map(),
        byModel: new Map(),
        runCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        touchedFileCount: 0,
      };
      target.byDay.set(date, targetDay);
    }
    mergeProviderMap(targetDay.byProvider, sourceDay.byProvider);
    for (const [model, cost] of sourceDay.byModel) {
      targetDay.byModel.set(model, (targetDay.byModel.get(model) ?? 0) + cost);
    }
    targetDay.runCount += sourceDay.runCount;
    targetDay.inputTokens += sourceDay.inputTokens;
    targetDay.outputTokens += sourceDay.outputTokens;
    targetDay.toolCallCount += sourceDay.toolCallCount;
    targetDay.touchedFileCount += sourceDay.touchedFileCount;
  }
  for (const [date, sourceProviders] of source.throughputByDay) {
    let targetProviders = target.throughputByDay.get(date);
    if (!targetProviders) {
      targetProviders = new Map();
      target.throughputByDay.set(date, targetProviders);
    }
    for (const [provider, sourceThroughput] of sourceProviders) {
      let targetThroughput = targetProviders.get(provider);
      if (!targetThroughput) {
        targetThroughput = { provider, outputTokens: 0, generationDurationMs: 0, sampleCount: 0 };
        targetProviders.set(provider, targetThroughput);
      }
      targetThroughput.outputTokens += sourceThroughput.outputTokens;
      targetThroughput.generationDurationMs += sourceThroughput.generationDurationMs;
      targetThroughput.sampleCount += sourceThroughput.sampleCount;
    }
  }
  for (const sessionPath of source.sessionPaths) target.sessionPaths.add(sessionPath);
  target.totalCost += source.totalCost;
  target.totalInputTokens += source.totalInputTokens;
  target.totalOutputTokens += source.totalOutputTokens;
  target.totalCacheReadTokens += source.totalCacheReadTokens;
  target.totalCacheWriteTokens += source.totalCacheWriteTokens;
  target.totalThroughputOutputTokens += source.totalThroughputOutputTokens;
  target.totalThroughputGenerationMs += source.totalThroughputGenerationMs;
  target.runCount += source.runCount;
  addSubagentLifecycleStats(target.subagentLifecycle, source.subagentLifecycle);

  for (const [date, samples] of source.costSamplesByDay) {
    const existing = target.costSamplesByDay.get(date);
    if (existing) existing.push(...samples);
    else target.costSamplesByDay.set(date, [...samples]);
  }
  for (const [date, samples] of source.tokenSamplesByDay) {
    const existing = target.tokenSamplesByDay.get(date);
    if (existing) existing.push(...samples);
    else target.tokenSamplesByDay.set(date, [...samples]);
  }
  for (const [date, sourceHours] of source.throughputByHourByDay) {
    let targetHours = target.throughputByHourByDay.get(date);
    if (!targetHours) {
      targetHours = new Map();
      target.throughputByHourByDay.set(date, targetHours);
    }
    for (const [hourMs, sourceHour] of sourceHours) {
      let targetHour = targetHours.get(hourMs);
      if (!targetHour) {
        targetHour = { byProvider: new Map(), byModel: new Map() };
        targetHours.set(hourMs, targetHour);
      }
      for (const [provider, values] of sourceHour.byProvider) {
        const entry = targetHour.byProvider.get(provider) ?? { out: 0, genMs: 0 };
        entry.out += values.out;
        entry.genMs += values.genMs;
        targetHour.byProvider.set(provider, entry);
      }
      for (const [model, values] of sourceHour.byModel) {
        const entry = targetHour.byModel.get(model) ?? { out: 0, genMs: 0 };
        entry.out += values.out;
        entry.genMs += values.genMs;
        targetHour.byModel.set(model, entry);
      }
    }
  }
  if (source.lastRun && source.lastRunEndedMs > target.lastRunEndedMs) {
    target.lastRunEndedMs = source.lastRunEndedMs;
    target.lastRun = source.lastRun;
  }
}

/** Merge independently accumulated run sets without revisiting their runs. */
export function mergeAggregateStatsAccumulators(
  ...accumulators: AggregateStatsAccumulator[]
): AggregateStatsAccumulator {
  const merged = createEmptyAccumulator();
  for (const source of accumulators) {
    mergeAccumulatorInto(merged, source);
  }
  return merged;
}

/** Derive today's per-provider cost and throughput from accumulated buckets. */
function buildTodayStats(
  todayDate: string,
  byDay: Map<string, DayAccumulator>,
  throughputByDay: Map<string, Map<string, ThroughputAcc>>,
): TodayStats {
  const todayAcc = byDay.get(todayDate);
  const todayCostByProvider: AggregateProviderCost[] = todayAcc
    ? [...todayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc)
    : [];
  const todayCost = todayCostByProvider.reduce((sum, entry) => sum + entry.cost, 0);

  const todayThroughputMap = throughputByDay.get(todayDate);
  const todayTokensPerSecondByProvider: AggregateProviderThroughput[] = todayThroughputMap
    ? [...todayThroughputMap.values()]
      .map(throughputAccToEntry)
      .filter((entry) => entry.sampleCount > 0)
      .sort(sortThroughputDesc)
    : [];

  let todayThroughputOutputTokens = 0;
  let todayThroughputGenerationMs = 0;
  if (todayThroughputMap) {
    for (const acc of todayThroughputMap.values()) {
      todayThroughputOutputTokens += acc.outputTokens;
      todayThroughputGenerationMs += acc.generationDurationMs;
    }
  }
  const todayTokensPerSecond = todayThroughputGenerationMs > 0
    ? todayThroughputOutputTokens / (todayThroughputGenerationMs / 1000)
    : 0;

  return {
    todayCost,
    todayCostByProvider,
    todayTokensPerSecond,
    todayTokensPerSecondByProvider,
  };
}

/** Merge a list of per-day per-provider cost rollups into a single provider list. */
function mergeDayProviders(
  days: AggregateDailyCost[],
): AggregateProviderCost[] {
  const merged = new Map<string, ProviderAccumulator>();
  for (const day of days) {
    for (const entry of day.byProvider) {
      let acc = merged.get(entry.provider);
      if (!acc) {
        acc = createProviderAccumulator(entry.provider);
        merged.set(entry.provider, acc);
      }
      acc.cost += entry.cost;
      acc.inputTokens += entry.inputTokens;
      acc.outputTokens += entry.outputTokens;
      acc.cacheReadTokens += entry.cacheReadTokens;
      acc.cacheWriteTokens += entry.cacheWriteTokens;
    }
  }
  return [...merged.values()].map(toProviderCost).sort(sortCostDesc);
}

/** Derive this-week per-provider cost and total from accumulated day buckets. */
function buildWeekStats(
  byDay: Map<string, DayAccumulator>,
  weekStartMs: number,
): WeekStats {
  const weekDays: AggregateDailyCost[] = [];
  for (let i = 0; i < WEEK_WINDOW_DAYS; i += 1) {
    const date = localDateString(weekStartMs + i * 86_400_000);
    const dayAcc = byDay.get(date);
    if (!dayAcc) continue;
    weekDays.push({
      date,
      totalCost: [...dayAcc.byProvider.values()].reduce((s, a) => s + a.cost, 0),
      byProvider: [...dayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc),
      byModel: dayModelCosts(dayAcc.byModel),
    });
  }
  const weekCostByProvider = mergeDayProviders(weekDays);
  const weekCost = weekCostByProvider.reduce((sum, entry) => sum + entry.cost, 0);
  return { weekCost, weekCostByProvider };
}

/** Build the daily cost series for the trailing window (oldest → newest). */
function buildDailyCostSeries(
  byDay: Map<string, DayAccumulator>,
  nowMs: number,
): AggregateDailyCost[] {
  const dailyCost: AggregateDailyCost[] = [];
  for (let i = DAILY_COST_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const dayMs = nowMs - i * 86_400_000;
    const date = localDateString(dayMs);
    const dayAcc = byDay.get(date);
    if (!dayAcc) continue;
    const byProvider = [...dayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc);
    dailyCost.push({
      date,
      totalCost: canonicalCostValue(byProvider.reduce((s, a) => s + a.cost, 0)),
      byProvider,
      byModel: dayModelCosts(dayAcc.byModel),
    });
  }
  return dailyCost;
}

/** Convert a day's per-model cost map to a sorted list (desc by cost). */
function dayModelCosts(byModel: Map<string, number>): AggregateDailyModelCost[] {
  return [...byModel.entries()]
    .map(([model, cost]) => ({ model, cost: canonicalCostValue(cost) }))
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

/** Round a cost value to a fixed number of decimal places for deterministic
 *  protocol-facing cumulative series output. Cost values are USD; 12 decimal
 *  places is well below any practical currency precision while eliminating
 *  order-of-addition ULP noise. */
function canonicalCostValue(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function sortSegmentsDesc(a: AggregateSeriesSegment, b: AggregateSeriesSegment): number {
  return b.value - a.value || a.key.localeCompare(b.key);
}

/** Internal bucket used while building a cumulative series. */
interface CumulativeBucket {
  ms: number;
  byProvider: Map<string, number>;
  byModel: Map<string, number>;
  byProviderModel: Map<string, { provider: string; model: string; value: number }>;
}

/**
 * Group raw cumulative-series samples into a bounded number of time buckets.
 * Samples at the same instant are merged first; if there are still too many
 * distinct instants, uniform-width time buckets are used. Provider/model values
 * are summed within each bucket so cumulative totals stay exact.
 */
function buildCumulativeBuckets<T extends { ms: number; provider: string; model: string; value: number }>(
  samples: T[],
  maxSampleBuckets: number,
  fixedRange?: { startMs: number; endMs: number },
  forceBucketing = false,
): CumulativeBucket[] {
  if (samples.length === 0 || maxSampleBuckets <= 0) return [];

  const sorted = [...samples].sort((a, b) => a.ms - b.ms);

  // First collapse samples that land at the exact same millisecond so repeated
  // events at one instant do not consume multiple chart points.
  const exactBuckets = new Map<number, CumulativeBucket>();
  for (const s of sorted) {
    let b = exactBuckets.get(s.ms);
    if (!b) {
      b = { ms: s.ms, byProvider: new Map(), byModel: new Map(), byProviderModel: new Map() };
      exactBuckets.set(s.ms, b);
    }
    b.byProvider.set(s.provider, (b.byProvider.get(s.provider) ?? 0) + s.value);
    b.byModel.set(s.model, (b.byModel.get(s.model) ?? 0) + s.value);
    const pairKey = `${s.provider}\u0000${s.model}`;
    const pair = b.byProviderModel.get(pairKey);
    if (pair) pair.value += s.value;
    else b.byProviderModel.set(pairKey, { provider: s.provider, model: s.model, value: s.value });
  }

  const buckets = [...exactBuckets.values()].sort((a, b) => a.ms - b.ms);
  if (buckets.length <= maxSampleBuckets && !forceBucketing) return buckets;

  // Too many distinct instants: uniform-width time buckets across the full range.
  const firstMs = fixedRange?.startMs ?? buckets[0].ms;
  const lastMs = fixedRange?.endMs ?? buckets[buckets.length - 1].ms;
  const duration = lastMs - firstMs;
  if (duration === 0) {
    // Every sample is at the same instant; merge everything into one bucket.
    const merged: CumulativeBucket = {
      ms: firstMs,
      byProvider: new Map(),
      byModel: new Map(),
      byProviderModel: new Map(),
    };
    for (const b of buckets) {
      for (const [k, v] of b.byProvider) {
        merged.byProvider.set(k, (merged.byProvider.get(k) ?? 0) + v);
      }
      for (const [k, v] of b.byModel) {
        merged.byModel.set(k, (merged.byModel.get(k) ?? 0) + v);
      }
      for (const [k, pair] of b.byProviderModel) {
        const target = merged.byProviderModel.get(k);
        if (target) target.value += pair.value;
        else merged.byProviderModel.set(k, { ...pair });
      }
    }
    return [merged];
  }

  const uniform = new Map<number, CumulativeBucket>();
  for (const b of buckets) {
    const idx = Math.min(maxSampleBuckets - 1, Math.floor(((b.ms - firstMs) * maxSampleBuckets) / duration));
    let u = uniform.get(idx);
    if (!u) {
      u = { ms: b.ms, byProvider: new Map(), byModel: new Map(), byProviderModel: new Map() };
      uniform.set(idx, u);
    }
    for (const [k, v] of b.byProvider) {
      u.byProvider.set(k, (u.byProvider.get(k) ?? 0) + v);
    }
    for (const [k, v] of b.byModel) {
      u.byModel.set(k, (u.byModel.get(k) ?? 0) + v);
    }
    for (const [k, pair] of b.byProviderModel) {
      const target = u.byProviderModel.get(k);
      if (target) target.value += pair.value;
      else u.byProviderModel.set(k, { ...pair });
    }
  }
  return [...uniform.entries()].sort((a, b) => a[0] - b[0]).map(([_, b]) => b);
}

/** Build a cumulative stacked series (cost or tokens) from per-turn samples,
 *  pruned to [first sample, now] with a trailing "now" point so the area
 *  extends to the current moment. Each point carries cumulative per-provider
 *  and per-model breakdowns (the chart steps up at each point).
 *
 *  To keep the snapshot payload bounded, raw samples are accumulated into at
 *  most `maxPoints - 1` time buckets; one point is always reserved for the
 *  trailing "now" value. */
export function buildCumulativeSeries(
  samples: { ms: number; provider: string; model: string; value: number }[],
  nowMs: number,
  maxPoints: number = MAX_INTRADAY_CHART_POINTS,
  options: { forceBucketing?: boolean; targetTotals?: { byProvider: AggregateSeriesSegment[]; byModel: AggregateSeriesSegment[] }; roundValues?: boolean } = {},
): AggregateSeriesPoint[] {
  if (samples.length === 0 || maxPoints < 2) return [];
  const normalizedOptions = typeof options === 'boolean' ? { forceBucketing: options } : options;
  const forceBucketing = normalizedOptions.forceBucketing ?? false;
  const targetTotals = normalizedOptions.targetTotals;
  const roundValues = normalizedOptions.roundValues ?? false;
  const now = new Date(nowMs);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const todayDate = localDateString(nowMs);
  const allToday = samples.every((sample) => localDateString(sample.ms) === todayDate);
  // A stable whole-local-day grid makes downsampling composable: a cached
  // completed layer and a separately accumulated open layer produce exactly
  // the same buckets as a one-pass finalize, even after either side exceeds
  // the point cap.
  const buckets = buildCumulativeBuckets(
    samples,
    maxPoints - 1,
    allToday ? { startMs: dayStart.getTime(), endMs: nextDay.getTime() } : undefined,
    forceBucketing,
  );
  const byProvider = new Map<string, number>();
  const byModel = new Map<string, number>();
  const seg = (m: Map<string, number>): AggregateSeriesSegment[] =>
    [...m.entries()]
      .map(([key, value]) => ({ key, value: roundValues ? canonicalCostValue(value) : value }))
      .sort(sortSegmentsDesc);
  const points: AggregateSeriesPoint[] = [];
  for (const b of buckets) {
    for (const [provider, value] of b.byProvider) {
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + value);
    }
    for (const [model, value] of b.byModel) {
      byModel.set(model, (byModel.get(model) ?? 0) + value);
    }
    points.push({ ms: b.ms, byProvider: seg(byProvider), byModel: seg(byModel) });
  }
  // Trailing "now" point (current cumulative) so the chart extends to now.
  const last = points[points.length - 1]!;
  if (last.ms < nowMs) {
    points.push({ ms: nowMs, byProvider: seg(byProvider), byModel: seg(byModel) });
  }
  // Snap the final cumulative point to the canonical aggregate totals so the
  // chart's top-right value always matches the aggregate cost total and is
  // independent of whether the series was built one-pass or from a compacted
  // completed layer.
  if (targetTotals && points.length > 0) {
    const final = points[points.length - 1]!;
    final.byProvider = targetTotals.byProvider;
    final.byModel = targetTotals.byModel;
  }
  return points;
}

/** Build today's per-hour throughput series (rate, not cumulative). One point
 *  per hour with data; ends at the last active hour. */
function buildThroughputSeries(byHour: Map<number, HourThroughput>): AggregateSeriesPoint[] {
  if (byHour.size === 0) return [];
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const rate = (out: number, genMs: number) => (genMs > 0 ? out / (genMs / 1000) : 0);
  const points: AggregateSeriesPoint[] = [];
  for (const hourMs of hours) {
    const hour = byHour.get(hourMs)!;
    points.push({
      ms: hourMs,
      byProvider: [...hour.byProvider.entries()].map(([key, v]) => ({ key, value: rate(v.out, v.genMs) })).sort((a, b) => b.value - a.value),
      byModel: [...hour.byModel.entries()].map(([key, v]) => ({ key, value: rate(v.out, v.genMs) })).sort((a, b) => b.value - a.value),
    });
  }
  return points;
}

/** Build the 14-day run-count series (ascending date), pruning leading
 *  zero-run days while keeping the trailing run through today for context. */
function buildDailyRunCount(byDay: Map<string, DayAccumulator>, nowMs: number): AggregateDailyRunCount[] {
  const out: AggregateDailyRunCount[] = [];
  for (let i = DAILY_COST_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const dayMs = nowMs - i * 86_400_000;
    const date = localDateString(dayMs);
    out.push({ date, runCount: byDay.get(date)?.runCount ?? 0 });
  }
  let first = 0;
  while (first < out.length - 1 && out[first]!.runCount === 0) first += 1;
  return out.slice(first);
}

/**
 * Sum measured tok/s across running sessions that are actively generating.
 * Paused sessions holding a stale rate are intentionally excluded.
 */
function computeLiveTokensPerSecond(
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
): LiveStats {
  let liveTokensPerSecond = 0;
  const runningSet = new Set(runningSessionPaths);
  for (const sessionPath of runningSet) {
    const state = ratesBySession[sessionPath];
    if (
      state
      && state.state === 'generating'
      && typeof state.rate === 'number'
      && Number.isFinite(state.rate)
      && state.rate > 0
    ) {
      liveTokensPerSecond += state.rate;
    }
  }
  return { liveTokensPerSecond, runningSessionCount: runningSet.size };
}

/** Compact one day's raw samples into the same bounded buckets used by the
 * protocol chart while retaining provider/model pair attribution. */
function compactIntradaySamples<T extends { ms: number; provider: string; model: string }>(
  samples: T[],
  valueOf: (sample: T) => number,
  create: (ms: number, provider: string, model: string, value: number) => T,
  fixedRange: { startMs: number; endMs: number },
): { samples: T[]; compacted: boolean } {
  const wasCompacted = new Set(samples.map((sample) => sample.ms)).size > MAX_INTRADAY_CHART_POINTS - 1;
  const buckets = buildCumulativeBuckets(
    samples.map((sample) => ({ ...sample, value: valueOf(sample) })),
    MAX_INTRADAY_CHART_POINTS - 1,
    fixedRange,
  );
  const compactedSamples: T[] = [];
  for (const bucket of buckets) {
    for (const pair of bucket.byProviderModel.values()) {
      compactedSamples.push(create(bucket.ms, pair.provider, pair.model, pair.value));
    }
  }
  return { samples: compactedSamples, compacted: wasCompacted };
}

/**
 * Prepare completed history for repeated open-run overlays. Only the fixed
 * trailing date windows and a bounded representation of today's raw chart
 * samples are retained. All-time scalars/provider maps remain exact.
 */
export function prepareAggregateStatsLayer(
  source: AggregateStatsAccumulator,
  nowMs: number,
  instrumentation?: AggregateStatsLayerInstrumentation,
): PreparedAggregateStatsLayer {
  const todayDate = localDateString(nowMs);
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const fixedIntradayRange = { startMs: dayStart.getTime(), endMs: nextDay.getTime() };
  const windowDates = new Set<string>();
  for (let i = 0; i < DAILY_COST_WINDOW_DAYS; i += 1) {
    windowDates.add(localDateString(nowMs - i * 86_400_000));
  }

  const byDay = new Map<string, DayAccumulator>();
  for (const date of windowDates) {
    const day = source.byDay.get(date);
    if (!day) continue;
    instrumentation?.onCompletedSourceEntryVisited?.('day');
    byDay.set(date, day);
  }

  const costSource = source.costSamplesByDay.get(todayDate) ?? [];
  for (let i = 0; i < costSource.length; i += 1) {
    instrumentation?.onCompletedSourceEntryVisited?.('cost_sample');
  }
  const tokenSource = source.tokenSamplesByDay.get(todayDate) ?? [];
  for (let i = 0; i < tokenSource.length; i += 1) {
    instrumentation?.onCompletedSourceEntryVisited?.('token_sample');
  }
  const compactedCost = compactIntradaySamples(
    costSource,
    (sample) => sample.cost,
    (ms, provider, model, cost) => ({ ms, provider, model, cost }),
    fixedIntradayRange,
  );
  const compactedTokens = compactIntradaySamples(
    tokenSource,
    (sample) => sample.tokens,
    (ms, provider, model, tokens) => ({ ms, provider, model, tokens }),
    fixedIntradayRange,
  );

  const throughputHours = source.throughputByHourByDay.get(todayDate);
  if (throughputHours) {
    for (const _hour of throughputHours) {
      instrumentation?.onCompletedSourceEntryVisited?.('throughput_hour');
    }
  }

  return {
    completedSessionPaths: source.sessionPaths,
    costSamplesCompacted: compactedCost.compacted,
    tokenSamplesCompacted: compactedTokens.compacted,
    accumulator: {
      byProvider: source.byProvider,
      byDay,
      throughputByDay: source.throughputByDay.has(todayDate)
        ? new Map([[todayDate, source.throughputByDay.get(todayDate)!]])
        : new Map(),
      // Session union is handled without copying this potentially historical set
      // in finalizeAggregateStatsLayers.
      sessionPaths: new Set(),
      totalCost: source.totalCost,
      totalInputTokens: source.totalInputTokens,
      totalOutputTokens: source.totalOutputTokens,
      totalCacheReadTokens: source.totalCacheReadTokens,
      totalCacheWriteTokens: source.totalCacheWriteTokens,
      totalThroughputOutputTokens: source.totalThroughputOutputTokens,
      totalThroughputGenerationMs: source.totalThroughputGenerationMs,
      costSamplesByDay: compactedCost.samples.length > 0 ? new Map([[todayDate, compactedCost.samples]]) : new Map(),
      tokenSamplesByDay: compactedTokens.samples.length > 0 ? new Map([[todayDate, compactedTokens.samples]]) : new Map(),
      throughputByHourByDay: throughputHours ? new Map([[todayDate, throughputHours]]) : new Map(),
      lastRunEndedMs: source.lastRunEndedMs,
      lastRun: source.lastRun,
      runCount: source.runCount,
      subagentLifecycle: source.subagentLifecycle,
    },
  };
}

/** Finalize a cached completed layer plus a mutable open-run accumulator. */
export function finalizeAggregateStatsLayers(
  completed: PreparedAggregateStatsLayer,
  open: AggregateStatsAccumulator,
  nowMs: number,
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
  openTabCount: number,
): AggregateStats {
  const merged = mergeAggregateStatsAccumulators(completed.accumulator, open);
  const stats = finalizeAggregateStats(
    merged,
    nowMs,
    runningSessionPaths,
    ratesBySession,
    openTabCount,
    {
      forceCostSeriesBucketing: completed.costSamplesCompacted,
      forceTokenSeriesBucketing: completed.tokenSamplesCompacted,
    },
  );
  let sessionCount = completed.completedSessionPaths.size;
  for (const sessionPath of open.sessionPaths) {
    if (!completed.completedSessionPaths.has(sessionPath)) sessionCount += 1;
  }
  stats.sessionCount = sessionCount;
  return stats;
}

/** Convert a merged run accumulator into the protocol-facing aggregate. */
export function finalizeAggregateStats(
  acc: AggregateStatsAccumulator,
  nowMs: number,
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
  openTabCount: number,
  options: { forceCostSeriesBucketing?: boolean; forceTokenSeriesBucketing?: boolean } = {},
): AggregateStats {
  const { todayDate, weekStartMs, weekDates } = buildDateWindows(nowMs);

  // ── All-time per-provider rollups ──
  const costByProvider = [...acc.byProvider.values()]
    .map(toProviderCost)
    .sort(sortCostDesc);

  const tokensPerSecondByProvider = [...acc.byProvider.values()]
    .map(toProviderThroughput)
    .filter((entry) => entry.sampleCount > 0)
    .sort(sortThroughputDesc);

  const tokensPerSecond = acc.totalThroughputGenerationMs > 0
    ? acc.totalThroughputOutputTokens / (acc.totalThroughputGenerationMs / 1000)
    : 0;

  // ── Today / week / daily rollups ──
  const todayStats = buildTodayStats(todayDate, acc.byDay, acc.throughputByDay);
  const weekStats = buildWeekStats(acc.byDay, weekStartMs);
  const dailyCost = buildDailyCostSeries(acc.byDay, nowMs);
  const todayDay = acc.byDay.get(todayDate);
  const todayCostSeriesTotals = todayDay
    ? {
        byProvider: todayStats.todayCostByProvider.map((entry) => ({ key: entry.provider, value: entry.cost })),
        byModel: dayModelCosts(todayDay.byModel).map((entry) => ({ key: entry.model, value: entry.cost })),
      }
    : undefined;
  const todayCostSeries = buildCumulativeSeries(
    (acc.costSamplesByDay.get(todayDate) ?? [])
      .map((s) => ({ ms: s.ms, provider: s.provider, model: s.model, value: s.cost })),
    nowMs,
    MAX_INTRADAY_CHART_POINTS,
    { forceBucketing: options.forceCostSeriesBucketing, targetTotals: todayCostSeriesTotals, roundValues: true },
  );
  const todayTokenSeries = buildCumulativeSeries(
    (acc.tokenSamplesByDay.get(todayDate) ?? [])
      .map((s) => ({ ms: s.ms, provider: s.provider, model: s.model, value: s.tokens })),
    nowMs,
    MAX_INTRADAY_CHART_POINTS,
    { forceBucketing: options.forceTokenSeriesBucketing },
  );
  const todayThroughputSeries = buildThroughputSeries(
    acc.throughputByHourByDay.get(todayDate) ?? new Map(),
  );
  const dailyRunCount = buildDailyRunCount(acc.byDay, nowMs);
  let weekRunCount = 0;
  for (const date of weekDates) weekRunCount += acc.byDay.get(date)?.runCount ?? 0;

  // ── Live aggregate tok/s ──
  const liveStats = computeLiveTokensPerSecond(runningSessionPaths, ratesBySession);

  return {
    todayCost: todayStats.todayCost,
    todayCostByProvider: todayStats.todayCostByProvider,
    todayTokensPerSecond: todayStats.todayTokensPerSecond,
    todayTokensPerSecondByProvider: todayStats.todayTokensPerSecondByProvider,
    todayRunCount: todayDay?.runCount ?? 0,
    todayInputTokens: todayDay?.inputTokens ?? 0,
    todayOutputTokens: todayDay?.outputTokens ?? 0,
    todayToolCallCount: todayDay?.toolCallCount ?? 0,
    todayTouchedFileCount: todayDay?.touchedFileCount ?? 0,
    todayCostSeries,
    todayTokenSeries,
    todayThroughputSeries,
    weekCost: weekStats.weekCost,
    weekCostByProvider: weekStats.weekCostByProvider,
    weekRunCount,
    dailyCost,
    dailyRunCount,
    liveTokensPerSecond: liveStats.liveTokensPerSecond,
    runningSessionCount: liveStats.runningSessionCount,
    openTabCount,
    subagentLifecycle: acc.subagentLifecycle,
    totalCost: canonicalCostValue(acc.totalCost),
    costByProvider,
    tokensPerSecond,
    tokensPerSecondByProvider,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    totalCacheReadTokens: acc.totalCacheReadTokens,
    totalCacheWriteTokens: acc.totalCacheWriteTokens,
    runCount: acc.runCount,
    sessionCount: acc.sessionPaths.size,
    lastRun: acc.lastRun,
    providerGate: EMPTY_PROVIDER_GATE_STATS,
    ready: true,
  };
}

/**
 * Compatibility wrapper for callers that still provide raw runs. New code can
 * cache/merge {@link accumulateAggregateStats} results before finalizing.
 */
export function computeAggregateStats(
  runs: RunSnapshot[],
  pricingMap: Map<string, ModelPricingRecord[]>,
  nowMs: number,
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
  openTabCount: number,
): AggregateStats {
  return finalizeAggregateStats(
    accumulateAggregateStats(runs, pricingMap),
    nowMs,
    runningSessionPaths,
    ratesBySession,
    openTabCount,
  );
}
