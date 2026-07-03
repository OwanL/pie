import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../src/backend/request-handler';
import { BackendError } from '../src/backend/server-io';
import type { ModelSettings } from '../src/shared/protocol';
import type { SessionContext } from '../src/backend/server-types';

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
  const emitContextUsageChangedCalls: SessionContext[] = [];
  let viewedSessionPath: string | undefined;
  const modelSettings = overrides.modelSettings ?? { defaultModel: 'model-a', defaultThinkingLevel: 'medium' };

  const session = {
    isStreaming: false,
    model: { id: 'model-a' },
    thinkingLevel: 'medium',
    prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
    },
    abort: async () => undefined,
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
    setViewedSessionPath(sessionPath) {
      viewedSessionPath = sessionPath;
    },
    async buildSessionOpenedPayload(sessionPath, selectionToken) {
      return { sessionPath, selectionToken } as any;
    },
    async loadTranscriptPage(sessionPath, direction, loadedStart, loadedEnd) {
      return { sessionPath, direction, loadedStart, loadedEnd } as any;
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
    protocolVersion: 10,
  });

  const listed = await handleBackendRequest(harness.deps, { id: '2', method: 'session.list' });
  assert.equal((listed as any)[0].path, '/repo/session.jsonl');

  const created = await handleBackendRequest(harness.deps, {
    id: '3',
    method: 'session.create',
    params: { cwd: '/custom', selectionToken: 'sel-1' },
  });
  assert.deepEqual(created, { sessionPath: '/repo/session.jsonl', selectionToken: 'sel-1' });
  assert.equal(harness.viewedSessionPath, '/repo/session.jsonl');
  assert.deepEqual(harness.createCalls[0], { cwd: '/custom', reason: 'new' });
  assert.deepEqual(harness.busyEvents, [false]);
  assert.deepEqual(harness.emitted.slice(0, 2), [
    { event: 'session.opened', payload: { sessionPath: '/repo/session.jsonl', selectionToken: 'sel-1' } },
    { event: 'session.list.changed' },
  ]);

  const opened = await handleBackendRequest(harness.deps, {
    id: '4',
    method: 'session.open',
    params: { sessionPath: '/repo/session.jsonl', selectionToken: 'sel-2' },
  });
  assert.deepEqual(opened, { sessionPath: '/repo/session.jsonl', selectionToken: 'sel-2' });

  const preloaded = await handleBackendRequest(harness.deps, {
    id: '5',
    method: 'session.preload',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(preloaded, { sessionPath: '/repo/session.jsonl', selectionToken: undefined });

  const page = await handleBackendRequest(harness.deps, {
    id: '6',
    method: 'session.loadTranscriptPage',
    params: { sessionPath: '/repo/session.jsonl', direction: 'older', loadedStart: 1, loadedEnd: 2 },
  });
  assert.deepEqual(page, {
    sessionPath: '/repo/session.jsonl',
    direction: 'older',
    loadedStart: 1,
    loadedEnd: 2,
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

  await assert.rejects(
    async () => await handleBackendRequest(acceptedHarness.deps, {
      id: '2',
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'Hello again', inputs: [] },
    }),
    /already in progress/,
  );

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
  await assert.rejects(
    async () => await handleBackendRequest(idleHarness.deps, {
      id: '2',
      method: 'message.interrupt',
      params: { sessionPath: '/repo/session.jsonl' },
    }),
    /Cannot interrupt a session that is not running/,
  );

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
  const interrupted = await handleBackendRequest(activeHarness.deps, {
    id: '3',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(interrupted, { interrupted: true });
  assert.equal(activeHarness.context.activeRequest?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(activeHarness.emitted.at(-1), {
    event: 'error',
    payload: {
      code: 'MESSAGE_INTERRUPT_FAILED',
      message: 'abort failed',
      requestId: 'req-1',
    },
  });
});

test('session.truncateAfter rewrites the file and recreates the session context', async () => {
  await withTempDir(async (dir) => {
    const sessionPath = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionPath, [
      JSON.stringify({ id: 'keep-1', message: 'keep' }),
      '{bad json}',
      JSON.stringify({ id: 'stop-here', message: 'stop' }),
      JSON.stringify({ id: 'after-stop', message: 'drop' }),
    ].join('\n') + '\n', 'utf8');

    const harness = createHarness();
    const reopenedContext = { ...harness.context, sessionPath };
    harness.context.sessionPath = sessionPath;
    harness.deps.getSessionContext = () => undefined;
    harness.deps.sdk.SessionManager.open = (openedPath: string) => {
      harness.openCalls.push(openedPath);
      return { cwd: '/repo', sessionPath: openedPath } as any;
    };
    harness.deps.createSessionContext = async (_manager, reason) => {
      harness.createCalls.push({ cwd: '/repo', reason });
      return reopenedContext;
    };
    harness.deps.buildSessionOpenedPayload = async (openedPath) => ({ sessionPath: openedPath } as any);

    const result = await handleBackendRequest(harness.deps, {
      id: '1',
      method: 'session.truncateAfter',
      params: { sessionPath, entryId: 'stop-here' },
    });

    assert.deepEqual(result, { sessionPath });
    assert.deepEqual(harness.openCalls, [sessionPath]);
    assert.deepEqual(harness.createCalls.at(-1), { cwd: '/repo', reason: 'resume' });
    const rewritten = await fs.readFile(sessionPath, 'utf8');
    assert.equal(rewritten, `${JSON.stringify({ id: 'keep-1', message: 'keep' })}\n`);
    assert.deepEqual(harness.emitted.at(-2), { event: 'session.opened', payload: { sessionPath } });
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
    { defaultModel: 'model-a', defaultThinkingLevel: 'medium' },
  ]);
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

test('settings.set does not reject when defaultModel is unchanged while a session is busy', async () => {
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

    const updated = await handleBackendRequest(harness.deps, {
      id: `settings-set-same-${busyState}`,
      method: 'settings.set',
      params: {
        sessionPath: '/repo/session.jsonl',
        defaultModel: 'model-a',
        defaultThinkingLevel: 'high',
      },
    });

    assert.deepEqual(updated, { defaultModel: 'model-a', defaultThinkingLevel: 'high' });
    assert.equal((harness.context.session.model as { id: string }).id, 'model-a');
    assert.equal(harness.context.session.thinkingLevel, 'high');
    assert.deepEqual(harness.writtenSettings, [{ defaultModel: 'model-a', defaultThinkingLevel: 'high' }]);
    assert.equal(harness.emitContextUsageChangedCalls.length, 1);
  }
});

test('settings.set does not reject when requested model matches the running session model while a session is busy', async () => {
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

    const updated = await handleBackendRequest(harness.deps, {
      id: `settings-set-runtime-match-${busyState}`,
      method: 'settings.set',
      params: {
        sessionPath: '/repo/session.jsonl',
        defaultModel: 'model-a',
        defaultThinkingLevel: 'high',
      },
    });

    assert.deepEqual(updated, { defaultModel: 'model-a', defaultThinkingLevel: 'high' });
    assert.equal((harness.context.session.model as { id: string }).id, 'model-a');
    assert.equal(harness.context.session.thinkingLevel, 'high');
    assert.equal(setModelCalls, 0);
    assert.deepEqual(harness.writtenSettings, [{ defaultModel: 'model-a', defaultThinkingLevel: 'high' }]);
    assert.equal(harness.emitContextUsageChangedCalls.length, 1);
  }
});

test('handleBackendRequest rejects unknown methods', async () => {
  const harness = createHarness();
  await assert.rejects(
    async () => await handleBackendRequest(harness.deps, { id: '1', method: 'missing.method' }),
    /Unknown method: missing.method/,
  );
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

test('message.send while busy throws BackendError with REQUEST_IN_PROGRESS code', async () => {
  const harness = createHarness({
    sessionOverrides: { isStreaming: true },
  });
  try {
    await handleBackendRequest(harness.deps, {
      id: '1',
      method: 'message.send',
      params: { sessionPath: '/repo/session.jsonl', text: 'Hi', inputs: [] },
    });
    assert.fail('expected busy send to throw');
  } catch (error) {
    assert.ok(error instanceof BackendError, 'busy send should throw a BackendError');
    assert.equal((error as BackendError).code, 'REQUEST_IN_PROGRESS');
  }
});
