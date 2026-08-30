import assert from 'node:assert/strict';
import test from 'node:test';

import { SDK_PATCH_IDENTITY_VERSION } from '../../../src/backend/sdk-patch-barrier';
import {
  WORKER_IPC_MAX_FRAME_BYTES,
  WORKER_IPC_MAX_ORDINARY_FRAME_BYTES,
  WORKER_IPC_VERSION,
  parseCoordinatorToWorkerFrame,
  parseWorkerToCoordinatorFrame,
  type WorkerFrameBase,
  type WorkerFrameExpectation,
} from '../../../src/backend/worker-protocol';

const base: WorkerFrameBase = {
  ipcVersion: WORKER_IPC_VERSION,
  coordinatorGeneration: 4,
  workerId: 'worker-1',
  workerGeneration: 7,
  workerPid: 4321,
  rootSessionPath: 'C:/sessions/root.jsonl',
  leasePath: 'C:/sessions/root.jsonl',
  leaseRevision: 3,
  sessionPath: 'C:/sessions/root.jsonl',
  seq: 11,
};

const sdkPatchIdentity = {
  identityVersion: SDK_PATCH_IDENTITY_VERSION,
  sdkPath: 'C:/sdk',
  sdkVersion: '0.80.6',
  terminalDurability: { patchVersion: 1, relativePath: 'dist/core/agent-session.js', sha256: 'a'.repeat(64) },
  retryClassifier: { patchVersion: 1, relativePath: 'dist/utils/retry.js', sha256: 'b'.repeat(64) },
  coldCreateDurability: { patchVersion: 2, relativePath: 'dist/core/session-manager.js', sha256: 'c'.repeat(64) },
  sessionOwnershipAdapter: { patchVersion: 1, relativePath: 'dist/core/session-manager.js', sha256: 'c'.repeat(64) },
  sessionReplacementAdapter: { patchVersion: 7, relativePath: 'dist/core/agent-session-runtime.js', sha256: 'd'.repeat(64) },
};

const expected: WorkerFrameExpectation = {
  coordinatorGeneration: 4,
  workerId: 'worker-1',
  workerGeneration: 7,
  workerPid: 4321,
  rootSessionPath: 'C:/sessions/root.jsonl',
  leasePath: 'C:/sessions/root.jsonl',
  leaseRevision: 3,
  sessionPath: 'C:/sessions/root.jsonl',
  expectedSeq: 11,
};

test('Phase 2 protocol accepts only its closed coordinator and worker variants', () => {
  const coordinatorFrames = [
    { ...base, kind: 'bootstrap', heartbeatIntervalMs: 1_000, sdkPatchIdentity },
    { ...base, kind: 'command', requestId: 'request-ping', operation: 'ping' },
    { ...base, kind: 'interrupt', requestId: 'request-interrupt', targetRequestId: 'request-ping', reason: 'user' },
    { ...base, kind: 'shutdown', requestId: 'request-shutdown', reason: 'coordinator shutdown' },
  ];
  const workerFrames = [
    { ...base, kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: 100 } },
    { ...base, kind: 'response', requestId: 'request-ping', ok: true, result: { kind: 'pong' } },
    { ...base, kind: 'response', requestId: 'request-ping', ok: false, error: { code: 'COMMAND_FAILED', message: 'failed', retryable: true } },
    { ...base, kind: 'heartbeat', heartbeat: { phase: 'busy', activeRequestId: 'request-ping', lastEventSeq: 2, lastDetailRevision: 3, eventLoopDelayMs: 4, lastDurableAppendId: 'entry-1' } },
    { ...base, kind: 'fatal', requestId: 'request-ping', error: { code: 'INTERNAL_ERROR', phase: 'command', message: 'failed closed' } },
  ];

  for (const frame of coordinatorFrames) assert.equal(parseCoordinatorToWorkerFrame(frame, expected).status, 'accepted');
  for (const frame of workerFrames) assert.equal(parseWorkerToCoordinatorFrame(frame, expected).status, 'accepted');
  assert.equal(parseWorkerToCoordinatorFrame(coordinatorFrames[1], expected).status, 'invalid', 'direction is closed');
  assert.equal(parseCoordinatorToWorkerFrame(workerFrames[0], expected).status, 'invalid', 'direction is closed');
});

test('Phase 4 protocol accepts every closed runtime, ownership, provider, and sync frame family', () => {
  const lease = {
    coordinatorGeneration: 4,
    workerId: 'worker-1',
    workerGeneration: 7,
    canonicalSessionPath: base.leasePath,
    ownershipRevision: base.leaseRevision,
    nonce: 'source-nonce',
  };
  const reservation = {
    reservationId: 'reservation-1',
    operationId: 'operation-1',
    canonicalSourcePath: base.leasePath,
    canonicalDestinationPath: 'C:/sessions/destination.jsonl',
    ownershipRevision: 4,
    nonce: 'reservation-nonce',
    destinationFingerprint: { exists: false, size: 0, sha256: null },
  };
  const authorization = {
    authorizationId: 'authorization-1',
    reservationId: reservation.reservationId,
    canonicalDestinationPath: reservation.canonicalDestinationPath,
    ownershipRevision: reservation.ownershipRevision,
    nonce: 'transfer-nonce',
    destinationLease: {
      coordinatorGeneration: 4,
      workerId: 'worker-1',
      workerGeneration: 7,
      canonicalSessionPath: reservation.canonicalDestinationPath,
      ownershipRevision: reservation.ownershipRevision,
      nonce: 'destination-nonce',
    },
  };
  const coordinatorFrames = [
    {
      ...base, kind: 'runtime.promote', requestId: 'promote', operationId: 'operation-1',
      payload: {
        sdkPath: 'C:/sdk', agentDir: 'C:/agent', startupCwd: 'C:/work', sessionDir: 'C:/sessions',
        sessionPath: base.leasePath, creationReason: 'resume', writeLease: lease,
        openedPayload: { runtimeReady: false }, modelSettings: { defaultModel: 'gpt' },
      },
    },
    { ...base, kind: 'runtime.command', requestId: 'command', operation: 'message.send', payload: { params: { text: 'hello' }, publicRequestId: 'public-1' } },
    { ...base, kind: 'ownership.reserved', requestId: 'reserve', reservation },
    { ...base, kind: 'ownership.committed', requestId: 'commit', authorization },
    { ...base, kind: 'ownership.aborted', requestId: 'abort', reservationId: reservation.reservationId },
    { ...base, kind: 'ownership.rejected', requestId: 'rejected', phase: 'reserve', code: 'OWNERSHIP_CONFLICT', message: 'busy', retryable: true },
    { ...base, kind: 'ownership.runtimeReadyAck', requestId: 'runtime-ready', canonicalPath: base.leasePath, ownershipRevision: base.leaseRevision },
    { ...base, kind: 'provider.granted', requestId: 'provider', lease: { leaseId: 'lease-1', provider: 'openai', model: 'gpt', grantedAt: 100, headerWaitMs: 120_000, streamIdleTimeoutMs: 120_000 } },
    { ...base, kind: 'provider.cancelled', requestId: 'provider', reason: 'aborted' },
    {
      ...base, kind: 'provider.rejected', requestId: 'provider',
      error: { name: 'ProviderGateSaturatedError', message: 'retry later', retryable: true, httpStatus: 429 },
    },
    { ...base, kind: 'provider.cancelAck', requestId: 'cancel', targetRequestId: 'provider', status: 'granted', leaseId: 'lease-1' },
    { ...base, kind: 'provider.released', requestId: 'release', leaseId: 'lease-1' },
    { ...base, kind: 'settings.authoritative', requestId: 'settings-write', revision: 2, values: { defaultModel: 'gpt' } },
    { ...base, kind: 'sync', requestId: 'settings', domain: 'settings', revision: 1, payload: { values: { theme: 'dark' } } },
    { ...base, kind: 'sync', requestId: 'catalog', domain: 'catalog', revision: 9, payload: { models: [{ id: 'gpt' }] } },
    { ...base, kind: 'sync', requestId: 'auth', domain: 'auth', revision: 2, payload: { authPath: 'C:/auth', fingerprint: 'fingerprint' } },
    { ...base, kind: 'sync', requestId: 'prefs', domain: 'runtimePrefs', revision: 3, payload: { values: { autonomousMode: true } } },
    { ...base, kind: 'sync', requestId: 'policy', domain: 'providerPolicy', revision: 4, payload: { providers: { openai: { maxConcurrent: 1 } } } },
    {
      ...base, kind: 'sync', requestId: 'registry', domain: 'sessionRegistry', revision: 5,
      payload: { tabs: [{ path: 'C:/sessions/root.jsonl', pinned: true, isRunning: false }] },
    },
  ];
  const workerFrames = [
    { ...base, kind: 'runtime.ready', requestId: 'promote', runtimeMetadata: { mode: 'phase4', startedAt: 100 } },
    { ...base, kind: 'response', requestId: 'command', ok: true, result: { kind: 'runtime.command', payload: { accepted: true } } },
    { ...base, kind: 'sync.ack', requestId: 'sync-worker-request', domain: 'settings', revision: 1 },
    { ...base, kind: 'runtime.event', event: 'message.delta', payload: { delta: 'hello' } },
    { ...base, kind: 'runtime.event', event: 'error', payload: { code: 'PROMPT_FAILED', message: 'failed' } },
    {
      ...base, kind: 'ownership.reserve', requestId: 'reserve',
      intent: { operationId: 'operation-1', reason: 'switch', source: lease, destinationPath: reservation.canonicalDestinationPath, destinationMustNotExist: false },
    },
    { ...base, kind: 'ownership.commit', requestId: 'commit', reservation, sourceLease: lease },
    { ...base, kind: 'ownership.abort', requestId: 'abort', reservation, reason: 'cancelled' },
    { ...base, kind: 'ownership.runtimeReady', requestId: 'runtime-ready', lease, canonicalPath: base.leasePath },
    { ...base, kind: 'provider.acquire', requestId: 'provider', request: { provider: 'openai', model: 'gpt', turnId: 'turn-1', attemptId: 'attempt-1' } },
    { ...base, kind: 'provider.cancel', requestId: 'cancel', targetRequestId: 'provider', reason: 'aborted' },
    { ...base, kind: 'provider.observation', leaseId: 'lease-1', observation: { classification: 'http-error', status: 429, retryable: true } },
    { ...base, kind: 'provider.release', requestId: 'release', leaseId: 'lease-1', outcome: 'cancelled' },
    { ...base, kind: 'settings.mutate', requestId: 'settings-write', updates: { defaultModel: 'gpt' } },
    { ...base, kind: 'runtime.report', domain: 'catalog', payload: { models: [{ id: 'runtime-discovered', reasoning: false }] } },
  ];
  for (const frame of coordinatorFrames) assert.equal(parseCoordinatorToWorkerFrame(frame, expected).status, 'accepted', frame.kind);
  for (const frame of workerFrames) assert.equal(parseWorkerToCoordinatorFrame(frame, expected).status, 'accepted', frame.kind);

  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, kind: 'sync', requestId: 'bad-registry', domain: 'sessionRegistry', revision: 5,
    payload: { tabs: 'not-an-array' },
  }, expected).status, 'invalid');

  // runtime.report is closed to the catalog domain and its models payload.
  for (const frame of [
    { ...base, kind: 'runtime.report', domain: 'provider', payload: { models: [] } },
    { ...base, kind: 'runtime.report', domain: 'catalog', payload: { models: 'not-an-array' } },
    { ...base, kind: 'runtime.report', domain: 'catalog', payload: { models: [] }, extra: true },
  ]) {
    assert.notEqual(parseWorkerToCoordinatorFrame(frame, expected).status, 'accepted', frame.kind);
  }

  const destinationBase = {
    ...base,
    leasePath: reservation.canonicalDestinationPath,
    leaseRevision: reservation.ownershipRevision,
  };
  const destinationExpected = {
    ...expected,
    leasePath: reservation.canonicalDestinationPath,
    leaseRevision: reservation.ownershipRevision,
  };
  assert.equal(parseWorkerToCoordinatorFrame({
    ...destinationBase,
    kind: 'ownership.consume', requestId: 'consume', authorization,
    canonicalDestinationPath: reservation.canonicalDestinationPath,
  }, destinationExpected).status, 'accepted');
  assert.equal(parseCoordinatorToWorkerFrame({
    ...destinationBase,
    kind: 'ownership.consumed', requestId: 'consume', authorizationId: authorization.authorizationId,
    lease: authorization.destinationLease,
  }, destinationExpected).status, 'accepted');
});

test('Phase 5 private protocol accepts subscribe/unsubscribe/fetch and six closed detail stream variants', () => {
  const address = {
    sessionPath: base.leasePath, turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'root-attempt',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };
  const payload = {
    kind: 'json-segment', encoding: 'utf8-json', segmentId: 'segment-1', semanticPath: [],
    startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4, text: 'null',
  };
  const durableRef = {
    key: 'durable:key', kind: 'tool-result', source: 'durable', sessionPath: base.leasePath,
    messageId: 'entry-1', toolCallId: 'tool-1', sizeBytes: 4, summary: 'detail', available: true,
  };
  const coordinatorFrames = [
    { ...base, kind: 'detail.subscribe', requestId: 'subscribe', subscriptionId: 'subscription-1', address, cursor: { revision: 1 }, maxPageBytes: 4096 },
    { ...base, kind: 'detail.unsubscribe', requestId: 'unsubscribe', subscriptionId: 'subscription-1' },
    { ...base, kind: 'detail.fetch', requestId: 'fetch', subscriptionId: 'subscription-1', address, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, maxPageBytes: 4096 },
  ];
  const workerFrames = [
    { ...base, kind: 'detail.start', requestId: 'subscribe', subscriptionId: 'subscription-1', address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 },
    { ...base, kind: 'detail.page', subscriptionId: 'subscription-1', ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload, payloadBytes: Buffer.byteLength(JSON.stringify(payload)), checksum: 'a'.repeat(64) },
    { ...base, kind: 'detail.delta', subscriptionId: 'subscription-1', baseRevision: 1, revision: 2, operations: [{ op: 'appendString', path: ['text'], value: 'x' }] },
    { ...base, kind: 'detail.rebase', subscriptionId: 'subscription-1', currentRevision: 2, reason: 'gap' },
    { ...base, kind: 'detail.terminal', subscriptionId: 'subscription-1', revision: 2, durableRef },
    { ...base, kind: 'detail.error', requestId: 'fetch', subscriptionId: 'subscription-1', code: 'UNAVAILABLE', message: 'retry', retryable: true },
    { ...base, kind: 'detail.unsubscribed', requestId: 'unsubscribe', subscriptionId: 'subscription-1' },
  ];
  for (const frame of coordinatorFrames) assert.equal(parseCoordinatorToWorkerFrame(frame, expected).status, 'accepted', frame.kind);
  for (const frame of workerFrames) assert.equal(parseWorkerToCoordinatorFrame(frame, expected).status, 'accepted', frame.kind);
  assert.equal(parseWorkerToCoordinatorFrame({ ...workerFrames[2], surprise: true }, expected).status, 'invalid');
});

test('Phase 4 identity rejects root alias drift and stale lease path or revision', () => {
  const frame = { ...base, kind: 'runtime.event', event: 'busy.changed', payload: { busy: true } };
  for (const changed of [
    { ...frame, rootSessionPath: 'C:/sessions/other-root.jsonl' },
    { ...frame, sessionPath: 'C:/sessions/other-root.jsonl' },
    { ...frame, leasePath: 'C:/sessions/old-lease.jsonl' },
    { ...frame, leaseRevision: base.leaseRevision - 1 },
  ]) assert.equal(parseWorkerToCoordinatorFrame(changed, expected).status, 'invalid');
});

test('protocol rejects exact extra fields, malformed correlated unions, and unsafe integers', () => {
  const extraRoot = parseCoordinatorToWorkerFrame({
    ...base, kind: 'command', requestId: 'request', operation: 'ping', payload: {},
  }, expected);
  assert.equal(extraRoot.status, 'invalid');
  if (extraRoot.status === 'invalid') assert.match(extraRoot.detail, /unknown field payload/);

  const extraNested = parseWorkerToCoordinatorFrame({
    ...base, kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: 1, extra: true },
  }, expected);
  assert.equal(extraNested.status, 'invalid');
  if (extraNested.status === 'invalid') assert.match(extraNested.detail, /unknown field extra/);

  assert.equal(parseWorkerToCoordinatorFrame({
    ...base, kind: 'response', requestId: 'request', ok: true,
    result: { kind: 'pong' }, error: { code: 'COMMAND_FAILED', message: 'x', retryable: false },
  }, expected).status, 'invalid');
  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, seq: Number.MAX_SAFE_INTEGER + 1, kind: 'command', requestId: 'request', operation: 'ping',
  }, expected).status, 'invalid');
  assert.equal(parseWorkerToCoordinatorFrame({
    ...base, kind: 'heartbeat', heartbeat: { phase: 'ready', lastEventSeq: 0, lastDetailRevision: 0, eventLoopDelayMs: 0.5 },
  }, expected).status, 'invalid');
  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, kind: 'bootstrap', heartbeatIntervalMs: 1_000,
    sdkPatchIdentity: { ...sdkPatchIdentity, extra: true },
  }, expected).status, 'invalid');
  const { coldCreateDurability: _missingColdCreate, ...missingColdCreateIdentity } = sdkPatchIdentity;
  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, kind: 'bootstrap', heartbeatIntervalMs: 1_000,
    sdkPatchIdentity: missingColdCreateIdentity,
  }, expected).status, 'invalid');
  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, kind: 'provider.rejected', requestId: 'provider',
    error: { name: 'ProviderGateSaturatedError', message: 'retry later', retryable: true, httpStatus: 700 },
  }, expected).status, 'invalid');
  assert.equal(parseCoordinatorToWorkerFrame({
    ...base, kind: 'provider.rejected', requestId: 'provider',
    error: { name: 'ProviderGateSaturatedError', message: 'retry later', retryable: true, surprise: true },
  }, expected).status, 'invalid');
});

test('generation and sequence fences distinguish stale frames from invalid current/future frames', () => {
  const ready = { ...base, kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: 1 } };

  const oldCoordinator = parseWorkerToCoordinatorFrame({ ...ready, coordinatorGeneration: 3 }, expected);
  assert.deepEqual(oldCoordinator.status === 'stale' && oldCoordinator.reason, 'coordinator_generation');
  const oldWorker = parseWorkerToCoordinatorFrame({ ...ready, workerGeneration: 6 }, expected);
  assert.deepEqual(oldWorker.status === 'stale' && oldWorker.reason, 'worker_generation');
  const duplicate = parseWorkerToCoordinatorFrame({ ...ready, seq: 10 }, expected);
  assert.deepEqual(duplicate.status === 'stale' && duplicate.reason, 'sequence');

  for (const frame of [
    { ...ready, coordinatorGeneration: 5 },
    { ...ready, workerGeneration: 8 },
    { ...ready, workerPid: 9999 },
    { ...ready, workerId: 'other' },
    { ...ready, sessionPath: 'C:/sessions/other.jsonl' },
    { ...ready, seq: 12 },
  ]) assert.equal(parseWorkerToCoordinatorFrame(frame, expected).status, 'invalid');

  const malformedOld = parseWorkerToCoordinatorFrame({ ...ready, workerGeneration: 6, surprise: true }, expected);
  assert.equal(malformedOld.status, 'invalid', 'malformed old-generation traffic is not classified as a valid stale frame');
});

test('protocol enforces UTF-8 hard and tighter ordinary frame bounds before dispatch', () => {
  const ordinaryOversize = parseWorkerToCoordinatorFrame({
    ...base,
    kind: 'runtime.event',
    event: 'message.delta',
    payload: { text: 'é'.repeat(WORKER_IPC_MAX_ORDINARY_FRAME_BYTES) },
  }, expected);
  assert.equal(ordinaryOversize.status, 'invalid');
  if (ordinaryOversize.status === 'invalid') assert.equal(ordinaryOversize.reason, 'ordinary_frame_too_large');

  const heartbeatOversize = parseWorkerToCoordinatorFrame({
    ...base,
    kind: 'heartbeat',
    heartbeat: {
      phase: 'busy', activeRequestId: 'é'.repeat(16 * 1024),
      lastEventSeq: 0, lastDetailRevision: 0, eventLoopDelayMs: 0,
    },
  }, expected);
  assert.equal(heartbeatOversize.status, 'invalid');
  if (heartbeatOversize.status === 'invalid') assert.equal(heartbeatOversize.reason, 'heartbeat_frame_too_large');

  const hardOversize = parseCoordinatorToWorkerFrame({
    ...base,
    kind: 'shutdown',
    requestId: 'request',
    reason: 'x'.repeat(WORKER_IPC_MAX_FRAME_BYTES + 1),
  }, expected);
  assert.equal(hardOversize.status, 'invalid');
  if (hardOversize.status === 'invalid') assert.equal(hardOversize.reason, 'frame_too_large');
});

test('protocol allows large control and session.opened frames up to the wire cap', () => {
  const largeTranscript = 'x'.repeat(WORKER_IPC_MAX_ORDINARY_FRAME_BYTES * 2);
  const lease = {
    coordinatorGeneration: base.coordinatorGeneration,
    workerId: base.workerId,
    workerGeneration: base.workerGeneration,
    canonicalSessionPath: base.leasePath,
    ownershipRevision: base.leaseRevision,
    nonce: 'source-nonce',
  };

  const promote = parseCoordinatorToWorkerFrame({
    ...base,
    kind: 'runtime.promote',
    requestId: 'promote',
    operationId: 'operation-1',
    payload: {
      sdkPath: 'C:/sdk', agentDir: 'C:/agent', startupCwd: 'C:/work', sessionDir: 'C:/sessions',
      sessionPath: base.leasePath, creationReason: 'resume', writeLease: lease,
      openedPayload: { runtimeReady: false, transcript: [{ role: 'user', text: largeTranscript }] },
      modelSettings: { defaultModel: 'gpt' },
    },
  }, expected);
  assert.equal(promote.status, 'accepted', 'runtime.promote may carry a large promotion snapshot');

  const sessionOpened = parseWorkerToCoordinatorFrame({
    ...base,
    kind: 'runtime.event',
    event: 'session.opened',
    payload: { sessionPath: base.leasePath, transcript: [{ role: 'user', text: largeTranscript }] },
  }, expected);
  assert.equal(sessionOpened.status, 'accepted', 'session.opened may re-emit a large transcript');
});
