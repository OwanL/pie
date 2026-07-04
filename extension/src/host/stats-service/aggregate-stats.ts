/**
 * Pure aggregate-stats computation, extracted from {@link AggregateStatsService}
 * so it is unit-testable in isolation (no I/O, no timers).
 *
 * Given the raw {@link RunSnapshot}s (completed + open), a model-pricing map,
 * the set of currently-running session paths, and the live per-session rate
 * states, it rolls up cost / tokens / throughput per provider and overall.
 *
 * Provider attribution policy: see {@link ../../shared/protocol/aggregate-stats.ts}.
 */

import type { ModelPricingRecord, ModelTokenPricing } from '../../backend/pricing';
import type {
  AggregateDailyCost,
  AggregateProviderCost,
  AggregateProviderThroughput,
  AggregateStats,
} from '../../shared/protocol';
import type { TokenRateIndicatorState } from '../../shared/token-rate';
import type { RunSnapshot, TurnThroughputSample } from '../run-analytics';

/** How many trailing days (inclusive of today) the daily-cost series covers. */
export const DAILY_COST_WINDOW_DAYS = 14;

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

/** Resolve the provider name for a model id (first priced provider), or `'unknown'`. */
export function providerForModel(
  modelId: string | undefined,
  pricingMap: Map<string, ModelPricingRecord[]>,
): string {
  if (!modelId) return 'unknown';
  const records = pricingMap.get(modelId);
  if (!records || records.length === 0) return 'unknown';
  const priced = records.find((r) => r.pricing !== undefined);
  return priced?.provider ?? records[0]!.provider;
}

/** Resolve the token pricing for a model id (first priced record), or `null`. */
export function pricingForModel(
  modelId: string | undefined,
  pricingMap: Map<string, ModelPricingRecord[]>,
): ModelTokenPricing | null {
  if (!modelId) return null;
  const records = pricingMap.get(modelId);
  if (!records) return null;
  const priced = records.find((r) => r.pricing !== undefined);
  return priced?.pricing ?? null;
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
  return (
    (inputTokens / 1_000_000) * pricing.input
    + (outputTokens / 1_000_000) * pricing.output
    + (cacheReadTokens / 1_000_000) * pricing.cacheRead
    + (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
  );
}

/** UTC calendar date (`YYYY-MM-DD`) for a millisecond epoch timestamp. */
function utcDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
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
    cost: acc.cost,
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

function sortCostDesc(a: AggregateProviderCost, b: AggregateProviderCost): number {
  return b.cost - a.cost || a.provider.localeCompare(b.provider);
}

function sortThroughputDesc(a: AggregateProviderThroughput, b: AggregateProviderThroughput): number {
  return b.outputTokens - a.outputTokens || a.provider.localeCompare(b.provider);
}

/**
 * Compute aggregate stats from raw runs + pricing.
 *
 * @param runs all runs (completed + open) for the workspace.
 * @param pricingMap model id → pricing records (from `loadModelPricing`).
 * @param nowMs current wall-clock (ms epoch); used for "today" + the daily window.
 * @param runningSessionPaths currently-running session paths (for the live count).
 * @param ratesBySession live per-session rate states (from `TokenRateService`).
 */
export function computeAggregateStats(
  runs: RunSnapshot[],
  pricingMap: Map<string, ModelPricingRecord[]>,
  nowMs: number,
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
): AggregateStats {
  const byProvider = new Map<string, ProviderAccumulator>();
  const byDay = new Map<string, DayAccumulator>();
  const sessionPaths = new Set<string>();

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalThroughputOutputTokens = 0;
  let totalThroughputGenerationMs = 0;

  const todayDate = utcDateString(nowMs);

  const providerAcc = (provider: string): ProviderAccumulator => {
    let acc = byProvider.get(provider);
    if (!acc) {
      acc = createProviderAccumulator(provider);
      byProvider.set(provider, acc);
    }
    return acc;
  };

  for (const run of runs) {
    if (run.sessionPath) sessionPaths.add(run.sessionPath);
    const provider = providerForModel(run.modelId, pricingMap);
    const pricing = pricingForModel(run.modelId, pricingMap);
    const acc = providerAcc(provider);

    const cost = costFromTokens(
      run.inputTokens,
      run.outputTokens,
      run.cacheReadTokens,
      run.cacheWriteTokens,
      pricing,
    );

    acc.cost += cost;
    acc.inputTokens += run.inputTokens;
    acc.outputTokens += run.outputTokens;
    acc.cacheReadTokens += run.cacheReadTokens;
    acc.cacheWriteTokens += run.cacheWriteTokens;

    totalCost += cost;
    totalInputTokens += run.inputTokens;
    totalOutputTokens += run.outputTokens;
    totalCacheReadTokens += run.cacheReadTokens;
    totalCacheWriteTokens += run.cacheWriteTokens;

    // Throughput: completed turns with measurable generation time only.
    // Interrupted/error turns are excluded so a rate-limited/failed turn doesn't
    // drag the average (their tokens are near-zero and durations unreliable).
    if (run.turnThroughputSamples.length > 0) {
      for (const sample of run.turnThroughputSamples) {
        if (sample.status !== 'completed') continue;
        if (sample.generationDurationMs <= 0) continue;
        acc.throughputOutputTokens += sample.outputTokens;
        acc.throughputGenerationMs += sample.generationDurationMs;
        acc.sampleCount += 1;
        totalThroughputOutputTokens += sample.outputTokens;
        totalThroughputGenerationMs += sample.generationDurationMs;
      }
    }

    // Day bucket (UTC).
    const dayMs = runDayMs(run);
    if (!Number.isNaN(dayMs)) {
      const date = utcDateString(dayMs);
      let day = byDay.get(date);
      if (!day) {
        day = { date, byProvider: new Map() };
        byDay.set(date, day);
      }
      let dayAcc = day.byProvider.get(provider);
      if (!dayAcc) {
        dayAcc = createProviderAccumulator(provider);
        day.byProvider.set(provider, dayAcc);
      }
      dayAcc.cost += cost;
      dayAcc.inputTokens += run.inputTokens;
      dayAcc.outputTokens += run.outputTokens;
      dayAcc.cacheReadTokens += run.cacheReadTokens;
      dayAcc.cacheWriteTokens += run.cacheWriteTokens;
    }
  }

  const costByProvider = [...byProvider.values()]
    .map(toProviderCost)
    .sort(sortCostDesc);

  const tokensPerSecondByProvider = [...byProvider.values()]
    .map(toProviderThroughput)
    .filter((entry) => entry.sampleCount > 0)
    .sort(sortThroughputDesc);

  const tokensPerSecond = totalThroughputGenerationMs > 0
    ? totalThroughputOutputTokens / (totalThroughputGenerationMs / 1000)
    : 0;

  // Today's per-provider spend.
  const todayAcc = byDay.get(todayDate);
  const todayCostByProvider: AggregateProviderCost[] = todayAcc
    ? [...todayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc)
    : [];
  const todayCost = todayCostByProvider.reduce((sum, entry) => sum + entry.cost, 0);

  // Trailing N-day series (ascending date), zero-cost days omitted.
  const dailyCost: AggregateDailyCost[] = [];
  for (let i = DAILY_COST_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const dayMs = nowMs - i * 86_400_000;
    const date = utcDateString(dayMs);
    const dayAcc = byDay.get(date);
    if (!dayAcc) continue;
    dailyCost.push({
      date,
      totalCost: [...dayAcc.byProvider.values()].reduce((s, a) => s + a.cost, 0),
      byProvider: [...dayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc),
    });
  }

  // Live aggregate tok/s: sum of measured rates across currently-running sessions.
  let liveTokensPerSecond = 0;
  const runningSet = new Set(runningSessionPaths);
  for (const sessionPath of runningSet) {
    const state = ratesBySession[sessionPath];
    if (state && typeof state.rate === 'number' && Number.isFinite(state.rate) && state.rate > 0) {
      liveTokensPerSecond += state.rate;
    }
  }

  return {
    totalCost,
    costByProvider,
    todayCost,
    todayCostByProvider,
    dailyCost,
    tokensPerSecond,
    tokensPerSecondByProvider,
    liveTokensPerSecond,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    runCount: runs.length,
    sessionCount: sessionPaths.size,
    runningSessionCount: runningSet.size,
    ready: true,
  };
}

/** Re-exported for tests / consumers that need the sample type. */
export type { TurnThroughputSample };
