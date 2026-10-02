import assert from 'node:assert/strict';
import test from 'node:test';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as pathMod from 'node:path';

import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { BackendError } from '../server-io.js';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler.js';
import type { TranscriptPagePayload } from '../../lib/rpc/session-events.js';
import {
  SESSION_CONTROL_SETTINGS_REQUEST_EVENT,
  type SessionControlSettingsAcknowledgement,
  type SessionControlSettingsRequest,
} from '../../lib/rpc/session-control-settings.js';
import { createSessionControlSender } from '../../lib/rpc/session-control-attribution.js';
import { ColdSessionLeaseAuthority, ColdSessionStore } from '../../../session-storage/lifecycle/cold-session-store.js';
import { parseWorkerToCoordinatorFrame, WORKER_IPC_VERSION } from '../../lib/rpc/worker-protocol.js';
import { serializeRuntimeCommandError } from '../../workers/worker-entry.js';
import { WorkerRequestTimeoutError } from '../../lib/rpc/worker-client.js';

const sourceArtifactDescriptor = createSyntheticSourceTestSdkRuntime(pathMod.resolve('/sdk')).descriptor;

type FakeServer = {
  handleWorkerSessionControl(frame: unknown, sourceSessionPath: string): Promise<{
    result: Record<string, unknown>;
    afterResponse?: () => void | Promise<void>;
  }>;
  listSessionSummaries(): Promise<unknown[]>;
  handleRequest(request: { id: string; method: string; params?: unknown }): Promise<unknown>;
  emit(event: string, payload?: unknown): void;
  workerRuntimeRouter?: {
    getRoute(path: string): { state: string; checkpoint?: { requestId?: string } };
    operationCancellationGeneration?(path: string): number;
    invalidatePendingRuntimeOperations?(path: string): number;
  };
};

function serverForTests(): FakeServer {
  return new BackendServer({ sdkPath: '/sdk', sourceArtifactDescriptor, cwd: '/workspace', workerEntryPath: '/worker.js' }) as unknown as FakeServer;
}

function frame(action: string, payload: Record<string, unknown> = {}): unknown {
  return { requestId: `control-${action}`, action, payload };
}

function mockSettingsReply(request: { method: string; params?: unknown }): Record<string, unknown> {
  return request.method === 'settings.set'
    ? { defaultThinkingLevel: (request.params as { defaultThinkingLevel?: string }).defaultThinkingLevel ?? 'high' }
    : { accepted: true };
}

function installSessionControlSettingsHarness(
  server: FakeServer,
  observedEvents: Array<{ event: string; payload?: unknown }> = [],
): void {
  const internal = server as unknown as {
    buildSessionOpenedPayload: (...args: unknown[]) => Promise<unknown>;
    initializeColdSessionStore(): {
      openSnapshot(path: string): Promise<unknown>;
      readDurableSessionMetadata(path: string, modelSettings: unknown): Promise<unknown>;
    };
    assertSessionControlModelAvailable(model: unknown): Promise<void>;
    acknowledgeHostSessionControlSettings(acknowledgement: SessionControlSettingsAcknowledgement): Promise<unknown>;
  };
  internal.buildSessionOpenedPayload = async (sessionPath) => ({
    session: {
      path: sessionPath,
      modelId: 'gpt-test',
      provider: 'openai',
      thinkingLevel: 'high',
    },
    modelSettings: {
      defaultModel: 'gpt-test',
      defaultProvider: 'openai',
      defaultThinkingLevel: 'high',
    },
    availableModels: [],
  });
  internal.initializeColdSessionStore = () => ({
    openSnapshot: async (sessionPath) => ({
      session: { path: sessionPath, cwd: '/workspace', modelId: 'gpt-test', provider: 'openai', thinkingLevel: 'high' },
    }),
    readDurableSessionMetadata: async () => ({
      cwd: '/workspace', modelId: 'gpt-test', provider: 'openai', thinkingLevel: 'high',
    }),
  });
  internal.assertSessionControlModelAvailable = async () => undefined;
  server.emit = (event, payload) => {
    observedEvents.push({ event, payload });
    if (event !== SESSION_CONTROL_SETTINGS_REQUEST_EVENT) return;
    const request = payload as SessionControlSettingsRequest;
    const captured = { autonomousMode: true, subagentProviderChoices: { openai: true } };
    const settings = request.action === 'capture'
      ? captured
      : {
        autonomousMode: request.settings?.autonomousMode ?? captured.autonomousMode,
        subagentProviderChoices: request.settings?.subagentProviderChoices ?? captured.subagentProviderChoices,
      };
    void internal.acknowledgeHostSessionControlSettings({
      requestId: request.requestId,
      sessionPath: request.sessionPath,
      action: request.action,
      outcome: 'succeeded',
      settings,
      ...(request.action === 'apply' ? { application: 'applied' } : {}),
    });
  };
}

const currentSender = createSessionControlSender(
  { sessionId: 'sid-current.jsonl', identityFallback: false },
  'Current plan',
);

const summaries = [
  {
    path: '/workspace/current.jsonl', name: 'Current', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 4,
  },
  {
    path: '/workspace/idle.jsonl', name: 'Idle', cwd: '/workspace', modifiedAt: '2026-01-01T00:00:01.000Z',
    messageCount: 2,
  },
];

function applyMembership(server: FakeServer, snapshot: unknown): void {
  (server as unknown as { applyHostLiveMembership(snapshot: unknown): void }).applyHostLiveMembership(snapshot);
}

function membershipEntry(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path,
    name: path.replace(/.*[/\\]/u, ''),
    cwd: '/workspace',
    activity: 'idle',
    ...overrides,
  };
}

const revisionCounter = { value: 0 };
function membership(sessions: unknown[], closing: unknown[] = []): unknown {
  return { revision: ++revisionCounter.value, timestamp: 1000, sessions, closing };
}

function closeFrameEntry(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { path, operationId: `close:${path}`, source: 'host', ...overrides };
}

// Title tests need the coordinator's fail-closed hydration to succeed: write
// real minimal session transcripts (header + assigned-name entry) so the
// namespace reads each live member's durable title facts from its own file.
async function writeSessionFile(dir: string, name: string, title?: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = pathMod.join(dir, name);
  const lines = [
    JSON.stringify({ type: 'session', cwd: dir, timestamp: '2026-01-01T00:00:00.000Z', id: `sid-${name}` }),
    ...(title ? [JSON.stringify({ type: 'session_info', name: title })] : []),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

/** Await the initial fail-closed hydration triggered by the first snapshot. */
async function hydrate(server: FakeServer): Promise<void> {
  await (server as unknown as { titleNamespaceHydration?: Promise<void> }).titleNamespaceHydration;
}

/** Hydrate a live authority over real transcript files titled "Current plan"
 *  and "Idle plan". Returns the real paths so frames target them. */
async function readyServerWithMembers(dir: string): Promise<{
  server: FakeServer;
  currentPath: string;
  idlePath: string;
}> {
  const server = serverForTests();
  const operationGenerations = new Map<string, number>();
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: 'cold' }),
    operationCancellationGeneration: (sessionPath) => operationGenerations.get(sessionPath) ?? 0,
    invalidatePendingRuntimeOperations: (sessionPath) => {
      const next = (operationGenerations.get(sessionPath) ?? 0) + 1;
      operationGenerations.set(sessionPath, next);
      return next;
    },
  };
  const currentPath = await writeSessionFile(dir, 'current.jsonl', 'Current plan');
  const idlePath = await writeSessionFile(dir, 'idle.jsonl', 'Idle plan');
  applyMembership(server, membership([membershipEntry(currentPath), membershipEntry(idlePath)]));
  await hydrate(server);
  return { server, currentPath, idlePath };
}

test('hydration re-reads the newest snapshot when membership changes during an awaited header read', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title: string }>;
    titleNamespaceHydration?: Promise<void>;
    liveSessionTitles: { ready: boolean; assigned(path: string): string | undefined };
  };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  internal.readLiveSessionTitleEntry = async (sessionPath) => {
    if (first) { first = false; await blocked; }
    return { sessionPath, sessionId: sessionPath, title: sessionPath === '/a' ? 'A' : 'B' };
  };
  applyMembership(server, membership([membershipEntry('/a')]));
  const older = internal.titleNamespaceHydration;
  applyMembership(server, membership([membershipEntry('/a'), membershipEntry('/b')]));
  assert.equal(internal.liveSessionTitles.ready, false);
  release();
  await older;
  await internal.titleNamespaceHydration;
  assert.equal(internal.liveSessionTitles.ready, true);
  assert.equal(internal.liveSessionTitles.assigned('/b'), 'B');
});

test('provisional membership refresh does not negate title readiness or block unrelated create', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-provisional-refresh-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const provisionalPath = await writeSessionFile(dir, 'provisional.jsonl');
  const internal = server as unknown as {
    readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title?: string }>;
    titleAdmission?: Promise<void>;
  };
  let release!: () => void;
  let readStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const originalRead = internal.readLiveSessionTitleEntry.bind(server);
  internal.readLiveSessionTitleEntry = async (sessionPath) => {
    if (sessionPath !== provisionalPath) return originalRead(sessionPath);
    readStarted();
    await blocked;
    return { sessionPath, sessionId: sessionPath, title: undefined };
  };
  const sessions = [membershipEntry(currentPath), membershipEntry(idlePath), membershipEntry(provisionalPath)];
  applyMembership(server, membership(sessions));
  await started;
  // A host may publish snapshots much faster than this provisional member's
  // title read; the assigned namespace and existing addresses remain usable.
  for (let index = 0; index < 5; index += 1) applyMembership(server, membership(sessions));

  installSessionControlSettingsHarness(server);
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    return request.method === 'session.create'
      ? { sessionPath: '/workspace/created.jsonl', title: 'New plan' }
      : mockSettingsReply(request);
  };
  const listed = await server.handleWorkerSessionControl(frame('list'), currentPath);
  const rows = listed.result.sessions as Array<Record<string, unknown>>;
  assert.equal(rows.find((row) => row.path === currentPath)?.title, 'Current plan');
  assert.equal(listed.result.titleNamespaceReady, true);
  const assignedTarget = await server.handleWorkerSessionControl(
    frame('message', { title: 'Current plan', prompt: 'assigned target stays usable' }), currentPath,
  );
  assert.equal((assignedTarget.result.message as Record<string, unknown>).status, 'accepted');
  const created = await server.handleWorkerSessionControl(
    frame('create', { title: 'New plan' }), currentPath,
  );
  assert.equal((created.result.creation as Record<string, unknown>).status, 'created');
  assert.ok(requests.some((request) => request.method === 'session.create'));

  release();
  await internal.titleAdmission;
});

test('initial title hydration retries a transient failure without a membership change', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title: string }>;
    liveSessionTitles: { ready: boolean; assigned(path: string): string | undefined };
  };
  let reads = 0;
  internal.readLiveSessionTitleEntry = async (sessionPath) => {
    reads += 1;
    if (reads === 1) throw new Error('transient initial hydration failure');
    return { sessionPath, sessionId: 'recovered-session', title: 'Recovered plan' };
  };
  applyMembership(server, membership([membershipEntry('/workspace/recovered.jsonl')]));
  await hydrate(server);
  assert.equal(internal.liveSessionTitles.ready, false);

  for (let tick = 0; tick < 200 && !internal.liveSessionTitles.ready; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reads, 2, 'a timer retries the unchanged complete membership once');
  assert.equal(internal.liveSessionTitles.ready, true);
  assert.equal(internal.liveSessionTitles.assigned('/workspace/recovered.jsonl'), 'Recovered plan');
});

test('disposing clears a scheduled title namespace retry', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title: string }>;
    titleNamespaceRetryTimer?: ReturnType<typeof setTimeout>;
    dispose(): Promise<void>;
  };
  let reads = 0;
  internal.readLiveSessionTitleEntry = async (sessionPath) => {
    reads += 1;
    throw new Error(`transient read ${sessionPath}`);
  };
  applyMembership(server, membership([membershipEntry('/workspace/disposed.jsonl')]));
  await hydrate(server);
  assert.ok(internal.titleNamespaceRetryTimer);
  await internal.dispose();
  assert.equal(internal.titleNamespaceRetryTimer, undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reads, 1, 'disposal prevents the retry callback from starting new reads');
});

test('a reopened collision is persisted before its title enters live admission', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-reopen-'));
  const server = serverForTests();
  const older = await writeSessionFile(dir, 'older.jsonl', 'Review');
  const reopened = await writeSessionFile(dir, 'reopened.jsonl', 'Review');
  applyMembership(server, membership([membershipEntry(older)]));
  await hydrate(server);
  const internal = server as unknown as {
    admitOpenedSessionTitle(path: string): Promise<void>;
    persistAssignedSessionTitle(path: string, title: string, id: string, expected?: string): Promise<void>;
    liveSessionTitles: { assigned(path: string): string | undefined };
  };
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  internal.persistAssignedSessionTitle = async (sessionPath, title, _id, expected) => {
    assert.equal(sessionPath, reopened);
    assert.equal(expected, 'Review');
    assert.equal(title, 'Review (2)');
    await blocked;
    await fs.appendFile(sessionPath, `${JSON.stringify({ type: 'session_info', name: title })}\n`);
  };
  const admission = internal.admitOpenedSessionTitle(reopened);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(internal.liveSessionTitles.assigned(reopened), undefined);
  unblock();
  await admission;
  assert.equal(internal.liveSessionTitles.assigned(reopened), 'Review (2)');
  assert.match(await fs.readFile(reopened, 'utf8'), /Review \(2\)/);
});

test('a fallback name is returned as a published assignment even when model generation failed', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    liveSessionTitles: { reconcile(entries: unknown[], persist: () => Promise<void>): Promise<unknown>; assigned(path: string): string | undefined };
    persistAssignedSessionTitle(path: string, title: string): Promise<void>;
    finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string): Promise<unknown>;
  };
  await internal.liveSessionTitles.reconcile([], async () => undefined);
  const path = '/workspace/fallback.jsonl';
  let persisted: string | undefined;
  internal.persistAssignedSessionTitle = async (_path, title) => { persisted = title; };
  const result = await internal.finalizeGeneratedLiveSessionTitle(
    path, 'Investigate failed login.', { generated: false, reason: 'disabled' }, 'title-fallback',
  ) as { generated?: boolean; name?: string };
  assert.equal(result.generated, true);
  assert.equal(result.name, persisted);
  assert.equal(internal.liveSessionTitles.assigned(path), persisted);
});

test('session.settingsAcknowledgement routes validated correlated acknowledgements and ignores unknown ids', async () => {
  const server = serverForTests();
  const acknowledgement = await server.handleRequest({
    id: 'settings-ack',
    method: 'session.settingsAcknowledgement',
    params: {
      requestId: 'unknown-settings-request',
      sessionPath: '/workspace/current.jsonl',
      action: 'capture',
      outcome: 'succeeded',
      settings: { autonomousMode: true, subagentProviderChoices: {} },
    },
  });
  assert.deepEqual(acknowledgement, { ok: true, acknowledged: false });
  await assert.rejects(server.handleRequest({
    id: 'settings-ack-invalid',
    method: 'session.settingsAcknowledgement',
    params: { requestId: 'x', sessionPath: '/workspace/current.jsonl', action: 'bad' },
  }));
});

test('session-control list projects host live membership instead of the durable catalog', async () => {
  const server = serverForTests();
  // The durable catalog must not back the live list: assert any catalog use fails loudly.
  server.listSessionSummaries = async () => {
    throw new Error('the live list must not read the durable catalog');
  };
  server.workerRuntimeRouter = {
    getRoute: (path) => path.endsWith('current.jsonl')
      ? { state: 'hot', checkpoint: { requestId: 'active' } }
      : { state: 'cold' },
  };
  applyMembership(server, membership([
    membershipEntry('/workspace/current.jsonl', {
      activity: 'running', requestStartedAt: 900, runningTools: 2, runningSubagents: 1,
      usage: { workingTimeMs: 1200, costUsd: 0.5, costProvenance: 'reported', freshness: 'fresh' },
    }),
    membershipEntry('/workspace/hidden.jsonl', { activity: 'running', hidden: true, agentCreated: true }),
  ]));

  const listed = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  const rows = listed.result.sessions as Array<Record<string, unknown>>;
  assert.equal(listed.result.scope, 'current-extension-host');
  assert.equal(listed.result.membershipHydrated, true);
  // Indexing completeness is never implied: the unique live-title namespace is
  // reported independently of membership and is still (or just now) hydrating.
  assert.equal(listed.result.titleNamespaceReady, false);
  assert.deepEqual(rows.map((row) => row.path), [
    '/workspace/current.jsonl', '/workspace/hidden.jsonl',
  ]);
  assert.equal(rows[0]?.busy, true);
  assert.equal(rows[0]?.activity, 'running');
  assert.equal(rows[0]?.runningTools, 2);
  assert.equal(rows[0]?.runningSubagents, 1);
  assert.equal((rows[0]?.elapsedMs as number) >= 0, true);
  assert.deepEqual((rows[0]?.workingTime as Record<string, unknown>).workingTimeMs, 1200);
  assert.equal(rows[1]?.hidden, true);
  assert.deepEqual(rows[1]?.workingTime, undefined); // unavailable usage is absent, not zero

  // Closing reservations are visible without being admitted live targets.
  applyMembership(server, membership([
    membershipEntry('/workspace/current.jsonl', { activity: 'running' }),
  ], [closeFrameEntry('/workspace/closing.jsonl')]))
  const closingListed = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  const closingRows = closingListed.result.closing as Array<Record<string, unknown>>;
  assert.deepEqual(closingRows.map((row) => row.path), ['/workspace/closing.jsonl']);
  assert.equal(closingRows[0]?.closedBy, 'host');
});

test('session-control list reports counts and truncation for every bounded array', async () => {
  const server = serverForTests();
  server.workerRuntimeRouter = { getRoute: () => ({ state: 'cold' }) };
  const sessions = Array.from({ length: 300 }, (_, index) =>
    membershipEntry(`/workspace/live-${index}.jsonl`));
  const closing = Array.from({ length: 280 }, (_, index) =>
    closeFrameEntry(`/workspace/closing-${index}.jsonl`, { operationId: `close-${index}` }));
  applyMembership(server, membership(sessions, closing));

  const listed = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  assert.equal((listed.result.sessions as unknown[]).length, 256);
  assert.equal(listed.result.totalCount, 300);
  assert.equal(listed.result.sessionsTruncated, true);
  assert.equal((listed.result.closing as unknown[]).length, 256);
  assert.equal(listed.result.closingTotalCount, 280);
  assert.equal(listed.result.closingTruncated, true);
  assert.equal(listed.result.truncated, true);
});

test('closing-only list byte limits trim closing rows and report truncation', async () => {
  const server = serverForTests();
  server.workerRuntimeRouter = { getRoute: () => ({ state: 'cold' }) };
  const longPath = 'x'.repeat(15_000);
  const closing = Array.from({ length: 30 }, (_, index) =>
    closeFrameEntry(`/workspace/${longPath}-${index}.jsonl`, { operationId: `close-${index}` }));
  applyMembership(server, membership([], closing));

  const listed = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  assert.ok(Buffer.byteLength(JSON.stringify(listed.result), 'utf8') <= 192 * 1024);
  assert.equal(listed.result.totalCount, 0);
  assert.equal(listed.result.sessionsTruncated, false);
  assert.equal(listed.result.closingTotalCount, 30);
  assert.equal((listed.result.closing as unknown[]).length < 30, true);
  assert.equal(listed.result.closingTruncated, true);
  assert.equal(listed.result.truncated, true);
});

test('membership-closing targets reject reads and messages and report UI-close joins without new requests', async () => {
  const server = serverForTests();
  server.workerRuntimeRouter = { getRoute: () => ({ state: 'cold' }) };
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  applyMembership(server, membership([
    membershipEntry('/workspace/live.jsonl'),
  ]));
  // A UI close removes the tab: the host publishes the closing reservation only.
  applyMembership(server, membership([], [closeFrameEntry('/workspace/live.jsonl')]));

  await assert.rejects(
    server.handleWorkerSessionControl(
      frame('message', { self: true, prompt: 'racing send' }),
      '/workspace/live.jsonl',
    ),
    /session is closing/,
  );
  await assert.rejects(
    server.handleWorkerSessionControl(frame('read', { self: true }), '/workspace/live.jsonl'),
    /session is closing/,
  );
  const closingClose = await server.handleWorkerSessionControl(
    frame('close', { self: true }),
    '/workspace/live.jsonl',
  );
  assert.equal(closingClose.result.closed, false);
  assert.equal(closingClose.result.closeRequested, false);
  assert.equal(closingClose.result.unknown, true);
  assert.equal(closingClose.result.alreadyClosing, true);
  // The host-owned close is not duplicated by a second coordinator request.
  assert.deepEqual(events.filter((entry) => entry.event === 'session.close.requested').length, 0);
});

test('closing holds its title until confirmed removal, then releases it for reuse', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-close-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const internal = server as unknown as {
    liveSessionTitles: {
      resolve(title: string): { sessionPath: string } | undefined;
      reserve(title: string, identity: { sessionPath: string; sessionId: string }): { title: string };
    };
  };
  applyMembership(server, membership([membershipEntry(idlePath)], [closeFrameEntry(currentPath)]));
  assert.equal(internal.liveSessionTitles.resolve('Current plan')?.sessionPath, currentPath);
  const duringClose = internal.liveSessionTitles.reserve('Current plan', { sessionPath: '/new', sessionId: 'new' });
  assert.equal(duringClose.title, 'Current plan (2)');
  applyMembership(server, membership([membershipEntry(idlePath)]));
  assert.equal(internal.liveSessionTitles.resolve('Current plan'), undefined);
  const afterClose = internal.liveSessionTitles.reserve('Current plan', { sessionPath: '/next', sessionId: 'next' });
  assert.equal(afterClose.title, 'Current plan');
});

test('retained historical cold managers never create a live target after close', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    retainColdSessionManager(handle: { sessionPath: string }, reason: 'resume'): void;
  };
  internal.retainColdSessionManager({ sessionPath: '/workspace/history.jsonl' }, 'resume');
  applyMembership(server, membership([]));
  await assert.rejects(server.handleWorkerSessionControl(
    frame('read', { self: true }), '/workspace/history.jsonl',
  ), /not a live session/);
});

test('closed membership targets are never addressable and user reopen restores admission', async () => {
  const server = serverForTests();
  server.listSessionSummaries = async () => summaries;
  server.workerRuntimeRouter = { getRoute: () => ({ state: 'cold' }) };
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method === 'session.loadTranscriptPage') {
      return {
        sessionPath: '/workspace/idle.jsonl',
        transcript: [{ id: 'row-0', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'hi', status: 'completed' }],
        transcriptWindow: {
          totalCount: 1, loadedStart: 0, loadedEnd: 1,
          hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true,
        },
        busy: false,
      } satisfies TranscriptPagePayload;
    }
    return { accepted: true };
  };
  applyMembership(server, membership([membershipEntry('/workspace/idle.jsonl')]));
  // The session closed: later snapshots carry neither a live nor a closing entry.
  applyMembership(server, membership([]));
  await assert.rejects(
    server.handleWorkerSessionControl(frame('message', { self: true, prompt: 'revive' }), '/workspace/idle.jsonl'),
    /not a live session/,
  );
  await assert.rejects(
    server.handleWorkerSessionControl(frame('read', { self: true }), '/workspace/idle.jsonl'),
    /not a live session/,
  );
  // Ordinary user reopen reopens through the host and republishes membership.
  applyMembership(server, membership([membershipEntry('/workspace/idle.jsonl')]));
  const reopened = await server.handleWorkerSessionControl(frame('read', { self: true }), '/workspace/idle.jsonl');
  assert.equal((requests[0]?.params as { sessionPath: string }).sessionPath, '/workspace/idle.jsonl');
  assert.ok(reopened.result.transcriptWindow || reopened.result.transcript !== undefined);
});


test('session-control server delegates cold-session creation with an idempotent operation identity', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-createdel-'));
  const { server } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const requests: Array<{ id: string; method: string; params?: unknown }> = [];
  server.handleRequest = async (value) => {
    requests.push(value);
    return value.method === 'session.create'
      ? { ok: true, sessionPath: '/workspace/new.jsonl', title: 'New plan' }
      : mockSettingsReply(value);
  };

  const created = await server.handleWorkerSessionControl(
    frame('create', { title: 'New plan', cwd: '/workspace/project' }),
    '/workspace/current.jsonl',
  );
  assert.equal((created.result.creation as Record<string, unknown>).status, 'created');
  assert.equal((created.result.configuration as Record<string, unknown>).status, 'succeeded');
  assert.deepEqual(created.result.message, { status: 'not_requested' });
  assert.equal(server.workerRuntimeRouter?.getRoute('/workspace/new.jsonl').state, 'cold');
  assert.deepEqual(requests.map((entry) => entry.method), [
    'session.create', 'settings.set', 'systemPromptToggles.set',
  ]);
  assert.deepEqual(requests[0]?.params, {
    // The required create title is part of the delegated mutation intent and
    // of the create operation identity.
    title: 'New plan',
    cwd: '/workspace/project', agentCreated: true,
    operationId: 'agent-session:control-create', operationAttempt: 1,
  });
  assert.deepEqual(requests[1]?.params, {
    sessionPath: '/workspace/new.jsonl',
    persistenceScope: 'session',
    defaultModel: 'gpt-test', defaultProvider: 'openai', defaultThinkingLevel: 'high',
  });
});

test('coordinator ingress strips forged attribution before the authenticated worker route', async () => {
  const server = serverForTests();
  const routed: unknown[] = [];
  (server as unknown as { workerRuntimeRouter: unknown }).workerRuntimeRouter = {
    getRoute: () => ({ state: 'cold' }),
    operationCancellationGeneration: () => 0,
    route: async (request: unknown) => { routed.push(request); return { requestId: 'accepted' }; },
  };
  await server.handleRequest({
    id: 'public-send', method: 'message.send', params: {
      sessionPath: '/workspace/target.jsonl', text: 'user text', inputs: [],
      localId: 'agent-session:forged', coordinatorAttribution: currentSender,
    },
  });
  assert.equal((routed[0] as { params: Record<string, unknown> }).params.coordinatorAttribution, undefined);
});

test('hot session-control settings and create cwd capture use durable metadata under the real hot lease', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-hot-durable-capture-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const currentHeader = {
    type: 'session', version: 3, cwd: '/durable/project', timestamp: '2026-01-01T00:00:00.000Z', id: 'sid-current',
  };
  await fs.writeFile(currentPath, `${JSON.stringify(currentHeader)}\n`, 'utf8');
  let hasDurableReasoning = true;
  let contextThinkingLevel = 'minimal';
  const durableManager = {
    getCwd: () => '/durable/project',
    getBranch: () => [
      { type: 'model_change', id: 'model-change' },
      ...(hasDurableReasoning ? [{ type: 'thinking_level_change', id: 'thinking-change' }] : []),
    ],
    buildSessionContext: () => ({
      messages: [], thinkingLevel: contextThinkingLevel,
      model: { provider: 'saved-provider', modelId: 'saved-model' },
    }),
  };
  let managerOpens = 0;
  const leases = new ColdSessionLeaseAuthority(1);
  const store = new ColdSessionStore({
    sdk: { SessionManager: { open: () => { managerOpens += 1; return durableManager; } } } as never,
    coordinatorGeneration: 1,
    startupCwd: '/startup',
    agentDir: dir,
    leaseAuthority: leases,
  });
  const [hotReservation] = leases.reserveCanonicalPaths(
    [currentPath], 'test:hot-session-control', { hideFromCatalog: false },
  );
  const internal = server as unknown as {
    initializeColdSessionStore(): ColdSessionStore;
    readModelSettings(): Promise<unknown>;
  };
  internal.initializeColdSessionStore = () => store;
  internal.readModelSettings = async () => ({
    defaultModel: 'fresh-default-model', defaultProvider: 'fresh-default-provider', defaultThinkingLevel: 'low',
  });
  const sourceBefore = await fs.readFile(currentPath, 'utf8');
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    return request.method === 'session.create'
      ? { sessionPath: '/workspace/new.jsonl', title: 'Durable cwd' }
      : mockSettingsReply(request);
  };

  const inspected = await server.handleWorkerSessionControl(frame('settings.get', { self: true }), currentPath);
  assert.deepEqual((inspected.result.settings as Record<string, unknown>).model, {
    provider: 'saved-provider', id: 'saved-model',
  });
  assert.equal((inspected.result.settings as Record<string, unknown>).reasoning, 'minimal',
    'an explicit durable reasoning entry wins over the fresh default and worker-applied state');
  assert.equal(managerOpens, 1);

  hasDurableReasoning = false;
  contextThinkingLevel = 'off';
  const defaulted = await server.handleWorkerSessionControl(frame('settings.get', { self: true }), currentPath);
  assert.equal((defaulted.result.settings as Record<string, unknown>).reasoning, 'low',
    'without an explicit durable entry the fresh saved default wins over the SDK context fallback');
  assert.equal(managerOpens, 2);

  await server.handleWorkerSessionControl(frame('create', { title: 'Durable cwd' }), currentPath);
  assert.equal((requests[0]?.params as { cwd?: string }).cwd, '/durable/project');
  const settingsWrite = requests.find((request) => request.method === 'settings.set')?.params as Record<string, unknown>;
  assert.equal(settingsWrite.defaultModel, 'saved-model');
  assert.equal(settingsWrite.defaultProvider, 'saved-provider');
  assert.equal(settingsWrite.defaultThinkingLevel, 'low');
  assert.equal(managerOpens, 3, 'create captures durable settings and cwd in one hot read');
  assert.equal(await fs.readFile(currentPath, 'utf8'), sourceBefore, 'the hot-owned source transcript remains read-only');

  leases.releaseCanonicalPaths([hotReservation]);
  assert.ok(events.some((entry) => entry.event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT));
});

test('create inheritance failure explicitly reports that no session was created', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-preflight-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const internal = server as unknown as { captureSessionControlSettings(path: string): Promise<never> };
  internal.captureSessionControlSettings = async () => { throw new Error('saved settings unavailable'); };
  const writes: string[] = [];
  server.handleRequest = async (request) => { writes.push(request.method); return {}; };
  const result = await server.handleWorkerSessionControl(frame('create', {
    title: 'Preflight failed', prompt: 'must not send',
  }), currentPath);
  assert.equal((result.result.creation as { status: string }).status, 'not_created');
  assert.equal((result.result.configuration as { status: string }).status, 'not_started');
  assert.equal((result.result.message as { status: string }).status, 'not_sent');
  assert.deepEqual(writes, []);
});

test('agent create rejects unconfigured providers before durable creation', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-providers-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const writes: string[] = [];
  server.handleRequest = async (request) => { writes.push(request.method); return {}; };
  await assert.rejects(server.handleWorkerSessionControl(frame('create', {
    title: 'Provider test', settings: { subagentProviderChoices: { forged: true } },
  }), currentPath), (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  assert.deepEqual(writes, []);
});

test('agent create inherits durable cwd rather than stale host or startup cwd', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-cwd-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  applyMembership(server, membership([membershipEntry(currentPath, { cwd: '/stale/host' })]));
  const internals = server as unknown as {
    initializeColdSessionStore(): { readDurableSessionMetadata(path: string, modelSettings: unknown): Promise<unknown> };
  };
  internals.initializeColdSessionStore = () => ({ readDurableSessionMetadata: async () => ({
    cwd: '/durable/project', modelId: 'gpt-test', provider: 'openai', thinkingLevel: 'high',
  }) });
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    return request.method === 'session.create' ? { sessionPath: '/workspace/new.jsonl', title: 'Durable cwd' } : {};
  };
  await server.handleWorkerSessionControl(frame('create', { title: 'Durable cwd' }), currentPath);
  assert.equal((requests[0]?.params as { cwd?: string }).cwd, '/durable/project');
});

test('created session-control sends stop after confirmed close during gated configuration', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-close-config-race-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const targetPath = '/workspace/created-race.jsonl';
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  const internal = server as unknown as {
    captureSessionControlSettings(path: string): Promise<unknown>;
    assertSessionControlModelAvailable(model: unknown): Promise<void>;
    configureSessionControlSettings(path: string, patch: unknown, requestId: string): Promise<Record<string, unknown>>;
    retainColdSessionManager(handle: unknown, creationReason: 'new'): void;
    newCreatePublicationPaths: Set<string>;
    coldManagerKey(path: string): string;
    liveSessionTitles: {
      reserve(title: string, entry: { sessionPath: string; sessionId: string }): unknown;
      confirm(reservation: unknown): void;
    };
    acknowledgeHostCloseRequest(params: unknown): Promise<unknown>;
    closingSessionRequests: Map<string, unknown>;
  };
  internal.captureSessionControlSettings = async () => ({
    settings: {
      model: { provider: 'openai', id: 'gpt-test' },
      reasoning: 'high',
      autonomousMode: true,
      subagentProviderChoices: { openai: true },
      disabledSystemPromptEntries: [],
    },
    cwd: '/workspace',
  });
  internal.assertSessionControlModelAvailable = async () => undefined;
  let markConfigurationStarted!: () => void;
  let releaseConfiguration!: () => void;
  const configurationStarted = new Promise<void>((resolve) => { markConfigurationStarted = resolve; });
  const configurationGate = new Promise<void>((resolve) => { releaseConfiguration = resolve; });
  internal.configureSessionControlSettings = async () => {
    markConfigurationStarted();
    await configurationGate;
    return { status: 'succeeded', applied: ['model', 'reasoning', 'hostExecutionSettings'] };
  };

  let sends = 0;
  server.handleRequest = async (request) => {
    if (request.method === 'session.create') {
      internal.retainColdSessionManager({ sessionPath: targetPath, manager: { getCwd: () => '/workspace' } }, 'new');
      const reservation = internal.liveSessionTitles.reserve('Created race', {
        sessionPath: targetPath,
        sessionId: 'created-race-id',
      });
      internal.liveSessionTitles.confirm(reservation);
      internal.newCreatePublicationPaths.add(internal.coldManagerKey(targetPath));
      return { sessionPath: targetPath, title: 'Created race' };
    }
    if (request.method === 'message.send') sends += 1;
    return { accepted: true };
  };

  const creating = server.handleWorkerSessionControl(frame('create', {
    title: 'Created race', prompt: 'send only if still live',
  }), currentPath);
  await configurationStarted;
  const closing = server.handleWorkerSessionControl(frame('close', { title: 'Created race' }), currentPath);
  applyMembership(server, membership(
    [membershipEntry(currentPath), membershipEntry(idlePath)],
    [closeFrameEntry(targetPath)],
  ));
  await internal.acknowledgeHostCloseRequest({
    sessionPath: targetPath, requestId: 'control-close:close', phase: 'accepted',
  });
  await internal.acknowledgeHostCloseRequest({
    sessionPath: targetPath, requestId: 'control-close:close', phase: 'completed',
  });
  assert.equal((await closing).result.closed, true);
  assert.equal(internal.closingSessionRequests.size, 0, 'the durable close acknowledgement releases its request fence');
  // Reopening the same durable path before the config gate releases must not
  // make the earlier create's pending prompt look like a new operation.
  applyMembership(server, membership([
    membershipEntry(currentPath), membershipEntry(idlePath), membershipEntry(targetPath),
  ]));

  releaseConfiguration();
  const outcome = await creating;
  assert.equal((outcome.result.creation as Record<string, unknown>).status, 'created');
  assert.equal((outcome.result.configuration as Record<string, unknown>).status, 'succeeded');
  assert.equal((outcome.result.message as Record<string, unknown>).status, 'rejected');
  assert.equal(sends, 0, 'the pre-close prompt is not routed after same-path reopen');
  assert.equal(events.filter((entry) => entry.event === 'message.agent').length, 0,
    'the rejected pre-admission send does not publish a transcript row');

  const reopenedSend = await server.handleWorkerSessionControl(frame('message', {
    title: 'Created race', prompt: 'fresh operation after reopen',
  }), currentPath);
  assert.equal((reopenedSend.result.message as Record<string, unknown>).status, 'accepted');
  assert.equal(sends, 1, 'a fresh operation uses the reopened path normally');
  const messageRows = events.filter((entry) => entry.event === 'message.agent');
  assert.deepEqual(messageRows.map((entry) => (entry.payload as { status: string }).status), ['queued', 'completed']);
  assert.ok(messageRows.every((entry) => (
    (entry.payload as { text: string }).text === 'fresh operation after reopen'
  )));
});

test('unrelated membership removal does not cancel a gated session-control send', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-independent-close-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  server.emit = () => undefined;
  const internal = server as unknown as {
    configureSessionControlSettings(path: string, patch: unknown, requestId: string): Promise<Record<string, unknown>>;
  };
  let markConfigurationStarted!: () => void;
  let releaseConfiguration!: () => void;
  const configurationStarted = new Promise<void>((resolve) => { markConfigurationStarted = resolve; });
  const configurationGate = new Promise<void>((resolve) => { releaseConfiguration = resolve; });
  internal.configureSessionControlSettings = async () => {
    markConfigurationStarted();
    await configurationGate;
    return { status: 'succeeded', applied: ['reasoning'] };
  };
  let sends = 0;
  server.handleRequest = async () => { sends += 1; return { accepted: true }; };
  const generation = server.workerRuntimeRouter!.operationCancellationGeneration!(currentPath);
  const sending = server.handleWorkerSessionControl(frame('message', {
    self: true, prompt: 'unaffected send', settings: { reasoning: 'low' },
  }), currentPath);
  await configurationStarted;

  // A different session leaves membership while this target remains live.
  applyMembership(server, membership([membershipEntry(currentPath)]));
  assert.equal(server.workerRuntimeRouter!.operationCancellationGeneration!(currentPath), generation);
  releaseConfiguration();

  const outcome = await sending;
  assert.equal((outcome.result.message as Record<string, unknown>).status, 'accepted');
  assert.equal(sends, 1);
});

test('combined create captures settings once, honors explicit overrides, then sends with attribution', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-combined-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const requests: Array<{ method: string; params?: unknown }> = [];
  const createdPath = '/workspace/combined.jsonl';
  const coordinator = server as unknown as {
    retainColdSessionManager(handle: unknown, creationReason: 'new'): void;
    newCreatePublicationPaths: Set<string>;
    coldManagerKey(path: string): string;
    liveSessionTitles: {
      reserve(title: string, entry: { sessionPath: string; sessionId: string }): unknown;
      confirm(reservation: unknown): void;
    };
  };
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method !== 'session.create') return mockSettingsReply(request);
    coordinator.retainColdSessionManager({ sessionPath: createdPath, manager: { getCwd: () => '/workspace' } }, 'new');
    const reservation = coordinator.liveSessionTitles.reserve('Combined worker', {
      sessionPath: createdPath, sessionId: 'combined-worker-id',
    });
    coordinator.liveSessionTitles.confirm(reservation);
    coordinator.newCreatePublicationPaths.add(coordinator.coldManagerKey(createdPath));
    return { ok: true, sessionPath: createdPath, title: 'Combined worker' };
  };

  const outcome = await server.handleWorkerSessionControl(frame('create', {
    title: 'Combined worker',
    prompt: 'start after configuration',
    settings: {
      reasoning: 'low',
      autonomousMode: false,
      disabledSystemPromptEntries: ['override-entry'],
    },
  }), currentPath);

  assert.equal((outcome.result.creation as Record<string, unknown>).status, 'created');
  assert.equal((outcome.result.configuration as Record<string, unknown>).status, 'succeeded');
  assert.equal((outcome.result.message as Record<string, unknown>).status, 'accepted');
  assert.deepEqual(requests.map((request) => request.method), [
    'session.create', 'settings.set', 'systemPromptToggles.set', 'message.send',
  ]);
  assert.deepEqual(requests[1]?.params, {
    sessionPath: '/workspace/combined.jsonl',
    persistenceScope: 'session',
    defaultModel: 'gpt-test', defaultProvider: 'openai', defaultThinkingLevel: 'low',
  });
  assert.deepEqual(requests[2]?.params, {
    sessionPath: '/workspace/combined.jsonl', disabledEntries: ['override-entry'],
  });
  assert.deepEqual((requests[3]?.params as Record<string, unknown>).coordinatorAttribution, currentSender);
  const settingsRequests = events
    .filter((entry) => entry.event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT)
    .map((entry) => entry.payload as SessionControlSettingsRequest);
  assert.deepEqual(settingsRequests.map((request) => request.action), ['capture', 'apply']);
  assert.deepEqual(settingsRequests[1]?.settings, {
    autonomousMode: false,
    subagentProviderChoices: { openai: true },
  });
  assert.deepEqual(events.filter((entry) => entry.event === 'message.agent').map((entry) => (
    (entry.payload as Record<string, unknown>).sender
  )), [currentSender, currentSender]);
});

test('message settings require confirmed effective reasoning before sending', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-reasoning-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const requests: string[] = [];
  server.handleRequest = async (request) => { requests.push(request.method); return { accepted: true }; };
  const outcome = await server.handleWorkerSessionControl(frame('message', {
    self: true, prompt: 'do not send without confirmation', settings: { reasoning: 'low' },
  }), currentPath);
  assert.equal((outcome.result.configuration as { status?: string }).status, 'unknown');
  assert.equal((outcome.result.message as { status?: string }).status, 'not_sent');
  assert.deepEqual(requests, ['settings.set']);
});

for (const scenario of [
  { method: 'settings.set', settings: { reasoning: 'low' }, failedSetting: 'reasoning' },
  { method: 'systemPromptToggles.set', settings: { disabledSystemPromptEntries: ['optional'] }, failedSetting: 'disabledSystemPromptEntries' },
]) {
  test(`message configuration reports unknown on ${scenario.method} worker acknowledgement timeout`, async () => {
    const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-settings-timeout-'));
    const { server, currentPath } = await readyServerWithMembers(dir);
    const events: Array<{ event: string; payload?: unknown }> = [];
    installSessionControlSettingsHarness(server, events);
    const requests: string[] = [];
    server.handleRequest = async (request) => {
      requests.push(request.method);
      throw new WorkerRequestTimeoutError(request.id, 'runtime.command', 120000);
    };
    const outcome = await server.handleWorkerSessionControl(frame('message', {
      self: true, prompt: 'do not send after uncertain configuration', settings: scenario.settings,
    }), currentPath);
    assert.equal((outcome.result.configuration as { status?: string }).status, 'unknown');
    assert.equal((outcome.result.configuration as { failedSetting?: string }).failedSetting, scenario.failedSetting);
    assert.deepEqual(outcome.result.message, { status: 'not_sent', reason: 'unknown' });
    assert.deepEqual(requests, [scenario.method]);
    assert.equal(events.filter((entry) => entry.event === 'message.agent').length, 0);
  });
}

test('combined create reports partial configuration failure and never sends after the busy guard rejects settings', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-partial-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const requests: string[] = [];
  server.handleRequest = async (request) => {
    requests.push(request.method);
    if (request.method === 'session.create') return { ok: true, sessionPath: '/workspace/partial.jsonl' };
    if (request.method === 'settings.set') throw new Error('target is busy');
    return { accepted: true };
  };
  const outcome = await server.handleWorkerSessionControl(frame('create', {
    title: 'Partial worker', prompt: 'must not be sent',
  }), currentPath);
  assert.equal((outcome.result.creation as Record<string, unknown>).status, 'created');
  assert.equal((outcome.result.configuration as Record<string, unknown>).status, 'failed');
  assert.deepEqual((outcome.result.configuration as Record<string, unknown>).applied, []);
  assert.deepEqual(outcome.result.message, { status: 'not_sent', reason: 'failed' });
  assert.deepEqual(requests, ['session.create', 'settings.set']);
  assert.equal(events.filter((entry) => entry.event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT).length, 1,
    'host preferences are not written after the earlier settings guard rejects');
});

test('create validates the complete explicit settings patch before durable creation or capture', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-prevalidate-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  let requests = 0;
  server.handleRequest = async () => { requests += 1; return { ok: true }; };
  await assert.rejects(server.handleWorkerSessionControl(frame('create', {
    title: 'Invalid worker',
    settings: { reasoning: 'unsupported' },
  }), currentPath), (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  assert.equal(requests, 0);
  assert.deepEqual(events, []);
});

test('settings inspection and update use target-session settings authorities', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-settings-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => { requests.push(request); return mockSettingsReply(request); };

  const inspected = await server.handleWorkerSessionControl(
    frame('settings.get', { title: 'Idle plan' }), currentPath,
  );
  assert.equal(inspected.result.sessionPath, idlePath);
  assert.deepEqual(inspected.result.settings, {
    model: { provider: 'openai', id: 'gpt-test' },
    reasoning: 'high',
    autonomousMode: true,
    subagentProviderChoices: { openai: true },
    disabledSystemPromptEntries: [],
  });

  const updated = await server.handleWorkerSessionControl(frame('settings.set', {
    self: true,
    settings: { reasoning: 'low', autonomousMode: false },
  }), currentPath);
  assert.equal((updated.result.configuration as Record<string, unknown>).status, 'succeeded');
  assert.deepEqual(requests, [{
    id: 'control-settings.set:model-settings', method: 'settings.set',
    params: { sessionPath: currentPath, persistenceScope: 'session', defaultThinkingLevel: 'low' },
  }]);
  const apply = events
    .map((entry) => entry.payload as SessionControlSettingsRequest | undefined)
    .find((request) => request?.action === 'apply');
  assert.deepEqual(apply?.settings, { autonomousMode: false });
});

test('replyTo resolves the live original identity and rejects stale references', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-reply-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => { requests.push(request); return { accepted: true }; };
  const idleReplyReference = createSessionControlSender(
    { sessionId: 'sid-idle.jsonl', identityFallback: false }, 'Idle plan',
  ).replyReference;

  const sent = await server.handleWorkerSessionControl(frame('message', {
    replyTo: idleReplyReference, prompt: 'reply to the original sender',
  }), currentPath);
  assert.equal((sent.result.message as Record<string, unknown>).status, 'accepted');
  assert.equal((requests[0]?.params as Record<string, unknown>).sessionPath, idlePath);
  assert.deepEqual((requests[0]?.params as Record<string, unknown>).coordinatorAttribution, currentSender);

  applyMembership(server, membership([membershipEntry(currentPath)]));
  await assert.rejects(server.handleWorkerSessionControl(frame('message', {
    replyTo: idleReplyReference, prompt: 'stale reply',
  }), currentPath), (error: { code?: string }) => error.code === 'SESSION_NOT_FOUND');
  assert.equal(requests.length, 1);
  assert.equal((events[0]?.payload as Record<string, unknown>).sender !== undefined, true);
});

test('agent create fails closed while the title namespace is not hydrated', async () => {
  const server = serverForTests();
  server.handleRequest = async () => {
    throw new Error('a session must never be created without a hydrated title namespace');
  };

  await assert.rejects(
    server.handleWorkerSessionControl(frame('create', { title: 'New plan' }), '/workspace/current.jsonl'),
    (error: { code?: string }) => error.code === 'LIVE_TITLE_NAMESPACE_UNAVAILABLE',
  );
});

test('a titled create reserves through the title seam and publishes only after assignment', async () => {
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const createCalls: unknown[] = [];
  const assigned: Array<{ sessionPath: string; baseTitle: string }> = [];
  const deps = {
    startupCwd: '/startup',
    sdkPath: '/sdk',
    agentDir: '/agent',
    createColdSession: (cwd: string) => {
      createCalls.push(cwd);
      return { sessionPath: '/workspace/new.jsonl' };
    },
    buildSessionOpenedPayload: async (sessionPath: string) => ({
      sessionPath,
      runtimeReady: false,
    }),
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
    emitSessionListChanged: async () => undefined,
    setViewedSessionPath: () => undefined,
    // The coordinator seam resolves uniqueness against the live authority;
    // record the call so reservation → persistence → completion stays
    // observable inside the create flow.
    assignCreatedSessionTitle: async (sessionPath: string, baseTitle: string) => {
      assigned.push({ sessionPath, baseTitle });
      return { assigned: true, title: baseTitle === 'Occupied' ? 'Occupied (2)' : baseTitle };
    },
  } as unknown as BackendRequestHandlerDeps;

  const created = await handleBackendRequest(deps, {
    id: 'create-titled',
    method: 'session.create',
    params: { cwd: '/workspace/project', title: 'New plan', operationId: 'op-titled', operationAttempt: 1 },
  }) as Record<string, unknown>;
  assert.deepEqual(created, { ok: true, sessionPath: '/workspace/new.jsonl', title: 'New plan' });
  assert.deepEqual(createCalls, ['/workspace/project']);
  assert.deepEqual(assigned, [{ sessionPath: '/workspace/new.jsonl', baseTitle: 'New plan' }]);
  // The assigned title is durable-persisted before the created session is
  // ever published (session.opened carries the finalized name context).
  assert.equal((emitted[0]?.payload as { sessionPath?: string }).sessionPath, '/workspace/new.jsonl');
});

test('a failed create title assignment fails closed instead of publishing a nameless tab', async () => {
  const deps = {
    startupCwd: '/startup',
    sdkPath: '/sdk',
    agentDir: '/agent',
    createColdSession: () => ({ sessionPath: '/workspace/new.jsonl' }),
    buildSessionOpenedPayload: async (sessionPath: string) => ({
      sessionPath,
      runtimeReady: false,
    }),
    emit: () => undefined,
    emitSessionListChanged: async () => undefined,
    setViewedSessionPath: () => undefined,
    assignCreatedSessionTitle: async () => ({ assigned: false, error: 'LIVE_TITLE_RESERVATION_FAILED: namespace unavailable' }),
  } as unknown as BackendRequestHandlerDeps;

  await assert.rejects(handleBackendRequest(deps, {
    id: 'create-titled-fail',
    method: 'session.create',
    params: { cwd: '/workspace/project', title: 'New plan' },
  }), (error: { code?: string }) => error.code === 'LIVE_TITLE_ASSIGNMENT_FAILED');
});

test('a ledger-committed create cannot acknowledge or republish before its required title is assigned', async () => {
  let created = 0;
  let emitted = 0;
  let canAssign = false;
  const deps = {
    startupCwd: '/startup', sdkPath: '/sdk', agentDir: '/agent',
    createColdSession: () => { created += 1; return { sessionPath: '/workspace/new.jsonl' }; },
    assignCreatedSessionTitle: async () => canAssign
      ? { assigned: true, title: 'Review' }
      : { assigned: false, error: 'injected persistence failure' },
    buildSessionOpenedPayload: async (sessionPath: string) => ({ session: { path: sessionPath } }),
    emit: () => { emitted += 1; },
    emitSessionListChanged: async () => undefined,
    setViewedSessionPath: () => undefined,
  } as unknown as BackendRequestHandlerDeps;
  const request = {
    id: 'ledger-title', method: 'session.create',
    params: { title: 'Review', operationId: 'op-ledger-title' },
  };
  await assert.rejects(handleBackendRequest(deps, request), /injected persistence failure/);
  assert.equal(emitted, 0);
  canAssign = true;
  const retry = await handleBackendRequest(deps, request) as { sessionPath: string; title: string };
  assert.equal(retry.title, 'Review');
  assert.equal(created, 1);
  assert.equal(emitted, 1);
});

test('create validation rejects an overlong title before any durable session exists', async () => {
  const deps = {
    startupCwd: '/startup',
    sdkPath: '/sdk',
    agentDir: '/agent',
    createColdSession: () => {
      throw new Error('no durable creation may happen for an invalid title');
    },
  } as unknown as BackendRequestHandlerDeps;

  await assert.rejects(
    handleBackendRequest(deps, {
      id: 'create-titled-invalid',
      method: 'session.create',
      params: { cwd: '/workspace/project', title: 'x'.repeat(30) },
    }),
    (error: { code?: string }) => error.code === 'INVALID_PARAMS',
  );
});

test('session-control server addresses a newly created retained cold session despite a stale warm catalog', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-live-'));
  const { server } = await readyServerWithMembers(dir);
  const newSessionPath = '/workspace/new.jsonl';
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const coordinator = server as unknown as {
    retainColdSessionManager(handle: { sessionPath: string; manager: { getCwd(): string } }, creationReason: 'new'): void;
    newCreatePublicationPaths: Set<string>;
    coldManagerKey(path: string): string;
    liveSessionTitles: {
      reserve(base: string, entry: { sessionPath: string; sessionId: string }): unknown;
      confirm(reservation: unknown): void;
    };
  };
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method === 'session.closeAcknowledgement') {
      // Route the typed close bridge ack through the real coordinator handler.
      return await (BackendServer.prototype as unknown as {
        handleRequest(request: { id: string; method: string; params?: unknown }): Promise<unknown>;
      }).handleRequest.call(server, request);
    }
    if (request.method === 'session.create') {
      // Mirror the normal coordinator create callback: the durable cold-store
      // handle is authoritative before the create acknowledgement is returned.
      coordinator.retainColdSessionManager({ sessionPath: newSessionPath, manager: { getCwd: () => '/workspace' } }, 'new');
      // Mirror the create-flow assignment: reserve → confirm.
      const reservation = coordinator.liveSessionTitles.reserve('New plan', { sessionPath: newSessionPath, sessionId: 'sid-new' });
      coordinator.liveSessionTitles.confirm(reservation);
      coordinator.newCreatePublicationPaths.add(coordinator.coldManagerKey(newSessionPath));
      return { ok: true, sessionPath: newSessionPath, title: 'New plan' };
    }
    return mockSettingsReply(request);
  };

  const created = await server.handleWorkerSessionControl(
    frame('create', { title: 'New plan' }),
    '/workspace/current.jsonl',
  );
  assert.equal((created.result.creation as Record<string, unknown>).sessionPath, newSessionPath);
  assert.equal((created.result.configuration as Record<string, unknown>).status, 'succeeded');
  const gapList = await server.handleWorkerSessionControl(frame('list'), '/workspace/current.jsonl');
  assert.equal(((gapList.result.sessions as Array<{ title: string }>).find((row) => row.title === 'New plan'))?.title, 'New plan');

  // The assigned title is the address for the publication-gap cold session.
  await server.handleWorkerSessionControl(
    frame('message', { title: 'New plan', prompt: 'wake the new session' }),
    '/workspace/current.jsonl',
  );
  const closeControl = server.handleWorkerSessionControl(
    frame('close', { title: 'New plan' }),
    '/workspace/current.jsonl',
  );
  // The cold target session is a cross-session close: the typed bridge waits
  // for the hosted stop/cleanup confirmation before resolving.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.handleRequest({
    id: 'ack-accepted',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: newSessionPath, requestId: 'control-close:close', phase: 'accepted' },
  });
  await server.handleRequest({
    id: 'ack-completed',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: newSessionPath, requestId: 'control-close:close', phase: 'completed' },
  });
  const closed = await closeControl;

  const createAndMessageRequests = requests.filter((request) => request.method !== 'session.closeAcknowledgement');
  assert.deepEqual(createAndMessageRequests.map((request) => request.method), [
    'session.create', 'settings.set', 'systemPromptToggles.set', 'message.send',
  ]);
  assert.equal((createAndMessageRequests[3]?.params as { sessionPath: string }).sessionPath, newSessionPath);
  assert.ok(events.some((entry) => entry.event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT));
  assert.equal(closed.result.closed, true);
});

test('session-control server adapts transcript cursors and ordinary message sends', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-msg-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const requests: Array<{ method: string; params?: unknown }> = [];
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  server.handleRequest = async (request) => {
    requests.push(request);
    if (request.method === 'session.loadTranscriptPage') {
      return {
        sessionPath: idlePath,
        transcript: [
          { id: 'old', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', markdown: 'old', status: 'completed' },
          { id: 'new', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', markdown: 'new', status: 'completed' },
        ],
        transcriptWindow: {
          totalCount: 10, loadedStart: 4, loadedEnd: 6,
          hasOlder: true, hasNewer: true, isPartial: true, hasUserMessages: true,
        },
        busy: false,
      } satisfies TranscriptPagePayload;
    }
    return { accepted: true };
  };

  const page = await server.handleWorkerSessionControl(
    frame('read', {
      title: 'Idle plan', direction: 'newer', cursor: { start: 0, end: 4 }, limit: 1,
    }),
    currentPath,
  );
  assert.deepEqual(page.result.cursor, { start: 4, end: 5 });
  assert.equal(requests[0]?.method, 'session.loadTranscriptPage');
  assert.deepEqual(requests[0]?.params, {
    sessionPath: idlePath, direction: 'newer', loadedStart: 0, loadedEnd: 4,
  });

  // An assigned title addresses another live session even while this caller
  // is itself live; `self` would have targeted the caller instead.
  await server.handleWorkerSessionControl(
    frame('message', { title: 'Idle plan', prompt: 'please continue' }),
    currentPath,
  );
  assert.equal(requests[1]?.method, 'message.send');
  assert.deepEqual(requests[1]?.params, {
    sessionPath: idlePath, text: 'please continue', inputs: [],
    operationId: 'agent-session:control-message', operationAttempt: 1,
    localId: 'local:agent-session:control-message',
    coordinatorAttribution: currentSender,
  });
  assert.equal(events[0]?.event, 'message.agent');
  const pendingMessage = events[0]?.payload as {
    sessionPath: string; localId: string; text: string; sender: unknown; status: string; timestamp: number;
  };
  const acceptedMessage = events[1]?.payload as typeof pendingMessage;
  assert.deepEqual({ ...pendingMessage, timestamp: undefined }, {
    sessionPath: idlePath,
    localId: 'local:agent-session:control-message',
    text: 'please continue',
    sender: currentSender,
    status: 'queued',
    timestamp: undefined,
  });
  assert.equal(acceptedMessage.status, 'completed');
  assert.equal(acceptedMessage.localId, pendingMessage.localId);
  assert.equal(acceptedMessage.timestamp, pendingMessage.timestamp);
});

test('a route promoted before agent send acceptance reconciles to direct delivery', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-promote-'));
  const { server, idlePath } = await readyServerWithMembers(dir);
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: 'promoting' }),
  };
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  let acceptSend!: (result: unknown) => void;
  let markSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
  server.handleRequest = async () => {
    markSendStarted();
    return await new Promise((resolve) => { acceptSend = resolve; });
  };

  const sending = server.handleWorkerSessionControl(
    frame('message', { title: 'Current plan', prompt: 'send after promotion' }),
    idlePath,
  );
  await sendStarted;
  assert.deepEqual(events.map(({ payload }) => (payload as { status: string }).status), ['queued']);
  acceptSend({ requestId: 'direct-request' });
  await sending;

  assert.deepEqual(events.map(({ payload }) => (payload as { status: string }).status), [
    'queued', 'completed',
  ]);
  assert.equal((events[0]?.payload as { localId: string }).localId,
    (events[1]?.payload as { localId: string }).localId);
});

test('session-control message rows reflect queued delivery and roll back rejected sends', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-rows-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: 'hot', checkpoint: { requestId: 'active-request' } }),
  };
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  server.handleRequest = async () => ({ queued: true });

  await server.handleWorkerSessionControl(
    frame('message', { title: 'Current plan', prompt: 'queued message' }),
    currentPath,
  );
  assert.equal((events[0]?.payload as { status: string }).status, 'queued');

  server.handleRequest = async () => { throw new Error('send rejected'); };
  const rejected = await server.handleWorkerSessionControl(
    { requestId: 'control-message-rejected', action: 'message', payload: { title: 'Idle plan', prompt: 'rejected message' } },
    currentPath,
  );
  assert.equal((rejected.result.message as Record<string, unknown>).status, 'rejected');
  assert.equal((events[1]?.payload as { status: string }).status, 'queued');
  assert.equal((events[2]?.payload as { status: string }).status, 'rejected');
  assert.equal((events[1]?.payload as { localId: string }).localId, (events[2]?.payload as { localId: string }).localId);

  const runtimeError = serializeRuntimeCommandError(Object.assign(
    new Error('sender durability unconfirmed'),
    { code: 'AGENT_MESSAGE_PROVENANCE_UNAVAILABLE' },
  ));
  assert.equal(serializeRuntimeCommandError(Object.assign(new Error('other failure'), {
    code: 'ARBITRARY_BACKEND_ERROR',
  })).code, 'RUNTIME_COMMAND_FAILED', 'worker-entry does not pass through arbitrary backend codes');
  assert.equal(serializeRuntimeCommandError(Object.assign(new Error('intent changed'), {
    code: 'OPERATION_INTENT_MISMATCH',
  })).code, 'OPERATION_INTENT_MISMATCH', 'the existing explicit worker error remains preserved');
  const workerResponse = parseWorkerToCoordinatorFrame({
    ipcVersion: WORKER_IPC_VERSION,
    coordinatorGeneration: 1,
    workerId: 'worker-provenance-test',
    workerGeneration: 1,
    workerPid: process.pid,
    rootSessionPath: currentPath,
    leasePath: currentPath,
    leaseRevision: 1,
    sessionPath: currentPath,
    seq: 1,
    kind: 'response',
    requestId: 'runtime-command-provenance',
    ok: false,
    error: runtimeError,
  }, {
    coordinatorGeneration: 1,
    workerId: 'worker-provenance-test',
    workerGeneration: 1,
    workerPid: process.pid,
    rootSessionPath: currentPath,
    leasePath: currentPath,
    leaseRevision: 1,
    sessionPath: currentPath,
    expectedSeq: 1,
  });
  assert.equal(workerResponse.status, 'accepted', 'worker-entry serialization is accepted by the closed IPC protocol');
  if (workerResponse.status !== 'accepted' || workerResponse.frame.kind !== 'response' || workerResponse.frame.ok) {
    throw new Error('Expected the serialized worker runtime error response.');
  }
  assert.equal(workerResponse.frame.error.code, 'AGENT_MESSAGE_PROVENANCE_UNAVAILABLE');
  server.handleRequest = async () => {
    throw new BackendError(workerResponse.frame.error.code, workerResponse.frame.error.message);
  };
  const unknown = await server.handleWorkerSessionControl(
    { requestId: 'control-message-unknown', action: 'message', payload: { title: 'Idle plan', prompt: 'possibly admitted' } },
    currentPath,
  );
  assert.equal((unknown.result.message as Record<string, unknown>).status, 'unknown');
  assert.equal((events[3]?.payload as { status: string }).status, 'queued');
  assert.equal(events.length, 4, 'a possibly admitted row must not be falsely rejected');
});

test('worker message acknowledgement timeout reports unknown without rejecting an admitted row', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-timeout-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.emit = (event, payload) => events.push({ event, payload });
  server.handleRequest = async () => { throw new WorkerRequestTimeoutError('send', 'runtime.command', 120000); };
  const outcome = await server.handleWorkerSessionControl(frame('message', {
    title: 'Idle plan', prompt: 'possibly still executing',
  }), currentPath);
  assert.equal((outcome.result.message as { status: string }).status, 'unknown');
  assert.deepEqual(events.filter((entry) => entry.event === 'message.agent')
    .map((entry) => (entry.payload as { status: string }).status), ['queued']);
});

test('session-control reads omit duplicated renderer data and diagnostics before applying the page budget', async () => {
  const server = serverForTests();
  server.handleRequest = async () => ({
    sessionPath: '/workspace/current.jsonl',
    busy: false,
    transcriptWindow: {
      totalCount: 1, loadedStart: 0, loadedEnd: 1,
      hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: true,
    },
    transcript: [{
      id: 'answer', role: 'assistant', status: 'completed', createdAt: '2026-01-01',
      markdown: 'Answer', customDetails: { debug: 'x'.repeat(600_000) },
      toolCalls: [{ id: 'tool', name: 'read', input: {}, status: 'completed', result: 'duplicate' }],
      parts: [
        { kind: 'text', text: 'Answer' },
        { kind: 'toolCall', toolCall: {
          id: 'tool', name: 'read', input: {}, status: 'completed',
          result: { content: [{ type: 'text', text: 'useful output' }], details: { debug: 'x'.repeat(600_000) } },
        } },
      ],
    }],
  });
  const read = await server.handleWorkerSessionControl(frame('read', { self: true, limit: 1 }), '/workspace/current.jsonl');
  const rows = read.result.transcript as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].markdown, '');
  assert.equal(rows[0].toolCalls, undefined);
  assert.equal(rows[0].customDetails, undefined);
  assert.ok(JSON.stringify(rows).includes('useful output'));
  assert.ok(!JSON.stringify(rows).includes('debug'));
  assert.deepEqual(read.result.cursor, { start: 0, end: 1 });
});

test('session-control read pages older and newer rows relative to the caller cursor', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-pages-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const totalCount = 250;
  const transcript = Array.from({ length: totalCount }, (_, index) => ({
    id: `row-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    markdown: `row ${index}`,
    status: 'completed' as const,
  }));
  server.handleRequest = async (request) => {
    if (request.method !== 'session.loadTranscriptPage') return { accepted: true };
    const params = request.params as {
      direction: 'older' | 'newer' | 'latest';
      loadedStart?: number;
      loadedEnd?: number;
    };
    const start = params.direction === 'latest'
      ? totalCount - 60
      : params.direction === 'older'
        ? Math.max(0, (params.loadedStart ?? 0) - 120)
        : (params.loadedStart ?? 0);
    const end = params.direction === 'latest'
      ? totalCount
      : params.direction === 'older'
        ? Math.min(totalCount, params.loadedEnd ?? totalCount)
        : Math.min(totalCount, (params.loadedEnd ?? 0) + 120);
    return {
      sessionPath: '/workspace/idle.jsonl',
      transcript: transcript.slice(start, end),
      transcriptWindow: {
        totalCount,
        loadedStart: start,
        loadedEnd: end,
        hasOlder: start > 0,
        hasNewer: end < totalCount,
        isPartial: start > 0 || end < totalCount,
        hasUserMessages: true,
      },
      busy: false,
    } satisfies TranscriptPagePayload;
  };

  const latest = await server.handleWorkerSessionControl(
    frame('read', { title: 'Idle plan', direction: 'latest', limit: 1 }),
    currentPath,
  );
  assert.deepEqual((latest.result.transcript as Array<{ id: string }>).map((row) => row.id), ['row-249']);
  assert.deepEqual(latest.result.cursor, { start: 249, end: 250 });

  const newestAtEnd = await server.handleWorkerSessionControl(
    frame('read', {
      title: 'Idle plan', direction: 'newer', cursor: latest.result.cursor, limit: 1,
    }),
    currentPath,
  );
  assert.deepEqual(newestAtEnd.result.transcript, []);
  assert.deepEqual(newestAtEnd.result.cursor, { start: 250, end: 250 });

  let olderCursor = latest.result.cursor;
  const olderIds: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    const result = await server.handleWorkerSessionControl(
      frame('read', {
        title: 'Idle plan', direction: 'older', cursor: olderCursor, limit: 1,
      }),
      currentPath,
    );
    olderIds.push(...(result.result.transcript as Array<{ id: string }>).map((row) => row.id));
    olderCursor = result.result.cursor as { start: number; end: number };
  }
  assert.deepEqual(olderIds, ['row-248', 'row-247', 'row-246']);

  let newerCursor = { start: 0, end: 1 };
  const newerIds: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    const result = await server.handleWorkerSessionControl(
      frame('read', {
        title: 'Idle plan', direction: 'newer', cursor: newerCursor, limit: 1,
      }),
      currentPath,
    );
    newerIds.push(...(result.result.transcript as Array<{ id: string }>).map((row) => row.id));
    newerCursor = result.result.cursor as { start: number; end: number };
  }
  assert.deepEqual(newerIds, ['row-1', 'row-2', 'row-3']);
});

test('agent close emits a typed host bridge request and reports acceptance for the caller session', async () => {
  const server = serverForTests();
  const events: Array<{ event: string; payload?: unknown }> = [];
  (server as unknown as { emit(event: string, payload?: unknown): void }).emit = (event, payload) => {
    events.push({ event, payload });
  };
  const closePromise = server.handleWorkerSessionControl(
    frame('close', { self: true, delete: true }),
    '/workspace/current.jsonl',
  );
  for (let tick = 0; tick < 100 && events.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(events.map((entry) => entry.event), ['session.close.requested']);
  const payload = events[0].payload as {
    sessionPath: string; requestId: string; delete: boolean; selfHandoffRequired: boolean;
  };
  assert.equal(payload.sessionPath, '/workspace/current.jsonl');
  assert.ok(payload.requestId.length > 0);
  assert.equal(payload.delete, true);
  assert.equal(payload.selfHandoffRequired, true);
  await server.handleRequest({
    id: 'ack-accepted',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'accepted' },
  });
  const close = await closePromise;
  // Self-close reports close requested, never an already-closed result.
  assert.equal(close.result.closeRequested, true);
  assert.equal(close.result.closed, false);
  assert.equal(close.result.deletionRequested, true);
  assert.equal(events.some((entry) => entry.event === 'session.close.responseDelivered'), false);
  await close.afterResponse?.();
  assert.equal(events.filter((entry) => entry.event === 'session.close.responseDelivered').length, 1);
});

test('self-close source loss releases the host close after the bounded response-handoff timeout', async () => {
  const server = new BackendServer({
    sdkPath: '/sdk', sourceArtifactDescriptor, cwd: '/workspace', workerEntryPath: '/worker.js', hostCloseHandoffTimeoutMs: 10,
  }) as unknown as FakeServer;
  const events: Array<{ event: string; payload?: unknown }> = [];
  (server as unknown as { emit(event: string, payload?: unknown): void }).emit = (event, payload) => {
    events.push({ event, payload });
  };
  const closePromise = server.handleWorkerSessionControl(
    frame('close', { self: true }), '/workspace/current.jsonl',
  );
  for (let tick = 0; tick < 100 && events.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const payload = events[0].payload as { sessionPath: string; requestId: string };
  await server.handleRequest({
    id: 'ack-accepted', method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'accepted' },
  });
  const close = await closePromise;
  assert.equal(close.result.closeRequested, true);
  // Simulate the source worker disappearing before the router can invoke
  // afterResponse; the close-specific fallback must still release host cleanup.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.filter((entry) => entry.event === 'session.close.responseDelivered').length, 1);
  await server.handleRequest({
    id: 'ack-completed', method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'completed' },
  });
});

test('cross-session close resolves with the typed host confirmation and late requests are tolerated', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-xclose-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  (server as unknown as { emit(event: string, payload?: unknown): void }).emit = (event, payload) => {
    events.push({ event, payload });
  };
  const closePromise = server.handleWorkerSessionControl(
    frame('close', { title: 'Idle plan' }),
    currentPath,
  );
  for (let tick = 0; tick < 100 && events.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(events.map((entry) => entry.event), ['session.close.requested']);
  const payload = events[0].payload as {
    sessionPath: string; requestId: string; delete: boolean; selfHandoffRequired: boolean;
  };
  assert.equal(payload.selfHandoffRequired, false);
  await server.handleRequest({
    id: 'ack-accepted',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'accepted' },
  });
  await server.handleRequest({
    id: 'ack-completed',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'completed' },
  });
  const close = await closePromise;
  assert.equal(close.result.closed, true);
  assert.equal(close.result.closeRequested, undefined);
  assert.equal(close.result.deletionRequested, false);

  // Late/unknown ack identities are tolerated by the coordinator bridge.
  const unknown = await server.handleRequest({
    id: 'ack-late',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: '/workspace/idle.jsonl', requestId: 'stale-request', phase: 'completed' },
  });
  assert.deepEqual(unknown, { ok: true, acknowledged: false });
});

test('a cross-session close joins an owning close after target membership reports closing', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-xclose-join-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  (server as unknown as { emit(event: string, payload?: unknown): void }).emit = (event, payload) => {
    events.push({ event, payload });
  };
  const first = server.handleWorkerSessionControl(frame('close', { title: 'Idle plan' }), currentPath);
  for (let tick = 0; tick < 100 && events.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const payload = events[0].payload as { sessionPath: string; requestId: string };
  await server.handleRequest({
    id: 'ack-accepted', method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'accepted' },
  });
  applyMembership(server, membership([membershipEntry(currentPath)], [closeFrameEntry(idlePath)]));

  const generationBeforeJoin = server.workerRuntimeRouter!.operationCancellationGeneration!(idlePath);
  let repeatSettled = false;
  const repeat = server.handleWorkerSessionControl(frame('close', { title: 'Idle plan' }), currentPath)
    .then((outcome) => { repeatSettled = true; return outcome; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(repeatSettled, false, 'a cross-close join waits for the owning terminal outcome');
  assert.equal(server.workerRuntimeRouter!.operationCancellationGeneration!(idlePath), generationBeforeJoin,
    'a join does not invalidate the owner generation a second time');
  assert.equal(events.filter((entry) => entry.event === 'session.close.requested').length, 1);

  await server.handleRequest({
    id: 'ack-completed', method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'completed' },
  });
  assert.equal((await first).result.closed, true);
  assert.equal((await repeat).result.closed, true);
  assert.equal(events.filter((entry) => entry.event === 'session.close.requested').length, 1);
});

test('an accepted self-close keeps its closing fence until the terminal acknowledgement', async () => {
  const server = serverForTests();
  const events: Array<{ event: string; payload?: unknown }> = [];
  (server as unknown as { emit(event: string, payload?: unknown): void }).emit = (event, payload) => {
    events.push({ event, payload });
  };
  const closePromise = server.handleWorkerSessionControl(
    frame('close', { self: true }),
    '/workspace/current.jsonl',
  );
  for (let tick = 0; tick < 100 && events.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const payload = events[0].payload as { sessionPath: string; requestId: string; delete: boolean };
  await server.handleRequest({
    id: 'ack-accepted',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'accepted' },
  });
  const close = await closePromise;
  assert.equal(close.result.closeRequested, true);
  assert.equal(close.result.closed, false);
  assert.equal(events.some((entry) => entry.event === 'session.close.responseDelivered'), false);
  await close.afterResponse?.();

  // Host cleanup is still running: the admission fence and the owning entry
  // stay alive past the self-close return.
  const bridge = (server as unknown as {
    hostCloseRequests: Map<string, unknown>;
    closingSessionRequests: Map<string, unknown>;
    assertSessionNotClosing(sessionPath: string): void;
  });
  assert.equal(bridge.hostCloseRequests.size, 1);
  assert.equal(bridge.closingSessionRequests.size, 1);
  assert.throws(() => bridge.assertSessionNotClosing('/workspace/current.jsonl'), /session is closing/);

  // A repeated close joins the owning entry instead of reissuing the request.
  const repeat = await server.handleWorkerSessionControl(
    frame('close', { self: true }),
    '/workspace/current.jsonl',
  );
  assert.equal(repeat.result.closeRequested, true);
  await repeat.afterResponse?.();
  assert.equal(bridge.hostCloseRequests.size, 1);
  assert.equal(events.filter((entry) => entry.event === 'session.close.requested').length, 1);
  assert.equal(events.filter((entry) => entry.event === 'session.close.responseDelivered').length, 1);

  // The terminal acknowledgement settles exactly once and releases the fence.
  await server.handleRequest({
    id: 'ack-completed',
    method: 'session.closeAcknowledgement',
    params: { sessionPath: payload.sessionPath, requestId: payload.requestId, phase: 'completed' },
  });
  assert.equal(bridge.hostCloseRequests.size, 0);
  assert.equal(bridge.closingSessionRequests.size, 0);
});

test('list exposes assigned titles from the unique authority and never provisional names', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-badges-'));
  const currentPath = await writeSessionFile(dir, 'current.jsonl', 'Current plan');
  // idle.jsonl has a provisional name only: it is never an address.
  const idlePath = await writeSessionFile(dir, 'idle.jsonl');
  const server = serverForTests();
  applyMembership(server, membership([membershipEntry(currentPath), membershipEntry(idlePath)]));
  await hydrate(server);
  const listed = await server.handleWorkerSessionControl(frame('list'), currentPath);
  const rows = listed.result.sessions as Array<Record<string, unknown>>;
  assert.equal(listed.result.titleNamespaceReady, true);
  const currentRow = rows.find((row) => row.path === currentPath);
  const idleRow = rows.find((row) => row.path === idlePath);
  assert.equal(currentRow?.title, 'Current plan');
  assert.ok(currentRow?.name, 'the provisional label stays visible');
  assert.ok(idleRow && !('title' in idleRow));
});