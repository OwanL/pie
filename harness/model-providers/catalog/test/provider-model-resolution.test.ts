import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProviderModelList } from '../provider-model-resolution.js';

const emptyConfig = { version: 1 as const, providers: {} };
// Value comparison deliberately ignores null-prototype record implementation.
const jsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const complete = {
  name: 'Shipped name', input: ['text'] as ('text' | 'image')[], reasoning: true,
  contextWindow: 8192, maxTokens: 1024,
};

test('layers metadata and applies explicit provider endpoints last without inferring preferences', () => {
  const result = resolveProviderModelList({
    config: { version: 1, providers: { p: {
      enabled: false, api: 'anthropic-messages', baseUrl: 'https://user.example',
      modelOverrides: { m: { name: 'User name', reasoning: false, input: ['text'] } },
      modelPreferences: { m: { visible: false } },
    } } },
    shipped: { p: { api: 'openai-completions', baseUrl: 'https://default.example', models: {
      m: { ...complete, api: 'openai-responses', baseUrl: 'https://model.example' },
    } } },
    discovered: { p: { kind: 'account', complete: true, freshness: 'fresh', models: {
      m: { name: 'Discovered name', api: 'google-generative-ai', baseUrl: 'https://discovered.example',
        input: ['text', 'image'], contextWindow: 16384, reasoning: undefined },
    } } },
  });
  const provider = result.providers.p;
  const model = provider.models.m;
  assert.equal(provider.configured, true);
  assert.equal(provider.enabled, false);
  assert.equal(model.providerId, 'p');
  assert.equal(model.id, 'm');
  assert.equal(model.label, 'User name');
  assert.equal(model.metadata.name, 'User name');
  assert.equal(model.metadata.api, 'anthropic-messages');
  assert.equal(model.metadata.baseUrl, 'https://user.example');
  assert.equal(model.metadata.reasoning, false);
  assert.equal(model.metadata.contextWindow, 16384);
  assert.equal(model.metadata.maxTokens, 1024);
  assert.deepEqual(model.metadata.input, ['text']);
  assert.equal(model.preferences.visible, false);
  assert.equal(Object.hasOwn(model.preferences, 'subagentEligible'), false);
  assert.deepEqual(model.missingRequestMetadata, []);
});

test('pricing merges only supplied rates, preserves zero, replaces tiers and unknown clears history', () => {
  const oldTiers = [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }];
  const newTiers = [{ inputTokensAbove: 200, input: 0, output: 4, cacheRead: 0, cacheWrite: 0 }];
  const result = resolveProviderModelList({
    config: { version: 1, providers: { p: { enabled: true, modelOverrides: {
      unknown: { pricing: 'unknown' },
      tiered: { pricing: { input: 0, output: 4, tiers: newTiers } },
      restored: { pricing: { input: 0, output: 1 } },
    } } } },
    shipped: { p: { models: {
      unknown: { pricing: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers: oldTiers } },
      tiered: { pricing: { input: 1, output: 2, cacheRead: 3, tiers: oldTiers } },
      merged: { pricing: { input: 1, output: 2 } },
      restored: { pricing: { input: 4, output: 5, cacheRead: 6, tiers: oldTiers } },
      unpriced: complete,
    }, api: 'openai-completions', baseUrl: 'https://example.test' } },
    discovered: { p: { kind: 'public', complete: true, freshness: 'fresh', models: {
      merged: { pricing: { input: 0 } },
      reset: { pricing: 'unknown' },
      restored: { pricing: 'unknown' },
    } } },
  });
  const models = result.providers.p.models;
  assert.equal(models.unknown.metadata.pricing, 'unknown');
  assert.deepEqual(jsonValue(models.tiered.metadata.pricing), { input: 0, output: 4, cacheRead: 3, tiers: newTiers });
  assert.deepEqual(jsonValue(models.merged.metadata.pricing), { input: 0, output: 2 });
  assert.deepEqual(jsonValue(models.restored.metadata.pricing), { input: 0, output: 1 });
  assert.equal(Object.hasOwn(models.restored.metadata.pricing as object, 'cacheRead'), false);
  assert.equal(Object.hasOwn(models.restored.metadata.pricing as object, 'tiers'), false);
  assert.equal(models.reset.metadata.pricing, 'unknown');
  assert.equal(Object.hasOwn(models.unpriced.metadata, 'pricing'), false);
  assert.deepEqual(models.unpriced.missingRequestMetadata, []);
});

test('keeps manual, override-only and preference-only IDs through discovery disappearance and return', () => {
  const config = { version: 1 as const, providers: { p: {
    enabled: false, manualModels: ['manual'], modelOverrides: { override: { reasoning: false } },
    modelPreferences: { ghost: { visible: false, subagentEligible: true }, returning: { subagentEligible: false } },
  } } };
  const snapshot = (present: boolean) => resolveProviderModelList({ config, discovered: {
    p: { kind: 'account', complete: true, freshness: 'fresh', models: present ? { returning: complete } : {} },
  } });
  const before = snapshot(true);
  const absent = snapshot(false);
  const returned = snapshot(true);
  assert.deepEqual(Object.keys(absent.providers.p.models), ['ghost', 'manual', 'override', 'returning']);
  assert.equal(absent.providers.p.enabled, false);
  assert.equal(absent.providers.p.models.manual.manuallyDeclared, true);
  assert.equal(absent.providers.p.models.ghost.manuallyDeclared, false);
  assert.equal(absent.providers.p.models.ghost.preferences.visible, false);
  assert.equal(absent.providers.p.models.ghost.preferences.subagentEligible, true);
  assert.equal(absent.providers.p.models.manual.accountListing, 'not-listed-at-observation');
  assert.equal(absent.providers.p.models.returning.accountListing, 'not-listed-at-observation');
  assert.equal(returned.providers.p.models.returning.accountListing, 'listed-at-observation');
  assert.equal(returned.providers.p.models.returning.preferences.subagentEligible, false);
  assert.equal(before.providers.p.models.returning.accountListing, 'listed-at-observation');
});

test('availability records snapshot facts only for account observations', () => {
  for (const kind of ['account', 'public'] as const) {
    for (const freshness of ['fresh', 'stale'] as const) {
      for (const completeListing of [true, false]) {
        const result = resolveProviderModelList({ config: emptyConfig,
          shipped: { p: { models: { absent: {} } } },
          discovered: { p: { kind, freshness, complete: completeListing, models: { present: {} } } },
        });
        const models = result.providers.p.models;
        assert.equal(models.present.accountListing, kind === 'account' ? 'listed-at-observation' : 'unknown');
        assert.equal(models.absent.accountListing,
          kind === 'account' && freshness === 'fresh' && completeListing ? 'not-listed-at-observation' : 'unknown');
        assert.equal(models.present.discoveryFreshness, freshness);
        assert.equal(result.providers.p.configured, false);
        assert.equal(result.providers.p.enabled, false);
        assert.deepEqual(Object.keys(models.present.preferences), []);
        for (const field of ['authenticated', 'available', 'dispatchable', 'selected', 'consent', 'routing']) {
          assert.equal(Object.hasOwn(models.present, field), false);
        }
      }
    }
  }
});

test('preserves incomplete manual metadata and reports request gaps, not unknown pricing', () => {
  const result = resolveProviderModelList({ config: { version: 1, providers: { local: {
    enabled: true, manualModels: ['bare', 'partial'],
    modelOverrides: { partial: { input: [], reasoning: false, contextWindow: 0, maxTokens: 1.5, pricing: 'unknown' } },
  } } } });
  const bare = result.providers.local.models.bare;
  assert.equal(bare.label, 'bare');
  assert.equal(Object.hasOwn(bare.metadata, 'name'), false);
  assert.equal(bare.accountListing, 'unknown');
  assert.equal(bare.discoveryFreshness, 'none');
  assert.deepEqual([...bare.missingRequestMetadata].sort(), ['api', 'baseUrl', 'contextWindow', 'input', 'maxTokens', 'reasoning'].sort());
  const partial = result.providers.local.models.partial;
  assert.equal(partial.metadata.contextWindow, 0);
  assert.equal(partial.metadata.maxTokens, 1.5);
  assert.equal(partial.metadata.pricing, 'unknown');
  assert.deepEqual([...partial.missingRequestMetadata].sort(), ['api', 'baseUrl', 'contextWindow', 'input', 'maxTokens'].sort());
});

test('transport URL gaps remain visible without changing source metadata', () => {
  const result = resolveProviderModelList({ config: emptyConfig,
    shipped: { p: { api: 'openai-completions', models: {
      file: { ...complete, baseUrl: 'file:///tmp/not-a-provider' },
      relative: { ...complete, baseUrl: 'relative/endpoint' },
      local: { ...complete, baseUrl: 'http://127.0.0.1:11434/v1' },
    } } },
  });
  assert.deepEqual(result.providers.p.models.file.missingRequestMetadata, ['baseUrl']);
  assert.equal(result.providers.p.models.file.metadata.baseUrl, 'file:///tmp/not-a-provider');
  assert.deepEqual(result.providers.p.models.relative.missingRequestMetadata, ['baseUrl']);
  assert.deepEqual(result.providers.p.models.local.missingRequestMetadata, []);
});

test('provider/model unions retain exact special IDs in sorted null-prototype records', () => {
  const specialProvider: string = 'constructor';
  const result = resolveProviderModelList({ config: {
    version: 1, providers: { ['__proto__']: { enabled: true, manualModels: ['constructor', '__proto__'] } },
  }, shipped: { z: { models: { same: { name: 'Z' } } }, a: { models: { same: { name: 'A' } } } },
  discovered: { [specialProvider]: { kind: 'public', complete: false, freshness: 'stale', models: { ['__proto__']: {} } } },
  });
  assert.equal(Object.getPrototypeOf(result.providers), null);
  assert.deepEqual(Object.keys(result.providers), ['__proto__', 'a', 'constructor', 'z']);
  assert.equal(result.providers.__proto__.id, '__proto__');
  assert.equal(Object.getPrototypeOf(result.providers.__proto__.models), null);
  assert.deepEqual(Object.keys(result.providers.__proto__.models), ['__proto__', 'constructor']);
  assert.equal(result.providers[specialProvider].models.__proto__.providerId, 'constructor');
  assert.equal(result.providers.a.models.same.label, 'A');
  assert.equal(result.providers.z.models.same.label, 'Z');
  assert.notEqual(result.providers.a.models.same, result.providers.z.models.same);
});

test('vendor policy fields are not metadata or user consent', () => {
  const vendorModel = { ...complete, visible: true, subagentEligible: true, automaticConsent: true,
    preferences: { visible: true, subagentEligible: true }, rolePools: ['worker'] };
  const result = resolveProviderModelList({ config: emptyConfig,
    shipped: { p: { models: { m: vendorModel } } },
    discovered: { p: { kind: 'public', complete: true, freshness: 'fresh', models: { m: vendorModel } } },
  });
  const model = result.providers.p.models.m;
  assert.deepEqual(Object.keys(model.preferences), []);
  for (const field of ['visible', 'subagentEligible', 'automaticConsent', 'preferences', 'rolePools']) {
    assert.equal(Object.hasOwn(model.metadata, field), false);
  }
});

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function assertFrozenDeep(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozenDeep(child);
  }
}

test('clones and freezes results without freezing or mutating inputs or older resolutions', () => {
  const input = { config: emptyConfig, shipped: { p: { models: { m: {
    ...complete, input: ['text'] as ('text' | 'image')[],
    pricing: { input: 0, output: 2, tiers: [{ inputTokensAbove: 100, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] },
  } } } } };
  const original = structuredClone(input);
  const first = resolveProviderModelList(input);
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(input.shipped.p.models.m), false);
  assertFrozenDeep(first);
  assert.notEqual(first.providers.p.models.m.metadata.input, input.shipped.p.models.m.input);
  assert.throws(() => { (first.providers.p.models.m.metadata.input as string[]).push('image'); }, TypeError);
  assert.throws(() => { Object.assign(first.providers.p.models.m.preferences, { visible: true }); }, TypeError);
  input.shipped.p.models.m.input.push('image');
  input.shipped.p.models.m.pricing.tiers[0].input = 9;
  const next = resolveProviderModelList(input);
  assert.deepEqual(first.providers.p.models.m.metadata.input, ['text']);
  assert.deepEqual(next.providers.p.models.m.metadata.input, ['text', 'image']);
  assert.deepEqual(jsonValue(first.providers.p.models.m.metadata.pricing), original.shipped.p.models.m.pricing);
  const frozenInput = freezeDeep(structuredClone(input));
  const frozenBefore = structuredClone(frozenInput);
  resolveProviderModelList(frozenInput);
  assert.deepEqual(frozenInput, frozenBefore);
});
