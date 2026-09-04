export const BILLABLE_INVOCATION_KINDS = [
  'conversation',
  'retry',
  'history_compaction',
  'branch_summary',
  'skill_pruning_prepass',
  'session_title',
  'subagent',
  'other',
] as const;

export type BillableInvocationKind = typeof BILLABLE_INVOCATION_KINDS[number];
export type BillableInvocationProvenance = 'exact' | 'estimated' | 'unpriced' | 'unknown';
export type BillableInvocationOutcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

/** Catalog rates are USD per million tokens. Omitted rates are unknown, not zero. */
export interface BillableInvocationRateSnapshot {
  readonly inputTokensUsdPerMillion?: number;
  readonly outputTokensUsdPerMillion?: number;
  readonly cacheReadTokensUsdPerMillion?: number;
  readonly cacheWriteTokensUsdPerMillion?: number;
  readonly reasoningTokensUsdPerMillion?: number;
}

/** Historical calculated cost is retained with the catalog identity that produced it. */
export interface BillableInvocationPricing {
  readonly catalogVersion: string;
  readonly calculatedCostUsd: number;
  readonly rateSnapshot?: BillableInvocationRateSnapshot;
}

type InstrumentedInvocation = {
  readonly instrumentationGap: false;
  readonly instrumentationGapReason?: never;
};

type InvocationInstrumentationGap = {
  readonly instrumentationGap: true;
  readonly instrumentationGapReason: string;
};

/**
 * One finalized provider invocation. Optional numeric fields mean unavailable;
 * zero is reserved for a provider- or instrument-reported zero.
 */
export type BillableInvocationRecord = {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly sourceId: string;
  readonly sessionId: string | null;
  readonly sessionPath: string | null;
  readonly branchId: string | null;
  readonly parentOperationId: string | null;
  readonly parentRunId: string | null;
  readonly parentToolId: string | null;
  readonly kind: BillableInvocationKind;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly providerTotalTokens?: number;
  readonly providerReportedCostUsd?: number;
  readonly pricing?: BillableInvocationPricing;
  readonly provenance: BillableInvocationProvenance;
  /** Direct settlement or deterministic compatibility backfill. */
  readonly evidenceOrigin?: 'live' | 'migration';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: BillableInvocationOutcome;
} & (InstrumentedInvocation | InvocationInstrumentationGap);

/** A sum which preserves whether some or all contributing values were unknown. */
export interface BillableInvocationMetricProjection {
  readonly value?: number;
  readonly knownInvocations: number;
  readonly unknownInvocations: number;
  readonly complete: boolean;
}

export interface BillableInvocationSummary {
  readonly invocationCount: number;
  readonly inputTokens: BillableInvocationMetricProjection;
  readonly outputTokens: BillableInvocationMetricProjection;
  readonly cacheReadTokens: BillableInvocationMetricProjection;
  readonly cacheWriteTokens: BillableInvocationMetricProjection;
  readonly reasoningTokens: BillableInvocationMetricProjection;
  readonly providerTotalTokens: BillableInvocationMetricProjection;
  /** Provider-reported cost when present, otherwise the historical calculated cost. */
  readonly effectiveCostUsd: BillableInvocationMetricProjection;
  readonly providerReportedCostUsd: BillableInvocationMetricProjection;
  readonly calculatedCostUsd: BillableInvocationMetricProjection;
  readonly provenanceCounts: Readonly<Record<BillableInvocationProvenance, number>>;
  readonly outcomeCounts: Readonly<Record<BillableInvocationOutcome, number>>;
  readonly instrumentationGapInvocations: number;
}

export interface BillableInvocationProjection {
  readonly records: readonly BillableInvocationRecord[];
  readonly summary: BillableInvocationSummary;
}

export interface BillableInvocationAggregateRow {
  readonly provider: string;
  readonly model: string;
  readonly kind: BillableInvocationKind;
  readonly summary: BillableInvocationSummary;
}

export interface BillableInvocationAggregateProjection {
  readonly summary: BillableInvocationSummary;
  readonly groups: readonly BillableInvocationAggregateRow[];
}

export interface BillableInvocationSessionSelector {
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly branchId?: string;
}
