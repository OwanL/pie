import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { SessionSummary } from '../shared/protocol';
import { backendSessionPathKey, type BackendSessionFileFingerprint } from './session-directory';
import type { IndexedSessionMetadata, SessionMetadataCheckpoint } from './session-metadata';

const SESSION_INDEX_SCHEMA_VERSION = 1;
// Session list/open RPCs share the backend event loop with this synchronous
// operational index. Multi-process contention must yield quickly; catalog
// reconciliation retains its last complete projection and retries later.
const SESSION_INDEX_BUSY_TIMEOUT_MS = 75;
const PRIVACY_CHECKPOINT_KEY = 'privacy_checkpoint_pending';
const CATALOG_MUTATION_GENERATION_KEY = 'catalog_mutation_generation';
const PRIVACY_CHECKPOINT_RETRY_BASE_MS = 250;
const PRIVACY_CHECKPOINT_RETRY_MAX_MS = 2_000;
const PRIVACY_CHECKPOINT_RETRY_MAX_ATTEMPTS = 8;

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => SqliteDatabase;
}

const sqlite = createRequire(process.execPath)('node:sqlite') as SqliteModule;

interface StoredSessionRow {
  path_key: string;
  fingerprint_json: string;
  summary_json: string;
  checkpoint_json: string;
}

interface WalCheckpointRow {
  busy?: number | bigint;
}

interface ExistingSessionIndexSnapshot {
  records: IndexedSessionMetadata[];
  privacyCheckpointPending: boolean;
}

export interface SessionIndexStoreOptions {
  /** Focused synthetic-fingerprint test seam. Production uses an exact bigint
   * stat comparison at the reconciliation transaction boundary. */
  reconciliationSourceMatches?: (fingerprint: BackendSessionFileFingerprint) => boolean;
}

export interface SessionIndexMutationResult {
  changed: boolean;
  previousMutationGeneration: number;
  mutationGeneration: number;
}

function schemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS catalog_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      path_key TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      modified_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_modified_at_idx
      ON sessions(modified_at DESC);
  `;
}

function sqliteInteger(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

function sqliteBusyError(indexPath: string): Error {
  return Object.assign(
    new Error(`Session index privacy checkpoint is busy: ${indexPath}`),
    { code: 'SQLITE_BUSY' },
  );
}

export class StaleSessionIndexMutationGenerationError extends Error {
  readonly code = 'SESSION_INDEX_MUTATION_GENERATION_CHANGED';

  constructor(
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(
      `Session index mutation generation changed from ${expectedGeneration} to ${actualGeneration}.`,
    );
    this.name = 'StaleSessionIndexMutationGenerationError';
  }
}

export class StaleSessionIndexSourceError extends Error {
  readonly code = 'SESSION_INDEX_SOURCE_CHANGED';

  constructor(readonly sessionPath: string) {
    super(`Session index source changed before commit: ${sessionPath}`);
    this.name = 'StaleSessionIndexSourceError';
  }
}

/** `node:sqlite` reports lock contention as the generic `ERR_SQLITE_ERROR`
 * code plus SQLite's numeric errcode. Test seams and older/native wrappers use
 * the symbolic SQLite codes instead, so recognize every stable representation
 * without treating unrelated index failures as transient. */
export function isSessionIndexBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  const code = String(candidate.code ?? '');
  const errcode = Number(candidate.errcode);
  const detail = `${String(candidate.errstr ?? '')} ${String(candidate.message ?? '')}`.toLowerCase();
  return errcode === 5
    || errcode === 6
    || code === 'EBUSY'
    || code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code.startsWith('SQLITE_BUSY_')
    || code.startsWith('SQLITE_LOCKED_')
    || /\b(?:database|database table|session index)\b[^\n]*\b(?:busy|locked)\b/.test(detail);
}

function isSqliteContentFailure(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return code === 'SQLITE_CORRUPT'
    || code === 'SQLITE_NOTADB'
    || code === 'SQLITE_SCHEMA'
    || message.includes('database disk image is malformed')
    || message.includes('file is not a database')
    || message.startsWith('invalid session index mutation generation:');
}

function isSqliteSchemaNotReady(error: unknown): boolean {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; errcode?: unknown }
    : undefined;
  const code = String(candidate?.code ?? '');
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return Number(candidate?.errcode) === 17
    || code === 'SQLITE_SCHEMA'
    || code.startsWith('SQLITE_SCHEMA_')
    || message.includes('no such table');
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Partial<SessionSummary>;
  return typeof summary.path === 'string'
    && typeof summary.cwd === 'string'
    && typeof summary.name === 'string'
    && typeof summary.modifiedAt === 'string'
    && typeof summary.messageCount === 'number';
}

function isFingerprint(value: unknown): value is BackendSessionFileFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fingerprint = value as Partial<BackendSessionFileFingerprint>;
  return typeof fingerprint.path === 'string'
    && typeof fingerprint.pathKey === 'string'
    && typeof fingerprint.sizeBytes === 'number'
    && typeof fingerprint.modifiedNs === 'string'
    && typeof fingerprint.changedNs === 'string'
    && typeof fingerprint.device === 'string'
    && typeof fingerprint.inode === 'string';
}

function isCheckpoint(value: unknown): value is SessionMetadataCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<SessionMetadataCheckpoint>;
  const accumulator = checkpoint.accumulator as unknown;
  if (!accumulator || typeof accumulator !== 'object' || Array.isArray(accumulator)) return false;
  const state = accumulator as Record<string, unknown>;
  const validOptionalString = (field: string): boolean =>
    state[field] === undefined || typeof state[field] === 'string';
  const validOptionalNumber = (field: string): boolean =>
    state[field] === undefined || (typeof state[field] === 'number' && Number.isFinite(state[field]));
  return checkpoint.version === 1
    && typeof checkpoint.parsedBytes === 'number'
    && typeof checkpoint.endedWithNewline === 'boolean'
    && typeof checkpoint.firstWitnessHash === 'string'
    && typeof checkpoint.tailWitnessStart === 'number'
    && typeof checkpoint.tailWitnessHash === 'string'
    && typeof state.headerSeen === 'boolean'
    && typeof state.invalidRoot === 'boolean'
    && typeof state.cwd === 'string'
    && validOptionalString('headerTimestamp')
    && validOptionalString('sessionId')
    && (state.explicitName === null || typeof state.explicitName === 'string')
    && typeof state.derivedName === 'string'
    && typeof state.derivedIsPlaceholder === 'boolean'
    && typeof state.sawFirstUserText === 'boolean'
    && typeof state.messageCount === 'number'
    && Number.isInteger(state.messageCount)
    && state.messageCount >= 0
    && validOptionalNumber('lastActivityMs');
}

function parseStoredRow(row: StoredSessionRow): IndexedSessionMetadata {
  const fingerprint = JSON.parse(row.fingerprint_json) as unknown;
  const summary = JSON.parse(row.summary_json) as unknown;
  const checkpoint = JSON.parse(row.checkpoint_json) as unknown;
  if (!isFingerprint(fingerprint)
    || !isSessionSummary(summary)
    || !isCheckpoint(checkpoint)
    || fingerprint.pathKey !== row.path_key
    || backendSessionPathKey(summary.path) !== row.path_key) {
    throw new Error(`Invalid session index row: ${row.path_key}`);
  }
  return { fingerprint, summary, checkpoint };
}

function removeExactIndexFiles(indexPath: string): void {
  for (const filePath of [indexPath, `${indexPath}-wal`, `${indexPath}-shm`]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }
}

function reconciliationSourceMatches(
  fingerprint: BackendSessionFileFingerprint,
): boolean {
  try {
    const stat = fs.statSync(fingerprint.path, { bigint: true });
    return Number(stat.size) === fingerprint.sizeBytes
      && stat.mtimeNs.toString() === fingerprint.modifiedNs
      && stat.ctimeNs.toString() === fingerprint.changedNs
      && stat.dev.toString() === fingerprint.device
      && stat.ino.toString() === fingerprint.inode;
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export function resolveSessionIndexAuthority(
  agentDir: string,
  sessionDir: string | undefined,
): string {
  return path.resolve(sessionDir ?? path.join(agentDir, 'sessions'));
}

/** Keep differently configured roots in distinct sidecars even when they share
 * a parent directory. The schema version in the filename prevents old/new
 * backend processes from fighting over migrations. */
export function resolveSessionIndexPath(
  agentDir: string,
  sessionDir: string | undefined,
): string {
  const authority = backendSessionPathKey(resolveSessionIndexAuthority(agentDir, sessionDir));
  const authorityHash = createHash('sha256').update(authority).digest('hex').slice(0, 16);
  return path.join(
    path.dirname(resolveSessionIndexAuthority(agentDir, sessionDir)),
    `.pie-session-index-v${SESSION_INDEX_SCHEMA_VERSION}-${authorityHash}.sqlite`,
  );
}

export class SessionIndexStore {
  private activeDatabase?: SqliteDatabase;
  private privacyCheckpointRetryTimer?: ReturnType<typeof setTimeout>;
  private privacyCheckpointRetryAttempts = 0;
  private closed = false;

  constructor(
    readonly indexPath: string,
    private readonly authorityKey: string,
    private readonly options: SessionIndexStoreOptions = {},
  ) {}

  readAll(): IndexedSessionMetadata[] {
    try {
      const snapshot = this.readExistingSnapshot();
      if (snapshot) {
        // A logical delete can commit while an older WAL reader prevents the
        // physical scrub checkpoint. The read-only handle is closed by now, so
        // make one bounded cleanup attempt without sacrificing a valid catalog.
        if (snapshot.privacyCheckpointPending) this.tryFinalizePrivacyCheckpointAfterRead();
        return snapshot.records;
      }
      return this.withDatabase(() => this.withContentRecovery(() => {
          const rows = this.database.prepare(`
            SELECT path_key, fingerprint_json, summary_json, checkpoint_json
            FROM sessions
            ORDER BY modified_at DESC
          `).all() as StoredSessionRow[];
          return rows.map(parseStoredRow);
        }));
    } catch (error) {
      // SQL integrity can be sound while an individual JSON projection was
      // externally damaged. It is still derived data, so rebuild instead of
      // trusting a partial/malformed checkpoint on an append path.
      if (!isSqliteContentFailure(error)
        && !(error instanceof SyntaxError)
        && !(error instanceof Error && error.message.startsWith('Invalid session index row:'))) {
        throw error;
      }
      this.rebuildDatabase();
      return [];
    }
  }

  /** Capture the shared delete ordering fence without entering the writer
   * path. Background reconciliation holds this value while it parses JSONL;
   * its later upsert validates the same value inside BEGIN IMMEDIATE. */
  readMutationGeneration(): number {
    try {
      const existing = this.readExistingMutationGeneration();
      if (existing !== undefined) return existing;
      return this.withDatabase(() => this.withContentRecovery(
        () => this.readMutationGenerationValue(this.database),
      ));
    } catch (error) {
      if (!isSqliteContentFailure(error)) throw error;
      this.rebuildDatabase();
      return 0;
    }
  }

  /** Delete rows whose transcripts are no longer in the successfully-read
   * canonical inventory. This runs before background parsing, so forgotten or
   * externally removed sessions cannot reappear from a stale snapshot. */
  deleteAbsent(retainedPathKeys: ReadonlySet<string>): boolean {
    return this.withDatabase(() => this.withContentRecovery(() => {
      const changed = this.transaction(() => {
        const rows = this.database.prepare('SELECT path_key FROM sessions').all() as Array<{ path_key: string }>;
        const remove = this.database.prepare('DELETE FROM sessions WHERE path_key = ?');
        let removed = false;
        for (const row of rows) {
          if (retainedPathKeys.has(row.path_key)) continue;
          removed = sqliteInteger(remove.run(row.path_key).changes) > 0 || removed;
        }
        if (removed) {
          this.advanceMutationGeneration(this.database);
          this.markPrivacyCheckpointPending(this.database);
        }
        return removed;
      });
      this.finalizePrivacyCheckpoint(this.database);
      return changed;
    }));
  }

  deletePaths(pathKeys: readonly string[]): boolean {
    if (pathKeys.length === 0) return false;
    return this.deletePathsWithGeneration(pathKeys).changed;
  }

  /** Delete and return the exact transaction ordering transition. Supplying an
   * expected generation lets an active local reconciliation advance across
   * its own known tombstone without accidentally adopting another process's
   * intervening delete. */
  deletePathsWithGeneration(
    pathKeys: readonly string[],
    expectedMutationGeneration?: number,
  ): SessionIndexMutationResult {
    if (pathKeys.length === 0) {
      const generation = this.readMutationGeneration();
      if (expectedMutationGeneration !== undefined && generation !== expectedMutationGeneration) {
        throw new StaleSessionIndexMutationGenerationError(expectedMutationGeneration, generation);
      }
      return {
        changed: false,
        previousMutationGeneration: generation,
        mutationGeneration: generation,
      };
    }
    return this.withDatabase(() => this.withContentRecovery(() => {
      const result = this.transaction(() => {
        const previousMutationGeneration = this.assertMutationGeneration(
          this.database,
          expectedMutationGeneration,
        );
        const remove = this.database.prepare('DELETE FROM sessions WHERE path_key = ?');
        let removed = false;
        for (const pathKey of pathKeys) {
          removed = sqliteInteger(remove.run(pathKey).changes) > 0 || removed;
        }
        // A logical forget must fence a parser even when that parser has not
        // inserted its first row yet, so every nonempty delete intent advances
        // the shared generation rather than only deletes that matched a row.
        const mutationGeneration = this.advanceMutationGeneration(this.database);
        if (removed) this.markPrivacyCheckpointPending(this.database);
        return {
          changed: removed,
          previousMutationGeneration,
          mutationGeneration,
        };
      });
      // secure_delete scrubs the deleted cells in the new database pages; a
      // truncate checkpoint also removes older WAL frames that may still hold
      // the projection text. A durable marker makes a busy checkpoint retry on
      // the next connection (including after process restart).
      this.finalizePrivacyCheckpoint(this.database);
      return result;
    }));
  }

  upsertBatch(
    records: readonly IndexedSessionMetadata[],
    expectedMutationGeneration?: number,
  ): boolean {
    if (records.length === 0 && expectedMutationGeneration === undefined) return false;
    return this.withDatabase(() => this.withContentRecovery(() => this.transaction(() => {
      this.assertMutationGeneration(this.database, expectedMutationGeneration);
      return this.upsertRecords(this.database, records);
    })));
  }

  /** Atomically validate, upsert, and retire invalid rows for one progressive
   * reconciliation batch. Returning the generation produced by this batch's
   * own deletes lets later batches continue, while any external delete before
   * the transaction rejects the entire stale batch. */
  commitReconciliationBatch(
    records: readonly IndexedSessionMetadata[],
    invalidPathKeys: readonly string[],
    expectedMutationGeneration: number,
  ): SessionIndexMutationResult {
    return this.withDatabase(() => this.withContentRecovery(() => {
      const result = this.transaction(() => {
        const previousMutationGeneration = this.assertMutationGeneration(
          this.database,
          expectedMutationGeneration,
        );
        let changed = this.upsertRecords(this.database, records, true);
        let mutationGeneration = previousMutationGeneration;
        if (invalidPathKeys.length > 0) {
          const remove = this.database.prepare('DELETE FROM sessions WHERE path_key = ?');
          let removed = false;
          for (const pathKey of invalidPathKeys) {
            removed = sqliteInteger(remove.run(pathKey).changes) > 0 || removed;
          }
          mutationGeneration = this.advanceMutationGeneration(this.database);
          if (removed) this.markPrivacyCheckpointPending(this.database);
          changed = removed || changed;
        }
        return { changed, previousMutationGeneration, mutationGeneration };
      });
      this.finalizePrivacyCheckpoint(this.database);
      return result;
    }));
  }

  close(): void {
    this.closed = true;
    this.clearPrivacyCheckpointRetry();
    this.releaseDatabase();
  }

  private get database(): SqliteDatabase {
    this.activeDatabase ??= this.openWithRecovery();
    return this.activeDatabase;
  }

  private withDatabase<T>(operation: () => T): T {
    // Establish the connection before entering the try so open failures retain
    // their original stack. Every public operation releases it on Windows,
    // avoiding long-lived -shm handles while the in-memory projection remains
    // the hot path.
    void this.database;
    try {
      return operation();
    } finally {
      this.releaseDatabase();
    }
  }

  private releaseDatabase(): void {
    const database = this.activeDatabase;
    this.activeDatabase = undefined;
    if (database) database.close();
  }

  /** Read the last committed catalog snapshot without running any PRAGMA that
   * mutates connection/database state, schema DDL, integrity scan, checkpoint,
   * or metadata write. WAL readers can therefore start while another backend
   * owns the writer lock. `undefined` asks the writable path to initialize or
   * migrate an absent/incompatible sidecar. */
  private readExistingSnapshot(): ExistingSessionIndexSnapshot | undefined {
    if (!fs.existsSync(this.indexPath)) return undefined;
    const database = new sqlite.DatabaseSync(this.indexPath, {
      readOnly: true,
      timeout: SESSION_INDEX_BUSY_TIMEOUT_MS,
    });
    try {
      const versionRow = database.prepare('PRAGMA user_version').get() as {
        user_version?: number | bigint;
      } | undefined;
      if (sqliteInteger(versionRow?.user_version ?? 0) !== SESSION_INDEX_SCHEMA_VERSION) {
        return undefined;
      }
      const authority = database.prepare("SELECT value FROM catalog_metadata WHERE key = 'authority'")
        .get() as { value?: string } | undefined;
      if (authority?.value !== this.authorityKey) return undefined;
      this.readMutationGenerationValue(database);
      const rows = database.prepare(`
        SELECT path_key, fingerprint_json, summary_json, checkpoint_json
        FROM sessions
        ORDER BY modified_at DESC
      `).all() as StoredSessionRow[];
      const privacyCheckpoint = database.prepare('SELECT value FROM catalog_metadata WHERE key = ?')
        .get(PRIVACY_CHECKPOINT_KEY) as { value?: string } | undefined;
      return {
        records: rows.map(parseStoredRow),
        privacyCheckpointPending: privacyCheckpoint?.value === '1',
      };
    } catch (error) {
      // A first initializer may have published the database file before its
      // schema/authority transaction is visible. Let the normal writable open
      // contend or complete idempotent initialization; never mistake that
      // transient shape for corruption and unlink another process's sidecar.
      if (isSqliteSchemaNotReady(error)) return undefined;
      throw error;
    } finally {
      database.close();
    }
  }

  /** Point-read the fence through a read-only WAL connection so a competing
   * backend writer cannot turn catalog capture into a UI stall. Old sidecars
   * legitimately lack the additive metadata key and begin at generation 0. */
  private readExistingMutationGeneration(): number | undefined {
    if (!fs.existsSync(this.indexPath)) return undefined;
    const database = new sqlite.DatabaseSync(this.indexPath, {
      readOnly: true,
      timeout: SESSION_INDEX_BUSY_TIMEOUT_MS,
    });
    try {
      const versionRow = database.prepare('PRAGMA user_version').get() as {
        user_version?: number | bigint;
      } | undefined;
      if (sqliteInteger(versionRow?.user_version ?? 0) !== SESSION_INDEX_SCHEMA_VERSION) {
        return undefined;
      }
      const authority = database.prepare("SELECT value FROM catalog_metadata WHERE key = 'authority'")
        .get() as { value?: string } | undefined;
      if (authority?.value !== this.authorityKey) return undefined;
      return this.readMutationGenerationValue(database);
    } catch (error) {
      if (isSqliteSchemaNotReady(error)) return undefined;
      throw error;
    } finally {
      database.close();
    }
  }

  /** Retry only the durable WAL scrub marker observed by the read-only fast
   * path. This avoids schema/quick-check work and swallows a busy or transient
   * writable-open failure: the marker remains `1`, so the next read retries
   * without routing a valid catalog through the slow SDK fallback. */
  private tryFinalizePrivacyCheckpointAfterRead(): void {
    if (this.closed) return;
    // A later explicit read starts a fresh finite retry budget after an older
    // series was exhausted. Reads while a timer is already armed do not create
    // duplicate timers or reset the active series.
    if (!this.privacyCheckpointRetryTimer
      && this.privacyCheckpointRetryAttempts >= PRIVACY_CHECKPOINT_RETRY_MAX_ATTEMPTS) {
      this.privacyCheckpointRetryAttempts = 0;
    }
    this.attemptPrivacyCheckpointFinalize();
  }

  private attemptPrivacyCheckpointFinalize(): void {
    if (this.closed) return;
    let database: SqliteDatabase | undefined;
    let complete = false;
    let retryable = false;
    try {
      database = new sqlite.DatabaseSync(this.indexPath, {
        timeout: SESSION_INDEX_BUSY_TIMEOUT_MS,
      });
      database.exec(`PRAGMA busy_timeout = ${SESSION_INDEX_BUSY_TIMEOUT_MS}`);
      this.finalizePrivacyCheckpoint(database);
      complete = true;
    } catch (error) {
      retryable = isSessionIndexBusyError(error);
      // Best effort and durably retryable via PRIVACY_CHECKPOINT_KEY. Only
      // lock contention receives autonomous retries; other failures remain
      // eligible on the next normal read without spinning in the background.
    } finally {
      try { database?.close(); } catch { /* next read retries */ }
    }
    if (complete) {
      this.clearPrivacyCheckpointRetry();
    } else if (retryable) {
      this.schedulePrivacyCheckpointRetry();
    }
  }

  private schedulePrivacyCheckpointRetry(): void {
    if (this.closed
      || this.privacyCheckpointRetryTimer
      || this.privacyCheckpointRetryAttempts >= PRIVACY_CHECKPOINT_RETRY_MAX_ATTEMPTS) {
      return;
    }
    const delayMs = Math.min(
      PRIVACY_CHECKPOINT_RETRY_MAX_MS,
      PRIVACY_CHECKPOINT_RETRY_BASE_MS * (2 ** this.privacyCheckpointRetryAttempts),
    );
    this.privacyCheckpointRetryAttempts += 1;
    this.privacyCheckpointRetryTimer = setTimeout(() => {
      this.privacyCheckpointRetryTimer = undefined;
      this.attemptPrivacyCheckpointFinalize();
    }, delayMs);
    this.privacyCheckpointRetryTimer.unref?.();
  }

  private clearPrivacyCheckpointRetry(): void {
    if (this.privacyCheckpointRetryTimer) clearTimeout(this.privacyCheckpointRetryTimer);
    this.privacyCheckpointRetryTimer = undefined;
    this.privacyCheckpointRetryAttempts = 0;
  }

  private openWithRecovery(): SqliteDatabase {
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    let firstDatabase: SqliteDatabase | undefined;
    try {
      firstDatabase = new sqlite.DatabaseSync(this.indexPath);
      this.initialize(firstDatabase);
      return firstDatabase;
    } catch (error) {
      // A catalog is derived data. Corruption never becomes a startup blocker:
      // discard only the exact versioned sidecar and build it again.
      try { firstDatabase?.close(); } catch { /* best effort */ }
      const integrityFailure = error instanceof Error
        && error.message.startsWith('Session index integrity check failed:');
      if (!isSqliteContentFailure(error) && !integrityFailure) throw error;
      removeExactIndexFiles(this.indexPath);
      const database = new sqlite.DatabaseSync(this.indexPath);
      try {
        this.initialize(database);
        return database;
      } catch (recoveryError) {
        try { database.close(); } catch { /* best effort */ }
        throw new AggregateError([error, recoveryError], `Unable to rebuild session index: ${this.indexPath}`);
      }
    }
  }

  private initialize(database: SqliteDatabase): void {
    database.exec(`PRAGMA busy_timeout = ${SESSION_INDEX_BUSY_TIMEOUT_MS}`);
    database.exec('PRAGMA secure_delete = ON');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = NORMAL');

    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined;
    const version = sqliteInteger(versionRow?.user_version ?? 0);
    if (version !== 0 && version !== SESSION_INDEX_SCHEMA_VERSION) {
      database.exec('BEGIN EXCLUSIVE');
      try {
        database.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS catalog_metadata;');
        database.exec(schemaSql());
        database.exec(`PRAGMA user_version = ${SESSION_INDEX_SCHEMA_VERSION}`);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* preserve original */ }
        throw error;
      }
    } else {
      database.exec(schemaSql());
      if (version === 0) database.exec(`PRAGMA user_version = ${SESSION_INDEX_SCHEMA_VERSION}`);
    }

    const quickCheck = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!quickCheck || !Object.values(quickCheck).some((value) => value === 'ok')) {
      throw new Error(`Session index integrity check failed: ${this.indexPath}`);
    }

    const existing = database.prepare("SELECT value FROM catalog_metadata WHERE key = 'authority'")
      .get() as { value?: string } | undefined;
    if (existing?.value !== undefined && existing.value !== this.authorityKey) {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DELETE FROM sessions');
        this.advanceMutationGeneration(database);
        this.markPrivacyCheckpointPending(database);
        database.prepare("UPDATE catalog_metadata SET value = ? WHERE key = 'authority'")
          .run(this.authorityKey);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* preserve original */ }
        throw error;
      }
    } else if (existing?.value === undefined) {
      database.prepare("INSERT OR IGNORE INTO catalog_metadata (key, value) VALUES ('authority', ?)")
        .run(this.authorityKey);
    }
    database.prepare('INSERT OR IGNORE INTO catalog_metadata (key, value) VALUES (?, ?)')
      .run(PRIVACY_CHECKPOINT_KEY, '0');
    database.prepare('INSERT OR IGNORE INTO catalog_metadata (key, value) VALUES (?, ?)')
      .run(CATALOG_MUTATION_GENERATION_KEY, '0');
    this.readMutationGenerationValue(database);
    this.finalizePrivacyCheckpoint(database);
  }

  private readMutationGenerationValue(database: SqliteDatabase): number {
    const row = database.prepare('SELECT value FROM catalog_metadata WHERE key = ?')
      .get(CATALOG_MUTATION_GENERATION_KEY) as { value?: string } | undefined;
    if (row?.value === undefined) return 0;
    if (!/^(?:0|[1-9]\d*)$/.test(row.value)) {
      throw new Error(`Invalid session index mutation generation: ${row.value}`);
    }
    const generation = Number(row.value);
    if (!Number.isSafeInteger(generation)) {
      throw new Error(`Invalid session index mutation generation: ${row.value}`);
    }
    return generation;
  }

  private assertMutationGeneration(
    database: SqliteDatabase,
    expectedMutationGeneration: number | undefined,
  ): number {
    const actualGeneration = this.readMutationGenerationValue(database);
    if (expectedMutationGeneration !== undefined && actualGeneration !== expectedMutationGeneration) {
      throw new StaleSessionIndexMutationGenerationError(
        expectedMutationGeneration,
        actualGeneration,
      );
    }
    return actualGeneration;
  }

  private upsertRecords(
    database: SqliteDatabase,
    records: readonly IndexedSessionMetadata[],
    requireSourceExists = false,
  ): boolean {
    const upsert = database.prepare(`
      INSERT INTO sessions (
        path_key, file_path, fingerprint_json, summary_json, checkpoint_json, modified_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path_key) DO UPDATE SET
        file_path = excluded.file_path,
        fingerprint_json = excluded.fingerprint_json,
        summary_json = excluded.summary_json,
        checkpoint_json = excluded.checkpoint_json,
        modified_at = excluded.modified_at
      WHERE sessions.fingerprint_json <> excluded.fingerprint_json
         OR sessions.summary_json <> excluded.summary_json
         OR sessions.checkpoint_json <> excluded.checkpoint_json
    `);
    let changed = false;
    for (const record of records) {
      // Forget removes the transcript before its shared SQLite tombstone. This
      // exact stat check occurs while BEGIN IMMEDIATE orders catalog writers:
      // a missing/replaced/appended source rolls back both durable and
      // in-memory publication; a later forget's delete follows this commit.
      const sourceMatches = this.options.reconciliationSourceMatches
        ?? reconciliationSourceMatches;
      if (requireSourceExists && !sourceMatches(record.fingerprint)) {
        throw new StaleSessionIndexSourceError(record.fingerprint.path);
      }
      const result = upsert.run(
        record.fingerprint.pathKey,
        record.fingerprint.path,
        JSON.stringify(record.fingerprint),
        JSON.stringify(record.summary),
        JSON.stringify(record.checkpoint),
        record.summary.modifiedAt,
      );
      changed = sqliteInteger(result.changes) > 0 || changed;
    }
    return changed;
  }

  private advanceMutationGeneration(database: SqliteDatabase): number {
    const generation = this.readMutationGenerationValue(database);
    if (generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Session index mutation generation exhausted.');
    }
    const nextGeneration = generation + 1;
    database.prepare(`
      INSERT INTO catalog_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(CATALOG_MUTATION_GENERATION_KEY, String(nextGeneration));
    return nextGeneration;
  }

  private markPrivacyCheckpointPending(database: SqliteDatabase): void {
    database.prepare(`
      INSERT INTO catalog_metadata (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = '1'
    `).run(PRIVACY_CHECKPOINT_KEY);
  }

  private finalizePrivacyCheckpoint(database: SqliteDatabase): void {
    const pending = database.prepare('SELECT value FROM catalog_metadata WHERE key = ?')
      .get(PRIVACY_CHECKPOINT_KEY) as { value?: string } | undefined;
    if (pending?.value !== '1') return;
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as WalCheckpointRow | undefined;
    if (sqliteInteger(checkpoint?.busy ?? 0) !== 0) throw sqliteBusyError(this.indexPath);
    // Reset only after the WAL containing the deleted projection has been
    // truncated. If the process stops between these statements, the durable
    // marker conservatively repeats the harmless checkpoint on next open.
    database.prepare('UPDATE catalog_metadata SET value = ? WHERE key = ?')
      .run('0', PRIVACY_CHECKPOINT_KEY);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  private withContentRecovery<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteContentFailure(error)) throw error;
      try { this.activeDatabase?.close(); } catch { /* best effort */ }
      this.activeDatabase = undefined;
      removeExactIndexFiles(this.indexPath);
      this.activeDatabase = this.openWithRecovery();
      return operation();
    }
  }

  private rebuildDatabase(): void {
    try { this.activeDatabase?.close(); } catch { /* best effort */ }
    this.activeDatabase = undefined;
    removeExactIndexFiles(this.indexPath);
    this.activeDatabase = this.openWithRecovery();
    this.releaseDatabase();
  }
}
