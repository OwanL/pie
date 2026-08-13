import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { ServiceLoadingGateDisposedError } from '../../../src/backend/runtime-factory';
import type { RuntimeDisposeScheduler } from '../../../src/backend/server';
import { BackendError } from '../../../src/backend/server-io';

/**
 * Deterministic fake-SDK coverage for the backend-wide service-loading
 * admission gate (`ServiceLoadingGate` in runtime-factory.ts):
 *  1. at most one `createAgentSessionServices` in flight per BackendServer;
 *  2. FIFO admission order across sessions/cwds/factories sharing the gate;
 *  3. every admitted call produces unique fresh services (never cached/shared);
 *  4. `createAgentSessionFromServices` runs OUTSIDE the gate;
 *  5. a failing service creation releases the slot so the queue advances;
 *  6. disposal rejects queued work, refuses new admissions, and disposes
 *     late-created runtimes through the server's ownership check instead of
 *     installing them.
 *
 * Mirrors the cast-to-any + stubbed-internals pattern of
 * `backend-editor-version.test.ts` / `backend-disposal-robustness.test.ts` so
 * the private seams (`server.createRuntimeFactory()`,
 * `server.createSessionContext()`) can be exercised without a real SDK.
 */

/** Deterministic microtask/macrotask flush: everything in these tests settles
 *  through promise continuations only, so one setImmediate is a stable
 *  observation point. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeServicesCall {
  index: number;
  options: unknown;
  promise: Promise<unknown>;
  resolve: (services: unknown) => void;
  reject: (error: unknown) => void;
}

function makeSessionManager(sessionPath: string): any {
  return {
    getCwd: () => '/workspace',
    getSessionFile: () => sessionPath,
    getSessionName: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
  };
}

/**
 * A minimal fake SdkModule whose `createAgentSessionServices` suspends on a
 * per-call deferred so tests control admission timing exactly. Each call
 * records its own options; callers resolve each with unique services objects.
 * `createAgentSessionFromServices` and `createAgentSessionRuntime` are
 * immediate wrappers (overridable per test).
 */
function makeFakeSdk(onServicesStart?: (index: number) => void): {
  sdk: any;
  servicesCalls: FakeServicesCall[];
} {
  const servicesCalls: FakeServicesCall[] = [];
  let servicesSeq = 0;
  const sdk = {
    VERSION: 'fake-sdk',
    getAgentDir: () => '/agent',
    AuthStorage: { create: () => ({ kind: 'auth-storage' }) },
    SessionManager: {
      continueRecent: () => makeSessionManager('/s.json'),
      create: () => makeSessionManager('/s.json'),
      open: () => makeSessionManager('/s.json'),
      forkFrom: () => makeSessionManager('/s.json'),
      listAll: async () => [],
    },
    createAgentSessionServices: (options: unknown) => {
      const call = deferred<unknown>();
      const entry: FakeServicesCall = {
        index: servicesSeq,
        options,
        promise: call.promise,
        resolve: (services) => call.resolve(services),
        reject: (error) => call.reject(error),
      };
      servicesSeq += 1;
      servicesCalls.push(entry);
      onServicesStart?.(entry.index);
      return call.promise;
    },
    createAgentSessionFromServices: async (options: any) => ({
      services: options.services,
      session: {
        sessionFile: options.sessionManager.getSessionFile(),
        isStreaming: false,
        messages: [],
        sessionManager: options.sessionManager,
        subscribe: () => () => undefined,
      },
    }),
    createAgentSessionRuntime: async (factory: any, options: any) => {
      const result = await factory(options);
      return {
        session: result.session,
        services: result.services,
        dispose: async () => undefined,
      };
    },
  };
  return { sdk, servicesCalls };
}

function makeServer(sdk: any): any {
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace' }) as any;
  server.sdk = sdk;
  server.agentDir = '/agent';
  server.authStorage = { kind: 'auth-storage' };
  return server;
}

const factoryArgs = (cwd: string, sessionPath: string) => ({
  cwd,
  agentDir: '/agent',
  sessionManager: makeSessionManager(sessionPath),
});

test('service loading admits at most one createAgentSessionServices at a time and never shares services', async () => {
  const starts: number[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => starts.push(index));
  const server = makeServer(sdk);

  // Each session open gets its own factory; both share the server's gate.
  const factoryA = server.createRuntimeFactory();
  const factoryB = server.createRuntimeFactory();
  assert.notEqual(factoryA, factoryB, 'each session receives a distinct runtime factory');

  const firstArgs = factoryArgs('/workspace-a', '/a.json');
  const secondArgs = factoryArgs('/workspace-b', '/b.json');
  const first = factoryA(firstArgs);
  const second = factoryB(secondArgs);
  await tick();

  assert.deepEqual(starts, [0], 'only the first creation may be in flight (max concurrency 1)');
  assert.equal(servicesCalls.length, 1);

  // Resolve the admitted call: the queued call may start only after it settles.
  servicesCalls[0].resolve({ id: 'services-0' });
  const firstResult = await first;
  await tick();
  assert.deepEqual(starts, [0, 1], 'the second creation starts only after the first settles');

  servicesCalls[1].resolve({ id: 'services-1' });
  const secondResult = await second;

  // Unique fresh services per session — nothing is cached or shared.
  assert.notEqual(firstResult.services, secondResult.services);
  assert.equal(firstResult.services.id, 'services-0');
  assert.equal(secondResult.services.id, 'services-1');
  // Each creation saw its own per-session inputs (cwd flows through).
  assert.equal((servicesCalls[0].options as any).cwd, '/workspace-a');
  assert.equal((servicesCalls[1].options as any).cwd, '/workspace-b');
  assert.notEqual((servicesCalls[0].options as any).cwd, (servicesCalls[1].options as any).cwd);
});

test('service loading is FIFO across sessions sharing the gate', async () => {
  const starts: number[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => starts.push(index));
  const server = makeServer(sdk);

  const calls = [0, 1, 2].map((index) =>
    server.createRuntimeFactory()(factoryArgs(`/workspace-${index}`, `/fifo-${index}.json`)),
  );
  await tick();
  assert.deepEqual(starts, [0], 'only the first of three is admitted');

  servicesCalls[0].resolve({ id: 'fifo-0' });
  await calls[0];
  await tick();
  assert.deepEqual(starts, [0, 1], 'the second is admitted before the third (FIFO)');

  servicesCalls[1].resolve({ id: 'fifo-1' });
  await calls[1];
  await tick();
  assert.deepEqual(starts, [0, 1, 2], 'the third starts only after the second settles');

  servicesCalls[2].resolve({ id: 'fifo-2' });
  const results = await Promise.all(calls);
  assert.deepEqual(
    results.map((result) => result.services.id),
    ['fifo-0', 'fifo-1', 'fifo-2'],
    'completion order matches enqueue order',
  );
});

test('createAgentSessionFromServices runs outside the admission gate', async () => {
  const sequence: string[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => sequence.push(`services:start:${index}`));
  const fromGate = deferred<unknown>();
  sdk.createAgentSessionFromServices = async (options: any) => {
    sequence.push('from:start');
    await fromGate.promise;
    return {
      services: options.services,
      session: {
        sessionFile: options.sessionManager.getSessionFile(),
        isStreaming: false,
        messages: [],
        sessionManager: options.sessionManager,
        subscribe: () => () => undefined,
      },
    };
  };
  const server = makeServer(sdk);

  const first = server.createRuntimeFactory()(factoryArgs('/workspace-out', '/outside.json'));
  const second = server.createRuntimeFactory()(factoryArgs('/workspace-out-2', '/outside-2.json'));
  await tick();
  assert.deepEqual(sequence, ['services:start:0']);

  // The gate releases as soon as services creation settles — even while the
  // first session's createAgentSessionFromServices is still suspended, the
  // second services creation must be admitted. If from-services were inside
  // the gate, `services:start:1` could not appear until `from:start` settled.
  servicesCalls[0].resolve({ id: 'outside-0' });
  await tick();
  assert.ok(sequence.includes('from:start'), 'from-services began after services resolved');
  assert.ok(
    sequence.includes('services:start:1'),
    'the next services creation starts while from-services is still suspended (not gated)',
  );

  fromGate.resolve(undefined);
  servicesCalls[1].resolve({ id: 'outside-1' });
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.services.id),
    ['outside-0', 'outside-1'],
  );
});

test('a failing service creation releases the gate and the next caller proceeds', async () => {
  const starts: number[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => starts.push(index));
  const server = makeServer(sdk);

  const first = server.createRuntimeFactory()(factoryArgs('/workspace-fail', '/fail.json'));
  const second = server.createRuntimeFactory()(factoryArgs('/workspace-after', '/after-fail.json'));
  await tick();
  assert.deepEqual(starts, [0]);

  servicesCalls[0].reject(new Error('services exploded'));
  await assert.rejects(first, /services exploded/, 'the caller observes the original failure');

  await tick();
  assert.deepEqual(starts, [0, 1], 'a failure must release the slot so the queue advances');

  servicesCalls[1].resolve({ id: 'after-fail' });
  const secondResult = await second;
  assert.equal(secondResult.services.id, 'after-fail');
});

test('dispose rejects queued service loading, refuses new admissions, and lets admitted work settle', async () => {
  const starts: number[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => starts.push(index));
  const server = makeServer(sdk);
  const factory = server.createRuntimeFactory();

  const admitted = factory(factoryArgs('/workspace-adm', '/admitted.json'));
  await tick();
  assert.deepEqual(starts, [0]);

  const queued = factory(factoryArgs('/workspace-queued', '/queued.json'));
  await tick();
  assert.deepEqual(starts, [0], 'the second call is queued behind the admitted one');
  const queuedRejection = assert.rejects(queued, ServiceLoadingGateDisposedError);

  await server.dispose();

  await queuedRejection;
  await assert.rejects(
    factory(factoryArgs('/workspace-late', '/after-dispose.json')),
    ServiceLoadingGateDisposedError,
    'new admissions are refused after disposal',
  );

  // An admitted in-flight creation is allowed to settle (it cannot be
  // cancelled); the server's ownership check handles its late runtime.
  servicesCalls[0].resolve({ id: 'admitted' });
  const admittedResult = await admitted;
  assert.equal(admittedResult.services.id, 'admitted');
});

test('a wedged late runtime disposer settles at the controlled bound and never installs the runtime', async () => {
  let releaseGrace: (() => void) | undefined;
  let graceTimerCleared = false;
  const scheduler: RuntimeDisposeScheduler = {
    setTimeout: (callback) => {
      releaseGrace = callback;
      return {} as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      graceTimerCleared = true;
    },
  };
  const { sdk, servicesCalls } = makeFakeSdk();
  let disposeCalled = false;
  const disposeStarted = deferred<void>();
  sdk.createAgentSessionRuntime = async (factory: any, options: any) => {
    const result = await factory(options);
    return {
      session: result.session,
      services: result.services,
      dispose: () => {
        disposeCalled = true;
        disposeStarted.resolve(undefined);
        return new Promise<void>(() => undefined);
      },
    };
  };
  const server = new BackendServer({ sdkPath: '/unused', cwd: '/workspace', runtimeDisposeScheduler: scheduler }) as any;
  server.sdk = sdk;
  server.agentDir = '/agent';
  server.authStorage = { kind: 'auth-storage' };

  const creation = server.createSessionContext(makeSessionManager('/wedged-late.json'), 'resume');
  const creationRejection = assert.rejects(
    creation,
    (error: unknown) => error instanceof BackendError && error.code === 'SERVER_SHUTTING_DOWN',
  );
  await tick();
  assert.equal(servicesCalls.length, 1);

  await server.dispose();
  servicesCalls[0].resolve({ id: 'wedged-late-services' });
  // Wait for the ownership rejection to invoke the disposer, rather than
  // waiting on filesystem or wall-clock timing. If the disposal policy is
  // accidentally bypassed, the disposer still signals here but no grace
  // callback will be armed below.
  await disposeStarted.promise;
  assert.equal(disposeCalled, true, 'the late runtime disposer is still invoked');
  assert.equal(server.sessionContexts.size, 0, 'the late runtime is never installed');
  assert.equal(releaseGrace !== undefined, true, 'the bounded-disposal grace was armed');
  let settled = false;
  void creationRejection.finally(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'a wedged disposer remains pending before the controlled bound');

  releaseGrace!();
  await creationRejection;
  assert.equal(graceTimerCleared, true, 'the bounded-disposal timer is cleaned up after settlement');
  assert.equal(server.sessionContexts.size, 0, 'the rejected runtime remains uninstalled');
});

test('a runtime created after disposal is not installed and is disposed through the ownership check', async () => {
  const starts: number[] = [];
  const disposed: string[] = [];
  const { sdk, servicesCalls } = makeFakeSdk((index) => starts.push(index));
  // Instrument the runtime so we can prove the late-created runtime was
  // disposed exactly once instead of leaking.
  sdk.createAgentSessionRuntime = async (factory: any, options: any) => {
    const result = await factory(options);
    return {
      session: result.session,
      services: result.services,
      dispose: async () => { disposed.push('runtime'); },
    };
  };
  const server = makeServer(sdk);

  // Session open begins while the server is live; its services creation is
  // admitted and suspended.
  const creation = server.createSessionContext(makeSessionManager('/late.json'), 'resume');
  const creationRejection = assert.rejects(
    creation,
    (error: unknown) => error instanceof BackendError && error.code === 'SERVER_SHUTTING_DOWN',
  );
  await tick();
  assert.deepEqual(starts, [0]);
  assert.equal(server.sessionContexts.size, 0);

  await server.dispose();

  // The admitted creation completes after disposal: the runtime is created,
  // but the server must refuse to install it and dispose it instead.
  servicesCalls[0].resolve({ id: 'late-services' });
  await creationRejection;

  assert.deepEqual(disposed, ['runtime'], 'the late-created runtime is disposed exactly once');
  assert.equal(server.sessionContexts.size, 0, 'the late runtime is never installed');
});
