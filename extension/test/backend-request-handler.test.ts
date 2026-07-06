import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../src/backend/request-handler';
import { handleSdkSessionEvent } from '../src/backend/session-event-handler';
import { BackendError } from '../src/backend/server-io';
import type { ModelSettings } from '../src/shared/protocol';
import type { SessionContext } from '../src/backend/server-types';
import type { SdkSessionEvent } from '../src/backend/sdk';

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
  const appliedToggles: Array<{ sessionPath: string; disabledEntries: string[] }> = [];
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
    followUp: async (_text: string, _images?: unknown) => undefined,
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
    setViewedSessionPath(sessionPath) {
      viewedSessionPath = sessionPath;
    },
    async buildSessionOpenedPayload(sessionPath, selectionToken) {
      return { sessionPath, selectionToken } as any;
    },
    async applySystemPromptToggles(sessionPath, disabledEntries) {
      appliedToggles.push({ sessionPath, disabledEntries: [...disabledEntries] });
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

  // Steering (FollowUp): a second send while a turn is already in-flight is
  // now QUEUED as a follow-up (SDK `followUp()`) instead of rejected. The
  // backend acks `{ queued: true }` with no new `activeRequest` (no turn is
  // started by the enqueue) and no `requestId`.
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

test('message.interrupt defensively clears a stuck activeRequest when abort settles and streaming has stopped', async () => {
  // Reproduces the stuck-session bug: the SDK never fires `turn_end` (e.g. a
  // hung provider connection), so `activeRequest` would stay set forever and
  // block sends + live model switches. The interrupt's `.finally` clears it
  // once the abort promise settles AND the session has actually stopped
  // streaming, never clobbering a still-streaming turn.
  let abortResolve: (() => void) | undefined;
  const harness = createHarness({
    context: {
      activeRequest: { id: 'req-stuck', messageIndex: 0, aborted: false },
    },
    sessionOverrides: {
      isStreaming: true,
      abort: () => new Promise<void>((resolve) => { abortResolve = resolve; }),
    },
  });

  const interrupted = await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(interrupted, { interrupted: true });
  assert.equal(harness.context.activeRequest?.aborted, true);

  // Simulate the provider tearing down the stream after abort resolves.
  (harness.context.session as unknown as { isStreaming: boolean }).isStreaming = false;
  abortResolve!();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The defensive clear fired: activeRequest is gone and busy=false emitted.
  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(harness.busyEvents.at(-1), false);

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

test('message.interrupt defensive clear does not clobber a still-streaming turn when abort resolves but streaming continues', async () => {
  // abort() resolved but the session is still streaming (abort couldn't stop
  // it). The defensive clear must NOT touch activeRequest — the session-event
  // handler's own `turn_end` clear still owns that path.
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

  await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });

  // Streaming continues after abort resolves.
  abortResolve!();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // activeRequest is preserved (turn_end will clear it later).
  assert.equal(harness.context.activeRequest?.id, 'req-streaming');
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

test('message.send while busy queues as a follow-up (steering) and acks { queued: true }', async () => {
  const followUpCalls: string[] = [];
  const harness = createHarness({
    sessionOverrides: {
      isStreaming: true,
      followUp: async (text: string) => { followUpCalls.push(text); },
    },
  });
  const result = await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.send',
    params: { sessionPath: '/repo/session.jsonl', text: 'Hi', inputs: [] },
  });
  assert.equal((result as { queued?: boolean }).queued, true);
  assert.ok(!(result as { requestId?: string }).requestId, 'queued send must not start a turn / mint a requestId');
  assert.equal(followUpCalls.length, 1);
  assert.equal(followUpCalls[0], 'Hi');
  // No activeRequest is created for a queued send (the turn is not started).
  assert.equal(harness.context.activeRequest, undefined);
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
    // The session.opened payload reflects the restored model.
    assert.equal((result as { session?: { modelId?: string } }).session?.modelId, 'model-b');
    // The file was still rewritten (the model_change entry is dropped from
    // disk; the in-memory re-apply is what restores the choice).
    const rewritten = await fs.readFile(sessionPath, 'utf8');
    assert.equal(rewritten, `${JSON.stringify({ id: 'keep-1', message: 'keep' })}\n`);
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
