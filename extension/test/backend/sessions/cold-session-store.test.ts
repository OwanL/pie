import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  COLD_SESSION_STORE_PLACEMENT,
  ColdSessionLeaseAuthority,
  ColdSessionStore,
  StaleColdSessionLeaseError,
} from '../../../src/backend/cold-session-store';
import { ensureSdkPatchBarrier, loadSdk, type SdkSessionManager } from '../../../src/backend/sdk';

function header(cwd: string, version: number | undefined = 3, id = 'session-test') {
  return {
    type: 'session',
    ...(version === undefined ? {} : { version }),
    id,
    timestamp: '2026-08-15T00:00:00.000Z',
    cwd,
  };
}

function userEntry(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-15T00:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1 },
  };
}

function assistantEntry(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-15T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'mock',
      model: 'model-a',
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 2,
    },
  };
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function readJsonl(filePath: string): Promise<any[]> {
  return (await fs.readFile(filePath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let sessionManagerPromise: Promise<any> | undefined;

function realSdkPath(): string {
  return path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent');
}

async function getRealSessionManager(): Promise<any> {
  sessionManagerPromise ??= loadSdk(realSdkPath(), { mode: 'cold-coordinator' })
    .then((sdk) => sdk.SessionManager);
  return await sessionManagerPromise;
}

async function makeHarness() {
  const SessionManager = await getRealSessionManager();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-store-'));
  const sessionDir = path.join(root, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  const leases = new ColdSessionLeaseAuthority(7);
  const store = new ColdSessionStore({
    sdk: { SessionManager } as any,
    coordinatorGeneration: 7,
    startupCwd: root,
    agentDir: root,
    sessionDir,
    leaseAuthority: leases,
  });
  return { root, sessionDir, leases, store };
}

test('production cold SDK load mode remains within the explicit one-time in-process startup budget', async () => {
  // Measure module loading, not the patch barrier: production always completes
  // that coordinator-owned barrier before importing any SDK module. A sampling
  // interval runs across the fresh cold import and receives one post-import turn
  // so synchronous module evaluation is represented in max event-loop drift.
  await ensureSdkPatchBarrier(realSdkPath());
  const sampleIntervalMs = 10;
  let nextSampleAt = performance.now() + sampleIntervalMs;
  let maxEventLoopDelayMs = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - nextSampleAt);
    nextSampleAt = now + sampleIntervalMs;
  }, sampleIntervalMs);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const startedAt = performance.now();
  let sdk: Awaited<ReturnType<typeof loadSdk>>;
  try {
    sdk = await loadSdk(realSdkPath(), { mode: 'cold-coordinator' });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    clearInterval(sampler);
  }
  const importDurationMs = performance.now() - startedAt;

  assert.equal(typeof sdk.SessionManager?.open, 'function');
  assert.equal(typeof sdk.AuthStorage?.create, 'function');
  assert.equal('AgentSession' in sdk, false);
  assert.ok(
    importDurationMs < 15_000,
    `cold SDK import duration ${importDurationMs.toFixed(1)}ms exceeded 15000ms`,
  );
  assert.ok(
    maxEventLoopDelayMs < 15_000,
    `cold SDK import event-loop delay ${maxEventLoopDelayMs.toFixed(1)}ms exceeded 15000ms`,
  );
});

test('v1/v2 opens migrate through the SDK and duplicate migrates its source before forkFrom', async () => {
  const h = await makeHarness();
  try {
    const v1Path = path.join(h.sessionDir, 'v1.jsonl');
    const v1Header = header(h.root, 3, 'legacy-v1');
    delete (v1Header as { version?: number }).version;
    await writeJsonl(v1Path, [
      v1Header,
      { type: 'message', timestamp: '2026-08-15T00:00:01.000Z', message: { role: 'user', content: 'legacy user', timestamp: 1 } },
      { type: 'message', timestamp: '2026-08-15T00:00:02.000Z', message: { role: 'hookMessage', content: 'legacy hook', timestamp: 2 } },
    ]);

    const snapshot = await h.store.openSnapshot(v1Path, {
      modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' },
      availableModels: [],
      selectionToken: 'migration-open',
    });
    const migratedV1 = await readJsonl(v1Path);
    assert.equal(migratedV1[0].version, 3);
    assert.ok(migratedV1.slice(1).every((row) => typeof row.id === 'string'));
    assert.equal(migratedV1[1].parentId, null);
    assert.equal(migratedV1[2].parentId, migratedV1[1].id);
    assert.equal(migratedV1[2].message.role, 'custom');
    assert.equal(snapshot.runtimeReady, false);
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.selectionToken, 'migration-open');

    const v2Path = path.join(h.sessionDir, 'v2.jsonl');
    await writeJsonl(v2Path, [
      header(h.root, 2, 'legacy-v2'),
      userEntry('u-v2', null, 'source'),
      {
        type: 'message', id: 'hook-v2', parentId: 'u-v2', timestamp: '2026-08-15T00:00:02.000Z',
        message: { role: 'hookMessage', content: 'hook', timestamp: 2 },
      },
    ]);
    const duplicate = h.store.duplicate(v2Path);
    const [migratedSource, forked] = await Promise.all([readJsonl(v2Path), readJsonl(duplicate.sessionPath)]);
    assert.equal(migratedSource[0].version, 3);
    assert.equal(migratedSource[2].message.role, 'custom');
    assert.equal(forked[0].version, 3);
    assert.equal(forked[0].parentSession, v2Path);
    assert.equal(forked[2].message.role, 'custom');
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('real SDK cold create durably publishes one v3 header before returning the exact handoff manager', async () => {
  const h = await makeHarness();
  try {
    const handle = h.store.create({ cwd: h.root });
    const rows = await readJsonl(handle.sessionPath);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], JSON.parse(JSON.stringify(handle.manager.getHeader?.())));
    assert.equal(rows[0].type, 'session');
    assert.equal(rows[0].version, 3);
    assert.deepEqual((await fs.readdir(h.sessionDir)).filter((name) => name.includes('.pie-create-')), []);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('serialized worker promotion grant is generation-bound and consumable exactly once', async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.sessionDir, 'promotion.jsonl');
    await writeJsonl(file, [header(h.root)]);
    const grant = h.store.serializePromotionGrant(file, 'resume');
    assert.equal(grant.coordinatorGeneration, 7);
    assert.equal(h.store.consumePromotionGrant(grant).grantId, grant.grantId);
    assert.throws(() => h.store.consumePromotionGrant(grant), /stale or already consumed/);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('create returns the exact process-local manager and handoff transfers ownership once', async () => {
  const h = await makeHarness();
  try {
    const handle = h.store.create({ cwd: h.root });
    let installed: SdkSessionManager | undefined;
    const result = h.store.handoff(handle, (manager) => {
      installed = manager;
      return 'installed';
    });
    assert.equal(result, 'installed');
    assert.equal(installed, handle.manager);
    assert.throws(
      () => h.leases.assertCurrent(handle.stamp),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'ownership-revision',
    );
    assert.throws(() => h.store.handoff(handle, () => undefined), /no longer available/);

    const ambiguous = h.store.create({ cwd: h.root });
    assert.throws(() => h.store.handoff(ambiguous, () => {
      throw new Error('partial install');
    }), /partial install/);
    assert.throws(
      () => h.store.handoff(ambiguous, () => assert.fail('ambiguous install must not replay')),
      /no longer available/,
    );
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('duplicate, tree, context, paging, and durable detail retain SDK and public projection semantics', async () => {
  const h = await makeHarness();
  try {
    const sessionPath = path.join(h.sessionDir, 'tree.jsonl');
    const longReasoning = 'reasoning detail '.repeat(1500);
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'tree-context'),
      userEntry('root', null, 'root prompt'),
      assistantEntry('left', 'root', 'left branch'),
      { ...userEntry('right', 'root', 'right branch'), timestamp: '2026-08-15T00:00:03.000Z' },
      {
        ...assistantEntry('leaf', 'right', 'active leaf'),
        timestamp: '2026-08-15T00:00:04.000Z',
        message: {
          ...assistantEntry('leaf', 'right', 'active leaf').message,
          content: [{ type: 'thinking', thinking: longReasoning }, { type: 'text', text: 'active leaf' }],
        },
      },
    ]);

    const tree = h.store.tree(sessionPath);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].entry.id, 'root');
    assert.deepEqual(tree[0].children.map((node) => node.entry.id), ['left', 'right']);
    assert.equal(tree[0].children[1].children[0].entry.id, 'leaf');

    const context = h.store.context(sessionPath);
    assert.deepEqual(
      context.messages.map((message: any) => message.content),
      ['root prompt', 'right branch', (context.messages[2] as any).content],
    );
    assert.equal((context.messages[2] as any).content[1].text, 'active leaf');

    const snapshot = await h.store.openSnapshot(sessionPath, {
      modelSettings: { defaultModel: 'model-a', defaultProvider: 'mock', defaultThinkingLevel: 'medium' },
      availableModels: [{
        id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true,
        thinkingLevels: ['off', 'medium'], inputKinds: ['text'], contextWindow: 1000,
      }],
    });
    assert.equal(snapshot.session.path, sessionPath);
    assert.equal(snapshot.runtimeReady, false);
    assert.deepEqual(snapshot.transcript.map((message) => message.id), ['root', 'right', 'leaf']);

    const page = await h.store.loadPage(sessionPath, 'latest');
    assert.equal(page.busy, false);
    assert.deepEqual(page.transcript.map((message) => message.id), ['root', 'right', 'leaf']);
    const reasoningRef = page.transcript[2].parts?.find((part) => part.kind === 'reasoning')?.detailRef;
    assert.ok(reasoningRef);
    const detail = await h.store.loadDetail(sessionPath, reasoningRef!);
    assert.deepEqual(detail, {
      sessionPath,
      key: reasoningRef!.key,
      status: 'loaded',
      value: longReasoning,
      sizeBytes: reasoningRef!.sizeBytes,
    });

    const duplicate = h.store.duplicate(sessionPath);
    const duplicateContext = h.store.context(duplicate.sessionPath);
    assert.equal(duplicateContext.messages.length, 3, 'forkFrom retains the active branch only');
    assert.deepEqual(
      (await h.store.list()).map((summary) => summary.path).sort(),
      [duplicate.sessionPath, sessionPath].sort(),
      'a duplicate invalidates the cached catalog inventory',
    );

    h.store.publishSync(page, () => undefined);
    assert.equal(h.store.ownershipStamp(page)?.[0]?.coordinatorGeneration, 7);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('truncate atomically rewrites and durably restores supported model/thinking state', async () => {
  const h = await makeHarness();
  try {
    const sessionPath = path.join(h.sessionDir, 'truncate.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'truncate-session'),
      userEntry('root', null, 'keep'),
      { type: 'model_change', id: 'model-old', parentId: 'root', timestamp: '2026-08-15T00:00:02.000Z', provider: 'mock', modelId: 'model-old' },
      { type: 'thinking_level_change', id: 'thinking-old', parentId: 'model-old', timestamp: '2026-08-15T00:00:03.000Z', thinkingLevel: 'low' },
      userEntry('truncate-here', 'thinking-old', 'remove this and later rows'),
      { type: 'model_change', id: 'model-new', parentId: 'truncate-here', timestamp: '2026-08-15T00:00:05.000Z', provider: 'mock', modelId: 'model-new' },
      { type: 'thinking_level_change', id: 'thinking-new', parentId: 'model-new', timestamp: '2026-08-15T00:00:06.000Z', thinkingLevel: 'high' },
      {
        ...assistantEntry('removed', 'thinking-new', 'remove'),
        message: { ...assistantEntry('removed', 'thinking-new', 'remove').message, model: 'model-new' },
      },
    ]);

    const beforeSummary = (await h.store.list()).find((summary) => summary.path === sessionPath);
    assert.equal(beforeSummary?.messageCount, 3);

    const result = await h.store.truncateAfter(sessionPath, 'truncate-here');
    assert.equal(result.sessionPath, sessionPath);
    assert.equal(result.restoredModel, true);
    assert.equal(result.restoredThinkingLevel, true);
    const rows = await readJsonl(sessionPath);
    assert.deepEqual(rows.slice(1).map((row) => row.id).filter(Boolean), [
      'root', 'model-old', 'thinking-old', rows[4].id, rows[5].id,
    ]);
    assert.deepEqual(rows[4], {
      type: 'model_change',
      id: rows[4].id,
      parentId: 'thinking-old',
      timestamp: rows[4].timestamp,
      provider: 'mock',
      modelId: 'model-new',
    });
    assert.equal(rows[5].type, 'thinking_level_change');
    assert.equal(rows[5].parentId, rows[4].id);
    assert.equal(rows[5].thinkingLevel, 'high');
    assert.deepEqual(h.store.context(sessionPath), {
      messages: [{ role: 'user', content: 'keep', timestamp: 1 }],
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
    assert.equal(
      (await h.store.list()).find((summary) => summary.path === sessionPath)?.messageCount,
      1,
      'truncate explicitly refreshes content metadata despite an unchanged filename inventory',
    );
    assert.deepEqual(
      (await fs.readdir(h.sessionDir)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('stale ownership rejects fork, truncate, forget, publication, and manager installation before commit', async () => {
  const h = await makeHarness();
  const SessionManager = await getRealSessionManager();
  try {
    const sessionPath = path.join(h.sessionDir, 'stale.jsonl');
    const originalRows = [header(h.root), userEntry('root', null, 'preserve')];
    await writeJsonl(sessionPath, originalRows);

    const handle = h.store.create({ cwd: h.root });
    h.leases.invalidate(handle.sessionPath);
    assert.throws(
      () => h.store.handoff(handle, () => assert.fail('stale manager must not install')),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'ownership-revision',
    );

    let forkCalls = 0;
    const forkAuthority = new ColdSessionLeaseAuthority(9);
    const forkStore = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(openedPath: string) {
            return {
              getSessionFile: () => openedPath,
              getCwd: () => {
                forkAuthority.invalidate(openedPath);
                return h.root;
              },
            } as SdkSessionManager;
          },
          forkFrom() {
            forkCalls += 1;
            throw new Error('must not fork');
          },
        },
      } as any,
      coordinatorGeneration: 9,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
      leaseAuthority: forkAuthority,
    });
    assert.throws(() => forkStore.duplicate(sessionPath), StaleColdSessionLeaseError);
    assert.equal(forkCalls, 0);

    let renameCalls = 0;
    const truncateStore = new ColdSessionStore({
      sdk: { SessionManager } as any,
      coordinatorGeneration: 11,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
      fileSystem: {
        writeFile: async (temporaryPath, content) => {
          await fs.writeFile(temporaryPath, content, 'utf8');
          truncateStore.leases.invalidate(sessionPath);
        },
        renameSync: () => { renameCalls += 1; },
      },
    });
    await assert.rejects(
      truncateStore.truncateAfter(sessionPath, 'root'),
      StaleColdSessionLeaseError,
    );
    assert.equal(renameCalls, 0);
    assert.deepEqual(await readJsonl(sessionPath), originalRows);

    const page = await h.store.loadPage(sessionPath, 'latest');
    h.leases.invalidate(sessionPath);
    assert.throws(
      () => h.store.publishSync(page, () => assert.fail('stale result must not publish')),
      StaleColdSessionLeaseError,
    );

    const forgetStore = new ColdSessionStore({
      sdk: { SessionManager } as any,
      coordinatorGeneration: 12,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
      forgetArtifactsDeps: {
        forgetReviewSidecars: () => undefined,
        clearSystemPromptToggles: async (targetPath) => {
          forgetStore.leases.invalidate(targetPath);
        },
      },
    });
    // The transcript delete callback is internal and synchronous. File
    // existence proves it was not reached after sidecar cleanup invalidated the lease.
    await assert.rejects(forgetStore.forget(sessionPath), StaleColdSessionLeaseError);
    assert.equal(await fs.readFile(sessionPath, 'utf8').then(() => true), true);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('an in-flight catalog scan retries across ownership and cold-mutation revisions before publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-list-fence-'));
  try {
    const sessionPath = path.join(root, 'session.jsonl');
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let listCalls = 0;
    let refreshCalls = 0;
    const catalog = {
      invalidateIfInventoryChanged: async () => false,
      list: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          firstStarted();
          await firstBlocked;
        }
        return [{
          path: sessionPath,
          cwd: root,
          name: listCalls === 1 ? 'stale' : 'fresh',
          isPlaceholder: false,
          modifiedAt: '2026-08-15T00:00:00.000Z',
          messageCount: listCalls,
        }];
      },
      refresh: () => { refreshCalls += 1; },
      remove: () => undefined,
    };
    const manager = {
      getSessionFile: () => sessionPath,
      getCwd: () => root,
    } as SdkSessionManager;
    const leases = new ColdSessionLeaseAuthority(20);
    const store = new ColdSessionStore({
      sdk: { SessionManager: { create: () => manager } } as any,
      coordinatorGeneration: 20,
      startupCwd: root,
      agentDir: root,
      leaseAuthority: leases,
      sessionCatalog: catalog as any,
    });

    const listing = store.list();
    await started;
    const handle = store.create();
    store.handoff(handle, () => undefined);
    releaseFirst();
    const result = await listing;

    assert.equal(listCalls, 2);
    assert.ok(refreshCalls >= 2, 'handoff invalidation and stale-scan retry both refresh the catalog');
    assert.equal(result[0].name, 'fresh');
    store.publishSync(result, () => undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing cold paths are rejected instead of being opened as SDK-created empty sessions', async () => {
  const h = await makeHarness();
  try {
    const missingPath = path.join(h.sessionDir, 'missing.jsonl');
    await assert.rejects(
      h.store.openSnapshot(missingPath, {
        modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' },
        availableModels: [],
      }),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
    await assert.rejects(h.store.loadPage(missingPath, 'latest'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.throws(() => h.store.tree(missingPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal(await fs.stat(missingPath).then(() => true, () => false), false);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('coordinator generation is part of every cold lease stamp', async () => {
  const h = await makeHarness();
  try {
    const sessionPath = path.join(h.sessionDir, 'generation.jsonl');
    await writeJsonl(sessionPath, [header(h.root), userEntry('root', null, 'hello')]);
    const page = await h.store.loadPage(sessionPath, 'latest');
    h.leases.advanceCoordinatorGeneration(8);
    assert.throws(
      () => h.store.publishSync(page, () => undefined),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'coordinator-generation',
    );
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('representative in-process cold operations keep a causal coordinator ping responsive', async () => {
  const h = await makeHarness();
  try {
    assert.equal(COLD_SESSION_STORE_PLACEMENT, 'coordinator-in-process');
    const primaryPath = path.join(h.sessionDir, 'primary.jsonl');
    const primaryRows: unknown[] = [header(h.root, 3, 'primary')];
    let parentId: string | null = null;
    for (let index = 0; index < 300; index += 1) {
      const id = `message-${index}`;
      primaryRows.push(userEntry(id, parentId, `representative cold row ${index} ${'x'.repeat(256)}`));
      parentId = id;
    }
    await writeJsonl(primaryPath, primaryRows);
    await Promise.all(Array.from({ length: 36 }, async (_, index) => {
      const filePath = path.join(h.sessionDir, `catalog-${index}.jsonl`);
      await writeJsonl(filePath, [header(h.root, 3, `catalog-${index}`), userEntry(`u-${index}`, null, `catalog ${index}`)]);
    }));

    const measurements: Array<{ label: string; pingDelayMs: number; pingBeforeCompletion: boolean }> = [];
    const measured = async <T>(label: string, operation: () => T | Promise<T>): Promise<T> => {
      let completed = false;
      let pingBeforeCompletion = false;
      const startedAt = performance.now();
      const ping = new Promise<void>((resolve) => {
        setImmediate(() => {
          pingBeforeCompletion = !completed;
          resolve();
        });
      });
      const result = Promise.resolve().then(operation).finally(() => { completed = true; });
      await ping;
      measurements.push({
        label,
        pingDelayMs: performance.now() - startedAt,
        pingBeforeCompletion,
      });
      return await result;
    };

    await measured('list', () => h.store.list());
    await measured('open', () => h.store.openSnapshot(primaryPath, {
      modelSettings: { defaultModel: 'model-a', defaultThinkingLevel: 'medium' },
      availableModels: [],
    }));
    await measured('page', () => h.store.loadPage(primaryPath, 'latest'));
    await measured('tree', () => h.store.tree(primaryPath));
    await measured('context', () => h.store.context(primaryPath));
    const duplicate = await measured('duplicate', () => h.store.duplicate(primaryPath));
    await measured('truncate', () => h.store.truncateAfter(duplicate.sessionPath, 'message-299'));
    await measured('forget', () => h.store.forget(duplicate.sessionPath));

    assert.ok(
      measurements.filter((measurement) => measurement.pingBeforeCompletion).length >= 4,
      `expected causal pings during async cold operations: ${JSON.stringify(measurements)}`,
    );
    for (const measurement of measurements) {
      // The causal ping-before-completion count above is the hard gate. This
      // delay bound is a generous multi-second CI budget (the plan requires
      // control responses to be causal, not sub-second); under full-suite
      // load a cold duplicate prefix once measured 1.18s.
      assert.ok(
        measurement.pingDelayMs < 5_000,
        `${measurement.label} coordinator ping delay ${measurement.pingDelayMs.toFixed(1)}ms exceeded 5000ms`,
      );
    }
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('ColdSessionStore has no runtime/provider/tool/subagent dependency imports', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'backend', 'cold-session-store.ts'), 'utf8');
  for (const forbidden of [
    'runtime-factory',
    'AgentSessionServices',
    "from './extensions",
    "from './provider",
    "from './tool",
    "from './subagent",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden coordinator dependency: ${forbidden}`);
  }
});
