import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { buildPieSystemPrompt } from '../../../agent-instructions/prompt-assembly/pie-harness-prompt.js';
import {
  collectInitialContextInventory,
  installInventoryProviderDenyBoundary,
  isInitialization,
  isInput,
  preloadVerifiedInventoryModules,
} from '../initial-context-estimate-worker.js';
import { INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION } from '../initial-context-estimate-protocol.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { estimateTextTokens } from '../../../../lib/token-estimation.js';
import { countTokens } from '../../../../lib/tokenization.js';
import { estimateRequestPrefixTokens, estimateToolDefinitionsTokens, type RequestEstimateTool } from '../../../../lib/request-token-estimate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function drainMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('verification barrier and independent loaders block publication until both succeed', async () => {
  const verification = deferred<string>();
  const full = deferred<object>();
  const prompt = deferred<object>();
  const starts: string[] = [];
  const frames: string[] = [];
  const sdk = {};
  const systemPrompt = {};
  const result = preloadVerifiedInventoryModules(
    () => verification.promise,
    (mode) => { starts.push(`full:${mode}`); return full.promise; },
    (mode) => { starts.push(`prompt:${mode}`); return prompt.promise; },
  ).then((modules) => { frames.push('ready', 'result'); return modules; });
  await drainMicrotasks();
  assert.deepEqual(starts, []);
  verification.resolve('selected');
  await drainMicrotasks();
  assert.deepEqual(starts, ['full:selected', 'prompt:selected']);
  assert.deepEqual(frames, []);
  full.resolve(sdk);
  await drainMicrotasks();
  assert.deepEqual(frames, [], 'delayed prompt blocks readiness and result');
  prompt.resolve(systemPrompt);
  assert.deepEqual(await result, [sdk, systemPrompt]);
  assert.deepEqual(frames, ['ready', 'result']);
});

test('initial verification rejection prevents either loader starting', async () => {
  const reason = {};
  let starts = 0;
  await assert.rejects(preloadVerifiedInventoryModules(
    async () => { throw reason; },
    async () => { starts += 1; },
    async () => { starts += 1; },
  ), (error) => error === reason);
  assert.equal(starts, 0);
});

for (const failing of ['full', 'prompt', 'both'] as const) {
  test(`preload drains both loaders on ${failing} rejection and preserves primary reason`, async () => {
    const full = deferred<object>();
    const prompt = deferred<object>();
    const fullReason = { loader: 'full' };
    const promptReason = { loader: 'prompt' };
    let settled = false;
    const starts: string[] = [];
    const result = preloadVerifiedInventoryModules(
      async () => 'selected',
      () => { starts.push('full'); return full.promise; },
      () => { starts.push('prompt'); return prompt.promise; },
    );
    const checked = assert.rejects(result, (error) => {
      settled = true;
      return error === (failing === 'prompt' ? promptReason : fullReason);
    });
    await drainMicrotasks();
    assert.deepEqual(starts, ['full', 'prompt']);
    if (failing === 'prompt') prompt.reject(promptReason);
    else full.reject(fullReason);
    await drainMicrotasks();
    assert.equal(settled, false, 'failure cannot reach teardown while the peer is pending');
    if (failing === 'prompt') full.resolve({});
    else if (failing === 'both') prompt.reject(promptReason);
    else prompt.resolve({});
    await checked;
    assert.equal(settled, true);
  });
}

test('worker retains guarded preload, ready ordering, and separate fresh discovery frame', () => {
  const source = readFileSync(path.resolve(__dirname, '../initial-context-estimate-worker.ts'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  const preload = main.indexOf('[sdk, systemPromptModule] = await preloadVerifiedInventoryModules(');
  const initialVerify = main.indexOf('await verifySdkRuntimeSelection(initialization.sdkPath, sdkRuntime)');
  const mode = main.indexOf("sdkRuntimeLoadMode(verifiedRuntime, 'full')");
  const full = main.indexOf('loadSdk(initialization.sdkPath, selectedMode)');
  const prompt = main.indexOf('loadSdkInternalModule<SdkSystemPromptModule>(');
  const ready = main.indexOf("kind: 'ready'");
  const request = main.indexOf('const input = await readFrame(inputStream, isInput,');
  const agreement = main.indexOf('assertSdkRuntimeAgreement(input.sdkPath, sdkRuntime, input.sdkRuntime)');
  const reverify = main.indexOf('await verifySdkRuntimeSelection(input.sdkPath, sdkRuntime)');
  const discovery = main.indexOf('await collectInitialContextInventory(');
  assert.ok(preload >= 0 && initialVerify > preload && mode > initialVerify);
  assert.ok(full > mode && prompt > full && ready > prompt);
  assert.ok(request > ready && agreement > request && reverify > agreement && discovery > reverify);
  assert.equal((main.match(/await readFrame\(/g) ?? []).length, 2);
  assert.equal((main.match(/await collectInitialContextInventory\(/g) ?? []).length, 1);
});

test('inventory frames reject missing, mixed, unknown, and legacy-discriminator runtime routes', () => {
  const sdkRuntime = createSyntheticSourceTestSdkRuntime('/sdk');
  const initialization = {
    protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
    kind: 'initialize',
    sdkPath: '/sdk',
    sdkRuntime,
    parentPid: 123,
  };
  const request = {
    protocolVersion: INITIAL_CONTEXT_INVENTORY_PROTOCOL_VERSION,
    kind: 'discover',
    sdkPath: '/sdk',
    sdkRuntime,
    cwd: '/tmp/workspace',
    agentDir: '/tmp/agent',
    model: { provider: 'mock', id: 'model' },
  };
  assert.equal(isInitialization(initialization), true);
  assert.equal(isInput(request), true);
  assert.equal(isInitialization({ ...initialization, protocolVersion: 1 }), false);
  assert.equal(isInput({ ...request, protocolVersion: 1 }), false);
  for (const malformed of [
    { ...initialization, sdkRuntime: undefined },
    { ...initialization, sdkRuntime: { ...sdkRuntime, descriptor: {} } },
    { ...initialization, sdkRuntime: { ...sdkRuntime, kind: 'unknown' } },
    { ...initialization, sdkRuntime: { ...sdkRuntime, patchIdentity: {} } },
    { ...initialization, sdkRuntime: { kind: 'legacy-patched', patchIdentity: {} } },
    { ...initialization, sdkPatchIdentity: {} },
  ]) assert.equal(isInitialization(malformed), false);
  for (const malformed of [
    { ...request, sdkRuntime: undefined },
    { ...request, sdkRuntime: { ...sdkRuntime, descriptor: {} } },
    { ...request, sdkRuntime: { ...sdkRuntime, kind: 'unknown' } },
    { ...request, sdkRuntime: { ...sdkRuntime, patchIdentity: {} } },
    { ...request, sdkRuntime: { kind: 'legacy-patched', patchIdentity: {} } },
    { ...request, sdkPatchIdentity: {} },
  ]) assert.equal(isInput(malformed), false);
});

test('fresh inventory binds resources, counts the unfiltered catalog, and disposes without prompting', async () => {
  let disposed = false;
  let bound = false;
  let promptCalls = 0;
  let turnDenied = false;
  let builtPromptOptions: any;
  let backendTools: any[] = [];
  const inactiveSnippet = 'Inspect hidden capability inventory without activating it.';
  const inactiveGuideline = 'Use hidden_inventory only when it is recovered for a turn.';
  const session: any = {
    model: { provider: 'mock', id: 'model-a', contextWindow: 200_000 },
    async bindExtensions() {
      bound = true;
      try { await this.prompt('forbidden'); } catch { turnDenied = true; }
      this._baseSystemPromptOptions = {
        cwd: '/workspace',
        selectedTools: ['read'],
        contextFiles: [{ path: '/workspace/AGENTS.md', content: 'Project instructions.' }],
        skills: [{ name: 'debugging', description: 'Debug carefully.', filePath: '/skills/debugging/SKILL.md' }],
      };
    },
    getAllTools: () => [
      {
        name: 'read',
        description: 'Read a file.',
        promptSnippet: 'Read file contents',
        promptGuidelines: ['Use read instead of shell cat.'],
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'hidden_inventory',
        description: 'Inspect inactive inventory.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
      ...backendTools,
    ],
    getToolDefinition: (name: string) => name === 'hidden_inventory'
      ? { promptSnippet: inactiveSnippet, promptGuidelines: [inactiveGuideline] }
      : undefined,
    waitForIdle: async () => undefined,
    prompt: async () => { promptCalls += 1; },
  };
  const stageTimings: Array<{ stage: string; durationMs: number }> = [];
  const sdk: any = {
    AuthStorage: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSessionServices: async (options: any) => {
      const loaderOptions = options.resourceLoaderOptions;
      assert.deepEqual(loaderOptions.defaultExtensions, []);
      assert.ok(loaderOptions.additionalUserSkillPaths.includes(path.resolve('/agent', 'harness', 'agent-instructions', 'skills')));
      assert.ok(loaderOptions.additionalProjectSkillPaths.includes(path.resolve('/workspace', 'skills')));
      assert.equal(typeof loaderOptions.skillPathPriority, 'function');
      assert.equal('noContextFiles' in loaderOptions, false);
      assert.equal(typeof loaderOptions.appendSystemPromptOverride, 'function');
      const resources = loaderOptions.agentsFilesOverride({
        agentsFiles: [{ path: '/workspace/AGENTS.md', content: 'Project instructions.' }],
      });
      assert.equal(resources.agentsFiles.length, 1);
      return { cwd: '/workspace', agentDir: '/agent', modelRegistry: { find: () => session.model } };
    },
    createAgentSessionFromServices: async (options: any) => {
      backendTools = options.customTools;
      assert.deepEqual(backendTools.map((tool) => tool.name), [
        'session_control', 'session_send', 'session_assign', 'session_finish', 'session_wait', 'session_resources',
      ]);
      return { session };
    },
    createAgentSessionRuntime: async (factory: any, options: any) => {
      await factory(options);
      return { session, dispose: async () => { disposed = true; } };
    },
    formatSkillsForPrompt: (skills: any[]) => `<available_skills>${skills.map((skill) => skill.name).join(',')}</available_skills>`,
  };
  const systemPromptModule: any = {
    buildSystemPrompt: (options: any) => {
      builtPromptOptions = options;
      return [
        'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.',
        '',
        'Available tools:',
        ...Object.entries(options.toolSnippets ?? {}).map(([name, snippet]) => `- ${name}: ${snippet}`),
        '',
        'In addition to the tools above, you may have access to other custom tools depending on the project.',
        '',
        'Guidelines:',
        ...(options.promptGuidelines ?? []).map((guideline: string) => `- ${guideline}`),
        '',
        'Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):',
        '- Main documentation: /sdk/README.md',
        '- Additional docs: /sdk/docs',
        '- Examples: /sdk/examples (extensions, custom tools, SDK)',
        '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)',
        'Current date: 2026-01-01',
        'Current working directory: /workspace',
      ].join('\n');
    },
  };

  const inventory = await collectInitialContextInventory(sdk, systemPromptModule, {
    cwd: '/workspace',
    agentDir: '/agent',
    model: { provider: 'mock', id: 'model-a' },
  }, (stage, durationMs) => stageTimings.push({ stage, durationMs }));

  assert.deepEqual(stageTimings.map(({ stage }) => stage), [
    'resourceDiscoveryDurationMs',
    'promptAndEstimateDurationMs',
  ]);
  assert.ok(stageTimings.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0));
  assert.equal(bound, true, 'resources_discover/session_start binding runs before inventory');
  assert.equal(disposed, true, 'the temporary runtime is always disposed');
  assert.equal(promptCalls, 0, 'inventory never invokes the original AgentSession.prompt');
  assert.equal(turnDenied, true, 'extension-triggered turns are rejected before session_start');
  assert.equal(inventory.estimate.contextWindow, 200_000);
  assert.deepEqual(builtPromptOptions.selectedTools, [
    'read', 'hidden_inventory', 'session_control', 'session_send', 'session_assign', 'session_finish', 'session_wait', 'session_resources',
  ]);
  const expectedPiePrompt = buildPieSystemPrompt(
    builtPromptOptions,
    systemPromptModule.buildSystemPrompt,
    '/agent',
  );
  assert.match(expectedPiePrompt, /^You are a coding assistant operating inside Pie/);
  assert.ok(!expectedPiePrompt.includes('Traversal safety:'), 'inventory uses the approved base without traversal prose');
  const expectedTools = session.getAllTools() as ReadonlyArray<RequestEstimateTool>;
  assert.equal(
    inventory.estimate.tokens,
    countTokens(expectedPiePrompt) + estimateToolDefinitionsTokens(expectedTools),
    'initial estimate counts the shared Pie prompt (whitespace preserved) plus provider tool definitions exactly once as one compact JSON array',
  );
  assert.equal(
    inventory.estimate.tokens,
    estimateRequestPrefixTokens(expectedPiePrompt, expectedTools),
    'inventory totals and the shared estimator use the same request-prefix basis',
  );
  assert.equal(builtPromptOptions.toolSnippets.hidden_inventory, inactiveSnippet);
  assert.ok(builtPromptOptions.promptGuidelines.includes(inactiveGuideline));
  assert.ok(
    inventory.estimate.tokens >= estimateTextTokens(`${inactiveSnippet}\n${inactiveGuideline}`),
    'inactive/all-tool snippet and guideline text contributes to the initial payload estimate',
  );

  const promptsById = new Map(inventory.systemPrompts.map((entry) => [entry.id, entry]));
  assert.match(promptsById.get('harness')?.text ?? '', /^You are a coding assistant operating inside Pie/);
  assert.match(inventory.systemPrompts.find((entry) => entry.title.endsWith('AGENTS.md'))?.text ?? '', /Project instructions\./);
  assert.match(promptsById.get('tools')?.text ?? '', /Inspect inactive inventory\./);
  const toolInventoryPrompt = promptsById.get('tools')?.text ?? '';
  for (const name of ['session_control', 'session_send', 'session_assign', 'session_finish', 'session_wait', 'session_resources']) {
    assert.ok(builtPromptOptions.selectedTools.includes(name), `${name} is selected in the fresh inventory`);
    assert.match(toolInventoryPrompt, new RegExp(name));
  }
  assert.match(promptsById.get('tools')?.text ?? '', /"query": \{/);
  assert.match(promptsById.get('skills')?.text ?? '', /debugging/);
  assert.equal(promptsById.get('provider')?.summary, 'mock');
});

test('inventory estimate follows the discovery-model basis instead of the legacy fallback', async () => {
  // Schema + Unicode content is chosen so the modern OpenAI o200k basis and
  // the legacy cl100k/compact fallback disagree, making the wiring observable.
  const unicodeContextContent = 'Project instructions.\n必読: 設定ファイルを編集する前に必ずバックアップを取得してください。😀🚀 保留原始空白與縮排。';
  const unicodeGuideline = '読みやすい出力を優先してください。日本語と😀を含む説明。';
  const schemaTool = {
    name: 'plan_review',
    description: '"漢字" review of the plan. 😀',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: 'Ordered steps to review. 步驟:', items: { type: 'string' } },
        approved: { type: 'boolean', description: 'Whether the reviewer approved. 已核准。' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  };
  let disposed = false;
  // The builder runs twice (full inventory prompt first, harness card last);
  // the estimate uses the first (full) output.
  const capturedPromptOutputs: string[] = [];
  const session: any = {
    model: { provider: 'openai', id: 'gpt-5', contextWindow: 400_000 },
    async bindExtensions() {
      this._baseSystemPromptOptions = {
        cwd: '/workspace',
        selectedTools: [schemaTool.name],
        contextFiles: [{ path: '/workspace/AGENTS.md', content: unicodeContextContent }],
        skills: [{ name: 'planning', description: unicodeGuideline, filePath: '/skills/planning/SKILL.md' }],
      };
    },
    getAllTools: () => [schemaTool],
    getToolDefinition: () => undefined,
    waitForIdle: async () => undefined,
    prompt: async () => { throw new Error('forbidden'); },
  };
  const sdk: any = {
    AuthStorage: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSessionServices: async () => ({
      cwd: '/workspace',
      agentDir: '/agent',
      modelRegistry: { find: () => session.model },
    }),
    createAgentSessionFromServices: async () => ({ session }),
    createAgentSessionRuntime: async (factory: any, options: any) => {
      await factory(options);
      return { session, dispose: async () => { disposed = true; } };
    },
    formatSkillsForPrompt: (skills: any[]) => `<available_skills>${skills.map((skill) => skill.name).join(',')}</available_skills>`,
  };
  const systemPromptModule: any = {
    buildSystemPrompt: (options: any) => {
      const output = [
        'Available tools:',
        ...Object.entries(options.toolSnippets ?? {}).map(([name, snippet]) => `- ${name}: ${snippet}`),
        'Guidelines:',
        ...(options.promptGuidelines ?? []).map((guideline: string) => `- ${guideline}`),
        ...((options.contextFiles ?? []) as Array<{ content: string }>).map((file) => file.content),
      ].join('\n');
      capturedPromptOutputs.push(output);
      return output;
    },
  };
  const estimateModel = { provider: 'openai', id: 'gpt-5' };

  const inventory = await collectInitialContextInventory(sdk, systemPromptModule, {
    cwd: '/workspace',
    agentDir: '/agent',
    model: estimateModel,
  });

  assert.equal(disposed, true, 'the temporary runtime is always disposed');
  assert.equal(inventory.estimate.contextWindow, 400_000);
  // The fake builder output has no Pie docs bullets, so the worker's
  // buildPieSystemPrompt rewrite is an identity for it.
  const expectedPrompt = capturedPromptOutputs[0];
  const expectedTools = session.getAllTools() as ReadonlyArray<RequestEstimateTool>;
  assert.equal(
    inventory.estimate.tokens,
    estimateRequestPrefixTokens(expectedPrompt, expectedTools, estimateModel),
    'the inventory estimate is computed by the shared estimator on the discovery-model basis',
  );
  assert.equal(
    inventory.estimate.tokens,
    estimateRequestPrefixTokens(expectedPrompt, expectedTools, { ...estimateModel, api: 'openai-responses' }),
    'a missing api stays acceptable for shipped OpenAI-structured ids; a known OpenAI api agrees',
  );
  assert.notEqual(
    inventory.estimate.tokens,
    estimateRequestPrefixTokens(expectedPrompt, expectedTools),
    'schema + Unicode content makes the discovery-model basis observable against the legacy fallback',
  );
  const promptsById = new Map(inventory.systemPrompts.map((entry) => [entry.id, entry]));
  assert.equal(promptsById.get('provider')?.summary, 'openai');
});

test('inventory network deny boundary detects caught provider attempts instead of allowing a partial estimate', async () => {
  const boundary = installInventoryProviderDenyBoundary();
  try {
    await assert.rejects(fetch('https://provider.example.test/models'), /disabled/);
    assert.throws(boundary.assertNoAttempts, /attempted outbound network access/);
  } finally {
    boundary.restore();
  }
});
