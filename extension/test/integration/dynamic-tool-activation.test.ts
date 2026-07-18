import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadSdk } from '../../src/backend/sdk';

interface CapturedRequest {
  tools?: Array<{ function?: { name?: string } }>;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeSseResponse(
  response: http.ServerResponse,
  turn: number,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const toolCalls = [
    { id: 'call-list', name: 'request_capability', arguments: '{}' },
    { id: 'call-enable', name: 'request_capability', arguments: '{"capabilityName":"hidden_lookup"}' },
    { id: 'call-hidden', name: 'hidden_lookup', arguments: '{"key":"answer"}' },
  ];
  const toolCall = toolCalls[turn];
  if (toolCall) {
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: 'chat.completion.chunk',
      created: turn + 1,
      model: 'mock-model',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: 'chat.completion.chunk',
      created: turn + 1,
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })}\n\n`);
  } else {
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: 'chat.completion.chunk',
      created: turn + 1,
      model: 'mock-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: 'chat.completion.chunk',
      created: turn + 1,
      model: 'mock-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

const integrationOnly = process.env.PIE_RUN_INTEGRATION_TESTS === '1'
  ? false
  : 'run npm run test:integration to exercise the real SDK/provider boundary';

test('setActiveTools inside a recovery tool exposes the recovered schema on the next model step', {
  timeout: 30_000,
  skip: integrationOnly,
}, async () => {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const turn = requests.length;
      requests.push(JSON.parse(body) as CapturedRequest);
      writeSseResponse(response, turn);
    });
  });
  const port = await listen(server);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-dynamic-tool-'));
  let session: any;

  try {
    const agentDir = path.join(tempDir, 'agent');
    const cwd = path.join(tempDir, 'workspace');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'mock-provider': {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'mock-key',
          models: [{
            id: 'mock-model', name: 'Mock Model', reasoning: false, input: ['text'],
            contextWindow: 8192, maxTokens: 128,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));

    const sdk = await loadSdk(path.resolve('node_modules/@earendil-works/pi-coding-agent')) as any;
    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const modelRegistry = sdk.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
    const model = modelRegistry.find('mock-provider', 'mock-model');
    assert.ok(model);

    let beforeAgentStartCalls = 0;
    let hiddenToolCalls = 0;
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultProjectTrust: false,
    }, { projectTrusted: false });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Use request_capability when a required tool is unavailable.',
      extensionFactories: [{
        name: 'dynamic-recovery-test',
        factory: (pi: any) => {
          pi.registerTool({
            name: 'request_capability',
            label: 'Request Capability',
            description: 'List hidden tools or enable one by exact name.',
            parameters: {
              type: 'object',
              properties: { capabilityName: { type: 'string' } },
              additionalProperties: false,
            },
            async execute(_id: string, params: { capabilityName?: string }) {
              if (!params.capabilityName) {
                return { content: [{ type: 'text', text: 'tools\thidden_lookup' }] };
              }
              pi.setActiveTools([...new Set([...pi.getActiveTools(), params.capabilityName])]);
              return { content: [{ type: 'text', text: `Enabled ${params.capabilityName}.` }] };
            },
          });
          pi.registerTool({
            name: 'hidden_lookup',
            label: 'Hidden Lookup',
            description: 'Look up a deterministic hidden value.',
            parameters: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
              additionalProperties: false,
            },
            async execute() {
              hiddenToolCalls += 1;
              return { content: [{ type: 'text', text: 'value=42' }] };
            },
          });
          pi.on('before_agent_start', () => { beforeAgentStartCalls += 1; });
        },
      }],
    });
    await resourceLoader.reload();

    const created = await sdk.createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: 'off',
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    });
    session = created.session;
    session.setActiveToolsByName(['request_capability']);

    await session.prompt('Find the hidden answer.');

    const advertised = requests.map((request) =>
      (request.tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
    assert.equal(requests.length, 4, 'poll, activation, hidden-tool use, and final response should be four model steps');
    assert.deepEqual(advertised[0], ['request_capability']);
    assert.deepEqual(advertised[1], ['request_capability']);
    assert.deepEqual(advertised[2], ['request_capability', 'hidden_lookup'],
      'setActiveTools must refresh the provider schema immediately after the activation result');
    assert.deepEqual(advertised[3], ['request_capability', 'hidden_lookup']);
    assert.equal(hiddenToolCalls, 1);
    assert.equal(beforeAgentStartCalls, 1, 'the recovery flow must remain inside one top-level agent run');
  } finally {
    await session?.dispose?.();
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
