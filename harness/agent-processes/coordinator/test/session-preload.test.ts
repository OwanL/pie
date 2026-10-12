import assert from 'node:assert/strict';
import test from 'node:test';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler.js';
import type { SessionOpenedPayload } from '../../lib/rpc/session-events.js';

test('session.preload builds and returns the transcript snapshot without initial context inventory', async () => {
  const snapshot = {
    session: {
      path: '/repo/session.jsonl',
      cwd: '/repo',
      name: 'Preloaded',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
    },
    transcript: [{ id: 'message-1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    transcriptWindow: {
      totalCount: 1,
      loadedStart: 0,
      loadedEnd: 1,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: true,
    },
    busy: false,
    runtimeReady: false,
  } as unknown as SessionOpenedPayload;
  let buildArgs: unknown[] | undefined;
  let includeInitialContextInventory: boolean | undefined;
  const deps = {
    buildSessionOpenedPayload: async (...args: unknown[]) => {
      buildArgs = args;
      includeInitialContextInventory = args[8] as boolean | undefined;
      return snapshot;
    },
  } as unknown as BackendRequestHandlerDeps;

  const response = await handleBackendRequest(deps, {
    id: 'preload-request',
    method: 'session.preload',
    params: { sessionPath: '/repo/session.jsonl' },
  });

  assert.deepEqual(buildArgs, [
    '/repo/session.jsonl',
    undefined,
    'tail',
    { kind: 'response', requestId: 'preload-request' },
    undefined,
    undefined,
    undefined,
    undefined,
    false,
  ]);
  assert.equal(includeInitialContextInventory, false);
  assert.equal(response, snapshot);
  assert.deepEqual((response as SessionOpenedPayload).transcript, snapshot.transcript);
});
