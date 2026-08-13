import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import type { SessionContext } from '../../../src/backend/server-types';
import { SESSION_SNAPSHOT_MAX_LINE_BYTES, sessionSnapshotLineBytes } from '../../../src/shared/transcript-window';

function entry(id: string, role: 'user' | 'assistant', text: string) {
  return {
    type: 'message',
    id,
    timestamp: '2026-08-13T00:00:00.000Z',
    message: role === 'user'
      ? { role, content: text }
      : { role, content: [{ type: 'text', text }], usage: { input: 1, output: 1, totalTokens: 2 } },
  };
}

async function makeColdServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-browse-'));
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, [
    JSON.stringify({ type: 'session', id: 'stable-session-id', version: 3, cwd: dir }),
    JSON.stringify(entry('user-1', 'user', 'hello')),
  ].join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'model-a', defaultThinkingLevel: 'medium' }));
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({
    providers: { mock: { models: [{ id: 'model-a', name: 'Model A', reasoning: true, contextWindow: 1000 }] } },
  }));

  let durableBranch: any[] = [entry('user-1', 'user', 'hello')];
  let sessionName: string | undefined;
  let managerOpens = 0;
  let runtimeCreations = 0;
  const server = new BackendServer({ sdkPath: '/unused', cwd: dir }) as any;
  server.agentDir = dir;
  server.sdk = {
    VERSION: 'test-sdk',
    SessionManager: {
      open(openedPath: string) {
        managerOpens += 1;
        const snapshot = [...durableBranch];
        return {
          getCwd: () => dir,
          getSessionId: () => 'stable-session-id',
          getSessionFile: () => openedPath,
          getSessionName: () => sessionName,
          getBranch: () => snapshot,
          getEntries: () => snapshot,
          buildSessionContext: () => ({
            messages: snapshot.filter((row) => row.type === 'message'),
            thinkingLevel: 'medium',
            model: { provider: 'mock', modelId: 'model-a' },
          }),
        };
      },
    },
  };
  server.createSessionContext = async () => {
    runtimeCreations += 1;
    throw new Error('cold browsing must not create a runtime');
  };
  return {
    dir,
    server,
    sessionPath,
    append(row: any) { durableBranch = [...durableBranch, row]; },
    replaceBranch(rows: any[]) { durableBranch = [...rows]; },
    setSessionName(name: string | undefined) { sessionName = name; },
    counts: () => ({ managerOpens, runtimeCreations }),
  };
}

test('cold open/preload/page/detail projections remain runtime-free and pages revalidate durable state', async () => {
  const h = await makeColdServer();
  try {
    const opened = await h.server.buildSessionOpenedPayload(h.sessionPath, 'selection-1');
    const preloaded = await h.server.buildSessionOpenedPayload(
      h.sessionPath,
      undefined,
      'tail',
      { kind: 'response', requestId: 'preload-1' },
    );
    assert.equal(opened.runtimeReady, false);
    assert.equal(preloaded.runtimeReady, false);
    assert.equal(opened.busy, false);
    assert.equal(opened.session.sessionId, 'stable-session-id');
    assert.equal(opened.sessionUsage.samples.length, 0);

    h.append(entry('assistant-1', 'assistant', 'fresh append'));
    const page = await h.server.loadTranscriptPage(h.sessionPath, 'latest');
    assert.deepEqual(page.transcript.map((message: { id: string }) => message.id), ['user-1', 'assistant-1']);
    assert.equal(page.busy, false);

    const detail = await h.server.loadDetail(h.sessionPath, {
      key: 'missing-detail',
      sessionPath: h.sessionPath,
      kind: 'reasoning',
      source: 'durable',
      messageId: 'assistant-1',
      summary: 'missing',
      available: true,
      sizeBytes: 1,
    });
    assert.equal(detail.status, 'unavailable');
    assert.deepEqual(h.counts(), { managerOpens: 4, runtimeCreations: 0 });
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold models.list is configured-catalog-only and does not promote', async () => {
  const h = await makeColdServer();
  try {
    const models = await h.server.handleRequest({
      id: 'models-cold', method: 'models.list', params: { sessionPath: h.sessionPath },
    });
    assert.deepEqual(models.map((model: { id: string }) => model.id), ['model-a']);
    assert.deepEqual(h.counts(), { managerOpens: 0, runtimeCreations: 0 });
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('open racing promotion joins the hot refresh and never publishes a stale cold snapshot', async () => {
  const h = await makeColdServer();
  try {
    let releaseSettings!: () => void;
    const settingsBlocked = new Promise<void>((resolve) => { releaseSettings = resolve; });
    h.server.readModelSettings = async () => {
      await settingsBlocked;
      return { defaultModel: 'model-a', defaultThinkingLevel: 'medium' };
    };
    const hotContext = { sessionPath: h.sessionPath } as SessionContext;
    h.server.createSessionContext = async () => {
      h.server.sessionContexts.set(h.sessionPath, hotContext);
      return hotContext;
    };
    h.server.buildHotSessionOpenedPayload = async (_path: string, selectionToken?: string) => ({
      session: { path: h.sessionPath }, runtimeReady: true, busy: false, selectionToken,
    });
    h.server.emit = () => undefined;

    const browse = h.server.buildSessionOpenedPayload(h.sessionPath, 'selection-race');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const promotion = h.server.ensureSessionContext(h.sessionPath);
    releaseSettings();

    const [payload, promoted] = await Promise.all([browse, promotion]);
    assert.equal(promoted, hotContext);
    assert.equal(payload.runtimeReady, true);
    assert.equal(payload.selectionToken, 'selection-race');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold session.opened has a metadata-independent bounded fallback for huge names, settings, and configured catalogs', async () => {
  const h = await makeColdServer();
  try {
    const huge = 'x'.repeat(31 * 1024 * 1024);
    h.setSessionName(huge);
    await fs.writeFile(path.join(h.dir, 'settings.json'), JSON.stringify({ defaultModel: huge, defaultThinkingLevel: 'medium' }));
    await fs.writeFile(path.join(h.dir, 'models.json'), JSON.stringify({
      providers: { mock: { models: [{ id: 'model-a', name: huge, reasoning: true }] } },
    }));

    const payload = await h.server.buildSessionOpenedPayload(h.sessionPath, 'selection-huge');

    assert.equal(payload.snapshotUnavailable?.code, 'SESSION_SNAPSHOT_TOO_LARGE');
    assert.equal(payload.session.path, h.sessionPath);
    assert.equal(payload.session.sessionId, 'stable-session-id');
    assert.equal(payload.session.name, 'Conversation snapshot unavailable');
    assert.equal(payload.selectionToken, 'selection-huge');
    assert.equal(payload.runtimeReady, false);
    assert.equal(payload.availableModels, undefined);
    assert.equal(payload.modelSettings, undefined);
    assert.ok(sessionSnapshotLineBytes(payload, { kind: 'event', event: 'session.opened' }) <= SESSION_SNAPSHOT_MAX_LINE_BYTES);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold page joins a promotion that starts during its durable read and does not return stale busy:false', async () => {
  const h = await makeColdServer();
  try {
    let releaseFingerprint!: () => void;
    const fingerprintBlocked = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
    let fingerprintCalls = 0;
    h.server.readColdBrowseFileFingerprint = async () => {
      fingerprintCalls += 1;
      if (fingerprintCalls === 1) await fingerprintBlocked;
      return 'stable';
    };
    h.server.readColdBrowseFileFingerprintSync = () => 'stable';
    const hotRows = [entry('user-hot', 'user', 'hot'), entry('assistant-hot', 'assistant', 'authoritative')];
    const hotContext = {
      sessionPath: h.sessionPath,
      session: {
        isStreaming: true,
        isCompacting: false,
        sessionManager: { getBranch: () => hotRows },
      },
      activeRequest: { id: 'active' },
    } as unknown as SessionContext;
    h.server.createSessionContext = async () => {
      h.server.sessionContexts.set(h.sessionPath, hotContext);
      return hotContext;
    };
    h.server.buildHotSessionOpenedPayload = async () => ({ session: { path: h.sessionPath }, runtimeReady: true });
    h.server.emit = () => undefined;

    const pagePromise = h.server.loadTranscriptPage(h.sessionPath, 'latest');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const promotionPromise = h.server.ensureSessionContext(h.sessionPath);
    await promotionPromise;
    releaseFingerprint();

    const page = await pagePromise;
    assert.equal(page.busy, true);
    assert.deepEqual(page.transcript.map((message: { id: string }) => message.id), ['user-hot', 'assistant-hot']);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold detail reopens after a concurrent file rewrite and never returns obsolete content', async () => {
  const h = await makeColdServer();
  try {
    h.replaceBranch([entry('user-1', 'user', 'hello'), {
      type: 'message', id: 'assistant-reasoning', timestamp: '2026-08-13T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'old' }], usage: { input: 1, output: 1, totalTokens: 2 } },
    }]);
    let releaseSecondFingerprint!: () => void;
    let markSecondStarted!: () => void;
    const secondFingerprintStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const secondFingerprintBlocked = new Promise<void>((resolve) => { releaseSecondFingerprint = resolve; });
    let fingerprintCalls = 0;
    h.server.readColdBrowseFileFingerprint = async () => {
      fingerprintCalls += 1;
      if (fingerprintCalls === 2) {
        markSecondStarted();
        await secondFingerprintBlocked;
        return 'version-2';
      }
      return fingerprintCalls === 1 ? 'version-1' : 'version-2';
    };
    h.server.readColdBrowseFileFingerprintSync = () => 'version-2';

    const detailPromise = h.server.loadDetail(h.sessionPath, {
      key: 'reasoning-old', sessionPath: h.sessionPath, kind: 'reasoning', source: 'durable',
      messageId: 'assistant-reasoning', partIndex: 0, summary: 'old', available: true, sizeBytes: 3,
    });
    await secondFingerprintStarted;
    h.replaceBranch([entry('user-1', 'user', 'hello')]);
    await fs.writeFile(h.sessionPath, [
      JSON.stringify({ type: 'session', id: 'stable-session-id', version: 3, cwd: h.dir }),
      JSON.stringify(entry('user-1', 'user', 'hello')),
    ].join('\n') + '\n');
    releaseSecondFingerprint();

    const detail = await detailPromise;
    assert.equal(detail.status, 'unavailable');
    assert.ok(h.counts().managerOpens >= 2, 'the changed file is reopened before detail lookup');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('host-local preloaded cold selections stay runtime-free and promotion consumes the latest real predecessor', async () => {
  const h = await makeColdServer();
  try {
    const a = path.join(h.dir, 'a.jsonl');
    const b = h.sessionPath;
    const c = path.join(h.dir, 'c.jsonl');
    const header = JSON.stringify({ type: 'session', id: 'stable-session-id', version: 3, cwd: h.dir });
    await Promise.all([a, c].map((file) => fs.writeFile(file, `${header}\n`)));
    h.server.viewedSessionPath = a;
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;

    // Startup hydration knows B and C durably but must not treat either preload
    // as a viewed transition or materialize execution services.
    await h.server.handleRequest({ id: 'preload-b', method: 'session.preload', params: { sessionPath: b } });
    await h.server.handleRequest({ id: 'preload-c', method: 'session.preload', params: { sessionPath: c } });
    assert.equal(h.counts().runtimeCreations, 0);

    for (const [id, sessionPath, previousSessionPath] of [
      ['view-b', b, a],
      ['view-c', c, b],
      ['revisit-b', b, c],
      ['same-b', b, b],
    ] as const) {
      await h.server.handleRequest({
        id, method: 'session.viewed', params: { sessionPath, previousSessionPath },
      });
    }
    assert.equal(h.counts().runtimeCreations, 0, 'view notifications do not create runtimes or reread transcripts');

    let capturedPrevious: string | undefined;
    const hotContext = { sessionPath: b } as SessionContext;
    h.server.createSessionContext = async (_manager: unknown, _reason: unknown, previousSessionFile?: string) => {
      capturedPrevious = previousSessionFile;
      h.server.sessionContexts.set(b, hotContext);
      return hotContext;
    };
    h.server.buildHotSessionOpenedPayload = async () => ({ session: { path: b }, runtimeReady: true });
    await h.server.ensureSessionContext(b);

    assert.equal(capturedPrevious, c, 'A→preloaded B→cold C→B promotes B with C');
    assert.notEqual(capturedPrevious, b, 'same-path B→B is a no-op');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('a slow create cannot overwrite a newer host-local viewed transition', async () => {
  const h = await makeColdServer();
  try {
    const a = path.join(h.dir, 'a.jsonl');
    const b = h.sessionPath;
    const createdPath = path.join(h.dir, 'created.jsonl');
    h.server.viewedSessionPath = a;
    h.server.sdk.SessionManager.create = () => ({ createdPath });
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;
    h.server.buildSessionOpenedPayload = async (sessionPath: string, selectionToken?: string) => ({
      session: { path: sessionPath }, selectionToken, transcript: [], busy: false,
    });
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const started = new Promise<void>((resolve) => { createStarted = resolve; });
    h.server.createSessionContext = async () => {
      createStarted();
      await blocked;
      return {
        sessionPath: createdPath,
        session: { isStreaming: false, isCompacting: false },
      } as SessionContext;
    };

    const create = h.server.handleRequest({
      id: 'create', method: 'session.create', params: { cwd: h.dir, selectionToken: 'create' },
    });
    await started;
    await h.server.handleRequest({
      id: 'view-b', method: 'session.viewed', params: { sessionPath: b, previousSessionPath: a },
    });
    releaseCreate();
    await create;

    assert.equal(h.server.viewedSessionPath, b);
    assert.equal(h.counts().runtimeCreations, 0);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('a slow cold session.open cannot overwrite a newer host-local viewed transition', async () => {
  const h = await makeColdServer();
  try {
    const b = h.sessionPath;
    const c = path.join(h.dir, 'c.jsonl');
    await fs.writeFile(c, `${JSON.stringify({ type: 'session', id: 'c', version: 3, cwd: h.dir })}\n`);
    h.server.viewedSessionPath = b;
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;

    let releaseOpen!: () => void;
    let openStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const started = new Promise<void>((resolve) => { openStarted = resolve; });
    const originalBuild = h.server.buildSessionOpenedPayload.bind(h.server);
    h.server.buildSessionOpenedPayload = async (...args: unknown[]) => {
      if (args[0] === c) {
        openStarted();
        await blocked;
      }
      return await originalBuild(...args);
    };

    const openC = h.server.handleRequest({
      id: 'open-c', method: 'session.open', params: { sessionPath: c, selectionToken: 'open-c' },
    });
    await started;
    await h.server.handleRequest({
      id: 'back-b', method: 'session.viewed', params: { sessionPath: b, previousSessionPath: c },
    });
    releaseOpen();
    await openC;

    assert.equal(h.server.viewedSessionPath, b);
    assert.equal(h.server.browsePreviousSessionFiles.get(b), c);
    assert.equal(h.counts().runtimeCreations, 0);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});
