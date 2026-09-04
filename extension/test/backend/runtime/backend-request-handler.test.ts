import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { formatInterruptWatchdogDuration, handleBackendRequest, BACKEND_REQUEST_METHODS, type BackendRequestHandlerDeps } from '../../../src/backend/request-handler';
import { handleSdkSessionEvent, type BackendSessionEventHandlerDeps } from '../../../src/backend/session-event-handler';
import { BackendError, extractRequestError } from '../../../src/backend/server-io';
import { PROVIDER_TOGGLES_ENV, type ModelSettings } from '../../../src/shared/protocol';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkSessionEvent } from '../../../src/backend/sdk';
import { ProviderGate } from '../../../src/backend/provider-gate';
import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import { ExtensionUIBridge } from '../../../src/backend/extension-ui-bridge';
import { JSONL_MAX_LINE_BYTES } from '../../../src/shared/jsonl';
import { SESSION_SNAPSHOT_MAX_LINE_BYTES, sessionSnapshotLineBytes } from '../../../src/shared/transcript-window';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTracePath,
  isBackendLivePipelineTraceEnabled,
  setBackendLivePipelineTraceEnabled,
} from '../../../src/backend/live-pipeline-trace-runtime';
import { readBackendRequestTracePhases } from '../../helpers/backend-live-pipeline-trace';

class FakeTransitionClock {
  private nextId = 1;
  private nowMs = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  advance(milliseconds: number): void {
    const target = this.nowMs + milliseconds;
    for (;;) {
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

interface Harness {
  deps: BackendRequestHandlerDeps;
  context: SessionContext;
  emitted: Array<{ event: string; payload?: unknown }>;
  busyEvents: boolean[];
  viewedSessionPath?: string;
  createCalls: Array<{ cwd: string; reason: string }>;
  openCalls: string[];
  writtenSettings: Partial<ModelSettings>[];
  emitContextUsageChangedCalls: SessionContext[];
  viewedTransitions: Array<{ sessionPath: string; previousSessionPath: string | null }>;
}

function createHarness(overrides: {
  context?: Partial<SessionContext>;
  sessionOverrides?: Record<string, unknown>;
  modelSettings?: ModelSettings;
  writeModelSettings?: (updates: Partial<ModelSettings>) => Promise<ModelSettings>;
} = {}): Harness {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const busyEvents: boolean[] = [];
  const createCalls: Array<{ cwd: string; reason: string }> = [];
  const openCalls: string[] = [];
  const writtenSettings: Partial<ModelSettings>[] = [];
  const appliedToggles: Array<{ sessionPath: string; disabledEntries: string[] }> = [];
  const emitContextUsageChangedCalls: SessionContext[] = [];
  const viewedTransitions: Array<{ sessionPath: string; previousSessionPath: string | null }> = [];
  let viewedSessionPath: string | undefined;
  const modelSettings = overrides.modelSettings ?? { defaultModel: 'model-a', defaultThinkingLevel: 'medium' };

  const session = {
    isStreaming: false,
    model: { id: 'model-a' },
    thinkingLevel: 'medium',
    prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
    },
    compact: async () => undefined,
    abort: async () => undefined,
    followUp: async (_text: string, _images?: unknown) => undefined,
    steer: async (_text: string, _images?: unknown) => undefined,
    clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
    setModel: async (model: { id: string }) => {
      (session.model as { id: string }).id = model.id;
    },
    setThinkingLevel: (level: string) => {
      session.thinkingLevel = level;
    },
  } as unknown as SessionContext['session'];

  Object.assign(session as object, overrides.sessionOverrides ?? {});

  const context: SessionContext = {
    runtime: {
      session,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => [
            { id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, input: ['text'] },
            { id: 'model-b', name: 'Model B', provider: 'mock', reasoning: false, input: ['text', 'image'] },
          ],
          find: (_provider: string, modelId: string) => ({ id: modelId }),
        },
      },
    } as SessionContext['runtime'],
    session,
    sessionPath: '/repo/session.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
    ...overrides.context,
  };

  const deps: BackendRequestHandlerDeps = {
    sdkPath: '/sdk',
    agentDir: '/agent',
    startupCwd: '/startup',
    sdk: {
      VERSION: '1.0.0',
      SessionManager: {
        listAll: async () => [],
        continueRecent: (cwd: string) => ({ cwd } as any),
        create: (cwd: string) => ({ cwd } as any),
        open: (sessionPath: string) => ({ cwd: '/repo', sessionPath } as any),
      },
    } as unknown as BackendRequestHandlerDeps['sdk'],
    getSessionContext(sessionPath) {
      return sessionPath === context.sessionPath ? context : undefined;
    },
    async createSessionContext(sessionManager, reason) {
      createCalls.push({ cwd: (sessionManager as { cwd?: string }).cwd ?? '/repo', reason });
      return context;
    },
    async ensureSessionContext(sessionPath) {
      assert.equal(sessionPath, context.sessionPath);
      return context;
    },
    createColdSession(cwd) {
      createCalls.push({ cwd: cwd || '/startup', reason: 'new' });
      return { sessionPath: context.sessionPath };
    },
    duplicateColdSession() {
      return { sessionPath: context.sessionPath };
    },
    setViewedSessionPath(sessionPath) {
      viewedSessionPath = sessionPath;
    },
    recordViewedSessionTransition(sessionPath, previousSessionPath) {
      if (sessionPath === previousSessionPath) return false;
      viewedTransitions.push({ sessionPath, previousSessionPath });
      viewedSessionPath = sessionPath;
      return true;
    },
    async buildSessionOpenedPayload(sessionPath, selectionToken, _transcript, _transport, operationId, operationAttempt, systemPromptDisabledEntries) {
      return {
        session: { path: sessionPath, cwd: '/repo', name: 'Session', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
        transcript: [],
        transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        busy: false,
        runtimeReady: false,
        selectionToken,
        operationId,
        operationAttempt,
        ...(systemPromptDisabledEntries !== undefined
          ? { systemPromptDisabledEntries: [...systemPromptDisabledEntries] }
          : {}),
      };
    },
    async applySystemPromptToggles(sessionPath, disabledEntries) {
      appliedToggles.push({ sessionPath, disabledEntries: [...disabledEntries] });
    },
    setAutonomousMode: () => undefined,
    async loadTranscriptPage(sessionPath) {
      return {
        sessionPath,
        transcript: [],
        transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        busy: false,
      };
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    emitBusyChanged(_context, busy) {
      busyEvents.push(busy);
    },
    emitContextUsageChanged(context) {
      emitContextUsageChangedCalls.push(context);
    },
    async emitSessionListChanged() {
      emitted.push({ event: 'session.list.changed' });
    },
    async listSessions() {
      return [{ path: context.sessionPath, cwd: '/repo', name: 'Session', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 }];
    },
    listAvailableModels() {
      return [{ id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, inputKinds: ['text'] }];
    },
    async readModelSettings() {
      return modelSettings;
    },
    async writeModelSettings(updates) {
      writtenSettings.push(updates);
      if (overrides.writeModelSettings) {
        return await overrides.writeModelSettings(updates);
      }
      return { ...modelSettings, ...updates };
    },
  };

  return {
    deps,
    context,
    emitted,
    busyEvents,
    get viewedSessionPath() {
      return viewedSessionPath;
    },
    createCalls,
    openCalls,
    writtenSettings,
    emitContextUsageChangedCalls,
    viewedTransitions,
  } as Harness;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-request-handler-test-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('handleBackendRequest covers handshake and session orchestration methods', async () => {
  const harness = createHarness();

  const ping = await handleBackendRequest(harness.deps, { id: '1', method: 'app.ping' });
  assert.deepEqual(ping, {
    sdkPath: '/sdk',
    agentDir: '/agent',
    sdkVersion: '1.0.0',
    protocolVersion: 15,
  });

  const listed = await handleBackendRequest(harness.deps, { id: '2', method: 'session.list' });
  assert.equal((listed as any)[0].path, '/repo/session.jsonl');

  const created = await handleBackendRequest(harness.deps, {
    id: '3',
    method: 'session.create',
    params: { cwd: '/custom', selectionToken: 'sel-1' },
  });
  assert.deepEqual(created, { ok: true, sessionPath: '/repo/session.jsonl' });
  assert.equal(harness.viewedSessionPath, '/repo/session.jsonl');
  assert.deepEqual(harness.createCalls[0], { cwd: '/custom', reason: 'new' });
  assert.deepEqual(harness.busyEvents, [], 'cold create does not emit runtime busy state');
  assert.equal(harness.emitted[0]?.event, 'session.opened');
  assert.equal((harness.emitted[0]?.payload as { selectionToken?: string }).selectionToken, 'sel-1');
  assert.deepEqual(harness.emitted[1], { event: 'session.list.changed' });

  const opened = await handleBackendRequest(harness.deps, {
    id: '4',
    method: 'session.open',
    params: { sessionPath: '/repo/session.jsonl', selectionToken: 'sel-2' },
  });
  assert.deepEqual(opened, { ok: true, sessionPath: '/repo/session.jsonl' });
  assert.equal(harness.emitted.at(-2)?.event, 'session.opened');
  assert.equal((harness.emitted.at(-2)?.payload as { selectionToken?: string }).selectionToken, 'sel-2');

  const viewed = await handleBackendRequest(harness.deps, {
    id: '4b',
    method: 'session.viewed',
    params: { sessionPath: '/repo/session.jsonl', previousSessionPath: '/repo/previous.jsonl' },
  });
  assert.deepEqual(viewed, { ok: true, sessionPath: '/repo/session.jsonl', changed: true });
  assert.deepEqual(harness.viewedTransitions, [{
    sessionPath: '/repo/session.jsonl', previousSessionPath: '/repo/previous.jsonl',
  }]);

  const preloaded = await handleBackendRequest(harness.deps, {
    id: '5',
    method: 'session.preload',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.equal((preloaded as { session: { path: string } }).session.path, '/repo/session.jsonl');

  const page = await handleBackendRequest(harness.deps, {
    id: '6',
    method: 'session.loadTranscriptPage',
    params: { sessionPath: '/repo/session.jsonl', direction: 'older', loadedStart: 1, loadedEnd: 2 },
  });
  assert.deepEqual(page, {
    sessionPath: '/repo/session.jsonl',
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
  });

  const models = await handleBackendRequest(harness.deps, {
    id: '7',
    method: 'models.list',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(models, [{ id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, inputKinds: ['text'] }]);

  const settings = await handleBackendRequest(harness.deps, { id: '8', method: 'settings.get' });
  assert.deepEqual(settings, { defaultModel: 'model-a', defaultThinkingLevel: 'medium' });
});

test('cold open/preload and models refresh do not cross the runtime-promotion seam', async () => {
  const harness = createHarness();
  let promotions = 0;
  harness.deps.getSessionContext = () => undefined;
  harness.deps.ensureSessionContext = async () => {
    promotions += 1;
    throw new Error('unexpected promotion');
  };
  harness.deps.buildSessionOpenedPayload = async (sessionPath, selectionToken) => ({
    session: { path: sessionPath, cwd: '/repo', name: 'Cold', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
    transcript: [],
    transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
    busy: false,
    runtimeReady: false,
    selectionToken,
  });
  harness.deps.listAvailableModels = async () => [];

  await handleBackendRequest(harness.deps, {
    id: 'cold-open', method: 'session.open', params: { sessionPath: '/cold.jsonl', selectionToken: 'cold-token' },
  });
  const preload = await handleBackendRequest(harness.deps, {
    id: 'cold-preload', method: 'session.preload', params: { sessionPath: '/cold.jsonl' },
  }) as import('../../../src/shared/protocol').SessionOpenedPayload;
  await handleBackendRequest(harness.deps, {
    id: 'cold-models', method: 'models.list', params: { sessionPath: '/cold.jsonl' },
  });

  assert.equal(promotions, 0);
  assert.equal(preload.runtimeReady, false);
  assert.equal((harness.emitted.find((item) => item.event === 'session.opened')?.payload as { runtimeReady?: boolean }).runtimeReady, false);
});

test('session.open echoes stable operation identity on its authoritative opened event', async () => {
  const harness = createHarness();
  let buildArgs: unknown[] = [];
  harness.deps.getSessionContext = () => undefined;
  harness.deps.buildSessionOpenedPayload = async (...args) => {
    buildArgs = args;
    return {
      session: { path: '/cold.jsonl', cwd: '/repo', name: 'Cold', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
      transcript: [],
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false,
      capabilities: { billableActivity: false, canContinue: false, canInterrupt: false, canCompact: true },
      selectionToken: 'selection-open',
      operationId: 'open-operation',
      operationAttempt: 2,
    };
  };

  const response = await handleBackendRequest(harness.deps, {
    id: 'open-correlated', method: 'session.open', params: {
      sessionPath: '/cold.jsonl', selectionToken: 'selection-open',
      operationId: 'open-operation', operationAttempt: 2,
    },
  });

  assert.deepEqual(buildArgs, [
    '/cold.jsonl', 'selection-open', undefined, undefined, 'open-operation', 2,
  ]);
  assert.deepEqual(response, { ok: true, sessionPath: '/cold.jsonl' });
  assert.equal((harness.emitted.find((entry) => entry.event === 'session.opened')?.payload as { operationId?: string }).operationId, 'open-operation');
});

test('explicit cold runtime mutations promote while live-only stop requests do not', async () => {
  const harness = createHarness();
  let promotions = 0;
  harness.deps.getSessionContext = () => undefined;
  harness.deps.ensureSessionContext = async () => {
    promotions += 1;
    return harness.context;
  };

  const interrupted = await handleBackendRequest(harness.deps, {
    id: 'cold-stop', method: 'message.interrupt', params: { sessionPath: '/cold.jsonl' },
  }).then(() => 'resolved', (error) => (error as Error).message);
  assert.match(interrupted, /Cannot interrupt an unopened session/);
  assert.equal(promotions, 0);

  await handleBackendRequest(harness.deps, {
    id: 'cold-compact', method: 'message.compact', params: { sessionPath: '/cold.jsonl' },
  });
  assert.equal(promotions, 1);
});

test('create, duplicate, and truncate keep successful slim acknowledgements when session.opened reports a bounded unavailable snapshot', async () => {
  await withTempDir(async (dir) => {
    const harness = createHarness();
    const snapshotUnavailable = {
      code: 'SESSION_SNAPSHOT_TOO_LARGE' as const,
      message: 'The lossless session transcript snapshot exceeded the transport limit.',
    };
    harness.deps.buildSessionOpenedPayload = async (sessionPath, selectionToken) => ({
      session: { path: sessionPath, cwd: '/repo', name: 'Session', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 },
      transcript: [],
      transcriptWindow: { totalCount: 1, loadedStart: 1, loadedEnd: 1, hasOlder: true, hasNewer: false, isPartial: true, hasUserMessages: true },
      busy: false,
      selectionToken,
      snapshotUnavailable,
    });
    harness.context.session.sessionManager = { getCwd: () => '/repo' } as SessionContext['session']['sessionManager'];
    harness.deps.sdk.SessionManager.forkFrom = ((_sourcePath: string, cwd: string) => ({ cwd })) as unknown as typeof harness.deps.sdk.SessionManager.forkFrom;

    const created = await handleBackendRequest(harness.deps, {
      id: 'create-unavailable', method: 'session.create', params: { cwd: '/repo', selectionToken: 'create-token' },
    });
    const duplicated = await handleBackendRequest(harness.deps, {
      id: 'duplicate-unavailable', method: 'session.duplicate', params: { sessionPath: harness.context.sessionPath, selectionToken: 'duplicate-token' },
    });

    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep', type: 'message' }),
      JSON.stringify({ id: 'stop', type: 'message' }),
    ].join('\n') + '\n');
    harness.context.sessionPath = sessionPath;
    const truncated = await handleBackendRequest(harness.deps, {
      id: 'truncate-unavailable', method: 'session.truncateAfter', params: { sessionPath, entryId: 'stop' },
    });

    assert.deepEqual(created, { ok: true, sessionPath: '/repo/session.jsonl' });
    assert.deepEqual(duplicated, { ok: true, sessionPath: '/repo/session.jsonl' });
    assert.deepEqual(truncated, { ok: true, sessionPath });
    const opened = harness.emitted.filter((entry) => entry.event === 'session.opened');
    assert.equal(opened.length, 3);
    assert.ok(opened.every((entry) => (entry.payload as { snapshotUnavailable?: unknown }).snapshotUnavailable));
    assert.equal((await fs.readFile(sessionPath, 'utf8')).includes('"stop"'), false, 'truncate mutation committed');
  });
});

test('session page transport culls oversized images with headroom and types a required-row overflow before enqueue', async () => {
  const harness = createHarness();
  const oversizedImage = {
    id: 'oversized-image', role: 'user' as const, createdAt: '2026-01-01T00:00:00.000Z', markdown: '', status: 'completed' as const,
    userParts: [{ kind: 'image' as const, mimeType: 'image/png', dataBase64: 'a'.repeat(31 * 1024 * 1024) }],
  };
  const requiredTail = {
    id: 'required-tail', role: 'assistant' as const, createdAt: '2026-01-01T00:00:01.000Z', markdown: 'keep', status: 'completed' as const,
  };
  let receivedPageOptions: unknown;
  harness.deps.loadTranscriptPage = async (sessionPath, _direction, _start, _end, options) => {
    receivedPageOptions = options;
    return {
    sessionPath,
    transcript: [oversizedImage, requiredTail],
    transcriptWindow: { totalCount: 2, loadedStart: 0, loadedEnd: 2, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true },
    busy: false,
    };
  };

  const bounded = await handleBackendRequest(harness.deps, {
    id: 'bounded-page', method: 'session.loadTranscriptPage',
    params: { sessionPath: '/repo/session.jsonl', direction: 'latest' },
  }) as import('../../../src/shared/protocol').TranscriptPagePayload;
  assert.deepEqual(bounded.transcript.map((message) => message.id), ['required-tail']);
  assert.deepEqual(receivedPageOptions, {
    transport: { kind: 'response', requestId: 'bounded-page' },
    requiredMessageId: undefined,
  });
  assert.ok(sessionSnapshotLineBytes(bounded, { kind: 'response', requestId: 'bounded-page' }) <= SESSION_SNAPSHOT_MAX_LINE_BYTES);
  assert.ok(SESSION_SNAPSHOT_MAX_LINE_BYTES < JSONL_MAX_LINE_BYTES, 'snapshot producer reserves explicit envelope headroom');

  harness.deps.loadTranscriptPage = async (sessionPath) => ({
    sessionPath,
    transcript: [oversizedImage],
    transcriptWindow: { totalCount: 1, loadedStart: 0, loadedEnd: 1, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true },
    busy: false,
  });
  let caught: unknown;
  try {
    await handleBackendRequest(harness.deps, {
      id: 'oversized-page', method: 'session.loadTranscriptPage',
      params: { sessionPath: '/repo/session.jsonl', direction: 'latest' },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.deepEqual(extractRequestError(caught).code, 'SESSION_SNAPSHOT_TOO_LARGE');
  assert.equal(harness.emitted.length, 0, 'the handler rejects before any event/writer enqueue');
});

test('session.loadDetail validates and delegates bounded retrieval identity', async () => {
  const harness = createHarness();
  const ref = {
    key: 'durable:tool:key', kind: 'tool-result' as const, source: 'durable' as const,
    sessionPath: '/repo/session.jsonl', messageId: 'message', toolCallId: 'tool',
    sizeBytes: 4, summary: 'detail', available: true,
  };
  harness.deps.loadDetail = async (sessionPath, receivedRef) => ({
    sessionPath, key: receivedRef.key, status: 'loaded', value: 'full', sizeBytes: 4,
  });
  assert.deepEqual(await handleBackendRequest(harness.deps, {
    id: 'detail', method: 'session.loadDetail', params: { sessionPath: '/repo/session.jsonl', ref },
  }), {
    sessionPath: '/repo/session.jsonl', key: ref.key, status: 'loaded', value: 'full', sizeBytes: 4,
  });
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'bad-detail', method: 'session.loadDetail', params: { sessionPath: '/repo/session.jsonl', ref: { key: '' } },
  }), /requires sessionPath and ref/);

  const pendingPath = 'C:\\repo\\__pending__:1-abc';
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'pending-detail',
    method: 'session.loadDetail',
    params: { sessionPath: pendingPath, ref: { ...ref, sessionPath: pendingPath } },
  }), /resolved session/);
});

test('session.create returns a session from the configured backend session directory', async () => {
  const harness = createHarness();
  const configuredDir = path.resolve('/configured/sessions');
  const sdkFallbackDir = path.resolve('/sdk-default/sessions');

  harness.deps.sessionDir = configuredDir;
  harness.deps.sdk.SessionManager.create = ((cwd: string, sessionDir?: string) => ({
    cwd,
    sessionPath: path.join(sessionDir ?? sdkFallbackDir, 'new-session.jsonl'),
  })) as unknown as typeof harness.deps.sdk.SessionManager.create;
  harness.deps.createColdSession = (cwd) => {
    const manager = harness.deps.sdk.SessionManager.create(cwd || harness.deps.startupCwd, harness.deps.sessionDir) as unknown as { sessionPath: string };
    return { sessionPath: manager.sessionPath };
  };
  harness.deps.buildSessionOpenedPayload = async (sessionPath) => ({ sessionPath, runtimeReady: false } as any);

  const created = await handleBackendRequest(harness.deps, {
    id: 'create-canonical',
    method: 'session.create',
    params: { cwd: '/custom' },
  }) as { sessionPath: string };

  assert.equal(created.sessionPath, path.join(configuredDir, 'new-session.jsonl'));
});

test('session.duplicate reads a cold source cwd without promoting the source runtime', async () => {
  const harness = createHarness();
  const sourcePath = '/other-workspace/source.jsonl';
  harness.deps.getSessionContext = () => undefined;
  let forkCwd = '';
  harness.deps.sdk.SessionManager.open = (() => ({ getCwd: () => '/other-workspace' })) as any;
  harness.deps.sdk.SessionManager.forkFrom = ((_source: string, cwd: string) => {
    forkCwd = cwd;
    return { cwd, sessionPath: '/repo/fork.jsonl' };
  }) as any;
  harness.deps.duplicateColdSession = (sessionPath) => {
    const sourceCwd = harness.deps.sdk.SessionManager.open(sessionPath).getCwd();
    const manager = harness.deps.sdk.SessionManager.forkFrom(sessionPath, sourceCwd) as unknown as { sessionPath: string };
    return { sessionPath: manager.sessionPath };
  };

  await handleBackendRequest(harness.deps, {
    id: 'duplicate-cold-cwd', method: 'session.duplicate', params: { sessionPath: sourcePath },
  });

  assert.equal(forkCwd, '/other-workspace');
});

test('session.duplicate returns a fork from the configured backend session directory', async () => {
  const harness = createHarness();
  const configuredDir = path.resolve('/configured/sessions');
  const sdkFallbackDir = path.resolve('/sdk-default/sessions');
  harness.deps.sessionDir = configuredDir;
  harness.context.session.sessionManager = {
    getCwd: () => '/source-cwd',
  } as SessionContext['session']['sessionManager'];
  harness.deps.sdk.SessionManager.forkFrom = ((
    _sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
  ) => ({
    cwd: targetCwd,
    sessionPath: path.join(sessionDir ?? sdkFallbackDir, 'forked-session.jsonl'),
  })) as unknown as typeof harness.deps.sdk.SessionManager.forkFrom;
  harness.deps.duplicateColdSession = (sourcePath) => {
    const manager = harness.deps.sdk.SessionManager.forkFrom(
      sourcePath,
      '/source-cwd',
      harness.deps.sessionDir,
    ) as unknown as { sessionPath: string };
    return { sessionPath: manager.sessionPath };
  };
  harness.deps.buildSessionOpenedPayload = async (sessionPath) => ({ sessionPath, runtimeReady: false } as any);

  const duplicated = await handleBackendRequest(harness.deps, {
    id: 'duplicate-canonical',
    method: 'session.duplicate',
    params: { sessionPath: harness.context.sessionPath },
  }) as { sessionPath: string };

  assert.equal(duplicated.sessionPath, path.join(configuredDir, 'forked-session.jsonl'));
});

test('concurrent cold message.send requests share one promotion', async () => {
  const harness = createHarness();
  let creations = 0;
  let pending: Promise<SessionContext> | undefined;
  harness.deps.getSessionContext = () => undefined;
  harness.deps.ensureSessionContext = async () => {
    pending ??= Promise.resolve().then(() => {
      creations += 1;
      return harness.context;
    });
    return await pending;
  };

  const [first, second] = await Promise.all([
    handleBackendRequest(harness.deps, {
      id: 'cold-send-1', method: 'message.send',
      params: { sessionPath: harness.context.sessionPath, text: 'first', inputs: [], localId: 'local-1' },
    }),
    handleBackendRequest(harness.deps, {
      id: 'cold-send-2', method: 'message.send',
      params: { sessionPath: harness.context.sessionPath, text: 'second', inputs: [], localId: 'local-2' },
    }),
  ]);

  assert.equal(creations, 1);
  assert.ok((first as { requestId?: string }).requestId || (second as { requestId?: string }).requestId);
  assert.ok((first as { queued?: boolean }).queued || (second as { queued?: boolean }).queued);
});

test('registered message.send carries its operation attempt through active ownership and agent settlement', async () => {
  const harness = createHarness();
  const result = await handleBackendRequest(harness.deps, {
    id: 'registered-send-attempt', method: 'message.send',
    params: {
      sessionPath: harness.context.sessionPath, text: 'Hello', inputs: [],
      operationId: 'send-operation', operationAttempt: 2,
    },
  }) as { requestId: string; operationId: string; operationAttempt: number };

  assert.equal(result.operationId, 'send-operation');
  assert.equal(result.operationAttempt, 2);
  assert.equal(harness.context.activeRequest?.operationId, 'send-operation');
  assert.equal(harness.context.activeRequest?.operationAttempt, 2);
  const requestId = harness.context.activeRequest?.id;
  const turnId = harness.context.activeRequest?.liveTurnAccumulator?.turnId;
  const attemptId = harness.context.activeRequest?.liveTurnAccumulator?.attemptId;

  handleSdkSessionEvent(
    {
      ...harness.deps,
      emitSessionOpened: async () => undefined,
      emitSessionListChanged: async () => undefined,
    } as unknown as BackendSessionEventHandlerDeps,
    harness.context,
    { type: 'agent_settled' },
  );
  const settled = harness.emitted.find((entry) => entry.event === 'agent.settled')?.payload as Record<string, unknown>;
  assert.deepEqual({
    operationId: settled.operationId,
    operationAttempt: settled.operationAttempt,
    requestId: settled.requestId,
    turnId: settled.turnId,
    attemptId: settled.attemptId,
  }, { operationId: 'send-operation', operationAttempt: 2, requestId, turnId, attemptId });
});

test('message.send accepts requests, handles preflight rejection, and guards concurrent sends', async () => {
  const acceptedHarness = createHarness();
  const accepted = await handleBackendRequest(acceptedHarness.deps, {
    id: '1',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Hello', inputs: [] },
  });
  assert.equal(typeof (accepted as { requestId: string }).requestId, 'string');
  assert.equal(acceptedHarness.busyEvents.at(-1), true);
  assert.ok(acceptedHarness.context.activeRequest?.id);
  assert.equal(acceptedHarness.context.activeRequest?.liveTurnAccumulator?.checkpoint().protocolVersion, 7);
  const succeeded = acceptedHarness.emitted.find((e) =>
    e.event === 'message.custom'
    && (e.payload as { message?: { customType?: string } }).message?.customType === 'preflight-succeeded');
  assert.ok(succeeded, 'successful preflight emits an explicit host phase boundary');

  // Steering: a second send while a turn is already in-flight is now QUEUED
  // as a steering injection (SDK `steer()`) instead of rejected. The backend
  // acks `{ queued: true }` with no new `activeRequest` (no turn is started by
  // the enqueue) and no `requestId`.
  const queued = await handleBackendRequest(acceptedHarness.deps, {
    id: '2',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Hello again', inputs: [] },
  });
  assert.equal((queued as { queued?: boolean }).queued, true);
  assert.ok(!(queued as { requestId?: string }).requestId, 'queued send must not start a turn / mint a requestId');

  const rejectedHarness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(false);
      },
    },
  });
  // Early-ack (Brief A): message.send resolves as soon as the prompt is QUEUED,
  // before the pruning prepass. A prepass rejection no longer rejects the RPC —
  // it is surfaced post-ack via the `preflight.failed` backend event so the
  // host dispatches PreflightFailed and reverts via pending.promoted.
  const rejected = await handleBackendRequest(rejectedHarness.deps, {
    id: '3',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Nope', inputs: [] },
  });
  assert.equal(typeof (rejected as { requestId: string }).requestId, 'string');
  const failed = rejectedHarness.emitted.find((e) => e.event === 'preflight.failed');
  assert.ok(failed, 'expected a preflight.failed event on prepass rejection');
  assert.equal(
    (failed?.payload as { error?: string }).error,
    'Prompt rejected before PI accepted the request.',
  );
  assert.equal(rejectedHarness.context.activeRequest, undefined);
});

test('message.continue resumes after a completed tool without invoking the prompt preflight path', async () => {
  let continueCalls = 0;
  let promptCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
        { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
      ],
      prompt: async () => { promptCalls += 1; },
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });

  const result = await handleBackendRequest(harness.deps, {
    id: 'continue-interrupted',
    method: 'message.continue',
    params: { sessionPath: harness.context.sessionPath },
  });

  assert.equal(typeof (result as { requestId?: string }).requestId, 'string');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(continueCalls, 1);
  assert.equal(promptCalls, 0, 'continuation must not enter session.prompt or before_agent_start');
  assert.ok(harness.context.activeRequest, 'continuation owns the ordinary live request lifecycle');
  assert.equal(
    harness.emitted.some((entry) => entry.event === 'message.custom'
      && (entry.payload as { message?: { customType?: string } }).message?.customType === 'preflight-succeeded'),
    false,
    'continuation has no pruning preflight phase',
  );
});

test('send, continue, compact, and title transition waits terminate at one deterministic typed deadline', async () => {
  const requests = [
    {
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'bounded send', inputs: [] },
    },
    {
      method: 'message.continue',
      params: { sessionPath: '/repo/session.jsonl' },
    },
    {
      method: 'message.compact',
      params: { sessionPath: '/repo/session.jsonl' },
    },
    {
      method: 'session.title.generate',
      params: {
        sessionPath: '/repo/session.jsonl',
        prompt: 'Name this session',
        provider: 'mock',
        model: 'model-a',
        thinkingLevel: 'medium',
        timeoutSec: 10,
      },
    },
  ] as const;

  for (const [index, candidate] of requests.entries()) {
    const clock = new FakeTransitionClock();
    let ensureCalls = 0;
    let providerStarts = 0;
    const harness = createHarness({
      sessionOverrides: {
        messages: [
          { role: 'user', content: 'work' },
          { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
          { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
        ],
        prompt: async () => { providerStarts += 1; },
        continueAfterInterruption: async () => { providerStarts += 1; },
        compact: async () => { providerStarts += 1; },
      },
    });
    harness.deps.ensureSessionContext = async () => {
      ensureCalls += 1;
      return harness.context;
    };
    harness.deps.isSessionTransitionPending = () => true;
    harness.deps.sessionTransitionWait = {
      timeoutMs: 50,
      pollIntervalMs: 10,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const rejected = assert.rejects(
      handleBackendRequest(harness.deps, {
        id: `transition-timeout-${index}`,
        method: candidate.method,
        params: candidate.params,
      }),
      (error: unknown) => error instanceof BackendError
        && error.code === 'SESSION_TRANSITION_TIMEOUT'
        && /50ms/.test(error.message),
    );
    await Promise.resolve();
    clock.advance(50);
    await rejected;

    assert.ok(ensureCalls >= 1);
    assert.equal(providerStarts, 0, `${candidate.method} must not start work after transition timeout`);
    assert.equal(harness.context.activeRequest, undefined);
  }
});

test('message.continue replays one stable operation without starting provider work twice', async () => {
  let continueCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
        { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
      ],
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });
  const params = {
    sessionPath: harness.context.sessionPath,
    operationId: 'continue-operation',
    operationAttempt: 1,
  };

  const first = await handleBackendRequest(harness.deps, {
    id: 'continue-first', method: 'message.continue', params,
  });
  const replay = await handleBackendRequest(harness.deps, {
    id: 'continue-replay', method: 'message.continue',
    params: { ...params, operationAttempt: 2 },
  });
  assert.deepEqual(replay, first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(continueCalls, 1);

  const status = await handleBackendRequest(harness.deps, {
    id: 'continue-status', method: 'operation.status',
    params: { sessionPath: harness.context.sessionPath, operationId: params.operationId },
  });
  assert.equal((status as { state: string }).state, 'accepted');
});

test('message.continue emits explicit cancelled settlement when Stop wins the acknowledgement/start gap', async () => {
  let continueCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
        { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
      ],
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });

  const result = await handleBackendRequest(harness.deps, {
    id: 'continue-cancelled-before-start',
    method: 'message.continue',
    params: { sessionPath: harness.context.sessionPath },
  }) as { requestId: string };
  harness.context.activeRequest!.aborted = true;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const terminal = harness.emitted.find((entry) => entry.event === 'message.aborted');
  assert.deepEqual(terminal?.payload, {
    requestId: result.requestId,
    sessionPath: harness.context.sessionPath,
    outcome: 'cancelled',
    userInitiated: true,
  });
  assert.equal((terminal?.payload as { messageId?: string }).messageId, undefined);
  assert.equal(continueCalls, 0);
});

test('message.continue emits explicit superseded settlement when runtime ownership changes before start', async () => {
  let continueCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
        { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
      ],
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });

  const result = await handleBackendRequest(harness.deps, {
    id: 'continue-superseded-before-start',
    method: 'message.continue',
    params: { sessionPath: harness.context.sessionPath },
  }) as { requestId: string };
  harness.context.sessionOwnershipEpoch = (harness.context.sessionOwnershipEpoch ?? 0) + 1;
  harness.context.activeRequest = undefined;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const terminal = harness.emitted.find((entry) => entry.event === 'message.aborted');
  assert.deepEqual(terminal?.payload, {
    requestId: result.requestId,
    sessionPath: harness.context.sessionPath,
    outcome: 'superseded',
  });
  assert.equal((terminal?.payload as { messageId?: string }).messageId, undefined);
  assert.equal(continueCalls, 0);
});

test('message.continue rejection before message_start settles without stamping an older assistant row', async () => {
  const harness = createHarness({
    sessionOverrides: {
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
        { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
      ],
      continueAfterInterruption: async () => { throw new Error('continuation start failed'); },
    },
  });

  const result = await handleBackendRequest(harness.deps, {
    id: 'continue-rejected-before-start',
    method: 'message.continue',
    params: { sessionPath: harness.context.sessionPath },
  }) as { requestId: string };
  await new Promise<void>((resolve) => setImmediate(resolve));

  const terminal = harness.emitted.find((entry) => entry.event === 'message.aborted');
  assert.deepEqual(terminal?.payload, {
    requestId: result.requestId,
    sessionPath: harness.context.sessionPath,
    outcome: 'failed',
    incidentId: `continuation-prestart:${result.requestId}`,
    reason: 'continuation start failed',
  });
  assert.equal((terminal?.payload as { messageId?: string }).messageId, undefined);
  assert.equal(harness.emitted.some((entry) => entry.event === 'error'), false);
  const incident = harness.emitted.find((entry) => entry.event === 'operational-error')?.payload as Record<string, unknown>;
  assert.equal(incident.code, 'MESSAGE_CONTINUE_FAILED');
  assert.equal(incident.requestId, result.requestId);
  assert.equal(incident.messageId, undefined);
  assert.equal(incident.severity, 'error');
  assert.equal(incident.certainty, 'definitive');
  assert.equal(incident.phase, 'preflight');
  assert.equal(harness.context.activeRequest, undefined);
  assert.deepEqual(harness.busyEvents, [false]);
});

test('message.continue accepts a repeated provider-forced context overflow', async () => {
  let continueCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [{
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'prompt is too long: 201000 tokens > 200000 maximum',
        content: [],
      }],
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });

  const result = await handleBackendRequest(harness.deps, {
    id: 'continue-overflow',
    method: 'message.continue',
    params: { sessionPath: harness.context.sessionPath },
  });

  assert.equal(typeof (result as { requestId?: string }).requestId, 'string');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(continueCalls, 1);
});

test('message.continue rejects a non-interrupted tail before acknowledging provider work', async () => {
  let continueCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      messages: [{ role: 'assistant', stopReason: 'stop', content: 'done' }],
      continueAfterInterruption: async () => { continueCalls += 1; },
    },
  });
  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'continue-not-available',
      method: 'message.continue',
      params: { sessionPath: harness.context.sessionPath },
    }),
    (error: unknown) => error instanceof BackendError && error.code === 'CONTINUATION_NOT_AVAILABLE',
  );
  assert.equal(continueCalls, 0);
  assert.equal(harness.context.activeRequest, undefined);
});

test('message.continue rejects a runtime without the continuation seam', async () => {
  const harness = createHarness();
  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'continue-unsupported',
      method: 'message.continue',
      params: { sessionPath: harness.context.sessionPath },
    }),
    (error: unknown) => error instanceof BackendError && error.code === 'SDK_INCOMPATIBLE',
  );
  assert.equal(harness.context.activeRequest, undefined);
});

test('message.send rejects retained models from explicitly disabled providers before enqueueing', async () => {
  const previous = process.env[PROVIDER_TOGGLES_ENV];
  process.env[PROVIDER_TOGGLES_ENV] = JSON.stringify({ 'openai-codex': false, ollama: true });
  let promptCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      model: { id: 'codex-model', provider: 'openai-codex' },
      prompt: async () => { promptCalls += 1; },
    },
  });

  try {
    await assert.rejects(
      handleBackendRequest(harness.deps, {
        id: 'provider-disabled-send',
        method: 'message.send',
        params: { sessionPath: harness.context.sessionPath, text: 'Do not enqueue', inputs: [] },
      }),
      (error: unknown) => error instanceof BackendError && error.code === 'PROVIDER_DISABLED',
    );
    assert.equal(promptCalls, 0);
    assert.equal(harness.context.activeRequest, undefined);
    assert.deepEqual(harness.busyEvents, []);
  } finally {
    if (previous === undefined) delete process.env[PROVIDER_TOGGLES_ENV];
    else process.env[PROVIDER_TOGGLES_ENV] = previous;
  }
});

test('message.send ignores stale preflight settlement after session replacement', async () => {
  let preflightResult: ((success: boolean) => void) | undefined;
  let resolvePrompt: (() => void) | undefined;
  const harness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        preflightResult = options?.preflightResult;
        await new Promise<void>((resolve) => { resolvePrompt = resolve; });
      },
    },
  });

  const sent = await handleBackendRequest(harness.deps, {
    id: 'replacement-stale-preflight',
    method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: '/replace', inputs: [] },
  });
  assert.equal(typeof (sent as { requestId: string }).requestId, 'string');
  const originalSession = harness.context.session;
  const originalPath = harness.context.sessionPath;
  harness.context.session = { ...originalSession } as SessionContext['session'];
  harness.context.sessionPath = '/repo/replacement.jsonl';
  harness.context.sessionOwnershipEpoch = (harness.context.sessionOwnershipEpoch ?? 0) + 1;
  harness.context.activeRequest = undefined;

  preflightResult?.(true);
  resolvePrompt?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.context.sessionPath, '/repo/replacement.jsonl');
  assert.equal(harness.emitted.some((entry) => entry.event === 'message.custom'), false);
  assert.deepEqual(harness.busyEvents, [], 'stale preflight must not mark the replacement busy');
  assert.equal(originalPath, '/repo/session.jsonl');
});

test('message.interrupt during preflight prevents the later agent prompt from starting', async () => {
  let releasePreflight: (() => void) | undefined;
  const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
  let agentPromptStarts = 0;
  let abortCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        await preflightGate;
        options?.preflightResult?.(true);
        agentPromptStarts += 1;
      },
      abort: async () => { abortCalls += 1; },
    },
  });

  const sent = await handleBackendRequest(harness.deps, {
    id: 'send-interrupted-during-preflight',
    method: 'message.send',
    params: {
      sessionPath: harness.context.sessionPath, operationId: 'operation-preflight-stop',
      text: 'do not start', inputs: [], localId: 'local-preflight-stop',
    },
  });
  assert.equal(typeof (sent as { requestId: string }).requestId, 'string');
  assert.ok(harness.context.activeRequest, 'send owns the preflight window before interrupt');

  assert.deepEqual(await handleBackendRequest(harness.deps, {
    id: 'interrupt-during-preflight',
    method: 'message.interrupt',
    params: { sessionPath: harness.context.sessionPath },
  }), { interrupted: true, settled: true });
  assert.equal(abortCalls, 1);
  assert.equal(harness.context.activeRequest, undefined);

  releasePreflight?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(agentPromptStarts, 0, 'a cancelled preflight must not cross into a billable agent prompt');
  assert.equal(harness.emitted.some((entry) => entry.event === 'preflight.failed'), false);
  assert.deepEqual(
    harness.emitted.filter((entry) => entry.event === 'message.aborted')
      .map((entry) => entry.payload),
    [{
      requestId: (sent as { requestId: string }).requestId,
      operationId: 'operation-preflight-stop',
      sessionPath: harness.context.sessionPath,
      outcome: 'cancelled',
      userInitiated: true,
      reason: 'The send was cancelled by Stop before it started.',
    }],
  );
  assert.deepEqual(harness.busyEvents, [false]);
});

test('message.send terminalizes an ordinary no-agent extension command', async () => {
  const harness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(true);
      },
    },
  });

  const sent = await handleBackendRequest(harness.deps, {
    id: 'ordinary-extension-command',
    method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: '/ordinary', inputs: [] },
  });
  assert.equal(typeof (sent as { requestId: string }).requestId, 'string');
  assert.equal(harness.context.activeRequest, undefined);
  assert.deepEqual(harness.busyEvents, [true, false]);
  const terminal = harness.emitted.find((entry) => entry.event === 'preflight.failed');
  assert.equal((terminal?.payload as { sessionPath?: string }).sessionPath, harness.context.sessionPath);
});

// Regression: the backend pre-commit safety-net timer (PROMPT_TIMEOUT_MS) MUST
// be cleared at the commit point (first assistant `message_start`), not only on
// `session.prompt()` settle. Without this clear, a healthy multi-turn agentic
// run (which keeps `session.prompt()` pending across all internal turns until
// the whole run completes) is aborted mid-stream once the run exceeds
// PROMPT_TIMEOUT_MS — surfacing as `stopReason: "aborted"` + "Request was
// aborted." with all-zero usage. This test arms the timer with a pending
// prompt, drives the commit-point `message_start`, then waits past the timer
// budget and asserts no abort / preflight.failed fired.
test('message.send pre-commit safety timer is cleared at the first message_start (no mid-stream abort)', async () => {
  // Use a short, real timer budget to keep the test fast while still proving the
  // clear happens. We patch PROMPT_TIMEOUT_MS indirectly by waiting longer than
  // the production 10-min budget is impractical, so instead we assert the
  // observable contract: after the commit point, the stashed timer handle is
  // gone AND no abort/preflight.failed fires after a generous wait.
  let abortCalled = false;
  const promptResolve = new Promise<void>(() => {
    // Never resolves by default — simulates a long agentic run.
  });
  const longRunHarness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(true);
        await promptResolve;
      },
      abort: async () => {
        abortCalled = true;
      },
    },
  });

  const sent = await handleBackendRequest(longRunHarness.deps, {
    id: '1',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Long run', inputs: [] },
  });
  assert.equal(typeof (sent as { requestId: string }).requestId, 'string');
  // Timer armed at send time.
  assert.ok(longRunHarness.context.activeRequest?.promptSafetyTimer, 'safety timer should be armed at send');

  // Commit point: the first assistant message_start for this request.
  handleSdkSessionEvent(
    {
      emit: (event: string, payload?: unknown) => longRunHarness.emitted.push({ event, payload }),
      emitBusyChanged: (_c: SessionContext, busy: boolean) => longRunHarness.busyEvents.push(busy),
      emitContextUsageChanged: () => undefined,
    } as any,
    longRunHarness.context,
    { type: 'message_start', message: { role: 'assistant' } } as SdkSessionEvent,
  );

  // The timer MUST be cleared at the commit point.
  assert.equal(
    longRunHarness.context.activeRequest?.promptSafetyTimer,
    undefined,
    'safety timer must be cleared at the first message_start (commit point)',
  );

  // Wait past the timer budget. The production budget is 10 min; we cannot wait
  // that long in a unit test, so we assert the observable contract: the stashed
  // handle is gone (cleared), so the timer callback cannot fire. The abort
  // assertion is a belt-and-suspenders check that no abort was triggered by the
  // (now-cleared) timer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(abortCalled, false, 'session.abort() must not be called after the commit-point clear');
  const failed = longRunHarness.emitted.find((e) => e.event === 'preflight.failed');
  assert.equal(failed, undefined, 'no preflight.failed must fire after the commit point');
});

test('message.compact joins duplicate attempts and preserves manual intent identity', async () => {
  let compactCalls = 0;
  let finishCompact!: () => void;
  const compactGate = new Promise<void>((resolve) => { finishCompact = resolve; });
  const harness = createHarness({
    sessionOverrides: {
      compact: async () => { compactCalls += 1; await compactGate; },
    },
  });
  const params = {
    sessionPath: harness.context.sessionPath,
    operationId: 'compact-operation', operationAttempt: 1, reason: 'manual',
  };
  const first = handleBackendRequest(harness.deps, {
    id: 'compact-first', method: 'message.compact', params,
  });
  await Promise.resolve();
  const replay = handleBackendRequest(harness.deps, {
    id: 'compact-replay', method: 'message.compact', params: { ...params, operationAttempt: 2 },
  });
  finishCompact();

  assert.deepEqual(await replay, await first);
  assert.equal(compactCalls, 1);
});

test('operation.status rejects reconciliation from a stale backend generation', async () => {
  const harness = createHarness();
  harness.deps.backendGeneration = 8;
  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'stale-status', method: 'operation.status',
      params: {
        sessionPath: harness.context.sessionPath,
        operationId: 'unknown-operation', backendGeneration: 7,
      },
    }),
    (error: unknown) => error instanceof BackendError && error.code === 'SESSION_GENERATION_ENDED',
  );
});

test('message.compact compacts an idle session and rejects a running session', async () => {
  let compactCalls = 0;
  const idleHarness = createHarness({
    sessionOverrides: { compact: async () => { compactCalls += 1; } },
  });
  assert.deepEqual(await handleBackendRequest(idleHarness.deps, {
    id: 'compact-idle', method: 'message.compact', params: { sessionPath: idleHarness.context.sessionPath },
  }), { compacted: true });
  assert.equal(compactCalls, 1);

  const runningHarness = createHarness({
    sessionOverrides: { isStreaming: true, compact: async () => { compactCalls += 1; } },
  });
  await assert.rejects(() => handleBackendRequest(runningHarness.deps, {
    id: 'compact-running', method: 'message.compact', params: { sessionPath: runningHarness.context.sessionPath },
  }), /Cannot compact while this session is running/);
  assert.equal(compactCalls, 1);
});

test('message.interrupt validates running state and reports abort failures', async () => {
  const missingHarness = createHarness();
  missingHarness.deps.getSessionContext = () => undefined;
  await assert.rejects(
    async () => await handleBackendRequest(missingHarness.deps, {
      id: '1',
      method: 'message.interrupt',
      params: { sessionPath: '/repo/session.jsonl' },
    }),
    /Cannot interrupt an unopened session/,
  );

  const idleHarness = createHarness();
  assert.deepEqual(await handleBackendRequest(idleHarness.deps, {
    id: '2',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  }), { interrupted: false, alreadyStopped: true });

  const activeHarness = createHarness({
    context: {
      activeRequest: { id: 'req-1', messageIndex: 0, aborted: false },
    },
    sessionOverrides: {
      isStreaming: true,
      abort: async () => {
        throw new Error('abort failed');
      },
    },
  });
  await assert.rejects(() => handleBackendRequest(activeHarness.deps, {
    id: '3',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  }), /abort failed/);
  assert.equal(activeHarness.context.activeRequest?.aborted, true);
});

test('interrupt watchdog duration uses readable singular, plural, and millisecond labels', () => {
  assert.equal(formatInterruptWatchdogDuration(5), '5ms');
  assert.equal(formatInterruptWatchdogDuration(1000), '1 second');
  assert.equal(formatInterruptWatchdogDuration(30_000), '30 seconds');
});

test('message.interrupt terminalizes locally and replaces runtime when remote teardown never settles', async () => {
  const previous = process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
  process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = '5';
  try {
    const harness = createHarness({
      sessionOverrides: { isStreaming: true, abort: () => new Promise(() => undefined) },
      context: { activeRequest: { id: 'req-stuck-abort', messageIndex: 1, lastAssistantMessageId: 'm1', aborted: false } },
    });
    const uiRequests: unknown[] = [];
    const bridge = new ExtensionUIBridge(harness.context.sessionPath, (_event, payload) => uiRequests.push(payload));
    harness.context.uiBridge = bridge;
    const result = await handleBackendRequest(harness.deps, {
      id: 'interrupt-stuck', method: 'message.interrupt', params: { sessionPath: harness.context.sessionPath },
    }) as { interrupted: boolean; settled: boolean; teardownTimedOut: boolean };
    assert.deepEqual(result, { interrupted: true, settled: false, teardownTimedOut: true });
    assert.equal(harness.context.activeRequest, undefined);
    assert.deepEqual(harness.busyEvents, [false]);
    assert.equal(harness.createCalls.length, 1);
    const operationalErrors = harness.emitted.filter((entry) => entry.event === 'operational-error');
    assert.equal(operationalErrors.length, 1, 'one stuck interrupt must surface one recovery notice');
    assert.deepEqual(operationalErrors[0]?.payload, {
      incidentId: 'interrupt-stuck:req-stuck-abort',
      dedupeKey: 'interrupt-stuck:/repo/session.jsonl:req-stuck-abort',
      code: 'INTERRUPT_ABORT_STUCK',
      message: 'Stop did not settle within 5ms, so Pie ended the turn locally and is refreshing the session runtime.',
      detail: 'session.abort() did not settle within 5ms. The stalled session runtime was retired before replacement.',
      sessionPath: harness.context.sessionPath,
      requestId: 'req-stuck-abort',
      messageId: 'm1',
      severity: 'error',
      certainty: 'definitive',
      phase: 'recovery',
      recovery: { retry: false, restart: true, showLogs: true },
    });
    assert.equal(harness.emitted.some((entry) => entry.event === 'message.aborted'), true);
    assert.equal(await bridge.confirm('late', 'runtime request'), false);
    bridge.notify('late runtime notice');
    assert.deepEqual(uiRequests, [], 'the retired runtime bridge must stay fenced after replacement starts');
  } finally {
    if (previous === undefined) delete process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
    else process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = previous;
  }
});

test('message.interrupt preserves semantic recovery that starts while abort is pending', async () => {
  const previous = process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
  process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = '5';
  try {
    let abortStarted: (() => void) | undefined;
    const abortDidStart = new Promise<void>((resolve) => { abortStarted = resolve; });
    const harness = createHarness({
      sessionOverrides: {
        isStreaming: true,
        abort: () => {
          abortStarted?.();
          return new Promise<void>(() => undefined);
        },
      },
      context: { activeRequest: { id: 'req-racing-recovery', messageIndex: 1, aborted: false } },
    });
    const interrupt = handleBackendRequest(harness.deps, {
      id: 'interrupt-racing-recovery',
      method: 'message.interrupt',
      params: { sessionPath: harness.context.sessionPath },
    });
    await abortDidStart;

    const existingRecovery = new Promise<SessionContext>(() => undefined);
    harness.context.retired = true;
    harness.context.recoveryPromise = existingRecovery;

    assert.deepEqual(await interrupt, {
      interrupted: false,
      alreadyStopped: true,
      recoveryPending: true,
    });
    assert.equal(harness.context.recoveryPromise, existingRecovery);
    assert.equal(harness.createCalls.length, 0, 'the interrupt watchdog must not steal recovery ownership');
  } finally {
    if (previous === undefined) delete process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
    else process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = previous;
  }
});

test('send, continue, and compact bound an unresolved runtime recovery before mutating the session', async () => {
  const requests = [
    {
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'bounded recovery', inputs: [] },
    },
    {
      method: 'message.continue',
      params: { sessionPath: '/repo/session.jsonl' },
    },
    {
      method: 'message.compact',
      params: { sessionPath: '/repo/session.jsonl' },
    },
  ] as const;

  for (const [index, candidate] of requests.entries()) {
    const clock = new FakeTransitionClock();
    let mutations = 0;
    const harness = createHarness({
      context: {
        retired: true,
        recoveryPromise: new Promise<SessionContext>(() => undefined),
      },
      sessionOverrides: {
        messages: [
          { role: 'user', content: 'work' },
          { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-1' }] },
          { role: 'toolResult', toolCallId: 'tool-1', content: 'done' },
        ],
        prompt: async () => { mutations += 1; },
        continueAfterInterruption: async () => { mutations += 1; },
        compact: async () => { mutations += 1; },
      },
    });
    harness.deps.sessionTransitionWait = {
      timeoutMs: 50,
      pollIntervalMs: 10,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    };

    const rejected = assert.rejects(
      handleBackendRequest(harness.deps, {
        id: `recovery-timeout-${index}`,
        method: candidate.method,
        params: candidate.params,
      }),
      (error: unknown) => error instanceof BackendError
        && error.code === 'SESSION_TRANSITION_TIMEOUT'
        && /50ms/.test(error.message),
    );
    await Promise.resolve();
    clock.advance(50);
    await rejected;
    assert.equal(mutations, 0, `${candidate.method} must not enter a runtime whose recovery did not settle`);
    assert.equal(harness.context.activeRequest, undefined);
  }
});

test('send, continue, and compact reject a retired runtime before mutating it', async () => {
  const requests = [
    {
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'retired runtime', inputs: [] },
    },
    {
      method: 'message.continue',
      params: { sessionPath: '/repo/session.jsonl' },
    },
    {
      method: 'message.compact',
      params: { sessionPath: '/repo/session.jsonl' },
    },
  ] as const;

  for (const [index, candidate] of requests.entries()) {
    let mutations = 0;
    const harness = createHarness({
      context: { retired: true },
      sessionOverrides: {
        prompt: async () => { mutations += 1; },
        continueAfterInterruption: async () => { mutations += 1; },
        compact: async () => { mutations += 1; },
      },
    });

    await assert.rejects(
      handleBackendRequest(harness.deps, {
        id: `retired-runtime-${index}`,
        method: candidate.method,
        params: candidate.params,
      }),
      (error: unknown) => error instanceof BackendError
        && error.code === 'SESSION_RUNTIME_RECOVERY_FAILED'
        && /retired/.test(error.message),
    );
    assert.equal(mutations, 0, `${candidate.method} must not mutate a retired runtime`);
    assert.equal(harness.context.activeRequest, undefined);
  }
});

test('send, continue, and compact revalidate worker ownership at the SDK mutation boundary', async () => {
  const requests = [
    {
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'revoked owner', inputs: [] },
    },
    {
      method: 'message.continue',
      params: { sessionPath: '/repo/session.jsonl' },
    },
    {
      method: 'message.compact',
      params: { sessionPath: '/repo/session.jsonl' },
    },
  ] as const;

  for (const [index, candidate] of requests.entries()) {
    let mutations = 0;
    const harness = createHarness({
      sessionOverrides: {
        prompt: async () => { mutations += 1; },
        continueAfterInterruption: async () => { mutations += 1; },
        compact: async () => { mutations += 1; },
      },
    });
    harness.deps.isSessionContextCurrent = () => false;

    await assert.rejects(
      handleBackendRequest(harness.deps, {
        id: `revoked-runtime-${index}`,
        method: candidate.method,
        params: candidate.params,
      }),
      (error: unknown) => error instanceof BackendError
        && error.code === 'SESSION_RUNTIME_RECOVERY_FAILED'
        && /owner changed/.test(error.message),
    );
    assert.equal(mutations, 0, `${candidate.method} must not mutate after worker ownership is revoked`);
    assert.equal(harness.context.activeRequest, undefined);
  }
});

test('message.send waits for semantic-timeout recovery instead of steering into the retired runtime', async () => {
  let oldSteerCalls = 0;
  let resolveReplacement: ((context: SessionContext) => void) | undefined;
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      steer: async () => { oldSteerCalls += 1; },
      abort: () => new Promise<void>(() => undefined),
    },
  });
  harness.context.retired = true;
  harness.context.recoveryPromise = new Promise<SessionContext>((resolve) => {
    resolveReplacement = resolve;
  });

  let replacementPromptCalls = 0;
  const replacementSession = {
    ...harness.context.session,
    isStreaming: false,
    prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
      replacementPromptCalls += 1;
      options?.preflightResult?.(true);
    },
  } as SessionContext['session'];
  const replacement: SessionContext = {
    ...harness.context,
    session: replacementSession,
    retired: false,
    recoveryPromise: undefined,
  };

  const send = handleBackendRequest(harness.deps, {
    id: 'send-after-semantic-timeout',
    method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: 'continue safely', inputs: [] },
  });
  await Promise.resolve();
  assert.equal(oldSteerCalls, 0);
  assert.equal(replacementPromptCalls, 0, 'send must wait until replacement is authoritative');

  resolveReplacement?.(replacement);
  const result = await send as { requestId?: string; queued?: boolean };
  assert.equal(typeof result.requestId, 'string');
  assert.equal(result.queued, undefined);
  assert.equal(oldSteerCalls, 0);
  assert.equal(replacementPromptCalls, 1);
});

test('message.send rejects without steering when semantic-timeout replacement fails', async () => {
  let oldSteerCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      steer: async () => { oldSteerCalls += 1; },
    },
  });
  harness.context.retired = true;
  harness.context.recoveryPromise = Promise.reject(new Error('replacement construction failed'));

  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'send-after-failed-semantic-recovery',
      method: 'message.send',
      params: { sessionPath: harness.context.sessionPath, text: 'do not queue this', inputs: [] },
    }),
    (error: unknown) => error instanceof BackendError
      && error.code === 'SESSION_RUNTIME_RECOVERY_FAILED'
      && /replacement construction failed/.test(error.message),
  );
  assert.equal(oldSteerCalls, 0);
});

test('message.interrupt does not start a second replacement while semantic recovery is pending', async () => {
  let abortCalls = 0;
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      abort: async () => { abortCalls += 1; },
    },
  });
  harness.context.retired = true;
  harness.context.recoveryPromise = new Promise<SessionContext>(() => undefined);

  const result = await handleBackendRequest(harness.deps, {
    id: 'interrupt-during-semantic-recovery',
    method: 'message.interrupt',
    params: { sessionPath: harness.context.sessionPath },
  });

  assert.deepEqual(result, {
    interrupted: false,
    alreadyStopped: true,
    recoveryPending: true,
  });
  assert.equal(abortCalls, 0);
  assert.equal(harness.createCalls.length, 0, 'the existing recovery remains the sole replacement owner');
});

test('late prompt rejection from a retired runtime cannot emit a second terminal event', async () => {
  let rejectPrompt: ((error: Error) => void) | undefined;
  const harness = createHarness({
    sessionOverrides: {
      prompt: (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(true);
        return new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
      },
    },
  });

  await handleBackendRequest(harness.deps, {
    id: 'send-before-semantic-retirement',
    method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: 'start', inputs: [] },
  });
  harness.context.retired = true;
  harness.context.activeRequest = undefined;
  const emittedBeforeLateRejection = harness.emitted.length;
  const busyBeforeLateRejection = harness.busyEvents.length;

  rejectPrompt?.(new Error('abort settled after local retirement'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.emitted.length, emittedBeforeLateRejection);
  assert.equal(harness.busyEvents.length, busyBeforeLateRejection);
  assert.equal(harness.emitted.some((entry) => entry.event === 'preflight.failed'), false);
});

test('message.interrupt defensively clears a stuck activeRequest when abort settles and streaming has stopped', async () => {
  // Reproduces the stuck-session bug: the SDK never fires `turn_end` (e.g. a
  // hung provider connection), so `activeRequest` would stay set forever and
  // block sends + live model switches. The interrupt's `.finally` clears it
  // once the abort promise settles AND the session has actually stopped
  // streaming, never clobbering a still-streaming turn.
  let abortResolve: (() => void) | undefined;
  const harness = createHarness({
    context: {
      activeRequest: {
        id: 'req-stuck', operationId: 'operation-stuck', messageIndex: 0,
        semanticStarted: true, currentMessageId: 'message-stuck', aborted: false,
      },
    },
    sessionOverrides: {
      isStreaming: true,
      abort: () => new Promise<void>((resolve) => { abortResolve = resolve; }),
    },
  });

  const interruptPromise = handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.equal(harness.context.activeRequest?.aborted, true);

  // Simulate the provider tearing down the stream after abort resolves.
  (harness.context.session as unknown as { isStreaming: boolean }).isStreaming = false;
  abortResolve!();
  assert.deepEqual(await interruptPromise, { interrupted: true, settled: true });

  // The defensive clear fired: activeRequest is gone and busy=false emitted.
  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(harness.busyEvents.at(-1), false);
  assert.deepEqual(
    harness.emitted.filter((entry) => entry.event === 'message.aborted').map((entry) => entry.payload),
    [{
      requestId: 'req-stuck', operationId: 'operation-stuck', sessionPath: '/repo/session.jsonl',
      messageId: 'message-stuck', userInitiated: true,
    }],
  );

  // A subsequent settings.set carrying a different model is no longer blocked
  // by the stale REQUEST_IN_PROGRESS — the live switch proceeds.
  const updated = await handleBackendRequest(harness.deps, {
    id: '2',
    method: 'settings.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      defaultModel: 'model-b',
      defaultThinkingLevel: 'high',
    },
  });
  assert.deepEqual(updated, { defaultModel: 'model-b', defaultThinkingLevel: 'high' });
  assert.equal((harness.context.session.model as { id: string }).id, 'model-b');
});

test('message.interrupt escalates when abort resolves but full billable activity remains', async () => {
  const previous = process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
  process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = '5';
  try {
    let abortResolve: (() => void) | undefined;
    const harness = createHarness({
      context: {
        activeRequest: { id: 'req-streaming', messageIndex: 0, aborted: false },
      },
      sessionOverrides: {
        isStreaming: true,
        abort: () => new Promise<void>((resolve) => { abortResolve = resolve; }),
      },
    });

    const interruptPromise = handleBackendRequest(harness.deps, {
      id: '1',
      method: 'message.interrupt',
      params: { sessionPath: '/repo/session.jsonl' },
    });
    abortResolve!();
    assert.deepEqual(await interruptPromise, { interrupted: true, settled: false, teardownTimedOut: true });
    assert.equal(harness.context.retired, true);
  } finally {
    if (previous === undefined) delete process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
    else process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = previous;
  }
});

test('message.interrupt hard-stops compaction when interrupted during the post-agent_end window', async () => {
  // Reproduces the "appears stopped but still burning money" bug: after
  // agent_end the backend already cleared activeRequest + emitted busy=false,
  // but the SDK is still running a billable compaction LLM call (isCompacting).
  // The interrupt must NOT be rejected as SESSION_NOT_RUNNING, and must call
  // the public abortCompaction/abortBranchSummary/abortBash/abortRetry methods
  // (which abort() alone does NOT) so spend stops instantly — before the
  // un-awaited abort() even runs.
  const aborted: Record<string, boolean> = {};
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: false,      // agent_end already fired
      isCompacting: true,      // compaction LLM call in flight
      isRetrying: false,
      isBashRunning: false,
      abortCompaction: () => {
        aborted.compaction = true;
        harness.context.session.isCompacting = false;
      },
      abortBranchSummary: () => { aborted.branchSummary = true; },
      abortBash: () => { aborted.bash = true; },
      abortRetry: () => { aborted.retry = true; },
      abort: async () => undefined,
    },
  });
  // No activeRequest (cleared on agent_end) — the legacy guard would throw
  // SESSION_NOT_RUNNING here. The relaxed guard must see isCompacting and pass.
  assert.equal(harness.context.activeRequest, undefined);

  const interrupted = await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(interrupted, { interrupted: true, settled: true });

  // Every billable window was hard-stopped synchronously (before abort()).
  assert.equal(aborted.compaction, true);
  assert.equal(aborted.branchSummary, true);
  assert.equal(aborted.bash, true);
  assert.equal(aborted.retry, true);
});

test('Stop cancels manual compaction that is still awaiting the SDK pre-compaction abort', async () => {
  const harness = createHarness();
  const eventDeps: BackendSessionEventHandlerDeps = {
    ...harness.deps,
    recoverStuckSession() {},
    async emitSessionOpened() {},
  };
  let markInitialAbortStarted!: () => void;
  const initialAbortStarted = new Promise<void>((resolve) => { markInitialAbortStarted = resolve; });
  let releaseInitialAbort!: () => void;
  const initialAbort = new Promise<void>((resolve) => { releaseInitialAbort = resolve; });
  let abortCalls = 0;
  let controllerReady = false;
  let compactionAborted = false;
  let providerStarted = false;
  const session = harness.context.session as unknown as {
    abort: () => Promise<void>;
    abortCompaction: () => void;
    compact: () => Promise<void>;
  };
  session.abort = async () => {
    abortCalls += 1;
    if (abortCalls === 1) {
      markInitialAbortStarted();
      await initialAbort;
    }
  };
  session.abortCompaction = () => {
    if (controllerReady) compactionAborted = true;
  };
  session.compact = async () => {
    await session.abort();
    controllerReady = true;
    handleSdkSessionEvent(eventDeps, harness.context, { type: 'compaction_start', reason: 'manual' });
    if (!compactionAborted) providerStarted = true;
    handleSdkSessionEvent(eventDeps, harness.context, {
      type: 'compaction_end', reason: 'manual', aborted: compactionAborted,
    });
    if (compactionAborted) throw new Error('Compaction cancelled');
  };

  const compact = handleBackendRequest(harness.deps, {
    id: 'compact-before-controller',
    method: 'message.compact',
    params: { sessionPath: harness.context.sessionPath },
  });
  await initialAbortStarted;
  assert.equal(harness.context.manualCompactionRequest?.cancelled, false);

  const stop = handleBackendRequest(harness.deps, {
    id: 'stop-before-controller',
    method: 'message.interrupt',
    params: { sessionPath: harness.context.sessionPath },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.context.manualCompactionRequest?.cancelled, true);

  releaseInitialAbort();
  await assert.rejects(compact, /Compaction cancelled/);
  assert.deepEqual(await stop, { interrupted: true, settled: true });
  assert.equal(compactionAborted, true, 'compaction_start replays Stop onto the newly created controller');
  assert.equal(providerStarted, false, 'the cancelled manual compact never reaches provider work');
  assert.equal(harness.context.manualCompactionRequest, undefined);
});

test('session.open re-arms busy while history compaction is active', async () => {
  const harness = createHarness({ sessionOverrides: { isCompacting: true } });

  await handleBackendRequest(harness.deps, {
    id: 'open-compacting',
    method: 'session.open',
    params: { sessionPath: '/repo/session.jsonl' },
  });

  assert.deepEqual(harness.busyEvents, [true]);
});

test('message.interrupt is idempotent when truly idle', async () => {
  // Host/backend busy events can cross at turn boundaries. Stop must remain a
  // successful barrier rather than wedging the UI with SESSION_NOT_RUNNING.
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      isBashRunning: false,
    },
  });
  assert.deepEqual(await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  }), { interrupted: false, alreadyStopped: true });
});

test('compaction_start/compaction_end re-arm busy so a compaction call stays interruptable', async () => {
  // agent_end already emitted busy=false (Stop button gone) before the SDK
  // runs its post-agent_end compaction. compaction_start must re-arm busy so
  // the Stop button stays visible (and the session stays interruptable) while
  // compaction bills; compaction_end restores idle.
  const harness = createHarness();

  // The compaction handlers only call emitBusyChanged (which the harness deps
  // provide); cast across the narrower event-handler deps shape for the test.
  const eventDeps: BackendSessionEventHandlerDeps = {
    ...harness.deps,
    recoverStuckSession() {},
    async emitSessionOpened(sessionPath) {
      harness.emitted.push({ event: 'session.opened', payload: { sessionPath } });
    },
  };
  handleSdkSessionEvent(eventDeps, harness.context, { type: 'compaction_start' });
  assert.deepEqual(harness.busyEvents, [true]);

  handleSdkSessionEvent(eventDeps, harness.context, {
    type: 'compaction_end',
    result: {
      summary: 'Condensed history',
      firstKeptEntryId: 'kept-entry',
      tokensBefore: 100,
      estimatedTokensAfter: 25,
      details: { readFiles: [], modifiedFiles: [] },
    },
  });
  assert.deepEqual(harness.busyEvents, [true, false]);
  assert.deepEqual(harness.emitContextUsageChangedCalls, [harness.context]);
  assert.equal(harness.emitted.some((entry) => entry.event === 'session.opened'), true);
  assert.equal(harness.emitted.some((entry) => entry.event === 'session.list.changed'), true);
});

test('cold session.truncateAfter delegates the durable rewrite without creating a runtime', async () => {
  await withTempDir(async (dir) => {
    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep-1', message: 'keep' }),
      '{bad json}',
      JSON.stringify({ id: 'stop-here', message: 'stop' }),
      JSON.stringify({ id: 'after-stop', message: 'drop' }),
    ].join('\n') + '\n', 'utf8');

    const harness = createHarness();
    harness.context.sessionPath = sessionPath;
    harness.deps.getSessionContext = () => undefined;
    harness.deps.truncateColdSessionAfter = async (openedPath, entryId) => {
      const rows = (await fs.readFile(openedPath, 'utf8')).split('\n');
      const kept: string[] = [];
      for (const row of rows) {
        if (!row.trim()) continue;
        try {
          if ((JSON.parse(row) as { id?: string }).id === entryId) break;
          kept.push(row);
        } catch { /* cold store omits malformed rows */ }
      }
      await fs.writeFile(openedPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
      return { sessionPath: openedPath };
    };
    harness.deps.buildSessionOpenedPayload = async (openedPath) => ({ sessionPath: openedPath, runtimeReady: false } as any);

    const result = await handleBackendRequest(harness.deps, {
      id: '1',
      method: 'session.truncateAfter',
      params: { sessionPath, entryId: 'stop-here' },
    });

    assert.deepEqual(result, { ok: true, sessionPath });
    assert.deepEqual(harness.openCalls, []);
    assert.deepEqual(harness.createCalls, []);
    const rewritten = await fs.readFile(sessionPath, 'utf8');
    assert.equal(rewritten, `${JSON.stringify({ id: 'keep-1', message: 'keep' })}\n`);
    assert.deepEqual(harness.emitted.at(-2), { event: 'session.opened', payload: { sessionPath, runtimeReady: false } });
  });
});

test('settings.set applies live model changes and rolls back persisted settings on failure', async () => {
  const successHarness = createHarness();
  const updated = await handleBackendRequest(successHarness.deps, {
    id: '1',
    method: 'settings.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      defaultModel: 'model-b',
      defaultThinkingLevel: 'high',
    },
  });

  assert.deepEqual(updated, { defaultModel: 'model-b', defaultThinkingLevel: 'high' });
  assert.equal((successHarness.context.session.model as { id: string }).id, 'model-b');
  assert.equal(successHarness.context.session.thinkingLevel, 'high');
  // Model switch delegates a fresh context-usage re-emit to the server's
  // emitContextUsageChanged (resolves the new model's window + last prompt
  // footprint) instead of blanking to null.
  assert.equal(successHarness.emitContextUsageChangedCalls.length, 1);
  assert.equal(successHarness.emitContextUsageChangedCalls[0], successHarness.context);

  const failingHarness = createHarness({
    sessionOverrides: {
      setModel: undefined,
    },
  });
  await assert.rejects(
    async () => await handleBackendRequest(failingHarness.deps, {
      id: '2',
      method: 'settings.set',
      params: {
        sessionPath: '/repo/session.jsonl',
        defaultModel: 'model-b',
      },
    }),
    /does not support live model switching/,
  );
  assert.deepEqual(failingHarness.writtenSettings, [
    { defaultModel: 'model-b' },
    // The rollback restores defaultModel + defaultThinkingLevel and explicitly
    // resets defaultProvider (to undefined here, since the previous settings
    // had none) so a provider added by the failed switch is dropped from the
    // merge-persisted settings.json.
    { defaultModel: 'model-a', defaultThinkingLevel: 'medium', defaultProvider: undefined },
  ]);
});

test('settings.set persists an explicit provider-only default update', async () => {
  const harness = createHarness({
    modelSettings: {
      defaultModel: 'model-a',
      defaultProvider: 'provider-a',
      defaultThinkingLevel: 'medium',
    },
  });

  const updated = await handleBackendRequest(harness.deps, {
    id: 'settings-provider-only',
    method: 'settings.set',
    params: { defaultProvider: 'provider-b' },
  });

  assert.deepEqual(harness.writtenSettings, [{ defaultProvider: 'provider-b' }]);
  assert.deepEqual(updated, {
    defaultModel: 'model-a',
    defaultProvider: 'provider-b',
    defaultThinkingLevel: 'medium',
  });
});

test('settings.set persists cold per-session model and reasoning choices instead of changing only the global default', async () => {
  const harness = createHarness();
  harness.deps.getSessionContext = () => undefined;
  harness.deps.listAvailableModels = () => [{
    id: 'model-b',
    name: 'Model B',
    provider: 'mock',
    reasoning: true,
    inputKinds: ['text'],
  }];
  const coldWrites: Array<{
    sessionPath: string;
    updates: {
      model?: { provider: string; modelId: string };
      thinkingLevel?: ModelSettings['defaultThinkingLevel'];
    };
  }> = [];
  harness.deps.applyColdSessionModelSettings = async (sessionPath, updates) => {
    coldWrites.push({ sessionPath, updates });
  };

  const updated = await handleBackendRequest(harness.deps, {
    id: 'settings-set-cold',
    method: 'settings.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      defaultModel: 'model-b',
      defaultProvider: 'mock',
      defaultThinkingLevel: 'high',
    },
  });

  assert.deepEqual(updated, {
    defaultModel: 'model-b',
    defaultProvider: 'mock',
    defaultThinkingLevel: 'high',
  });
  assert.deepEqual(harness.writtenSettings, [{
    defaultModel: 'model-b',
    defaultProvider: 'mock',
    defaultThinkingLevel: 'high',
  }]);
  assert.deepEqual(coldWrites, [{
    sessionPath: '/repo/session.jsonl',
    updates: {
      model: { provider: 'mock', modelId: 'model-b' },
      thinkingLevel: 'high',
    },
  }]);
});

test('settings.set rolls back the global default when a cold per-session append fails', async () => {
  const harness = createHarness();
  harness.deps.getSessionContext = () => undefined;
  harness.deps.listAvailableModels = () => [{
    id: 'model-b',
    name: 'Model B',
    provider: 'mock',
    reasoning: true,
    inputKinds: ['text'],
  }];
  harness.deps.applyColdSessionModelSettings = async () => {
    throw new Error('cold append failed');
  };

  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'settings-set-cold-failure',
    method: 'settings.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      defaultModel: 'model-b',
      defaultProvider: 'mock',
      defaultThinkingLevel: 'high',
    },
  }), /cold append failed/);

  assert.deepEqual(harness.writtenSettings, [
    { defaultModel: 'model-b', defaultProvider: 'mock', defaultThinkingLevel: 'high' },
    { defaultModel: 'model-a', defaultThinkingLevel: 'medium', defaultProvider: undefined },
  ]);
});

test('systemPromptToggles.set persists and confirms a cold session without creating a runtime', async () => {
  const harness = createHarness();
  harness.deps.getSessionContext = () => undefined;
  harness.deps.ensureSessionContext = async () => {
    assert.fail('a cold prompt toggle must not promote or ensure a runtime');
  };
  const writes: Array<{ sessionPath: string; disabledEntries: string[] }> = [];
  harness.deps.applyColdSystemPromptToggles = async (sessionPath, disabledEntries) => {
    writes.push({ sessionPath, disabledEntries: [...disabledEntries] });
  };

  const result = await handleBackendRequest(harness.deps, {
    id: 'system-prompt-toggle-cold',
    method: 'systemPromptToggles.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      disabledEntries: ['skills', 'skills', 'tools'],
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(writes, [{
    sessionPath: '/repo/session.jsonl',
    disabledEntries: ['skills', 'skills', 'tools'],
  }]);
  const opened = harness.emitted.at(-1);
  assert.equal(opened?.event, 'session.opened');
  assert.deepEqual(
    (opened?.payload as { systemPromptDisabledEntries?: string[] }).systemPromptDisabledEntries,
    ['skills', 'tools'],
  );
});

test('settings.set rejects live model switch while a session is busy', async () => {
  for (const busyState of ['activeRequest', 'streaming'] as const) {
    let setModelCalls = 0;
    const harness = createHarness({
      context: busyState === 'activeRequest'
        ? {
          activeRequest: {
            id: 'req-active',
            messageIndex: 0,
            aborted: false,
          },
        }
        : undefined,
      sessionOverrides: {
        ...(busyState === 'streaming' ? { isStreaming: true } : {}),
        setModel: async () => {
          setModelCalls++;
        },
      },
    });

    await assert.rejects(
      async () => await handleBackendRequest(harness.deps, {
        id: `settings-set-${busyState}`,
        method: 'settings.set',
        params: {
          sessionPath: '/repo/session.jsonl',
          defaultModel: 'model-b',
        },
      }),
      (error: unknown) => error instanceof BackendError && error.code === 'REQUEST_IN_PROGRESS',
    );

    assert.equal(setModelCalls, 0);
    assert.equal((harness.context.session.model as { id: string }).id, 'model-a');
    assert.deepEqual(harness.writtenSettings, []);
    assert.deepEqual(harness.emitContextUsageChangedCalls, []);
  }
});

test('settings.set rejects thinking-level changes while a session is busy even when the model is unchanged', async () => {
  for (const busyState of ['activeRequest', 'streaming'] as const) {
    const harness = createHarness({
      context: busyState === 'activeRequest'
        ? {
          activeRequest: {
            id: 'req-active',
            messageIndex: 0,
            aborted: false,
          },
        }
        : undefined,
      sessionOverrides: {
        ...(busyState === 'streaming' ? { isStreaming: true } : {}),
      },
    });

    await assert.rejects(
      async () => await handleBackendRequest(harness.deps, {
        id: `settings-set-same-${busyState}`,
        method: 'settings.set',
        params: {
          sessionPath: '/repo/session.jsonl',
          defaultModel: 'model-a',
          defaultThinkingLevel: 'high',
        },
      }),
      (error: unknown) => error instanceof BackendError && error.code === 'REQUEST_IN_PROGRESS',
    );

    assert.equal((harness.context.session.model as { id: string }).id, 'model-a');
    assert.equal(harness.context.session.thinkingLevel, 'medium');
    assert.deepEqual(harness.writtenSettings, []);
    assert.equal(harness.emitContextUsageChangedCalls.length, 0);
  }
});

test('settings.set rejects thinking-level changes while a session is busy even when the requested model matches the running session model', async () => {
  for (const busyState of ['activeRequest', 'streaming'] as const) {
    let setModelCalls = 0;
    const harness = createHarness({
      modelSettings: { defaultModel: 'model-b', defaultThinkingLevel: 'medium' },
      context: busyState === 'activeRequest'
        ? {
          activeRequest: {
            id: 'req-active',
            messageIndex: 0,
            aborted: false,
          },
        }
        : undefined,
      sessionOverrides: {
        ...(busyState === 'streaming' ? { isStreaming: true } : {}),
        setModel: async () => {
          setModelCalls++;
        },
      },
    });

    await assert.rejects(
      async () => await handleBackendRequest(harness.deps, {
        id: `settings-set-runtime-match-${busyState}`,
        method: 'settings.set',
        params: {
          sessionPath: '/repo/session.jsonl',
          defaultModel: 'model-a',
          defaultThinkingLevel: 'high',
        },
      }),
      (error: unknown) => error instanceof BackendError && error.code === 'REQUEST_IN_PROGRESS',
    );

    assert.equal((harness.context.session.model as { id: string }).id, 'model-a');
    assert.equal(harness.context.session.thinkingLevel, 'medium');
    assert.equal(setModelCalls, 0);
    assert.deepEqual(harness.writtenSettings, []);
    assert.equal(harness.emitContextUsageChangedCalls.length, 0);
  }
});

test('settings.set is a no-op when both model and thinking level already match persisted and runtime state', async () => {
  const harness = createHarness();

  const updated = await handleBackendRequest(harness.deps, {
    id: 'settings-set-noop',
    method: 'settings.set',
    params: {
      sessionPath: '/repo/session.jsonl',
      defaultModel: 'model-a',
      defaultThinkingLevel: 'medium',
    },
  });

  assert.deepEqual(updated, { defaultModel: 'model-a', defaultThinkingLevel: 'medium' });
  assert.deepEqual(harness.writtenSettings, []);
  assert.equal(harness.context.session.thinkingLevel, 'medium');
  assert.equal(harness.emitContextUsageChangedCalls.length, 0);
});

test('handleBackendRequest rejects unknown methods', async () => {
  const harness = createHarness();
  await assert.rejects(
    async () => await handleBackendRequest(harness.deps, { id: '1', method: 'missing.method' }),
    /Unknown method: missing.method/,
  );
});

test('request producer records one ordered route-to-completion trace', async () => {
  const harness = createHarness();
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    await handleBackendRequest(harness.deps, { id: 'trace-request-order', method: 'app.ping' });
    await assert.rejects(handleBackendRequest(harness.deps, {
      id: 'trace-invalid', method: 'session.open', params: {},
    }));
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  // Records are matched by the exact HMAC request identity this test
  // generated, so concurrent trace-producing tests cannot alter the sequence.
  const phases = await readBackendRequestTracePhases(before, ['trace-request-order', 'trace-invalid']);
  // Truthful ordering: route_selected at dispatch selection, request_validated
  // after the handler actually validated its params, handler_started only
  // after validation (execution, not validation, is what it denotes), and
  // exactly one completion per request. The invalid request fails validation,
  // so it records an explicit request_validated failure BEFORE its failure
  // completion and never starts a handler. No handler_queued phase is claimed
  // because there is no general request queue.
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
    'route_selected:transition',
    'request_validated:failure',
    'handler_finished:failure',
  ]);
});

test('unknown methods record no route/start and exactly one failure completion', async () => {
  const harness = createHarness();
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    await assert.rejects(handleBackendRequest(harness.deps, { id: 'trace-unknown', method: 'missing.method' }));
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  const phases = await readBackendRequestTracePhases(before, ['trace-unknown']);
  // No route was selected and no handler ran; the single failure completion
  // is the request's terminal record.
  assert.deepEqual(phases, ['handler_finished:failure']);
});

test('a validated request that fails records request_validated and exactly one failure completion', async () => {
  const harness = createHarness({
    sessionOverrides: { isStreaming: true, steer: async () => { throw new Error('queue failed'); } },
  });
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    await assert.rejects(handleBackendRequest(harness.deps, {
      id: 'trace-validated-failure', method: 'message.send',
      params: { sessionPath: harness.context.sessionPath, text: 'queued', inputs: [], localId: 'local-failed' },
    }), /queue failed/);
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  const phases = await readBackendRequestTracePhases(before, ['trace-validated-failure']);
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:failure',
  ]);
});

test('every registered route records a validation settlement and one completion', async () => {
  const harness = createHarness();
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    for (const method of BACKEND_REQUEST_METHODS) {
      const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
      // Empty params exercise the route's validator; no-param routes settle
      // immediately. The outcome (success or any failure) is irrelevant — the
      // settlement/completion invariant must hold either way.
      await handleBackendRequest(harness.deps, { id: `route-settlement-${method}`, method, params: {} })
        .catch(() => undefined);
      const phases = await readBackendRequestTracePhases(before, [`route-settlement-${method}`]);
      const validated = phases.filter((phase) => phase.startsWith('request_validated:'));
      const finished = phases.filter((phase) => phase.startsWith('handler_finished:'));
      assert.equal(validated.length, 1, `${method} must settle validation exactly once, got ${JSON.stringify(phases)}`);
      assert.equal(finished.length, 1, `${method} must complete exactly once, got ${JSON.stringify(phases)}`);
      assert.equal(phases[0], 'route_selected:transition', `${method} must open with route selection, got ${JSON.stringify(phases)}`);
      if (validated[0] === 'request_validated:success') {
        // Execution is denoted only after validation: handler_started sits
        // between the validation settlement and the completion.
        assert.deepEqual(phases.slice(0, 3), [
          'route_selected:transition',
          'request_validated:success',
          'handler_started:start',
        ], `${method} must start execution after validation, got ${JSON.stringify(phases)}`);
      } else {
        // Invalid params produce an explicit validation failure before the
        // failure completion and never start a handler.
        assert.equal(validated[0], 'request_validated:failure', `${method} got ${JSON.stringify(phases)}`);
        assert.deepEqual(phases, [
          'route_selected:transition',
          'request_validated:failure',
          'handler_finished:failure',
        ], `${method} must record the validation failure before the completion, got ${JSON.stringify(phases)}`);
      }
    }
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('diagnostics.livePipeline.setEnabled notifies the server of the new enablement', async () => {
  const harness = createHarness();
  const changes: boolean[] = [];
  harness.deps.onLivePipelineTraceEnabledChange = (enabled) => changes.push(enabled);
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  try {
    const result = await handleBackendRequest(harness.deps, {
      id: 'trace-toggle-on', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    }) as { enabled: boolean };
    assert.equal(result.enabled, true);
    assert.deepEqual(changes, [true]);
    await handleBackendRequest(harness.deps, {
      id: 'trace-toggle-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    });
    assert.deepEqual(changes, [true, false]);
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('diagnostics.livePipeline.setEnabled rejects non-boolean enabled', async () => {
  const harness = createHarness();
  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'trace-toggle-bad', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: 'yes' },
    }),
    (error: unknown) => error instanceof BackendError && error.code === 'INVALID_PARAMS',
  );
});

test('diagnostics.livePipeline.setEnabled off→on records the full success trace and settles state/callback', async () => {
  const harness = createHarness();
  const changes: boolean[] = [];
  harness.deps.onLivePipelineTraceEnabledChange = (enabled) => changes.push(enabled);
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(false);
  try {
    const result = await handleBackendRequest(harness.deps, {
      id: 'trace-toggle-off-to-on', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    }) as { enabled: boolean; health: { enabled: boolean } };
    assert.equal(result.enabled, true);
    assert.equal(result.health.enabled, true, 'response health must reflect the post-enable state');
    assert.equal(isBackendLivePipelineTraceEnabled(), true, 'store must be enabled after the request settles');
    assert.deepEqual(changes, [true], 'server callback must fire once, in lockstep with the store');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  const phases = await readBackendRequestTracePhases(before, ['trace-toggle-off-to-on']);
  // The enable is applied at the request boundary BEFORE the first trace
  // record, so the enabling request's own prefix is recorded under the new
  // state: one coherent route_selected → request_validated → handler_started
  // → handler_finished success trace.
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
  ]);
});

test('diagnostics.livePipeline.setEnabled on→off records the full success trace and settles state/callback', async () => {
  const harness = createHarness();
  const changes: boolean[] = [];
  harness.deps.onLivePipelineTraceEnabledChange = (enabled) => changes.push(enabled);
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    const result = await handleBackendRequest(harness.deps, {
      id: 'trace-toggle-on-to-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    }) as { enabled: boolean; health: { enabled: boolean } };
    assert.equal(result.enabled, false);
    assert.equal(result.health.enabled, false, 'response health must reflect the post-disable state');
    assert.equal(isBackendLivePipelineTraceEnabled(), false, 'store must be disabled after the request settles');
    assert.deepEqual(changes, [false], 'server callback must fire once, in lockstep with the store');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  const phases = await readBackendRequestTracePhases(before, ['trace-toggle-on-to-off']);
  // The disable is applied at the request boundary AFTER the completion
  // record, so the disabling request's own trace completes under the old
  // (enabled) state: one coherent route_selected → request_validated →
  // handler_started → handler_finished success trace.
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
  ]);
});

test('diagnostics.livePipeline.setEnabled invalid toggle keeps a truthful failure trace and does not mutate enablement', async () => {
  const harness = createHarness();
  const changes: boolean[] = [];
  harness.deps.onLivePipelineTraceEnabledChange = (enabled) => changes.push(enabled);
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  setBackendLivePipelineTraceEnabled(true);
  try {
    await assert.rejects(
      handleBackendRequest(harness.deps, {
        id: 'trace-toggle-invalid', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: 'yes' },
      }),
      (error: unknown) => error instanceof BackendError && error.code === 'INVALID_PARAMS',
    );
    assert.equal(isBackendLivePipelineTraceEnabled(), true, 'invalid toggle must not mutate enablement');
    assert.deepEqual(changes, [], 'invalid toggle must not notify the server');
  } finally {
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
  const phases = await readBackendRequestTracePhases(before, ['trace-toggle-invalid']);
  // The invalid toggle never reaches the boundary application: the failure
  // trace is recorded under the unchanged enablement.
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:failure',
    'handler_finished:failure',
  ]);
});

test('handleBackendRequest unknown method throws BackendError with UNKNOWN_METHOD code', async () => {
  const harness = createHarness();
  try {
    await handleBackendRequest(harness.deps, { id: '1', method: 'missing.method' });
    assert.fail('expected unknown method to throw');
  } catch (error) {
    assert.ok(error instanceof BackendError, 'unknown method should throw a BackendError');
    assert.equal((error as BackendError).code, 'UNKNOWN_METHOD');
  }
});

test('message.send rejects before SDK enqueue when queued correlation capacity is exhausted', async () => {
  const harness = createHarness({
    sessionOverrides: { isStreaming: true },
    context: { queuedLocalIds: Array.from({ length: 256 }, (_, index) => `local-${index}`) },
  });
  await assert.rejects(
    handleBackendRequest(harness.deps, {
      id: 'queue-overflow', method: 'message.send',
      params: { sessionPath: harness.context.sessionPath, text: 'overflow', inputs: [], localId: 'overflow' },
    }),
    (error: unknown) => error instanceof BackendError && error.code === 'QUEUE_CAPACITY_EXCEEDED',
  );
  assert.equal(harness.context.queuedLocalIds?.length, 256);
});

test('message.send registers localId before a synchronous SDK steering delivery can fire', async () => {
  let observedDuringSteer: string[] = [];
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      steer: async () => { observedDuringSteer = [...(harness.context.queuedLocalIds ?? [])]; },
    },
  });
  await handleBackendRequest(harness.deps, {
    id: 'sync-steer', method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: 'queued', inputs: [], localId: 'local-sync' },
  });
  assert.deepEqual(observedDuringSteer, ['local-sync']);
});

test('message.send removes a pre-registered localId when SDK queueing rejects', async () => {
  const harness = createHarness({
    sessionOverrides: { isStreaming: true, steer: async () => { throw new Error('queue failed'); } },
  });
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'failed-steer', method: 'message.send',
    params: { sessionPath: harness.context.sessionPath, text: 'queued', inputs: [], localId: 'local-failed' },
  }), /queue failed/);
  assert.deepEqual(harness.context.queuedLocalIds, []);
});

test('message.send joins and replays one operation without prompting twice', async () => {
  let promptCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = createHarness({
    sessionOverrides: {
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        promptCalls += 1;
        options?.preflightResult?.(true);
        await gate;
      },
    },
  });
  const request = {
    method: 'message.send',
    params: {
      sessionPath: harness.context.sessionPath,
      operationId: 'op-retry', operationAttempt: 1,
      text: 'only once', inputs: [], localId: 'local-retry',
    },
  };
  const first = handleBackendRequest(harness.deps, { id: 'send-1', ...request });
  await Promise.resolve();
  const retry = handleBackendRequest(harness.deps, {
    id: 'send-2', ...request,
    params: { ...request.params, operationAttempt: 2 },
  });
  release();
  const [firstResult, retryResult] = await Promise.all([first, retry]) as Array<{
    requestId?: string; operationId?: string; operationAttempt?: number;
  }>;

  assert.equal(retryResult.requestId, firstResult.requestId);
  assert.equal(firstResult.operationAttempt, 1);
  assert.equal(retryResult.operationAttempt, 2);
  assert.equal(harness.context.activeRequest?.operationAttempt, 2);
  assert.equal(promptCalls, 1);
  const status = await handleBackendRequest(harness.deps, {
    id: 'status-1', method: 'operation.status',
    params: { sessionPath: harness.context.sessionPath, operationId: 'op-retry' },
  });
  assert.equal((status as { state: string }).state, 'accepted');
});

test('message.send rejects changed intent for an existing operationId', async () => {
  let promptCalls = 0;
  const harness = createHarness({
    sessionOverrides: { prompt: async () => { promptCalls += 1; } },
  });
  await handleBackendRequest(harness.deps, {
    id: 'send-original', method: 'message.send', params: {
      sessionPath: harness.context.sessionPath, operationId: 'op-mismatch',
      text: 'original', inputs: [], localId: 'local-original',
    },
  });
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'send-changed', method: 'message.send', params: {
      sessionPath: harness.context.sessionPath, operationId: 'op-mismatch',
      text: 'changed', inputs: [], localId: 'local-original',
    },
  }), (error: unknown) => error instanceof BackendError && error.code === 'OPERATION_INTENT_MISMATCH');
  assert.equal(promptCalls, 1);
});

test('queued message.send operations retain independent identities', async () => {
  const steerCalls: string[] = [];
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      steer: async (text: string) => { steerCalls.push(text); },
    },
  });
  const first = await handleBackendRequest(harness.deps, {
    id: 'queued-1', method: 'message.send', params: {
      sessionPath: harness.context.sessionPath, operationId: 'op-queued-1',
      text: 'first', inputs: [], localId: 'local-1',
    },
  });
  const second = await handleBackendRequest(harness.deps, {
    id: 'queued-2', method: 'message.send', params: {
      sessionPath: harness.context.sessionPath, operationId: 'op-queued-2',
      text: 'second', inputs: [], localId: 'local-2',
    },
  });
  assert.deepEqual(steerCalls, ['first', 'second']);
  assert.equal((first as { operationId?: string }).operationId, 'op-queued-1');
  assert.equal((second as { operationId?: string }).operationId, 'op-queued-2');
  assert.deepEqual(harness.context.queuedOperationIds, ['op-queued-1', 'op-queued-2']);

  await handleBackendRequest(harness.deps, {
    id: 'clear-queued', method: 'message.clearQueue', params: { sessionPath: harness.context.sessionPath },
  });
  assert.deepEqual(
    harness.emitted.filter((entry) => entry.event === 'message.aborted')
      .map((entry) => (entry.payload as { operationId?: string }).operationId),
    ['op-queued-1', 'op-queued-2'],
  );
  for (const operationId of ['op-queued-1', 'op-queued-2']) {
    const status = await handleBackendRequest(harness.deps, {
      id: `status-${operationId}`, method: 'operation.status',
      params: { sessionPath: harness.context.sessionPath, operationId },
    });
    assert.equal((status as { state: string }).state, 'failed');
  }
});

test('message.replaceQueue clears and requeues edited messages in order with stable local ids', async () => {
  const steerCalls: string[] = [];
  let clearCalls = 0;
  let correlationsAtFirstEnqueue: string[] = [];
  const harness = createHarness({
    context: { queuedLocalIds: ['local-1', 'local-2'] },
    sessionOverrides: {
      isStreaming: true,
      clearQueue: () => { clearCalls += 1; return { steering: [], followUp: [] }; },
      steer: async (text: string) => {
        if (steerCalls.length === 0) correlationsAtFirstEnqueue = [...(harness.context.queuedLocalIds ?? [])];
        steerCalls.push(text);
      },
    },
  });
  const result = await handleBackendRequest(harness.deps, {
    id: 'replace-queue', method: 'message.replaceQueue', params: {
      sessionPath: harness.context.sessionPath,
      messages: [
        { localId: 'local-1', text: 'edited', inputs: [] },
        { localId: 'local-2', text: 'second', inputs: [] },
      ],
      fallbackMessages: [
        { localId: 'local-1', text: 'first', inputs: [] },
        { localId: 'local-2', text: 'second', inputs: [] },
      ],
    },
  });
  assert.deepEqual(result, { updated: true, count: 2 });
  assert.equal(clearCalls, 1);
  assert.deepEqual(steerCalls, ['edited', 'second']);
  assert.deepEqual(correlationsAtFirstEnqueue, ['local-1', 'local-2']);
  assert.deepEqual(harness.context.queuedLocalIds, ['local-1', 'local-2']);
});

test('message.replaceQueue refuses a stale host queue after delivery consumed an item', async () => {
  let clearCalls = 0;
  const steerCalls: string[] = [];
  const harness = createHarness({
    // local-1 has already crossed the SDK delivery boundary; the host has not
    // received queuedDelivered yet and still submits both rows.
    context: { queuedLocalIds: ['local-2'] },
    sessionOverrides: {
      isStreaming: true,
      clearQueue: () => { clearCalls += 1; return { steering: [], followUp: [] }; },
      steer: async (text: string) => { steerCalls.push(text); },
    },
  });

  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'replace-stale-queue', method: 'message.replaceQueue', params: {
      sessionPath: harness.context.sessionPath,
      messages: [
        { localId: 'local-1', text: 'edited first', inputs: [] },
        { localId: 'local-2', text: 'second', inputs: [] },
      ],
      fallbackMessages: [
        { localId: 'local-1', text: 'first', inputs: [] },
        { localId: 'local-2', text: 'second', inputs: [] },
      ],
    },
  }), /QUEUE_CHANGED/);
  assert.equal(clearCalls, 0, 'the authoritative remaining queue is untouched');
  assert.deepEqual(steerCalls, []);
  assert.deepEqual(harness.context.queuedLocalIds, ['local-2']);
});

test('message.replaceQueue restores the original queue when replacement fails', async () => {
  const steerCalls: string[] = [];
  let clearCalls = 0;
  let failEdited = true;
  const harness = createHarness({
    context: { queuedLocalIds: ['local-1'] },
    sessionOverrides: {
      isStreaming: true,
      clearQueue: () => { clearCalls += 1; return { steering: [], followUp: [] }; },
      steer: async (text: string) => {
        steerCalls.push(text);
        if (text === 'edited' && failEdited) { failEdited = false; throw new Error('replace failed'); }
      },
    },
  });
  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'replace-queue-fail', method: 'message.replaceQueue', params: {
      sessionPath: harness.context.sessionPath,
      messages: [{ localId: 'local-1', text: 'edited', inputs: [] }],
      fallbackMessages: [{ localId: 'local-1', text: 'first', inputs: [] }],
    },
  }), /replace failed/);
  assert.equal(clearCalls, 2);
  assert.deepEqual(steerCalls, ['edited', 'first']);
  assert.deepEqual(harness.context.queuedLocalIds, ['local-1']);
});

test('message.replaceQueue clears correlations when replacement and fallback both fail', async () => {
  const harness = createHarness({
    context: { queuedLocalIds: ['local-1'] },
    sessionOverrides: {
      isStreaming: true,
      steer: async () => { throw new Error('always fails'); },
    },
  });
  const result = await handleBackendRequest(harness.deps, {
    id: 'replace-queue-double-fail', method: 'message.replaceQueue', params: {
      sessionPath: harness.context.sessionPath,
      messages: [{ localId: 'local-1', text: 'edited', inputs: [] }],
      fallbackMessages: [{ localId: 'local-1', text: 'first', inputs: [] }],
    },
  }) as { updated: boolean; queueCleared?: boolean };
  assert.equal(result.updated, false);
  assert.equal(result.queueCleared, true);
  assert.deepEqual(harness.context.queuedLocalIds, []);
});

test('message.send while busy queues as a steering injection and acks { queued: true }', async () => {
  const steerCalls: string[] = [];
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      steer: async (text: string) => { steerCalls.push(text); },
    },
  });
  const result = await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Hi', inputs: [] },
  });
  assert.equal((result as { queued?: boolean }).queued, true);
  assert.ok(!(result as { requestId?: string }).requestId, 'queued send must not start a turn / mint a requestId');
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0], 'Hi');
  // No activeRequest is created for a queued send (the turn is not started).
  assert.equal(harness.context.activeRequest, undefined);
});

test('message.send during preflight queues a follow-up instead of collapsing it into the first model turn', async () => {
  const steerCalls: string[] = [];
  const followUpCalls: string[] = [];
  const harness = createHarness({
    context: { activeRequest: { id: 'request-preflight', messageIndex: 0, aborted: false } },
    sessionOverrides: {
      isStreaming: false,
      steer: async (text: string) => { steerCalls.push(text); },
      followUp: async (text: string) => { followUpCalls.push(text); },
    },
  });
  const result = await handleBackendRequest(harness.deps, {
    id: 'preflight-follow-up',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'After the first answer', inputs: [] },
  });
  assert.equal((result as { queued?: boolean }).queued, true);
  assert.deepEqual(followUpCalls, ['After the first answer']);
  assert.deepEqual(steerCalls, []);
  assert.equal(harness.context.activeRequest?.id, 'request-preflight');
});

test('session.truncateAfter re-applies the user\'s model when the truncate dropped its model_change entry', async () => {
  await withTempDir(async (dir) => {
    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep-1', message: 'keep' }),
      JSON.stringify({ id: 'stop-here', message: 'stop' }),
      // A model_change appended AFTER the edited message (the user set the
      // model after this message existed). truncateAfter drops everything
      // from 'stop-here' onward, so this entry is lost and the reopened
      // session would revert to the previous model.
      JSON.stringify({ id: 'mc-1', type: 'model_change', provider: 'mock', modelId: 'model-b' }),
    ].join('\n') + '\n', 'utf8');

    // Existing context: the user's chosen model (model-b) + thinking level.
    const existingSession = {
      isStreaming: false,
      model: { id: 'model-b' },
      thinkingLevel: 'high',
      setModel: async () => undefined,
      setThinkingLevel: (_level: string) => undefined,
    } as unknown as SessionContext['session'];
    const existingContext: SessionContext = {
      runtime: { session: existingSession, dispose: async () => undefined, services: { modelRegistry: { getAvailable: () => [], find: () => undefined } } } as SessionContext['runtime'],
      session: existingSession,
      sessionPath,
      unsubscribe: () => undefined,
      busySeq: 0,
    };

    // Reopened context: the SDK resolved the model from the surviving entries
    // only (model-a, the pre-switch model) — the bug. setModel/setThinkingLevel
    // spies record the re-application.
    const reopenedSetModelCalls: { id: string }[] = [];
    const reopenedSetThinkingLevelCalls: string[] = [];
    const reopenedSession = {
      isStreaming: false,
      model: { id: 'model-a' },
      thinkingLevel: 'medium',
      setModel: async (model: { id: string }) => {
        reopenedSetModelCalls.push({ id: model.id });
        (reopenedSession.model as { id: string }).id = model.id;
      },
      setThinkingLevel: (level: string) => {
        reopenedSetThinkingLevelCalls.push(level);
        (reopenedSession as { thinkingLevel: string }).thinkingLevel = level;
      },
    } as unknown as SessionContext['session'];
    const reopenedContext: SessionContext = {
      runtime: { session: reopenedSession, dispose: async () => undefined, services: { modelRegistry: { getAvailable: () => [
        { id: 'model-b', name: 'Model B', provider: 'mock', reasoning: false, input: ['text', 'image'] },
      ], find: (_p: string, id: string) => ({ id }) } } } as SessionContext['runtime'],
      session: reopenedSession,
      sessionPath,
      unsubscribe: () => undefined,
      busySeq: 0,
    };

    const emitted: Array<{ event: string; payload?: unknown }> = [];
    const deps: BackendRequestHandlerDeps = {
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/startup',
      sdk: { VERSION: '1.0.0', SessionManager: { open: (p: string) => ({ cwd: '/repo', sessionPath: p } as any), listAll: async () => [], continueRecent: (cwd: string) => ({ cwd } as any), create: (cwd: string) => ({ cwd } as any) } } as any,
      getSessionContext: () => existingContext,
      async createSessionContext(_manager, _reason) { return reopenedContext; },
      async ensureSessionContext(p) { assert.equal(p, sessionPath); return reopenedContext; },
      setViewedSessionPath: () => undefined,
      async buildSessionOpenedPayload(p) { return { sessionPath: p, session: { path: p, modelId: reopenedSession.model?.id, thinkingLevel: reopenedSession.thinkingLevel } } as any; },
      async applySystemPromptToggles() { /* no-op */ },
      setAutonomousMode: () => undefined,
      async loadTranscriptPage() { return {} as any; },
      emit: (event, payload) => emitted.push({ event, payload }),
      emitBusyChanged: () => undefined,
      emitContextUsageChanged: () => undefined,
      async emitSessionListChanged() { emitted.push({ event: 'session.list.changed' }); },
      async listSessions() { return []; },
      listAvailableModels: () => [],
      async readModelSettings() { return { defaultModel: 'model-b', defaultThinkingLevel: 'high' }; },
      async writeModelSettings(u) { return { defaultModel: '', defaultThinkingLevel: 'medium', ...u }; },
    };

    const result = await handleBackendRequest(deps, {
      id: '1',
      method: 'session.truncateAfter',
      params: { sessionPath, entryId: 'stop-here' },
    });

    // The fresh context's model + thinking level are restored to the user's
    // pre-truncate choice, so the edit turn runs on model-b/high, not the
    // reverted model-a/medium.
    assert.deepEqual(reopenedSetModelCalls, [{ id: 'model-b' }],
      'setModel must be re-applied with the user\'s pre-truncate model');
    assert.deepEqual(reopenedSetThinkingLevelCalls, ['high'],
      'setThinkingLevel must be restored after setModel re-clamps');
    assert.equal(reopenedSession.model?.id, 'model-b');
    assert.equal(reopenedSession.thinkingLevel, 'high');
    // The authoritative session.opened event reflects the restored model; the
    // correlated truncate result is intentionally only an acknowledgement.
    assert.deepEqual(result, { ok: true, sessionPath });
    const opened = emitted.find((entry) => entry.event === 'session.opened');
    assert.equal((opened?.payload as { session?: { modelId?: string } }).session?.modelId, 'model-b');
    // The file was still rewritten (the model_change entry is dropped from
    // disk; the in-memory re-apply is what restores the choice).
    const rewritten = await fs.readFile(sessionPath, 'utf8');
    assert.equal(rewritten, `${JSON.stringify({ id: 'keep-1', message: 'keep' })}\n`);
  });
});

test('cold session.truncateAfter emits a runtime-free authoritative snapshot', async () => {
  await withTempDir(async (dir) => {
    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep', type: 'message' }),
      JSON.stringify({ id: 'stop', type: 'message' }),
    ].join('\n') + '\n');
    const harness = createHarness();
    harness.deps.getSessionContext = () => undefined;
    let truncateCalls = 0;
    harness.deps.truncateColdSessionAfter = async (openedPath, entryId) => {
      truncateCalls += 1;
      assert.equal(openedPath, sessionPath);
      assert.equal(entryId, 'stop');
      return { sessionPath: openedPath };
    };
    harness.deps.buildSessionOpenedPayload = async (openedPath) => ({
      session: { path: openedPath }, runtimeReady: false, busy: false,
    } as any);

    await handleBackendRequest(harness.deps, {
      id: 'truncate-cold-model', method: 'session.truncateAfter', params: { sessionPath, entryId: 'stop' },
    });

    assert.equal(truncateCalls, 1);
    assert.equal(harness.createCalls.length, 0);
    const opened = harness.emitted.find((event) => event.event === 'session.opened');
    assert.equal((opened?.payload as { runtimeReady?: boolean }).runtimeReady, false);
  });
});

test('session.truncateAfter leaves the model untouched when the new context already matches', async () => {
  await withTempDir(async (dir) => {
    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep-1', message: 'keep' }),
      JSON.stringify({ id: 'stop-here', message: 'stop' }),
    ].join('\n') + '\n', 'utf8');

    const setModelCalls: { id: string }[] = [];
    const setThinkingLevelCalls: string[] = [];
    const session = {
      isStreaming: false,
      model: { id: 'model-a' },
      thinkingLevel: 'medium',
      setModel: async (m: { id: string }) => { setModelCalls.push(m); },
      setThinkingLevel: (l: string) => { setThinkingLevelCalls.push(l); },
    } as unknown as SessionContext['session'];
    const context: SessionContext = {
      runtime: { session, dispose: async () => undefined, services: { modelRegistry: { getAvailable: () => [], find: () => undefined } } } as SessionContext['runtime'],
      session, sessionPath, unsubscribe: () => undefined, busySeq: 0,
    };
    const deps: BackendRequestHandlerDeps = {
      sdkPath: '/sdk', agentDir: '/agent', startupCwd: '/startup',
      sdk: { VERSION: '1.0.0', SessionManager: { open: (p: string) => ({ cwd: '/repo', sessionPath: p } as any), listAll: async () => [], continueRecent: (cwd: string) => ({ cwd } as any), create: (cwd: string) => ({ cwd } as any) } } as any,
      getSessionContext: () => context,
      async createSessionContext(_m, _r) { return context; },
      async ensureSessionContext(p) { assert.equal(p, sessionPath); return context; },
      setViewedSessionPath: () => undefined,
      async buildSessionOpenedPayload(p) { return { sessionPath: p } as any; },
      async applySystemPromptToggles() { /* no-op */ },
      setAutonomousMode: () => undefined,
      async loadTranscriptPage() { return {} as any; },
      emit: () => undefined,
      emitBusyChanged: () => undefined,
      emitContextUsageChanged: () => undefined,
      async emitSessionListChanged() { /* no-op */ },
      async listSessions() { return []; },
      listAvailableModels: () => [],
      async readModelSettings() { return { defaultModel: 'model-a', defaultThinkingLevel: 'medium' }; },
      async writeModelSettings(u) { return { defaultModel: '', defaultThinkingLevel: 'medium', ...u }; },
    };

    await handleBackendRequest(deps, {
      id: '1', method: 'session.truncateAfter',
      params: { sessionPath, entryId: 'stop-here' },
    });

    assert.deepEqual(setModelCalls, [], 'setModel must not be called when the model already matches');
    assert.deepEqual(setThinkingLevelCalls, [], 'setThinkingLevel must not be called when the level already matches');
  });
});

test('liveTurn.checkpoint returns active and terminal-grace in-memory authority', async () => {
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 7, sessionPath: '/repo/session.jsonl', requestId: 'request-live',
    turnId: 'turn-live', attemptId: 'attempt-live', canonicalMessageId: 'message-live', startedAt: 100,
  });
  accumulator.observe({ kind: 'turn.started' }, 100);
  const harness = createHarness({
    context: { activeRequest: { id: 'request-live', messageIndex: 0, aborted: false, liveTurnAccumulator: accumulator } },
  });
  const active = await handleBackendRequest(harness.deps, {
    id: 'checkpoint-active', method: 'liveTurn.checkpoint', params: { sessionPath: harness.context.sessionPath },
  }) as any;
  assert.equal(active.status, 'active');
  assert.equal(active.checkpoint.checkpointSeq, 1);

  const nextAccumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 7, sessionPath: '/repo/session.jsonl', requestId: 'request-live',
    turnId: 'turn-next', attemptId: 'attempt-next', canonicalMessageId: 'message-next', startedAt: 200,
  });
  nextAccumulator.observe({ kind: 'turn.started' }, 200);
  harness.context.activeRequest = {
    id: 'request-live', messageIndex: 1, aborted: false, liveTurnAccumulator: nextAccumulator,
  };
  harness.context.terminalLiveTurn = { accumulator, expiresAt: Date.now() + 1_000 };
  const terminal = await handleBackendRequest(harness.deps, {
    id: 'checkpoint-terminal', method: 'liveTurn.checkpoint',
    params: {
      sessionPath: harness.context.sessionPath,
      turnId: 'turn-live',
      attemptId: 'attempt-live',
    },
  }) as any;
  assert.equal(terminal.status, 'terminal_grace');
  assert.equal(terminal.checkpoint.turnId, 'turn-live');

  const next = await handleBackendRequest(harness.deps, {
    id: 'checkpoint-next', method: 'liveTurn.checkpoint',
    params: {
      sessionPath: harness.context.sessionPath,
      turnId: 'turn-next',
      attemptId: 'attempt-next',
    },
  }) as any;
  assert.equal(next.status, 'active');
  assert.equal(next.checkpoint.turnId, 'turn-next');
});

test('extension_ui.response rejects expired ownership instead of acknowledging a no-op', async () => {
  const requests: Array<{ id: string }> = [];
  const harness = createHarness();
  const bridge = new ExtensionUIBridge(harness.context.sessionPath, (_event, payload) => requests.push(payload));
  harness.context.uiBridge = bridge;
  const pending = bridge.confirm('Confirm', 'Continue?');
  const id = requests[0]!.id;

  await assert.rejects(handleBackendRequest(harness.deps, {
    id: 'expired-ui', method: 'extension_ui.response',
    params: { sessionPath: harness.context.sessionPath, response: { id: 'expired', confirmed: true } },
  }), (error: unknown) => error instanceof BackendError && error.code === 'UI_REQUEST_NOT_PENDING');

  await handleBackendRequest(harness.deps, {
    id: 'valid-ui', method: 'extension_ui.response',
    params: { sessionPath: harness.context.sessionPath, response: { id, confirmed: true } },
  });
  assert.equal(await pending, true);
});

test('provider_gate.metrics reports disabled shape when the ProviderGate is not installed', async (t) => {
  ProviderGate.uninstall();
  t.after(() => ProviderGate.uninstall());

  const result = await handleBackendRequest({} as any, {
    id: 'test-provider-gate-metrics-empty',
    method: 'provider_gate.metrics',
    params: undefined,
  });

  assert.deepEqual(result, { enabled: false, providers: [] });
});

test('provider_gate.metrics returns live ProviderGate metrics when installed', async (t) => {
  ProviderGate.uninstall();
  t.after(() => ProviderGate.uninstall());
  ProviderGate.install([{
    provider: 'openai',
    baseUrl: 'https://api.openai.test/v1',
    maxConcurrentRequests: 2,
    afterburnSeconds: 5,
    queueWaitSeconds: 30,
    headerWaitSeconds: 120,
  }]);

  const result = await handleBackendRequest({} as any, {
    id: 'test-provider-gate-metrics-live',
    method: 'provider_gate.metrics',
    params: undefined,
  });

  assert.deepEqual(result, {
    enabled: true,
    providers: [{
      provider: 'openai',
      activeRequests: 0,
      queuedRequests: 0,
      maxConcurrentRequests: 2,
      afterburnSeconds: 5,
      queueWaitSeconds: 30,
      paused: false,
      pausedUntilMs: 0,
      strikeCount: 0,
    }],
  });
});
