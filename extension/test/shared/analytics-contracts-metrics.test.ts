import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAnalyticsObservation,
  closeDispositionForPrivacy,
  deriveAnalyticsIdempotencyKey,
  parseInt64,
  validateAnalyticsObservation,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts';
import {
  normalizeUsageChannels,
  summarizeAccountingScope,
  summarizeDailyCost,
  summarizeEffectiveCost,
  summarizeInt64,
  summarizeLatency,
  summarizeSettledThroughput,
  summarizeUsageChannel,
  latestContextUtilization,
  localCalendarWeekDateKeys,
  unionDurationMs,
} from '../../../shared/analytics/metrics';
import { sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction';

function observation(overrides: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    schemaVersion: 1,
    generationId: 'generation-1',
    producerKind: 'host',
    sourceKey: 'source-1',
    entityKind: 'execution',
    entityKey: 'execution-1',
    observationKind: 'end',
    idempotencyKey: '["generation-1","end","source-1"]',
    observedAtMs: 1_735_690_844_443,
    scope: { workspaceCoverage: 'known', workspaceId: 'workspace-1', rootSessionId: 'session-1' },
    captureSubject: { kind: 'session', rootSessionId: 'session-1' },
    producer: { buildId: 'build-1', processId: 'process-1', processGeneration: 'backend-1' },
    fields: {},
    ...overrides,
  };
}

test('observation envelope validates typed numeric invariants and derives scoped idempotency', () => {
  const valid = observation({ fields: { inputTokens: 10, reportedCostUsd: 0 } });
  assert.deepEqual(validateAnalyticsObservation(valid), []);
  assert.equal(deriveAnalyticsIdempotencyKey(valid), '["generation-1","end","source-1"]');
  assert.notDeepEqual(validateAnalyticsObservation({
    ...valid,
    fields: { inputTokens: -1 },
  }), []);
  assert.match(
    validateAnalyticsObservation({ ...valid, idempotencyKey: 'wrong' })
      .map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    /idempotencyKey: must match/,
  );
  assert.match(
    validateAnalyticsObservation({ ...valid, fields: { settledAtMs: 1.5 } })
      .map((issue) => `${issue.path}: ${issue.message}`).join('\n'),
    /fields\.settledAtMs: must be a safe integer/,
  );
});

test('observation source keys distinguish exact redelivery from conflict and generation reuse', () => {
  const first = observation();
  const accepted = acceptAnalyticsObservation({}, first);
  assert.equal(accepted.status, 'accepted');
  const duplicate = acceptAnalyticsObservation(accepted.state, first);
  assert.equal(duplicate.status, 'duplicate');
  const replayedByReplacement = acceptAnalyticsObservation(accepted.state, {
    ...first,
    sourceSequence: '99',
    producer: { ...first.producer, processId: 'process-2', processGeneration: 'backend-2' },
  });
  assert.equal(replayedByReplacement.status, 'duplicate', 'transport receipts do not redefine source payload');

  const conflict = acceptAnalyticsObservation(accepted.state, {
    ...first,
    fields: { outcome: 'failed' },
  });
  assert.equal(conflict.status, 'conflict');

  const nextGeneration = acceptAnalyticsObservation(accepted.state, {
    ...first,
    generationId: 'generation-2',
    idempotencyKey: '["generation-2","end","source-1"]',
  });
  assert.equal(nextGeneration.status, 'accepted');
});

test('int64 preservation and missing channel coverage are explicit', () => {
  const large = '9007199254740993';
  assert.equal(parseInt64(large), 9007199254740993n);
  assert.deepEqual(summarizeInt64([1, large, null]), {
    occurrenceCount: 3,
    knownCount: 2,
    unknownCount: 1,
    knownTotal: '9007199254740994',
    value: null,
    complete: false,
  });
});

test('cache and reasoning normalization produces disjoint totals without double counting', () => {
  const normalized = normalizeUsageChannels({
    inputTokens: 100,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    inputIncludesCache: true,
    outputIncludesReasoning: true,
  });
  assert.deepEqual(normalized, {
    baseInputTokens: 50,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
    reasoningIncludedInOutput: true,
    complete: true,
  });
});

test('effective cost honors an explicit reported zero and never presents partial cost as complete', () => {
  const zero = summarizeEffectiveCost([{
    invocationId: 'zero',
    usage: {},
    reportedCostUsd: 0,
    calculatedCostUsd: 99,
  }]);
  assert.equal(zero.value, 0);
  assert.equal(zero.reportedCount, 1);
  assert.equal(zero.calculatedCount, 0);

  const partial = summarizeEffectiveCost([
    { invocationId: 'known', usage: {}, reportedCostUsd: 1.25 },
    { invocationId: 'unknown', usage: {} },
  ]);
  assert.equal(partial.knownTotal, 1.25);
  assert.equal(partial.value, null);
  assert.equal(partial.complete, false);
});

test('usage joins deduplicate invocation IDs before channel aggregation', () => {
  const result = summarizeUsageChannel([
    { invocationId: 'same', usage: { outputTokens: 10 } },
    { invocationId: 'same', usage: { outputTokens: 10 } },
    { invocationId: 'other', usage: {} },
  ], 'outputTokens');
  assert.equal(result.occurrenceCount, 2);
  assert.equal(result.knownTotal, 10);
  assert.equal(result.value, null);
});

test('busy time unions nested intervals and settled throughput reports exclusions', () => {
  assert.equal(unionDurationMs([
    { startMs: 0, endMs: 10 },
    { startMs: 2, endMs: 5 },
    { startMs: 9, endMs: 20 },
    { startMs: 30, endMs: 40 },
  ]), 30);
  const throughput = summarizeSettledThroughput([
    { settled: true, outputTokens: 100, durationMs: 1_000, durationSource: 'measured' },
    { settled: true, outputTokens: 50, durationMs: 0, durationSource: 'measured' },
    { settled: false, outputTokens: 10, durationMs: 100, durationSource: 'measured' },
  ]);
  assert.equal(throughput.tokensPerSecond, 100);
  assert.equal(throughput.matchedCount, 1);
  assert.equal(throughput.excludedCount, 2);
  assert.equal(throughput.complete, false);
});

test('execution-inclusive accounting includes descendants while direct scope stays narrow', () => {
  const records = [
    { invocationId: 'parent', executionId: 'parent-exec', usage: {}, reportedCostUsd: 1 },
    { invocationId: 'failed-child', executionId: 'failed-child-exec', parentExecutionId: 'parent-exec', usage: {}, reportedCostUsd: 2 },
    { invocationId: 'nested-child', executionId: 'nested-child-exec', parentExecutionId: 'failed-child-exec', usage: {}, reportedCostUsd: 4 },
  ];
  assert.equal(summarizeAccountingScope(records, { kind: 'execution', executionId: 'parent-exec', inclusive: false }).value, 1);
  assert.equal(summarizeAccountingScope(records, { kind: 'execution', executionId: 'parent-exec', inclusive: true }).value, 7);
});

test('local settlement buckets use calendar dates across DST transitions', () => {
  const records = [
    { invocationId: 'before', usage: {}, reportedCostUsd: 1, settledAtMs: Date.parse('2026-03-08T06:30:00Z') },
    { invocationId: 'after', usage: {}, reportedCostUsd: 2, settledAtMs: Date.parse('2026-03-08T07:30:00Z') },
    { invocationId: 'undated', usage: {}, reportedCostUsd: 4 },
  ];
  const daily = summarizeDailyCost(records, 'America/New_York');
  assert.deepEqual([...daily.buckets.keys()], ['2026-03-08']);
  assert.equal(daily.buckets.get('2026-03-08')?.value, 3);
  assert.equal(daily.undated.value, 4);
  assert.equal(daily.unknownSettlementCount, 1);
  assert.deepEqual(localCalendarWeekDateKeys(Date.parse('2026-03-08T07:30:00Z'), 'America/New_York'), [
    '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08',
  ]);
});

test('latency and context metrics retain distinct authorities and point-in-time semantics', () => {
  const latency = summarizeLatency([
    { requestToFirstOutputMs: 10, providerHeaderWaitMs: 5 },
    { requestToFirstOutputMs: 20 },
  ], 'requestToFirstOutputMs');
  assert.equal(latency.p50Ms, 10);
  assert.equal(latency.p95Ms, 20);
  assert.equal(latency.complete, true);
  const context = latestContextUtilization([
    { source: 'initialEstimate', observedAtMs: 1, inputTokens: 20, contextLimitTokens: 100 },
    { source: 'provider', observedAtMs: 2, inputTokens: 40, contextLimitTokens: 200 },
  ]);
  assert.equal(context?.source, 'provider');
  assert.equal(context?.utilization, 0.2);
});

test('fork selection and truncation never reduce root all-work accounting', () => {
  const records = [
    { invocationId: 'a', rootSessionId: 'root', branchId: 'A', usage: {}, reportedCostUsd: 0.01 },
    { invocationId: 'b', rootSessionId: 'root', branchId: 'B', usage: {}, reportedCostUsd: 0.02 },
    { invocationId: 'c', rootSessionId: 'root', branchId: 'C', usage: {}, reportedCostUsd: 0.03 },
  ];
  const branches = [
    { branchId: 'A' },
    { branchId: 'B', parentBranchId: 'A' },
    { branchId: 'C', parentBranchId: 'A' },
  ];
  assert.equal(summarizeAccountingScope(records, { kind: 'branch', branchId: 'B', branches }).value, 0.03);
  assert.equal(summarizeAccountingScope(records, { kind: 'branch', branchId: 'C', branches }).value, 0.04);
  assert.equal(summarizeAccountingScope(records, { kind: 'rootSession', rootSessionId: 'root' }).value, 0.06);

  // Truncation changes the displayed branch back to A; incurred B/C work remains root-owned.
  assert.equal(summarizeAccountingScope(records, { kind: 'branch', branchId: 'A', branches }).value, 0.01);
  assert.equal(summarizeAccountingScope(records, { kind: 'rootSession', rootSessionId: 'root' }).value, 0.06);
});

test('copy references inherited work without adding it to the global total', () => {
  const records = [
    { invocationId: 'a', rootSessionId: 'source', usage: {}, reportedCostUsd: 0.01 },
    { invocationId: 'b', rootSessionId: 'source', usage: {}, reportedCostUsd: 0.02 },
    { invocationId: 'a-copy-ref', rootSessionId: 'source', selectedSessionId: 'copy', inheritedFromInvocationId: 'a', usage: {}, reportedCostUsd: 0.01 },
    { invocationId: 'b-copy-ref', rootSessionId: 'source', selectedSessionId: 'copy', inheritedFromInvocationId: 'b', usage: {}, reportedCostUsd: 0.02 },
    { invocationId: 'd', rootSessionId: 'copy', selectedSessionId: 'copy', usage: {}, reportedCostUsd: 0.04 },
  ];
  assert.equal(summarizeAccountingScope(records, { kind: 'rootSession', rootSessionId: 'source' }).value, 0.03);
  assert.equal(summarizeAccountingScope(records, { kind: 'copyInherited', copySessionId: 'copy' }).value, 0.03);
  assert.equal(summarizeAccountingScope(records, { kind: 'copyOwn', copySessionId: 'copy' }).value, 0.04);
  assert.equal(summarizeAccountingScope(records, { kind: 'global' }).value, 0.07);
});

test('privacy close disposition is deterministic and explicit', () => {
  assert.equal(closeDispositionForPrivacy('on'), 'delete');
  assert.equal(closeDispositionForPrivacy('off'), 'retain');
});

test('analytics detail filtering redacts credential keys and credential-shaped text recursively', () => {
  const safe = sanitizeAnalyticsDetail({
    authorization: 'Bearer secret-value',
    nested: [{ apiKey: 'sk-this-is-a-long-secret-key', OPENAI_API_KEY: 'env-secret', text: 'password=hunter2 OPENAI_API_KEY=env-secret context' }],
    usage: { inputTokens: 12 },
  });
  assert.deepEqual(safe, {
    authorization: '[redacted]',
    nested: [{ apiKey: '[redacted]', OPENAI_API_KEY: '[redacted]', text: 'password=[redacted] OPENAI_API_KEY=[redacted] context' }],
    usage: { inputTokens: 12 },
  });
  assert.equal(JSON.stringify(safe).includes('hunter2'), false);
});

test('analytics detail filtering covers separator variants and credential text in binary views', () => {
  const safe = sanitizeAnalyticsDetail({
    'X-Api-Key': 'header-secret',
    clientSecret: 'camel-secret',
    sessionToken: 'session-secret',
    proxyAuthorization: 'proxy-secret',
    nested: { Refresh_Token: 'refresh-secret', token: 'generic-secret' },
    bytes: Buffer.from('prefix Authorization: Bearer binary-secret suffix', 'utf8'),
    view: new Uint8Array(Buffer.from('x-api-key=another-binary-secret', 'utf8')),
  }) as Record<string, unknown>;
  assert.equal(safe['X-Api-Key'], '[redacted]');
  assert.equal(safe.clientSecret, '[redacted]');
  assert.equal(safe.sessionToken, '[redacted]');
  assert.equal(safe.proxyAuthorization, '[redacted]');
  assert.deepEqual(safe.nested, { Refresh_Token: '[redacted]', token: '[redacted]' });
  assert.equal(Buffer.from(safe.bytes as Uint8Array).toString('utf8').includes('binary-secret'), false);
  assert.equal(Buffer.from(safe.view as Uint8Array).toString('utf8').includes('another-binary-secret'), false);
});
