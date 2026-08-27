import assert from 'node:assert/strict';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { SessionCatalog } from '../../../src/backend/session-catalog';
import {
  isSessionIndexBusyError,
  resolveSessionIndexPath,
  SessionIndexStore,
  StaleSessionIndexMutationGenerationError,
  StaleSessionIndexSourceError,
} from '../../../src/backend/session-index-store';
import {
  readIndexedSessionMetadata,
  type IndexedSessionMetadata,
} from '../../../src/backend/session-metadata';
import {
  backendSessionPathKey,
  readBackendSessionInventory,
  readBackendSessionInventorySignature,
  statBackendSessionFile,
} from '../../../src/backend/session-directory';
import type { SdkModule } from '../../../src/backend/sdk';
import { deriveSessionNameFromText } from '../../../src/shared/session-name';

const sqlite = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (location: string) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
  };
};

function header(cwd: string, id: string, timestamp = '2026-01-01T00:00:00.000Z'): object {
  return { type: 'session', version: 3, id, timestamp, cwd };
}

function message(
  id: string,
  role: 'user' | 'assistant',
  content: unknown,
  timestamp: string,
): object {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp,
    message: { role, content, timestamp: Date.parse(timestamp) },
  };
}

async function readExistingSidecarText(indexPath: string): Promise<string> {
  const chunks: Buffer[] = [];
  for (const filePath of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    try {
      chunks.push(await fs.readFile(filePath));
    } catch (error) {
      const code = error && typeof error === 'object'
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeJsonl(filePath: string, entries: readonly object[]): Promise<void> {
  await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

async function readMetadata(
  filePath: string,
  previous?: IndexedSessionMetadata,
): Promise<IndexedSessionMetadata> {
  const fingerprint = await statBackendSessionFile(filePath);
  assert.ok(fingerprint);
  const result = await readIndexedSessionMetadata(fingerprint, previous);
  assert.equal(result.status, 'ok');
  return result.metadata;
}

const unusedSdk = {
  SessionManager: {
    listAll: async (): Promise<never> => {
      throw new Error('the persistent catalog must not call SessionManager.listAll');
    },
  },
} as unknown as SdkModule;

const createSyntheticFingerprintIndexStore = (
  indexPath: string,
  authorityKey: string,
): SessionIndexStore => new SessionIndexStore(indexPath, authorityKey, {
  reconciliationSourceMatches: () => true,
});

test('indexed metadata resumes ordinary appends and reparses a detected rewrite of only that file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-parser-'));
  try {
    const filePath = path.join(root, 'session.jsonl');
    await writeJsonl(filePath, [
      header(root, 'session-a'),
      message('user-1', 'user', 'Implement the durable session catalog', '2026-01-01T00:00:01.000Z'),
      message('assistant-1', 'assistant', 'Done', '2026-01-01T00:00:02.000Z'),
    ]);
    const firstFingerprint = await statBackendSessionFile(filePath);
    assert.ok(firstFingerprint);
    const firstResult = await readIndexedSessionMetadata(firstFingerprint);
    assert.equal(firstResult.status, 'ok');
    assert.equal(firstResult.resumedAppend, false);
    assert.equal(firstResult.metadata.summary.messageCount, 2);
    assert.equal(firstResult.metadata.summary.sessionId, 'session-a');

    await fs.appendFile(filePath, `${JSON.stringify({
      type: 'session_info', id: 'info-1', parentId: 'assistant-1',
      timestamp: '2026-01-01T00:00:03.000Z', name: 'Indexed catalog',
    })}\n${JSON.stringify(message(
      'user-2', 'user', 'Verify append checkpoints', '2026-01-01T00:00:04.000Z',
    ))}\n`, 'utf8');
    const appendedFingerprint = await statBackendSessionFile(filePath);
    assert.ok(appendedFingerprint);
    const appended = await readIndexedSessionMetadata(appendedFingerprint, firstResult.metadata);
    assert.equal(appended.status, 'ok');
    assert.equal(appended.resumedAppend, true, 'an append reads only bytes after the durable checkpoint');
    assert.equal(appended.metadata.summary.messageCount, 3);
    assert.equal(appended.metadata.summary.name, 'Indexed catalog');

    await writeJsonl(filePath, [
      header(root, 'session-a', '2026-02-01T00:00:00.000Z'),
      message('replacement', 'user', 'Rewrite this transcript', '2026-02-01T00:00:01.000Z'),
    ]);
    const rewrittenFingerprint = await statBackendSessionFile(filePath);
    assert.ok(rewrittenFingerprint);
    const rewritten = await readIndexedSessionMetadata(rewrittenFingerprint, appended.metadata);
    assert.equal(rewritten.status, 'ok');
    assert.equal(rewritten.resumedAppend, false, 'truncate/rewrite cannot reuse an append checkpoint');
    assert.equal(rewritten.metadata.summary.messageCount, 1);
    assert.notEqual(rewritten.metadata.summary.name, 'Indexed catalog');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('indexed metadata joins Pi text blocks with spaces when deriving a session name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-text-blocks-'));
  try {
    const filePath = path.join(root, 'session.jsonl');
    const joinedText = 'First metadata block Second metadata block';
    await writeJsonl(filePath, [
      header(root, 'session-text-blocks'),
      message('user', 'user', [
        { type: 'text', text: 'First metadata block' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'Second metadata block' },
      ], '2026-01-01T00:00:01.000Z'),
    ]);

    const metadata = await readMetadata(filePath);
    assert.equal(metadata.summary.name, deriveSessionNameFromText(joinedText).name);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite session index persists summaries and rebuilds malformed rows and schema mismatches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-store-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'session-store'), message(
      'user', 'user', 'Persist this catalog', '2026-01-01T00:00:01.000Z',
    )]);
    const metadata = await readMetadata(filePath);
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const authority = path.resolve(sessionDir);

    const first = new SessionIndexStore(indexPath, authority);
    assert.equal(first.upsertBatch([metadata]), true);
    assert.equal(new SessionIndexStore(indexPath, authority).readAll().length, 1);

    const malformed = new sqlite.DatabaseSync(indexPath);
    malformed.exec("UPDATE sessions SET checkpoint_json = '{}'");
    malformed.close();
    assert.deepEqual(
      new SessionIndexStore(indexPath, authority).readAll(),
      [],
      'a malformed durable checkpoint rebuilds instead of reaching the append reader',
    );

    const mismatched = new sqlite.DatabaseSync(indexPath);
    mismatched.exec('PRAGMA user_version = 99');
    mismatched.close();
    assert.deepEqual(
      new SessionIndexStore(indexPath, authority).readAll(),
      [],
      'a schema mismatch safely recreates the versioned derived sidecar',
    );

    await fs.writeFile(indexPath, 'not a sqlite database', 'utf8');
    assert.deepEqual(
      new SessionIndexStore(indexPath, authority).readAll(),
      [],
      'database corruption is discarded and rebuilt',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite read-only startup completes a partial schema without destructive recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-partial-schema-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const partial = new sqlite.DatabaseSync(indexPath);
    partial.exec(`
      CREATE TABLE initializer_sentinel (value TEXT NOT NULL);
      INSERT INTO initializer_sentinel (value) VALUES ('retained');
      PRAGMA user_version = 1;
    `);
    partial.close();

    assert.deepEqual(new SessionIndexStore(indexPath, path.resolve(sessionDir)).readAll(), []);
    const verified = new sqlite.DatabaseSync(indexPath);
    const sentinel = verified.prepare('SELECT value FROM initializer_sentinel').get() as { value?: string };
    verified.close();
    assert.equal(sentinel.value, 'retained', 'schema readiness must not unlink the initializing sidecar');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite session index rebuilds a malformed shared mutation generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-generation-corrupt-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'generation-corrupt'), message(
      'user', 'user', 'Rebuild malformed generation', '2026-01-01T00:00:01.000Z',
    )]);
    const metadata = await readMetadata(filePath);
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const authority = path.resolve(sessionDir);
    new SessionIndexStore(indexPath, authority).upsertBatch([metadata]);

    const malformed = new sqlite.DatabaseSync(indexPath);
    malformed.exec("UPDATE catalog_metadata SET value = 'not-an-integer' WHERE key = 'catalog_mutation_generation'");
    malformed.close();

    const recovered = new SessionIndexStore(indexPath, authority);
    assert.deepEqual(recovered.readAll(), []);
    assert.equal(recovered.readMutationGeneration(), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite session index scrubs forgotten summary text from the database and WAL', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-privacy-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'privacy'), message(
      'user', 'user', 'Ordinary derived name', '2026-01-01T00:00:01.000Z',
    )]);
    const metadata = await readMetadata(filePath);
    const privateText = 'PRIVATE-FORGOTTEN-SUMMARY-5a732f15';
    metadata.summary.name = privateText;
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const store = new SessionIndexStore(indexPath, path.resolve(sessionDir));
    store.upsertBatch([metadata]);
    assert.match(await readExistingSidecarText(indexPath), new RegExp(privateText));

    assert.equal(store.deletePaths([metadata.fingerprint.pathKey]), true);
    assert.doesNotMatch(
      await readExistingSidecarText(indexPath),
      new RegExp(privateText),
      'secure_delete plus a truncate checkpoint removes old projection bytes',
    );
    assert.deepEqual(new SessionIndexStore(indexPath, path.resolve(sessionDir)).readAll(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('shared mutation generation makes a cross-process delete win over stale catalog upserts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-delete-fence-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const privatePath = path.join(sessionDir, 'private.jsonl');
    const safePath = path.join(sessionDir, 'safe.jsonl');
    await Promise.all([
      writeJsonl(privatePath, [header(root, 'private'), message(
        'private-user', 'user', 'Private stale parser payload', '2026-01-01T00:00:01.000Z',
      )]),
      writeJsonl(safePath, [header(root, 'safe'), message(
        'safe-user', 'user', 'Safe current parser payload', '2026-01-02T00:00:01.000Z',
      )]),
    ]);
    const privateMetadata = await readMetadata(privatePath);
    const safeMetadata = await readMetadata(safePath);
    const privateText = 'PRIVATE-CROSS-PROCESS-SUMMARY-f72d160a';
    privateMetadata.summary.name = privateText;

    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const authority = path.resolve(sessionDir);
    const parserStore = new SessionIndexStore(indexPath, authority);
    const forgetStore = new SessionIndexStore(indexPath, authority);

    const seedGeneration = parserStore.readMutationGeneration();
    assert.equal(
      parserStore.upsertBatch([privateMetadata], seedGeneration),
      true,
      'an unchanged generation permits an ordinary reconciler upsert',
    );
    const staleGeneration = parserStore.readMutationGeneration();
    assert.equal(forgetStore.deletePaths([privateMetadata.fingerprint.pathKey]), true);
    assert.throws(
      () => parserStore.upsertBatch([privateMetadata], staleGeneration),
      (error) => error instanceof StaleSessionIndexMutationGenerationError
        && error.expectedGeneration === staleGeneration
        && error.actualGeneration > staleGeneration,
      'a parser that started before the other backend delete cannot resurrect its row',
    );
    assert.deepEqual(parserStore.readAll(), []);
    assert.doesNotMatch(await readExistingSidecarText(indexPath), new RegExp(privateText));

    const absentDeleteGeneration = parserStore.readMutationGeneration();
    assert.equal(
      forgetStore.deletePaths([safeMetadata.fingerprint.pathKey]),
      false,
      'logical forgets still advance the fence before a first row exists',
    );
    assert.throws(
      () => parserStore.upsertBatch([safeMetadata], absentDeleteGeneration),
      StaleSessionIndexMutationGenerationError,
    );

    const currentGeneration = parserStore.readMutationGeneration();
    assert.equal(parserStore.upsertBatch([safeMetadata], currentGeneration), true);
    assert.deepEqual(
      parserStore.readAll().map((record) => record.summary.path),
      [safePath],
      'a parser captured after the delete fence continues to update normally',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconciliation transaction rejects a source appended after metadata parsing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-source-fence-'));
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'source-fence'), message(
      'user', 'user', 'Parsed before append', '2026-01-01T00:00:01.000Z',
    )]);
    const staleMetadata = await readMetadata(filePath);
    const privateText = 'PRIVATE-STALE-APPEND-SUMMARY-094677e2';
    staleMetadata.summary.name = privateText;
    const store = new SessionIndexStore(
      resolveSessionIndexPath(root, sessionDir),
      path.resolve(sessionDir),
    );
    const generation = store.readMutationGeneration();

    await fs.appendFile(filePath, `${JSON.stringify(message(
      'assistant', 'assistant', 'Appended after parse', '2026-01-01T00:00:02.000Z',
    ))}\n`, 'utf8');

    assert.throws(
      () => store.commitReconciliationBatch([staleMetadata], [], generation),
      StaleSessionIndexSourceError,
    );
    assert.deepEqual(store.readAll(), []);
    assert.doesNotMatch(
      await readExistingSidecarText(store.indexPath),
      new RegExp(privateText),
      'a stat mismatch rolls back the stale summary bytes with the whole batch',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('multi-batch reconciliation advances only across its own checked invalid-row delete', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-invalid-generation-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const invalidPath = path.join(sessionDir, 'invalid.jsonl');
    const validPath = path.join(sessionDir, 'valid.jsonl');
    await Promise.all([
      writeJsonl(invalidPath, [header(root, 'invalid'), message(
        'invalid-user', 'user', 'Invalid newest row', '2026-01-02T00:00:01.000Z',
      )]),
      writeJsonl(validPath, [header(root, 'valid'), message(
        'valid-user', 'user', 'Valid later row', '2026-01-01T00:00:01.000Z',
      )]),
    ]);
    const invalid = await readMetadata(invalidPath);
    const valid = await readMetadata(validPath);
    invalid.fingerprint = {
      ...invalid.fingerprint,
      sizeBytes: 17 * 1024 * 1024,
      modifiedNs: '2',
    };
    valid.fingerprint = { ...valid.fingerprint, modifiedNs: '1' };
    const catalog = new SessionCatalog({
      createIndexStore: createSyntheticFingerprintIndexStore,
      readInventory: async () => [invalid.fingerprint, valid.fingerprint],
      readIndexedMetadata: async (file) => file.pathKey === invalid.fingerprint.pathKey
        ? { status: 'invalid' }
        : { status: 'ok', metadata: valid, resumedAppend: false },
    });

    assert.deepEqual(
      (await catalog.list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [validPath],
      'the invalid first batch advances its own generation without self-staling the next batch',
    );
    assert.deepEqual(catalog.getProgress(), { complete: true, processed: 2, total: 2 });
    assert.deepEqual(
      new SessionIndexStore(
        resolveSessionIndexPath(agentDir, sessionDir),
        backendSessionPathKey(sessionDir),
      ).readAll().map((record) => record.summary.path),
      [validPath],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an invalid fingerprint is retried until its durable delete commits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-invalid-retry-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const filePath = path.join(sessionDir, 'invalid-after-index.jsonl');
    await writeJsonl(filePath, [header(root, 'invalid-after-index'), message(
      'user', 'user', 'This stale summary must be removed', '2026-01-01T00:00:01.000Z',
    )]);
    const indexed = await readMetadata(filePath);
    const changedFingerprint = {
      ...indexed.fingerprint,
      modifiedNs: `${BigInt(indexed.fingerprint.modifiedNs) + 1n}`,
    };
    const indexPath = resolveSessionIndexPath(agentDir, sessionDir);
    const authority = backendSessionPathKey(sessionDir);
    const seedStore = createSyntheticFingerprintIndexStore(indexPath, authority);
    seedStore.upsertBatch([indexed]);
    seedStore.close();

    let commitAttempts = 0;
    let metadataReads = 0;
    const catalog = new SessionCatalog({
      createIndexStore: (location, authorityKey) => {
        const store = createSyntheticFingerprintIndexStore(location, authorityKey);
        const commit = store.commitReconciliationBatch.bind(store);
        store.commitReconciliationBatch = (...args) => {
          commitAttempts += 1;
          if (commitAttempts === 1) throw new Error('injected reconciliation commit failure');
          return commit(...args);
        };
        return store;
      },
      readInventory: async () => [changedFingerprint],
      readIndexedMetadata: async () => {
        metadataReads += 1;
        return { status: 'invalid' };
      },
    });

    assert.deepEqual(
      (await catalog.list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [filePath],
      'a failed delete commit keeps the last complete projection visible',
    );
    assert.deepEqual(catalog.getProgress(), { complete: false, processed: 0, total: 1 });

    assert.deepEqual(
      (await catalog.list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [],
      'the unchanged invalid fingerprint is retried and removed after commit succeeds',
    );
    assert.equal(metadataReads, 2);
    assert.equal(commitAttempts, 2);
    assert.deepEqual(catalog.getProgress(), { complete: true, processed: 1, total: 1 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('queued inventory scanned before another backend forget cannot publish after that delete', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-queued-delete-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const blockingPath = path.join(sessionDir, 'blocking.jsonl');
    const forgottenPath = path.join(sessionDir, 'forgotten.jsonl');
    await Promise.all([
      writeJsonl(blockingPath, [header(root, 'blocking'), message(
        'blocking-user', 'user', 'Finish the active inventory first', '2026-01-01T00:00:01.000Z',
      )]),
      writeJsonl(forgottenPath, [header(root, 'forgotten'), message(
        'forgotten-user', 'user', 'Never publish this queued inventory', '2026-01-02T00:00:01.000Z',
      )]),
    ]);
    const blocking = await readMetadata(blockingPath);
    const forgotten = await readMetadata(forgottenPath);
    const privateText = 'PRIVATE-QUEUED-INVENTORY-SUMMARY-43db788c';
    forgotten.summary.name = privateText;
    const indexPath = resolveSessionIndexPath(agentDir, sessionDir);
    const authority = backendSessionPathKey(sessionDir);
    const forgetStore = new SessionIndexStore(indexPath, authority);

    let inventoryReads = 0;
    let resolveBlockingRead!: () => void;
    const blockingReadGate = new Promise<void>((resolve) => { resolveBlockingRead = resolve; });
    let resolveBlockingStarted!: () => void;
    const blockingStarted = new Promise<void>((resolve) => { resolveBlockingStarted = resolve; });
    let resolveQueuedScan!: () => void;
    const queuedScan = new Promise<void>((resolve) => { resolveQueuedScan = resolve; });
    let resolveForgottenProjection!: () => void;
    const forgottenProjection = new Promise<void>((resolve) => { resolveForgottenProjection = resolve; });
    let forgetCommitted = false;
    const catalog = new SessionCatalog({
      onCatalogChanged: () => {
        if (forgetCommitted) return;
        // This callback is queued by the first batch before the reconciliation
        // loop can consume its already-scanned second inventory.
        fsSync.rmSync(forgottenPath);
        forgetStore.deletePaths([forgotten.fingerprint.pathKey]);
        forgetCommitted = true;
      },
      readInventory: async () => {
        inventoryReads += 1;
        if (inventoryReads === 1) return [blocking.fingerprint];
        if (inventoryReads === 2) {
          resolveQueuedScan();
          return [forgotten.fingerprint];
        }
        return [blocking.fingerprint];
      },
      readIndexedMetadata: async (file) => {
        if (file.pathKey === blocking.fingerprint.pathKey) {
          resolveBlockingStarted();
          await blockingReadGate;
          return { status: 'ok', metadata: blocking, resumedAppend: false };
        }
        resolveForgottenProjection();
        return { status: 'ok', metadata: forgotten, resumedAppend: false };
      },
    });

    const firstListing = catalog.list(unusedSdk, sessionDir, [], agentDir);
    await blockingStarted;
    const queuedListing = catalog.invalidateIfInventoryChanged(agentDir, sessionDir);
    await queuedScan;
    resolveBlockingRead();
    await forgottenProjection;
    await Promise.all([firstListing, queuedListing]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(forgetCommitted, true);
    assert.deepEqual(
      new SessionIndexStore(indexPath, authority).readAll().map((record) => record.summary.path),
      [blockingPath],
    );
    assert.doesNotMatch(await readExistingSidecarText(indexPath), new RegExp(privateText));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('read-only restart retries a committed privacy checkpoint after an older WAL reader closes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-privacy-restart-'));
  let blocker: InstanceType<(typeof sqlite)['DatabaseSync']> | undefined;
  let restartedStore: SessionIndexStore | undefined;
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'privacy-restart'), message(
      'user', 'user', 'Restart privacy checkpoint', '2026-01-01T00:00:01.000Z',
    )]);
    const metadata = await readMetadata(filePath);
    const privateText = 'PRIVATE-WAL-RESTART-SUMMARY-b138c2e7';
    metadata.summary.name = privateText;
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const authority = path.resolve(sessionDir);
    const store = new SessionIndexStore(indexPath, authority);
    store.upsertBatch([metadata]);

    blocker = new sqlite.DatabaseSync(indexPath);
    blocker.exec('PRAGMA journal_mode = WAL');
    blocker.exec('BEGIN');
    blocker.prepare('SELECT path_key FROM sessions').get();

    assert.throws(
      () => store.deletePaths([metadata.fingerprint.pathKey]),
      isSessionIndexBusyError,
      'the logical delete commits even when the older reader blocks WAL truncation',
    );
    restartedStore = new SessionIndexStore(indexPath, authority);
    assert.deepEqual(
      restartedStore.readAll(),
      [],
      'a busy cleanup never routes the valid logical snapshot through SDK fallback',
    );
    const pending = new sqlite.DatabaseSync(indexPath);
    assert.equal(
      (pending.prepare("SELECT value FROM catalog_metadata WHERE key = 'privacy_checkpoint_pending'")
        .get() as { value?: string } | undefined)?.value,
      '1',
    );
    pending.close();
    const retryTimer = (restartedStore as any).privacyCheckpointRetryTimer as NodeJS.Timeout | undefined;
    assert.ok(retryTimer, 'a busy restart cleanup arms an autonomous retry');
    assert.equal(retryTimer.hasRef(), false, 'privacy cleanup cannot keep the backend process alive');
    assert.deepEqual(restartedStore.readAll(), []);
    assert.equal(
      (restartedStore as any).privacyCheckpointRetryTimer,
      retryTimer,
      'repeated catalog reads share the existing retry timer',
    );
    const closingStore = new SessionIndexStore(indexPath, authority);
    assert.deepEqual(closingStore.readAll(), []);
    assert.ok((closingStore as any).privacyCheckpointRetryTimer);
    closingStore.close();
    assert.equal(
      (closingStore as any).privacyCheckpointRetryTimer,
      undefined,
      'closing a superseded catalog store cancels its privacy retry',
    );

    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = undefined;
    let pendingValue: string | undefined;
    const deadline = Date.now() + 5_000;
    do {
      const scrubbed = new sqlite.DatabaseSync(indexPath);
      pendingValue = (scrubbed.prepare(
        "SELECT value FROM catalog_metadata WHERE key = 'privacy_checkpoint_pending'",
      ).get() as { value?: string } | undefined)?.value;
      scrubbed.close();
      if (pendingValue === '0') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(pendingValue, '0', 'the unref retry clears the marker without another list or restart');
    assert.equal((restartedStore as any).privacyCheckpointRetryTimer, undefined);
    assert.doesNotMatch(await readExistingSidecarText(indexPath), new RegExp(privateText));
  } finally {
    restartedStore?.close();
    try { blocker?.exec('ROLLBACK'); } catch { /* best effort */ }
    try { blocker?.close(); } catch { /* best effort */ }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SQLite session index serves a warm snapshot while a competing writer is active and bounds writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-busy-'));
  let blocker: InstanceType<(typeof sqlite)['DatabaseSync']> | undefined;
  try {
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'busy'), message(
      'user', 'user', 'Bound lock waits', '2026-01-01T00:00:01.000Z',
    )]);
    const metadata = await readMetadata(filePath);
    const indexPath = resolveSessionIndexPath(root, sessionDir);
    const authority = path.resolve(sessionDir);
    const store = new SessionIndexStore(indexPath, authority);
    store.upsertBatch([metadata]);

    blocker = new sqlite.DatabaseSync(indexPath);
    blocker.exec('PRAGMA journal_mode = WAL');
    blocker.exec('BEGIN IMMEDIATE');

    const readStartedAt = performance.now();
    const warmSnapshot = new SessionIndexStore(indexPath, authority).readAll();
    assert.equal(warmSnapshot.length, 1);
    assert.equal(warmSnapshot[0]?.summary.path, filePath);
    assert.ok(
      performance.now() - readStartedAt < 750,
      'a read-only WAL snapshot must not wait behind the competing writer',
    );

    const startedAt = performance.now();
    assert.throws(
      () => store.deletePaths([metadata.fingerprint.pathKey]),
      isSessionIndexBusyError,
    );
    assert.ok(
      performance.now() - startedAt < 750,
      'a synchronous index operation must not inherit the former five-second busy wait',
    );

    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = undefined;
    assert.equal(store.deletePaths([metadata.fingerprint.pathKey]), true);
  } finally {
    try { blocker?.exec('ROLLBACK'); } catch { /* best effort */ }
    try { blocker?.close(); } catch { /* best effort */ }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionCatalog serves a durable snapshot immediately and reconciles only the appended file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-catalog-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const firstPath = path.join(sessionDir, 'first.jsonl');
    const secondPath = path.join(sessionDir, 'second.jsonl');
    await Promise.all([
      writeJsonl(firstPath, [header(root, 'first'), message(
        'first-user', 'user', 'Build first session', '2026-01-01T00:00:01.000Z',
      )]),
      writeJsonl(secondPath, [header(root, 'second'), message(
        'second-user', 'user', 'Build second session', '2026-01-02T00:00:01.000Z',
      )]),
    ]);

    const bootstrap = new SessionCatalog();
    assert.equal((await bootstrap.list(unusedSdk, sessionDir, [], agentDir)).length, 2);

    const reads: Array<{ path: string; resumed: boolean }> = [];
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => { resolveChanged = resolve; });
    let resolveWarmInventory!: () => void;
    const warmInventory = new Promise<void>((resolve) => { resolveWarmInventory = resolve; });
    const warm = new SessionCatalog({
      onCatalogChanged: () => {
        if (warm.getProgress().complete) resolveWarmInventory();
        if (reads.length > 0) resolveChanged();
      },
      readIndexedMetadata: async (file, previous) => {
        const result = await readIndexedSessionMetadata(file, previous);
        if (result.status === 'ok') reads.push({ path: file.path, resumed: result.resumedAppend });
        return result;
      },
    });

    assert.equal((await warm.list(unusedSdk, sessionDir, [], agentDir)).length, 2);
    assert.deepEqual(reads, [], 'a valid snapshot does not await or repeat transcript parsing');
    await warmInventory;

    await fs.appendFile(firstPath, `${JSON.stringify(message(
      'first-assistant', 'assistant', 'Appended', '2026-01-03T00:00:01.000Z',
    ))}\n`, 'utf8');
    assert.equal(
      await warm.invalidateIfInventoryChanged(agentDir, sessionDir),
      false,
      'the stale-but-valid row remains usable while low-priority reconcile runs',
    );
    await changed;
    assert.deepEqual(reads, [{ path: firstPath, resumed: true }]);
    const refreshed = await warm.list(unusedSdk, sessionDir, [], agentDir);
    assert.equal(refreshed.find((summary) => summary.path === firstPath)?.messageCount, 2);

    await fs.rm(secondPath);
    warm.remove(secondPath);
    assert.equal((await warm.list(unusedSdk, sessionDir, [], agentDir)).length, 1);
    assert.equal(
      (await new SessionCatalog().list(unusedSdk, sessionDir, [], agentDir)).length,
      1,
      'a forgotten transcript cannot reappear from the durable sidecar after restart',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('forget tombstones cannot be reinserted by a metadata batch already in flight', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-forget-race-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const forgottenPath = path.join(sessionDir, 'forgotten.jsonl');
    const blockingPath = path.join(sessionDir, 'blocking.jsonl');
    await Promise.all([
      writeJsonl(forgottenPath, [header(root, 'forgotten'), message(
        'forgotten-user', 'user', 'Forget this buffered session', '2026-01-02T00:00:01.000Z',
      )]),
      writeJsonl(blockingPath, [header(root, 'blocking'), message(
        'blocking-user', 'user', 'Hold this metadata batch open', '2026-01-01T00:00:01.000Z',
      )]),
    ]);
    const forgotten = await readMetadata(forgottenPath);
    const blocking = await readMetadata(blockingPath);
    const privateText = 'PRIVATE-BUFFERED-FORGET-SUMMARY-0b45c37f';
    forgotten.summary.name = privateText;
    forgotten.fingerprint = { ...forgotten.fingerprint, modifiedNs: '2' };
    blocking.fingerprint = { ...blocking.fingerprint, modifiedNs: '1' };
    const byPath = new Map([
      [forgotten.fingerprint.pathKey, forgotten],
      [blocking.fingerprint.pathKey, blocking],
    ]);

    let releaseBlockingRead!: () => void;
    const blockingReadGate = new Promise<void>((resolve) => { releaseBlockingRead = resolve; });
    let resolveBlockingReadStarted!: () => void;
    const blockingReadStarted = new Promise<void>((resolve) => { resolveBlockingReadStarted = resolve; });
    const catalog = new SessionCatalog({
      createIndexStore: createSyntheticFingerprintIndexStore,
      readInventory: async () => [forgotten.fingerprint, blocking.fingerprint],
      readIndexedMetadata: async (file) => {
        if (file.pathKey === blocking.fingerprint.pathKey) {
          resolveBlockingReadStarted();
          await blockingReadGate;
        }
        return { status: 'ok', metadata: byPath.get(file.pathKey)!, resumedAppend: false };
      },
    });

    const listing = catalog.list(unusedSdk, sessionDir, [], agentDir);
    await blockingReadStarted;
    await fs.rm(forgottenPath);
    catalog.remove(forgottenPath);
    releaseBlockingRead();

    assert.deepEqual((await listing).map((summary) => summary.path), [blockingPath]);
    const indexPath = resolveSessionIndexPath(agentDir, sessionDir);
    assert.deepEqual(
      new SessionIndexStore(indexPath, backendSessionPathKey(sessionDir))
        .readAll()
        .map((record) => record.summary.path),
      [blockingPath],
      'a buffered pre-forget projection must not be committed after the tombstone',
    );
    assert.doesNotMatch(
      await readExistingSidecarText(indexPath),
      new RegExp(privateText),
      'the forgotten summary must not be resurrected in SQLite or its WAL',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a nonempty durable catalog returns before the background inventory walk settles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-warm-immediate-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const filePath = path.join(sessionDir, 'warm.jsonl');
    await writeJsonl(filePath, [header(root, 'warm'), message(
      'warm-user', 'user', 'Project the durable row first', '2026-01-01T00:00:01.000Z',
    )]);

    const bootstrap = new SessionCatalog();
    assert.equal((await bootstrap.list(unusedSdk, sessionDir, [], agentDir)).length, 1);

    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>((resolve) => { releaseInventory = resolve; });
    let resolveInventoryStarted!: () => void;
    const inventoryStarted = new Promise<void>((resolve) => { resolveInventoryStarted = resolve; });
    let resolveComplete!: () => void;
    const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
    const warm = new SessionCatalog({
      onCatalogChanged: () => {
        if (warm.getProgress().complete) resolveComplete();
      },
      readInventory: async (nextAgentDir, nextSessionDir) => {
        resolveInventoryStarted();
        await inventoryGate;
        return await readBackendSessionInventory(nextAgentDir, nextSessionDir);
      },
    });

    let settled = false;
    const listing = warm.list(unusedSdk, sessionDir, [], agentDir).finally(() => { settled = true; });
    await inventoryStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'the durable rows do not wait behind the directory stat walk');
    assert.equal((await listing)[0]?.path, filePath);
    assert.deepEqual(warm.getProgress(), { complete: false, processed: 1 });

    releaseInventory();
    await complete;
    assert.deepEqual(warm.getProgress(), { complete: true, processed: 1, total: 1 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('filename publication barrier removes externally deleted rows in a current context and after restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-filename-privacy-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const retainedPath = path.join(sessionDir, 'retained.jsonl');
    const deletedPath = path.join(sessionDir, 'deleted.jsonl');
    await Promise.all([
      writeJsonl(retainedPath, [header(root, 'retained'), message(
        'retained-user', 'user', 'Keep this session', '2026-01-01T00:00:01.000Z',
      )]),
      writeJsonl(deletedPath, [header(root, 'deleted'), message(
        'deleted-user', 'user', 'Forget this private session', '2026-01-02T00:00:01.000Z',
      )]),
    ]);

    const bootstrap = new SessionCatalog();
    assert.equal((await bootstrap.list(unusedSdk, sessionDir, [], agentDir)).length, 2);

    let resolveComplete!: () => void;
    const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
    const warm = new SessionCatalog({
      onCatalogChanged: () => {
        if (warm.getProgress().complete) resolveComplete();
      },
    });
    assert.equal((await warm.list(unusedSdk, sessionDir, [], agentDir)).length, 2);
    await complete;

    await fs.rm(deletedPath);
    assert.deepEqual(
      (await warm.list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [retainedPath],
      'the next publication in an existing backend filters the absent transcript',
    );
    assert.deepEqual(
      (await new SessionCatalog().list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [retainedPath],
      'a new backend filters and durably deletes the stale sidecar row before publication',
    );
    assert.equal(
      new SessionIndexStore(
        resolveSessionIndexPath(agentDir, sessionDir),
        backendSessionPathKey(sessionDir),
      ).readAll().length,
      1,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('filename publication barrier coalesces concurrent scans and retains a snapshot when the root is inaccessible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-filename-coalesce-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'coalesce'), message(
      'user', 'user', 'Keep the warm snapshot responsive', '2026-01-01T00:00:01.000Z',
    )]);
    assert.equal((await new SessionCatalog().list(unusedSdk, sessionDir, [], agentDir)).length, 1);

    let scans = 0;
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let resolveScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { resolveScanStarted = resolve; });
    let resolveComplete!: () => void;
    const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
    const warm = new SessionCatalog({
      usePersistentIndex: true,
      onCatalogChanged: () => {
        if (warm.getProgress().complete) resolveComplete();
      },
      readInventorySignature: async (nextAgentDir, nextSessionDir) => {
        scans += 1;
        resolveScanStarted();
        await scanGate;
        return await readBackendSessionInventorySignature(nextAgentDir, nextSessionDir);
      },
    });
    const first = warm.list(unusedSdk, sessionDir, [], agentDir);
    const concurrent = warm.list(unusedSdk, sessionDir, [], agentDir);
    await scanStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans, 1, 'concurrent list callers share one filename-only directory scan');
    releaseScan();
    assert.equal((await first).length, 1);
    assert.equal((await concurrent).length, 1);
    await complete;

    const inaccessible = Object.assign(new Error('session root unavailable'), { code: 'EACCES' });
    const retaining = new SessionCatalog({
      usePersistentIndex: true,
      readInventorySignature: async () => await Promise.reject(inaccessible),
      readInventory: async () => await Promise.reject(inaccessible),
    });
    assert.equal(
      (await retaining.list(unusedSdk, sessionDir, [], agentDir))[0]?.path,
      filePath,
      'an inaccessible root is not mistaken for an empty/deleted store',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionCatalog isolates a transient newest-file failure and still indexes older sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-file-boundary-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const olderPath = path.join(sessionDir, 'older.jsonl');
    const newestPath = path.join(sessionDir, 'newest.jsonl');
    await Promise.all([
      writeJsonl(olderPath, [header(root, 'older'), message(
        'older-user', 'user', 'Older valid session', '2026-01-01T00:00:01.000Z',
      )]),
      writeJsonl(newestPath, [header(root, 'newest'), message(
        'newest-user', 'user', 'Newest temporarily unreadable session', '2026-01-02T00:00:01.000Z',
      )]),
    ]);
    const older = await readMetadata(olderPath);
    const newest = await readMetadata(newestPath);
    older.fingerprint = { ...older.fingerprint, modifiedNs: '1' };
    newest.fingerprint = { ...newest.fingerprint, modifiedNs: '2' };
    const reads: string[] = [];
    let failNewest = true;
    const catalog = new SessionCatalog({
      createIndexStore: createSyntheticFingerprintIndexStore,
      readInventory: async () => [older.fingerprint, newest.fingerprint],
      readIndexedMetadata: async (file) => {
        reads.push(file.path);
        if (file.path === newestPath && failNewest) {
          throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
        }
        return {
          status: 'ok',
          metadata: file.path === newestPath ? newest : older,
          resumedAppend: false,
        };
      },
    });

    assert.deepEqual(
      (await catalog.list(unusedSdk, sessionDir, [], agentDir)).map((summary) => summary.path),
      [olderPath],
    );
    assert.deepEqual(reads, [newestPath, olderPath], 'newest-first traversal continues after a local failure');

    failNewest = false;
    assert.equal((await catalog.list(unusedSdk, sessionDir, [], agentDir)).length, 2);
    assert.equal(reads.filter((filePath) => filePath === newestPath).length, 2, 'the missing row remains retryable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionCatalog retries a transient index-open failure after bounded backoff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-open-retry-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'retry'), message(
      'user', 'user', 'Recover the operational index', '2026-01-01T00:00:01.000Z',
    )]);
    let now = 0;
    let indexOpens = 0;
    let legacyScans = 0;
    let resolveRetryNotification!: () => void;
    const retryNotification = new Promise<void>((resolve) => { resolveRetryNotification = resolve; });
    const fallbackSdk = {
      SessionManager: {
        listAll: async () => {
          legacyScans += 1;
          return [{
            path: filePath,
            cwd: root,
            name: 'Legacy fallback',
            modified: new Date('2026-01-01T00:00:00.000Z'),
            messageCount: 1,
          }];
        },
      },
    } as unknown as SdkModule;
    const catalog = new SessionCatalog({
      nowMs: () => now,
      onCatalogChanged: resolveRetryNotification,
      createIndexStore: (indexPath, authorityKey) => {
        indexOpens += 1;
        if (indexOpens === 1) throw Object.assign(new Error('temporary lock'), { code: 'SQLITE_BUSY' });
        return new SessionIndexStore(indexPath, authorityKey);
      },
    });

    assert.deepEqual(await catalog.list(fallbackSdk, sessionDir, [], agentDir), []);
    assert.deepEqual(catalog.getProgress(), { complete: false, processed: 0 });
    assert.equal(legacyScans, 0, 'SQLITE_BUSY must never enter the full SDK directory scan');
    now = 249;
    assert.deepEqual(await catalog.list(fallbackSdk, sessionDir, [], agentDir), []);
    assert.equal(indexOpens, 1, 'calls inside the backoff window retain the bounded live-only result');

    now = 250;
    await retryNotification;
    const recovered = await catalog.list(fallbackSdk, sessionDir, [], agentDir);
    assert.equal(indexOpens, 2);
    assert.equal(legacyScans, 0);
    assert.equal(recovered[0]?.path, filePath);
    assert.notEqual(recovered[0]?.name, 'Legacy fallback');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionCatalog retains SDK compatibility fallback for a non-lock index failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-generic-fallback-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    let legacyScans = 0;
    const sdk = {
      SessionManager: {
        listAll: async () => {
          legacyScans += 1;
          return [];
        },
      },
    } as unknown as SdkModule;
    const catalog = new SessionCatalog({
      createIndexStore: () => {
        throw Object.assign(new Error('index directory is read-only'), { code: 'EACCES' });
      },
    });

    assert.deepEqual(await catalog.list(sdk, sessionDir, [], agentDir), []);
    assert.equal(legacyScans, 1);
    assert.deepEqual(catalog.getProgress(), { complete: true, processed: 0, total: 0 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('brand-new small catalog waits for its meaningful first batch but not unrelated backend work', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-background-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const filePath = path.join(sessionDir, 'session.jsonl');
    await writeJsonl(filePath, [header(root, 'background'), message(
      'user', 'user', 'Bootstrap without blocking RPCs', '2026-01-01T00:00:01.000Z',
    )]);

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => { resolveChanged = resolve; });
    const catalog = new SessionCatalog({
      onCatalogChanged: resolveChanged,
      readIndexedMetadata: async (file, previous) => {
        await readGate;
        return await readIndexedSessionMetadata(file, previous);
      },
    });

    let settled = false;
    const listing = catalog.list(unusedSdk, sessionDir, [], agentDir).finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the first caller waits for a meaningful batch rather than flashing empty');
    releaseRead();
    await changed;
    assert.equal((await listing).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('large bootstrap shares its 24-row count guard across callers and continues the remainder in background', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-progressive-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      const suffix = String(index).padStart(2, '0');
      await writeJsonl(path.join(sessionDir, `${suffix}.jsonl`), [
        header(root, `progressive-${suffix}`, `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
        message(`user-${suffix}`, 'user', `Build session ${suffix}`, `2026-02-01T00:00:${suffix}.000Z`),
      ]);
    }));

    let releaseRemainder!: () => void;
    const remainderGate = new Promise<void>((resolve) => { releaseRemainder = resolve; });
    let reads = 0;
    let notifications = 0;
    let resolveFirstNotification!: () => void;
    let resolveFinalNotification!: () => void;
    const firstNotification = new Promise<void>((resolve) => { resolveFirstNotification = resolve; });
    const finalNotification = new Promise<void>((resolve) => { resolveFinalNotification = resolve; });
    const catalog = new SessionCatalog({
      onCatalogChanged: () => {
        notifications += 1;
        if (notifications === 1) resolveFirstNotification();
        if (notifications === 2) resolveFinalNotification();
      },
      readIndexedMetadata: async (file, previous) => {
        reads += 1;
        if (reads > 24) await remainderGate;
        return await readIndexedSessionMetadata(file, previous);
      },
    });

    const first = catalog.list(unusedSdk, sessionDir, [], agentDir);
    const concurrent = catalog.list(unusedSdk, sessionDir, [], agentDir);
    await firstNotification;
    assert.equal((await first).length, 24);
    assert.equal((await concurrent).length, 24, 'concurrent first callers share the same bootstrap barrier');
    assert.equal(reads, 25, 'the remainder has started but cannot delay the first 24-row projection');
    assert.deepEqual(catalog.getProgress(), { complete: false, processed: 24, total: 33 });

    releaseRemainder();
    await finalNotification;
    assert.equal((await catalog.list(unusedSdk, sessionDir, [], agentDir)).length, 33);
    assert.deepEqual(catalog.getProgress(), { complete: true, processed: 33, total: 33 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bootstrap and background publication batches are capped by source bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-byte-budget-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    const records = await Promise.all(Array.from({ length: 15 }, async (_, index) => {
      const suffix = String(index).padStart(2, '0');
      const filePath = path.join(sessionDir, `${suffix}.jsonl`);
      await writeJsonl(filePath, [
        header(root, `byte-budget-${suffix}`),
        message(`user-${suffix}`, 'user', `Budget session ${suffix}`, '2026-01-01T00:00:01.000Z'),
      ]);
      const metadata = await readMetadata(filePath);
      const sizeBytes = 6 * 1024 * 1024;
      metadata.fingerprint = {
        ...metadata.fingerprint,
        sizeBytes,
        modifiedNs: String(100 - index),
      };
      metadata.checkpoint = { ...metadata.checkpoint, parsedBytes: sizeBytes };
      return metadata;
    }));
    const byPath = new Map(records.map((record) => [record.fingerprint.pathKey, record]));

    let releaseFirstRemainder!: () => void;
    const firstRemainderGate = new Promise<void>((resolve) => { releaseFirstRemainder = resolve; });
    let releaseSecondRemainder!: () => void;
    const secondRemainderGate = new Promise<void>((resolve) => { releaseSecondRemainder = resolve; });
    let reads = 0;
    let notifications = 0;
    let resolveFirstNotification!: () => void;
    let resolveSecondNotification!: () => void;
    let resolveFinalNotification!: () => void;
    const firstNotification = new Promise<void>((resolve) => { resolveFirstNotification = resolve; });
    const secondNotification = new Promise<void>((resolve) => { resolveSecondNotification = resolve; });
    const finalNotification = new Promise<void>((resolve) => { resolveFinalNotification = resolve; });
    const catalog = new SessionCatalog({
      createIndexStore: createSyntheticFingerprintIndexStore,
      onCatalogChanged: () => {
        notifications += 1;
        if (notifications === 1) resolveFirstNotification();
        if (notifications === 2) resolveSecondNotification();
        if (notifications === 3) resolveFinalNotification();
      },
      readInventory: async () => records.map((record) => record.fingerprint),
      readIndexedMetadata: async (file) => {
        reads += 1;
        if (reads === 3) await firstRemainderGate;
        if (reads === 13) await secondRemainderGate;
        return { status: 'ok', metadata: byPath.get(file.pathKey)!, resumedAppend: false };
      },
    });

    const listing = catalog.list(unusedSdk, sessionDir, [], agentDir);
    await firstNotification;
    assert.equal((await listing).length, 2, '16 MiB first budget admits two 6 MiB sessions');
    assert.equal(reads, 3, 'the next source starts only after the first projection is durable');
    assert.deepEqual(catalog.getProgress(), { complete: false, processed: 2, total: 15 });

    releaseFirstRemainder();
    await secondNotification;
    assert.equal(reads, 13);
    assert.deepEqual(
      catalog.getProgress(),
      { complete: false, processed: 12, total: 15 },
      '64 MiB background budget flushes ten more 6 MiB sessions before continuing',
    );

    releaseSecondRemainder();
    await finalNotification;
    assert.deepEqual(catalog.getProgress(), { complete: true, processed: 15, total: 15 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bootstrap readiness is bounded even when its newest 24 files are invalid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-index-invalid-batch-'));
  try {
    const agentDir = path.join(root, 'agent');
    const sessionDir = path.join(root, 'sessions');
    await Promise.all([fs.mkdir(agentDir), fs.mkdir(sessionDir)]);
    await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      await fs.writeFile(path.join(sessionDir, `${String(index).padStart(2, '0')}.jsonl`), '', 'utf8');
    }));

    let releaseRemainder!: () => void;
    const remainderGate = new Promise<void>((resolve) => { releaseRemainder = resolve; });
    let resolveRemainderStarted!: () => void;
    const remainderStarted = new Promise<void>((resolve) => { resolveRemainderStarted = resolve; });
    let reads = 0;
    const catalog = new SessionCatalog({
      onCatalogChanged: () => undefined,
      readIndexedMetadata: async () => {
        reads += 1;
        if (reads === 25) {
          resolveRemainderStarted();
          await remainderGate;
        }
        return { status: 'invalid' };
      },
    });

    const listing = catalog.list(unusedSdk, sessionDir, [], agentDir);
    await remainderStarted;
    assert.deepEqual(
      await listing,
      [],
      'a completed invalid first batch releases callers while the remaining history stays backgrounded',
    );
    releaseRemainder();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
