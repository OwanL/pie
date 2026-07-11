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
  AggregateDailyModelCost,
  AggregateDailyRunCount,
  AggregateLastRun,
  AggregateLastRunTurn,
  AggregateProviderCost,
  AggregateProviderThroughput,
  AggregateSeriesPoint,
  AggregateSeriesSegment,
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
  /** Per-model cost within this day (for the weekly chart's per-model hover). */
  byModel: Map<string, number>;
  /** Number of runs bucketed to this day. */
  runCount: number;
}

/** A timestamped sample for today's intraday cost series. */
interface TodayCostSample {
  ms: number;
  provider: string;
  model: string;
  cost: number;
}

/** A timestamped sample for today's intraday output-token series. */
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

/** Accumulated run statistics produced by a single pass over the runs. */
interface RunAccumulations {
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
  todayRunCount: number;
  weekRunCount: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayToolCallCount: number;
  todayTouchedFileCount: number;
  todayCostSamples: TodayCostSample[];
  todayTokenSamples: TodayTokenSample[];
  todayThroughputByHour: Map<number, HourThroughput>;
  lastRunTurnSeries: AggregateLastRunTurn[];
  lastRun: AggregateLastRun | null;
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

function usageTotal(usage: TokenCounts): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function subtractUsage(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
  };
}

function usageForModel(
  model: string,
  occurredAtMs: number,
  counts: TokenCounts,
  pricingMap: Map<string, ModelPricingRecord[]>,
): AttributedUsage {
  const pricing = pricingForModel(model === 'unknown' ? undefined : model, pricingMap);
  return {
    ...counts,
    model,
    provider: providerForModel(model === 'unknown' ? undefined : model, pricingMap),
    occurredAtMs,
    cost: costFromTokens(
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
  const usage: AttributedUsage[] = [usageForModel(runModel, fallbackMs, {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
  }, pricingMap)];
  const auxiliary = run.auxiliaryLlmUsage ?? [];
  const seen = new Set<string>();

  for (const sample of auxiliary) {
    if (sample.kind !== 'skill_pruning_prepass') continue;
    const dedupKey = `${sample.kind}:${sample.sourceId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const counts = {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    };
    if (usageTotal(counts) === 0) continue;
    const occurredAtMs = Date.parse(sample.occurredAt);
    usage.push(usageForModel(
      sample.modelId ?? runModel,
      Number.isNaN(occurredAtMs) ? fallbackMs : occurredAtMs,
      counts,
      pricingMap,
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
    usage.push(usageForModel(
      sample.modelId ?? runModel,
      Number.isNaN(occurredAtMs) ? fallbackMs : occurredAtMs,
      counts,
      pricingMap,
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
    usage.push(usageForModel(fallbackModel, fallbackMs, remaining, pricingMap));
  }

  return usage;
}

function distributeUsageForSeries(
  run: RunSnapshot,
  usage: AttributedUsage[],
  fallbackMs: number,
  includeSample: (ms: number) => boolean,
): { cost: TodayCostSample[]; tokens: TodayTokenSample[] } {
  const groups = new Map<string, AttributedUsage>();
  for (const item of usage) {
    const current = groups.get(item.model);
    if (!current) {
      groups.set(item.model, { ...item });
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
        && (sample.modelId ?? run.modelId ?? 'unknown') === group.model);
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
 * Single pass over all runs that accumulates per-provider, per-day, and
 * per-day-throughput statistics, plus today / week counts and the most-recent
 * run. Returns all intermediate state so the caller can derive the final
 * rollups.
 */
function accumulateRuns(
  runs: RunSnapshot[],
  pricingMap: Map<string, ModelPricingRecord[]>,
  todayDate: string,
  weekDates: Set<string>,
): RunAccumulations {
  const byProvider = new Map<string, ProviderAccumulator>();
  const byDay = new Map<string, DayAccumulator>();
  // Throughput bucketed by the SAMPLE's end-date (a run spanning midnight
  // attributes its samples to the day they actually landed, so "today's
  // throughput" reflects today's generation, not today's runs).
  const throughputByDay = new Map<string, Map<string, ThroughputAcc>>();
  const sessionPaths = new Set<string>();
  // Intraday series collections (today only, local day).
  const todayCostSamples: TodayCostSample[] = [];
  const todayTokenSamples: TodayTokenSample[] = [];
  const todayThroughputByHour = new Map<number, HourThroughput>();
  let lastRunTurnSeries: AggregateLastRunTurn[] = [];

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalThroughputOutputTokens = 0;
  let totalThroughputGenerationMs = 0;

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
    const dayMs = runDayMs(run);
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
      const sampleProvider = providerForModel(sample.modelId ?? run.modelId, pricingMap);
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
        day = { date, byProvider: new Map(), byModel: new Map(), runCount: 0 };
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

      if (date === todayDate) {
        todayRunCount += 1;
        todayInputTokens += runInputTokens;
        todayOutputTokens += runOutputTokens;
        todayToolCallCount += run.toolUsage?.totalCount ?? 0;
        todayTouchedFileCount += run.fileMutation?.touchedFileCount ?? 0;

        const series = distributeUsageForSeries(
          run,
          usage,
          dayMs,
          (ms) => localDateString(ms) === todayDate,
        );
        todayCostSamples.push(...series.cost);
        todayTokenSamples.push(...series.tokens);

        for (const sample of run.turnThroughputSamples) {
          const sMs = Date.parse(sample.endedAt);
          if (Number.isNaN(sMs) || localDateString(sMs) !== todayDate) continue;
          if (sample.status !== 'completed' || sample.generationDurationMs <= 0) continue;
          const sProvider = providerForModel(sample.modelId ?? run.modelId, pricingMap);
          const sModel = sample.modelId ?? run.modelId ?? 'unknown';
          const hourDate = new Date(sMs);
          hourDate.setMinutes(0, 0, 0);
          const hourMs = hourDate.getTime();
          let hour = todayThroughputByHour.get(hourMs);
          if (!hour) {
            hour = { byProvider: new Map(), byModel: new Map() };
            todayThroughputByHour.set(hourMs, hour);
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
      }
      if (weekDates.has(date)) weekRunCount += 1;
    }

    // Track the most-recent run by its end timestamp. Its token sparkline is
    // normalized to canonical usage, so prepass/subagent output is included
    // without counting forwarded child throughput samples twice.
    if (!Number.isNaN(dayMs) && dayMs > lastRunEndedMs) {
      lastRunEndedMs = dayMs;
      const series = distributeUsageForSeries(run, usage, dayMs, () => true);
      lastRunTurnSeries = series.tokens
        .map((sample) => ({ ms: sample.ms, outputTokens: sample.tokens }))
        .sort((a, b) => a.ms - b.ms);
      lastRun = {
        cost: runCost,
        durationMs: run.busyDurationMs ?? 0,
        modelId: run.modelId ?? null,
        provider: providerForModel(run.modelId, pricingMap),
        outcome: run.outcome ?? null,
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
    todayRunCount,
    weekRunCount,
    todayInputTokens,
    todayOutputTokens,
    todayToolCallCount,
    todayTouchedFileCount,
    todayCostSamples,
    todayTokenSamples,
    todayThroughputByHour,
    lastRunTurnSeries,
    lastRun,
  };
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
    dailyCost.push({
      date,
      totalCost: [...dayAcc.byProvider.values()].reduce((s, a) => s + a.cost, 0),
      byProvider: [...dayAcc.byProvider.values()].map(toProviderCost).sort(sortCostDesc),
      byModel: dayModelCosts(dayAcc.byModel),
    });
  }
  return dailyCost;
}

/** Convert a day's per-model cost map to a sorted list (desc by cost). */
function dayModelCosts(byModel: Map<string, number>): AggregateDailyModelCost[] {
  return [...byModel.entries()]
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
}

/** Build a cumulative stacked series (cost or tokens) from per-turn samples,
 *  pruned to [first sample, now] with a trailing "now" point so the area
 *  extends to the current moment. Each point carries cumulative per-provider
 *  and per-model breakdowns (the chart steps up at each point). */
function buildCumulativeSeries(
  samples: { ms: number; provider: string; model: string; value: number }[],
  nowMs: number,
): AggregateSeriesPoint[] {
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const byProvider = new Map<string, number>();
  const byModel = new Map<string, number>();
  const seg = (m: Map<string, number>): AggregateSeriesSegment[] =>
    [...m.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  const points: AggregateSeriesPoint[] = [];
  for (const s of sorted) {
    byProvider.set(s.provider, (byProvider.get(s.provider) ?? 0) + s.value);
    byModel.set(s.model, (byModel.get(s.model) ?? 0) + s.value);
    points.push({ ms: s.ms, byProvider: seg(byProvider), byModel: seg(byModel) });
  }
  // Trailing "now" point (current cumulative) so the chart extends to now.
  const last = points[points.length - 1]!;
  if (last.ms < nowMs) {
    points.push({ ms: nowMs, byProvider: seg(byProvider), byModel: seg(byModel) });
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
  const { todayDate, weekStartMs, weekDates } = buildDateWindows(nowMs);
  const acc = accumulateRuns(runs, pricingMap, todayDate, weekDates);

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
  const todayCostSeries = buildCumulativeSeries(
    acc.todayCostSamples.map((s) => ({ ms: s.ms, provider: s.provider, model: s.model, value: s.cost })),
    nowMs,
  );
  const todayTokenSeries = buildCumulativeSeries(
    acc.todayTokenSamples.map((s) => ({ ms: s.ms, provider: s.provider, model: s.model, value: s.tokens })),
    nowMs,
  );
  const todayThroughputSeries = buildThroughputSeries(acc.todayThroughputByHour);
  const dailyRunCount = buildDailyRunCount(acc.byDay, nowMs);

  // ── Live aggregate tok/s ──
  const liveStats = computeLiveTokensPerSecond(runningSessionPaths, ratesBySession);

  return {
    todayCost: todayStats.todayCost,
    todayCostByProvider: todayStats.todayCostByProvider,
    todayTokensPerSecond: todayStats.todayTokensPerSecond,
    todayTokensPerSecondByProvider: todayStats.todayTokensPerSecondByProvider,
    todayRunCount: acc.todayRunCount,
    todayInputTokens: acc.todayInputTokens,
    todayOutputTokens: acc.todayOutputTokens,
    todayToolCallCount: acc.todayToolCallCount,
    todayTouchedFileCount: acc.todayTouchedFileCount,
    todayCostSeries,
    todayTokenSeries,
    todayThroughputSeries,
    weekCost: weekStats.weekCost,
    weekCostByProvider: weekStats.weekCostByProvider,
    weekRunCount: acc.weekRunCount,
    dailyCost,
    dailyRunCount,
    liveTokensPerSecond: liveStats.liveTokensPerSecond,
    runningSessionCount: liveStats.runningSessionCount,
    openTabCount,
    totalCost: acc.totalCost,
    costByProvider,
    tokensPerSecond,
    tokensPerSecondByProvider,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    totalCacheReadTokens: acc.totalCacheReadTokens,
    totalCacheWriteTokens: acc.totalCacheWriteTokens,
    runCount: runs.length,
    sessionCount: acc.sessionPaths.size,
    lastRun: acc.lastRun,
    warmBash: EMPTY_WARM_BASH_STATS,
    providerGate: EMPTY_PROVIDER_GATE_STATS,
    ready: true,
  };
}
