import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { SessionCostTooltip } from '../../../src/webview/panel/composer/session-cost-tooltip';
import type { SessionCostIndicatorState } from '../../../src/webview/panel/session-tabs/token-usage';

test('session cost tooltip renders provider graph, model details, and cost sources', () => {
  const indicator: SessionCostIndicatorState = {
    label: '$0.14*',
    ariaLabel: 'Known estimated session cost $0.14; some usage is not priced.',
    tooltip: 'Plain-text fallback',
    breakdown: {
      totalCost: 0.14,
      hasIncompleteCost: true,
      unpricedTokens: 2_500,
      reportedTurnCount: 3,
      inputTokens: 12_000,
      outputTokens: 2_000,
      providers: [
        {
          provider: 'anthropic',
          cost: 0.1,
          hasKnownCost: true,
          unpricedTokens: 0,
          models: [
            { provider: 'anthropic', model: 'claude', cost: 0.1, hasKnownCost: true, unpricedTokens: 0 },
          ],
        },
        {
          provider: 'openai',
          cost: 0.04,
          hasKnownCost: true,
          unpricedTokens: 2_500,
          models: [
            { provider: 'openai', model: 'gpt', cost: 0.04, hasKnownCost: true, unpricedTokens: 0 },
            { provider: 'openai', model: 'unpriced-model', cost: 0, hasKnownCost: false, unpricedTokens: 2_500 },
          ],
        },
      ],
      sources: [
        { key: 'conversation', label: 'Main conversation', cost: 0.09, hasKnownCost: true, unpricedTokens: 0, tokens: 10_000 },
        { key: 'subagents', label: 'Subagents', cost: 0.04, hasKnownCost: true, unpricedTokens: 2_500, tokens: 5_000 },
        { key: 'pruning', label: 'Skill pruning prepasses', cost: 0.01, hasKnownCost: true, unpricedTokens: 0, tokens: 500 },
      ],
    },
  };

  const html = renderToString(h(SessionCostTooltip, { indicator }));

  assert.match(html, /Estimated session cost/);
  assert.match(html, /Whole branch · Main conversation: 3 assistant turns/);
  assert.match(html, /aria-label="Cost by provider:/);
  assert.match(html, /anthropic: \$0\.1000 \(71%\)/);
  assert.match(html, /claude/);
  assert.match(html, /unpriced-model/);
  assert.match(html, /unavailable\*/);
  assert.match(html, /Cost sources/);
  assert.match(html, /Main conversation/);
  assert.match(html, /Subagents/);
  assert.match(html, /Skill pruning prepasses/);
  assert.match(html, /Excludes 2\.5k tokens pending billing details or pricing/);
});
