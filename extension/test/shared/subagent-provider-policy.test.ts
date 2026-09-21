import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBAGENT_TOOL_NAME,
  subagentProvidersAllDisabled,
} from '../../../shared/subagent-provider-policy.js';

const buckets = (small: string[], medium: string[] = [], frontier: string[] = []) => ({
  small: small.map((model) => ({ model, thinkingLevel: 'off' })),
  medium: medium.map((model) => ({ model, thinkingLevel: 'off' })),
  frontier: frontier.map((model) => ({ model, thinkingLevel: 'off' })),
});

const MODELS = [
  { id: 'haiku', provider: 'anthropic' },
  { id: 'gpt-5', provider: 'openai' },
];

test('empty surface keeps subagents enabled (unspecified / default-enabled semantics)', () => {
  // No buckets and no toggle entries — the no-buckets parent-model fallback
  // must never be read as "all providers unchecked".
  assert.equal(subagentProvidersAllDisabled({}), false);
  assert.equal(subagentProvidersAllDisabled({ buckets: buckets([]) }), false);
  assert.equal(subagentProvidersAllDisabled({ buckets: buckets([]), defaults: {} }), false);
});

test('all-unchecked holds when every surface provider resolves to disabled', () => {
  // Qualified bucket specs contribute their provider prefix.
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['anthropic/haiku', 'openai/gpt-5']),
    defaults: { anthropic: false, openai: false },
  }), true);
  // Session overrides can finish the surface.
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['anthropic/haiku']),
    defaults: { anthropic: true },
    sessionToggles: { anthropic: false },
  }), true);
  // A toggle-key-only surface (legacy route kept visible) counts too.
  assert.equal(subagentProvidersAllDisabled({
    sessionToggles: { codex: false },
  }), true);
});

test('any effectively enabled provider keeps subagents enabled', () => {
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['anthropic/haiku', 'openai/gpt-5']),
    defaults: { anthropic: false },
    // openai is unspecified → default enabled.
  }), false);
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['anthropic/haiku']),
    defaults: { anthropic: false },
    sessionToggles: { anthropic: true },
  }), false);
});

test('legacy bare-id bucket entries resolve against the available catalog', () => {
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['haiku']),
    defaults: { anthropic: false },
    availableModels: MODELS,
  }), true);
  // Without the catalog the bare id contributes no provider, but the explicit
  // defaults entry keeps the surface non-empty.
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['haiku']),
    defaults: { anthropic: false },
  }), true);
  // Unresolvable bare id with no other surface → unspecified → enabled.
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['unknown-model']),
    availableModels: MODELS,
  }), false);
});

test('malformed mirrors never disable subagents', () => {
  assert.equal(subagentProvidersAllDisabled({
    buckets: { small: 'not-an-array', medium: [{ model: 42 }] },
    defaults: { anthropic: 'no' as unknown as boolean },
  }), false);
  // Non-boolean defaults entries are ignored: anthropic becomes unspecified
  // (enabled) rather than accidentally disabled.
  assert.equal(subagentProvidersAllDisabled({
    buckets: buckets(['anthropic/haiku']),
    defaults: { anthropic: 'no' as unknown as boolean },
  }), false);
});

test('the shared tool name matches the subagent extension registration', () => {
  assert.equal(SUBAGENT_TOOL_NAME, 'subagent');
});