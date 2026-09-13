import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  closeDispositionForPrivacy,
  parseInt64,
  type AnalyticsCloseDisposition,
  type AnalyticsPrivacyMode,
  type Int64Value,
} from '../../../shared/analytics/contracts.js';
import { ANALYTICS_HANDOFF_MAX_STATUS_HOSTS } from '../../../shared/analytics/handoff.js';

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
interface SqliteModule {
  DatabaseSync: new (location: string, options?: { timeout?: number; readBigInts?: boolean }) => SqliteDatabase;
}
const sqlite = createRequire(process.execPath)('node:sqlite') as SqliteModule;

class DatabaseCompat {
  private readonly database: SqliteDatabase;

  constructor(location: string) {
    this.database = new sqlite.DatabaseSync(location, { timeout: 5_000, readBigInts: true });
  }

  close(): void { this.database.close(); }
  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string): SqliteStatement { return this.database.prepare(sql); }
  pragma(statement: string, options?: { simple?: boolean }): unknown {
    if (statement === 'user_version' && options?.simple) {
      return (this.database.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version;
    }
    this.database.exec(`PRAGMA ${statement}`);
    return undefined;
  }
  transaction<T>(operation: () => T): () => T {
    return () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.database.exec('ROLLBACK'); } catch { /* retain original failure */ }
        throw error;
      }
    };
  }
}

const HOUR_MS = 60n * 60n * 1_000n;
const DAY_MS = 24n * HOUR_MS;
type PrivacyMode = AnalyticsPrivacyMode;
type SessionCloseDisposition = AnalyticsCloseDisposition;
// The host registry is an additive feature table. Keep the lifecycle
// user_version at 3 so an older extension host can continue opening the same
// database while this feature is still discovery-only.
const SCHEMA_VERSION = 3;
const ADDITIVE_HOST_REGISTRY_VERSION = 4;
const MAX_ANALYTICS_WRITER_HOSTS = 512;
const MAX_ANALYTICS_WRITER_LEASES = 4_096;

export type SessionCleanupState = 'open' | 'retained' | 'deleting' | 'deleted' | 'blocked';
export type SessionCloseCause = 'user_close' | 'private_close' | 'forget' | 'expiry';
export type LifecycleArtifactKind = 'transcript' | 'session_sidecar' | 'managed_cache' | 'external_reference';
export type LifecycleArtifactLocationKind = 'root_relative' | 'fixed_absolute' | 'external';
export type LifecycleArtifactState = 'present' | 'deleting' | 'deleted' | 'missing' | 'blocked';

/** Durable identity of an extension host that can participate in a future
 * all-host handoff. Registration is deliberately separate from completeness:
 * a caller must reconcile this set with runtime-generation leases and process
 * evidence before it may claim that every writer was quiesced. */
export type AnalyticsHostState = 'registered' | 'stopping' | 'stopped' | 'unsupported';

export interface AnalyticsHostRecord {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
  endpointName?: string;
  capabilities: string[];
  state: AnalyticsHostState;
  registeredAtMs: string;
  heartbeatAtMs: string;
  stoppedAtMs?: string;
  unsupportedReason?: string;
  updatedAtMs: string;
}

export interface AnalyticsHostPage {
  hosts: AnalyticsHostRecord[];
  truncated: boolean;
  nextCursor?: string;
}

export type AnalyticsWriterFencePurpose = 'analytics-activation' | 'storage-cutoff';
export type AnalyticsWriterFenceState = 'open' | 'fencing' | 'fenced';

/** Stable process/host identity used by the durable writer admission gate.
 * Per-boot keys and endpoint names intentionally stay outside this record. */
export interface AnalyticsWriterIdentity {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
}

export interface AnalyticsWriterFenceRecord {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  fenceEpoch: number;
  state: AnalyticsWriterFenceState;
  expectedHosts: AnalyticsWriterIdentity[];
  acknowledgedHostInstanceIds: string[];
  startedAtMs: string;
  updatedAtMs: string;
}

export interface AnalyticsWriterFenceAcknowledgement {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  acknowledgedAtMs: string;
}

export interface AnalyticsWriterLeaseRecord extends AnalyticsWriterIdentity {
  leaseId: string;
  fenceEpoch: number;
  acquiredAtMs: string;
}

export interface AnalyticsWriterAdmissionState {
  workspaceId: string;
  state: AnalyticsWriterFenceState;
  fenceEpoch: number;
}

export interface BeginAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  purpose: AnalyticsWriterFencePurpose;
  expectedHosts: readonly AnalyticsWriterIdentity[];
  nowMs: Int64Value;
}

export interface AcknowledgeAnalyticsWriterFenceOptions {
  workspaceId: string;
  operationId: string;
  fenceEpoch: number;
  identity: AnalyticsWriterIdentity;
  activeWriterCount: number;
  nowMs: Int64Value;
}

export interface ReopenAnalyticsWriterAdmissionOptions {
  workspaceId: string;
  operationId: string;
  purpose: 'analytics-activation';
  nowMs: Int64Value;
}

interface AnalyticsHostRow {
  host_instance_id: string;
  workspace_id: string;
  generation_id: string;
  build_id: string;
  process_id: number | bigint;
  endpoint_name: string | null;
  capabilities_json: string;
  state: AnalyticsHostState;
  registered_at_ms: string;
  heartbeat_at_ms: string;
  stopped_at_ms: string | null;
  unsupported_reason: string | null;
  updated_at_ms: string;
}

interface AnalyticsWriterFenceRow {
  workspace_id: string;
  operation_id: string;
  purpose: AnalyticsWriterFencePurpose;
  fence_epoch: number | bigint;
  state: AnalyticsWriterFenceState;
  expected_hosts_json: string;
  expected_hosts_sha256: string;
  started_at_ms: string;
  updated_at_ms: string;
}

interface AnalyticsWriterFenceAckRow {
  workspace_id: string;
  operation_id: string;
  host_instance_id: string;
  generation_id: string;
  build_id: string;
  process_id: number | bigint;
  fence_epoch: number | bigint;
  active_writer_count: number | bigint;
  acknowledged_at_ms: string;
}

interface AnalyticsWriterLeaseRow {
  lease_id: string;
  workspace_id: string;
  host_instance_id: string;
  generation_id: string;
  build_id: string;
  process_id: number | bigint;
  fence_epoch: number | bigint;
  acquired_at_ms: string;
}

export interface SessionLifecycleRecord {
  sessionId: string;
  privacyMode: PrivacyMode;
  /** Stable host create/duplicate operation that owned the pending analytics subject. */
  pendingCreateOperationId?: string;
  closeOperationId?: string;
  /** Stable first-close identity; retained alias for lifecycle/recorder callers. */
  firstCloseOperationId?: string;
  firstCloseCause?: SessionCloseCause;
  closedAtMs?: string;
  disposition?: SessionCloseDisposition;
  expiresAtMs?: string;
  transcriptRelativePath?: string;
  cleanupOperationId?: string;
  cleanupState: SessionCleanupState;
  cleanupStartedAtMs?: string;
  cleanupError?: string;
  deletedAtMs?: string;
  writeEpoch: number;
  updatedAtMs: string;
}

export interface SessionCloseResolution extends SessionLifecycleRecord {
  firstCloseOperationId: string;
  closedAtMs: string;
  disposition: SessionCloseDisposition;
  duplicate: boolean;
}

export interface LifecycleArtifactRecord {
  sessionId: string;
  artifactId: string;
  kind: LifecycleArtifactKind;
  locationKind: LifecycleArtifactLocationKind;
  location: string;
  rootName?: string;
  identityJson?: string;
  state: LifecycleArtifactState;
  cleanupOperationId?: string;
  cleanupError?: string;
  updatedAtMs: string;
}

interface LifecycleRow {
  session_id: string;
  privacy_mode: PrivacyMode;
  pending_create_operation_id: string | null;
  close_operation_id: string | null;
  first_close_cause: SessionCloseCause | null;
  closed_at_ms: string | null;
  disposition: SessionCloseDisposition | null;
  expires_at_ms: string | null;
  transcript_relative_path: string | null;
  cleanup_operation_id: string | null;
  cleanup_state: SessionCleanupState;
  cleanup_started_at_ms: string | null;
  cleanup_error: string | null;
  deleted_at_ms: string | null;
  write_epoch: number | bigint;
  updated_at_ms: string;
}

interface ArtifactRow {
  session_id: string;
  artifact_id: string;
  kind: LifecycleArtifactKind;
  location_kind: LifecycleArtifactLocationKind;
  location: string;
  root_name: string | null;
  identity_json: string | null;
  state: LifecycleArtifactState;
  cleanup_operation_id: string | null;
  cleanup_error: string | null;
  updated_at_ms: string;
}

function encodeTimestamp(value: Int64Value, name: string): string {
  return parseInt64(value, name).toString();
}

function requireId(value: string, name: string): string {
  if (!value || value.includes('\u0000')) throw new Error(`${name} is required and cannot contain NUL.`);
  return value;
}

function requireHostField(value: string, name: string, maxLength = 512): string {
  requireId(value, name);
  if (value.length > maxLength) throw new Error(`${name} exceeds the bounded length.`);
  return value;
}

function requireWriterIdentity(value: AnalyticsWriterIdentity, name: string): AnalyticsWriterIdentity {
  if (!value || typeof value !== 'object') throw new Error(`${name} is invalid.`);
  return {
    hostInstanceId: requireHostField(value.hostInstanceId, `${name}.hostInstanceId`),
    workspaceId: requireHostField(value.workspaceId, `${name}.workspaceId`),
    generationId: requireHostField(value.generationId, `${name}.generationId`),
    buildId: requireHostField(value.buildId, `${name}.buildId`),
    processId: (() => {
      if (!Number.isSafeInteger(value.processId) || value.processId <= 0) {
        throw new Error(`${name}.processId must be a positive safe integer.`);
      }
      return value.processId;
    })(),
  };
}

function writerIdentityFromHost(host: AnalyticsHostRecord): AnalyticsWriterIdentity {
  return requireWriterIdentity({
    hostInstanceId: host.hostInstanceId,
    workspaceId: host.workspaceId,
    generationId: host.generationId,
    buildId: host.buildId,
    processId: host.processId,
  }, 'Analytics host identity');
}

function sameWriterIdentity(left: AnalyticsWriterIdentity, right: AnalyticsWriterIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId
    && left.workspaceId === right.workspaceId
    && left.generationId === right.generationId
    && left.buildId === right.buildId
    && left.processId === right.processId;
}

function compareWriterHostIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writerHostsSerialization(hosts: readonly AnalyticsWriterIdentity[]): string {
  return `${JSON.stringify(hosts)}\n`;
}

function writerHostsDigest(hosts: readonly AnalyticsWriterIdentity[]): string {
  return createHash('sha256').update(writerHostsSerialization(hosts), 'utf8').digest('hex');
}

function canonicalWriterHosts(hosts: readonly AnalyticsWriterIdentity[]): AnalyticsWriterIdentity[] {
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > MAX_ANALYTICS_WRITER_HOSTS) {
    throw new Error('Analytics writer census must contain a bounded, non-empty host set.');
  }
  const normalized = hosts.map((host, index) => requireWriterIdentity(host, `Analytics writer census[${index}]`));
  normalized.sort((left, right) => compareWriterHostIds(left.hostInstanceId, right.hostInstanceId));
  const hostIds = new Set<string>();
  const processIds = new Set<number>();
  for (const host of normalized) {
    if (hostIds.has(host.hostInstanceId)) throw new SessionLifecycleConflictError(`Analytics writer census duplicates host ${host.hostInstanceId}.`);
    if (processIds.has(host.processId)) throw new SessionLifecycleConflictError(`Analytics writer census has ambiguous process ${host.processId}.`);
    hostIds.add(host.hostInstanceId);
    processIds.add(host.processId);
  }
  return normalized;
}

function parseWriterHosts(value: string, expectedDigest: string): AnalyticsWriterIdentity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SessionLifecycleConflictError('Analytics writer fence has corrupt expected-host evidence.');
  }
  if (!Array.isArray(parsed)) throw new SessionLifecycleConflictError('Analytics writer fence expected-host evidence is invalid.');
  const hosts = canonicalWriterHosts(parsed as AnalyticsWriterIdentity[]);
  if (writerHostsDigest(hosts) !== expectedDigest) {
    throw new SessionLifecycleConflictError('Analytics writer fence expected-host digest is invalid.');
  }
  return hosts;
}

function encodeHostCapabilities(capabilities: readonly string[]): string {
  if (!Array.isArray(capabilities) || capabilities.length > 32) {
    throw new Error('Analytics host capabilities exceed the bounded count.');
  }
  const normalized = [...new Set(capabilities)].map((capability) => requireHostField(capability, 'Analytics host capability', 128)).sort();
  return JSON.stringify(normalized);
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

function toRecord(row: LifecycleRow): SessionLifecycleRecord {
  return {
    sessionId: row.session_id,
    privacyMode: row.privacy_mode,
    pendingCreateOperationId: optional(row.pending_create_operation_id),
    closeOperationId: optional(row.close_operation_id),
    firstCloseOperationId: optional(row.close_operation_id),
    firstCloseCause: row.first_close_cause ?? undefined,
    closedAtMs: optional(row.closed_at_ms),
    disposition: row.disposition ?? undefined,
    expiresAtMs: optional(row.expires_at_ms),
    transcriptRelativePath: optional(row.transcript_relative_path),
    cleanupOperationId: optional(row.cleanup_operation_id),
    cleanupState: row.cleanup_state,
    cleanupStartedAtMs: optional(row.cleanup_started_at_ms),
    cleanupError: optional(row.cleanup_error),
    deletedAtMs: optional(row.deleted_at_ms),
    writeEpoch: Number(row.write_epoch),
    updatedAtMs: row.updated_at_ms,
  };
}

function toArtifact(row: ArtifactRow): LifecycleArtifactRecord {
  return {
    sessionId: row.session_id,
    artifactId: row.artifact_id,
    kind: row.kind,
    locationKind: row.location_kind,
    location: row.location,
    rootName: optional(row.root_name),
    identityJson: optional(row.identity_json),
    state: row.state,
    cleanupOperationId: optional(row.cleanup_operation_id),
    cleanupError: optional(row.cleanup_error),
    updatedAtMs: row.updated_at_ms,
  };
}

function toAnalyticsHost(row: AnalyticsHostRow): AnalyticsHostRecord {
  let capabilities: string[];
  try {
    const parsed = JSON.parse(row.capabilities_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error('capabilities are not a string array');
    }
    capabilities = [...new Set(parsed)].sort();
  } catch {
    throw new SessionLifecycleConflictError(`Analytics host ${row.host_instance_id} has corrupt capability evidence.`);
  }
  return {
    hostInstanceId: row.host_instance_id,
    workspaceId: row.workspace_id,
    generationId: row.generation_id,
    buildId: row.build_id,
    processId: Number(row.process_id),
    ...(row.endpoint_name ? { endpointName: row.endpoint_name } : {}),
    capabilities,
    state: row.state,
    registeredAtMs: row.registered_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    ...(row.stopped_at_ms ? { stoppedAtMs: row.stopped_at_ms } : {}),
    ...(row.unsupported_reason ? { unsupportedReason: row.unsupported_reason } : {}),
    updatedAtMs: row.updated_at_ms,
  };
}

function toWriterAcknowledgement(row: AnalyticsWriterFenceAckRow): AnalyticsWriterFenceAcknowledgement {
  return {
    workspaceId: row.workspace_id,
    operationId: row.operation_id,
    fenceEpoch: Number(row.fence_epoch),
    identity: requireWriterIdentity({
      hostInstanceId: row.host_instance_id,
      workspaceId: row.workspace_id,
      generationId: row.generation_id,
      buildId: row.build_id,
      processId: Number(row.process_id),
    }, 'Analytics writer acknowledgement identity'),
    activeWriterCount: Number(row.active_writer_count),
    acknowledgedAtMs: row.acknowledged_at_ms,
  };
}

function toWriterLease(row: AnalyticsWriterLeaseRow): AnalyticsWriterLeaseRecord {
  return {
    leaseId: row.lease_id,
    ...requireWriterIdentity({
      hostInstanceId: row.host_instance_id,
      workspaceId: row.workspace_id,
      generationId: row.generation_id,
      buildId: row.build_id,
      processId: Number(row.process_id),
    }, 'Analytics writer lease identity'),
    fenceEpoch: Number(row.fence_epoch),
    acquiredAtMs: row.acquired_at_ms,
  };
}

export function sessionRetentionDeadline(closedAtMs: Int64Value): string {
  return (parseInt64(closedAtMs, 'closedAtMs') + DAY_MS).toString();
}

/** Normalize a lifecycle-owned path. It is deliberately stricter than
 * path.normalize: persisted root-relative locations never contain `..`, a
 * drive/UNC prefix, an empty segment, or platform-dependent separators. */
export function normalizeLifecycleRelativePath(value: string): string {
  if (!value || value.includes('\u0000') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('Lifecycle artifact path must be non-empty and root-relative.');
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Lifecycle artifact path must not contain empty, dot, or parent segments.');
  }
  return segments.join('/');
}

export class SessionLifecycleConflictError extends Error {
  readonly code = 'SESSION_LIFECYCLE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'SessionLifecycleConflictError';
  }
}

export class SessionWriteRevokedError extends Error {
  readonly code = 'SESSION_WRITE_REVOKED';

  constructor(readonly sessionId: string, readonly writeEpoch: number, reason: string) {
    super(`Writes are revoked for session ${sessionId} at epoch ${writeEpoch}: ${reason}`);
    this.name = 'SessionWriteRevokedError';
  }
}

/** Durable single-writer lifecycle authority. The SQLite file is shared by
 * coordinator and worker processes. Filesystem mutation serialization itself
 * is supplied by SessionFilesystemMutationBarrier; every write must re-read
 * this store while holding that barrier. */
export class SessionLifecycleStore {
  private readonly database: DatabaseCompat;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseCompat(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const version = Number((this.database.pragma('user_version', { simple: true }) as number | bigint));
    if (version > ADDITIVE_HOST_REGISTRY_VERSION) {
      throw new Error(`Unsupported session lifecycle schema version ${version}.`);
    }
    // An earlier development build briefly encoded the additive host table as
    // lifecycle schema v4. It changed no lifecycle columns, so normalize that
    // marker back to v3 before an older host can reopen the shared database.
    if (version === ADDITIVE_HOST_REGISTRY_VERSION) this.database.exec('PRAGMA user_version = 3');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_lifecycle (
        session_id TEXT PRIMARY KEY,
        privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('off', 'on')),
        pending_create_operation_id TEXT UNIQUE,
        close_operation_id TEXT UNIQUE,
        first_close_cause TEXT CHECK (first_close_cause IN ('user_close', 'private_close', 'forget', 'expiry')),
        closed_at_ms TEXT,
        disposition TEXT CHECK (disposition IN ('retain', 'delete')),
        expires_at_ms TEXT,
        transcript_relative_path TEXT,
        cleanup_operation_id TEXT UNIQUE,
        cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('open', 'retained', 'deleting', 'deleted', 'blocked')),
        cleanup_started_at_ms TEXT,
        cleanup_error TEXT,
        deleted_at_ms TEXT,
        write_epoch INTEGER NOT NULL,
        updated_at_ms TEXT NOT NULL,
        CHECK ((closed_at_ms IS NULL) = (disposition IS NULL)),
        CHECK (expires_at_ms IS NULL OR disposition = 'retain')
      );
    `);
    if (version === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE session_lifecycle RENAME TO session_lifecycle_v1;
        CREATE TABLE session_lifecycle (
          session_id TEXT PRIMARY KEY,
          privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('off', 'on')),
          pending_create_operation_id TEXT UNIQUE,
          close_operation_id TEXT UNIQUE,
          first_close_cause TEXT CHECK (first_close_cause IN ('user_close', 'private_close', 'forget', 'expiry')),
          closed_at_ms TEXT,
          disposition TEXT CHECK (disposition IN ('retain', 'delete')),
          expires_at_ms TEXT,
          transcript_relative_path TEXT,
          cleanup_operation_id TEXT UNIQUE,
          cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('open', 'retained', 'deleting', 'deleted', 'blocked')),
          cleanup_started_at_ms TEXT,
          cleanup_error TEXT,
          deleted_at_ms TEXT,
          write_epoch INTEGER NOT NULL,
          updated_at_ms TEXT NOT NULL,
          CHECK ((closed_at_ms IS NULL) = (disposition IS NULL)),
          CHECK (expires_at_ms IS NULL OR disposition = 'retain')
        );
        INSERT INTO session_lifecycle (
          session_id, privacy_mode, pending_create_operation_id, close_operation_id, first_close_cause,
          closed_at_ms, disposition, expires_at_ms, cleanup_operation_id,
          cleanup_state, cleanup_started_at_ms, deleted_at_ms, write_epoch, updated_at_ms
        )
        SELECT
          session_id, privacy_mode, NULL, first_close_operation_id,
          CASE WHEN closed_at_ms IS NULL THEN NULL WHEN disposition = 'delete' THEN 'private_close' ELSE 'user_close' END,
          CAST(closed_at_ms AS TEXT), disposition, CAST(expires_at_ms AS TEXT),
          CASE WHEN cleanup_state = 'deleting' THEN first_close_operation_id ELSE NULL END,
          CASE WHEN closed_at_ms IS NULL THEN 'open' ELSE cleanup_state END,
          CASE WHEN cleanup_state = 'deleting' THEN CAST(closed_at_ms AS TEXT) ELSE NULL END,
          CAST(deleted_at_ms AS TEXT), write_epoch, CAST(privacy_updated_at_ms AS TEXT)
        FROM session_lifecycle_v1;
        DROP TABLE session_lifecycle_v1;
        COMMIT;
      `);
    }
    if (version === 2) {
      this.database.exec(`
        ALTER TABLE session_lifecycle ADD COLUMN pending_create_operation_id TEXT;
      `);
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_lifecycle_pending_create_operation
        ON session_lifecycle(pending_create_operation_id) WHERE pending_create_operation_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_lifecycle_cleanup_operation
        ON session_lifecycle(cleanup_operation_id) WHERE cleanup_operation_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS session_lifecycle_artifacts (
        session_id TEXT NOT NULL REFERENCES session_lifecycle(session_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('transcript', 'session_sidecar', 'managed_cache', 'external_reference')),
        location_kind TEXT NOT NULL CHECK (location_kind IN ('root_relative', 'fixed_absolute', 'external')),
        location TEXT NOT NULL,
        root_name TEXT,
        identity_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('present', 'deleting', 'deleted', 'missing', 'blocked')),
        cleanup_operation_id TEXT,
        cleanup_error TEXT,
        updated_at_ms TEXT NOT NULL,
        PRIMARY KEY (session_id, artifact_id),
        CHECK ((location_kind = 'root_relative') = (root_name IS NOT NULL)),
        CHECK (kind = 'external_reference' OR location_kind != 'external')
      );
      CREATE INDEX IF NOT EXISTS session_lifecycle_due ON session_lifecycle(cleanup_state, expires_at_ms);
      CREATE INDEX IF NOT EXISTS session_lifecycle_artifact_cleanup ON session_lifecycle_artifacts(session_id, state);
      CREATE TABLE IF NOT EXISTS analytics_hosts (
        host_instance_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        process_id INTEGER NOT NULL CHECK (process_id > 0),
        endpoint_name TEXT,
        capabilities_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('registered', 'stopping', 'stopped', 'unsupported')),
        registered_at_ms TEXT NOT NULL,
        heartbeat_at_ms TEXT NOT NULL,
        stopped_at_ms TEXT,
        unsupported_reason TEXT,
        updated_at_ms TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analytics_hosts_workspace ON analytics_hosts(workspace_id, state, host_instance_id);
      CREATE INDEX IF NOT EXISTS analytics_hosts_workspace_host ON analytics_hosts(workspace_id, host_instance_id);
      /* This is handoff operation state beside the existing host registry, not
       * a second registry. A fence row is the durable admission-revocation
       * point; acknowledgements and short-lived writer leases are evidence for
       * that row. */
      CREATE TABLE IF NOT EXISTS analytics_writer_fences (
        workspace_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK (purpose IN ('analytics-activation', 'storage-cutoff')),
        fence_epoch INTEGER NOT NULL CHECK (fence_epoch > 0),
        state TEXT NOT NULL CHECK (state IN ('open', 'fencing', 'fenced')),
        expected_hosts_json TEXT NOT NULL,
        expected_hosts_sha256 TEXT NOT NULL,
        started_at_ms TEXT NOT NULL,
        updated_at_ms TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics_writer_fence_acks (
        workspace_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        host_instance_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        process_id INTEGER NOT NULL CHECK (process_id > 0),
        fence_epoch INTEGER NOT NULL CHECK (fence_epoch > 0),
        active_writer_count INTEGER NOT NULL CHECK (active_writer_count >= 0),
        acknowledged_at_ms TEXT NOT NULL,
        PRIMARY KEY (workspace_id, operation_id, host_instance_id)
      );
      CREATE INDEX IF NOT EXISTS analytics_writer_fence_acks_operation
        ON analytics_writer_fence_acks(workspace_id, operation_id, host_instance_id);
      CREATE TABLE IF NOT EXISTS analytics_writer_leases (
        lease_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        host_instance_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        process_id INTEGER NOT NULL CHECK (process_id > 0),
        fence_epoch INTEGER NOT NULL CHECK (fence_epoch >= 0),
        acquired_at_ms TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS analytics_writer_leases_workspace
        ON analytics_writer_leases(workspace_id, fence_epoch, host_instance_id);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  close(): void {
    this.database.close();
  }

  /** Register one host identity in the existing lifecycle authority. This is
   * discovery/status evidence only: callers must reconcile it with runtime
   * leases and process ownership before claiming an all-host fence. */
  registerAnalyticsHost(
    host: Omit<AnalyticsHostRecord, 'state' | 'heartbeatAtMs' | 'updatedAtMs'> & {
      state?: AnalyticsHostState;
      heartbeatAtMs?: Int64Value;
      updatedAtMs?: Int64Value;
    },
  ): AnalyticsHostRecord {
    const hostInstanceId = requireHostField(host.hostInstanceId, 'hostInstanceId');
    const workspaceId = requireHostField(host.workspaceId, 'workspaceId');
    const generationId = requireHostField(host.generationId, 'generationId');
    const buildId = requireHostField(host.buildId, 'buildId');
    if (!Number.isSafeInteger(host.processId) || host.processId <= 0) {
      throw new Error('Analytics host processId must be a positive safe integer.');
    }
    const endpointName = host.endpointName ? requireHostField(host.endpointName, 'endpointName', 256) : undefined;
    const capabilitiesJson = encodeHostCapabilities(host.capabilities);
    const registeredAtMs = encodeTimestamp(host.registeredAtMs, 'registeredAtMs');
    const heartbeatAtMs = encodeTimestamp(host.heartbeatAtMs ?? host.registeredAtMs, 'heartbeatAtMs');
    const updatedAtMs = encodeTimestamp(host.updatedAtMs ?? host.registeredAtMs, 'updatedAtMs');
    const state = host.state ?? 'registered';
    if (state !== 'registered' && state !== 'unsupported') {
      throw new Error(`Analytics host registration state ${state} is not admissible.`);
    }
    const unsupportedReason = host.unsupportedReason
      ? requireHostField(host.unsupportedReason, 'unsupportedReason', 1_024)
      : undefined;
    return this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
        .get(hostInstanceId) as AnalyticsHostRow | undefined;
      if (existing && (existing.workspace_id !== workspaceId
        || existing.generation_id !== generationId
        || existing.build_id !== buildId
        || Number(existing.process_id) !== host.processId)) {
        throw new SessionLifecycleConflictError(`Analytics host ${hostInstanceId} is bound to another process identity.`);
      }
      if (existing?.state === 'stopped') {
        throw new SessionLifecycleConflictError(`Analytics host ${hostInstanceId} is terminal and cannot be re-registered.`);
      }
      const activeFence = this.database.prepare(`
        SELECT state FROM analytics_writer_fences WHERE workspace_id = ?
      `).get(workspaceId) as { state: AnalyticsWriterFenceState } | undefined;
      if (activeFence && activeFence.state !== 'open') {
        throw new SessionLifecycleConflictError('Analytics host registration is closed while a writer fence is active.');
      }
      this.database.prepare(`
        INSERT INTO analytics_hosts (
          host_instance_id, workspace_id, generation_id, build_id, process_id, endpoint_name,
          capabilities_json, state, registered_at_ms, heartbeat_at_ms, stopped_at_ms,
          unsupported_reason, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(host_instance_id) DO UPDATE SET
          endpoint_name = excluded.endpoint_name,
          capabilities_json = excluded.capabilities_json,
          state = excluded.state,
          heartbeat_at_ms = excluded.heartbeat_at_ms,
          stopped_at_ms = NULL,
          unsupported_reason = excluded.unsupported_reason,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        hostInstanceId, workspaceId, generationId, buildId, host.processId, endpointName ?? null,
        capabilitiesJson, state, registeredAtMs, heartbeatAtMs, unsupportedReason ?? null, updatedAtMs,
      );
      return toAnalyticsHost(this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
        .get(hostInstanceId) as AnalyticsHostRow);
    })();
  }

  heartbeatAnalyticsHost(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    nowMs: Int64Value,
  ): AnalyticsHostRecord {
    requireHostField(hostInstanceId, 'hostInstanceId');
    requireHostField(generationId, 'generationId');
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Analytics host processId is invalid.');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    const result = this.database.prepare(`
      UPDATE analytics_hosts SET heartbeat_at_ms = ?, stopped_at_ms = NULL, updated_at_ms = ?
      WHERE host_instance_id = ? AND process_id = ? AND generation_id = ?
        AND state IN ('registered', 'unsupported')
    `).run(encodedNow, encodedNow, hostInstanceId, processId, generationId);
    if (Number(result.changes) !== 1) throw new SessionLifecycleConflictError(`Analytics host ${hostInstanceId} heartbeat identity is stale.`);
    return toAnalyticsHost(this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
      .get(hostInstanceId) as AnalyticsHostRow);
  }

  markAnalyticsHostState(
    hostInstanceId: string,
    processId: number,
    generationId: string,
    state: Extract<AnalyticsHostState, 'stopping' | 'stopped'>,
    nowMs: Int64Value,
  ): AnalyticsHostRecord {
    requireHostField(hostInstanceId, 'hostInstanceId');
    requireHostField(generationId, 'generationId');
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Analytics host processId is invalid.');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    const result = this.database.prepare(`
      UPDATE analytics_hosts SET state = ?, heartbeat_at_ms = ?, stopped_at_ms = CASE WHEN ? = 'stopped' THEN ? ELSE stopped_at_ms END,
        updated_at_ms = ?
      WHERE host_instance_id = ? AND process_id = ? AND generation_id = ? AND state != 'stopped'
    `).run(state, encodedNow, state, encodedNow, encodedNow, hostInstanceId, processId, generationId);
    if (Number(result.changes) !== 1) throw new SessionLifecycleConflictError(`Analytics host ${hostInstanceId} state identity is stale.`);
    return toAnalyticsHost(this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
      .get(hostInstanceId) as AnalyticsHostRow);
  }

  getAnalyticsHost(hostInstanceId: string): AnalyticsHostRecord | undefined {
    requireHostField(hostInstanceId, 'hostInstanceId');
    const row = this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
      .get(hostInstanceId) as AnalyticsHostRow | undefined;
    return row ? toAnalyticsHost(row) : undefined;
  }

  listAnalyticsHosts(
    workspaceId: string,
    options: { limit?: number; cursor?: string } = {},
  ): AnalyticsHostPage {
    requireHostField(workspaceId, 'workspaceId');
    const requestedLimit = options.limit ?? ANALYTICS_HANDOFF_MAX_STATUS_HOSTS;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1
      || requestedLimit > ANALYTICS_HANDOFF_MAX_STATUS_HOSTS) {
      throw new Error('Analytics host page limit is invalid.');
    }
    const cursor = options.cursor === undefined
      ? undefined : requireHostField(options.cursor, 'host cursor', 256);
    const rows = (cursor === undefined
      ? this.database.prepare(`
          SELECT * FROM analytics_hosts WHERE workspace_id = ? ORDER BY host_instance_id LIMIT ?
        `).all(workspaceId, requestedLimit + 1)
      : this.database.prepare(`
          SELECT * FROM analytics_hosts
          WHERE workspace_id = ? AND host_instance_id > ?
          ORDER BY host_instance_id LIMIT ?
        `).all(workspaceId, cursor, requestedLimit + 1)) as AnalyticsHostRow[];
    const truncated = rows.length > requestedLimit;
    const pageRows = truncated ? rows.slice(0, requestedLimit) : rows;
    const hosts = pageRows.map(toAnalyticsHost);
    return {
      hosts,
      truncated,
      ...(truncated && hosts.length > 0 ? { nextCursor: hosts[hosts.length - 1]!.hostInstanceId } : {}),
    };
  }

  /** Return the current durable writer-admission epoch. No fence row means
   * the initial admission generation is open at epoch zero. */
  getAnalyticsWriterAdmissionState(workspaceId: string): AnalyticsWriterAdmissionState {
    const normalizedWorkspaceId = requireHostField(workspaceId, 'workspaceId');
    const row = this.database.prepare(`
      SELECT workspace_id, fence_epoch, state FROM analytics_writer_fences WHERE workspace_id = ?
    `).get(normalizedWorkspaceId) as Pick<AnalyticsWriterFenceRow, 'workspace_id' | 'fence_epoch' | 'state'> | undefined;
    return row
      ? { workspaceId: row.workspace_id, fenceEpoch: Number(row.fence_epoch), state: row.state }
      : { workspaceId: normalizedWorkspaceId, fenceEpoch: 0, state: 'open' };
  }

  /** Begin or resume one durable all-host writer fence. The registry snapshot
   * is checked in the same transaction as admission revocation, so a census
   * cannot authorize a fence for a host identity that changed underneath it. */
  beginAnalyticsWriterFence(options: BeginAnalyticsWriterFenceOptions): AnalyticsWriterFenceRecord {
    const workspaceId = requireHostField(options.workspaceId, 'workspaceId');
    const operationId = requireHostField(options.operationId, 'operationId');
    if (options.purpose !== 'analytics-activation' && options.purpose !== 'storage-cutoff') {
      throw new Error('Analytics writer fence purpose is invalid.');
    }
    const expectedHosts = canonicalWriterHosts(options.expectedHosts);
    if (expectedHosts.some((host) => host.workspaceId !== workspaceId)) {
      throw new SessionLifecycleConflictError('Analytics writer census contains another workspace.');
    }
    const expectedHostsJson = writerHostsSerialization(expectedHosts);
    const expectedHostsSha256 = writerHostsDigest(expectedHosts);
    const nowMs = encodeTimestamp(options.nowMs, 'nowMs');
    return this.database.transaction(() => {
      this.assertWriterRegistrySnapshot(workspaceId, expectedHosts);
      const existing = this.database.prepare(`
        SELECT * FROM analytics_writer_fences WHERE workspace_id = ?
      `).get(workspaceId) as AnalyticsWriterFenceRow | undefined;
      if (existing) {
        if (existing.state !== 'open') {
          if (existing.operation_id !== operationId
            || existing.purpose !== options.purpose
            || existing.expected_hosts_sha256 !== expectedHostsSha256) {
            throw new SessionLifecycleConflictError(
              `Analytics writer fence ${existing.operation_id} is already ${existing.state}; refusing a competing fence.`,
            );
          }
          return this.toWriterFenceRecord(existing);
        }
        const fenceEpoch = existing.operation_id === operationId ? Number(existing.fence_epoch) : Number(existing.fence_epoch) + 1;
        if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch <= 0) {
          throw new SessionLifecycleConflictError('Analytics writer fence epoch is exhausted.');
        }
        this.database.prepare(`
          DELETE FROM analytics_writer_fence_acks WHERE workspace_id = ? AND operation_id = ?
        `).run(workspaceId, operationId);
        this.database.prepare(`
          UPDATE analytics_writer_fences
          SET operation_id = ?, purpose = ?, fence_epoch = ?, state = 'fencing',
              expected_hosts_json = ?, expected_hosts_sha256 = ?, updated_at_ms = ?
          WHERE workspace_id = ?
        `).run(
          operationId, options.purpose, fenceEpoch, expectedHostsJson, expectedHostsSha256, nowMs, workspaceId,
        );
      } else {
        const operationOwner = this.database.prepare(`
          SELECT workspace_id FROM analytics_writer_fences WHERE operation_id = ?
        `).get(operationId) as { workspace_id: string } | undefined;
        if (operationOwner) {
          throw new SessionLifecycleConflictError(`Analytics writer operation ${operationId} is already bound to another workspace.`);
        }
        this.database.prepare(`
          INSERT INTO analytics_writer_fences (
            workspace_id, operation_id, purpose, fence_epoch, state,
            expected_hosts_json, expected_hosts_sha256, started_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 1, 'fencing', ?, ?, ?, ?)
        `).run(
          workspaceId, operationId, options.purpose, expectedHostsJson, expectedHostsSha256, nowMs, nowMs,
        );
      }
      return this.toWriterFenceRecord(this.database.prepare(`
        SELECT * FROM analytics_writer_fences WHERE workspace_id = ?
      `).get(workspaceId) as AnalyticsWriterFenceRow);
    })();
  }

  getAnalyticsWriterFence(workspaceId: string): AnalyticsWriterFenceRecord | undefined {
    const normalizedWorkspaceId = requireHostField(workspaceId, 'workspaceId');
    const row = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
      .get(normalizedWorkspaceId) as AnalyticsWriterFenceRow | undefined;
    return row ? this.toWriterFenceRecord(row) : undefined;
  }

  listAnalyticsWriterFenceAcknowledgements(
    workspaceId: string,
    operationId: string,
  ): AnalyticsWriterFenceAcknowledgement[] {
    const normalizedWorkspaceId = requireHostField(workspaceId, 'workspaceId');
    const normalizedOperationId = requireHostField(operationId, 'operationId');
    const rows = this.database.prepare(`
      SELECT * FROM analytics_writer_fence_acks
      WHERE workspace_id = ? AND operation_id = ? ORDER BY host_instance_id
    `).all(normalizedWorkspaceId, normalizedOperationId) as AnalyticsWriterFenceAckRow[];
    return rows.map(toWriterAcknowledgement);
  }

  /** Record one authenticated host acknowledgement. Repeating the exact ack
   * is idempotent; a conflicting ack for the same identity is not. */
  acknowledgeAnalyticsWriterFence(
    options: AcknowledgeAnalyticsWriterFenceOptions,
  ): AnalyticsWriterFenceAcknowledgement {
    const workspaceId = requireHostField(options.workspaceId, 'workspaceId');
    const operationId = requireHostField(options.operationId, 'operationId');
    const identity = requireWriterIdentity(options.identity, 'Analytics writer acknowledgement identity');
    if (identity.workspaceId !== workspaceId) throw new SessionLifecycleConflictError('Writer acknowledgement workspace does not match the fence.');
    if (!Number.isSafeInteger(options.fenceEpoch) || options.fenceEpoch <= 0) {
      throw new Error('Analytics writer acknowledgement epoch is invalid.');
    }
    if (!Number.isSafeInteger(options.activeWriterCount) || options.activeWriterCount < 0) {
      throw new Error('Analytics writer acknowledgement active count is invalid.');
    }
    const acknowledgedAtMs = encodeTimestamp(options.nowMs, 'nowMs');
    return this.database.transaction(() => {
      const fence = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(workspaceId) as AnalyticsWriterFenceRow | undefined;
      if (!fence || fence.operation_id !== operationId || (fence.state !== 'fencing' && fence.state !== 'fenced')) {
        throw new SessionLifecycleConflictError('Analytics writer fence is missing, open, or owned by another operation.');
      }
      if (Number(fence.fence_epoch) !== options.fenceEpoch) {
        throw new SessionLifecycleConflictError('Analytics writer acknowledgement epoch is stale.');
      }
      const expectedHosts = parseWriterHosts(fence.expected_hosts_json, fence.expected_hosts_sha256);
      const expected = expectedHosts.find((host) => host.hostInstanceId === identity.hostInstanceId);
      if (!expected || !sameWriterIdentity(expected, identity)) {
        throw new SessionLifecycleConflictError('Analytics writer acknowledgement identity is not in the frozen census.');
      }
      this.assertRegisteredWriterIdentity(identity);
      const existing = this.database.prepare(`
        SELECT * FROM analytics_writer_fence_acks
        WHERE workspace_id = ? AND operation_id = ? AND host_instance_id = ?
      `).get(workspaceId, operationId, identity.hostInstanceId) as AnalyticsWriterFenceAckRow | undefined;
      if (existing) {
        const prior = toWriterAcknowledgement(existing);
        if (prior.fenceEpoch !== options.fenceEpoch
          || !sameWriterIdentity(prior.identity, identity)
          || prior.activeWriterCount !== options.activeWriterCount) {
          throw new SessionLifecycleConflictError('Analytics writer acknowledgement conflicts with durable evidence.');
        }
        return prior;
      }
      this.database.prepare(`
        INSERT INTO analytics_writer_fence_acks (
          workspace_id, operation_id, host_instance_id, generation_id, build_id,
          process_id, fence_epoch, active_writer_count, acknowledged_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspaceId, operationId, identity.hostInstanceId, identity.generationId, identity.buildId,
        identity.processId, options.fenceEpoch, options.activeWriterCount, acknowledgedAtMs,
      );
      return toWriterAcknowledgement(this.database.prepare(`
        SELECT * FROM analytics_writer_fence_acks
        WHERE workspace_id = ? AND operation_id = ? AND host_instance_id = ?
      `).get(workspaceId, operationId, identity.hostInstanceId) as AnalyticsWriterFenceAckRow);
    })();
  }

  /** Complete a fence only after every frozen host has acknowledged zero local
   * writers and every durable writer lease has been released. */
  completeAnalyticsWriterFence(
    workspaceId: string,
    operationId: string,
    nowMs: Int64Value = Date.now(),
  ): AnalyticsWriterFenceRecord {
    const normalizedWorkspaceId = requireHostField(workspaceId, 'workspaceId');
    const normalizedOperationId = requireHostField(operationId, 'operationId');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      const fence = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(normalizedWorkspaceId) as AnalyticsWriterFenceRow | undefined;
      if (!fence || fence.operation_id !== normalizedOperationId || (fence.state !== 'fencing' && fence.state !== 'fenced')) {
        throw new SessionLifecycleConflictError('Analytics writer fence is missing, open, or owned by another operation.');
      }
      const expectedHosts = parseWriterHosts(fence.expected_hosts_json, fence.expected_hosts_sha256);
      const acknowledgements = this.database.prepare(`
        SELECT * FROM analytics_writer_fence_acks
        WHERE workspace_id = ? AND operation_id = ? ORDER BY host_instance_id
      `).all(normalizedWorkspaceId, normalizedOperationId) as AnalyticsWriterFenceAckRow[];
      const acknowledgementsByHost = new Map(acknowledgements.map((ack) => [ack.host_instance_id, ack] as const));
      if (acknowledgements.length !== expectedHosts.length
        || expectedHosts.some((host) => !acknowledgementsByHost.has(host.hostInstanceId))) {
        throw new SessionLifecycleConflictError('Analytics writer fence acknowledgements are incomplete.');
      }
      const expectedByHost = new Map(expectedHosts.map((host) => [host.hostInstanceId, host] as const));
      for (const row of acknowledgements) {
        const acknowledgement = toWriterAcknowledgement(row);
        const expected = expectedByHost.get(acknowledgement.identity.hostInstanceId);
        if (!expected || !sameWriterIdentity(expected, acknowledgement.identity)) {
          throw new SessionLifecycleConflictError('Analytics writer fence acknowledgement identity is invalid.');
        }
      }
      if (acknowledgements.some((ack) => Number(ack.fence_epoch) !== Number(fence.fence_epoch)
        || Number(ack.active_writer_count) !== 0)) {
        throw new SessionLifecycleConflictError('Analytics writer fence still has an active host writer.');
      }
      if (this.countActiveWriterLeases(normalizedWorkspaceId) !== 0) {
        throw new SessionLifecycleConflictError('Analytics writer durable leases are still active.');
      }
      if (fence.state === 'fencing') {
        this.database.prepare(`
          UPDATE analytics_writer_fences SET state = 'fenced', updated_at_ms = ? WHERE workspace_id = ?
        `).run(encodedNow, normalizedWorkspaceId);
      }
      return this.toWriterFenceRecord(this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(normalizedWorkspaceId) as AnalyticsWriterFenceRow);
    })();
  }

  /** Re-open admission only as an explicit analytics-activation routing step.
   * Advance the fence epoch so writers from the old admission generation
   * remain stale; storage-cutoff fences are never re-opened by this method. */
  reopenAnalyticsWriterAdmission(options: ReopenAnalyticsWriterAdmissionOptions): AnalyticsWriterAdmissionState {
    const workspaceId = requireHostField(options.workspaceId, 'workspaceId');
    const operationId = requireHostField(options.operationId, 'operationId');
    const nowMs = encodeTimestamp(options.nowMs, 'nowMs');
    return this.database.transaction(() => {
      const fence = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(workspaceId) as AnalyticsWriterFenceRow | undefined;
      if (!fence || fence.operation_id !== operationId || fence.purpose !== options.purpose || fence.state !== 'fenced') {
        throw new SessionLifecycleConflictError('Only a completed analytics-activation fence can reopen admission.');
      }
      if (this.countActiveWriterLeases(workspaceId) !== 0) {
        throw new SessionLifecycleConflictError('Cannot reopen analytics writer admission while a writer lease is active.');
      }
      const nextFenceEpoch = Number(fence.fence_epoch) + 1;
      if (!Number.isSafeInteger(nextFenceEpoch) || nextFenceEpoch <= 0) {
        throw new SessionLifecycleConflictError('Analytics writer fence epoch is exhausted.');
      }
      this.database.prepare(`
        DELETE FROM analytics_writer_fence_acks WHERE workspace_id = ? AND operation_id = ?
      `).run(workspaceId, operationId);
      this.database.prepare(`UPDATE analytics_writer_fences SET fence_epoch = ?, state = 'open', updated_at_ms = ? WHERE workspace_id = ?`)
        .run(nextFenceEpoch, nowMs, workspaceId);
      return { workspaceId, state: 'open' as const, fenceEpoch: nextFenceEpoch };
    })();
  }

  /** Acquire a short-lived durable admission lease. The caller must supply
   * the epoch it observed before entering its mutation, so an old writer
   * cannot become admissible again after an explicit analytics reopen. */
  acquireAnalyticsWriterLease(
    identity: AnalyticsWriterIdentity,
    expectedFenceEpoch: number,
    nowMs: Int64Value,
  ): AnalyticsWriterLeaseRecord {
    const normalizedIdentity = requireWriterIdentity(identity, 'Analytics writer identity');
    if (!Number.isSafeInteger(expectedFenceEpoch) || expectedFenceEpoch < 0) {
      throw new Error('Analytics writer admission epoch is invalid.');
    }
    const acquiredAtMs = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      this.assertRegisteredWriterIdentity(normalizedIdentity);
      const admission = this.getAnalyticsWriterAdmissionState(normalizedIdentity.workspaceId);
      if (admission.state !== 'open' || admission.fenceEpoch !== expectedFenceEpoch) {
        throw new SessionLifecycleConflictError(
          `Analytics writer admission is ${admission.state} at epoch ${admission.fenceEpoch}; expected open epoch ${expectedFenceEpoch}.`,
        );
      }
      const fence = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(normalizedIdentity.workspaceId) as AnalyticsWriterFenceRow | undefined;
      if (fence) {
        const expectedHosts = parseWriterHosts(fence.expected_hosts_json, fence.expected_hosts_sha256);
        if (!expectedHosts.some((host) => sameWriterIdentity(host, normalizedIdentity))) {
          throw new SessionLifecycleConflictError('Analytics writer identity is outside the current admission census.');
        }
      }
      if (this.countActiveWriterLeases(normalizedIdentity.workspaceId) >= MAX_ANALYTICS_WRITER_LEASES) {
        throw new SessionLifecycleConflictError('Analytics writer admission lease capacity is exhausted.');
      }
      const leaseId = randomUUID();
      this.database.prepare(`
        INSERT INTO analytics_writer_leases (
          lease_id, workspace_id, host_instance_id, generation_id, build_id,
          process_id, fence_epoch, acquired_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leaseId, normalizedIdentity.workspaceId, normalizedIdentity.hostInstanceId,
        normalizedIdentity.generationId, normalizedIdentity.buildId, normalizedIdentity.processId,
        expectedFenceEpoch, acquiredAtMs,
      );
      return toWriterLease(this.database.prepare('SELECT * FROM analytics_writer_leases WHERE lease_id = ?')
        .get(leaseId) as AnalyticsWriterLeaseRow);
    })();
  }

  /** Synchronous admission assertion for ownership/session-manager mutation
   * seams. It never authorizes a writer by registry presence alone. */
  assertAnalyticsWriterAdmitted(identity: AnalyticsWriterIdentity, expectedFenceEpoch: number): void {
    const normalizedIdentity = requireWriterIdentity(identity, 'Analytics writer identity');
    if (!Number.isSafeInteger(expectedFenceEpoch) || expectedFenceEpoch < 0) {
      throw new Error('Analytics writer admission epoch is invalid.');
    }
    this.database.transaction(() => {
      this.assertRegisteredWriterIdentity(normalizedIdentity);
      const admission = this.getAnalyticsWriterAdmissionState(normalizedIdentity.workspaceId);
      if (admission.state !== 'open' || admission.fenceEpoch !== expectedFenceEpoch) {
        throw new SessionLifecycleConflictError(
          `Analytics writer admission is ${admission.state} at epoch ${admission.fenceEpoch}; expected open epoch ${expectedFenceEpoch}.`,
        );
      }
      const fence = this.database.prepare('SELECT * FROM analytics_writer_fences WHERE workspace_id = ?')
        .get(normalizedIdentity.workspaceId) as AnalyticsWriterFenceRow | undefined;
      if (fence) {
        const expectedHosts = parseWriterHosts(fence.expected_hosts_json, fence.expected_hosts_sha256);
        if (!expectedHosts.some((host) => sameWriterIdentity(host, normalizedIdentity))) {
          throw new SessionLifecycleConflictError('Analytics writer identity is outside the current admission census.');
        }
      }
    })();
  }

  releaseAnalyticsWriterLease(lease: AnalyticsWriterLeaseRecord): void {
    const leaseId = requireHostField(lease.leaseId, 'Analytics writer leaseId');
    const identity = requireWriterIdentity(lease, 'Analytics writer lease identity');
    this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM analytics_writer_leases WHERE lease_id = ?')
        .get(leaseId) as AnalyticsWriterLeaseRow | undefined;
      if (!existing) return;
      const prior = toWriterLease(existing);
      if (!sameWriterIdentity(prior, identity) || prior.fenceEpoch !== lease.fenceEpoch) {
        throw new SessionLifecycleConflictError('Analytics writer lease identity is stale.');
      }
      this.database.prepare('DELETE FROM analytics_writer_leases WHERE lease_id = ?').run(leaseId);
    })();
  }

  listAnalyticsWriterLeases(workspaceId: string): AnalyticsWriterLeaseRecord[] {
    const normalizedWorkspaceId = requireHostField(workspaceId, 'workspaceId');
    const rows = this.database.prepare(`
      SELECT * FROM analytics_writer_leases WHERE workspace_id = ? ORDER BY lease_id LIMIT ?
    `).all(normalizedWorkspaceId, MAX_ANALYTICS_WRITER_LEASES + 1) as AnalyticsWriterLeaseRow[];
    if (rows.length > MAX_ANALYTICS_WRITER_LEASES) {
      throw new SessionLifecycleConflictError('Analytics writer lease census is truncated.');
    }
    return rows.map(toWriterLease);
  }

  private countActiveWriterLeases(workspaceId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM analytics_writer_leases WHERE workspace_id = ?
    `).get(workspaceId) as { count: number | bigint };
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ANALYTICS_WRITER_LEASES) {
      throw new SessionLifecycleConflictError('Analytics writer lease count is invalid or exceeds the bound.');
    }
    return count;
  }

  private assertRegisteredWriterIdentity(identity: AnalyticsWriterIdentity): void {
    const row = this.database.prepare('SELECT * FROM analytics_hosts WHERE host_instance_id = ?')
      .get(identity.hostInstanceId) as AnalyticsHostRow | undefined;
    if (!row) throw new SessionLifecycleConflictError(`Analytics writer host ${identity.hostInstanceId} is not registered.`);
    const host = toAnalyticsHost(row);
    if (!sameWriterIdentity(writerIdentityFromHost(host), identity) || host.state !== 'registered') {
      throw new SessionLifecycleConflictError(`Analytics writer host ${identity.hostInstanceId} is not currently admissible.`);
    }
  }

  private assertWriterRegistrySnapshot(
    workspaceId: string,
    expectedHosts: readonly AnalyticsWriterIdentity[],
  ): void {
    const rows = this.database.prepare(`
      SELECT * FROM analytics_hosts WHERE workspace_id = ? ORDER BY host_instance_id
    `).all(workspaceId) as AnalyticsHostRow[];
    if (rows.length !== expectedHosts.length) {
      throw new SessionLifecycleConflictError('Analytics writer census does not cover the complete host registry.');
    }
    const expectedByHost = new Map(expectedHosts.map((host) => [host.hostInstanceId, host] as const));
    for (const row of rows) {
      const host = toAnalyticsHost(row);
      const expected = expectedByHost.get(host.hostInstanceId);
      if (!expected
        || host.state !== 'registered'
        || !host.capabilities.includes('authenticated-control')
        || !host.capabilities.includes('writer-fence')
        || !sameWriterIdentity(writerIdentityFromHost(host), expected)) {
        throw new SessionLifecycleConflictError('Analytics writer census does not match the complete host registry.');
      }
    }
  }

  private toWriterFenceRecord(row: AnalyticsWriterFenceRow): AnalyticsWriterFenceRecord {
    const expectedHosts = parseWriterHosts(row.expected_hosts_json, row.expected_hosts_sha256);
    const acknowledgedHostInstanceIds = (this.database.prepare(`
      SELECT host_instance_id FROM analytics_writer_fence_acks
      WHERE workspace_id = ? AND operation_id = ? ORDER BY host_instance_id
    `).all(row.workspace_id, row.operation_id) as Array<{ host_instance_id: string }>).map((ack) => {
      const hostInstanceId = requireHostField(ack.host_instance_id, 'Analytics writer acknowledgement hostInstanceId');
      if (!expectedHosts.some((host) => host.hostInstanceId === hostInstanceId)) {
        throw new SessionLifecycleConflictError('Analytics writer fence contains an out-of-census acknowledgement.');
      }
      return hostInstanceId;
    });
    if (new Set(acknowledgedHostInstanceIds).size !== acknowledgedHostInstanceIds.length) {
      throw new SessionLifecycleConflictError('Analytics writer fence contains duplicate acknowledgements.');
    }
    return {
      workspaceId: row.workspace_id,
      operationId: row.operation_id,
      purpose: row.purpose,
      fenceEpoch: Number(row.fence_epoch),
      state: row.state,
      expectedHosts,
      acknowledgedHostInstanceIds,
      startedAtMs: row.started_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  get(sessionId: string): SessionLifecycleRecord | undefined {
    const row = this.database.prepare('SELECT * FROM session_lifecycle WHERE session_id = ?').get(sessionId) as LifecycleRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  getByPendingCreateOperationId(pendingCreateOperationId: string): SessionLifecycleRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM session_lifecycle WHERE pending_create_operation_id = ?
    `).get(pendingCreateOperationId) as LifecycleRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  private ensureOpen(sessionId: string, nowMs: string): void {
    this.database.prepare(`
      INSERT INTO session_lifecycle (
        session_id, privacy_mode, cleanup_state, write_epoch, updated_at_ms
      ) VALUES (?, 'off', 'open', 0, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, nowMs);
  }

  registerTranscript(sessionId: string, transcriptRelativePath: string, nowMs: Int64Value): SessionLifecycleRecord {
    requireId(sessionId, 'sessionId');
    const relativePath = normalizeLifecycleRelativePath(transcriptRelativePath);
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      this.ensureOpen(sessionId, encodedNow);
      const existing = this.get(sessionId)!;
      if (existing.transcriptRelativePath && existing.transcriptRelativePath !== relativePath) {
        throw new SessionLifecycleConflictError(`Session ${sessionId} is already bound to another transcript path.`);
      }
      this.database.prepare(`UPDATE session_lifecycle SET transcript_relative_path = ?, updated_at_ms = ? WHERE session_id = ?`)
        .run(relativePath, encodedNow, sessionId);
      return this.get(sessionId)!;
    })();
  }

  registerPendingCreateOperation(
    sessionId: string,
    pendingCreateOperationId: string,
    nowMs: Int64Value,
  ): SessionLifecycleRecord {
    requireId(sessionId, 'sessionId');
    requireId(pendingCreateOperationId, 'pendingCreateOperationId');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      this.ensureOpen(sessionId, encodedNow);
      const existing = this.get(sessionId)!;
      if (existing.pendingCreateOperationId
        && existing.pendingCreateOperationId !== pendingCreateOperationId) {
        throw new SessionLifecycleConflictError(
          `Session ${sessionId} is already bound to another pending-create operation.`,
        );
      }
      this.database.prepare(`
        UPDATE session_lifecycle
        SET pending_create_operation_id = COALESCE(pending_create_operation_id, ?), updated_at_ms = ?
        WHERE session_id = ?
      `).run(pendingCreateOperationId, encodedNow, sessionId);
      return this.get(sessionId)!;
    })();
  }

  setPrivacyMode(sessionId: string, privacyMode: PrivacyMode, nowMs: Int64Value): SessionLifecycleRecord {
    requireId(sessionId, 'sessionId');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      this.ensureOpen(sessionId, encodedNow);
      const existing = this.get(sessionId)!;
      if (existing.closedAtMs !== undefined) {
        if (existing.privacyMode !== privacyMode) {
          throw new SessionLifecycleConflictError(`Privacy mode for ${sessionId} is frozen after close.`);
        }
        return existing;
      }
      this.database.prepare('UPDATE session_lifecycle SET privacy_mode = ?, updated_at_ms = ? WHERE session_id = ?')
        .run(privacyMode, encodedNow, sessionId);
      return this.get(sessionId)!;
    })();
  }

  resolveClose(
    sessionId: string,
    closeOperationId: string,
    closedAtMs: Int64Value,
    cause?: SessionCloseCause,
  ): SessionCloseResolution {
    requireId(sessionId, 'sessionId');
    requireId(closeOperationId, 'closeOperationId');
    const encodedClosedAt = encodeTimestamp(closedAtMs, 'closedAtMs');
    return this.database.transaction(() => {
      this.ensureOpen(sessionId, encodedClosedAt);
      const existing = this.get(sessionId)!;
      if (existing.closedAtMs !== undefined) return { ...existing, duplicate: true } as SessionCloseResolution;
      const disposition = closeDispositionForPrivacy(existing.privacyMode);
      const closeCause = cause ?? (disposition === 'delete' ? 'private_close' : 'user_close');
      const expiresAtMs = disposition === 'retain' ? sessionRetentionDeadline(encodedClosedAt) : null;
      const cleanupState: SessionCleanupState = disposition === 'delete' ? 'deleting' : 'retained';
      const cleanupOperationId = disposition === 'delete' ? closeOperationId : null;
      this.database.prepare(`
        UPDATE session_lifecycle
        SET close_operation_id = ?, first_close_cause = ?, closed_at_ms = ?, disposition = ?, expires_at_ms = ?,
            cleanup_operation_id = ?, cleanup_state = ?, cleanup_started_at_ms = ?, cleanup_error = NULL,
            write_epoch = write_epoch + 1, updated_at_ms = ?
        WHERE session_id = ? AND closed_at_ms IS NULL
      `).run(
        closeOperationId, closeCause, encodedClosedAt, disposition, expiresAtMs,
        cleanupOperationId, cleanupState, disposition === 'delete' ? encodedClosedAt : null,
        encodedClosedAt, sessionId,
      );
      return { ...this.get(sessionId)!, duplicate: false } as SessionCloseResolution;
    })();
  }

  assertWritable(sessionId: string, expectedEpoch?: number): SessionLifecycleRecord {
    const record = this.get(sessionId);
    if (!record) throw new SessionWriteRevokedError(sessionId, -1, 'session is not registered');
    if (record.cleanupState !== 'open' || record.closedAtMs !== undefined) {
      throw new SessionWriteRevokedError(sessionId, record.writeEpoch, record.cleanupState);
    }
    if (expectedEpoch !== undefined && record.writeEpoch !== expectedEpoch) {
      throw new SessionWriteRevokedError(sessionId, record.writeEpoch, `expected epoch ${expectedEpoch}`);
    }
    return record;
  }

  claimCleanup(sessionId: string, cleanupOperationId: string, nowMs: Int64Value): SessionLifecycleRecord {
    requireId(cleanupOperationId, 'cleanupOperationId');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      const existing = this.get(sessionId);
      if (!existing?.closedAtMs) throw new SessionLifecycleConflictError(`Session ${sessionId} is not closed.`);
      if (existing.cleanupState === 'deleted') return existing;
      if (existing.disposition === 'retain' && parseInt64(existing.expiresAtMs!, 'expiresAtMs') > parseInt64(encodedNow, 'nowMs')) {
        throw new SessionLifecycleConflictError(`Session ${sessionId} is not due for cleanup.`);
      }
      if (existing.cleanupOperationId && existing.cleanupOperationId !== cleanupOperationId) {
        // The stable first operation is the recovery identity. A later host may
        // resume it, but cannot replace it with a competing operation.
        cleanupOperationId = existing.cleanupOperationId;
      }
      const incrementEpoch = existing.cleanupState === 'retained' ? 1 : 0;
      this.database.prepare(`
        UPDATE session_lifecycle
        SET cleanup_operation_id = ?, cleanup_state = 'deleting', cleanup_started_at_ms = COALESCE(cleanup_started_at_ms, ?),
            cleanup_error = NULL, write_epoch = write_epoch + ?, updated_at_ms = ?
        WHERE session_id = ?
      `).run(cleanupOperationId, encodedNow, incrementEpoch, encodedNow, sessionId);
      return this.get(sessionId)!;
    })();
  }

  markCleanupBlocked(sessionId: string, cleanupOperationId: string, error: string, nowMs: Int64Value): SessionLifecycleRecord {
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    return this.database.transaction(() => {
      const record = this.get(sessionId);
      if (!record || record.cleanupOperationId !== cleanupOperationId) {
        throw new SessionLifecycleConflictError(`Cleanup operation ${cleanupOperationId} does not own ${sessionId}.`);
      }
      this.database.prepare(`UPDATE session_lifecycle SET cleanup_state = 'blocked', cleanup_error = ?, updated_at_ms = ? WHERE session_id = ?`)
        .run(error, encodedNow, sessionId);
      return this.get(sessionId)!;
    })();
  }

  markDeleted(sessionId: string, deletedAtMs: Int64Value, cleanupOperationId?: string): SessionLifecycleRecord {
    const encodedDeletedAt = encodeTimestamp(deletedAtMs, 'deletedAtMs');
    return this.database.transaction(() => {
      const existing = this.get(sessionId);
      if (!existing?.closedAtMs) throw new SessionLifecycleConflictError(`Session ${sessionId} is not closed.`);
      if (cleanupOperationId && existing.cleanupOperationId && cleanupOperationId !== existing.cleanupOperationId) {
        throw new SessionLifecycleConflictError(`Cleanup operation ${cleanupOperationId} does not own ${sessionId}.`);
      }
      this.database.prepare(`
        UPDATE session_lifecycle
        SET cleanup_state = 'deleted', cleanup_error = NULL, deleted_at_ms = COALESCE(deleted_at_ms, ?), updated_at_ms = ?
        WHERE session_id = ?
      `).run(encodedDeletedAt, encodedDeletedAt, sessionId);
      return this.get(sessionId)!;
    })();
  }

  registerArtifact(record: Omit<LifecycleArtifactRecord, 'state' | 'cleanupOperationId' | 'cleanupError' | 'updatedAtMs'>, nowMs: Int64Value): LifecycleArtifactRecord {
    requireId(record.sessionId, 'sessionId');
    requireId(record.artifactId, 'artifactId');
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    const location = record.locationKind === 'root_relative'
      ? normalizeLifecycleRelativePath(record.location)
      : record.location;
    if (record.locationKind === 'root_relative' && !record.rootName) throw new Error('rootName is required for root-relative artifacts.');
    if (record.locationKind === 'fixed_absolute' && !path.isAbsolute(location)) throw new Error('Fixed artifact path must be absolute.');
    if (record.locationKind === 'external' && record.kind !== 'external_reference') throw new Error('Only external references can use an external location.');
    return this.database.transaction(() => {
      this.ensureOpen(record.sessionId, encodedNow);
      const existing = this.database.prepare(`SELECT * FROM session_lifecycle_artifacts WHERE session_id = ? AND artifact_id = ?`)
        .get(record.sessionId, record.artifactId) as ArtifactRow | undefined;
      if (existing) {
        const same = existing.kind === record.kind
          && existing.location_kind === record.locationKind
          && existing.location === location
          && existing.root_name === (record.rootName ?? null)
          && existing.identity_json === (record.identityJson ?? null);
        if (!same) throw new SessionLifecycleConflictError(`Artifact ${record.artifactId} is already registered with different ownership evidence.`);
        return toArtifact(existing);
      }
      this.database.prepare(`
        INSERT INTO session_lifecycle_artifacts (
          session_id, artifact_id, kind, location_kind, location, root_name, identity_json, state, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'present', ?)
      `).run(
        record.sessionId, record.artifactId, record.kind, record.locationKind, location,
        record.rootName ?? null, record.identityJson ?? null, encodedNow,
      );
      return toArtifact(this.database.prepare(`SELECT * FROM session_lifecycle_artifacts WHERE session_id = ? AND artifact_id = ?`)
        .get(record.sessionId, record.artifactId) as ArtifactRow);
    })();
  }

  listArtifacts(sessionId: string): LifecycleArtifactRecord[] {
    return (this.database.prepare(`SELECT * FROM session_lifecycle_artifacts WHERE session_id = ? ORDER BY artifact_id`).all(sessionId) as ArtifactRow[])
      .map(toArtifact);
  }

  markArtifactDeleting(sessionId: string, artifactId: string, cleanupOperationId: string, nowMs: Int64Value): LifecycleArtifactRecord {
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    this.database.prepare(`
      UPDATE session_lifecycle_artifacts SET state = 'deleting', cleanup_operation_id = ?, cleanup_error = NULL, updated_at_ms = ?
      WHERE session_id = ? AND artifact_id = ? AND state NOT IN ('deleted')
    `).run(cleanupOperationId, encodedNow, sessionId, artifactId);
    const row = this.database.prepare(`SELECT * FROM session_lifecycle_artifacts WHERE session_id = ? AND artifact_id = ?`)
      .get(sessionId, artifactId) as ArtifactRow | undefined;
    if (!row) throw new SessionLifecycleConflictError(`Unknown lifecycle artifact ${artifactId}.`);
    return toArtifact(row);
  }

  markArtifactResult(
    sessionId: string,
    artifactId: string,
    cleanupOperationId: string,
    state: Extract<LifecycleArtifactState, 'deleted' | 'missing' | 'blocked'>,
    nowMs: Int64Value,
    error?: string,
  ): LifecycleArtifactRecord {
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    const result = this.database.prepare(`
      UPDATE session_lifecycle_artifacts SET state = ?, cleanup_error = ?, updated_at_ms = ?
      WHERE session_id = ? AND artifact_id = ? AND cleanup_operation_id = ?
    `).run(state, error ?? null, encodedNow, sessionId, artifactId, cleanupOperationId);
    if (Number(result.changes) !== 1) throw new SessionLifecycleConflictError(`Cleanup operation ${cleanupOperationId} does not own artifact ${artifactId}.`);
    return toArtifact(this.database.prepare(`SELECT * FROM session_lifecycle_artifacts WHERE session_id = ? AND artifact_id = ?`)
      .get(sessionId, artifactId) as ArtifactRow);
  }

  listDue(nowMs: Int64Value, limit = 100): SessionLifecycleRecord[] {
    const encodedNow = encodeTimestamp(nowMs, 'nowMs');
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return (this.database.prepare(`
      SELECT * FROM session_lifecycle
      WHERE (cleanup_state IN ('deleting', 'blocked') OR (cleanup_state = 'retained' AND CAST(expires_at_ms AS INTEGER) <= CAST(? AS INTEGER)))
      ORDER BY CASE WHEN cleanup_state = 'retained' THEN expires_at_ms ELSE cleanup_started_at_ms END, session_id
      LIMIT ?
    `).all(encodedNow, boundedLimit) as LifecycleRow[]).map(toRecord);
  }

  nextExpiry(): string | undefined {
    const row = this.database.prepare(`SELECT MIN(CAST(expires_at_ms AS INTEGER)) AS deadline FROM session_lifecycle WHERE cleanup_state = 'retained'`)
      .get() as { deadline: number | bigint | null };
    return row.deadline === null ? undefined : row.deadline.toString();
  }
}
