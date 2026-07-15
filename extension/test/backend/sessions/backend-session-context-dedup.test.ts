import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ProviderGate, ProviderGateAbortError } from '../../../src/backend/provider-gate';
import type { SessionContext } from '../../../src/backend/server-types';

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

test('backend disposal uninstalls the provider gate and rejects queued waiters', async () => {
  const savedFetch = globalThis.fetch;
  const upstreamFetch = async () => new Response(null, { status: 200 });
  globalThis.fetch = upstreamFetch;
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' });
  try {
    ProviderGate.install([{
      provider: 'shutdown-test',
      baseUrl: 'https://shutdown.example/v1',
      maxConcurrentRequests: 1,
      afterburnSeconds: 60,
      queueWaitSeconds: 0,
    }], 0);
    const headers = (session: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': session, session_id: session },
    });
    await fetch('https://shutdown.example/v1/chat', headers('first'));
    const queued = fetch('https://shutdown.example/v1/chat', headers('queued'));
    await new Promise((resolve) => setImmediate(resolve));

    await server.dispose();
    await assert.rejects(queued, ProviderGateAbortError);
    assert.equal(ProviderGate.getInstance(), null);
    assert.equal(globalThis.fetch, upstreamFetch);
  } finally {
    ProviderGate.uninstall();
    globalThis.fetch = savedFetch;
  }
});
