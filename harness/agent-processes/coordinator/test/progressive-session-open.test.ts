import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendServer } from '../server.js';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler.js';
import type { SessionOpenedPayload } from '../../lib/rpc/session-events.js';

const snapshot = () => ({
  session: { path: '/repo/session.jsonl', cwd: '/repo' },
  runtimeReady: false,
  systemPrompts: [],
}) as unknown as SessionOpenedPayload;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const original = snapshot();
  const inventory = deferred<SessionOpenedPayload>();
  const events: Array<{ event: string; payload: any }> = [];
  let current = true;
  let hot = false;
  let forgotten = false;
  let builds = 0;
  const server: any = Object.create(BackendServer.prototype);
  Object.assign(server, {
    promptInventorySequence: 0,
    disposed: false,
    coldSessionStore: {
      ownershipStamp: () => [{}],
      publishSync: (_payload: unknown, publish: () => void) => publish(),
    },
    workerRuntimeRouter: { hasHotOwner: () => hot },
    isSessionForgotten: () => forgotten,
    isBrowseResponseCurrent: () => current,
    buildSessionOpenedPayload: () => { builds += 1; return inventory.promise; },
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
  });
  return {
    original, inventory, events, server,
    builds: () => builds,
    invalidate: (kind: string) => {
      if (kind === 'fingerprint') current = false;
      if (kind === 'hot') hot = true;
      if (kind === 'forgotten') forgotten = true;
      if (kind === 'disposed') server.disposed = true;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('failed inventory settles empty only while original ownership remains current', async () => {
  for (const stale of [false, true]) {
    const f = fixture();
    f.server.deferSessionPromptInventory(f.original);
    await Promise.resolve();
    if (stale) f.invalidate('fingerprint');
    f.inventory.reject(new Error('discovery failed'));
    await flush();
    assert.equal(f.events.length, stale ? 0 : 1);
    if (!stale) assert.deepEqual(f.events[0].payload.systemPrompts, []);
  }
});

test('an unavailable catalog cannot publish an initial estimate beside an empty failure catalog', async () => {
  const f = fixture();
  f.server.deferSessionPromptInventory(f.original);
  await Promise.resolve();
  f.inventory.resolve({
    ...snapshot(),
    systemPrompts: undefined,
    initialContextEstimate: { tokens: 123, contextWindow: 1000 },
    snapshotUnavailable: { code: 'SESSION_SNAPSHOT_TOO_LARGE', message: 'Catalog cannot fit.' },
  });
  await flush();
  assert.deepEqual(f.events[0]?.payload, {
    sessionPath: f.original.session.path,
    token: f.original.promptInventoryToken,
    systemPrompts: [],
  });
});

test('a fresh snapshot without cold ownership cannot publish inventory', async () => {
  const f = fixture();
  f.server.coldSessionStore.ownershipStamp = (payload: unknown) => payload === f.original ? [{}] : undefined;
  f.server.deferSessionPromptInventory(f.original);
  await Promise.resolve();
  f.inventory.resolve(snapshot());
  await flush();
  assert.deepEqual(f.events, []);
});

test('real open handler emits and acknowledges before deferred inventory resolves', async () => {
  const f = fixture();
  let args: unknown[] = [];
  const deps = {
    buildSessionOpenedPayload: async (...received: unknown[]) => { args = received; return f.original; },
    deferSessionPromptInventory: (payload: SessionOpenedPayload) => f.server.deferSessionPromptInventory(payload),
    setViewedSessionPath: () => {},
    getSessionContext: () => undefined,
    emitSessionListChanged: async () => {},
    emit: f.server.emit,
  } as unknown as BackendRequestHandlerDeps;
  const ack = await handleBackendRequest(deps, {
    id: 'open', method: 'session.open', params: { sessionPath: f.original.session.path },
  });
  assert.equal(args[8], false);
  assert.deepEqual(ack, { ok: true, sessionPath: f.original.session.path });
  assert.equal(f.builds(), 1);
  assert.deepEqual(f.events.map(({ event }) => event), ['session.opened']);
  const token = f.original.promptInventoryToken;
  assert.ok(token);
  const complete = { ...snapshot(), systemPrompts: [{ id: 'prompt' }] } as unknown as SessionOpenedPayload;
  f.inventory.resolve(complete);
  await flush();
  assert.deepEqual(f.events.map(({ event }) => event), ['session.opened', 'session.promptInventory']);
  assert.deepEqual(f.events[1].payload, { sessionPath: f.original.session.path, token, systemPrompts: complete.systemPrompts });
});

for (const kind of ['fingerprint', 'hot', 'forgotten', 'disposed']) {
  test(`deferred inventory fences ${kind} before discovery and after discovery`, async () => {
    for (const before of [true, false]) {
      const f = fixture();
      f.server.deferSessionPromptInventory(f.original);
      if (!before) await Promise.resolve();
      f.invalidate(kind);
      f.inventory.resolve(snapshot());
      await flush();
      assert.equal(f.builds(), before ? 0 : 1);
      assert.deepEqual(f.events, []);
    }
  });
}

test('inventory tokens are unique per open and final publication rechecks original ownership', async () => {
  const f = fixture();
  f.server.deferSessionPromptInventory(f.original);
  const other = snapshot();
  f.server.deferSessionPromptInventory(other);
  assert.notEqual(other.promptInventoryToken, f.original.promptInventoryToken);
  await Promise.resolve();
  f.server.coldSessionStore.publishSync = (_payload: unknown, publish: () => void) => {
    f.invalidate('fingerprint');
    publish();
  };
  f.inventory.resolve(snapshot());
  await flush();
  assert.deepEqual(f.events, []);
});
