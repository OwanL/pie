import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProviderRuntimeProjection } from '../projection';
import { appendProviderRuntimeReference, readProviderRuntimeReference, saveProviderRuntimeProjection, readProviderRuntimeProjection } from '../store';
import type { NativeRuntimeModel, RuntimeEntryManager } from '../contracts';
const canonicalRevision = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const native: NativeRuntimeModel = { provider: 'known', id: 'same', name: 'Native', api: 'openai-completions', baseUrl: 'https://example.com/v1', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 3 } };
test('native baseline, qualified identity, overlays, masks and independent preferences', () => {
  const config = { version: 1 as const, providers: { known: { enabled: false, baseUrl: 'https://other.example/v1', modelPreferences: { same: { visible: false, subagentEligible: true } } } } };
  const snapshot = captureProviderRuntimeProjection({ config, configRevision: canonicalRevision('projection-one'), legacyModels: [native, { ...native, provider: 'other' }], builtinModels: [native] })!;
  assert.equal(snapshot.models.length, 2);
  const row = snapshot.models[0];
  assert.equal(row.enabled, false); assert.equal(row.visible, false); assert.equal(row.subagentEligible, true);
  assert.equal(row.model?.baseUrl, 'https://other.example/v1'); assert.equal(row.model?.cost.input, 0);
  assert.equal(snapshot.models[1].credential.source, 'legacy');
  config.providers.known.baseUrl = 'https://later.example';
  assert.equal(row.model?.baseUrl, 'https://other.example/v1'); assert.ok(Object.isFrozen(row.model?.cost));
  assert.equal(captureProviderRuntimeProjection({ legacyModels: [native] }), undefined);
  assert.throws(() => captureProviderRuntimeProjection({ config, configRevision: canonicalRevision('projection-one'), legacyModels: [native, native] }));
});
test('managed Ollama complete inventory excludes absent models only in new captures', () => {
  const installed = { ...native, provider: 'ollama', id: 'qwen3.5:9b' };
  const absent = { ...native, provider: 'ollama', id: 'llama3:latest' };
  const other = { ...native, provider: 'other', id: absent.id };
  const input = { config: { version: 1 as const, providers: { ollama: { enabled: true }, other: { enabled: true } } },
    configRevision: canonicalRevision('ollama-inventory'), legacyModels: [installed, absent, other],
    builtinModels: [installed, absent, other] };
  const pinned = captureProviderRuntimeProjection(input)!;
  assert.equal(pinned.models.length, 3); // No listing: offline known fallback.
  for (const freshness of ['fresh', 'stale'] as const) {
    const snapshot = captureProviderRuntimeProjection({ ...input, discovered: {
      ollama: { kind: 'account', complete: true, freshness, models: { [installed.id]: {} } },
      other: { kind: 'account', complete: true, freshness, models: {} },
    } })!;
    assert.deepEqual(snapshot.models.map(row => `${row.providerId}/${row.id}`),
      ['ollama/qwen3.5:9b', 'other/llama3:latest']);
    assert.ok(snapshot.models.every(row => row.model));
  }
  assert.ok(pinned.models.find(row => row.providerId === 'ollama' && row.id === absent.id)?.model);
  const partial = captureProviderRuntimeProjection({ ...input, discovered: {
    ollama: { kind: 'account', complete: false, freshness: 'fresh', models: { [installed.id]: {} } },
  } })!;
  assert.equal(partial.models.length, 3);
  const empty = captureProviderRuntimeProjection({ ...input, discovered: {
    ollama: { kind: 'account', complete: true, freshness: 'stale', models: {} },
  } })!;
  assert.deepEqual(empty.models.map(row => row.providerId), ['other']);
});

test('no invented capabilities or rates; unknown and tiered prices rejected', () => {
  for (const pricing of ['unknown', { input: 1, output: 2 }, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [] }] as const) {
    const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: { custom: { enabled: true, manualModels: ['new'], modelOverrides: { new: { pricing: pricing as never } } } } }, configRevision: canonicalRevision('projection-one'), legacyModels: [] })!;
    assert.equal(snapshot.models[0].model, undefined);
    assert.equal(snapshot.models[0].rejection, 'unsupported-or-incomplete-runtime-model');
  }
  const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: { known: { enabled: true, modelOverrides: { same: { pricing: 'unknown' } } } } }, configRevision: canonicalRevision('projection-one'), legacyModels: [native] })!;
  assert.equal(snapshot.models[0].model, undefined);
});
test('SDK optional undefined tiers are flat prices, but actual tiers remain rejected', () => {
  const baseline = { ...native, cost: { ...native.cost, tiers: undefined } };
  const capture = (cost: typeof baseline.cost) => captureProviderRuntimeProjection({
    config: { version: 1, providers: { known: { enabled: true } } },
    configRevision: canonicalRevision('optional-tiers'),
    legacyModels: [{ ...baseline, cost }], builtinModels: [{ ...baseline, cost }],
  })!;
  assert.deepEqual(capture(baseline.cost).models[0].model?.cost, native.cost);
  assert.equal(capture({ ...baseline.cost, tiers: [] } as never).models[0].model, undefined);
});
test('managed pricing requires compiled proof or declared complete rates', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const capture = (baseline: NativeRuntimeModel, builtinModels: NativeRuntimeModel[] = [], pricing?: unknown, discoveryPricing?: unknown) =>
    captureProviderRuntimeProjection({ config: { version: 1, providers: { known: { enabled: true,
      ...(pricing === undefined ? {} : { modelOverrides: { same: { pricing: pricing as never } } }) } } },
      configRevision: canonicalRevision('pricing-proof'), legacyModels: [baseline], builtinModels,
      ...(discoveryPricing === undefined ? {} : { discovered: { known: { kind: 'account' as const, complete: true, freshness: 'fresh' as const,
        models: { same: { name: 'Listed', contextWindow: 2000, pricing: discoveryPricing as never }, new: { pricing: 'unknown' as const } } } } }) })!;
  const custom = { ...native, cost: zero };
  assert.equal(capture(custom).models[0].model, undefined);
  assert.deepEqual(capture(custom, [], zero).models[0].model?.cost, zero);
  assert.deepEqual(capture(custom, [custom]).models[0].model?.cost, zero);
  assert.equal(capture(custom, [native]).models[0].model, undefined);
  assert.equal(capture(custom, [], { input: 1, output: 2 }).models[0].model, undefined);
  assert.equal(capture(custom, [], undefined, { input: 1, output: 2 }).models.find(row => row.id === 'same')?.model, undefined);
  assert.equal(capture(custom, [], { input: 1, output: 2 }, { cacheRead: 3, cacheWrite: 4 }).models.find(row => row.id === 'same')?.model, undefined);
  assert.deepEqual(capture(custom, [], undefined, native.cost).models.find(row => row.id === 'same')?.model?.cost, native.cost);
  const listed = capture(native, [native], undefined, 'unknown');
  const row = listed.models.find(row => row.id === 'same')!;
  assert.deepEqual(row.model?.cost, native.cost);
  assert.equal(row.model?.name, 'Listed'); assert.equal(row.model?.contextWindow, 2000);
  assert.equal(listed.models.find(row => row.id === 'new')?.model, undefined);
  assert.equal(capture(native, [native], 'unknown', 'unknown').models.find(row => row.id === 'same')?.model, undefined);
  assert.deepEqual(capture(native, [native], { input: 9, output: 8 }, 'unknown').models.find(row => row.id === 'same')?.model?.cost,
    { ...native.cost, input: 9, output: 8 });
  // Complete declared pricing is authoritative, including full financial facts.
  const emptyTiers = capture(native, [native], { ...native.cost, tiers: [] }).models[0];
  assert.deepEqual(emptyTiers.model?.cost, native.cost);
  assert.deepEqual(emptyTiers.pricingFacts, native.cost);
  const tiers = [{ inputTokensAbove: 1000, input: 4, output: 5, cacheRead: 1, cacheWrite: 2 }];
  const tiered = capture(native, [native], { ...native.cost, tiers }).models[0];
  assert.deepEqual(tiered.model?.cost, native.cost);
  assert.deepEqual(tiered.pricingFacts, { ...native.cost, tiers });
  for (const pricing of ['unknown', { ...native.cost, tiers: [{ inputTokensAbove: 1000, input: 4 }] },
    { ...native.cost, output: -1 }]) {
    const rejected = capture(native, [native], pricing).models[0];
    assert.equal(rejected.model, undefined);
    assert.equal(rejected.pricingFacts, undefined);
    assert.equal(rejected.rejection, 'unsupported-or-incomplete-runtime-model');
  }
});
test('artifact reads do not create directories and saves reject linked Git checkouts before mkdir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pie-runtime-path-test-'));
  const repo = join(root, 'fake-repo');
  const outside = join(root, 'outside');
  const link = join(outside, 'checkout-link');
  const missingRead = join(outside, 'missing-read');
  const linkedNested = join(link, 'nested');
  try {
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(outside);
    await symlink(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    const snapshot = captureProviderRuntimeProjection({ config: { version: 1, providers: {} },
      configRevision: canonicalRevision('artifact-paths'), legacyModels: [native] })!;

    await assert.rejects(readProviderRuntimeProjection(missingRead, { version: 1, sha256: 'a'.repeat(64) }));
    await assert.rejects(lstat(missingRead), { code: 'ENOENT' });
    await assert.rejects(saveProviderRuntimeProjection(linkedNested, snapshot));
    await assert.rejects(lstat(linkedNested), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable roundtrip, revisions, markers, duplicates and corruption fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pie-runtime-test-'));
  try {
    const config = { version: 1 as const, providers: {} };
    const old = captureProviderRuntimeProjection({ config, configRevision: canonicalRevision('durable-old'), legacyModels: [native] })!;
    const ref = await saveProviderRuntimeProjection(dir, old);
    assert.deepEqual(await readProviderRuntimeProjection(dir, ref), old);
    const next = await saveProviderRuntimeProjection(dir, captureProviderRuntimeProjection({ config, configRevision: canonicalRevision('durable-new'), legacyModels: [native] })!);
    assert.notEqual(next.sha256, ref.sha256);
    assert.deepEqual(await readProviderRuntimeProjection(dir, ref), old);
    const entries: ReturnType<RuntimeEntryManager['getEntries']>[number][] = [];
    const manager: RuntimeEntryManager = { getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
    assert.equal(readProviderRuntimeReference(manager), undefined);
    appendProviderRuntimeReference(manager, ref); appendProviderRuntimeReference(manager, ref);
    assert.equal(entries.length, 1);
    assert.deepEqual(readProviderRuntimeReference({ getEntries: () => [...entries] }), ref);
    assert.throws(() => appendProviderRuntimeReference(manager, next));
    entries.push({ type: 'custom', customType: 'pie-provider-runtime-v1', data: { version: 1, sha256: '../bad' } });
    assert.throws(() => readProviderRuntimeReference(manager));
    await writeFile(join(dir, `${ref.sha256}.json`), '{}');
    await assert.rejects(readProviderRuntimeProjection(dir, ref));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
