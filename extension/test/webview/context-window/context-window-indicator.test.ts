import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextWindowIndicatorState, type ContextWindowIndicatorState } from '../../../src/webview/panel/context-window/indicator';
import type { ContextWindowSummary } from '../../../src/webview/panel/context-window/breakdown';

function makeSummary(overrides: Partial<ContextWindowSummary> = {}): ContextWindowSummary {
  return {
    usedTokens: 23400,
    usedKind: 'exact',
    remainingTokens: 376600,
    remainingKind: 'exact',
    totalWindow: 400000,
    ...overrides,
  };
}

test('buildContextWindowIndicatorState shows used over total tokens without a percentage', () => {
  const state = buildContextWindowIndicatorState(makeSummary());

  assert.equal(state.label, '23.4k / 400k tokens');
  assert.equal(state.ariaLabel, 'Context window usage: 23,400 of 400,000 tokens used; 376,600 remaining.');
  assert.equal(state.severity, '');
  assert.ok(!state.label.includes('%'));
});

test('buildContextWindowIndicatorState shows estimated usage without a prefix', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: 350500,
    usedKind: 'estimated',
    remainingTokens: 49500,
    remainingKind: 'estimated',
  }));

  assert.equal(state.label, '350.5k / 400k tokens');
  assert.equal(state.ariaLabel, 'Estimated context window usage: 350,500 of 400,000 tokens used; 49,500 remaining.');
  assert.equal(state.severity, 'critical');
});

test('buildContextWindowIndicatorState shows zero-token estimates without a prefix (pre-session)', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: 0,
    usedKind: 'estimated',
    remainingTokens: 400000,
    remainingKind: 'estimated',
  }));

  assert.equal(state.label, '0 / 400k tokens');
  assert.equal(state.ariaLabel, 'Estimated context window usage: 0 of 400,000 tokens used; 400,000 remaining.');
  assert.equal(state.severity, '');
});

test('buildContextWindowIndicatorState falls back to an unknown label when usage is unavailable', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: null,
    usedKind: 'unknown',
    remainingTokens: null,
    remainingKind: 'unknown',
  }));

  assert.equal(state.label, '? / 400k tokens');
  assert.equal(state.ariaLabel, 'Context window usage is unknown. Total window: 400,000 tokens.');
  assert.equal(state.severity, '');
});

test('buildContextWindowIndicatorState uses inclusive 70% warning and 85% critical thresholds', () => {
  // Exactly at each threshold escalates (inclusive); just below stays calm.
  const cases: Array<{ used: number; expected: ContextWindowIndicatorState['severity'] }> = [
    { used: 279_999, expected: '' },      // 69.99975%
    { used: 280_000, expected: 'warning' },   // exactly 70%
    { used: 339_999, expected: 'warning' },   // 84.99975%
    { used: 340_000, expected: 'critical' },  // exactly 85%
  ];
  for (const { used, expected } of cases) {
    const state = buildContextWindowIndicatorState(makeSummary({
      usedTokens: used,
      remainingTokens: 400_000 - used,
      usedKind: 'exact',
      remainingKind: 'exact',
    }));
    assert.equal(state.severity, expected, `severity at ${used} tokens`);
    assert.ok(state.label !== null);
    assert.match(state.label, /^[\d.]+k? \/ 400k tokens$/);
  }
});

test('buildContextWindowIndicatorState clamps remaining at zero for a saturated window', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: 410_000,
    remainingTokens: 0,
    remainingKind: 'exact',
  }));

  assert.equal(state.label, '410k / 400k tokens');
  assert.equal(state.severity, 'critical');
});