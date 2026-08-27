import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import { getReviewSidecarFingerprint, readReviews } from '../../../src/backend/session-review-store';

type PollingTestServer = {
  agentDir: string;
  sessionDir: string;
  sessionDirResolved: boolean;
  sessionCatalog: {
    invalidateIfInventoryChanged(agentDir: string, sessionDir?: string): Promise<boolean>;
  };
  emitSessionListChanged(): Promise<void>;
  startReviewReconciliation(): void;
  startSessionCatalogPolling(intervalMs?: number): void;
  sessionCatalogPollTimer?: NodeJS.Timeout;
  reviewSidecarFingerprint: string;
  pollSessionCatalog(): Promise<void>;
  dispose(): Promise<void>;
};

function createPollingTestServer(): PollingTestServer {
  const server = new BackendServer({ workerEntryPath: '/worker-entry.js', sdkPath: '/unused', cwd: '/workspace' }) as unknown as PollingTestServer;
  server.agentDir = path.resolve('/agent');
  server.sessionDir = path.resolve('/configured/sessions');
  server.sessionDirResolved = true;
  return server;
}

test('backend RPCs use the configured directory while explicit legacy opens keep their path', async () => {
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  const configuredDir = path.resolve('/configured/sessions');
  const sdkFallbackDir = path.resolve('/sdk-default/sessions');
  process.env.PI_CODING_AGENT_SESSION_DIR = configuredDir;

  try {
    const catalogListDirs: Array<string | undefined> = [];
    const sdkListDirs: Array<string | undefined> = [];
    const openCalls: unknown[][] = [];
    const sessionCatalog = {
      list: async (_sdk: unknown, sessionDir?: string) => {
        catalogListDirs.push(sessionDir);
        return [];
      },
      refresh: () => undefined,
      remove: () => undefined,
      getProgress: () => ({ complete: true, processed: 0, total: 0 }),
      invalidateIfInventoryChanged: async () => false,
    };
    const server = new BackendServer({
      workerEntryPath: '/worker-entry.js',
      sdkPath: '/unused',
      cwd: '/workspace',
      sessionCatalog: sessionCatalog as any,
    }) as any;
    server.agentDir = path.resolve('/agent');
    server.sdk = {
      VERSION: 'test',
      SessionManager: {
        create: (cwd: string, sessionDir?: string) => {
          const sessionPath = path.join(sessionDir ?? sdkFallbackDir, 'created.jsonl');
          return {
            getCwd: () => cwd,
            getSessionFile: () => sessionPath,
            getSessionName: () => undefined,
            getBranch: () => [],
            getEntries: () => [],
          };
        },
        listAll: async (sessionDir?: string) => {
          sdkListDirs.push(sessionDir);
          return [];
        },
        open: (...args: unknown[]) => {
          openCalls.push(args);
          return { cwd: '/legacy-workspace', sessionPath: String(args[0]) };
        },
      },
    };
    server.buildSessionOpenedPayload = async (sessionPath: string) => ({ sessionPath });
    server.emit = () => undefined;
    server.emitSessionListChanged = async () => undefined;

    const result = await server.handleRequest({
      id: 'create-configured',
      method: 'session.create',
      params: { cwd: '/workspace' },
    }) as { sessionPath: string };

    assert.equal(result.sessionPath, path.join(configuredDir, 'created.jsonl'));

    assert.deepEqual(await server.handleRequest({ id: 'list-configured', method: 'session.list' }), []);
    assert.deepEqual(catalogListDirs, [configuredDir]);
    assert.deepEqual(sdkListDirs, [], 'indexed listing must not rescan through the SDK');
    assert.deepEqual(await server.handleRequest({ id: 'list-cached', method: 'session.list' }), []);
    assert.deepEqual(catalogListDirs, [configuredDir, configuredDir]);
    assert.deepEqual(sdkListDirs, [], 'an unchanged indexed catalog must not rescan session files');

    const legacyPath = path.join(sdkFallbackDir, 'legacy.jsonl');
    const opened = await server.handleRequest({
      id: 'open-legacy',
      method: 'session.open',
      params: { sessionPath: legacyPath },
    }) as { sessionPath: string };
    assert.equal(opened.sessionPath, legacyPath);
    assert.deepEqual(openCalls, [], 'the stubbed browse payload owns file reading; session.open must not invoke the runtime-promotion seam');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  }
});

test('session inventory polling is unrefed, overlap-safe, emits once, and stops on dispose', async () => {
  const server = createPollingTestServer();

  let checks = 0;
  let resolveCheck: ((changed: boolean) => void) | undefined;
  server.sessionCatalog.invalidateIfInventoryChanged = async () => {
    checks += 1;
    return await new Promise<boolean>((resolve) => { resolveCheck = resolve; });
  };
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };

  server.startSessionCatalogPolling(60_000);
  const timer = server.sessionCatalogPollTimer as NodeJS.Timeout;
  assert.equal(timer.hasRef(), false, 'background inventory polling must not keep the backend alive');

  const first = server.pollSessionCatalog();
  const overlapping = server.pollSessionCatalog();
  assert.equal(checks, 1, 'an overlapping tick must reuse/skip the active inventory check');
  resolveCheck?.(true);
  await Promise.all([first, overlapping]);
  assert.equal(emissions, 1, 'one changed inventory emits one session-list refresh');

  await server.dispose();
  await server.pollSessionCatalog();
  assert.equal(checks, 1, 'disposed polling cannot start another inventory check');
});

test('review reconciliation emits an unconditional startup refresh for a preseeded outbox', async () => {
  const reviewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-review-startup-'));
  const previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = reviewsDir;
  fs.writeFileSync(path.join(reviewsDir, 'closure-actions.jsonl'), `${JSON.stringify({
    actionId: 'preseeded-close', kind: 'closeSelf', targetSessionId: 'session-1',
    targetSessionPath: '/missing/session-1.jsonl', status: 'pending', attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
  })}\n`, 'utf8');

  const server = createPollingTestServer();
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };
  try {
    server.startReviewReconciliation();
    assert.equal(emissions, 1, 'startup/restart reconciliation must not wait for a watcher event');
    await server.pollSessionCatalog();
    assert.equal(emissions, 2, 'an unchanged active action keeps reconciliation bounded after a transient list failure');
  } finally {
    await server.dispose();
    if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = previous;
    fs.rmSync(reviewsDir, { recursive: true, force: true });
  }
});

test('unchanged sidecar fingerprint polls reuse cached active closure state without reparsing reviews', async () => {
  const reviewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-review-cache-'));
  const previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = reviewsDir;
  fs.writeFileSync(
    path.join(reviewsDir, 'reviews.jsonl'),
    Array.from({ length: 100 }, (_, index) => JSON.stringify({ schemaVersion: 2, reviewId: `invalid-${index}` })).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(reviewsDir, 'closure-actions.jsonl'), `${JSON.stringify({
    actionId: 'cached-active-close', kind: 'closeSelf', targetSessionId: 'session-cache',
    targetSessionPath: '/missing/session-cache.jsonl', status: 'pending', attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
  })}\n`, 'utf8');

  const server = createPollingTestServer();
  server.sessionCatalog.invalidateIfInventoryChanged = async () => false;
  let emissions = 0;
  server.emitSessionListChanged = async () => {
    emissions += 1;
    readReviews();
  };
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalRead = mutableFs.readFileSync;
  let sidecarReads = 0;
  mutableFs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file !== 'number' && path.dirname(path.resolve(String(file))) === path.resolve(reviewsDir)) {
      sidecarReads += 1;
    }
    return Reflect.apply(originalRead, mutableFs, [file, ...args]);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();

  try {
    server.startReviewReconciliation();
    const startupReads = sidecarReads;
    assert.ok(startupReads > 0, 'startup establishes parsed closure state');
    await server.pollSessionCatalog();
    await server.pollSessionCatalog();
    assert.equal(emissions, 3, 'the cached active action still drives bounded reconciliation retries');
    assert.equal(sidecarReads, startupReads, 'unchanged polls and retry lists use fingerprint-keyed parsed state only');
  } finally {
    mutableFs.readFileSync = originalRead;
    syncBuiltinESMExports();
    await server.dispose();
    if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = previous;
    fs.rmSync(reviewsDir, { recursive: true, force: true });
  }
});

test('sidecar fingerprint polling recovers a missed watcher event', async () => {
  const reviewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-review-poll-'));
  const previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = reviewsDir;
  const server = createPollingTestServer();
  server.sessionCatalog.invalidateIfInventoryChanged = async () => false;
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };

  try {
    server.startSessionCatalogPolling(60_000);
    // Establish the same baseline startup reconciliation records before the
    // simulated watcher miss.
    server.reviewSidecarFingerprint = getReviewSidecarFingerprint();
    fs.appendFileSync(path.join(reviewsDir, 'closure-actions.jsonl'), '{"wake":true}\n', 'utf8');

    await server.pollSessionCatalog();
    assert.equal(emissions, 1, 'the bounded poll observes sidecar mutation without fs.watch');
    await server.pollSessionCatalog();
    assert.equal(emissions, 1, 'an unchanged fingerprint does not emit repeatedly');
  } finally {
    await server.dispose();
    if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = previous;
    fs.rmSync(reviewsDir, { recursive: true, force: true });
  }
});

test('session inventory polling emits no list refresh when inventory inspection fails', async () => {
  const server = createPollingTestServer();
  server.sessionCatalog.invalidateIfInventoryChanged = async () => {
    throw Object.assign(new Error('inventory unavailable'), { code: 'EACCES' });
  };
  let emissions = 0;
  server.emitSessionListChanged = async () => { emissions += 1; };

  server.startSessionCatalogPolling(60_000);
  await server.pollSessionCatalog();
  assert.equal(emissions, 0, 'a failed inventory read cannot publish a possibly truncated list');
  await server.dispose();
});
