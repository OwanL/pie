import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInitialContextBreakdown } from '../../context-inspector/initial-breakdown';
import { buildContextWindowIndicatorState } from '../../context-inspector/indicator';

test('cold initial inventory is shown as a pre-filter estimate without an approximation prefix', () => {
  const breakdown = buildInitialContextBreakdown({ tokens: 23_400, contextWindow: 200_000 });
  const indicator = buildContextWindowIndicatorState(breakdown.summary);

  assert.deepEqual(breakdown.summary, {
    usedTokens: 23_400,
    usedKind: 'estimated',
    remainingTokens: 176_600,
    remainingKind: 'estimated',
    totalWindow: 200_000,
  });
  assert.equal(indicator.label, '23.4k / 200k tokens');
  assert.ok(!indicator.label.includes('±'));
  assert.match(breakdown.title, /Before pruning: 23,400 estimated/);
  assert.match(breakdown.title, /before Pie skill pruning or prompt\/tool disabling/);
  assert.match(breakdown.title, /not a prediction of the outgoing request/);
  assert.match(breakdown.title, /provider-hidden instructions/);
  assert.doesNotMatch(breakdown.title, /After pruning|Middle 50%/);
});

test('fresh inventory carries after-pruning distribution into the breakdown', () => {
  const estimate = {
    tokens: 23_400,
    contextWindow: 200_000,
    afterPruning: { medianTokens: 12_345, p25Tokens: 10_000, p75Tokens: 15_678 },
  };
  const breakdown = buildInitialContextBreakdown(estimate);

  assert.deepEqual(breakdown.afterPruning, estimate.afterPruning);
  assert.match(breakdown.title, /After pruning:\nMedian: 12,345\nMiddle 50%: 10,000–15,678/);
});

test('cold model switches retain the inventory numerator but use the current selected model window', () => {
  const breakdown = buildInitialContextBreakdown(
    { tokens: 23_400, contextWindow: 200_000 },
    128_000,
  );
  const indicator = buildContextWindowIndicatorState(breakdown.summary);

  assert.deepEqual(breakdown.summary, {
    usedTokens: 23_400,
    usedKind: 'estimated',
    remainingTokens: 104_600,
    remainingKind: 'estimated',
    totalWindow: 128_000,
  });
  assert.equal(indicator.label, '23.4k / 128k tokens');
});
