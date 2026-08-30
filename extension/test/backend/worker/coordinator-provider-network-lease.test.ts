import assert from 'node:assert/strict';
import test from 'node:test';

import { CoordinatorProviderNetworkLeaseAuthority } from '../../../src/backend/coordinator-provider-network-lease';
import { installWorkerProviderNetworkLease } from '../../../src/backend/worker-provider-network-lease';
import { observeProviderTransport } from '../../../src/backend/provider-progress-bus';

const owner = (workerId: string, workerGeneration = 1) => ({ coordinatorGeneration: 1, workerId, workerGeneration });

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly now = (): number => this.nowMs;

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, delayMs), callback });
    return id;
  };

  readonly clearTimeout = (timer: unknown): void => {
    if (typeof timer === 'number') this.timers.delete(timer);
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = target;
  }
}

test('coordinator provider authority enforces capacity per provider and releases exactly once', async () => {
  const authority = new CoordinatorProviderNetworkLeaseAuthority();
  const first = await authority.acquire(owner('a'), 'request-a', { provider: 'p', model: 'm' });
  let secondSettled = false;
  const secondPromise = authority.acquire(owner('b'), 'request-b', { provider: 'p', model: 'm2' }).then((lease) => {
    secondSettled = true;
    return lease;
  });
  const independent = await authority.acquire(owner('c'), 'request-c', { provider: 'p2', model: 'm3' });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  assert.equal(independent.provider, 'p2', 'independent providers do not share capacity');
  assert.equal(authority.release(owner('a'), first.leaseId, 'completed'), true);
  assert.equal(authority.release(owner('a'), first.leaseId, 'completed'), false);
  const second = await secondPromise;
  assert.equal(second.provider, 'p');
  authority.releaseOwner(owner('b'));
  authority.releaseOwner(owner('c'));
  assert.deepEqual(authority.inspect(), { queued: 0 });
});

test('coordinator cancels the exact queued admission and releases a just-granted lease once', async () => {
  const authority = new CoordinatorProviderNetworkLeaseAuthority();
  const first = await authority.acquire(owner('a'), 'active-a', { provider: 'p', model: 'a' });
  const queuedB = authority.acquire(owner('b'), 'queued-b', { provider: 'p', model: 'b' });
  const queuedC = authority.acquire(owner('c'), 'queued-c', { provider: 'p', model: 'c' });
  const cancelledB = authority.cancel(owner('b'), 'queued-b', 'fixture abort');
  assert.deepEqual(cancelledB, { status: 'queued', notifyAcquire: true });
  await assert.rejects(queuedB, (error: Error) => error.name === 'AbortError');
  assert.equal(authority.inspect().queued, 1);

  authority.release(owner('a'), first.leaseId, 'completed');
  const third = await queuedC;
  authority.markDelivered(owner('c'), 'queued-c', third.leaseId);
  const cancelledGranted = authority.cancel(owner('c'), 'queued-c', 'late abort');
  assert.deepEqual(cancelledGranted, { status: 'granted', leaseId: third.leaseId, notifyAcquire: false });
  assert.equal(authority.release(owner('c'), third.leaseId, 'cancelled'), false, 'cancel already released the grant');
  assert.deepEqual(authority.inspect(), { queued: 0 });
});

test('coordinator cancellation wins the release-to-grant microtask race without leaking capacity', async () => {
  const authority = new CoordinatorProviderNetworkLeaseAuthority();
  const first = await authority.acquire(owner('a'), 'first', { provider: 'p', model: 'a' });
  const raced = authority.acquire(owner('b'), 'raced', { provider: 'p', model: 'b' });
  authority.release(owner('a'), first.leaseId, 'completed');
  const cancellation = authority.cancel(owner('b'), 'raced', 'interrupt raced grant');
  assert.equal(cancellation.status, 'granted');
  assert.equal(cancellation.notifyAcquire, true);
  const racedLease = await raced;
  assert.equal(authority.isActive(owner('b'), 'raced', racedLease.leaseId), false);
  const next = await authority.acquire(owner('c'), 'next', { provider: 'p', model: 'c' });
  assert.equal(authority.isActive(owner('c'), 'next', next.leaseId), true);
  authority.releaseOwner(owner('c'));
});

test('coordinator provider circuits are global and allow exactly one half-open probe', async () => {
  let now = 100;
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: () => now,
    defaultPolicy: { circuitFailureThreshold: 2, circuitResetMs: 50 },
  });
  const failedA = await authority.acquire(owner('a'), 'failed-a', { provider: 'p', model: 'm' });
  authority.release(owner('a'), failedA.leaseId, 'failed');
  const failedB = await authority.acquire(owner('b'), 'failed-b', { provider: 'p', model: 'm' });
  authority.release(owner('b'), failedB.leaseId, 'failed');
  await assert.rejects(
    authority.acquire(owner('c'), 'blocked-c', { provider: 'p', model: 'm' }),
    (error: Error) => error.name === 'ProviderCircuitOpenError',
  );

  now = 150;
  const probe = await authority.acquire(owner('c'), 'probe-c', { provider: 'p', model: 'm' });
  let secondProbeSettled = false;
  const secondProbe = authority.acquire(owner('d'), 'probe-d', { provider: 'p', model: 'm' }).then((lease) => {
    secondProbeSettled = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(secondProbeSettled, false, 'only one global half-open probe may run');
  authority.release(owner('c'), probe.leaseId, 'completed');
  const admitted = await secondProbe;
  assert.equal(admitted.provider, 'p');
  authority.releaseOwner(owner('d'));
});

test('non-retryable provider observations do not poison the global circuit', async () => {
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    defaultPolicy: { circuitFailureThreshold: 1 },
  });
  const lease = await authority.acquire(owner('a'), 'bad-input', { provider: 'p', model: 'm' });
  assert.equal(authority.observe(owner('a'), lease.leaseId, {
    classification: 'http-error', status: 400, retryable: false,
  }), true);
  authority.release(owner('a'), lease.leaseId, 'failed');
  const healthyTransport = await authority.acquire(owner('b'), 'next', { provider: 'p', model: 'm' });
  assert.equal(healthyTransport.provider, 'p');
  authority.releaseOwner(owner('b'));
});

test('coordinator provider policy updates capacity in place', async () => {
  const authority = new CoordinatorProviderNetworkLeaseAuthority();
  const first = await authority.acquire(owner('a'), 'a', { provider: 'p', model: 'm' });
  let settled = false;
  const secondPromise = authority.acquire(owner('b'), 'b', { provider: 'p', model: 'm' }).then((lease) => {
    settled = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  authority.updatePolicies({ p: { maxConcurrentRequests: 2 } });
  const second = await secondPromise;
  assert.equal(settled, true);
  authority.release(owner('a'), first.leaseId, 'completed');
  authority.release(owner('b'), second.leaseId, 'completed');
});

test('coordinator provider authority expires queued admission at its exact injected-clock deadline', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    defaultPolicy: { queueWaitMs: 100 },
  });
  const active = await authority.acquire(owner('a'), 'active', { provider: 'p', model: 'm' });
  assert.equal(clock.pendingTimers, 0, 'an immediately granted admission clears its queue timer');
  const timeout = authority.acquire(owner('b'), 'queued', { provider: 'p', model: 'm' }).then(
    () => undefined,
    (error: Error) => error,
  );
  assert.equal(clock.pendingTimers, 1);
  authority.updatePolicies({ p: { queueWaitMs: 1_000 } });
  clock.advance(99);
  assert.equal(authority.inspect().queued, 1);
  clock.advance(1);
  const error = await timeout;
  assert.equal(error?.name, 'ProviderGateSaturatedError');
  assert.match(error?.message ?? '', /waited 100ms/);
  assert.equal((error as Error & { isRetryable?: boolean }).isRetryable, true);
  assert.equal(authority.inspect().queued, 0);
  assert.equal(clock.pendingTimers, 0);
  authority.release(owner('a'), active.leaseId, 'completed');
});

test('coordinator policies expose base metrics and grant worker transport bounds', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  authority.updatePolicies({
    p: {
      maxConcurrentRequests: 2,
      queueWaitSeconds: 1.5,
      headerWaitSeconds: 2.5,
      streamIdleTimeoutMs: 3_500,
    },
    q: { maxConcurrentRequests: 4, queueWaitMs: 75, headerWaitMs: 125 },
  });
  assert.deepEqual(authority.getMetrics(), [
    {
      provider: 'p', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 2,
      afterburnSeconds: 0, queueWaitSeconds: 1.5, paused: false, pausedUntilMs: 0, strikeCount: 0,
    },
    {
      provider: 'q', activeRequests: 0, queuedRequests: 0, maxConcurrentRequests: 4,
      afterburnSeconds: 0, queueWaitSeconds: 0.075, paused: false, pausedUntilMs: 0, strikeCount: 0,
    },
  ]);

  const first = await authority.acquire(owner('a'), 'first', { provider: 'p', model: 'm1' });
  const second = await authority.acquire(owner('b'), 'second', { provider: 'p', model: 'm2' });
  const thirdPromise = authority.acquire(owner('c'), 'third', { provider: 'p', model: 'm3' });
  assert.equal(first.headerWaitMs, 2_500);
  assert.equal(first.streamIdleTimeoutMs, 3_500);
  assert.equal(second.headerWaitMs, 2_500);
  assert.equal(clock.pendingTimers, 1);
  assert.deepEqual(authority.getMetrics()[0], {
    provider: 'p', activeRequests: 2, queuedRequests: 1, maxConcurrentRequests: 2,
    afterburnSeconds: 0, queueWaitSeconds: 1.5, paused: false, pausedUntilMs: 0, strikeCount: 0,
  });

  authority.release(owner('a'), first.leaseId, 'completed');
  const third = await thirdPromise;
  assert.equal(third.headerWaitMs, 2_500);
  assert.equal(third.streamIdleTimeoutMs, 3_500);
  assert.equal(clock.pendingTimers, 0, 'grant clears the queued admission deadline');
  authority.releaseOwner(owner('b'));
  authority.releaseOwner(owner('c'));

  const base = await authority.acquire(owner('base'), 'base', { provider: 'unconfigured', model: 'm' });
  assert.equal(base.headerWaitMs, 120_000);
  assert.equal(base.streamIdleTimeoutMs, 120_000);
  authority.releaseOwner(owner('base'));
});

test('coordinator normalizes provider deadlines to finite positive integer milliseconds', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  authority.updatePolicies({
    p: {
      maxConcurrentRequests: 1,
      queueWaitSeconds: 0,
      headerWaitSeconds: 0.0001,
      streamIdleTimeoutSeconds: 999_999,
    },
  });

  const active = await authority.acquire(owner('a'), 'active-normalized', { provider: 'p', model: 'm' });
  assert.equal(active.headerWaitMs, 1);
  assert.equal(active.streamIdleTimeoutMs, 300_000);
  const queued = authority.acquire(owner('b'), 'queued-normalized', { provider: 'p', model: 'm' }).then(
    () => undefined,
    (error: Error) => error,
  );
  clock.advance(299_999);
  assert.equal(authority.inspect().queued, 1);
  clock.advance(1);
  assert.equal((await queued)?.name, 'ProviderGateSaturatedError');
  authority.release(owner('a'), active.leaseId, 'completed');
});

test('coordinator afterburn reserves capacity for the same worker and releases it on expiry', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  authority.updatePolicies({
    p: { maxConcurrentRequests: 1, afterburnSeconds: 10, queueWaitSeconds: 30 },
  });
  assert.equal(authority.getMetrics()[0]?.afterburnSeconds, 10);

  const first = await authority.acquire(owner('a'), 'afterburn-first', { provider: 'p', model: 'm' });
  authority.release(owner('a'), first.leaseId, 'completed');

  let otherSettled = false;
  const other = authority.acquire(owner('b'), 'afterburn-other', { provider: 'p', model: 'm' }).then((lease) => {
    otherSettled = true;
    return lease;
  });
  const sameOwner = await authority.acquire(owner('a'), 'afterburn-same', { provider: 'p', model: 'm' });
  assert.equal(otherSettled, false, 'the sticky owner reclaims its reserved slot ahead of an unrelated waiter');
  authority.release(owner('a'), sameOwner.leaseId, 'completed');

  clock.advance(9_999);
  await Promise.resolve();
  assert.equal(otherSettled, false);
  clock.advance(1);
  const admitted = await other;
  assert.equal(admitted.provider, 'p');
  authority.releaseOwner(owner('b'));
  assert.equal(clock.pendingTimers, 0);
});

test('coordinator does not grant afterburn to a failed non-retryable HTTP request', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  authority.updatePolicies({
    p: { maxConcurrentRequests: 1, afterburnSeconds: 10, queueWaitSeconds: 30 },
  });

  const failed = await authority.acquire(owner('a'), 'http-failure', { provider: 'p', model: 'm' });
  authority.observe(owner('a'), failed.leaseId, {
    classification: 'http-error', status: 400, retryable: false,
  });
  authority.release(owner('a'), failed.leaseId, 'failed');

  let unrelatedGranted = false;
  const unrelated = authority.acquire(owner('b'), 'after-http-failure', { provider: 'p', model: 'm' })
    .then((lease) => {
      unrelatedGranted = true;
      return lease;
    });
  await Promise.resolve();
  assert.equal(unrelatedGranted, true, 'a failed request must not retain sticky capacity');
  const lease = await unrelated;
  assert.equal(clock.pendingTimers, 0, 'neither an afterburn hold nor a queue deadline remains');
  authority.releaseOwner(owner('b'));
});

test('coordinator clears afterburn holds on owner release and policy disable', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  authority.updatePolicies({ p: { maxConcurrentRequests: 1, afterburnSeconds: 60 } });

  const first = await authority.acquire(owner('a'), 'owner-held', { provider: 'p', model: 'm' });
  authority.release(owner('a'), first.leaseId, 'completed');
  const waitingB = authority.acquire(owner('b'), 'waiting-b', { provider: 'p', model: 'm' });
  authority.releaseOwner(owner('a'));
  const admittedB = await waitingB;

  authority.release(owner('b'), admittedB.leaseId, 'completed');
  const waitingC = authority.acquire(owner('c'), 'waiting-c', { provider: 'p', model: 'm' });
  authority.updatePolicies({ p: { maxConcurrentRequests: 1, afterburnSeconds: 0 } });
  const admittedC = await waitingC;
  authority.releaseOwner(owner('c'));
  assert.equal(clock.pendingTimers, 0);
});

test('coordinator clears queued deadlines on cancellation, owner release, and circuit flush', async () => {
  const clock = new FakeClock();
  const authority = new CoordinatorProviderNetworkLeaseAuthority({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    defaultPolicy: { queueWaitMs: 100, circuitFailureThreshold: 1 },
  });
  const active = await authority.acquire(owner('a'), 'active', { provider: 'p', model: 'm' });

  const cancelled = authority.acquire(owner('b'), 'cancelled', { provider: 'p', model: 'm' });
  assert.equal(clock.pendingTimers, 1);
  authority.cancel(owner('b'), 'cancelled');
  await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
  assert.equal(clock.pendingTimers, 0);

  const exited = authority.acquire(owner('c'), 'exited', { provider: 'p', model: 'm' });
  assert.equal(clock.pendingTimers, 1);
  authority.releaseOwner(owner('c'));
  await assert.rejects(exited, (error: Error) => error.name === 'AbortError');
  assert.equal(clock.pendingTimers, 0);

  const flushed = authority.acquire(owner('d'), 'flushed', { provider: 'p', model: 'm' });
  assert.equal(clock.pendingTimers, 1);
  authority.release(owner('a'), active.leaseId, 'failed');
  await assert.rejects(flushed, (error: Error) => error.name === 'ProviderCircuitOpenError');
  assert.equal(clock.pendingTimers, 0);
});

test('worker provider admission races a queued acquire against AbortSignal and cancels correlation', async () => {
  const originalFetch = globalThis.fetch;
  let acquiredRequestId: string | undefined;
  let cancelledRequestId: string | undefined;
  const neverGranted = new Promise<{ leaseId: string; headerWaitMs: number; streamIdleTimeoutMs: number }>(() => undefined);
  globalThis.fetch = (async () => { throw new Error('underlying fetch must not run'); }) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async (requestId) => {
      acquiredRequestId = requestId;
      return await neverGranted;
    },
    cancel: async (requestId) => { cancelledRequestId = requestId; },
    observe: () => undefined,
    release: async () => undefined,
  });
  try {
    const controller = new AbortController();
    const fetching = globalThis.fetch('https://provider.example/v1/chat', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(fetching, (error: Error) => error.name === 'AbortError');
    assert.ok(acquiredRequestId);
    assert.equal(cancelledRequestId, acquiredRequestId);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider admission observes an AbortSignal carried by the Request object', async () => {
  const originalFetch = globalThis.fetch;
  let acquiredRequestId: string | undefined;
  let cancelledRequestId: string | undefined;
  globalThis.fetch = (async () => { throw new Error('underlying fetch must not run'); }) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async (requestId) => {
      acquiredRequestId = requestId;
      return await new Promise<{ leaseId: string; headerWaitMs: number; streamIdleTimeoutMs: number }>(() => undefined);
    },
    cancel: async (requestId) => { cancelledRequestId = requestId; },
    observe: () => undefined,
    release: async () => undefined,
  });
  try {
    const controller = new AbortController();
    const request = new Request('https://provider.example/v1/chat', { signal: controller.signal });
    const fetching = globalThis.fetch(request);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(fetching, (error: Error) => error.name === 'AbortError');
    assert.ok(acquiredRequestId);
    assert.equal(cancelledRequestId, acquiredRequestId);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease is acquired at fetch and held through body EOF, error, and cancel', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('ok'));
      controller.close();
    },
  }))) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async () => {
      calls.push('acquire');
      return { leaseId: 'lease-1', headerWaitMs: 120_000, streamIdleTimeoutMs: 120_000 };
    },
    cancel: async () => { calls.push('cancel'); },
    observe: (_leaseId, observation) => { calls.push(`observe:${observation.classification}`); },
    release: async (_leaseId, outcome) => { calls.push(`release:${outcome}`); },
  });
  try {
    const response = await globalThis.fetch('https://provider.example/v1/chat');
    assert.deepEqual(calls, ['acquire']);
    assert.equal(await response.text(), 'ok');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['acquire', 'observe:success', 'release:completed']);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease bounds hung response headers and releases coordinator capacity', async () => {
  const originalFetch = globalThis.fetch;
  let transportSignal: AbortSignal | undefined;
  const observations: string[] = [];
  const releases: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    transportSignal = init?.signal ?? undefined;
    return await new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async () => ({ leaseId: 'lease-header-timeout', headerWaitMs: 20, streamIdleTimeoutMs: 120_000 }),
    cancel: async () => undefined,
    observe: (_leaseId, observation) => { observations.push(observation.classification); },
    release: async (_leaseId, outcome) => { releases.push(outcome); },
  }, () => ({ provider: 'hung-provider', model: 'model' }));
  try {
    await assert.rejects(
      globalThis.fetch('https://hung.example/v1/chat'),
      (error: Error) => error.name === 'WorkerProviderHeaderTimeoutError',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transportSignal?.aborted, true);
    assert.deepEqual(observations, ['transport-error']);
    assert.deepEqual(releases, ['failed']);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease bounds a stalled response body', async () => {
  const originalFetch = globalThis.fetch;
  const observations: string[] = [];
  const releases: string[] = [];
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull: async () => await new Promise<void>(() => undefined),
  }))) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async () => ({ leaseId: 'lease-idle-timeout', headerWaitMs: 1_000, streamIdleTimeoutMs: 20 }),
    cancel: async () => undefined,
    observe: (_leaseId, observation) => { observations.push(observation.classification); },
    release: async (_leaseId, outcome) => { releases.push(outcome); },
  }, () => ({ provider: 'idle-provider', model: 'model' }));
  try {
    const response = await globalThis.fetch('https://idle.example/v1/chat');
    await assert.rejects(response.text(), (error: Error) => error.name === 'WorkerProviderStreamIdleTimeoutError');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observations, ['transport-error']);
    assert.deepEqual(releases, ['failed']);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease supersedes non-retryable HTTP headers when the error body stalls', async () => {
  const originalFetch = globalThis.fetch;
  const observations: Array<{ classification: string; retryable: boolean }> = [];
  const releases: string[] = [];
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull: async () => await new Promise<void>(() => undefined),
  }), { status: 400 })) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async () => ({ leaseId: 'lease-http-idle-timeout', headerWaitMs: 1_000, streamIdleTimeoutMs: 20 }),
    cancel: async () => undefined,
    observe: (_leaseId, observation) => {
      observations.push({ classification: observation.classification, retryable: observation.retryable });
    },
    release: async (_leaseId, outcome) => { releases.push(outcome); },
  }, () => ({ provider: 'idle-provider', model: 'model' }));
  try {
    const response = await globalThis.fetch('https://idle.example/v1/chat');
    await assert.rejects(response.text(), (error: Error) => error.name === 'WorkerProviderStreamIdleTimeoutError');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observations, [
      { classification: 'http-error', retryable: false },
      { classification: 'transport-error', retryable: true },
    ]);
    assert.deepEqual(releases, ['failed']);
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease classifies the actual URL before root-session fallback', async () => {
  const originalFetch = globalThis.fetch;
  let admittedProvider = '';
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async (_requestId, request) => {
      admittedProvider = request.provider;
      return { leaseId: 'lease-url-provider', headerWaitMs: 1_000, streamIdleTimeoutMs: 1_000 };
    },
    cancel: async () => undefined,
    observe: () => undefined,
    release: async () => undefined,
  }, () => ({ provider: 'github-copilot', model: 'root-model' }), {
    resolveProvider: (url, fallback) => url.startsWith('http://localhost:11434/v1') ? 'ollama' : fallback,
  });
  try {
    await globalThis.fetch('http://localhost:11434/v1/chat/completions');
    assert.equal(admittedProvider, 'ollama');
  } finally {
    uninstall();
    globalThis.fetch = originalFetch;
  }
});

test('worker provider lease republishes queue and transport phases from the isolated network boundary', async () => {
  const originalFetch = globalThis.fetch;
  const observations: Array<{ kind: string; queueDurationMs?: number; attemptId: string }> = [];
  const stop = observeProviderTransport((observation) => observations.push(observation));
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('ok'));
      controller.close();
    },
  }))) as typeof fetch;
  const uninstall = installWorkerProviderNetworkLease({
    acquire: async () => ({ leaseId: 'lease-progress', headerWaitMs: 120_000, streamIdleTimeoutMs: 120_000 }),
    cancel: async () => undefined,
    observe: () => undefined,
    release: async () => undefined,
  }, () => ({ sessionId: 'session-progress', provider: 'provider-progress', model: 'model-progress' }));
  try {
    const response = await globalThis.fetch('https://provider.example/v1/chat');
    assert.equal(await response.text(), 'ok');
    assert.deepEqual(observations.map((observation) => observation.kind), [
      'gate_queue', 'gate_acquired', 'headers_wait', 'headers_received', 'raw_chunk', 'transport_terminal',
    ]);
    assert.ok((observations[1]?.queueDurationMs ?? -1) >= 0);
    assert.ok(observations.every((observation) => observation.attemptId === observations[0]?.attemptId));
  } finally {
    uninstall();
    stop();
    globalThis.fetch = originalFetch;
  }
});
