/**
 * Phase 1 red-test battery — backend interrupt / proxy / retry hardening (pie).
 *
 * These pin the three suspected pie backend lifecycle bugs surfaced by recent
 * provider-side instability:
 *
 *  Bug 4 — handleMessageInterrupt: `void context.session.abort()` is un-awaited
 *          and un-bounded. If `session.abort()` NEVER settles (a hung provider
 *          connection teardown), the `.finally` backstop never fires →
 *          `activeRequest` is NEVER cleared → session permanently blocked from
 *          sending or live-switching models. NO bound on the abort promise.
 *          (request-handler.ts handleMessageInterrupt, the `void
 *          context.session.abort().catch(...).finally(...)` block.)
 *
 *  Bug 5 — Proxy restart mid-stream: `ProxyService.restart()` does
 *          `await this.stop()` (kills the litellm tree) then `start()` with NO
 *          check for in-flight streaming sessions through the proxy. A
 *          `settings.set` carrying a proxy field triggers
 *          `regenerateProxyConfigAndRestart` → kills the proxy mid-stream →
 *          in-flight proxied turn gets a random connection error. No structured
 *          notice, no drain. (proxy-service.ts restart + service.ts
 *          regenerateProxyConfigAndRestart.)
 *
 *  Bug 6 — `willRetry:true` hang: on `agent_end willRetry`, the handler returns
 *          early (correct — don't finalize mid-retry). The SDK then sleeps
 *          `delayMs` and retries. If that backoff/retry never completes (the
 *          SDK's retry turn hangs — e.g. provider dies mid-backoff, or an
 *          extension hook blocks the retry), `activeRequest` stays set forever
 *          with NO bound on the willRetry window.
 *          (session-event-handler.ts `agent_end` case, the `if (event.willRetry)
 *          return;` branch.)
 *
 * Approach: extends the existing `backend-request-handler.test.ts` harness
 * pattern (hand-built `createHarness()` that injects a mock session), so the
 * interrupt test uses the SAME `handleBackendRequest` entry point as the
 * shipped interrupt tests. The proxy + willRetry tests use the real
 * `ProxyService` class and the real `handleSdkSessionEvent` respectively,
 * mocking only the boundaries (the proxy subprocess and the session state).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../src/backend/request-handler';
import type { ModelSettings } from '../src/shared/protocol';
import type { SessionContext } from '../src/backend/server-types';

// ===========================================================================
// Shared harness (mirrors backend-request-handler.test.ts createHarness)
// ===========================================================================

interface Harness {
  deps: BackendRequestHandlerDeps;
  context: SessionContext;
  emitted: Array<{ event: string; payload?: unknown }>;
  busyEvents: boolean[];
}

function createHarness(overrides: {
  context?: Partial<SessionContext>;
  sessionOverrides?: Record<string, unknown>;
  modelSettings?: ModelSettings;
} = {}): Harness {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const busyEvents: boolean[] = [];
  const modelSettings = overrides.modelSettings ?? { defaultModel: 'model-a', defaultThinkingLevel: 'medium' };

  const session = {
    isStreaming: false,
    model: { id: 'model-a' },
    thinkingLevel: 'medium',
    prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
    },
    abort: async () => undefined,
    followUp: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    setModel: async (model: { id: string }) => { (session.model as { id: string }).id = model.id; },
    setThinkingLevel: (level: string) => { session.thinkingLevel = level; },
  } as unknown as SessionContext['session'];

  Object.assign(session as object, overrides.sessionOverrides ?? {});

  const context: SessionContext = {
    runtime: {
      session,
      dispose: async () => undefined,
      services: {
        modelRegistry: {
          getAvailable: () => [{ id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, input: ['text'] }],
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
    sdk: { VERSION: '1.0.0', SessionManager: { listAll: async () => [], continueRecent: () => ({}), create: () => ({}), open: () => ({}) } } as never,
    getSessionContext: () => context,
    async createSessionContext() { return context; },
    async ensureSessionContext() { return context; },
    setViewedSessionPath() {},
    async buildSessionOpenedPayload() { return {} as never; },
    async applySystemPromptToggles() {},
    async loadTranscriptPage() { return {} as never; },
    emit(event, payload) { emitted.push({ event, payload }); },
    emitBusyChanged(_ctx, busy) { busyEvents.push(busy); },
    emitContextUsageChanged() {},
    async emitSessionListChanged() {},
    async listSessions() { return []; },
    listAvailableModels() { return [{ id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, inputKinds: ['text'] }]; },
    async readModelSettings() { return modelSettings; },
    async writeModelSettings(updates) { return { ...modelSettings, ...updates }; },
  };

  return { deps, context, emitted, busyEvents };
}

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms))]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Bug 4 — handleMessageInterrupt: abort() never settles → activeRequest stuck
// ===========================================================================

test('Bug 4: when session.abort() never settles (hung provider teardown), the interrupt-abort watchdog force-clears activeRequest + emits operational-error (Phase 2 fix: 30s watchdog bounds the abort promise)', async () => {
  // The watchdog races `session.abort()` against PIE_INTERRUPT_ABORT_WATCHDOG_MS.
  // If abort() NEVER settles (provider connection teardown stuck), the watchdog
  // force-clears `activeRequest` + emits an `operational-error` notice so the
  // session is NOT permanently blocked from sending / live-switching models.
  // Tighten the watchdog to 50ms so the test does not wait the full 30s.
  const prevWatchdog = process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
  process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = '50';
  const harness = createHarness({
    context: { activeRequest: { id: 'req-stuck-abort', messageIndex: 0, aborted: false } },
    sessionOverrides: {
      isStreaming: true,
      abort: () => new Promise<void>(() => {}), // NEVER settles — hung teardown
    },
  });

  const interrupted = await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });
  assert.deepEqual(interrupted, { interrupted: true });
  assert.equal(harness.context.activeRequest?.aborted, true);

  // Before the watchdog fires, activeRequest is still set (the abort hasn't
  // settled). This is correct — the watchdog only force-clears after the window.
  await sleep(20);
  assert.equal(harness.context.activeRequest?.id, 'req-stuck-abort', 'activeRequest still set before watchdog fires (no premature clear)');

  // After the watchdog window elapses, activeRequest is force-cleared.
  await sleep(80);
  assert.equal(
    harness.context.activeRequest,
    undefined,
    'Phase 2 FIX: the interrupt-abort watchdog force-clears activeRequest after the window — session is no longer permanently wedged',
  );

  // An operational-error notice was emitted so the user can recover.
  const opErrors = harness.emitted.filter((e) => e.event === 'operational-error');
  assert.ok(opErrors.length >= 1, 'an operational-error notice is emitted when the abort watchdog fires');
  const opPayload = opErrors[0]?.payload as { code?: string; message?: string } | undefined;
  assert.match(
    `${opPayload?.code ?? ''} ${opPayload?.message ?? ''}`,
    /INTERRUPT_ABORT_STUCK|abort.+did not settle|force-cleared/i,
  );

  // Consequence fixed: with the watchdog having cleared activeRequest AND
  // the session no longer reporting streaming, a subsequent settings.set (live
  // model switch) PROCEEDS (the session is unblocked). In production
  // `isStreaming` flips false when the SDK's `turn_end` fires; here we simulate
  // that the stream has stopped (the realistic state once the abort watchdog
  // has fired — the turn is dead, even if abort() never settled).
  (harness.context.session as unknown as { isStreaming: boolean }).isStreaming = false;
  const registry = (harness.context.runtime.services as { modelRegistry: { getAvailable: () => unknown[]; find: (p: string, id: string) => unknown } }).modelRegistry;
  registry.getAvailable = () => [
    { id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, input: ['text'] },
    { id: 'model-b', name: 'Model B', provider: 'mock', reasoning: false, input: ['text'] },
  ] as never;
  registry.find = (_p: string, id: string) => ({ id }) as never;
  const updated = await handleBackendRequest(harness.deps, {
    id: '2',
    method: 'settings.set',
    params: { sessionPath: '/repo/session.jsonl', defaultModel: 'model-b' },
  });
  assert.deepEqual(updated, { defaultModel: 'model-b', defaultThinkingLevel: 'medium' }, 'live model switch succeeds after the watchdog cleared the stuck activeRequest (with isStreaming=false)');

  if (prevWatchdog === undefined) delete process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS;
  else process.env.PIE_INTERRUPT_ABORT_WATCHDOG_MS = prevWatchdog;
});

test('Bug 4 (control): a session.abort() that settles promptly clears activeRequest (the healthy-abort path must NOT be changed by the Phase 2 fix)', async () => {
  // Control proving the structural path is sound when abort settles. Phase 2's
  // watchdog must NOT touch this path — only the never-settles window.
  let abortResolve!: () => void;
  const harness = createHarness({
    context: { activeRequest: { id: 'req-healthy', messageIndex: 0, aborted: false } },
    sessionOverrides: {
      isStreaming: true,
      abort: () => new Promise<void>((resolve) => { abortResolve = resolve; }),
    },
  });
  // model-b must be available for the live switch in this control. The default
  // harness registry only has model-a; add model-b in place.
  const registry = (harness.context.runtime.services as { modelRegistry: { getAvailable: () => unknown[]; find: (p: string, id: string) => unknown } }).modelRegistry;
  registry.getAvailable = () => [
    { id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true, input: ['text'] },
    { id: 'model-b', name: 'Model B', provider: 'mock', reasoning: false, input: ['text'] },
  ] as never;
  registry.find = (_p: string, id: string) => ({ id }) as never;

  await handleBackendRequest(harness.deps, {
    id: '1',
    method: 'message.interrupt',
    params: { sessionPath: '/repo/session.jsonl' },
  });

  // Stream stops, abort resolves → finally clears activeRequest.
  (harness.context.session as unknown as { isStreaming: boolean }).isStreaming = false;
  abortResolve();
  await sleep(10);

  assert.equal(harness.context.activeRequest, undefined);
  assert.equal(harness.busyEvents.at(-1), false);

  // Live model switch now proceeds (no REQUEST_IN_PROGRESS).
  const updated = await handleBackendRequest(harness.deps, {
    id: '2',
    method: 'settings.set',
    params: { sessionPath: '/repo/session.jsonl', defaultModel: 'model-b' },
  });
  assert.deepEqual(updated, { defaultModel: 'model-b', defaultThinkingLevel: 'medium' });
});
