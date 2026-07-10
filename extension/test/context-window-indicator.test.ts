import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextWindowIndicatorState } from '../src/webview/panel/context-window/indicator';
import type { ContextWindowSummary } from '../src/webview/panel/context-window/breakdown';

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

test('buildContextWindowIndicatorState shows used tokens out of the total window', () => {
  const state = buildContextWindowIndicatorState(makeSummary());

  assert.equal(state.label, '23.4k / 400k tokens');
  assert.equal(state.ariaLabel, 'Context window usage: 23,400 of 400,000 tokens used.');
  assert.equal(state.severity, '');
});

test('buildContextWindowIndicatorState marks estimated usage and severity near the limit', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: 350500,
    usedKind: 'estimated',
    remainingTokens: 49500,
    remainingKind: 'estimated',
  }));

  assert.equal(state.label, '350.5k / 400k tokens');
  assert.equal(state.ariaLabel, 'Estimated context window usage: 350,500 of 400,000 tokens used.');
  assert.equal(state.severity, 'critical');
});

test('buildContextWindowIndicatorState does not prefix zero-token estimates with a tilde', () => {
  const state = buildContextWindowIndicatorState(makeSummary({
    usedTokens: 0,
    usedKind: 'estimated',
    remainingTokens: 400000,
    remainingKind: 'estimated',
  }));

  assert.equal(state.label, '0 / 400k tokens');
  assert.equal(state.ariaLabel, 'Estimated context window usage: 0 of 400,000 tokens used.');
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
