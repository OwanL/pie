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
} from '../contracts/contracts.js';

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

/** Shared metric internals used by the projection metrics over the same usage facts. */
export function metricInt64(value: bigint): MetricInt64 {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export function optionalInt64(value: Int64Value | null | undefined, fieldName: string): bigint | null {
  if (value === undefined || value === null) return null;
  const parsed = parseInt64(value, fieldName);
  if (parsed < 0n) throw new RangeError(`${fieldName} must be non-negative.`);
  return parsed;
}

export function coverageFromCounts(
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
