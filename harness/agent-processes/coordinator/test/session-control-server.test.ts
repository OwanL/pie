import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach } from 'node:test';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as pathMod from 'node:path';

import { BackendServer } from '../server.js';
import { createSyntheticSourceTestSdkRuntime } from '../../test/fixtures/sdk-runtime-selection.js';
import { BackendError } from '../server-io.js';
import { handleBackendRequest, type BackendRequestHandlerDeps } from '../request-handler.js';
import type { DelegatedHandoff } from '../../lib/rpc/session-events.js';
import type { SessionEntryLike } from '../../../session-storage/transcripts/transcript.js';
import {
  SESSION_CONTROL_SETTINGS_REQUEST_EVENT,
  type SessionControlSettingsAcknowledgement,
  type SessionControlSettingsRequest,
} from '../../lib/rpc/session-control-settings.js';
import { createSessionControlSender, createSessionReplyReference } from '../../lib/rpc/session-control-attribution.js';
import { createSessionAddress } from '../session-address.js';
import { resolveSessionIdentity } from '../../../session-storage/ownership/session-identity.js';
import { readAgentCreatedSessionCreator } from '../../../session-storage/metadata/session-provenance.js';
import { appendAdmissionFallbackMarker, getAdmissionFallbackTitle } from '../../../session-storage/metadata/session-title.js';
import { ColdSessionLeaseAuthority, ColdSessionStore } from '../../../session-storage/lifecycle/cold-session-store.js';
import { parseWorkerToCoordinatorFrame, WORKER_IPC_VERSION } from '../../lib/rpc/worker-protocol.js';
import { serializeRuntimeCommandError } from '../../workers/worker-entry.js';
import { WorkerRequestTimeoutError } from '../../lib/rpc/worker-client.js';
import { DurableDetailStore } from '../../../session-storage/transcripts/durable-detail-store.js';

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
    hasPendingRuntimeWork?(path: string): boolean;
    hasHotOwner?(path: string): boolean;
  };
};

const ownedServers = new Map<BackendServer, unknown>();

afterEach(async () => {
  const servers = [...ownedServers];
  ownedServers.clear();
  const disposals = await Promise.allSettled(servers.map(async ([server, workerRuntimeRouter]) => {
    const internal = server as unknown as {
      workerRuntimeRouter?: unknown;
      hostCloseRequests: Map<string, { sessionPath: string }>;
      acknowledgeHostCloseRequest(params: {
        sessionPath: string; requestId: string; phase: 'completed';
      }): Promise<unknown>;
    };
    internal.workerRuntimeRouter = workerRuntimeRouter;
    await Promise.all([...internal.hostCloseRequests].map(([requestId, { sessionPath }]) => (
      internal.acknowledgeHostCloseRequest({ sessionPath, requestId, phase: 'completed' })
    )));
    await server.dispose();
  }));
  const failed = disposals.find((disposal) => disposal.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});

function trackServer(server: BackendServer): FakeServer {
  ownedServers.set(server, (server as unknown as { workerRuntimeRouter?: unknown }).workerRuntimeRouter);
  return server as unknown as FakeServer;
}

function serverForTests(): FakeServer {
  return trackServer(new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' }, sdkPath: '/sdk', sourceArtifactDescriptor, cwd: '/workspace', workerEntryPath: '/worker.js' }));
}

function frame(action: string, payload: Record<string, unknown> = {}): unknown {
  return { requestId: `control-${action}`, action, payload: { ...(action === 'message' ? { expectReply: true } : {}), ...payload } };
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
    runtimePrefs: unknown;
    sessionModelCatalog(path: string): Promise<unknown>;
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
  internal.runtimePrefs = { subagentBuckets: { small: [], medium: [], frontier: [] }, providerToggles: {} };
  internal.sessionModelCatalog = async () => ({ ok: true, models: [{
    provider: 'openai', id: 'gpt-test', reasoning: true,
    thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
  }] });
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

function installReadSource(server: FakeServer, entries: readonly SessionEntryLike[]): void {
  (server as unknown as { initializeColdSessionStore(): unknown }).initializeColdSessionStore = () => ({
    readSessionControlSource: () => ({ sessionId: 'read-session', entries }),
  });
}

function textEntry(id: string, text: string, role = 'user'): SessionEntryLike {
  return { type: 'message', id, timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 0 } } as SessionEntryLike;
}

const currentSender = createSessionControlSender(
  { sessionId: 'sid-current.jsonl', identityFallback: false },
  'Current plan',
);

function assertStampedSender(value: unknown, expectReply = true) {
  const sender = value as typeof currentSender;
  assert.deepEqual({ ...sender, message: undefined }, { ...currentSender, message: undefined });
  assert.equal(sender.message?.expectReply, expectReply);
  assert.ok(Number.isSafeInteger(sender.message?.sentAt));
  assert.equal(sender.message?.deliveredAt, undefined);
  return sender;
}

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

/** Model an explicitly durable direct-creator marker for lifecycle mechanics tests. */
function allowDirectCreator(server: FakeServer, creatorPath: string, targetPath: string): void {
  const internal = server as unknown as {
    sessionControlOwnership(path: string, sourcePath: string): Record<string, unknown>;
  };
  const original = internal.sessionControlOwnership.bind(server);
  internal.sessionControlOwnership = (path, sourcePath) => path === targetPath && sourcePath === creatorPath
    ? { ownedByCaller: true }
    : original(path, sourcePath);
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

/** Test owning writer: durable entry-bound markers, with the same replacement
 * guards as the hot/cold owners. Production store durability is covered by its
 * SDK-backed fixtures; these coordinator cases exercise reserve/confirm flow. */
function installTitleWriter(server: FakeServer) {
  const writes: Array<{ sessionPath: string; title: string; options?: { isAdmissionFallback?: boolean; replaceAdmissionFallback?: boolean } }> = [];
  const internal = server as unknown as {
    persistAssignedSessionTitle(path: string, title: string, id: string, expected?: string,
      options?: { isAdmissionFallback?: boolean; replaceAdmissionFallback?: boolean }): Promise<void>;
    emitSessionListChanged(): Promise<void>;
  };
  internal.emitSessionListChanged = async () => undefined;
  internal.persistAssignedSessionTitle = async (sessionPath, title, _id, expected, options) => {
    const entries = (await fs.readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const current = entries.findLast((entry) => entry.type === 'session_info')?.name;
    if (options?.replaceAdmissionFallback
      ? getAdmissionFallbackTitle({ getEntries: () => entries }) !== expected
      : expected !== undefined ? current !== expected : Boolean(current)) {
      throw new BackendError('SESSION_OWNERSHIP_CONFLICT', 'Intervening manual name');
    }
    const row = { type: 'session_info', id: randomUUID(), name: title };
    entries.push(row);
    const appended: unknown[] = [row];
    if (options?.isAdmissionFallback) appendAdmissionFallbackMarker({
      getEntries: () => entries,
      appendCustomEntry: (customType, data) => appended.push({ type: 'custom', customType, data }),
    });
    await fs.appendFile(sessionPath, `${appended.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    writes.push({ sessionPath, title, options });
  };
  return writes;
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
    hasHotOwner: () => false,
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
    frame('create', { bucket: 'medium', title: 'New plan' }), currentPath,
  );
  assert.equal((created.result.creation as Record<string, unknown>).status, 'created');
  assert.ok(requests.some((request) => request.method === 'session.create'));

  release();
  await internal.titleAdmission;
});

test('background title admission backs off unreadable members without starving later titles and recovers', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-admission-backoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const badPath = pathMod.join(dir, 'missing.jsonl');
  const goodPath = await writeSessionFile(dir, 'later.jsonl', 'Later plan');
  const internal = server as unknown as {
    readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title?: string }>;
    admitOpenedSessionTitle(path: string): Promise<void>;
    resolveLiveSessionPath(path: string, source: string, action: 'read'): unknown;
    titleAdmission?: Promise<void>;
    titleNamespaceRetryTimer?: ReturnType<typeof setTimeout>;
    pendingLiveTitlePaths: Set<string>;
    liveSessionTitles: { ready: boolean; assigned(path: string): string | undefined };
    dispose(): Promise<void>;
  };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let reads = 0;
  const originalRead = internal.readLiveSessionTitleEntry.bind(server);
  internal.readLiveSessionTitleEntry = async (sessionPath) => {
    if (sessionPath === badPath) reads += 1;
    return originalRead(sessionPath);
  };
  const base = [membershipEntry(currentPath), membershipEntry(idlePath)];
  const refresh = async (includeBad = true) => {
    applyMembership(server, membership([
      ...base, ...(includeBad ? [membershipEntry(badPath, { activity: 'running' })] : []), membershipEntry(goodPath),
    ]));
    await internal.titleAdmission;
  };
  for (let index = 0; index < 100; index += 1) await refresh();
  assert.equal(reads, 1, 'settled activity snapshots must not retry the unreadable member');
  assert.equal(internal.liveSessionTitles.assigned(goodPath), 'Later plan');
  assert.equal(internal.liveSessionTitles.ready, true);
  assert.equal(internal.liveSessionTitles.assigned(currentPath), 'Current plan');
  assert.throws(
    () => internal.resolveLiveSessionPath(badPath, currentPath, 'read'),
    (error: unknown) => error instanceof BackendError && error.code === 'LIVE_TITLE_NAMESPACE_UNAVAILABLE',
  );

  now += 1_000;
  await refresh();
  assert.equal(reads, 2, 'a later snapshot retries once after the initial cooldown');
  now += 1_000;
  for (let index = 0; index < 100; index += 1) await refresh();
  assert.equal(reads, 2, 'successive failures increase the cooldown');

  await refresh(false);
  await refresh();
  assert.equal(reads, 3, 'confirmed retirement discards the old path cooldown');
  await writeSessionFile(dir, 'missing.jsonl', 'Recovered plan');
  await internal.admitOpenedSessionTitle(badPath);
  assert.equal(reads, 4, 'explicit open retries immediately even during cooldown');
  await refresh();
  assert.equal(internal.liveSessionTitles.assigned(badPath), 'Recovered plan');
  assert.equal(internal.pendingLiveTitlePaths.size, 0);

  await refresh(false);
  await fs.rm(badPath);
  await refresh();
  for (let attempt = 0; attempt < 7; attempt += 1) {
    now += 60_000;
    await refresh();
  }
  assert.equal(reads, 12);
  now += 59_999;
  await refresh();
  assert.equal(reads, 12, 'persistent failures retain a capped one-minute cooldown');
  await writeSessionFile(dir, 'missing.jsonl', 'Repaired plan');
  now += 1;
  await refresh();
  assert.equal(reads, 13, 'a repaired transcript recovers on a later snapshot at the capped deadline');
  assert.equal(internal.liveSessionTitles.assigned(badPath), 'Repaired plan');
  assert.equal(internal.pendingLiveTitlePaths.size, 0);
  assert.equal(internal.titleNamespaceRetryTimer, undefined, 'background admissions schedule no timer');
  (server as unknown as { workerRuntimeRouter?: unknown }).workerRuntimeRouter =
    ownedServers.get(server as unknown as BackendServer);
  await internal.dispose();
  await refresh();
  assert.equal(reads, 13, 'disposed coordinator starts no further admission reads');
});

test('background and explicit title admission share one flight and fence disposed or replaced generations', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-admission-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const fence of ['dispose', 'generation'] as const) {
    const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
    const newPath = pathMod.join(dir, `${fence}.jsonl`);
    const internal = server as unknown as {
      readLiveSessionTitleEntry(path: string): Promise<{ sessionPath: string; sessionId: string; title: string }>;
      admitOpenedSessionTitle(path: string): Promise<void>;
      titleAdmission?: Promise<void>;
      liveTitleAdmissionRetries: Map<string, unknown>;
      pendingOpenedTitleAdmissions: Map<string, Promise<void>>;
      liveSessionTitles: { assigned(path: string): string | undefined };
      backendGeneration: number;
      dispose(): Promise<void>;
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    internal.readLiveSessionTitleEntry = async (sessionPath) => {
      reads += 1;
      await blocked;
      return { sessionPath, sessionId: sessionPath, title: 'Late plan' };
    };
    const sessions = [membershipEntry(currentPath), membershipEntry(idlePath), membershipEntry(newPath)];
    applyMembership(server, membership(sessions));
    const background = internal.titleAdmission;
    const explicit = assert.rejects(internal.admitOpenedSessionTitle(newPath),
      (error: unknown) => error instanceof BackendError && error.code === 'SESSION_GENERATION_ENDED');
    for (let index = 0; index < 100; index += 1) applyMembership(server, membership(sessions));
    assert.equal(reads, 1, 'open and background snapshots join the per-path admission');
    if (fence === 'dispose') {
      (server as unknown as { workerRuntimeRouter?: unknown }).workerRuntimeRouter =
        ownedServers.get(server as unknown as BackendServer);
      await internal.dispose();
    } else internal.backendGeneration += 1;
    release();
    await Promise.all([background, explicit]);
    assert.equal(internal.liveSessionTitles.assigned(newPath), undefined);
    assert.equal(internal.pendingOpenedTitleAdmissions.size, 0);
    if (fence === 'dispose') assert.equal(internal.liveTitleAdmissionRetries.size, 0);
  }
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

test('restored untitled live titles survive a new coordinator and normal generation replaces only marked fallbacks', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'admission-title-restore-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const paths = [await writeSessionFile(dir, 'a.jsonl'), await writeSessionFile(dir, 'b.jsonl')];
  const first = serverForTests();
  const firstWrites = installTitleWriter(first);
  const members = paths.map((path) => membershipEntry(path));
  applyMembership(first, membership(members));
  await hydrate(first);
  assert.equal(firstWrites.length, 2);
  const second = serverForTests();
  const writes = installTitleWriter(second);
  applyMembership(second, membership(members));
  await hydrate(second);
  const internal = second as unknown as {
    liveSessionTitles: { assigned(path: string): string | undefined; isAdmissionFallback(path: string): boolean; resolve(title: string): unknown };
    finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string): Promise<unknown>;
  };
  assert.equal(writes.length, 0, 'durable admission titles are not reassigned on restart');
  assert.equal(internal.liveSessionTitles.assigned(paths[0]), 'New Session');
  assert.equal(internal.liveSessionTitles.assigned(paths[1]), 'New Session (2)');
  assert.equal(internal.liveSessionTitles.isAdmissionFallback(paths[0]), true);
  assert.deepEqual(await internal.finalizeGeneratedLiveSessionTitle(paths[0], 'Fix login',
    { generated: true, name: 'Fix Login' }, 'generated'), { generated: true, name: 'Fix Login' });
  assert.equal(writes[0].options?.replaceAdmissionFallback, true);
  assert.equal(internal.liveSessionTitles.resolve('New Session'), undefined, 'the fallback is not a historical alias');
  assert.equal(internal.liveSessionTitles.isAdmissionFallback(paths[0]), false);
  const rows = (await fs.readFile(paths[0], 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(getAdmissionFallbackTitle({ getEntries: () => rows }), undefined);
  assert.deepEqual(await internal.finalizeGeneratedLiveSessionTitle(paths[0], 'Another prompt',
    { generated: true, name: 'Do Not Replace' }, 'second'), { generated: false, reason: 'explicit-name' });
  assert.equal(writes.length, 1);
});

test('title handleRequest assigns candidates and fail-open snippets but fences invalidated inference', async (t) => {
  for (const outcome of ['generated', 'model-failed', 'invalid-output', 'disabled', 'invalidated'] as const) {
    await t.test(outcome, async (t) => {
      const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'title-request-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const sessionPath = await writeSessionFile(dir, 'a.jsonl');
      const server = serverForTests();
      const writes = installTitleWriter(server);
      applyMembership(server, membership([membershipEntry(sessionPath)]));
      await hydrate(server);
      let generation = 0;
      let inferenceCalls = 0;
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const inferenceStarted = new Promise<void>((resolve) => { started = resolve; });
      (server as unknown as { workerRuntimeRouter: unknown }).workerRuntimeRouter = {
        getRoute: () => ({ state: 'hot' }),
        hasHotOwner: () => true,
        operationCancellationGeneration: () => generation,
        routeExisting: async () => {
          inferenceCalls += 1;
          if (outcome === 'model-failed') throw new Error('model unavailable');
          if (outcome === 'invalidated') { started(); await blocked; }
          if (outcome === 'invalid-output') return { generated: false, reason: 'invalid-output' };
          return { generated: true, name: 'Fix Login' };
        },
      };
      const pending = server.handleRequest({
        id: `title-${outcome}`, method: 'session.title.generate',
        params: { sessionPath, prompt: 'Investigate login', enabled: outcome !== 'disabled',
          provider: 'ollama', model: 'test-model', thinkingLevel: 'off', timeoutSec: 15 },
      });
      if (outcome === 'invalidated') {
        await inferenceStarted;
        generation += 1;
        release();
      }
      assert.deepEqual(await pending, outcome === 'invalidated'
        ? { generated: false, reason: 'cancelled' }
        : outcome === 'invalid-output'
          ? { generated: true, reason: 'invalid-output', name: 'Investigate login' }
          : { generated: true, name: outcome === 'generated' ? 'Fix Login' : 'Investigate login',
            ...(outcome === 'generated' ? {} : { reason: outcome }) });
      assert.equal(inferenceCalls, outcome === 'disabled' ? 0 : 1);
      assert.equal(writes.length, outcome === 'invalidated' ? 1 : 2);
      const internal = server as unknown as {
        liveSessionTitles: { assigned(path: string): string | undefined; isAdmissionFallback(path: string): boolean };
      };
      assert.equal(internal.liveSessionTitles.assigned(sessionPath), outcome === 'invalidated'
        ? 'New Session' : outcome === 'generated' ? 'Fix Login' : 'Investigate login');
      assert.equal(internal.liveSessionTitles.isAdmissionFallback(sessionPath), outcome === 'invalidated');
    });
  }
});

test('generation joins an in-flight admission write before replacing its fallback', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'admission-title-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const writes = installTitleWriter(server);
  const internal = server as unknown as {
    persistAssignedSessionTitle(path: string, title: string, id: string, expected?: string, options?: object): Promise<void>;
    finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string): Promise<unknown>;
    liveSessionTitles: { assigned(path: string): string | undefined };
    titleAdmission?: Promise<void>;
  };
  const original = internal.persistAssignedSessionTitle.bind(server);
  let release!: () => void;
  let dispatch!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { dispatch = resolve; });
  internal.persistAssignedSessionTitle = async (...args) => {
    if (args[2] === 'live-title-open') { dispatch(); await blocked; }
    await original(...args);
  };
  const target = await writeSessionFile(dir, 'racing.jsonl');
  applyMembership(server, membership([membershipEntry(currentPath), membershipEntry(idlePath), membershipEntry(target)]));
  await started;
  const generated = internal.finalizeGeneratedLiveSessionTitle(target, 'Fix login', { generated: true, name: 'Fix Login' }, 'racing');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 0);
  release();
  assert.deepEqual(await generated, { generated: true, name: 'Fix Login' });
  await internal.titleAdmission;
  assert.equal(writes.length, 2);
  assert.equal(internal.liveSessionTitles.assigned(target), 'Fix Login');
});

test('generation failure replaces admission fallback with a stable final prompt title', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'admission-title-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionPath = await writeSessionFile(dir, 'a.jsonl');
  const server = serverForTests();
  const writes = installTitleWriter(server);
  applyMembership(server, membership([membershipEntry(sessionPath)]));
  await hydrate(server);
  const internal = server as unknown as {
    liveSessionTitles: { isAdmissionFallback(path: string): boolean; assigned(path: string): string | undefined };
    finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string): Promise<unknown>;
  };
  assert.deepEqual(await internal.finalizeGeneratedLiveSessionTitle(sessionPath, 'Investigate login',
    { generated: false, reason: 'timeout' }, 'failed'), { generated: true, reason: 'timeout', name: 'Investigate login' });
  assert.equal(internal.liveSessionTitles.isAdmissionFallback(sessionPath), false);
  assert.equal(internal.liveSessionTitles.assigned(sessionPath), 'Investigate login');
  await internal.finalizeGeneratedLiveSessionTitle(sessionPath, 'Later prompt', { generated: true, name: 'Later' }, 'later');
  assert.equal(writes.length, 2, 'successful failure-fallback assignment is stable');
});

test('cold generation replacement rechecks the exact admission marker against a same-text manual rename', async () => {
  const server = serverForTests();
  const entries: unknown[] = [
    { type: 'session_info', id: 'admission', name: 'New Session' },
    { type: 'custom', customType: 'pie.session-title-admission-fallback', data: { version: 1, titleEntryId: 'admission', name: 'New Session' } },
    { type: 'session_info', id: 'manual', name: 'New Session' },
  ];
  const internal = server as unknown as {
    sdk: unknown;
    runColdSessionMutation(path: string, run: () => Promise<void>): Promise<void>;
    initializeColdSessionStore(): unknown;
    persistAssignedColdSessionTitle(path: string, title: string, expected: string, options: object): Promise<void>;
  };
  internal.sdk = { SessionManager: { open: () => ({ getSessionName: () => 'New Session', getEntries: () => entries }) } };
  internal.runColdSessionMutation = async (_path, run) => run();
  internal.initializeColdSessionStore = () => ({ setSessionTitle: () => assert.fail('manual name must not be overwritten') });
  await assert.rejects(internal.persistAssignedColdSessionTitle('/s', 'Generated', 'New Session', { replaceAdmissionFallback: true }),
    (error: unknown) => error instanceof BackendError && error.code === 'SESSION_OWNERSHIP_CONFLICT');
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

test('generated candidates never report success when title assignment was skipped', async () => {
  for (const alreadyNamed of [false, true]) {
    const server = serverForTests();
    const internal = server as unknown as {
      liveSessionTitles: { reconcile(entries: unknown[], persist: () => Promise<void>): Promise<unknown>; assigned(path: string): string | undefined };
      persistAssignedSessionTitle(path: string, title: string): Promise<void>;
      finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string): Promise<unknown>;
    };
    const path = '/workspace/skipped-title.jsonl';
    if (alreadyNamed) {
      await internal.liveSessionTitles.reconcile([
        { sessionPath: path, sessionId: 'manual', title: 'Manual authority' },
      ], async () => undefined);
    }
    internal.persistAssignedSessionTitle = async () => { assert.fail('skipped assignment must not persist a candidate'); };
    const result = await internal.finalizeGeneratedLiveSessionTitle(
      path, 'Investigate failed login.', { generated: true, name: 'Generated candidate' }, 'title-skipped',
    );
    assert.deepEqual(result, {
      generated: false,
      reason: alreadyNamed ? 'explicit-name' : 'assignment-failed',
    });
    assert.equal(internal.liveSessionTitles.assigned(path), alreadyNamed ? 'Manual authority' : undefined);
  }
});

test('title finalization fences cancelled and stale generations before assignment dispatch', async () => {
  for (const fence of ['cancelled', 'stale'] as const) {
    const server = serverForTests();
    const internal = server as unknown as {
      backendGeneration: number;
      titleNamespaceHydration?: Promise<void>;
      liveSessionTitles: { reconcile(entries: unknown[], persist: () => Promise<void>): Promise<unknown>; assigned(path: string): string | undefined };
      finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string, isCurrent: () => boolean): Promise<unknown>;
    };
    let release!: () => void;
    internal.titleNamespaceHydration = new Promise<void>((resolve) => { release = resolve; });
    let cancellationGeneration = 0;
    const backendGeneration = internal.backendGeneration;
    let assignments = 0;
    (server as unknown as { workerRuntimeRouter: unknown }).workerRuntimeRouter = {
      hasHotOwner: () => true,
      assignSessionTitle: async () => { assignments += 1; return { assigned: true }; },
    };
    const sessionPath = '/workspace/fenced-title.jsonl';
    const pending = internal.finalizeGeneratedLiveSessionTitle(
      sessionPath, 'First prompt', { generated: true, name: 'Candidate' }, 'fenced-title',
      () => cancellationGeneration === 0 && internal.backendGeneration === backendGeneration,
    );
    if (fence === 'cancelled') cancellationGeneration += 1;
    else internal.backendGeneration += 1;
    await internal.liveSessionTitles.reconcile([], async () => undefined);
    release();
    assert.deepEqual(await pending, { generated: false, reason: 'cancelled' });
    assert.equal(assignments, 0);
    assert.equal(internal.liveSessionTitles.assigned(sessionPath), undefined);
  }
});

test('cancellation after title assignment dispatch retains the reservation until the writer settles', async () => {
  const server = serverForTests();
  const internal = server as unknown as {
    liveSessionTitles: {
      reconcile(entries: unknown[], persist: () => Promise<void>): Promise<unknown>;
      assigned(path: string): string | undefined;
      reserve(title: string, identity: { sessionPath: string; sessionId: string }): { title: string };
    };
    finalizeGeneratedLiveSessionTitle(path: string, prompt: string, generation: object, id: string, isCurrent: () => boolean): Promise<unknown>;
  };
  await internal.liveSessionTitles.reconcile([], async () => undefined);
  let release!: () => void;
  let dispatched!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  let current = true;
  let assignments = 0;
  (server as unknown as { workerRuntimeRouter: unknown }).workerRuntimeRouter = {
    hasHotOwner: () => true,
    assignSessionTitle: async (sessionPath: string, title: string, requestId: string) => {
      assignments += 1;
      assert.equal(sessionPath, '/workspace/settling-title.jsonl');
      assert.equal(title, 'Candidate');
      assert.equal(requestId, 'settling-title:title');
      dispatched();
      await blocked;
      return { assigned: true };
    },
  };
  let settled = false;
  const pending = internal.finalizeGeneratedLiveSessionTitle(
    '/workspace/settling-title.jsonl', 'First prompt', { generated: true, name: 'Candidate' },
    'settling-title', () => current,
  ).then((result) => { settled = true; return result; });
  await started;
  current = false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'cancellation must not detach the dispatched writer');
  assert.equal(internal.liveSessionTitles.assigned('/workspace/settling-title.jsonl'), undefined);
  assert.equal(internal.liveSessionTitles.reserve('Candidate', {
    sessionPath: '/workspace/competitor.jsonl', sessionId: 'competitor',
  }).title, 'Candidate (2)', 'the in-flight title remains reserved');
  release();
  assert.deepEqual(await pending, { generated: true, name: 'Candidate' });
  assert.equal(assignments, 1);
  assert.equal(internal.liveSessionTitles.assigned('/workspace/settling-title.jsonl'), 'Candidate');
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

test('closing retains durable detail until confirmed retirement, then reopen resolves fresh detail', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'detail-close-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  let resolutions = 0;
  const emitted: unknown[] = [];
  const store = new DurableDetailStore({
    resolve: async () => {
      resolutions += 1;
      const value = { text: `detail-${resolutions}` };
      return { value, sizeBytes: Buffer.byteLength(JSON.stringify(value)), messageId: 'message', toolCallId: 'tool', kind: 'tool-result' };
    },
    emit: (message) => { emitted.push(message); return true; },
  });
  (server as unknown as { durableDetailStore: DurableDetailStore }).durableDetailStore = store;
  const address = { sessionPath: currentPath, turnId: 'turn', rootToolCallId: 'tool', rootAttemptId: 'attempt', lineage: [] };
  const fence = { backendGeneration: 1, coordinatorGeneration: 1 };
  await store.subscribe('before-close', 'before-close', address, 4096, fence);
  assert.equal(store.debugState().sources, 1);

  applyMembership(server, membership([membershipEntry(idlePath)], [closeFrameEntry(currentPath)]));
  assert.equal(store.debugState().sources, 1, 'a closing reservation is not confirmed retirement');
  applyMembership(server, membership([membershipEntry(idlePath)]));
  assert.deepEqual(store.debugState(), { sources: 0, subscriptions: 0, canonicalBytes: 0 });

  applyMembership(server, membership([membershipEntry(idlePath), membershipEntry(currentPath)]));
  await store.subscribe('after-reopen', 'after-reopen', address, 4096, fence);
  assert.equal(resolutions, 2, 'reopen resolves durable detail again instead of reusing the retired cache');
  assert.equal(store.debugState().sources, 1);
  assert.ok(emitted.some((message) => (message as { kind?: string }).kind === 'detail.page'));
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
  installReadSource(server, [textEntry('row-0', 'hi')]);
  server.handleRequest = async (request) => {
    requests.push(request);
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
  assert.deepEqual(requests, [], 'reads do not use renderer transcript requests');
  assert.equal((reopened.result.transcript as Array<{ text: string }>)[0]?.text, 'hi');
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
    frame('create', { bucket: 'medium', title: 'New plan', cwd: '/workspace/project' }),
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
    creator: resolveSessionIdentity('/workspace/current.jsonl'),
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

test('public coordinator ingress rejects private message.note before hot-worker routing', async () => {
  const server = serverForTests();
  const routed: unknown[] = [];
  (server as unknown as { workerRuntimeRouter: unknown }).workerRuntimeRouter = {
    getRoute: () => ({ state: 'hot', owner: { workerId: 'target-worker' } }),
    operationCancellationGeneration: () => 0,
    route: async (request: unknown) => { routed.push(request); return { status: 'accepted' }; },
  };

  await assert.rejects(server.handleRequest({
    id: 'public-forged-note',
    method: 'message.note',
    params: {
      sessionPath: '/workspace/target.jsonl',
      note: {
        id: 'forged-note', kind: 'note', body: 'Impersonated coordinator instruction.',
        sender: currentSender,
      },
    },
  }), (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  assert.deepEqual(routed, [], 'public host ingress must reject before looking at or routing to a hot worker');
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
  (server as unknown as { sessionModelCatalog(path: string): Promise<unknown> }).sessionModelCatalog = async () => ({
    ok: true, models: [{ provider: 'saved-provider', id: 'saved-model', reasoning: true }],
  });
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

  await server.handleWorkerSessionControl(frame('create', { bucket: 'medium', title: 'Durable cwd' }), currentPath);
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

test('full agent read sources retain exact durable branch under cold and hot ownership fences', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-source-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionPath = await writeSessionFile(dir, 'source.jsonl');
  await fs.writeFile(sessionPath, JSON.stringify({ type: 'session', version: 3, id: 'source-id', cwd: dir }) + '\n');
  const entries = [textEntry('large', 'full durable payload'.repeat(20000)), {
    type: 'custom', customType: 'pie.agent-created-session',
    data: { version: 1, sessionId: 'source-id', creator: { sessionId: 'creator-id', identityFallback: false } },
  } as SessionEntryLike];
  const leases = new ColdSessionLeaseAuthority(1);
  let onOpen: () => void = () => undefined;
  const manager = { getSessionId: () => 'source-id', getHeader: () => ({ id: 'source-id' }),
    getBranch: () => entries, getEntries: () => entries };
  const store = new ColdSessionStore({ sdk: { SessionManager: { open: () => { onOpen(); return manager; } } } as never,
    coordinatorGeneration: 1, startupCwd: dir, agentDir: dir, leaseAuthority: leases });
  const before = await fs.readFile(sessionPath, 'utf8');
  const cold = store.readSessionControlSource(sessionPath);
  assert.equal(cold.entries, entries, 'no preview, folding or windowing precedes agent paging');
  assert.deepEqual(cold.creator, { sessionId: 'creator-id', identityFallback: false });
  const [reservation] = leases.reserveCanonicalPaths([sessionPath], 'test:hot-source-read', { hideFromCatalog: false });
  const hot = store.readSessionControlSource(sessionPath);
  assert.equal(hot.entries, entries);
  assert.equal(await fs.readFile(sessionPath, 'utf8'), before, 'both reads are read-only');
  onOpen = () => { leases.releaseCanonicalPaths([reservation]); };
  assert.throws(() => store.readSessionControlSource(sessionPath), /ownership|lease|revision|changed/iu,
    'an ownership change during SDK open cannot publish stale source');
});

test('create inheritance failure explicitly reports that no session was created', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-preflight-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const internal = server as unknown as { captureSessionControlSettings(path: string): Promise<never> };
  internal.captureSessionControlSettings = async () => { throw new Error('saved settings unavailable'); };
  const writes: string[] = [];
  server.handleRequest = async (request) => { writes.push(request.method); return {}; };
  const result = await server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
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
  await assert.rejects(server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
    title: 'Provider test', settings: { subagentProviderChoices: { forged: true } },
  }), currentPath), (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  assert.deepEqual(writes, []);
});

test('agent create validates the selected custom model against the creation-time catalog before durable writes', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-creation-model-catalog-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const model = { provider: 'custom-provider', id: 'runtime-only-model' };
  const callerModel = {
    ...model, reasoning: true, thinkingLevels: ['high'], subagent: { eligible: true },
  };
  const internal = server as unknown as {
    captureSessionControlSettings(path: string): Promise<unknown>;
    sessionModelCatalog(path: string): Promise<unknown>;
    creationModelCatalog(): Promise<unknown>;
    assertSessionControlModelAvailable(model: unknown, sessionPath?: string, reasoning?: string): Promise<void>;
  };
  const prototype = BackendServer.prototype as unknown as {
    assertSessionControlModelAvailable(
      this: BackendServer, model: unknown, sessionPath?: string, reasoning?: string,
    ): Promise<void>;
  };
  // installSessionControlSettingsHarness stubs this method for unrelated tests;
  // restore the production implementation for this regression.
  internal.assertSessionControlModelAvailable = prototype.assertSessionControlModelAvailable.bind(
    server as unknown as BackendServer,
  );
  internal.captureSessionControlSettings = async () => ({
    settings: {
      model, reasoning: 'high', autonomousMode: true, subagentProviderChoices: { 'custom-provider': true },
      disabledSystemPromptEntries: [],
    },
    cwd: '/workspace',
  });
  let callerCatalogReads = 0;
  internal.sessionModelCatalog = async () => {
    callerCatalogReads += 1;
    return { ok: true, models: [callerModel] };
  };
  const writes: string[] = [];
  server.handleRequest = async (request) => { writes.push(request.method); return {}; };

  for (const creationModel of [
    { ...callerModel, subagent: { eligible: false } },
    { ...callerModel, thinkingLevels: ['low'] },
  ]) {
    let creationCatalogReads = 0;
    internal.creationModelCatalog = async () => {
      creationCatalogReads += 1;
      return { ok: true, models: [creationModel] };
    };
    const result = await server.handleWorkerSessionControl(
      frame('create', { bucket: 'medium', title: 'Custom model validation' }), currentPath,
    );
    assert.equal((result.result.creation as { status: string }).status, 'not_created');
    assert.equal((result.result.configuration as { status: string }).status, 'not_started');
    assert.equal(creationCatalogReads, 1, 'creation validates against the creation-time catalog');
    assert.deepEqual(writes, [], 'ineligible or unsupported creation models are rejected before durable writes');
  }
  assert.equal(callerCatalogReads, 2, 'selection uses the caller catalog for the same custom model identity');
});

test('agent create preflight honors explicit reasoning over caller bucket reasoning', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-reasoning-preflight-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const internal = server as unknown as {
    runtimePrefs: unknown;
    sessionModelCatalog(path: string): Promise<unknown>;
    creationModelCatalog(): Promise<unknown>;
    assertSessionControlModelAvailable(model: unknown, sessionPath?: string, reasoning?: string): Promise<void>;
  };
  const prototype = BackendServer.prototype as unknown as {
    assertSessionControlModelAvailable(
      this: BackendServer, model: unknown, sessionPath?: string, reasoning?: string,
    ): Promise<void>;
  };
  // Restore the production validator because the shared harness stubs it.
  internal.assertSessionControlModelAvailable = prototype.assertSessionControlModelAvailable.bind(
    server as unknown as BackendServer,
  );
  internal.runtimePrefs = {
    providerToggles: {},
    subagentBuckets: { small: [], medium: [{ model: 'openai/gpt-test', thinkingLevel: 'high' }], frontier: [] },
  };
  internal.sessionModelCatalog = async () => ({ ok: true, models: [
    { provider: 'openai', id: 'gpt-test', reasoning: true, thinkingLevels: ['high'] },
  ] });
  internal.creationModelCatalog = async () => ({ ok: true, models: [
    { provider: 'openai', id: 'gpt-test', reasoning: true, thinkingLevels: ['low'] },
  ] });
  const writes: string[] = [];
  let configuredReasoning: unknown;
  server.handleRequest = async (request) => {
    writes.push(request.method);
    if (request.method === 'settings.set') {
      configuredReasoning = (request.params as { defaultThinkingLevel?: unknown }).defaultThinkingLevel;
    }
    return request.method === 'session.create'
      ? { sessionPath: '/workspace/reasoning-created.jsonl', title: 'Reasoning worker' }
      : mockSettingsReply(request);
  };

  const created = await server.handleWorkerSessionControl(frame('create', {
    bucket: 'medium', title: 'Reasoning worker', settings: { reasoning: 'low' },
  }), currentPath);
  assert.equal((created.result.creation as { status: string }).status, 'created');
  assert.deepEqual(created.result.modelSelection, {
    model: { provider: 'openai', id: 'gpt-test' },
    reasoning: 'high', requestedBucket: 'medium', effectiveBucket: 'medium',
    pool: ['openai/gpt-test'], fallback: false,
  });
  const settingsWrite = writes.includes('settings.set');
  assert.equal(settingsWrite, true);
  assert.equal((writes.includes('systemPromptToggles.set')), true);
  assert.equal((created.result.configuration as { status: string }).status, 'succeeded');
  assert.equal(configuredReasoning, 'low', 'the explicit override is persisted despite the high bucket selection');
  assert.equal((created.result.modelSelection as { reasoning: string }).reasoning, 'high');

  writes.length = 0;
  const rejected = await server.handleWorkerSessionControl(frame('create', {
    bucket: 'medium', title: 'No override',
  }), currentPath);
  assert.equal((rejected.result.creation as { status: string }).status, 'not_created');
  assert.equal((rejected.result.configuration as { status: string }).status, 'not_started');
  assert.deepEqual(writes, [], 'unsupported inherited high reasoning is rejected before durable writes');
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
  await server.handleWorkerSessionControl(frame('create', { bucket: 'medium', title: 'Durable cwd' }), currentPath);
  assert.equal((requests[0]?.params as { cwd?: string }).cwd, '/durable/project');
});

test('created session-control sends stop after confirmed close during gated configuration', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-close-config-race-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const targetPath = '/workspace/created-race.jsonl';
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
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

  const creating = server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
    title: 'Created race', prompt: 'send only if still live',
  }), currentPath);
  await configurationStarted;
  allowDirectCreator(server, currentPath, targetPath);
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

test('message requires explicit reply intent before configuration or send', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-reply-intent-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  let requests = 0;
  server.handleRequest = async () => { requests += 1; return { accepted: true }; };
  for (const expectReply of [undefined, null, 'false', 0]) {
    await assert.rejects(server.handleWorkerSessionControl(frame('message', {
      self: true, prompt: 'notification', expectReply,
    }), currentPath), /expectReply/);
  }
  assert.equal(requests, 0);
});

test('agent send records reply intent and send time, leaving delivery time to the recipient', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-send-stamp-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const requests: Array<{ method: string; params?: unknown }> = [];
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.handleRequest = async (request) => { requests.push(request); return { queued: true }; };
  server.emit = (event, payload) => events.push({ event, payload });
  const before = Date.now();
  await server.handleWorkerSessionControl(frame('message', {
    title: 'Idle plan', prompt: 'window released', expectReply: false,
  }), currentPath);
  const sender = (requests[0]!.params as { coordinatorAttribution: typeof currentSender & {
    message: { sentAt: number; expectReply: boolean; deliveredAt?: number };
  } }).coordinatorAttribution;
  assert.deepEqual(sender.identity, currentSender.identity);
  assert.equal(sender.message.expectReply, false);
  assert.ok(sender.message.sentAt >= before && sender.message.sentAt <= Date.now());
  assert.equal(sender.message.deliveredAt, undefined);
  const event = events.find(({ event }) => event === 'message.agent')!.payload as { timestamp: number; sender: unknown };
  assert.equal(event.timestamp, sender.message.sentAt);
  assert.deepEqual(event.sender, sender);
});

test('combined create captures settings once, honors explicit overrides, then returns an explicit task assignment', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-combined-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const events: Array<{ event: string; payload?: unknown }> = [];
  installSessionControlSettingsHarness(server, events);
  const requests: Array<{ method: string; params?: unknown }> = [];
  const createdPath = '/workspace/combined.jsonl';
  const initialPrompt = 'x'.repeat(16 * 1024);
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

  const outcome = await server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
    title: 'Combined worker',
    prompt: initialPrompt,
    settings: {
      reasoning: 'low',
      autonomousMode: false,
      disabledSystemPromptEntries: ['override-entry'],
    },
  }), currentPath);

  assert.equal((outcome.result.creation as Record<string, unknown>).status, 'created');
  assert.equal((outcome.result.configuration as Record<string, unknown>).status, 'succeeded');
  assert.equal((outcome.result.message as Record<string, unknown>).status, 'accepted');
  const task = outcome.result.task as Record<string, unknown>;
  assert.equal(typeof task.taskId, 'string');
  assert.equal(task.revision, 1);
  assert.equal(task.status, 'accepted');
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
  const rawSender = (requests[3]?.params as Record<string, unknown>).coordinatorAttribution as Record<string, unknown>;
  const sender = rawSender as typeof currentSender & { message: {
    sentAt: number; expectReply: boolean; kind: string; taskId: string; taskRevision: number;
  } };
  assert.deepEqual(sender.identity, currentSender.identity);
  assert.equal(sender.message.expectReply, false);
  assert.equal(sender.message.kind, 'assignment');
  assert.equal(sender.message.taskId, task.taskId);
  assert.equal(sender.message.taskRevision, task.revision);
  assert.equal((requests[3]?.params as Record<string, unknown>).text, initialPrompt,
    'an initial assignment exactly at 16 KiB UTF-8 is accepted and sent');
  assert.equal((task.requester as Record<string, unknown>).address, createSessionAddress(currentSender.identity));
  assert.equal((task.worker as Record<string, unknown>).address, (outcome.result.creation as Record<string, unknown>).address);
  const settingsRequests = events
    .filter((entry) => entry.event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT)
    .map((entry) => entry.payload as SessionControlSettingsRequest);
  assert.deepEqual(settingsRequests.map((request) => request.action), ['capture', 'apply']);
  assert.deepEqual(settingsRequests[1]?.settings, {
    autonomousMode: false,
    subagentProviderChoices: { openai: true },
    subagentBucketChoices: { small: true, medium: true, frontier: true },
  });
  assert.deepEqual(events.filter((entry) => entry.event === 'message.agent').map((entry) => (
    (entry.payload as Record<string, unknown>).sender
  )), [sender, sender]);
});

test('unrelated sessions may coordinate and request task interruption, but cannot close or reconfigure a peer', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-authority-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const requests: Array<{ method: string; params?: unknown }> = [];
  server.handleRequest = async request => {
    requests.push(request);
    return request.method === 'message.interrupt' ? { interrupted: true, settled: true } : { queued: true };
  };

  const note = await server.handleWorkerSessionControl(frame('note', {
    target: 'Idle plan', message: 'Shared file changed; please inspect it.',
  }), currentPath);
  assert.equal((note.result as Record<string, unknown>).status, 'accepted', JSON.stringify(note.result));

  const assignment = await server.handleWorkerSessionControl(frame('task.assign', {
    target: 'Idle plan', prompt: 'Inspect the shared files and report findings.',
  }), currentPath);
  assert.equal((assignment.result as Record<string, unknown>).status, 'accepted');
  const task = assignment.result.task as Record<string, unknown>;
  assert.equal(task.status, 'accepted');

  await assert.rejects(server.handleWorkerSessionControl(frame('settings.set', {
    title: 'Idle plan', settings: { reasoning: 'low' },
  }), currentPath), (error: { code?: string }) => error.code === 'SESSION_CONTROL_FORBIDDEN');
  await assert.rejects(server.handleWorkerSessionControl(frame('close', {
    title: 'Idle plan', delete: true,
  }), currentPath), (error: { code?: string }) => error.code === 'SESSION_CONTROL_FORBIDDEN');

  const interrupted = await server.handleWorkerSessionControl(frame('interrupt', { address: task.worker && (task.worker as Record<string, unknown>).address }), currentPath);
  assert.equal((interrupted.result as Record<string, unknown>).interrupted, true,
    'the authenticated requester may interrupt its worker while the assignment is nonterminal');
  assert.equal(requests.filter(request => request.method === 'message.interrupt').length, 1);

  await assert.rejects(server.handleWorkerSessionControl(frame('close', { title: 'Idle plan' }), currentPath),
    (error: { code?: string }) => error.code === 'SESSION_CONTROL_FORBIDDEN',
    'task requester authority does not extend to close');
  await assert.rejects(server.handleWorkerSessionControl(frame('settings.set', {
    address: createSessionReplyReference(resolveSessionIdentity(idlePath)), settings: { reasoning: 'low' },
  }), currentPath), (error: { code?: string }) => error.code === 'SESSION_CONTROL_FORBIDDEN',
  'task requester authority does not extend to settings');
});

test('requester interrupt cancels an awaiting-result task only after confirmed settlement', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-task-interrupt-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  let interruption: Record<string, unknown> = { interrupted: true, settled: false, teardownTimedOut: true };
  server.handleRequest = async request => request.method === 'message.interrupt' ? interruption : { queued: true };

  const assigned = await server.handleWorkerSessionControl(frame('task.assign', {
    target: 'Idle plan', prompt: 'inspect then report',
  }), currentPath);
  const task = assigned.result.task as Record<string, unknown>;
  server.emit('agent.settled', { sessionPath: idlePath, operationId: 'agent-session:control-task.assign' });
  const unknownInterrupt = await server.handleWorkerSessionControl(frame('interrupt', {
    address: (task.worker as Record<string, unknown>).address,
  }), currentPath);
  assert.equal((unknownInterrupt.result as Record<string, unknown>).settled, false);
  const stillAwaiting = await server.handleWorkerSessionControl(frame('wait', {
    waitId: 'still-awaiting', taskIds: [task.taskId], timeoutMs: 0,
  }), currentPath);
  assert.equal((stillAwaiting.result.tasks as Array<Record<string, unknown>>)[0]?.status, 'awaiting-result');
  await assert.rejects(server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'next task' }) as Record<string, unknown>), requestId: 'next-after-unknown-interrupt',
  }, currentPath));

  interruption = { interrupted: true, settled: true };
  const confirmedInterrupt = await server.handleWorkerSessionControl(frame('interrupt', {
    address: (task.worker as Record<string, unknown>).address,
  }), currentPath);
  assert.equal((confirmedInterrupt.result as Record<string, unknown>).interrupted, true);
  const cancelled = await server.handleWorkerSessionControl(frame('wait', {
    waitId: 'cancelled-task', taskIds: [task.taskId], timeoutMs: 0,
  }), currentPath);
  assert.equal((cancelled.result.tasks as Array<Record<string, unknown>>)[0]?.outcome, 'cancelled');

  const next = await server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'next task' }) as Record<string, unknown>), requestId: 'next-after-confirmed-interrupt',
  }, currentPath);
  assert.equal((next.result.task as Record<string, unknown>).status, 'accepted');
  await assert.rejects(server.handleWorkerSessionControl(frame('task.finish', {
    taskId: task.taskId, revision: task.revision, outcome: 'completed', result: 'late success',
  }), idlePath), /different immutable finish/u);
});

test('generic IPC failure after correlated task start returns unknown evidence, never a known rejection', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-late-task-ack-'));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  server.handleRequest = async () => {
    server.emit('message.started', { sessionPath: idlePath, operationId: 'agent-session:late-task-ack' });
    // WorkerClient rejects pending requests with a generic Error when the
    // process/IPC dies, even if an earlier correlated event already arrived.
    throw new Error('Worker IPC read descriptor closed after dispatch.');
  };

  const outcome = await server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'inspect and report', requestKey }) as Record<string, unknown>),
    requestId: 'late-task-ack',
  }, currentPath);
  const assigned = outcome.result as Record<string, unknown>;
  assert.equal(assigned.status, 'unknown');
  assert.equal((assigned.task as Record<string, unknown>).status, 'running');
  assert.equal((assigned.message as Record<string, unknown>).status, 'unknown');
  assert.match(String(assigned.guidance), /do not repeat/u);

  const receipt = (await server.handleWorkerSessionControl(frame('operation.status', { requestKey }), currentPath))
    .result.operation as Record<string, unknown>;
  assert.equal(receipt.status, 'known', 'the operation response is durably recorded');
  assert.equal(receipt.outcome, 'unknown');
  assert.equal((receipt.result as Record<string, unknown>).status, 'unknown');
  assert.equal(receipt.error, undefined, 'no INVALID_PARAMS known rejection was recorded');
});

test('explicit typed preflight rejection remains conclusive and known', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-task-preflight-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  server.handleRequest = async () => {
    throw new BackendError('MESSAGE_SEND_PRECOMMIT_FAILED', 'Prompt rejected before admission.');
  };
  const outcome = await server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'do not execute', requestKey }) as Record<string, unknown>),
    requestId: 'typed-preflight-rejection',
  }, currentPath);
  const assigned = outcome.result as Record<string, unknown>;
  assert.equal(assigned.status, 'rejected');
  assert.equal((assigned.task as Record<string, unknown>).status, 'rejected');
  assert.equal((assigned.message as Record<string, unknown>).status, 'rejected');
  const receipt = (await server.handleWorkerSessionControl(frame('operation.status', { requestKey }), currentPath))
    .result.operation as Record<string, unknown>;
  assert.equal(receipt.status, 'known');
  assert.equal(receipt.outcome, 'known');
  assert.equal((receipt.result as Record<string, unknown>).status, 'rejected');
});

test('unallowlisted structured worker errors remain unknown and reserve the task slot', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-structured-worker-error-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  server.handleRequest = async () => {
    throw new BackendError('INTERNAL_ERROR', 'Worker returned a structured error without admission proof.');
  };
  const outcome = await server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'may have started', requestKey }) as Record<string, unknown>),
    requestId: 'structured-worker-error',
  }, currentPath);
  const assigned = outcome.result as Record<string, unknown>;
  assert.equal(assigned.status, 'unknown');
  assert.equal((assigned.task as Record<string, unknown>).status, 'unknown');
  assert.match(String(assigned.guidance), /do not repeat/u);

  const receipt = (await server.handleWorkerSessionControl(frame('operation.status', { requestKey }), currentPath))
    .result.operation as Record<string, unknown>;
  assert.equal(receipt.status, 'known');
  assert.equal(receipt.outcome, 'unknown');
  assert.equal((receipt.result as Record<string, unknown>).status, 'unknown');

  await assert.rejects(server.handleWorkerSessionControl({
    ...(frame('task.assign', { target: 'Idle plan', prompt: 'must not overlap unknown task' }) as Record<string, unknown>),
    requestId: 'blocked-by-unknown-task',
  }, currentPath), /non-terminal task/u, 'unknown admission retains the registry worker slot');
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
  const outcome = await server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
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
  await assert.rejects(server.handleWorkerSessionControl(frame('create', { bucket: 'medium',
    title: 'Invalid worker',
    settings: { reasoning: 'unsupported' },
  }), currentPath), (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  assert.equal(requests, 0);
  assert.deepEqual(events, []);
});

for (const [label, prompt] of [
  ['ASCII', 'x'.repeat(16 * 1024 + 1)],
  ['multibyte UTF-8', '🧭'.repeat(4 * 1024 + 1)],
] as const) {
  test(`create rejects an initial assignment above 16 KiB UTF-8 (${label}) before durable effects`, async (t) => {
    const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-prompt-bound-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const { server, currentPath } = await readyServerWithMembers(dir);
    const events: Array<{ event: string; payload?: unknown }> = [];
    installSessionControlSettingsHarness(server, events);
    let writes = 0;
    server.handleRequest = async () => { writes += 1; return {}; };

    await assert.rejects(server.handleWorkerSessionControl(frame('create', {
      bucket: 'medium', title: 'Too large', prompt,
    }), currentPath), (error: { code?: string; message?: string }) =>
      error.code === 'INVALID_PARAMS' && /16 KiB UTF-8/u.test(error.message ?? ''));
    assert.equal(writes, 0, 'no durable create or settings operation was sent');
    assert.deepEqual(events, [], 'no settings capture or mutation was emitted');
  });
}

for (const payload of [
  { title: 'Missing bucket' },
  { title: 'Invalid bucket', bucket: 'large' },
  { title: 'Model override', bucket: 'medium', settings: { model: { provider: 'openai', id: 'gpt-test' } } },
]) {
  test(`create rejects ${payload.title} before capture`, async (t) => {
    const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-bucket-validation-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const { server, currentPath } = await readyServerWithMembers(dir);
    const events: Array<{ event: string; payload?: unknown }> = [];
    installSessionControlSettingsHarness(server, events);
    let writes = 0;
    server.handleRequest = async () => { writes += 1; return {}; };
    await assert.rejects(server.handleWorkerSessionControl(frame('create', payload), currentPath),
      (error: { code?: string }) => error.code === 'INVALID_PARAMS');
    assert.equal(writes, 0);
    assert.deepEqual(events, []);
  });
}

for (const scenario of ['configured', 'downgrade', 'fallback', 'filtered', 'failure'] as const) {
  test(`create bucket selection: ${scenario}`, async (t) => {
    const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-bucket-selection-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const { server, currentPath } = await readyServerWithMembers(dir);
    installSessionControlSettingsHarness(server);
    const internal = server as unknown as {
      runtimePrefs: unknown;
      sessionModelCatalog(path: string): Promise<unknown>;
    };
    const assignment = { model: 'openai/bucket-model', thinkingLevel: 'medium' };
    internal.runtimePrefs = {
      providerToggles: scenario === 'failure' ? { openai: false } : {},
      subagentBuckets: {
        small: scenario === 'downgrade' ? [assignment] : [],
        medium: scenario === 'configured' ? [assignment] : scenario === 'filtered'
          ? [{ model: 'anthropic/blocked-model', thinkingLevel: 'high' }] : [],
        frontier: [],
      },
    };
    internal.sessionModelCatalog = async (source) => {
      assert.equal(source, currentPath);
      return { ok: true, models: [
        { provider: 'openai', id: 'gpt-test', reasoning: true },
        { provider: 'openai', id: 'bucket-model', reasoning: true },
        { provider: 'anthropic', id: 'blocked-model', reasoning: true },
      ] };
    };
    // Explicit caller choices, not the create patch, constrain model selection.
    const originalEmit = server.emit;
    server.emit = (event, payload) => {
      if (event === SESSION_CONTROL_SETTINGS_REQUEST_EVENT
        && (payload as SessionControlSettingsRequest).action === 'capture') {
        const request = payload as SessionControlSettingsRequest;
        void (server as unknown as {
          acknowledgeHostSessionControlSettings(ack: SessionControlSettingsAcknowledgement): Promise<unknown>;
        }).acknowledgeHostSessionControlSettings({
          requestId: request.requestId, sessionPath: request.sessionPath, action: 'capture',
          outcome: 'succeeded', settings: { autonomousMode: true, subagentProviderChoices: { openai: true, anthropic: false } },
        });
      } else originalEmit(event, payload);
    };
    const requests: Array<{ method: string; params?: unknown }> = [];
    server.handleRequest = async (request) => {
      requests.push(request);
      return request.method === 'session.create'
        ? { sessionPath: '/workspace/bucket-created.jsonl', title: 'Bucket worker' }
        : mockSettingsReply(request);
    };
    const outcome = await server.handleWorkerSessionControl(frame('create', {
      bucket: 'medium', title: 'Bucket worker',
      ...(scenario === 'failure' ? { prompt: 'never send' } : {}),
      ...(scenario === 'filtered' ? { settings: { subagentProviderChoices: { anthropic: true } } } : {}),
    }), currentPath);
    if (scenario === 'failure') {
      assert.equal((outcome.result.creation as { status: string }).status, 'not_created');
      assert.equal((outcome.result.message as { status: string }).status, 'not_sent');
      assert.deepEqual(requests, []);
      return;
    }
    const selected = scenario === 'configured' || scenario === 'downgrade';
    assert.deepEqual(outcome.result.modelSelection, {
      model: { provider: 'openai', id: selected ? 'bucket-model' : 'gpt-test' },
      reasoning: selected ? 'medium' : 'high',
      requestedBucket: 'medium', effectiveBucket: scenario === 'downgrade' ? 'small' : 'medium',
      pool: selected ? ['openai/bucket-model'] : [], fallback: !selected,
    });
    const settings = requests.find((request) => request.method === 'settings.set')?.params as Record<string, unknown>;
    assert.equal(settings.defaultModel, selected ? 'bucket-model' : 'gpt-test');
    assert.equal(settings.defaultThinkingLevel, selected ? 'medium' : 'high');
  });
}

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
    subagentBucketChoices: { small: true, medium: true, frontier: true },
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

test('replyTo resolves an unnamed pending-title live identity but rejects closing members', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-pending-reply-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const pendingPath = await writeSessionFile(dir, 'unnamed.jsonl');
  const baseMembers = [membershipEntry(currentPath), membershipEntry(idlePath)];
  applyMembership(server, membership([...baseMembers, membershipEntry(pendingPath)]));
  const internal = server as unknown as {
    pendingLiveTitlePaths: Set<string>;
    liveSessionTitles: { assigned(path: string): string | undefined };
  };
  const pendingKey = [...internal.pendingLiveTitlePaths].find((key) => key.endsWith('unnamed.jsonl'));
  assert.ok(pendingKey, 'the live target is awaiting title admission');
  assert.equal(internal.liveSessionTitles.assigned(pendingPath), undefined);

  const resolveTarget = (server as unknown as {
    resolveSessionControlTarget(action: string, payload: Record<string, unknown>, sourcePath: string): { sessionPath: string };
  }).resolveSessionControlTarget.bind(server);
  for (const action of ['read', 'message', 'settings.get', 'settings.set', 'close']) {
    assert.equal(resolveTarget(action, { self: true }, pendingPath).sessionPath, pendingPath,
      `${action} admits an unnamed caller independently of title admission`);
  }

  const replyReference = createSessionControlSender(resolveSessionIdentity(pendingPath), 'Unnamed plan').replyReference;
  const resolveReply = (server as unknown as {
    resolveSessionControlReplyTarget(payload: Record<string, unknown>, sourcePath: string): unknown;
  }).resolveSessionControlReplyTarget.bind(server);
  const resolved = resolveReply({ replyTo: replyReference }, currentPath) as { status: string; sessionPath: string };
  assert.equal(resolved.status, 'live');
  assert.equal(resolved.sessionPath, pendingPath, 'stable identity resolves despite pending title admission');

  applyMembership(server, membership(baseMembers, [closeFrameEntry(pendingPath)]));
  assert.throws(() => resolveTarget('read', { self: true }, pendingPath),
    (error: { code?: string }) => error.code === 'SESSION_CLOSING',
    'self targeting still respects closing membership');
  assert.throws(() => resolveReply({ replyTo: replyReference }, currentPath),
    (error: { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    'host closing membership remains non-addressable');
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
  assertStampedSender((requests[0]?.params as Record<string, unknown>).coordinatorAttribution);

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
    server.handleWorkerSessionControl(frame('create', { bucket: 'medium', title: 'New plan' }), '/workspace/current.jsonl'),
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
    frame('create', { bucket: 'medium', title: 'New plan' }),
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
  allowDirectCreator(server, '/workspace/current.jsonl', newSessionPath);
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
  installReadSource(server, [textEntry('old', 'old'), textEntry('new', 'new', 'assistant')]);
  server.handleRequest = async (request) => {
    requests.push(request);
    return { accepted: true };
  };

  const page = await server.handleWorkerSessionControl(
    frame('read', { title: 'Idle plan', maxCharacters: 4000 }), currentPath,
  );
  assert.equal(typeof page.result.cursor, 'string');
  assert.deepEqual((page.result.transcript as Array<{ text: string }>).map(row => row.text), ['old', 'new']);
  assert.deepEqual(requests, []);

  // An assigned title addresses another live session even while this caller
  // is itself live; `self` would have targeted the caller instead.
  await server.handleWorkerSessionControl(
    frame('message', { title: 'Idle plan', prompt: 'please continue' }),
    currentPath,
  );
  assert.equal(requests[0]?.method, 'message.send');
  const sender = assertStampedSender((requests[0]?.params as Record<string, unknown>).coordinatorAttribution);
  assert.deepEqual(requests[0]?.params, {
    sessionPath: idlePath, text: 'please continue', inputs: [],
    operationId: 'agent-session:control-message', operationAttempt: 1,
    localId: 'local:agent-session:control-message',
    coordinatorAttribution: sender,
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
    sender,
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

  server.handleRequest = async () => { throw new BackendError('INVALID_PARAMS', 'send rejected before admission'); };
  const rejected = await server.handleWorkerSessionControl(
    { requestId: 'control-message-rejected', action: 'message', payload: { title: 'Idle plan', prompt: 'rejected message', expectReply: false } },
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
    { requestId: 'control-message-unknown', action: 'message', payload: { title: 'Idle plan', prompt: 'possibly admitted', expectReply: false } },
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

test('session-control reads bypass renderer projections and retain model-facing tool content only', async () => {
  const server = serverForTests();
  server.workerRuntimeRouter = { getRoute: () => ({ state: 'cold' }) };
  applyMembership(server, membership([membershipEntry('/workspace/current.jsonl')]));
  installReadSource(server, [{
    type: 'message', id: 'answer', timestamp: '2026-01-01', message: { role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Answer' }] },
  } as SessionEntryLike, {
    type: 'message', id: 'result', timestamp: '2026-01-01',
    message: { role: 'toolResult', toolCallId: 'tool', toolName: 'read',
      content: [{ type: 'text', text: 'useful output' }, { type: 'image', data: 'BASE64_IMAGE_PAYLOAD', mimeType: 'image/png' }], details: { debug: 'durable detail' } },
  } as SessionEntryLike]);
  server.handleRequest = async () => { throw new Error('reads must bypass renderer requests'); };
  const read = await server.handleWorkerSessionControl(
    frame('read', { self: true, maxCharacters: 4000, includeToolCalls: true }), '/workspace/current.jsonl',
  );
  const rows = read.result.transcript as Array<Record<string, unknown>>;
  assert.equal(rows[0].text, 'Answer');
  assert.equal(rows[0].markdown, undefined);
  assert.equal(rows[0].toolCalls, undefined);
  assert.equal(rows[0].customDetails, undefined);
  assert.ok(JSON.stringify(rows).includes('useful output'));
  assert.ok(!JSON.stringify(rows).includes('durable detail'));
  assert.ok(!JSON.stringify(rows).includes('BASE64_IMAGE_PAYLOAD'));
  assert.ok(JSON.stringify(rows).includes('omitted'));
  assert.equal(typeof read.result.cursor, 'string');
  assert.ok(!JSON.stringify(rows).includes('private reasoning'));
  const reasoning = await server.handleWorkerSessionControl(
    frame('read', { self: true, maxCharacters: 4000, includeReasoning: true, includeToolCalls: false }),
    '/workspace/current.jsonl',
  );
  assert.ok(JSON.stringify(reasoning.result.transcript).includes('private reasoning'));
  assert.ok(!JSON.stringify(reasoning.result.transcript).includes('useful output'));
  await assert.rejects(server.handleWorkerSessionControl(
    frame('read', { self: true, direction: 'older', cursor: read.result.cursor, includeReasoning: true }), '/workspace/current.jsonl',
  ), (error: { code?: string }) => error.code === 'READ_CURSOR_INVALIDATED');
});

test('session-control read pages full payloads older and append-only payloads newer with opaque cursors', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-pages-'));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const payload = '0123456789'.repeat(2000);
  installReadSource(server, [textEntry('full-payload', payload)]);
  server.handleRequest = async () => { throw new Error('reads must use the full durable branch'); };
  const read = (options: Record<string, unknown>) => server.handleWorkerSessionControl(
    frame('read', { title: 'Idle plan', maxCharacters: 2000, ...options }), currentPath,
  );
  const latest = await read({ direction: 'latest' });
  assert.equal(typeof latest.result.cursor, 'string');
  assert.equal(latest.result.hasOlder, true);
  assert.equal(latest.result.hasNewer, false);
  const atEnd = await read({ direction: 'newer', cursor: latest.result.cursor });
  assert.deepEqual(atEnd.result.transcript, []);
  const fragments = (result: Record<string, unknown>) => result.transcript as Array<{ text: string; offset: number }>;
  let cursor = latest.result.cursor;
  let reconstructed = fragments(latest.result).map(row => row.text).join('');
  let oldest = latest;
  for (let page = 0; oldest.result.hasOlder && page < 100; page += 1) {
    oldest = await read({ direction: 'older', cursor });
    const rows = fragments(oldest.result);
    assert.ok(rows.length > 0);
    reconstructed = rows.map(row => row.text).join('') + reconstructed;
    cursor = oldest.result.cursor;
  }
  assert.equal(oldest.result.hasOlder, false);
  assert.equal(reconstructed, payload, 'older pages preserve the entire large payload without duplication');
  // Cursors describe the accumulated window, not just the most recent page.
  // An append-only branch can continue newer from its existing right edge.
  installReadSource(server, [textEntry('full-payload', payload), textEntry('append', payload)]);
  reconstructed = '';
  let newer = await read({ direction: 'newer', cursor: oldest.result.cursor });
  for (let page = 0; page < 100; page += 1) {
    reconstructed += fragments(newer.result).map(row => row.text).join('');
    if (!newer.result.hasNewer) break;
    newer = await read({ direction: 'newer', cursor: newer.result.cursor });
  }
  assert.equal(newer.result.hasNewer, false);
  assert.equal(reconstructed, payload, 'newer pages preserve the entire appended payload');
  await assert.rejects(read({ direction: 'older', cursor: { start: 0, end: 1 } }),
    (error: { code?: string }) => error.code === 'INVALID_PARAMS');
});

test('durable creator ownership survives human prompts and cleanup closes only caller-owned sessions', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-ownership-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const runningPath = await writeSessionFile(dir, 'running.jsonl', 'Running plan');
  const runtimePath = await writeSessionFile(dir, 'runtime.jsonl', 'Runtime plan');
  const pendingPath = await writeSessionFile(dir, 'pending.jsonl', 'Pending plan');
  const foreignPath = await writeSessionFile(dir, 'foreign.jsonl', 'Foreign plan');
  const creator = resolveSessionIdentity(currentPath);
  const branches = new Map<string, SessionEntryLike[]>();
  const reads = new Map<string, number>();
  for (const sessionPath of [idlePath, runningPath, runtimePath, pendingPath, foreignPath]) {
    branches.set(sessionPath, [{ type: 'custom', customType: 'pie.agent-created-session',
      data: { version: 1, sessionId: resolveSessionIdentity(sessionPath).sessionId, creator: sessionPath === foreignPath
        ? { sessionId: 'another-owner', identityFallback: false } : creator } } as SessionEntryLike]);
  }
  (server as unknown as { initializeColdSessionStore(): unknown }).initializeColdSessionStore = () => ({
    readSessionControlSource: (sessionPath: string) => {
      const entries = branches.get(sessionPath) ?? [];
      reads.set(sessionPath, (reads.get(sessionPath) ?? 0) + 1);
      const sessionId = resolveSessionIdentity(sessionPath).sessionId;
      return { sessionId, entries, creator: readAgentCreatedSessionCreator({
        getSessionId: () => sessionId, getHeader: () => null, getEntries: () => entries,
      } as never) };
    },
  });
  server.workerRuntimeRouter = { getRoute: (sessionPath) => sessionPath === runtimePath
    ? { state: 'hot', checkpoint: { requestId: 'authoritative-request' } } : { state: 'cold' },
    hasPendingRuntimeWork: (sessionPath) => sessionPath === pendingPath };
  applyMembership(server, membership([
    membershipEntry(currentPath), membershipEntry(idlePath, { agentCreated: false }),
    membershipEntry(runningPath, { activity: 'waiting-user-input' }), membershipEntry(runtimePath), membershipEntry(pendingPath),
    membershipEntry(foreignPath, { agentCreated: true }),
  ]));
  await hydrate(server);
  const list = async () => (await server.handleWorkerSessionControl(frame('list'), currentPath)).result.sessions as Array<Record<string, unknown>>;
  assert.equal((await list()).find(row => row.path === idlePath)?.ownedByCaller, true);
  branches.get(idlePath)!.push(textEntry('human', 'A human now directs this session'));
  const rows = await list();
  assert.equal(rows.find(row => row.path === idlePath)?.ownedByCaller, true);
  assert.deepEqual(rows.find(row => row.path === idlePath)?.creator, creator);
  assert.equal(rows.find(row => row.path === foreignPath)?.ownedByCaller, false);
  assert.equal(reads.get(idlePath), 1, 'speech appends do not reread cached immutable ownership');
  assert.equal(rows.find(row => row.path === pendingPath)?.busy, true);
  const closed: string[] = [];
  (server as unknown as { requestHostSessionClose(...args: unknown[]): Promise<unknown> }).requestHostSessionClose = async (sessionPath) => {
    closed.push(sessionPath as string);
    return { result: { closed: true } };
  };
  const safe = await server.handleWorkerSessionControl(frame('cleanup'), currentPath);
  assert.equal(safe.result.dontCloseRunning, true);
  assert.equal(safe.result.ownedCount, 4);
  assert.equal(safe.result.closedCount, 1);
  assert.equal(safe.result.skippedCount, 3);
  assert.equal(safe.result.failedCount, 0);
  assert.equal(safe.result.unknownCount, 0);
  assert.equal(safe.result.resultsTruncated, false);
  assert.deepEqual(closed, [idlePath]);
  assert.deepEqual((safe.result.results as Array<{ status: string; reason?: string }>).filter(row => row.status === 'skipped').map(row => row.reason), ['running', 'running', 'running']);
  closed.length = 0;
  const forced = await server.handleWorkerSessionControl(frame('cleanup', { dontCloseRunning: false }), currentPath);
  assert.equal(forced.result.closedCount, 4);
  assert.deepEqual(closed, [idlePath, runningPath, runtimePath, pendingPath]);
  assert.equal(reads.get(idlePath), 1, 'cleanup reuses immutable ownership evidence');
  await fs.writeFile(idlePath, JSON.stringify({ type: 'session', id: 'replacement-session', cwd: dir }) + '\n');
  branches.set(idlePath, []);
  assert.equal((await list()).find(row => row.path === idlePath)?.ownedByCaller, false);
  assert.equal(reads.get(idlePath), 2, 'a replacement identity invalidates the creator cache');
});

test('settled handoffs target the durable live creator once and never request another reply', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-handoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const creator = resolveSessionIdentity(currentPath);
  const childSessionId = resolveSessionIdentity(idlePath).sessionId;
  const internal = server as unknown as {
    initializeColdSessionStore(): unknown;
    routeDelegatedHandoff(handoff: DelegatedHandoff, source: string): Promise<void>;
  };
  internal.initializeColdSessionStore = () => ({ readSessionControlSource: () => ({ sessionId: childSessionId, creator }) });
  const requests: Array<{ method: string; params?: unknown }> = [];
  const events: Array<{ event: string; payload?: unknown }> = [];
  server.handleRequest = async request => { requests.push(request); return { queued: true }; };
  server.emit = (event, payload) => events.push({ event, payload });
  const handoff: DelegatedHandoff = { id: 'claim-1', childSessionId, recipient: creator,
    inputIds: ['delivered-input'], outcome: 'completed', text: 'Changed the parser; focused tests pass.' };
  await Promise.all([internal.routeDelegatedHandoff(handoff, idlePath), internal.routeDelegatedHandoff(handoff, idlePath)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'message.send');
  const params = requests[0].params as { sessionPath: string; text: string; coordinatorAttribution: typeof currentSender };
  assert.equal(params.sessionPath, currentPath);
  assert.match(params.text, /Changed the parser/);
  assert.equal(params.coordinatorAttribution.message?.kind, 'completion');
  assert.equal(params.coordinatorAttribution.message?.expectReply, false);
  assert.equal(params.coordinatorAttribution.message?.deliveredAt, undefined, 'queued is not delivered');
  assert.equal(events.some(event => event.event === 'operational-error'), false);
  // The title can disappear/reappear, but the original identity is never reopened.
  applyMembership(server, membership([membershipEntry(idlePath)]));
  await internal.routeDelegatedHandoff({ ...handoff, id: 'claim-closed' }, idlePath);
  assert.equal(requests.length, 1);
  assert.equal(events.at(-1)?.event, 'operational-error');
});

test('unknown handoff sends are not retried and wrong creator identities are rejected', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-handoff-unknown-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath, idlePath } = await readyServerWithMembers(dir);
  const creator = resolveSessionIdentity(currentPath);
  const childSessionId = resolveSessionIdentity(idlePath).sessionId;
  const internal = server as unknown as {
    initializeColdSessionStore(): unknown;
    routeDelegatedHandoff(handoff: DelegatedHandoff, source: string): Promise<void>;
  };
  internal.initializeColdSessionStore = () => ({ readSessionControlSource: () => ({ sessionId: childSessionId, creator }) });
  let sends = 0;
  const incidents: Array<{ certainty: string }> = [];
  server.handleRequest = async () => { sends++; throw new BackendError('UNKNOWN', 'lost acknowledgement'); };
  server.emit = (event, payload) => { if (event === 'operational-error') incidents.push(payload as { certainty: string }); };
  const handoff: DelegatedHandoff = { id: 'unknown', childSessionId, recipient: creator,
    inputIds: ['delivered-input'], outcome: 'cancelled', text: 'Stopped before verification.' };
  await internal.routeDelegatedHandoff(handoff, idlePath);
  await internal.routeDelegatedHandoff(handoff, idlePath);
  assert.equal(sends, 1);
  assert.equal(incidents[0].certainty, 'ambiguous');
  await internal.routeDelegatedHandoff({ ...handoff, id: 'wrong-creator', recipient: resolveSessionIdentity(idlePath) }, idlePath);
  await internal.routeDelegatedHandoff({ ...handoff, id: 'wrong-child', childSessionId: 'old-header' }, idlePath);
  assert.equal(sends, 1);
  assert.equal(incidents.length, 3);
});

test('operation status reports pending and known evidence without replay and read-only access rejects mutations', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-status-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath } = await readyServerWithMembers(dir);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let sends = 0;
  server.handleRequest = async () => { sends += 1; started(); await gate; return { accepted: true }; };
  const payload = { self: true, prompt: 'one send', requestKey };
  const send = server.handleWorkerSessionControl(frame('message', payload), currentPath);
  await admitted;
  const status = async (source = currentPath, key = requestKey) => (
    await server.handleWorkerSessionControl(frame('operation.status', { requestKey: key }), source)
  ).result.operation as Record<string, unknown>;
  assert.equal((await status()).status, 'pending');
  assert.equal((await server.handleWorkerSessionControl(frame('message', payload), currentPath)).result.operation !== undefined, true);
  assert.equal(sends, 1);
  release();
  await send;
  assert.equal((await status()).status, 'known');
  assert.equal((await status()).outcome, 'known');
  await server.handleWorkerSessionControl(frame('message', payload), currentPath);
  assert.equal(sends, 1, 'completed requests are not replayed');
  assert.equal((await status('/other-owner')).status, 'unavailable');
  assert.equal((await status(currentPath, `${Date.now()}:${randomUUID()}`)).status, 'unavailable');
  for (const action of ['create', 'message', 'settings.set', 'close', 'cleanup']) {
    await assert.rejects(server.handleWorkerSessionControl({ ...(frame(action) as object), access: 'read-only' }, currentPath),
      (error: { code?: string }) => error.code === 'INVALID_PARAMS');
  }
  assert.equal(sends, 1);
});

test('post-admission title assignment failure reports an unknown create and receipt without replay', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-create-unknown-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  const creates: Array<{ id: string; method: string; params?: unknown }> = [];
  server.handleRequest = async (request) => {
    if (request.method !== 'session.create') return mockSettingsReply(request);
    creates.push(request);
    // The create was admitted and its cold session durably committed before
    // the required title assignment failed.
    throw new BackendError('LIVE_TITLE_ASSIGNMENT_FAILED', 'LIVE_TITLE_ASSIGNMENT_FAILED: durable title write failed');
  };
  const create = frame('create', { bucket: 'medium', title: 'Unknown create', requestKey });
  const outcome = await server.handleWorkerSessionControl(create, currentPath);
  assert.equal((outcome.result.creation as { status: string }).status, 'unknown');
  assert.equal(creates.length, 1);

  const receipt = (await server.handleWorkerSessionControl(
    frame('operation.status', { requestKey }), currentPath,
  )).result.operation as Record<string, unknown>;
  assert.equal(receipt.status, 'known');
  assert.equal(receipt.outcome, 'unknown');
  assert.equal((receipt.result as { creation?: { status?: string } }).creation?.status, 'unknown');

  const repeated = await server.handleWorkerSessionControl(create, currentPath);
  assert.equal(creates.length, 1, 'the retained receipt is returned instead of replaying the create');
  assert.equal((repeated.result.operation as Record<string, unknown>).outcome, 'unknown');
});

test('pre-admission create validation failure remains a known failed creation', async (t) => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-create-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { server, currentPath } = await readyServerWithMembers(dir);
  installSessionControlSettingsHarness(server);
  const requestKey = `${Date.now()}:${randomUUID()}`;
  server.handleRequest = async (request) => {
    if (request.method !== 'session.create') return mockSettingsReply(request);
    // Pre-admission validation, such as an invalid normalized title, proves
    // no durable session exists.
    throw new BackendError('INVALID_PARAMS', 'create requires a valid title');
  };
  const outcome = await server.handleWorkerSessionControl(
    frame('create', { bucket: 'medium', title: 'Invalid title', requestKey }), currentPath,
  );
  assert.equal((outcome.result.creation as { status: string }).status, 'failed');
  const receipt = (await server.handleWorkerSessionControl(
    frame('operation.status', { requestKey }), currentPath,
  )).result.operation as Record<string, unknown>;
  assert.equal(receipt.status, 'known');
  assert.equal(receipt.outcome, 'known');
  assert.equal((receipt.result as { creation?: { status?: string } }).creation?.status, 'failed');
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
  const server = trackServer(new BackendServer({ analyticsContext: { mode: 'canonical-only', generationId: 'test-capture', buildId: 'test-build', workspaceId: 'test-workspace', hostInstanceId: 'test-host' },
    sdkPath: '/sdk', sourceArtifactDescriptor, cwd: '/workspace', workerEntryPath: '/worker.js', hostCloseHandoffTimeoutMs: 10,
  }));
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
  allowDirectCreator(server, currentPath, pathMod.join(dir, 'idle.jsonl'));
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
  allowDirectCreator(server, currentPath, idlePath);
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

test('list exposes durable admission titles rather than provisional labels', async () => {
  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'session-control-badges-'));
  const currentPath = await writeSessionFile(dir, 'current.jsonl', 'Current plan');
  // idle.jsonl starts untitled and must become addressable on admission.
  const idlePath = await writeSessionFile(dir, 'idle.jsonl');
  const server = serverForTests();
  const writes = installTitleWriter(server);
  applyMembership(server, membership([membershipEntry(currentPath), membershipEntry(idlePath)]));
  await hydrate(server);
  const listed = await server.handleWorkerSessionControl(frame('list'), currentPath);
  const rows = listed.result.sessions as Array<Record<string, unknown>>;
  assert.equal(listed.result.titleNamespaceReady, true);
  const currentRow = rows.find((row) => row.path === currentPath);
  const idleRow = rows.find((row) => row.path === idlePath);
  assert.equal(currentRow?.title, 'Current plan');
  assert.ok(currentRow?.name, 'the provisional label stays visible');
  assert.equal(idleRow?.title, 'New Session');
  assert.equal(writes.length, 1);
  const resolveTarget = (server as unknown as {
    resolveSessionControlTarget(action: string, payload: Record<string, unknown>, sourcePath: string): { sessionPath: string };
  }).resolveSessionControlTarget.bind(server);
  for (const action of ['read', 'message', 'settings.get', 'settings.set', 'close']) {
    assert.equal(resolveTarget(action, { title: 'New Session' }, currentPath).sessionPath, idlePath);
  }
});
