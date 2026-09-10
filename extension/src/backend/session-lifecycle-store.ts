import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import {
  canonicalInt64,
  parseInt64,
  type AnalyticsCloseDisposition,
  type AnalyticsPrivacyMode,
  type Int64Value,
} from '../../../shared/analytics/contracts.js';

const sqlite = createRequire(process.execPath)('node:sqlite') as {
  DatabaseSync: new (
    location: string,
    options?: { timeout?: number; readBigInts?: boolean },
  ) => SqliteDatabase;
};

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const RETENTION_MS = 24n * 60n * 60n * 1_000n;

interface SqliteRunResult { changes: number | bigint }
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

export type SessionCleanupState = 'retained' | 'deleting' | 'deleted';

export interface SessionLifecycleRecord {
  sessionId: string;
  privacyMode: AnalyticsPrivacyMode;
  privacyUpdatedAtMs: string;
  closedAtMs?: string;
  expiresAtMs?: string;
  firstCloseOperationId?: string;
  disposition?: AnalyticsCloseDisposition;
  writeEpoch: number;
  cleanupState: SessionCleanupState;
  deletedAtMs?: string;
}

export interface SessionCloseDecision extends SessionLifecycleRecord {
  closedAtMs: string;
  firstCloseOperationId: string;
  disposition: AnalyticsCloseDisposition;
  duplicate: boolean;
}

interface StoredLifecycleRow {
  session_id: string;
  privacy_mode: AnalyticsPrivacyMode;
  privacy_updated_at_ms: number | bigint;
  closed_at_ms: number | bigint | null;
  expires_at_ms: number | bigint | null;
  first_close_operation_id: string | null;
  disposition: AnalyticsCloseDisposition | null;
  write_epoch: number | bigint;
  cleanup_state: SessionCleanupState;
  deleted_at_ms: number | bigint | null;
}

function asString(value: number | bigint | null): string | undefined {
  return value === null ? undefined : String(value);
}

function asNumber(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`Invalid lifecycle write epoch: ${String(value)}`);
  }
  return converted;
}

function recordFromRow(row: StoredLifecycleRow): SessionLifecycleRecord {
  return {
    sessionId: row.session_id,
    privacyMode: row.privacy_mode,
    privacyUpdatedAtMs: String(row.privacy_updated_at_ms),
    closedAtMs: asString(row.closed_at_ms),
    expiresAtMs: asString(row.expires_at_ms),
    firstCloseOperationId: row.first_close_operation_id ?? undefined,
    disposition: row.disposition ?? undefined,
    writeEpoch: asNumber(row.write_epoch),
    cleanupState: row.cleanup_state,
    deletedAtMs: asString(row.deleted_at_ms),
  };
}

function assertId(value: string, name: string): void {
  if (!value || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL.`);
}

/**
 * Early P2b operational owner prototype. It is deliberately not wired into
 * live session admission or expiry yet. Short indexed SQLite transactions own
 * the reversible privacy setting and freeze the first close decision; the
 * analytics recorder consumes that decision through its separate deletion
 * transaction.
 */
export class SessionLifecycleStore {
  private readonly database: SqliteDatabase;
  private closed = false;

  constructor(readonly databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new sqlite.DatabaseSync(databasePath, {
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: true,
    });
    this.database.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = ${SCHEMA_VERSION};

      CREATE TABLE IF NOT EXISTS session_lifecycle (
        session_id TEXT PRIMARY KEY,
        privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('on', 'off')),
        privacy_updated_at_ms INTEGER NOT NULL,
        closed_at_ms INTEGER,
        expires_at_ms INTEGER,
        first_close_operation_id TEXT UNIQUE,
        disposition TEXT CHECK (disposition IN ('delete', 'retain')),
        write_epoch INTEGER NOT NULL DEFAULT 0,
        cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('retained', 'deleting', 'deleted')),
        deleted_at_ms INTEGER,
        CHECK ((closed_at_ms IS NULL) = (first_close_operation_id IS NULL)),
        CHECK ((closed_at_ms IS NULL) = (disposition IS NULL)),
        CHECK ((disposition = 'retain' AND expires_at_ms IS NOT NULL)
          OR (disposition = 'delete' AND expires_at_ms IS NULL)
          OR disposition IS NULL)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_lifecycle_due_idx
        ON session_lifecycle(expires_at_ms, session_id)
        WHERE expires_at_ms IS NOT NULL AND cleanup_state <> 'deleted';
    `);
  }

  setPrivacyMode(sessionId: string, mode: AnalyticsPrivacyMode, updatedAtMs: Int64Value): SessionLifecycleRecord {
    this.assertOpen();
    assertId(sessionId, 'sessionId');
    const timestamp = parseInt64(updatedAtMs, 'updatedAtMs');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readRow(sessionId);
      if (existing?.closed_at_ms !== null && existing !== undefined) {
        throw new Error(`Session privacy is frozen after close: ${sessionId}`);
      }
      this.database.prepare(`
        INSERT INTO session_lifecycle (
          session_id, privacy_mode, privacy_updated_at_ms, cleanup_state
        ) VALUES (?, ?, ?, 'retained')
        ON CONFLICT(session_id) DO UPDATE SET
          privacy_mode = excluded.privacy_mode,
          privacy_updated_at_ms = excluded.privacy_updated_at_ms
        WHERE session_lifecycle.closed_at_ms IS NULL
          AND excluded.privacy_updated_at_ms >= session_lifecycle.privacy_updated_at_ms
      `).run(sessionId, mode, timestamp);
      const row = this.requireRow(sessionId);
      this.database.exec('COMMIT');
      return recordFromRow(row);
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  resolveClose(sessionId: string, operationId: string, closedAtMs: Int64Value): SessionCloseDecision {
    this.assertOpen();
    assertId(sessionId, 'sessionId');
    assertId(operationId, 'operationId');
    const closedAt = parseInt64(closedAtMs, 'closedAtMs');
    const expiresAt = closedAt + RETENTION_MS;
    parseInt64(expiresAt, 'expiresAtMs');

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readRow(sessionId);
      if (existing?.closed_at_ms !== null && existing !== undefined) {
        const record = recordFromRow(existing);
        this.database.exec('COMMIT');
        return {
          ...record,
          closedAtMs: record.closedAtMs!,
          firstCloseOperationId: record.firstCloseOperationId!,
          disposition: record.disposition!,
          duplicate: true,
        };
      }

      const privacyMode = existing?.privacy_mode ?? 'off';
      const privacyUpdatedAt = existing?.privacy_updated_at_ms ?? closedAt;
      const disposition: AnalyticsCloseDisposition = privacyMode === 'on' ? 'delete' : 'retain';
      const epoch = existing ? asNumber(existing.write_epoch) + 1 : 1;
      this.database.prepare(`
        INSERT INTO session_lifecycle (
          session_id, privacy_mode, privacy_updated_at_ms, closed_at_ms,
          expires_at_ms, first_close_operation_id, disposition, write_epoch,
          cleanup_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          closed_at_ms = excluded.closed_at_ms,
          expires_at_ms = excluded.expires_at_ms,
          first_close_operation_id = excluded.first_close_operation_id,
          disposition = excluded.disposition,
          write_epoch = excluded.write_epoch,
          cleanup_state = excluded.cleanup_state
        WHERE session_lifecycle.closed_at_ms IS NULL
      `).run(
        sessionId,
        privacyMode,
        privacyUpdatedAt,
        closedAt,
        disposition === 'retain' ? expiresAt : null,
        operationId,
        disposition,
        epoch,
        disposition === 'delete' ? 'deleting' : 'retained',
      );
      const record = recordFromRow(this.requireRow(sessionId));
      this.database.exec('COMMIT');
      return {
        ...record,
        closedAtMs: record.closedAtMs!,
        firstCloseOperationId: record.firstCloseOperationId!,
        disposition: record.disposition!,
        duplicate: false,
      };
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  markDeleted(sessionId: string, deletedAtMs: Int64Value): SessionLifecycleRecord {
    this.assertOpen();
    const timestamp = parseInt64(deletedAtMs, 'deletedAtMs');
    const changed = this.database.prepare(`
      UPDATE session_lifecycle
      SET cleanup_state = 'deleted', deleted_at_ms = ?
      WHERE session_id = ? AND disposition = 'delete' AND cleanup_state <> 'deleted'
    `).run(timestamp, sessionId).changes;
    if (Number(changed) === 0) {
      const existing = this.get(sessionId);
      if (!existing || existing.disposition !== 'delete') {
        throw new Error(`Session has no private-close deletion intent: ${sessionId}`);
      }
      return existing;
    }
    return this.get(sessionId)!;
  }

  get(sessionId: string): SessionLifecycleRecord | undefined {
    this.assertOpen();
    const row = this.readRow(sessionId);
    return row ? recordFromRow(row) : undefined;
  }

  listDue(nowMs: Int64Value, limit = 100): SessionLifecycleRecord[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('limit must be an integer from 1 through 10000.');
    }
    const now = parseInt64(nowMs, 'nowMs');
    return (this.database.prepare(`
      SELECT * FROM session_lifecycle
      WHERE expires_at_ms IS NOT NULL
        AND expires_at_ms <= ?
        AND cleanup_state <> 'deleted'
      ORDER BY expires_at_ms, session_id
      LIMIT ?
    `).all(now, limit) as StoredLifecycleRow[]).map(recordFromRow);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private readRow(sessionId: string): StoredLifecycleRow | undefined {
    return this.database.prepare('SELECT * FROM session_lifecycle WHERE session_id = ?')
      .get(sessionId) as StoredLifecycleRow | undefined;
  }

  private requireRow(sessionId: string): StoredLifecycleRow {
    const row = this.readRow(sessionId);
    if (!row) throw new Error(`Missing lifecycle row after write: ${sessionId}`);
    return row;
  }

  private rollback(): void {
    try { this.database.exec('ROLLBACK'); } catch { /* preserve original error */ }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Session lifecycle store is closed: ${this.databasePath}`);
  }
}

export function sessionRetentionDeadline(closedAtMs: Int64Value): string {
  return canonicalInt64(parseInt64(closedAtMs, 'closedAtMs') + RETENTION_MS);
}
