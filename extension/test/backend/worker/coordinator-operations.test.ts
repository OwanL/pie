import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import { isCoordinatorOperationAllowed } from '../../../src/backend/coordinator-operations';

test('backend construction fails closed without a bundled worker artifact path', () => {
  assert.throws(() => new BackendServer({ sdkPath: '/sdk', cwd: '/cwd' }), /requires a bundled worker entry path/);
});

test('coordinator operation catalog includes runtime-free durable mutations only', () => {
  for (const method of ['app.ping', 'diagnostics.livePipeline.setEnabled', 'mcp.list', 'mcp.setServerEnabled', 'openTabs.set', 'provider_gate.metrics', 'session.list', 'session.create', 'session.open', 'session.duplicate', 'session.preload', 'session.loadTranscriptPage', 'session.loadDetail', 'session.truncateAfter', 'models.list', 'settings.get', 'systemPromptToggles.set']) {
    assert.equal(isCoordinatorOperationAllowed(method, {}), true, method);
  }
  assert.equal(isCoordinatorOperationAllowed('settings.set', { defaultModel: 'x' }), true);
  assert.equal(isCoordinatorOperationAllowed('settings.set', { sessionPath: '/hot', defaultModel: 'x' }), true);
  for (const method of ['message.send', 'message.compact', 'message.interrupt', 'extension_ui.response', 'liveTurn.checkpoint']) {
    assert.equal(isCoordinatorOperationAllowed(method, {}), false, method);
  }
});

test('coordinator open-tab mirror cannot regress when an older broadcast settles last', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
  let settleOlder!: (value: { applied: true; revision: number; retiredWorkers: number }) => void;
  let settleNewer!: (value: { applied: true; revision: number; retiredWorkers: number }) => void;
  const older = new Promise<{ applied: true; revision: number; retiredWorkers: number }>((resolve) => {
    settleOlder = resolve;
  });
  const newer = new Promise<{ applied: true; revision: number; retiredWorkers: number }>((resolve) => {
    settleNewer = resolve;
  });
  server.workerRuntimeRouter = {
    syncSessionRegistry: (_tabs: unknown[], sourceRevision: number) => sourceRevision === 1 ? older : newer,
  };

  const previousTabs = process.env['PIE_OPEN_TABS'];
  const previousRevision = process.env['PIE_OPEN_TABS_REVISION'];
  try {
    const olderRequest = server.handleRequest({
      v: 1,
      id: 'registry-older',
      method: 'openTabs.set',
      params: { tabs: [{ path: '/older.jsonl' }], revision: 1 },
    });
    const newerRequest = server.handleRequest({
      v: 1,
      id: 'registry-newer',
      method: 'openTabs.set',
      params: { tabs: [{ path: '/newer.jsonl' }], revision: 2 },
    });

    settleNewer({ applied: true, revision: 3, retiredWorkers: 0 });
    await newerRequest;
    settleOlder({ applied: true, revision: 2, retiredWorkers: 0 });
    await olderRequest;

    assert.equal(process.env['PIE_OPEN_TABS_REVISION'], '3');
    assert.deepEqual(JSON.parse(process.env['PIE_OPEN_TABS'] ?? 'null'), [{ path: '/newer.jsonl' }]);
  } finally {
    if (previousTabs === undefined) delete process.env['PIE_OPEN_TABS'];
    else process.env['PIE_OPEN_TABS'] = previousTabs;
    if (previousRevision === undefined) delete process.env['PIE_OPEN_TABS_REVISION'];
    else process.env['PIE_OPEN_TABS_REVISION'] = previousRevision;
  }
});

test('cold create/duplicate/truncate stay runtime and extension free while hot paths fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-coordinator-cold-'));
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

    for (const method of ['message.send', 'message.compact']) {
      await assert.rejects(
        server.handleRequest({ v: 1, id: method, method, params: { sessionPath: created.sessionPath } }),
        /requires Phase 4 isolated-runtime routing/,
      );
    }
    assert.equal(serviceCreations, 0, 'createAgentSessionServices is never reached');
    assert.equal(runtimeCreations, 0, 'runtime/extension loading is never reached');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function editServer(options: {
  truncate(onCommit: () => void): Promise<{ sessionPath: string }>;
  send?(): Promise<Record<string, unknown>>;
}) {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
  let truncateCalls = 0;
  let sendCalls = 0;
  server.agentDir = '/agent';
  server.sdk = { VERSION: 'test', SessionManager: {} };
  server.emitSessionListChanged = async () => undefined;
  server.coldSessionStore = {
    leases: { invalidate: () => undefined },
    truncateAfter: async (_sessionPath: string, _entryId: string, truncateOptions: { onCommit(): void }) => {
      truncateCalls += 1;
      return await options.truncate(truncateOptions.onCommit);
    },
  };
  let hot = false;
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: hot ? 'hot' : 'cold', rootSessionPath: '/cold.jsonl' }),
    operationCancellationGeneration: () => 0,
    hasMessageOperationOwner: () => false,
    hasHotOwner: () => hot,
    promote: async () => { hot = true; return { state: 'hot' }; },
    runHotTransition: async (_path: string, _key: string, operation: (control: unknown) => Promise<unknown>) => (
      await operation({
        interrupt: async () => ({ soft: true }),
        retire: async () => undefined,
        promote: async () => ({ state: 'hot' }),
        assertActive: () => undefined,
        routePromoted: async () => {
          sendCalls += 1;
          return await (options.send?.() ?? Promise.resolve({ requestId: 'replacement-request' }));
        },
      })
    ),
    routeExisting: async () => ({ operationId: 'status', state: 'accepted', committed: false }),
  };
  return {
    server,
    counts: () => ({ truncateCalls, sendCalls }),
    request: (operationId: string, text = 'replacement', operationAttempt = 1) => server.handleRequest({
      v: 1,
      id: `edit-${operationAttempt}`,
      method: 'message.edit',
      params: {
        sessionPath: '/cold.jsonl', messageId: 'target', text, inputs: [], localId: 'local:edit',
        operationId, operationAttempt,
      },
    }),
    status: (operationId: string) => server.handleRequest({
      v: 1,
      id: `status-${operationId}`,
      method: 'operation.status',
      params: { sessionPath: '/cold.jsonl', operationId },
    }),
  };
}

test('message.edit records pre/post-commit failure evidence and never replays a committed truncate', async () => {
  const precommit = editServer({ truncate: async () => { throw new Error('before rename'); } });
  await assert.rejects(precommit.request('edit-precommit'), /before rename/);
  assert.deepEqual(await precommit.status('edit-precommit'), {
    operationId: 'edit-precommit', state: 'failed', code: 'MESSAGE_OPERATION_REJECTED',
    message: 'before rename', outcome: 'failed', committed: false,
  });
  await assert.rejects(precommit.request('edit-precommit', 'replacement', 2), /before rename/);
  assert.deepEqual(precommit.counts(), { truncateCalls: 1, sendCalls: 0 });

  const postcommit = editServer({
    truncate: async (onCommit) => {
      onCommit();
      return { sessionPath: '/cold.jsonl' };
    },
    send: async () => { throw new Error('replacement rejected'); },
  });
  await assert.rejects(postcommit.request('edit-postcommit'), /replacement rejected/);
  assert.deepEqual(await postcommit.status('edit-postcommit'), {
    operationId: 'edit-postcommit', state: 'failed', code: 'MESSAGE_OPERATION_REJECTED',
    message: 'replacement rejected', outcome: 'failed', committed: true,
  });
  await assert.rejects(postcommit.request('edit-postcommit', 'replacement', 2), /replacement rejected/);
  assert.deepEqual(postcommit.counts(), { truncateCalls: 1, sendCalls: 1 });
});

test('message.edit joins/replays retries and rejects changed intent without another truncate or send', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = editServer({
    truncate: async (onCommit) => {
      await blocked;
      onCommit();
      return { sessionPath: '/cold.jsonl' };
    },
  });
  const first = h.request('edit-replay');
  const joined = h.request('edit-replay', 'replacement', 2);
  assert.deepEqual(await h.status('edit-replay'), {
    operationId: 'edit-replay', state: 'pending', committed: false,
  });
  release();
  assert.equal((await first).requestId, 'replacement-request');
  assert.equal((await joined).operationAttempt, 2);
  assert.equal((await h.request('edit-replay', 'replacement', 3)).requestId, 'replacement-request');
  await assert.rejects(
    h.request('edit-replay', 'changed', 4),
    (error: unknown) => (error as { code?: string }).code === 'OPERATION_INTENT_MISMATCH',
  );
  assert.deepEqual(h.counts(), { truncateCalls: 1, sendCalls: 1 });
  assert.deepEqual(await h.status('edit-replay'), {
    operationId: 'edit-replay', state: 'accepted', requestId: 'replacement-request', queued: false, committed: true,
  });
});

test('hot message.edit keeps interrupt, truncate, promotion, and replacement send in one router transition', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
  const order: string[] = [];
  let downstreamStatus: Record<string, unknown> = { operationId: 'hot-edit', state: 'accepted', committed: false };
  server.agentDir = '/agent';
  server.sdk = { VERSION: 'test', SessionManager: {} };
  server.emitSessionListChanged = async () => undefined;
  server.coldSessionStore = {
    leases: { invalidate: () => undefined },
    truncateAfter: async (_path: string, _entry: string, options: { onCommit(): void }) => {
      order.push('truncate');
      options.onCommit();
      return { sessionPath: '/hot.jsonl' };
    },
  };
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: 'hot', rootSessionPath: '/hot.jsonl' }),
    operationCancellationGeneration: () => 0,
    hasMessageOperationOwner: () => false,
    hasHotOwner: () => true,
    routeExisting: async () => downstreamStatus,
    runHotTransition: async (_path: string, _key: string, operation: (control: unknown) => Promise<unknown>) => (
      await operation({
        interrupt: async () => { order.push('interrupt'); return { soft: true }; },
        retire: async () => { order.push('retire'); },
        promote: async () => { order.push('promote'); return { state: 'hot' }; },
        assertActive: () => undefined,
        routePromoted: async (request: { method: string }) => {
          order.push(request.method);
          return { operationId: 'hot-edit', requestId: 'hot-replacement' };
        },
      })
    ),
  };

  const response = await server.handleRequest({
    v: 1, id: 'hot-edit-request', method: 'message.edit',
    params: {
      sessionPath: '/hot.jsonl', entryId: 'target', text: 'replacement', inputs: [],
      operationId: 'hot-edit', operationAttempt: 1,
    },
  });
  assert.equal(response.requestId, 'hot-replacement');
  assert.deepEqual(order, ['interrupt', 'retire', 'truncate', 'promote', 'message.send']);
  const statusRequest = () => server.handleRequest({
    v: 1, id: 'hot-edit-status', method: 'operation.status',
    params: { sessionPath: '/hot.jsonl', operationId: 'hot-edit' },
  });
  assert.deepEqual(await statusRequest(), {
    operationId: 'hot-edit', state: 'accepted', requestId: 'hot-replacement', queued: false, committed: true,
  });
  downstreamStatus = {
    operationId: 'hot-edit', state: 'failed', code: 'MESSAGE_SEND_PRECOMMIT_FAILED',
    message: 'late preflight failure', outcome: 'failed', committed: false,
  };
  assert.deepEqual(await statusRequest(), {
    operationId: 'hot-edit', state: 'failed', code: 'MESSAGE_SEND_PRECOMMIT_FAILED',
    message: 'late preflight failure', outcome: 'failed', committed: true,
  });
});

test('message.edit requires stable operation identity and attempt', async () => {
  const h = editServer({ truncate: async () => ({ sessionPath: '/cold.jsonl' }) });
  await assert.rejects(h.server.handleRequest({
    v: 1, id: 'invalid-edit', method: 'message.edit',
    params: { sessionPath: '/cold.jsonl', messageId: 'target', text: 'replacement', inputs: [] },
  }), /operationId and operationAttempt are required/);
  assert.deepEqual(h.counts(), { truncateCalls: 0, sendCalls: 0 });
});

test('message.interrupt joins concurrent retries, replays one terminal, and rejects changed intent', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let interruptCalls = 0;
  server.workerRuntimeRouter = {
    getRoute: () => ({ state: 'hot', rootSessionPath: '/hot.jsonl' }),
    cancelPendingRuntimeOperations: () => true,
    hasHotOwner: () => true,
    hasMessageOperationOwner: () => false,
    interrupt: async () => {
      interruptCalls += 1;
      await gate;
      return { soft: true };
    },
  };
  const request = (attempt: number, sessionPath = '/hot.jsonl') => server.handleRequest({
    v: 1, id: `interrupt-${attempt}`, method: 'message.interrupt',
    params: { sessionPath, operationId: 'interrupt-op', operationAttempt: attempt },
  });

  const first = request(1);
  const joined = request(2);
  assert.deepEqual(await server.handleRequest({
    v: 1, id: 'interrupt-status-pending', method: 'operation.status',
    params: { sessionPath: '/hot.jsonl', operationId: 'interrupt-op' },
  }), { operationId: 'interrupt-op', state: 'pending', committed: false });
  release();
  assert.deepEqual(await first, {
    interrupted: true, settled: true, operationId: 'interrupt-op', operationAttempt: 1,
  });
  assert.equal((await joined).operationAttempt, 2);
  assert.equal((await request(3)).operationAttempt, 3);
  assert.equal(interruptCalls, 1);
  assert.deepEqual(await server.handleRequest({
    v: 1, id: 'interrupt-status-terminal', method: 'operation.status',
    params: { sessionPath: '/hot.jsonl', operationId: 'interrupt-op' },
  }), {
    operationId: 'interrupt-op', state: 'accepted', committed: true,
    interrupted: true, settled: true,
  });
  await assert.rejects(
    request(4, '/other.jsonl'),
    (error: unknown) => (error as { code?: string }).code === 'OPERATION_INTENT_MISMATCH',
  );
  assert.equal(interruptCalls, 1);
});

test('message.interrupt reports confirmed forced recovery and treats idle as a successful no-op', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
  let hot = true;
  server.workerRuntimeRouter = {
    getRoute: () => hot
      ? ({ state: 'hot', rootSessionPath: '/hot.jsonl' })
      : ({ state: 'cold', rootSessionPath: '/hot.jsonl' }),
    cancelPendingRuntimeOperations: () => true,
    hasHotOwner: () => hot,
    hasMessageOperationOwner: () => false,
    interrupt: async () => {
      hot = false;
      return { soft: false };
    },
  };
  assert.deepEqual(await server.handleRequest({
    v: 1, id: 'interrupt-forced', method: 'message.interrupt',
    params: { sessionPath: '/hot.jsonl', operationId: 'interrupt-forced-op', operationAttempt: 1 },
  }), {
    interrupted: true, settled: true, forcedRecovery: true, teardownTimedOut: true,
    operationId: 'interrupt-forced-op', operationAttempt: 1,
  });
  assert.deepEqual(await server.handleRequest({
    v: 1, id: 'interrupt-idle', method: 'message.interrupt',
    params: { sessionPath: '/hot.jsonl', operationId: 'interrupt-idle-op', operationAttempt: 1 },
  }), {
    interrupted: false, alreadyStopped: true, settled: true,
    operationId: 'interrupt-idle-op', operationAttempt: 1,
  });
  await assert.rejects(server.handleRequest({
    v: 1, id: 'interrupt-partial-identity', method: 'message.interrupt',
    params: { sessionPath: '/hot.jsonl', operationId: 'missing-attempt' },
  }), /operationId and operationAttempt must be provided together/);
});

test('cold truncate retains its replacement inside the mutation owner and rejects a competing mutation without invalidating it', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/cwd', workerEntryPath: '/worker-entry.js' }) as any;
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
