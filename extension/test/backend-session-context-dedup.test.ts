import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../src/backend';
import type { SessionContext } from '../src/backend/server-types';

test('concurrent cold opens share one expensive session runtime creation', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  let opens = 0;
  let creations = 0;
  let release!: (context: SessionContext) => void;
  const contextPromise = new Promise<SessionContext>((resolve) => { release = resolve; });
  const context = { sessionPath: '/s' } as SessionContext;

  server.sdk = {
    SessionManager: {
      open: (sessionPath: string) => {
        opens += 1;
        return { sessionPath };
      },
    },
  };
  server.createSessionContext = async () => {
    creations += 1;
    return await contextPromise;
  };

  const first = server.ensureSessionContext('/s');
  const second = server.ensureSessionContext('/s');
  assert.equal(opens, 1);
  assert.equal(creations, 1);

  release(context);
  assert.equal(await first, context);
  assert.equal(await second, context);
  assert.equal(server.pendingSessionContexts.size, 0, 'dedup entry is released after settlement');
});
