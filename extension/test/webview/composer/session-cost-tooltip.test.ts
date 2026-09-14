import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { CanonicalActivityTooltip, SessionCostTooltip } from '../../../src/webview/panel/composer/session-cost-tooltip';
import type {
  CanonicalSessionActivitySummary,
  SessionCostIndicatorState,
} from '../../../src/webview/panel/session-tabs/token-usage';

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

function canonicalSummary(
  overrides: Partial<CanonicalSessionActivitySummary> = {},
): CanonicalSessionActivitySummary {
  return {
    scopeNote: 'Root session (all branches) · selected-branch totals not shown',
    omitted: false,
    missing: false,
    activity: {
      totalSpans: 10,
      measuredTotalMs: 186_120,
      observedCount: 8,
      estimatedCount: 1,
      unknownCount: 1,
      measuredKnownCount: 9,
      measuredUnknownCount: 1,
      kinds: [{ kind: 'conversation', spanCount: 8, measuredTotalMs: 186_000 }],
      notes: ['Bounded read: row limit(s) reached'],
    },
    toolFacets: {
      facetCount: 2,
      attemptedChangeCount: 1,
      attemptedAddedLines: 3,
      attemptedRemovedLines: 0,
      withoutLineCounts: 1,
      verifiedCount: 0,
      unverifiedCount: 1,
      otherVerificationCount: 1,
      notes: [],
    },
    ...overrides,
  };
}

function costIndicator(): SessionCostIndicatorState {
  return {
    label: '$0.14*',
    ariaLabel: 'cost',
    tooltip: 'fallback',
    breakdown: {
      totalCost: 0.14,
      hasIncompleteCost: false,
      unpricedTokens: 0,
      reportedTurnCount: 3,
      inputTokens: 12_000,
      outputTokens: 2_000,
      providers: [],
      sources: [],
    },
  };
}

function renderCostTooltip(canonicalActivity: CanonicalSessionActivitySummary | null | undefined): string {
  return renderToString(h(SessionCostTooltip, { indicator: costIndicator(), canonicalActivity }));
}

test('canonical activity renders inside the session cost tooltip with explicit scope and qualifications', () => {
  const html = renderCostTooltip(canonicalSummary());

  assert.match(html, /Canonical activity/);
  assert.match(html, /Root session \(all branches\) · selected-branch totals not shown/);
  assert.match(html, /10 spans · measured work 3\.1m \(additive measured durations, not wall time\)/);
  assert.match(html, /1 span without measured duration/);
  assert.match(html, /observed 8 · estimated 1 · unknown 1/);
  assert.match(html, /conversation: 8 spans · 3\.1m/);
  assert.match(html, /Bounded read: row limit\(s\) reached/);
  assert.match(html, /attempted-change entry/);
  assert.match(html, /\+3\/−0 lines/);
  assert.match(html, /unverified proxy, not an exact diff/);
  assert.match(html, /1 entry has no summed line counts/);
  assert.match(html, /verified 0 · unverified 1 · other\/unknown 1/);
});

test('unknown canonical reads render explicit unknown states, never zeros', () => {
  const html = renderCostTooltip(canonicalSummary({ activity: null, toolFacets: null }));
  assert.match(html, /Activity read unknown \(suppressed, invalidated, or not yet hydrated\)/);
  assert.match(html, /Tool-facet read unknown \(suppressed, invalidated, or not yet hydrated\)/);
  assert.doesNotMatch(html, /0 span/);
});

test('an omitted session address is explicit instead of substituted', () => {
  const html = renderCostTooltip(canonicalSummary({
    missing: true,
    omitted: true,
    activity: null,
    toolFacets: null,
  }));
  assert.match(html, /Unavailable for this session · omitted from the bounded visible-session address set/);
  assert.doesNotMatch(html, /span\(s\)/);
});

test('legacy snapshots (canonicalActivity absent) render no canonical section', () => {
  const html = renderCostTooltip(undefined);
  assert.doesNotMatch(html, /Canonical activity/);
  const htmlNull = renderCostTooltip(null);
  assert.doesNotMatch(htmlNull, /Canonical activity/);
});

test('partial per-channel coverage renders ? for the unknown channel, never a zero', () => {
  const html = renderToString(h(SessionCostTooltip, {
    indicator: costIndicator(),
    canonicalActivity: canonicalSummary({
      toolFacets: {
        facetCount: 1,
        attemptedChangeCount: 1,
        attemptedAddedLines: 3,
        attemptedRemovedLines: null,
        withoutLineCounts: 0,
        verifiedCount: 0,
        unverifiedCount: 1,
        otherVerificationCount: 0,
        notes: [],
      },
    }),
  }));
  assert.match(html, /\+3\/−\? lines/);
  assert.doesNotMatch(html, /−0 lines/);
});

test('exact oversized int64 sums render exactly, never rounded or zero-filled', () => {
  const html = renderToString(h(SessionCostTooltip, {
    indicator: costIndicator(),
    canonicalActivity: canonicalSummary({
      toolFacets: {
        facetCount: 2,
        attemptedChangeCount: 2,
        attemptedAddedLines: '9007199254740999',
        attemptedRemovedLines: 4,
        withoutLineCounts: 0,
        verifiedCount: 1,
        unverifiedCount: 1,
        otherVerificationCount: 0,
        notes: [],
      },
    }),
  }));
  assert.match(html, /\+9,007,199,254,740,999\/−4 lines/);
  assert.doesNotMatch(html, /\+\?/);
});

test('the activity-only fallback tooltip shows canonical activity and never fabricates cost content', () => {
  const html = renderToString(h(CanonicalActivityTooltip, { summary: canonicalSummary() }));
  assert.match(html, /Canonical activity/);
  assert.match(html, /Root session \(all branches\) · selected-branch totals not shown/);
  assert.match(html, /10 spans · measured work/);
  assert.match(html, /attempted-change entry/);
  assert.doesNotMatch(html, /Estimated API-equivalent/);
  assert.doesNotMatch(html, /Main conversation/);
  assert.doesNotMatch(html, /Total:/);
  assert.doesNotMatch(html, /\$/);
  assert.doesNotMatch(html, /unpriced/i);
});
