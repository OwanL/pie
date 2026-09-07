import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buildPieSystemPrompt,
  installPieSystemPromptRebuildGuard,
  type PieSystemPromptOptions,
} from '../../../shared/pie-harness-prompt.js';
import { loadSdk } from '../../src/backend/sdk';

interface CapturedRequest {
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown[];
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

async function loadPinnedSystemPrompt(sdkPath: string): Promise<{
  buildSystemPrompt(options: PieSystemPromptOptions): string;
}> {
  return await import(pathToFileURL(path.join(sdkPath, 'dist', 'core', 'system-prompt.js')).href) as {
    buildSystemPrompt(options: PieSystemPromptOptions): string;
  };
}

test('real SDK raw picker state omits both system message and tool schemas', {
  timeout: 30_000,
  skip: process.env.PIE_RUN_INTEGRATION_TESTS === '1'
    ? false
    : 'run npm run test:integration to exercise the real SDK/provider boundary',
}, async () => {
  const requests: CapturedRequest[] = [];
  let resolveRequest!: () => void;
  const requestCaptured = new Promise<void>((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body) as CapturedRequest);
      resolveRequest();
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-empty-system-prompt-'));

  try {
    const agentDir = path.join(tempDir, 'agent');
    const cwd = path.join(tempDir, 'workspace');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      defaultThinkingLevel: 'off',
      packages: [],
    }));
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

    const sdkPath = path.resolve('node_modules/@earendil-works/pi-coding-agent');
    const sdk = await loadSdk(sdkPath);
    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const services = await sdk.createAgentSessionServices({ cwd, agentDir, authStorage }) as any;
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: sdk.SessionManager.create(cwd),
    }) as any;
    const session = created.session as any;
    session.setActiveToolsByName([]);
    session._baseSystemPrompt = '';
    session.agent.state.systemPrompt = '';

    const prompt = session.prompt('Say ok').catch(() => undefined);
    try {
      await Promise.race([
        requestCaptured,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Mock provider received no request')), 10_000)),
      ]);
    } finally {
      await session.abort();
      await prompt;
      await session.dispose?.();
    }

    assert.equal(requests.length, 1);
    assert.ok(!requests[0]?.messages?.some((message) => message.role === 'system'),
      'empty pie base prompt must serialize with no system message');
    assert.ok(requests[0]?.messages?.some((message) => message.role === 'user'));
    assert.equal(requests[0]?.tools?.length ?? 0, 0,
      'disabling the Tools row must remove the provider tool-schema field');
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('real SDK provider payload carries Pie ownership, dynamic guidance, and the parent append', {
  timeout: 30_000,
  skip: process.env.PIE_RUN_INTEGRATION_TESTS === '1'
    ? false
    : 'run npm run test:integration to exercise the real SDK/provider boundary',
}, async () => {
  const requests: CapturedRequest[] = [];
  let resolveRequest!: () => void;
  const requestCaptured = new Promise<void>((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body) as CapturedRequest);
      resolveRequest();
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-system-prompt-boundary-'));

  try {
    const agentDir = path.join(tempDir, 'agent');
    const cwd = path.join(tempDir, 'workspace');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mock-provider',
      defaultModel: 'mock-model',
      defaultThinkingLevel: 'off',
      packages: [],
    }));
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

    const sdkPath = path.resolve('node_modules/@earendil-works/pi-coding-agent');
    const sdk = await loadSdk(sdkPath);
    const sdkPrompt = await loadPinnedSystemPrompt(sdkPath);
    const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
    const services = await sdk.createAgentSessionServices({ cwd, agentDir, authStorage }) as any;
    const created = await sdk.createAgentSessionFromServices({
      services,
      sessionManager: sdk.SessionManager.create(cwd),
    }) as any;
    const session = created.session as any;
    const options: PieSystemPromptOptions = {
      cwd,
      selectedTools: ['read', 'bash'],
      toolSnippets: { read: 'Read files', bash: 'Run commands' },
      promptGuidelines: ['Parent dynamic guidance.'],
      appendSystemPrompt: '# Parent append\nKeep the parent role body.',
    };
    const stockBuild = sdkPrompt.buildSystemPrompt;
    const stockPrompt = stockBuild(options);
    session._baseSystemPromptOptions = options;
    session._baseSystemPrompt = stockPrompt;
    session.agent.state.systemPrompt = stockPrompt;
    installPieSystemPromptRebuildGuard(session, agentDir);

    const prompt = session.prompt('Say ok').catch(() => undefined);
    try {
      await Promise.race([
        requestCaptured,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Mock provider received no request')), 10_000)),
      ]);
    } finally {
      await session.abort();
      await prompt;
      await session.dispose?.();
    }

    assert.equal(requests.length, 1);
    const system = requests[0]?.messages?.find((message) => message.role === 'system')?.content;
    assert.equal(typeof system, 'string');
    assert.match(system as string, /^You are a coding assistant operating inside Pie/u);
    assert.match(system as string, /You may be assisting the user directly or completing a delegated task\./u);
    assert.match(system as string, /Parent dynamic guidance\./u);
    assert.match(system as string, /# Parent append\nKeep the parent role body\./u);

    const customOptions: PieSystemPromptOptions = {
      ...options,
      customPrompt: 'Explicit parent replacement.',
    };
    assert.equal(
      buildPieSystemPrompt(customOptions, stockBuild, agentDir),
      stockBuild(customOptions),
      'an explicit custom parent prompt remains byte-for-byte preserved',
    );
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
