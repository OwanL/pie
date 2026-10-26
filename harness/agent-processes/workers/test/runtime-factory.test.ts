import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

import { createRuntimeFactory, ServiceLoadingGate } from '../runtime-factory';
import { selectAdmittedInitialModel, type SdkModule } from '../../lib/sdk-integration/sdk';

test('admitted initial selection preserves SDK provider preference and configured priority offline', () => {
  const older = { provider: 'openai', id: 'older' };
  const preferred = { provider: 'openai', id: 'preferred' };
  const sdk = { defaultModelPerProvider: { openai: 'preferred' } };
  assert.equal(selectAdmittedInitialModel(sdk, [older, preferred]), preferred);
  assert.equal(selectAdmittedInitialModel(sdk, [older, preferred], 'openai', 'older'), older);
  assert.equal(selectAdmittedInitialModel(sdk, [older]), older);
  assert.equal(selectAdmittedInitialModel(sdk, []), undefined);
});

for (const count of [0, 1, 2]) {
  test(`managed creation with ${count} admitted candidates`, async () => {
    const fallback = { provider: 'authenticated', id: 'fallback' };
    const preferred = { provider: 'preferred', id: 'default' };
    const admitted = [fallback, preferred].slice(0, count);
    let serviceCalls = 0;
    let selected: unknown;
    const registry = { getAvailable: () => admitted, find: () => { throw new Error('global lookup forbidden'); } };
    const sdk = {
      createAgentSessionServices: async () => {
        serviceCalls++;
        return { modelRegistry: registry, settingsManager: {
          getDefaultProvider: () => preferred.provider, getDefaultModel: () => preferred.id,
        } };
      },
      createAgentSessionFromServices: async (options: any) => { selected = options.model; return {}; },
    } as unknown as SdkModule;
    const factory = createRuntimeFactory(sdk, {}, '/workspace', new ServiceLoadingGate(), {
      providerServices: async () => ({ authStorage: {}, modelRegistry: registry }),
    });
    const run = () => factory({ cwd: '/workspace', agentDir: '/agent', sessionManager: {
      getBranch: () => [], buildSessionContext: () => ({ model: null }),
    } as any });
    if (!count) {
      await assert.rejects(run, /Captured provider authentication is unavailable/);
      assert.equal(serviceCalls, 0);
      assert.equal(selected, undefined);
    } else {
      await run();
      assert.equal(selected, count === 2 ? preferred : fallback);
    }
  });
}

test('runtime factory passes the configured provider-qualified default to new sessions', async () => {
  const selectedModel = { id: 'shared-model', provider: 'provider-b' };
  const findCalls: Array<{ provider: string; modelId: string }> = [];
  const createOptions: Array<Record<string, unknown>> = [];
  let resourceOptions: any;

  const sdk = {
    createAgentSessionServices: async (options: any) => {
      resourceOptions = options.resourceLoaderOptions;
      return {
      modelRegistry: {
        find(provider: string, modelId: string) {
          findCalls.push({ provider, modelId });
          return provider === selectedModel.provider && modelId === selectedModel.id
            ? selectedModel
            : undefined;
        },
      },
      settingsManager: {
        getDefaultProvider: () => selectedModel.provider,
        getDefaultModel: () => selectedModel.id,
      },
    };
    },
    createAgentSessionFromServices: async (options: unknown) => {
      createOptions.push(options as Record<string, unknown>);
      return { session: { model: selectedModel } };
    },
  } as unknown as SdkModule;

  const sessionManager = {
    getSessionFile: () => '/sessions/new.jsonl',
    getBranch: () => [],
    buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
  } as any;
  const factory = createRuntimeFactory(sdk, {}, '/workspace', new ServiceLoadingGate());

  await factory({
    cwd: '/workspace',
    agentDir: '/agent',
    sessionManager,
    sessionStartEvent: { type: 'session_start', reason: 'new' },
  });

  assert.deepEqual(resourceOptions.defaultExtensions, []);
  assert.ok(resourceOptions.additionalUserSkillPaths.includes(path.resolve('/agent', 'harness', 'agent-instructions', 'skills')));
  assert.ok(resourceOptions.additionalProjectSkillPaths.includes(path.resolve('/workspace', 'skills')));
  assert.equal(typeof resourceOptions.skillPathPriority, 'function');
  assert.equal('noContextFiles' in resourceOptions, false);
  assert.equal(typeof resourceOptions.appendSystemPromptOverride, 'function');
  assert.deepEqual(findCalls, [{ provider: 'provider-b', modelId: 'shared-model' }]);
  assert.equal(createOptions.length, 1);
  assert.equal(createOptions[0].model, selectedModel);
  assert.equal('thinkingLevel' in createOptions[0], false);
});
