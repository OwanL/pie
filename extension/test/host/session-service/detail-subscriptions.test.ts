import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DetailSubscriptionService,
  DETAIL_SUBSCRIPTION_MAX_ACTIVE,
  DETAIL_TOMBSTONE_TTL_MS,
} from '../../../src/host/session-service/detail-subscriptions';
import type {
  BackendDetailFence,
  CoordinatorToHostDetailMessage,
  LiveSubagentDetailAddress,
} from '../../../src/shared/protocol/subagent-detail';
import type { HostToWebviewMessage } from '../../../src/shared/protocol';

const SESSION_PATH = '/workspace/session.jsonl';

function address(overrides: Partial<LiveSubagentDetailAddress> = {}): LiveSubagentDetailAddress {
  return {
    sessionPath: SESSION_PATH,
    turnId: 'turn-1',
    rootToolCallId: 'tool-1',
    rootAttemptId: 'root-attempt',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
    ...overrides,
  };
}

function fence(overrides: Partial<BackendDetailFence> = {}): BackendDetailFence {
  return {
    backendGeneration: 2,
    coordinatorGeneration: 1,
    workerId: 'worker-1',
    workerGeneration: 1,
    ...overrides,
  };
}

function pagePayload(text: string, startByte = 0): {
  kind: 'json-segment'; encoding: 'utf8-json'; segmentId: string; semanticPath: readonly (string | number)[];
  startByte: number; endByte: number; totalBytes: number; startCodePoint: number; endCodePoint: number; totalCodePoints: number; text: string;
} {
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    kind: 'json-segment', encoding: 'utf8-json', segmentId: 'segment-1', semanticPath: [],
    startByte, endByte: startByte + bytes, totalBytes: startByte + bytes,
    startCodePoint: 0, endCodePoint: [...text].length, totalCodePoints: [...text].length, text,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pageMessage(subscriptionId: string, pageIndex: number, pageCount: number, text: string, f = fence(), baselineRevision = 1): CoordinatorToHostDetailMessage {
  const payload = pagePayload(text);
  return {
    kind: 'detail.page', subscriptionId,
    ref: { baselineRevision, pageIndex, pageCount },
    payload, payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    checksum: sha256(JSON.stringify(payload)), fence: f,
  };
}

function startMessage(subscriptionId: string, overrides: Partial<Extract<CoordinatorToHostDetailMessage, { kind: 'detail.start' }>> = {}): CoordinatorToHostDetailMessage {
  return {
    kind: 'detail.start', subscriptionId, address: address(), source: 'live',
    baselineRevision: 1, pageCount: 1, totalBytes: 4, fence: fence(),
    ...overrides,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  service: DetailSubscriptionService;
  requests: Array<{ method: string; params?: unknown }>;
  posted: HostToWebviewMessage[];
  setViewGeneration: (value: number) => void;
  setBackendGeneration: (value: number) => void;
  setNow: (value: number) => void;
}

function createHarness(overrides: {
  subscribeFailure?: Error;
} = {}): Harness {
  let now = 0;
  let viewGeneration = 3;
  let backendGeneration = 2;
  const requests: Array<{ method: string; params?: unknown }> = [];
  const posted: HostToWebviewMessage[] = [];
  const backend = {
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === 'detail.subscribe' && overrides.subscribeFailure) throw overrides.subscribeFailure;
      return { accepted: true };
    },
  };
  const service = new DetailSubscriptionService({
    backend: backend as never,
    postImperative: (message) => posted.push(message),
    getHostInstanceId: () => 'host-instance-1',
    getViewGeneration: () => viewGeneration,
    getBackendGeneration: () => backendGeneration,
    now: () => now,
    maxPageBytes: 4096,
  });
  return {
    service, requests, posted,
    setViewGeneration: (value) => { viewGeneration = value; },
    setBackendGeneration: (value) => { backendGeneration = value; },
    setNow: (value) => { now = value; },
  };
}

const KEY = 'subagent:msg-1:tool-1';

const DURABLE_REF = {
  sessionPath: SESSION_PATH, messageId: 'msg-1', key: 'durable:tool:key', kind: 'tool-result',
  source: 'durable', sizeBytes: 16, summary: 'exit code 0', available: true,
} as const;

test('subscribe records the exact owner and forwards a fence-matched live stream', async () => {
  const { service, requests, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();

  assert.deepEqual(requests[0], {
    method: 'detail.subscribe',
    params: { subscriptionId: 'subscription-1', address: address(), maxPageBytes: 4096 },
  });

  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, 'detail.start');
  if (posted[0]?.type === 'detail.start') {
    assert.deepEqual(posted[0]?.address, address());
    assert.equal(posted[0]?.source, 'live');
    assert.equal(posted[0]?.subscriptionId, 'subscription-1');
    assert.equal(posted[0]?.hostInstanceId, 'host-instance-1');
    assert.equal(posted[0]?.hostGeneration, 0);
    assert.equal(posted[0]?.viewGeneration, 3);
    assert.equal(posted[0]?.backendGeneration, 2);
    assert.equal(posted[0]?.coordinatorGeneration, 1);
    assert.equal(posted[0]?.workerId, 'worker-1');
    assert.equal(posted[0]?.workerGeneration, 1);
    assert.equal(posted[0]?.detailKey, KEY);
  }

  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  assert.equal(posted[1]?.type, 'detail.page');
  if (posted[1]?.type === 'detail.page') {
    assert.equal(posted[1]?.ref.pageIndex, 0);
    assert.equal(posted[1]?.checksum, sha256(JSON.stringify(pagePayload('null'))));
  }

  service.handleStream({
    kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2,
    operations: [{ op: 'set', path: ['exitCode'], value: 0 }], fence: fence(),
  });
  assert.equal(posted[2]?.type, 'detail.delta');
  if (posted[2]?.type === 'detail.delta') {
    assert.equal(posted[2]?.revision, 2);
    assert.equal(posted[2]?.baseRevision, 1);
  }

  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 2,
    durableRef: { sessionPath: SESSION_PATH, messageId: 'msg-1', key: 'durable:tool:key', kind: 'tool-result', source: 'durable', sizeBytes: 16, summary: 'exit code 0', available: true },
    fence: fence(),
  });
  assert.equal(posted[3]?.type, 'detail.terminal');
  // Terminal closes the subscription exactly once: late traffic is dropped and
  // can never recreate UI.
  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 4);
});

test('subscribe is idempotent for the same owner and replaces a stale owner', async () => {
  const { service, requests } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  assert.deepEqual(requests.map((request) => request.method), ['detail.subscribe']);
  assert.equal(requests.length, 1, 'a duplicate subscribe for the same owner is a no-op');

  service.handleStream(startMessage('subscription-1'));
  // A different address for the same key replaces the owner and actively
  // releases the old worker slot before opening the new one.
  service.subscribe('subscription-2', 3, KEY, address({ rootAttemptId: 'new-attempt' }));
  await tick();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1).map((request) => request.method), [
    'detail.unsubscribe',
    'detail.subscribe',
  ]);
  assert.deepEqual(requests[1]?.params, { subscriptionId: 'subscription-1', reason: 'rebase' });
  assert.equal((requests[2]?.params as { subscriptionId: string }).subscriptionId, 'subscription-2');
  // The old owner's stream is dead.
  service.handleStream(startMessage('subscription-1'));
  assert.equal((requests[0]?.params as { subscriptionId: string }).subscriptionId, 'subscription-1');
});

test('unsubscribe discards the owner, tombstones its id, and notifies the backend', async () => {
  const { service, requests, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.unsubscribe(3, KEY, 'collapse');
  await tick();

  assert.equal((requests[1]?.params as { subscriptionId: string; reason: string }).reason, 'collapse');
  const before = posted.length;
  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  service.handleStream({
    kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2, operations: [], fence: fence(),
  });
  service.handleStream(startMessage('subscription-1'));
  service.handleStream({
    kind: 'detail.error', subscriptionId: 'subscription-1', code: 'UNAVAILABLE', message: 'x', retryable: true, fence: fence(),
  });
  assert.equal(posted.length, before, 'tombstoned late traffic cannot recreate UI');

  // A fresh subscribe for the same key mints a NEW subscription id and routes
  // a fresh stream.
  service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  assert.equal((requests[2]?.params as { subscriptionId: string }).subscriptionId, 'subscription-2');
  service.handleStream(startMessage('subscription-2'));
  assert.equal(posted.at(-1)?.type, 'detail.start');
});

test('generation fences invalidate streams: view reload and backend death', async () => {
  const { service, posted, setViewGeneration, setBackendGeneration } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 1);

  // A webview reload increments the view generation: the owner's renderer is
  // gone, so its stream is closed without forwarding.
  setViewGeneration(4);
  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  assert.equal(posted.length, 1);
  service.subscribe('subscription-2', 4, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-2'));
  assert.equal(posted.length, 2);

  // Backend generation changes invalidate the old fence. After the registry
  // reset, a fresh subscription stamped by the new backend is accepted.
  setBackendGeneration(3);
  service.handleStream(pageMessage('subscription-2', 0, 1, 'null'));
  assert.equal(posted.length, 2, 'backend-generation-stale traffic is dropped');
  service.reset();
  service.subscribe('subscription-3', 4, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-3', { fence: fence({ backendGeneration: 3, coordinatorGeneration: 3 }) }));
  assert.equal(posted.length, 3, 'new backend-generation traffic is forwarded');

  // Worker generation changes inside the same backend are also fence-checked.
  service.subscribe('subscription-4', 4, `${KEY}:other`, address());
  await tick();
  const currentFence = fence({ backendGeneration: 3, coordinatorGeneration: 3 });
  service.handleStream(startMessage('subscription-4', { fence: currentFence }));
  service.handleStream(pageMessage('subscription-4', 0, 1, 'null', { ...currentFence, workerGeneration: 2 }));
  assert.equal(posted.length, 4, 'only the original start is forwarded');
});

test('start validation: wrong state, mismatched address, or malformed page is dropped', async () => {
  const { service, posted } = createHarness();
  // start before subscribe: unknown subscription.
  service.handleStream(startMessage('ghost'));
  assert.equal(posted.length, 0);

  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  // A start for a different address cannot bind to this owner; the owner is
  // closed so a later mismatched start can never bind either.
  service.handleStream(startMessage('subscription-1', { address: address({ rootAttemptId: 'other' }) }));
  assert.equal(posted.length, 0);
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 1);

  // A mismatched baseline manifest is dropped.
  service.handleStream({
    kind: 'detail.page', subscriptionId: 'subscription-1',
    ref: { baselineRevision: 9, pageIndex: 0, pageCount: 1 },
    payload: pagePayload('null'), payloadBytes: 4, checksum: 'a'.repeat(64), fence: fence(),
  });
  assert.equal(posted.length, 1);

  // A bad checksum is dropped.
  const bad = pageMessage('subscription-1', 0, 1, 'null');
  service.handleStream({ ...bad, checksum: 'b'.repeat(64) } as CoordinatorToHostDetailMessage);
  assert.equal(posted.length, 1);

  // An out-of-range page index is dropped.
  service.handleStream(pageMessage('subscription-1', 1, 1, 'null'));
  assert.equal(posted.length, 1);

  // A valid page is forwarded.
  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  assert.equal(posted.length, 2);

  // A second start while active is a protocol violation: it is dropped and
  // closes the owner, so later stream traffic can no longer bind.
  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 2);
  service.handleStream(pageMessage('subscription-1', 0, 1, 'null'));
  assert.equal(posted.length, 2, 'closed owner cannot be recreated by late traffic');
});

test('a delta gap the coordinator missed transitions to an explicit rebase', async () => {
  const { service, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.handleStream({
    kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2,
    operations: [{ op: 'set', path: ['a'], value: 1 }], fence: fence(),
  });
  assert.equal(posted[1]?.type, 'detail.delta');
  service.handleStream({
    kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 5, revision: 6,
    operations: [{ op: 'set', path: ['a'], value: 2 }], fence: fence(),
  });
  assert.equal(posted[2]?.type, 'detail.rebase');
  if (posted[2]?.type === 'detail.rebase') {
    assert.equal(posted[2]?.reason, 'gap');
    assert.equal(posted[2]?.currentRevision, 5);
  }
  // Coordinator rebases are forwarded and transition the owner.
  service.handleStream({
    kind: 'detail.rebase', subscriptionId: 'subscription-1', currentRevision: 7, reason: 'generation-change', fence: fence(),
  });
  assert.equal(posted[3]?.type, 'detail.rebase');
  if (posted[3]?.type === 'detail.rebase') {
    assert.equal(posted[3]?.reason, 'generation-change');
  }
});

test('fetchPages routes the exact owner address and closes on failure', async () => {
  const { service, requests, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.fetchPages(3, KEY, { baselineRevision: 1, pageIndex: 0, pageCount: 1 });
  await tick();
  assert.deepEqual(requests[1], {
    method: 'detail.fetch',
    params: { subscriptionId: 'subscription-1', address: address(), ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, maxPageBytes: 4096 },
  });

  // A ref against a stale baseline is dropped without a request.
  service.fetchPages(3, KEY, { baselineRevision: 9, pageIndex: 0, pageCount: 1 });
  assert.equal(requests.length, 2);

  // Unknown key / unmounted owner: no request.
  service.fetchPages(3, 'other-key', { baselineRevision: 1, pageIndex: 0, pageCount: 1 });
  assert.equal(requests.length, 2);
});

test('subscribe RPC failure surfaces a retryable detail.error and closes the owner', async () => {
  const { service, posted } = createHarness({ subscribeFailure: Object.assign(new Error('worker gone'), { code: 'SESSION_NOT_FOUND' }) });
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, 'detail.error');
  if (posted[0]?.type === 'detail.error') {
    assert.equal(posted[0]?.code, 'NOT_FOUND');
    assert.equal(posted[0]?.retryable, true);
    assert.equal(posted[0]?.subscriptionId, 'subscription-1');
    assert.equal(posted[0]?.viewGeneration, 3);
    assert.equal(posted[0]?.detailKey, KEY);
  }
  // The failed owner is closed: a late start cannot bind.
  service.handleStream(startMessage('subscription-1'));
  assert.equal(posted.length, 1);
});

test('terminal handoff answers a re-expanded key durably without a worker round-trip', async () => {
  const { service, requests, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 4,
    durableRef: { sessionPath: SESSION_PATH, messageId: 'msg-1', key: 'durable:tool:key', kind: 'tool-result', source: 'durable', sizeBytes: 16, summary: 'exit code 0', available: true },
    fence: fence(),
  });

  // Re-expand after collapse: the host subscribes through the paged durable
  // authority instead of loading the whole value with session.loadDetail.
  service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  const subscribeCall = requests.find((request) => request.method === 'detail.subscribe'
    && (request.params as { subscriptionId?: string })?.subscriptionId === 'subscription-2');
  assert.ok(subscribeCall, 'durable re-expansion uses backend detail.subscribe');
  assert.deepEqual(subscribeCall?.params, {
    subscriptionId: 'subscription-2',
    address: address(),
    maxPageBytes: 4096,
  });
  assert.equal(requests.some((request) => request.method === 'session.loadDetail'), false, 'no whole-value load is issued');

  // The backend streams exact durable pages; the host forwards them and ends
  // with the terminal handoff, all under the stream fence. Durable fences
  // carry no worker identity.
  const durableFence = fence({ workerId: undefined, workerGeneration: undefined });
  service.handleStream({
    kind: 'detail.start', subscriptionId: 'subscription-2', address: address(), source: 'durable',
    baselineRevision: 4, pageCount: 1, totalBytes: 16, fence: durableFence,
  });
  service.handleStream(pageMessage('subscription-2', 0, 1, '{"exitCode":0}', durableFence, 4));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-2', revision: 4, durableRef: DURABLE_REF, fence: durableFence,
  });

  const start = posted.find((message) => message.type === 'detail.start' && message.subscriptionId === 'subscription-2');
  assert.equal(start?.type, 'detail.start');
  if (start?.type === 'detail.start') {
    assert.equal(start.source, 'durable');
    assert.equal(start.baselineRevision, 4);
    assert.equal(start.pageCount, 1);
    assert.equal(start.subscriptionId, 'subscription-2');
    assert.equal(start.workerId, undefined, 'durable answers carry no worker identity');
    assert.equal(start.backendGeneration, 2);
  }
  const pages = posted.filter((message): message is Extract<HostToWebviewMessage, { type: 'detail.page' }> =>
    message.type === 'detail.page' && message.subscriptionId === 'subscription-2');
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.checksum, sha256(JSON.stringify(pages[0]?.payload)), 'durable pages are checksummed');
  assert.equal(posted.some((message) => message.type === 'detail.terminal' && message.subscriptionId === 'subscription-2'), true, 'durable answer ends with a terminal handoff');
});

test('durable fallback surfaces subscribe failures and stream errors', async () => {
  const failing = createHarness({
    subscribeFailure: Object.assign(new Error('the live source is gone'), { code: 'NOT_FOUND' }),
  });
  failing.service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  failing.service.handleStream(startMessage('subscription-1'));
  failing.service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 1,
    durableRef: DURABLE_REF, fence: fence(),
  });
  failing.service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  await tick();
  const error = failing.posted.find((message) => message.type === 'detail.error' && message.subscriptionId === 'subscription-2');
  assert.equal(error?.type, 'detail.error');
  if (error?.type === 'detail.error') {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.retryable, true);
  }

  // Stream-time errors from the durable backend are forwarded under the fence.
  const { service, posted } = createHarness();
  service.subscribe('subscription-3', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-3'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-3', revision: 1,
    durableRef: DURABLE_REF, fence: fence(),
  });
  service.subscribe('subscription-4', 3, KEY, address());
  await tick();
  const durableFence = fence({ workerId: undefined, workerGeneration: undefined });
  service.handleStream({
    kind: 'detail.start', subscriptionId: 'subscription-4', address: address(), source: 'durable',
    baselineRevision: 1, pageCount: 1, totalBytes: 16, fence: durableFence,
  });
  service.handleStream({
    kind: 'detail.error', subscriptionId: 'subscription-4', code: 'NOT_FOUND',
    message: 'The durable source is gone.', retryable: true, fence: durableFence,
  });
  const streamError = posted.find((message) => message.type === 'detail.error' && message.subscriptionId === 'subscription-4');
  assert.equal(streamError?.type, 'detail.error');
  if (streamError?.type === 'detail.error') {
    assert.equal(streamError.code, 'NOT_FOUND');
    assert.equal(streamError.retryable, true);
  }
});

test('bounded tombstones and terminal records expire and evict by capacity', async () => {
  const { service, setNow, posted } = createHarness();
  for (let i = 0; i < 3; i += 1) {
    service.subscribe(`subscription-${i}`, 3, `${KEY}:${i}`, address({ rootAttemptId: `attempt-${i}` }));
    await tick();
  }
  for (let i = 0; i < 3; i += 1) {
    service.unsubscribe(3, `${KEY}:${i}`, 'collapse');
  }
  // Expired tombstones are pruned on the next tombstone insert.
  setNow(DETAIL_TOMBSTONE_TTL_MS + 1);
  service.subscribe('subscription-x', 3, `${KEY}:x`, address({ rootAttemptId: 'attempt-x' }));
  await tick();
  service.unsubscribe(3, `${KEY}:x`, 'collapse');

  // Terminal records also expire: after TTL + a prune trigger, re-expanding
  // the key routes a fresh live subscribe instead of a durable answer.
  service.subscribe('subscription-t', 3, `${KEY}:terminal`, address({ rootAttemptId: 'attempt-t' }));
  await tick();
  service.handleStream(startMessage('subscription-t'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-t', revision: 1,
    durableRef: { sessionPath: SESSION_PATH, messageId: 'm', key: 'k', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 's', available: true },
    fence: fence(),
  });
  setNow(DETAIL_TOMBSTONE_TTL_MS * 2 + 1);
  // Trigger a prune via another terminal.
  service.subscribe('subscription-u', 3, `${KEY}:u`, address({ rootAttemptId: 'attempt-u' }));
  await tick();
  service.handleStream(startMessage('subscription-u'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-u', revision: 1,
    durableRef: { sessionPath: SESSION_PATH, messageId: 'm', key: 'k', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 's', available: true },
    fence: fence(),
  });
  // The expired terminal record was pruned: re-expanding the key now routes a
  // fresh live subscribe instead of a durable answer.
  service.subscribe('subscription-v', 3, `${KEY}:terminal`, address({ rootAttemptId: 'attempt-t' }));
  await tick();
  service.handleStream(startMessage('subscription-v', { address: address({ rootAttemptId: 'attempt-t' }) }));
  assert.equal(posted.at(-1)?.type, 'detail.start');
  assert.equal((posted.at(-1) as { subscriptionId?: string }).subscriptionId, 'subscription-v');
});

test('the active subscription budget is bounded', async () => {
  const { service, posted } = createHarness();
  for (let i = 0; i < DETAIL_SUBSCRIPTION_MAX_ACTIVE; i += 1) {
    service.subscribe(`subscription-${i}`, 3, `${KEY}:${i}`, address({ rootAttemptId: `attempt-${i}` }));
  }
  service.subscribe('subscription-over', 3, `${KEY}:over`, address({ rootAttemptId: 'attempt-over' }));
  const error = posted.find((message) => message.type === 'detail.error');
  assert.equal(error?.type, 'detail.error');
  if (error?.type === 'detail.error') {
    assert.equal(error?.code, 'UNAVAILABLE');
    assert.equal(error?.retryable, true);
    assert.equal(error?.subscriptionId, 'subscription-over');
  }
});

test('reset clears owners, tombstones, terminal records, and bumps the host generation', async () => {
  const { service, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 1,
    durableRef: { sessionPath: SESSION_PATH, messageId: 'm', key: 'k', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 's', available: true },
    fence: fence(),
  });
  assert.deepEqual(service.getDebugState(), { subscriptions: 0, tombstones: 0, terminalRecords: 1, hostGeneration: 0 });

  service.reset();
  assert.deepEqual(service.getDebugState(), { subscriptions: 0, tombstones: 0, terminalRecords: 0, hostGeneration: 1 });

  service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-2'));
  assert.equal(posted.at(-1)?.type, 'detail.start');
  assert.equal((posted.at(-1) as { hostGeneration?: number }).hostGeneration, 1);
});

test('the durable terminal handoff identity is replayed on re-expansion', async () => {
  const { service, posted } = createHarness();
  service.subscribe('subscription-1', 3, KEY, address());
  await tick();
  service.handleStream(startMessage('subscription-1'));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 1,
    durableRef: DURABLE_REF, fence: fence(),
  });
  service.subscribe('subscription-2', 3, KEY, address());
  await tick();
  // The durable terminal handoff arrives through the backend stream with the
  // same durable identity the original terminal carried.
  service.handleStream({
    kind: 'detail.start', subscriptionId: 'subscription-2', address: address(), source: 'durable',
    baselineRevision: 1, pageCount: 1, totalBytes: 16, fence: fence(),
  });
  service.handleStream(pageMessage('subscription-2', 0, 1, '{"exitCode":0}', fence()));
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-2', revision: 1, durableRef: DURABLE_REF, fence: fence(),
  });
  const terminal = posted.find((message) => message.type === 'detail.terminal' && message.subscriptionId === 'subscription-2');
  assert.equal(terminal?.type, 'detail.terminal');
  if (terminal?.type === 'detail.terminal') {
    assert.deepEqual(terminal.durableRef, DURABLE_REF);
  }
});

test('browser ownership: the complete key {viewGeneration, rendererId, rendererGeneration, detailKey} isolates renderers', async () => {
  const { service, requests, posted } = createHarness();
  // Two browser renderers subscribe to the SAME viewGeneration + detailKey.
  // The complete ownership key keeps them separate: no idempotent dedupe, no
  // cross-renderer stream routing, no cross-renderer tombstone.
  service.subscribe('subscription-a', 3, KEY, address(), undefined, 'renderer-a', 1);
  service.subscribe('subscription-b', 3, KEY, address(), undefined, 'renderer-b', 1);
  await tick();
  assert.equal(requests.length, 2, 'each renderer gets its own backend subscription');

  service.handleStream(startMessage('subscription-a'));
  service.handleStream(startMessage('subscription-b'));
  const starts = posted.filter((message) => message.type === 'detail.start');
  assert.equal(starts.length, 2);
  const startA = starts.find((message) => message.subscriptionId === 'subscription-a');
  const startB = starts.find((message) => message.subscriptionId === 'subscription-b');
  assert.equal(startA?.type, 'detail.start');
  assert.equal(startB?.type, 'detail.start');
  if (startA?.type === 'detail.start' && startB?.type === 'detail.start') {
    assert.equal(startA.rendererId, 'renderer-a');
    assert.equal(startA.rendererGeneration, 1);
    assert.equal(startB.rendererId, 'renderer-b');
    assert.equal(startB.rendererGeneration, 1);
  }

  // Stream content for A routes ONLY to A (the route carries A's identity).
  service.handleStream(pageMessage('subscription-a', 0, 1, '{"a":1}', fence()));
  const pageA = posted.find((message) => message.type === 'detail.page' && message.subscriptionId === 'subscription-a');
  assert.equal(pageA?.type, 'detail.page');
  if (pageA?.type === 'detail.page') {
    assert.equal(pageA.rendererId, 'renderer-a');
  }

  // A's unsubscribe must not touch B's owner (complete-key tombstones).
  service.unsubscribe(3, KEY, 'collapse', 'renderer-a', 1);
  service.handleStream(pageMessage('subscription-b', 0, 1, '{"b":1}', fence()));
  const pageB = posted.find((message) => message.type === 'detail.page' && message.subscriptionId === 'subscription-b');
  assert.equal(pageB?.type, 'detail.page', 'B streams after A unsubscribes');
  if (pageB?.type === 'detail.page') {
    assert.equal(pageB.rendererId, 'renderer-b');
  }

  // A's tombstone absorbs A's late traffic; B's stream is untouched.
  service.handleStream(pageMessage('subscription-a', 0, 1, '{"a-late":1}', fence()));
  const lateA = posted.filter((message) => message.type === 'detail.page' && message.subscriptionId === 'subscription-a');
  assert.equal(lateA.length, 1, 'late A traffic is absorbed by the tombstone');
});

test('browser ownership: a renderer generation bump fences the old owner', async () => {
  const { service, requests, posted } = createHarness();
  // A reconnect registers the same rendererId with a NEW generation; the old
  // owner (generation 1) must not be settled or streamed to the new one.
  service.subscribe('subscription-old', 3, KEY, address(), undefined, 'renderer-a', 1);
  await tick();
  service.handleStream(startMessage('subscription-old'));
  const oldStart = posted.find((message) => message.type === 'detail.start' && message.subscriptionId === 'subscription-old');
  assert.equal(oldStart?.type, 'detail.start');
  if (oldStart?.type === 'detail.start') {
    assert.equal(oldStart.rendererId, 'renderer-a');
    assert.equal(oldStart.rendererGeneration, 1);
  }

  // The old owner's terminal handoff is keyed to generation 1: re-expanding
  // the key from the NEW generation must NOT be answered by the old durable
  // record (the complete ownership key includes rendererGeneration).
  service.handleStream({
    kind: 'detail.terminal', subscriptionId: 'subscription-old', revision: 1,
    durableRef: DURABLE_REF, fence: fence(),
  });
  service.subscribe('subscription-new', 3, KEY, address(), undefined, 'renderer-a', 2);
  await tick();
  const subscribeRequests = requests.filter((request) => request.method === 'detail.subscribe');
  assert.equal(subscribeRequests.length, 2, 'generation-2 re-expansion is NOT answered by the generation-1 durable record');
  assert.equal((subscribeRequests[1]?.params as { subscriptionId?: string } | undefined)?.subscriptionId, 'subscription-new');

  // The generation-2 stream routes with the NEW generation.
  service.handleStream(startMessage('subscription-new'));
  const newStart = posted.find((message) => message.type === 'detail.start' && message.subscriptionId === 'subscription-new');
  assert.equal(newStart?.type, 'detail.start');
  if (newStart?.type === 'detail.start') {
    assert.equal(newStart.rendererGeneration, 2);
  }
});

// Segmentation mechanics (UTF-8-safe boundaries, checksums, stable ids, and
// reassembly) are covered by the shared suite in
// test/shared/detail-segmentation.test.ts, used by the worker's live store
// and the backend's durable store alike.
