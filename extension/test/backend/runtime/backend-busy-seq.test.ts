import test from 'node:test';
import assert from 'node:assert/strict';

import { BackendServer } from '../../../src/backend/index';

function createSessionManager(sessionPath: string) {
  return {
    getCwd: () => '/ws',
    getSessionFile: () => sessionPath,
    getSessionName: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
  };
}

test('createSessionContext preserves busy seq across session reloads for the same path', async () => {
  const unsubscribed: string[] = [];
  const disposed: string[] = [];
  const sessionPath = '/ws/sessions/edit-rerun.jsonl';

  const server = new BackendServer({ sdkPath: '/unused', cwd: '/ws' }) as any;
  server.agentDir = '/agent';
  server.sdk = {
    createAgentSessionRuntime: async (
      _factory: unknown,
      options: { sessionManager: ReturnType<typeof createSessionManager> },
    ) => {
      const sessionManager = options.sessionManager;
      return {
        session: {
          sessionFile: sessionPath,
          sessionManager,
          isStreaming: false,
          messages: [],
          subscribe: () => () => {
            unsubscribed.push(sessionPath);
          },
          prompt: async () => undefined,
          abort: async () => undefined,
        },
        services: {
          modelRegistry: {
            getAvailable: () => [],
            find: () => undefined,
          },
        },
        dispose: async () => {
          disposed.push(sessionPath);
        },
      };
    },
  };

  const sessionManager = createSessionManager(sessionPath);

  const firstContext = await server.createSessionContext(sessionManager, 'resume');
  assert.equal(firstContext.busySeq, 0);

  firstContext.busySeq = 7;

  const reloadedContext = await server.createSessionContext(sessionManager, 'resume');

  assert.notEqual(reloadedContext, firstContext);
  assert.equal(reloadedContext.busySeq, 7);
  assert.deepEqual(unsubscribed, [sessionPath]);
  assert.deepEqual(disposed, [sessionPath]);
});
