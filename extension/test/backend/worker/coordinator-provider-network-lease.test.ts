import assert from 'node:assert/strict';
import test from 'node:test';

import { CoordinatorProviderNetworkLeaseAuthority } from '../../../src/backend/coordinator-provider-network-lease';
import { installWorkerProviderNetworkLease } from '../../../src/backend/worker-provider-network-lease';
import { observeProviderTransport } from '../../../src/backend/provider-progress-bus';

const owner = (workerId: string, workerGeneration = 1) => ({ coordinatorGeneration: 1, workerId, workerGeneration });

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

test('worker provider admission races a queued acquire against AbortSignal and cancels correlation', async () => {
  const originalFetch = globalThis.fetch;
  let acquiredRequestId: string | undefined;
  let cancelledRequestId: string | undefined;
  const neverGranted = new Promise<{ leaseId: string }>(() => undefined);
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
      return await new Promise<{ leaseId: string }>(() => undefined);
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
    acquire: async () => { calls.push('acquire'); return { leaseId: 'lease-1' }; },
    cancel: async () => { calls.push('cancel'); },
    observe: (_leaseId, observation) => { calls.push(`observe:${observation.classification}`); },
    release: async (_leaseId, outcome) => { calls.push(`release:${outcome}`); },
  });
  try {
    const response = await globalThis.fetch('https://provider.example/v1/chat');
    assert.deepEqual(calls, ['acquire', 'observe:success']);
    assert.equal(await response.text(), 'ok');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['acquire', 'observe:success', 'release:completed']);
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
    acquire: async () => ({ leaseId: 'lease-progress' }),
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
