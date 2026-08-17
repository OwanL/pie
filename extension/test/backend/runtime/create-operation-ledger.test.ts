import assert from 'node:assert/strict';
import test from 'node:test';

import { handleBackendRequest, type BackendRequestHandlerDeps } from '../../../src/backend/request-handler';
import { CreateOperationLedger } from '../../../src/backend/create-operation-ledger';
import type { SessionContext } from '../../../src/backend/server-types';
import type { SdkSessionManager } from '../../../src/backend/sdk';

/**
 * §6.3 idempotent create/duplicate dedupe — backend half.
 *
 * Covers the plan's coordinator-side contract: concurrent same-id RPCs share
 * one durable creation, retries reuse the completed durable result, distinct
 * operationIds create distinct sessions, `session.duplicate` dedupes through
 * the same ledger, and a durable path left behind by a failed publication is
 * resumed instead of recreated. Also covers the ledger's per-deps fallback
 * (the harness below does not wire a ledger, so these tests exercise the
 * safe fallback path exactly like existing test harnesses).
 */

interface Harness {
  deps: BackendRequestHandlerDeps;
  emitted: Array<{ event: string; payload?: unknown }>;
  /** Number of durable `SessionManager.create` invocations. */
  createCalls: number;
  /** Paths passed to `SessionManager.open`. */
  openCalls: string[];
  /** Paths materialized through `createSessionContext` (runtime creation). */
  contextPaths: string[];
  /** When true, runtime/context bootstrap fails before commit. */
  failContext: boolean;
  /** When true, `buildSessionOpenedPayload` rejects (publication failure). */
  failPublication: boolean;
}

function createHarness(): Harness {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const openCalls: string[] = [];
  const contextPaths: string[] = [];
  const harnessState: Harness = {
    deps: undefined as never,
    emitted,
    createCalls: 0,
    openCalls,
    contextPaths,
    failContext: false,
    failPublication: false,
  };

  let createIndex = 0;
  let viewedSessionPath: string | undefined;
  let viewedRevision = 0;

  const session = {
    isStreaming: false,
    isCompacting: false,
    activeRequest: undefined,
    sessionManager: { getCwd: () => '/repo' },
  } as unknown as SessionContext['session'];

  const context: SessionContext = {
    runtime: { session, dispose: async () => undefined },
    session,
    sessionPath: '/sessions/created-1.jsonl',
    unsubscribe: () => undefined,
    busySeq: 0,
  } as unknown as SessionContext;

  const makeManager = (sessionPath: string, cwd: string): SdkSessionManager => ({
    getCwd: () => cwd,
    getSessionFile: () => sessionPath,
    getSessionName: () => 'Session',
    getBranch: () => [],
    getEntries: () => [],
  });

  harnessState.deps = {
    sdkPath: '/sdk',
    agentDir: '/agent',
    startupCwd: '/startup',
    sdk: {
      VERSION: '1.0.0',
      SessionManager: {
        create: (cwd: string) => {
          harnessState.createCalls += 1;
          createIndex += 1;
          return makeManager(`/sessions/created-${createIndex}.jsonl`, cwd);
        },
        open: (sessionPath: string) => {
          openCalls.push(sessionPath);
          return makeManager(sessionPath, '/repo');
        },
        forkFrom: (sourcePath: string, cwd: string) => {
          createIndex += 1;
          return makeManager(`/sessions/forked-${createIndex}.jsonl`, cwd);
        },
      },
    } as unknown as BackendRequestHandlerDeps['sdk'],
    getSessionContext: () => undefined,
    createColdSession(cwd) {
      const manager = harnessState.deps.sdk.SessionManager.create(cwd || harnessState.deps.startupCwd);
      const sessionPath = manager.getSessionFile() as string;
      contextPaths.push(sessionPath);
      if (harnessState.failContext) throw new Error('context bootstrap failed');
      return { sessionPath };
    },
    duplicateColdSession(sourcePath) {
      const source = harnessState.deps.sdk.SessionManager.open(sourcePath);
      const manager = harnessState.deps.sdk.SessionManager.forkFrom(sourcePath, source.getCwd());
      const sessionPath = manager.getSessionFile() as string;
      contextPaths.push(sessionPath);
      return { sessionPath };
    },
    async createSessionContext(manager, reason) {
      const sessionPath = manager.getSessionFile() as string;
      contextPaths.push(sessionPath);
      if (harnessState.failContext) throw new Error('context bootstrap failed');
      return { ...context, sessionPath };
    },
    async ensureSessionContext(sessionPath) {
      return { ...context, sessionPath };
    },
    captureViewedSessionRevision: () => viewedRevision,
    setViewedSessionPathIfCurrent(sessionPath, revision) {
      if (revision !== viewedRevision) return false;
      viewedSessionPath = sessionPath;
      viewedRevision += 1;
      return true;
    },
    setViewedSessionPath(sessionPath) {
      viewedSessionPath = sessionPath;
      viewedRevision += 1;
    },
    async buildSessionOpenedPayload(sessionPath, selectionToken, _transcript, _transport, operationId, operationAttempt) {
      if (harnessState.failPublication) {
        throw new Error('publication failed');
      }
      return {
        session: { path: sessionPath, cwd: '/repo', name: 'Session', modifiedAt: '2026-01-01T00:00:00.000Z', messageCount: 0 },
        transcript: [],
        transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        busy: false,
        runtimeReady: false,
        selectionToken,
        operationId,
        operationAttempt,
      };
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    emitBusyChanged: () => undefined,
    emitContextUsageChanged: () => undefined,
    async emitSessionListChanged() {
      emitted.push({ event: 'session.list.changed' });
    },
    async listSessions() {
      return [];
    },
    listAvailableModels() {
      return [];
    },
    async readModelSettings() {
      return { defaultModel: 'model-a', defaultThinkingLevel: 'medium' };
    },
    async writeModelSettings(updates) {
      return { defaultModel: 'model-a', defaultThinkingLevel: 'medium', ...updates };
    },
    async applySystemPromptToggles() {},
    setAutonomousMode: () => undefined,
    async loadTranscriptPage(sessionPath) {
      return {
        sessionPath,
        transcript: [],
        transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
        busy: false,
      };
    },
  };

  return harnessState;
}

function openedEvents(harness: Harness): Array<{ event: string; payload?: unknown }> {
  return harness.emitted.filter((entry) => entry.event === 'session.opened');
}

const CREATE = (operationId: string, selectionToken = 'sel-1', operationAttempt = 1) => ({
  id: `create-${operationId}`,
  method: 'session.create' as const,
  params: { cwd: '/workspace', selectionToken, operationId, operationAttempt },
});

test('concurrent session.create with the same operationId performs one durable create and one publication', async () => {
  const harness = createHarness();

  const [first, second] = await Promise.all([
    handleBackendRequest(harness.deps, CREATE('op-concurrent')),
    handleBackendRequest(harness.deps, CREATE('op-concurrent', 'sel-2')),
  ]);

  assert.deepEqual(first, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.deepEqual(second, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.equal(harness.createCalls, 1, 'a second durable session must not be created');
  assert.deepEqual(harness.contextPaths, ['/sessions/created-1.jsonl']);
  const opened = openedEvents(harness);
  assert.equal(opened.length, 1, 'the in-flight joiner must not publish a second session.opened');
  assert.equal((opened[0]?.payload as { operationId?: string }).operationId, 'op-concurrent');
  assert.equal((opened[0]?.payload as { operationAttempt?: number }).operationAttempt, 1);
});

test('retry after a completed session.create reuses the durable result and re-publishes session.opened', async () => {
  const harness = createHarness();

  const first = await handleBackendRequest(harness.deps, CREATE('op-completed'));
  const retry = await handleBackendRequest(harness.deps, CREATE('op-completed', 'sel-retry'));

  assert.deepEqual(first, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.deepEqual(retry, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.equal(harness.createCalls, 1, 'a retry must not create a second durable session');
  assert.deepEqual(harness.contextPaths, ['/sessions/created-1.jsonl'], 'a completed retry must not re-materialize the runtime');
  const opened = openedEvents(harness);
  assert.equal(opened.length, 2, 'the retry re-publishes so a first emission lost in the timeout window is recovered');
  for (const entry of opened) {
    assert.equal((entry.payload as { operationId?: string }).operationId, 'op-completed');
  }
  assert.equal((opened[1]?.payload as { selectionToken?: string }).selectionToken, 'sel-retry');
});

test('session.create with distinct operationIds creates distinct sessions', async () => {
  const harness = createHarness();

  const first = await handleBackendRequest(harness.deps, CREATE('op-a'));
  const second = await handleBackendRequest(harness.deps, CREATE('op-b'));

  assert.deepEqual(first, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.deepEqual(second, { ok: true, sessionPath: '/sessions/created-2.jsonl' });
  assert.equal(harness.createCalls, 2);
  assert.equal(openedEvents(harness).length, 2);
});

test('session.duplicate dedupes concurrent same-id forks through the same ledger', async () => {
  const harness = createHarness();
  const duplicate = (operationId: string) => ({
    id: `duplicate-${operationId}`,
    method: 'session.duplicate' as const,
    params: { sessionPath: '/repo/source.jsonl', selectionToken: 'dup-sel', operationId },
  });

  const [first, second] = await Promise.all([
    handleBackendRequest(harness.deps, duplicate('op-dup')),
    handleBackendRequest(harness.deps, duplicate('op-dup')),
  ]);

  assert.deepEqual(first, { ok: true, sessionPath: '/sessions/forked-1.jsonl' });
  assert.deepEqual(second, { ok: true, sessionPath: '/sessions/forked-1.jsonl' });
  const opened = openedEvents(harness);
  assert.equal(opened.length, 1, 'the concurrent duplicate joiner must not publish a second session.opened');
  assert.equal((opened[0]?.payload as { operationId?: string }).operationId, 'op-dup');
});

test('publication failure after durable creation returns the committed path and never creates twice', async () => {
  const harness = createHarness();
  harness.failPublication = true;

  const acknowledged = await handleBackendRequest(harness.deps, CREATE('op-pubfail'));
  assert.deepEqual(acknowledged, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.equal(harness.createCalls, 1, 'the durable session committed before publication failed');
  assert.equal(openedEvents(harness).length, 0);

  harness.failPublication = false;
  const retry = await handleBackendRequest(harness.deps, CREATE('op-pubfail'));

  assert.deepEqual(retry, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.equal(harness.createCalls, 1, 'the retry must not create a second durable session');
  assert.deepEqual(harness.openCalls, []);
  // Completed retries best-effort republish the authoritative snapshot.
  await new Promise((resolve) => setImmediate(resolve));
  const opened = openedEvents(harness);
  assert.equal(opened.length, 1);
  assert.equal((opened[0]?.payload as { operationId?: string }).operationId, 'op-pubfail');
});

test('ledger cannot claim a durable create when the SDK header barrier fails before returning', async () => {
  const harness = createHarness();
  const originalCreate = harness.deps.createColdSession!;
  let barrierAttempts = 0;
  harness.deps.createColdSession = (cwd) => {
    barrierAttempts += 1;
    if (barrierAttempts === 1) throw new Error('SDK cold-create header fsync failed');
    return originalCreate(cwd);
  };

  await assert.rejects(
    handleBackendRequest(harness.deps, CREATE('op-header-failure')),
    /header fsync failed/,
  );
  const retry = await handleBackendRequest(harness.deps, CREATE('op-header-failure'));

  assert.deepEqual(retry, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.equal(barrierAttempts, 2);
  assert.equal(harness.createCalls, 1, 'the failed SDK barrier returned no path for the ledger to retain');
});

test('cold manager installation failure is pre-commit and a retry performs a fresh create', async () => {
  const harness = createHarness();
  harness.failContext = true;
  await assert.rejects(handleBackendRequest(harness.deps, CREATE('op-context-fail')), /context bootstrap failed/);
  assert.equal(harness.createCalls, 1);

  harness.failContext = false;
  const retry = await handleBackendRequest(harness.deps, CREATE('op-context-fail'));
  assert.deepEqual(retry, { ok: true, sessionPath: '/sessions/created-2.jsonl' });
  assert.equal(harness.createCalls, 2, 'pre-commit failure must not acknowledge/reuse the allocated filename');
});

test('session.create without operationId keeps the legacy non-deduplicated behavior', async () => {
  const harness = createHarness();

  const first = await handleBackendRequest(harness.deps, {
    id: 'legacy-1', method: 'session.create', params: { cwd: '/workspace' },
  });
  const second = await handleBackendRequest(harness.deps, {
    id: 'legacy-2', method: 'session.create', params: { cwd: '/workspace' },
  });

  assert.deepEqual(first, { ok: true, sessionPath: '/sessions/created-1.jsonl' });
  assert.deepEqual(second, { ok: true, sessionPath: '/sessions/created-2.jsonl' });
  assert.equal(harness.createCalls, 2, 'legacy creates are never deduplicated');
  assert.equal(openedEvents(harness).length, 2);
  assert.equal((openedEvents(harness)[0]?.payload as { operationId?: string }).operationId, undefined);
});

// ─── ledger-level semantics ─────────────────────────────────────────────────

test('ledger: failed operation without a durable path retries as a fresh attempt', async () => {
  const ledger = new CreateOperationLedger();
  let attempts = 0;
  const run = () => ledger.run({
    operationId: 'op-fresh',
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('durable create failed');
      return { sessionPath: '/sessions/retried.jsonl' };
    },
    resume: async () => {
      throw new Error('resume must not run without a durable path');
    },
  });

  await assert.rejects(run(), /durable create failed/);
  const retry = await run();
  assert.deepEqual(retry, { sessionPath: '/sessions/retried.jsonl' });
  assert.equal(attempts, 2);
});

test('ledger: an error after durable-path registration settles as committed success', async () => {
  const ledger = new CreateOperationLedger();
  let executes = 0;
  let republishes = 0;
  const run = () => ledger.run({
    operationId: 'op-committed',
    execute: async (registerDurablePath) => {
      executes += 1;
      registerDurablePath('/sessions/committed.jsonl');
      throw new Error('publication failed');
    },
    resume: async () => {
      throw new Error('a committed operation is never resumed/recreated');
    },
    republish: async () => { republishes += 1; },
  });

  assert.deepEqual(await run(), { sessionPath: '/sessions/committed.jsonl' });
  assert.deepEqual(await run(), { sessionPath: '/sessions/committed.jsonl' });
  assert.equal(executes, 1);
  assert.equal(republishes, 1, 'a retry only republishes the completed operation');
});

test('ledger: completed retry reuses the result and swallows republish errors', async () => {
  const ledger = new CreateOperationLedger();
  let executes = 0;
  let republishes = 0;
  const run = () => ledger.run({
    operationId: 'op-republish',
    execute: async () => {
      executes += 1;
      return { sessionPath: '/sessions/done.jsonl' };
    },
    resume: async () => {
      throw new Error('resume must not run for a completed operation');
    },
    republish: async () => {
      republishes += 1;
      if (republishes === 1) throw new Error('republish failed');
    },
  });

  assert.deepEqual(await run(), { sessionPath: '/sessions/done.jsonl' });
  // The failed republish must not fail the retry: the durable result is committed.
  assert.deepEqual(await run(), { sessionPath: '/sessions/done.jsonl' });
  assert.deepEqual(await run(), { sessionPath: '/sessions/done.jsonl' });
  assert.equal(executes, 1, 'a completed retry never re-executes the durable creation');
  assert.equal(republishes, 2);
});

test('ledger: a synchronously throwing republish still cannot fail the completed retry', async () => {
  const ledger = new CreateOperationLedger();
  const run = () => ledger.run({
    operationId: 'op-sync-republish',
    execute: async () => ({ sessionPath: '/sessions/done.jsonl' }),
    resume: async () => {
      throw new Error('resume must not run for a completed operation');
    },
    republish: () => {
      throw new Error('sync republish failure');
    },
  });

  assert.deepEqual(await run(), { sessionPath: '/sessions/done.jsonl' });
  assert.deepEqual(await run(), { sessionPath: '/sessions/done.jsonl' });
});
