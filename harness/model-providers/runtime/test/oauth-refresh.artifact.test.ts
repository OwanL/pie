import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSdk, type SourceArtifactSdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture';
import { createPiProviderAuth } from '../../management/pi-auth';
import { createProviderRuntimeServices } from '../services';
import type { RuntimeSnapshot } from '../contracts';

const provider = 'openai-codex';
function token(account: string): string {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account },
  })).toString('base64url')}.synthetic-signature`;
}

// These are SDK artifact qualifications, not OAuth login or live-provider tests.
for (const refreshSucceeds of [true, false]) {
  test(`captured managed OAuth ${refreshSucceeds ? 'persists native SDK refresh and rejects revoked scopes' : 'fails closed on native SDK refresh rejection without fallback'}`, async () => {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
    const dir = await mkdtemp(join(tmpdir(), 'pie-oauth-refresh-'));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let unexpectedRequests = 0;
    let fallbackCalls = 0;
    const freshAccess = token('synthetic-refreshed-account');
    globalThis.fetch = (async (input, init) => {
      // Never delegate: even an unexpected SDK endpoint must not reach the network.
      const url = input instanceof Request ? input.url : String(input);
      if (url !== 'https://auth.openai.com/oauth/token' || init?.method !== 'POST') {
        unexpectedRequests++;
        throw new Error('Unexpected synthetic OAuth request');
      }
      requests++;
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'synthetic-expired-refresh');
      return refreshSucceeds
        ? Response.json({ access_token: freshAccess, refresh_token: 'synthetic-rotated-refresh', expires_in: 3600 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }) as typeof fetch;
    try {
      const file = join(dir, 'auth.json');
      const broker = createPiProviderAuth(sdk.AuthStorage, file);
      const expired = { type: 'oauth' as const, access: token('synthetic-old-account'),
        refresh: 'synthetic-expired-refresh', expires: 0, accountId: 'synthetic-old-account' };
      await broker.saveCredential(provider, expired);
      const scope = (await broker.getRuntimeCredentialScope!(provider))!;
      assert.ok(scope);
      const snapshot: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: [{
        providerId: provider, id: 'synthetic', enabled: true, visible: true, subagentEligible: true,
        credential: { source: 'saved', scope }, model: { provider, id: 'synthetic', name: 'Synthetic',
          api: 'openai-codex-responses', baseUrl: 'https://synthetic.invalid/backend-api', input: ['text'], reasoning: false,
          contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      }] };
      const services = createProviderRuntimeServices(sdk, snapshot, {
        getApiKey: async () => { fallbackCalls++; return 'synthetic-forbidden-fallback'; },
        hasAuth: () => { fallbackCalls++; return true; },
      }, { credentialFile: file });
      const model = services.modelRegistry.find(provider, 'synthetic')!;
      assert.equal(requests, 0, 'capturing services must not refresh');
      const before = Date.now();
      const result = await services.modelRegistry.getApiKeyAndHeaders(model);
      assert.equal(result.ok, refreshSucceeds);
      const persisted = sdk.AuthStorage.create(file).get(provider);
      if (refreshSucceeds) {
        assert.ok(result.ok);
        assert.equal(result.apiKey, freshAccess);
        assert.ok(persisted?.type === 'oauth');
        assert.equal(persisted.access, freshAccess);
        assert.equal(persisted.refresh, 'synthetic-rotated-refresh');
        assert.equal(persisted.accountId, 'synthetic-refreshed-account');
        assert.ok(persisted.expires >= before + 3_500_000);
        assert.equal(await broker.getRuntimeCredentialScope!(provider), scope);
        assert.equal(await broker.getRuntimeApiKey!(provider, scope), freshAccess);
        assert.equal((await services.modelRegistry.getApiKeyAndHeaders(model)).ok, true);
        assert.equal(requests, 1, 'persisted refresh must be reused by fresh native storage');
        await broker.saveCredential(provider, { type: 'api_key', key: 'synthetic-replacement' });
        assert.equal((await services.modelRegistry.getApiKeyAndHeaders(model)).ok, false);
        const replacementScope = (await broker.getRuntimeCredentialScope!(provider))!;
        assert.notEqual(replacementScope, scope);
        await assert.rejects(broker.getRuntimeApiKey!(provider, scope), /^Error: Provider credential storage failed$/);
        await broker.removeCredential(provider);
        await assert.rejects(broker.getRuntimeApiKey!(provider, replacementScope), /^Error: Provider credential storage failed$/);
        assert.equal((await services.modelRegistry.getApiKeyAndHeaders(model)).ok, false);
      } else {
        assert.deepEqual(persisted, expired, 'failed refresh preserves the saved credential for retry');
        assert.equal(await broker.getRuntimeCredentialScope!(provider), scope);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, 'Captured provider authentication is unavailable');
      }
      assert.equal(requests, 1);
      assert.equal(unexpectedRequests, 0);
      assert.equal(fallbackCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
