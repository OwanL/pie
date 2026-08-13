import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ProviderGate, ProviderGateAbortError } from '../../../src/backend/provider-gate';
import type { SessionContext } from '../../../src/backend/server-types';

test('concurrent cold promotions share one expensive session runtime creation', async () => {
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
    const created = await contextPromise;
    server.sessionContexts.set('/s', created);
    return created;
  };
  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
  server.emit = () => undefined;

  const first = server.ensureSessionContext('/s');
  const second = server.ensureSessionContext('/s');
  assert.equal(opens, 1);
  assert.equal(creations, 1);

  release(context);
  assert.equal(await first, context);
  assert.equal(await second, context);
  assert.equal(server.pendingSessionContexts.size, 0, 'dedup entry is released after settlement');
});

test('a caller already awaiting promotion joins a subsequently reserved replacement', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  let releasePromotion!: (context: SessionContext) => void;
  const promotionGate = new Promise<SessionContext>((resolve) => { releasePromotion = resolve; });
  const promoted = { sessionPath: '/s', marker: 'promoted' } as unknown as SessionContext;
  const replacement = { sessionPath: '/s', marker: 'replacement' } as unknown as SessionContext;
  server.sdk = { SessionManager: { open: () => ({ getSessionFile: () => '/s' }) } };
  server.createSessionContext = async () => {
    const context = await promotionGate;
    server.sessionContexts.set('/s', context);
    return context;
  };
  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
  server.emit = () => undefined;

  const sendPromotion = server.ensureSessionContext('/s');
  const transition = server.transitionSessionContext('/s', async () => {
    server.sessionContexts.set('/s', replacement);
    return replacement;
  });
  releasePromotion(promoted);

  assert.equal(await sendPromotion, replacement, 'the earlier caller must not escape onto the replaced runtime');
  assert.equal(await transition, replacement);
});

test('promotion hydration failure retires the unpublished runtime and a retry creates a fresh authority', async () => {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
  let creations = 0;
  let disposals = 0;
  const capturedPredecessors: Array<string | undefined> = [];
  server.browsePreviousSessionFiles.set('/s', '/previous');
  server.sdk = { SessionManager: { open: () => ({ getSessionFile: () => '/s' }) } };
  server.createSessionContext = async (_manager: unknown, _reason: unknown, previous?: string) => {
    capturedPredecessors.push(previous);
    creations += 1;
    const context = {
      sessionPath: '/s',
      runtime: { dispose: async () => { disposals += 1; } },
      unsubscribe: () => undefined,
    } as SessionContext;
    server.sessionContexts.set('/s', context);
    return context;
  };
  server.buildHotSessionOpenedPayload = async () => { throw new Error('hydrate failed'); };

  await assert.rejects(server.ensureSessionContext('/s'), /hydrate failed/);
  assert.equal(server.sessionContexts.has('/s'), false);
  assert.equal(disposals, 1);

  server.buildHotSessionOpenedPayload = async () => ({ session: { path: '/s' }, runtimeReady: true });
  server.emit = () => undefined;
  await server.ensureSessionContext('/s');
  assert.equal(creations, 2);
  assert.deepEqual(capturedPredecessors, ['/previous', '/previous'], 'failed hydration retains browse-time predecessor for retry');
});

test('forget tombstone fences an in-flight promotion before hydration publication', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-forget-race-'));
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, '');
  const server = new BackendServer({ sdkPath: '/unused', cwd: dir }) as any;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let hydrationBuilds = 0;
  let publications = 0;
  server.sdk = { SessionManager: { open: () => ({ getSessionFile: () => sessionPath }) } };
  server.createSessionContext = async () => {
    await gate;
    const context = {
      sessionPath,
      runtime: { dispose: async () => undefined },
      unsubscribe: () => undefined,
    } as SessionContext;
    server.sessionContexts.set(sessionPath, context);
    return context;
  };
  server.buildHotSessionOpenedPayload = async () => {
    hydrationBuilds += 1;
    return { session: { path: sessionPath }, runtimeReady: true };
  };
  server.emit = () => { publications += 1; };

  const promotion = server.ensureSessionContext(sessionPath);
  const forgetting = server.forgetSession(sessionPath);
  release();
  await assert.rejects(promotion, /no longer available|forgotten/);
  await forgetting;

  assert.equal(hydrationBuilds, 0);
  assert.equal(publications, 0);
  assert.equal(server.sessionContexts.has(sessionPath), false);
  await fs.rm(dir, { recursive: true, force: true });
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
