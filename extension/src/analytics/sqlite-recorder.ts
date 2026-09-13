import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { deserialize, serialize as serializeV8 } from 'node:v8';

import {
  AnalyticsSourceConflictError,
  analyticsObservationFingerprint,
  analyticsObservationRegistryKey,
  assertValidAnalyticsObservation,
  canonicalInt64,
  encodeInt64,
  parseInt64,
  parseNonNegativeInt64,
  type AnalyticsDetailCapture,
  type AnalyticsDetailSink,
  type AnalyticsObservation,
  type AnalyticsSink,
  type AnalyticsUsageChannels,
  type Int64Value,
} from '../../../shared/analytics/contracts.js';
import {
  calculateCompleteCostUsd,
  costWithinParityTolerance,
  localCalendarDayKey,
  localCalendarWeekDateKeys,
  normalizeUsageChannels,
  type CoverageMetric,
  type EffectiveCostMetric,
  type NormalizedUsageChannels,
} from '../../../shared/analytics/metrics.js';
import { sanitizeAnalyticsDetail } from '../../../shared/sensitive-redaction.js';
import {
  applyProviderProjection,
  createProviderProjectionSchema,
  decrementProviderSessionPresence,
  incrementProviderSessionPresence,
  prepareProviderDailyProjection,
  readProviderModelGroups,
  rebuildProviderProjection,
  settlementFromDatabaseRow,
  type ProviderProjectionAggregateRequest,
  type ProviderProjectionDatabase,
  type ProviderProjectionSettlement,
} from './provider-model-projection.js';
import {
  applyExecutionSummaryDelta,
  type CanonicalExecutionLatestRun,
  emptyExecutionSummary,
  executionSummaryFromCounts,
  type CanonicalExecutionSummary,
  type ExecutionSummaryDeliveryCoverage,
  type ExecutionSummaryScope,
} from './execution-summary.js';
import {
  applyActivityProjection,
  createActivityProjectionSchema,
  movePendingActivityProjection,
  readActivityProjection,
  removeActivityProjectionForRoot,
  type ActivityProjectionDatabase,
  type ActivityProjectionReadModel,
  type ActivityProjectionReadRequest,
  type ActivityProjectionSpanState,
} from './activity-projection.js';

interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  columns(): Array<{ name: string }>;
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): Iterable<unknown>;
  run(...params: unknown[]): SqliteRunResult;
}

type SqliteAuthorizer = (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  databaseName: string | null,
  triggerOrView: string | null,
) => number;

interface SqliteDatabase {
  close(): void;
  enableDefensive(active: boolean): void;
  enableLoadExtension(allow: boolean): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  setAuthorizer(callback: SqliteAuthorizer | null): void;
}

interface SqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; timeout?: number; readBigInts?: boolean },
  ) => SqliteDatabase;
  constants: Record<string, number>;
}

const FIXED_WRITER_STATEMENT_KEYS = [
  'reconciliation.current', 'reconciliation.pending', 'reconciliation.next',
  'reconciliation.delete-next', 'reconciliation.pending-count', 'reconciliation.insert-pending',
  'reconciliation.pending-rows', 'reconciliation.upsert',
  'projection.revision.read', 'projection.revision.update',
  'provider.accounting.lookup', 'provider.accounting.upsert',
  'provider.settlement.lookup', 'provider.settlement.insert',
  'typed.execution.observation.insert', 'typed.execution.state.lookup',
  'typed.execution.state.upsert', 'typed.execution.summary.lookup',
  'typed.execution.summary.upsert', 'typed.execution.summary.delete',
  'typed.tool.observation.insert', 'typed.tool.state.upsert',
  'typed.activity.observation.insert', 'typed.activity.state.lookup', 'typed.activity.state.upsert',
  'typed.feature.observation.insert',
  'typed.branch.selection.insert', 'typed.branch.selection-current.upsert',
  'typed.branch.edge.lookup', 'typed.branch.edge.parent.lookup', 'typed.branch.edge.upsert',
  'typed.copy.insert',
  'detail.payload.lookup', 'detail.source.lookup', 'detail.content.insert',
  'detail.payload.insert', 'detail.reference.insert', 'generation.insert',
  'observation.registry.lookup', 'subject.deleted.present', 'copy.destination.lookup',
  'copy.scrubbed.upsert', 'observation.insert', 'subject.pending.lookup', 'subject.deleted.lookup',
  'facts.bytes.add', 'facts.bytes.subtract',
] as const;
const WRITER_STATEMENT_KEYS = new Set<string>(FIXED_WRITER_STATEMENT_KEYS);
for (const kind of ['observations', 'details']) {
  for (const outcome of ['accepted', 'replayed', 'deleted']) {
    WRITER_STATEMENT_KEYS.add(`delivery.${kind}.${outcome}.read`);
    WRITER_STATEMENT_KEYS.add(`delivery.${kind}.${outcome}.update`);
  }
}
// 47 fixed keys plus 12 delivery kind/outcome read/update combinations.
if (WRITER_STATEMENT_KEYS.size !== 59) throw new Error('Analytics writer statement key inventory changed.');
const MAX_CACHED_WRITER_STATEMENTS = 64;
const INSERT_GENERATION_SQL = `
  INSERT OR IGNORE INTO analytics_generations (generation_id, first_observed_at_ms) VALUES (?, ?)
`;

/** Connection-local cache for the recorder's explicitly named, static write-path
 * statements. Schema setup, PRAGMAs, iterators, and ad-hoc/read-only queries
 * continue to use the raw database directly. */
class WriterStatementCache {
  private readonly statements = new Map<string, { readonly sql: string; readonly statement: SqliteStatement }>();

  constructor(private readonly database: SqliteDatabase) {}

  prepare(key: string, sql: string): SqliteStatement {
    if (!WRITER_STATEMENT_KEYS.has(key)) throw new Error(`Unknown analytics writer statement key: ${key}`);
    const existing = this.statements.get(key);
    if (existing) {
      if (existing.sql !== sql) throw new Error(`Analytics writer statement key changed SQL: ${key}`);
      return existing.statement;
    }
    if (this.statements.size >= MAX_CACHED_WRITER_STATEMENTS) {
      throw new Error(`Analytics writer statement cache exceeded ${MAX_CACHED_WRITER_STATEMENTS} entries.`);
    }
    const statement = this.database.prepare(sql);
    this.statements.set(key, { sql, statement });
    return statement;
  }

  clear(): void {
    this.statements.clear();
  }
}

function prepareWriterStatement(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  key: string,
  sql: string,
): SqliteStatement {
  return statements ? statements.prepare(key, sql) : database.prepare(sql);
}

const sqlite = createRequire(process.execPath)('node:sqlite') as SqliteModule;
const DATABASE_SCHEMA_VERSION = 12;
const BUSY_TIMEOUT_MS = 5_000;
const MAX_PENDING_SEQUENCES_PER_PRODUCER = 4_096;
const DEFAULT_QUERY_ROWS = 200;
const MAX_QUERY_ROWS = 10_000;
const DEFAULT_QUERY_BYTES = 256 * 1024;
const MAX_QUERY_BYTES = 16 * 1024 * 1024;
const MAX_DETAIL_CAPTURE_BYTES = 64 * 1024 * 1024;

interface RegistryRow { fingerprint: string }
interface UserVersionRow { user_version: number | bigint }
interface RevisionRow { revision: string }
interface CountRow { count: number | bigint }
interface DeletedSubjectRow {
  deleted_count: number | bigint;
  deleted_at_ms: string;
  scrub_state: 'pending' | 'complete';
  scrub_error: string | null;
}
interface PayloadRow {
  payload_id?: string;
  fingerprint: string;
  manifest_json: string;
  logical_bytes: number | bigint;
  media_type?: string;
  source_encoding?: string;
  complete?: number | bigint;
  capture_stage?: string | null;
  source_version?: string | null;
  omission_reason?: string | null;
}
interface ContentRow { digest: string; encoding: string; body: Uint8Array }
interface WalCheckpointRow { busy: number | bigint; log: number | bigint; checkpointed: number | bigint }

export interface AnalyticsSubjectBindingReceipt {
  pendingOperationId: string;
  rootSessionId: string;
  movedObservationCount: number;
  movedPayloadCount: number;
  duplicate: boolean;
  /** A late binding to an already-deleted root is retained as a durable fence;
   * any pending facts/details are scrubbed instead of migrated. */
  deletedSubject: boolean;
}

export interface AnalyticsDeleteReceipt {
  rootSessionId: string;
  deletedObservationCount: number;
  deletedPayloadCount: number;
  deletedAtMs: string;
  duplicate: boolean;
  scrubState: 'complete';
}

export class AnalyticsPrivacyScrubPendingError extends Error {
  readonly code = 'privacy_scrub_pending';

  constructor(readonly rootSessionId: string, message: string) {
    super(message);
    this.name = 'AnalyticsPrivacyScrubPendingError';
  }
}

export interface AnalyticsSubjectBindingState {
  pendingOperationId: string;
  rootSessionId: string;
  deleted: boolean;
}

export interface AnalyticsPrivacyScrubState {
  rootSessionId: string;
  deletedAtMs: number | string;
  state: 'pending' | 'complete';
  lastError: string | null;
}

export interface AnalyticsDeliveryAccounting {
  /** Pre-v3 migrations know retained rows, not historical replay/deletion outcomes. */
  deliveryHistoryCoverage: 'complete' | 'retained_only';
  observations: { delivered: number | string; accepted: number | string; replayed: number | string; deleted: number | string };
  details: { delivered: number | string; accepted: number | string; replayed: number | string; deleted: number | string };
  /** Monotonic recorder commit watermark for independently complete detail payloads. */
  completeDetailWatermark: number | string;
  retainedDetailLogicalBytes: number | string;
  retainedDetailStoredBytes: number | string;
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

export interface ProviderSettlementProjection extends ProviderUsageProjection {
  generationId: string;
  rootSessionId: string | null;
  executionId: string | null;
  branchId: string | null;
  /** Set only by a copy-selection read. The stored settlement remains owned
   * by its original root and is never duplicated. */
  selectedSessionId?: string;
  inheritedFromInvocationId?: string;
  provider: string | null;
  model: string | null;
  dispatchedModel: string | null;
  reportedModel: string | null;
  purpose: string | null;
  outcome: string | null;
  settledAtMs: number | string | null;
  calculatedCostUsd: number | null;
  calculatedCostComplete: boolean;
  normalizedUsage: NormalizedUsageChannels;
  effectiveCostUsd: number | null;
  effectiveCostSource: 'reported' | 'calculated' | null;
  effectiveCostCoverage: 'known' | 'unknown' | 'not_applicable';
  revision: number | string;
}

export interface ProviderSettlementReadModel {
  revision: number | string;
  settlements: ProviderSettlementProjection[];
}

export type ProviderSettlementScope =
  | { kind: 'global' }
  | { kind: 'rootSession'; rootSessionId: string }
  | { kind: 'selectedBranch'; generationId: string; rootSessionId: string }
  | { kind: 'copySelected'; generationId: string; copySessionId: string };

export interface ScopedProviderSettlementReadModel extends ProviderSettlementReadModel {
  scope: ProviderSettlementScope;
  settlementCoverage: 'complete' | 'truncated';
  truncated: boolean;
  nextOffset: number | null;
  selectionCoverage: 'known' | 'unknown' | 'not_applicable';
  inheritanceCoverage: 'not_applicable' | 'known' | 'unknown';
  inheritanceUnavailableReason?: 'source_scrubbed' | 'missing_source_selection' | 'incomplete_source_ancestry';
}

export interface ScopedProviderSettlementPage {
  limit?: number;
  offset?: number;
  /** Reject a later page if intervening commits changed the projection. */
  expectedRevision?: number | string;
}

export interface HistoricalDimensionSummary extends AnalyticsQuerySnapshotMetadata {
  revision: number | string;
  scope: { kind: 'global' };
  providers: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  activities: Array<Record<string, unknown>>;
  features: Array<Record<string, unknown>>;
  /** Bounds apply before materialization, across one consistent snapshot. */
  truncation: AnalyticsQueryTruncation;
  maxRowsPerDimension: number;
}

export interface ProviderAccountingSummary {
  revision: number | string;
  invocationCount: number;
  inputTokens: CoverageMetric;
  outputTokens: CoverageMetric;
  cacheReadTokens: CoverageMetric;
  cacheWriteTokens: CoverageMetric;
  reasoningTokens: CoverageMetric;
  providerTotalTokens: CoverageMetric;
  effectiveCostUsd: EffectiveCostMetric;
}

/** One bounded aggregate read. The accounting projection and provider/model
 * groups are produced in the same SQLite snapshot and carry the same
 * projection revision, so a consumer cannot pair facts from different
 * commits. */
export interface ProviderAggregateReadRequest {
  todayStartMs: number;
  todayEndMs: number;
  weekStartMs: number;
  weekEndMs: number;
  maxGroups?: number;
  /** One agreed active calendar zone. The writer must prepare this zone. */
  timeZone?: string;
  /** Writer preparation envelope used to fence a concurrent rollover. */
  dailyWindowStartMs?: number;
  dailyWindowEndMs?: number;
}

export interface ProviderAggregateReadModel {
  revision: number | string;
  snapshotWatermark: number | string;
  accounting: ProviderAccountingSummary;
  /** Captured root execution summary; lifecycle/timing coverage is scoped to
   * retained rows and does not certify complete producer history. */
  executionSummary: CanonicalExecutionSummary;
  /** Source-chronological latest completed root execution. */
  latestRun: CanonicalExecutionLatestRun | null;
  groups: Array<Record<string, unknown>>;
  truncation: AnalyticsQueryTruncation;
}

export interface SourceSequenceGap {
  from: number | string;
  to: number | string;
}

export interface ProducerReconciliation {
  producerIdentity: string;
  contiguousWatermark: number | string;
  highestObservedSequence: number | string;
  visibleGaps: SourceSequenceGap[];
  pendingReceiptCount: number;
}

export interface AnalyticsQueryTruncation {
  rowLimit: boolean;
  byteLimit: boolean;
  cellLimit: boolean;
}

export interface AnalyticsPendingDetailCoverage {
  deliveryHistoryCoverage: AnalyticsDeliveryAccounting['deliveryHistoryCoverage'];
  completeDetailWatermark: number | string;
  retainedDetailLogicalBytes: number | string;
  retainedDetailStoredBytes: number | string;
}

/** Metadata read in the same SQLite snapshot as each logical query result. */
export interface AnalyticsQuerySnapshotMetadata {
  databaseSchemaVersion: number;
  projectionRevision: number | string;
  snapshotWatermark: number | string;
  generationIds: string[];
  generationIdsTruncated: boolean;
  pendingDetailCoverage: AnalyticsPendingDetailCoverage;
  truncation: AnalyticsQueryTruncation;
}

export interface AnalyticsReadOnlyQueryResult extends AnalyticsQuerySnapshotMetadata {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  returnedRows: number;
}

export interface AnalyticsDetailMetadata {
  logicalBytes: number | string;
  storedBytes: number | string;
  mediaType: string;
  sourceEncoding: string;
  complete: boolean;
  captureStage: string | null;
  sourceVersion: string | null;
  omissionReason: string | null;
}

export interface AnalyticsDetailRangeResult extends AnalyticsQuerySnapshotMetadata {
  payloadId: string;
  available: boolean;
  mediaType: string | null;
  sourceEncoding: string | null;
  representationEncoding: 'node-v8';
  complete: boolean;
  captureStage: string | null;
  sourceVersion: string | null;
  omissionReason: string | null;
  totalLength: number | string;
  offset: number | string;
  nextOffset: number | string | null;
  truncated: boolean;
  bytes: Uint8Array;
}

export interface AnalyticsSchemaDescription extends AnalyticsQuerySnapshotMetadata {
  projectionVersion: number;
  logicalCommands: readonly ['schema', 'query', 'detail', 'storage'];
  views: string[];
  detail: { defaultRangeBytes: number; representationEncoding: 'node-v8' };
}

export interface AnalyticsStorageSummary extends AnalyticsDetailStorageStats {
  databaseBytes: number | string;
  walBytes: number | string;
  sharedMemoryBytes: number | string;
  factsLogicalBytes: number | string;
  engineAllocationOverheadBytes: null;
}

export interface AnalyticsStorageReadModel extends AnalyticsQuerySnapshotMetadata {
  storage: AnalyticsStorageSummary;
  delivery: AnalyticsDeliveryAccounting;
}

/** Recorder-local opt-in until producer sequencing becomes part of the shared
 * DTO contract. Existing unsequenced AnalyticsObservation values remain valid. */
export type SequencedAnalyticsObservation<Fields extends object = Record<string, unknown>> =
  AnalyticsObservation<Fields> & {
  sourceSequence?: Int64Value;
};

export interface AnalyticsDetailStorageStats {
  payloadCount: number;
  contentCount: number;
  logicalBytes: number | string;
  storedContentBytes: number | string;
}

type DetailNode =
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'boolean'; v: boolean }
  | { t: 'number'; v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'bigint'; v: string }
  | { t: 'leaf'; d: string; e: 'utf8' | 'binary' }
  | { t: 'array'; v: Array<DetailNode | null> }
  | { t: 'object'; v: Array<[string, DetailNode]> };

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, child) => typeof child === 'bigint' ? child.toString() : child);
}

function subjectKey(observation: AnalyticsObservation<object>): string {
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

/** Enforce the analytics exclusion at the single durable boundary and return
 * the decoded value alongside the canonical bytes.
 *
 * Producers already sanitize detail before serialization, but recording is the
 * last layer that can see content before a manifest, content digest, SQLite
 * page or WAL record is written. Re-sanitizing here means a producer or
 * transport that skipped redaction still cannot persist private bytes, while
 * the common already-sanitized case stays a byte-level fixed point because
 * redaction is idempotent. The decoded value is returned so the caller builds
 * the content manifest from the same decode instead of paying a second
 * deserialize, and the canonical buffer is only produced when it differs from
 * the input. */
function canonicalDetailCapture(bytes: Uint8Array): { bytes: Uint8Array; value: unknown } {
  // `deserialize` and `Buffer.compare` both accept a Uint8Array view directly,
  // so the bytes are never copied onto the per-payload hot path.
  const value = deserialize(bytes);
  const scrubbed = sanitizeAnalyticsDetail(value);
  const canonical = serializeV8(scrubbed);
  return {
    bytes: Buffer.compare(bytes, canonical) === 0 ? bytes : canonical,
    value: scrubbed,
  };
}

function captureFingerprint(capture: AnalyticsDetailCapture): string {
  const semanticMetadata = JSON.stringify(Object.fromEntries(
    Object.entries(capture.metadata).sort(([left], [right]) => left.localeCompare(right)),
  ));
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
    .update(capture.mediaType)
    .update('\0')
    .update(capture.encoding)
    .update('\0')
    .update(capture.complete ? 'complete' : 'incomplete')
    .update('\0')
    .update(semanticMetadata)
    .update('\0')
    .update(capture.bytes)
    .digest('hex');
}

function configureDatabase(database: SqliteDatabase, readOnly: boolean): void {
  database.enableLoadExtension(false);
  database.enableDefensive(true);
  database.exec(`
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    ${readOnly ? 'PRAGMA query_only = ON;' : `
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
    `}
  `);
}

function createV1Tables(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE analytics_observations (
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
    CREATE UNIQUE INDEX analytics_idempotency_idx
      ON analytics_observations(generation_id, idempotency_key);
    CREATE INDEX analytics_subject_idx
      ON analytics_observations(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_root_session_idx
      ON analytics_observations(root_session_id, commit_sequence);
    CREATE INDEX analytics_invocation_idx
      ON analytics_observations(invocation_id, commit_sequence);

    CREATE TABLE analytics_detail_content (
      digest TEXT PRIMARY KEY,
      encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'binary')),
      logical_bytes INTEGER NOT NULL,
      body BLOB NOT NULL
    ) STRICT;
    CREATE TABLE analytics_detail_payloads (
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
    CREATE INDEX analytics_detail_subject_idx
      ON analytics_detail_payloads(capture_subject_kind, capture_subject_key);
    CREATE TABLE analytics_detail_references (
      payload_id TEXT NOT NULL REFERENCES analytics_detail_payloads(payload_id) ON DELETE CASCADE,
      digest TEXT NOT NULL REFERENCES analytics_detail_content(digest),
      PRIMARY KEY(payload_id, digest)
    ) STRICT;
    CREATE TABLE analytics_deleted_subjects (
      root_session_id TEXT PRIMARY KEY,
      delete_source_key TEXT NOT NULL UNIQUE,
      deleted_count INTEGER NOT NULL,
      deleted_payload_count INTEGER NOT NULL,
      deleted_at_ms TEXT NOT NULL
    ) STRICT;
  `);
}

function createV2Tables(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE analytics_pending_subject_bindings (
      pending_operation_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      bound_at_ms TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_pending_subject_root_idx
      ON analytics_pending_subject_bindings(root_session_id);

    CREATE TABLE analytics_projection_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision TEXT NOT NULL
    ) STRICT;
    INSERT INTO analytics_projection_state (singleton, revision) VALUES (1, '0');

    CREATE TABLE analytics_provider_settlements (
      generation_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      observation_registry_key TEXT NOT NULL UNIQUE,
      settlement_fingerprint TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      provider TEXT,
      dispatched_model TEXT,
      reported_model TEXT,
      effective_model TEXT,
      purpose TEXT,
      outcome TEXT,
      settled_at_ms TEXT,
      input_tokens TEXT,
      output_tokens TEXT,
      cache_read_tokens TEXT,
      cache_write_tokens TEXT,
      reasoning_tokens TEXT,
      provider_total_tokens TEXT,
      reported_cost_usd REAL,
      calculated_cost_usd REAL,
      calculated_cost_complete INTEGER NOT NULL CHECK (calculated_cost_complete IN (0, 1)),
      effective_cost_usd REAL,
      effective_cost_source TEXT CHECK (effective_cost_source IN ('reported', 'calculated')),
      effective_cost_coverage TEXT NOT NULL CHECK (effective_cost_coverage IN ('known', 'unknown', 'not_applicable')),
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, invocation_id)
    ) STRICT;
    CREATE INDEX analytics_provider_settlement_subject_idx
      ON analytics_provider_settlements(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_provider_settlement_root_idx
      ON analytics_provider_settlements(root_session_id, projection_revision);
    CREATE INDEX analytics_provider_settlement_dimensions_idx
      ON analytics_provider_settlements(provider, effective_model, purpose, outcome);
    CREATE TABLE analytics_provider_accounting_projections (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('global', 'session')),
      subject_key TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(subject_kind, subject_key)
    ) STRICT;

    CREATE TABLE analytics_execution_observations (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      observation_kind TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      operation_kind TEXT,
      outcome TEXT,
      started_at_ms TEXT,
      ended_at_ms TEXT,
      payload_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_execution_root_idx
      ON analytics_execution_observations(root_session_id, projection_revision);
    CREATE TABLE analytics_execution_states (
      generation_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      operation_kind TEXT,
      outcome TEXT,
      started_at_ms TEXT,
      ended_at_ms TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, execution_id)
    ) STRICT;
    CREATE INDEX analytics_execution_state_root_idx
      ON analytics_execution_states(root_session_id, projection_revision);

    CREATE TABLE analytics_tool_observations (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      observation_kind TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      tool_definition_id TEXT,
      outcome TEXT,
      started_at_ms TEXT,
      execution_ended_at_ms TEXT,
      payload_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_tool_root_idx
      ON analytics_tool_observations(root_session_id, projection_revision);
    CREATE INDEX analytics_tool_identity_idx
      ON analytics_tool_observations(generation_id, tool_call_id, projection_revision);
    CREATE TABLE analytics_tool_states (
      generation_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      tool_definition_id TEXT,
      outcome TEXT,
      started_at_ms TEXT,
      execution_ended_at_ms TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, tool_call_id)
    ) STRICT;
    CREATE INDEX analytics_tool_state_root_idx
      ON analytics_tool_states(root_session_id, projection_revision);

    CREATE TABLE analytics_activity_observations (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      observation_kind TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      activity_kind TEXT,
      started_at_ms TEXT,
      ended_at_ms TEXT,
      duration_ms REAL,
      coverage TEXT,
      payload_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_activity_root_idx
      ON analytics_activity_observations(root_session_id, projection_revision);
    CREATE INDEX analytics_activity_identity_idx
      ON analytics_activity_observations(generation_id, span_id, projection_revision);
    CREATE TABLE analytics_activity_states (
      generation_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      activity_kind TEXT,
      started_at_ms TEXT,
      ended_at_ms TEXT,
      duration_ms REAL,
      coverage TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, span_id)
    ) STRICT;
    CREATE INDEX analytics_activity_state_root_idx
      ON analytics_activity_states(root_session_id, projection_revision);

    CREATE TABLE analytics_feature_observations (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      feature TEXT,
      decision TEXT,
      rule_version TEXT,
      measured_size_effect REAL,
      estimated_size_effect REAL,
      payload_json TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_feature_root_idx
      ON analytics_feature_observations(root_session_id, projection_revision);
    CREATE INDEX analytics_feature_dimensions_idx
      ON analytics_feature_observations(feature, decision, rule_version);

    CREATE TABLE analytics_producer_sequences (
      producer_identity TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      receipt_digest TEXT NOT NULL,
      PRIMARY KEY(producer_identity, source_sequence)
    ) STRICT;
    CREATE TABLE analytics_producer_reconciliation (
      producer_identity TEXT PRIMARY KEY,
      contiguous_watermark TEXT NOT NULL,
      highest_observed_sequence TEXT NOT NULL,
      visible_gaps_json TEXT NOT NULL
    ) STRICT;
  `);
}

function migrateV3(database: SqliteDatabase, deliveryHistoryCoverage: 'complete' | 'retained_only'): void {
  database.exec(`
    ALTER TABLE analytics_provider_settlements ADD COLUMN normalized_base_input_tokens TEXT;
    ALTER TABLE analytics_provider_settlements ADD COLUMN normalized_output_tokens TEXT;
    ALTER TABLE analytics_provider_settlements ADD COLUMN normalized_cache_read_tokens TEXT;
    ALTER TABLE analytics_provider_settlements ADD COLUMN normalized_cache_write_tokens TEXT;
    ALTER TABLE analytics_provider_settlements ADD COLUMN normalized_total_tokens TEXT;
    ALTER TABLE analytics_provider_settlements
      ADD COLUMN normalized_usage_complete INTEGER NOT NULL DEFAULT 0 CHECK (normalized_usage_complete IN (0, 1));
    ALTER TABLE analytics_provider_settlements
      ADD COLUMN reasoning_included_in_output INTEGER CHECK (reasoning_included_in_output IN (0, 1));

    ALTER TABLE analytics_detail_payloads
      ADD COLUMN media_type TEXT NOT NULL DEFAULT 'application/x-pie-subagent-result';
    ALTER TABLE analytics_detail_payloads
      ADD COLUMN source_encoding TEXT NOT NULL DEFAULT 'node-v8';
    ALTER TABLE analytics_detail_payloads
      ADD COLUMN complete INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0, 1));
    ALTER TABLE analytics_detail_payloads ADD COLUMN capture_stage TEXT;
    ALTER TABLE analytics_detail_payloads ADD COLUMN source_version TEXT;
    ALTER TABLE analytics_detail_payloads ADD COLUMN omission_reason TEXT;

    ALTER TABLE analytics_deleted_subjects
      ADD COLUMN scrub_state TEXT NOT NULL DEFAULT 'pending' CHECK (scrub_state IN ('pending', 'complete'));
    ALTER TABLE analytics_deleted_subjects ADD COLUMN scrub_error TEXT;

    CREATE INDEX analytics_execution_state_subject_idx
      ON analytics_execution_states(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_tool_state_subject_idx
      ON analytics_tool_states(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_activity_state_subject_idx
      ON analytics_activity_states(capture_subject_kind, capture_subject_key);

    CREATE TABLE analytics_generations (
      generation_id TEXT PRIMARY KEY,
      first_observed_at_ms TEXT NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO analytics_generations (generation_id, first_observed_at_ms)
      SELECT generation_id, MIN(observed_at_ms) FROM analytics_observations GROUP BY generation_id;
    INSERT OR IGNORE INTO analytics_generations (generation_id, first_observed_at_ms)
      SELECT generation_id, MIN(observed_at_ms) FROM analytics_detail_payloads GROUP BY generation_id;

    CREATE TABLE analytics_delivery_accounting (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      observations_delivered TEXT NOT NULL,
      observations_accepted TEXT NOT NULL,
      observations_replayed TEXT NOT NULL,
      observations_deleted TEXT NOT NULL,
      details_delivered TEXT NOT NULL,
      details_accepted TEXT NOT NULL,
      details_replayed TEXT NOT NULL,
      details_deleted TEXT NOT NULL,
      delivery_history_coverage TEXT NOT NULL CHECK (delivery_history_coverage IN ('complete', 'retained_only'))
    ) STRICT;
    INSERT INTO analytics_delivery_accounting (
      singleton,
      observations_delivered, observations_accepted, observations_replayed, observations_deleted,
      details_delivered, details_accepted, details_replayed, details_deleted,
      delivery_history_coverage
    ) SELECT 1,
      CAST(COUNT(*) AS TEXT), CAST(COUNT(*) AS TEXT), '0', '0',
      CAST((SELECT COUNT(*) FROM analytics_detail_payloads) AS TEXT),
      CAST((SELECT COUNT(*) FROM analytics_detail_payloads) AS TEXT), '0', '0',
      '${deliveryHistoryCoverage}'
    FROM analytics_observations;

    CREATE TRIGGER analytics_detail_reference_last_owner_cleanup
    AFTER DELETE ON analytics_detail_references
    WHEN NOT EXISTS (
      SELECT 1 FROM analytics_detail_references WHERE digest = OLD.digest
    )
    BEGIN
      DELETE FROM analytics_detail_content WHERE digest = OLD.digest;
    END;

    DELETE FROM analytics_detail_content
    WHERE NOT EXISTS (
      SELECT 1 FROM analytics_detail_references reference
      WHERE reference.digest = analytics_detail_content.digest
    );

    CREATE VIEW analytics_provider_usage_v1 AS
      SELECT generation_id, invocation_id, root_session_id AS owning_root_session_id,
        provider, dispatched_model, reported_model, effective_model, purpose, outcome,
        settled_at_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, provider_total_tokens,
        normalized_base_input_tokens, normalized_output_tokens,
        normalized_cache_read_tokens, normalized_cache_write_tokens,
        normalized_total_tokens, normalized_usage_complete, reasoning_included_in_output,
        reported_cost_usd, calculated_cost_usd,
        calculated_cost_complete, effective_cost_usd, effective_cost_source,
        effective_cost_coverage, projection_revision
      FROM analytics_provider_settlements;
  `);
  backfillV3NormalizedUsage(database);
  // V2 retained every accepted source sequence. V3 needs only bounded
  // out-of-order receipts above the compact contiguous watermark.
  database.exec(`
    DELETE FROM analytics_producer_sequences
    WHERE CAST(source_sequence AS INTEGER) <= CAST((
      SELECT contiguous_watermark FROM analytics_producer_reconciliation state
      WHERE state.producer_identity = analytics_producer_sequences.producer_identity
    ) AS INTEGER);
  `);
}

function migrateV4(database: SqliteDatabase): void {
  database.exec(`
    ALTER TABLE analytics_provider_settlements ADD COLUMN execution_id TEXT;
    ALTER TABLE analytics_provider_settlements ADD COLUMN branch_id TEXT;
    CREATE INDEX analytics_provider_settlement_branch_idx
      ON analytics_provider_settlements(root_session_id, branch_id, projection_revision);

    CREATE TABLE analytics_branch_edges (
      generation_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      parent_branch_id TEXT,
      parent_known INTEGER NOT NULL CHECK (parent_known IN (0, 1)),
      source_entry_id TEXT,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, branch_id)
    ) STRICT;
    CREATE INDEX analytics_branch_edge_subject_idx
      ON analytics_branch_edges(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_branch_edge_root_idx
      ON analytics_branch_edges(root_session_id, branch_id);

    CREATE TABLE analytics_branch_selections (
      observation_registry_key TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      source_selection_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      observed_at_ms TEXT NOT NULL,
      projection_revision TEXT NOT NULL
    ) STRICT;
    CREATE INDEX analytics_branch_selection_subject_idx
      ON analytics_branch_selections(capture_subject_kind, capture_subject_key);

    CREATE TABLE analytics_current_branch_selections (
      generation_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      root_session_id TEXT,
      branch_id TEXT NOT NULL,
      source_selection_id TEXT NOT NULL,
      observed_at_ms TEXT NOT NULL,
      observation_registry_key TEXT NOT NULL,
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, capture_subject_kind, capture_subject_key)
    ) STRICT;
    CREATE INDEX analytics_current_branch_root_idx
      ON analytics_current_branch_selections(root_session_id);

    CREATE TABLE analytics_session_copies (
      generation_id TEXT NOT NULL,
      copy_root_session_id TEXT NOT NULL,
      capture_subject_kind TEXT NOT NULL,
      capture_subject_key TEXT NOT NULL,
      source_root_session_id TEXT,
      source_branch_id TEXT,
      operation_id TEXT NOT NULL,
      inheritance_coverage TEXT NOT NULL CHECK (inheritance_coverage IN ('known', 'unknown')),
      inheritance_unavailable_reason TEXT CHECK (inheritance_unavailable_reason IN ('source_scrubbed')),
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(generation_id, copy_root_session_id),
      UNIQUE(generation_id, operation_id)
    ) STRICT;
    CREATE INDEX analytics_session_copy_subject_idx
      ON analytics_session_copies(capture_subject_kind, capture_subject_key);
    CREATE INDEX analytics_session_copy_source_idx
      ON analytics_session_copies(source_root_session_id);

    DROP VIEW analytics_provider_usage_v1;
    CREATE VIEW analytics_provider_usage_v1 AS
      SELECT generation_id, invocation_id, root_session_id AS owning_root_session_id,
        execution_id, branch_id,
        provider, dispatched_model, reported_model, effective_model, purpose, outcome,
        settled_at_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, provider_total_tokens,
        normalized_base_input_tokens, normalized_output_tokens,
        normalized_cache_read_tokens, normalized_cache_write_tokens,
        normalized_total_tokens, normalized_usage_complete, reasoning_included_in_output,
        reported_cost_usd, calculated_cost_usd,
        calculated_cost_complete, effective_cost_usd, effective_cost_source,
        effective_cost_coverage, projection_revision
      FROM analytics_provider_settlements;
  `);
}

/** Serve the settlement projection's declared ordering from an index.
 *
 * `readProviderSettlements` orders by `CAST(projection_revision AS INTEGER),
 * generation_id, invocation_id`. Because the leading key is a cast expression,
 * SQLite cannot satisfy that ordering from any plain index and falls back to a
 * full table SCAN plus a temporary B-tree — even when the caller supplies a
 * small LIMIT, so a bounded page still reads every settlement. Measured at
 * 250,000 settlements: the bounded read dropped from 30.7 ms to 0.8 ms once the
 * matching expression index existed, and the temp B-tree disappeared. This is
 * an additive index only; no stored value or ordering semantics change. */
/** Index the reference-cleanup trigger's digest lookup.
 *
 * `analytics_detail_references` is keyed `(payload_id, digest)`, so its primary
 * key cannot serve a lookup by `digest` alone. The last-owner cleanup trigger
 * runs `SELECT 1 FROM analytics_detail_references WHERE digest = OLD.digest`
 * **once per deleted reference row**, which therefore scanned the whole
 * reference table each time. Internal phase profiling attributed 119,382 ms of a
 * 128,675 ms private delete to the payload delete that cascades into this
 * trigger, and an isolated probe measured the pattern dropping from 9,359 ms to
 * 60 ms once `digest` was indexed, with identical results. Additive only. */
function ensureReferenceDigestIndex(database: SqliteDatabase): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS analytics_detail_reference_digest_idx
      ON analytics_detail_references(digest);
  `);
}

/** Serve the private-close copy-scrub predicate from a partial index.
 *
 * `deleteSession` locates copy-sourced observations with
 * `entity_kind = 'copy' AND json_extract(payload_json, '$.fields.sourceSessionId') = ?`
 * and runs it **twice** — once to sum the removed payload bytes for the
 * maintained counter, then again as the DELETE. `entity_kind` had no index, so
 * both were full scans of every observation. At 1M facts the two scans plus the
 * surrounding work exceeded the supervisor's 30 s IPC bound, which killed the
 * worker mid-delete (the real cause surfaced only after the supervisor stopped
 * reporting a bare SIGTERM).
 *
 * The predicate can never match a non-copy row, so the index is **partial** and
 * stays a small fraction of the table regardless of total history.
 * `json_extract` remains a residual filter within the copy rows, which are few.
 * Additive only: no stored value, row count or ordering changes. */
function ensureCopyScrubIndex(database: SqliteDatabase): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS analytics_copy_scrub_idx
      ON analytics_observations(entity_kind, root_session_id)
      WHERE entity_kind = 'copy';
  `);
}

/** Maintain a running total of stored fact payload bytes.
 *
 * `readStorageSummary` reported `factsLogicalBytes` by running
 * `SUM(LENGTH(payload_json))` over every observation. At 1,000,000 facts that
 * full-table aggregate costs roughly ten seconds on the query helper's event
 * loop, which made the `storage` logical command exceed the client's 10-second
 * default (measured: `storage` 10,022 ms against every other worker command
 * under 400 ms). The total is now a maintained counter, updated in the same
 * transactions that insert and delete observations, so reading it is O(1) like
 * the existing delivery accounting. The counter holds the same quantity the
 * aggregate computed; only how it is obtained changes.
 *
 * `factsPayloadBytes` also lands on `analytics_delivery_accounting`, but that
 * table is version-recreated by migrateV3's `retained_only` path, so the column
 * is added by an idempotent ALTER here instead of in the CREATE statement. */
function ensureFactByteCounter(database: SqliteDatabase): void {
  const columns = database.prepare('PRAGMA table_info(analytics_delivery_accounting)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'facts_payload_bytes')) {
    database.exec(`
      ALTER TABLE analytics_delivery_accounting
        ADD COLUMN facts_payload_bytes TEXT NOT NULL DEFAULT '0';
    `);
  }
  // Seed from the stored rows exactly once, then track incrementally. A zero
  // counter with a non-empty table means it was never seeded.
  const state = database.prepare(`
    SELECT facts_payload_bytes AS bytes,
      (SELECT COUNT(*) FROM analytics_observations) AS observations
    FROM analytics_delivery_accounting WHERE singleton = 1
  `).get() as { bytes: string; observations: number | bigint } | undefined;
  if (!state) return;
  if (BigInt(state.bytes) === 0n && toNumber(state.observations) > 0) {
    database.exec(`
      UPDATE analytics_delivery_accounting
      SET facts_payload_bytes = CAST((
        SELECT COALESCE(SUM(LENGTH(payload_json)), 0) FROM analytics_observations
      ) AS TEXT)
      WHERE singleton = 1;
    `);
  }
}

/** Serve the settlement projection's declared ordering from an index.
 *
 * `readProviderSettlements` orders by `CAST(projection_revision AS INTEGER),
 * generation_id, invocation_id`. Because the leading key is a cast expression,
 * SQLite cannot satisfy that ordering from any plain index and falls back to a
 * full table SCAN plus a temporary B-tree — even when the caller supplies a
 * small LIMIT, so a bounded page still reads every settlement. Measured at
 * 250,000 settlements: the bounded read dropped from 30.7 ms to 0.8 ms once the
 * matching expression index existed, and the temp B-tree disappeared. This is
 * an additive index only; no stored value or ordering semantics change. */
function migrateV5(database: SqliteDatabase): void {
  // IF NOT EXISTS keeps the step idempotent: a database may already carry the
  // index if an earlier run was interrupted between creating it and committing
  // the version bump, and an explicit re-run must not fail.
  database.exec(`
    CREATE INDEX IF NOT EXISTS analytics_provider_settlement_projection_order_idx
      ON analytics_provider_settlements(
        CAST(projection_revision AS INTEGER), generation_id, invocation_id
      );
  `);
  ensureFactByteCounter(database);
}

/** Schema v6 -> v7: the partial copy-scrub index described on
 * {@link ensureCopyScrubIndex}. Additive only. */
function migrateV6(database: SqliteDatabase): void {
  ensureCopyScrubIndex(database);
}

/** Schema v7 -> v8: the reference-digest index described on
 * {@link ensureReferenceDigestIndex}. Additive only. */
function migrateV7(database: SqliteDatabase): void {
  ensureReferenceDigestIndex(database);
}

/** Schema v8 -> v9: retain provider/model/purpose/workspace dimensions in
 * writer-maintained all-time and bounded local-day summaries. The backfill is
 * deliberately one-off and streams settlement rows; ordinary reads never
 * rebuild either table or scan settlement history. */
function migrateV8(database: SqliteDatabase): void {
  createProviderProjectionSchema(database as unknown as ProviderProjectionDatabase);
  database.exec(`
    UPDATE analytics_provider_settlements
    SET workspace_coverage = CASE
      WHEN json_extract((SELECT payload_json FROM analytics_observations observation
        WHERE observation.registry_key = analytics_provider_settlements.observation_registry_key),
        '$.scope.workspaceCoverage') IN ('known', 'unknown', 'not_applicable')
        THEN json_extract((SELECT payload_json FROM analytics_observations observation
          WHERE observation.registry_key = analytics_provider_settlements.observation_registry_key),
          '$.scope.workspaceCoverage')
      ELSE 'unknown' END,
      workspace_key = CASE
        WHEN json_extract((SELECT payload_json FROM analytics_observations observation
          WHERE observation.registry_key = analytics_provider_settlements.observation_registry_key),
          '$.scope.workspaceCoverage') = 'known'
          THEN COALESCE(json_extract((SELECT payload_json FROM analytics_observations observation
            WHERE observation.registry_key = analytics_provider_settlements.observation_registry_key),
            '$.scope.workspaceId'), '')
        ELSE '' END;
  `);
  rebuildProviderProjection(database as unknown as ProviderProjectionDatabase);
}

/** Schema v9 -> v10: maintain the bounded root-agent execution summary.
 *
 * Execution state rows already contain the durable lifecycle identity.  The
 * additive columns record which state transition settled it and the summary
 * table keeps global/session counts out of the live aggregate read path.  The
 * backfill joins the retained typed observation to its raw observation only
 * to recover the original source key; it never invents a completion for a
 * state that has no retained end observation.
 */
function migrateV9(database: SqliteDatabase): void {
  const stateColumns = new Set((database.prepare('PRAGMA table_info(analytics_execution_states)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!stateColumns.has('settled')) {
    database.exec(`ALTER TABLE analytics_execution_states
      ADD COLUMN settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1));`);
  }
  if (!stateColumns.has('settled_source_key')) {
    database.exec('ALTER TABLE analytics_execution_states ADD COLUMN settled_source_key TEXT;');
  }
  if (!stateColumns.has('settled_revision')) {
    database.exec('ALTER TABLE analytics_execution_states ADD COLUMN settled_revision TEXT;');
  }
  if (!stateColumns.has('began')) {
    database.exec(`ALTER TABLE analytics_execution_states
      ADD COLUMN began INTEGER NOT NULL DEFAULT 0 CHECK (began IN (0, 1));`);
  }
  if (!stateColumns.has('begin_source_key')) {
    database.exec('ALTER TABLE analytics_execution_states ADD COLUMN begin_source_key TEXT;');
  }
  database.exec(`
    DROP INDEX IF EXISTS analytics_execution_state_latest_idx;
    CREATE INDEX IF NOT EXISTS analytics_execution_state_latest_global_idx
      ON analytics_execution_states(
        operation_kind, settled, CAST(settled_revision AS INTEGER), generation_id, execution_id
      );
    CREATE INDEX IF NOT EXISTS analytics_execution_state_latest_session_idx
      ON analytics_execution_states(
        root_session_id, operation_kind, settled,
        CAST(settled_revision AS INTEGER), generation_id, execution_id
      );
    CREATE TABLE IF NOT EXISTS analytics_execution_summary (
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'session')),
      scope_key TEXT NOT NULL,
      execution_count TEXT NOT NULL,
      begun_count TEXT NOT NULL DEFAULT '0',
      settled_count TEXT NOT NULL,
      started_at_count TEXT NOT NULL DEFAULT '0',
      ended_at_count TEXT NOT NULL DEFAULT '0',
      projection_revision TEXT NOT NULL,
      PRIMARY KEY(scope_kind, scope_key)
    ) STRICT;
  `);
  const summaryColumns = new Set((database.prepare('PRAGMA table_info(analytics_execution_summary)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!summaryColumns.has('begun_count')) {
    database.exec(`ALTER TABLE analytics_execution_summary
      ADD COLUMN begun_count TEXT NOT NULL DEFAULT '0';`);
  }
  if (!summaryColumns.has('started_at_count')) {
    database.exec(`ALTER TABLE analytics_execution_summary
      ADD COLUMN started_at_count TEXT NOT NULL DEFAULT '0';`);
  }
  if (!summaryColumns.has('ended_at_count')) {
    database.exec(`ALTER TABLE analytics_execution_summary
      ADD COLUMN ended_at_count TEXT NOT NULL DEFAULT '0';`);
  }
  database.exec(`
    DELETE FROM analytics_execution_summary;
    UPDATE analytics_execution_states
    SET operation_kind = 'agent-run'
    WHERE EXISTS (
      SELECT 1 FROM analytics_execution_observations typed
      WHERE typed.generation_id = analytics_execution_states.generation_id
        AND typed.execution_id = analytics_execution_states.execution_id
        AND typed.operation_kind = 'agent-run'
        AND typed.observation_kind IN ('begin', 'end')
    );
    UPDATE analytics_execution_states
    SET started_at_ms = (
          SELECT typed.started_at_ms
          FROM analytics_execution_observations typed
          WHERE typed.generation_id = analytics_execution_states.generation_id
            AND typed.execution_id = analytics_execution_states.execution_id
            AND typed.observation_kind = 'begin'
            AND typed.operation_kind = 'agent-run'
            AND typed.started_at_ms IS NOT NULL
          ORDER BY CAST(typed.projection_revision AS INTEGER) ASC
          LIMIT 1
        ),
        ended_at_ms = (
          SELECT typed.ended_at_ms
          FROM analytics_execution_observations typed
          WHERE typed.generation_id = analytics_execution_states.generation_id
            AND typed.execution_id = analytics_execution_states.execution_id
            AND typed.observation_kind = 'end'
            AND typed.operation_kind = 'agent-run'
            AND typed.ended_at_ms IS NOT NULL
          ORDER BY CAST(typed.projection_revision AS INTEGER) ASC
          LIMIT 1
        );
    UPDATE analytics_execution_states
    SET settled = 1,
        settled_source_key = (
          SELECT raw.source_key
          FROM analytics_execution_observations typed
          JOIN analytics_observations raw
            ON raw.registry_key = typed.observation_registry_key
          WHERE typed.generation_id = analytics_execution_states.generation_id
            AND typed.execution_id = analytics_execution_states.execution_id
            AND typed.observation_kind = 'end'
            AND typed.operation_kind = 'agent-run'
          ORDER BY CAST(typed.projection_revision AS INTEGER) DESC
          LIMIT 1
        ),
        settled_revision = (
          SELECT typed.projection_revision
          FROM analytics_execution_observations typed
          WHERE typed.generation_id = analytics_execution_states.generation_id
            AND typed.execution_id = analytics_execution_states.execution_id
            AND typed.observation_kind = 'end'
            AND typed.operation_kind = 'agent-run'
          ORDER BY CAST(typed.projection_revision AS INTEGER) DESC
          LIMIT 1
        )
    WHERE EXISTS (
      SELECT 1 FROM analytics_execution_observations typed
      WHERE typed.generation_id = analytics_execution_states.generation_id
        AND typed.execution_id = analytics_execution_states.execution_id
        AND typed.observation_kind = 'end'
        AND typed.operation_kind = 'agent-run'
    );
    UPDATE analytics_execution_states
    SET began = 1,
        begin_source_key = (
          SELECT raw.source_key
          FROM analytics_execution_observations typed
          JOIN analytics_observations raw
            ON raw.registry_key = typed.observation_registry_key
          WHERE typed.generation_id = analytics_execution_states.generation_id
            AND typed.execution_id = analytics_execution_states.execution_id
            AND typed.observation_kind = 'begin'
            AND typed.operation_kind = 'agent-run'
          ORDER BY CAST(typed.projection_revision AS INTEGER) ASC
          LIMIT 1
        )
    WHERE EXISTS (
      SELECT 1 FROM analytics_execution_observations typed
      WHERE typed.generation_id = analytics_execution_states.generation_id
        AND typed.execution_id = analytics_execution_states.execution_id
        AND typed.observation_kind = 'begin'
        AND typed.operation_kind = 'agent-run'
    );
    INSERT INTO analytics_execution_summary (
      scope_kind, scope_key, execution_count, begun_count, settled_count,
      started_at_count, ended_at_count, projection_revision
    ) VALUES ('global', '*',
      CAST((SELECT COUNT(*) FROM analytics_execution_states
        WHERE operation_kind = 'agent-run') AS TEXT),
      CAST((SELECT COUNT(*) FROM analytics_execution_states
        WHERE operation_kind = 'agent-run' AND began = 1) AS TEXT),
      CAST((SELECT COUNT(*) FROM analytics_execution_states
        WHERE operation_kind = 'agent-run' AND settled = 1) AS TEXT),
      CAST((SELECT COUNT(*) FROM analytics_execution_states
        WHERE operation_kind = 'agent-run' AND started_at_ms IS NOT NULL) AS TEXT),
      CAST((SELECT COUNT(*) FROM analytics_execution_states
        WHERE operation_kind = 'agent-run' AND ended_at_ms IS NOT NULL) AS TEXT),
      COALESCE((SELECT revision FROM analytics_projection_state WHERE singleton = 1), '0'));
    INSERT INTO analytics_execution_summary (
      scope_kind, scope_key, execution_count, begun_count, settled_count,
      started_at_count, ended_at_count, projection_revision
    )
    SELECT 'session', root_session_id,
      CAST(COUNT(*) AS TEXT),
      CAST(SUM(CASE WHEN began = 1 THEN 1 ELSE 0 END) AS TEXT),
      CAST(SUM(CASE WHEN settled = 1 THEN 1 ELSE 0 END) AS TEXT),
      CAST(SUM(CASE WHEN started_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS TEXT),
      CAST(SUM(CASE WHEN ended_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS TEXT),
      COALESCE((SELECT revision FROM analytics_projection_state WHERE singleton = 1), '0')
    FROM analytics_execution_states
    WHERE operation_kind = 'agent-run' AND root_session_id IS NOT NULL
    GROUP BY root_session_id;
  `);
}

/** Schema v10 -> v11: add source-time and exact execution lookup indexes for
 * the bounded canonical latest-run projection. Delivery revision remains the
 * ordering used by the diagnostic latestSettled field. */
function migrateV10(database: SqliteDatabase): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS analytics_execution_state_source_end_global_idx
      ON analytics_execution_states(
        operation_kind, settled, CAST(ended_at_ms AS INTEGER) DESC,
        generation_id DESC, execution_id DESC
      )
      WHERE ended_at_ms IS NOT NULL;
    CREATE INDEX IF NOT EXISTS analytics_execution_state_source_end_session_idx
      ON analytics_execution_states(
        root_session_id, operation_kind, settled,
        CAST(ended_at_ms AS INTEGER) DESC, generation_id DESC, execution_id DESC
      )
      WHERE ended_at_ms IS NOT NULL;
    CREATE INDEX IF NOT EXISTS analytics_provider_settlement_execution_idx
      ON analytics_provider_settlements(generation_id, execution_id, invocation_id)
      WHERE execution_id IS NOT NULL;
  `);
}

/** Schema v11 -> v12: bounded activity projection members and scoped additive
 * summaries, seeded from retained activity states without fabricated values.
 * Stored null anchors, durations and coverage stay exactly as captured; a
 * span's measured clock domain is recovered from the observation that actually
 * delivered a measured duration and stays unknown when no observation proves
 * one. Late evidence merged into the state rows before this upgrade is
 * seeded as-is, never collapsed or reconstructed. */
function migrateV11(database: SqliteDatabase): void {
  createActivityProjectionSchema(database as unknown as ActivityProjectionDatabase);
  const rows = database.prepare(`
    SELECT s.generation_id, s.span_id, s.capture_subject_kind, s.capture_subject_key,
      s.root_session_id, s.activity_kind, s.started_at_ms, s.ended_at_ms,
      s.duration_ms, s.coverage,
      (SELECT json_extract(o.payload_json, '$.fields.clockDomain')
        FROM analytics_activity_observations o
        WHERE o.generation_id = s.generation_id AND o.span_id = s.span_id
          AND json_extract(o.payload_json, '$.fields.durationMs') IS NOT NULL
        ORDER BY o.rowid DESC LIMIT 1) AS clock_domain
    FROM analytics_activity_states s
    ORDER BY s.rowid
  `).iterate() as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    applyActivityProjection(database as unknown as ActivityProjectionDatabase, {
      generationId: String(row.generation_id),
      spanId: String(row.span_id),
      captureSubjectKind: String(row.capture_subject_kind),
      captureSubjectKey: String(row.capture_subject_key),
      rootSessionId: row.root_session_id === null || row.root_session_id === undefined
        ? null : String(row.root_session_id),
      kind: row.activity_kind === null || row.activity_kind === undefined
        ? null : String(row.activity_kind),
      clockDomain: row.clock_domain === null || row.clock_domain === undefined
        ? null : String(row.clock_domain),
      startedAtMs: row.started_at_ms === null || row.started_at_ms === undefined
        ? null : String(row.started_at_ms),
      endedAtMs: row.ended_at_ms === null || row.ended_at_ms === undefined
        ? null : String(row.ended_at_ms),
      durationMs: row.duration_ms === null || row.duration_ms === undefined
        ? null : Number(row.duration_ms),
      coverage: row.coverage === null || row.coverage === undefined
        ? null : String(row.coverage),
    }, '0');
  }
}

function databaseTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }
}

function initializeSchema(database: SqliteDatabase, readOnly = false): void {
  configureDatabase(database, readOnly);
  if (readOnly) {
    const version = toNumber((database.prepare('PRAGMA user_version').get() as UserVersionRow).user_version);
    if (version !== DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Read-only analytics query requires schema version ${DATABASE_SCHEMA_VERSION}; found ${version}.`,
      );
    }
    return;
  }
  // Acquire the migration-writer lock before selecting the version, then
  // re-evaluate it under that lock. Concurrent fresh helpers therefore see
  // the schema committed by the winner rather than replaying CREATE TABLE.
  databaseTransaction(database, () => {
    const version = toNumber((database.prepare('PRAGMA user_version').get() as UserVersionRow).user_version);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported newer analytics database schema version ${version}; this recorder supports ${DATABASE_SCHEMA_VERSION}.`,
      );
    }
    if (version === 0) {
      const existing = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'analytics_%'
        LIMIT 1
      `).get();
      if (existing) throw new Error('Unsupported unversioned analytics database schema.');
      createV1Tables(database);
      createV2Tables(database);
      migrateV3(database, 'complete');
      migrateV4(database);
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 1) {
      createV2Tables(database);
      migrateV3(database, 'retained_only');
      migrateV4(database);
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      backfillV2(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 2) {
      migrateV3(database, 'retained_only');
      migrateV4(database);
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 3) {
      migrateV4(database);
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 4) {
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 5) {
      migrateV5(database);
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 6) {
      migrateV6(database);
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 7) {
      migrateV7(database);
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 8) {
      migrateV8(database);
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 9) {
      migrateV9(database);
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 10) {
      migrateV10(database);
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      return;
    }
    if (version === 11) {
      migrateV11(database);
      database.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    }
  });
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
  if ((capture.mediaType !== 'application/x-pie-subagent-result'
      && capture.mediaType !== 'application/x-pie-tool-observation')
    || capture.encoding !== 'node-v8'
    || capture.complete !== true
    || !(capture.bytes instanceof Uint8Array)) {
    throw new Error('Unsupported or incomplete analytics detail capture.');
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalToken(fields: Record<string, unknown>, name: keyof AnalyticsUsageChannels): string | null {
  const value = fields[name];
  if (value === null || value === undefined) return null;
  return parseNonNegativeInt64(value, `fields.${name}`).toString();
}

function normalizedUsage(fields: Record<string, unknown>): NormalizedUsageChannels {
  return normalizeUsageChannels({
    inputTokens: optionalToken(fields, 'inputTokens'),
    outputTokens: optionalToken(fields, 'outputTokens'),
    cacheReadTokens: optionalToken(fields, 'cacheReadTokens'),
    cacheWriteTokens: optionalToken(fields, 'cacheWriteTokens'),
    reasoningTokens: optionalToken(fields, 'reasoningTokens'),
    providerTotalTokens: optionalToken(fields, 'providerTotalTokens'),
    inputIncludesCache: fields.inputIncludesCache === true
      ? true
      : fields.inputIncludesCache === false ? false : undefined,
    outputIncludesReasoning: fields.outputIncludesReasoning === true
      ? true
      : fields.outputIncludesReasoning === false ? false : undefined,
    cacheChannelsOmittedAsZero: fields.cacheChannelsOmittedAsZero === true,
  });
}

function normalizedSqlValue(value: number | string | null): string | null {
  return value === null ? null : canonicalInt64(value);
}

interface ProviderCostProjection {
  reportedCost: number | null;
  calculatedCost: number | null;
  calculatedCostComplete: boolean;
  effectiveCost: number | null;
  effectiveSource: 'reported' | 'calculated' | null;
  effectiveCoverage: 'known' | 'unknown' | 'not_applicable';
}

function providerCostProjection(
  fields: Record<string, unknown>,
  normalized: NormalizedUsageChannels,
  invocationId: string,
): ProviderCostProjection {
  const reportedCost = optionalCost(fields.reportedCostUsd);
  const suppliedCalculatedCost = optionalCost(fields.calculatedCostUsd);
  const pricingProvided = fields.pricing !== null && fields.pricing !== undefined;
  const pricing = fields.pricing && typeof fields.pricing === 'object' && !Array.isArray(fields.pricing)
    ? fields.pricing as Record<string, unknown>
    : null;
  const canonicalCalculatedCost = pricing?.normalizationVersion === 'oracle-v1'
    && pricing.currency === 'USD'
    ? calculateCompleteCostUsd(normalized, {
        inputUsdPerMillionTokens: optionalCost(pricing.inputUsdPerMillionTokens),
        outputUsdPerMillionTokens: optionalCost(pricing.outputUsdPerMillionTokens),
        cacheReadUsdPerMillionTokens: optionalCost(pricing.cacheReadUsdPerMillionTokens),
        cacheWriteUsdPerMillionTokens: optionalCost(pricing.cacheWriteUsdPerMillionTokens),
      })
    : null;
  if (canonicalCalculatedCost !== null
    && suppliedCalculatedCost !== null
    && fields.calculatedCostComplete === true
    && !costWithinParityTolerance(suppliedCalculatedCost, canonicalCalculatedCost)) {
    throw new Error(`Provider settlement calculated cost does not match its pricing snapshot for ${invocationId}.`);
  }
  const calculatedCost = canonicalCalculatedCost ?? suppliedCalculatedCost;
  const calculatedCostComplete = canonicalCalculatedCost !== null
    || (!pricingProvided && suppliedCalculatedCost !== null && fields.calculatedCostComplete === true);
  const effectiveCost = reportedCost ?? (calculatedCostComplete ? calculatedCost : null);
  return {
    reportedCost,
    calculatedCost,
    calculatedCostComplete,
    effectiveCost,
    effectiveSource: reportedCost !== null ? 'reported' : effectiveCost !== null ? 'calculated' : null,
    effectiveCoverage: effectiveCost !== null
      ? 'known'
      : fields.effectiveCostCoverage === 'not_applicable' || fields.costCoverage === 'not_applicable'
        ? 'not_applicable'
        : 'unknown',
  };
}

function backfillV3NormalizedUsage(database: SqliteDatabase): void {
  const update = database.prepare(`
    UPDATE analytics_provider_settlements SET
      normalized_base_input_tokens = ?, normalized_output_tokens = ?,
      normalized_cache_read_tokens = ?, normalized_cache_write_tokens = ?,
      normalized_total_tokens = ?, normalized_usage_complete = ?, reasoning_included_in_output = ?,
      reported_cost_usd = ?, calculated_cost_usd = ?, calculated_cost_complete = ?,
      effective_cost_usd = ?, effective_cost_source = ?, effective_cost_coverage = ?
    WHERE generation_id = ? AND invocation_id = ?
  `);
  database.exec('DELETE FROM analytics_provider_accounting_projections;');
  let lastGeneration: string | null = null;
  let lastInvocation: string | null = null;
  while (true) {
    const rows = database.prepare(`
      SELECT settlement.generation_id, settlement.invocation_id,
        settlement.root_session_id, observation.payload_json
      FROM analytics_provider_settlements settlement
      JOIN analytics_observations observation
        ON observation.registry_key = settlement.observation_registry_key
      WHERE ? IS NULL
        OR settlement.generation_id > ?
        OR (settlement.generation_id = ? AND settlement.invocation_id > ?)
      ORDER BY settlement.generation_id, settlement.invocation_id
      LIMIT 512
    `).all(lastGeneration, lastGeneration, lastGeneration, lastInvocation) as Array<{
      generation_id: string;
      invocation_id: string;
      root_session_id: string | null;
      payload_json: string;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const observation = JSON.parse(row.payload_json) as AnalyticsObservation;
      const fields = observation.fields as Record<string, unknown>;
      const normalized = normalizedUsage(fields);
      const costs = providerCostProjection(fields, normalized, row.invocation_id);
      update.run(
        normalizedSqlValue(normalized.baseInputTokens),
        normalizedSqlValue(normalized.outputTokens),
        normalizedSqlValue(normalized.cacheReadTokens),
        normalizedSqlValue(normalized.cacheWriteTokens),
        normalizedSqlValue(normalized.totalTokens),
        normalized.complete ? 1 : 0,
        normalized.reasoningIncludedInOutput === null ? null : normalized.reasoningIncludedInOutput ? 1 : 0,
        costs.reportedCost,
        costs.calculatedCost,
        costs.calculatedCostComplete ? 1 : 0,
        costs.effectiveCost,
        costs.effectiveSource,
        costs.effectiveCoverage,
        row.generation_id,
        row.invocation_id,
      );
      const revision = nextProjectionRevision(database);
      const accountingValues = {
        inputTokens: normalizedSqlValue(normalized.baseInputTokens),
        outputTokens: normalizedSqlValue(normalized.outputTokens),
        cacheReadTokens: normalizedSqlValue(normalized.cacheReadTokens),
        cacheWriteTokens: normalizedSqlValue(normalized.cacheWriteTokens),
        reasoningTokens: normalizedSqlValue(normalized.reasoningTokens),
        providerTotalTokens: optionalToken(fields, 'providerTotalTokens'),
        effectiveCost: costs.effectiveCost,
        effectiveSource: costs.effectiveSource,
      };
      updateProviderAccountingProjection(database, undefined, 'global', '*', revision, accountingValues, 1);
      if (row.root_session_id) {
        updateProviderAccountingProjection(database, undefined, 'session', row.root_session_id, revision, accountingValues, 1);
      }
    }
    lastGeneration = rows.at(-1)!.generation_id;
    lastInvocation = rows.at(-1)!.invocation_id;
  }
}

function sourceSequence(observation: AnalyticsObservation<object>): bigint | null {
  const value = (observation as AnalyticsObservation<object> & { sourceSequence?: unknown }).sourceSequence;
  return value === undefined || value === null
    ? null
    : parseNonNegativeInt64(value, 'sourceSequence');
}

function producerIdentity(observation: AnalyticsObservation<object>): string {
  const stableOriginId = observation.stableOriginId?.trim();
  if (stableOriginId) {
    return JSON.stringify([observation.generationId, observation.producerKind, stableOriginId]);
  }
  // Schema-v1 compatibility. New production adapters provide stableOriginId;
  // processId is only a last-resort discriminator for old captures.
  return JSON.stringify([
    observation.generationId,
    observation.producerKind,
    observation.producer.buildId,
    observation.producer.processGeneration ?? observation.producer.processId ?? null,
  ]);
}

function reconciliationGaps(sequences: readonly bigint[], contiguous: bigint): Array<{ from: string; to: string }> {
  const gaps: Array<{ from: string; to: string }> = [];
  let expected = contiguous + 1n;
  for (const sequence of sequences) {
    if (sequence <= contiguous) continue;
    if (sequence > expected) gaps.push({ from: expected.toString(), to: (sequence - 1n).toString() });
    expected = sequence + 1n;
  }
  return gaps;
}

/** Record one delivered producer sequence while retaining only bounded
 * out-of-order receipts. Contiguous receipts are represented by the watermark,
 * so reconciliation storage never grows with normal history. */
function recordSourceSequence(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  observation: AnalyticsObservation<object>,
  registryKey: string,
  fingerprint: string,
  replay: boolean,
): void {
  const sequence = sourceSequence(observation);
  if (sequence === null) return;
  const identity = producerIdentity(observation);
  const encoded = sequence.toString();
  const receiptDigest = createHash('sha256')
    .update(registryKey)
    .update('\0')
    .update(fingerprint)
    .digest('hex');
  const current = prepareWriterStatement(database, statements, 'reconciliation.current', `
    SELECT contiguous_watermark, highest_observed_sequence
    FROM analytics_producer_reconciliation WHERE producer_identity = ?
  `).get(identity) as { contiguous_watermark: string; highest_observed_sequence: string } | undefined;
  let contiguous = BigInt(current?.contiguous_watermark ?? '0');
  let highest = BigInt(current?.highest_observed_sequence ?? '0');

  if (sequence <= contiguous) {
    if (replay) return;
    throw new Error(`Analytics source sequence ${encoded} is behind contiguous watermark ${contiguous.toString()}.`);
  }

  const pending = prepareWriterStatement(database, statements, 'reconciliation.pending', `
    SELECT receipt_digest FROM analytics_producer_sequences
    WHERE producer_identity = ? AND source_sequence = ?
  `).get(identity, encoded) as { receipt_digest: string } | undefined;
  if (pending) {
    if (pending.receipt_digest !== receiptDigest) {
      throw new AnalyticsSourceConflictError(
        `${identity}:sourceSequence:${encoded}`,
        pending.receipt_digest,
        receiptDigest,
      );
    }
    if (replay) return;
    throw new Error(`Analytics source sequence ${encoded} was already delivered without this source fact.`);
  }

  highest = sequence > highest ? sequence : highest;
  if (sequence === contiguous + 1n) {
    contiguous = sequence;
    while (true) {
      const next = (contiguous + 1n).toString();
      const receipt = prepareWriterStatement(database, statements, 'reconciliation.next', `
        SELECT receipt_digest FROM analytics_producer_sequences
        WHERE producer_identity = ? AND source_sequence = ?
      `).get(identity, next) as { receipt_digest: string } | undefined;
      if (!receipt) break;
      prepareWriterStatement(database, statements, 'reconciliation.delete-next', `
        DELETE FROM analytics_producer_sequences
        WHERE producer_identity = ? AND source_sequence = ?
      `).run(identity, next);
      contiguous += 1n;
    }
  } else {
    const pendingCount = toNumber((prepareWriterStatement(database, statements, 'reconciliation.pending-count', `
      SELECT COUNT(*) AS count FROM analytics_producer_sequences WHERE producer_identity = ?
    `).get(identity) as CountRow).count);
    if (pendingCount >= MAX_PENDING_SEQUENCES_PER_PRODUCER) {
      throw new Error(`Analytics producer reconciliation capacity exceeded for ${identity}.`);
    }
    prepareWriterStatement(database, statements, 'reconciliation.insert-pending', `
      INSERT INTO analytics_producer_sequences (
        producer_identity, source_sequence, receipt_digest
      ) VALUES (?, ?, ?)
    `).run(identity, encoded, receiptDigest);
  }

  const pendingRows = prepareWriterStatement(database, statements, 'reconciliation.pending-rows', `
    SELECT source_sequence FROM analytics_producer_sequences
    WHERE producer_identity = ? ORDER BY CAST(source_sequence AS INTEGER)
    LIMIT ?
  `).all(identity, MAX_PENDING_SEQUENCES_PER_PRODUCER) as Array<{ source_sequence: string }>;
  const pendingSequences = pendingRows.map((row) => BigInt(row.source_sequence));
  const gaps = reconciliationGaps(pendingSequences, contiguous);
  prepareWriterStatement(database, statements, 'reconciliation.upsert', `
    INSERT INTO analytics_producer_reconciliation (
      producer_identity, contiguous_watermark, highest_observed_sequence, visible_gaps_json
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(producer_identity) DO UPDATE SET
      contiguous_watermark = excluded.contiguous_watermark,
      highest_observed_sequence = excluded.highest_observed_sequence,
      visible_gaps_json = excluded.visible_gaps_json
  `).run(identity, contiguous.toString(), highest.toString(), JSON.stringify(gaps));
}

function nextProjectionRevision(database: SqliteDatabase, statements?: WriterStatementCache): string {
  const row = prepareWriterStatement(database, statements, 'projection.revision.read',
    'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
  ).get() as RevisionRow;
  const revision = parseNonNegativeInt64(row.revision, 'projectionRevision') + 1n;
  if (revision > ((1n << 63n) - 1n)) throw new Error('Analytics projection revision exhausted signed-64 range.');
  const encoded = revision.toString();
  prepareWriterStatement(database, statements, 'projection.revision.update',
    'UPDATE analytics_projection_state SET revision = ? WHERE singleton = 1',
  ).run(encoded);
  return encoded;
}

const ACCOUNTING_CHANNELS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'providerTotalTokens',
] as const;

type AccountingChannel = typeof ACCOUNTING_CHANNELS[number];

interface StoredProviderAccounting {
  occurrenceCount: string;
  channels: Record<AccountingChannel, { knownCount: string; unknownCount: string; knownTotal: string }>;
  cost: {
    knownCount: string;
    unknownCount: string;
    reportedCount: string;
    calculatedCount: string;
    knownTotal: number;
  };
}

function encodeAggregateTotal(value: string): number | string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Stored provider accounting total is malformed.');
  }
  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

function emptyStoredProviderAccounting(): StoredProviderAccounting {
  return {
    occurrenceCount: '0',
    channels: Object.fromEntries(ACCOUNTING_CHANNELS.map((channel) => [channel, {
      knownCount: '0', unknownCount: '0', knownTotal: '0',
    }])) as StoredProviderAccounting['channels'],
    cost: { knownCount: '0', unknownCount: '0', reportedCount: '0', calculatedCount: '0', knownTotal: 0 },
  };
}

type DeliveryKind = 'observations' | 'details';
type DeliveryOutcome = 'accepted' | 'replayed' | 'deleted';

/** Add one stored observation's payload size to the maintained counter.
 *
 * The delta is computed by SQLite's own `LENGTH(?)` rather than in JavaScript
 * so the stored total is byte-for-byte the same expression the previous
 * full-table `SUM(LENGTH(payload_json))` aggregate used. */
function addFactBytes(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  payloadJson: string,
): void {
  prepareWriterStatement(database, statements, 'facts.bytes.add', `
    UPDATE analytics_delivery_accounting
    SET facts_payload_bytes = CAST(
      CAST(facts_payload_bytes AS INTEGER) + LENGTH(?) AS TEXT
    )
    WHERE singleton = 1
  `).run(payloadJson);
}

/** Subtract payload bytes removed by a deletion. The caller supplies a total
 * already measured with SQLite's `LENGTH(payload_json)` inside the same
 * transaction, so no value is left double-counted or stranded. */
function subtractFactBytes(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  bytes: bigint,
): void {
  if (bytes === 0n) return;
  prepareWriterStatement(database, statements, 'facts.bytes.subtract', `
    UPDATE analytics_delivery_accounting
    SET facts_payload_bytes = CAST(
      MAX(0, CAST(facts_payload_bytes AS INTEGER) - ?) AS TEXT
    )
    WHERE singleton = 1
  `).run(bytes.toString());
}

function incrementDeliveryAccounting(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  kind: DeliveryKind,
  outcome: DeliveryOutcome,
  count = 1n,
): void {
  const deliveredColumn = `${kind}_delivered`;
  const outcomeColumn = `${kind}_${outcome}`;
  const row = prepareWriterStatement(database, statements, `delivery.${kind}.${outcome}.read`, `
    SELECT ${deliveredColumn} AS delivered, ${outcomeColumn} AS outcome
    FROM analytics_delivery_accounting WHERE singleton = 1
  `).get() as { delivered: string; outcome: string };
  prepareWriterStatement(database, statements, `delivery.${kind}.${outcome}.update`, `
    UPDATE analytics_delivery_accounting
    SET ${deliveredColumn} = ?, ${outcomeColumn} = ?
    WHERE singleton = 1
  `).run(
    (BigInt(row.delivered) + count).toString(),
    (BigInt(row.outcome) + count).toString(),
  );
}

function updateProviderAccountingProjection(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  subjectKind: 'global' | 'session',
  subject: string,
  revision: string,
  values: Partial<Record<AccountingChannel, string | null>> & {
    effectiveCost: number | null;
    effectiveSource: 'reported' | 'calculated' | null;
  },
  direction: 1 | -1,
): void {
  const row = prepareWriterStatement(database, statements, 'provider.accounting.lookup', `
    SELECT summary_json FROM analytics_provider_accounting_projections
    WHERE subject_kind = ? AND subject_key = ?
  `).get(subjectKind, subject) as { summary_json: string } | undefined;
  const summary = row ? JSON.parse(row.summary_json) as StoredProviderAccounting : emptyStoredProviderAccounting();
  summary.occurrenceCount = (BigInt(summary.occurrenceCount) + BigInt(direction)).toString();
  for (const channel of ACCOUNTING_CHANNELS) {
    const target = summary.channels[channel];
    const value = values[channel];
    if (value === null || value === undefined) {
      target.unknownCount = (BigInt(target.unknownCount) + BigInt(direction)).toString();
    } else {
      target.knownCount = (BigInt(target.knownCount) + BigInt(direction)).toString();
      target.knownTotal = (BigInt(target.knownTotal) + BigInt(value) * BigInt(direction)).toString();
    }
  }
  if (values.effectiveCost === null) {
    summary.cost.unknownCount = (BigInt(summary.cost.unknownCount) + BigInt(direction)).toString();
  } else {
    summary.cost.knownCount = (BigInt(summary.cost.knownCount) + BigInt(direction)).toString();
    summary.cost.knownTotal += values.effectiveCost * direction;
    if (values.effectiveSource === 'reported') {
      summary.cost.reportedCount = (BigInt(summary.cost.reportedCount) + BigInt(direction)).toString();
    } else if (values.effectiveSource === 'calculated') {
      summary.cost.calculatedCount = (BigInt(summary.cost.calculatedCount) + BigInt(direction)).toString();
    }
  }
  if (summary.occurrenceCount === '0') Object.assign(summary, emptyStoredProviderAccounting());
  prepareWriterStatement(database, statements, 'provider.accounting.upsert', `
    INSERT INTO analytics_provider_accounting_projections (
      subject_kind, subject_key, summary_json, projection_revision
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_kind, subject_key) DO UPDATE SET
      summary_json = excluded.summary_json,
      projection_revision = excluded.projection_revision
  `).run(subjectKind, subject, JSON.stringify(summary), revision);
}

interface StoredExecutionSummaryCounts {
  execution_count: string | number | bigint;
  begun_count: string | number | bigint;
  settled_count: string | number | bigint;
  started_at_count: string | number | bigint;
  ended_at_count: string | number | bigint;
}

function safeExecutionSummaryCount(value: string | number | bigint, name: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`Canonical execution summary ${name} is not an integer.`);
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Canonical execution summary ${name} is outside the safe range.`);
  }
  return Number(parsed);
}

/** Apply an incremental execution count to the one-row global/session
 * projection. The read-modify-write is always performed by the caller's
 * existing SQLite transaction, so retries cannot double-apply a deletion or
 * pending-create bind. */
function updateExecutionSummary(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  scopeKind: 'global' | 'session',
  scopeKey: string,
  revision: string,
  delta: {
    executionCount: number;
    begunCount: number;
    settledCount: number;
    startedAtCount: number;
    endedAtCount: number;
  },
): void {
  if (!Number.isSafeInteger(delta.executionCount) || !Number.isSafeInteger(delta.settledCount)) {
    throw new RangeError('Canonical execution summary delta must use safe integers.');
  }
  const row = prepareWriterStatement(database, statements, 'typed.execution.summary.lookup', `
    SELECT execution_count, begun_count, settled_count, started_at_count, ended_at_count
    FROM analytics_execution_summary WHERE scope_kind = ? AND scope_key = ?
  `).get(scopeKind, scopeKey) as StoredExecutionSummaryCounts | undefined;
  const current = row ? {
    executionCount: safeExecutionSummaryCount(row.execution_count, 'execution_count'),
    begunCount: safeExecutionSummaryCount(row.begun_count, 'begun_count'),
    settledCount: safeExecutionSummaryCount(row.settled_count, 'settled_count'),
    startedAtCount: safeExecutionSummaryCount(row.started_at_count, 'started_at_count'),
    endedAtCount: safeExecutionSummaryCount(row.ended_at_count, 'ended_at_count'),
  } : { executionCount: 0, begunCount: 0, settledCount: 0, startedAtCount: 0, endedAtCount: 0 };
  const next = applyExecutionSummaryDelta(current, delta);
  if (scopeKind === 'session' && next.executionCount === 0 && next.settledCount === 0) {
    prepareWriterStatement(database, statements, 'typed.execution.summary.delete', `
      DELETE FROM analytics_execution_summary WHERE scope_kind = ? AND scope_key = ?
    `).run(scopeKind, scopeKey);
    return;
  }
  prepareWriterStatement(database, statements, 'typed.execution.summary.upsert', `
    INSERT INTO analytics_execution_summary (
      scope_kind, scope_key, execution_count, begun_count, settled_count,
      started_at_count, ended_at_count, projection_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
      execution_count = excluded.execution_count,
      begun_count = excluded.begun_count,
      settled_count = excluded.settled_count,
      started_at_count = excluded.started_at_count,
      ended_at_count = excluded.ended_at_count,
      projection_revision = excluded.projection_revision
  `).run(
    scopeKind,
    scopeKey,
    next.executionCount.toString(),
    next.begunCount.toString(),
    next.settledCount.toString(),
    next.startedAtCount.toString(),
    next.endedAtCount.toString(),
    revision,
  );
}

function applyProviderSettlement(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  observation: AnalyticsObservation<object>,
  registryKey: string,
  fingerprint: string,
): boolean {
  if (observation.observationKind !== 'providerSettlement') return false;
  const fields = observation.fields as Record<string, unknown>;
  const scopedInvocation = observation.scope.invocationId;
  const fieldInvocation = optionalString(fields.invocationId);
  if (scopedInvocation && fieldInvocation && scopedInvocation !== fieldInvocation) {
    throw new Error(`Provider settlement invocation identity mismatch: ${scopedInvocation} != ${fieldInvocation}.`);
  }
  const invocationId = scopedInvocation ?? fieldInvocation;
  if (!invocationId) throw new Error('Provider settlement requires an invocationId.');

  const existing = prepareWriterStatement(database, statements, 'provider.settlement.lookup', `
    SELECT settlement_fingerprint FROM analytics_provider_settlements
    WHERE generation_id = ? AND invocation_id = ?
  `).get(observation.generationId, invocationId) as { settlement_fingerprint: string } | undefined;
  if (existing) {
    if (existing.settlement_fingerprint !== fingerprint) {
      throw new AnalyticsSourceConflictError(
        `providerSettlement:${observation.generationId}:${invocationId}`,
        existing.settlement_fingerprint,
        fingerprint,
      );
    }
    return false;
  }

  const normalized = normalizedUsage(fields);
  const costs = providerCostProjection(fields, normalized, invocationId);
  const dispatchedModel = optionalString(fields.dispatchedModel);
  const reportedModel = optionalString(fields.reportedModel);
  const settledAt = fields.settledAtMs === null || fields.settledAtMs === undefined
    ? null
    : canonicalInt64(fields.settledAtMs as Int64Value);
  const revision = nextProjectionRevision(database, statements);
  prepareWriterStatement(database, statements, 'provider.settlement.insert', `
    INSERT INTO analytics_provider_settlements (
      generation_id, invocation_id, observation_registry_key, settlement_fingerprint,
      capture_subject_kind, capture_subject_key, root_session_id, execution_id, branch_id,
      workspace_key, workspace_coverage,
      provider, dispatched_model, reported_model, effective_model, purpose, outcome, settled_at_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, provider_total_tokens,
      normalized_base_input_tokens, normalized_output_tokens,
      normalized_cache_read_tokens, normalized_cache_write_tokens,
      normalized_total_tokens, normalized_usage_complete, reasoning_included_in_output,
      reported_cost_usd, calculated_cost_usd,
      calculated_cost_complete, effective_cost_usd, effective_cost_source,
      effective_cost_coverage, projection_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.generationId,
    invocationId,
    registryKey,
    fingerprint,
    observation.captureSubject.kind,
    subjectKey(observation),
    observation.scope.rootSessionId ?? null,
    observation.scope.executionId ?? null,
    observation.scope.branchId ?? null,
    observation.scope.workspaceCoverage === 'known' ? observation.scope.workspaceId ?? '' : '',
    observation.scope.workspaceCoverage,
    optionalString(fields.provider),
    dispatchedModel,
    reportedModel,
    reportedModel ?? dispatchedModel,
    optionalString(fields.purpose),
    optionalString(fields.outcome),
    settledAt,
    optionalToken(fields, 'inputTokens'),
    optionalToken(fields, 'outputTokens'),
    optionalToken(fields, 'cacheReadTokens'),
    optionalToken(fields, 'cacheWriteTokens'),
    optionalToken(fields, 'reasoningTokens'),
    optionalToken(fields, 'providerTotalTokens'),
    normalizedSqlValue(normalized.baseInputTokens),
    normalizedSqlValue(normalized.outputTokens),
    normalizedSqlValue(normalized.cacheReadTokens),
    normalizedSqlValue(normalized.cacheWriteTokens),
    normalizedSqlValue(normalized.totalTokens),
    normalized.complete ? 1 : 0,
    normalized.reasoningIncludedInOutput === null ? null : normalized.reasoningIncludedInOutput ? 1 : 0,
    costs.reportedCost,
    costs.calculatedCost,
    costs.calculatedCostComplete ? 1 : 0,
    costs.effectiveCost,
    costs.effectiveSource,
    costs.effectiveCoverage,
    revision,
  );
  const accountingValues = {
    inputTokens: normalizedSqlValue(normalized.baseInputTokens),
    outputTokens: normalizedSqlValue(normalized.outputTokens),
    cacheReadTokens: normalizedSqlValue(normalized.cacheReadTokens),
    cacheWriteTokens: normalizedSqlValue(normalized.cacheWriteTokens),
    reasoningTokens: normalizedSqlValue(normalized.reasoningTokens),
    providerTotalTokens: normalizedSqlValue(normalized.totalTokens),
    effectiveCost: costs.effectiveCost,
    effectiveSource: costs.effectiveSource,
  };
  const projectionSettlement: ProviderProjectionSettlement = {
    provider: optionalString(fields.provider),
    model: reportedModel ?? dispatchedModel,
    purpose: optionalString(fields.purpose),
    settledAtMs: settledAt,
    workspaceKey: observation.scope.workspaceCoverage === 'known' ? observation.scope.workspaceId ?? '' : '',
    workspaceCoverage: observation.scope.workspaceCoverage,
    inputTokens: accountingValues.inputTokens,
    outputTokens: accountingValues.outputTokens,
    cacheReadTokens: accountingValues.cacheReadTokens,
    cacheWriteTokens: accountingValues.cacheWriteTokens,
    reasoningTokens: accountingValues.reasoningTokens,
    providerTotalTokens: normalizedSqlValue(normalized.totalTokens),
    effectiveCostUsd: costs.effectiveCost,
    effectiveCostSource: costs.effectiveSource,
    effectiveCostCoverage: costs.effectiveCoverage,
  };
  applyProviderProjection(database as unknown as ProviderProjectionDatabase, projectionSettlement, revision, 1);
  if (observation.scope.rootSessionId) {
    incrementProviderSessionPresence(database as unknown as ProviderProjectionDatabase, observation.scope.rootSessionId, revision);
  }
  updateProviderAccountingProjection(database, statements, 'global', '*', revision, accountingValues, 1);
  if (observation.scope.rootSessionId) {
    updateProviderAccountingProjection(database, statements, 'session', observation.scope.rootSessionId, revision, accountingValues, 1);
  }
  return true;
}

function optionalTimestamp(value: unknown, _fieldName: string): string | null {
  return value === null || value === undefined ? null : canonicalInt64(value as Int64Value);
}

function optionalNonNegativeFloat(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function applyTypedObservation(
  database: SqliteDatabase,
  statements: WriterStatementCache | undefined,
  observation: AnalyticsObservation<object>,
  registryKey: string,
): boolean {
  const fields = observation.fields as Record<string, unknown>;
  const common = [
    registryKey,
    observation.generationId,
    observation.entityKey,
    observation.observationKind,
    observation.captureSubject.kind,
    subjectKey(observation),
    observation.scope.rootSessionId ?? null,
  ] as const;
  if (observation.entityKind === 'execution') {
    const operationKind = optionalString(fields.operationKind);
    // Turn phases and transcript evidence are facets of the already-started
    // agent execution. They must not replace its root kind in the durable
    // state projection; only a lifecycle begin/end observation may establish
    // or update that state-level classification.
    const stateOperationKind = observation.observationKind === 'begin'
      || observation.observationKind === 'end'
      ? operationKind
      : null;
    // Facets are retained as observations, but cannot revise lifecycle state
    // after the root execution has started or settled. In particular, a late
    // assistant phase must not replace a terminal outcome or timing.
    const stateOutcome = observation.observationKind === 'begin'
      || observation.observationKind === 'end'
      ? optionalString(fields.outcome)
      : null;
    const stateStartedAtMs = observation.observationKind === 'begin'
      || observation.observationKind === 'end'
      ? optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs')
      : null;
    const stateEndedAtMs = observation.observationKind === 'begin'
      || observation.observationKind === 'end'
      ? optionalTimestamp(fields.endedAtMs, 'fields.endedAtMs')
      : null;
    const stateBegan = observation.observationKind === 'begin' ? 1 : 0;
    const stateSettled = observation.observationKind === 'end' ? 1 : 0;
    const revision = nextProjectionRevision(database, statements);
    const previousState = prepareWriterStatement(database, statements, 'typed.execution.state.lookup', `
      SELECT operation_kind, began, settled, started_at_ms, ended_at_ms
      FROM analytics_execution_states
      WHERE generation_id = ? AND execution_id = ?
    `).get(observation.generationId, observation.entityKey) as {
      operation_kind: string | null;
      began: number | bigint;
      settled: number | bigint;
      started_at_ms: string | null;
      ended_at_ms: string | null;
    } | undefined;
    const previousOperationKind = previousState?.operation_kind ?? null;
    const previousBegan = previousState ? Number(previousState.began) === 1 : false;
    const previousSettled = previousState ? Number(previousState.settled) === 1 : false;
    const previousStartedAt = previousState?.started_at_ms ?? null;
    const previousEndedAt = previousState?.ended_at_ms ?? null;
    const effectiveOperationKind = stateOperationKind ?? previousOperationKind;
    const effectiveStartedAt = stateStartedAtMs ?? previousStartedAt;
    const effectiveEndedAt = stateEndedAtMs ?? previousEndedAt;
    const executionDelta = effectiveOperationKind === 'agent-run' && previousOperationKind !== 'agent-run'
      ? 1 : 0;
    const begunDelta = effectiveOperationKind === 'agent-run' && !previousBegan && stateBegan === 1
      ? 1 : 0;
    const settledDelta = effectiveOperationKind === 'agent-run' && !previousSettled && stateSettled === 1
      ? 1 : 0;
    const startedAtDelta = effectiveOperationKind === 'agent-run'
      && previousStartedAt === null && effectiveStartedAt !== null ? 1 : 0;
    const endedAtDelta = effectiveOperationKind === 'agent-run'
      && previousEndedAt === null && effectiveEndedAt !== null ? 1 : 0;
    prepareWriterStatement(database, statements, 'typed.execution.observation.insert', `
      INSERT INTO analytics_execution_observations (
        observation_registry_key, generation_id, execution_id, observation_kind,
        capture_subject_kind, capture_subject_key, root_session_id,
        operation_kind, outcome, started_at_ms, ended_at_ms, payload_json, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...common,
      operationKind,
      optionalString(fields.outcome),
      optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs'),
      optionalTimestamp(fields.endedAtMs, 'fields.endedAtMs'),
      serialize(observation),
      revision,
    );
    prepareWriterStatement(database, statements, 'typed.execution.state.upsert', `
      INSERT INTO analytics_execution_states (
        generation_id, execution_id, capture_subject_kind, capture_subject_key,
        root_session_id, operation_kind, outcome, started_at_ms, ended_at_ms,
        began, begin_source_key, settled, settled_source_key, settled_revision, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, execution_id) DO UPDATE SET
        operation_kind = COALESCE(excluded.operation_kind, operation_kind),
        outcome = COALESCE(excluded.outcome, outcome),
        started_at_ms = COALESCE(excluded.started_at_ms, started_at_ms),
        ended_at_ms = COALESCE(excluded.ended_at_ms, ended_at_ms),
        began = MAX(began, excluded.began),
        begin_source_key = COALESCE(begin_source_key, excluded.begin_source_key),
        settled = MAX(settled, excluded.settled),
        settled_source_key = COALESCE(excluded.settled_source_key, settled_source_key),
        settled_revision = COALESCE(excluded.settled_revision, settled_revision),
        projection_revision = excluded.projection_revision
    `).run(
      observation.generationId, observation.entityKey, observation.captureSubject.kind,
      subjectKey(observation), observation.scope.rootSessionId ?? null,
      stateOperationKind, stateOutcome, stateStartedAtMs, stateEndedAtMs, stateBegan,
      observation.observationKind === 'begin' ? observation.sourceKey : null,
      stateSettled,
      observation.observationKind === 'end' ? observation.sourceKey : null,
      observation.observationKind === 'end' ? revision : null,
      revision,
    );
    if (executionDelta !== 0 || begunDelta !== 0 || settledDelta !== 0
      || startedAtDelta !== 0 || endedAtDelta !== 0) {
      updateExecutionSummary(database, statements, 'global', '*', revision, {
        executionCount: executionDelta,
        begunCount: begunDelta,
        settledCount: settledDelta,
        startedAtCount: startedAtDelta,
        endedAtCount: endedAtDelta,
      });
      if (observation.captureSubject.kind === 'session' && observation.scope.rootSessionId) {
        updateExecutionSummary(database, statements, 'session', observation.scope.rootSessionId, revision, {
          executionCount: executionDelta,
          begunCount: begunDelta,
          settledCount: settledDelta,
          startedAtCount: startedAtDelta,
          endedAtCount: endedAtDelta,
        });
      }
    }
    return true;
  }
  if (observation.entityKind === 'toolCall') {
    const revision = nextProjectionRevision(database, statements);
    const toolCallId = `tool:${createHash('sha256').update(JSON.stringify([
      observation.captureSubject.kind,
      subjectKey(observation),
      observation.scope.executionId ?? null,
      observation.entityKey,
    ])).digest('hex')}`;
    prepareWriterStatement(database, statements, 'typed.tool.observation.insert', `
      INSERT INTO analytics_tool_observations (
        observation_registry_key, generation_id, tool_call_id, observation_kind,
        capture_subject_kind, capture_subject_key, root_session_id,
        tool_definition_id, outcome, started_at_ms, execution_ended_at_ms,
        payload_json, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      registryKey,
      observation.generationId,
      toolCallId,
      observation.observationKind,
      observation.captureSubject.kind,
      subjectKey(observation),
      observation.scope.rootSessionId ?? null,
      optionalString(fields.toolDefinitionId),
      optionalString(fields.outcome),
      optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs'),
      optionalTimestamp(fields.executionEndedAtMs, 'fields.executionEndedAtMs'),
      serialize(observation),
      revision,
    );
    prepareWriterStatement(database, statements, 'typed.tool.state.upsert', `
      INSERT INTO analytics_tool_states (
        generation_id, tool_call_id, capture_subject_kind, capture_subject_key,
        root_session_id, tool_definition_id, outcome, started_at_ms,
        execution_ended_at_ms, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, tool_call_id) DO UPDATE SET
        tool_definition_id = COALESCE(excluded.tool_definition_id, tool_definition_id),
        outcome = COALESCE(excluded.outcome, outcome),
        started_at_ms = COALESCE(excluded.started_at_ms, started_at_ms),
        execution_ended_at_ms = COALESCE(excluded.execution_ended_at_ms, execution_ended_at_ms),
        projection_revision = excluded.projection_revision
    `).run(
      observation.generationId, toolCallId, observation.captureSubject.kind,
      subjectKey(observation), observation.scope.rootSessionId ?? null,
      optionalString(fields.toolDefinitionId), optionalString(fields.outcome),
      optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs'),
      optionalTimestamp(fields.executionEndedAtMs, 'fields.executionEndedAtMs'), revision,
    );
    return true;
  }
  if (observation.entityKind === 'activitySpan') {
    const revision = nextProjectionRevision(database, statements);
    // Resolve the span state and its trusted-subject ownership first: a
    // conflicting subject or conflicting measured fact rejects the whole
    // observation before any write lands in this transaction.
    const incomingSpan: ActivityProjectionSpanState = {
      generationId: observation.generationId,
      spanId: observation.entityKey,
      captureSubjectKind: observation.captureSubject.kind,
      captureSubjectKey: subjectKey(observation),
      rootSessionId: observation.scope.rootSessionId ?? null,
      kind: optionalString(fields.kind),
      clockDomain: optionalString(fields.clockDomain),
      startedAtMs: optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs'),
      endedAtMs: optionalTimestamp(fields.endedAtMs, 'fields.endedAtMs'),
      durationMs: optionalNonNegativeFloat(fields.durationMs),
      coverage: optionalString(fields.coverage),
    };
    const { merged } = applyActivityProjection(
      database as unknown as ActivityProjectionDatabase, incomingSpan, revision,
    );
    prepareWriterStatement(database, statements, 'typed.activity.observation.insert', `
      INSERT INTO analytics_activity_observations (
        observation_registry_key, generation_id, span_id, observation_kind,
        capture_subject_kind, capture_subject_key, root_session_id,
        activity_kind, started_at_ms, ended_at_ms, duration_ms, coverage,
        payload_json, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...common,
      optionalString(fields.kind),
      optionalTimestamp(fields.startedAtMs, 'fields.startedAtMs'),
      optionalTimestamp(fields.endedAtMs, 'fields.endedAtMs'),
      optionalNonNegativeFloat(fields.durationMs),
      optionalString(fields.coverage),
      serialize(observation),
      revision,
    );
    // The state row mirrors the merged span, so a late begin after a terminal
    // end cannot overwrite terminal measured evidence, and a bound pending
    // subject cannot silently re-own another session's span.
    prepareWriterStatement(database, statements, 'typed.activity.state.upsert', `
      INSERT INTO analytics_activity_states (
        generation_id, span_id, capture_subject_kind, capture_subject_key,
        root_session_id, activity_kind, started_at_ms, ended_at_ms, duration_ms,
        coverage, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, span_id) DO UPDATE SET
        capture_subject_kind = excluded.capture_subject_kind,
        capture_subject_key = excluded.capture_subject_key,
        root_session_id = excluded.root_session_id,
        activity_kind = excluded.activity_kind,
        started_at_ms = excluded.started_at_ms,
        ended_at_ms = excluded.ended_at_ms,
        duration_ms = excluded.duration_ms,
        coverage = excluded.coverage,
        projection_revision = excluded.projection_revision
    `).run(
      merged.generationId, merged.spanId, merged.captureSubjectKind,
      merged.captureSubjectKey, merged.rootSessionId,
      merged.kind, merged.startedAtMs, merged.endedAtMs, merged.durationMs,
      merged.coverage, revision,
    );
    return true;
  }
  if (observation.entityKind === 'featureObservation') {
    const revision = nextProjectionRevision(database, statements);
    prepareWriterStatement(database, statements, 'typed.feature.observation.insert', `
      INSERT INTO analytics_feature_observations (
        observation_registry_key, generation_id, feature_key,
        capture_subject_kind, capture_subject_key, root_session_id,
        feature, decision, rule_version, measured_size_effect,
        estimated_size_effect, payload_json, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      registryKey,
      observation.generationId,
      observation.entityKey,
      observation.captureSubject.kind,
      subjectKey(observation),
      observation.scope.rootSessionId ?? null,
      optionalString(fields.feature),
      optionalString(fields.decision),
      optionalString(fields.ruleVersion),
      optionalNonNegativeFloat(fields.measuredSizeEffect),
      optionalNonNegativeFloat(fields.estimatedSizeEffect),
      serialize(observation),
      revision,
    );
    return true;
  }
  if (observation.entityKind === 'branch') {
    const branchId = optionalString(fields.branchId);
    if (!branchId || observation.scope.branchId !== branchId) {
      throw new Error('Branch observation requires matching field and scope branchId.');
    }
    const revision = nextProjectionRevision(database, statements);
    const sourceSelectionId = optionalString(fields.sourceSelectionId);
    if (sourceSelectionId) {
      prepareWriterStatement(database, statements, 'typed.branch.selection.insert', `
        INSERT INTO analytics_branch_selections (
          observation_registry_key, generation_id, branch_id, source_selection_id,
          capture_subject_kind, capture_subject_key, root_session_id,
          observed_at_ms, projection_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        registryKey, observation.generationId, branchId, sourceSelectionId,
        observation.captureSubject.kind, subjectKey(observation),
        observation.scope.rootSessionId ?? null,
        canonicalInt64(observation.observedAtMs), revision,
      );
      prepareWriterStatement(database, statements, 'typed.branch.selection-current.upsert', `
        INSERT INTO analytics_current_branch_selections (
          generation_id, capture_subject_kind, capture_subject_key, root_session_id,
          branch_id, source_selection_id, observed_at_ms, observation_registry_key, projection_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_id, capture_subject_kind, capture_subject_key) DO UPDATE SET
          root_session_id = excluded.root_session_id,
          branch_id = excluded.branch_id,
          source_selection_id = excluded.source_selection_id,
          observed_at_ms = excluded.observed_at_ms,
          observation_registry_key = excluded.observation_registry_key,
          projection_revision = excluded.projection_revision
        WHERE CAST(excluded.observed_at_ms AS INTEGER) > CAST(analytics_current_branch_selections.observed_at_ms AS INTEGER)
          OR (
            excluded.observed_at_ms = analytics_current_branch_selections.observed_at_ms
            AND excluded.observation_registry_key > analytics_current_branch_selections.observation_registry_key
          )
      `).run(
        observation.generationId, observation.captureSubject.kind, subjectKey(observation),
        observation.scope.rootSessionId ?? null, branchId, sourceSelectionId,
        canonicalInt64(observation.observedAtMs), registryKey, revision,
      );
      return true;
    }
    const parentKnown = Object.prototype.hasOwnProperty.call(fields, 'parentBranchId');
    const parentBranchId = parentKnown ? optionalString(fields.parentBranchId) : null;
    const sourceEntryId = optionalString(fields.sourceEntryId);
    const existingEdge = prepareWriterStatement(database, statements, 'typed.branch.edge.lookup', `
      SELECT parent_branch_id, parent_known, source_entry_id
      FROM analytics_branch_edges WHERE generation_id = ? AND branch_id = ?
    `).get(observation.generationId, branchId) as {
      parent_branch_id: string | null;
      parent_known: number | bigint;
      source_entry_id: string | null;
    } | undefined;
    if (existingEdge && parentKnown && toNumber(existingEdge.parent_known) === 1
      && existingEdge.parent_branch_id !== parentBranchId) {
      throw new Error(`Conflicting parent for analytics branch ${branchId}.`);
    }
    if (existingEdge?.source_entry_id && sourceEntryId && existingEdge.source_entry_id !== sourceEntryId) {
      throw new Error(`Conflicting source entry for analytics branch ${branchId}.`);
    }
    if (parentBranchId !== null) {
      const visited = new Set<string>([branchId]);
      let ancestor: string | null = parentBranchId;
      while (ancestor !== null) {
        if (visited.has(ancestor)) throw new Error(`Cycle in analytics branch ancestry at ${ancestor}.`);
        visited.add(ancestor);
        const edge = prepareWriterStatement(database, statements, 'typed.branch.edge.parent.lookup', `
          SELECT parent_branch_id, parent_known FROM analytics_branch_edges
          WHERE generation_id = ? AND branch_id = ?
        `).get(observation.generationId, ancestor) as {
          parent_branch_id: string | null;
          parent_known: number | bigint;
        } | undefined;
        if (!edge || toNumber(edge.parent_known) !== 1) break;
        ancestor = edge.parent_branch_id;
      }
    }
    prepareWriterStatement(database, statements, 'typed.branch.edge.upsert', `
      INSERT INTO analytics_branch_edges (
        generation_id, branch_id, capture_subject_kind, capture_subject_key,
        root_session_id, parent_branch_id, parent_known, source_entry_id, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, branch_id) DO UPDATE SET
        parent_branch_id = CASE
          WHEN analytics_branch_edges.parent_known = 0 AND excluded.parent_known = 1
            THEN excluded.parent_branch_id
          ELSE analytics_branch_edges.parent_branch_id END,
        parent_known = MAX(analytics_branch_edges.parent_known, excluded.parent_known),
        source_entry_id = COALESCE(analytics_branch_edges.source_entry_id, excluded.source_entry_id),
        projection_revision = excluded.projection_revision
    `).run(
      observation.generationId, branchId, observation.captureSubject.kind, subjectKey(observation),
      observation.scope.rootSessionId ?? null,
      parentBranchId,
      parentKnown ? 1 : 0,
      sourceEntryId, revision,
    );
    return true;
  }
  if (observation.entityKind === 'copy') {
    const copySessionId = optionalString(fields.copySessionId);
    const operationId = optionalString(fields.operationId);
    const coverage = optionalString(fields.inheritanceCoverage);
    if (!copySessionId || !operationId || observation.scope.rootSessionId !== copySessionId
      || (coverage !== 'known' && coverage !== 'unknown')) {
      throw new Error('Copy observation requires destination, operation, and inheritance coverage.');
    }
    const revision = nextProjectionRevision(database, statements);
    prepareWriterStatement(database, statements, 'typed.copy.insert', `
      INSERT INTO analytics_session_copies (
        generation_id, copy_root_session_id, capture_subject_kind, capture_subject_key,
        source_root_session_id, source_branch_id, operation_id,
        inheritance_coverage, inheritance_unavailable_reason, projection_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.generationId, copySessionId, observation.captureSubject.kind, subjectKey(observation),
      optionalString(fields.sourceSessionId), optionalString(fields.sourceBranchId), operationId,
      coverage, optionalString(fields.inheritanceUnavailableReason), revision,
    );
    return true;
  }
  return false;
}

function backfillV2(database: SqliteDatabase): void {
  const rows = database.prepare(`
    SELECT registry_key, fingerprint, payload_json
    FROM analytics_observations ORDER BY commit_sequence
  `).iterate() as Iterable<{ registry_key: string; fingerprint: string; payload_json: string }>;
  for (const row of rows) {
    const observation = JSON.parse(row.payload_json) as AnalyticsObservation;
    assertValidAnalyticsObservation(observation);
    recordSourceSequence(database, undefined, observation, row.registry_key, row.fingerprint, false);
    applyProviderSettlement(database, undefined, observation, row.registry_key, row.fingerprint);
    applyTypedObservation(database, undefined, observation, row.registry_key);
  }
}

/**
 * SQLite P0 candidate. All methods are synchronous and therefore belong in the
 * isolated recorder worker, never the extension host or subagent callback.
 * Facts, deletion markers, linked detail manifests, shared content and
 * projections use one canonical database.
 */
function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return Math.min(candidate, maximum);
}

function boundedTimestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer timestamp.`);
  return value;
}

function providerSettlementProjection(
  row: Record<string, unknown>,
  inheritedForSession?: string,
): ProviderSettlementProjection {
  const decodeInt = (value: unknown): number | string | null => value === null || value === undefined
    ? null
    : encodeInt64(String(value));
  const invocationId = String(row.invocation_id);
  return {
    generationId: String(row.generation_id),
    invocationId,
    rootSessionId: row.root_session_id === null ? null : String(row.root_session_id),
    executionId: row.execution_id === null ? null : String(row.execution_id),
    branchId: row.branch_id === null ? null : String(row.branch_id),
    ...(inheritedForSession ? {
      selectedSessionId: inheritedForSession,
      inheritedFromInvocationId: invocationId,
    } : {}),
    provider: row.provider === null ? null : String(row.provider),
    model: row.effective_model === null ? null : String(row.effective_model),
    dispatchedModel: row.dispatched_model === null ? null : String(row.dispatched_model),
    reportedModel: row.reported_model === null ? null : String(row.reported_model),
    purpose: row.purpose === null ? null : String(row.purpose),
    outcome: row.outcome === null ? null : String(row.outcome),
    settledAtMs: decodeInt(row.settled_at_ms),
    usage: {
      inputTokens: decodeInt(row.input_tokens),
      outputTokens: decodeInt(row.output_tokens),
      cacheReadTokens: decodeInt(row.cache_read_tokens),
      cacheWriteTokens: decodeInt(row.cache_write_tokens),
      reasoningTokens: decodeInt(row.reasoning_tokens),
      providerTotalTokens: decodeInt(row.provider_total_tokens),
    },
    reportedCostUsd: row.reported_cost_usd === null ? null : Number(row.reported_cost_usd),
    calculatedCostUsd: row.calculated_cost_usd === null ? null : Number(row.calculated_cost_usd),
    calculatedCostComplete: Number(row.calculated_cost_complete) === 1,
    normalizedUsage: {
      baseInputTokens: decodeInt(row.normalized_base_input_tokens),
      outputTokens: decodeInt(row.normalized_output_tokens),
      cacheReadTokens: decodeInt(row.normalized_cache_read_tokens),
      cacheWriteTokens: decodeInt(row.normalized_cache_write_tokens),
      reasoningTokens: decodeInt(row.reasoning_tokens),
      totalTokens: decodeInt(row.normalized_total_tokens),
      reasoningIncludedInOutput: row.reasoning_included_in_output === null
        ? null
        : Number(row.reasoning_included_in_output) === 1,
      complete: Number(row.normalized_usage_complete) === 1,
    },
    effectiveCostUsd: row.effective_cost_usd === null ? null : Number(row.effective_cost_usd),
    effectiveCostSource: row.effective_cost_source === null
      ? null
      : row.effective_cost_source as 'reported' | 'calculated',
    effectiveCostCoverage: row.effective_cost_coverage as 'known' | 'unknown' | 'not_applicable',
    revision: encodeInt64(String(row.projection_revision)),
  };
}

function encodeQueryCell(value: unknown, maximumBytes: number): { value: unknown; truncated: boolean } {
  if (typeof value === 'bigint') return { value: encodeInt64(value), truncated: false };
  if (value instanceof Uint8Array) {
    const truncated = value.byteLength > maximumBytes;
    const bounded = truncated ? value.subarray(0, maximumBytes) : value;
    return {
      value: {
        type: 'blob',
        encoding: 'base64',
        data: Buffer.from(bounded).toString('base64'),
        originalBytes: value.byteLength,
      },
      truncated,
    };
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
    return {
      value: {
        type: 'text',
        encoding: 'utf8',
        data: bytes.subarray(0, maximumBytes).toString('utf8'),
        originalBytes: bytes.byteLength,
      },
      truncated: true,
    };
  }
  return { value, truncated: false };
}

export class SqliteAnalyticsRecorder implements AnalyticsSink, AnalyticsDetailSink {
  private readonly database: SqliteDatabase;
  private readonly writerStatements: WriterStatementCache;
  private readonly readOnly: boolean;
  private readonly stats: AnalyticsRecorderStats = {
    accepted: 0,
    duplicates: 0,
    detailsAccepted: 0,
    detailDuplicates: 0,
    rejectedAfterDelete: 0,
  };
  private closed = false;
  /** Number of currently open transactions. Used to avoid nesting, which SQLite
   * rejects, when a bounded batch deletion is reached from inside a transaction. */
  private transactionDepth = 0;

  constructor(readonly databasePath: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new sqlite.DatabaseSync(databasePath, {
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: true,
      readOnly: this.readOnly,
    });
    try {
      initializeSchema(database, this.readOnly);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.writerStatements = new WriterStatementCache(database);
  }

  submit<Fields extends object>(observation: SequencedAnalyticsObservation<Fields>): void {
    this.submitBatch([observation]);
  }

  /** Writer-only calendar preparation. Read helpers never call this method:
   * changing the active IANA zone and rebuilding the bounded seven-day table
   * is an explicit recorder command owned by the runtime/supervisor. */
  prepareProviderDailyProjection(
    timeZone: string,
    windowStartMs: number | string | bigint,
    windowEndMs: number | string | bigint,
    allowTimeZoneChange = false,
  ): void {
    this.assertWritable();
    const start = canonicalInt64(windowStartMs as Int64Value);
    const end = canonicalInt64(windowEndMs as Int64Value);
    this.transaction(() => {
      const revision = nextProjectionRevision(this.database, this.writerStatements);
      prepareProviderDailyProjection(
        this.database as unknown as ProviderProjectionDatabase,
        timeZone,
        start,
        end,
        revision,
        allowTimeZoneChange,
      );
    });
  }

  /** Bounded maintained activity summary for the global or one session scope.
   * Counts keep known/unknown isolated and `measuredTotalMs` is additive
   * measured work, not a wall union; wall-union queries over member anchors
   * remain explicit raw SQL. No daily buckets are maintained. */
  readActivityProjection(request: ActivityProjectionReadRequest = {}): ActivityProjectionReadModel & AnalyticsQuerySnapshotMetadata {
    this.assertOpen();
    const rootSessionId = request.rootSessionId;
    if (rootSessionId !== undefined && (!rootSessionId.trim() || rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    const maxKinds = boundedPositiveInteger(
      request.maxKinds ?? 64, 64, MAX_QUERY_ROWS, 'activity maxKinds',
    );
    return this.snapshot(() => ({
      ...this.readQuerySnapshotMetadata(),
      ...readActivityProjection(
        this.database as unknown as ActivityProjectionDatabase,
        { rootSessionId, maxKinds },
        this.getProjectionRevision(),
      ),
    }));
  }

  submitBatch<Fields extends object>(observations: readonly SequencedAnalyticsObservation<Fields>[]): void {
    this.assertWritable();
    if (observations.length === 0) return;
    for (const observation of observations) assertValidAnalyticsObservation(observation);
    const outcomes = this.transaction(() => observations.map((observation) => this.insertObservation(observation)));
    const accepted = outcomes.filter((outcome) => outcome === 'accepted').length;
    const duplicates = outcomes.filter((outcome) => outcome === 'duplicate').length;
    const deleted = outcomes.length - accepted - duplicates;
    this.stats.accepted += accepted;
    this.stats.duplicates += duplicates;
    this.stats.rejectedAfterDelete += deleted;
    if (deleted > 0) {
      throw new Error(`Analytics capture subject is deleted: ${subjectKey(observations.find((_entry, index) => outcomes[index] === 'deleted')!)}`);
    }
  }

  submitDetail(capture: AnalyticsDetailCapture): void {
    this.assertWritable();
    validateDetailCapture(capture);
    if (capture.bytes.byteLength > MAX_DETAIL_CAPTURE_BYTES) {
      throw new RangeError(`Analytics detail exceeds the ${MAX_DETAIL_CAPTURE_BYTES}-byte storage bound.`);
    }
    const canonical = canonicalDetailCapture(capture.bytes);
    if (canonical.bytes !== capture.bytes) capture = { ...capture, bytes: canonical.bytes };
    const canonicalValue = canonical.value;
    const fingerprint = captureFingerprint(capture);
    const outcome = this.transaction(() => {
      const existing = this.writerStatements.prepare('detail.payload.lookup',
        'SELECT fingerprint, manifest_json, logical_bytes FROM analytics_detail_payloads WHERE payload_id = ?',
      ).get(capture.payloadId) as PayloadRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new AnalyticsSourceConflictError(capture.payloadId, existing.fingerprint, fingerprint);
        }
        incrementDeliveryAccounting(this.database, this.writerStatements, 'details', 'replayed');
        return 'duplicate' as const;
      }
      const sourceExisting = this.writerStatements.prepare('detail.source.lookup', `
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
      const resolvedSubject = this.resolveSubject(capture.captureSubject.kind, captureSubjectKey(capture));
      if (resolvedSubject.deleted) {
        incrementDeliveryAccounting(this.database, this.writerStatements, 'details', 'deleted');
        return 'deleted' as const;
      }

      // Build the manifest from the canonical decode already performed at the
      // exclusion boundary; the value never changes between fingerprinting and
      // manifest construction within this transaction.
      const value = canonicalValue;
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
          if (Array.isArray(candidate)) {
            const children = new Array<DetailNode | null>(candidate.length);
            for (let index = 0; index < candidate.length; index += 1) {
              children[index] = Object.prototype.hasOwnProperty.call(candidate, index)
                ? encode(candidate[index])
                : null;
            }
            return { t: 'array', v: children };
          }
          if (candidate instanceof Date) return encode(candidate.toISOString());
          return { t: 'object', v: Object.entries(candidate).map(([key, child]) => [key, encode(child)]) };
        } finally {
          active.delete(candidate);
        }
      };
      const manifest = encode(value);

      const insertContent = this.writerStatements.prepare('detail.content.insert', `
        INSERT OR IGNORE INTO analytics_detail_content (digest, encoding, logical_bytes, body)
        VALUES (?, ?, ?, ?)
      `);
      for (const [digest, entry] of references) {
        insertContent.run(digest, entry.encoding, entry.bytes.byteLength, entry.bytes);
      }
      this.writerStatements.prepare('detail.payload.insert', `
        INSERT INTO analytics_detail_payloads (
          payload_id, generation_id, source_key, fingerprint, observed_at_ms,
          committed_at_ms, capture_subject_kind, capture_subject_key,
          manifest_json, logical_bytes, media_type, source_encoding, complete,
          capture_stage, source_version, omission_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        capture.payloadId,
        capture.generationId,
        capture.sourceKey,
        fingerprint,
        canonicalInt64(capture.observedAtMs),
        Date.now().toString(),
        resolvedSubject.kind,
        resolvedSubject.key,
        JSON.stringify(manifest),
        logicalBytes,
        capture.mediaType,
        capture.encoding,
        capture.complete ? 1 : 0,
        optionalString(capture.metadata.captureStage),
        optionalString(capture.metadata.sourceVersion),
        null,
      );
      const insertReference = this.writerStatements.prepare('detail.reference.insert', `
        INSERT INTO analytics_detail_references (payload_id, digest) VALUES (?, ?)
      `);
      for (const digest of references.keys()) insertReference.run(capture.payloadId, digest);
      this.writerStatements.prepare('generation.insert', INSERT_GENERATION_SQL)
        .run(capture.generationId, canonicalInt64(capture.observedAtMs));
      incrementDeliveryAccounting(this.database, this.writerStatements, 'details', 'accepted');
      return 'accepted' as const;
    });
    if (outcome === 'accepted') this.stats.detailsAccepted += 1;
    else if (outcome === 'duplicate') this.stats.detailDuplicates += 1;
    else {
      this.stats.rejectedAfterDelete += 1;
      throw new Error(`Analytics capture subject is deleted: ${captureSubjectKey(capture)}`);
    }
  }

  private insertObservation<Fields extends object>(
    observation: SequencedAnalyticsObservation<Fields>,
  ): 'accepted' | 'duplicate' | 'deleted' {
    const registryKey = analyticsObservationRegistryKey(observation);
    const fingerprint = analyticsObservationFingerprint(observation);
    const existing = this.writerStatements.prepare('observation.registry.lookup',
      'SELECT fingerprint FROM analytics_observations WHERE registry_key = ?',
    ).get(registryKey) as RegistryRow | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AnalyticsSourceConflictError(registryKey, existing.fingerprint, fingerprint);
      }
      recordSourceSequence(this.database, this.writerStatements, observation, registryKey, fingerprint, true);
      incrementDeliveryAccounting(this.database, this.writerStatements, 'observations', 'replayed');
      return 'duplicate';
    }

    const submittedSubjectKey = subjectKey(observation);
    const resolvedSubject = this.resolveSubject(observation.captureSubject.kind, submittedSubjectKey);
    if (observation.entityKind === 'copy' && !resolvedSubject.deleted) {
      const fields = observation.fields as Record<string, unknown>;
      const sourceRootSessionId = optionalString(fields.sourceSessionId);
      const copyRootSessionId = optionalString(fields.copySessionId);
      const operationId = optionalString(fields.operationId);
      const sourceDeleted = sourceRootSessionId && Boolean(this.writerStatements.prepare('subject.deleted.present',
        'SELECT 1 AS present FROM analytics_deleted_subjects WHERE root_session_id = ?',
      ).get(sourceRootSessionId));
      if (sourceDeleted) {
        if (!copyRootSessionId || !operationId) throw new Error('Copy observation identity is incomplete.');
        const existingCopy = this.writerStatements.prepare('copy.destination.lookup', `
          SELECT operation_id FROM analytics_session_copies
          WHERE generation_id = ? AND copy_root_session_id = ?
        `).get(observation.generationId, copyRootSessionId) as { operation_id: string } | undefined;
        if (existingCopy && existingCopy.operation_id !== operationId) {
          throw new Error(`Copy session ${copyRootSessionId} is already owned by another operation.`);
        }
        const revision = nextProjectionRevision(this.database, this.writerStatements);
        this.writerStatements.prepare('copy.scrubbed.upsert', `
          INSERT INTO analytics_session_copies (
            generation_id, copy_root_session_id, capture_subject_kind, capture_subject_key,
            source_root_session_id, source_branch_id, operation_id,
            inheritance_coverage, inheritance_unavailable_reason, projection_revision
          ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'unknown', 'source_scrubbed', ?)
          ON CONFLICT(generation_id, copy_root_session_id) DO UPDATE SET
            source_root_session_id = NULL,
            source_branch_id = NULL,
            inheritance_coverage = 'unknown',
            inheritance_unavailable_reason = 'source_scrubbed',
            projection_revision = excluded.projection_revision
        `).run(
          observation.generationId, copyRootSessionId,
          observation.captureSubject.kind, subjectKey(observation), operationId, revision,
        );
        recordSourceSequence(this.database, this.writerStatements, observation, registryKey, fingerprint, true);
        incrementDeliveryAccounting(this.database, this.writerStatements, 'observations', 'deleted');
        return 'deleted';
      }
    }

    if (resolvedSubject.deleted) {
      recordSourceSequence(this.database, this.writerStatements, observation, registryKey, fingerprint, true);
      incrementDeliveryAccounting(this.database, this.writerStatements, 'observations', 'deleted');
      return 'deleted';
    }
    if (observation.captureSubject.kind === 'session'
      && observation.scope.rootSessionId
      && observation.scope.rootSessionId !== submittedSubjectKey) {
      throw new Error('Analytics session scope and capture subject identities do not match.');
    }
    const effectiveObservation = resolvedSubject.kind === observation.captureSubject.kind
      && resolvedSubject.key === submittedSubjectKey
      ? observation
      : {
          ...observation,
          captureSubject: { kind: 'session' as const, rootSessionId: resolvedSubject.key },
          scope: { ...observation.scope, rootSessionId: resolvedSubject.key },
        };
    recordSourceSequence(this.database, this.writerStatements, observation, registryKey, fingerprint, false);
    applyProviderSettlement(this.database, this.writerStatements, effectiveObservation, registryKey, fingerprint);
    applyTypedObservation(this.database, this.writerStatements, effectiveObservation, registryKey);
    const payloadJson = serialize(effectiveObservation);
    this.writerStatements.prepare('observation.insert', `
      INSERT INTO analytics_observations (
        generation_id, source_key, registry_key, idempotency_key, fingerprint,
        observed_at_ms, committed_at_ms, producer_kind, entity_kind, entity_key,
        observation_kind, capture_subject_kind, capture_subject_key,
        root_session_id, invocation_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      effectiveObservation.generationId,
      effectiveObservation.sourceKey,
      registryKey,
      effectiveObservation.idempotencyKey,
      fingerprint,
      canonicalInt64(effectiveObservation.observedAtMs),
      Date.now().toString(),
      effectiveObservation.producerKind,
      effectiveObservation.entityKind,
      effectiveObservation.entityKey,
      effectiveObservation.observationKind,
      resolvedSubject.kind,
      resolvedSubject.key,
      effectiveObservation.scope.rootSessionId ?? null,
      effectiveObservation.scope.invocationId ?? null,
      payloadJson,
    );
    this.writerStatements.prepare('generation.insert', INSERT_GENERATION_SQL)
      .run(effectiveObservation.generationId, canonicalInt64(effectiveObservation.observedAtMs));
    addFactBytes(this.database, this.writerStatements, payloadJson);
    incrementDeliveryAccounting(this.database, this.writerStatements, 'observations', 'accepted');
    return 'accepted';
  }

  private resolveSubject(kind: string, key: string): { kind: string; key: string; deleted: boolean } {
    let resolvedKind = kind;
    let resolvedKey = key;
    if (kind === 'pendingCreate') {
      const bound = this.writerStatements.prepare('subject.pending.lookup', `
        SELECT root_session_id FROM analytics_pending_subject_bindings
        WHERE pending_operation_id = ?
      `).get(key) as { root_session_id: string } | undefined;
      if (!bound) return { kind, key, deleted: false };
      resolvedKind = 'session';
      resolvedKey = bound.root_session_id;
    }
    const deleted = resolvedKind === 'session' && Boolean(this.writerStatements.prepare('subject.deleted.lookup',
      'SELECT root_session_id FROM analytics_deleted_subjects WHERE root_session_id = ?',
    ).get(resolvedKey));
    return { kind: resolvedKind, key: resolvedKey, deleted };
  }

  private removeRootAttributedData(rootSessionId: string): {
    deletedObservationCount: number;
    deletedPayloadCount: number;
  } {
    // Opt-in phase attribution. Externally-derived guesses about this
    // operation's cost were wrong four times, so the operation measures itself
    // when PIE_ANALYTICS_DELETE_PROFILE=1 and reports through the console, which
    // the recorder worker's stderr capture surfaces to the harness.
    const profile = process.env.PIE_ANALYTICS_DELETE_PROFILE === '1';
    const marks: Array<[string, number]> = [];
    const mark = (label: string, startedAt: number): void => {
      if (profile) marks.push([label, performance.now() - startedAt]);
    };
    const traceStarted = performance.now();
    const revision = nextProjectionRevision(this.database, this.writerStatements);
    mark('nextProjectionRevision', traceStarted);
    const subjectFilter = `(
      capture_subject_kind = 'session' AND capture_subject_key = ?
    ) OR (
      capture_subject_kind = 'pendingCreate' AND capture_subject_key IN (
        SELECT pending_operation_id FROM analytics_pending_subject_bindings WHERE root_session_id = ?
      )
    )`;
    const settlementsStarted = performance.now();
    const removedSettlements = this.database.prepare(`
      SELECT normalized_base_input_tokens AS input_tokens,
        normalized_base_input_tokens,
        normalized_output_tokens AS output_tokens,
        normalized_output_tokens,
        normalized_cache_read_tokens AS cache_read_tokens,
        normalized_cache_read_tokens,
        normalized_cache_write_tokens AS cache_write_tokens,
        normalized_cache_write_tokens,
        reasoning_tokens, provider_total_tokens, normalized_total_tokens AS normalized_total_tokens,
        effective_cost_usd, effective_cost_source, effective_cost_coverage,
        provider, effective_model, purpose, settled_at_ms,
        workspace_key, workspace_coverage, root_session_id
      FROM analytics_provider_settlements WHERE ${subjectFilter}
    `).iterate(rootSessionId, rootSessionId) as Iterable<Record<string, unknown>>;
    let settlementRows = 0;
    for (const row of removedSettlements) {
      settlementRows += 1;
      updateProviderAccountingProjection(this.database, this.writerStatements, 'global', '*', revision, {
        inputTokens: row.input_tokens === null ? null : String(row.input_tokens),
        outputTokens: row.output_tokens === null ? null : String(row.output_tokens),
        cacheReadTokens: row.cache_read_tokens === null ? null : String(row.cache_read_tokens),
        cacheWriteTokens: row.cache_write_tokens === null ? null : String(row.cache_write_tokens),
        reasoningTokens: row.reasoning_tokens === null ? null : String(row.reasoning_tokens),
        // Accounting projections are built from normalized channels. The raw
        // provider total is still retained for provenance, but using it here
        // would subtract a value that was counted as unknown whenever the
        // normalization contract could not prove the total.
        providerTotalTokens: row.normalized_total_tokens === null ? null : String(row.normalized_total_tokens),
        effectiveCost: row.effective_cost_usd === null ? null : Number(row.effective_cost_usd),
        effectiveSource: row.effective_cost_source === null
          ? null
          : row.effective_cost_source as 'reported' | 'calculated',
        }, -1);
      applyProviderProjection(this.database as unknown as ProviderProjectionDatabase, settlementFromDatabaseRow(row), revision, -1);
      if (row.root_session_id !== null && row.root_session_id !== undefined) {
        decrementProviderSessionPresence(
          this.database as unknown as ProviderProjectionDatabase,
          String(row.root_session_id),
          revision,
        );
      }
    }
    mark(`providerAccountingLoop(${settlementRows} rows)`, settlementsStarted);
    const projectionsStarted = performance.now();
    this.database.prepare(`
      DELETE FROM analytics_provider_accounting_projections
      WHERE subject_kind = 'session' AND subject_key = ?
    `).run(rootSessionId);
    mark('deleteSessionProjections', projectionsStarted);
    // A retained duplicate must not preserve its privately deleted source
    // identity. Keep only a destination-owned coverage tombstone so its own
    // later work remains queryable without presenting inheritance as zero.
    this.database.prepare(`
      UPDATE analytics_session_copies
      SET source_root_session_id = NULL,
          source_branch_id = NULL,
          inheritance_coverage = 'unknown',
          inheritance_unavailable_reason = 'source_scrubbed',
          projection_revision = ?
      WHERE source_root_session_id = ?
    `).run(revision, rootSessionId);
    // Sum the removable payload bytes before removing the rows, so the
    // maintained counter stays exactly equal to the aggregate it replaces.
    const sourceCopyBytes = BigInt((this.database.prepare(`
      SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM analytics_observations
      WHERE entity_kind = 'copy'
        AND json_extract(payload_json, '$.fields.sourceSessionId') = ?
    `).get(rootSessionId) as { bytes: number | bigint }).bytes);
    const deletedSourceCopyObservations = toNumber(this.database.prepare(`
      DELETE FROM analytics_observations
      WHERE entity_kind = 'copy'
        AND json_extract(payload_json, '$.fields.sourceSessionId') = ?
    `).run(rootSessionId).changes);
    subtractFactBytes(this.database, this.writerStatements, sourceCopyBytes);
    const removedExecutionRows = this.database.prepare(`
      SELECT operation_kind, began, settled, started_at_ms, ended_at_ms
      FROM analytics_execution_states WHERE ${subjectFilter}
    `).all(rootSessionId, rootSessionId) as Array<{
      operation_kind: string | null;
      began: number | bigint;
      settled: number | bigint;
      started_at_ms: string | null;
      ended_at_ms: string | null;
    }>;
    let removedExecutionCount = 0;
    let removedBegunExecutionCount = 0;
    let removedSettledExecutionCount = 0;
    let removedStartedAtCount = 0;
    let removedEndedAtCount = 0;
    for (const row of removedExecutionRows) {
      if (row.operation_kind !== 'agent-run') continue;
      removedExecutionCount += 1;
      if (Number(row.began) === 1) removedBegunExecutionCount += 1;
      if (Number(row.settled) === 1) removedSettledExecutionCount += 1;
      if (row.started_at_ms !== null) removedStartedAtCount += 1;
      if (row.ended_at_ms !== null) removedEndedAtCount += 1;
    }
    const tableDeletesStarted = performance.now();
    // Activity projection members and their scoped summary contributions are
    // removed together in one short transaction, so the removal is either
    // fully published or left for the fence's idempotent retry.
    const activityProjectionStarted = performance.now();
    this.transactionOrInline(() => removeActivityProjectionForRoot(
      this.database as unknown as ActivityProjectionDatabase,
      rootSessionId,
      revision,
    ));
    mark('remove:activityProjection', activityProjectionStarted);
    for (const table of [
      'analytics_provider_settlements',
      'analytics_execution_observations',
      'analytics_tool_observations',
      'analytics_tool_states',
      'analytics_activity_observations',
      'analytics_activity_states',
      'analytics_feature_observations',
      'analytics_branch_edges',
      'analytics_branch_selections',
      'analytics_current_branch_selections',
      'analytics_session_copies',
    ]) {
      const perTableStarted = performance.now();
      this.database.prepare(`DELETE FROM ${table} WHERE ${subjectFilter}`).run(rootSessionId, rootSessionId);
      mark(`delete:${table}`, perTableStarted);
    }
    if (removedExecutionCount > 0) {
      updateExecutionSummary(this.database, this.writerStatements, 'global', '*', revision, {
        executionCount: -removedExecutionCount,
        begunCount: -removedBegunExecutionCount,
        settledCount: -removedSettledExecutionCount,
        startedAtCount: -removedStartedAtCount,
        endedAtCount: -removedEndedAtCount,
      });
      updateExecutionSummary(this.database, this.writerStatements, 'session', rootSessionId, revision, {
        executionCount: -removedExecutionCount,
        begunCount: -removedBegunExecutionCount,
        settledCount: -removedSettledExecutionCount,
        startedAtCount: -removedStartedAtCount,
        endedAtCount: -removedEndedAtCount,
      });
    }
    const executionStateStarted = performance.now();
    this.database.prepare(`DELETE FROM analytics_execution_states WHERE ${subjectFilter}`)
      .run(rootSessionId, rootSessionId);
    mark('delete:analytics_execution_states', executionStateStarted);
    mark('tableDeletesTotal', tableDeletesStarted);
    const subjectSumStarted = performance.now();
    const subjectBytes = BigInt((this.database.prepare(`
      SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM analytics_observations
      WHERE ${subjectFilter}
    `).get(rootSessionId, rootSessionId) as { bytes: number | bigint }).bytes);
    mark('subjectByteSum', subjectSumStarted);
    const observationDeleteStarted = performance.now();
    // Delete in bounded statements rather than one statement over the whole
    // subject. A single DELETE across ~1,000,000 rows holds the database write
    // lock for its entire duration (measured ~20 s at scale), which exceeds the
    // 5 s busy timeout every other recorder shares, so a concurrent writer fails
    // with "database is locked" instead of being rejected by the committed
    // fence. Each batch statement commits independently, releasing the lock
    // between batches, so the lock is never held for the whole removal.
    const deletedObservationCount = deletedSourceCopyObservations
      + this.deleteSubjectRowsInBatches('analytics_observations', subjectFilter, rootSessionId);
    mark('deleteSubjectObservations', observationDeleteStarted);
    subtractFactBytes(this.database, this.writerStatements, subjectBytes);
    const payloadDeleteStarted = performance.now();
    const deletedPayloadCount = this.deleteSubjectRowsInBatches(
      'analytics_detail_payloads', subjectFilter, rootSessionId,
    );
    mark('deleteSubjectPayloads', payloadDeleteStarted);
    // The reference cleanup trigger deletes content exactly when its last owner
    // is removed, atomically with these payload deletes. No history sweep is
    // needed and a concurrently committed legitimate owner cannot be lost.
    if (profile) {
      const total = marks.reduce((sum, [, ms]) => sum + ms, 0);
      console.error(`[delete-profile] ${JSON.stringify({ rootSessionId, settlementRows, totalMs: total, marks })}`);
    }
    return { deletedObservationCount, deletedPayloadCount };
  }

  private completePrivacyScrub(rootSessionId: string): void {
    try {
      const row = this.truncateWalAndRead() as WalCheckpointRow;
      const busy = toNumber(row.busy);
      if (busy !== 0) throw new Error(`WAL checkpoint is busy (${busy}).`);
      this.transaction(() => {
        this.database.prepare(`
          UPDATE analytics_deleted_subjects
          SET scrub_state = 'complete', scrub_error = NULL
          WHERE root_session_id = ?
        `).run(rootSessionId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.transaction(() => {
          this.database.prepare(`
            UPDATE analytics_deleted_subjects
            SET scrub_state = 'pending', scrub_error = ?
            WHERE root_session_id = ?
          `).run(message.slice(0, 1_024), rootSessionId);
        });
      } catch {
        // Preserve the original durability failure; a later explicit retry can
        // recover from the marker that was committed before the checkpoint.
      }
      throw new AnalyticsPrivacyScrubPendingError(
        rootSessionId,
        `Private analytics rows were fenced but WAL scrubbing is still pending for ${rootSessionId}: ${message}`,
      );
    }
  }

  bindPendingCreate(
    pendingOperationId: string,
    rootSessionId: string,
    sourceKey: string,
    boundAtMs: Int64Value,
  ): AnalyticsSubjectBindingReceipt {
    this.assertWritable();
    if (!pendingOperationId || !rootSessionId || !sourceKey) throw new Error('Pending-create binding identity is required.');
    const encodedBoundAt = canonicalInt64(boundAtMs);
    const result = this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT root_session_id, source_key FROM analytics_pending_subject_bindings
        WHERE pending_operation_id = ?
      `).get(pendingOperationId) as { root_session_id: string; source_key: string } | undefined;
      if (existing && existing.root_session_id !== rootSessionId) {
        throw new Error(`Pending-create subject ${pendingOperationId} is already bound to another session.`);
      }
      if (existing && existing.source_key !== sourceKey) {
        // A private close can install the root-plus-pending fence before an
        // already-issued bind reaches the recorder. Once that root is deleted,
        // the late bind is policy replay, not a competing active attribution;
        // retain the original deletion provenance and accept it idempotently.
        const rootIsDeleted = Boolean(this.database.prepare(
          'SELECT 1 AS present FROM analytics_deleted_subjects WHERE root_session_id = ?',
        ).get(rootSessionId));
        if (!rootIsDeleted) {
          throw new Error(`Pending-create binding source conflict for ${pendingOperationId}.`);
        }
      }
      if (!existing) {
        this.database.prepare(`
          INSERT INTO analytics_pending_subject_bindings (
            pending_operation_id, root_session_id, source_key, bound_at_ms
          ) VALUES (?, ?, ?, ?)
        `).run(pendingOperationId, rootSessionId, sourceKey, encodedBoundAt);
      }
      const deletedSubject = Boolean(this.database.prepare(
        'SELECT 1 AS present FROM analytics_deleted_subjects WHERE root_session_id = ?',
      ).get(rootSessionId));
      if (deletedSubject) {
        const deleted = this.removeRootAttributedData(rootSessionId);
        this.database.prepare(`
          UPDATE analytics_deleted_subjects
          SET deleted_count = deleted_count + ?,
              deleted_payload_count = deleted_payload_count + ?,
              scrub_state = 'pending', scrub_error = NULL
          WHERE root_session_id = ?
        `).run(deleted.deletedObservationCount, deleted.deletedPayloadCount, rootSessionId);
        return {
          pendingOperationId,
          rootSessionId,
          movedObservationCount: 0,
          movedPayloadCount: 0,
          duplicate: Boolean(existing),
          deletedSubject: true,
        };
      }

      const revision = nextProjectionRevision(this.database, this.writerStatements);
      const pendingExecutionCounts = this.database.prepare(`
        SELECT COUNT(*) AS execution_count,
          COALESCE(SUM(CASE WHEN began = 1 THEN 1 ELSE 0 END), 0) AS begun_count,
          COALESCE(SUM(CASE WHEN settled = 1 THEN 1 ELSE 0 END), 0) AS settled_count,
          COALESCE(SUM(CASE WHEN started_at_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS started_at_count,
          COALESCE(SUM(CASE WHEN ended_at_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS ended_at_count
        FROM analytics_execution_states
        WHERE capture_subject_kind = 'pendingCreate'
          AND capture_subject_key = ? AND operation_kind = 'agent-run'
      `).get(pendingOperationId) as {
        execution_count: number | bigint;
        begun_count: number | bigint;
        settled_count: number | bigint;
        started_at_count: number | bigint;
        ended_at_count: number | bigint;
      };
      const pendingSettlements = this.database.prepare(`
        SELECT normalized_base_input_tokens AS input_tokens,
          normalized_output_tokens AS output_tokens,
          normalized_cache_read_tokens AS cache_read_tokens,
          normalized_cache_write_tokens AS cache_write_tokens,
          reasoning_tokens, provider_total_tokens, effective_cost_usd, effective_cost_source
        FROM analytics_provider_settlements
        WHERE capture_subject_kind = 'pendingCreate' AND capture_subject_key = ?
      `).iterate(pendingOperationId) as Iterable<Record<string, unknown>>;
      for (const row of pendingSettlements) {
        updateProviderAccountingProjection(this.database, this.writerStatements, 'session', rootSessionId, revision, {
          inputTokens: row.input_tokens === null ? null : String(row.input_tokens),
          outputTokens: row.output_tokens === null ? null : String(row.output_tokens),
          cacheReadTokens: row.cache_read_tokens === null ? null : String(row.cache_read_tokens),
          cacheWriteTokens: row.cache_write_tokens === null ? null : String(row.cache_write_tokens),
          reasoningTokens: row.reasoning_tokens === null ? null : String(row.reasoning_tokens),
          providerTotalTokens: row.provider_total_tokens === null ? null : String(row.provider_total_tokens),
          effectiveCost: row.effective_cost_usd === null ? null : Number(row.effective_cost_usd),
          effectiveSource: row.effective_cost_source === null
            ? null
            : row.effective_cost_source as 'reported' | 'calculated',
        }, 1);
        incrementProviderSessionPresence(
          this.database as unknown as ProviderProjectionDatabase,
          rootSessionId,
          revision,
        );
      }
      for (const table of [
        'analytics_provider_settlements',
        'analytics_execution_observations',
        'analytics_execution_states',
        'analytics_tool_observations',
        'analytics_tool_states',
        'analytics_activity_observations',
        'analytics_activity_states',
        'analytics_feature_observations',
        'analytics_branch_edges',
        'analytics_branch_selections',
        'analytics_current_branch_selections',
      ]) {
        this.database.prepare(`
          UPDATE ${table}
          SET capture_subject_kind = 'session', capture_subject_key = ?, root_session_id = ?
          WHERE capture_subject_kind = 'pendingCreate' AND capture_subject_key = ?
        `).run(rootSessionId, rootSessionId, pendingOperationId);
      }
      // The projection's member rows move with the same ownership change, and
      // their session-scope contributions are added here; spans already
      // promoted by a bind that committed first are absent and stay untouched.
      movePendingActivityProjection(
        this.database as unknown as ActivityProjectionDatabase,
        pendingOperationId,
        rootSessionId,
        revision,
      );
      const pendingExecutionCount = toNumber(pendingExecutionCounts.execution_count);
      const pendingSettledCount = toNumber(pendingExecutionCounts.settled_count);
      if (pendingExecutionCount > 0) {
        updateExecutionSummary(this.database, this.writerStatements, 'session', rootSessionId, revision, {
          executionCount: pendingExecutionCount,
          begunCount: toNumber(pendingExecutionCounts.begun_count),
          settledCount: pendingSettledCount,
          startedAtCount: toNumber(pendingExecutionCounts.started_at_count),
          endedAtCount: toNumber(pendingExecutionCounts.ended_at_count),
        });
      }
      const movedObservationCount = toNumber(this.database.prepare(`
        UPDATE analytics_observations
        SET capture_subject_kind = 'session', capture_subject_key = ?, root_session_id = ?,
            payload_json = json_set(payload_json,
              '$.captureSubject', json_object('kind', 'session', 'rootSessionId', ?),
              '$.scope.rootSessionId', ?)
        WHERE capture_subject_kind = 'pendingCreate' AND capture_subject_key = ?
      `).run(rootSessionId, rootSessionId, rootSessionId, rootSessionId, pendingOperationId).changes);
      const movedPayloadCount = toNumber(this.database.prepare(`
        UPDATE analytics_detail_payloads
        SET capture_subject_kind = 'session', capture_subject_key = ?
        WHERE capture_subject_kind = 'pendingCreate' AND capture_subject_key = ?
      `).run(rootSessionId, pendingOperationId).changes);
      return {
        pendingOperationId,
        rootSessionId,
        movedObservationCount,
        movedPayloadCount,
        duplicate: Boolean(existing),
        deletedSubject: false,
      };
    });
    if (result.deletedSubject) {
      try {
        this.completePrivacyScrub(rootSessionId);
      } finally {
        this.writerStatements.clear();
      }
    }
    return result;
  }

  deleteSession(
    rootSessionId: string,
    deleteSourceKey: string,
    deletedAtMs: Int64Value,
    pendingOperationId?: string,
  ): AnalyticsDeleteReceipt {
    this.assertWritable();
    if (!rootSessionId || !deleteSourceKey) throw new Error('rootSessionId and deleteSourceKey are required.');
    const encodedDeletedAt = canonicalInt64(deletedAtMs);
    try {
      // Phase 1 (bounded, fast): commit the deletion fence in its own short
      // transaction.
      //
      // The previous shape held ONE write transaction across the entire delete,
      // including the bulk row removal. At 1M facts that transaction lasted
      // 10-21 s while every other recorder shares the default 5 s busy timeout,
      // so a concurrent writer could not even reach the deleted-subject check
      // and failed with "database is locked" instead of the intended
      // subject_deleted rejection. Committing the fence first is what the
      // contract requires: the marker is authoritative and every later write
      // transaction checks it, so a write that arrives during the bulk removal
      // is rejected by the fence rather than blocked behind it.
      const fence = this.transaction(() => {
        let addedPendingFence = false;
        if (pendingOperationId) {
          const binding = this.database.prepare(`
            SELECT root_session_id FROM analytics_pending_subject_bindings
            WHERE pending_operation_id = ?
          `).get(pendingOperationId) as { root_session_id: string } | undefined;
          if (binding && binding.root_session_id !== rootSessionId) {
            throw new Error(`Pending-create subject ${pendingOperationId} is already bound to another session.`);
          }
          if (!binding) {
            this.database.prepare(`
              INSERT INTO analytics_pending_subject_bindings (
                pending_operation_id, root_session_id, source_key, bound_at_ms
              ) VALUES (?, ?, ?, ?)
            `).run(pendingOperationId, rootSessionId, deleteSourceKey, encodedDeletedAt);
            addedPendingFence = true;
          }
        }
        const existing = this.database.prepare(`
          SELECT deleted_count, deleted_payload_count, deleted_at_ms, scrub_state, scrub_error, delete_source_key
          FROM analytics_deleted_subjects WHERE root_session_id = ?
        `).get(rootSessionId) as (DeletedSubjectRow & {
          deleted_payload_count: number | bigint;
          delete_source_key: string;
        }) | undefined;
        if (existing) {
          if (addedPendingFence) {
            this.database.prepare(`
              UPDATE analytics_deleted_subjects
              SET scrub_state = 'pending', scrub_error = NULL
              WHERE root_session_id = ?
            `).run(rootSessionId);
            return {
              done: true as const,
              receipt: {
                rootSessionId,
                deletedObservationCount: toNumber(existing.deleted_count),
                deletedPayloadCount: toNumber(existing.deleted_payload_count),
                deletedAtMs: existing.deleted_at_ms,
                duplicate: true,
                scrubState: 'complete' as const,
              },
              scrub: true,
              addedPendingFence,
            };
          }
          return {
            done: true as const,
            receipt: {
              rootSessionId,
              deletedObservationCount: toNumber(existing.deleted_count),
              deletedPayloadCount: toNumber(existing.deleted_payload_count),
              deletedAtMs: existing.deleted_at_ms,
              duplicate: true,
              scrubState: 'complete' as const,
            },
            scrub: existing.scrub_state !== 'complete',
            addedPendingFence,
          };
        }
        // Commit a durable fence before any bulk removal.
        this.database.prepare(`
          INSERT INTO analytics_deleted_subjects (
            root_session_id, delete_source_key, deleted_count,
            deleted_payload_count, deleted_at_ms, scrub_state, scrub_error
          ) VALUES (?, ?, 0, 0, ?, 'pending', NULL)
        `).run(rootSessionId, deleteSourceKey, encodedDeletedAt);
        return { done: false as const, scrub: true, addedPendingFence };
      });

      // Phase 2 (bounded): the fence is durable, so the bulk removal no longer
      // has to be one indivisible transaction. Each statement is short enough
      // that a concurrent writer waits well inside its busy timeout, and any
      // writer arriving meanwhile is rejected by the committed fence rather
      // than blocked behind it.
      //
      // A duplicate/retry delete still reports the ORIGINAL counts, so the
      // fence's recorded totals are authoritative and are only advanced when a
      // fresh removal actually happened.
      let deletedObservationCount = fence.done ? fence.receipt.deletedObservationCount : 0;
      let deletedPayloadCount = fence.done ? fence.receipt.deletedPayloadCount : 0;
      if (!fence.done) {
        let bulkError: unknown;
        try {
          const deleted = this.removeRootAttributedData(rootSessionId);
          deletedObservationCount = deleted.deletedObservationCount;
          deletedPayloadCount = deleted.deletedPayloadCount;
        } catch (error) {
          bulkError = error;
        }
        // Persist whatever progress was made, so an interrupted removal stays
        // visibly incomplete instead of looking like a completed deletion.
        this.transaction(() => {
          this.database.prepare(`
            UPDATE analytics_deleted_subjects
            SET deleted_count = ?, deleted_payload_count = ?
            WHERE root_session_id = ?
          `).run(deletedObservationCount, deletedPayloadCount, rootSessionId);
        });
        if (bulkError) throw bulkError;
      } else if (fence.addedPendingFence) {
        // A late pending-create bind on an already-deleted subject still
        // removes any newly-attributed rows and accumulates the counts.
        const added = this.removeRootAttributedData(rootSessionId);
        deletedObservationCount += added.deletedObservationCount;
        deletedPayloadCount += added.deletedPayloadCount;
        this.transaction(() => {
          this.database.prepare(`
            UPDATE analytics_deleted_subjects
            SET deleted_count = ?, deleted_payload_count = ?, scrub_state = 'pending', scrub_error = NULL
            WHERE root_session_id = ?
          `).run(deletedObservationCount, deletedPayloadCount, rootSessionId);
        });
      }
      const receipt = {
        rootSessionId,
        deletedObservationCount,
        deletedPayloadCount,
        deletedAtMs: fence.done ? fence.receipt.deletedAtMs : encodedDeletedAt,
        duplicate: fence.done,
        scrubState: 'complete' as const,
      };
      const needsScrub = fence.done ? fence.scrub : true;
      if (needsScrub) this.completePrivacyScrub(rootSessionId);
      return receipt;
    } finally {
      // StatementSync retains its last bound values after run/get reset on the
      // pinned Node runtime. Drop every cached reference at the privacy fence
      // so deleted payloads and identifiers are no longer cache-owned.
      this.writerStatements.clear();
    }
  }

  readSubjectBinding(pendingOperationId: string): AnalyticsSubjectBindingState | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT binding.root_session_id,
        EXISTS(SELECT 1 FROM analytics_deleted_subjects deleted
          WHERE deleted.root_session_id = binding.root_session_id) AS deleted
      FROM analytics_pending_subject_bindings binding
      WHERE binding.pending_operation_id = ?
    `).get(pendingOperationId) as { root_session_id: string; deleted: number | bigint } | undefined;
    return row ? {
      pendingOperationId,
      rootSessionId: row.root_session_id,
      deleted: toNumber(row.deleted) === 1,
    } : null;
  }

  privacyScrubState(rootSessionId: string): AnalyticsPrivacyScrubState | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT deleted_at_ms, scrub_state, scrub_error
      FROM analytics_deleted_subjects WHERE root_session_id = ?
    `).get(rootSessionId) as Pick<DeletedSubjectRow, 'deleted_at_ms' | 'scrub_state' | 'scrub_error'> | undefined;
    return row ? {
      rootSessionId,
      deletedAtMs: encodeInt64(BigInt(row.deleted_at_ms)),
      state: row.scrub_state,
      lastError: row.scrub_error,
    } : null;
  }

  /** Bounded recovery hook for the lifecycle owner. It never scans fact/detail
   * history and leaves failures durably visible for a later retry. */
  resumePendingPrivacyScrubs(limit = 16): { completed: string[]; pending: Array<{ rootSessionId: string; error: string }> } {
    this.assertWritable();
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT root_session_id FROM analytics_deleted_subjects
      WHERE scrub_state = 'pending' ORDER BY deleted_at_ms LIMIT ?
    `).all(boundedLimit) as Array<{ root_session_id: string }>;
    const completed: string[] = [];
    const pending: Array<{ rootSessionId: string; error: string }> = [];
    for (const row of rows) {
      try {
        this.completePrivacyScrub(row.root_session_id);
        completed.push(row.root_session_id);
      } catch (error) {
        pending.push({
          rootSessionId: row.root_session_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { completed, pending };
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

  countProviderSettlements(rootSessionId?: string): number {
    this.assertOpen();
    const row = rootSessionId
      ? this.database.prepare('SELECT COUNT(*) AS count FROM analytics_provider_settlements WHERE root_session_id = ?').get(rootSessionId)
      : this.database.prepare('SELECT COUNT(*) AS count FROM analytics_provider_settlements').get();
    return toNumber((row as CountRow).count);
  }

  countTypedEntityObservations(
    entityKind: 'execution' | 'toolCall' | 'activitySpan' | 'featureObservation' | 'branch' | 'copy',
    rootSessionId?: string,
  ): number {
    this.assertOpen();
    const table = {
      execution: 'analytics_execution_observations',
      toolCall: 'analytics_tool_observations',
      activitySpan: 'analytics_activity_observations',
      featureObservation: 'analytics_feature_observations',
      branch: 'analytics_branch_selections',
      copy: 'analytics_session_copies',
    }[entityKind];
    const row = rootSessionId
      ? this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE root_session_id = ?`).get(rootSessionId)
      : this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
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

  detailMetadata(payloadId: string): AnalyticsDetailMetadata | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT logical_bytes, media_type, source_encoding, complete,
        capture_stage, source_version, omission_reason
      FROM analytics_detail_payloads WHERE payload_id = ?
    `).get(payloadId) as Required<Pick<PayloadRow,
      'logical_bytes' | 'media_type' | 'source_encoding' | 'complete'>>
      & Pick<PayloadRow, 'capture_stage' | 'source_version' | 'omission_reason'> | undefined;
    if (!row) return null;
    const stored = this.database.prepare(`
      SELECT COALESCE(SUM(content.logical_bytes), 0) AS stored_bytes
      FROM analytics_detail_references reference
      JOIN analytics_detail_content content ON content.digest = reference.digest
      WHERE reference.payload_id = ?
    `).get(payloadId) as { stored_bytes: number | bigint };
    return {
      logicalBytes: encodeInt64(BigInt(row.logical_bytes)),
      storedBytes: encodeInt64(BigInt(stored.stored_bytes)),
      mediaType: row.media_type,
      sourceEncoding: row.source_encoding,
      complete: toNumber(row.complete) === 1,
      captureStage: row.capture_stage ?? null,
      sourceVersion: row.source_version ?? null,
      omissionReason: row.omission_reason ?? null,
    };
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
        case 'array': {
          // Match the producer's canonical general/holey array allocation.
          // A null manifest entry is a sparse slot, including manifests written
          // before holes were represented explicitly during encoding.
          const result: unknown[] = [null];
          result.pop();
          result.length = node.v.length;
          for (let index = 0; index < node.v.length; index += 1) {
            const child = node.v[index];
            if (child !== null) result[index] = decode(child);
          }
          return result;
        }
        case 'object': return Object.fromEntries(node.v.map(([key, child]) => [key, decode(child)]));
      }
    };
    return decode(JSON.parse(payload.manifest_json) as DetailNode);
  }

  readDetailRange(payloadId: string, offset: Int64Value = 0, maxBytes = 64 * 1024): AnalyticsDetailRangeResult {
    this.assertOpen();
    return this.snapshot(() => {
      const snapshotMetadata = this.readQuerySnapshotMetadata();
      const metadata = this.detailMetadata(payloadId);
      if (!metadata) {
        return {
          ...snapshotMetadata,
          payloadId,
          available: false,
          mediaType: null,
          sourceEncoding: null,
          representationEncoding: 'node-v8',
          complete: false,
          captureStage: null,
          sourceVersion: null,
          omissionReason: 'unavailable-or-scrubbed',
          totalLength: 0,
          offset: 0,
          nextOffset: null,
          truncated: false,
          bytes: new Uint8Array(),
        };
      }
      const start = parseInt64(offset, 'detail offset');
      if (start < 0n || start > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('detail offset is out of range.');
      const boundedBytes = boundedPositiveInteger(maxBytes, 64 * 1024, MAX_QUERY_BYTES, 'detail maxBytes');
      const body = serializeV8(sanitizeAnalyticsDetail(this.reconstructDetail(payloadId)));
      const numericStart = Number(start);
      const end = Math.min(body.byteLength, numericStart + boundedBytes);
      const bytes = numericStart >= body.byteLength ? new Uint8Array() : body.subarray(numericStart, end);
      return {
        ...snapshotMetadata,
        payloadId,
        available: true,
        mediaType: metadata.mediaType,
        sourceEncoding: metadata.sourceEncoding,
        representationEncoding: 'node-v8',
        complete: metadata.complete,
        captureStage: metadata.captureStage,
        sourceVersion: metadata.sourceVersion,
        omissionReason: metadata.omissionReason,
        totalLength: encodeInt64(BigInt(body.byteLength)),
        offset: encodeInt64(start),
        nextOffset: end < body.byteLength ? encodeInt64(BigInt(end)) : null,
        truncated: end < body.byteLength,
        bytes,
      };
    });
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
      logicalBytes: encodeInt64(BigInt(payload.logical)),
      storedContentBytes: encodeInt64(BigInt(content.stored)),
    };
  }

  getDatabaseSchemaVersion(): number {
    this.assertOpen();
    return toNumber((this.database.prepare('PRAGMA user_version').get() as UserVersionRow).user_version);
  }

  getProjectionRevision(): number | string {
    this.assertOpen();
    const row = this.database.prepare(
      'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
    ).get() as RevisionRow;
    return encodeInt64(row.revision);
  }

  describeSchema(): AnalyticsSchemaDescription {
    this.assertOpen();
    return this.snapshot(() => {
      const metadata = this.readQuerySnapshotMetadata();
      const views = this.database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'analytics_%' ORDER BY name
      `).all() as Array<{ name: string }>;
      return {
        ...metadata,
        projectionVersion: 3,
        logicalCommands: ['schema', 'query', 'detail', 'storage'],
        views: views.map((row) => row.name),
        detail: { defaultRangeBytes: 64 * 1024, representationEncoding: 'node-v8' },
      };
    });
  }

  /** Read only the complete-detail watermark.
   *
   * The capture acknowledgement needs exactly this value, and only this value.
   * It previously called {@link readDeliveryAccounting}, which additionally runs
   * `detailStorageStats()`: two unbounded `COUNT(*)`/`SUM(logical_bytes)`
   * aggregates over `analytics_detail_payloads` and `analytics_detail_content`.
   * One acknowledgement is issued per ingested batch, so at 1M facts in
   * 256-record batches that is roughly 3,900 acknowledgements, each scanning a
   * table that grows as the tier proceeds — cost O(batches x rows), quadratic in
   * the tier, and the aggregates were then discarded unread.
   *
   * The watermark itself is an already-maintained counter (`details_accepted` on
   * the singleton accounting row), so this reader is a single indexed point read.
   * The full summary stays available through {@link readDeliveryAccounting} and
   * {@link detailStorageStats} for the explicit storage/summary commands, where
   * an exact aggregate is the point and the call is rare. */
  readCompleteDetailWatermark(): number | string {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT details_accepted AS accepted FROM analytics_delivery_accounting WHERE singleton = 1
    `).get() as { accepted: string } | undefined;
    if (!row) throw new Error('Analytics delivery accounting row is missing.');
    return encodeInt64(row.accepted);
  }

  readDeliveryAccounting(): AnalyticsDeliveryAccounting {
    this.assertOpen();
    const row = this.database.prepare(`SELECT * FROM analytics_delivery_accounting WHERE singleton = 1`).get() as Record<string, string>;
    const details = this.detailStorageStats();
    const count = (name: string): number | string => encodeInt64(row[name]!);
    return {
      deliveryHistoryCoverage: row.delivery_history_coverage === 'retained_only' ? 'retained_only' : 'complete',
      observations: {
        delivered: count('observations_delivered'),
        accepted: count('observations_accepted'),
        replayed: count('observations_replayed'),
        deleted: count('observations_deleted'),
      },
      details: {
        delivered: count('details_delivered'),
        accepted: count('details_accepted'),
        replayed: count('details_replayed'),
        deleted: count('details_deleted'),
      },
      completeDetailWatermark: count('details_accepted'),
      retainedDetailLogicalBytes: details.logicalBytes,
      retainedDetailStoredBytes: details.storedContentBytes,
    };
  }

  readStorageSummary(): AnalyticsStorageSummary {
    this.assertOpen();
    const bytes = (suffix: string): number | string => {
      try {
        return encodeInt64(fs.statSync(`${this.databasePath}${suffix}`, { bigint: true }).size);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    };
    // Maintained counter, not a full-table SUM(LENGTH(...)) aggregate: the
    // aggregate is O(all facts) and made the `storage` command exceed the
    // query client's default timeout at 1M rows. Same quantity, O(1) read.
    const facts = this.database.prepare(`
      SELECT facts_payload_bytes AS bytes FROM analytics_delivery_accounting WHERE singleton = 1
    `).get() as { bytes: string };
    return {
      ...this.detailStorageStats(),
      databaseBytes: bytes(''),
      walBytes: bytes('-wal'),
      sharedMemoryBytes: bytes('-shm'),
      factsLogicalBytes: encodeInt64(BigInt(facts.bytes)),
      engineAllocationOverheadBytes: null,
    };
  }

  readStorageReadModel(): AnalyticsStorageReadModel {
    this.assertOpen();
    return this.snapshot(() => ({
      ...this.readQuerySnapshotMetadata(),
      storage: this.readStorageSummary(),
      delivery: this.readDeliveryAccounting(),
    }));
  }

  executeReadOnlyQuery(
    sql: string,
    parameters: readonly unknown[] = [],
    options: { maxRows?: number; maxBytes?: number; maxCellBytes?: number } = {},
  ): AnalyticsReadOnlyQueryResult {
    this.assertOpen();
    if (!sql.trim()) throw new Error('Analytics query SQL is required.');
    const maxRows = boundedPositiveInteger(options.maxRows, DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS, 'query maxRows');
    const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_QUERY_BYTES, MAX_QUERY_BYTES, 'query maxBytes');
    const maxCellBytes = boundedPositiveInteger(options.maxCellBytes, 64 * 1024, maxBytes, 'query maxCellBytes');
    return this.snapshot(() => {
      const metadata = this.readQuerySnapshotMetadata();
      const allowed = new Set([
        sqlite.constants.SQLITE_SELECT,
        sqlite.constants.SQLITE_READ,
        sqlite.constants.SQLITE_RECURSIVE,
      ]);
      const boundedFunctions = new Set([
        'abs', 'avg', 'coalesce', 'count', 'date', 'datetime', 'ifnull',
        'json_array_length', 'json_extract', 'json_type', 'julianday', 'length',
        'lower', 'max', 'min', 'nullif', 'round', 'strftime', 'sum', 'time',
        'total', 'typeof', 'unixepoch', 'upper',
      ]);
      this.database.setAuthorizer((actionCode, argument1, argument2) => {
        if (allowed.has(actionCode)) return sqlite.constants.SQLITE_OK;
        if (actionCode === sqlite.constants.SQLITE_FUNCTION
          && boundedFunctions.has(String(argument2 ?? argument1).toLowerCase())) {
          return sqlite.constants.SQLITE_OK;
        }
        return sqlite.constants.SQLITE_DENY;
      });
      try {
        const statement = this.database.prepare(sql);
        const columns = statement.columns().map((column) => column.name);
        const rows: Array<Record<string, unknown>> = [];
        const truncation: AnalyticsQueryTruncation = { rowLimit: false, byteLimit: false, cellLimit: false };
        let resultBytes = 0;
        for (const raw of statement.iterate(...parameters) as Iterable<Record<string, unknown>>) {
          if (rows.length >= maxRows) {
            truncation.rowLimit = true;
            break;
          }
          const row: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(raw)) {
            const encoded = encodeQueryCell(value, maxCellBytes);
            row[key] = encoded.value;
            if (encoded.truncated) truncation.cellLimit = true;
          }
          const rowBytes = Buffer.byteLength(serialize(row), 'utf8');
          if (resultBytes + rowBytes > maxBytes) {
            truncation.byteLimit = true;
            break;
          }
          resultBytes += rowBytes;
          rows.push(row);
        }
        return {
          ...metadata,
          columns,
          rows,
          returnedRows: rows.length,
          truncation,
        };
      } finally {
        this.database.setAuthorizer(null);
      }
    });
  }

  /** Persisted, typed settlement read model. Revision and rows are read from
   * one database snapshot so cross-host consumers never pair a new revision
   * with stale rows. */
  readProviderSettlements(rootSessionId?: string, limit?: number): ProviderSettlementReadModel {
    this.assertOpen();
    return this.snapshot(() => {
      const revision = this.getProjectionRevision();
      const scoped = rootSessionId !== undefined;
      const where = scoped ? 'WHERE root_session_id = ?' : '';
      const boundedLimit = limit === undefined ? undefined : Math.max(0, Math.trunc(limit));
      const rows = this.database.prepare(`
        SELECT * FROM analytics_provider_settlements
        ${where}
        ORDER BY CAST(projection_revision AS INTEGER), generation_id, invocation_id
        ${boundedLimit === undefined ? '' : 'LIMIT ?'}
      `).all(...(scoped ? [rootSessionId] : []), ...(boundedLimit === undefined ? [] : [boundedLimit])) as Array<Record<string, unknown>>;
      return {
        revision,
        settlements: rows.map((row) => providerSettlementProjection(row)),
      };
    });
  }

  readProviderSettlementProjection(rootSessionId?: string): ProviderSettlementReadModel {
    return this.readProviderSettlements(rootSessionId);
  }

  readScopedProviderSettlements(
    scope: ProviderSettlementScope,
    page: ScopedProviderSettlementPage = {},
  ): ScopedProviderSettlementReadModel {
    this.assertOpen();
    if (!scope || typeof scope !== 'object') throw new Error('Provider settlement scope is required.');
    const scopeKind = Reflect.get(scope, 'kind');
    if (scopeKind !== 'global'
      && scopeKind !== 'rootSession'
      && scopeKind !== 'selectedBranch'
      && scopeKind !== 'copySelected') {
      throw new Error('Unsupported provider settlement scope kind.');
    }
    const validateScopeId = (value: string, name: string): void => {
      if (!value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string without NUL.`);
    };
    if (scope.kind === 'rootSession' || scope.kind === 'selectedBranch') {
      validateScopeId(scope.rootSessionId, 'rootSessionId');
    } else if (scope.kind === 'copySelected') {
      validateScopeId(scope.copySessionId, 'copySessionId');
    }
    if (scope.kind === 'selectedBranch' || scope.kind === 'copySelected') {
      validateScopeId(scope.generationId, 'generationId');
    }
    const limit = boundedPositiveInteger(page.limit, DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS, 'scoped settlement limit');
    const offset = page.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('scoped settlement offset must be a non-negative safe integer.');
    }
    const selectedRows = (
      generationId: string,
      rootSessionId: string,
      explicitBranchId?: string,
    ): Array<Record<string, unknown>> => {
      const branchSeed = explicitBranchId
        ? 'SELECT ? AS generation_id, ? AS branch_id'
        : `SELECT generation_id, branch_id FROM analytics_current_branch_selections
           WHERE generation_id = ? AND root_session_id = ?`;
      return this.database.prepare(`
        WITH RECURSIVE ancestry(generation_id, branch_id) AS (
          ${branchSeed}
          UNION
          SELECT edge.generation_id, edge.parent_branch_id
          FROM analytics_branch_edges edge
          JOIN ancestry child
            ON child.generation_id = edge.generation_id AND child.branch_id = edge.branch_id
          WHERE edge.parent_known = 1 AND edge.parent_branch_id IS NOT NULL
        )
        SELECT settlement.*
        FROM analytics_provider_settlements settlement
        JOIN ancestry branch
          ON branch.generation_id = settlement.generation_id
          AND branch.branch_id = settlement.branch_id
        WHERE settlement.root_session_id = ? AND settlement.generation_id = ?
        ORDER BY CAST(settlement.projection_revision AS INTEGER), settlement.generation_id, settlement.invocation_id
        LIMIT ? OFFSET ?
      `).all(
        generationId,
        ...(explicitBranchId ? [explicitBranchId] : [rootSessionId]),
        rootSessionId, generationId, limit + 1, offset,
      ) as Array<Record<string, unknown>>;
    };
    const ancestryCoverage = (
      generationId: string,
      rootSessionId: string,
      explicitBranchId?: string,
    ): 'known' | 'unknown' => {
      const seeds = explicitBranchId
        ? this.database.prepare(`
            SELECT generation_id, branch_id FROM analytics_branch_edges
            WHERE generation_id = ? AND root_session_id = ? AND branch_id = ?
          `).all(generationId, rootSessionId, explicitBranchId) as Array<{ generation_id: string; branch_id: string }>
        : this.database.prepare(`
            SELECT generation_id, branch_id FROM analytics_current_branch_selections
            WHERE generation_id = ? AND root_session_id = ?
          `).all(generationId, rootSessionId) as Array<{ generation_id: string; branch_id: string }>;
      if (seeds.length === 0) return 'unknown';
      for (const seed of seeds) {
        const visited = new Set<string>();
        let branchId: string | null = seed.branch_id;
        while (branchId !== null) {
          if (visited.has(branchId)) throw new Error(`Cycle in persisted branch ancestry at ${branchId}.`);
          visited.add(branchId);
          const edge = this.database.prepare(`
            SELECT parent_branch_id, parent_known FROM analytics_branch_edges
            WHERE generation_id = ? AND branch_id = ? AND root_session_id = ?
          `).get(seed.generation_id, branchId, rootSessionId) as {
            parent_branch_id: string | null;
            parent_known: number | bigint;
          } | undefined;
          if (!edge || toNumber(edge.parent_known) !== 1) return 'unknown';
          branchId = edge.parent_branch_id;
        }
      }
      return 'known';
    };
    const pageResult = (rows: ProviderSettlementProjection[]) => {
      const truncated = rows.length > limit;
      return {
        settlements: rows.slice(0, limit),
        settlementCoverage: truncated ? 'truncated' as const : 'complete' as const,
        truncated,
        nextOffset: truncated ? offset + limit : null,
      };
    };
    return this.snapshot(() => {
      const revision = this.getProjectionRevision();
      if (page.expectedRevision !== undefined
        && canonicalInt64(page.expectedRevision) !== canonicalInt64(revision)) {
        throw new Error(`Scoped settlement projection changed from revision ${page.expectedRevision} to ${revision}.`);
      }
      if (scope.kind === 'global' || scope.kind === 'rootSession') {
        const scoped = scope.kind === 'rootSession';
        const rows = this.database.prepare(`
          SELECT * FROM analytics_provider_settlements
          ${scoped ? 'WHERE root_session_id = ?' : ''}
          ORDER BY CAST(projection_revision AS INTEGER), generation_id, invocation_id
          LIMIT ? OFFSET ?
        `).all(...(scoped ? [scope.rootSessionId] : []), limit + 1, offset) as Array<Record<string, unknown>>;
        return {
          revision,
          scope,
          ...pageResult(rows.map((row) => providerSettlementProjection(row))),
          selectionCoverage: 'not_applicable' as const,
          inheritanceCoverage: 'not_applicable' as const,
        };
      }
      if (scope.kind === 'selectedBranch') {
        const coverage = ancestryCoverage(scope.generationId, scope.rootSessionId);
        return {
          revision,
          scope,
          ...pageResult(selectedRows(scope.generationId, scope.rootSessionId)
            .map((row) => providerSettlementProjection(row))),
          selectionCoverage: coverage,
          inheritanceCoverage: 'not_applicable' as const,
        };
      }
      const relation = this.database.prepare(`
        SELECT source_root_session_id, source_branch_id,
          inheritance_coverage, inheritance_unavailable_reason
        FROM analytics_session_copies WHERE generation_id = ? AND copy_root_session_id = ?
      `).get(scope.generationId, scope.copySessionId) as {
        source_root_session_id: string | null;
        source_branch_id: string | null;
        inheritance_coverage: 'known' | 'unknown';
        inheritance_unavailable_reason: 'source_scrubbed' | null;
      } | undefined;
      const ownSelectionCoverage = ancestryCoverage(scope.generationId, scope.copySessionId);
      const inheritedAvailable = relation?.inheritance_coverage === 'known'
        && relation.source_root_session_id !== null
        && relation.source_branch_id !== null;
      const inheritedAncestryCoverage = inheritedAvailable
        ? ancestryCoverage(scope.generationId, relation.source_root_session_id!, relation.source_branch_id!)
        : 'unknown';
      const inheritedComplete = inheritedAvailable && inheritedAncestryCoverage === 'known';
      const rows = this.database.prepare(`
        WITH RECURSIVE ancestry(generation_id, branch_id, owning_root_session_id, inherited) AS (
          SELECT generation_id, branch_id, root_session_id, 0
          FROM analytics_current_branch_selections
          WHERE generation_id = ? AND root_session_id = ?
          UNION
          SELECT ?, ?, ?, 1 WHERE ? IS NOT NULL AND ? IS NOT NULL
          UNION
          SELECT edge.generation_id, edge.parent_branch_id,
            child.owning_root_session_id, child.inherited
          FROM analytics_branch_edges edge
          JOIN ancestry child
            ON child.generation_id = edge.generation_id
            AND child.branch_id = edge.branch_id
            AND child.owning_root_session_id = edge.root_session_id
          WHERE edge.parent_known = 1 AND edge.parent_branch_id IS NOT NULL
        )
        SELECT settlement.*, ancestry.inherited AS copy_inherited
        FROM analytics_provider_settlements settlement
        JOIN ancestry
          ON ancestry.generation_id = settlement.generation_id
          AND ancestry.branch_id = settlement.branch_id
          AND ancestry.owning_root_session_id = settlement.root_session_id
        WHERE settlement.generation_id = ?
        ORDER BY CAST(settlement.projection_revision AS INTEGER), settlement.generation_id, settlement.invocation_id
        LIMIT ? OFFSET ?
      `).all(
        scope.generationId, scope.copySessionId,
        scope.generationId, relation?.source_branch_id ?? null, relation?.source_root_session_id ?? null,
        inheritedAvailable ? relation?.source_branch_id : null,
        inheritedAvailable ? relation?.source_root_session_id : null,
        scope.generationId, limit + 1, offset,
      ) as Array<Record<string, unknown> & { copy_inherited: number | bigint }>;
      return {
        revision,
        scope,
        ...pageResult(rows.map((row) => providerSettlementProjection(
          row,
          toNumber(row.copy_inherited) === 1 ? scope.copySessionId : undefined,
        ))),
        selectionCoverage: ownSelectionCoverage,
        inheritanceCoverage: inheritedComplete ? 'known' : 'unknown',
        ...(!inheritedComplete ? {
          inheritanceUnavailableReason: relation?.inheritance_unavailable_reason
            ?? (inheritedAvailable ? 'incomplete_source_ancestry' : 'missing_source_selection'),
        } : {}),
      };
    });
  }

  readHistoricalDimensionSummary(
    options: { maxRowsPerDimension?: number; maxBytes?: number; maxCellBytes?: number } = {},
  ): HistoricalDimensionSummary {
    this.assertOpen();
    const maxRowsPerDimension = boundedPositiveInteger(
      options.maxRowsPerDimension, DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS, 'dimension maxRowsPerDimension',
    );
    const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_QUERY_BYTES, MAX_QUERY_BYTES, 'dimension maxBytes');
    const maxCellBytes = boundedPositiveInteger(options.maxCellBytes, Math.min(64 * 1024, maxBytes), maxBytes, 'dimension maxCellBytes');
    return this.snapshot(() => {
      const metadata = this.readQuerySnapshotMetadata();
      const revision = metadata.projectionRevision;
      const truncation: AnalyticsQueryTruncation = { rowLimit: false, byteLimit: false, cellLimit: false };
      let resultBytes = 0;
      // Historical membership can have unbounded cardinality. Stream capped
      // groups instead of allocating the full result before the IPC size check.
      // The byte budget is shared by all four dimensions, not renewed per query.
      const readGroups = (sql: string): Array<Record<string, unknown>> => {
        if (truncation.byteLimit) return [];
        const rows: Array<Record<string, unknown>> = [];
        for (const raw of this.database.prepare(`${sql} LIMIT ?`).iterate(maxRowsPerDimension + 1) as Iterable<Record<string, unknown>>) {
          if (rows.length >= maxRowsPerDimension) {
            truncation.rowLimit = true;
            break;
          }
          const row: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(raw)) {
            const encoded = encodeQueryCell(value, maxCellBytes);
            row[key] = encoded.value;
            if (encoded.truncated) truncation.cellLimit = true;
          }
          const rowBytes = Buffer.byteLength(serialize(row), 'utf8');
          if (resultBytes + rowBytes > maxBytes) {
            truncation.byteLimit = true;
            break;
          }
          resultBytes += rowBytes;
          rows.push(row);
        }
        return rows;
      };
      const providers = readGroups(`
        SELECT provider, effective_model, purpose, outcome, COUNT(*) AS occurrence_count
        FROM analytics_provider_settlements
        GROUP BY provider, effective_model, purpose, outcome
        ORDER BY provider, effective_model, purpose, outcome
      `);
      const tools = readGroups(`
        SELECT tool_definition_id, outcome, COUNT(*) AS occurrence_count
        FROM analytics_tool_states
        GROUP BY tool_definition_id, outcome
        ORDER BY tool_definition_id, outcome
      `);
      const activities = readGroups(`
        SELECT activity_kind, coverage, COUNT(*) AS occurrence_count
        FROM analytics_activity_states
        GROUP BY activity_kind, coverage
        ORDER BY activity_kind, coverage
      `);
      const features = readGroups(`
        SELECT feature, decision, rule_version, COUNT(*) AS occurrence_count
        FROM analytics_feature_observations
        GROUP BY feature, decision, rule_version
        ORDER BY feature, decision, rule_version
      `);
      return { ...metadata, revision, scope: { kind: 'global' }, providers, tools, activities, features, truncation, maxRowsPerDimension };
    });
  }

  /** Bounded maintained summary of root agent-run executions. It reads one
   * summary row and at most one settled state from the same SQLite snapshot;
   * provider invocation and assistant-turn rows are deliberately excluded. */
  readExecutionSummary(rootSessionId?: string): CanonicalExecutionSummary {
    this.assertOpen();
    if (rootSessionId !== undefined && (!rootSessionId.trim() || rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    return this.snapshot(() => this.readExecutionSummaryInSnapshot(
      rootSessionId,
      this.getProjectionRevision(),
    ));
  }

  private readExecutionSummaryInSnapshot(
    rootSessionId: string | undefined,
    revision: number | string,
  ): CanonicalExecutionSummary {
    const scope: ExecutionSummaryScope = rootSessionId === undefined
      ? { kind: 'global' }
      : { kind: 'session', rootSessionId };
    const deliveryRow = this.database.prepare(`
      SELECT delivery_history_coverage FROM analytics_delivery_accounting WHERE singleton = 1
    `).get() as { delivery_history_coverage: string } | undefined;
    const deliveryCoverage: ExecutionSummaryDeliveryCoverage = deliveryRow?.delivery_history_coverage === 'complete'
      || deliveryRow?.delivery_history_coverage === 'retained_only'
      ? deliveryRow.delivery_history_coverage
      : 'unknown';
    const row = this.database.prepare(`
      SELECT execution_count, begun_count, settled_count, started_at_count, ended_at_count
      FROM analytics_execution_summary WHERE scope_kind = ? AND scope_key = ?
    `).get(scope.kind, rootSessionId ?? '*') as StoredExecutionSummaryCounts | undefined;
    if (!row) return emptyExecutionSummary(revision, scope, deliveryCoverage);
    const executionCount = safeExecutionSummaryCount(row.execution_count, 'execution_count');
    const begunCount = safeExecutionSummaryCount(row.begun_count, 'begun_count');
    const settledCount = safeExecutionSummaryCount(row.settled_count, 'settled_count');
    const startedAtCount = safeExecutionSummaryCount(row.started_at_count, 'started_at_count');
    const endedAtCount = safeExecutionSummaryCount(row.ended_at_count, 'ended_at_count');
    const latestRow = this.database.prepare(`
      SELECT generation_id, execution_id, settled_source_key, started_at_ms, ended_at_ms
      FROM analytics_execution_states
      WHERE operation_kind = 'agent-run' AND settled = 1
        ${rootSessionId === undefined ? '' : 'AND root_session_id = ?'}
      ORDER BY CAST(settled_revision AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `).get(...(rootSessionId === undefined ? [] : [rootSessionId])) as {
      generation_id: string;
      execution_id: string;
      settled_source_key: string | null;
      started_at_ms: string | null;
      ended_at_ms: string | null;
    } | undefined;
    const decodeTimestamp = (value: string | null | undefined): number | string | null => (
      value === null || value === undefined ? null : encodeInt64(value)
    );
    return executionSummaryFromCounts(revision, scope, {
      executionCount,
      begunCount,
      settledCount,
      startedAtCount,
      endedAtCount,
    }, latestRow ? {
      generationId: latestRow.generation_id,
      executionId: latestRow.execution_id,
      sourceKey: latestRow.settled_source_key,
      startedAtMs: decodeTimestamp(latestRow.started_at_ms),
      endedAtMs: decodeTimestamp(latestRow.ended_at_ms),
    } : null, deliveryCoverage);
  }

  /** Select and summarize one source-chronological completed execution while
   * the caller's read snapshot is open. The execution identity is always the
   * stored generation/id pair; provider rows from another execution or
   * generation cannot enter this result. */
  private readLatestRunInSnapshot(): CanonicalExecutionLatestRun | null {
    const latestRow = this.database.prepare(`
      SELECT generation_id, execution_id, root_session_id, settled_source_key,
        outcome, started_at_ms, ended_at_ms
      FROM analytics_execution_states
      WHERE operation_kind = 'agent-run' AND settled = 1
        AND ended_at_ms IS NOT NULL
        AND ended_at_ms = CAST(CAST(ended_at_ms AS INTEGER) AS TEXT)
      ORDER BY CAST(ended_at_ms AS INTEGER) DESC, generation_id DESC, execution_id DESC
      LIMIT 1
    `).get() as {
      generation_id: string;
      execution_id: string;
      root_session_id: string | null;
      settled_source_key: string | null;
      outcome: string | null;
      started_at_ms: string | null;
      ended_at_ms: string | null;
    } | undefined;
    if (!latestRow) return null;
    let endedAtMs: number | string;
    try {
      if (latestRow.ended_at_ms === null) return null;
      endedAtMs = encodeInt64(latestRow.ended_at_ms);
    } catch {
      // A malformed persisted source timestamp is unavailable evidence, not
      // a reason to substitute receipt time or claim a different run.
      return null;
    }
    const decodeOptionalTimestamp = (value: string | null): number | string | null => {
      if (value === null) return null;
      try { return encodeInt64(value); } catch { return null; }
    };

    let invocationCount = 0;
    let inputTokens = 0n;
    let outputTokens = 0n;
    let inputUnknown = false;
    let outputUnknown = false;
    let costUsd = 0;
    let costUnknown = false;
    let provider: string | null = null;
    let modelId: string | null = null;
    let providerKnown = false;
    let modelKnown = false;
    let providerUnknown = false;
    let modelUnknown = false;
    let providerMixed = false;
    let modelMixed = false;
    for (const row of this.database.prepare(`
      SELECT provider, effective_model, normalized_base_input_tokens,
        normalized_output_tokens, effective_cost_usd, effective_cost_coverage
      FROM analytics_provider_settlements
      WHERE generation_id = ? AND execution_id = ?
      ORDER BY invocation_id
    `).iterate(latestRow.generation_id, latestRow.execution_id) as Iterable<Record<string, unknown>>) {
      invocationCount += 1;
      const rowProvider = typeof row.provider === 'string' && row.provider.length > 0 ? row.provider : null;
      if (rowProvider === null) providerUnknown = true;
      else if (!providerKnown) { provider = rowProvider; providerKnown = true; }
      else if (provider !== rowProvider) providerMixed = true;
      const rowModel = typeof row.effective_model === 'string' && row.effective_model.length > 0
        ? row.effective_model : null;
      if (rowModel === null) modelUnknown = true;
      else if (!modelKnown) { modelId = rowModel; modelKnown = true; }
      else if (modelId !== rowModel) modelMixed = true;

      const addToken = (value: unknown, name: 'input' | 'output'): void => {
        if (value === null || value === undefined) {
          if (name === 'input') inputUnknown = true;
          else outputUnknown = true;
          return;
        }
        try {
          const parsed = parseNonNegativeInt64(value, `lastRun.${name}Tokens`);
          if (name === 'input') inputTokens += parsed;
          else outputTokens += parsed;
        } catch {
          if (name === 'input') inputUnknown = true;
          else outputUnknown = true;
        }
      };
      addToken(row.normalized_base_input_tokens, 'input');
      addToken(row.normalized_output_tokens, 'output');
      if (row.effective_cost_usd === null || row.effective_cost_usd === undefined
        || row.effective_cost_coverage !== 'known') {
        costUnknown = true;
      } else {
        const value = Number(row.effective_cost_usd);
        if (!Number.isFinite(value) || value < 0) costUnknown = true;
        else {
          const nextCost = costUsd + value;
          if (!Number.isFinite(nextCost)) costUnknown = true;
          else costUsd = nextCost;
        }
      }
    }
    let encodedInputTokens: number | string | null = null;
    if (invocationCount > 0 && !inputUnknown) {
      try { encodedInputTokens = encodeInt64(inputTokens); } catch { inputUnknown = true; }
    }
    let encodedOutputTokens: number | string | null = null;
    if (invocationCount > 0 && !outputUnknown) {
      try { encodedOutputTokens = encodeInt64(outputTokens); } catch { outputUnknown = true; }
    }
    const usageCoverage = invocationCount === 0
      ? 'unavailable'
      : inputUnknown || outputUnknown || costUnknown ? 'partial' : 'complete';
    const attributionCoverage = invocationCount === 0 || (!providerKnown && !modelKnown)
      ? 'unknown'
      : providerUnknown || modelUnknown || !providerKnown || !modelKnown
        ? 'unknown'
        : providerMixed || modelMixed ? 'mixed' : 'single';
    return {
      generationId: latestRow.generation_id,
      executionId: latestRow.execution_id,
      rootSessionId: latestRow.root_session_id,
      sourceKey: latestRow.settled_source_key,
      outcome: latestRow.outcome,
      startedAtMs: decodeOptionalTimestamp(latestRow.started_at_ms),
      endedAtMs,
      costUsd: invocationCount === 0 || costUnknown ? null : costUsd,
      inputTokens: encodedInputTokens,
      outputTokens: encodedOutputTokens,
      usageCoverage,
      provider: attributionCoverage === 'single' ? provider : null,
      modelId: attributionCoverage === 'single' ? modelId : null,
      attributionCoverage,
      turnSeries: [],
      turnSeriesCoverage: 'unavailable',
    };
  }

  /** Bounded global provider aggregate. Accounting, grouped dimensions, the
   * projection revision, and the observation watermark are all read while one
   * SQLite read transaction is open. Only aggregate rows (plus one sentinel
   * row for truncation detection) are materialized. */
  readProviderAggregateSummary(request: ProviderAggregateReadRequest): ProviderAggregateReadModel {
    this.assertOpen();
    const todayStartMs = boundedTimestamp(request.todayStartMs, 'todayStartMs');
    const todayEndMs = boundedTimestamp(request.todayEndMs, 'todayEndMs');
    const weekStartMs = boundedTimestamp(request.weekStartMs, 'weekStartMs');
    const weekEndMs = boundedTimestamp(request.weekEndMs, 'weekEndMs');
    if (todayStartMs > todayEndMs || weekStartMs > weekEndMs) {
      throw new RangeError('Canonical aggregate date bounds must be ordered.');
    }
    const configuredTimeZone = this.database.prepare(
      'SELECT time_zone FROM analytics_provider_daily_state WHERE singleton = 1',
    ).get() as { time_zone: string | null } | undefined;
    const timeZone = request.timeZone ?? configuredTimeZone?.time_zone ?? 'UTC';
    if (!timeZone || timeZone.includes('\0')) throw new Error('Canonical aggregate timezone is required.');
    const maxGroups = boundedPositiveInteger(
      request.maxGroups,
      DEFAULT_QUERY_ROWS,
      MAX_QUERY_ROWS,
      'provider aggregate maxGroups',
    );
    return this.snapshot(() => {
      const revision = this.getProjectionRevision();
      const accounting = this.readProviderAccountingSummaryInSnapshot(undefined, revision);
      const executionSummary = this.readExecutionSummaryInSnapshot(undefined, revision);
      const latestRun = this.readLatestRunInSnapshot();
      const projection = readProviderModelGroups(
        this.database as unknown as ProviderProjectionDatabase,
        {
          timeZone,
          todayDay: localCalendarDayKey(todayStartMs, timeZone),
          weekDays: localCalendarWeekDateKeys(todayStartMs, timeZone),
          maxGroups,
          windowStartMs: request.dailyWindowStartMs === undefined ? undefined : canonicalInt64(request.dailyWindowStartMs as Int64Value),
          windowEndMs: request.dailyWindowEndMs === undefined ? undefined : canonicalInt64(request.dailyWindowEndMs as Int64Value),
        } satisfies ProviderProjectionAggregateRequest,
      );
      const rows = projection.rows as Array<Record<string, unknown>>;
      const truncated = projection.truncated;
      return {
        revision,
        snapshotWatermark: this.readObservationWatermark(),
        accounting,
        executionSummary,
        latestRun,
        groups: truncated ? rows.slice(0, maxGroups) : rows,
        truncation: { rowLimit: truncated, byteLimit: false, cellLimit: false },
      };
    });
  }

  /** Exact once-per-invocation accounting with explicit missingness. A total
   * value is null whenever any contributing invocation lacks that channel. */
  readProviderAccountingSummary(rootSessionId?: string): ProviderAccountingSummary {
    this.assertOpen();
    return this.snapshot(() => this.readProviderAccountingSummaryInSnapshot(
      rootSessionId,
      this.getProjectionRevision(),
    ));
  }

  private readProviderAccountingSummaryInSnapshot(
    rootSessionId: string | undefined,
    revision: number | string,
  ): ProviderAccountingSummary {
    const scoped = rootSessionId !== undefined;
    const row = this.database.prepare(`
      SELECT summary_json FROM analytics_provider_accounting_projections
      WHERE subject_kind = ? AND subject_key = ?
    `).get(scoped ? 'session' : 'global', rootSessionId ?? '*') as { summary_json: string } | undefined;
    const stored = row ? JSON.parse(row.summary_json) as StoredProviderAccounting : emptyStoredProviderAccounting();
    const invocationCount = Number(stored.occurrenceCount);
    const channel = (name: AccountingChannel): CoverageMetric => {
      const value = stored.channels[name];
      const knownCount = Number(value.knownCount);
      const unknownCount = Number(value.unknownCount);
      // A maintained aggregate may exceed signed int64 even though every
      // individual observation is bounded by it. Preserve that exact decimal
      // total for the aggregate reader; the per-run projection separately
      // marks an overflowing selected channel partial rather than throwing.
      const knownTotal = encodeAggregateTotal(value.knownTotal);
      return {
        occurrenceCount: invocationCount,
        knownCount,
        unknownCount,
        knownTotal,
        value: unknownCount === 0 ? knownTotal : null,
        complete: unknownCount === 0,
      };
    };
    const costKnownCount = Number(stored.cost.knownCount);
    const costUnknownCount = Number(stored.cost.unknownCount);
    return {
      revision,
      invocationCount,
      inputTokens: channel('inputTokens'),
      outputTokens: channel('outputTokens'),
      cacheReadTokens: channel('cacheReadTokens'),
      cacheWriteTokens: channel('cacheWriteTokens'),
      reasoningTokens: channel('reasoningTokens'),
      providerTotalTokens: channel('providerTotalTokens'),
      effectiveCostUsd: {
        occurrenceCount: invocationCount,
        knownCount: costKnownCount,
        unknownCount: costUnknownCount,
        reportedCount: Number(stored.cost.reportedCount),
        calculatedCount: Number(stored.cost.calculatedCount),
        knownTotal: stored.cost.knownTotal,
        value: costUnknownCount === 0 ? stored.cost.knownTotal : null,
        complete: costUnknownCount === 0,
      },
    };
  }

  /** Backward-compatible P0 usage-only view, now served without replaying the
   * generic observation ledger. Missing channels remain null.
   *
   * This reads the usage columns directly instead of mapping over
   * {@link readProviderSettlements}. That path builds a full
   * `ProviderSettlementProjection` for every settlement row — roughly twenty-five
   * fields including nested `usage`, `cost` and coverage objects — and this view
   * then discards all but three of them. Measured against 400,000 settlements:
   * the projection path took 7,284 ms while selecting the three columns directly
   * took 833 ms, so about 6.5 s of the 7.3 s was constructing objects nobody read.
   * That is what pushed the all-history projection past its 9 s gate at 1M. */
  projectProviderUsage(rootSessionId?: string): ProviderUsageProjection[] {
    this.assertOpen();
    const scoped = rootSessionId !== undefined;
    const where = scoped ? 'WHERE root_session_id = ?' : '';
    const rows = this.database.prepare(`
      SELECT invocation_id, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, provider_total_tokens, reported_cost_usd
      FROM analytics_provider_settlements
      ${where}
      ORDER BY CAST(projection_revision AS INTEGER), generation_id, invocation_id
    `).all(...(scoped ? [rootSessionId] : [])) as Array<Record<string, unknown>>;
    const decodeInt = (value: unknown): number | string | null => value === null || value === undefined
      ? null
      : encodeInt64(String(value));
    return rows.map((row) => ({
      invocationId: String(row.invocation_id),
      usage: {
        inputTokens: decodeInt(row.input_tokens),
        outputTokens: decodeInt(row.output_tokens),
        cacheReadTokens: decodeInt(row.cache_read_tokens),
        cacheWriteTokens: decodeInt(row.cache_write_tokens),
        reasoningTokens: decodeInt(row.reasoning_tokens),
        providerTotalTokens: decodeInt(row.provider_total_tokens),
      },
      reportedCostUsd: row.reported_cost_usd === null || row.reported_cost_usd === undefined
        ? null
        : Number(row.reported_cost_usd),
    }));
  }

  readProducerAcknowledgements(observations: readonly AnalyticsObservation[]): ProducerReconciliation[] {
    this.assertOpen();
    const identities = [...new Set(observations
      .filter((observation) => sourceSequence(observation) !== null)
      .map((observation) => producerIdentity(observation)))];
    const statement = this.database.prepare(`
      SELECT state.producer_identity, state.contiguous_watermark,
        state.highest_observed_sequence, state.visible_gaps_json,
        (SELECT COUNT(*) FROM analytics_producer_sequences pending
          WHERE pending.producer_identity = state.producer_identity) AS pending_receipt_count
      FROM analytics_producer_reconciliation state WHERE state.producer_identity = ?
    `);
    return identities.flatMap((identity) => {
      const row = statement.get(identity) as {
        producer_identity: string;
        contiguous_watermark: string;
        highest_observed_sequence: string;
        visible_gaps_json: string;
        pending_receipt_count: number | bigint;
      } | undefined;
      return row ? [this.decodeProducerReconciliation(row)] : [];
    });
  }

  readProducerReconciliation(limit = 1_000): ProducerReconciliation[] {
    this.assertOpen();
    const boundedLimit = boundedPositiveInteger(limit, 1_000, 10_000, 'producer reconciliation limit');
    const rows = this.database.prepare(`
      SELECT state.producer_identity, state.contiguous_watermark,
        state.highest_observed_sequence, state.visible_gaps_json,
        (SELECT COUNT(*) FROM analytics_producer_sequences pending
          WHERE pending.producer_identity = state.producer_identity) AS pending_receipt_count
      FROM analytics_producer_reconciliation state ORDER BY state.producer_identity LIMIT ?
    `).all(boundedLimit) as Array<{
      producer_identity: string;
      contiguous_watermark: string;
      highest_observed_sequence: string;
      visible_gaps_json: string;
      pending_receipt_count: number | bigint;
    }>;
    return rows.map((row) => this.decodeProducerReconciliation(row));
  }

  private decodeProducerReconciliation(row: {
    producer_identity: string;
    contiguous_watermark: string;
    highest_observed_sequence: string;
    visible_gaps_json: string;
    pending_receipt_count: number | bigint;
  }): ProducerReconciliation {
    return {
      producerIdentity: row.producer_identity,
      contiguousWatermark: encodeInt64(row.contiguous_watermark),
      highestObservedSequence: encodeInt64(row.highest_observed_sequence),
      visibleGaps: (JSON.parse(row.visible_gaps_json) as Array<{ from: string; to: string }>).map((gap) => ({
        from: encodeInt64(gap.from),
        to: encodeInt64(gap.to),
      })),
      pendingReceiptCount: toNumber(row.pending_receipt_count),
    };
  }

  getProducerReconciliation(): ProducerReconciliation[] {
    return this.readProducerReconciliation();
  }

  getStats(): Readonly<AnalyticsRecorderStats> {
    return { ...this.stats };
  }

  /** Make committed writes durable.
   *
   * `TRUNCATE` demands exclusive access to the database and fails with
   * "database is locked" whenever any other helper is mid-write, so using it as
   * an ordinary flush barrier turned a routine concurrent `flush()` into a
   * worker-visible failure. A PASSIVE checkpoint moves committed frames into the
   * main database without blocking and without requiring exclusivity, which is
   * what a flush actually needs; the blocking full truncation stays where it is
   * genuinely required (private-close scrubbing). */
  checkpoint(): void {
    this.assertWritable();
    // A flush must make committed writes durable, and must never fail just
    // because another helper is mid-write.
    //
    // TRUNCATE both checkpoints the frames and folds the WAL file back to zero
    // bytes, which is the state the capacity calibration relies on. It needs
    // exclusive access, so contention is reported as a `busy` flag rather than
    // thrown, and is expected whenever another helper is writing. In that case
    // fall back to PASSIVE, which still checkpoints the frames durably without
    // requiring exclusivity; the WAL then stays non-empty until the next
    // quiescent flush, and every capacity snapshot is taken with all helpers
    // stopped.
    //
    // Truncating matters beyond tidiness: the calibration measures the database
    // family as main + WAL + shared-memory. A WAL left over a quiescent
    // boundary makes those totals depend on how much happened to be outstanding
    // rather than on how much data is stored, so a later truncation moves the
    // totals *backwards* while the database only grows.
    const result = this.truncateWalAndRead();
    if (toNumber(result.busy) !== 0) this.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /** Truncate the WAL, requiring exclusive access.
   *
   * Used by the private-close scrub, which must physically remove private bytes
   * from the WAL. A concurrent writer legitimately prevents this, so callers
   * must tolerate failure and keep the fence pending for a later retry. */
  /** Delete a subject's rows from one table in bounded statements.
   *
   * One `DELETE ... WHERE subject = ?` over a large subject holds the database
   * write lock for the statement's whole duration — measured ~20 s for ~1M rows
   * at scale — which exceeds the 5 s busy timeout every recorder shares, so a
   * concurrent writer fails as "database is locked". Deleting a bounded rowid
   * window per statement releases the lock between batches, so the longest
   * any other writer waits is one batch. Total work is unchanged; only how it is
   * divided.
   *
   * `rowid` is used rather than `LIMIT` because SQLite only accepts `LIMIT` on a
   * DELETE when compiled with the optional extension; a rowid window is
   * portable and cannot skip rows as long as the window is re-read after each
   * delete (which it is, since deleted rows leave the window empty). */
  private deleteSubjectRowsInBatches(
    table: 'analytics_observations' | 'analytics_detail_payloads',
    subjectFilter: string,
    rootSessionId: string,
    batchSize = 5_000,
  ): number {
    const selectWindow = this.database.prepare(`
      SELECT rowid AS rid FROM ${table} WHERE ${subjectFilter} LIMIT ?
    `);
    const deleteWindow = this.database.prepare(`
      DELETE FROM ${table} WHERE rowid = ?
    `);
    // Report the longest single-statement hold so the claim this change rests on
    // (no statement outlives another recorder's busy timeout) is measurable
    // rather than asserted.
    const profile = process.env.PIE_ANALYTICS_DELETE_PROFILE === '1';
    let deleted = 0;
    let batchCount = 0;
    let maxBatchMs = 0;
    for (;;) {
      // One bounded transaction per batch. The window is selected and deleted
      // inside the same transaction, so a concurrent writer cannot add a row to
      // the window between the two statements.
      //
      // The transaction is explicit and bounded rather than one statement per
      // row: this connection runs `synchronous = FULL` under WAL, so every
      // implicit transaction costs an fsync. A per-row commit measured 3,905 ms
      // for 2,000 rows against 5.9 ms for the same work in one transaction, so
      // the batch is what keeps the whole removal fast while still releasing the
      // write lock between batches.
      const batchStarted = performance.now();
      const rows = this.transactionOrInline(() => {
        const window = selectWindow.all(rootSessionId, rootSessionId, batchSize) as Array<{ rid: number | bigint }>;
        let changes = 0;
        for (const row of window) changes += toNumber(deleteWindow.run(row.rid).changes);
        return { window, changes };
      });
      if (rows.window.length === 0) {
        if (profile) {
          console.error(`[delete-profile] ${table} batches=${batchCount} rows=${deleted} maxBatchMs=${maxBatchMs.toFixed(1)}`);
        }
        return deleted;
      }
      deleted += rows.changes;
      batchCount += 1;
      maxBatchMs = Math.max(maxBatchMs, performance.now() - batchStarted);
    }
  }

  truncateWal(): void {
    this.assertWritable();
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Truncate and report the checkpoint result so the caller can see `busy`.
   * A concurrent writer legitimately makes this busy; that is a retryable
   * condition for the privacy scrub, not a defect. */
  truncateWalAndRead(): WalCheckpointRow {
    this.assertWritable();
    return this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as WalCheckpointRow;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writerStatements.clear();
    this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.transactionDepth += 1;
    try {
      return databaseTransaction(this.database, operation);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  /** Run `operation` in its own transaction, or inline when one is already open.
   * SQLite has no nested transactions, and the bulk removal is reached both
   * directly and from inside a pending-create binding transaction. Joining the
   * caller's transaction is correct in both cases: the outer transaction already
   * provides the atomicity, and the inner work cannot release a lock the outer
   * one is holding anyway. */
  private transactionOrInline<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    return this.transaction(operation);
  }

  /** Read bounded query-envelope metadata. Call only inside the snapshot that
   * also produces the command payload so revision/coverage cannot be paired
   * with rows from another commit. */
  private readQuerySnapshotMetadata(): AnalyticsQuerySnapshotMetadata {
    const generations = this.database.prepare(`
      SELECT generation_id FROM analytics_generations ORDER BY first_observed_at_ms, generation_id LIMIT 1001
    `).all() as Array<{ generation_id: string }>;
    const generationIdsTruncated = generations.length > 1_000;
    if (generationIdsTruncated) generations.pop();
    const delivery = this.readDeliveryAccounting();
    return {
      databaseSchemaVersion: this.getDatabaseSchemaVersion(),
      projectionRevision: this.getProjectionRevision(),
      snapshotWatermark: this.readObservationWatermark(),
      generationIds: generations.map((row) => row.generation_id),
      generationIdsTruncated,
      pendingDetailCoverage: {
        deliveryHistoryCoverage: delivery.deliveryHistoryCoverage,
        completeDetailWatermark: delivery.completeDetailWatermark,
        retainedDetailLogicalBytes: delivery.retainedDetailLogicalBytes,
        retainedDetailStoredBytes: delivery.retainedDetailStoredBytes,
      },
      truncation: { rowLimit: false, byteLimit: false, cellLimit: false },
    };
  }

  private readObservationWatermark(): number | string {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(commit_sequence), 0) AS watermark FROM analytics_observations
    `).get() as { watermark: number | bigint };
    return encodeInt64(BigInt(row.watermark));
  }

  private snapshot<T>(operation: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    }
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.readOnly) throw new Error('Analytics recorder is read-only.');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Analytics recorder is closed.');
  }
}
