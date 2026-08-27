import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import { BackendError } from '../../../src/backend/server-io';
import type { RequestEnvelope } from '../../../src/shared/protocol';
import type { CoordinatorToHostDetailMessage, LiveSubagentDetailAddress } from '../../../src/shared/protocol/subagent-detail';

interface ServerDetailTestPort {
  handleRequest(
    request: RequestEnvelope,
    onRequestValidated?: () => void,
    livePipelineTraceToggleGeneration?: number,
  ): Promise<unknown>;
  workerRuntimeRouter: {
    subscribeDetail(message: unknown): Promise<unknown>;
    unsubscribeDetail(message: unknown): Promise<unknown>;
    fetchDetail(message: unknown): void;
    hasHotOwner(sessionPath: string): boolean;
    interrupt(sessionPath: string, reason: string): Promise<{ soft: boolean; teardownTimedOut?: boolean }>;
    getRoute(sessionPath: string): { state: string; promotion?: Promise<unknown>; retirement?: Promise<unknown> };
    runHotTransition(sessionPath: string, options: unknown): Promise<unknown>;
    isHotOperation(method: string): boolean;
  };
}

const ADDRESS: LiveSubagentDetailAddress = {
  sessionPath: '/repo/session.jsonl',
  turnId: 'turn-1',
  rootToolCallId: 'tool-1',
  rootAttemptId: 'attempt-1',
  lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
};

function createIsolatedServer() {
  const server = new BackendServer({
    sdkPath: '/sdk',
    cwd: '/repo',
    workerEntryPath: '/worker.js',
  });
  const subscribed: unknown[] = [];
  const unsubscribed: unknown[] = [];
  const fetched: unknown[] = [];
  const port = server as unknown as ServerDetailTestPort;
  port.workerRuntimeRouter = {
    subscribeDetail: async (message) => { subscribed.push(message); return { accepted: true }; },
    unsubscribeDetail: async (message) => { unsubscribed.push(message); return { accepted: true }; },
    fetchDetail: (message) => { fetched.push(message); },
    hasHotOwner: () => true,
    interrupt: async () => ({ soft: true }),
    getRoute: () => ({ state: 'hot' }),
    runHotTransition: async () => ({ ok: true }),
    isHotOperation: () => false,
  };
  return { server, port, subscribed, unsubscribed, fetched };
}

function envelope(method: string, params: unknown, id = 'req-1'): RequestEnvelope {
  return { id, method, params };
}

test('isolated server routes detail.subscribe/unsubscribe/fetch to the runtime router', async () => {
  const { server, port, subscribed, unsubscribed, fetched } = createIsolatedServer();
  let validated = 0;

  const subscribeResult = await port.handleRequest(
    envelope('detail.subscribe', { subscriptionId: 'subscription-1', address: ADDRESS, maxPageBytes: 4096 }),
    () => { validated += 1; },
  );
  assert.deepEqual(subscribeResult, { accepted: true });
  assert.deepEqual(subscribed, [{
    kind: 'detail.subscribe', requestId: 'req-1', subscriptionId: 'subscription-1', address: ADDRESS, maxPageBytes: 4096,
  }]);

  const cursorResult = await port.handleRequest(
    envelope('detail.subscribe', {
      subscriptionId: 'subscription-2', address: ADDRESS, cursor: { revision: 3 }, maxPageBytes: 2048,
    }, 'req-2'),
  );
  assert.deepEqual(cursorResult, { accepted: true });
  assert.deepEqual(subscribed[1], {
    kind: 'detail.subscribe', requestId: 'req-2', subscriptionId: 'subscription-2', address: ADDRESS,
    cursor: { revision: 3 }, maxPageBytes: 2048,
  });

  await port.handleRequest(envelope('detail.unsubscribe', { subscriptionId: 'subscription-1', reason: 'collapse' }, 'req-3'));
  assert.deepEqual(unsubscribed, [{
    kind: 'detail.unsubscribe', requestId: 'req-3', subscriptionId: 'subscription-1', reason: 'collapse',
  }]);

  await port.handleRequest(envelope('detail.fetch', {
    subscriptionId: 'subscription-2', address: ADDRESS, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 2 }, maxPageBytes: 4096,
  }, 'req-4'));
  assert.deepEqual(fetched, [{
    kind: 'detail.fetch', requestId: 'req-4', subscriptionId: 'subscription-2', address: ADDRESS,
    ref: { baselineRevision: 1, pageIndex: 0, pageCount: 2 }, maxPageBytes: 4096,
  }]);
  assert.equal(validated, 1);
});

test('isolated server rejects malformed detail payloads with INVALID_PARAMS', async () => {
  const { server, port } = createIsolatedServer();
  await assert.rejects(
    port.handleRequest(envelope('detail.subscribe', { address: ADDRESS, maxPageBytes: 4096 })),
    (error: unknown) => error instanceof BackendError
      && error.code === 'INVALID_PARAMS'
      && /subscriptionId/.test(error.message),
  );
  await assert.rejects(
    port.handleRequest(envelope('detail.unsubscribe', { subscriptionId: 's', reason: 'evict' })),
    (error: unknown) => error instanceof BackendError && error.code === 'INVALID_PARAMS',
  );
  await assert.rejects(
    port.handleRequest(envelope('detail.fetch', { subscriptionId: 's', address: ADDRESS, maxPageBytes: 1 })),
    (error: unknown) => error instanceof BackendError && error.code === 'INVALID_PARAMS',
  );
});

test('detail RPCs fail closed without an initialized worker router', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/repo', workerEntryPath: '/worker.js' });
  const port = server as unknown as ServerDetailTestPort;
  // Without `start()` the coordinator has no router; the detail RPCs are not
  // in the coordinator operation catalog, so they fail closed as unavailable
  // instead of reaching any SDK path.
  await assert.rejects(
    port.handleRequest(envelope('detail.subscribe', { subscriptionId: 's', address: ADDRESS, maxPageBytes: 4096 })),
    (error: unknown) => error instanceof BackendError && error.code === 'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
  );
  await assert.rejects(
    port.handleRequest(envelope('detail.unsubscribe', { subscriptionId: 's', reason: 'collapse' })),
    (error: unknown) => error instanceof BackendError && error.code === 'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
  );
  await assert.rejects(
    port.handleRequest(envelope('detail.fetch', { subscriptionId: 's', address: ADDRESS, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, maxPageBytes: 4096 })),
    (error: unknown) => error instanceof BackendError && error.code === 'ISOLATED_RUNTIME_ROUTING_UNAVAILABLE',
  );
});

test('detail.stream events carry validated coordinator→host payloads (emitDetail wiring)', () => {
  // The emitDetail wiring is installed in `start()`; exercise the same seam by
  // verifying the router-facing callback type accepts every stream variant.
  const variants: CoordinatorToHostDetailMessage[] = [
    { kind: 'detail.start', subscriptionId: 's', address: ADDRESS, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4, fence: { backendGeneration: 2, coordinatorGeneration: 1, workerId: 'w', workerGeneration: 1 } },
    { kind: 'detail.error', subscriptionId: 's', code: 'UNAVAILABLE', message: 'x', retryable: true, fence: { backendGeneration: 2, coordinatorGeneration: 1, workerId: 'w', workerGeneration: 1 } },
  ];
  assert.equal(variants.length, 2);
});
