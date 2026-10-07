import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { createWorkerEntryHandlers } from '../worker-entry';
import type { WorkerServer, WorkerServerIdentity } from '../../lib/rpc/worker-server.js';
import type { CoordinatorToWorkerFrame } from '../../lib/rpc/worker-protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { failPromotion?: boolean } = {}) {
  const calls: string[] = [];
  const resources: { disposed: boolean }[] = [];
  const load = deferred<any>();
  const verification = deferred<any>();
  const promotion = deferred<void>();
  const sdkRuntime = createSyntheticSourceTestSdkRuntime(path.resolve('unused-sdk'));
  class Host {
    constructor() { calls.push('create'); }
    applySync(domain: string, revision: number) { calls.push(`sync:${domain}:${revision}`); }
    async promote() {
      calls.push('promote');
      await promotion.promise;
      // Model SDK/factory loading that installs a context only after its await.
      resources.push({ disposed: false });
      calls.push('create-context');
      if (options.failPromotion) throw new Error('controlled promotion failure');
    }
    async interrupt() { calls.push('interrupt'); }
    async dispose() {
      calls.push('dispose');
      for (const resource of resources) {
        resource.disposed = true;
        calls.push('dispose-context');
      }
    }
  }
  const handlers = createWorkerEntryHandlers({ workerId: 'worker', coordinatorGeneration: 1, workerGeneration: 1 } as WorkerServerIdentity, {
    loadHost: async () => { calls.push('load'); return load.promise; },
    verifyRuntime: async () => { calls.push('verify'); return verification.promise; },
  });
  const server = { sendFrame: (frame: { kind: string }) => { calls.push(frame.kind); } } as unknown as WorkerServer;
  const frame = (value: object) => value as CoordinatorToWorkerFrame;
  const dispatch = (value: object) => Promise.resolve(handlers.onFrame!(frame(value), server));
  const bootstrap = () => Promise.resolve(handlers.validateBootstrap!(frame({ kind: 'bootstrap', sdkRuntime }) as never));
  const shutdown = () => Promise.resolve(handlers.onShutdown!(frame({ kind: 'shutdown' }) as never));
  const interrupt = () => Promise.resolve(handlers.onInterrupt!(frame({ kind: 'interrupt' }) as never));
  const promote = () => dispatch({ kind: 'runtime.promote', requestId: 'promotion', payload: {} });
  return { calls, resources, load, verification, promotion, Host, sdkRuntime, dispatch, bootstrap, shutdown, interrupt, promote };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('importing the actual worker entry leaves the promotion-only host module unevaluated', () => {
  assert.equal(Object.keys(require.cache).some(file => /[/\\]worker-runtime-host\.[cm]?[jt]s$/.test(file)), false);
});

test('bootstrap finishes full verification without loading the promotion host', async () => {
  const f = fixture();
  let verified = false;
  const bootstrap = f.bootstrap().then(() => { verified = true; });
  await tick();
  assert.equal(verified, false);
  assert.deepEqual(f.calls, ['verify']);
  f.verification.resolve(f.sdkRuntime);
  await bootstrap;
  await f.shutdown();
  assert.deepEqual(f.calls, ['verify']);
});

test('concurrent promotions share creation; load-time sync and interrupt remain admitted', async () => {
  const f = fixture();
  f.verification.resolve(f.sdkRuntime);
  await f.bootstrap();
  await f.dispatch({ kind: 'sync', domain: 'settings', revision: 1, payload: {} });
  const first = f.promote();
  const second = f.promote();
  const interrupt = f.interrupt();
  await f.dispatch({ kind: 'sync', domain: 'settings', revision: 2, payload: {} });
  await f.dispatch({ kind: 'sync', domain: 'auth', revision: 1, payload: {} });
  assert.deepEqual(f.calls, ['verify', 'load']);
  f.load.resolve({ WorkerRuntimeHost: f.Host });
  await interrupt;
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  assert.ok(f.calls.indexOf('sync:settings:2') < f.calls.indexOf('promote'));
  assert.ok(f.calls.indexOf('sync:auth:1') < f.calls.indexOf('promote'));
  assert.ok(f.calls.includes('interrupt'), 'interrupt settles without waiting for promotion');
  assert.ok(!f.calls.includes('runtime.ready'));
  f.promotion.resolve();
  await Promise.all([first, second]);
  await f.shutdown();
  assert.equal(f.calls.filter((call) => call === 'dispose').length, 1);
  assert.equal(f.resources.length, 2);
  assert.ok(f.resources.every((resource) => resource.disposed));
});

test('shutdown joins pending load and fences late construction and readiness', async () => {
  const f = fixture();
  f.verification.resolve(f.sdkRuntime);
  await f.bootstrap();
  const promotion = f.promote();
  const interrupt = f.interrupt();
  let stopped = false;
  const shutdown = f.shutdown().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  f.load.resolve({ WorkerRuntimeHost: f.Host });
  await Promise.all([promotion, interrupt, shutdown]);
  await f.promote();
  assert.deepEqual(f.calls, ['verify', 'load']);
});

test('failed module load is shared and shutdown still settles', async () => {
  const f = fixture();
  f.verification.resolve(f.sdkRuntime);
  await f.bootstrap();
  const promotion = assert.rejects(f.promote(), /controlled load failure/);
  const second = assert.rejects(f.promote(), /controlled load failure/);
  f.load.reject(new Error('controlled load failure'));
  await Promise.all([promotion, second, f.shutdown()]);
  assert.deepEqual(f.calls, ['verify', 'load']);
});

test('shutdown joins concurrent promotions before disposing late contexts and acknowledging', async () => {
  const f = fixture();
  f.verification.resolve(f.sdkRuntime);
  await f.bootstrap();
  const first = f.promote();
  const second = f.promote();
  f.load.resolve({ WorkerRuntimeHost: f.Host });
  await tick();
  let acknowledged = false;
  const shutdown = f.shutdown().then(() => {
    assert.equal(f.resources.length, 2);
    assert.ok(f.resources.every((resource) => resource.disposed));
    f.calls.push('shutdown.ack');
    acknowledged = true;
  });
  await tick();
  assert.equal(acknowledged, false);
  assert.equal(f.resources.length, 0);
  assert.ok(!f.calls.includes('dispose'));
  await f.promote(); // No admission after shutdown, even with an existing host.
  assert.equal(f.calls.filter((call) => call === 'promote').length, 2);
  f.promotion.resolve();
  await Promise.all([first, second, shutdown]);
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call === 'dispose').length, 1);
  assert.ok(f.calls.lastIndexOf('create-context') < f.calls.indexOf('dispose'));
  assert.ok(f.calls.lastIndexOf('dispose-context') < f.calls.indexOf('shutdown.ack'));
  assert.ok(!f.calls.includes('runtime.ready'));
});

test('failed admitted promotions retain their errors and dispose late contexts before shutdown settles', async () => {
  const f = fixture({ failPromotion: true });
  f.verification.resolve(f.sdkRuntime);
  await f.bootstrap();
  const first = assert.rejects(f.promote(), /controlled promotion failure/);
  const second = assert.rejects(f.promote(), /controlled promotion failure/);
  f.load.resolve({ WorkerRuntimeHost: f.Host });
  await tick();
  let stopped = false;
  const shutdown = f.shutdown().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  assert.ok(!f.calls.includes('dispose'));
  f.promotion.resolve();
  await Promise.all([first, second, shutdown]);
  assert.equal(f.calls.filter((call) => call === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call === 'dispose').length, 1);
  assert.equal(f.resources.length, 2);
  assert.ok(f.resources.every((resource) => resource.disposed));
  assert.ok(!f.calls.includes('runtime.ready'));
});
