import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadSdk } from '../../harness/agent-processes/lib/sdk-integration/sdk';
import { sourceDescriptor, sourceLoadMode } from '../../harness/agent-processes/lib/sdk-integration/test/source-fixture.js';
import { mapTranscript } from '../../harness/session-storage/transcripts/transcript';

const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cY9sAAAAASUVORK5CYII=';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-real-sdk-image-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function mockImageProvider(): Promise<{ server: http.Server; port: number; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: 'ok' }, null], [{}, 'stop'],
      ]) {
        response.write(`data: ${JSON.stringify({
          id: 'image-test', object: 'chat.completion.chunk', created: 1, model: 'mock-image',
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, requests };
}

test('real SDK persists committed user images in canonical session history', { timeout: 240_000 }, async (t) => {
  if (process.env['PIE_RUN_REAL_SDK_TESTS'] !== '1' && process.env.PIE_RUN_INTEGRATION_TESTS !== '1') {
    t.skip('Set PIE_RUN_INTEGRATION_TESTS=1 to run the source SDK image persistence verification.');
    return;
  }

  await withTempDir(async (tempDir) => {
    const sdk = await loadSdk(sourceDescriptor.sdkPath, sourceLoadMode);
    const agentDir = path.join(tempDir, 'agent');
    const cwd = path.join(tempDir, 'workspace');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    const { server, port, requests } = await mockImageProvider();
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
      'mock-provider': {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'mock-key',
        models: [{ id: 'mock-image', name: 'Mock Image', reasoning: false, input: ['text', 'image'],
          contextWindow: 8192, maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    } }));
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'mock-provider',
        defaultModel: 'mock-image',
        defaultThinkingLevel: 'off',
        compaction: { enabled: false }, retry: { enabled: false }, packages: [],
      }, null, 2),
      'utf8',
    );

    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        authStorage,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true,
        },
      });
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return Object.assign({ services }, created as Record<string, unknown>);
    };

    const sessionManager = sdk.SessionManager.create(cwd, path.join(tempDir, 'sessions'));
    const runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

    try {
      const availableModels = runtime.services.modelRegistry.getAvailable();
      const imageModel = availableModels.find((model) => Array.isArray(model.input) && model.input.includes('image'));
      assert.ok(imageModel, 'expected at least one image-capable model from the real SDK');

      if (runtime.session.model?.id !== imageModel?.id && typeof runtime.session.setModel === 'function') {
        const resolvedModel = runtime.services.modelRegistry.find(imageModel!.provider, imageModel!.id);
        assert.ok(resolvedModel, 'expected to resolve the selected image-capable model from the registry');
        await runtime.session.setModel(resolvedModel);
      }
      runtime.session.setThinkingLevel?.('off');
      runtime.session.setActiveToolsByName([]);

      let preflightAccepted = false;
      const waitForAgentEnd = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for agent_end from the real SDK session.')), 180_000);
        const unsubscribe = runtime.session.subscribe((event) => {
          if (event.type === 'agent_end') {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });

      await runtime.session.prompt('Reply with exactly the single word ok and do not use tools.', {
        images: [{
          type: 'image',
          data: PNG_1X1_BASE64,
          mimeType: 'image/png',
        }],
        source: 'rpc',
        preflightResult: (success) => {
          preflightAccepted = success;
        },
      });

      await waitForAgentEnd;
      assert.equal(preflightAccepted, true, 'the real SDK prompt should pass preflight acceptance');
      assert.equal(requests.length, 1, 'the SDK must send exactly one request to the local provider');
      assert.ok(JSON.stringify(requests[0]).includes(`data:image/png;base64,${PNG_1X1_BASE64}`),
        'the real provider payload must carry the committed image');

      const sessionFile = runtime.session.sessionFile ?? runtime.session.sessionManager.getSessionFile();
      assert.ok(sessionFile, 'the real SDK session should persist to a session file');
      const raw = await fs.readFile(sessionFile!, 'utf8');
      assert.match(raw, /"type":"image"/, 'session JSONL should contain a committed image content block');
      assert.match(raw, /"mimeType":"image\/png"/, 'session JSONL should retain the image mime type');
      assert.ok(raw.includes(PNG_1X1_BASE64), 'session JSONL should retain the committed image bytes');

      await runtime.dispose();

      const reopenedManager = sdk.SessionManager.open(sessionFile!);
      const reopenedTranscript = mapTranscript(reopenedManager.getBranch() as any);
      const reopenedUserMessage = reopenedTranscript.find((message) =>
        message.role === 'user'
        && message.userParts?.some((part) => part.kind === 'image'),
      );

      assert.ok(reopenedUserMessage, 'reopened canonical transcript should restore the committed user image');
      const restoredImagePart = reopenedUserMessage?.userParts?.find((part) => part.kind === 'image');
      assert.equal(restoredImagePart?.kind, 'image');
      if (restoredImagePart?.kind === 'image') {
        assert.equal(restoredImagePart.mimeType, 'image/png');
        assert.equal(restoredImagePart.dataBase64, PNG_1X1_BASE64);
      }
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
});
