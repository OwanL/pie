import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import type { RequestEnvelope } from '../../../src/shared/protocol';

interface TransitionRoute {
  state: 'transitioning';
  completion: Promise<unknown>;
}

interface TransitionRouterStub {
  getRoute(sessionPath: string): TransitionRoute | { state: 'hot' | 'cold' };
  hasHotOwner(sessionPath: string): boolean;
  interrupt(sessionPath: string, reason: string): Promise<{ soft: boolean }>;
}

interface ServerTransitionTestPort {
  handleRequest(request: RequestEnvelope, onRequestValidated?: () => void): Promise<unknown>;
  workerRuntimeRouter: TransitionRouterStub;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createServer(router: TransitionRouterStub): ServerTransitionTestPort {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/repo', workerEntryPath: '/worker.js' });
  const port = server as unknown as ServerTransitionTestPort;
  port.workerRuntimeRouter = router;
  return port;
}

test('session.viewed remains runtime-free while the viewed session route is transitioning', async () => {
  const transition = deferred<unknown>();
  const sessionPath = '/repo/session.jsonl';
  const port = createServer({
    getRoute: () => ({ state: 'transitioning', completion: transition.promise }),
    hasHotOwner: () => false,
    interrupt: async () => ({ soft: true }),
  });

  const result = await port.handleRequest({
    id: 'view-during-transition',
    method: 'session.viewed',
    params: { sessionPath, previousSessionPath: '/repo/previous.jsonl' },
  });

  assert.deepEqual(result, { ok: true, sessionPath, changed: true });
  // The notification must not join or wait for the runtime transition.
  transition.resolve(undefined);
});

test('message.interrupt serializes behind a hot transition and targets only the current owner', async () => {
  const transition = deferred<unknown>();
  const sessionPath = '/repo/session.jsonl';
  let transitioned = false;
  const interruptCalls: Array<{ sessionPath: string; reason: string }> = [];
  const port = createServer({
    getRoute: () => transitioned
      ? { state: 'hot' }
      : { state: 'transitioning', completion: transition.promise },
    hasHotOwner: () => transitioned,
    interrupt: async (path, reason) => {
      interruptCalls.push({ sessionPath: path, reason });
      return { soft: true };
    },
  });
  let validated = 0;
  let settled = false;
  const request = port.handleRequest({
    id: 'interrupt-during-transition',
    method: 'message.interrupt',
    params: { sessionPath },
  }, () => { validated += 1; }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(validated, 1, 'the accepted user action is validated immediately');
  assert.equal(settled, false, 'the interrupt cannot race the replacement owner');
  assert.equal(interruptCalls.length, 0);

  transitioned = true;
  transition.resolve(undefined);
  assert.deepEqual(await request, { interrupted: true, settled: true });
  assert.equal(interruptCalls.length, 1);
  assert.equal(interruptCalls[0]?.sessionPath, sessionPath);
  assert.match(interruptCalls[0]?.reason ?? '', /after session transition/);
});

test('message.interrupt succeeds after a transition settles cold with no live turn', async () => {
  const transition = deferred<unknown>();
  const sessionPath = '/repo/session.jsonl';
  const port = createServer({
    getRoute: () => ({ state: 'transitioning', completion: transition.promise }),
    hasHotOwner: () => false,
    interrupt: async () => { throw new Error('must not target a retired owner'); },
  });

  const request = port.handleRequest({
    id: 'interrupt-retired-transition',
    method: 'message.interrupt',
    params: { sessionPath },
  });
  transition.reject(new Error('promotion failed after retirement'));
  assert.deepEqual(await request, { interrupted: true, settled: true });
});
