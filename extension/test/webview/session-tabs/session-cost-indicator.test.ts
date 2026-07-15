import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompletedCostSummary,
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  extractSubagentCostSummary,
  extractSubagentDirectCost,
  formatCostUsd,
  type SessionTokenUsageSummary,
} from '../../../src/webview/panel/session-tabs/token-usage';

function makeSummary(partial: Partial<SessionTokenUsageSummary> = {}): SessionTokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    reportedTurnCount: 0,
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

test('buildSessionCostIndicator returns null when nothing has been spent', () => {
  const summary = makeSummary();
  assert.equal(buildSessionCostIndicator(summary, undefined, 'Model', buildCompletedCostSummary(summary, [], undefined, undefined), extractSubagentDirectCost([]), undefined), null);
});

test('buildSessionCostIndicator stays quiet until a turn reports usage', () => {
  const summary = makeSummary();
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  assert.equal(buildSessionCostIndicator(summary, pricing, 'Model', buildCompletedCostSummary(summary, [], pricing, undefined), extractSubagentDirectCost([]), undefined), null);
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
  assert.match(result.tooltip, /Copilot: Claude Sonnet 4\.6/);
  assert.match(result.tooltip, /Completed subtotal:\s+\$22\.0500/);
  assert.match(result.tooltip, /Cache read:\s+\$0\.3000/);
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
  assert.match(result.tooltip, /Sub-agents/);
  assert.match(result.tooltip, /Direct cost:\s+\$0\.0500/);
  assert.match(result.tooltip, /Total: \$0\.1100/);
});

test('buildSessionCostIndicator breaks down direct and nested sub-agent costs by model', () => {
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
  assert.match(result.tooltip, /Direct cost:\s+\$0\.0500/);
  assert.match(result.tooltip, /Nested cost:\s+\$0\.0200/);
  assert.match(result.tooltip, /Cost by model/);
  assert.match(result.tooltip, /claude-sonnet:\s+\$0\.0500/);
  assert.match(result.tooltip, /claude-haiku:\s+\$0\.0200/);
  assert.match(result.tooltip, /Selected model:\s+\$0\.0600/);
});

test('buildSessionCostIndicator merges the live estimate into the selected model\'s by-model row', () => {
  // Regression: the in-flight live-turn estimate used to be keyed by the
  // selected model's DISPLAY NAME while completed turns are keyed by the
  // model's ID, so the "Cost by model" rollup showed two rows for the same
  // model while a turn streamed. Passing `selectedModelId` keys the live
  // estimate by the model id so it merges with the completed turns.
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
  );

  assert.ok(result);
  // Main: 0.1M*0.25 + 0.01M*2 = 0.025 + 0.02 = 0.045. Live: 0.05M*0.25 = 0.0125. Total: 0.0575.
  assert.equal(result.label, '$0.06');
  assert.match(result.tooltip, /gpt-5\.4-mini:\s+\$0\.0575/);
  // Merged sources line — only present when the live estimate keyed onto the
  // same model id as the completed turns (two sources > 1).
  assert.match(result.tooltip, /Main turns \$0\.0450 · Live estimate \$0\.0125/);
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
  assert.equal(result.label, '$0.00');
  assert.match(result.tooltip, /150,000 tokens \(no pricing\)/);
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
  assert.match(result.tooltip, /Pruning prepass/);
  assert.match(result.tooltip, /gemma3:4b/);
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
  assert.match(result.tooltip, /Pruning prepass/);
  assert.match(result.tooltip, /Cost:\s+\$2\.5000/);
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
  assert.equal(result.label, '$1.00');
  assert.match(result.tooltip, /Cost: unavailable \(no pricing\)/);
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
  assert.match(result.tooltip, /Completed subtotal:\s+\$0\.3000/);
  assert.match(result.tooltip, /Model id: actual-model/);
  assert.match(result.tooltip, /Input:\s+\$0\.1000 \(100,000 tokens\)/);
  assert.match(result.tooltip, /Output:\s+\$0\.2000 \(10,000 tokens\)/);
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
  assert.match(result.tooltip, /Live turn partial estimate/);
  assert.match(result.tooltip, /126,500 tokens/);
  assert.match(result.tooltip, /cost pending provider cache split/);
  assert.match(result.ariaLabel, /live context cost is pending the provider cache split/);
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
  assert.match(result.ariaLabel, /cost unavailable.*pricing is unavailable/i);
  assert.match(result.tooltip, /Total: unavailable \(live model pricing unavailable\)/);
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
  assert.match(result.tooltip, /Context footprint: cost pending provider cache split \(1,000,000 tokens\)/);
  assert.match(result.tooltip, /Known subtotal: \$0\.0000 \(live context cost excluded\)/);
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
