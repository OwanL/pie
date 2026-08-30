import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectInitialContextEstimate,
  installInventoryProviderDenyBoundary,
} from '../../../src/backend/initial-context-estimate-worker';
import { estimateTextTokens } from '../../../src/shared/tokenize';

test('fresh inventory binds resources, counts the unfiltered catalog, and disposes without prompting', async () => {
  let disposed = false;
  let bound = false;
  let promptCalls = 0;
  let turnDenied = false;
  let builtPromptOptions: any;
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
    ],
    getToolDefinition: (name: string) => name === 'hidden_inventory'
      ? { promptSnippet: inactiveSnippet, promptGuidelines: [inactiveGuideline] }
      : undefined,
    waitForIdle: async () => undefined,
    prompt: async () => { promptCalls += 1; },
  };
  const sdk: any = {
    AuthStorage: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSessionServices: async (options: any) => {
      const resources = options.resourceLoaderOptions.agentsFilesOverride({
        agentsFiles: [{ path: '/workspace/AGENTS.md', content: 'Project instructions.' }],
      });
      assert.equal(resources.agentsFiles.length, 1);
      return { cwd: '/workspace', agentDir: '/agent', modelRegistry: { find: () => session.model } };
    },
    createAgentSessionFromServices: async () => ({ session }),
    createAgentSessionRuntime: async () => ({
      session,
      dispose: async () => { disposed = true; },
    }),
    formatSkillsForPrompt: (skills: any[]) => `<available_skills>${skills.map((skill) => skill.name).join(',')}</available_skills>`,
  };
  const systemPromptModule: any = {
    buildSystemPrompt: (options: any) => {
      builtPromptOptions = options;
      return [
        'Harness instructions.',
        ...Object.values(options.toolSnippets ?? {}),
        ...(options.promptGuidelines ?? []),
        options.appendSystemPrompt ?? '',
        ...(options.contextFiles ?? []).map((file: any) => file.content),
        ...(options.skills ?? []).map((skill: any) => `${skill.name}: ${skill.description}`),
      ].join('\n');
    },
  };

  const estimate = await collectInitialContextEstimate(sdk, systemPromptModule, {
    cwd: '/workspace',
    agentDir: '/agent',
    model: { provider: 'mock', id: 'model-a' },
  });

  assert.equal(bound, true, 'resources_discover/session_start binding runs before inventory');
  assert.equal(disposed, true, 'the temporary runtime is always disposed');
  assert.equal(promptCalls, 0, 'inventory never invokes the original AgentSession.prompt');
  assert.equal(turnDenied, true, 'extension-triggered turns are rejected before session_start');
  assert.equal(estimate.contextWindow, 200_000);
  assert.deepEqual(builtPromptOptions.selectedTools, ['read', 'hidden_inventory']);
  assert.equal(builtPromptOptions.toolSnippets.hidden_inventory, inactiveSnippet);
  assert.ok(builtPromptOptions.promptGuidelines.includes(inactiveGuideline));
  assert.ok(
    estimate.tokens >= estimateTextTokens(`${inactiveSnippet}\n${inactiveGuideline}`),
    'inactive/all-tool snippet and guideline text contributes to the initial payload estimate',
  );
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
