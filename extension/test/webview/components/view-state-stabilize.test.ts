/**
 * Unit tests for the reference-stabilization helpers used by `hydrateViewState`
 * to keep `prefs` / `pruningSettings` / `pruningCatalog` referentially stable
 * across host state posts that don't actually change them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shallowConfigEqual, pickStable } from '../../../src/webview/panel/utils/view-state-stabilize';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS } from '../../../src/shared/protocol';

test('shallowConfigEqual returns true for structurally equal prefs (scalars + toggle records)', () => {
  const a = { ...DEFAULT_CHAT_PREFS, autoExpandReasoning: true, extensionToggles: { x: true, y: false } };
  const b = { ...DEFAULT_CHAT_PREFS, autoExpandReasoning: true, extensionToggles: { x: true, y: false } };
  assert.equal(shallowConfigEqual(a, b), true);
});

test('pickStable reuses full structured-cloned prefs with nested JSON-like config', () => {
  const stable = structuredClone({
    ...DEFAULT_CHAT_PREFS,
    subagentBuckets: {
      small: [{ model: 'test/small-model', thinkingLevel: 'low' }],
      medium: [{ model: 'test/medium-model', thinkingLevel: 'medium' }],
      frontier: [{ model: 'test/frontier-model', thinkingLevel: 'high' }],
    },
    subagentProviderTogglesBySession: {
      '/session/a': { openai: true, anthropic: false },
    },
    providerConcurrency: {
      openai: { maxConcurrentRequests: 3, afterburnSeconds: 10 },
    },
  });
  const equivalentClone = structuredClone(stable);

  assert.equal(pickStable(stable, equivalentClone), stable);
});

test('pickStable adopts a structured-cloned prefs candidate after a nested leaf changes', () => {
  const stable = structuredClone({
    ...DEFAULT_CHAT_PREFS,
    subagentBuckets: {
      small: [{ model: 'test/small-model', thinkingLevel: 'low' }],
      medium: [{ model: 'test/medium-model', thinkingLevel: 'medium' }],
      frontier: [],
    },
    subagentProviderTogglesBySession: {
      '/session/a': { openai: true },
    },
    providerConcurrency: {
      openai: { maxConcurrentRequests: 3 },
    },
  });
  const changedClone = structuredClone(stable);
  changedClone.providerConcurrency.openai!.maxConcurrentRequests = 4;

  assert.equal(pickStable(stable, changedClone), changedClone);
});

test('shallowConfigEqual fails open for fresh unsupported object prototypes', () => {
  class UnsupportedConfig {
    constructor(readonly value: string) {}
  }

  assert.equal(
    shallowConfigEqual(
      { custom: new UnsupportedConfig('same') },
      { custom: new UnsupportedConfig('same') },
    ),
    false,
  );
});

test('shallowConfigEqual returns true for the same reference', () => {
  const a = { ...DEFAULT_CHAT_PREFS };
  assert.equal(shallowConfigEqual(a, a), true);
});

test('shallowConfigEqual detects scalar differences', () => {
  const a = { ...DEFAULT_CHAT_PREFS, autoExpandReasoning: true };
  const b = { ...DEFAULT_CHAT_PREFS, autoExpandReasoning: false };
  assert.equal(shallowConfigEqual(a, b), false);
});

test('shallowConfigEqual detects toggle record value differences', () => {
  const a = { ...DEFAULT_CHAT_PREFS, extensionToggles: { x: true } };
  const b = { ...DEFAULT_CHAT_PREFS, extensionToggles: { x: false } };
  assert.equal(shallowConfigEqual(a, b), false);
});

test('shallowConfigEqual detects toggle record key differences', () => {
  const a = { ...DEFAULT_CHAT_PREFS, extensionToggles: { x: true } };
  const b = { ...DEFAULT_CHAT_PREFS, extensionToggles: { y: true } };
  assert.equal(shallowConfigEqual(a, b), false);
});

test('shallowConfigEqual treats toggle records with the same keys in different order as equal', () => {
  const a = { ...DEFAULT_CHAT_PREFS, extensionToggles: { x: true, y: false } };
  const b = { ...DEFAULT_CHAT_PREFS, extensionToggles: { y: false, x: true } };
  assert.equal(shallowConfigEqual(a, b), true);
});

test('shallowConfigEqual rejects array-vs-object shape mismatch (empty [] vs {})', () => {
  const a = { items: [] as unknown as string[] };
  const b = { items: {} as unknown as Record<string, unknown> };
  assert.equal(shallowConfigEqual(a, b), false);
});

test('shallowConfigEqual compares string arrays (pruning keep-lists)', () => {
  const a = { ...DEFAULT_PRUNING_SETTINGS, skillAlwaysKeep: ['a', 'b'] };
  const b = { ...DEFAULT_PRUNING_SETTINGS, skillAlwaysKeep: ['a', 'b'] };
  const c = { ...DEFAULT_PRUNING_SETTINGS, skillAlwaysKeep: ['a', 'c'] };
  const d = { ...DEFAULT_PRUNING_SETTINGS, skillAlwaysKeep: ['a'] };
  assert.equal(shallowConfigEqual(a, b), true);
  assert.equal(shallowConfigEqual(a, c), false);
  assert.equal(shallowConfigEqual(a, d), false);
});

test('shallowConfigEqual compares pruning catalog skill/tool lists', () => {
  const a = { skills: ['read', 'edit'], tools: ['bash', 'write'] };
  const b = { skills: ['read', 'edit'], tools: ['bash', 'write'] };
  const c = { skills: ['read'], tools: ['bash', 'write'] };
  assert.equal(shallowConfigEqual(a, b), true);
  assert.equal(shallowConfigEqual(a, c), false);
});

test('pickStable reuses the stable reference when content is equal', () => {
  const stable = { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: true };
  const candidate = { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: true };
  assert.equal(pickStable(stable, candidate), stable);
});

test('pickStable adopts the candidate when content changed', () => {
  const stable = { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: true };
  const candidate = { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: false };
  assert.equal(pickStable(stable, candidate), candidate);
});

test('pickStable adopts candidate when stable is null (first call)', () => {
  const candidate = { ...DEFAULT_CHAT_PREFS };
  assert.equal(pickStable(null, candidate), candidate);
});
