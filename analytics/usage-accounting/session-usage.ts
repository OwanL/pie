import type { AssistantUsage } from '../contracts/legacy-run-analytics-contracts.js';
import type {
  BillableInvocationOutcome,
  BillableInvocationProvenance,
} from './billable-invocation';
import type { SubagentBillingCaptureReceipt } from '../contracts/subagent-billing-capture-receipt.js';

export type SessionUsageKind =
  | 'assistant'
  | 'conversation'
  | 'retry'
  | 'history_compaction'
  | 'branch_summary'
  | 'skill_pruning_prepass'
  | 'session_title'
  | 'subagent'
  | 'other';

/** One independently billable model invocation retained outside transcript windows. */
export interface SessionUsageSample {
  sourceId: string;
  /** Stable subagent-result group shared by its aggregate and attempt samples. */
  groupId?: string;
  kind: SessionUsageKind;
  modelId?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  /** Exact provider-reported cost. Catalog pricing is used only when all token channels are present. */
  reportedCostUsd?: number;
  /** Historical catalog calculation retained by the invocation ledger. */
  calculatedCostUsd?: number;
  priceCatalogVersion?: string;
  providerTotalTokens?: number;
  /** False when numeric zero channel placeholders represent unavailable data. */
  tokenChannelsKnown?: boolean;
  tokenChannelPresence?: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
  };
  provenance?: 'exact' | 'estimated' | 'unpriced' | 'unknown';
  instrumentationGap?: boolean;
  instrumentationGapReason?: string;
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  startedAt?: string;
  endedAt?: string;
  parentOperationId?: string;
  parentRunId?: string;
  parentToolId?: string;
  /** Raw durable provider-response sources represented by a folded migration row. */
  constituentSourceIds?: string[];
  /** Producer-owned canonical provider identity. The host may project or
   * reconcile it, but must not mint a replacement. */
  canonicalInvocationId?: string;
  /** Runtime assistant message id associated with a pending live handoff. It
   * is not durable accounting identity and is omitted from settled rows. */
  provisionalMessageId?: string;
  producerCaptureReceipt?: SubagentBillingCaptureReceipt;
  producerAttemptId?: string;
  producerEvidenceKind?: 'providerInvocation' | 'attemptGap' | 'omittedGap' | 'aggregate';
}

/** Complete ledger projection for a session branch. */
export type SessionUsageFreshness = 'fresh' | 'stale' | 'unknown';
export type SessionUsageRefreshStatus = 'idle' | 'refreshing' | 'error';

export interface SessionUsageSnapshot {
  samples: SessionUsageSample[];
  /** Host-observed provider settlements awaiting the canonical authority. These
   * rows are display-only handoff evidence, never durable accounting, and are
   * removed once their canonical invocation identity is present in `samples`. */
  pendingSamples?: SessionUsageSample[];
  /** Steady-state renderer authority. Absent is treated as unknown for an old
   * host; transcript data is never substituted. `ledger` is the legacy
   * JSONL authority, `canonical` the normalized canonical analytics store.
   * Both are authoritative; the value only tells the webview which durable
   * store answered the projection. */
  authority?: 'ledger' | 'canonical' | 'unknown';
  /** Whether the rows belong to the latest known durable revision. A stale
   * snapshot remains usable only as an explicitly labelled last-known value;
   * it must never be presented as fresh. */
  freshness?: SessionUsageFreshness;
  /** Refresh state for the durable projection. `error` means the last bounded
   * replacement read failed; a stale last-known snapshot may still be shown
   * with that error marker. */
  refreshStatus?: SessionUsageRefreshStatus;
  branchId?: string;
  /** Raw durable IDs in the selected branch, including assistant responses
   * folded together by the display transcript mapper. */
  branchEntryIds?: string[];
  incompleteInvocationCount?: number;
  unpricedInvocationCount?: number;
}

/** Convert immutable ledger rows to the compatibility snapshot consumed by the
 * session token/cost surfaces. Unknown channels remain visible through
 * provenance/instrumentation metadata rather than masquerading as known zero. */
/**
 * Structural projection input shared by the legacy ledger records and P5's
 * canonical settlement rows. Only fields the public session-usage projection
 * consumes are part of this contract; ledger records satisfy it structurally.
 */
export type SessionUsageProjectionRow = {
  readonly sourceId: string;
  readonly canonicalInvocationId?: string;
  readonly kind: Exclude<SessionUsageKind, 'assistant'>;
  readonly model: string | null;
  readonly provider: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly providerTotalTokens?: number | null;
  readonly providerReportedCostUsd?: number | null;
  readonly calculatedCostUsd?: number | null;
  readonly priceCatalogVersion?: string;
  readonly pricing?: { catalogVersion: string; calculatedCostUsd: number };
  readonly provenance?: BillableInvocationProvenance;
  readonly instrumentationGap?: boolean;
  readonly instrumentationGapReason?: string;
  readonly outcome?: BillableInvocationOutcome;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly parentOperationId?: string | null;
  readonly parentRunId?: string | null;
  readonly parentToolId?: string | null;
};

/** Projection of one durable store into the public session-usage protocol. */
export function sessionUsageSnapshotFromLedger(
  records: readonly SessionUsageProjectionRow[],
  authority: 'ledger' | 'canonical' = 'ledger',
): SessionUsageSnapshot {
  const samples = records.map((record): SessionUsageSample => ({
    sourceId: record.sourceId,
    ...(record.canonicalInvocationId ? { canonicalInvocationId: record.canonicalInvocationId } : {}),
    kind: record.kind,
    modelId: record.model === 'unknown-model' || record.model === null ? undefined : record.model,
    provider: record.provider === 'unknown-provider' || record.provider === null ? undefined : record.provider,
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    cacheReadTokens: record.cacheReadTokens ?? 0,
    cacheWriteTokens: record.cacheWriteTokens ?? 0,
    totalTokens: record.providerTotalTokens
      ?? (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
        + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0),
    ...(record.reasoningTokens !== undefined && record.reasoningTokens !== null
      ? { reasoningTokens: record.reasoningTokens } : {}),
    ...(record.providerReportedCostUsd !== undefined && record.providerReportedCostUsd !== null
      ? { reportedCostUsd: record.providerReportedCostUsd } : {}),
    ...(record.calculatedCostUsd !== undefined && record.calculatedCostUsd !== null
      ? { calculatedCostUsd: record.calculatedCostUsd }
      : record.pricing ? {
        calculatedCostUsd: record.pricing.calculatedCostUsd,
        priceCatalogVersion: record.pricing.catalogVersion,
      } : {}),
    ...(record.priceCatalogVersion !== undefined ? { priceCatalogVersion: record.priceCatalogVersion } : {}),
    ...(record.providerTotalTokens !== undefined && record.providerTotalTokens !== null
      ? { providerTotalTokens: record.providerTotalTokens } : {}),
    tokenChannelsKnown: record.inputTokens != null && record.outputTokens != null
      && record.cacheReadTokens != null && record.cacheWriteTokens != null,
    tokenChannelPresence: {
      input: record.inputTokens != null,
      output: record.outputTokens != null,
      cacheRead: record.cacheReadTokens != null,
      cacheWrite: record.cacheWriteTokens != null,
    },
    provenance: record.provenance,
    instrumentationGap: record.instrumentationGap,
    ...(record.instrumentationGapReason ? { instrumentationGapReason: record.instrumentationGapReason } : {}),
    outcome: record.outcome,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(record.parentOperationId ? { parentOperationId: record.parentOperationId } : {}),
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(record.parentToolId ? { parentToolId: record.parentToolId } : {}),
  }));
  return {
    samples,
    authority,
    incompleteInvocationCount: records.filter((record) => record.provenance === 'unknown' || record.instrumentationGap).length,
    unpricedInvocationCount: records.filter((record) => record.provenance === 'unpriced').length,
  };
}

/**
 * Flat, deterministic accounting fingerprint. Structured-cloned snapshots get
 * fresh references on every host post; this lets the webview gate expensive
 * transcript/subagent walks on content rather than reference identity.
 */
export function sessionUsageSignature(snapshot: SessionUsageSnapshot | null | undefined): string {
  const sampleSignature = (sample: SessionUsageSample) => [
    sample.sourceId,
    sample.canonicalInvocationId ?? '',
    sample.provisionalMessageId ?? '',
    sample.groupId ?? '',
    sample.kind,
    sample.modelId ?? '',
    sample.provider ?? '',
    sample.inputTokens,
    sample.outputTokens,
    sample.cacheReadTokens,
    sample.cacheWriteTokens,
    sample.totalTokens,
    sample.reasoningTokens ?? '',
    sample.reportedCostUsd ?? '',
    sample.calculatedCostUsd ?? '',
    sample.priceCatalogVersion ?? '',
    sample.providerTotalTokens ?? '',
    sample.provenance ?? '',
    sample.instrumentationGap ?? '',
    sample.outcome ?? '',
  ];
  return JSON.stringify({
    authority: snapshot?.authority ?? 'unknown',
    freshness: snapshot?.freshness ?? 'unknown',
    refreshStatus: snapshot?.refreshStatus ?? 'idle',
    samples: (snapshot?.samples ?? []).map(sampleSignature),
    pendingSamples: (snapshot?.pendingSamples ?? []).map(sampleSignature),
  });
}

function sessionUsageGroupId(sample: SessionUsageSample): string {
  if (sample.groupId) return sample.groupId;
  if (sample.kind !== 'subagent' || !sample.sourceId.startsWith('subagent:')) return sample.sourceId;

  // Before groupId existed, attempt and residual source ids retained the
  // aggregate result id as a prefix. Recover that group for cross-version
  // baseline/overlay replacement while keeping sourceId as the fallback.
  for (const marker of [':attempt:', ':residual-cost']) {
    const markerIndex = sample.sourceId.lastIndexOf(marker);
    if (markerIndex > 0) return sample.sourceId.slice(0, markerIndex);
  }
  return sample.sourceId;
}

/** Merge a durable full-session baseline with fresher loaded/live rows.
 * Exact sources replace exact sources; a fresher subagent result replaces every
 * aggregate/attempt representation from the same stable result group. */
export function mergeSessionUsageSnapshots(
  baseline: SessionUsageSnapshot | null | undefined,
  overlay: SessionUsageSnapshot | null | undefined,
): SessionUsageSnapshot {
  const overlaySamples = overlay?.samples ?? [];
  const overlayGroups = new Set(overlaySamples.map(sessionUsageGroupId));
  const merged = new Map<string, SessionUsageSample>();
  for (const sample of baseline?.samples ?? []) {
    if (overlayGroups.has(sessionUsageGroupId(sample))) continue;
    merged.set(sample.sourceId, sample);
  }
  for (const sample of overlaySamples) merged.set(sample.sourceId, sample);
  const authority = overlay?.authority ?? baseline?.authority;
  const freshness = overlay?.freshness ?? baseline?.freshness;
  const refreshStatus = overlay?.refreshStatus ?? baseline?.refreshStatus;
  const branchId = overlay?.branchId ?? baseline?.branchId;
  const branchEntryIds = overlay?.branchEntryIds ?? baseline?.branchEntryIds;
  const pendingSamples = [...(baseline?.pendingSamples ?? []), ...(overlay?.pendingSamples ?? [])];
  return {
    samples: [...merged.values()],
    ...(pendingSamples.length > 0 ? { pendingSamples } : {}),
    ...(authority !== undefined ? { authority } : {}),
    ...(freshness !== undefined ? { freshness } : {}),
    ...(refreshStatus !== undefined ? { refreshStatus } : {}),
    ...(branchId !== undefined ? { branchId } : {}),
    ...(branchEntryIds !== undefined ? { branchEntryIds } : {}),
  };
}

export function mergeAssistantUsage(
  current: AssistantUsage | undefined,
  incoming: AssistantUsage | undefined,
): AssistantUsage | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  const hasReasoning = current.reasoningTokens !== undefined || incoming.reasoningTokens !== undefined;
  const hasReportedCost = current.reportedCostUsd !== undefined || incoming.reportedCostUsd !== undefined;
  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
    cacheReadTokens: current.cacheReadTokens + incoming.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + incoming.cacheWriteTokens,
    totalTokens: current.totalTokens + incoming.totalTokens,
    ...(hasReasoning ? { reasoningTokens: (current.reasoningTokens ?? 0) + (incoming.reasoningTokens ?? 0) } : {}),
    ...(hasReportedCost ? { reportedCostUsd: (current.reportedCostUsd ?? 0) + (incoming.reportedCostUsd ?? 0) } : {}),
  };
}

export function assistantUsageFromSample(sample: SessionUsageSample): AssistantUsage {
  return {
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    cacheReadTokens: sample.cacheReadTokens,
    cacheWriteTokens: sample.cacheWriteTokens,
    totalTokens: sample.totalTokens,
    ...(sample.tokenChannelsKnown !== undefined ? { tokenChannelsKnown: sample.tokenChannelsKnown } : {}),
    ...(sample.tokenChannelPresence ? { tokenChannelPresence: sample.tokenChannelPresence } : {}),
    ...(sample.reasoningTokens !== undefined ? { reasoningTokens: sample.reasoningTokens } : {}),
    ...(sample.reportedCostUsd !== undefined ? { reportedCostUsd: sample.reportedCostUsd } : {}),
  };
}
