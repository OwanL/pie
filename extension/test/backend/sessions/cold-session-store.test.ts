import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
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
  type ColdSessionOpenOptions,
} from '../../../src/backend/cold-session-store';
import {
  ColdBrowseHelperRequestError,
  type ColdBrowseHelper,
} from '../../../src/backend/cold-browse-helper-client';
import { REVIEWS_DIR_ENV } from '../../../src/backend/session-review-store';
import { ensureSdkPatchBarrier, loadSdk, type SdkSessionManager } from '../../../src/backend/sdk';
import { SessionSnapshotTooLargeError } from '../../../src/shared/transcript-window';
import { validReview } from '../../../../extensions/session-reviewer/test/fixtures.js';

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

async function makeObservedBrowseStore(
  h: Awaited<ReturnType<typeof makeHarness>>,
  options: { maxSourceBytes?: number; maxEntries?: number; readAttempts?: number } = {},
) {
  const SessionManager = await getRealSessionManager();
  let managerOpens = 0;
  const store = new ColdSessionStore({
    sdk: {
      SessionManager: {
        open(sessionPath: string) {
          managerOpens += 1;
          return SessionManager.open(sessionPath);
        },
      },
    } as any,
    coordinatorGeneration: 31,
    startupCwd: h.root,
    agentDir: h.root,
    sessionDir: h.sessionDir,
    browseCacheMaxSourceBytes: options.maxSourceBytes,
    browseCacheMaxEntries: options.maxEntries,
    readAttempts: options.readAttempts,
  });
  return { store, managerOpens: () => managerOpens };
}

const browseOpenOptions: ColdSessionOpenOptions = {
  modelSettings: { defaultModel: 'model-a', defaultProvider: 'mock', defaultThinkingLevel: 'medium' },
  availableModels: [{
    id: 'model-a', name: 'Model A', provider: 'mock', reasoning: true,
    thinkingLevels: ['off', 'medium'], inputKinds: ['text'], contextWindow: 1000,
  }],
};

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

test('open, preload, page, and detail share one immutable durable projection single-flight', async () => {
  const h = await makeHarness();
  try {
    const sessionPath = path.join(h.sessionDir, 'singleflight.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'singleflight'),
      userEntry('user', null, 'hello'),
      { type: 'model_change', id: 'model', parentId: 'user', timestamp: '2026-08-15T00:00:02.000Z', provider: 'mock', modelId: 'model-a' },
      assistantEntry('assistant', 'model', 'answer'),
    ]);
    const observed = await makeObservedBrowseStore(h);
    const detailRef = {
      key: 'missing-detail', sessionPath, kind: 'reasoning' as const, source: 'durable' as const,
      messageId: 'assistant', summary: 'missing', available: true, sizeBytes: 1,
    };

    const [opened, preloaded, page, detail] = await Promise.all([
      observed.store.openSnapshot(sessionPath, { ...browseOpenOptions, selectionToken: 'open' }),
      observed.store.openSnapshot(sessionPath, { ...browseOpenOptions, transcript: 'skip' }),
      observed.store.loadPage(sessionPath, 'latest'),
      observed.store.loadDetail(sessionPath, detailRef),
    ]);

    assert.equal(observed.managerOpens(), 1);
    assert.deepEqual(opened.transcript.map((message) => message.id), ['user', 'assistant']);
    assert.equal(preloaded.transcriptSkipped, true);
    assert.deepEqual(page.transcript.map((message) => message.id), ['user', 'assistant']);
    assert.equal(detail.status, 'unavailable');
    assert.deepEqual(observed.store.getBrowseCacheStats(), {
      hits: 0,
      misses: 1,
      inflightJoins: 3,
      evictions: 0,
      invalidations: 0,
      entries: 1,
      inflight: 0,
      currentSourceBytes: (await fs.stat(sessionPath)).size,
      maxSourceBytes: 128 * 1024 * 1024,
      maxEntries: 4,
    });

    const refreshedMetadata = await observed.store.openSnapshot(sessionPath, {
      modelSettings: { ...browseOpenOptions.modelSettings, defaultThinkingLevel: 'high' },
      availableModels: [{ ...browseOpenOptions.availableModels![0], name: 'Updated Model', contextWindow: 2000 }],
    });
    assert.equal(observed.managerOpens(), 1, 'dynamic metadata decoration does not reopen the durable session');
    assert.equal(refreshedMetadata.session.thinkingLevel, 'high');
    assert.equal(refreshedMetadata.availableModels?.[0]?.name, 'Updated Model');
    assert.equal(refreshedMetadata.contextUsage?.contextWindow, 2000);
    assert.equal(observed.store.getBrowseCacheStats().hits, 1);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('review decoration is refreshed on a durable projection cache hit', async () => {
  const h = await makeHarness();
  const previousReviewsDir = process.env[REVIEWS_DIR_ENV];
  try {
    const sessionPath = path.join(h.sessionDir, 'review-cache.jsonl');
    const reviewsDir = path.join(h.root, 'reviews');
    await fs.mkdir(reviewsDir, { recursive: true });
    process.env[REVIEWS_DIR_ENV] = reviewsDir;
    await writeJsonl(sessionPath, [header(h.root, 3, 'review-cache'), userEntry('user', null, 'review me')]);
    const observed = await makeObservedBrowseStore(h);

    const beforeReview = await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(beforeReview.session.reviewed, undefined);
    const review = {
      ...structuredClone(validReview()),
      kind: 'production',
      reviewId: 'review-cache-1',
      sessionId: 'review-cache',
      sessionPathAtReview: sessionPath,
      reviewedAt: '2026-08-25T00:00:00.000Z',
    };
    await fs.writeFile(path.join(reviewsDir, 'reviews.jsonl'), `${JSON.stringify(review)}\n`, 'utf8');

    const afterReview = await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(afterReview.session.reviewed, true);
    assert.equal(afterReview.session.reviewId, 'review-cache-1');
    assert.equal(observed.managerOpens(), 1);
    assert.equal(observed.store.getBrowseCacheStats().hits, 1);
  } finally {
    if (previousReviewsDir === undefined) delete process.env[REVIEWS_DIR_ENV];
    else process.env[REVIEWS_DIR_ENV] = previousReviewsDir;
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('a v3 external rewrite during SessionManager.open is rejected rather than restamped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-open-race-'));
  try {
    const sessionPath = path.join(root, 'race.jsonl');
    const originalRows = [header(root, 3, 'race'), userEntry('old', null, 'old durable row')];
    const replacementRows = [header(root, 3, 'race'), userEntry('new', null, 'external replacement row')];
    await writeJsonl(sessionPath, originalRows);
    let opens = 0;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(openedPath: string) {
            opens += 1;
            fsSync.writeFileSync(
              openedPath,
              `${replacementRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
              'utf8',
            );
            return {
              getSessionFile: () => openedPath,
              getCwd: () => root,
              getSessionId: () => 'race',
              getSessionName: () => undefined,
              getHeader: () => originalRows[0],
              getBranch: () => originalRows.slice(1),
              getEntries: () => originalRows.slice(1),
              buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
            };
          },
        },
      } as any,
      coordinatorGeneration: 41,
      startupCwd: root,
      agentDir: root,
      readAttempts: 1,
    });

    await assert.rejects(
      store.openSnapshot(sessionPath, browseOpenOptions),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'fingerprint',
    );
    assert.equal(opens, 1);
    assert.deepEqual(await readJsonl(sessionPath), replacementRows);
    assert.equal(store.getBrowseCacheStats().entries, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('helper fingerprint changes retry off-process without a synchronous SDK reopen', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-fingerprint-retry-'));
  try {
    const sessionPath = path.join(root, 'helper.jsonl');
    await writeJsonl(sessionPath, [header(root, 3, 'helper-retry'), userEntry('old', null, 'old')]);
    const helperFingerprints: string[] = [];
    let helperCalls = 0;
    let syncOpens = 0;
    const helper = {
      warm: async () => undefined,
      openSnapshot: async (stamp) => {
        helperCalls += 1;
        helperFingerprints.push(stamp.fingerprint);
        if (helperCalls === 1) {
          await writeJsonl(sessionPath, [
            header(root, 3, 'helper-retry'),
            userEntry('new', null, 'a newer and deliberately longer durable value'),
          ]);
          throw new ColdBrowseHelperRequestError(
            'FINGERPRINT_CHANGED',
            'the durable image changed during helper projection',
            undefined,
            stamp.fingerprint,
          );
        }
        return {
          session: { path: sessionPath },
          transcript: [],
          transcriptWindow: {},
          busy: false,
        } as any;
      },
      loadPage: async () => { throw new Error('unused'); },
      loadDetail: async () => { throw new Error('unused'); },
      invalidatePath: async () => undefined,
      dispose: async () => undefined,
    } satisfies ColdBrowseHelper;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open() {
            syncOpens += 1;
            throw new Error('coordinator reopen must not run');
          },
        },
      } as any,
      coordinatorGeneration: 50,
      startupCwd: root,
      agentDir: root,
      browseHelper: helper,
      readAttempts: 2,
    });

    const opened = await store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(opened.session.path, sessionPath);
    assert.equal(helperCalls, 2);
    assert.notEqual(
      helperFingerprints[0],
      helperFingerprints[1],
      'the retry captures a fresh coordinator fingerprint after the helper detects a change',
    );
    assert.equal(syncOpens, 0, 'a correlated helper race stays off the coordinator event loop');

    let ownershipHelperCalls = 0;
    const ownershipHelper = {
      ...helper,
      openSnapshot: async (stamp) => {
        ownershipHelperCalls += 1;
        ownershipStore.leases.invalidate(sessionPath);
        throw new ColdBrowseHelperRequestError(
          'FINGERPRINT_CHANGED',
          'the durable image changed during helper projection',
          undefined,
          stamp.fingerprint,
        );
      },
    } satisfies ColdBrowseHelper;
    const ownershipStore = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open() {
            syncOpens += 1;
            throw new Error('coordinator reopen must not run');
          },
        },
      } as any,
      coordinatorGeneration: 51,
      startupCwd: root,
      agentDir: root,
      browseHelper: ownershipHelper,
      readAttempts: 2,
    });
    await assert.rejects(
      ownershipStore.openSnapshot(sessionPath, browseOpenOptions),
      (error) => error instanceof StaleColdSessionLeaseError
        && error.reason === 'ownership-revision',
    );
    assert.equal(ownershipHelperCalls, 1, 'an ownership transition is never retried as a file race');
    assert.equal(syncOpens, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('helper results are fingerprint/ownership fenced and helper failure preserves synchronous semantics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-fence-'));
  try {
    const SessionManager = await getRealSessionManager();
    const sessionPath = path.join(root, 'helper.jsonl');
    await writeJsonl(sessionPath, [header(root, 3, 'helper'), userEntry('old', null, 'old')]);
    let helperCalls = 0;
    let syncOpens = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const helper = {
      warm: async () => undefined,
      openSnapshot: async () => {
        helperCalls += 1;
        if (helperCalls === 1) {
          firstStarted();
          await firstBlocked;
          return {} as any;
        }
        throw new Error('synthetic helper failure');
      },
      loadPage: async () => { throw new Error('unused'); },
      loadDetail: async () => { throw new Error('unused'); },
      invalidatePath: async () => undefined,
      dispose: async () => undefined,
    } satisfies ColdBrowseHelper;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(openedPath: string) {
            syncOpens += 1;
            return SessionManager.open(openedPath);
          },
        },
      } as any,
      coordinatorGeneration: 51,
      startupCwd: root,
      agentDir: root,
      browseHelper: helper,
      readAttempts: 2,
    });

    const opening = store.openSnapshot(sessionPath, browseOpenOptions);
    await started;
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify(header(root, 3, 'helper'))}\n${JSON.stringify(userEntry('new', null, 'new durable value'))}\n`,
      'utf8',
    );
    releaseFirst();
    const opened = await opening;
    assert.deepEqual(opened.transcript.map((message) => message.id), ['new']);
    assert.equal(helperCalls, 2, 'stale helper response is retried against the new exact fingerprint');
    assert.equal(syncOpens, 1, 'helper failure uses the existing synchronous SDK path');

    let releaseOwnership!: () => void;
    let ownershipStarted!: () => void;
    const ownershipBlocked = new Promise<void>((resolve) => { releaseOwnership = resolve; });
    const ownershipSeen = new Promise<void>((resolve) => { ownershipStarted = resolve; });
    const ownershipHelper = {
      ...helper,
      openSnapshot: async () => {
        ownershipStarted();
        await ownershipBlocked;
        return {} as any;
      },
    } satisfies ColdBrowseHelper;
    const ownershipStore = new ColdSessionStore({
      sdk: { SessionManager } as any,
      coordinatorGeneration: 52,
      startupCwd: root,
      agentDir: root,
      browseHelper: ownershipHelper,
    });
    const ownershipOpen = ownershipStore.openSnapshot(sessionPath, browseOpenOptions);
    await ownershipSeen;
    ownershipStore.leases.invalidate(sessionPath);
    releaseOwnership();
    await assert.rejects(
      ownershipOpen,
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'ownership-revision',
    );

    const legacyPath = path.join(root, 'legacy.jsonl');
    await writeJsonl(legacyPath, [header(root, 2, 'legacy'), userEntry('legacy', null, 'legacy')]);
    const beforeLegacyCalls = helperCalls;
    const legacy = await store.openSnapshot(legacyPath, browseOpenOptions);
    assert.deepEqual(legacy.transcript.map((message) => message.id), ['legacy']);
    assert.equal(helperCalls, beforeLegacyCalls, 'v1/v2 migration never enters the read-only helper');
    assert.equal((await readJsonl(legacyPath))[0].version, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('helper page overflow stays typed and never synchronously reopens the durable file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-helper-page-overflow-'));
  try {
    const sessionPath = path.join(root, 'helper.jsonl');
    await writeJsonl(sessionPath, [header(root, 3, 'helper-overflow'), userEntry('required', null, 'row')]);
    let syncOpens = 0;
    let seenOptions: unknown;
    const tooLarge = new SessionSnapshotTooLargeError(2_000, 1_000, 'required');
    const helper = {
      warm: async () => undefined,
      openSnapshot: async () => { throw new Error('unused'); },
      loadPage: async (_stamp, _direction, _loadedStart, _loadedEnd, options) => {
        seenOptions = options;
        throw tooLarge;
      },
      loadDetail: async () => { throw new Error('unused'); },
      invalidatePath: async () => undefined,
      dispose: async () => undefined,
    } satisfies ColdBrowseHelper;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open() {
            syncOpens += 1;
            throw new Error('coordinator reopen must not run');
          },
        },
      } as any,
      coordinatorGeneration: 53,
      startupCwd: root,
      agentDir: root,
      browseHelper: helper,
    });

    await assert.rejects(
      store.loadPage(sessionPath, 'latest', undefined, undefined, {
        transport: { kind: 'response', requestId: 'page-request' },
        requiredMessageId: 'required',
      }),
      (error) => error === tooLarge,
    );
    assert.deepEqual(seenOptions, {
      transport: { kind: 'response', requestId: 'page-request' },
      requiredMessageId: 'required',
    });
    assert.equal(syncOpens, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('browse cache enforces LRU entry/source-byte bounds while retaining one current oversize session', async () => {
  const h = await makeHarness();
  try {
    const paths = await Promise.all(['a', 'b', 'c'].map(async (name) => {
      const sessionPath = path.join(h.sessionDir, `${name}.jsonl`);
      await writeJsonl(sessionPath, [header(h.root, 3, name), userEntry(`user-${name}`, null, name.repeat(128))]);
      return sessionPath;
    }));
    const bounded = await makeObservedBrowseStore(h, {
      maxSourceBytes: Number.MAX_SAFE_INTEGER,
      maxEntries: 2,
    });
    await bounded.store.openSnapshot(paths[0], browseOpenOptions);
    await bounded.store.openSnapshot(paths[1], browseOpenOptions);
    await bounded.store.openSnapshot(paths[0], browseOpenOptions);
    await bounded.store.openSnapshot(paths[2], browseOpenOptions);
    assert.equal(bounded.managerOpens(), 3);
    assert.equal(bounded.store.getBrowseCacheStats().evictions, 1, 'least-recently-used b was evicted');
    await bounded.store.openSnapshot(paths[1], browseOpenOptions);
    assert.equal(bounded.managerOpens(), 4, 'evicted b requires one new durable open');

    const oversize = await makeObservedBrowseStore(h, { maxSourceBytes: 1, maxEntries: 4 });
    await oversize.store.openSnapshot(paths[0], browseOpenOptions);
    await oversize.store.openSnapshot(paths[0], browseOpenOptions);
    const oversizeStats = oversize.store.getBrowseCacheStats();
    assert.equal(oversize.managerOpens(), 1);
    assert.equal(oversizeStats.entries, 1);
    assert.ok(oversizeStats.currentSourceBytes > oversizeStats.maxSourceBytes);
    assert.equal(oversizeStats.hits, 1);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('fingerprint, ownership, generation, promotion, and forget fences make cached projections unreachable', async () => {
  const h = await makeHarness();
  try {
    const sessionPath = path.join(h.sessionDir, 'invalidation.jsonl');
    await writeJsonl(sessionPath, [header(h.root, 3, 'invalidation'), userEntry('user', null, 'before')]);
    const observed = await makeObservedBrowseStore(h);
    await observed.store.openSnapshot(sessionPath, browseOpenOptions);

    await fs.appendFile(sessionPath, `${JSON.stringify(assistantEntry('assistant', 'user', 'after'))}\n`);
    const externallyChanged = await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.deepEqual(externallyChanged.transcript.map((message) => message.id), ['user', 'assistant']);
    assert.equal(observed.managerOpens(), 2);

    observed.store.leases.invalidate(sessionPath);
    await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(observed.managerOpens(), 3);

    observed.store.leases.advanceCoordinatorGeneration(32);
    await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(observed.managerOpens(), 4);

    const grant = observed.store.serializePromotionGrant(sessionPath, 'resume');
    observed.store.consumePromotionGrant(grant);
    assert.equal(observed.store.getBrowseCacheStats().entries, 0, 'promotion eagerly retires the cold projection');

    await observed.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(observed.managerOpens(), 5);
    await observed.store.forget(sessionPath);
    assert.equal(observed.store.getBrowseCacheStats().entries, 0, 'forget eagerly purges privacy-sensitive bytes');
    await assert.rejects(fs.stat(sessionPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('forget does not wait behind helper cache reclamation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-forget-helper-'));
  try {
    const sessionPath = path.join(root, 'forget.jsonl');
    await writeJsonl(sessionPath, [header(root, 3, 'forget-helper'), userEntry('user', null, 'private')]);
    let invalidateCalls = 0;
    let invalidatedKey: string | undefined;
    const preDeleteKey = 'canonical-before-delete';
    const helper = {
      warm: async () => undefined,
      openSnapshot: async () => { throw new Error('unused'); },
      loadPage: async () => { throw new Error('unused'); },
      loadDetail: async () => { throw new Error('unused'); },
      invalidatePath: async (sessionPathKey) => {
        invalidateCalls += 1;
        invalidatedKey = sessionPathKey;
        await new Promise<void>(() => undefined);
      },
      dispose: async () => undefined,
    } satisfies ColdBrowseHelper;
    const catalog = {
      list: async () => [],
      refresh: () => undefined,
      remove: () => undefined,
    };
    const store = new ColdSessionStore({
      sdk: { SessionManager: {} } as any,
      coordinatorGeneration: 33,
      startupCwd: root,
      agentDir: root,
      leaseAuthority: new ColdSessionLeaseAuthority(33, {
        canonicalPathKey: () => fsSync.existsSync(sessionPath) ? preDeleteKey : 'canonical-after-delete',
      }),
      sessionCatalog: catalog as any,
      browseHelper: helper,
    });

    await Promise.race([
      store.forget(sessionPath),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('forget waited for helper invalidation')),
        250,
      )),
    ]);
    assert.equal(invalidateCalls, 1);
    assert.equal(invalidatedKey, preDeleteKey, 'helper invalidation retains the exact pre-delete cache identity');
    await assert.rejects(fs.stat(sessionPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

test('cold model settings append canonical Pi entries and survive a fresh store generation', async () => {
  const h = await makeHarness();
  const SessionManager = await getRealSessionManager();
  try {
    const sessionPath = path.join(h.sessionDir, 'cold-settings.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'cold-settings-session'),
      userEntry('root', null, 'keep'),
      { type: 'model_change', id: 'model-old', parentId: 'root', timestamp: '2026-08-15T00:00:02.000Z', provider: 'mock', modelId: 'model-old' },
      { type: 'thinking_level_change', id: 'thinking-old', parentId: 'model-old', timestamp: '2026-08-15T00:00:03.000Z', thinkingLevel: 'low' },
    ]);

    await h.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(h.store.getBrowseCacheStats().entries, 1);

    const changed = h.store.setModelSettings(sessionPath, {
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
    assert.deepEqual(changed, { modelChanged: true, thinkingLevelChanged: true });
    assert.equal(h.store.getBrowseCacheStats().entries, 0, 'the pre-write browse projection is retired');

    const rowsAfterChange = await readJsonl(sessionPath);
    const modelChange = rowsAfterChange.at(-2);
    const thinkingChange = rowsAfterChange.at(-1);
    assert.equal(modelChange.type, 'model_change');
    assert.equal(modelChange.parentId, 'thinking-old');
    assert.equal(modelChange.provider, 'mock');
    assert.equal(modelChange.modelId, 'model-new');
    assert.equal(thinkingChange.type, 'thinking_level_change');
    assert.equal(thinkingChange.parentId, modelChange.id);
    assert.equal(thinkingChange.thinkingLevel, 'high');

    const noOp = h.store.setModelSettings(sessionPath, {
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
    assert.deepEqual(noOp, { modelChanged: false, thinkingLevelChanged: false });
    assert.equal((await readJsonl(sessionPath)).length, rowsAfterChange.length, 'a repeated choice appends nothing');

    const restartedStore = new ColdSessionStore({
      sdk: { SessionManager } as any,
      coordinatorGeneration: 8,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
    });
    assert.deepEqual(restartedStore.context(sessionPath), {
      messages: [{ role: 'user', content: 'keep', timestamp: 1 }],
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('retained new-session handles remain promotable after a cold model-settings write', async () => {
  const h = await makeHarness();
  try {
    const handle = h.store.create({ cwd: h.root });
    const changed = h.store.setHandleModelSettings(handle, {
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
    assert.deepEqual(changed, { modelChanged: true, thinkingLevelChanged: true });

    const opened = await h.store.openHandleSnapshot(handle, browseOpenOptions);
    assert.equal(opened.session.modelId, 'model-new');
    assert.equal(opened.session.provider, 'mock');
    assert.equal(opened.session.thinkingLevel, 'high');
    assert.doesNotThrow(() => h.store.handoff(handle, () => undefined));
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('a failed atomic cold model-settings commit preserves durable bytes and the current browse cache', async () => {
  const h = await makeHarness();
  const SessionManager = await getRealSessionManager();
  try {
    const sessionPath = path.join(h.sessionDir, 'cold-settings-failure.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'cold-settings-failure'),
      userEntry('root', null, 'keep'),
      { type: 'model_change', id: 'model-old', parentId: 'root', timestamp: '2026-08-15T00:00:02.000Z', provider: 'mock', modelId: 'model-old' },
      { type: 'thinking_level_change', id: 'thinking-old', parentId: 'model-old', timestamp: '2026-08-15T00:00:03.000Z', thinkingLevel: 'low' },
    ]);
    let batchCalls = 0;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(targetPath: string) {
            const manager = SessionManager.open(targetPath);
            manager.appendPieModelSettingsChange = () => {
              batchCalls += 1;
              throw new Error('injected atomic settings failure');
            };
            return manager;
          },
        },
      } as any,
      coordinatorGeneration: 17,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
    });
    await store.openSnapshot(sessionPath, browseOpenOptions);
    const before = await fs.readFile(sessionPath, 'utf8');
    assert.equal(store.getBrowseCacheStats().entries, 1);

    assert.throws(
      () => store.setModelSettings(sessionPath, {
        model: { provider: 'mock', modelId: 'model-new' },
        thinkingLevel: 'high',
      }),
      /injected atomic settings failure/,
    );

    assert.equal(batchCalls, 1, 'one user intent reaches one SDK batch seam');
    assert.equal(await fs.readFile(sessionPath, 'utf8'), before);
    assert.equal(store.getBrowseCacheStats().entries, 1, 'a failed commit does not retire valid pre-write state');
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('a transient atomic-replace denial retries before publishing cold model settings', async () => {
  const h = await makeHarness();
  const SessionManager = await getRealSessionManager();
  try {
    const sessionPath = path.join(h.sessionDir, 'cold-settings-retry.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'cold-settings-retry'),
      userEntry('root', null, 'keep'),
    ]);
    let batchCalls = 0;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(targetPath: string) {
            const manager = SessionManager.open(targetPath);
            const originalBatch = manager.appendPieModelSettingsChange.bind(manager);
            manager.appendPieModelSettingsChange = (...args: unknown[]) => {
              batchCalls += 1;
              if (batchCalls === 1) {
                const error = new Error('injected transient atomic replace denial') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                error.syscall = 'rename';
                throw error;
              }
              return originalBatch(...args);
            };
            return manager;
          },
        },
      } as any,
      coordinatorGeneration: 17,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
    });

    assert.deepEqual(store.setModelSettings(sessionPath, {
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    }), { modelChanged: true, thinkingLevelChanged: true });
    assert.equal(batchCalls, 2);

    const restartedStore = new ColdSessionStore({
      sdk: { SessionManager } as any,
      coordinatorGeneration: 18,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
    });
    assert.deepEqual(restartedStore.context(sessionPath), {
      messages: [{ role: 'user', content: 'keep', timestamp: 1 }],
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('a stale cold settings lease is rejected before the SDK batch seam', async () => {
  const h = await makeHarness();
  const SessionManager = await getRealSessionManager();
  try {
    const sessionPath = path.join(h.sessionDir, 'cold-settings-stale.jsonl');
    await writeJsonl(sessionPath, [
      header(h.root, 3, 'cold-settings-stale'),
      userEntry('root', null, 'keep'),
    ]);
    const leases = new ColdSessionLeaseAuthority(18);
    let batchCalls = 0;
    const store = new ColdSessionStore({
      sdk: {
        SessionManager: {
          open(targetPath: string) {
            const manager = SessionManager.open(targetPath);
            const originalBatch = manager.appendPieModelSettingsChange.bind(manager);
            manager.appendPieModelSettingsChange = (...args: unknown[]) => {
              batchCalls += 1;
              return originalBatch(...args);
            };
            // Simulate an ownership transition during the SDK open seam. The
            // post-open lease check must reject before any settings publish.
            leases.invalidate(targetPath);
            return manager;
          },
        },
      } as any,
      coordinatorGeneration: 18,
      startupCwd: h.root,
      agentDir: h.root,
      sessionDir: h.sessionDir,
      leaseAuthority: leases,
    });
    const before = await fs.readFile(sessionPath, 'utf8');

    assert.throws(
      () => store.setModelSettings(sessionPath, {
        model: { provider: 'mock', modelId: 'model-new' },
        thinkingLevel: 'high',
      }),
      (error: unknown) => error instanceof StaleColdSessionLeaseError
        && error.reason === 'ownership-revision',
    );

    assert.equal(batchCalls, 0);
    assert.equal(await fs.readFile(sessionPath, 'utf8'), before);
  } finally {
    await fs.rm(h.root, { recursive: true, force: true });
  }
});

test('a retained-handle snapshot cannot publish pre-settings data under the post-write stamp', async () => {
  const h = await makeHarness();
  try {
    const handle = h.store.create({ cwd: h.root });
    const staleOpen = h.store.openHandleSnapshot(handle, browseOpenOptions);

    // openSessionBrowseSnapshot yields for the durable stat after projecting
    // the manager. Mutate in that gap: the in-flight projection is now stale
    // even though the retained handle itself has been restamped.
    h.store.setHandleModelSettings(handle, {
      model: { provider: 'mock', modelId: 'model-new' },
      thinkingLevel: 'high',
    });

    await assert.rejects(staleOpen, (error: unknown) => (
      error instanceof Error
      && error.name === 'StaleColdSessionLeaseError'
      && (error as { code?: string }).code === 'STALE_COLD_SESSION_LEASE'
    ));

    const current = await h.store.openHandleSnapshot(handle, browseOpenOptions);
    assert.equal(current.session.modelId, 'model-new');
    assert.equal(current.session.provider, 'mock');
    assert.equal(current.session.thinkingLevel, 'high');
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
    await h.store.openSnapshot(sessionPath, browseOpenOptions);
    assert.equal(h.store.getBrowseCacheStats().entries, 1);

    const result = await h.store.truncateAfter(sessionPath, 'truncate-here');
    assert.equal(result.sessionPath, sessionPath);
    assert.equal(result.restoredModel, true);
    assert.equal(result.restoredThinkingLevel, true);
    assert.equal(h.store.getBrowseCacheStats().entries, 0, 'truncate eagerly retires the old durable projection');
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

test('a persistent catalog snapshot is returned without awaiting blocked inventory reconciliation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-cold-list-index-fast-path-'));
  try {
    const sessionPath = path.join(root, 'indexed.jsonl');
    await writeJsonl(sessionPath, [header(root, 3, 'indexed')]);
    let eagerInventoryCalls = 0;
    const catalog = {
      invalidateIfInventoryChanged: async () => {
        eagerInventoryCalls += 1;
        await new Promise<void>(() => undefined);
        return false;
      },
      list: async () => [{
        path: sessionPath,
        cwd: root,
        name: 'indexed',
        isPlaceholder: false,
        modifiedAt: '2026-08-25T00:00:00.000Z',
        messageCount: 1,
      }],
      refresh: () => undefined,
      remove: () => undefined,
    };
    let fingerprintCalls = 0;
    let canonicalPathCalls = 0;
    const lexicalPathKey = (filePath: string): string => {
      const resolved = path.resolve(filePath);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const leases = new ColdSessionLeaseAuthority(21, {
      fingerprint: () => {
        fingerprintCalls += 1;
        return 'catalog rows must not be fingerprinted';
      },
      canonicalPathKey: (filePath) => {
        canonicalPathCalls += 1;
        return lexicalPathKey(filePath);
      },
    });
    const [hotToken] = leases.reserveCanonicalPaths(
      [path.join(root, 'active-hot-session.jsonl')],
      'long-lived-hot-session',
      { hideFromCatalog: false },
    );
    canonicalPathCalls = 0;
    const store = new ColdSessionStore({
      sdk: { SessionManager: {} } as any,
      coordinatorGeneration: 21,
      startupCwd: root,
      agentDir: root,
      leaseAuthority: leases,
      sessionCatalog: catalog as any,
    });

    const listing = await Promise.race([
      store.list(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('list blocked on inventory')), 250)),
    ]);
    assert.equal(eagerInventoryCalls, 0);
    assert.equal(listing[0]?.path, sessionPath);
    store.publishSync(listing, () => undefined);
    assert.equal(fingerprintCalls, 0, 'warm catalog projection and publication remain filesystem-free');
    assert.equal(canonicalPathCalls, 0, 'an unrelated hot reservation does not canonicalize catalog rows');

    leases.invalidate(sessionPath);
    assert.throws(
      () => store.publishSync(listing, () => undefined),
      StaleColdSessionLeaseError,
      'one catalog authority stamp still fences a stale writer publication',
    );
    leases.releaseCanonicalPaths([hotToken]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reservation basename candidates preserve canonical alias matching and index lifecycle', () => {
  const root = path.resolve(os.tmpdir(), 'pie-cold-reservation-candidates');
  const reserved = path.join(root, 'canonical', 'same.jsonl');
  const alias = path.join(root, 'alias', 'same.jsonl');
  const otherSameBasename = path.join(root, 'other', 'same.jsonl');
  const unrelated = path.join(root, 'other', 'different.jsonl');
  const lexicalPathKey = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  let canonicalPathCalls = 0;
  const leases = new ColdSessionLeaseAuthority(61, {
    fingerprint: () => 'fingerprint',
    canonicalPathKey: (filePath) => {
      canonicalPathCalls += 1;
      return lexicalPathKey(filePath === alias ? reserved : filePath);
    },
  });

  const [token] = leases.reserveCanonicalPaths([reserved], 'candidate-index');
  canonicalPathCalls = 0;
  assert.equal(leases.isPathReserved(unrelated), false);
  assert.equal(canonicalPathCalls, 0, 'non-candidate basenames stay filesystem-free');
  assert.equal(leases.isPathReserved(reserved), true);
  assert.equal(canonicalPathCalls, 0, 'an exact lexical reservation needs no canonicalization');
  assert.equal(leases.isPathReserved(alias), true);
  assert.equal(canonicalPathCalls, 1, 'a same-basename alias uses the canonical safety fallback');
  assert.equal(leases.isPathReserved(otherSameBasename), false);
  assert.equal(canonicalPathCalls, 2, 'a non-alias basename collision is still canonicalized safely');

  assert.throws(
    () => leases.releaseCanonicalPaths([token, token]),
    /Duplicate cold path reservation release/,
  );
  assert.equal(leases.isPathReserved(reserved), true, 'a rejected release leaves both indexes intact');
  leases.releaseCanonicalPaths([token]);
  canonicalPathCalls = 0;
  assert.equal(leases.isPathReserved(alias), false);
  assert.equal(canonicalPathCalls, 0, 'release removes the last basename candidate');

  leases.reserveCanonicalPaths([reserved], 'generation-reset');
  leases.advanceCoordinatorGeneration(62);
  canonicalPathCalls = 0;
  assert.equal(leases.isPathReserved(alias), false);
  assert.equal(canonicalPathCalls, 0, 'generation advance clears the candidate index');
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

test('representative coordinator fallback operations retain their causal control-plane contract', async () => {
  const h = await makeHarness();
  try {
    assert.equal(COLD_SESSION_STORE_PLACEMENT, 'coordinator-with-optional-helper');
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
    // Exercise a physical page miss here; ordinary page-after-open is now a
    // cache hit and can correctly finish before the scheduled ping callback.
    h.leases.invalidate(primaryPath);
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

test('list skips reserved (mid-creation) paths instead of failing the whole scan', async () => {
  const h = await makeHarness();
  try {
    const committedPath = path.join(h.sessionDir, 'committed.jsonl');
    await writeJsonl(committedPath, [header(h.root, 3, 'committed'), userEntry('root', null, 'hello')]);
    const [hotToken] = h.leases.reserveCanonicalPaths(
      [committedPath],
      'hot:active-worker',
      { hideFromCatalog: false },
    );

    // Reserve a path as if a `session.create` is in flight.
    const reservedPath = path.join(h.sessionDir, 'reserved.jsonl');
    const [token] = h.leases.reserveCanonicalPaths([reservedPath], 'test-reservation');

    // `capture` on a reserved path throws (unchanged contract for writers).
    assert.throws(
      () => h.leases.capture(reservedPath),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
    );

    // Both reservation kinds reject cold IO, but only the uncommitted
    // destination reservation is hidden from the catalog.
    assert.equal(h.leases.tryCapture(reservedPath), undefined);
    assert.equal(h.leases.tryCapture(committedPath), undefined);
    assert.throws(
      () => h.leases.capture(committedPath),
      (error) => error instanceof StaleColdSessionLeaseError && error.reason === 'path-reserved',
    );

    // `list` omits the reserved path rather than throwing `path-reserved`.
    const listing = await h.store.list();
    const paths = listing.map((summary) => summary.path);
    assert.ok(paths.includes(committedPath), 'committed session is listed');
    assert.ok(!paths.includes(reservedPath), 'reserved (mid-creation) session is omitted');

    // Releasing the reservation makes the path visible again (the file now
    // exists on disk, so background inventory reconciliation finds it).
    await writeJsonl(reservedPath, [header(h.root, 3, 'reserved'), userEntry('root', null, 'hello')]);
    h.leases.releaseCanonicalPaths([token]);
    // Production learns external inventory changes through the safety poll;
    // an ordinary cold mutation supplies the equivalent explicit refresh hint
    // in this isolated store test.
    h.store.create({ cwd: h.root });
    let afterRelease: string[] = [];
    for (let attempt = 0; attempt < 50 && !afterRelease.includes(reservedPath); attempt += 1) {
      afterRelease = (await h.store.list()).map((summary) => summary.path);
      if (!afterRelease.includes(reservedPath)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(afterRelease.includes(reservedPath), 'released path becomes visible');
    h.leases.releaseCanonicalPaths([hotToken]);
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
