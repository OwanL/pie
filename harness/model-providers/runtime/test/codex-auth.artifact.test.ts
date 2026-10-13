import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSdk, type SourceArtifactSdkModule } from '../../../agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../../agent-processes/lib/sdk-integration/test/source-fixture';
import { createPiProviderAuth } from '../../management/pi-auth';
import { createProviderRuntimeServices } from '../services';
import type { RuntimeSnapshot } from '../contracts';
import { WorkerRuntimeHost } from '../../../agent-processes/workers/worker-runtime-host';
import { saveProviderRuntimeProjection } from '../store';

async function exercisePrompt(invalidToken: boolean): Promise<void> {
  const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
  const { AuthStorage } = sdk;
  const dir = await mkdtemp(join(tmpdir(), 'pie-codex-auth-'));
  const originalFetch = globalThis.fetch;
  let dispatched = false;
  globalThis.fetch = (async (_url, init) => {
    dispatched = true;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('chatgpt-account-id'), 'synthetic-account');
    assert.equal(headers.get('authorization'), `Bearer ${access}`);
    throw new Error('synthetic transport stop');
  }) as typeof fetch;
  const access = invalidToken ? 'synthetic-invalid-token' : `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
  })).toString('base64url')}.synthetic-signature`;
  try {
    const file = join(dir, 'auth.json');
    const broker = createPiProviderAuth(AuthStorage, file);
    await broker.saveCredential('openai-codex', { type: 'oauth', access, refresh: 'synthetic-refresh',
      expires: Date.now() + 3_600_000, accountId: 'synthetic-account' });
    const scope = await broker.getRuntimeCredentialScope!('openai-codex');
    assert.ok(scope);
    const snapshot: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: [{
      providerId: 'openai-codex', id: 'synthetic', enabled: true, visible: true, subagentEligible: true,
      credential: { source: 'saved', scope }, model: { provider: 'openai-codex', id: 'synthetic', name: 'Synthetic',
        api: 'openai-codex-responses', baseUrl: 'https://synthetic.invalid/backend-api', input: ['text'], reasoning: false,
        contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    }] };
    const services = createProviderRuntimeServices(sdk, snapshot, undefined, { credentialFile: file });
    const model = services.modelRegistry.find('openai-codex', 'synthetic')!;
    const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
    assert.equal(auth.ok, true);
    if (!auth.ok) throw new Error(auth.error);
    assert.equal(auth.apiKey, access);
    assert.equal(auth.env, undefined);
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { enabled: false, provider: { maxRetries: 0 } } }));
    const reference = await saveProviderRuntimeProjection(dir, snapshot);
    const manager = sdk.SessionManager.create(dir, dir);
    manager.appendModelChange('openai-codex', 'synthetic');
    manager.appendThinkingLevelChange('off');
    const sessionPath = await realpath(manager.getSessionFile()!);
    const sdkRuntime = { kind: 'source-artifact' as const, descriptor: sourceDescriptor };
    const frames: Array<{ kind: string; event?: string; payload?: any }> = [];
    const host = new WorkerRuntimeHost({ sdkRuntime, owner: { coordinatorGeneration: 1, workerId: 'codex', workerGeneration: 1 },
      server: { sendFrame(frame: any) { frames.push(frame); return true; }, sendEventFrame() { return true; }, sendLiveSemanticFrame() { return true; },
        sendRuntimeReportFrame() { return true; }, sendDetailFrame() { return true; }, onDetailDrain() { return () => {}; },
        requestFrame: async (request: any) => {
          if (request.kind === 'provider.acquire') return { lease: { leaseId: 'mock', headerWaitMs: 1000, streamIdleTimeoutMs: 1000 } };
          return {};
        }, failRuntime(error: Error) { throw error; },
      } as any });
    try {
      await host.promote({ sdkPath: sourceDescriptor.sdkPath, sdkRuntime, agentDir: dir, startupCwd: dir, sessionDir: dir,
        sessionPath, creationReason: 'new', writeLease: { coordinatorGeneration: 1, workerId: 'codex', workerGeneration: 1,
          canonicalSessionPath: sessionPath, ownershipRevision: 1, nonce: 'mock' }, openedPayload: {} as any, modelSettings: {},
        providerRuntime: { artifactDir: dir, reference, credentialFile: file } });
      const session = (host as any).context.session as Awaited<ReturnType<typeof sdk.createAgentSession>>['session'];
      session.agent.transport = 'sse';
      await host.command('message.send', { params: { sessionPath, text: 'Hello', localId: 'synthetic-user', inputs: [] } }, 'synthetic-send');
      await session.waitForIdle();
      const result = session.messages.find(message => message.role === 'assistant') as any;
      assert.equal(dispatched, !invalidToken);
      assert.equal(result?.stopReason, 'error');
      assert.equal(result?.errorMessage, invalidToken ? 'Failed to extract accountId from token' : 'synthetic transport stop');
      assert.equal(session.isStreaming, false);
      assert.ok(frames.some(frame => frame.event === 'agent.settled'));
    } finally { await host.dispose(); }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

for (const invalidToken of [false, true]) {
  test(`managed worker Codex prompt ${invalidToken ? 'settles account extraction failure' : 'carries captured OAuth through transport'} without provider calls`,
    () => exercisePrompt(invalidToken));
}
