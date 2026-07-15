import assert from 'node:assert/strict';
import test from 'node:test';

import type { SystemPromptEntry } from '../../../src/shared/protocol';
import {
  estimateSystemPromptTokens,
  formatSystemPromptTokenLabel,
  getSystemPromptTokenEstimateTitle,
} from '../../../src/webview/panel/system-prompt-tokens';

function makePrompt(overrides: Partial<SystemPromptEntry> = {}): SystemPromptEntry {
  return {
    source: 'user',
    title: 'User system prompt',
    text: 'abcd',
    summary: 'abcd',
    availability: 'available',
    ...overrides,
  };
}

test('estimateSystemPromptTokens counts only available prompt text', () => {
  const tokenCount = estimateSystemPromptTokens([
    makePrompt({ text: 'abcd' }),
    makePrompt({ source: 'harness', text: 'abcde' }),
    makePrompt({ disabled: true, text: 'x'.repeat(400) }),
    makePrompt({ source: 'provider', availability: 'unknown', text: 'x'.repeat(400) }),
    makePrompt({ availability: 'hidden', text: 'x'.repeat(400) }),
    makePrompt({ availability: 'missing', text: 'x'.repeat(400) }),
  ]);

  assert.equal(tokenCount, 3);
});

test('formatSystemPromptTokenLabel marks counts as estimates', () => {
  assert.equal(formatSystemPromptTokenLabel(1), '1 token');
  assert.equal(formatSystemPromptTokenLabel(12), '12 tokens');
});

test('getSystemPromptTokenEstimateTitle notes unavailable prompt text', () => {
  const title = getSystemPromptTokenEstimateTitle([
    makePrompt(),
    makePrompt({ source: 'provider', availability: 'unknown', text: 'Unknown' }),
  ]);

  assert.match(title, /not included/i);
});