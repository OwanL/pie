import assert from 'node:assert/strict';
import test from 'node:test';

import type { SdkSessionEvent } from '../../../src/backend/sdk';
import type { SessionContext } from '../../../src/backend/server-types';
import { WorkerRuntimeHost } from '../../../src/backend/worker-runtime-host';
import type { SessionOpenedPayload } from '../../../src/shared/protocol';

interface WorkerRuntimeHostInternals {
  openedPayload?: SessionOpenedPayload;
  buildOpenedPayload: (
    sessionPath: string,
    selectionToken?: string,
    operationId?: string,
    operationAttempt?: number,
  ) => Promise<SessionOpenedPayload>;
  emitRefreshedSessionOpened: (sessionPath: string) => Promise<void>;
  handleSessionEvent: (context: SessionContext, event: SdkSessionEvent) => void;
}

function makeHost(): {
  host: WorkerRuntimeHost;
  sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }>;
} {
  const sent: Array<{ kind: string; event?: string; domain?: string; payload?: unknown }> = [];
  const server = {
    sendFrame: (frame: any) => { sent.push(frame); return true; },
    sendDetailFrame: () => true,
  } as never;
  const host = new WorkerRuntimeHost({
    server,
    owner: { coordinatorGeneration: 1, workerId: 'host-worker', workerGeneration: 1 },
    patchIdentity: { relativePath: 'dist/core/session-manager.js', patchVersion: 1, sha256: 'a'.repeat(64) },
  } as never);
  return { host, sent };
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

test('host applies monotonic sync domains and rejects stale catalog revisions', () => {
  const { host } = makeHost();
  host.applySync('catalog', 1, { models: [{ id: 'configured-c', name: 'Configured C', provider: 'phase-0', reasoning: false }] });
  host.applySync('settings', 1, { values: { defaultModel: 'configured-c' } });
  host.applySync('runtimePrefs', 1, { values: { autonomousMode: true } });
  assert.throws(() => host.applySync('catalog', 1, { models: [] }), /Stale worker sync revision/);
  assert.throws(() => host.applySync('catalog', 0, { models: [] }), /Stale worker sync revision/);
  host.applySync('catalog', 2, { models: [{ id: 'configured-d' }] });
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
