import test from 'node:test';
import assert from 'node:assert/strict';

import { modelSupportsInputKind } from '../../../../src/host/core/model-capability';
import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import type { ModelInfo, ModelInputKind } from '../../../../src/shared/protocol';

// `modelSupportsInputKind` resolves the effective model id (requested → session
// current → global default) and checks whether it lists `inputKind`. Fallbacks:
// no model known at all → text yes / image no; model id resolved but absent from
// the available-models tables → assume text-only.

function model(id: string, inputKinds: ModelInputKind[]): ModelInfo {
  return { id, name: id, provider: 'test', reasoning: false, inputKinds };
}

/** Build an ArchState with a few commonly-overridden slices. */
function state(over: {
  sessions?: ArchState['sessions']['sessions'];
  workspaceCwd?: string | null;
  defaultModel?: string;
  availableModelsBySession?: Record<string, ModelInfo[]>;
}): ArchState {
  const s = createInitialArchState();
  return {
    ...s,
    sessions: {
      ...s.sessions,
      sessions: over.sessions ?? s.sessions.sessions,
      workspaceCwd: over.workspaceCwd ?? s.sessions.workspaceCwd,
    },
    settings: {
      ...s.settings,
      modelSettings: over.defaultModel
        ? { defaultModel: over.defaultModel, defaultThinkingLevel: 'off' }
        : s.settings.modelSettings,
      availableModelsBySession: over.availableModelsBySession ?? s.settings.availableModelsBySession,
    },
  };
}

// ─── no model resolvable ─────────────────────────────────────────────────────

test('with no requested model, no session model, and no default: text is supported, image is not', () => {
  const s = state({}); // modelSettings stays null
  assert.equal(modelSupportsInputKind('/s', undefined, 'text', () => s), true);
  assert.equal(modelSupportsInputKind('/s', undefined, 'image', () => s), false);
});

test('an explicit requestedModelId overrides session and default models', () => {
  const s = state({
    sessions: [{ path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'text-only' }],
    defaultModel: 'text-only',
    availableModelsBySession: {
      '/s': [model('text-only', ['text']), model('vision', ['text', 'image'])],
    },
  });
  // Session + default both point at text-only, but the request asks for vision.
  assert.equal(modelSupportsInputKind('/s', 'vision', 'image', () => s), true);
  assert.equal(modelSupportsInputKind('/s', 'text-only', 'image', () => s), false);
});

// ─── fallback chain for the model id ─────────────────────────────────────────

test('session.modelId is used when no model is explicitly requested', () => {
  const s = state({
    sessions: [{ path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'vision' }],
    // defaultModel is text-only to prove the session model wins over it.
    defaultModel: 'text-only',
    availableModelsBySession: {
      '/s': [model('vision', ['text', 'image']), model('text-only', ['text'])],
    },
  });
  assert.equal(modelSupportsInputKind('/s', undefined, 'image', () => s), true);
});

test('global defaultModel is used when neither requested nor session model is set', () => {
  const s = state({
    sessions: [{ path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0 }],
    defaultModel: 'vision',
    availableModelsBySession: { '/s': [model('vision', ['text', 'image'])] },
  });
  assert.equal(modelSupportsInputKind('/s', undefined, 'image', () => s), true);
});

// ─── model lookup in direct vs fallback tables ───────────────────────────────

test('model found in another session\'s available-models list satisfies the lookup (fallback table)', () => {
  // The requested model is NOT in /s's direct list, but IS in /other's. The code
  // flattens Object.values(...) of availableModelsBySession as a fallback.
  const s = state({
    defaultModel: 'shared',
    availableModelsBySession: {
      '/s': [model('text-only', ['text'])],
      '/other': [model('shared', ['text', 'image'])],
    },
  });
  assert.equal(modelSupportsInputKind('/s', 'shared', 'image', () => s), true);
});

test('model id resolved but absent from every available-models table falls back to text-only', () => {
  const s = state({
    defaultModel: 'ghost',
    availableModelsBySession: { '/s': [model('real', ['text', 'image'])] },
  });
  assert.equal(modelSupportsInputKind('/s', 'ghost', 'text', () => s), true);
  assert.equal(modelSupportsInputKind('/s', 'ghost', 'image', () => s), false);
});

// ─── inputKinds membership ───────────────────────────────────────────────────

test('a model declaring only image still reports text=false (pure .includes check)', () => {
  const s = state({
    availableModelsBySession: { '/s': [model('img-only', ['image'])] },
  });
  assert.equal(modelSupportsInputKind('/s', 'img-only', 'image', () => s), true);
  assert.equal(modelSupportsInputKind('/s', 'img-only', 'text', () => s), false);
});

test('omitting getArchState uses the default that throws', () => {
  assert.throws(
    () => modelSupportsInputKind('/s', 'm', 'text'),
    /getArchState is required to resolve model input-kind support/,
  );
});
