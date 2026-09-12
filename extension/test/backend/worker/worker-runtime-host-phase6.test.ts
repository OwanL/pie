import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';
import type { ProviderIncident } from '../../../src/backend/provider-incident';
import type { ProviderTransportObservation } from '../../../src/backend/provider-progress-bus';
import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import { WorkerRuntimeHost } from '../../../src/backend/worker-runtime-host';
import type { SessionOpenedPayload } from '../../../src/shared/protocol';

interface WorkerRuntimeHostInternals {
  sdk?: unknown;
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
  emitContextUsageChanged: (context: SessionContext, estimated?: number) => void;
  resolveNetworkProvider: (url: string, fallbackProvider?: string) => string | undefined;
  suppressNextReplacementOpened: boolean;
}

function makeHost(): {
  host: WorkerRuntimeHost;
  sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }>;
  runtimeFailures: Error[];
} {
  const sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }> = [];
  const runtimeFailures: Error[] = [];
  const server = {
    sendFrame: (frame: any) => { sent.push(frame); return true; },
    sendLiveSemanticFrame: (payload: any) => {
      sent.push({ kind: 'runtime.event', event: 'live.semantic', payload });
      return true;
    },
    sendDetailFrame: () => true,
    failRuntime: (error: Error) => { runtimeFailures.push(error); },
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
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

test('context source observations qualify prompt footprints separately from display fallbacks', () => {
  const { host, sent } = makeHost();
  const context = makeSessionEventContext('/sessions/context.jsonl');
  let entries: unknown[] = [];
  context.session = {
    model: { id: 'source-model', provider: 'source-provider', contextWindow: 1000 },
    sessionManager: { getBranch: () => entries },
  } as unknown as SessionContext['session'];
  const emit = () => getInternals(host).emitContextUsageChanged(context);
  emit();
  getInternals(host).emitContextUsageChanged(context, 200);
  entries = [{ type: 'message', message: { role: 'assistant', usage: { total_tokens: 400 } } }];
  emit();
  entries = [{ type: 'message', message: { role: 'assistant', usage: { input: 10, cacheRead: 2, cacheWrite: 3, output: 4 } } }];
  emit();
  emit();
  entries = [{ type: 'message', message: { role: 'assistant', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 4 } } }];
  emit();
  const payloads = sent.filter((frame) => frame.event === 'contextUsage.changed')
    .map((frame) => frame.payload as import('../../../src/shared/protocol').ContextUsageChangedPayload);
  assert.deepEqual(payloads.map((payload) => [payload.source, payload.canonicalInputTokens]), [
    ['unknown', null], ['postCompactionEstimate', 200], ['unknown', null],
    ['provider', 15], ['provider', 15], ['provider', 0],
  ]);
  assert.equal(payloads[2]!.contextUsage!.tokens, 400, 'display fallback remains available');
  assert.equal(payloads[5]!.contextUsage!.tokens, 4, 'display fallback is independent of a known zero prompt');
  assert.equal(new Set(payloads.map((payload) => payload.observationId)).size, 6);
  for (const payload of payloads) {
    assert.ok(Number.isSafeInteger(payload.observedAt));
    assert.equal(payload.modelId, 'source-model');
    assert.equal(payload.provider, 'source-provider');
  }
});

test('hot duplicate runs through the owning runtime replacement and suppresses its intermediate event', async () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  const sourcePath = '/sessions/source.jsonl';
  const duplicatePath = '/sessions/duplicate.jsonl';
  const context = makeSessionEventContext(sourcePath);
  let forkCalls = 0;
  context.runtime = {
    fork: async (entryId: string, options: { position?: 'before' | 'at' }) => {
      forkCalls += 1;
      assert.equal(entryId, 'assistant-leaf');
      assert.deepEqual(options, { position: 'at' });
      assert.equal(internals.suppressNextReplacementOpened, true);
      context.sessionPath = duplicatePath;
      return { cancelled: false };
    },
  } as unknown as SessionContext['runtime'];
  context.session = {
    sessionManager: {
      getBranch: () => [{ id: 'assistant-leaf', type: 'message' }],
    },
  } as unknown as SessionContext['session'];
  internals.context = context;
  internals.sdk = {};

  assert.deepEqual(await host.command('session.duplicateHot', {
    params: { sessionPath: sourcePath },
  }, 'duplicate-hot'), { sessionPath: duplicatePath });
  assert.equal(forkCalls, 1);
  assert.equal(internals.suppressNextReplacementOpened, false);

  internals.openedPayload = makeOpenedPayload(duplicatePath, [], {
    replacesSessionPath: sourcePath,
  });
  internals.buildOpenedPayload = async (sessionPath, selectionToken, operationId, operationAttempt) => (
    makeOpenedPayload(sessionPath, [], { selectionToken, operationId, operationAttempt, runtimeReady: true })
  );
  const snapshot = await host.command('session.snapshot', {
    params: {
      sessionPath: duplicatePath,
      selectionToken: 'duplicate-selection',
      operationId: 'duplicate-operation',
      operationAttempt: 2,
    },
  }, 'snapshot-hot') as unknown as SessionOpenedPayload;
  assert.equal(snapshot.replacesSessionPath, undefined);
  assert.equal(snapshot.selectionToken, 'duplicate-selection');
  assert.equal(internals.openedPayload?.replacesSessionPath, undefined,
    'later worker refreshes must not replace the source tab');
});

test('priority interrupt marks the active request aborted', async () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  const activeRequest = { id: 'request-1', messageIndex: 1, aborted: false };
  const session = {
    isStreaming: true,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    clearQueue() {},
    async abort() { session.isStreaming = false; },
  };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: session as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest,
  };

  assert.deepEqual(await host.interrupt(), { interrupted: true, settled: true });
  assert.equal(activeRequest.aborted, true);
});

test('priority interrupt keeps its response pending when abort resolves but billable activity remains', async () => {
  const { host } = makeHost();
  const internals = getInternals(host);
  const session = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: true,
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingMessageCount: 0,
    clearQueue() {},
    async abort() {},
  };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: session as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
  };

  const interrupt = host.interrupt();
  assert.equal(await Promise.race([
    interrupt.then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]), 'pending');
  session.isRetrying = false;
  assert.deepEqual(await interrupt, { interrupted: true, settled: true });
});

test('priority interrupt detaches and terminalizes a pre-commit send when abort emits no agent_end', async () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const activeRequest = {
    id: 'request-1', operationId: 'operation-preflight-stop', messageIndex: 0, aborted: false,
  };
  const session = {
    isStreaming: true,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    clearQueue() {},
    async abort() { session.isStreaming = false; },
  };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: session as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest,
  };

  assert.deepEqual(await host.interrupt(), { interrupted: true, settled: true });
  assert.equal(internals.context.activeRequest, undefined);
  assert.equal(
    sent.some((frame) => frame.event === 'busy.changed'
      && (frame.payload as { busy?: unknown } | undefined)?.busy === false),
    true,
  );
  assert.deepEqual(
    sent.filter((frame) => frame.event === 'message.aborted').map((frame) => frame.payload),
    [{
      requestId: 'request-1', operationId: 'operation-preflight-stop', sessionPath: '/session.jsonl',
      outcome: 'cancelled', userInitiated: true,
      reason: 'The send was cancelled by Stop before it started.',
    }],
  );
});

test('priority interrupt closes a semantic turn when abort emits no agent_end', async () => {
  const { host, sent } = makeHost();
  const internals = getInternals(host);
  const session = {
    isStreaming: true,
    isCompacting: false,
    isRetrying: false,
    isBashRunning: false,
    clearQueue() {},
    async abort() { session.isStreaming = false; },
  };
  internals.context = {
    runtime: {} as SessionContext['runtime'],
    session: session as unknown as SessionContext['session'],
    sessionPath: '/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    activeRequest: {
      id: 'request-committed', operationId: 'operation-committed', messageIndex: 0,
      semanticStarted: true, aborted: false,
      liveTurnAccumulator: {
        checkpoint: () => ({ turn: { canonicalMessageId: 'message-committed' } }),
      } as NonNullable<SessionContext['activeRequest']>['liveTurnAccumulator'],
    },
  };

  assert.deepEqual(await host.interrupt(), { interrupted: true, settled: true });
  assert.deepEqual(
    sent.filter((frame) => frame.event === 'message.aborted').map((frame) => frame.payload),
    [{
      requestId: 'request-committed', operationId: 'operation-committed',
      sessionPath: '/session.jsonl', messageId: 'message-committed', userInitiated: true,
    }],
  );
});

test('a quota incident does not schedule delayed heuristic recovery', async () => {
  const { host, sent, runtimeFailures } = makeHost();
  const internals = getInternals(host);
  const context: SessionContext = {
    runtime: {} as SessionContext['runtime'],
    session: {
      isStreaming: true,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
      sessionManager: { getSessionId: () => 'session-quota' },
    } as unknown as SessionContext['session'],
    sessionPath: '/sessions/quota-no-recovery.jsonl',
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

  // Well past the historical heuristic settlement grace (15s default; cleared
  // in tests at ~5-15ms). The runtime must not be failed or aborted by
  // elapsed time: the exact SDK lifecycle owns terminalization, and the
  // incident itself remains visible exactly once.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtimeFailures.length, 0, 'no delayed runtime failure is scheduled');
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 1, 'the real provider incident is still surfaced');
  assert.equal((errors[0]!.payload as { code?: string }).code, 'PROVIDER_QUOTA_EXHAUSTED');
});
test('agent_settled refreshes session.opened from the current session and preserves cached operation identity', async () => {
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

  const context = makeSessionEventContext(sessionPath);
  context.activeRequest = {
    id: 'request-1', operationId: 'operation-1', operationAttempt: 3,
    messageIndex: 1, aborted: false,
    liveTurnAccumulator: new BackendLiveTurnAccumulator({
      protocolVersion: 7,
      sessionPath,
      requestId: 'request-1',
      operationId: 'operation-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      canonicalMessageId: 'message-1',
      startedAt: 1,
    }),
  };
  internals.handleSessionEvent(context, { type: 'agent_settled' });
  await waitForAsyncEvent();

  assert.deepEqual(rebuildCalls, [[sessionPath, 'selection-1', 'operation-1', 3]]);
  const settledFrame = sent.find((frame) => frame.kind === 'runtime.event' && frame.event === 'agent.settled');
  const settledPayload = { ...(settledFrame?.payload as Record<string, unknown>) };
  const occurredAt = settledPayload.occurredAt;
  const endedAt = settledPayload.endedAt;
  delete settledPayload.occurredAt;
  delete settledPayload.endedAt;
  assert.deepEqual(settledPayload, {
    sessionPath,
    capabilities: {
      billableActivity: false,
      canInterrupt: false,
      canCompact: true,
      canContinue: false,
    },
    operationId: 'operation-1',
    requestId: 'request-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
    operationAttempt: 3,
    backendGeneration: 1,
    workerGeneration: 1,
  });
  assert.equal(typeof occurredAt, 'number');
  assert.equal(endedAt, occurredAt, 'source settlement timestamps share one sample');
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

test('host applies monotonic sync domains and runtime preferences', () => {
  const { host } = makeHost();
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
    assert.deepEqual(JSON.parse(process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON ?? 'null'), {
      small: false,
      medium: false,
      frontier: true,
    });
    assert.throws(() => host.applySync('catalog', 1, { models: [] }), /Stale worker sync revision/);
    assert.throws(() => host.applySync('catalog', 0, { models: [] }), /Stale worker sync revision/);
    host.applySync('catalog', 2, { models: [{ id: 'configured-d' }] });
  } finally {
    if (savedBucketCanSpawn === undefined) delete process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON;
    else process.env.PIE_SUBAGENT_BUCKET_CAN_SPAWN_JSON = savedBucketCanSpawn;
  }
});

test('worker provider incidents dedupe repeats but preserve a later definitive condition', () => {
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
  const quotaIncident: ProviderIncident = {
    ...incident,
    kind: 'quota_exhausted',
    userMessage: 'OpenAI quota is exhausted.',
    detail: 'provider=api.openai.com; status=429; quota exhausted',
  };
  internals.handleProviderIncident(quotaIncident);

  assert.equal(context.activeRequest?.latestProviderIncident, quotaIncident);
  assert.equal(context.activeRequest?.lastProviderErrorForDiagnostics, quotaIncident.userMessage);
  const errors = sent.filter((frame) => frame.kind === 'runtime.event' && frame.event === 'operational-error');
  assert.equal(errors.length, 2, 'only an exact repeated condition is deduplicated');
  assert.deepEqual(errors[0]?.payload, {
    incidentId: 'provider:request-1:rate_limited:api.openai.com:429:5001',
    dedupeKey: 'provider:request-1:rate_limited:api.openai.com:429:5001',
    code: 'PROVIDER_RATE_LIMITED',
    message: incident.userMessage,
    detail: incident.detail,
    sessionPath: '/sessions/provider.jsonl',
    requestId: 'request-1',
    severity: 'error',
    certainty: 'ambiguous',
    phase: 'provider',
    recovery: { retry: false, restart: false, showLogs: true },
  });
  const quotaPayload = errors[1]?.payload as { dedupeKey?: string; certainty?: string } | undefined;
  assert.equal(
    quotaPayload?.dedupeKey,
    'provider:request-1:quota_exhausted:api.openai.com:429:5001',
  );
  assert.equal(quotaPayload?.certainty, 'definitive');
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

test('live.semantic emission uses the recoverable-drop seam while other events stay fail-closed', () => {
  const liveSemanticPayloads: unknown[] = [];
  const sendFrames: Array<{ kind: string; event?: string }> = [];
  const runtimeFailures: Error[] = [];
  const server = {
    sendFrame: (frame: any) => { sendFrames.push(frame); return true; },
    sendLiveSemanticFrame: (payload: unknown) => {
      liveSemanticPayloads.push(payload);
      // The transport seam reports a dropped (capacity/oversize) envelope.
      return false;
    },
    sendDetailFrame: () => true,
    failRuntime: (error: Error) => { runtimeFailures.push(error); },
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
  } as never);
  const emitter = host as unknown as { emit(event: string, payload?: unknown): void };

  emitter.emit('live.semantic', {
    protocolVersion: 1, sessionPath: '/sessions/session.jsonl', requestId: 'request',
    turnId: 'turn', attemptId: 'attempt', seq: 9, occurredAt: 130, checkpointBytes: 1,
    kind: 'turn.text', delta: 'ok',
  });
  assert.equal(liveSemanticPayloads.length, 1, 'live.semantic must route through the recoverable-drop seam');
  assert.deepEqual((liveSemanticPayloads[0] as { seq?: number }).seq, 9);
  assert.equal(sendFrames.length, 0);
  assert.equal(runtimeFailures.length, 0,
    'a dropped live.semantic envelope must not fail the runtime or synthesize a replacement');

  emitter.emit('tool.progress', { requestId: 'request', sessionPath: '/sessions/session.jsonl' });
  assert.equal(sendFrames.length, 1, 'non-semantic events must stay on the fail-closed sendFrame path');
  assert.equal(sendFrames[0]!.event, 'tool.progress');
  assert.equal(runtimeFailures.length, 0);
});
