import {
  AnalyticsQueryClient,
} from './query-client.js';
import type {
  AnalyticsQueryAdmissionSnapshot,
  AnalyticsQueryLifecycleEvent,
} from './query-client.js';
import type {
  AnalyticsDetailRangeResult,
  AnalyticsQuerySnapshotMetadata,
  AnalyticsReadOnlyQueryResult,
  AnalyticsSchemaDescription,
  AnalyticsStorageReadModel,
  HistoricalDimensionSummary,
  ProviderAccountingSummary,
  ProviderAggregateReadModel,
  ProviderSettlementScope,
  ProviderSettlementReadModel,
  ScopedProviderSettlementReadModel,
} from './sqlite-recorder.js';
import type { CanonicalExecutionSummary } from './execution-summary.js';
import type { ActivityProjectionReadModel } from './activity-projection.js';
import type { ToolFacetProjectionReadModel } from './tool-facet.js';

/**
 * Canonical analytics filename inside the canonical `analytics/` data root.
 * P2b's lifecycle store is the separate `state/session-lifecycle.sqlite`;
 * this file is only ever read through the bounded read-only query helper.
 */
export const ANALYTICS_DATABASE_FILENAME = 'analytics.sqlite';

/** Resolve the canonical analytics database path from the canonical analytics directory. */
export function canonicalAnalyticsDatabasePath(analyticsDir: string): string {
  return `${analyticsDir.replace(/[\\/]$/, '')}/${ANALYTICS_DATABASE_FILENAME}`;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REVISION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ROWS = 200;
const MAX_ROWS = 10_000;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DETAIL_BYTES = 64 * 1024;

export interface CanonicalAnalyticsReadModelOptions {
  /** Canonical database file (usually {@link canonicalAnalyticsDatabasePath}). */
  databasePath: string;
  /** Forkable query-helper entry: the built `out/analytics-query-worker.js`
   * bundle in production, or the TS entry under a TS loader in tests. */
  workerScript: string;
  /** Per-query inactivity timeout (contract default 10s). */
  timeoutMs?: number;
  maxConcurrentQueries?: number;
  maxQueuedQueries?: number;
  /** Default displayed row bound for `executeQuery` and settlement reads;
   * the helper caps at 10k rows. */
  maxRows?: number;
  /** Default serialized-result bound; the helper caps at 16 MiB. */
  maxResultBytes?: number;
  /** Default detail range size; the helper caps at 64 KiB per request. */
  maxDetailBytes?: number;
  /** Cross-host revision polling interval (contract target 1s). */
  revisionPollIntervalMs?: number;
  /** Per-query JavaScript heap ceiling for the disposable helper fork. */
  maxOldSpaceMb?: number;
  /** Fork exec args for the disposable helper (defaults to inherited exec args). */
  execArgv?: readonly string[];
  /** Optional non-blocking request lifecycle diagnostics. */
  onQueryLifecycle?: (event: AnalyticsQueryLifecycleEvent) => void;
  /** Runtime-owned writer preparation for the active calendar window. The
   * read model itself never mutates the SQLite projection. */
  beforeProviderAggregateRead?: (request: CanonicalAggregateRequest) => Promise<void>;
}

export interface CanonicalQueryRequest {
  sql: string;
  parameters?: readonly unknown[];
  maxRows?: number;
  maxQueryBytes?: number;
  maxCellBytes?: number;
  maxResultBytes?: number;
}

export interface CanonicalDetailRequest {
  payloadId: string;
  offset?: number | string;
  maxBytes?: number;
  maxResultBytes?: number;
}

export interface CanonicalSettlementRequest {
  rootSessionId?: string;
  limit?: number;
  maxResultBytes?: number;
}

export interface CanonicalAggregateRequest {
  todayStartMs: number;
  todayEndMs: number;
  weekStartMs: number;
  weekEndMs: number;
  /** The single active IANA calendar zone prepared by the recorder writer. */
  timeZone?: string;
  /** Stable writer preparation envelope. These are kept out of the helper
   * payload because the helper reads only the already-prepared projection. */
  dailyWindowStartMs?: number;
  dailyWindowEndMs?: number;
  maxGroups?: number;
  maxResultBytes?: number;
}

export interface CanonicalActivityProjectionRequest {
  /** Session scope; omitted selects the global scope. */
  rootSessionId?: string;
  /** Bounded per-kind rows (helper default 64, cap 10 000). */
  maxKinds?: number;
  maxResultBytes?: number;
}

export interface CanonicalToolFacetProjectionRequest {
  /** Session scope; omitted selects the global scope. */
  rootSessionId?: string;
  /** Bounded facet rows (helper default 200, cap 10 000). */
  limit?: number;
  maxResultBytes?: number;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Canonical analytics read model ${name} must be a positive safe integer.`);
  }
  return Math.min(value, maximum);
}

/** Normalize int64 values the helper returns as decimal strings or numbers. */
function canonicalRevisionValue(value: number | string): string {
  return typeof value === 'number' ? value.toString() : BigInt(value).toString();
}

/**
 * Host-owned P5 read model and query transport over the canonical analytics
 * store. Every call dispatches one disposable read-only SQLite helper fork
 * (bounded rows/bytes, inactivity timeout, concurrency/queue caps,
 * cancellation) and never touches the legacy JSONL ledger, raw run logs, or
 * detail-source fallbacks. The writer stays a separate process; a cancelled
 * or timed-out helper cannot disturb the extension host or the recorder.
 */
export class CanonicalAnalyticsReadModel {
  private readonly client: AnalyticsQueryClient;
  private readonly maxConcurrentQueries: number;
  private readonly maxRows: number;
  private readonly maxResultBytes: number;
  private readonly maxDetailBytes: number;
  private readonly revisionPollIntervalMs: number;
  private readonly beforeProviderAggregateRead?: (request: CanonicalAggregateRequest) => Promise<void>;

  constructor(options: CanonicalAnalyticsReadModelOptions) {
    this.maxConcurrentQueries = boundedPositiveInteger(
      options.maxConcurrentQueries,
      2,
      64,
      'maxConcurrentQueries',
    );
    this.client = new AnalyticsQueryClient({
      databasePath: options.databasePath,
      workerScript: options.workerScript,
      timeoutMs: boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 3_600_000, 'timeoutMs'),
      maxConcurrentQueries: this.maxConcurrentQueries,
      maxQueuedQueries: options.maxQueuedQueries === undefined
        ? undefined
        : boundedPositiveInteger(options.maxQueuedQueries, 16, 1024, 'maxQueuedQueries'),
      maxOldSpaceMb: options.maxOldSpaceMb,
      execArgv: options.execArgv,
      onQueryLifecycle: options.onQueryLifecycle,
    });
    this.maxRows = boundedPositiveInteger(options.maxRows, DEFAULT_MAX_ROWS, MAX_ROWS, 'maxRows');
    this.maxResultBytes = boundedPositiveInteger(
      options.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      MAX_RESULT_BYTES,
      'maxResultBytes',
    );
    this.maxDetailBytes = boundedPositiveInteger(
      options.maxDetailBytes,
      DEFAULT_MAX_DETAIL_BYTES,
      MAX_RESULT_BYTES,
      'maxDetailBytes',
    );
    this.beforeProviderAggregateRead = options.beforeProviderAggregateRead;
    this.revisionPollIntervalMs = boundedPositiveInteger(
      options.revisionPollIntervalMs,
      DEFAULT_REVISION_POLL_INTERVAL_MS,
      60_000,
      'revisionPollIntervalMs',
    );
  }

  /** Actual per-instance query admission capacity used by startup hydration. */
  getMaxConcurrentQueries(): number {
    return this.maxConcurrentQueries;
  }

  /** O(1) current admission state for bounded diagnostics. */
  getAdmissionSnapshot(): AnalyticsQueryAdmissionSnapshot {
    return this.client.getAdmissionSnapshot();
  }

  /** Resolved logical commands, views, and projection versions for this store. */
  describeSchema(signal?: AbortSignal): Promise<AnalyticsSchemaDescription> {
    return this.client.query<AnalyticsSchemaDescription>({ type: 'schema' }, signal);
  }

  /** Cheap current projection revision (decimal string), for refresh ownership. */
  async readRevision(signal?: AbortSignal): Promise<string> {
    const result = await this.client.query<AnalyticsReadOnlyQueryResult>({
      type: 'query',
      sql: 'SELECT revision FROM analytics_projection_state WHERE singleton = 1',
    }, signal);
    const value = result.rows[0]?.revision;
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error('Canonical analytics projection revision is unavailable.');
    }
    return canonicalRevisionValue(value);
  }

  /**
   * Resolve when the projection revision differs from {@link revision} — the
   * contract's cross-host refresh contract — by bounded polling (contract
   * target 1s). Resolves with the current revision on cancellation of the
   * condition by an explicit {@link options.maxWaitMs} bound; rejects when
   * {@link options.signal} aborts.
   */
  async waitForRevision(
    revision: number | string,
    options: { signal?: AbortSignal; maxWaitMs?: number } = {},
  ): Promise<string> {
    const target = canonicalRevisionValue(revision);
    const deadline = options.maxWaitMs === undefined ? undefined : Date.now() + options.maxWaitMs;
    for (;;) {
      const current = await this.readRevision(options.signal);
      if (current !== target) return current;
      if (deadline !== undefined && Date.now() + this.revisionPollIntervalMs > deadline) return current;
      await this.delay(this.revisionPollIntervalMs, options.signal);
    }
  }

  /** One bounded read-only SELECT. Results carry the snapshot watermark,
   * projection revision, generation coverage, and explicit truncation flags. */
  executeQuery(request: CanonicalQueryRequest, signal?: AbortSignal): Promise<AnalyticsReadOnlyQueryResult> {
    if (!request.sql || /\0/u.test(request.sql)) {
      throw new Error('Canonical analytics query SQL must be a non-empty string without NUL.');
    }
    return this.client.query<AnalyticsReadOnlyQueryResult>({
      type: 'query',
      sql: request.sql,
      parameters: request.parameters,
      maxRows: request.maxRows ?? this.maxRows,
      maxQueryBytes: request.maxQueryBytes,
      maxCellBytes: request.maxCellBytes,
      maxResultBytes: request.maxResultBytes ?? this.maxResultBytes,
    }, signal);
  }

  /** One bounded detail range; large payloads page via `nextOffset` and the
   * `truncated` flag, never by silently raising the byte bound. */
  readDetail(request: CanonicalDetailRequest, signal?: AbortSignal): Promise<AnalyticsDetailRangeResult> {
    if (!request.payloadId || request.payloadId.includes('\0')) {
      throw new Error('Canonical analytics payloadId must be a non-empty string without NUL.');
    }
    return this.client.query<AnalyticsDetailRangeResult>({
      type: 'detail',
      payloadId: request.payloadId,
      offset: request.offset,
      maxBytes: request.maxBytes ?? this.maxDetailBytes,
      maxResultBytes: request.maxResultBytes ?? this.maxResultBytes,
    }, signal);
  }

  /** Bounded storage and delivery accounting, including pending-detail coverage. */
  readStorageSummary(signal?: AbortSignal): Promise<AnalyticsStorageReadModel> {
    return this.client.query<AnalyticsStorageReadModel>({
      type: 'storage',
      maxResultBytes: this.maxResultBytes,
    }, signal);
  }

  /** Bounded settlement projection rows (optionally one root session), with the
   * projection revision the rows were read at. */
  readProviderSettlements(
    request: CanonicalSettlementRequest = {},
    signal?: AbortSignal,
  ): Promise<ProviderSettlementReadModel> {
    if (request.rootSessionId !== undefined
        && (!request.rootSessionId.trim() || request.rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    return this.client.query<ProviderSettlementReadModel>({
      type: 'providerSettlements',
      rootSessionId: request.rootSessionId,
      limit: request.limit ?? this.maxRows,
      maxResultBytes: request.maxResultBytes ?? this.maxResultBytes,
    }, signal);
  }

  /** Accounting-only branch/copy view. Inherited rows remain references to
   * original invocation identities and carry explicit coverage. */
  readScopedProviderSettlements(
    scope: ProviderSettlementScope,
    page: { limit?: number; offset?: number; expectedRevision?: number | string; maxResultBytes?: number } = {},
    signal?: AbortSignal,
  ): Promise<ScopedProviderSettlementReadModel> {
    const maxResultBytes = boundedPositiveInteger(
      page.maxResultBytes,
      this.maxResultBytes,
      MAX_RESULT_BYTES,
      'scoped settlement maxResultBytes',
    );
    return this.client.query<ScopedProviderSettlementReadModel>({
      type: 'scopedProviderSettlements',
      scope,
      limit: page.limit ?? this.maxRows,
      offset: page.offset,
      expectedRevision: page.expectedRevision,
      maxResultBytes,
    }, signal);
  }

  /** Engine-neutral scoped accounting summary over the canonical settlements. */
  readProviderAccountingSummary(rootSessionId?: string, signal?: AbortSignal): Promise<ProviderAccountingSummary> {
    if (rootSessionId !== undefined && (!rootSessionId.trim() || rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    return this.client.query<ProviderAccountingSummary>({
      type: 'providerAccounting',
      rootSessionId,
    }, signal);
  }

  /** Bounded maintained root agent-run execution counts and latest settled
   * identity. Provider calls and assistant-turn facets are excluded. */
  readExecutionSummary(rootSessionId?: string, signal?: AbortSignal): Promise<CanonicalExecutionSummary> {
    if (rootSessionId !== undefined && (!rootSessionId.trim() || rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    return this.client.query<CanonicalExecutionSummary>({
      type: 'executionSummary',
      rootSessionId,
    }, signal);
  }

  /** Accounting and bounded provider/model/date groups from one recorder
   * snapshot. The result revision is the authority for consumer freshness. */
  readProviderAggregateSummary(
    request: CanonicalAggregateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderAggregateReadModel> {
    if (!request || !Number.isSafeInteger(request.todayStartMs)
      || !Number.isSafeInteger(request.todayEndMs)
      || !Number.isSafeInteger(request.weekStartMs)
      || !Number.isSafeInteger(request.weekEndMs)
      || (request.dailyWindowStartMs !== undefined && !Number.isSafeInteger(request.dailyWindowStartMs))
      || (request.dailyWindowEndMs !== undefined && !Number.isSafeInteger(request.dailyWindowEndMs))
      || request.todayStartMs > request.todayEndMs
      || request.weekStartMs > request.weekEndMs
      || (request.dailyWindowStartMs !== undefined && request.dailyWindowEndMs !== undefined
        && request.dailyWindowStartMs > request.dailyWindowEndMs)) {
      throw new RangeError('Canonical aggregate date bounds must be ordered safe integers.');
    }
    if (request.timeZone !== undefined
      && (typeof request.timeZone !== 'string' || !request.timeZone || request.timeZone.includes('\0'))) {
      throw new RangeError('Canonical aggregate timeZone must be a non-empty IANA name.');
    }
    const maxGroups = request.maxGroups === undefined
      ? undefined
      : boundedPositiveInteger(request.maxGroups, this.maxRows, MAX_ROWS, 'aggregate maxGroups');
    const maxResultBytes = boundedPositiveInteger(
      request.maxResultBytes,
      this.maxResultBytes,
      MAX_RESULT_BYTES,
      'aggregate maxResultBytes',
    );
    return (async () => {
      if (this.beforeProviderAggregateRead) await this.beforeProviderAggregateRead(request);
      return this.client.query<ProviderAggregateReadModel>({
      type: 'providerAggregate',
      todayStartMs: request.todayStartMs,
      todayEndMs: request.todayEndMs,
      weekStartMs: request.weekStartMs,
      weekEndMs: request.weekEndMs,
      timeZone: request.timeZone,
      dailyWindowStartMs: request.dailyWindowStartMs,
      dailyWindowEndMs: request.dailyWindowEndMs,
      maxGroups,
      maxResultBytes,
      }, signal);
    })();
  }

  /** Bounded historical membership. Inspect truncation; use explicit SQL for
   * narrower scopes when these convenience groups exceed the display limits. */
  readHistoricalDimensions(signal?: AbortSignal): Promise<HistoricalDimensionSummary> {
    return this.client.query<HistoricalDimensionSummary>({
      type: 'historicalDimensions',
      maxRowsPerDimension: this.maxRows,
      maxResultBytes: this.maxResultBytes,
    }, signal);
  }

  /** Bounded maintained activity summary for the global or one session scope.
   * `totals.measuredTotalMs` is additive measured work — parallel or nested
   * spans may exceed elapsed wall time — and known/unknown counts stay
   * isolated. Wall-union queries remain explicit raw SQL over the member
   * anchors. */
  readActivityProjection(
    request: CanonicalActivityProjectionRequest = {},
    signal?: AbortSignal,
  ): Promise<ActivityProjectionReadModel & AnalyticsQuerySnapshotMetadata> {
    if (request.rootSessionId !== undefined
        && (!request.rootSessionId.trim() || request.rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    const maxKinds = request.maxKinds === undefined
      ? undefined
      : boundedPositiveInteger(request.maxKinds, this.maxRows, MAX_ROWS, 'activity maxKinds');
    return this.client.query<ActivityProjectionReadModel & AnalyticsQuerySnapshotMetadata>({
      type: 'activityProjection',
      rootSessionId: request.rootSessionId,
      maxKinds,
      maxResultBytes: request.maxResultBytes ?? this.maxResultBytes,
    }, signal);
  }

  /** Bounded maintained tool/file facet rows with explicit attempted
   * (unverified-proxy) line counts; `null`/absent line counts mean the tool
   * has no line-activity evidence, never an invented empty change. */
  readToolFacetProjection(
    request: CanonicalToolFacetProjectionRequest = {},
    signal?: AbortSignal,
  ): Promise<ToolFacetProjectionReadModel & AnalyticsQuerySnapshotMetadata> {
    if (request.rootSessionId !== undefined
        && (!request.rootSessionId.trim() || request.rootSessionId.includes('\0'))) {
      throw new Error('Canonical analytics rootSessionId must be a non-empty string without NUL.');
    }
    const limit = request.limit === undefined
      ? undefined
      : boundedPositiveInteger(request.limit, this.maxRows, MAX_ROWS, 'facet limit');
    return this.client.query<ToolFacetProjectionReadModel & AnalyticsQuerySnapshotMetadata>({
      type: 'toolFacetProjection',
      rootSessionId: request.rootSessionId,
      limit,
      maxResultBytes: request.maxResultBytes ?? this.maxResultBytes,
    }, signal);
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Canonical analytics revision wait cancelled.'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref();
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal!.reason ?? new Error('Canonical analytics revision wait cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
