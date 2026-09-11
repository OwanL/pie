import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderSettlementProjection } from '../../src/analytics/sqlite-recorder.js';
import {
  canonicalDailyUsageAndCost,
  canonicalSettlementUsageRecord,
  canonicalWeeklyUsageAndCost,
  sessionUsageSnapshotFromCanonicalSettlements,
  summarizeCanonicalUsage,
  type CanonicalUsageRecord,
} from '../../src/analytics/canonical-usage.js';
import {
  normalizeUsageChannels,
  summarizeEffectiveCost,
  type NormalizedUsageChannels,
} from '../../../shared/analytics/metrics.js';

function settlement(options: {
  invocationId: string;
  rootSessionId?: string | null;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  outcome?: string | null;
  settledAtMs?: number | string | null;
  usage?: {
    inputTokens?: number | string | null;
    outputTokens?: number | string | null;
    cacheReadTokens?: number | string | null;
    cacheWriteTokens?: number | string | null;
    reasoningTokens?: number | string | null;
    providerTotalTokens?: number | string | null;
  };
  reportedCostUsd?: number | null;
  calculatedCostUsd?: number | null;
  calculatedCostComplete?: boolean;
  effectiveCostUsd?: number | null;
  effectiveCostSource?: 'reported' | 'calculated' | null;
  effectiveCostCoverage?: 'known' | 'unknown' | 'not_applicable';
  revision?: number | string;
}): ProviderSettlementProjection {
  return {
    generationId: 'generation-1',
    invocationId: options.invocationId,
    rootSessionId: options.rootSessionId ?? 'root-a',
    executionId: null,
    branchId: null,
    provider: options.provider ?? 'anthropic',
    model: options.model ?? 'claude-x',
    dispatchedModel: options.model ?? 'claude-x',
    reportedModel: options.model ?? 'claude-x',
    purpose: options.purpose ?? 'conversation',
    outcome: options.outcome ?? 'succeeded',
    settledAtMs: options.settledAtMs ?? 1_750_000_000_000,
    usage: {
      inputTokens: options.usage?.inputTokens === undefined ? '100' : options.usage.inputTokens,
      outputTokens: options.usage?.outputTokens === undefined ? '50' : options.usage.outputTokens,
      cacheReadTokens: options.usage?.cacheReadTokens === undefined ? '10' : options.usage.cacheReadTokens,
      cacheWriteTokens: options.usage?.cacheWriteTokens === undefined ? '5' : options.usage.cacheWriteTokens,
      reasoningTokens: options.usage?.reasoningTokens ?? null,
      providerTotalTokens: options.usage?.providerTotalTokens === undefined ? '165' : options.usage.providerTotalTokens,
    },
    reportedCostUsd: options.reportedCostUsd ?? null,
    calculatedCostUsd: options.calculatedCostUsd ?? null,
    calculatedCostComplete: options.calculatedCostComplete ?? false,
    normalizedUsage: normalizeUsageChannels({
      inputTokens: options.usage?.inputTokens === undefined || options.usage.inputTokens === null
        ? null : String(options.usage.inputTokens),
      outputTokens: options.usage?.outputTokens === undefined || options.usage.outputTokens === null
        ? null : String(options.usage.outputTokens),
      cacheReadTokens: options.usage?.cacheReadTokens === undefined || options.usage.cacheReadTokens === null
        ? null : String(options.usage.cacheReadTokens),
      cacheWriteTokens: options.usage?.cacheWriteTokens === undefined || options.usage.cacheWriteTokens === null
        ? null : String(options.usage.cacheWriteTokens),
      reasoningTokens: options.usage?.reasoningTokens === undefined || options.usage.reasoningTokens === null
        ? null : String(options.usage.reasoningTokens),
      providerTotalTokens: options.usage?.providerTotalTokens === undefined || options.usage.providerTotalTokens === null
        ? null : String(options.usage.providerTotalTokens),
    }),
    effectiveCostUsd: options.effectiveCostUsd ?? null,
    effectiveCostSource: options.effectiveCostSource ?? null,
    effectiveCostCoverage: options.effectiveCostCoverage ?? 'unknown',
    revision: options.revision ?? '1',
  };
}

test('canonical settlement adapters feed the engine-neutral scope summary', () => {
  const settlements = [
    settlement({ invocationId: 'i-1', reportedCostUsd: 0.04, effectiveCostUsd: 0.04, effectiveCostSource: 'reported' }),
    settlement({ invocationId: 'i-2', calculatedCostUsd: 0.03, calculatedCostComplete: true, effectiveCostUsd: 0.03, effectiveCostSource: 'calculated' }),
  ];
  const records: CanonicalUsageRecord[] = settlements.map(canonicalSettlementUsageRecord);
  const global = summarizeCanonicalUsage(records, { kind: 'global' });
  assert.equal(global.occurrenceCount, 2);
  assert.equal(global.value, 0.07);
  assert.equal(global.reportedCount, 1);
  assert.equal(global.calculatedCount, 1);
  const byRoot = summarizeCanonicalUsage(records, { kind: 'rootSession', rootSessionId: 'root-a' });
  assert.equal(byRoot.value, 0.07);
  assert.equal(
    summarizeCanonicalUsage(records, { kind: 'rootSession', rootSessionId: 'other-root' }).occurrenceCount,
    0,
  );
  // Parity with the engine-neutral metric applied directly.
  assert.deepEqual(summarizeEffectiveCost(records), global);
});

test('canonical copy scopes select owning and inherited rows by reference', () => {
  const records: CanonicalUsageRecord[] = [
    {
      invocationId: 'a-1',
      rootSessionId: 'copy-a',
      selectedSessionId: 'copy-a',
      usage: {},
      reportedCostUsd: 0.04,
      calculatedCostUsd: null,
      calculatedCostComplete: false,
      settledAtMs: 1n,
    },
    {
      invocationId: 'b-1',
      rootSessionId: 'copy-b',
      selectedSessionId: 'copy-b',
      usage: {},
      reportedCostUsd: 0.03,
      calculatedCostUsd: null,
      calculatedCostComplete: false,
      settledAtMs: 2n,
    },
    {
      invocationId: 'a-1',
      rootSessionId: 'copy-a',
      selectedSessionId: 'copy-d',
      inheritedFromInvocationId: 'a-1',
      usage: {},
      reportedCostUsd: 0.04,
      calculatedCostUsd: null,
      calculatedCostComplete: false,
      settledAtMs: 3n,
    },
  ];
  assert.equal(summarizeCanonicalUsage(records, { kind: 'global' }).value, 0.07);
  assert.equal(summarizeCanonicalUsage(records, { kind: 'copyOwn', copySessionId: 'copy-a' }).value, 0.04);
  assert.equal(summarizeCanonicalUsage(records, { kind: 'copyOwn', copySessionId: 'copy-b' }).value, 0.03);
  assert.equal(summarizeCanonicalUsage(records, { kind: 'copyOwn', copySessionId: 'copy-d' }).occurrenceCount, 0);
  assert.equal(summarizeCanonicalUsage(records, { kind: 'copyInherited', copySessionId: 'copy-d' }).value, 0.04);
  // Branch scopes without descriptor facts select nothing, never a fallback.
  assert.equal(summarizeCanonicalUsage(records, { kind: 'branch', branchId: 'br-1', branches: [] }).occurrenceCount, 0);
});

test('canonical calendar buckets use the explicitly requested timezone', () => {
  const records: CanonicalUsageRecord[] = [
    { invocationId: 'd1', usage: {}, reportedCostUsd: 0.01, calculatedCostUsd: null, calculatedCostComplete: false, settledAtMs: 1_752_885_000_000 },
    { invocationId: 'd2', usage: {}, reportedCostUsd: 0.02, calculatedCostUsd: null, calculatedCostComplete: false, settledAtMs: 1_752_971_400_000 },
    { invocationId: 'd3', usage: {}, reportedCostUsd: 0.04, calculatedCostUsd: null, calculatedCostComplete: false, settledAtMs: null },
  ];
  const daily = canonicalDailyUsageAndCost(records, 'UTC');
  assert.equal(daily.buckets.size, 2);
  assert.equal(daily.buckets.get('2025-07-19')?.cost.knownTotal, 0.01);
  assert.equal(daily.unknownSettlementCount, 1);
  assert.equal(daily.undated.cost.occurrenceCount, 1);
  assert.equal(daily.undated.cost.knownCount, 1);
  assert.equal(daily.undated.cost.knownTotal, 0.04);
  assert.equal(daily.undated.settlementCount, 1);
  // The contract's week is the settlement day plus the preceding six local
  // dates; each settlement day keys its own rolling 7-day window.
  const weekly = canonicalWeeklyUsageAndCost(records, 'UTC');
  assert.equal(weekly.buckets.size, 2);
  assert.deepEqual([...weekly.buckets.keys()], ['2025-07-13..2025-07-19', '2025-07-14..2025-07-20']);
  assert.equal(weekly.undated.cost.occurrenceCount, 1);
  assert.equal(weekly.undated.cost.knownCount, 1);
  assert.equal(weekly.undated.settlementCount, 1);
});

test('canonical settlements project the public session-usage snapshot', () => {
  const snapshot = sessionUsageSnapshotFromCanonicalSettlements([
    settlement({
      invocationId: 'reported-1',
      purpose: 'conversation',
      outcome: 'cancelled',
      reportedCostUsd: 0.05,
      effectiveCostUsd: 0.05,
      effectiveCostSource: 'reported',
      effectiveCostCoverage: 'known',
    }),
    settlement({
      invocationId: 'calculated-1',
      reportedCostUsd: null,
      calculatedCostUsd: 0.02,
      calculatedCostComplete: true,
      effectiveCostUsd: 0.02,
      effectiveCostSource: 'calculated',
      effectiveCostCoverage: 'known',
    }),
    settlement({
      invocationId: 'unpriced-1',
      purpose: 'branch_summary',
      reportedCostUsd: null,
      calculatedCostUsd: null,
      effectiveCostUsd: null,
      effectiveCostCoverage: 'not_applicable',
    }),
    settlement({
      invocationId: 'unknown-1',
      purpose: 'session_title',
      usage: { inputTokens: '12', outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerTotalTokens: null },
      effectiveCostUsd: null,
      effectiveCostCoverage: 'unknown',
    }),
    settlement({
      invocationId: 'other-1',
      purpose: 'unknown-purpose',
    }),
  ]);
  assert.equal(snapshot.authority, 'canonical');
  assert.equal(snapshot.samples.length, 5);
  const bySource = new Map(snapshot.samples.map((sample) => [sample.sourceId, sample]));
  const reported = bySource.get('reported-1');
  assert.equal(reported?.kind, 'conversation');
  assert.equal(reported?.reportedCostUsd, 0.05);
  assert.equal(reported?.provenance, 'exact');
  assert.equal(reported?.outcome, 'cancelled');
  assert.equal(reported?.startedAt, undefined);
  assert.equal(reported?.endedAt, new Date(1_750_000_000_000).toISOString());
  assert.equal(reported?.tokenChannelsKnown, true);
  const calculated = bySource.get('calculated-1');
  assert.equal(calculated?.provenance, 'estimated');
  assert.equal(calculated?.calculatedCostUsd, 0.02);
  const unpriced = bySource.get('unpriced-1');
  assert.equal(unpriced?.provenance, 'unpriced');
  assert.equal(unpriced?.instrumentationGap, false);
  const unknown = bySource.get('unknown-1');
  assert.equal(unknown?.provenance, 'unknown');
  assert.equal(unknown?.tokenChannelsKnown, false);
  assert.equal(unknown?.instrumentationGap, true);
  assert.equal(unknown?.inputTokens, 12);
  assert.equal(unknown?.tokenChannelPresence?.output, false);
  assert.equal(bySource.get('other-1')?.kind, 'other');
  assert.equal(snapshot.incompleteInvocationCount, 1);
  assert.equal(snapshot.unpricedInvocationCount, 2);
});

test('canonical settlement channel presence distinguishes zero from unknown', () => {
  const snapshot = sessionUsageSnapshotFromCanonicalSettlements([
    settlement({
      invocationId: 'zeroed',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        providerTotalTokens: 0,
      },
      reportedCostUsd: 0,
      effectiveCostUsd: 0,
      effectiveCostSource: 'reported',
      effectiveCostCoverage: 'known',
    }),
  ]);
  const sample = snapshot.samples[0]!;
  assert.equal(sample.inputTokens, 0);
  assert.equal(sample.totalTokens, 0);
  assert.equal(sample.tokenChannelPresence?.input, true);
  assert.equal(sample.reportedCostUsd, 0);
});

test('canonical public usage marks int64 values outside the numeric protocol range as unknown', () => {
  const exactInputTokens = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
  const snapshot = sessionUsageSnapshotFromCanonicalSettlements([
    settlement({
      invocationId: 'unsafe-int64',
      usage: {
        inputTokens: exactInputTokens,
        outputTokens: '1',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        providerTotalTokens: exactInputTokens,
      },
    }),
    settlement({
      invocationId: 'unsafe-optional-int64',
      usage: {
        inputTokens: '1',
        outputTokens: '1',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        reasoningTokens: exactInputTokens,
        providerTotalTokens: exactInputTokens,
      },
    }),
  ]);

  const sample = snapshot.samples[0]!;
  assert.equal(sample.inputTokens, 0);
  assert.equal(sample.tokenChannelPresence?.input, false);
  assert.equal(sample.tokenChannelsKnown, false);
  assert.equal(sample.instrumentationGap, true);
  assert.match(sample.instrumentationGapReason ?? '', /exact decimal remains available/u);
  const optional = snapshot.samples[1]!;
  assert.equal(optional.tokenChannelsKnown, true);
  assert.equal(optional.reasoningTokens, undefined);
  assert.equal(optional.providerTotalTokens, undefined);
  assert.equal(optional.instrumentationGap, true);
  assert.match(optional.instrumentationGapReason ?? '', /exact decimal remains available/u);
  assert.equal(snapshot.incompleteInvocationCount, 2);
});
