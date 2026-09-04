import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletedCostSummary,
  buildCompletedCostSummaryFromSnapshot,
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  buildSessionTokenUsageFromSnapshot,
  extractSubagentCostSummary,
  extractSubagentCostSummaryFromSnapshot,
  extractSubagentDirectCost,
  formatCostUsd,
  type SessionTokenUsageSummary,
} from '../../../src/webview/panel/session-tabs/token-usage';
import {
  buildSessionUsageSnapshot,
  mergeSessionUsageSnapshots,
  type SessionUsageSnapshot,
} from '../../../src/shared/session-usage';
import { estimateTextTokens } from '../../../src/shared/tokenize';

function makeSummary(partial: Partial<SessionTokenUsageSummary> = {}): SessionTokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reportedTurnCount: 0,
    incompleteInvocationCount: 0,
    knownTokenInvocationCount: 0,
    lastTurn: null,
    ...partial,
  };
}

test('formatCostUsd renders zero, sub-cent, and normal amounts', () => {
  assert.equal(formatCostUsd(0), '$0.00');
  assert.equal(formatCostUsd(-1), '$0.00');
  assert.equal(formatCostUsd(0.004), '<$0.01');
  assert.equal(formatCostUsd(0.026), '$0.03');
  assert.equal(formatCostUsd(1.5), '$1.50');
});

test('buildSessionTokenIndicator shows em-dash counts when no usage is reported', () => {
  const indicator = buildSessionTokenIndicator(makeSummary());
  assert.equal(indicator.label, '\u2191 \u2014 \u2193 \u2014');
});

test('buildSessionTokenIndicator shows real counts once usage is reported', () => {
  const summary = makeSummary({
    inputTokens: 1820,
    outputTokens: 540,
    totalTokens: 2360,
    reasoningTokens: 400,
    reportedTurnCount: 1,
    lastTurn: {
      inputTokens: 1820,
      outputTokens: 540,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2360,
      reasoningTokens: 400,
    },
  });
  const indicator = buildSessionTokenIndicator(summary);
  assert.equal(indicator.label, '\u2191 1.8k \u2193 540');
  assert.match(indicator.tooltip, /Reasoning \(included in output\): 400/);
});

test('session token indicator marks incomplete invocation totals instead of known zero', () => {
  const summary = buildSessionTokenUsageFromSnapshot({
    samples: [{
      sourceId: 'gap',
      kind: 'conversation',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      tokenChannelsKnown: false,
      provenance: 'unknown',
      instrumentationGap: true,
    }],
    incompleteInvocationCount: 1,
  });
  const indicator = buildSessionTokenIndicator(summary);
  assert.equal(indicator.label, '↑ — ↓ —*');
  assert.match(indicator.tooltip, /Known subtotal · 1 invocation/);
  assert.match(indicator.ariaLabel, /known subtotal/);
});

test('buildSessionCostIndicator returns null when nothing has been spent', () => {
  const summary = makeSummary();
  assert.equal(buildSessionCostIndicator(summary, undefined, 'Model', buildCompletedCostSummary(summary, [], undefined, undefined), extractSubagentDirectCost([]), undefined), null);
});

test('buildSessionCostIndicator stays quiet until a turn reports usage', () => {
  const summary = makeSummary();
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  assert.equal(buildSessionCostIndicator(summary, pricing, 'Model', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), undefined), null);
});

test('whole-session accounting prevents a partial transcript window from undercounting cost', () => {
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const hiddenOldTurn = {
    id: 'old', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    modelId: 'claude', provider: 'anthropic',
    usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 },
  };
  const loadedTailTurn = {
    id: 'tail', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    modelId: 'claude', provider: 'anthropic',
    usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 },
  };
  const durableSnapshot = buildSessionUsageSnapshot([hiddenOldTurn, loadedTailTurn]);
  const loadedWindowSnapshot = buildSessionUsageSnapshot([loadedTailTurn]);
  const accounting = mergeSessionUsageSnapshots(durableSnapshot, loadedWindowSnapshot);
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const resolvePricing = () => pricing;

  const result = buildSessionCostIndicator(
    summary,
    pricing,
    'Claude',
    buildCompletedCostSummaryFromSnapshot(accounting, pricing, resolvePricing),
    extractSubagentCostSummaryFromSnapshot(accounting, resolvePricing),
    undefined,
    resolvePricing,
    undefined,
    'claude',
    'anthropic',
    accounting,
  );

  assert.ok(result);
  assert.equal(summary.reportedTurnCount, 2);
  assert.equal(result.label, '$18.00');
  assert.match(result.tooltip, /anthropic \/ claude:\s+\$18\.0000/);
});

test('replacing aggregate subagent usage with attempt usage does not double-count', () => {
  const transcript = (withAttempts: boolean) => [{
    id: 'parent', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    toolCalls: [{
      id: 'subagent-call', name: 'subagent', input: {}, status: 'completed' as const,
      result: { details: { results: [{
        model: 'worker-model', provider: 'openai',
        usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.07 },
        ...(withAttempts ? {
          attemptRecords: [{
            attemptId: 'worker-attempt', model: 'openai/worker-model', provider: 'openai',
            usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.07 },
          }],
        } : {}),
      }] } },
    }],
  }];
  const baseline = buildSessionUsageSnapshot(transcript(false) as never);
  const overlay = buildSessionUsageSnapshot(transcript(true) as never);

  assert.equal(baseline.samples.length, 1);
  assert.equal(overlay.samples.length, 1);
  assert.equal(baseline.samples[0]?.groupId, overlay.samples[0]?.groupId);
  baseline.samples.push({
    sourceId: 'subagent:unrelated-call:0',
    groupId: 'subagent:unrelated-call:0',
    kind: 'subagent',
    modelId: 'other-model',
    provider: 'other-provider',
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1,
    reportedCostUsd: 0.03,
  });
  const legacyBaseline = {
    samples: baseline.samples.map(({ groupId: _groupId, ...sample }) => sample),
  };

  const accounting = mergeSessionUsageSnapshots(legacyBaseline, overlay);
  const summary = extractSubagentCostSummaryFromSnapshot(accounting);
  assert.equal(accounting.samples.length, 2);
  assert.equal(summary.totalCost, 0.1);
  assert.equal(summary.modelCosts.get('openai/worker-model')?.cost, 0.07);
  assert.equal(summary.modelCosts.get('other-provider/other-model')?.cost, 0.03);
});

test('total-only usage falls back to reported cost for assistant, subagent, and prepass samples', () => {
  const pricing = { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 };
  const accounting: SessionUsageSnapshot = {
    samples: [
      {
        sourceId: 'assistant:total-only', kind: 'assistant', provider: 'provider-a', modelId: 'assistant-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100,
        reportedCostUsd: 0.42,
      },
      {
        sourceId: 'subagent:total-only', groupId: 'subagent:total-only', kind: 'subagent', provider: 'provider-b', modelId: 'subagent-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 200,
        reportedCostUsd: 0.33,
      },
      {
        sourceId: 'skill-pruning:total-only', kind: 'skill_pruning_prepass', provider: 'provider-c', modelId: 'prepass-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300,
        reportedCostUsd: 0.11,
      },
    ],
  };
  const rawSubagentAccounting = buildSessionUsageSnapshot([{
    id: 'raw-subagent', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    toolCalls: [{
      id: 'raw-subagent-call', name: 'subagent', input: {}, status: 'completed' as const,
      result: { details: { results: [{
        provider: 'provider-b', model: 'subagent-model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: 0.33 },
      }] } },
    }],
  }] as never);
  assert.equal(rawSubagentAccounting.samples[0]?.totalTokens, 200);

  const resolvePricing = () => pricing;
  const rawSubagentSummary = extractSubagentCostSummaryFromSnapshot(rawSubagentAccounting, resolvePricing);
  assert.equal(rawSubagentSummary.totalCost, 0.33);
  assert.equal(rawSubagentSummary.modelCosts.get('provider-b/subagent-model')?.hasKnownCost, true);
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const completed = buildCompletedCostSummaryFromSnapshot(accounting, undefined, resolvePricing);
  const subagents = extractSubagentCostSummaryFromSnapshot(accounting, resolvePricing);

  assert.equal(completed.totalCost, 0.42);
  assert.equal(completed.modelCosts.get('provider-a/assistant-model')?.cost, 0.42);
  assert.equal(subagents.totalCost, 0.33);
  assert.equal(subagents.modelCosts.get('provider-b/subagent-model')?.cost, 0.33);

  const explicitZero = buildCompletedCostSummaryFromSnapshot({
    samples: [{
      sourceId: 'assistant:free', kind: 'assistant', provider: 'provider-a', modelId: 'assistant-model',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100,
      reportedCostUsd: 0,
    }],
  }, undefined, resolvePricing);
  assert.equal(explicitZero.totalCost, 0);
  assert.equal(explicitZero.modelCosts.get('provider-a/assistant-model')?.hasKnownCost, true);
  assert.equal(explicitZero.modelCosts.get('provider-a/assistant-model')?.unpricedTokens, 0);

  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected',
    completed,
    subagents,
    undefined,
    resolvePricing,
    undefined,
    undefined,
    undefined,
    accounting,
  );
  assert.ok(result);
  assert.equal(result.label, '$0.86');
  assert.deepEqual(
    result.breakdown.sources.map((source) => [source.key, source.cost]),
    [['conversation', 0.42], ['subagents', 0.33], ['pruning', 0.11]],
  );
});

test('ledger-unpriced usage is not repriced from the current catalog', () => {
  const summary = buildCompletedCostSummaryFromSnapshot({
    samples: [{
      sourceId: 'historical-unpriced',
      kind: 'conversation',
      modelId: 'model-now-priced',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_500,
      provenance: 'unpriced',
    }],
  }, { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 }, () => ({
    input: 10,
    output: 10,
    cacheRead: 10,
    cacheWrite: 10,
  }));

  assert.equal(summary.totalCost, 0);
  assert.equal(summary.pricedTurnCount, 0);
  assert.equal(summary.modelCosts.get('model-now-priced')?.hasKnownCost, false);
  assert.equal(summary.modelCosts.get('model-now-priced')?.unpricedTokens, 1_500);
});

test('total-only usage without a usable cost stays unavailable instead of known zero', () => {
  const accounting: SessionUsageSnapshot = {
    samples: [
      {
        sourceId: 'assistant:unknown-total', kind: 'assistant', provider: 'provider-a', modelId: 'assistant-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100,
      },
      {
        sourceId: 'subagent:unknown-total', groupId: 'subagent:unknown-total', kind: 'subagent', provider: 'provider-b', modelId: 'subagent-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 200,
      },
      {
        sourceId: 'skill-pruning:unknown-total', kind: 'skill_pruning_prepass', provider: 'provider-c', modelId: 'prepass-model',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 300,
      },
    ],
  };
  const resolvePricing = () => ({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2 });
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const completed = buildCompletedCostSummaryFromSnapshot(accounting, undefined, resolvePricing);
  const subagents = extractSubagentCostSummaryFromSnapshot(accounting, resolvePricing);

  assert.equal(completed.modelCosts.get('provider-a/assistant-model')?.hasKnownCost, false);
  assert.equal(completed.modelCosts.get('provider-a/assistant-model')?.unpricedTokens, 100);
  assert.equal(subagents.modelCosts.get('provider-b/subagent-model')?.hasKnownCost, false);
  assert.equal(subagents.modelCosts.get('provider-b/subagent-model')?.unpricedTokens, 200);

  const rawUnknownAccounting = buildSessionUsageSnapshot([{
    id: 'raw-unknown-subagent', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    toolCalls: [{
      id: 'raw-unknown-subagent-call', name: 'subagent', input: {}, status: 'completed' as const,
      result: { details: { results: [{
        provider: 'provider-b', model: 'subagent-model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 400 },
      }] } },
    }],
  }] as never);
  const rawUnknownSummary = extractSubagentCostSummaryFromSnapshot(rawUnknownAccounting, resolvePricing);
  assert.equal(rawUnknownSummary.modelCosts.get('provider-b/subagent-model')?.hasKnownCost, false);
  assert.equal(rawUnknownSummary.modelCosts.get('provider-b/subagent-model')?.unpricedTokens, 400);

  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected',
    completed,
    subagents,
    undefined,
    resolvePricing,
    undefined,
    undefined,
    undefined,
    accounting,
  );
  assert.ok(result);
  assert.equal(result.label, '—*');
  assert.match(result.tooltip, /provider-a \/ assistant-model: unavailable\* \(100 tokens\)/);
  assert.match(result.tooltip, /provider-b \/ subagent-model: unavailable\* \(200 tokens\)/);
  assert.match(result.tooltip, /provider-c \/ prepass-model: unavailable\* \(300 tokens\)/);
  assert.match(result.tooltip, /Total: unavailable/);
  assert.doesNotMatch(result.tooltip, /Known subtotal: \$0\.0000/);
});

test('whole-session accounting includes every pruning prepass rather than only the latest', () => {
  const pruningMessages = [0.01, 0.02].map((cost, index) => ({
    id: `pruning-${index}`,
    role: 'system' as const,
    createdAt: '',
    markdown: '',
    status: 'completed' as const,
    customType: 'pruning-result',
    customDetails: {
      mode: 'auto' as const,
      skillTokensSaved: 0,
      toolTokensSaved: 0,
      includedSkills: [],
      excludedSkills: [],
      includedTools: [],
      excludedTools: [],
      prepassModel: 'pruner',
      prepassProvider: 'openai',
      prepassInputTokens: 1_000,
      prepassOutputTokens: 100,
      prepassReportedCostUsd: cost,
    },
  }));
  const accounting = buildSessionUsageSnapshot(pruningMessages);
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected',
    buildCompletedCostSummaryFromSnapshot(accounting, undefined, undefined),
    extractSubagentCostSummaryFromSnapshot(accounting),
    pruningMessages[1]!.customDetails,
    undefined,
    undefined,
    undefined,
    undefined,
    accounting,
  );

  assert.ok(result);
  assert.equal(result.label, '$0.03');
  assert.match(result.tooltip, /openai \/ pruner:\s+\$0\.0300/);
});

test('displayed provider/model rows add exactly to the displayed total', () => {
  const accounting = {
    samples: [
      {
        sourceId: 'assistant:a', kind: 'assistant' as const, provider: 'provider-a', modelId: 'model-a',
        inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1,
        reportedCostUsd: 1.00004,
      },
      {
        sourceId: 'assistant:b', kind: 'assistant' as const, provider: 'provider-b', modelId: 'model-b',
        inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1,
        reportedCostUsd: 2.00004,
      },
    ],
  };
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected',
    buildCompletedCostSummaryFromSnapshot(accounting, undefined, undefined),
    extractSubagentCostSummaryFromSnapshot(accounting),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accounting,
  );

  assert.ok(result);
  assert.match(result.tooltip, /provider-a \/ model-a:\s+\$1\.0000/);
  assert.match(result.tooltip, /provider-b \/ model-b:\s+\$2\.0000/);
  assert.match(result.tooltip, /Total: \$3\.0000/);
  assert.deepEqual(
    result.breakdown.providers.map((provider) => ({
      provider: provider.provider,
      cost: provider.cost,
      models: provider.models.map((model) => model.model),
    })),
    [
      { provider: 'provider-b', cost: 2, models: ['model-b'] },
      { provider: 'provider-a', cost: 1, models: ['model-a'] },
    ],
  );
  assert.deepEqual(result.breakdown.sources.map((source) => source.key), ['conversation']);
});

test('buildSessionCostIndicator computes cost across all channels', () => {
  // 1M input @ $3, 1M output @ $15, 1M cacheRead @ $0.3, 1M cacheWrite @ $3.75
  const summary = makeSummary({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    totalTokens: 4_000_000,
    reportedTurnCount: 2,
  });
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const result = buildSessionCostIndicator(summary, pricing, 'Copilot: Claude Sonnet 4.6', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), undefined);
  assert.ok(result);
  // 3 + 15 + 0.3 + 3.75 = 22.05
  assert.equal(result.label, '$22.05');
  assert.match(result.tooltip, /Estimated API-equivalent token cost by provider \/ model/);
  assert.match(result.tooltip, /Unknown provider \/ Selected model:\s+\$22\.0500/);
  assert.doesNotMatch(result.tooltip, /Input:|Output:|Cache read:|Cache write:/);
  assert.match(result.tooltip, /Total: \$22\.0500/);
});

test('buildSessionCostIndicator omits cache lines when no cache usage', () => {
  const summary = makeSummary({
    inputTokens: 500_000,
    outputTokens: 100_000,
    totalTokens: 600_000,
    reportedTurnCount: 1,
  });
  const pricing = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 };
  const result = buildSessionCostIndicator(summary, pricing, 'Copilot: GPT-4.1', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), undefined);
  assert.ok(result);
  // 0.5M*2 = 1.0 + 0.1M*8 = 0.8 → $1.80
  assert.equal(result.label, '$1.80');
  assert.doesNotMatch(result.tooltip, /Cache read/);
});

test('buildSessionCostIndicator renders sub-cent spend compactly', () => {
  const summary = makeSummary({
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    reportedTurnCount: 1,
  });
  const pricing = { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 };
  const result = buildSessionCostIndicator(summary, pricing, 'Copilot: GPT-5 Mini', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), undefined);
  assert.ok(result);
  // 0.001M*0.25 = 0.00025 + 0.0002M*2 = 0.0004 → 0.00065 → "<$0.01"
  assert.equal(result.label, '<$0.01');
});

test('buildSessionCostIndicator shows sub-agent costs from transcript', () => {
  const summary = makeSummary({
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    reportedTurnCount: 1,
  });
  const pricing = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };

  // Transcript with a completed subagent tool call
  const transcript = [
    { id: 'm1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, toolCalls: [
      {
        id: 'tc1',
        name: 'subagent',
        input: { agent: 'worker', task: 'do stuff' },
        result: {
          content: [],
          details: {
            mode: 'single',
            results: [
              { agent: 'worker', usage: { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 6000, turns: 1 } },
            ],
          },
        },
        status: 'completed' as const,
      },
    ] },
  ];

  const result = buildSessionCostIndicator(summary, pricing, 'Test Model', buildCompletedCostSummary(summary, transcript, pricing, undefined), extractSubagentDirectCost(transcript as never), undefined);
  assert.ok(result);
  // Main: 10k/1M * 3 + 2k/1M * 15 = 0.03 + 0.03 = 0.06
  // Sub: $0.05
  // Total: $0.11
  assert.equal(result.label, '$0.11');
  assert.match(result.tooltip, /Unknown provider \/ Unknown subagent model:\s+\$0\.0500/);
  assert.match(result.tooltip, /Unknown provider \/ Selected model:\s+\$0\.0600/);
  assert.match(result.tooltip, /Total: \$0\.1100/);
  assert.deepEqual(
    result.breakdown.sources.map((source) => [source.key, source.cost]),
    [['conversation', 0.06], ['subagents', 0.05]],
  );
});

test('live typed subagent previews contribute their reported costs to the parent session total', () => {
  const transcript = [{
    id: 'live-parent', role: 'assistant' as const, createdAt: '', markdown: '', status: 'streaming' as const,
    toolCalls: [{
      id: 'parallel-review', name: 'subagent', input: {}, status: 'running' as const,
      result: {
        kind: 'subagent', mode: 'parallel', omittedChildren: 0,
        children: [
          {
            id: 'engine-review', phase: 'running', agent: 'reviewer', provider: 'github-copilot', model: 'gpt-5.6-sol',
            usage: { input: 50, output: 10_000, cacheRead: 2_000_000, cacheWrite: 100_000, cost: 2.378, contextTokens: 100_000, turns: 20 },
          },
          {
            id: 'frontend-review', phase: 'running', agent: 'reviewer', provider: 'github-copilot', model: 'gpt-5.6-sol',
            usage: { input: 40, output: 9_000, cacheRead: 1_800_000, cacheWrite: 120_000, cost: 2.954, contextTokens: 120_000, turns: 18 },
          },
          {
            id: 'verification', phase: 'completed', agent: 'worker', provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud',
            usage: { input: 1_500_000, output: 18_000, cacheRead: 0, cacheWrite: 0, cost: 0.229, contextTokens: 70_000, turns: 40 },
          },
        ],
      },
    }],
  }];
  const accounting = buildSessionUsageSnapshot(transcript as never);
  const summary = buildSessionTokenUsageFromSnapshot(accounting);
  const subagents = extractSubagentCostSummaryFromSnapshot(accounting);
  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected model',
    buildCompletedCostSummaryFromSnapshot(accounting, undefined, undefined),
    subagents,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accounting,
  );

  assert.equal(accounting.samples.length, 3);
  assert.ok(Math.abs(subagents.totalCost - 5.561) < 1e-9);
  assert.ok(result);
  assert.equal(result.label, '$5.56');
  assert.match(result.tooltip, /github-copilot \/ gpt-5\.6-sol:\s+\$5\.3320/);
  assert.match(result.tooltip, /ollama \/ deepseek-v4-flash:0731-cloud:\s+\$0\.2290/);
  assert.match(result.tooltip, /Total: \$5\.5610/);
});

test('failed outer subagent calls retain billable child usage', () => {
  const accounting = buildSessionUsageSnapshot([{
    id: 'failed-parent', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    toolCalls: [{
      id: 'failed-subagent', name: 'subagent', input: {}, status: 'failed' as const,
      result: { details: { results: [{
        provider: 'openai-codex', model: 'worker-model',
        usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.42 },
      }] } },
    }],
  }] as never);
  const summary = extractSubagentCostSummaryFromSnapshot(accounting);

  assert.equal(accounting.samples.length, 1);
  assert.equal(summary.totalCost, 0.42);
  assert.equal(summary.modelCosts.get('openai-codex/worker-model')?.cost, 0.42);
});

test('buildSessionCostIndicator rolls direct and nested sub-agent costs into model totals', () => {
  const summary = makeSummary({
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    reportedTurnCount: 1,
  });
  const pricing = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
  const transcript = [
    { id: 'm1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, toolCalls: [
      {
        id: 'tc1',
        name: 'subagent',
        input: { agent: 'worker', task: 'do stuff' },
        status: 'completed' as const,
        result: {
          details: {
            mode: 'single',
            results: [
              {
                agent: 'worker',
                task: 'do stuff',
                exitCode: 0,
                model: 'claude-sonnet',
                usage: { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.05, contextTokens: 6000, turns: 1 },
                messages: [
                  {
                    role: 'assistant',
                    content: [
                      {
                        type: 'toolCall',
                        id: 'nested-tc',
                        name: 'subagent',
                        arguments: {},
                        result: {
                          details: {
                            mode: 'single',
                            results: [
                              {
                                agent: 'scout',
                                task: 'inspect',
                                exitCode: 0,
                                model: 'claude-haiku',
                                usage: { input: 2000, output: 500, cacheRead: 100, cacheWrite: 0, cost: 0.02, contextTokens: 2600, turns: 1 },
                                messages: [],
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ] },
  ];

  const result = buildSessionCostIndicator(
    summary,
    pricing,
    'Test Model',
    buildCompletedCostSummary(summary, transcript, pricing, undefined),
    extractSubagentCostSummary(transcript as never),
    undefined,
  );

  assert.ok(result);
  assert.equal(result.label, '$0.13');
  assert.match(result.tooltip, /Unknown provider \/ claude-sonnet:\s+\$0\.0500/);
  assert.match(result.tooltip, /Unknown provider \/ claude-haiku:\s+\$0\.0200/);
  assert.match(result.tooltip, /Unknown provider \/ Selected model:\s+\$0\.0600/);
  assert.doesNotMatch(result.tooltip, /Direct cost:|Nested cost:/);
});

test('subagent retry costs remain provider-scoped when model ids collide', () => {
  const transcript = [{
    id: 'm1', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const,
    toolCalls: [{
      id: 'tc1', name: 'subagent', input: {}, status: 'completed' as const,
      result: { details: { mode: 'single', results: [{
        model: 'shared-model', provider: 'github-copilot', messages: [],
        usage: { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 },
        attemptRecords: [
          { model: 'shared-model', provider: 'openai-codex', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
          { model: 'shared-model', provider: 'github-copilot', usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.02 } },
        ],
      }] } },
    }],
  }];

  const summary = extractSubagentCostSummary(transcript as never);
  assert.equal(summary.totalCost, 0.03);
  assert.equal(summary.modelCosts.get('openai-codex/shared-model')?.cost, 0.01);
  assert.equal(summary.modelCosts.get('github-copilot/shared-model')?.cost, 0.02);

  const snapshotSummary = extractSubagentCostSummaryFromSnapshot(buildSessionUsageSnapshot(transcript));
  assert.equal(snapshotSummary.totalCost, 0.03);
  assert.equal(snapshotSummary.modelCosts.get('openai-codex/shared-model')?.cost, 0.01);
  assert.equal(snapshotSummary.modelCosts.get('github-copilot/shared-model')?.cost, 0.02);
});

test('whole-session subagent accounting reprices attempts without adding the stale aggregate residual', () => {
  const transcript = [{
    id: 'parent',
    role: 'assistant' as const,
    createdAt: '',
    markdown: '',
    status: 'completed' as const,
    toolCalls: [{
      id: 'subagent-call',
      name: 'subagent',
      input: {},
      status: 'completed' as const,
      result: { details: { mode: 'single', results: [{
        model: 'worker-model',
        provider: 'openai',
        messages: [],
        usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0, cost: 0.07 },
        attemptRecords: [{
          attemptId: 'priced-only-at-result',
          model: 'worker-model',
          provider: 'openai',
          usage: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
        }],
      }] } },
    }],
  }];
  const accounting = buildSessionUsageSnapshot(transcript);
  const summary = extractSubagentCostSummaryFromSnapshot(
    accounting,
    () => ({ input: 100, output: 100, cacheRead: 100, cacheWrite: 100 }),
  );

  assert.equal(accounting.samples.find((sample) => sample.sourceId.includes(':attempt:'))?.reportedCostUsd, 0);
  assert.equal(summary.totalCost, 1.1);
  assert.equal(summary.modelCosts.get('openai/worker-model')?.cost, 1.1);
});

test('buildSessionCostIndicator merges the live estimate into the selected model\'s by-model row', () => {
  // Regression: the in-flight live-turn estimate used to be keyed by the
  // selected model's DISPLAY NAME while completed turns are keyed by the
  // provider/model billing identity, so one model appeared twice while a turn
  // streamed. The selected provider and model must merge into one live total.
  const summary = makeSummary({
    inputTokens: 100_000,
    outputTokens: 10_000,
    totalTokens: 110_000,
    reportedTurnCount: 1,
  });
  const pricing = { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 };
  const transcript = [
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      modelId: 'gpt-5.4-mini',
      provider: 'openai-codex',
      usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110_000 },
    },
  ];
  const liveEstimate = {
    source: 'live-context' as const,
    inputTokens: 50_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 50_000,
    unclassifiedContextTokens: 0,
  };

  const result = buildSessionCostIndicator(
    summary,
    pricing,
    'GPT-5.4 Mini',
    buildCompletedCostSummary(summary, transcript, pricing, (id) => (id === 'gpt-5.4-mini' ? pricing : undefined)),
    extractSubagentDirectCost([]),
    undefined,
    (id) => (id === 'gpt-5.4-mini' ? pricing : undefined),
    liveEstimate,
    'gpt-5.4-mini',
    'openai-codex',
  );

  assert.ok(result);
  // Main: 0.1M*0.25 + 0.01M*2 = 0.025 + 0.02 = 0.045. Live: 0.05M*0.25 = 0.0125. Total: 0.0575.
  assert.equal(result.label, '$0.06');
  assert.match(result.tooltip, /openai-codex \/ gpt-5\.4-mini:\s+\$0\.0575/);
  assert.equal(result.tooltip.match(/gpt-5\.4-mini/g)?.length, 1);
});

test('buildSessionCostIndicator shows tokens when no pricing (Ollama)', () => {
  const summary = makeSummary({
    inputTokens: 100_000,
    outputTokens: 50_000,
    totalTokens: 150_000,
    reportedTurnCount: 1,
  });

  const result = buildSessionCostIndicator(summary, undefined, 'Ollama: llama3.1', buildCompletedCostSummary(summary, [], undefined, undefined), extractSubagentDirectCost([]), undefined);
  assert.ok(result);
  assert.equal(result.label, '—*');
  assert.match(result.tooltip, /Unknown provider \/ Selected model: unavailable\* \(150,000 tokens\)/);
  assert.match(result.tooltip, /Total: unavailable/);
});

test('buildSessionCostIndicator shows prepass cost from pruning details', () => {
  const summary = makeSummary({
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    reportedTurnCount: 1,
  });
  const pricing = { input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 };

  const pruningDetails = {
    mode: 'auto' as const,
    skillTokensSaved: 500,
    toolTokensSaved: 200,
    includedSkills: ['a'],
    excludedSkills: ['b'],
    includedTools: ['x'],
    excludedTools: ['y'],
    prepassModel: 'gemma3:4b',
    prepassInputTokens: 8000,
    prepassOutputTokens: 200,
  };

  const result = buildSessionCostIndicator(summary, pricing, 'Test', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), pruningDetails);
  assert.ok(result);
  assert.match(result.tooltip, /Unknown provider \/ gemma3:4b: unavailable\*/);
  assert.match(result.tooltip, /Known subtotal:/);
});

test('buildSessionCostIndicator attributes a reported prepass cost without token details', () => {
  const summary = makeSummary();
  const result = buildSessionCostIndicator(
    summary,
    undefined,
    'Selected Model',
    buildCompletedCostSummary(summary, [], undefined, undefined),
    extractSubagentDirectCost([]),
    {
      mode: 'auto' as const,
      skillTokensSaved: 0,
      toolTokensSaved: 0,
      includedSkills: [],
      excludedSkills: [],
      includedTools: [],
      excludedTools: [],
      prepassModel: 'priced-prepass',
      prepassProvider: 'openai',
      prepassReportedCostUsd: 0.0123,
    },
  );

  assert.ok(result);
  assert.match(result.tooltip, /openai \/ priced-prepass:\s+\$0\.0123/);
  assert.doesNotMatch(result.tooltip, /No priced usage/);
  assert.match(result.tooltip, /Total: \$0\.0123/);
});

test('buildSessionCostIndicator uses prepass model pricing when available', () => {
  const summary = makeSummary({
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    reportedTurnCount: 1,
  });
  const selectedPricing = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
  const prepassPricing = { input: 1, output: 20, cacheRead: 0, cacheWrite: 0 };

  const result = buildSessionCostIndicator(
    summary,
    selectedPricing,
    'Selected Model',
    buildCompletedCostSummary(summary, [], selectedPricing, undefined),
    extractSubagentDirectCost([]),
    {
      mode: 'auto' as const,
      skillTokensSaved: 0,
      toolTokensSaved: 0,
      includedSkills: [],
      excludedSkills: [],
      includedTools: [],
      excludedTools: [],
      prepassModel: 'prepass-model',
      prepassInputTokens: 500_000,
      prepassOutputTokens: 100_000,
    },
    (modelId) => (modelId === 'prepass-model' ? prepassPricing : undefined),
  );

  assert.ok(result);
  assert.match(result.tooltip, /Unknown provider \/ prepass-model:\s+\$2\.5000/);
  assert.match(result.tooltip, /Unknown provider \/ Selected model:\s+\$10\.0000/);
  assert.match(result.tooltip, /Total: \$12\.5000/);
});

test('buildSessionCostIndicator does not price the prepass at the selected model\'s rate when its pricing is unknown', () => {
  // Regression: `prepassPricing` used to fall back to the SELECTED model's
  // pricing when the prepass model had no pricing entry, silently pricing a
  // local/cheap prepass model at the main model's rate. It must instead report
  // "unavailable" and contribute $0 to the total.
  const summary = makeSummary({
    inputTokens: 100_000,
    outputTokens: 0,
    totalTokens: 100_000,
    reportedTurnCount: 1,
  });
  const selectedPricing = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
  const transcript = [
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      modelId: 'selected-model',
      usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100_000 },
    },
  ];

  const result = buildSessionCostIndicator(
    summary,
    selectedPricing,
    'Selected Model',
    buildCompletedCostSummary(summary, transcript, selectedPricing, (id) => (id === 'selected-model' ? selectedPricing : undefined)),
    extractSubagentDirectCost([]),
    {
      mode: 'auto' as const,
      skillTokensSaved: 0,
      toolTokensSaved: 0,
      includedSkills: [],
      excludedSkills: [],
      includedTools: [],
      excludedTools: [],
      prepassModel: 'gemma3:4b',
      prepassInputTokens: 1_000_000,
      prepassOutputTokens: 0,
    },
    (id) => (id === 'selected-model' ? selectedPricing : undefined),
  );

  assert.ok(result);
  // Main: 0.1M * 10 = 1.0. Prepass: unavailable → $0. Total: $1.00 (NOT $11).
  assert.equal(result.label, '$1.00*');
  assert.match(result.tooltip, /Unknown provider \/ gemma3:4b: unavailable\* \(1,000,000 tokens\)/);
  assert.match(result.tooltip, /Known subtotal: \$1\.0000/);
  assert.doesNotMatch(result.tooltip, /gemma3:4b:[^\n]*\$10/);
});

test('buildSessionCostIndicator uses assistant message model pricing when available', () => {
  const summary = makeSummary({
    inputTokens: 100_000,
    outputTokens: 10_000,
    totalTokens: 110_000,
    reportedTurnCount: 1,
  });
  const selectedPricing = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
  const messagePricing = { input: 1, output: 20, cacheRead: 0, cacheWrite: 0 };
  const transcript = [
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      modelId: 'actual-model',
      usage: {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 110_000,
      },
    },
  ];

  const result = buildSessionCostIndicator(
    summary,
    selectedPricing,
    'Selected Model',
    buildCompletedCostSummary(summary, transcript, selectedPricing, (modelId) => (modelId === 'actual-model' ? messagePricing : undefined)),
    extractSubagentDirectCost(transcript as never),
    undefined,
    (modelId) => (modelId === 'actual-model' ? messagePricing : undefined),
  );

  assert.ok(result);
  assert.match(result.tooltip, /Unknown provider \/ actual-model:\s+\$0\.3000/);
  assert.doesNotMatch(result.tooltip, /Input:|Output:/);
});

test('buildCompletedCostSummary resolves shared model ids by serving provider', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_000_000,
  };
  const transcript = [
    { id: 'codex', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, modelId: 'shared-model', provider: 'openai-codex', usage },
    { id: 'copilot', role: 'assistant' as const, createdAt: '', markdown: '', status: 'completed' as const, modelId: 'shared-model', provider: 'github-copilot', usage },
  ];
  const seen: string[] = [];
  const completed = buildCompletedCostSummary(makeSummary(), transcript, undefined, (modelId, provider) => {
    seen.push(`${provider}/${modelId}`);
    if (provider === 'openai-codex') return { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (provider === 'github-copilot') return { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 };
    return undefined;
  });

  assert.deepEqual(seen, ['openai-codex/shared-model', 'github-copilot/shared-model']);
  assert.equal(completed.totalCost, 7);
  assert.deepEqual(
    Array.from(completed.modelCosts.keys()).sort(),
    ['github-copilot/shared-model', 'openai-codex/shared-model'],
  );
  assert.deepEqual(
    Array.from(completed.modelIds).sort(),
    ['github-copilot/shared-model', 'openai-codex/shared-model'],
  );

  const indicator = buildSessionCostIndicator(
    makeSummary(),
    undefined,
    'Shared model',
    completed,
    extractSubagentDirectCost([]),
    undefined,
  );
  assert.ok(indicator);
  assert.match(indicator.tooltip, /github-copilot \/ shared-model:\s+\$5\.0000/);
  assert.match(indicator.tooltip, /openai-codex \/ shared-model:\s+\$2\.0000/);
  assert.match(indicator.tooltip, /Total: \$7\.0000/);
});

test('provider-less shared ids stay unpriced when the resolver reports ambiguity', () => {
  const transcript = [{
    id: 'legacy',
    role: 'assistant' as const,
    createdAt: '',
    markdown: '',
    status: 'completed' as const,
    modelId: 'shared-model',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000_000,
    },
  }];
  const completed = buildCompletedCostSummary(
    makeSummary(),
    transcript,
    { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
    () => undefined,
  );
  assert.equal(completed.totalCost, 0);
  assert.equal(completed.pricedTurnCount, 0);
});

test('buildSessionCostIndicator shows a live estimate while running without completed usage', () => {
  const transcript = [
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: 'streaming answer text',
      status: 'streaming' as const,
    },
  ];
  const liveEstimate = buildLiveSessionCostEstimate(
    transcript,
    { tokens: 126_500, contextWindow: 1_048_576, percent: 12.1 },
    true,
  );

  const result = buildSessionCostIndicator(
    makeSummary(),
    { input: 0.04, output: 0.08, cacheRead: 0, cacheWrite: 0 },
    'Ollama Cloud: Gemma 3 4B',
    buildCompletedCostSummary(makeSummary(), transcript, { input: 0.04, output: 0.08, cacheRead: 0, cacheWrite: 0 }, undefined),
    extractSubagentDirectCost(transcript as never),
    undefined,
    undefined,
    liveEstimate,
  );

  assert.ok(liveEstimate);
  assert.ok(result);
  assert.equal(result.label, '<$0.01*');
  assert.match(result.tooltip, /Unknown provider \/ Ollama Cloud: Gemma 3 4B: \$0\.0000\*/);
  assert.match(result.tooltip, /Excludes 126,500 tokens pending billing details or pricing/);
  assert.match(result.ariaLabel, /some provider\/model usage is not yet priced/);
});

test('live session cost includes streaming tool-call output', () => {
  const draft = '{"command":"echo generated output"}';
  const transcript = [{
    id: 'tool-draft',
    role: 'assistant' as const,
    createdAt: '',
    markdown: 'I will run this.',
    thinking: 'Choosing a command.',
    status: 'streaming' as const,
    draftingToolCall: { id: 'tool-1', name: 'bash', argumentsText: draft },
  }];

  const estimate = buildLiveSessionCostEstimate(
    transcript,
    { tokens: 1_000, contextWindow: 100_000, percent: 1 },
    true,
  );
  const expectedOutput = estimateTextTokens(transcript[0].markdown)
    + estimateTextTokens(transcript[0].thinking)
    + estimateTextTokens('bash')
    + estimateTextTokens(draft);

  assert.ok(estimate);
  assert.equal(estimate.outputTokens, expectedOutput);
  assert.equal(estimate.totalTokens, 1_000 + expectedOutput);
});

test('buildSessionCostIndicator does not present unpriced live usage as zero cost', () => {
  const transcript = [{
    id: 'unpriced-live',
    role: 'assistant' as const,
    createdAt: '',
    markdown: 'streaming answer text',
    status: 'streaming' as const,
  }];
  const liveEstimate = buildLiveSessionCostEstimate(
    transcript,
    { tokens: 25_000, contextWindow: 100_000, percent: 25 },
    true,
  );
  const result = buildSessionCostIndicator(
    makeSummary(),
    undefined,
    'Unpriced model',
    buildCompletedCostSummary(makeSummary(), transcript, undefined, undefined),
    extractSubagentDirectCost(transcript as never),
    undefined,
    undefined,
    liveEstimate,
  );

  assert.ok(result);
  assert.equal(result.label, '—*');
  assert.match(result.ariaLabel, /cost unavailable.*not yet priced/i);
  assert.match(result.tooltip, /Total: unavailable/);
  assert.doesNotMatch(result.tooltip, /Known (?:estimated )?(?:subtotal|session cost) \$0/);
});

test('buildSessionCostIndicator does not price unclassified live context as uncached input', () => {
  const transcript = [
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'streaming' as const,
    },
  ];
  const liveEstimate = buildLiveSessionCostEstimate(
    transcript,
    { tokens: 1_000_000, contextWindow: 2_000_000, percent: 50 },
    true,
  );
  // Deliberately distinct rates make an accidental channel assignment
  // observable: the canonical context footprint has no cache split, so it is
  // neither $30 of uncached input nor $0.03 of cache reads (nor a cache write).
  const pricing = { input: 30, output: 7, cacheRead: 0.03, cacheWrite: 37.5 };
  const result = buildSessionCostIndicator(
    makeSummary(),
    pricing,
    'Distinct-rate model',
    buildCompletedCostSummary(makeSummary(), transcript, pricing, undefined),
    extractSubagentDirectCost(transcript as never),
    undefined,
    undefined,
    liveEstimate,
  );

  assert.ok(liveEstimate);
  assert.equal(liveEstimate.inputTokens, 0);
  assert.equal(liveEstimate.cacheReadTokens, 0);
  assert.equal(liveEstimate.cacheWriteTokens, 0);
  assert.equal(liveEstimate.unclassifiedContextTokens, 1_000_000);
  assert.ok(result);
  assert.equal(result.label, '$0.00*');
  assert.match(result.tooltip, /Excludes 1,000,000 tokens pending billing details or pricing/);
  assert.match(result.tooltip, /Known subtotal: \$0\.0000/);
  assert.doesNotMatch(result.tooltip, /\$30\.0000|\$0\.0300|\$37\.5000/);
});

test('buildSessionCostIndicator does not crash when a tool call has an undefined name (parts path)', () => {
  // Regression: a streaming snapshot can deliver a tool call part whose name
  // is undefined. extractSubagentDirectCost used to call .trim() on it
  // unconditionally, crashing ComposerView via useComposerIndicators.
  const summary = makeSummary({
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    reportedTurnCount: 1,
  });
  const transcript = [
    {
      id: 'm1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      parts: [
        { kind: 'text' as const, text: 'doing work' },
        { kind: 'toolCall' as const, toolCall: { id: 'tc1', name: undefined, input: {}, status: 'running' as const } },
      ],
    },
  ];
  const result = buildSessionCostIndicator(summary, undefined, 'Model', buildCompletedCostSummary(summary, transcript as never, undefined, undefined), extractSubagentDirectCost(transcript as never), undefined);
  assert.ok(result);
});

test('buildSessionCostIndicator does not crash when message.toolCalls has an undefined name', () => {
  // Regression: same as above, but for the legacy toolCalls array on the message
  // (the path used when message.parts is absent).
  const summary = makeSummary({
    inputTokens: 10_000,
    outputTokens: 2_000,
    totalTokens: 12_000,
    reportedTurnCount: 1,
  });
  const transcript = [
    {
      id: 'm1',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      toolCalls: [
        { id: 'tc1', name: undefined, input: {}, status: 'running' as const },
      ],
    },
  ];
  const result = buildSessionCostIndicator(summary, undefined, 'Model', buildCompletedCostSummary(summary, transcript as never, undefined, undefined), extractSubagentDirectCost(transcript as never), undefined);
  assert.ok(result);
});
