import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { deserialize } from 'node:v8';

import {
  AnalyticsSourceConflictError,
  analyticsObservationFingerprint,
  analyticsObservationRegistryKey,
  assertValidAnalyticsObservation,
  canonicalInt64,
  parseInt64,
  type AnalyticsDetailCapture,
  type AnalyticsDetailSink,
  type AnalyticsObservation,
  type AnalyticsSink,
  type AnalyticsUsageChannels,
  type Int64Value,
} from '../../../shared/analytics/contracts.js';

interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
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
    options?: { readOnly?: boolean; timeout?: number; readBigInts?: boolean },
  ) => SqliteDatabase;
}

const sqlite = createRequire(process.execPath)('node:sqlite') as SqliteModule;
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

interface RegistryRow { fingerprint: string }
interface CountRow { count: number | bigint }
interface DeletedSubjectRow { deleted_count: number | bigint; deleted_at_ms: string }
interface PayloadRow { payload_id?: string; fingerprint: string; manifest_json: string; logical_bytes: number | bigint }
interface ContentRow { digest: string; encoding: string; body: Uint8Array }

export interface AnalyticsDeleteReceipt {
  rootSessionId: string;
  deletedObservationCount: number;
  deletedPayloadCount: number;
  deletedAtMs: string;
  duplicate: boolean;
}

export interface AnalyticsRecorderStats {
  accepted: number;
  duplicates: number;
  detailsAccepted: number;
  detailDuplicates: number;
  rejectedAfterDelete: number;
}

export interface ProviderUsageProjection {
  invocationId: string;
  usage: AnalyticsUsageChannels;
  reportedCostUsd: number | null;
}

export interface AnalyticsDetailStorageStats {
  payloadCount: number;
  contentCount: number;
  logicalBytes: number;
  storedContentBytes: number;
}

type DetailNode =
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'boolean'; v: boolean }
  | { t: 'number'; v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'bigint'; v: string }
  | { t: 'leaf'; d: string; e: 'utf8' | 'binary' }
  | { t: 'array'; v: DetailNode[] }
  | { t: 'object'; v: Array<[string, DetailNode]> };

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
}

function subjectKey(observation: AnalyticsObservation): string {
  switch (observation.captureSubject.kind) {
    case 'session': return observation.captureSubject.rootSessionId;
    case 'pendingCreate': return observation.captureSubject.operationId;
    case 'host': return observation.captureSubject.hostId;
  }
}

function captureSubjectKey(capture: AnalyticsDetailCapture): string {
  switch (capture.captureSubject.kind) {
    case 'session': return capture.captureSubject.rootSessionId;
    case 'pendingCreate': return capture.captureSubject.operationId;
    case 'host': return capture.captureSubject.hostId;
  }
}

function toNumber(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`SQLite value is outside the nonnegative safe-integer range: ${String(value)}`);
  }
  return converted;
}

function contentDigest(encoding: 'utf8' | 'binary', bytes: Uint8Array): string {
  return createHash('sha256')
    .update(encoding)
    .update('\0')
    .update(bytes)
    .digest('hex');
}

function captureFingerprint(capture: AnalyticsDetailCapture): string {
  return createHash('sha256')
    .update(capture.generationId)
    .update('\0')
    .update(capture.sourceKey)
    .update('\0')
    .update(capture.payloadId)
    .update('\0')
    .update(captureSubjectKey(capture))
    .update('\0')
    .update(canonicalInt64(capture.observedAtMs))
    .update('\0')
    .update(capture.bytes)
    .digest('hex');
}

function createSchema(database: SqliteDatabase): void {
  database.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA user_version = ${SCHEMA_VERSION};

    CREATE TABLE IF NOT EXISTS analytics_observations (
      commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      registry_key TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_at_ms TEXT NOT NULL,
      committed_at_ms TEXT NOT NULL,
      producer_kind TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      observation_kind TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      invocation_id TEXT,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS analytics_idempotency_idx
      ON analytics_observations(generation_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS analytics_subject_idx
      ON analytics_observations(capture_subject_kind, capture_subject_key);
    CREATE INDEX IF NOT EXISTS analytics_root_session_idx
      ON analytics_observations(root_session_id, commit_sequence);
    CREATE INDEX IF NOT EXISTS analytics_invocation_idx
      ON analytics_observations(invocation_id, commit_sequence);

    CREATE TABLE IF NOT EXISTS analytics_detail_content (
      digest TEXT PRIMARY KEY,
      encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'binary')),
      logical_bytes INTEGER NOT NULL,
      body BLOB NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS analytics_detail_payloads (
      payload_id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_at_ms TEXT NOT NULL,
      committed_at_ms TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      logical_bytes INTEGER NOT NULL,
      UNIQUE(generation_id, source_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS analytics_detail_subject_idx
      ON analytics_detail_payloads(capture_subject_kind, capture_subject_key);

    CREATE TABLE IF NOT EXISTS analytics_detail_references (
      payload_id TEXT NOT NULL REFERENCES analytics_detail_payloads(payload_id) ON DELETE CASCADE,
      digest TEXT NOT NULL REFERENCES analytics_detail_content(digest),
      PRIMARY KEY(payload_id, digest)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS analytics_deleted_subjects (
      root_session_id TEXT PRIMARY KEY,
      delete_source_key TEXT NOT NULL UNIQUE,
      deleted_count INTEGER NOT NULL,
      deleted_payload_count INTEGER NOT NULL,
      deleted_at_ms TEXT NOT NULL
    ) STRICT;
  `);
}

function validateDetailCapture(capture: AnalyticsDetailCapture): void {
  for (const [name, value] of [
    ['generationId', capture.generationId],
    ['payloadId', capture.payloadId],
    ['sourceKey', capture.sourceKey],
  ] as const) {
    if (!value || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL.`);
  }
  if (capture.schemaVersion < 1 || !Number.isSafeInteger(capture.schemaVersion)) {
    throw new Error('Detail capture schemaVersion must be a positive safe integer.');
  }
  parseInt64(capture.observedAtMs, 'observedAtMs');
  if (capture.mediaType !== 'application/x-pie-subagent-result'
    || capture.encoding !== 'node-v8'
    || capture.complete !== true
    || !(capture.bytes instanceof Uint8Array)) {
    throw new Error('Unsupported or incomplete analytics detail capture.');
  }
}

/**
 * SQLite P0 candidate. All methods are synchronous and therefore belong in the
 * isolated recorder worker, never the extension host or subagent callback.
 * Facts, deletion markers, linked detail manifests, shared content and
 * projections use one canonical database.
 */
export class SqliteAnalyticsRecorder implements AnalyticsSink, AnalyticsDetailSink {
  private readonly database: SqliteDatabase;
  private readonly stats: AnalyticsRecorderStats = {
    accepted: 0,
    duplicates: 0,
    detailsAccepted: 0,
    detailDuplicates: 0,
    rejectedAfterDelete: 0,
  };
  private closed = false;

  constructor(readonly databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new sqlite.DatabaseSync(databasePath, {
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: true,
    });
    createSchema(this.database);
  }

  submit(observation: AnalyticsObservation): void {
    this.submitBatch([observation]);
  }

  submitBatch(observations: readonly AnalyticsObservation[]): void {
    this.assertOpen();
    if (observations.length === 0) return;
    for (const observation of observations) assertValidAnalyticsObservation(observation);
    this.transaction(() => {
      for (const observation of observations) this.insertObservation(observation);
    });
  }

  submitDetail(capture: AnalyticsDetailCapture): void {
    this.assertOpen();
    validateDetailCapture(capture);
    const fingerprint = captureFingerprint(capture);
    this.transaction(() => {
      const existing = this.database.prepare(
        'SELECT fingerprint, manifest_json, logical_bytes FROM analytics_detail_payloads WHERE payload_id = ?',
      ).get(capture.payloadId) as PayloadRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new AnalyticsSourceConflictError(capture.payloadId, existing.fingerprint, fingerprint);
        }
        this.stats.detailDuplicates += 1;
        return;
      }
      const sourceExisting = this.database.prepare(`
        SELECT payload_id, fingerprint, manifest_json, logical_bytes
        FROM analytics_detail_payloads
        WHERE generation_id = ? AND source_key = ?
      `).get(capture.generationId, capture.sourceKey) as PayloadRow | undefined;
      if (sourceExisting) {
        throw new AnalyticsSourceConflictError(
          `${capture.generationId}:${capture.sourceKey}`,
          sourceExisting.fingerprint,
          fingerprint,
        );
      }
      this.assertSubjectWritable(capture.captureSubject.kind, captureSubjectKey(capture));

      const value = deserialize(Buffer.from(capture.bytes));
      const references = new Map<string, { encoding: 'utf8' | 'binary'; bytes: Uint8Array }>();
      let logicalBytes = 0;
      const active = new WeakSet<object>();
      const encode = (candidate: unknown): DetailNode => {
        if (candidate === null) return { t: 'null' };
        if (candidate === undefined) return { t: 'undefined' };
        if (typeof candidate === 'boolean') return { t: 'boolean', v: candidate };
        if (typeof candidate === 'number') {
          const value = Number.isNaN(candidate) ? 'NaN'
            : candidate === Infinity ? 'Infinity'
              : candidate === -Infinity ? '-Infinity'
                : Object.is(candidate, -0) ? '-0' : candidate;
          return { t: 'number', v: value };
        }
        if (typeof candidate === 'bigint') return { t: 'bigint', v: candidate.toString() };
        if (typeof candidate === 'string') {
          const bytes = Buffer.from(candidate, 'utf8');
          const digest = contentDigest('utf8', bytes);
          references.set(digest, { encoding: 'utf8', bytes });
          logicalBytes += bytes.byteLength;
          return { t: 'leaf', d: digest, e: 'utf8' };
        }
        if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
          const bytes = Buffer.from(candidate);
          const digest = contentDigest('binary', bytes);
          references.set(digest, { encoding: 'binary', bytes });
          logicalBytes += bytes.byteLength;
          return { t: 'leaf', d: digest, e: 'binary' };
        }
        if (typeof candidate !== 'object') {
          throw new Error(`Unsupported analytics detail value: ${typeof candidate}`);
        }
        if (active.has(candidate)) throw new Error('Cyclic analytics detail is not supported.');
        active.add(candidate);
        try {
          if (Array.isArray(candidate)) return { t: 'array', v: candidate.map(encode) };
          if (candidate instanceof Date) return encode(candidate.toISOString());
          return { t: 'object', v: Object.entries(candidate).map(([key, child]) => [key, encode(child)]) };
        } finally {
          active.delete(candidate);
        }
      };
      const manifest = encode(value);

      const insertContent = this.database.prepare(`
        INSERT OR IGNORE INTO analytics_detail_content (digest, encoding, logical_bytes, body)
        VALUES (?, ?, ?, ?)
      `);
      for (const [digest, entry] of references) {
        insertContent.run(digest, entry.encoding, entry.bytes.byteLength, entry.bytes);
      }
      this.database.prepare(`
        INSERT INTO analytics_detail_payloads (
          payload_id, generation_id, source_key, fingerprint, observed_at_ms,
          committed_at_ms, capture_subject_kind, capture_subject_key,
          manifest_json, logical_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        capture.payloadId,
        capture.generationId,
        capture.sourceKey,
        fingerprint,
        canonicalInt64(capture.observedAtMs),
        Date.now().toString(),
        capture.captureSubject.kind,
        captureSubjectKey(capture),
        JSON.stringify(manifest),
        logicalBytes,
      );
      const insertReference = this.database.prepare(`
        INSERT INTO analytics_detail_references (payload_id, digest) VALUES (?, ?)
      `);
      for (const digest of references.keys()) insertReference.run(capture.payloadId, digest);
      this.stats.detailsAccepted += 1;
    });
  }

  private insertObservation(observation: AnalyticsObservation): void {
    const registryKey = analyticsObservationRegistryKey(observation);
    const fingerprint = analyticsObservationFingerprint(observation);
    const existing = this.database.prepare(
      'SELECT fingerprint FROM analytics_observations WHERE registry_key = ?',
    ).get(registryKey) as RegistryRow | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AnalyticsSourceConflictError(registryKey, existing.fingerprint, fingerprint);
      }
      this.stats.duplicates += 1;
      return;
    }

    this.assertSubjectWritable(observation.captureSubject.kind, subjectKey(observation));
    this.database.prepare(`
      INSERT INTO analytics_observations (
        generation_id, source_key, registry_key, idempotency_key, fingerprint,
        observed_at_ms, committed_at_ms, producer_kind, entity_kind, entity_key,
        observation_kind, capture_subject_kind, capture_subject_key,
        root_session_id, invocation_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.generationId,
      observation.sourceKey,
      registryKey,
      observation.idempotencyKey,
      fingerprint,
      canonicalInt64(observation.observedAtMs),
      Date.now().toString(),
      observation.producerKind,
      observation.entityKind,
      observation.entityKey,
      observation.observationKind,
      observation.captureSubject.kind,
      subjectKey(observation),
      observation.scope.rootSessionId ?? null,
      observation.scope.invocationId ?? null,
      serialize(observation),
    );
    this.stats.accepted += 1;
  }

  private assertSubjectWritable(kind: string, key: string): void {
    if (kind !== 'session') return;
    const deleted = this.database.prepare(
      'SELECT root_session_id FROM analytics_deleted_subjects WHERE root_session_id = ?',
    ).get(key);
    if (deleted) {
      this.stats.rejectedAfterDelete += 1;
      throw new Error(`Analytics capture subject is deleted: ${key}`);
    }
  }

  deleteSession(
    rootSessionId: string,
    deleteSourceKey: string,
    deletedAtMs: Int64Value,
  ): AnalyticsDeleteReceipt {
    this.assertOpen();
    if (!rootSessionId || !deleteSourceKey) throw new Error('rootSessionId and deleteSourceKey are required.');
    const encodedDeletedAt = canonicalInt64(deletedAtMs);
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT deleted_count, deleted_payload_count, deleted_at_ms
        FROM analytics_deleted_subjects WHERE root_session_id = ?
      `).get(rootSessionId) as (DeletedSubjectRow & { deleted_payload_count: number | bigint }) | undefined;
      if (existing) {
        return {
          rootSessionId,
          deletedObservationCount: toNumber(existing.deleted_count),
          deletedPayloadCount: toNumber(existing.deleted_payload_count),
          deletedAtMs: existing.deleted_at_ms,
          duplicate: true,
        };
      }

      const deletedObservationCount = toNumber(this.database.prepare(`
        DELETE FROM analytics_observations
        WHERE capture_subject_kind = 'session' AND capture_subject_key = ?
      `).run(rootSessionId).changes);
      const deletedPayloadCount = toNumber(this.database.prepare(`
        DELETE FROM analytics_detail_payloads
        WHERE capture_subject_kind = 'session' AND capture_subject_key = ?
      `).run(rootSessionId).changes);
      this.database.prepare(`
        DELETE FROM analytics_detail_content
        WHERE NOT EXISTS (
          SELECT 1 FROM analytics_detail_references reference
          WHERE reference.digest = analytics_detail_content.digest
        )
      `).run();
      this.database.prepare(`
        INSERT INTO analytics_deleted_subjects (
          root_session_id, delete_source_key, deleted_count,
          deleted_payload_count, deleted_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(rootSessionId, deleteSourceKey, deletedObservationCount, deletedPayloadCount, encodedDeletedAt);
      return {
        rootSessionId,
        deletedObservationCount,
        deletedPayloadCount,
        deletedAtMs: encodedDeletedAt,
        duplicate: false,
      };
    });
  }

  countObservations(rootSessionId?: string): number {
    this.assertOpen();
    const row = rootSessionId
      ? this.database.prepare(
          'SELECT COUNT(*) AS count FROM analytics_observations WHERE root_session_id = ?',
        ).get(rootSessionId)
      : this.database.prepare('SELECT COUNT(*) AS count FROM analytics_observations').get();
    return toNumber((row as CountRow).count);
  }

  countDetails(rootSessionId?: string): number {
    this.assertOpen();
    const row = rootSessionId
      ? this.database.prepare(`
          SELECT COUNT(*) AS count FROM analytics_detail_payloads
          WHERE capture_subject_kind = 'session' AND capture_subject_key = ?
        `).get(rootSessionId)
      : this.database.prepare('SELECT COUNT(*) AS count FROM analytics_detail_payloads').get();
    return toNumber((row as CountRow).count);
  }

  reconstructDetail(payloadId: string): unknown {
    this.assertOpen();
    const payload = this.database.prepare(`
      SELECT fingerprint, manifest_json, logical_bytes
      FROM analytics_detail_payloads WHERE payload_id = ?
    `).get(payloadId) as PayloadRow | undefined;
    if (!payload) throw new Error(`Analytics detail payload is unavailable: ${payloadId}`);
    const rows = this.database.prepare(`
      SELECT content.digest, content.encoding, content.body
      FROM analytics_detail_references reference
      JOIN analytics_detail_content content ON content.digest = reference.digest
      WHERE reference.payload_id = ?
    `).all(payloadId) as ContentRow[];
    const content = new Map(rows.map((row) => [row.digest, row]));
    const decode = (node: DetailNode): unknown => {
      switch (node.t) {
        case 'null': return null;
        case 'undefined': return undefined;
        case 'boolean': return node.v;
        case 'number':
          return node.v === 'NaN' ? NaN
            : node.v === 'Infinity' ? Infinity
              : node.v === '-Infinity' ? -Infinity
                : node.v === '-0' ? -0 : node.v;
        case 'bigint': return BigInt(node.v);
        case 'leaf': {
          const row = content.get(node.d);
          if (!row || row.encoding !== node.e) throw new Error(`Missing analytics detail content: ${node.d}`);
          return node.e === 'utf8' ? Buffer.from(row.body).toString('utf8') : Buffer.from(row.body);
        }
        case 'array': return node.v.map(decode);
        case 'object': return Object.fromEntries(node.v.map(([key, child]) => [key, decode(child)]));
      }
    };
    return decode(JSON.parse(payload.manifest_json) as DetailNode);
  }

  detailStorageStats(): AnalyticsDetailStorageStats {
    this.assertOpen();
    const payload = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(logical_bytes), 0) AS logical
      FROM analytics_detail_payloads
    `).get() as { count: number | bigint; logical: number | bigint };
    const content = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(logical_bytes), 0) AS stored
      FROM analytics_detail_content
    `).get() as { count: number | bigint; stored: number | bigint };
    return {
      payloadCount: toNumber(payload.count),
      contentCount: toNumber(content.count),
      logicalBytes: toNumber(payload.logical),
      storedContentBytes: toNumber(content.stored),
    };
  }

  /** Minimal P0 projection: one terminal provider settlement per invocation.
   * Missing channels remain null and are not coerced to zero. */
  projectProviderUsage(rootSessionId?: string): ProviderUsageProjection[] {
    this.assertOpen();
    const where = rootSessionId
      ? "WHERE observation_kind = 'providerSettlement' AND root_session_id = ?"
      : "WHERE observation_kind = 'providerSettlement'";
    const rows = this.database.prepare(`
      SELECT invocation_id, payload_json
      FROM analytics_observations
      ${where}
      ORDER BY commit_sequence
    `).all(...(rootSessionId ? [rootSessionId] : [])) as Array<{
      invocation_id: string | null;
      payload_json: string;
    }>;
    const distinct = new Map<string, ProviderUsageProjection>();
    for (const row of rows) {
      const observation = JSON.parse(row.payload_json) as AnalyticsObservation<Record<string, unknown>>;
      const invocationId = row.invocation_id
        ?? (typeof observation.fields.invocationId === 'string' ? observation.fields.invocationId : undefined);
      if (!invocationId || distinct.has(invocationId)) continue;
      const channel = (name: keyof AnalyticsUsageChannels): number | string | null => {
        const value = observation.fields[name];
        return typeof value === 'number' || typeof value === 'string' ? value : null;
      };
      const reportedCost = observation.fields.reportedCostUsd;
      distinct.set(invocationId, {
        invocationId,
        usage: {
          inputTokens: channel('inputTokens'),
          outputTokens: channel('outputTokens'),
          cacheReadTokens: channel('cacheReadTokens'),
          cacheWriteTokens: channel('cacheWriteTokens'),
          reasoningTokens: channel('reasoningTokens'),
          providerTotalTokens: channel('providerTotalTokens'),
        },
        reportedCostUsd: typeof reportedCost === 'number' ? reportedCost : null,
      });
    }
    return [...distinct.values()];
  }

  getStats(): Readonly<AnalyticsRecorderStats> {
    return { ...this.stats };
  }

  checkpoint(): void {
    this.assertOpen();
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
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

  private assertOpen(): void {
    if (this.closed) throw new Error('Analytics recorder is closed.');
  }
}
