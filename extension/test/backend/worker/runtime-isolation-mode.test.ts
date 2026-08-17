import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import {
  isPhase3IsolatedCoordinatorOperationAllowed,
  resolveRuntimeIsolationMode,
} from '../../../src/backend/runtime-isolation-mode';

test('runtime isolation mode resolves once with legacy default and fails closed on invalid values', () => {
  assert.equal(resolveRuntimeIsolationMode(undefined), 'isolated');
  assert.equal(resolveRuntimeIsolationMode('0'), 'legacy');
  assert.equal(resolveRuntimeIsolationMode('1'), 'isolated');
  for (const value of ['', 'true', '01', '2', 'off', ' 1 ']) {
    assert.throws(() => resolveRuntimeIsolationMode(value), /must be unset, 0, or 1/);
  }
});

test('isolated backend construction fails closed without a bundled worker artifact path', () => {
  assert.throws(() => new BackendServer({
    sdkPath: '/sdk',
    cwd: '/cwd',
    runtimeIsolationMode: 'isolated',
  }), /requires a bundled worker entry path/);
});

test('Phase 3 isolated operation catalog includes runtime-free durable mutations only', () => {
  for (const method of ['app.ping', 'diagnostics.livePipeline.setEnabled', 'provider_gate.metrics', 'session.list', 'session.create', 'session.open', 'session.duplicate', 'session.preload', 'session.loadTranscriptPage', 'session.loadDetail', 'session.truncateAfter', 'models.list', 'settings.get']) {
    assert.equal(isPhase3IsolatedCoordinatorOperationAllowed(method, {}), true, method);
  }
  assert.equal(isPhase3IsolatedCoordinatorOperationAllowed('settings.set', { defaultModel: 'x' }), true);
  assert.equal(isPhase3IsolatedCoordinatorOperationAllowed('settings.set', { sessionPath: '/hot', defaultModel: 'x' }), false);
  for (const method of ['message.send', 'message.compact', 'message.interrupt', 'extension_ui.response', 'systemPromptToggles.set', 'liveTurn.checkpoint']) {
    assert.equal(isPhase3IsolatedCoordinatorOperationAllowed(method, {}), false, method);
  }
});

test('isolated create/duplicate/truncate stay runtime and extension free while hot paths fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-phase3-isolated-'));
  try {
    let runtimeCreations = 0;
    let serviceCreations = 0;
    const manager = (sessionPath: string) => ({
      getCwd: () => root,
      getSessionId: () => path.basename(sessionPath),
      getSessionFile: () => sessionPath,
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
      getTree: () => [],
      buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
    });
    let nextId = 0;
    const server = new BackendServer({
      sdkPath: '/sdk',
      cwd: root,
      runtimeIsolationMode: 'isolated',
      workerEntryPath: '/worker-entry.js',
    }) as any;
    server.agentDir = root;
    server.sessionDir = root;
    server.sessionDirResolved = true;
    server.sdk = {
      VERSION: 'test',
      SessionManager: {
        listAll: async () => [],
        create: () => {
          const sessionPath = path.join(root, `created-${++nextId}.jsonl`);
          fsSync.writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id: `s-${nextId}`, cwd: root })}\n`);
          return manager(sessionPath);
        },
        open: (sessionPath: string) => manager(sessionPath),
        forkFrom: (sourcePath: string) => {
          const sessionPath = path.join(root, `duplicate-${++nextId}.jsonl`);
          fsSync.copyFileSync(sourcePath, sessionPath);
          return manager(sessionPath);
        },
      },
      createAgentSessionServices: async () => { serviceCreations += 1; throw new Error('must not run'); },
      createAgentSessionRuntime: async () => { runtimeCreations += 1; throw new Error('must not run'); },
    };
    server.readModelSettings = async () => ({ defaultModel: 'cold', defaultThinkingLevel: 'medium' });
    server.emit = () => undefined;
    server.emitSessionListChanged = async () => undefined;

    assert.equal((await server.handleRequest({ v: 1, id: 'ping', method: 'app.ping' })).sdkVersion, 'test');
    const created = await server.handleRequest({
      v: 1, id: 'create', method: 'session.create',
      params: { cwd: root, selectionToken: 'create-token', operationId: 'create-op', operationAttempt: 1 },
    });
    const duplicated = await server.handleRequest({
      v: 1, id: 'duplicate', method: 'session.duplicate',
      params: { sessionPath: created.sessionPath, selectionToken: 'duplicate-token' },
    });
    await server.handleRequest({
      v: 1, id: 'truncate', method: 'session.truncateAfter',
      params: { sessionPath: duplicated.sessionPath, entryId: 'missing-entry' },
    });
    const opened = await server.buildSessionOpenedPayload(created.sessionPath, 'open-token');
    assert.equal(opened.runtimeReady, false);

    for (const method of ['message.send', 'message.compact', 'systemPromptToggles.set']) {
      await assert.rejects(
        server.handleRequest({ v: 1, id: method, method, params: { sessionPath: created.sessionPath } }),
        /requires Phase 4 isolated-runtime routing/,
      );
    }
    assert.equal(serviceCreations, 0, 'createAgentSessionServices is never reached');
    assert.equal(runtimeCreations, 0, 'runtime/extension loading is never reached');
    assert.equal(server.sessionContexts.size, 0, 'no AgentSession context is installed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cold truncate retains its replacement inside the mutation owner and rejects a competing mutation without invalidating it', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd' }) as any;
  server.agentDir = '/agent';
  server.sdk = { VERSION: 'test', SessionManager: {} };
  server.emit = () => undefined;
  server.emitSessionListChanged = async () => undefined;
  server.buildSessionOpenedPayload = async (sessionPath: string) => ({ session: { path: sessionPath }, runtimeReady: false });
  let invalidations = 0;
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const handle = { sessionPath: '/cold.jsonl', manager: {}, stamp: {} };
  server.coldSessionStore = {
    leases: { invalidate: () => { invalidations += 1; } },
    truncateAfter: async () => {
      markStarted();
      await blocked;
      return handle;
    },
    ownershipStamp: () => undefined,
  };

  const first = server.handleRequest({
    v: 1, id: 'truncate-first', method: 'session.truncateAfter',
    params: { sessionPath: '/cold.jsonl', entryId: 'entry' },
  });
  await started;
  await assert.rejects(server.handleRequest({
    v: 1, id: 'truncate-second', method: 'session.truncateAfter',
    params: { sessionPath: '/cold.jsonl', entryId: 'entry' },
  }), /cold mutation is already active/);
  assert.equal(invalidations, 1, 'the rejected competitor does not invalidate the active lease');
  release();
  await first;
  assert.equal(server.coldSessionManagerHandles.get(server.coldManagerKey('/cold.jsonl')).handle, handle);
});

test('isolated cold truncate fails closed for equivalent path spellings when a hot owner exists', async () => {
  const server = new BackendServer({
    sdkPath: '/sdk', cwd: '/cwd', runtimeIsolationMode: 'isolated', workerEntryPath: '/worker-entry.js',
  }) as any;
  server.agentDir = '/agent';
  server.sdk = { VERSION: 'test', SessionManager: {} };
  const hotPath = path.resolve('/owned/session.jsonl');
  const aliasPath = `${path.dirname(hotPath)}${path.sep}.${path.sep}${path.basename(hotPath)}`;
  assert.notEqual(aliasPath, hotPath);
  server.sessionContexts.set(hotPath, { sessionPath: hotPath });
  await assert.rejects(
    server.handleRequest({
      v: 1, id: 'truncate-hot', method: 'session.truncateAfter',
      params: { sessionPath: aliasPath, entryId: 'entry' },
    }),
    /Phase 4 isolated-runtime routing is unavailable/,
  );
});
