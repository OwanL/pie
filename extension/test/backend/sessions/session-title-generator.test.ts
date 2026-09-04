import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactSessionTitleInput,
  generateSessionTitle,
  sanitizeGeneratedSessionTitle,
  SESSION_TITLE_MAX_INPUT_CHARS,
} from '../../../src/backend/session-title-generator';
import type { SessionContext } from '../../../src/backend/server-types';

function fakeContext(options: { explicitName?: string; explicitPropertyName?: string; nameAfterFetch?: string; output?: string; expectedThink?: false | string; usage?: { input: number; output: number } } = {}) {
  let writtenName: string | undefined;
  let explicitName = options.explicitName;
  let fetchCalls = 0;
  const session = {
    sessionName: options.explicitPropertyName,
    sessionManager: {
      getSessionName: () => explicitName,
    },
    _modelRegistry: {
      find: (provider: string, id: string) => ({
        provider,
        id,
        baseUrl: 'http://localhost:11434/v1',
      }),
    },
    _getCompactionRequestAuth: async () => ({}),
    setSessionName: (name: string) => { writtenName = name; },
  };
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.think, options.expectedThink ?? false);
    assert.equal((body.options as { temperature?: number }).temperature, 0);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-pi-request-class'), 'session-title');
    if (options.nameAfterFetch) explicitName = options.nameAfterFetch;
    return new Response(JSON.stringify({
      message: { content: options.output ?? 'Fix Slow MCP Settings' },
      ...(options.usage ? {
        prompt_eval_count: options.usage.input,
        eval_count: options.usage.output,
      } : {}),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    context: { session } as unknown as SessionContext,
    fetchFn,
    get writtenName() { return writtenName; },
    get fetchCalls() { return fetchCalls; },
  };
}

test('generates and durably writes a bounded title through Ollama native chat', async () => {
  const fake = fakeContext();
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Changing MCP settings is slow. Investigate and fix it.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: fake.fetchFn as typeof fetch });

  assert.deepEqual(result, { generated: true, name: 'Fix Slow MCP Settings' });
  assert.equal(fake.writtenName, 'Fix Slow MCP Settings');
  assert.equal(fake.fetchCalls, 1);
});

test('reports one provider settlement with title usage and timing', async () => {
  const fake = fakeContext({ usage: { input: 19, output: 4 } });
  const settlements: Array<Record<string, unknown>> = [];
  let now = Date.parse('2026-09-04T10:00:00.000Z');
  await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix title accounting.', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: fake.fetchFn as typeof fetch,
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push(settlement),
  });

  assert.equal(settlements.length, 1);
  assert.deepEqual(settlements[0]?.usage, {
    inputTokens: 19,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 23,
  });
  assert.equal(settlements[0]?.outcome, 'succeeded');
});

test('an existing explicit/manual name wins without making a model call', async () => {
  const fake = fakeContext({ explicitName: 'Manual Name' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Fix the login flow.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: fake.fetchFn as typeof fetch });

  assert.deepEqual(result, { generated: false, reason: 'explicit-name' });
  assert.equal(fake.fetchCalls, 0);
  assert.equal(fake.writtenName, undefined);
});

test('the SDK sessionName property also prevents generated overwrite', async () => {
  const fake = fakeContext({ explicitPropertyName: 'SDK Explicit Name' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the login flow.', provider: 'ollama', model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: fake.fetchFn as typeof fetch });
  assert.deepEqual(result, { generated: false, reason: 'explicit-name' });
  assert.equal(fake.fetchCalls, 0);
});

test('passes the selected thinking budget to Ollama native chat', async () => {
  const fake = fakeContext({ expectedThink: 'low' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Fix the login flow.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
    thinkingLevel: 'low',
    timeoutSec: 30,
  }, { fetchFn: fake.fetchFn as typeof fetch });
  assert.equal(result.generated, true);
});

test('a manual rename racing inference wins immediately before durable write', async () => {
  const fake = fakeContext({ nameAfterFetch: 'Manual Race Winner' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Fix the login flow.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: fake.fetchFn as typeof fetch });

  assert.deepEqual(result, { generated: false, reason: 'explicit-name' });
  assert.equal(fake.fetchCalls, 1);
  assert.equal(fake.writtenName, undefined);
});

test('invalid prose output fails soft to the prompt snippet', async () => {
  const fake = fakeContext({ output: 'The user would like me to produce a detailed explanation of their request and possible implementation choices.' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Explain token rotation.',
    provider: 'ollama',
    model: 'glm',
  }, { fetchFn: fake.fetchFn as typeof fetch });

  assert.deepEqual(result, { generated: false, reason: 'invalid-output' });
  assert.equal(fake.writtenName, undefined);
});

test('generation is bounded by a short fail-open timeout', async () => {
  const fake = fakeContext();
  const stalledFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(() => generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Fix the login flow.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: stalledFetch as typeof fetch, timeoutMs: 5 }), /aborted/);
  assert.equal(fake.writtenName, undefined);
});

test('output sanitizer accepts only the compact title contract', () => {
  assert.equal(sanitizeGeneratedSessionTitle('Title: Review PR #208\n'), 'Review PR #208');
  assert.equal(sanitizeGeneratedSessionTitle('One'), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review PR #208\nAdditional explanation'), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review\u0007 PR #208'), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('This title has far too many words to be accepted safely'), undefined);
});

test('input compaction removes fenced code and keeps bounded beginning and end context', () => {
  const input = `Start context\n\`\`\`ts\n${'x'.repeat(5_000)}\n\`\`\`\n${'middle '.repeat(1_000)}Final request`;
  const compacted = compactSessionTitleInput(input);
  assert.ok(compacted.length <= SESSION_TITLE_MAX_INPUT_CHARS);
  assert.match(compacted, /^Start context \[code omitted\]/);
  assert.match(compacted, /Final request$/);
});
