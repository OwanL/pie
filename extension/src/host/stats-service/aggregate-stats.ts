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
import type {
  AggregateDailyCost,
  AggregateLastRun,
  AggregateProviderCost,
  AggregateProviderThroughput,
  AggregateStats,
} from '../../shared/protocol';
import { EMPTY_PROVIDER_GATE_STATS, EMPTY_WARM_BASH_STATS } from '../../shared/protocol/aggregate-stats';
import type { TokenRateIndicatorState } from '../../shared/token-rate';
import type { RunSnapshot } from '../run-analytics';

/** How many trailing days (inclusive of today) the daily-cost series covers. */
export const DAILY_COST_WINDOW_DAYS = 14;
/** Length of the rolling "this week" cost window (inclusive of today). */
export const WEEK_WINDOW_DAYS = 7;

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

/** Minimal throughput accumulator for a (date, provider) bucket. */
interface ThroughputAcc {
  provider: string;
  outputTokens: number;
  generationDurationMs: number;
  sampleCount: number;
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

/**
 * Compute aggregate stats from raw runs + pricing.
 *
 * @param runs all runs (completed + open) for the workspace.
 * @param pricingMap model id → pricing records (from `loadModelPricing`).
 * @param nowMs current wall-clock (ms epoch); used for "today" + the daily/week windows.
 * @param runningSessionPaths currently-running session paths (for the live count).
 * @param ratesBySession live per-session rate states (from `TokenRateService`).
 * @param openTabCount currently-open session tabs (current UI state).
 */
export function computeAggregateStats(
  runs: RunSnapshot[],
  pricingMap: Map<string, ModelPricingRecord[]>,
  nowMs: number,
  runningSessionPaths: string[],
  ratesBySession: Record<string, TokenRateIndicatorState>,
  openTabCount: number,
): AggregateStats {
  const byProvider = new Map<string, ProviderAccumulator>();
  const byDay = new Map<string, DayAccumulator>();
  // Throughput bucketed by the SAMPLE's end-date (a run spanning midnight
  // attributes its samples to the day they actually landed, so "today's
  // throughput" reflects today's generation, not today's runs).
  const throughputByDay = new Map<string, Map<string, ThroughputAcc>>();
  const sessionPaths = new Set<string>();

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalThroughputOutputTokens = 0;
  let totalThroughputGenerationMs = 0;

  const todayDate = utcDateString(nowMs);
  const weekStartMs = nowMs - (WEEK_WINDOW_DAYS - 1) * 86_400_000;
  const weekDates = new Set<string>();
  for (let i = 0; i < WEEK_WINDOW_DAYS; i += 1) {
    weekDates.add(utcDateString(weekStartMs + i * 86_400_000));
  }

  let todayRunCount = 0;
  let weekRunCount = 0;
  let todayInputTokens = 0;
  let todayOutputTokens = 0;
  let todayToolCallCount = 0;
  let todayTouchedFileCount = 0;

  // Most-recent finalized run (max endedAt across all runs).
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
        // All-time per-provider throughput.
        acc.throughputOutputTokens += sample.outputTokens;
        acc.throughputGenerationMs += sample.generationDurationMs;
        acc.sampleCount += 1;
        totalThroughputOutputTokens += sample.outputTokens;
        totalThroughputGenerationMs += sample.generationDurationMs;
        // Per-day throughput (by sample end-date) for "today's throughput".
        const sampleMs = Date.parse(sample.endedAt);
        if (!Number.isNaN(sampleMs)) {
          const sampleDate = utcDateString(sampleMs);
          const tAcc = dayThroughput(sampleDate, provider);
          tAcc.outputTokens += sample.outputTokens;
          tAcc.generationDurationMs += sample.generationDurationMs;
          tAcc.sampleCount += 1;
        }
      }
    }

    // Day cost bucket (UTC, by run day).
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

      // Run-count buckets (by run day).
      if (date === todayDate) {
        todayRunCount += 1;
        todayInputTokens += run.inputTokens;
        todayOutputTokens += run.outputTokens;
        todayToolCallCount += run.toolUsage?.totalCount ?? 0;
        todayTouchedFileCount += run.fileMutation?.touchedFileCount ?? 0;
      }
      if (weekDates.has(date)) weekRunCount += 1;
    }

    // Track the most-recent run by its end timestamp (finalizedAt else updatedAt
    // else startedAt). Open (in-flight) runs are included so the bar reflects a
    // run that just started, but a finalized run with a later endedAt wins.
    const endedMs = runDayMs(run);
    if (!Number.isNaN(endedMs) && endedMs > lastRunEndedMs) {
      lastRunEndedMs = endedMs;
      lastRun = {
        cost,
        durationMs: run.busyDurationMs ?? 0,
        modelId: run.modelId ?? null,
        provider,
        outcome: run.outcome ?? null,
        startedAt: run.startedAt,
        endedAt: run.finalizedAt ?? run.updatedAt,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
      };
    }
  }

  // ── All-time per-provider rollups ──
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

  // ── Today per-provider ──
  const todayAcc = byDay.get(todayDate);
  const todayCostByProvider: AggregateProviderCost[] = todayAcc
    ? [...todayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc)
    : [];
  const todayCost = todayCostByProvider.reduce((sum, entry) => sum + entry.cost, 0);

  const todayThroughputMap = throughputByDay.get(todayDate);
  const todayTokensPerSecondByProvider: AggregateProviderThroughput[] = todayThroughputMap
    ? [...todayThroughputMap.values()].map(throughputAccToEntry).filter((e) => e.sampleCount > 0).sort(sortThroughputDesc)
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

  // ── Week (last 7 days) per-provider ──
  const weekDays: AggregateDailyCost[] = [];
  for (let i = 0; i < WEEK_WINDOW_DAYS; i += 1) {
    const date = utcDateString(weekStartMs + i * 86_400_000);
    const dayAcc = byDay.get(date);
    if (!dayAcc) continue;
    weekDays.push({
      date,
      totalCost: [...dayAcc.byProvider.values()].reduce((s, a) => s + a.cost, 0),
      byProvider: [...dayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc),
    });
  }
  const weekCostByProvider = mergeDayProviders(weekDays);
  const weekCost = weekCostByProvider.reduce((sum, entry) => sum + entry.cost, 0);

  // ── Daily series (last 14 days, ascending date) — tooltip context ──
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

  // ── Live aggregate tok/s: sum of measured rates across running sessions ──
  // Only sessions ACTIVELY generating contribute. A session paused on a tool
  // call (or between turns) holds its last rate for the chip display (the
  // chip shows '⏸ 200 tok/s' — see token-rate.ts, whose paused branch returns
  // state:'paused' with a held `rate`) but must NOT inflate the status-bar
  // total for the whole tool-call duration. The contract documents this as
  // "0 when no session is generating". Filtering on `state.state ===
  // 'generating'` (in addition to `rate > 0`) is what excludes the stale held
  // rate; `rate > 0` alone sums it for the entire pause.
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

  return {
    todayCost,
    todayCostByProvider,
    todayTokensPerSecond,
    todayTokensPerSecondByProvider,
    todayRunCount,
    todayInputTokens,
    todayOutputTokens,
    todayToolCallCount,
    todayTouchedFileCount,
    weekCost,
    weekCostByProvider,
    weekRunCount,
    dailyCost,
    liveTokensPerSecond,
    runningSessionCount: runningSet.size,
    openTabCount,
    totalCost,
    costByProvider,
    tokensPerSecond,
    tokensPerSecondByProvider,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    runCount: runs.length,
    sessionCount: sessionPaths.size,
    lastRun,
    warmBash: EMPTY_WARM_BASH_STATS,
    providerGate: EMPTY_PROVIDER_GATE_STATS,
    ready: true,
  };
}
