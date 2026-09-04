import assert from 'node:assert/strict';
import test from 'node:test';

import { projectLedgerUsageOntoAggregate } from '../../src/host/billable-invocation-ledger/aggregate';
import type { BillableInvocationRecord } from '../../src/shared/billable-invocation';
import { sessionUsageSnapshotFromLedger } from '../../src/shared/session-usage';
import { EMPTY_AGGREGATE_STATS } from '../../src/shared/protocol/aggregate-stats';
import {
  buildCompletedCostSummaryFromSnapshot,
  buildSessionCostIndicator,
  buildSessionTokenUsageFromSnapshot,
  extractSubagentCostSummaryFromSnapshot,
} from '../../src/webview/panel/session-tabs/token-usage';

function row(
  invocationId: string,
  kind: BillableInvocationRecord['kind'],
  inputTokens: number,
  outputTokens: number,
  cost: number,
  endedAt: string,
): BillableInvocationRecord {
  return {
    schemaVersion: 1,
    invocationId,
    sourceId: `source:${invocationId}`,
    sessionId: 'session-conservation',
    sessionPath: '/sessions/conservation.jsonl',
    branchId: 'branch-a',
    parentOperationId: 'operation-a',
    parentRunId: 'run-a',
    parentToolId: kind === 'subagent' ? 'tool-a' : null,
    kind,
    provider: 'provider-a',
    model: 'model-a',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    providerTotalTokens: inputTokens + outputTokens,
    providerReportedCostUsd: cost,
    provenance: 'exact',
    startedAt: endedAt,
    endedAt,
    outcome: 'succeeded',
    instrumentationGap: false,
  };
}

test('session, aggregate, and export-authority projections conserve every billable invocation', () => {
  const nowMs = new Date(2026, 8, 4, 12, 0, 0).getTime();
  const endedAt = (minutesAgo: number): string => new Date(nowMs - minutesAgo * 60_000).toISOString();
  const records = [
    row('conversation', 'conversation', 100, 20, 0.10, endedAt(60)),
    row('retry', 'retry', 30, 2, 0.03, endedAt(50)),
    row('compaction', 'history_compaction', 40, 8, 0.04, endedAt(40)),
    row('title', 'session_title', 10, 3, 0.01, endedAt(30)),
    row('prepass', 'skill_pruning_prepass', 25, 5, 0.02, endedAt(20)),
    row('subagent', 'subagent', 80, 12, 0.08, endedAt(10)),
  ];

  const authority = {
    inputTokens: records.reduce((total, record) => total + (record.inputTokens ?? 0), 0),
    outputTokens: records.reduce((total, record) => total + (record.outputTokens ?? 0), 0),
    effectiveCostUsd: records.reduce((total, record) => total
      + (record.providerReportedCostUsd ?? record.pricing?.calculatedCostUsd ?? 0), 0),
  };
  const snapshot = sessionUsageSnapshotFromLedger(records);
  const sessionTokens = buildSessionTokenUsageFromSnapshot(snapshot);
  const completed = buildCompletedCostSummaryFromSnapshot(snapshot, undefined, undefined);
  const subagents = extractSubagentCostSummaryFromSnapshot(snapshot);
  const sessionCost = buildSessionCostIndicator(
    sessionTokens,
    undefined,
    undefined,
    completed,
    subagents,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    snapshot,
  );
  const aggregate = projectLedgerUsageOntoAggregate(
    { ...EMPTY_AGGREGATE_STATS, ready: true },
    records,
    nowMs,
  );

  assert.equal(sessionTokens.inputTokens, authority.inputTokens);
  assert.equal(sessionTokens.outputTokens, authority.outputTokens);
  assert.equal(sessionCost?.breakdown.totalCost, authority.effectiveCostUsd);
  assert.equal(aggregate.todayInputTokens, authority.inputTokens);
  assert.equal(aggregate.todayOutputTokens, authority.outputTokens);
  assert.equal(aggregate.todayCost, authority.effectiveCostUsd);
  assert.equal(aggregate.totalCost, authority.effectiveCostUsd);
  assert.deepEqual(
    sessionCost?.breakdown.sources.map((source) => source.key).sort(),
    ['conversation', 'history_compaction', 'pruning', 'retry', 'session_title', 'subagents'].sort(),
  );
});

test('unknown and unpriced provenance remains incomplete without changing known conserved subtotals', () => {
  const exact = row('exact', 'conversation', 12, 3, 0.5, '2026-09-04T10:00:00.000Z');
  const gap: BillableInvocationRecord = {
    ...row('gap', 'branch_summary', 0, 0, 0, '2026-09-04T10:01:00.000Z'),
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    providerTotalTokens: undefined,
    providerReportedCostUsd: undefined,
    provenance: 'unknown',
    outcome: 'failed',
    instrumentationGap: true,
    instrumentationGapReason: 'provider omitted usage',
  };
  const snapshot = sessionUsageSnapshotFromLedger([exact, gap]);

  assert.equal(snapshot.incompleteInvocationCount, 1);
  assert.equal(snapshot.unpricedInvocationCount, 0);
  assert.equal(exact.providerReportedCostUsd, 0.5);
  const aggregate = projectLedgerUsageOntoAggregate(
    { ...EMPTY_AGGREGATE_STATS, ready: true },
    [exact, gap],
    Date.parse('2026-09-04T12:00:00.000Z'),
  );
  assert.equal(aggregate.totalCost, 0.5);
  assert.equal(aggregate.billableAccounting?.unknownInvocationCount, 1);
  assert.equal(aggregate.billableAccounting?.instrumentationGapInvocationCount, 1);
});
