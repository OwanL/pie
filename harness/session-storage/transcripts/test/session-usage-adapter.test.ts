import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../../../agent-processes/lib/rpc/message-contract.js';
import { buildSessionUsageSnapshot, buildSubagentUsageSamples } from '../session-usage-adapter.js';

const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 };
const presence = { input: true, output: false, cacheRead: false, cacheWrite: false };
const receipt = {
  factStatus: 'disabled' as const,
  generationId: 'generation-gap', stableOriginId: 'origin-gap', executionId: 'execution-gap',
  attemptId: 'gap', terminalDetailPayloadId: 'detail-gap', lastSubmittedSequence: 0,
  terminalDetailComplete: false,
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'display', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z',
    markdown: '', status: 'completed', ...overrides,
  };
}

function compact(billing: unknown[]) {
  return buildSubagentUsageSamples({ id: 'tool', status: 'completed', result: { billing } });
}

test('snapshot uses durable billing identity, constituent entries, and ordered tool parts', () => {
  const toolCall = { id: 'child', name: ' Subagent ', status: 'completed' as const,
    result: { billing: [{ path: '0', usage: { ...usage, cost: 0 } }] } };
  const snapshot = buildSessionUsageSnapshot([
    message({ role: 'user' }),
    message({ durableEntryId: 'durable', renderIdentity: 'render-only',
      billingSourceEntryIds: ['first', 'durable'], modelId: 'model', provider: 'provider',
      usage: { inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: 9, reasoningTokens: 2, reportedCostUsd: 0,
        tokenChannelsKnown: false, tokenChannelPresence: presence },
      parts: [{ kind: 'toolCall', toolCall }] }),
  ], 'branch');
  assert.equal(snapshot.branchId, 'branch');
  assert.equal(snapshot.samples.length, 2);
  assert.deepEqual(snapshot.samples[0], {
    sourceId: 'assistant:durable', kind: 'assistant', modelId: 'model', provider: 'provider',
    constituentSourceIds: ['assistant:first', 'assistant:durable'],
    inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 9, providerTotalTokens: 9, reasoningTokens: 2, reportedCostUsd: 0,
    tokenChannelsKnown: false, tokenChannelPresence: presence, instrumentationGap: true,
    instrumentationGapReason: 'The historical provider response omitted one or more token channels.',
  });
  assert.equal(snapshot.samples[1].sourceId, 'subagent:child:0');
  assert.equal(snapshot.samples[1].reportedCostUsd, 0);
  assert.deepEqual(buildSessionUsageSnapshot([message({ toolCalls: [{ ...toolCall, name: 'read' }] })]), { samples: [] });
});

test('pruning invocation records override aggregates and retain exact, estimated, and unknown provenance', () => {
  const samples = buildSessionUsageSnapshot([message({ role: 'system', customType: 'pruning-result',
    customDetails: {
      prepassModel: 'model', prepassProvider: 'provider', prepassInputTokens: 999,
      prepassInvocations: [
        { invocationId: 'exact', input: 4, output: 2, cacheRead: 0, cacheWrite: 0,
          reportedCostUsd: 0, outcome: 'succeeded', startedAt: 'start', endedAt: 'end' },
        { invocationId: 'estimated', input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          reportedCostUsd: -1, outcome: 'cancelled' },
        { invocationId: 'missing', input: 4, output: Number.NaN, cacheRead: -1,
          reportedCostUsd: 0.12, outcome: 'failed' },
      ],
    } })]).samples;
  assert.deepEqual(samples.map((sample) => [sample.sourceId, sample.totalTokens, sample.provenance,
    sample.reportedCostUsd, sample.outcome, sample.instrumentationGap]), [
    ['exact', 6, 'exact', 0, 'succeeded', false],
    ['estimated', 2, 'estimated', undefined, 'cancelled', false],
    ['missing', 0, 'unknown', 0.12, 'failed', true],
  ]);
  assert.deepEqual(samples[2].tokenChannelPresence, presence);
  assert.equal(samples[0].startedAt, 'start');
  assert.equal(samples[0].endedAt, 'end');
});

test('historical pruning keeps partial-channel and cost-only evidence but drops empty unmetered records', () => {
  const pruning = (id: string, customDetails: unknown) => message({ id, role: 'system',
    customType: 'pruning-result', customDetails });
  const samples = buildSessionUsageSnapshot([
    pruning('partial', { prepassModel: 'model', prepassInputTokens: 4 }),
    pruning('declared', { prepassModel: 'model', prepassInputTokens: 4,
      prepassOutputTokens: 0, prepassCacheReadTokens: 0, prepassCacheWriteTokens: 0,
      prepassTokenChannelsKnown: false, prepassTokenChannelPresence: presence }),
    pruning('cost', { prepassModel: 'model', prepassReportedCostUsd: 0 }),
    pruning('complete', { prepassModel: 'model', prepassInputTokens: 3,
      prepassOutputTokens: 0, prepassCacheReadTokens: 0, prepassCacheWriteTokens: 0 }),
    pruning('empty', { prepassModel: 'model' }),
    pruning('no-model', { prepassInputTokens: 4 }),
    pruning('not-details', null),
  ]).samples;
  assert.deepEqual(samples.map((sample) => [sample.sourceId, sample.totalTokens, sample.provenance]), [
    ['skill-pruning:partial', 0, 'unknown'], ['skill-pruning:declared', 0, 'unknown'],
    ['skill-pruning:cost', 0, undefined], ['skill-pruning:complete', 3, undefined],
  ]);
  assert.deepEqual(samples[0].tokenChannelPresence, presence);
  assert.deepEqual(samples[1].tokenChannelPresence, presence);
  assert.equal(samples[2].reportedCostUsd, 0);
  assert.equal(samples[0].instrumentationGap, true);
});

test('compact sideband owns invocation identity and receipt instead of render aggregate or duplicate attempt', () => {
  const tool = { id: 'tool', status: 'failed' as const, result: {
    billing: [{ path: '0', model: 'fallback-model', provider: 'fallback-provider',
      attempts: [{ attemptId: 'gap', usage: { ...usage, cost: 99 }, analyticsCaptureReceipt: receipt }],
      invocations: [
        { invocationId: 'raw', canonicalInvocationId: 'canonical', attemptId: 'gap',
          model: 'child-model', provider: 'child-provider', usage: { ...usage, cost: 0.1 },
          startedAt: 1000, completedAt: 2000, outcome: 'success' },
        { invocationId: 'failed', attemptId: 'gap', outcome: 'failure' },
      ] }],
    results: [{ agent: 'worker', task: 'task', exitCode: 0, messages: [], usage: { ...usage, cost: 999 } }],
  } };
  const samples = buildSubagentUsageSamples(tool);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((sample) => [sample.sourceId, sample.groupId, sample.canonicalInvocationId,
    sample.producerAttemptId, sample.producerEvidenceKind]), [
    ['subagent:tool:0:invocation:raw', 'subagent:tool:0', 'canonical', 'gap', 'providerInvocation'],
    ['subagent:tool:0:invocation:failed', 'subagent:tool:0', 'failed', 'gap', 'providerInvocation'],
  ]);
  assert.deepEqual(samples[0].producerCaptureReceipt, receipt);
  assert.equal(samples[0].modelId, 'child-model');
  assert.equal(samples[0].provider, 'child-provider');
  assert.equal(samples[0].reportedCostUsd, 0.1);
  assert.equal(samples[0].startedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(samples[0].endedAt, '1970-01-01T00:00:02.000Z');
  assert.equal(samples[1].outcome, 'failed');
  assert.equal(samples[1].provenance, 'unknown');
  assert.equal(samples[1].tokenChannelsKnown, false);
  assert.equal(samples[1].reportedCostUsd, undefined);
  assert.deepEqual(buildSubagentUsageSamples(tool), samples, 'terminal replay retains exact source identities');
});

test('partial subagent provider usage retains explicit cost without making absent channels known zero', () => {
  const samples = compact([{ path: '0', invocations: [{ invocationId: 'partial', attemptId: 'a',
    outcome: 'aborted', usage: { input: 4, reportedCostUsd: 0.12 } }] }]);
  assert.equal(samples.length, 1);
  const sample = samples[0];
  assert.equal(sample.sourceId, 'subagent:tool:0:invocation:partial');
  assert.equal(sample.reportedCostUsd, 0.12);
  assert.equal(sample.inputTokens, 4);
  assert.equal(sample.totalTokens, 4);
  assert.equal(sample.tokenChannelsKnown, false);
  assert.deepEqual(sample.tokenChannelPresence, presence);
  assert.equal(sample.instrumentationGap, true);
  assert.equal(sample.provenance, 'unknown');
  assert.equal(sample.outcome, 'cancelled');
});

test('no provider response suppresses synthetic attempt zero billing and terminal absence stays a gap', () => {
  const samples = compact([{ path: '0', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    attempts: [{ attemptId: 'dispatched', outcome: 'failure', providerResponseObserved: false,
      usage: { ...usage, cost: 0 } }] }]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].sourceId, 'subagent:tool:0:attempt:dispatched');
  assert.equal(samples[0].producerEvidenceKind, 'attemptGap');
  assert.equal(samples[0].reportedCostUsd, undefined);
  assert.equal(samples[0].provenance, 'unknown');
  assert.equal(samples[0].instrumentationGap, true);
  assert.equal(samples[0].tokenChannelsKnown, false);
  assert.equal(samples[0].totalTokens, 0);
  const fallback = buildSubagentUsageSamples({ id: 'tool', status: 'failed', result: {
    mode: 'single', results: [{ agent: 'worker', task: 'task', exitCode: 1, messages: [] }],
  } });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].sourceId, 'subagent:tool:0:instrumentation-gap');
  assert.equal(fallback[0].outcome, 'failed');
  assert.equal(fallback[0].provenance, 'unknown');
  assert.equal(fallback[0].tokenChannelsKnown, false);
  assert.deepEqual(buildSubagentUsageSamples({ id: 'tool', status: 'completed', result: {} }), []);
});

test('each omitted invocation has a stable unknown gap and the non-disabled producer receipt wins', () => {
  const submitted = { ...receipt, factStatus: 'submitted', attemptId: 'submitted',
    lastSubmittedSequence: 3, lastAcknowledgedSequence: 3, terminalDetailComplete: true };
  const samples = compact([{ path: 'nested.0', selectedModel: 'selected', provider: 'provider',
    occurredAt: 2000, omittedInvocationCount: 2,
    attempts: [{ attemptId: 'gap', outcome: 'aborted', providerResponseObserved: false,
      analyticsCaptureReceipt: receipt },
    { attemptId: 'submitted', providerResponseObserved: false, analyticsCaptureReceipt: submitted }] }]);
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.slice(0, 2).map((sample) => sample.sourceId), [
    'subagent:tool:nested.0:invocation:omitted:0', 'subagent:tool:nested.0:invocation:omitted:1',
  ]);
  for (const sample of samples.slice(0, 2)) {
    assert.equal(sample.groupId, 'subagent:tool:nested.0');
    assert.equal(sample.modelId, 'selected');
    assert.equal(sample.producerEvidenceKind, 'omittedGap');
    assert.deepEqual(sample.producerCaptureReceipt, submitted);
    assert.equal(sample.canonicalInvocationId, undefined);
    assert.equal(sample.provenance, 'unknown');
    assert.equal(sample.tokenChannelsKnown, false);
    assert.equal(sample.instrumentationGap, true);
    assert.equal(sample.reportedCostUsd, undefined);
    assert.equal(sample.outcome, 'unknown');
    assert.equal(sample.endedAt, '1970-01-01T00:00:02.000Z');
  }
  assert.equal(samples[2].outcome, 'cancelled');
});

test('explicit aggregate provider cost owns only its group residual and keeps unreported attempts unpriced', () => {
  const samples = compact([
    { path: '0', usage: { ...usage, providerReportedCostUsd: 0.5 }, occurredAt: 2000,
      attempts: [{ attemptId: 'unreported', usage }, { attemptId: 'priced', usage: { ...usage, cost: 0.2 } }] },
    { path: '1', usage: { ...usage, reportedCostUsd: 0.1 },
      invocations: [{ invocationId: 'priced', attemptId: 'a', usage: { ...usage, reportedCostUsd: 0.1 } }] },
    { path: '2', usage: { ...usage, reportedCostUsd: 0 }, attempts: [{ attemptId: 'a', usage }] },
  ]);
  assert.equal(samples.length, 6);
  assert.equal(samples[0].provenance, 'unpriced');
  assert.equal(samples[0].reportedCostUsd, undefined);
  assert.equal(samples[0].totalTokens, 6);
  assert.equal(samples[1].reportedCostUsd, 0.2);
  assert.equal(samples[2].sourceId, 'subagent:tool:0:residual-cost');
  assert.equal(samples[2].groupId, 'subagent:tool:0');
  assert.equal(samples[2].producerEvidenceKind, 'aggregate');
  assert.equal(samples[2].reportedCostUsd, 0.3);
  assert.equal(samples[2].totalTokens, 0);
  assert.equal(samples[2].tokenChannelsKnown, true);
  assert.equal(samples.filter((sample) => sample.groupId === 'subagent:tool:1').length, 1);
  assert.equal(samples[4].provenance, 'unpriced');
  assert.equal(samples[5].reportedCostUsd, 0, 'explicit provider zero is retained, not fabricated on the attempt');
});

test('legacy numeric aggregate cost is exact only without invocation splits; SDK cost.total is not billing', () => {
  const samples = compact([
    { path: 'legacy', usage: { ...usage, cost: 0.25 } },
    { path: 'split', usage: { ...usage, cost: 99 }, attempts: [{ attemptId: 'a', usage }] },
    { path: 'sdk', usage: { ...usage, cost: { total: 99 } } },
    { path: 'empty', usage: {} },
  ]);
  assert.equal(samples.length, 4);
  assert.equal(samples[0].sourceId, 'subagent:tool:legacy');
  assert.equal(samples[0].reportedCostUsd, 0.25);
  assert.equal(samples[0].tokenChannelsKnown, true);
  assert.equal(samples[1].reportedCostUsd, undefined);
  assert.equal(samples[1].provenance, undefined);
  assert.equal(samples[2].reportedCostUsd, undefined);
  assert.equal(samples[2].totalTokens, 6);
  assert.equal(samples[3].provenance, 'unknown');
  assert.equal(samples[3].tokenChannelsKnown, false);
  assert.equal(samples[3].instrumentationGap, true);
});
