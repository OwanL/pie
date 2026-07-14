import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveComposerModelState } from '../../../src/webview/panel/composer/model-state';

test('resolveComposerModelState prefers the active session model over the global default', () => {
  const state = resolveComposerModelState({
    activeModelId: 'gemini-2.5-pro',
    modelSettings: { defaultModel: 'claude-sonnet-4-5', defaultThinkingLevel: 'medium' },
    availableModels: [
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet',
        provider: 'anthropic',
        reasoning: true,
        inputKinds: ['text'],
        contextWindow: 200000,
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: 'google',
        reasoning: true,
        inputKinds: ['text', 'image'],
        contextWindow: 1000000,
      },
    ],
  });

  assert.equal(state.selectedModel, 'gemini-2.5-pro');
  assert.equal(state.selectedLevel, 'medium');
  assert.equal(state.selectedModelInfo?.contextWindow, 1000000);
  assert.equal(state.supportsReasoning, true);
});

test('resolveComposerModelState falls back to the default model when the session has no explicit model', () => {
  const state = resolveComposerModelState({
    modelSettings: { defaultModel: 'claude-sonnet-4-5', defaultThinkingLevel: 'low' },
    availableModels: [
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet',
        provider: 'anthropic',
        reasoning: true,
        inputKinds: ['text'],
        contextWindow: 200000,
      },
    ],
  });

  assert.equal(state.selectedModel, 'claude-sonnet-4-5');
  assert.equal(state.selectedLevel, 'low');
  assert.equal(state.selectedModelInfo?.id, 'claude-sonnet-4-5');
  assert.equal(state.supportsReasoning, true);
});
