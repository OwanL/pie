import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeFactory, ServiceLoadingGate } from '../../../src/backend/runtime-factory';
import type { SdkModule } from '../../../src/backend/sdk';

test('runtime factory passes the configured provider-qualified default to new sessions', async () => {
  const selectedModel = { id: 'shared-model', provider: 'provider-b' };
  const findCalls: Array<{ provider: string; modelId: string }> = [];
  const createOptions: Array<Record<string, unknown>> = [];

  const sdk = {
    createAgentSessionServices: async () => ({
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
    }),
    createAgentSessionFromServices: async (options: unknown) => {
      createOptions.push(options as Record<string, unknown>);
      return { session: { model: selectedModel } };
    },
  } as unknown as SdkModule;

  const sessionManager = {
    getSessionFile: () => '/sessions/new.jsonl',
    buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
  } as any;
  const factory = createRuntimeFactory(sdk, {}, '/workspace', new ServiceLoadingGate());

  await factory({
    cwd: '/workspace',
    agentDir: '/agent',
    sessionManager,
    sessionStartEvent: { type: 'session_start', reason: 'new' },
  });

  assert.deepEqual(findCalls, [{ provider: 'provider-b', modelId: 'shared-model' }]);
  assert.equal(createOptions.length, 1);
  assert.equal(createOptions[0].model, selectedModel);
});
