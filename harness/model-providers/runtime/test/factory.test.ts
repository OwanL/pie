import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeFactory, ServiceLoadingGate } from '../../../agent-processes/workers/runtime-factory';
import type { SdkModule, SdkSessionManager } from '../../../agent-processes/lib/sdk-integration/sdk';

test('providerServices callback is per-session/guarded; undefined retains legacy factory options', async () => {
  const originalAuth = {};
  const capturedAuth = {};
  const capturedRegistry = { find: () => undefined };
  const calls: { authStorage?: unknown; modelRegistry?: unknown }[] = [];
  const callbackManagers: SdkSessionManager[] = [];
  const sdk = {
    createAgentSessionServices: async (options: unknown) => {
      calls.push(options as typeof calls[number]);
      return { modelRegistry: capturedRegistry };
    },
    createAgentSessionFromServices: async () => ({ session: {} }),
  } as unknown as SdkModule;
  const manager = (name: string) => ({ getSessionFile: () => undefined, getBranch: () => [], getSessionName: () => name }) as unknown as SdkSessionManager;
  const first = manager('captured');
  const second = manager('legacy');
  const guarded = manager('guarded');
  const factory = createRuntimeFactory(sdk, originalAuth, '/workspace', new ServiceLoadingGate(), {
    wrapSessionManager: value => value === first ? guarded : value,
    providerServices: async ({ sessionManager, agentDir }) => {
      assert.equal(agentDir, '/agent'); callbackManagers.push(sessionManager);
      return sessionManager === guarded ? { authStorage: capturedAuth, modelRegistry: capturedRegistry } : undefined;
    },
  });
  await factory({ cwd: '/workspace', agentDir: '/agent', sessionManager: first });
  await factory({ cwd: '/workspace', agentDir: '/agent', sessionManager: second });
  assert.deepEqual(callbackManagers, [guarded, second]);
  assert.equal(calls[0].authStorage, capturedAuth);
  assert.equal(calls[0].modelRegistry, capturedRegistry);
  assert.equal(calls[1].authStorage, originalAuth);
  assert.equal(Object.hasOwn(calls[1], 'modelRegistry'), false);
});
