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

const cases = [
  { provider: 'openai', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
  { provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  { provider: 'github-copilot', api: 'openai-completions', baseUrl: 'https://synthetic-account.invalid' },
  { provider: 'custom-compatible', api: 'openai-completions', baseUrl: 'https://synthetic-compatible.invalid/v1' },
] as const;

function response(anthropic: boolean): Response {
  const events = anthropic ? [
    ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'synthetic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') : [
    { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
}

for (const entry of cases) for (const unauthorized of [false, true]) {
  test(`managed ${entry.provider} native transport ${unauthorized ? 'HTTP 401 settles' : 'Hello settles'} (synthetic auth, no refresh)`, async () => {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode) as SourceArtifactSdkModule;
    const dir = await mkdtemp(join(tmpdir(), 'pie-other-provider-'));
    const originalFetch = globalThis.fetch;
    const anthropic = entry.provider === 'anthropic';
    const copilot = entry.provider === 'github-copilot';
    const key = 'synthetic-access';
    let requests = 0;
    let host: WorkerRuntimeHost | undefined;
    try {
      const file = join(dir, 'auth.json');
      const broker = createPiProviderAuth(sdk.AuthStorage, file);
      // Copilot uses an already-valid native token and an already-captured account endpoint.
      // This does not qualify discovery or OAuth refresh.
      await broker.saveCredential(entry.provider, copilot
        ? { type: 'oauth', access: key, refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 }
        : { type: 'api_key', key });
      const scope = await broker.getRuntimeCredentialScope!(entry.provider);
      assert.ok(scope);
      const snapshot: RuntimeSnapshot = { version: 1, configRevision: `sha256:${'a'.repeat(64)}`, models: [{
        providerId: entry.provider, id: 'synthetic', enabled: true, visible: true, subagentEligible: true,
        credential: { source: 'saved', scope }, model: { provider: entry.provider, id: 'synthetic', name: 'Synthetic',
          api: entry.api, baseUrl: entry.baseUrl, input: ['text'], reasoning: false,
          contextWindow: 10000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      }] };
      const services = createProviderRuntimeServices(sdk, snapshot, undefined, { credentialFile: file });
      const selected = services.modelRegistry.find(entry.provider, 'synthetic')!;
      assert.equal(selected.baseUrl, entry.baseUrl);
      const auth = await services.modelRegistry.getApiKeyAndHeaders(selected);
      assert.equal(auth.ok, true);
      if (!auth.ok) throw new Error(auth.error);
      assert.equal(auth.apiKey, key);
      globalThis.fetch = (async (input, init) => {
        requests++;
        const request = new Request(input, init);
        assert.equal(request.url, `${entry.baseUrl}${anthropic ? '/v1/messages' : '/chat/completions'}`);
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.get(anthropic ? 'x-api-key' : 'authorization'), anthropic ? key : `Bearer ${key}`);
        assert.equal(request.headers.get('content-type'), 'application/json');
        if (anthropic) {
          assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
          assert.equal(request.headers.get('authorization'), null);
        } else assert.equal(request.headers.get('x-api-key'), null);
        const body = await request.json();
        assert.equal(body.model, 'synthetic');
        assert.equal(body.stream, true);
        return unauthorized ? new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'synthetic unauthorized' } }),
          { status: 401, headers: { 'content-type': 'application/json' } }) : response(anthropic);
      }) as typeof fetch;
      await writeFile(join(dir, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { enabled: false, provider: { maxRetries: 0 } } }));
      const reference = await saveProviderRuntimeProjection(dir, snapshot);
      const manager = sdk.SessionManager.create(dir, dir);
      manager.appendModelChange(entry.provider, 'synthetic');
      manager.appendThinkingLevelChange('off');
      const sessionPath = await realpath(manager.getSessionFile()!);
      const sdkRuntime = { kind: 'source-artifact' as const, descriptor: sourceDescriptor };
      const frames: Array<{ event?: string }> = [];
      host = new WorkerRuntimeHost({ sdkRuntime, owner: { coordinatorGeneration: 1, workerId: 'mock', workerGeneration: 1 },
        server: { sendFrame(frame: any) { frames.push(frame); return true; }, sendEventFrame() { return true; }, sendLiveSemanticFrame() { return true; },
          sendRuntimeReportFrame() { return true; }, sendDetailFrame() { return true; }, onDetailDrain() { return () => {}; },
          requestFrame: async (request: any) => request.kind === 'provider.acquire'
            ? { lease: { leaseId: 'mock', headerWaitMs: 1000, streamIdleTimeoutMs: 1000 } } : {},
          failRuntime(error: Error) { throw error; },
        } as any });
      await host.promote({ sdkPath: sourceDescriptor.sdkPath, sdkRuntime, agentDir: dir, startupCwd: dir, sessionDir: dir,
        sessionPath, creationReason: 'new', writeLease: { coordinatorGeneration: 1, workerId: 'mock', workerGeneration: 1,
          canonicalSessionPath: sessionPath, ownershipRevision: 1, nonce: 'mock' }, openedPayload: {} as any, modelSettings: {},
        providerRuntime: { artifactDir: dir, reference, credentialFile: file } });
      const session = (host as any).context.session as Awaited<ReturnType<typeof sdk.createAgentSession>>['session'];
      session.agent.transport = 'sse';
      await host.command('message.send', { params: { sessionPath, text: 'Hello', localId: 'mock-user', inputs: [] } }, 'mock-send');
      await session.waitForIdle();
      const result = session.messages.find(message => message.role === 'assistant') as any;
      assert.equal(requests, 1);
      assert.equal(result?.stopReason, unauthorized ? 'error' : 'stop');
      if (unauthorized) assert.match(result.errorMessage, /401|synthetic unauthorized/);
      else assert.equal(result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''), 'Hello');
      assert.equal(session.isStreaming, false);
      assert.ok(frames.some(frame => frame.event === 'agent.settled'));
    } finally {
      await host?.dispose();
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
