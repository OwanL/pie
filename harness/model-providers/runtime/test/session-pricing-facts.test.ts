import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCapturedInvocationPricing } from '../../pricing/captured-invocation-pricing';
import type { NativeRuntimeModel, RuntimeSnapshot } from '../contracts';
import { OPENAI_CODEX_MODELS } from '../../../pi/packages/ai/src/providers/openai-codex.models';
import { buildProviderRuntimePricingFacts } from '../pricing-facts';
import { readProviderRuntimeProjectionSync } from '../store';
import { readFileSync, readdirSync } from 'node:fs';
import { readSessionPricingFacts } from '../session-pricing-facts';
import { saveProviderRuntimeProjection } from '../store';

const marker = 'pie-provider-runtime-v1';

test('rejected legacy gpt-5.6-sol has runtime-equivalent tier facts without admission or writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pie-session-rejected-pricing-'));
  const artifactDir = join(root, 'runtime');
  const session = join(root, 'session.jsonl');
  const row = { providerId: 'openai-codex', id: 'gpt-5.6-sol', enabled: true, visible: true,
    subagentEligible: true, credential: { source: 'legacy' as const }, rejection: 'unsupported-or-incomplete-runtime-model' as const };
  const snapshot: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`,
    models: [row, { ...row, id: 'unknown-model' }, { ...row, providerId: 'openai', credential: { source: 'saved' } }] };
  try {
    const reference = await saveProviderRuntimeProjection(artifactDir, snapshot);
    const artifact = join(artifactDir, `${reference.sha256}.json`);
    const before = readFileSync(artifact, 'utf8');
    writeFileSync(session, `${JSON.stringify({ type: 'session', version: 3 })}\n${JSON.stringify({ type: 'custom', customType: marker, data: reference })}\n`);
    const capture = readSessionPricingFacts(session, artifactDir);
    if (capture.kind !== 'managed' || !capture.facts) assert.fail('expected recovered pricing');
    const builtins = OPENAI_CODEX_MODELS as unknown as Record<string, NativeRuntimeModel>;
    const runtime = readProviderRuntimeProjectionSync(artifactDir, reference,
      (provider, id) => provider === 'openai-codex' ? builtins[id] : undefined);
    const expected = buildProviderRuntimePricingFacts(runtime);
    assert.ok(runtime.models[0].model);
    assert.ok(capture.facts.map.get(row.id)?.[0].pricing.tiers?.length);
    assert.deepEqual(capture.facts.map.get(row.id), expected.map.get(row.id));
    for (const inputTokens of [100_000, 300_000]) {
      const invocation = { provider: row.providerId, modelId: row.id,
        usage: { inputTokens, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0 } };
      assert.deepEqual(resolveCapturedInvocationPricing({ ...invocation, facts: capture.facts })?.rateSnapshot,
        resolveCapturedInvocationPricing({ ...invocation, facts: expected })?.rateSnapshot);
    }
    assert.equal(capture.facts.map.has('unknown-model'), false);
    assert.equal(capture.facts.map.has(`openai/${row.id}`), false);
    assert.deepEqual(readProviderRuntimeProjectionSync(artifactDir, reference).models, snapshot.models);
    assert.equal(readFileSync(artifact, 'utf8'), before);
    assert.deepEqual(readdirSync(artifactDir), [`${reference.sha256}.json`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const capturedSnapshot: RuntimeSnapshot = {
  version: 1,
  configRevision: `sha256:${'c'.repeat(64)}`,
  models: [
    { providerId: 'main', id: 'shared', enabled: true, visible: true, subagentEligible: true,
      credential: { source: 'saved' }, model: { provider: 'main', id: 'shared', name: 'Main', api: 'openai-completions',
        baseUrl: 'https://main.example/v1', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } },
    { providerId: 'aux', id: 'shared', enabled: true, visible: true, subagentEligible: true,
      credential: { source: 'saved' }, model: { provider: 'aux', id: 'shared', name: 'Aux', api: 'openai-completions',
        baseUrl: 'https://aux.example/v1', input: ['text'], reasoning: false, contextWindow: 1000, maxTokens: 100,
        cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } } },
  ],
};

test('bounded session prefix classifies legacy, captures large first-message pricing, and fails closed on missing/corrupt data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pie-session-pricing-'));
  const artifactDir = join(root, 'runtime');
  const session = join(root, 'session.jsonl');
  try {
    const reference = await saveProviderRuntimeProjection(artifactDir, capturedSnapshot);
    const header = JSON.stringify({ type: 'session', version: 3 });
    const markerEntry = JSON.stringify({ type: 'custom', customType: marker, data: reference });
    const firstMessage = JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(70 * 1024) } });
    writeFileSync(session, `${header}\n${markerEntry}\n${firstMessage}\n`);
    const capture = readSessionPricingFacts(session, artifactDir);
    assert.equal(capture.kind, 'managed');
    if (capture.kind !== 'managed' || !capture.facts) assert.fail('expected captured managed pricing facts');
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    assert.equal(resolveCapturedInvocationPricing({ facts: capture.facts, provider: 'main', modelId: 'shared', usage })?.calculatedCostUsd, 10);
    assert.equal(resolveCapturedInvocationPricing({ facts: capture.facts, provider: 'aux', modelId: 'shared', usage })?.calculatedCostUsd, 26);
    assert.equal(resolveCapturedInvocationPricing({ facts: capture.facts, provider: 'missing', modelId: 'shared', usage }), undefined);

    // Later configuration edits and a process restart cannot change facts already
    // captured by the session's content-addressed reference.
    writeFileSync(join(root, 'provider-config.json'), '{"edited":true}');
    const afterRestart = readSessionPricingFacts(session, artifactDir);
    assert.equal(afterRestart.kind, 'managed');
    if (afterRestart.kind !== 'managed' || !afterRestart.facts) assert.fail('expected persisted managed pricing facts');
    assert.equal(resolveCapturedInvocationPricing({ facts: afterRestart.facts, provider: 'main', modelId: 'shared', usage })?.calculatedCostUsd, 10);
    assert.deepEqual(readSessionPricingFacts(join(root, 'missing-session.jsonl'), artifactDir), { kind: 'managed', facts: undefined });
    const missingReference = { version: 1, sha256: 'a'.repeat(64) };
    writeFileSync(session, `${header}\n${JSON.stringify({ type: 'custom', customType: marker, data: missingReference })}\n${JSON.stringify({ type: 'message' })}\n`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });
    writeFileSync(join(artifactDir, `${reference.sha256}.json`), '{}');
    writeFileSync(session, `${header}\n${markerEntry}\n${JSON.stringify({ type: 'message' })}\n`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });
    writeFileSync(session, `${header}\n${markerEntry}\n{broken\n${firstMessage}`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });

    writeFileSync(session, `${header}\n${JSON.stringify({ type: 'message', message: { role: 'user' } })}\nunread history`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'legacy' });
    const largeLegacyMessage = JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(70 * 1024) } });
    writeFileSync(session, `${header}\n${largeLegacyMessage}\n`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'legacy' });
    writeFileSync(session, `${header}\n${JSON.stringify({ type: 'custom', customType: 'unknown', data: 'x'.repeat(70 * 1024) })}`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });
    writeFileSync(session, `${header}\n${JSON.stringify({ type: 'custom', customType: 'unknown', data: 'x'.repeat(70 * 1024) }).slice(0, 65536)}`);
    assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });
    for (const prefix of [
      '{broken\n',
      JSON.stringify({ type: 'custom', customType: marker, data: { version: 2, sha256: 'a'.repeat(64) } }),
      JSON.stringify({ type: 'custom', customType: marker, data: { version: 1, sha256: 'a'.repeat(64) } }),
      ' '.repeat(65536),
    ]) {
      writeFileSync(session, prefix);
      assert.deepEqual(readSessionPricingFacts(session, artifactDir), { kind: 'managed', facts: undefined });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
