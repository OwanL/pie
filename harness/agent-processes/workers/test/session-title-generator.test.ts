import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactSessionTitleInput,
  generateSessionTitle,
  sanitizeGeneratedSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_MAX_INPUT_CHARS,
  SESSION_TITLE_SYSTEM_PROMPT,
} from '../session-title-generator';
import type { SessionContext } from '../../coordinator/server-types.js';
import type { SessionTitleGeneratorDeps } from '../session-title-generator';
import { ADMISSION_FALLBACK_CUSTOM_TYPE } from '../../../session-storage/metadata/session-title.js';

type TitleAuthResult = { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };

function fakeContext(options: { explicitName?: string; explicitPropertyName?: string; nameAfterFetch?: string; output?: string; expectedThink?: false | string; usage?: { input: number; output: number }; auth?: () => Promise<TitleAuthResult>; sessionInfoEntries?: () => readonly unknown[] } = {}) {
  let writtenName: string | undefined;
  let explicitName = options.explicitName;
  let fetchCalls = 0;
  const session = {
    sessionName: options.explicitPropertyName,
    sessionManager: {
      getSessionName: () => explicitName,
      ...(options.sessionInfoEntries ? { getEntries: options.sessionInfoEntries } : {}),
    },
    _modelRegistry: {
      find: (provider: string, id: string) => ({
        provider,
        id,
        baseUrl: 'http://localhost:11434/v1',
      }),
    },
    _getCompactionRequestAuth: options.auth ?? (async () => ({})),
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

test('returns a bounded candidate only; it never performs the final durable write', async () => {
  const fake = fakeContext();
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk',
    prompt: 'Changing MCP settings is slow. Investigate and fix it.',
    provider: 'ollama',
    model: 'deepseek-v4-flash:0731-cloud',
  }, { fetchFn: fake.fetchFn as typeof fetch });

  assert.deepEqual(result, { generated: true, name: 'Fix Slow MCP Settings' });
  assert.equal(fake.writtenName, undefined, 'candidate generation must not persist the title itself');
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
  assert.equal(settlements[0]?.attempt, 0);
});

test('a retried title after invalid output records distinct per-attempt settlements', async () => {
  const fake = fakeContext();
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  let calls = 0;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Review session control', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        message: { content: calls === 1 ? 'Review Session Control Plus' : 'Review Control Flow' },
      }));
    },
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push({ ...settlement }),
  });

  assert.deepEqual(result, { generated: true, name: 'Review Control Flow' });
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements[0], {
    usage: undefined,
    startedAt: at(50),
    endedAt: at(75),
    outcome: 'succeeded',
    attempt: 0,
  });
  assert.deepEqual(settlements[1], {
    usage: undefined,
    startedAt: at(100),
    endedAt: at(125),
    outcome: 'succeeded',
    attempt: 1,
  });
});

test('a failed retry settles the current attempt window, not the whole operation', async () => {
  const fake = fakeContext();
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  let calls = 0;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  await assert.rejects(() => generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Review session control', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ message: { content: 'Review Session Control Plus' } }));
      throw new Error('provider exploded');
    },
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push({ ...settlement }),
  }), /provider exploded/);

  assert.equal(settlements.length, 2);
  assert.equal(settlements[0]?.attempt, 0);
  assert.equal(settlements[0]?.outcome, 'succeeded');
  assert.deepEqual(settlements[1], {
    // The failure window starts at the retried attempt, not at the operation start.
    startedAt: at(100),
    endedAt: at(125),
    outcome: 'failed',
    attempt: 1,
  });
  assert.ok(!('usage' in settlements[1]!), 'a failed attempt settles without usage evidence');
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

test('an approved, marker-bound admission fallback title is generation-replaceable', async () => {
  const fake = fakeContext({
    explicitName: 'Fix Flaky Windows Tests',
    sessionInfoEntries: () => [
      { id: 'ti-1', type: 'session_info', name: 'Fix Flaky Windows Tests' },
      {
        id: 'mk-1', type: 'custom', customType: ADMISSION_FALLBACK_CUSTOM_TYPE,
        data: { version: 1, titleEntryId: 'ti-1', name: 'Fix Flaky Windows Tests' },
      },
    ],
  });
  const manager = fake.context.session.sessionManager;
  const getEntries = manager.getEntries;
  manager.getEntries = function () {
    assert.equal(this, manager, 'SDK methods retain their manager receiver');
    return getEntries.call(manager);
  };
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the flaky Windows tests.', provider: 'ollama', model: 'title-model',
  }, { fetchFn: fake.fetchFn as typeof fetch });
  assert.deepEqual(result, { generated: true, name: 'Fix Slow MCP Settings' });
  assert.equal(fake.fetchCalls, 1);
});

test('a later manual rename invalidates the fallback marker even for the same text', async () => {
  const fake = fakeContext({
    explicitName: 'Fallback Title',
    sessionInfoEntries: () => [
      { id: 'ti-1', type: 'session_info', name: 'Fallback Title' },
      {
        id: 'mk-1', type: 'custom', customType: ADMISSION_FALLBACK_CUSTOM_TYPE,
        data: { version: 1, titleEntryId: 'ti-1', name: 'Fallback Title' },
      },
      // A manual rename appends a fresh session_info entry: the oldest marker
      // is tied to ti-1 and can never validate the newer ti-2.
      { id: 'ti-2', type: 'session_info', name: 'Fallback Title' },
    ],
  });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the login flow.', provider: 'ollama', model: 'title-model',
  }, { fetchFn: fake.fetchFn as typeof fetch });
  assert.deepEqual(result, { generated: false, reason: 'explicit-name' });
  assert.equal(fake.fetchCalls, 0);
});

test('an unmarked generation-failure fallback title stays final and protected', async () => {
  const fake = fakeContext({
    explicitName: 'Stable Fallback Title',
    sessionInfoEntries: () => [
      { id: 'ti-1', type: 'session_info', name: 'Stable Fallback Title' },
    ],
  });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the login flow.', provider: 'ollama', model: 'title-model',
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

test('a manual rename racing inference prevents any candidate or durable write', async () => {
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

test('an oversized title is never shortened and retries only once', async () => {
  const fake = fakeContext({ output: 'Review Session Control Plus' });
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Review session control.', provider: 'ollama', model: 'title-model',
  }, { fetchFn: fake.fetchFn as typeof fetch });
  assert.deepEqual(result, { generated: false, reason: 'invalid-output' });
  assert.equal(fake.fetchCalls, 2);
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

test('output sanitizer accepts only the compact 25-character candidate contract', () => {
  assert.equal(SESSION_TITLE_MAX_CHARS, 25);
  assert.match(SESSION_TITLE_SYSTEM_PROMPT, /at most 25 characters/);
  for (const example of [...SESSION_TITLE_SYSTEM_PROMPT.matchAll(/^Title: (.+)$/gmu)]) {
    assert.ok(example[1]!.trim().length <= SESSION_TITLE_MAX_CHARS, example[1]);
  }
  assert.equal(sanitizeGeneratedSessionTitle('Title: Review PR #208\n'), 'Review PR #208');
  assert.equal(sanitizeGeneratedSessionTitle('One'), 'One');
  assert.equal(sanitizeGeneratedSessionTitle('修复登录问题'), '修复登录问题');
  assert.equal(sanitizeGeneratedSessionTitle('Review Session Control Plus', true), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review VeryLongIdentifierThatCannotFit', true), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('This title has far too many words to be accepted safely', true), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review Session Control Plus\nExplanation', true), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review PR #208\nAdditional explanation'), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('Review\u0007 PR #208'), undefined);
  assert.equal(sanitizeGeneratedSessionTitle('This title has far too many words to be accepted safely'), undefined);
  assert.equal(
    sanitizeGeneratedSessionTitle('Review Session Control Plus'),
    undefined,
    'a 26+ character candidate is invalid, like any oversize base title',
  );
});

test('a corrective request returns a complete replacement', async () => {
  const fake = fakeContext();
  let calls = 0;
  const result = await generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Review session control', provider: 'ollama', model: 'title-model',
  }, { fetchFn: async (_input, init) => {
    calls += 1;
    if (calls === 2) assert.match(String(init?.body), /complete replacement/);
    return new Response(JSON.stringify({ message: { content: calls === 1 ? 'Review Session Control Plus' : 'Review Control Flow' } }));
  } });
  assert.deepEqual(result, { generated: true, name: 'Review Control Flow' });
  assert.equal(calls, 2);
});

for (const provider of ['ollama', 'openai-codex']) {
  test(`${provider} correction includes the rejected output and measured length within the input budget`, async () => {
    const rejected = 'Replace Bespoke Pies Image Viewer';
    const fake = fakeContext({ auth: async () => ({ apiKey: 'test-key' }) });
    const requests: string[] = [];
    const reply = (request: string) => {
      requests.push(request);
      return requests.length === 2 && request.includes(JSON.stringify(rejected))
        && request.includes(`${rejected.length} characters`)
        ? 'Replace Image Viewer' : rejected;
    };
    const result = await generateSessionTitle(fake.context, {
      sdkPath: '/sdk', provider, model: 'title-model',
      prompt: `Replace the bespoke image viewer. ${'Context '.repeat(900)}Use an existing viewer.`,
    }, {
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        return new Response(JSON.stringify({ message: { content: reply(body.messages[1]!.content) } }));
      },
      completeSimple: async (_model, context) => ({
        content: [{ type: 'text', text: reply(context.messages[0]!.content[0]!.text) }],
      }),
    });
    assert.deepEqual(result, { generated: true, name: 'Replace Image Viewer' });
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.ok(request.length <= SESSION_TITLE_MAX_INPUT_CHARS + '<request>\n\n</request>'.length);
    }
    assert.equal(fake.writtenName, undefined);
  });
}

test('a runtime load that resumes after abort never dispatches or settles a provider attempt', async () => {
  const fake = fakeContext({ auth: async () => ({ apiKey: 'test-key' }) });
  let resolveLoad!: (completeSimple: NonNullable<SessionTitleGeneratorDeps['completeSimple']>) => void;
  let providerCalls = 0;
  const settlements: unknown[] = [];
  const generation = generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the login flow.', provider: 'openai', model: 'title-model',
  }, {
    timeoutMs: 5,
    loadCompleteSimple: () => new Promise((resolve) => { resolveLoad = resolve; }),
    onSettled: (settlement) => settlements.push(settlement),
  });

  await assert.rejects(generation, /aborted/);
  resolveLoad(async () => {
    providerCalls += 1;
    return { content: [{ type: 'text', text: 'Late Title' }] };
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(providerCalls, 0, 'a provider must not be invoked after its operation deadline');
  assert.deepEqual(settlements, [], 'loading the runtime is not a provider attempt');
});

test('deadline includes stalled auth and ignores late completion', async () => {
  const fake = fakeContext({
    auth: () => new Promise((resolve) => { resolveAuth = resolve; }),
  });
  let resolveAuth!: (value: TitleAuthResult) => void;
  const settlements: unknown[] = [];
  await assert.rejects(generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix auth', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: fake.fetchFn, timeoutMs: 5,
    onSettled: (s) => settlements.push(s),
  }), /aborted/);
  resolveAuth({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.fetchCalls, 0);
  assert.deepEqual(settlements, [], 'a timeout during stalled auth fabricates no provider invocation');
});

test('already aborted signals do not start requests', async () => {
  const fake = fakeContext();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix auth', provider: 'ollama', model: 'title-model', signal: controller.signal,
  }, { fetchFn: fake.fetchFn }), /aborted/);
  assert.equal(fake.fetchCalls, 0);
});

test('noncooperative model cannot outlive the operation deadline', async () => {
  const fake = fakeContext();
  let resolveFetch!: (response: Response) => void;
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  await assert.rejects(generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix auth', provider: 'ollama', model: 'title-model',
  }, {
    timeoutMs: 5,
    fetchFn: () => new Promise((resolve) => { resolveFetch = resolve; }),
    now: () => (now += 25),
    onSettled: (s) => settlements.push({ ...s }),
  }), /aborted/);
  // Noncooperative providers never settle on their own, so the deadline
  // wrapper reports the dispatched attempt as cancelled with its true start.
  assert.deepEqual(settlements, [{
    startedAt: at(50),
    endedAt: at(75),
    outcome: 'cancelled',
    attempt: 0,
  }]);
  resolveFetch(new Response(JSON.stringify({ message: { content: 'Late Title' } })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The late completion of an abandoned attempt must not double-report.
  assert.equal(settlements.length, 1);
  assert.equal(fake.writtenName, undefined, 'an abandoned late completion mutates nothing');
});

test('a cooperative timeout reports the dispatched attempt as cancelled exactly once', async () => {
  const fake = fakeContext();
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  const stalledFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix auth', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: stalledFetch as typeof fetch,
    timeoutMs: 5,
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push({ ...settlement }),
  }), /aborted/);
  // The deadline and the cooperative provider rejection race, but exactly one
  // cancelled settlement with the attempt's identity and start is reported.
  assert.deepEqual(settlements, [{
    startedAt: at(50),
    endedAt: at(75),
    outcome: 'cancelled',
    attempt: 0,
  }]);
  assert.ok(!('usage' in settlements[0]!), 'a cancelled timeout settles without fabricated usage');
  assert.equal(fake.writtenName, undefined);
});

test('a caller abort after dispatch reports the active attempt as cancelled exactly once', async () => {
  const fake = fakeContext();
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  const controller = new AbortController();
  let signalStarted!: () => void;
  const dispatchObserved = new Promise<void>((resolveDispatch) => { signalStarted = resolveDispatch; });
  const abortedFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    signalStarted();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const generation = generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix the login flow.', provider: 'ollama', model: 'title-model',
    signal: controller.signal,
  }, {
    fetchFn: abortedFetch as typeof fetch,
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push({ ...settlement }),
  });
  await dispatchObserved;
  controller.abort();
  await assert.rejects(() => generation, /aborted/);
  assert.deepEqual(settlements, [{
    startedAt: at(50),
    endedAt: at(75),
    outcome: 'cancelled',
    attempt: 0,
  }]);
  assert.ok(!('usage' in settlements[0]!), 'a caller-aborted attempt settles without fabricated usage');
  assert.equal(fake.writtenName, undefined);
});

test('a caller abort during stalled auth fabricates no provider invocation', async () => {
  const fake = fakeContext({
    auth: () => new Promise((resolve) => { resolveAuth = resolve; }),
  });
  let resolveAuth!: (value: TitleAuthResult) => void;
  const settlements: unknown[] = [];
  const controller = new AbortController();
  const generation = generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Fix auth', provider: 'ollama', model: 'title-model',
    signal: controller.signal,
  }, {
    fetchFn: fake.fetchFn,
    onSettled: (s) => settlements.push({ ...s }),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(() => generation, /aborted/);
  assert.equal(settlements.length, 0);
  resolveAuth({});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settlements.length, 0, 'a post-abort arrival before dispatch fabricates no invocation');
  assert.equal(fake.fetchCalls, 0);
});

test('a timeout during a retried attempt settles that attempt, not a duplicate of the first', async () => {
  const fake = fakeContext();
  let resolveFetch!: (response: Response) => void;
  const settlements: Array<Record<string, unknown>> = [];
  const origin = Date.parse('2026-09-04T10:00:00.000Z');
  let now = origin;
  const at = (offset: number) => new Date(origin + offset).toISOString();
  let calls = 0;
  await assert.rejects(generateSessionTitle(fake.context, {
    sdkPath: '/sdk', prompt: 'Review session control', provider: 'ollama', model: 'title-model',
  }, {
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ message: { content: 'Review Session Control Plus' } }));
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    timeoutMs: 5,
    now: () => (now += 25),
    onSettled: (settlement) => settlements.push({ ...settlement }),
  }), /aborted/);
  assert.deepEqual(settlements, [
    {
      usage: undefined,
      startedAt: at(50),
      endedAt: at(75),
      outcome: 'succeeded',
      attempt: 0,
    },
    {
      startedAt: at(100),
      endedAt: at(125),
      outcome: 'cancelled',
      attempt: 1,
    },
  ]);
  resolveFetch(new Response(JSON.stringify({ message: { content: 'Late Retry Title' } })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settlements.length, 2);
  assert.equal(fake.writtenName, undefined);
});

test('input compaction removes fenced code and keeps bounded beginning and end context', () => {
  const input = `Start context\n\`\`\`ts\n${'x'.repeat(5_000)}\n\`\`\`\n${'middle '.repeat(1_000)}Final request`;
  const compacted = compactSessionTitleInput(input);
  assert.ok(compacted.length <= SESSION_TITLE_MAX_INPUT_CHARS);
  assert.match(compacted, /^Start context \[code omitted\]/);
  assert.match(compacted, /Final request$/);
});
