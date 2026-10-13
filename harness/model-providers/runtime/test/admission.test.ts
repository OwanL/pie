import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableProviderRuntimeModels } from '../services';
import { projectProviderRuntimeModels } from '../model-info';
import type { RuntimeSnapshot, NativeRuntimeModel } from '../contracts';

test('offline Codex admission honors saved epoch, missing credentials and authoritative empty catalogs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pie-admission-'));
  try {
    const credentialFile = join(dir, 'credentials.json');
    const model: NativeRuntimeModel = { provider: 'openai-codex', id: 'codex', name: 'Codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', input: ['text'], reasoning: true, contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    const snapshot: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: [{ providerId: model.provider, id: model.id, enabled: true, visible: true, subagentEligible: true, credential: { source: 'saved', scope: 'captured' }, model }] };
    let credential: unknown = { type: 'oauth', expires: 0 };
    const options = { credentialFile, savedCredential: () => credential, legacyHasAuth: () => true, defaultHasAuth: () => true };
    const catalog = () => projectProviderRuntimeModels(snapshot, availableProviderRuntimeModels(snapshot, options));
    assert.deepEqual(catalog(), []);
    writeFileSync(`${credentialFile}.runtime-scopes.json`, JSON.stringify({ 'openai-codex': 'captured' }));
    assert.equal(catalog().length, 1); // Expired OAuth is configured without a refresh.
    credential = undefined;
    assert.deepEqual(catalog(), []);
    credential = { type: 'oauth' };
    writeFileSync(`${credentialFile}.runtime-scopes.json`, JSON.stringify({ 'openai-codex': 'replacement' }));
    assert.deepEqual(catalog(), []);
    snapshot.models[0].credential = { source: 'legacy' };
    assert.equal(catalog().length, 1);
    assert.deepEqual(availableProviderRuntimeModels(snapshot, { ...options, legacyHasAuth: () => false }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
