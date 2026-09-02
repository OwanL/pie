import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';
import type { ProviderIncident } from '../../../src/backend/provider-incident';
import type { ProviderTransportObservation } from '../../../src/backend/provider-progress-bus';
import { WorkerRuntimeHost } from '../../../src/backend/worker-runtime-host';
import type { SessionOpenedPayload } from '../../../src/shared/protocol';

interface WorkerRuntimeHostInternals {
  context?: SessionContext;
  agentDir: string;
  availableModels: () => unknown;
  openedPayload?: SessionOpenedPayload;
  buildOpenedPayload: (
    sessionPath: string,
    selectionToken?: string,
    operationId?: string,
    operationAttempt?: number,
  ) => Promise<SessionOpenedPayload>;
  emitRefreshedSessionOpened: (sessionPath: string) => Promise<void>;
  handleSessionEvent: (context: SessionContext, event: SdkSessionEvent) => void;
  handleProviderIncident: (incident: ProviderIncident) => void;
  handleProviderProgress: (observation: ProviderTransportObservation) => void;
  recoverStuckSession: (context: SessionContext, reason: string) => void;
  resolveNetworkProvider: (url: string, fallbackProvider?: string) => string | undefined;
}

function makeHost(options: { automaticRecoveryAbortGraceMs?: number; quotaSettlementGraceMs?: number } = {}): {
  host: WorkerRuntimeHost;
  sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }>;
  runtimeFailures: Error[];
} {
  const sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }> = [];
  const runtimeFailures: Error[] = [];
  const server = {
    sendFrame: (frame: any) => { sent.push(frame); return true; },
    sendDetailFrame: () => true,
    failRuntime: (error: Error) => { runtimeFailures.push(error); },
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
    ...options,
  } as never);
  return { host, sent, runtimeFailures };
}

function getInternals(host: WorkerRuntimeHost): WorkerRuntimeHostInternals {
  return host as unknown as WorkerRuntimeHostInternals;
}

function makeOpenedPayload(
  sessionPath: string,
  transcript: SessionOpenedPayload['transcript'],
  overrides: Partial<SessionOpenedPayload> = {},
): SessionOpenedPayload {
  return {
    session: {
      path: sessionPath,
      name: 'Session',
      cwd: '/',
      modifiedAt: new Date(0).toISOString(),
      messageCount: transcript.length,
    },
    transcript,
    transcriptWindow: {
      totalCount: transcript.length,
      loadedStart: 0,
      loadedEnd: transcript.length,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: transcript.length > 0,
    },
    busy: false,
    ...overrides,
  };
}

function makeSessionEventContext(sessionPath: string): SessionContext {
  return {
    runtime: {} as SessionContext['runtime'],
    session: {} as SessionContext['session'],
    sessionPath,
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'request-1', messageIndex: 0, aborted: true },
  };
}

function waitForAsyncEvent(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('priority interrupt cancels deferred hard-compaction continuation ownership', async () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  let cancelCalls = 0;
  const activeRequest = { id: 'request-1', messageIndex: 1, aborted: false };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      clearQueue() {},
      cancelPendingHardCompactionContinuation() { cancelCalls += 1; },
      async abort() {},
    } as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest,
    hardCompactionContinuationPending: true,
  };

  assert.deepEqual(await host.interrupt(), { interrupted: true, settled: true });
  assert.equal(cancelCalls, 1);
  assert.equal(internals.context.hardCompactionContinuationPending, false);
  assert.equal(activeRequest.aborted, true);
});

test('priority interrupt detaches a re-armed request when abort emits no agent_end', async () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const activeRequest = { id: 'request-1', messageIndex: 1, aborted: false };
  let watchdogClears = 0;
  const session = {
    isStreaming: true,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    clearQueue() {},
    cancelPendingHardCompactionContinuation() {},
    async abort() { session.isStreaming = false; },
  };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: session as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest,
    hardCompactionContinuationPending: true,
    willRetryWatchdogClear: () => { watchdogClears += 1; },
  };

  assert.deepEqual(await host.interrupt(), { interrupted: true, settled: true });
  assert.equal(internals.context.activeRequest, undefined);
  assert.equal(watchdogClears, 1);
  assert.equal(
    sent.some((frame) => frame.event === 'busy.changed'
      && (frame.payload as { busy?: unknown } | undefined)?.busy === false),
    true,
  );
});

test('automatic semantic recovery fails the worker once when session.abort never settles', async () => {
  const { host, sent, runtimeFailures } = makeHost({ automaticRecoveryAbortGraceMs: 10 });
  const internals = getInternals(host);
  let abortCalls = 0;
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      clearQueue: () => undefined,
      abort: () => {
        abortCalls += 1;
        return new Promise<void>(() => undefined);
      },
    } as unknown as SessionContext['session'],
    sessionPath: '/sessions/stuck-semantic.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'stuck-request', messageIndex: 1, aborted: false },
  };
  internals.context = context;

  internals.recoverStuckSession(context, 'The provider stopped producing semantic response events.');
  internals.recoverStuckSession(context, 'duplicate watchdog signal');
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(abortCalls, 1, 'overlapping watchdogs share one abort attempt');
  assert.equal(runtimeFailures.length, 1, 'the stuck runtime fails closed exactly once');
  assert.match(runtimeFailures[0]!.message, /did not settle within 10ms/);
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]!.payload, {
    incidentId: 'runtime-recovery:stuck-request',
    code: 'SESSION_RUNTIME_RECOVERY_FAILED',
    message: 'The provider stopped producing semantic response events.',
    detail: 'Automatic session recovery abort or terminalization did not settle within 10ms.',
    sessionPath: context.sessionPath,
    requestId: 'stuck-request',
  });

  internals.recoverStuckSession(context, 'late duplicate watchdog signal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(abortCalls, 1);
  assert.equal(runtimeFailures.length, 1, 'terminal recovery ownership remains fenced until worker exit');
});

test('automatic semantic recovery fails closed when abort resolves without terminalizing its request', async () => {
  const { host, sent, runtimeFailures } = makeHost({ automaticRecoveryAbortGraceMs: 15 });
  const internals = getInternals(host);
  let abortCalls = 0;
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      clearQueue: () => undefined,
      abort: async () => { abortCalls += 1; },
    } as unknown as SessionContext['session'],
    sessionPath: '/sessions/abort-resolved-without-terminal.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'still-owned-request', messageIndex: 1, aborted: false },
  };
  internals.context = context;

  internals.recoverStuckSession(context, 'The provider stopped producing semantic response events.');
  await new Promise((resolve) => setTimeout(resolve, 35));

  // Same watchdog-race wait as the quota recovery test above.
  const settledDeadline = Date.now() + 2_000;
  while (runtimeFailures.length === 0 && Date.now() < settledDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(abortCalls, 1);
  assert.equal(context.activeRequest?.id, 'still-owned-request');
  assert.equal(runtimeFailures.length, 1);
  assert.match(runtimeFailures[0]!.message, /terminalization did not settle|owned request did not terminalize/);
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 1);
  assert.match(String((errors[0]!.payload as { detail?: string }).detail), /terminalization did not settle|did not terminalize/);
});

test('automatic semantic recovery accepts a terminal lifecycle event after abort resolves', async () => {
  const { host, runtimeFailures } = makeHost({ automaticRecoveryAbortGraceMs: 40 });
  const internals = getInternals(host);
  let abortCalls = 0;
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      clearQueue: () => undefined,
      abort: async () => {
        abortCalls += 1;
        setTimeout(() => { context.activeRequest = undefined; }, 5);
      },
    } as unknown as SessionContext['session'],
    sessionPath: '/sessions/abort-delayed-terminal.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'settling-request', messageIndex: 1, aborted: false },
  };
  internals.context = context;

  internals.recoverStuckSession(context, 'The provider stopped producing semantic response events.');
  await new Promise((resolve) => setTimeout(resolve, 55));

  assert.equal(abortCalls, 1);
  assert.equal(context.activeRequest, undefined);
  assert.equal(runtimeFailures.length, 0);
});

test('quota recovery uses the bounded abort watchdog when session.abort never settles', async () => {
  const { host, sent, runtimeFailures } = makeHost({
    automaticRecoveryAbortGraceMs: 10,
    quotaSettlementGraceMs: 5,
  });
  const internals = getInternals(host);
  let abortCalls = 0;
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      clearQueue: () => undefined,
      abort: () => {
        abortCalls += 1;
        return new Promise<void>(() => undefined);
      },
      sessionManager: { getSessionId: () => 'session-quota' },
    } as unknown as SessionContext['session'],
    sessionPath: '/sessions/stuck-quota.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: { id: 'quota-request', messageIndex: 1, aborted: false },
  };
  internals.context = context;

  internals.handleProviderIncident({
    kind: 'quota_exhausted',
    providerHost: 'api.example.test',
    sessionId: 'session-quota',
    userMessage: 'Provider quota is exhausted.',
    detail: 'fixture quota response',
    occurredAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 35));

  // The abort watchdog callback races this test's timers under full-suite
  // load; wait for the recovery outcome instead of assuming one fixed sleep
  // covers the watchdog's post-fire async work.
  const deadline = Date.now() + 2_000;
  while (runtimeFailures.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(abortCalls, 1);
  assert.equal(runtimeFailures.length, 1, 'quota recovery fails the stuck runtime closed exactly once');
  assert.match(runtimeFailures[0]!.message, /did not settle within 10ms/);
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 2, 'the provider incident and bounded recovery failure are both visible');
  assert.equal((errors[1]!.payload as { code?: string }).code, 'SESSION_RUNTIME_RECOVERY_FAILED');
});

test('agent_end refreshes session.opened from the current session and preserves cached operation identity', async () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const sessionPath = '/sessions/current.jsonl';
  const sourceSessionPath = '/sessions/source.jsonl';
  const freshTranscript = [{ role: 'user', content: 'fresh transcript' }] as unknown as SessionOpenedPayload['transcript'];
  const cachedPayload = makeOpenedPayload(sessionPath, [], {
    selectionToken: 'selection-1',
    operationId: 'operation-1',
    operationAttempt: 3,
    replacesSessionPath: sourceSessionPath,
  });
  const rebuildCalls: Array<[string, string | undefined, string | undefined, number | undefined]> = [];

  internals.openedPayload = cachedPayload;
  internals.buildOpenedPayload = async (openedPath, selectionToken, operationId, operationAttempt) => {
    rebuildCalls.push([openedPath, selectionToken, operationId, operationAttempt]);
    return makeOpenedPayload(openedPath, freshTranscript, { selectionToken, operationId, operationAttempt });
  };

  internals.handleSessionEvent(makeSessionEventContext(sessionPath), { type: 'agent_end' });
  await waitForAsyncEvent();

  assert.deepEqual(rebuildCalls, [[sessionPath, 'selection-1', 'operation-1', 3]]);
  const openedFrames = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'session.opened');
  assert.equal(openedFrames.length, 1);
  const emittedPayload = openedFrames[0]!.payload as SessionOpenedPayload;
  assert.deepEqual(emittedPayload.transcript, freshTranscript);
  assert.equal(emittedPayload.transcriptWindow.totalCount, 1);
  assert.equal(emittedPayload.selectionToken, 'selection-1');
  assert.equal(emittedPayload.operationId, 'operation-1');
  assert.equal(emittedPayload.operationAttempt, 3);
  assert.equal(emittedPayload.replacesSessionPath, sourceSessionPath);
  assert.equal(emittedPayload.runtimeReady, true);
});

test('session.opened refresh falls back to the cached payload when rebuilding throws', async () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const sessionPath = '/sessions/current.jsonl';
  const cachedPayload = makeOpenedPayload(sessionPath, [], {
    selectionToken: 'selection-1',
    operationId: 'operation-1',
    operationAttempt: 3,
  });

  internals.openedPayload = cachedPayload;
  internals.buildOpenedPayload = async () => {
    throw new Error('session changed during refresh');
  };

  await assert.doesNotReject(() => internals.emitRefreshedSessionOpened(sessionPath));

  const openedFrames = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'session.opened');
  assert.equal(openedFrames.length, 1);
  assert.deepEqual(openedFrames[0]!.payload, { ...cachedPayload, runtimeReady: true });
});

test('host applies monotonic sync domains and keeps the session registry live in worker env', () => {
  const { host } = makeHost();
  const savedTabs = process.env.PIE_OPEN_TABS;
  const savedRevision = process.env.PIE_OPEN_TABS_REVISION;
  const savedBucketCanSpawn = process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON;
  try {
    host.applySync('catalog', 1, { models: [{ id: 'configured-c', name: 'Configured C', provider: 'phase-0', reasoning: false }] });
    host.applySync('settings', 1, { values: { defaultModel: 'configured-c' } });
    host.applySync('runtimePrefs', 1, {
      values: {
        autonomousMode: true,
        subagentBucketCanSpawn: { small: false, medium: false, frontier: true },
      },
    });
    host.applySync('sessionRegistry', 1, {
      tabs: [{ path: '/sessions/a.jsonl', pinned: true, isRunning: false }],
    });
    assert.deepEqual(JSON.parse(process.env.PIE_OPEN_TABS ?? 'null'), [
      { path: '/sessions/a.jsonl', pinned: true, isRunning: false },
    ]);
    assert.equal(process.env.PIE_OPEN_TABS_REVISION, '1');
    assert.deepEqual(JSON.parse(process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON ?? 'null'), {
      small: false,
      medium: false,
      frontier: true,
    });
    assert.throws(() => host.applySync('catalog', 1, { models: [] }), /Stale worker sync revision/);
    assert.throws(() => host.applySync('sessionRegistry', 1, { tabs: [] }), /Stale worker sync revision/);
    assert.throws(() => host.applySync('catalog', 0, { models: [] }), /Stale worker sync revision/);
    host.applySync('catalog', 2, { models: [{ id: 'configured-d' }] });
    host.applySync('sessionRegistry', 2, { tabs: [] });
    assert.deepEqual(JSON.parse(process.env.PIE_OPEN_TABS ?? 'null'), []);
    assert.equal(process.env.PIE_OPEN_TABS_REVISION, '2');
  } finally {
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS;
    else process.env.PIE_OPEN_TABS = savedTabs;
    if (savedRevision === undefined) delete process.env.PIE_OPEN_TABS_REVISION;
    else process.env.PIE_OPEN_TABS_REVISION = savedRevision;
    if (savedBucketCanSpawn === undefined) delete process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON;
    else process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON = savedBucketCanSpawn;
  }
});

test('worker-owned provider incidents surface a specific, deduplicated UI error', () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const context = makeSessionEventContext('/sessions/provider.jsonl');
  context.session = {
    sessionManager: { getSessionId: () => 'sdk-session-1' },
  } as SessionContext['session'];
  internals.context = context;
  const incident: ProviderIncident = {
    sessionId: 'sdk-session-1',
    requestId: 'provider-request-1',
    providerHost: 'api.openai.com',
    kind: 'rate_limited',
    occurredAt: 1,
    status: 429,
    retryAfterMs: 5_000,
    retryAt: 5_001,
    userMessage: 'OpenAI rate-limited this request (HTTP 429).',
    detail: 'provider=api.openai.com; status=429; retryAfterMs=5000',
  };

  internals.handleProviderIncident(incident);
  internals.handleProviderIncident(incident);
  internals.handleProviderIncident({ ...incident, sessionId: 'another-session' });

  assert.equal(context.activeRequest?.latestProviderIncident, incident);
  assert.equal(context.activeRequest?.lastProviderErrorForDiagnostics, incident.userMessage);
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 1, 'SDK retries of the same incident do not flood the UI');
  assert.deepEqual(errors[0]?.payload, {
    incidentId: 'provider:request-1:rate_limited:api.openai.com:429:5001',
    code: 'PROVIDER_RATE_LIMITED',
    message: incident.userMessage,
    detail: incident.detail,
    sessionPath: '/sessions/provider.jsonl',
    requestId: 'request-1',
  });
});

test('worker-owned provider progress restores queue phase and latency ownership', () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const context = makeSessionEventContext('/sessions/provider.jsonl');
  context.session = {
    sessionManager: { getSessionId: () => 'sdk-session-1' },
  } as SessionContext['session'];
  const semantic: Array<{ kind: string; phase?: string }> = [];
  context.activeRequest = {
    id: 'request-1', messageIndex: 0, aborted: false, providerTurnSequence: 4,
    liveTurnAccumulator: {
      currentSeq: 2,
      observe: (event: { kind: string; phase?: string }) => {
        semantic.push(event);
        return { ...event, protocolVersion: 1, sessionPath: context.sessionPath, requestId: 'request-1', turnId: 'turn', attemptId: 'attempt', seq: semantic.length + 2, occurredAt: 1, checkpointBytes: 1 };
      },
    } as never,
  };
  internals.context = context;
  const base = {
    sessionId: 'sdk-session-1', provider: 'provider', attemptId: 'network-attempt', occurredAt: 10,
  };

  internals.handleProviderProgress({ ...base, kind: 'gate_queue' });
  internals.handleProviderProgress({ ...base, kind: 'gate_acquired', occurredAt: 35, queueDurationMs: 25 });
  internals.handleProviderProgress({ ...base, kind: 'headers_wait', occurredAt: 36 });

  assert.deepEqual(context.activeRequest.providerQueueByTurn?.get(4), { durationMs: 25, attemptCount: 1 });
  assert.deepEqual(semantic.map((event) => event.phase), ['queued', 'waiting_provider']);
  assert.equal(context.activeRequest.providerNetworkPending, true);
  assert.equal(sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'live.semantic').length, 2);
  internals.handleProviderProgress({ ...base, kind: 'raw_chunk', occurredAt: 37 });
  assert.equal(context.activeRequest.providerNetworkPending, false,
    'the exact request correlation clears at its first upstream body chunk');
  internals.handleProviderProgress({ ...base, sessionId: 'other-session', kind: 'gate_acquired', queueDurationMs: 99 });
  assert.deepEqual(context.activeRequest.providerQueueByTurn?.get(4), { durationMs: 25, attemptCount: 1 });
});

test('worker network admission uses runtime-discovered provider URLs before the root fallback', () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  host.applySync('providerPolicy', 1, {
    providers: {
      'github-copilot': { maxConcurrentRequests: 2 },
      openai: { maxConcurrentRequests: 4, baseUrl: 'https://chatgpt.com/backend-api' },
    },
  });
  const context = makeSessionEventContext('/sessions/provider-routing.jsonl');
  context.runtime = {
    services: {
      modelRegistry: {
        getAvailable: () => [{
          id: 'copilot-model', name: 'Copilot model', provider: 'github-copilot',
          reasoning: true, input: ['text'], baseUrl: 'https://copilot.enterprise.example/api',
        }],
        getAll: () => [{
          id: 'copilot-model', provider: 'github-copilot',
          baseUrl: 'https://copilot.enterprise.example/api',
        }],
      },
    },
  } as unknown as SessionContext['runtime'];
  internals.context = context;

  assert.equal(
    internals.resolveNetworkProvider('https://copilot.enterprise.example/api/chat/completions', 'openai'),
    'github-copilot',
  );
  assert.equal(
    internals.resolveNetworkProvider('https://chatgpt.com/backend-api/codex/responses', 'github-copilot'),
    'openai',
  );
  assert.equal(
    internals.resolveNetworkProvider('https://chatgpt.com/backend-api-v10/codex/responses', 'github-copilot'),
    'github-copilot',
    'a sibling path must not match a configured provider prefix',
  );
  assert.equal(
    internals.resolveNetworkProvider('https://chatgpt.com.evil.example/backend-api/codex/responses', 'github-copilot'),
    'github-copilot',
    'a sibling host must not match a configured provider origin',
  );
  assert.equal(internals.resolveNetworkProvider('https://unmapped.example/v1', 'openai'), 'openai');
});

test('hot worker model discovery preserves pricing and exact reasoning metadata', () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-hot-model-pricing-'));
  try {
    fs.writeFileSync(path.join(agentDir, 'model-profiles.json'), JSON.stringify({
      profiles: [{ provider: 'mock', id: 'priced-model', eligible: true }],
    }));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        mock: {
          models: [{
            id: 'priced-model', name: 'Priced model', reasoning: true,
            cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          }],
        },
      },
    }));
    internals.agentDir = agentDir;
    const context = makeSessionEventContext('/sessions/priced.jsonl');
    context.runtime = {
      services: {
        modelRegistry: {
          getAvailable: () => [{
            id: 'priced-model', name: 'Priced model', provider: 'mock', reasoning: true,
            thinkingLevelMap: { xhigh: 'xhigh', max: null },
            input: ['text'], contextWindow: 200_000, maxTokens: 32_000,
          }],
        },
      },
    } as unknown as SessionContext['runtime'];
    internals.context = context;

    assert.deepEqual(internals.availableModels(), [{
      id: 'priced-model',
      name: 'Priced model',
      provider: 'mock',
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      inputKinds: ['text'],
      contextWindow: 200_000,
      maxTokens: 32_000,
      subagent: {
        eligible: true,
        pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      },
    }]);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('a successfully read empty hot registry remains authoritative over configured fallback models', () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  host.applySync('catalog', 1, {
    models: [{ id: 'configured-fallback', name: 'Fallback', provider: 'phase-0', reasoning: false }],
  });
  const context = makeSessionEventContext('/sessions/empty-registry.jsonl');
  context.runtime = {
    services: { modelRegistry: { getAvailable: () => [] } },
  } as unknown as SessionContext['runtime'];
  internals.context = context;

  assert.deepEqual(internals.availableModels(), []);
});

test('host consumes the synced catalog as fallback for models.list', () => {
  const { host, sent } = makeHost();
  // No runtime context: the synced configured catalog is the availability fallback.
  host.applySync('catalog', 1, { models: [{ id: 'configured-fallback', name: 'Fallback', provider: 'phase-0', reasoning: false }] });
  const probe = host as unknown as { availableModels(): unknown };
  assert.deepEqual(probe.availableModels(), [{ id: 'configured-fallback', name: 'Fallback', provider: 'phase-0', reasoning: false }]);
  // The coordinator remains the authority: a later authoritative catalog
  // snapshot replaces the fallback, and reports never do.
  host.applySync('catalog', 2, { models: [] });
  assert.deepEqual(probe.availableModels(), []);
  assert.equal(sent.filter((frame) => frame.kind === 'runtime.report').length, 0);
});

test('host bounds turn.terminal durable messages onto the worker IPC frame budget', () => {
  const { host, sent } = makeHost();
  const emitter = host as unknown as { emit(event: string, payload?: unknown): void };
  const results = Array.from({ length: 60 }, (_, index) => ({
    kind: 'toolCall',
    toolCall: {
      id: `tool-${index}`, name: 'read', input: { path: `/f/${index}` },
      result: 'r'.repeat(6_000), status: 'completed', durableEntryId: `tool-${index}-entry`,
    },
  }));
  const mirror = results.map((part) => part.toolCall);
  const envelope = {
    protocolVersion: 1, sessionPath: '/sessions/session.jsonl', requestId: 'request',
    turnId: 'turn', attemptId: 'attempt', seq: 42, occurredAt: 130, checkpointBytes: 1,
    kind: 'turn.terminal', terminalKind: 'completed', durableEntryId: 'assistant-entry',
    durableMessage: {
      id: 'message', role: 'assistant', createdAt: new Date(130).toISOString(),
      markdown: 'done', status: 'completed', durableEntryId: 'assistant-entry',
      parts: results, toolCalls: mirror,
    },
  };
  emitter.emit('live.semantic', envelope);
  assert.equal(sent.length, 1);
  const frame = sent[0] as { payload: { durableMessage: { id?: string; durableEntryId?: string; parts?: Array<{ kind?: string; toolCall?: { detailRef?: unknown } }> } } };
  const durable = frame.payload.durableMessage;
  const bytes = Buffer.byteLength(JSON.stringify(durable), 'utf8');
  // 238 KiB projection budget leaves headroom for the envelope and frame
  // identity fields under the 256 KiB ordinary-frame ceiling.
  assert.ok(bytes <= 238 * 1024, `terminal projection ${bytes} exceeds the wire budget`);
  assert.equal(durable.id, 'message');
  assert.equal(durable.durableEntryId, 'assistant-entry');
  const toolParts = (durable.parts ?? []).filter((part) => (part as { kind?: string }).kind === 'toolCall');
  assert.equal(toolParts.length, 60);
  assert.ok(toolParts.every((part) => part.toolCall?.detailRef));
  assert.equal(JSON.stringify(durable).includes('r'.repeat(1_000)), false);
});

test('host drops a single text delta that cannot ride the worker wire', () => {
  const { host, sent } = makeHost();
  const emitter = host as unknown as { emit(event: string, payload?: unknown): void };
  emitter.emit('live.semantic', {
    protocolVersion: 1, sessionPath: '/sessions/session.jsonl', requestId: 'request',
    turnId: 'turn', attemptId: 'attempt', seq: 10, occurredAt: 130, checkpointBytes: 1,
    kind: 'turn.text', delta: 'x'.repeat(300 * 1024),
  });
  assert.equal(sent.length, 0, 'oversized delta must not be sent; the host recovers via seq-gap rebase');
  emitter.emit('live.semantic', {
    protocolVersion: 1, sessionPath: '/sessions/session.jsonl', requestId: 'request',
    turnId: 'turn', attemptId: 'attempt', seq: 11, occurredAt: 131, checkpointBytes: 1,
    kind: 'turn.text', delta: 'ok',
  });
  assert.equal(sent.length, 1);
  const frame = sent[0] as { payload: { delta?: unknown } };
  assert.equal(frame.payload.delta, 'ok');
});
