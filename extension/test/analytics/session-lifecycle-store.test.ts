import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSessionLifecycleWriterAdmission,
  SessionLifecycleStore,
  sessionRetentionDeadline,
} from '../../src/backend/session-lifecycle-store.js';
import {
  SessionExpiryScheduler,
  SessionFilesystemMutationBarrier,
  SessionLifecycleCleaner,
} from '../../src/backend/session-filesystem-lifecycle.js';

function tempDatabase(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'pie-session-lifecycle-'));
  return { root, databasePath: path.join(root, 'lifecycle.sqlite') };
}

test('schema-v1 lifecycle databases add every required close and update column', () => {
  const temp = tempDatabase();
  const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
    DatabaseSync: new (location: string) => { exec(sql: string): void; close(): void };
  };
  const legacy = new DatabaseSync(temp.databasePath);
  legacy.exec(`
    CREATE TABLE session_lifecycle (
      session_id TEXT PRIMARY KEY,
      privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('on', 'off')),
      privacy_updated_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      expires_at_ms INTEGER,
      first_close_operation_id TEXT UNIQUE,
      disposition TEXT CHECK (disposition IN ('delete', 'retain')),
      write_epoch INTEGER NOT NULL DEFAULT 0,
      cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('retained', 'deleting', 'deleted')),
      deleted_at_ms INTEGER
    ) STRICT;
    INSERT INTO session_lifecycle VALUES ('legacy', 'off', 1, NULL, NULL, NULL, NULL, 0, 'retained', NULL);
    PRAGMA user_version = 1;
  `);
  legacy.close();
  const store = new SessionLifecycleStore(temp.databasePath);
  try {
    store.setPrivacyMode('legacy', 'on', 10);
    assert.equal(store.resolveClose('legacy', 'legacy-close', 20).firstCloseOperationId, 'legacy-close');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('schema-v2 lifecycle databases add durable pending-create ownership', () => {
  const temp = tempDatabase();
  const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
    DatabaseSync: new (location: string) => { exec(sql: string): void; close(): void };
  };
  const legacy = new DatabaseSync(temp.databasePath);
  legacy.exec(`
    CREATE TABLE session_lifecycle (
      session_id TEXT PRIMARY KEY,
      privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('off', 'on')),
      close_operation_id TEXT UNIQUE,
      first_close_cause TEXT,
      closed_at_ms TEXT,
      disposition TEXT,
      expires_at_ms TEXT,
      transcript_relative_path TEXT,
      cleanup_operation_id TEXT UNIQUE,
      cleanup_state TEXT NOT NULL,
      cleanup_started_at_ms TEXT,
      cleanup_error TEXT,
      deleted_at_ms TEXT,
      write_epoch INTEGER NOT NULL,
      updated_at_ms TEXT NOT NULL
    );
    INSERT INTO session_lifecycle (
      session_id, privacy_mode, cleanup_state, write_epoch, updated_at_ms
    ) VALUES ('v2-root', 'off', 'open', 0, '1');
    PRAGMA user_version = 2;
  `);
  legacy.close();
  const store = new SessionLifecycleStore(temp.databasePath);
  try {
    const record = store.registerPendingCreateOperation('v2-root', 'v2-create-origin', 2);
    assert.equal(record.pendingCreateOperationId, 'v2-create-origin');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('additive analytics host registry keeps the lifecycle schema version compatible with old hosts', () => {
  const temp = tempDatabase();
  const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
    DatabaseSync: new (location: string) => {
      prepare(sql: string): { get(...params: unknown[]): unknown };
      close(): void;
    };
  };
  let store = new SessionLifecycleStore(temp.databasePath);
  store.registerAnalyticsHost({
    hostInstanceId: 'host-additive', workspaceId: 'workspace-additive',
    generationId: 'generation-additive', buildId: 'build-additive', processId: 1,
    capabilities: ['host-status'], registeredAtMs: '1',
  });
  store.close();
  const oldReader = new DatabaseSync(temp.databasePath);
  try {
    const version = oldReader.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
    assert.equal(Number(version.user_version), 3);
    oldReader.prepare('SELECT session_id, cleanup_state FROM session_lifecycle').get();
  } finally {
    oldReader.close();
  }
  store = new SessionLifecycleStore(temp.databasePath);
  try {
    assert.equal(store.getAnalyticsHost('host-additive')?.state, 'registered');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('read-only lifecycle handles support non-mutating production discovery', () => {
  const temp = tempDatabase();
  const writable = new SessionLifecycleStore(temp.databasePath);
  writable.registerAnalyticsHost({
    hostInstanceId: 'host-read-only', workspaceId: 'workspace-read-only',
    generationId: 'generation-read-only', buildId: 'build-read-only', processId: 301,
    capabilities: ['authenticated-control'], registeredAtMs: '1',
  });
  writable.close();
  const readonly = new SessionLifecycleStore(temp.databasePath, { readOnly: true });
  try {
    assert.equal(readonly.listAnalyticsHosts('workspace-read-only').hosts[0]?.hostInstanceId, 'host-read-only');
    assert.throws(() => readonly.registerAnalyticsHost({
      hostInstanceId: 'host-read-only-new', workspaceId: 'workspace-read-only',
      generationId: 'generation-read-only-new', buildId: 'build-read-only', processId: 302,
      capabilities: ['authenticated-control'], registeredAtMs: '2',
    }), /read-only/);
    assert.equal(readonly.listAnalyticsHosts('workspace-read-only').hosts.length, 1);
  } finally {
    readonly.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('durable writer admission holds leases through writes and rejects a fenced epoch', () => {
  const temp = tempDatabase();
  const store = new SessionLifecycleStore(temp.databasePath);
  const identity = {
    hostInstanceId: 'writer-admission-host',
    workspaceId: 'writer-admission-workspace',
    generationId: 'writer-admission-generation',
    buildId: 'writer-admission-build',
    processId: 401,
  };
  try {
    store.registerAnalyticsHost({
      ...identity,
      capabilities: ['authenticated-control', 'writer-fence'],
      registeredAtMs: '1',
    });
    const admission = createSessionLifecycleWriterAdmission(store, identity, () => 2);
    const release = admission.acquire();
    assert.equal(store.listAnalyticsWriterLeases(identity.workspaceId).length, 1);
    release();
    assert.equal(store.listAnalyticsWriterLeases(identity.workspaceId).length, 0);

    const fence = store.beginAnalyticsWriterFence({
      workspaceId: identity.workspaceId,
      operationId: 'writer-admission-fence',
      purpose: 'analytics-activation',
      expectedHosts: [identity],
      nowMs: 3,
    });
    assert.throws(() => admission.assertAdmitted(), /admission is fencing/);
    assert.throws(() => admission.acquire(), /admission is fencing/);
    store.acknowledgeAnalyticsWriterFence({
      workspaceId: identity.workspaceId,
      operationId: fence.operationId,
      fenceEpoch: fence.fenceEpoch,
      identity,
      activeWriterCount: 0,
      nowMs: 4,
    });
    store.markAnalyticsHostState(identity.hostInstanceId, identity.processId, identity.generationId, 'stopped', 5);
    assert.equal(store.completeAnalyticsWriterFence(identity.workspaceId, fence.operationId, 6).state, 'fenced');

    const successor = {
      hostInstanceId: 'writer-admission-successor',
      workspaceId: identity.workspaceId,
      generationId: 'writer-admission-successor-generation',
      buildId: identity.buildId,
      processId: 402,
    };
    store.registerAnalyticsHost({
      ...successor,
      capabilities: ['authenticated-control', 'writer-fence'],
      registeredAtMs: '7',
    });
    const successorAdmission = createSessionLifecycleWriterAdmission(store, successor, () => 8);
    assert.throws(() => successorAdmission.acquire(), /admission is fenced/);
    const startupRelease = successorAdmission.acquireStartup?.();
    assert.equal(typeof startupRelease, 'function');
    assert.equal(store.listAnalyticsWriterLeases(identity.workspaceId).length, 1);
    startupRelease?.();
    assert.equal(store.listAnalyticsWriterLeases(identity.workspaceId).length, 0);
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('analytics host pagination uses a workspace and host ordering index', () => {
  const temp = tempDatabase();
  const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
    DatabaseSync: new (location: string) => {
      prepare(sql: string): { all(...params: unknown[]): unknown[] };
      close(): void;
    };
  };
  const store = new SessionLifecycleStore(temp.databasePath);
  store.registerAnalyticsHost({
    hostInstanceId: 'host-page-a', workspaceId: 'workspace-page',
    generationId: 'generation-page-a', buildId: 'build-page', processId: 101,
    capabilities: ['host-status'], registeredAtMs: '1',
  });
  store.registerAnalyticsHost({
    hostInstanceId: 'host-page-b', workspaceId: 'workspace-page',
    generationId: 'generation-page-b', buildId: 'build-page', processId: 102,
    capabilities: ['host-status'], registeredAtMs: '2',
  });
  const page = store.listAnalyticsHosts('workspace-page', { limit: 1 });
  assert.deepEqual(page.hosts.map((host) => host.hostInstanceId), ['host-page-a']);
  assert.equal(page.nextCursor, 'host-page-a');
  const database = new DatabaseSync(temp.databasePath);
  try {
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM analytics_hosts
      WHERE workspace_id = ? AND host_instance_id > ?
      ORDER BY host_instance_id LIMIT ?
    `).all('workspace-page', 'host-page-a', 2) as Array<{ detail?: string }>;
    assert.ok(
      plan.some((entry) => entry.detail?.includes('analytics_hosts_workspace_host')),
      `pagination query must use the bounded workspace/host index: ${JSON.stringify(plan)}`,
    );
  } finally {
    database.close();
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('stopping and stopped host identities cannot be revived by heartbeat or registration', () => {
  const temp = tempDatabase();
  const store = new SessionLifecycleStore(temp.databasePath);
  const host = {
    hostInstanceId: 'host-terminal', workspaceId: 'workspace-terminal',
    generationId: 'generation-terminal', buildId: 'build-terminal', processId: 201,
    capabilities: ['host-status'], registeredAtMs: '1',
  };
  try {
    store.registerAnalyticsHost(host);
    store.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopping', 2);
    assert.throws(
      () => store.heartbeatAnalyticsHost(host.hostInstanceId, host.processId, host.generationId, 3),
      /heartbeat identity is stale/,
    );
    assert.equal(store.getAnalyticsHost(host.hostInstanceId)?.state, 'stopping');
    store.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopped', 4);
    assert.throws(
      () => store.registerAnalyticsHost(host),
      /terminal and cannot be re-registered/,
    );
    assert.throws(
      () => store.heartbeatAnalyticsHost(host.hostInstanceId, host.processId, host.generationId, 5),
      /heartbeat identity is stale/,
    );
    assert.equal(store.getAnalyticsHost(host.hostInstanceId)?.state, 'stopped');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('pending-create origin survives private close, restart, and cleanup replay without resurrection', async () => {
  const temp = tempDatabase();
  const sessions = path.join(temp.root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  let store = new SessionLifecycleStore(temp.databasePath);
  const pendingOrigins: Array<string | undefined> = [];
  try {
    store.registerTranscript('root-private', 'private.jsonl', 10);
    store.registerPendingCreateOperation('root-private', 'create-origin-private', 11);
    store.setPrivacyMode('root-private', 'on', 12);
    store.resolveClose('root-private', 'cleanup-operation-private', 13, 'private_close');

    store.close();
    store = new SessionLifecycleStore(temp.databasePath);
    const barrier = new SessionFilesystemMutationBarrier({
      store,
      lockRoot: path.join(temp.root, 'locks'),
    });
    const cleaner = new SessionLifecycleCleaner({
      store,
      barrier,
      roots: { sessions },
      analytics: {
        deleteSession: (_root, _source, _timestamp, pendingCreateOperationId) => {
          pendingOrigins.push(pendingCreateOperationId);
        },
      },
      now: () => 14,
    });

    await cleaner.cleanupSession('root-private', 'cleanup-operation-private');
    assert.deepEqual(pendingOrigins, ['create-origin-private']);
    assert.equal(store.get('root-private')?.cleanupState, 'deleted');
    assert.equal(
      store.registerPendingCreateOperation('root-private', 'create-origin-private', 15).cleanupState,
      'deleted',
      'a stale retry may confirm identity but must not reopen a deleted root',
    );
    assert.throws(
      () => store.registerPendingCreateOperation('root-private', 'different-create-origin', 16),
      /already bound to another pending-create operation/,
    );

    store.registerTranscript('unrelated-root', 'unrelated.jsonl', 17);
    store.registerPendingCreateOperation('unrelated-root', 'unrelated-create-origin', 18);
    assert.equal(store.get('unrelated-root')?.cleanupState, 'open');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('pending-create origins cannot alias two distinct root sessions', () => {
  const temp = tempDatabase();
  const store = new SessionLifecycleStore(temp.databasePath);
  try {
    store.registerPendingCreateOperation('root-a', 'shared-create-alias', 1);
    assert.throws(
      () => store.registerPendingCreateOperation('root-b', 'shared-create-alias', 2),
      /UNIQUE constraint failed/,
    );
    assert.equal(store.get('root-a')?.pendingCreateOperationId, 'shared-create-alias');
    assert.equal(store.get('root-b'), undefined, 'a conflicting create must not register an unrelated root');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('privacy setting is reversible while open and the first close decision is frozen across hosts', () => {
  const temp = tempDatabase();
  const first = new SessionLifecycleStore(temp.databasePath);
  const second = new SessionLifecycleStore(temp.databasePath);
  try {
    first.setPrivacyMode('session-private', 'on', 100);
    first.setPrivacyMode('session-private', 'off', 101);
    second.setPrivacyMode('session-private', 'on', 102);

    const close = first.resolveClose('session-private', 'close-operation-1', 200);
    assert.equal(close.privacyMode, 'on');
    assert.equal(close.disposition, 'delete');
    assert.equal(close.cleanupState, 'deleting');
    assert.equal(close.expiresAtMs, undefined);
    assert.equal(close.writeEpoch, 1);
    assert.equal(close.duplicate, false);

    const duplicate = second.resolveClose('session-private', 'competing-close-operation', 999);
    assert.deepEqual(duplicate, { ...close, duplicate: true });
    assert.throws(() => second.setPrivacyMode('session-private', 'off', 1_000), /frozen after close/);

    const deleted = second.markDeleted('session-private', 250);
    assert.equal(deleted.cleanupState, 'deleted');
    assert.equal(first.get('session-private')?.cleanupState, 'deleted');
  } finally {
    first.close();
    second.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('privacy setting survives application shutdown without becoming an implicit close', () => {
  const temp = tempDatabase();
  let store = new SessionLifecycleStore(temp.databasePath);
  try {
    store.setPrivacyMode('session-restart', 'on', 100);
    store.close();
    store = new SessionLifecycleStore(temp.databasePath);
    const open = store.get('session-restart');
    assert.equal(open?.privacyMode, 'on');
    assert.equal(open?.closedAtMs, undefined);
    assert.equal(store.resolveClose('session-restart', 'close-after-restart', 200).disposition, 'delete');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('non-private close retains for exactly 24 hours using signed-64-bit timestamps', () => {
  const temp = tempDatabase();
  let store = new SessionLifecycleStore(temp.databasePath);
  try {
    const closedAt = '9007199254740993';
    const close = store.resolveClose('session-retained', 'close-operation-retained', closedAt);
    assert.equal(close.disposition, 'retain');
    assert.equal(close.expiresAtMs, sessionRetentionDeadline(closedAt));
    assert.deepEqual(store.listDue(BigInt(close.expiresAtMs) - 1n), []);
    assert.equal(store.listDue(close.expiresAtMs)[0]?.sessionId, 'session-retained');

    store.close();
    store = new SessionLifecycleStore(temp.databasePath);
    assert.deepEqual(store.resolveClose('session-retained', 'restart-retry', 1), {
      ...close,
      duplicate: true,
    });
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

function lifecycleFixture(now: { value: number }) {
  const temp = tempDatabase();
  const sessions = path.join(temp.root, 'sessions');
  const artifacts = path.join(temp.root, 'artifacts');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const store = new SessionLifecycleStore(temp.databasePath);
  const barrier = new SessionFilesystemMutationBarrier({
    store,
    lockRoot: path.join(temp.root, 'locks'),
    now: () => now.value,
    waitTimeoutMs: 25,
    retryDelayMs: 1,
  });
  return { temp, sessions, artifacts, store, barrier };
}

function writeTranscript(filePath: string, sessionId: string): void {
  writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: sessionId })}\n`);
}

test('private close atomically fences all later SDK mutations and deletes only registered owned files', async () => {
  const now = { value: 1_000 };
  const fixture = lifecycleFixture(now);
  const transcript = path.join(fixture.sessions, 'private.jsonl');
  const sidecar = path.join(fixture.artifacts, 'private-sidecar.json');
  const unrelated = path.join(fixture.artifacts, 'caller-owned.txt');
  writeTranscript(transcript, 'private-root');
  writeFileSync(sidecar, 'owned');
  writeFileSync(unrelated, 'unrelated');
  const analyticsDeletes: string[] = [];
  try {
    fixture.store.registerTranscript('private-root', 'private.jsonl', now.value);
    fixture.store.registerArtifact({
      sessionId: 'private-root', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'root_relative', location: 'private.jsonl', rootName: 'sessions',
    }, now.value);
    fixture.store.registerArtifact({
      sessionId: 'private-root', artifactId: 'sidecar', kind: 'session_sidecar',
      locationKind: 'root_relative', location: 'private-sidecar.json', rootName: 'artifacts',
    }, now.value);
    fixture.store.setPrivacyMode('private-root', 'on', now.value);
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store,
      barrier: fixture.barrier,
      roots: { sessions: fixture.sessions, artifacts: fixture.artifacts },
      analytics: { deleteSession: (sessionId) => { analyticsDeletes.push(sessionId); } },
      now: () => now.value,
    });

    const close = await cleaner.closeSession('private-root', 'private-close', 'private_close');
    assert.equal(close.disposition, 'delete');
    assert.equal(fixture.store.get('private-root')?.cleanupState, 'deleted');
    assert.deepEqual(analyticsDeletes, ['private-root']);
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(sidecar), false);
    assert.equal(existsSync(unrelated), true);
    assert.throws(
      () => fixture.barrier.runWriteMutation('private-root', 'late-append', () => writeTranscript(transcript, 'private-root')),
      /Writes are revoked/,
    );
    assert.equal(existsSync(transcript), false, 'a rejected late writer must not recreate the transcript');
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('private crash recovery remains visibly blocked without the canonical analytics deletion adapter', async () => {
  const now = { value: 9_000 };
  const fixture = lifecycleFixture(now);
  try {
    fixture.store.registerTranscript('blocked-private', 'blocked.jsonl', now.value);
    fixture.store.setPrivacyMode('blocked-private', 'on', now.value);
    fixture.store.resolveClose('blocked-private', 'blocked-close', now.value, 'private_close');
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store, barrier: fixture.barrier, roots: { sessions: fixture.sessions }, now: () => now.value,
    });
    await assert.rejects(
      cleaner.cleanupSession('blocked-private', 'blocked-close'),
      /Private analytics deletion adapter is unavailable/,
    );
    assert.equal(fixture.store.get('blocked-private')?.cleanupState, 'blocked');
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('ordinary expiry does not shorten 24 hours or delete retained analytics', async () => {
  const now = { value: 10_000 };
  const fixture = lifecycleFixture(now);
  const transcript = path.join(fixture.sessions, 'ordinary.jsonl');
  writeTranscript(transcript, 'ordinary-root');
  let analyticsDeletes = 0;
  try {
    fixture.store.registerTranscript('ordinary-root', 'ordinary.jsonl', now.value);
    fixture.store.registerArtifact({
      sessionId: 'ordinary-root', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'root_relative', location: 'ordinary.jsonl', rootName: 'sessions',
    }, now.value);
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store,
      barrier: fixture.barrier,
      roots: { sessions: fixture.sessions },
      analytics: { deleteSession: () => { analyticsDeletes += 1; } },
      now: () => now.value,
    });
    const close = await cleaner.closeSession('ordinary-root', 'ordinary-close');
    const deadline = Number(close.expiresAtMs);
    now.value = deadline - 1;
    assert.deepEqual(await cleaner.runDue(), { deleted: [], blocked: [] });
    assert.equal(existsSync(transcript), true);
    now.value = deadline;
    assert.deepEqual(await cleaner.runDue(), { deleted: ['ordinary-root'], blocked: [] });
    assert.equal(existsSync(transcript), false);
    assert.equal(analyticsDeletes, 0);
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('expiry scheduler arms the exact retained deadline and recovers due work at startup', async () => {
  const now = { value: 20_000 };
  const fixture = lifecycleFixture(now);
  const callbacks: Array<() => void> = [];
  try {
    fixture.store.registerTranscript('scheduled-root', 'scheduled.jsonl', now.value);
    const close = fixture.store.resolveClose('scheduled-root', 'scheduled-close', now.value);
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store, barrier: fixture.barrier, roots: { sessions: fixture.sessions }, now: () => now.value,
    });
    const delays: number[] = [];
    const scheduler = new SessionExpiryScheduler({
      store: fixture.store,
      cleaner,
      now: () => now.value,
      setTimer: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return { callback } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => undefined,
    });
    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delays[0], Number(BigInt(close.expiresAtMs!) - BigInt(now.value)));
    now.value = Number(close.expiresAtMs);
    callbacks.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.store.get('scheduled-root')?.cleanupState, 'deleted');
    await scheduler.stop();
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('interrupted deletion resumes from persisted per-artifact intent without scanning', async () => {
  const now = { value: 5_000 };
  const fixture = lifecycleFixture(now);
  const transcript = path.join(fixture.sessions, 'recover.jsonl');
  writeTranscript(transcript, 'recover-root');
  try {
    fixture.store.registerTranscript('recover-root', 'recover.jsonl', now.value);
    fixture.store.registerArtifact({
      sessionId: 'recover-root', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'root_relative', location: 'recover.jsonl', rootName: 'sessions',
    }, now.value);
    fixture.store.setPrivacyMode('recover-root', 'on', now.value);
    fixture.store.resolveClose('recover-root', 'recover-close', now.value, 'private_close');
    fixture.store.markArtifactDeleting('recover-root', 'transcript', 'recover-close', now.value);
    rmSync(transcript); // crash after unlink and before the durable completion mark

    fixture.store.close();
    fixture.store = new SessionLifecycleStore(fixture.temp.databasePath);
    const barrier = new SessionFilesystemMutationBarrier({
      store: fixture.store, lockRoot: path.join(fixture.temp.root, 'locks'), now: () => now.value,
    });
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store, barrier, roots: { sessions: fixture.sessions },
      analytics: { deleteSession: () => undefined }, now: () => now.value,
    });
    assert.equal((await cleaner.cleanupSession('recover-root', 'recover-close')).cleanupState, 'deleted');
    assert.equal(fixture.store.listArtifacts('recover-root')[0]?.state, 'deleted');
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('cross-host lock recovery serializes one session without blocking an unrelated session', async () => {
  const now = { value: 8_000 };
  const fixture = lifecycleFixture(now);
  try {
    fixture.store.registerTranscript('session-a', 'a.jsonl', now.value);
    fixture.store.registerTranscript('session-b', 'b.jsonl', now.value);
    const secondHost = new SessionFilesystemMutationBarrier({
      store: fixture.store,
      lockRoot: path.join(fixture.temp.root, 'locks'),
      waitTimeoutMs: 10,
      retryDelayMs: 1,
    });
    fixture.barrier.runWriteMutation('session-a', 'slow-a', () => {
      assert.equal(secondHost.runWriteMutation('session-b', 'write-b', () => 'b'), 'b');
      assert.throws(
        () => secondHost.runWriteMutation('session-a', 'competing-a', () => 'late'),
        /Timed out acquiring session mutation barrier/,
      );
    });

    const staleId = 'stale-session';
    fixture.store.registerTranscript(staleId, 'stale.jsonl', now.value);
    const key = createHash('sha256').update(staleId).digest('hex');
    const staleLock = path.join(fixture.temp.root, 'locks', `${key}.lock`);
    mkdirSync(staleLock);
    writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({
      schema: 1, pid: 999_999, token: 'dead', sessionId: staleId, acquiredAtMs: 0,
    }));
    mkdirSync(`${staleLock}.takeover`);
    writeFileSync(path.join(`${staleLock}.takeover`, 'owner.json'), JSON.stringify({
      schema: 1, pid: 999_998, token: 'dead-takeover', sessionId: staleId, acquiredAtMs: 0,
    }));
    const recoveringHost = new SessionFilesystemMutationBarrier({
      store: fixture.store,
      lockRoot: path.join(fixture.temp.root, 'locks'),
      processAlive: () => false,
    });
    assert.equal(recoveringHost.runWriteMutation(staleId, 'recover-dead-owner', () => 'recovered'), 'recovered');

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const slow = fixture.barrier.runWriteMutationAsync('session-a', 'slow-async-a', async () => {
      await slowGate;
      return 'slow-finished';
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await secondHost.runWriteMutationAsync('session-b', 'async-b', async () => 'b-finished'), 'b-finished');
    await assert.rejects(
      secondHost.runWriteMutationAsync('session-a', 'competing-async-a', async () => 'late'),
      /Timed out acquiring session mutation barrier/,
    );
    releaseSlow();
    assert.equal(await slow, 'slow-finished');
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});

test('a copied session gets independent open privacy/lifecycle state and a closed source cannot reopen', () => {
  const temp = tempDatabase();
  const store = new SessionLifecycleStore(temp.databasePath);
  try {
    store.registerTranscript('source', 'source.jsonl', 1);
    store.setPrivacyMode('source', 'on', 2);
    store.resolveClose('source', 'source-close', 3, 'private_close');
    assert.throws(() => store.assertWritable('source'), /Writes are revoked/);

    const copy = store.registerTranscript('copy', 'copy.jsonl', 4);
    assert.equal(copy.privacyMode, 'off');
    assert.equal(copy.cleanupState, 'open');
    assert.equal(store.assertWritable('copy').sessionId, 'copy');
  } finally {
    store.close();
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test('missing owned targets are complete while path-reused targets fail without deleting the replacement', async () => {
  const now = { value: 7_000 };
  const fixture = lifecycleFixture(now);
  const missing = path.join(fixture.sessions, 'missing.jsonl');
  const reused = path.join(fixture.sessions, 'reused.jsonl');
  try {
    fixture.store.registerTranscript('missing-root', 'missing.jsonl', now.value);
    fixture.store.registerArtifact({
      sessionId: 'missing-root', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'root_relative', location: 'missing.jsonl', rootName: 'sessions',
    }, now.value);
    fixture.store.setPrivacyMode('missing-root', 'on', now.value);
    fixture.store.resolveClose('missing-root', 'missing-close', now.value, 'private_close');
    const cleaner = new SessionLifecycleCleaner({
      store: fixture.store, barrier: fixture.barrier, roots: { sessions: fixture.sessions },
      analytics: { deleteSession: () => undefined }, now: () => now.value,
    });
    assert.equal((await cleaner.cleanupSession('missing-root', 'missing-close')).cleanupState, 'deleted');

    writeTranscript(reused, 'different-session');
    fixture.store.registerTranscript('reused-root', 'reused.jsonl', now.value);
    fixture.store.registerArtifact({
      sessionId: 'reused-root', artifactId: 'transcript', kind: 'transcript',
      locationKind: 'root_relative', location: 'reused.jsonl', rootName: 'sessions',
    }, now.value);
    fixture.store.setPrivacyMode('reused-root', 'on', now.value);
    fixture.store.resolveClose('reused-root', 'reused-close', now.value, 'private_close');
    await assert.rejects(cleaner.cleanupSession('reused-root', 'reused-close'), /header identity does not match/);
    assert.equal(existsSync(reused), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.temp.root, { recursive: true, force: true });
  }
});
