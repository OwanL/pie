import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import catalog from '../../../../models.json';
import { OPENAI_CODEX_MODELS } from '../../../pi/packages/ai/src/providers/openai-codex.models';
import type { NativeRuntimeModel, RuntimeModelProjection, RuntimeSnapshot } from '../contracts';
import { repairRejectedLegacyRuntimeRows } from '../recovery';
import { buildProviderRuntimePricingFacts } from '../pricing-facts';
import { resolveCapturedInvocationPricing } from '../../pricing/captured-invocation-pricing';
import { readProviderRuntimeProjection, readProviderRuntimeProjectionSync, saveProviderRuntimeProjection } from '../store';

const rejected = { providerId: 'openai-codex', id: 'gpt-6-astra', enabled: true, visible: true,
  subagentEligible: true, credential: { source: 'legacy' as const }, rejection: 'unsupported-or-incomplete-runtime-model' as const };

test('bundled recovery preserves actual rejected Astra identity, full behavior and tier pricing without writes', async () => {
  const source: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: [rejected,
    { ...rejected, id: 'unrecognized-model' },
    { ...rejected, providerId: 'openai', credential: { source: 'saved' } },
    { ...rejected, providerId: 'github-copilot', enabled: false, visible: false, subagentEligible: false }] };
  const before = JSON.stringify(source);
  const repaired = repairRejectedLegacyRuntimeRows(source);
  assert.equal(JSON.stringify(source), before);
  assert.equal(repaired.models.length, source.models.length);
  assert.equal(repaired.models[1], source.models[1]);
  assert.equal(repaired.models[2], source.models[2]);
  const row = repaired.models[0];
  const bundled = catalog.providers['openai-codex'].models.find(model => model.id === rejected.id)!;
  assert.ok(row.model);
  assert.equal(row.rejection, undefined);
  assert.deepEqual(row.model.compat, bundled.compat);
  assert.deepEqual(row.model.thinkingLevelMap, bundled.thinkingLevelMap);
  assert.deepEqual(row.pricingFacts, bundled.cost);
  assert.equal(row.pricingFacts?.tiers?.[0].output, 75);
  assert.equal(resolveCapturedInvocationPricing({ facts: buildProviderRuntimePricingFacts(repaired),
    provider: 'openai-codex', modelId: 'openai-codex/gpt-6-astra',
    usage: { inputTokens: 300_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 } })?.rateSnapshot.outputTokensUsdPerMillion, 75);
  assert.equal(row.credential, source.models[0].credential);
  assert.equal(row.builtinHeaders, undefined);
  assert.equal(repaired.models[3].enabled, false);
  assert.equal(repaired.models[3].visible, false);
  assert.equal(repaired.models[3].subagentEligible, false);
  assert.equal(repairRejectedLegacyRuntimeRows(repaired), repaired);
  const dir = await mkdtemp(join(tmpdir(), 'pie-runtime-recovery-'));
  try {
    const ref = await saveProviderRuntimeProjection(dir, source);
    const path = join(dir, `${ref.sha256}.json`);
    const bytes = await readFile(path, 'utf8');
    assert.deepEqual(await readProviderRuntimeProjection(dir, ref), repaired);
    assert.deepEqual(readProviderRuntimeProjectionSync(dir, ref), repaired);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await readdir(dir), [`${ref.sha256}.json`]);
    await saveProviderRuntimeProjection(dir, repaired); // schema-valid, explicit test-only write
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const bundledCodex = catalog.providers['openai-codex'] as { baseUrl: string;
  models: Array<{ id: string; name?: string; api?: string; input?: string[]; reasoning?: boolean;
    contextWindow: number; maxTokens: number; thinkingLevelMap?: Record<string, string | null>; cost?: Record<string, unknown> }>;
  modelOverrides: Record<string, Record<string, unknown>> };
const codexBuiltins = OPENAI_CODEX_MODELS as unknown as Record<string, {
  id: string; name: string; api: string; provider: string; baseUrl: string; reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>; input: string[]; cost: Record<string, unknown>;
  contextWindow: number; maxTokens: number;
}>;
const overrideIds = Object.keys(bundledCodex.modelOverrides);
const bundledIds = bundledCodex.models.map(model => model.id);
const rejectedRow = (id: string): RuntimeModelProjection => ({ providerId: 'openai-codex', id, enabled: true, visible: true,
  subagentEligible: true, credential: { source: 'legacy' as const }, rejection: 'unsupported-or-incomplete-runtime-model' as const });

const rejectKnownBuiltin = (provider: string, id: string) => (provider === 'openai-codex' && codexBuiltins[id]
  ? ({ ...codexBuiltins[id] } as unknown as NativeRuntimeModel) : undefined);

test('read-time recovery composes all 11 actual Codex snapshot identities from SDK builtins and bundled overrides', async () => {
  // Every bundled override identity is a real SDK builtin so composition covers
  // all bundled + override rows without inventing an identity.
  for (const id of overrideIds) assert.ok(codexBuiltins[id], `${id} must resolve from the SDK builtin catalog`);
  const identityList = [...bundledIds, ...overrideIds];
  assert.equal(identityList.length, 11);
  assert.equal(new Set(identityList).size, 11);
  const source: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`,
    models: [...identityList.map(rejectedRow),
      // Unknown and non-legacy rows stay unchanged.
      rejectedRow('unrecognized-model'),
      { ...rejectedRow(bundledIds[0]!), providerId: 'openai', credential: { source: 'saved' as const } }] };
  const before = JSON.stringify(source);

  // Without the injected SDK authority, bundled-only recovery fails closed for
  // override rows (exactly like the native registry drops them).
  const bundledOnly = repairRejectedLegacyRuntimeRows(source);
  assert.notEqual(bundledOnly, source);
  const recoveredIds = (snapshot: RuntimeSnapshot) =>
    snapshot.models.map(row => (row as { model?: { id: string } }).model?.id ?? null);
  const recoveredBundledOnly = recoveredIds(bundledOnly).filter((id): id is string => id !== null);
  assert.deepEqual([...recoveredBundledOnly].sort(), [...bundledIds].sort(),
    'bundled-only reads still recover every full shipped identity');
  for (const [index, row] of bundledOnly.models.entries()) {
    if (recoveredIds(bundledOnly)[index] === null) assert.equal(row, source.models[index]);
  }

  const resolved = JSON.parse(JSON.stringify(source)) as RuntimeSnapshot;
  const repaired = repairRejectedLegacyRuntimeRows(resolved, rejectKnownBuiltin);
  assert.equal(JSON.stringify(source), before, 'recovery never mutates its input snapshot');
  for (const id of identityList) {
    const row = repaired.models.find(candidate => candidate.id === id)!;
    assert.ok(row.model && !row.rejection, `${id} must recover`);
    assert.deepEqual(row.credential, { source: 'legacy' }, `${id} keeps its pinned credential policy`);
  }
  assert.equal(repaired.models.find(row => row.id === 'unrecognized-model')?.model, undefined);
  assert.equal(repaired.models.find(row => row.providerId === 'openai')?.model, undefined);

  // Full bundled identities recover their complete shipped definition.
  for (const id of bundledIds) {
    const row = repaired.models.find(candidate => candidate.id === id)!;
    const definition = bundledCodex.models.find(model => model.id === id)!;
    assert.equal(row.model!.name, definition.name);
    assert.deepEqual(row.model!.compat, definition.compat);
    assert.deepEqual(row.model!.thinkingLevelMap, definition.thinkingLevelMap);
    assert.deepEqual(row.pricingFacts, definition.cost);
  }

  // Override-only identities compose the SDK builtin baseline (api, endpoint,
  // reasoning, thinking map, context window, max tokens) with the bundled
  // shipped override (name, input and the whole cost/tier table).
  for (const id of overrideIds) {
    const row = repaired.models.find(candidate => candidate.id === id)!;
    const definition = bundledCodex.modelOverrides[id] as { name?: string; input?: string[]; cost?: Record<string, unknown> };
    const builtin = codexBuiltins[id]!;
    assert.equal(row.model!.name, definition.name ?? builtin.name);
    assert.equal(row.model!.api, builtin.api);
    assert.equal(row.model!.baseUrl, bundledCodex.baseUrl);
    assert.deepEqual(row.model!.input, definition.input ?? builtin.input);
    assert.equal(row.model!.reasoning, builtin.reasoning);
    assert.deepEqual(row.model!.thinkingLevelMap, builtin.thinkingLevelMap);
    assert.equal(row.model!.contextWindow, builtin.contextWindow);
    assert.equal(row.model!.maxTokens, builtin.maxTokens);
    assert.equal(row.model!.compat, undefined);
    assert.deepEqual(row.pricingFacts, definition.cost, `${id} keeps the complete bundled tier table`);
    assert.deepEqual((row.model!.cost as Record<string, unknown>),
      Object.fromEntries(Object.entries(definition.cost ?? {}).filter(([key]) => key !== 'tiers')));
    assert.equal(row.builtinHeaders, undefined);
  }

  // Both store read paths compose through the same injected built-in authority,
  // verbatim and without writing artifacts; the resolver seam stays optional.
  const dir = await mkdtemp(join(tmpdir(), 'pie-runtime-recovery-overrides-'));
  try {
    const ref = await saveProviderRuntimeProjection(dir, resolved);
    const path = join(dir, `${ref.sha256}.json`);
    const bytes = await readFile(path, 'utf8');
    assert.deepEqual(await readProviderRuntimeProjection(dir, ref, rejectKnownBuiltin), repaired);
    assert.deepEqual(readProviderRuntimeProjectionSync(dir, ref, rejectKnownBuiltin), repaired);
    // Without a resolver the read fails closed to the bundled-only recovery.
    assert.equal(await readProviderRuntimeProjection(dir, ref)
      .then(snapshot => recoveredIds(snapshot).filter(id => id !== null).length), bundledIds.length);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.deepEqual(await readdir(dir), [`${ref.sha256}.json`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
