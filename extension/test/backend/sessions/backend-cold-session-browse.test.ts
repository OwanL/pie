import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { REVIEWS_DIR_ENV } from '../../../src/backend/session-review-store';
import { readSystemPromptTogglesForSession } from '../../../src/backend/system-prompt-toggle-store';
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

async function makeColdServer(options: { sessionCatalog?: any; contextThinkingLevel?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-browse-'));
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, [
    JSON.stringify({ type: 'session', id: 'stable-session-id', version: 3, cwd: dir }),
    JSON.stringify(entry('user-1', 'user', 'hello')),
  ].join('\n') + '\n');
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'model-a', defaultThinkingLevel: 'medium' }));
  await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({
    providers: { mock: { models: [
      { id: 'model-a', name: 'Model A', reasoning: true, contextWindow: 1000 },
      { id: 'model-b', name: 'Model B', reasoning: true, contextWindow: 2000 },
    ] } },
  }));

  let durableBranch: any[] = [entry('user-1', 'user', 'hello')];
  let sessionName: string | undefined;
  let managerOpens = 0;
  let nextEntryId = 0;
  const server = new BackendServer({ workerEntryPath: '/worker-entry.js',
    sdkPath: '/unused',
    cwd: dir,
    sessionCatalog: options.sessionCatalog,
  }) as any;
  server.agentDir = dir;
  server.sdk = {
    VERSION: 'test-sdk',
    SessionManager: {
      async listAll() {
        return [{
          path: sessionPath,
          cwd: dir,
          name: sessionName,
          firstMessage: 'hello',
          modified: new Date('2026-08-13T00:00:00.000Z'),
          messageCount: durableBranch.length,
        }];
      },
      open(openedPath: string) {
        managerOpens += 1;
        const snapshot = [...durableBranch];
        const appendRows = (rows: ReadonlyArray<Record<string, unknown>>): string[] => {
          let parentId = (snapshot.at(-1) as { id?: string } | undefined)?.id ?? null;
          const entries = rows.map((row) => {
            const id = `cold-setting-${++nextEntryId}`;
            const entry = { ...row, id, parentId, timestamp: new Date().toISOString() };
            parentId = id;
            return entry;
          });
          fsSync.appendFileSync(
            openedPath,
            entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
            'utf8',
          );
          snapshot.push(...entries);
          if (openedPath === sessionPath) durableBranch = [...snapshot];
          return entries.map((entry) => entry.id);
        };
        const append = (row: Record<string, unknown>): string => appendRows([row])[0]!;
        return {
          getCwd: () => dir,
          getSessionId: () => 'stable-session-id',
          getSessionFile: () => openedPath,
          getSessionName: () => sessionName,
          getBranch: () => snapshot,
          getEntries: () => snapshot,
          buildSessionContext: () => {
            const model = snapshot.filter((row) => row.type === 'model_change').at(-1) as {
              provider?: string;
              modelId?: string;
            } | undefined;
            const thinking = snapshot.filter((row) => row.type === 'thinking_level_change').at(-1) as {
              thinkingLevel?: string;
            } | undefined;
            return {
              messages: snapshot.filter((row) => row.type === 'message'),
              thinkingLevel: thinking?.thinkingLevel ?? options.contextThinkingLevel ?? 'medium',
              model: {
                provider: model?.provider ?? 'mock',
                modelId: model?.modelId ?? 'model-a',
              },
            };
          },
          appendModelChange: (provider: string, modelId: string) => append({
            type: 'model_change', provider, modelId,
          }),
          appendThinkingLevelChange: (thinkingLevel: string) => append({
            type: 'thinking_level_change', thinkingLevel,
          }),
          appendPieModelSettingsChange: (
            provider: string | undefined,
            modelId: string | undefined,
            thinkingLevel: string | undefined,
          ) => {
            if ((provider === undefined) !== (modelId === undefined)) {
              throw new Error('appendPieModelSettingsChange requires both provider and modelId.');
            }
            const rows: Array<Record<string, unknown>> = [];
            if (provider !== undefined && modelId !== undefined) {
              rows.push({ type: 'model_change', provider, modelId });
            }
            if (thinkingLevel !== undefined) {
              rows.push({ type: 'thinking_level_change', thinkingLevel });
            }
            const ids = appendRows(rows);
            return {
              modelChangeId: provider === undefined ? undefined : ids.shift(),
              thinkingLevelChangeId: thinkingLevel === undefined ? undefined : ids.shift(),
            };
          },
        };
      },
    },
  };
  return {
    dir,
    server,
    sessionPath,
    async append(row: any, targetPath = sessionPath) {
      durableBranch = [...durableBranch, row];
      await fs.appendFile(targetPath, `${JSON.stringify(row)}\n`);
    },
    replaceBranch(rows: any[]) { durableBranch = [...rows]; },
    setSessionName(name: string | undefined) { sessionName = name; },
    counts: () => ({ managerOpens }),
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

    await h.append(entry('assistant-1', 'assistant', 'fresh append'));
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
    assert.deepEqual(h.counts(), { managerOpens: 2 });
    assert.deepEqual(h.server.coldSessionStore.getBrowseCacheStats(), {
      hits: 2,
      misses: 2,
      inflightJoins: 0,
      evictions: 0,
      invalidations: 1,
      entries: 1,
      inflight: 0,
      currentSourceBytes: (await fs.stat(h.sessionPath)).size,
      maxSourceBytes: 128 * 1024 * 1024,
      maxEntries: 4,
    });
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold sessions inherit configured reasoning until the branch records an explicit choice', async () => {
  const h = await makeColdServer({ contextThinkingLevel: 'off' });
  try {
    await fs.writeFile(path.join(h.dir, 'settings.json'), JSON.stringify({
      defaultModel: 'model-a', defaultThinkingLevel: 'high',
    }));
    const inherited = await h.server.buildSessionOpenedPayload(h.sessionPath);
    assert.equal(inherited.session.thinkingLevel, 'high');

    await h.append({
      type: 'thinking_level_change', id: 'thinking-off', parentId: 'user-1',
      timestamp: '2026-08-13T00:00:01.000Z', thinkingLevel: 'off',
    });
    const explicit = await h.server.buildSessionOpenedPayload(h.sessionPath);
    assert.equal(explicit.session.thinkingLevel, 'off');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold list and models.list use coordinator metadata without promotion', async () => {
  const h = await makeColdServer();
  try {
    const sessions = await h.server.handleRequest({
      id: 'list-cold', method: 'session.list',
    });
    assert.deepEqual(sessions.map((session: { path: string }) => session.path), [h.sessionPath]);
    const models = await h.server.handleRequest({
      id: 'models-cold', method: 'models.list', params: { sessionPath: h.sessionPath },
    });
    assert.deepEqual(models.map((model: { id: string }) => model.id), ['model-a', 'model-b']);
    assert.deepEqual(h.counts(), { managerOpens: 0 });
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('coordinator-routed cold settings survive snapshot rebuild and backend-generation replacement without promotion', async () => {
  const h = await makeColdServer();
  try {
    const updated = await h.server.handleRequest({
      id: 'settings-cold-durable',
      method: 'settings.set',
      params: {
        sessionPath: h.sessionPath,
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
    assert.equal(h.server.workerRuntimeRouter, undefined, 'configuration must not promote an execution runtime');

    const hydrated = await h.server.buildSessionOpenedPayload(h.sessionPath);
    assert.equal(hydrated.session.modelId, 'model-b');
    assert.equal(hydrated.session.provider, 'mock');
    assert.equal(hydrated.session.thinkingLevel, 'high');

    // A new ColdSessionStore has no process-local manager or browse cache. It
    // reconstructs only from the durable transcript, matching a backend/VS
    // Code restart rather than accidentally proving an in-memory overlay.
    h.server.coldSessionStore = undefined;
    const afterRestart = await h.server.buildSessionOpenedPayload(h.sessionPath);
    assert.equal(afterRestart.session.modelId, 'model-b');
    assert.equal(afterRestart.session.provider, 'mock');
    assert.equal(afterRestart.session.thinkingLevel, 'high');

    const rows = (await fs.readFile(h.sessionPath, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.slice(-2).map((row) => row.type), [
      'model_change',
      'thinking_level_change',
    ]);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('coordinator-routed cold system-prompt toggles persist and confirm without promotion', async () => {
  const h = await makeColdServer();
  const previousReviewsDir = process.env[REVIEWS_DIR_ENV];
  process.env[REVIEWS_DIR_ENV] = h.dir;
  try {
    const emitted: Array<{ event: string; payload: any }> = [];
    h.server.emit = (event: string, payload: any) => { emitted.push({ event, payload }); };

    const result = await h.server.handleRequest({
      id: 'system-prompts-cold-durable',
      method: 'systemPromptToggles.set',
      params: {
        sessionPath: h.sessionPath,
        disabledEntries: ['skills', 'tools'],
      },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(h.server.workerRuntimeRouter, undefined, 'a config-only write must not promote a runtime');
    assert.deepEqual(await readSystemPromptTogglesForSession(h.sessionPath), ['skills', 'tools']);
    assert.deepEqual(emitted.at(-1), {
      event: 'session.opened',
      payload: {
        ...emitted.at(-1)!.payload,
        systemPromptDisabledEntries: ['skills', 'tools'],
      },
    });
  } finally {
    if (previousReviewsDir === undefined) delete process.env[REVIEWS_DIR_ENV];
    else process.env[REVIEWS_DIR_ENV] = previousReviewsDir;
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

    const payload = await h.server.buildSessionOpenedPayload(
      h.sessionPath,
      'selection-huge',
      undefined,
      undefined,
      undefined,
      undefined,
      ['skills'],
    );

    assert.equal(payload.snapshotUnavailable?.code, 'SESSION_SNAPSHOT_TOO_LARGE');
    assert.equal(payload.session.path, h.sessionPath);
    assert.equal(payload.session.sessionId, 'stable-session-id');
    assert.equal(payload.session.name, 'Conversation snapshot unavailable');
    assert.equal(payload.selectionToken, 'selection-huge');
    assert.equal(payload.runtimeReady, false);
    assert.equal(payload.availableModels, undefined);
    assert.equal(payload.modelSettings, undefined);
    assert.deepEqual(payload.systemPromptDisabledEntries, ['skills']);
    assert.ok(sessionSnapshotLineBytes(payload, { kind: 'event', event: 'session.opened' }) <= SESSION_SNAPSHOT_MAX_LINE_BYTES);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold detail reads the current durable file without promoting a runtime', async () => {
  const h = await makeColdServer();
  try {
    h.replaceBranch([entry('user-1', 'user', 'hello')]);
    await fs.writeFile(h.sessionPath, [
      JSON.stringify({ type: 'session', id: 'stable-session-id', version: 3, cwd: h.dir }),
      JSON.stringify(entry('user-1', 'user', 'hello')),
    ].join('\n') + '\n');

    const detail = await h.server.loadDetail(h.sessionPath, {
      key: 'reasoning-old', sessionPath: h.sessionPath, kind: 'reasoning', source: 'durable',
      messageId: 'assistant-reasoning', partIndex: 0, summary: 'old', available: true, sizeBytes: 3,
    });
    assert.equal(detail.status, 'unavailable');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('an externally rewritten retained session evicts its stale manager and reopens once', async () => {
  const h = await makeColdServer();
  try {
    const createdPath = path.join(h.dir, 'externally-rewritten.jsonl');
    await fs.writeFile(createdPath, `${JSON.stringify({ type: 'session', id: 'rewritten', version: 3, cwd: h.dir })}\n`);
    const createdManager = h.server.sdk.SessionManager.open(createdPath);
    h.server.sdk.SessionManager.create = () => createdManager;
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;
    await h.server.handleRequest({ id: 'create-rewritten', method: 'session.create', params: { cwd: h.dir } });
    const opensBeforeRewrite = h.counts().managerOpens;

    const externalEntry = entry('assistant-after-rewrite', 'assistant', 'external');
    await h.append(externalEntry, createdPath);
    const payload = await h.server.buildSessionOpenedPayload(createdPath);

    assert.equal(payload.runtimeReady, false);
    assert.equal(h.counts().managerOpens, opensBeforeRewrite + 1);
    assert.equal(h.server.coldSessionManagerHandles.size, 0, 'the stale handle is not selected again');
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('public JSONL app.ping reaches the response writer before a blocked cold catalog operation is released', async () => {
  let markStarted!: () => void;
  let releaseList!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseList = resolve; });
  const catalog = {
    invalidateIfInventoryChanged: async () => false,
    list: async () => {
      markStarted();
      await blocked;
      return [];
    },
    refresh: () => undefined,
    remove: () => undefined,
  };
  const h = await makeColdServer({ sessionCatalog: catalog });
  const originalWrite = process.stdout.write;
  const responses: Array<{ id: string; ok: boolean; result?: any }> = [];
  let markPingWritten!: () => void;
  let markListWritten!: () => void;
  const pingWritten = new Promise<void>((resolve) => { markPingWritten = resolve; });
  const listWritten = new Promise<void>((resolve) => { markListWritten = resolve; });
  (process.stdout as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    let captured = false;
    for (const line of text.trim().split('\n')) {
      try {
        const response = JSON.parse(line) as { id?: unknown; ok?: unknown; result?: unknown };
        if ((response.id === 'causal-ping' || response.id === 'blocked-list')
            && typeof response.ok === 'boolean') {
          responses.push(response as { id: string; ok: boolean; result?: any });
          if (response.id === 'causal-ping') markPingWritten();
          else markListWritten();
          captured = true;
        }
      } catch {
        // Non-protocol test-runner output stays on the real stdout stream.
      }
    }
    if (!captured) {
      return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback, callback);
    }
    if (typeof done === 'function') done(null);
    return true;
  };

  let released = false;
  try {
    const listing = h.server.handleLine(JSON.stringify({ id: 'blocked-list', method: 'session.list' }));
    await started;
    const pingHandling = h.server.handleLine(JSON.stringify({ id: 'causal-ping', method: 'app.ping' }));
    let pingDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pingWritten,
        new Promise<never>((_resolve, reject) => {
          pingDeadline = setTimeout(
            () => reject(new Error('correlated app.ping did not cross the JSONL writer before the causal deadline')),
            5_000,
          );
        }),
      ]);
    } finally {
      if (pingDeadline) clearTimeout(pingDeadline);
    }

    assert.equal(released, false, 'the correlated ping response crossed the writer before release');
    assert.deepEqual(responses.map((response) => response.id), ['causal-ping']);
    assert.equal(responses[0]?.ok, true);
    assert.equal(responses[0]?.result?.sdkVersion, 'test-sdk');

    released = true;
    releaseList();
    await Promise.all([listing, pingHandling, listWritten]);
    assert.deepEqual(
      responses.map((response) => response.id),
      ['causal-ping', 'blocked-list'],
      'responses stay FIFO within the response lane once each handler settles',
    );
  } finally {
    releaseList();
    (process.stdout as any).write = originalWrite;
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('cold forget routes through the store and removes the durable session without runtime creation', async () => {
  const h = await makeColdServer();
  try {
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;
    assert.deepEqual(await h.server.handleRequest({
      id: 'forget-cold', method: 'session.forget', params: { sessionPath: h.sessionPath },
    }), { sessionPath: h.sessionPath, forgotten: true });
    assert.equal(await fs.stat(h.sessionPath).then(() => true, () => false), false);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('a cold read that arrives during promotion waits for the hot owner instead of reopening under its fence', async () => {
  const h = await makeColdServer();
  try {
    let releasePromotion!: () => void;
    const promotion = new Promise<void>((resolve) => { releasePromotion = resolve; });
    let hot = false;
    const routed: Array<{ id: string; method: string; params?: unknown }> = [];
    h.server.workerRuntimeRouter = {
      getRoute: () => hot
        ? { state: 'hot', rootSessionPath: h.sessionPath }
        : { state: 'promoting', rootSessionPath: h.sessionPath, promotion },
      hasHotOwner: () => hot,
      routeExisting: async (request: { id: string; method: string; params?: unknown }) => {
        routed.push(request);
        return { ok: true, sessionPath: h.sessionPath };
      },
    };
    let coldBuilds = 0;
    h.server.buildSessionOpenedPayload = async () => {
      coldBuilds += 1;
      throw new Error('the promoting path must not be reopened through cold ownership');
    };

    const opening = h.server.handleRequest({
      id: 'open-during-promotion',
      method: 'session.open',
      params: {
        sessionPath: h.sessionPath,
        selectionToken: 'selection-during-promotion',
        operationId: 'open-operation',
        operationAttempt: 2,
      },
    });
    await Promise.resolve();
    assert.equal(coldBuilds, 0, 'the read remains parked behind the promotion owner');
    assert.deepEqual(routed, []);

    hot = true;
    releasePromotion();
    assert.deepEqual(await opening, { ok: true, sessionPath: h.sessionPath });
    assert.equal(coldBuilds, 0);
    assert.deepEqual(routed, [{
      id: 'open-during-promotion',
      method: 'session.open',
      params: {
        sessionPath: h.sessionPath,
        selectionToken: 'selection-during-promotion',
        operationId: 'open-operation',
        operationAttempt: 2,
      },
    }]);
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});

test('stale cold session.opened publication follows promotion and refreshes through the hot owner', async () => {
  const h = await makeColdServer();
  try {
    const stale = await h.server.buildSessionOpenedPayload(
      h.sessionPath,
      'stale-selection',
      'skip',
      undefined,
      'stale-open-operation',
      3,
    );
    let releasePromotion!: () => void;
    const promotion = new Promise<void>((resolve) => { releasePromotion = resolve; });
    let hot = false;
    let routedResolve!: (request: { id: string; method: string; params?: unknown }) => void;
    const routed = new Promise<{ id: string; method: string; params?: unknown }>((resolve) => {
      routedResolve = resolve;
    });
    h.server.workerRuntimeRouter = {
      getRoute: () => hot
        ? { state: 'hot', rootSessionPath: h.sessionPath }
        : { state: 'promoting', rootSessionPath: h.sessionPath, promotion },
      hasHotOwner: () => hot,
      routeExisting: async (request: { id: string; method: string; params?: unknown }) => {
        routedResolve(request);
        return { ok: true, sessionPath: h.sessionPath };
      },
    };
    let coldBuilds = 0;
    h.server.buildSessionOpenedPayload = async () => {
      coldBuilds += 1;
      throw new Error('stale publication must not retry against the hot ownership fence');
    };
    h.server.coldSessionStore.leases.invalidate(h.sessionPath);

    h.server.emit('session.opened', stale);
    await Promise.resolve();
    assert.equal(coldBuilds, 0, 'publication recovery waits while ownership is promoting');

    hot = true;
    releasePromotion();
    const request = await routed;
    assert.equal(coldBuilds, 0);
    assert.equal(request.method, 'session.open');
    assert.match(request.id, /^cold-publication-refresh:/u);
    assert.deepEqual(request.params, {
      sessionPath: h.sessionPath,
      selectionToken: 'stale-selection',
      transcript: 'skip',
      operationId: 'stale-open-operation',
      operationAttempt: 3,
    });
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
    await fs.writeFile(createdPath, `${JSON.stringify({ type: 'session', id: 'created', version: 3, cwd: h.dir })}\n`);
    h.server.sdk.SessionManager.create = () => h.server.sdk.SessionManager.open(createdPath);
    h.server.emit = () => undefined;
    h.server.emitSessionListChanged = async () => undefined;
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const started = new Promise<void>((resolve) => { createStarted = resolve; });
    const originalBuild = h.server.buildSessionOpenedPayload.bind(h.server);
    h.server.buildSessionOpenedPayload = async (...args: unknown[]) => {
      if (args[0] === createdPath) {
        createStarted();
        await blocked;
      }
      return await originalBuild(...args);
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
  } finally {
    await fs.rm(h.dir, { recursive: true, force: true });
  }
});
