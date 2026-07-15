import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../../../src/backend/request-handler';
import { handleSdkSessionEvent, type BackendSessionEventHandlerDeps } from '../../../src/backend/session-event-handler';
import { BackendError } from '../../../src/backend/server-io';
import type { ModelSettings } from '../../../src/shared/protocol';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkSessionEvent } from '../../../src/backend/sdk';
import { ProviderGate } from '../../../src/backend/provider-gate';
import { BackendLiveTurnAccumulator } from '../../../src/backend/live-turn-accumulator';
import { ExtensionUIBridge } from '../../../src/backend/extension-ui-bridge';

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
  assert.equal(acceptedHarness.context.activeRequest?.liveTurnAccumulator?.checkpoint().protocolVersion, 5);
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
      activeRequest: { id: 'req-stuck', messageIndex: 0, aborted: false },
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

  const interruptPromise = handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });

  // Streaming continues after abort resolves.
  abortResolve!();
  assert.deepEqual(await interruptPromise, { interrupted: true, settled: true });

  // activeRequest is preserved (turn_end will clear it later).
  assert.equal(harness.context.activeRequest?.id, 'req-streaming');
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
      abortCompaction: () => { aborted.compaction = true; },
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
  // compaction bills; compaction_end restores idle. session_finished deferred
  // triggers already fired at agent_end — the compaction_end re-fire is a
  // no-op (DeferredTriggerRegistry.fire is idempotent once consumed).
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
    // The rollback restores defaultModel + defaultThinkingLevel and explicitly
    // resets defaultProvider (to undefined here, since the previous settings
    // had none) so a provider added by the failed switch is dropped from the
    // merge-persisted settings.json.
    { defaultModel: 'model-a', defaultThinkingLevel: 'medium', defaultProvider: undefined },
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

test('liveTurn.checkpoint returns active and terminal-grace in-memory authority', async () => {
  const accumulator = new BackendLiveTurnAccumulator({
    protocolVersion: 5, sessionPath: '/repo/session.jsonl', requestId: 'request-live',
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

  harness.context.activeRequest = undefined;
  harness.context.terminalLiveTurn = { accumulator, expiresAt: Date.now() + 1_000 };
  const terminal = await handleBackendRequest(harness.deps, {
    id: 'checkpoint-terminal', method: 'liveTurn.checkpoint', params: { sessionPath: harness.context.sessionPath },
  }) as any;
  assert.equal(terminal.status, 'terminal_grace');
  assert.equal(terminal.checkpoint.turnId, 'turn-live');
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
      paused: false,
      pausedUntilMs: 0,
      strikeCount: 0,
    }],
  });
});
