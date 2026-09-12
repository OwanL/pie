/**
 * Pure analytics metric helpers.
 *
 * Missing telemetry is represented explicitly in every aggregate. Callers may
 * display `knownTotal`, but must only display `value` as a complete total when
 * `complete` is true. No helper performs I/O or mutates recorder state.
 */

import {
  canonicalInt64,
  parseInt64,
  type AnalyticsUsageChannels,
  type Int64Value,
} from './contracts.js';

export type MetricInt64 = number | string;

export interface CoverageMetric {
  occurrenceCount: number;
  knownCount: number;
  unknownCount: number;
  /** Sum of values that were present, even when the total is partial. */
  knownTotal: MetricInt64;
  /** Null whenever one or more occurrences are unknown. */
  value: MetricInt64 | null;
  complete: boolean;
}

function metricInt64(value: bigint): MetricInt64 {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function optionalInt64(value: Int64Value | null | undefined, fieldName: string): bigint | null {
  if (value === undefined || value === null) return null;
  const parsed = parseInt64(value, fieldName);
  if (parsed < 0n) throw new RangeError(`${fieldName} must be non-negative.`);
  return parsed;
}

function coverageFromCounts(
  occurrenceCount: number,
  knownCount: number,
  total: bigint,
): CoverageMetric {
  const unknownCount = occurrenceCount - knownCount;
  return {
    occurrenceCount,
    knownCount,
    unknownCount,
    knownTotal: metricInt64(total),
    value: unknownCount === 0 ? metricInt64(total) : null,
    complete: unknownCount === 0,
  };
}

/** Sum an int64 channel without coercing it through a 32-bit binding. */
export function summarizeInt64(values: readonly (Int64Value | null | undefined)[]): CoverageMetric {
  let total = 0n;
  let knownCount = 0;
  values.forEach((value, index) => {
    const parsed = optionalInt64(value, `values[${index}]`);
    if (parsed === null) return;
    total += parsed;
    knownCount += 1;
  });
  return coverageFromCounts(values.length, knownCount, total);
}

export interface InvocationUsageRecord {
  invocationId: string;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  scopeKey?: string | null;
  usage: AnalyticsUsageChannels;
  reportedCostUsd?: number | null;
  calculatedCostUsd?: number | null;
  calculatedCostComplete?: boolean;
  settledAtMs?: Int64Value | null;
}

/** Deduplicate joins by the stable invocation identity before any sum. */
export function distinctInvocationUsage(
  records: readonly InvocationUsageRecord[],
): InvocationUsageRecord[] {
  const byId = new Map<string, InvocationUsageRecord>();
  for (const record of records) {
    if (!record.invocationId) throw new Error('invocationId is required for usage aggregation.');
    if (!byId.has(record.invocationId)) byId.set(record.invocationId, record);
  }
  return [...byId.values()];
}

export type UsageChannel = keyof AnalyticsUsageChannels;

export function summarizeUsageChannel(
  records: readonly InvocationUsageRecord[],
  channel: UsageChannel,
): CoverageMetric {
  const distinct = distinctInvocationUsage(records);
  return summarizeInt64(distinct.map((record) => record.usage[channel]));
}

/** Compatibility name used by query adapters that call the operation a metric. */
export const aggregateUsageChannel = summarizeUsageChannel;

export interface EffectiveCostMetric extends CoverageMetric {
  reportedCount: number;
  calculatedCount: number;
}

function validCost(value: number | null | undefined, fieldName: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${fieldName} must be a finite non-negative number.`);
  return value;
}

export function effectiveInvocationCost(record: InvocationUsageRecord): {
  value: number | null;
  source: 'reported' | 'calculated' | 'unknown';
} {
  const reported = validCost(record.reportedCostUsd, 'reportedCostUsd');
  // Zero is a real reported value and must not fall through to the calculated path.
  if (reported !== null) return { value: reported, source: 'reported' };
  const calculated = validCost(record.calculatedCostUsd, 'calculatedCostUsd');
  if (calculated !== null && record.calculatedCostComplete !== false) {
    return { value: calculated, source: 'calculated' };
  }
  return { value: null, source: 'unknown' };
}

/** Aggregate reported cost first, then a complete calculated cost, retaining
 * provenance and an explicit incomplete value. */
export function summarizeEffectiveCost(
  records: readonly InvocationUsageRecord[],
): EffectiveCostMetric {
  const distinct = distinctInvocationUsage(records);
  let total = 0;
  let compensation = 0;
  let knownCount = 0;
  let reportedCount = 0;
  let calculatedCount = 0;
  for (const record of distinct) {
    const effective = effectiveInvocationCost(record);
    if (effective.value === null) continue;
    // Kahan summation keeps daily/weekly rollups deterministic enough for the
    // documented monetary tolerance without treating a float as an int64.
    const corrected = effective.value - compensation;
    const next = total + corrected;
    compensation = (next - total) - corrected;
    total = next;
    knownCount += 1;
    if (effective.source === 'reported') reportedCount += 1;
    else calculatedCount += 1;
  }
  const base = coverageFromCounts(distinct.length, knownCount, BigInt(0));
  return {
    ...base,
    knownTotal: total,
    value: base.complete ? total : null,
    reportedCount,
    calculatedCount,
  };
}

export const COST_PARITY_ABSOLUTE_TOLERANCE_USD = 1e-9;
export const COST_PARITY_RELATIVE_TOLERANCE = 1e-12;

export function costWithinParityTolerance(actualUsd: number, referenceUsd: number): boolean {
  if (!Number.isFinite(actualUsd) || !Number.isFinite(referenceUsd)) return false;
  return Math.abs(actualUsd - referenceUsd)
    <= COST_PARITY_ABSOLUTE_TOLERANCE_USD + COST_PARITY_RELATIVE_TOLERANCE * Math.abs(referenceUsd);
}

export interface UsageNormalizationInput extends AnalyticsUsageChannels {
  /** Required to distinguish provider input from cache channels. */
  inputIncludesCache?: boolean;
  /** Required to distinguish provider output from a reasoning subset. */
  outputIncludesReasoning?: boolean;
  /** Only an explicit protocol convention may turn omitted cache fields into zero. */
  cacheChannelsOmittedAsZero?: boolean;
}

export interface NormalizedUsageChannels {
  baseInputTokens: MetricInt64 | null;
  cacheReadTokens: MetricInt64 | null;
  cacheWriteTokens: MetricInt64 | null;
  /** Billable/disjoint output, including reasoning only when it was separate. */
  outputTokens: MetricInt64 | null;
  reasoningTokens: MetricInt64 | null;
  totalTokens: MetricInt64 | null;
  reasoningIncludedInOutput: boolean | null;
  complete: boolean;
}

function addOptional(a: bigint | null, b: bigint | null): bigint | null {
  return a === null || b === null ? null : a + b;
}

/** Normalize cache and reasoning conventions before totals or pricing. */
export function normalizeUsageChannels(input: UsageNormalizationInput): NormalizedUsageChannels {
  const rawInput = optionalInt64(input.inputTokens, 'inputTokens');
  const rawOutput = optionalInt64(input.outputTokens, 'outputTokens');
  const rawCacheRead = optionalInt64(input.cacheReadTokens, 'cacheReadTokens');
  const rawCacheWrite = optionalInt64(input.cacheWriteTokens, 'cacheWriteTokens');
  const rawReasoning = optionalInt64(input.reasoningTokens, 'reasoningTokens');

  const cacheRead = rawCacheRead ?? (input.cacheChannelsOmittedAsZero ? 0n : null);
  const cacheWrite = rawCacheWrite ?? (input.cacheChannelsOmittedAsZero ? 0n : null);
  let baseInput: bigint | null = null;
  if (input.inputIncludesCache === true) {
    const cached = addOptional(cacheRead, cacheWrite);
    if (rawInput !== null && cached !== null) {
      baseInput = rawInput - cached;
      if (baseInput < 0n) throw new RangeError('cache token channels exceed provider input tokens.');
    }
  } else if (input.inputIncludesCache === false) {
    baseInput = rawInput;
  }

  let output: bigint | null = null;
  let reasoningIncludedInOutput: boolean | null = null;
  if (input.outputIncludesReasoning === true) {
    output = rawOutput;
    reasoningIncludedInOutput = true;
  } else if (input.outputIncludesReasoning === false) {
    output = addOptional(rawOutput, rawReasoning);
    reasoningIncludedInOutput = false;
  }

  const total = addOptional(addOptional(baseInput, cacheRead), addOptional(cacheWrite, output));
  return {
    baseInputTokens: baseInput === null ? null : metricInt64(baseInput),
    cacheReadTokens: cacheRead === null ? null : metricInt64(cacheRead),
    cacheWriteTokens: cacheWrite === null ? null : metricInt64(cacheWrite),
    outputTokens: output === null ? null : metricInt64(output),
    reasoningTokens: rawReasoning === null ? null : metricInt64(rawReasoning),
    totalTokens: total === null ? null : metricInt64(total),
    reasoningIncludedInOutput,
    complete: total !== null,
  };
}

export interface ChannelPricingRates {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  cacheReadUsdPerMillionTokens: number | null;
  cacheWriteUsdPerMillionTokens: number | null;
}

function price(value: MetricInt64 | null, rate: number | null, name: string): number | null {
  if (value === null || rate === null || rate === undefined) return null;
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`${name} must be finite and non-negative.`);
  const tokens = Number(parseInt64(value, name));
  const result = tokens * rate / 1_000_000;
  return Number.isFinite(result) ? result : null;
}

/** Calculate cost only when every normalized billable channel and rate is known. */
export function calculateCompleteCostUsd(
  normalized: NormalizedUsageChannels,
  rates: ChannelPricingRates,
): number | null {
  if (!normalized.complete) return null;
  const components = [
    price(normalized.baseInputTokens, rates.inputUsdPerMillionTokens, 'input rate'),
    price(normalized.outputTokens, rates.outputUsdPerMillionTokens, 'output rate'),
    price(normalized.cacheReadTokens, rates.cacheReadUsdPerMillionTokens, 'cache-read rate'),
    price(normalized.cacheWriteTokens, rates.cacheWriteUsdPerMillionTokens, 'cache-write rate'),
  ];
  const knownComponents = components.filter((component): component is number => component !== null);
  if (knownComponents.length !== components.length) return null;
  return knownComponents.reduce((total, component) => total + component, 0);
}

export interface ActivityInterval {
  startMs: number;
  endMs?: number | null;
  clockDomain: string;
  coverage?: 'observed' | 'estimated' | 'unknown';
}

export interface DurationMetric {
  durationMs: number | null;
  intervalCount: number;
  coverage: 'complete' | 'partial' | 'unavailable';
  complete: boolean;
}

function finiteTime(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${fieldName} must be finite.`);
  return value;
}

/** Union half-open intervals. Nested activities are counted once. */
export function unionDurationMs(intervals: readonly { startMs: number; endMs: number }[]): number {
  const sorted = intervals
    .map((interval) => ({
      startMs: finiteTime(interval.startMs, 'startMs'),
      endMs: finiteTime(interval.endMs, 'endMs'),
    }))
    .map((interval) => {
      if (interval.endMs < interval.startMs) throw new RangeError('activity interval ends before it starts.');
      return interval;
    })
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of sorted) {
    if (start === undefined) {
      start = interval.startMs;
      end = interval.endMs;
    } else if (interval.startMs <= end!) {
      end = Math.max(end!, interval.endMs);
    } else {
      total += end! - start;
      start = interval.startMs;
      end = interval.endMs;
    }
  }
  if (start !== undefined) total += end! - start;
  return total;
}

/** Combine owner busy intervals and explicitly uncovered preflight work. An
 * active interval is usable only when a reference `nowMs` is supplied. */
export function summarizeBusyWallTime(
  ownerIntervals: readonly ActivityInterval[],
  uncoveredPreflightIntervals: readonly ActivityInterval[] = [],
  nowMs?: number,
): DurationMetric {
  const all = [...ownerIntervals, ...uncoveredPreflightIntervals];
  if (all.length === 0) return { durationMs: 0, intervalCount: 0, coverage: 'complete', complete: true };
  const resolvedByClockDomain = new Map<string, { startMs: number; endMs: number }[]>();
  let partial = false;
  for (const interval of all) {
    let end = interval.endMs ?? null;
    if (end === null) {
      if (nowMs === undefined) {
        partial = true;
        continue;
      }
      end = nowMs;
      partial = true;
    }
    if (interval.coverage === 'unknown' || interval.coverage === 'estimated') partial = true;
    const domainIntervals = resolvedByClockDomain.get(interval.clockDomain) ?? [];
    domainIntervals.push({ startMs: interval.startMs, endMs: end });
    resolvedByClockDomain.set(interval.clockDomain, domainIntervals);
  }
  if (resolvedByClockDomain.size > 1) partial = true;
  const resolved = [...resolvedByClockDomain.values()];
  if (resolved.length === 0) return {
    durationMs: null,
    intervalCount: all.length,
    coverage: 'unavailable',
    complete: false,
  };
  return {
    // Domains without a correlation anchor cannot be unioned precisely; keep
    // each domain's measured union and qualify the combined display value.
    durationMs: resolved.reduce((total, intervals) => total + unionDurationMs(intervals), 0),
    intervalCount: all.length,
    coverage: partial ? 'partial' : 'complete',
    complete: !partial,
  };
}

export interface AdditiveDurationMetric {
  durationMs: number;
  knownCount: number;
  unknownCount: number;
  complete: boolean;
}

/** Sum independent session-work or tool/child-attempt durations. Unlike busy
 * wall time this intentionally remains additive for parallel work. */
export function summarizeAdditiveDurations(
  durationsMs: readonly (number | null | undefined)[],
): AdditiveDurationMetric {
  let durationMs = 0;
  let knownCount = 0;
  for (const [index, duration] of durationsMs.entries()) {
    if (duration === undefined || duration === null) continue;
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`durationsMs[${index}] must be finite and non-negative.`);
    durationMs += duration;
    knownCount += 1;
  }
  return {
    durationMs,
    knownCount,
    unknownCount: durationsMs.length - knownCount,
    complete: knownCount === durationsMs.length,
  };
}

export const summarizeAggregateWorkingTime = summarizeAdditiveDurations;
export const summarizeToolChildWork = summarizeAdditiveDurations;

export interface MeasuredWorkSample {
  durationMs?: number | null;
  coverage: 'measured' | 'estimated' | 'unknown';
}

export interface MeasuredWorkMetric extends AdditiveDurationMetric {
  excludedEstimatedCount: number;
}

export function summarizeMeasuredWork(samples: readonly MeasuredWorkSample[]): MeasuredWorkMetric {
  const measured = samples.map((sample) => sample.coverage === 'measured' ? sample.durationMs : null);
  const result = summarizeAdditiveDurations(measured);
  return {
    ...result,
    excludedEstimatedCount: samples.filter((sample) => sample.coverage !== 'measured').length,
  };
}

export interface SettledThroughputSample {
  settled: boolean;
  outputTokens?: Int64Value | null;
  durationMs?: number | null;
  durationSource?: 'measured' | 'estimated' | 'unknown';
}

export interface LiveGenerationRateSample {
  outputTokens?: Int64Value | null;
  generationMs?: number | null;
}

export interface LiveGenerationRateMetric {
  tokensPerSecond: number | null;
  outputTokens: MetricInt64;
  generationMs: number | null;
  estimated: true;
  complete: boolean;
}

/** Bounded live estimates remain separate from settled provider usage. The
 * token-rate owner supplies already-windowed samples; this helper never stores
 * display ticks. */
export function summarizeLiveGenerationRate(
  samples: readonly LiveGenerationRateSample[],
): LiveGenerationRateMetric {
  let output = 0n;
  let duration = 0;
  let known = 0;
  for (const [index, sample] of samples.entries()) {
    const tokens = optionalInt64(sample.outputTokens, `samples[${index}].outputTokens`);
    if (tokens === null || sample.generationMs === undefined || sample.generationMs === null
      || !Number.isFinite(sample.generationMs) || sample.generationMs <= 0) continue;
    output += tokens;
    duration += sample.generationMs;
    known += 1;
  }
  return {
    tokensPerSecond: known === 0 ? null : Number(output) / (duration / 1000),
    outputTokens: metricInt64(output),
    generationMs: known === 0 ? null : duration,
    estimated: true,
    complete: known === samples.length && known > 0,
  };
}

export interface ThroughputMetric {
  outputTokens: MetricInt64;
  durationMs: number | null;
  tokensPerSecond: number | null;
  matchedCount: number;
  excludedCount: number;
  coverage: 'complete' | 'partial' | 'unavailable';
  complete: boolean;
}

/** Throughput uses only settled samples with a measured positive duration and
 * known output. Estimated/zero/missing pairs remain visible as exclusions. */
export function summarizeSettledThroughput(
  samples: readonly SettledThroughputSample[],
): ThroughputMetric {
  let output = 0n;
  let duration = 0;
  let matchedCount = 0;
  for (const [index, sample] of samples.entries()) {
    if (!sample.settled || sample.durationSource !== 'measured'
      || sample.durationMs === undefined || sample.durationMs === null
      || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0
      || sample.outputTokens === undefined || sample.outputTokens === null) continue;
    const tokens = optionalInt64(sample.outputTokens, `samples[${index}].outputTokens`);
    if (tokens === null) continue;
    output += tokens;
    duration += sample.durationMs;
    matchedCount += 1;
  }
  const excludedCount = samples.length - matchedCount;
  const complete = samples.length > 0 && excludedCount === 0 && matchedCount > 0;
  return {
    outputTokens: metricInt64(output),
    durationMs: matchedCount === 0 ? null : duration,
    tokensPerSecond: matchedCount === 0 ? null : Number(output) / (duration / 1000),
    matchedCount,
    excludedCount,
    coverage: matchedCount === 0 ? 'unavailable' : complete ? 'complete' : 'partial',
    complete,
  };
}

export interface LatencySample {
  requestToFirstOutputMs?: number | null;
  providerHeaderWaitMs?: number | null;
  providerFirstOutputWaitMs?: number | null;
  fullOperationMs?: number | null;
}

export interface LatencyMetric {
  occurrenceCount: number;
  knownCount: number;
  unknownCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  complete: boolean;
}

/** Summarize one named latency interval; different latency authorities stay
 * separate instead of turning receipt or tool-result time into model latency. */
export function summarizeLatency(
  samples: readonly LatencySample[],
  field: keyof LatencySample,
): LatencyMetric {
  const values: number[] = [];
  for (const sample of samples) {
    const value = sample[field];
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be finite and non-negative.`);
    values.push(value);
  }
  values.sort((a, b) => a - b);
  const percentile = (fraction: number): number | null => {
    if (values.length === 0) return null;
    return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
  };
  return {
    occurrenceCount: samples.length,
    knownCount: values.length,
    unknownCount: samples.length - values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: values.length === 0 ? null : values[values.length - 1],
    complete: values.length === samples.length,
  };
}

export interface ContextObservation {
  observedAtMs: Int64Value;
  contextLimitTokens?: Int64Value | null;
  inputTokens?: Int64Value | null;
  source: 'provider' | 'initialEstimate' | 'recovered' | string;
}

export interface ContextUtilizationMetric {
  source: string;
  observedAtMs: Int64Value;
  inputTokens: MetricInt64 | null;
  contextLimitTokens: MetricInt64 | null;
  utilization: number | null;
  complete: boolean;
}

/** Point-in-time context state: the latest applicable observation wins; no
 * historical input tokens are summed. */
export function latestContextUtilization(
  observations: readonly ContextObservation[],
): ContextUtilizationMetric | null {
  if (observations.length === 0) return null;
  const latest = [...observations].sort((a, b) => Number(parseInt64(b.observedAtMs)) - Number(parseInt64(a.observedAtMs)))[0];
  const input = optionalInt64(latest.inputTokens, 'inputTokens');
  const limit = optionalInt64(latest.contextLimitTokens, 'contextLimitTokens');
  if (limit !== null && limit === 0n) throw new RangeError('contextLimitTokens must be positive when present.');
  return {
    source: latest.source,
    observedAtMs: latest.observedAtMs,
    inputTokens: input === null ? null : metricInt64(input),
    contextLimitTokens: limit === null ? null : metricInt64(limit),
    utilization: input === null || limit === null ? null : Number(input) / Number(limit),
    complete: input !== null && limit !== null,
  };
}

function dateFromInt64(timestampMs: Int64Value): Date {
  const numberValue = Number(parseInt64(timestampMs, 'timestampMs'));
  if (!Number.isFinite(numberValue) || Math.abs(numberValue) > 8_640_000_000_000_000) {
    throw new RangeError('timestampMs is outside the JavaScript Date range.');
  }
  return new Date(numberValue);
}

function datePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) throw new Error(`Time-zone formatter did not return ${type}.`);
  return value;
}

const CALENDAR_FORMATTER_CACHE_LIMIT = 16;
const calendarFormatterCache = new Map<string, Intl.DateTimeFormat>();

function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = calendarFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  if (calendarFormatterCache.size >= CALENDAR_FORMATTER_CACHE_LIMIT) {
    const oldest = calendarFormatterCache.keys().next().value;
    if (oldest !== undefined) calendarFormatterCache.delete(oldest);
  }
  calendarFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** Local calendar keys are derived through Intl, never by subtracting 24h of
 * milliseconds, so DST transitions do not move a settlement across a day. */
export function localCalendarDayKey(timestampMs: Int64Value, timeZone: string): string {
  const parts = calendarFormatter(timeZone).formatToParts(dateFromInt64(timestampMs));
  return `${datePart(parts, 'year').padStart(4, '0')}-${datePart(parts, 'month').padStart(2, '0')}-${datePart(parts, 'day').padStart(2, '0')}`;
}

/** Current UI week: today plus the preceding six local calendar dates.
 * Date arithmetic is performed on UTC calendar parts only; it is not a
 * rolling 168-hour window and remains stable across DST transitions. */
export function localCalendarWeekDateKeys(timestampMs: Int64Value, timeZone: string): string[] {
  const dayKey = localCalendarDayKey(timestampMs, timeZone);
  const [year, month, day] = dayKey.split('-').map(Number);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - (6 - index)));
    return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date.getUTCDate().toString().padStart(2, '0')}`;
  });
}

/** Return the first representable instant of the local calendar date. This
 * deliberately searches the zone's calendar boundary instead of subtracting
 * a fixed offset, so a DST transition (including a skipped midnight) is
 * handled by the same Intl authority as localCalendarDayKey. */
function calendarDayStartForKey(target: string, timeZone: string): number {
  const [year, month, day] = target.split('-').map(Number);
  let low = Date.UTC(year, month - 1, day) - 3 * 86_400_000;
  let high = Date.UTC(year, month - 1, day) + 3 * 86_400_000;
  while (localCalendarDayKey(low, timeZone) >= target) low -= 86_400_000;
  while (localCalendarDayKey(high, timeZone) < target) high += 86_400_000;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localCalendarDayKey(middle, timeZone) < target) low = middle;
    else high = middle;
  }
  return high;
}

export function localCalendarDayStartMs(timestampMs: Int64Value, timeZone: string): number {
  return calendarDayStartForKey(localCalendarDayKey(timestampMs, timeZone), timeZone);
}

/** Move by local calendar dates. The result is the start of the requested
 * date, which is the boundary shape required by maintained daily windows. */
export function addLocalCalendarDaysMs(timestampMs: Int64Value, days: number, timeZone: string): number {
  if (!Number.isSafeInteger(days)) throw new RangeError('Calendar day offset must be a safe integer.');
  const target = localCalendarDayKey(timestampMs, timeZone);
  const [year, month, day] = target.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const shiftedKey = `${shifted.getUTCFullYear().toString().padStart(4, '0')}-${(shifted.getUTCMonth() + 1).toString().padStart(2, '0')}-${shifted.getUTCDate().toString().padStart(2, '0')}`;
  return calendarDayStartForKey(shiftedKey, timeZone);
}

export interface LocalCostBucketResult {
  buckets: ReadonlyMap<string, EffectiveCostMetric>;
  /** Known values with no source settlement timestamp remain queryable here. */
  undated: EffectiveCostMetric;
  unknownSettlementCount: number;
}

export interface LocalUsageCostBucket {
  cost: EffectiveCostMetric;
  usage: ReadonlyMap<UsageChannel, CoverageMetric>;
  settlementCount: number;
}

function summarizeLocalUsageCostBuckets(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
  keyFor: (record: InvocationUsageRecord) => string,
): { buckets: ReadonlyMap<string, LocalUsageCostBucket>; undated: LocalUsageCostBucket; unknownSettlementCount: number } {
  const groups = new Map<string, InvocationUsageRecord[]>();
  const undated: InvocationUsageRecord[] = [];
  let unknownSettlementCount = 0;
  for (const record of distinctInvocationUsage(records)) {
    if (record.settledAtMs === undefined || record.settledAtMs === null) {
      unknownSettlementCount += 1;
      undated.push(record);
      continue;
    }
    const key = keyFor(record);
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  const summarizeBucket = (value: readonly InvocationUsageRecord[]): LocalUsageCostBucket => ({
    cost: summarizeEffectiveCost(value),
    usage: new Map((['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'providerTotalTokens'] as const)
      .map((channel) => [channel, summarizeUsageChannel(value, channel)])),
    settlementCount: value.length,
  });
  return {
    buckets: new Map([...groups.entries()].map(([key, value]) => [key, summarizeBucket(value)])),
    undated: summarizeBucket(undated),
    unknownSettlementCount,
  };
}

/** Daily/weekly query projections keep explicit settlement time and all
 * optional usage-channel coverage. Dimensioned adapters can append provider,
 * model, purpose and scopeKey to the returned bucket key. */
export function summarizeDailyUsageAndCost(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
): { buckets: ReadonlyMap<string, LocalUsageCostBucket>; undated: LocalUsageCostBucket; unknownSettlementCount: number } {
  return summarizeLocalUsageCostBuckets(records, timeZone, (record) => localCalendarDayKey(record.settledAtMs!, timeZone));
}

export function summarizeWeeklyUsageAndCost(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
): { buckets: ReadonlyMap<string, LocalUsageCostBucket>; undated: LocalUsageCostBucket; unknownSettlementCount: number } {
  return summarizeLocalUsageCostBuckets(records, timeZone, (record) => {
    const days = localCalendarWeekDateKeys(record.settledAtMs!, timeZone);
    return `${days[0]}..${days[6]}`;
  });
}

export function summarizeDimensionedDailyUsageAndCost(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
): { buckets: ReadonlyMap<string, LocalUsageCostBucket>; undated: LocalUsageCostBucket; unknownSettlementCount: number } {
  return summarizeLocalUsageCostBuckets(records, timeZone, (record) => {
    const day = localCalendarDayKey(record.settledAtMs!, timeZone);
    return `${day}|provider=${record.provider ?? '?'}|model=${record.model ?? '?'}|purpose=${record.purpose ?? '?'}|scope=${record.scopeKey ?? '?'}`;
  });
}

function summarizeCostBucket(records: readonly InvocationUsageRecord[]): EffectiveCostMetric {
  return summarizeEffectiveCost(records);
}

export function summarizeDailyCost(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
): LocalCostBucketResult {
  const groups = new Map<string, InvocationUsageRecord[]>();
  const undated: InvocationUsageRecord[] = [];
  let unknownSettlementCount = 0;
  for (const record of distinctInvocationUsage(records)) {
    if (record.settledAtMs === undefined || record.settledAtMs === null) {
      unknownSettlementCount += 1;
      undated.push(record);
      continue;
    }
    const key = localCalendarDayKey(record.settledAtMs, timeZone);
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return {
    buckets: new Map([...groups.entries()].map(([key, value]) => [key, summarizeCostBucket(value)])),
    undated: summarizeCostBucket(undated),
    unknownSettlementCount,
  };
}

export function summarizeWeeklyCost(
  records: readonly InvocationUsageRecord[],
  timeZone: string,
): LocalCostBucketResult {
  const groups = new Map<string, InvocationUsageRecord[]>();
  const undated: InvocationUsageRecord[] = [];
  let unknownSettlementCount = 0;
  for (const record of distinctInvocationUsage(records)) {
    if (record.settledAtMs === undefined || record.settledAtMs === null) {
      unknownSettlementCount += 1;
      undated.push(record);
      continue;
    }
    const days = localCalendarWeekDateKeys(record.settledAtMs, timeZone);
    const key = `${days[0]}..${days[6]}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return {
    buckets: new Map([...groups.entries()].map(([key, value]) => [key, summarizeCostBucket(value)])),
    undated: summarizeCostBucket(undated),
    unknownSettlementCount,
  };
}

export interface BranchDescriptor {
  branchId: string;
  parentBranchId?: string | null;
}

export interface AccountingInvocation extends InvocationUsageRecord {
  rootSessionId?: string;
  executionId?: string;
  parentExecutionId?: string | null;
  branchId?: string;
  selectedSessionId?: string;
  inheritedFromInvocationId?: string;
}

function branchAncestry(
  branchId: string,
  branches: readonly BranchDescriptor[],
): Set<string> {
  const parents = new Map(branches.map((branch) => [branch.branchId, branch.parentBranchId ?? undefined]));
  const result = new Set<string>();
  let current: string | undefined = branchId;
  while (current !== undefined) {
    if (result.has(current)) throw new Error(`Cycle in branch ancestry at ${current}.`);
    result.add(current);
    current = parents.get(current);
  }
  return result;
}

export type AccountingScope =
  | { kind: 'global' }
  | { kind: 'rootSession'; rootSessionId: string }
  | { kind: 'execution'; executionId: string; inclusive: boolean }
  | { kind: 'branch'; branchId: string; branches: readonly BranchDescriptor[] }
  | { kind: 'copyOwn'; copySessionId: string }
  | { kind: 'copyInherited'; copySessionId: string };

/** Branch and copy views count distinct invocation IDs. Inherited work is
 * selected by reference; it is not duplicated as new global work. */
function executionAncestry(
  executionId: string,
  records: readonly AccountingInvocation[],
): Set<string> {
  const parents = new Map(records
    .filter((record) => record.executionId !== undefined)
    .map((record) => [record.executionId!, record.parentExecutionId ?? undefined]));
  const result = new Set<string>();
  let current: string | undefined = executionId;
  while (current !== undefined) {
    if (result.has(current)) throw new Error(`Cycle in execution ancestry at ${current}.`);
    result.add(current);
    current = parents.get(current);
  }
  return result;
}

export function summarizeAccountingScope(
  records: readonly AccountingInvocation[],
  scope: AccountingScope,
): EffectiveCostMetric {
  const visible = records.filter((record) => {
    switch (scope.kind) {
      case 'global': return true;
      case 'rootSession': return record.rootSessionId === scope.rootSessionId;
      case 'execution': return record.executionId !== undefined
        && (scope.inclusive
          ? executionAncestry(record.executionId, records).has(scope.executionId)
          : record.executionId === scope.executionId);
      case 'branch': return record.branchId !== undefined
        && branchAncestry(scope.branchId, scope.branches).has(record.branchId);
      case 'copyOwn': return record.rootSessionId === scope.copySessionId;
      case 'copyInherited': return record.selectedSessionId === scope.copySessionId
        && record.rootSessionId !== scope.copySessionId;
    }
  });
  // A copy reference may use a local row identity while pointing at an
  // already-accounted source invocation. Deduplicate after selecting the view
  // so the inherited view can still find that reference, then collapse it by
  // its source identity.
  const distinct = new Map<string, AccountingInvocation>();
  for (const record of visible) {
    const identity = record.inheritedFromInvocationId ?? record.invocationId;
    if (!distinct.has(identity)) distinct.set(identity, record);
  }
  return summarizeEffectiveCost([...distinct.values()]);
}

/** Exported for parity tests and query adapters that need the exact identity set. */
export function distinctAccountingInvocationIds(records: readonly AccountingInvocation[]): string[] {
  return [...new Set(records.map((record) => record.invocationId))];
}

/** Stable source identity for a usage row when a query adapter needs to expose
 * it in a diagnostic result. */
export function usageIdentity(record: InvocationUsageRecord): string {
  return canonicalInt64(record.settledAtMs ?? 0n) === '0'
    ? record.invocationId
    : `${record.invocationId}@${canonicalInt64(record.settledAtMs!)}`;
}
