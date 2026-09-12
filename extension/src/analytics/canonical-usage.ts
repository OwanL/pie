import type { Int64Value } from "../../../shared/analytics/contracts.js";
import type { ProviderSettlementProjection } from "./sqlite-recorder.js";
import type { BillableInvocationKind, BillableInvocationOutcome, BillableInvocationRecord } from '../shared/billable-invocation.js';
import {
  summarizeAccountingScope,
  summarizeDailyUsageAndCost,
  summarizeDimensionedDailyUsageAndCost,
  summarizeWeeklyUsageAndCost,
  type AccountingInvocation,
  type AccountingScope,
  type EffectiveCostMetric,
  type LocalUsageCostBucket,
} from '../../../shared/analytics/metrics.js';
import {
  sessionUsageSnapshotFromLedger,
  type SessionUsageKind,
  type SessionUsageProjectionRow,
  type SessionUsageSnapshot,
} from '../shared/session-usage.js';

/**
 * P5 read-model adapters over the canonical provider-settlement projection.
 *
 * Everything here is a pure projection of durable canonical settlement rows:
 * engine-neutral metrics (shared/analytics/metrics) own the sums, coverage,
 * calendar buckets, and scope math, and the public protocol owns the
 * session-usage shape. These adapters never read the legacy JSONL ledger,
 * raw run logs, or detail payloads, and never synthesize aggregates the
 * canonical store did not observe.
 */

/** The canonical settlement view carries its attribution facts directly. */
export type CanonicalUsageRecord = AccountingInvocation;

/** Map one durable canonical settlement row to the engine-neutral usage record. */
export function canonicalSettlementUsageRecord(
  settlement: ProviderSettlementProjection,
): CanonicalUsageRecord {
  const usage = settlement.usage;
  return {
    invocationId: settlement.invocationId,
    provider: settlement.provider,
    model: settlement.model,
    purpose: settlement.purpose,
    scopeKey: settlement.rootSessionId,
    rootSessionId: settlement.rootSessionId ?? undefined,
    executionId: settlement.executionId ?? undefined,
    branchId: settlement.branchId ?? undefined,
    selectedSessionId: settlement.selectedSessionId,
    inheritedFromInvocationId: settlement.inheritedFromInvocationId,
    usage,
    reportedCostUsd: settlement.reportedCostUsd,
    calculatedCostUsd: settlement.calculatedCostUsd,
    calculatedCostComplete: settlement.calculatedCostComplete,
    settledAtMs: settlement.settledAtMs ?? undefined,
  };
}

/**
 * Summarize the effective cost and channel coverage of canonical settlements
 * under one public scope. Scopes are exactly the contract's scope kinds; the
 * branch and copy scopes select only rows that carry those canonical facts.
 * The current durable settlement projection attributes every row to its
 * owning root session, so execution/branch/copy scopes are supported by the
 * engine-neutral math but select nothing until those canonical facts are
 * captured (P4 producer gap) — never a legacy fallback.
 */
export function summarizeCanonicalUsage(
  records: readonly CanonicalUsageRecord[],
  scope: AccountingScope,
): EffectiveCostMetric {
  return summarizeAccountingScope(records, scope);
}

/** Canonical settlements bucketed by local-calendar day in an explicit timezone. */
export function canonicalDailyUsageAndCost(
  records: readonly CanonicalUsageRecord[],
  timeZone: string,
): ReturnType<typeof summarizeDailyUsageAndCost> {
  return summarizeDailyUsageAndCost(records, timeZone);
}

/** Canonical settlements bucketed by local-calendar week in an explicit timezone. */
export function canonicalWeeklyUsageAndCost(
  records: readonly CanonicalUsageRecord[],
  timeZone: string,
): { buckets: ReadonlyMap<string, LocalUsageCostBucket>; undated: LocalUsageCostBucket; unknownSettlementCount: number } {
  return summarizeWeeklyUsageAndCost(records, timeZone);
}

/** Canonical settlements bucketed per day, provider, model, purpose, and scope. */
export function canonicalDimensionedDailyUsageAndCost(
  records: readonly CanonicalUsageRecord[],
  timeZone: string,
): ReturnType<typeof summarizeDimensionedDailyUsageAndCost> {
  return summarizeDimensionedDailyUsageAndCost(records, timeZone);
}

const CANONICAL_USAGE_KINDS: ReadonlySet<string> = new Set([
  'conversation',
  'retry',
  'history_compaction',
  'branch_summary',
  'skill_pruning_prepass',
  'session_title',
  'subagent',
  'other',
]);

/**
 * Adapt one durable settlement to the legacy aggregate's value-only input
 * shape. This is a read-side adapter only: it never writes the invocation
 * ledger and it preserves canonical cost/coverage provenance. The aggregate
 * service uses it for its bounded historical projection while session usage
 * continues to use the richer adapter below.
 */
export function canonicalSettlementToBillableRecord(
  settlement: ProviderSettlementProjection,
): BillableInvocationRecord {
  const settledAtMs = canonicalMillis(settlement.settledAtMs);
  // The compatibility record has string time fields but no undated bucket.
  // Keep missing settlement time visibly undated so a compatibility consumer
  // cannot silently attribute it to the Unix epoch.
  const endedAt = settledAtMs === undefined ? 'undated' : new Date(settledAtMs).toISOString();
  const kind: BillableInvocationKind = settlement.purpose !== null && CANONICAL_USAGE_KINDS.has(settlement.purpose)
    ? settlement.purpose as BillableInvocationKind
    : 'other';
  const outcome: BillableInvocationOutcome = settlement.outcome === 'succeeded'
    || settlement.outcome === 'failed'
    || settlement.outcome === 'cancelled'
    ? settlement.outcome
    : 'unknown';
  const inputTokens = safeUsageNumber(settlement.usage.inputTokens);
  const outputTokens = safeUsageNumber(settlement.usage.outputTokens);
  const cacheReadTokens = safeUsageNumber(settlement.usage.cacheReadTokens);
  const cacheWriteTokens = safeUsageNumber(settlement.usage.cacheWriteTokens);
  const reasoningTokens = safeUsageNumber(settlement.usage.reasoningTokens);
  const providerTotalTokens = safeUsageNumber(settlement.usage.providerTotalTokens);
  const channelsComplete = inputTokens !== undefined
    && outputTokens !== undefined
    && cacheReadTokens !== undefined
    && cacheWriteTokens !== undefined;
  const instrumentationGap = settlement.effectiveCostCoverage === 'unknown' || !channelsComplete;
  const record: BillableInvocationRecord = {
    schemaVersion: 1,
    invocationId: settlement.invocationId,
    sourceId: settlement.invocationId,
    sessionId: settlement.rootSessionId,
    sessionPath: null,
    branchId: settlement.branchId,
    parentOperationId: settlement.executionId,
    parentRunId: settlement.executionId,
    parentToolId: null,
    kind,
    provider: settlement.provider ?? 'unknown',
    model: settlement.model ?? 'unknown',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(providerTotalTokens === undefined ? {} : { providerTotalTokens }),
    ...(settlement.reportedCostUsd !== null ? { providerReportedCostUsd: settlement.reportedCostUsd } : {}),
    // The canonical projection has already validated the effective calculated
    // cost. Keep that value available to the existing aggregate math without
    // pretending it came from this host's pricing catalog.
    ...(settlement.reportedCostUsd === null && settlement.calculatedCostUsd !== null
      && settlement.calculatedCostComplete
      ? { pricing: { catalogVersion: 'canonical-projection', calculatedCostUsd: settlement.calculatedCostUsd } }
      : {}),
    provenance: settlement.effectiveCostSource === 'reported'
      ? 'exact'
      : settlement.effectiveCostSource === 'calculated' ? 'estimated'
        : instrumentationGap ? 'unknown' : 'unpriced',
    ...(instrumentationGap ? {
      instrumentationGap: true as const,
      instrumentationGapReason: 'The canonical settlement has incomplete usage or cost coverage.',
    } : { instrumentationGap: false as const }),
    startedAt: endedAt,
    endedAt,
    outcome,
  };
  return record;
}

function canonicalMillis(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeUsageNumber(value: Int64Value | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Convert an int64 usage value to the public numeric protocol only when its
 * integer identity is exactly representable. The durable canonical row keeps
 * the exact decimal; an unrepresentable public channel remains explicitly
 * unknown instead of being rounded. */
function usageNumber(value: Int64Value | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const parsed = typeof value === 'number' ? value : BigInt(value);
    if (typeof parsed === 'number') {
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
    }
    return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function int64IsoTimestamp(value: Int64Value | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const parsed = typeof value === 'number' ? value : BigInt(value);
    const numeric = typeof parsed === 'number'
      ? Number.isSafeInteger(parsed) ? parsed : undefined
      : parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(parsed) : undefined;
    if (numeric === undefined) return undefined;
    const date = new Date(numeric);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

/** Canonical purposes are billable kinds; unknown purposes stay visible as `other`. */
function canonicalUsageKind(purpose: string | null): Exclude<SessionUsageKind, 'assistant'> {
  return purpose !== null && CANONICAL_USAGE_KINDS.has(purpose)
    ? purpose as Exclude<SessionUsageKind, 'assistant'>
    : 'other';
}

function canonicalOutcome(outcome: string | null): 'succeeded' | 'failed' | 'cancelled' | 'unknown' {
  return outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled' ? outcome : 'unknown';
}

/**
 * Project durable canonical settlements into the public session-usage
 * protocol with the same coverage semantics as the ledger projection:
 * unknown channels stay visibly unknown (never coerced to zero), provenance
 * distinguishes provider-reported from catalog-calculated cost, and the
 * snapshot authority is `canonical` because the canonical analytics store
 * answered the projection.
 */
export function sessionUsageSnapshotFromCanonicalSettlements(
  settlements: readonly ProviderSettlementProjection[],
  options: { branchId?: string } = {},
): SessionUsageSnapshot {
  const records = settlements.map((settlement): SessionUsageProjectionRow => {
    const usage = settlement.usage;
    const inputTokens = usageNumber(usage.inputTokens);
    const outputTokens = usageNumber(usage.outputTokens);
    const cacheReadTokens = usageNumber(usage.cacheReadTokens);
    const cacheWriteTokens = usageNumber(usage.cacheWriteTokens);
    const reasoningTokens = usageNumber(usage.reasoningTokens);
    const providerTotalTokens = usageNumber(usage.providerTotalTokens);
    const channelsComplete = inputTokens !== undefined && outputTokens !== undefined
      && cacheReadTokens !== undefined && cacheWriteTokens !== undefined;
    const hasUnrepresentableChannel = [
      [usage.inputTokens, inputTokens],
      [usage.outputTokens, outputTokens],
      [usage.cacheReadTokens, cacheReadTokens],
      [usage.cacheWriteTokens, cacheWriteTokens],
      [usage.reasoningTokens, reasoningTokens],
      [usage.providerTotalTokens, providerTotalTokens],
    ].some(([exact, projected]) => exact !== null && exact !== undefined && projected === undefined);
    const instrumentationGap = !channelsComplete || hasUnrepresentableChannel;
    const provenance: 'exact' | 'estimated' | 'unpriced' | 'unknown' = settlement.effectiveCostSource === 'reported'
      ? 'exact'
      : settlement.effectiveCostSource === 'calculated' ? 'estimated'
        : channelsComplete ? 'unpriced' : 'unknown';
    const endedAt = int64IsoTimestamp(settlement.settledAtMs);
    return {
      sourceId: settlement.invocationId,
      kind: canonicalUsageKind(settlement.purpose),
      model: settlement.model,
      provider: settlement.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(settlement.reportedCostUsd !== null ? { providerReportedCostUsd: settlement.reportedCostUsd } : {}),
      ...(settlement.calculatedCostUsd !== null ? { calculatedCostUsd: settlement.calculatedCostUsd } : {}),
      providerTotalTokens,
      provenance,
      instrumentationGap,
      ...(instrumentationGap ? {
        instrumentationGapReason: hasUnrepresentableChannel
          ? 'A canonical token count exceeds the public numeric safe-integer range; its exact decimal remains available in the canonical read model.'
          : 'The canonical settlement captured incomplete provider usage channels.',
      } : {}),
      outcome: canonicalOutcome(settlement.outcome),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
  });
  const snapshot = sessionUsageSnapshotFromLedger(records, 'canonical');
  return options.branchId ? { ...snapshot, branchId: options.branchId } : snapshot;
}
