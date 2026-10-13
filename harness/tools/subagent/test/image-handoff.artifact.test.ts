import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { verifyPiRuntimeArtifact } from '../../../../lib/pi-runtime/artifact.mjs';
import { runSingleAgent } from '../runner.js';
import { buildParentUserContext, type ParentSessionManager } from '../user-context.js';

// The runner's injectable SDK seam avoids extension/analytics fixture plumbing,
// but resource loading, AgentSession.prompt and HTTP serialization remain real.
// Select this with test:artifact or test:file --sdk-path (no provider credentials).
test('parent branch images reach the real child provider unchanged and stay out of result metadata', { timeout: 20_000 }, async () => {
  const config = process.env.TSX_TSCONFIG_PATH;
  assert.ok(config, 'requires the native runner --sdk-path alias overlay');
  const paths = JSON.parse(readFileSync(config, 'utf8')).compilerOptions?.paths;
  const entry = paths?.['@earendil-works/pi-coding-agent']?.[0];
  assert.ok(entry && path.isAbsolute(entry), 'requires a selected compiled SDK');
  const sdkRoot = path.dirname(path.dirname(entry));
  const verified = await verifyPiRuntimeArtifact(path.resolve(sdkRoot, '../../..'));
  assert.equal(path.resolve(verified.sdkPath), sdkRoot);
  const sdk = await import(pathToFileURL(entry).href);
  const root = mkdtempSync(path.join(tmpdir(), 'pie-image-handoff-'));
  const images = [
    { type: 'image' as const, mimeType: 'image/png', data: Buffer.from('first-image-fixture').toString('base64') },
    { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from('second-image-fixture').toString('base64') },
  ];
  // Include a repeated occurrence and an unrelated tool image to guard ordering
  // and the user-only extraction boundary, not just one successful attachment.
  const branch = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Inspect these images.' }, images[0]] } },
    { type: 'message', message: { role: 'toolResult', toolName: 'read', content: [images[1]] } },
    { type: 'message', message: { role: 'user', content: [images[1], images[0]] } },
  ];
  const packet = buildParentUserContext('all', { getBranch: () => branch } as unknown as ParentSessionManager);
  assert.ok(packet);
  const expected = [images[0], images[1], images[0]];
  assert.deepEqual(packet.images, expected);
  let requests = 0;
  let requestBody: any;
  const errors: unknown[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        requests++;
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer disposable-image-fixture-key');
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          assert.ok(body.length < 256_000, 'fixture request must remain bounded');
        }
        requestBody = JSON.parse(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish] of [[{ role: 'assistant', content: 'Images received.' }, null], [{}, 'stop']] as const) {
          response.write(`data: ${JSON.stringify({ id: 'image-response', object: 'chat.completion.chunk', created: 1, model: 'image-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      } catch (error) {
        errors.push(error);
        response.writeHead(500);
        response.end('fixture failed');
      }
    })();
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const auth = sdk.AuthStorage.inMemory();
    const registry = sdk.ModelRegistry.inMemory(auth);
    registry.registerProvider('image-fixture', {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'disposable-image-fixture-key', api: 'openai-completions',
      models: [{ id: 'image-model', name: 'image-model', input: ['text', 'image'], reasoning: false, contextWindow: 100_000, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = registry.find('image-fixture', 'image-model');
    assert.ok(model);
    const result = await runSingleAgent(
      root, [{ name: 'worker', description: 'image fixture', systemPrompt: '', source: 'user', filePath: path.join(root, 'worker.md'), tools: [] }],
      'worker', 'Describe the attached images.', undefined, undefined, controller.signal, undefined,
      (results) => ({ mode: 'single', agentScope: 'user', projectAgentsDir: null, results }),
      registry, model, undefined, undefined, undefined, undefined, undefined, undefined,
      { sdk: {
        createSession: (args) => sdk.createAgentSession({ ...args, agentDir: root, authStorage: auth }),
        createResourceLoader: (args) => new sdk.DefaultResourceLoader({ ...args, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }),
        createSessionManager: (cwd) => sdk.SessionManager.inMemory(cwd),
        getAgentDir: () => root,
      } }, undefined, packet, { inputKinds: ['image'] },
    );
    assert.deepEqual(errors, []);
    assert.equal(result.exitCode, 0, result.errorMessage);
    assert.ok(result.messages.some((message: any) => message.role === 'assistant' && message.content.some((part: any) => part.type === 'text' && part.text === 'Images received.')), 'real SDK assistant response must settle the child');
    assert.equal(requests, 1, 'only the child prompt must reach the loopback provider');
    const userMessages = requestBody.messages.filter((message: any) => message.role === 'user');
    assert.equal(userMessages.length, 1);
    const content = userMessages[0].content;
    assert.deepEqual(content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url), expected.map((image) => `data:${image.mimeType};base64,${image.data}`));
    const text = content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    assert.match(text, /Describe the attached images\./);
    assert.match(text, /\[Parent image 1\][\s\S]*\[Parent image 2\][\s\S]*\[Parent image 3\]/);
    assert.equal(result.parentUserContextMode, 'all');
    assert.equal(result.parentUserContext, packet.content);
    for (const image of images) {
      assert.equal(text.includes(image.data), false);
      assert.equal(JSON.stringify(result).includes(image.data), false, 'result metadata must not contain attachment bytes');
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
