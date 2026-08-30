import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInitialContextBreakdown } from '../../../src/webview/panel/context-window/initial-breakdown';
import { buildContextWindowIndicatorState } from '../../../src/webview/panel/context-window/indicator';

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
  assert.match(breakdown.title, /Discovered initial prompt, tools, and skills/);
  assert.match(breakdown.title, /before Pie skill pruning or prompt\/tool disabling/);
  assert.match(breakdown.title, /provider-hidden instructions/);
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
