import assert from 'node:assert/strict';
import test from 'node:test';

import { colorFor, colorsFor } from '../../../src/webview/panel/components/chart-colors';

test('colorFor is deterministic', () => {
  assert.equal(colorFor('openai'), colorFor('openai'));
});

test('colorsFor resolves hash collisions within one chart', () => {
  const providers = [
    'openai', 'anthropic', 'google', 'ollama', 'deepseek', 'mistral',
    'openrouter', 'moonshot', 'x-ai', 'minimax', 'qwen', 'z-ai',
  ];
  const colors = colorsFor(providers);
  assert.equal(colors.size, providers.length);
  assert.equal(new Set(colors.values()).size, providers.length);
});

test('colorsFor is order-independent and retains the single-key default', () => {
  const forward = colorsFor(['ollama', 'deepseek', 'openai']);
  const reverse = colorsFor(['openai', 'deepseek', 'ollama']);
  assert.deepEqual([...forward], [...reverse]);
  assert.equal(colorsFor(['ollama']).get('ollama'), colorFor('ollama'));
});
