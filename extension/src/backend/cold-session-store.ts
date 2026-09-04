import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';

import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts';
import { findDurableDetail } from '../shared/lazy-details';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol';
import type {
  DetailResult,
  LazyDetailRef,
  ModelInfo,
  ModelSettings,
  SessionOpenedPayload,
  SessionSummary,
  ThinkingLevel,
  TranscriptMode,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../shared/protocol';
import type { LiveSubagentDetailAddress } from '../shared/protocol/subagent-detail';
import { SessionSnapshotTooLargeError, type SessionSnapshotTransport } from '../shared/transcript-window';
import {
  ColdBrowseProjectionCache,
  type ColdBrowseProjectionCacheStats,
} from './cold-browse-projection-cache';
import {
  ColdBrowseHelperRequestError,
  type ColdBrowseHelper,
} from './cold-browse-helper-client';
import {
  readColdBrowseFingerprintSync,
  type ColdBrowseHelperPageOptions,
} from './cold-browse-helper-protocol';
import { forgetPrivateSessionArtifacts, type ForgetPrivateSessionArtifactsDeps } from './private-session-artifacts';
import {
  DurableDetailNotAddressableError,
  DurableDetailNotFoundError,
  resolveDurableDetailFromTranscript,
  type ResolvedDurableDetail,
} from './durable-detail-store';
import {
  buildBrowseSessionOpenedPayload,
  openSessionBrowseSnapshot,
  type SessionBrowseSnapshot,
} from './session-browser';
import { SessionCatalog } from './session-catalog';
import { backendSessionPathKey } from './session-directory';
import { recordWriteOwnership } from './write-ownership-trace';
import { BackendError } from './server-io';
import type { SdkModule, SdkSessionManager } from './sdk';
import { normalizeDanglingTranscript } from './session-opened';
import { buildPagedTranscriptWindow } from './transcript-window';
import type { SessionEntryLike } from './transcript';

/** The coordinator remains the sole ownership authority. Exact-v3 browse
 * misses may project in an explicitly configured read-only helper; every
 * mutation and all legacy/malformed semantics remain coordinator-local. */
export const COLD_SESSION_STORE_PLACEMENT = 'coordinator-with-optional-helper' as const;

const MISSING_FINGERPRINT = 'missing';
const DEFAULT_READ_ATTEMPTS = 3;
const ATOMIC_REPLACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const ATOMIC_REPLACE_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface ColdSessionContext {
  messages: unknown[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface ColdSessionTreeNode {
  entry: SessionEntryLike;
  children: ColdSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

interface ColdSdkSessionManager extends SdkSessionManager {
  buildSessionContext: () => ColdSessionContext;
  getTree: () => ColdSessionTreeNode[];
  buildContextEntries?: () => SessionEntryLike[];
  appendPieModelSettingsChange?: (
    provider: string | undefined,
    modelId: string | undefined,
    thinkingLevel: string | undefined,
  ) => {
    modelChangeId?: string;
    thinkingLevelChangeId?: string;
  };
}

export interface ColdSessionOwnershipStamp {
  readonly coordinatorGeneration: number;
  readonly sessionPath: string;
  readonly sessionPathKey: string;
  readonly ownershipRevision: number;
  readonly fingerprint: string;
}

export type StaleColdSessionLeaseReason =
  | 'coordinator-generation'
  | 'ownership-revision'
  | 'session-path'
  | 'path-reserved'
  | 'fingerprint';

export class StaleColdSessionLeaseError extends Error {
  readonly code = 'STALE_COLD_SESSION_LEASE';

  constructor(
    readonly reason: StaleColdSessionLeaseReason,
    readonly stamp: ColdSessionOwnershipStamp,
  ) {
    super(`Cold session ownership changed before commit (${reason}): ${stamp.sessionPath}`);
    this.name = 'StaleColdSessionLeaseError';
  }
}

export interface ColdSessionLeaseAuthorityOptions {
  fingerprint?: (sessionPath: string) => string;
  /** Test seam for proving catalog reservation checks stay filesystem-free. */
  canonicalPathKey?: (sessionPath: string) => string;
}

export interface ColdSessionPathReservationToken {
  readonly reservationId: string;
  readonly canonicalPath: string;
  readonly sessionPathKey: string;
  readonly nonce: string;
}

interface ColdSessionPathReservationState {
  reservationId: string;
  canonicalPath: string;
  nonce: string;
  hideFromCatalog: boolean;
}

export interface ColdSessionPathReservationOptions {
  /** Destination/create transitions are hidden until durable commit. Long-lived
   * hot ownership fences remain catalog-visible while still rejecting cold IO. */
  hideFromCatalog?: boolean;
}

/** Coordinator-local lease authority. Capturing a stamp is cheap and does not
 * exclude concurrent cold reads. Promotion, replacement, forget, or any other
 * ownership transition calls invalidate(path); all existing work then fails
 * its synchronous publication/commit check. Replacement reservations use this
 * same authority so a reserved path cannot mint or commit a cold stamp. */
export class ColdSessionLeaseAuthority {
  private readonly ownershipRevisions = new Map<string, number>();
  private readonly pathReservations = new Map<string, ColdSessionPathReservationState>();
  /** Most catalog rows can be rejected lexically. Only a basename that could
   * alias a catalog-hidden canonical path needs the synchronous realpath fallback. */
  private readonly hiddenReservationBasenameCounts = new Map<string, number>();
  private currentCoordinatorGeneration: number;
  private currentAuthorityRevision = 0;
  private readonly fingerprint: (sessionPath: string) => string;
  private readonly canonicalPathKey: (sessionPath: string) => string;

  constructor(coordinatorGeneration: number, options: ColdSessionLeaseAuthorityOptions = {}) {
    if (!Number.isSafeInteger(coordinatorGeneration) || coordinatorGeneration < 0) {
      throw new Error('coordinatorGeneration must be a non-negative safe integer.');
    }
    this.currentCoordinatorGeneration = coordinatorGeneration;
    this.fingerprint = options.fingerprint ?? readColdBrowseFingerprintSync;
    this.canonicalPathKey = options.canonicalPathKey ?? coldCanonicalPathKey;
  }

  get coordinatorGeneration(): number {
    return this.currentCoordinatorGeneration;
  }

  /** Monotonic process-local fence for catalog scans that do not know their
   * result paths until SDK discovery finishes. */
  get authorityRevision(): number {
    return this.currentAuthorityRevision;
  }

  capture(sessionPath: string): ColdSessionOwnershipStamp {
    const sessionPathKey = this.canonicalPathKey(sessionPath);
    const stamp = {
      coordinatorGeneration: this.currentCoordinatorGeneration,
      sessionPath,
      sessionPathKey,
      ownershipRevision: this.ownershipRevisions.get(sessionPathKey) ?? 0,
      fingerprint: this.fingerprint(sessionPath),
    };
    if (this.pathReservations.has(sessionPathKey)) {
      throw new StaleColdSessionLeaseError('path-reserved', stamp);
    }
    return stamp;
  }

  /** Like {@link capture} but returns `undefined` instead of throwing when the
   *  path is currently reserved (a session mid-creation). Used by read-only
   *  catalog scans (`list`) where a reserved path is a not-yet-committed
   *  session that should simply be omitted from the result rather than failing
   *  the whole scan. */
  tryCapture(sessionPath: string): ColdSessionOwnershipStamp | undefined {
    const sessionPathKey = this.canonicalPathKey(sessionPath);
    if (this.pathReservations.has(sessionPathKey)) {
      return undefined;
    }
    return {
      coordinatorGeneration: this.currentCoordinatorGeneration,
      sessionPath,
      sessionPathKey,
      ownershipRevision: this.ownershipRevisions.get(sessionPathKey) ?? 0,
      fingerprint: this.fingerprint(sessionPath),
    };
  }

  /** Catalog projection only needs to omit a path while a replacement/create
   * reservation is active; it must not synchronously realpath/stat every
   * indexed row. The common non-candidate path is O(1) and filesystem-free,
   * including while long-lived catalog-visible hot fences exist. For a hidden
   * basename candidate, retain symlink-safe canonical matching. */
  isPathReserved(sessionPath: string): boolean {
    if (this.pathReservations.size === 0) return false;
    const lexicalKey = backendSessionPathKey(sessionPath);
    const lexicalReservation = this.pathReservations.get(lexicalKey);
    if (lexicalReservation?.hideFromCatalog) return true;
    if (!this.hiddenReservationBasenameCounts.has(coldReservationBasenameKey(sessionPath))) return false;
    return this.pathReservations.get(this.canonicalPathKey(sessionPath))?.hideFromCatalog === true;
  }

  /** Atomically reserve canonical paths in sorted key order. Validation happens
   * before mutation, and rollback/release uses the same deterministic order. */
  reserveCanonicalPaths(
    canonicalPaths: readonly string[],
    reservationId: string,
    options: ColdSessionPathReservationOptions = {},
  ): readonly ColdSessionPathReservationToken[] {
    if (!reservationId) throw new Error('Cold path reservation requires an identity.');
    const ordered = [...new Map(canonicalPaths.map((canonicalPath) => [
      this.canonicalPathKey(canonicalPath),
      canonicalPath,
    ])).entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [sessionPathKey, canonicalPath] of ordered) {
      const existing = this.pathReservations.get(sessionPathKey);
      if (existing) {
        throw new StaleColdSessionLeaseError('path-reserved', {
          coordinatorGeneration: this.currentCoordinatorGeneration,
          sessionPath: canonicalPath,
          sessionPathKey,
          ownershipRevision: this.ownershipRevisions.get(sessionPathKey) ?? 0,
          fingerprint: this.fingerprint(canonicalPath),
        });
      }
    }
    // Construct every token before mutating either reservation index. If token
    // creation ever fails, the operation leaves both indexes untouched.
    const tokens = ordered.map(([sessionPathKey, canonicalPath]) => ({
      reservationId,
      canonicalPath,
      sessionPathKey,
      nonce: crypto.randomUUID(),
    }));
    for (const token of tokens) {
      const { canonicalPath, sessionPathKey, nonce } = token;
      const hideFromCatalog = options.hideFromCatalog ?? true;
      this.pathReservations.set(sessionPathKey, {
        reservationId,
        canonicalPath,
        nonce,
        hideFromCatalog,
      });
      if (hideFromCatalog) this.incrementHiddenReservationBasename(canonicalPath);
      this.bumpOwnershipRevision(sessionPathKey);
    }
    return tokens;
  }

  releaseCanonicalPaths(tokens: readonly ColdSessionPathReservationToken[]): void {
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token.sessionPathKey)) {
        throw new Error(`Duplicate cold path reservation release: ${token.canonicalPath}`);
      }
      seen.add(token.sessionPathKey);
    }
    const ordered = [...tokens].sort((left, right) => left.sessionPathKey.localeCompare(right.sessionPathKey));
    for (const token of ordered) {
      const current = this.pathReservations.get(token.sessionPathKey);
      if (!current || current.reservationId !== token.reservationId || current.nonce !== token.nonce) {
        throw new Error(`Cold path reservation is stale: ${token.canonicalPath}`);
      }
    }
    for (const token of ordered) {
      const current = this.pathReservations.get(token.sessionPathKey)!;
      this.pathReservations.delete(token.sessionPathKey);
      if (current.hideFromCatalog) this.decrementHiddenReservationBasename(current.canonicalPath);
      this.bumpOwnershipRevision(token.sessionPathKey);
    }
  }

  /** Refresh only the durable fingerprint after this lease synchronously
   * performed a supported SDK/file commit. Generation and ownership must still
   * match; callers cannot use restamping to cross an ownership transition. */
  restamp(stamp: ColdSessionOwnershipStamp): ColdSessionOwnershipStamp {
    this.assertOwnershipCurrent(stamp);
    return {
      ...stamp,
      fingerprint: this.fingerprint(stamp.sessionPath),
    };
  }

  assertCurrent(stamp: ColdSessionOwnershipStamp): void {
    this.assertOwnershipCurrent(stamp);
    if (this.fingerprint(stamp.sessionPath) !== stamp.fingerprint) {
      throw new StaleColdSessionLeaseError('fingerprint', stamp);
    }
  }

  /** The check and callback are deliberately synchronous. There is no event
   * loop gap in which a promotion/replacement can steal ownership between the
   * final check and the SDK/file commit. */
  commitSync<T>(stamp: ColdSessionOwnershipStamp, commit: () => T): T {
    this.assertCurrent(stamp);
    return commit();
  }

  invalidate(sessionPath: string): number {
    return this.bumpOwnershipRevision(this.canonicalPathKey(sessionPath));
  }

  /** Retire every stamp from an old coordinator generation. */
  advanceCoordinatorGeneration(nextGeneration: number): void {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.currentCoordinatorGeneration) {
      throw new Error('The coordinator generation must increase.');
    }
    this.currentCoordinatorGeneration = nextGeneration;
    this.ownershipRevisions.clear();
    this.pathReservations.clear();
    this.hiddenReservationBasenameCounts.clear();
    this.currentAuthorityRevision += 1;
  }

  private bumpOwnershipRevision(key: string): number {
    const next = (this.ownershipRevisions.get(key) ?? 0) + 1;
    this.ownershipRevisions.set(key, next);
    this.currentAuthorityRevision += 1;
    return next;
  }

  private assertOwnershipCurrent(stamp: ColdSessionOwnershipStamp): void {
    if (stamp.coordinatorGeneration !== this.currentCoordinatorGeneration) {
      throw new StaleColdSessionLeaseError('coordinator-generation', stamp);
    }
    if (this.canonicalPathKey(stamp.sessionPath) !== stamp.sessionPathKey) {
      throw new StaleColdSessionLeaseError('session-path', stamp);
    }
    if ((this.ownershipRevisions.get(stamp.sessionPathKey) ?? 0) !== stamp.ownershipRevision) {
      throw new StaleColdSessionLeaseError('ownership-revision', stamp);
    }
    if (this.pathReservations.has(stamp.sessionPathKey)) {
      throw new StaleColdSessionLeaseError('path-reserved', stamp);
    }
  }

  private incrementHiddenReservationBasename(sessionPath: string): void {
    const basename = coldReservationBasenameKey(sessionPath);
    this.hiddenReservationBasenameCounts.set(
      basename,
      (this.hiddenReservationBasenameCounts.get(basename) ?? 0) + 1,
    );
  }

  private decrementHiddenReservationBasename(sessionPath: string): void {
    const basename = coldReservationBasenameKey(sessionPath);
    const next = (this.hiddenReservationBasenameCounts.get(basename) ?? 0) - 1;
    if (next <= 0) this.hiddenReservationBasenameCounts.delete(basename);
    else this.hiddenReservationBasenameCounts.set(basename, next);
  }
}

export interface ColdSessionManagerHandle {
  readonly sessionPath: string;
  readonly manager: SdkSessionManager;
  readonly stamp: ColdSessionOwnershipStamp;
}

export interface SerializedColdSessionPromotionGrant {
  readonly grantId: string;
  readonly coordinatorGeneration: number;
  readonly sessionPath: string;
  readonly sessionPathKey: string;
  readonly fingerprint: string;
  readonly creationReason: 'new' | 'resume';
}

export interface ColdSessionOpenOptions {
  modelSettings: ModelSettings;
  /** Omit on catalog failure; [] is an authoritative empty catalog. */
  availableModels?: ModelInfo[];
  selectionToken?: string;
  operationId?: string;
  operationAttempt?: number;
  transcript?: TranscriptMode;
  transport?: SessionSnapshotTransport;
  systemPromptDisabledEntries?: readonly string[];
}

/** Canonical per-session configuration written while no execution runtime owns
 * the session. These values become ordinary Pi transcript entries, so cold
 * browsing, later worker promotion, and a fresh backend process all observe
 * the same source of truth. */
export interface ColdSessionModelSettingsUpdate {
  model?: {
    provider: string;
    modelId: string;
  };
  thinkingLevel?: ThinkingLevel;
}

export interface ColdSessionModelSettingsResult {
  modelChanged: boolean;
  thinkingLevelChanged: boolean;
}

export type ColdSessionPageOptions = ColdBrowseHelperPageOptions;

export interface ColdSessionTruncateResult extends ColdSessionManagerHandle {
  restoredModel: boolean;
  restoredThinkingLevel: boolean;
}

export interface ColdSessionStoreFileSystem {
  readFile(sessionPath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  renameSync(sourcePath: string, targetPath: string): void;
  removeFile(filePath: string): Promise<void>;
}

export interface ColdSessionStoreOptions {
  sdk: Pick<SdkModule, 'SessionManager'>;
  coordinatorGeneration: number;
  startupCwd: string;
  agentDir: string;
  sessionDir?: string;
  leaseAuthority?: ColdSessionLeaseAuthority;
  sessionCatalog?: SessionCatalog;
  fileSystem?: Partial<ColdSessionStoreFileSystem>;
  forgetArtifactsDeps?: Omit<ForgetPrivateSessionArtifactsDeps, 'deleteTranscript'>;
  readAttempts?: number;
  browseCacheMaxSourceBytes?: number;
  browseCacheMaxEntries?: number;
  browseHelper?: ColdBrowseHelper;
}

const defaultFileSystem: ColdSessionStoreFileSystem = {
  readFile: async (sessionPath) => await fs.readFile(sessionPath, 'utf8'),
  writeFile: async (filePath, content) => { await fs.writeFile(filePath, content, 'utf8'); },
  renameSync: (sourcePath, targetPath) => fsSync.renameSync(sourcePath, targetPath),
  removeFile: async (filePath) => { await fs.rm(filePath, { force: true }); },
};

interface HandleState {
  status: 'available' | 'installed';
  stamp: ColdSessionOwnershipStamp;
}

interface LoadedBrowseProjection {
  readonly browse: SessionBrowseSnapshot;
  readonly stamp: ColdSessionOwnershipStamp;
}

interface ColdSessionCatalogPublicationStamp {
  readonly coordinatorGeneration: number;
  readonly authorityRevision: number;
  readonly mutationRevision: number;
}

/** Narrow, runtime-free adapter over the SDK SessionManager and Pie's existing
 * browse/catalog/transcript projections. It intentionally has no route or
 * AgentSession ownership. */
export class ColdSessionStore {
  readonly placement = COLD_SESSION_STORE_PLACEMENT;
  readonly leases: ColdSessionLeaseAuthority;

  private readonly sdk: Pick<SdkModule, 'SessionManager'>;
  private readonly startupCwd: string;
  private readonly agentDir: string;
  private readonly sessionDir?: string;
  private readonly catalog: SessionCatalog;
  private readonly fileSystem: ColdSessionStoreFileSystem;
  private readonly forgetArtifactsDeps: Omit<ForgetPrivateSessionArtifactsDeps, 'deleteTranscript'>;
  private readonly readAttempts: number;
  private readonly browseHelper?: ColdBrowseHelper;
  private catalogMutationRevision = 0;
  private readonly resultStamps = new WeakMap<object, readonly ColdSessionOwnershipStamp[]>();
  private readonly catalogPublicationStamps = new WeakMap<object, ColdSessionCatalogPublicationStamp>();
  private readonly handleStates = new WeakMap<ColdSessionManagerHandle, HandleState>();
  private readonly promotionGrants = new Map<string, { grant: SerializedColdSessionPromotionGrant; consumed: boolean }>();
  private readonly browseCache: ColdBrowseProjectionCache<SessionBrowseSnapshot>;
  private readonly browseLoads = new Map<string, Promise<LoadedBrowseProjection>>();
  private browseCacheGeneration: number;

  constructor(options: ColdSessionStoreOptions) {
    this.sdk = options.sdk;
    this.startupCwd = options.startupCwd;
    this.agentDir = options.agentDir;
    this.sessionDir = options.sessionDir;
    this.leases = options.leaseAuthority
      ?? new ColdSessionLeaseAuthority(options.coordinatorGeneration);
    if (this.leases.coordinatorGeneration !== options.coordinatorGeneration) {
      throw new Error('ColdSessionStore and lease authority coordinator generations must match.');
    }
    this.catalog = options.sessionCatalog ?? new SessionCatalog();
    this.fileSystem = { ...defaultFileSystem, ...options.fileSystem };
    this.forgetArtifactsDeps = options.forgetArtifactsDeps ?? {};
    this.readAttempts = options.readAttempts ?? DEFAULT_READ_ATTEMPTS;
    this.browseHelper = options.browseHelper;
    this.browseCache = new ColdBrowseProjectionCache(
      options.browseCacheMaxSourceBytes,
      options.browseCacheMaxEntries,
    );
    this.browseCacheGeneration = this.leases.coordinatorGeneration;
  }

  /** Process-local cache counters for tests and perf attribution. They are not
   * part of the backend RPC contract. */
  getBrowseCacheStats(): ColdBrowseProjectionCacheStats {
    return this.browseCache.snapshotStats(this.browseLoads.size);
  }

  async list(liveSummaries: readonly SessionSummary[] = []): Promise<SessionSummary[]> {
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      const generation = this.leases.coordinatorGeneration;
      const authorityRevision = this.leases.authorityRevision;
      const mutationRevision = this.catalogMutationRevision;
      // SessionCatalog.list owns persistent-index snapshot publication and
      // background inventory reconciliation. An eager inventory walk here
      // would defeat its immediate nonempty-index startup path.
      const sessions = await this.catalog.list(
        this.sdk as SdkModule,
        this.sessionDir,
        liveSummaries,
        this.agentDir,
      );
      if (generation !== this.leases.coordinatorGeneration
        || authorityRevision !== this.leases.authorityRevision
        || mutationRevision !== this.catalogMutationRevision) {
        this.catalog.refresh();
        continue;
      }
      const visibleSessions: SessionSummary[] = [];
      for (const session of sessions) {
        // A reserved path is a session mid-creation (not yet committed). Skip
        // it from the read-only list rather than failing the whole scan, so a
        // concurrent `session.create` no longer makes `emitSessionListChanged`
        // throw `path-reserved` every ~10s and stall the session-list refresh.
        if (this.leases.isPathReserved(session.path)) continue;
        visibleSessions.push(session);
      }
      if (generation !== this.leases.coordinatorGeneration
        || authorityRevision !== this.leases.authorityRevision
        || mutationRevision !== this.catalogMutationRevision) {
        this.catalog.refresh();
        continue;
      }
      // Catalog rows are a revisioned metadata snapshot, not browse payloads.
      // Per-file browse stamps would realpath/stat every row three times across
      // list, return, and writer publication. One O(1) authority/mutation stamp
      // preserves the same forget/create/replacement publication fence without
      // turning a warm SQLite projection back into a filesystem scan.
      this.resultStamps.set(visibleSessions, []);
      this.catalogPublicationStamps.set(visibleSessions, {
        coordinatorGeneration: generation,
        authorityRevision,
        mutationRevision,
      });
      return visibleSessions;
    }
    throw new Error('The session catalog changed repeatedly while it was being read.');
  }

  async openSnapshot(sessionPath: string, options: ColdSessionOpenOptions): Promise<SessionOpenedPayload> {
    const assisted = await this.tryHelperBrowse(sessionPath, async (helper, stamp) => (
      await helper.openSnapshot(stamp, options)
    ));
    if (assisted) {
      this.leases.assertCurrent(assisted.stamp);
      this.stampResult(assisted.result, [assisted.stamp]);
      return assisted.result;
    }
    return await this.withStableBrowse(sessionPath, async (browse, stamp) => {
      const payload = this.buildOpenedPayload(browse, stamp, options);
      this.leases.assertCurrent(stamp);
      return payload;
    });
  }

  async loadPage(
    sessionPath: string,
    direction: TranscriptPageDirection,
    loadedStart?: number,
    loadedEnd?: number,
    options: ColdSessionPageOptions = {
      transport: { kind: 'response', requestId: 'cold-session-store' },
    },
  ): Promise<TranscriptPagePayload> {
    const assisted = await this.tryHelperBrowse(sessionPath, async (helper, stamp) => (
      await helper.loadPage(stamp, direction, loadedStart, loadedEnd, options)
    ));
    if (assisted) {
      this.leases.assertCurrent(assisted.stamp);
      this.stampResult(assisted.result, [assisted.stamp]);
      return assisted.result;
    }
    return await this.withStableBrowse(sessionPath, async (browse, stamp) => {
      const page = buildPagedTranscriptWindow(browse.cache, { direction, loadedStart, loadedEnd });
      const result: TranscriptPagePayload = {
        sessionPath,
        transcript: normalizeDanglingTranscript(page.transcript)
          .map(deduplicateToolCallResultsForTransport),
        transcriptWindow: page.transcriptWindow,
        busy: false,
      };
      this.leases.assertCurrent(stamp);
      this.stampResult(result, [stamp]);
      return result;
    });
  }

  /** Resolve one live detail address against the durable JSONL under the cold
   *  ownership lease. This is the paged-durable authority behind
   *  `detail.subscribe`: the terminal tool result (already written before the
   *  terminal handoff) is addressed by its stable tool-call id and producer
   *  lineage, and the caller segments it into exact pages. The generic bounded
   *  `loadDetail` remains the single-frame path and is unchanged. */
  async resolveDurableDetail(
    sessionPath: string,
    address: LiveSubagentDetailAddress,
    durableRef?: LazyDetailRef,
  ): Promise<ResolvedDurableDetail> {
    return await this.withStableBrowse(sessionPath, async (browse, stamp) => {
      const resolution = resolveDurableDetailFromTranscript(browse.cache.transcript, sessionPath, address, durableRef);
      if (resolution.status === 'not-found') {
        throw new DurableDetailNotFoundError(resolution.message);
      }
      if (resolution.status === 'not-addressable') {
        throw new DurableDetailNotAddressableError(resolution.message);
      }
      this.leases.assertCurrent(stamp);
      return {
        value: resolution.value,
        sizeBytes: resolution.sizeBytes!,
        messageId: resolution.messageId!,
        toolCallId: resolution.toolCallId!,
        kind: 'tool-result' as const,
      };
    });
  }

  async loadDetail(sessionPath: string, ref: LazyDetailRef): Promise<DetailResult> {
    if (ref.source !== 'durable') {
      return {
        sessionPath,
        key: ref.key,
        status: 'unavailable',
        message: 'Live detail is owned by the execution runtime.',
      };
    }
    const assisted = await this.tryHelperBrowse(sessionPath, async (helper, stamp) => (
      await helper.loadDetail(stamp, ref)
    ));
    if (assisted) {
      this.leases.assertCurrent(assisted.stamp);
      this.stampResult(assisted.result, [assisted.stamp]);
      return assisted.result;
    }
    return await this.withStableBrowse(sessionPath, async (browse, stamp) => {
      const found = findDurableDetail(browse.cache.transcript, ref);
      let result: DetailResult;
      if (found.status === 'unavailable') {
        result = { sessionPath, key: ref.key, status: 'unavailable', message: 'The durable detail is no longer available.' };
      } else if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
        result = { sessionPath, key: ref.key, status: 'unavailable', message: 'The detail exceeds the supported retrieval size.' };
      } else if (found.sizeBytes !== ref.sizeBytes) {
        result = { sessionPath, key: ref.key, status: 'stale', message: 'The durable detail changed; refresh the session and retry.' };
      } else {
        result = { sessionPath, key: ref.key, status: 'loaded', value: found.value, sizeBytes: found.sizeBytes };
      }
      this.leases.assertCurrent(stamp);
      this.stampResult(result, [stamp]);
      return result;
    });
  }

  /** The coordinator patch barrier makes SessionManager.create itself the
   * atomic durable-header boundary. Do not fabricate or reopen the file here:
   * the returned manager is the exact one-use handoff manager. */
  create(options: { cwd?: string; sessionDir?: string } = {}): ColdSessionManagerHandle {
    const manager = this.sdk.SessionManager.create(
      options.cwd || this.startupCwd,
      options.sessionDir ?? this.sessionDir,
    );
    this.refreshCatalog();
    return this.createHandle(manager);
  }

  /** Project a newly created/forked/truncated manager without reopening its
   * durable path. The same process-local manager remains available for the
   * one-use promotion handoff. */
  async openHandleSnapshot(
    handle: ColdSessionManagerHandle,
    options: ColdSessionOpenOptions,
  ): Promise<SessionOpenedPayload> {
    const state = this.handleStates.get(handle);
    if (!state || state.status !== 'available' || state.stamp.sessionPathKey !== handle.stamp.sessionPathKey) {
      throw new Error(`Cold session manager handle is no longer available: ${handle.sessionPath}`);
    }
    // Capture one immutable read fence. A concurrent retained-handle settings
    // append restamps `state`, but must not let browse data projected from the
    // pre-append manager state pass validation under that newer stamp.
    const snapshotStamp = state.stamp;
    this.leases.assertCurrent(snapshotStamp);
    const browse = await openSessionBrowseSnapshot({
      manager: handle.manager,
      sessionPath: handle.sessionPath,
      startupCwd: this.startupCwd,
    });
    this.leases.assertCurrent(snapshotStamp);
    const payload = this.buildOpenedPayload(browse, snapshotStamp, options);
    this.leases.assertCurrent(snapshotStamp);
    return payload;
  }

  /** Persist model/reasoning choices for an ordinary cold session without
   * materializing an AgentSession. The SDK append methods preserve Pi's branch
   * parentage and format; the coordinator lease makes each synchronous append
   * share the same single-writer boundary as truncate/promotion. */
  setModelSettings(
    sessionPath: string,
    updates: ColdSessionModelSettingsUpdate,
  ): ColdSessionModelSettingsResult {
    const opened = this.openManagerWithMigrationLease(sessionPath);
    return this.applyModelSettings(opened.manager, opened.stamp, updates).result;
  }

  /** Apply the same durable mutation to a newly-created/forked/truncated
   * manager retained for one-use promotion. Updating its private handle stamp
   * keeps that exact manager usable; reopening the path here would make the
   * retained manager stale and accidentally change a new session into a
   * resume on promotion. */
  setHandleModelSettings(
    handle: ColdSessionManagerHandle,
    updates: ColdSessionModelSettingsUpdate,
  ): ColdSessionModelSettingsResult {
    const state = this.handleStates.get(handle);
    if (!state || state.status !== 'available' || state.stamp.sessionPathKey !== handle.stamp.sessionPathKey) {
      throw new Error(`Cold session manager handle is no longer available: ${handle.sessionPath}`);
    }
    const applied = this.applyModelSettings(
      handle.manager,
      state.stamp,
      updates,
      (stamp) => { state.stamp = stamp; },
    );
    state.stamp = applied.stamp;
    return applied.result;
  }

  /** Opening the source first is required: SessionManager.open performs the
   * supported v1/v2→v3 migration, while forkFrom otherwise copies legacy rows
   * verbatim into a v3 destination. */
  duplicate(
    sourcePath: string,
    options: { targetCwd?: string; sessionDir?: string } = {},
  ): ColdSessionManagerHandle {
    const opened = this.openManagerWithMigrationLease(sourcePath);
    const sourceManager = opened.manager as ColdSdkSessionManager;
    const targetCwd = options.targetCwd || sourceManager.getCwd() || this.startupCwd;
    const forked = this.leases.commitSync(opened.stamp, () => this.sdk.SessionManager.forkFrom(
      sourcePath,
      targetCwd,
      options.sessionDir ?? this.sessionDir,
    ));
    this.refreshCatalog();
    return this.createHandle(forked);
  }

  /** Fence cold ownership and mint a JSON-serializable, one-use promotion
   * grant. The worker reopens through the supported SDK after the coordinator
   * converts this grant into its sole-writer lease. */
  serializePromotionGrant(
    sessionPath: string,
    creationReason: 'new' | 'resume',
  ): SerializedColdSessionPromotionGrant {
    const stamp = this.leases.capture(sessionPath);
    if (stamp.fingerprint === MISSING_FINGERPRINT) throw missingSessionError(sessionPath);
    const grant: SerializedColdSessionPromotionGrant = {
      grantId: crypto.randomUUID(),
      coordinatorGeneration: stamp.coordinatorGeneration,
      sessionPath: stamp.sessionPath,
      sessionPathKey: stamp.sessionPathKey,
      fingerprint: stamp.fingerprint,
      creationReason,
    };
    // This is a reversible reservation, not the handoff itself. Hot ownership
    // fences coordinator writes separately; the grant and any retained manager
    // remain retryable until runtime.ready is acknowledged and consume commits.
    this.promotionGrants.set(grant.grantId, { grant, consumed: false });
    return grant;
  }

  consumePromotionGrant(grant: SerializedColdSessionPromotionGrant): SerializedColdSessionPromotionGrant {
    const state = this.promotionGrants.get(grant.grantId);
    if (!state || state.consumed || state.grant.coordinatorGeneration !== this.leases.coordinatorGeneration
      || state.grant.sessionPathKey !== coldCanonicalPathKey(grant.sessionPath)) {
      throw new Error(`Cold session promotion grant is stale or already consumed: ${grant.sessionPath}`);
    }
    state.consumed = true;
    this.promotionGrants.delete(grant.grantId);
    this.leases.invalidate(grant.sessionPath);
    this.invalidateBrowsePath(grant.sessionPath);
    return { ...state.grant };
  }

  /** Abort an uncommitted promotion without changing cold ownership. Safe and
   * idempotent so every failed bootstrap/readiness path can preserve retry. */
  abortPromotionGrant(grant: SerializedColdSessionPromotionGrant): void {
    const state = this.promotionGrants.get(grant.grantId);
    if (state && !state.consumed) this.promotionGrants.delete(grant.grantId);
  }

  /** Refresh an available retained handle after a tentative hot fence was
   * released. The exact manager and creation reason remain process-local. */
  refreshHandle(handle: ColdSessionManagerHandle): void {
    const state = this.handleStates.get(handle);
    if (!state || state.status !== 'available') return;
    state.stamp = this.leases.capture(handle.sessionPath);
  }

  /** Retire the exact retained manager only after worker runtime readiness. */
  retireHandle(handle: ColdSessionManagerHandle): void {
    const state = this.handleStates.get(handle);
    if (state?.status === 'available') state.status = 'installed';
  }

  /** Install a process-local manager exactly once. Successful installation
   * advances path ownership in the same synchronous turn, invalidating every
   * outstanding cold stamp for the destination. */
  handoff<T>(handle: ColdSessionManagerHandle, install: (manager: SdkSessionManager) => T): T {
    const state = this.handleStates.get(handle);
    if (!state || state.status !== 'available') {
      throw new Error(`Cold session manager handle is no longer available: ${handle.sessionPath}`);
    }
    let installStarted = false;
    try {
      return this.leases.commitSync(state.stamp, () => {
        installStarted = true;
        // Installation may partially commit before throwing. Retire the handle
        // as soon as its callback starts so the same manager can never be
        // installed twice after an ambiguous failure.
        state.status = 'installed';
        return install(handle.manager);
      });
    } finally {
      if (installStarted) {
        this.refreshCatalog();
        this.leases.invalidate(handle.sessionPath);
        this.invalidateBrowsePath(handle.sessionPath);
      }
    }
  }

  async truncateAfter(
    sessionPath: string,
    entryId: string,
    options?: { requireCurrentBranchTarget?: boolean; onCommit?: () => void },
  ): Promise<ColdSessionTruncateResult> {
    const opened = this.openManagerWithMigrationLease(sessionPath);
    if (options?.requireCurrentBranchTarget
      && !opened.manager.getBranch().some((entry) => entry.id === entryId)) {
      throw new BackendError(
        'STALE_BRANCH_TARGET',
        `The edit target is not on the current authoritative branch: ${entryId}`,
      );
    }
    const beforeContext = (opened.manager as ColdSdkSessionManager).buildSessionContext();
    const raw = await this.fileSystem.readFile(sessionPath);
    this.leases.assertCurrent(opened.stamp);

    const keepLines: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { id?: string };
        if (entry.id === entryId) break;
        keepLines.push(line);
      } catch {
        // Preserve the existing truncate behavior: malformed rows are omitted.
      }
    }
    const content = keepLines.length > 0 ? `${keepLines.join('\n')}\n` : '';
    const temporaryPath = path.join(
      path.dirname(sessionPath),
      `.${path.basename(sessionPath)}.${crypto.randomUUID()}.tmp`,
    );
    let committed = false;
    try {
      await this.fileSystem.writeFile(temporaryPath, content);
      this.leases.commitSync(opened.stamp, () => {
        // Test-build append/truncate owner instrumentation: the coordinator's
        // cold truncate commit carries no worker lease identity.
        recordWriteOwnership({
          event: 'pie.write-ownership',
          ts: Date.now(),
          pid: process.pid,
          seam: 'cold.truncateAfter',
          sessionPath,
          ownerRole: 'coordinator',
        });
        this.fileSystem.renameSync(temporaryPath, sessionPath);
        committed = true;
        // The rename is the destructive commit point. Record it in the
        // generation ledger in this same synchronous ownership turn so no
        // post-rename failure can be misclassified as pre-commit.
        options?.onCommit?.();
      });
      this.invalidateBrowsePath(sessionPath);
      this.refreshCatalog();
    } finally {
      if (!committed) await this.fileSystem.removeFile(temporaryPath).catch(() => undefined);
    }

    let stamp = this.leases.restamp(opened.stamp);
    const replacement = this.leases.commitSync(stamp, () => this.sdk.SessionManager.open(sessionPath));
    stamp = this.leases.restamp(stamp);
    const coldManager = replacement as ColdSdkSessionManager;
    const afterContext = coldManager.buildSessionContext();

    const previousModel = beforeContext.model;
    const shouldRestoreModel = previousModel !== null
      && (afterContext.model?.provider !== previousModel.provider
        || afterContext.model?.modelId !== previousModel.modelId);
    const shouldRestoreThinkingLevel = !!beforeContext.thinkingLevel
      && afterContext.thinkingLevel !== beforeContext.thinkingLevel;
    let restoredModel = false;
    let restoredThinkingLevel = false;
    if ((shouldRestoreModel || shouldRestoreThinkingLevel)
      && typeof coldManager.appendPieModelSettingsChange === 'function') {
      try {
        this.leases.commitSync(stamp, () => appendColdModelSettingsWithAtomicReplaceRetry(
          coldManager,
          shouldRestoreModel ? previousModel.provider : undefined,
          shouldRestoreModel ? previousModel.modelId : undefined,
          shouldRestoreThinkingLevel ? beforeContext.thinkingLevel : undefined,
        ));
        stamp = this.leases.restamp(stamp);
        restoredModel = shouldRestoreModel;
        restoredThinkingLevel = shouldRestoreThinkingLevel;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) throw error;
        // The durable truncate already committed. Preserve the prior
        // best-effort restoration contract rather than reporting the rewrite
        // as failed, but never expose a partially restored model/reasoning
        // pair: the SDK seam publishes both or neither.
      }
    }

    return this.createHandle(replacement, stamp, { restoredModel, restoredThinkingLevel });
  }

  async forget(sessionPath: string): Promise<void> {
    const stamp = this.leases.capture(sessionPath);
    await forgetPrivateSessionArtifacts(sessionPath, {
      ...this.forgetArtifactsDeps,
      deleteTranscript: async (targetPath) => {
        this.leases.commitSync(stamp, () => fsSync.rmSync(targetPath, { force: true }));
      },
    });
    this.catalog.remove(sessionPath);
    this.catalogMutationRevision += 1;
    this.leases.invalidate(sessionPath);
    // Privacy-sensitive forget eagerly drops any durable projection rather
    // than relying only on the now-unreachable fingerprint/revision key.
    // Preserve the exact pre-delete canonical identity. Re-canonicalizing a
    // removed symlink/path can produce a different key and strand private cache
    // bytes under the old durable identity.
    const sessionPathKey = stamp.sessionPathKey;
    this.browseCache.invalidatePath(sessionPathKey);
    // The local privacy/ownership fences above already make every helper entry
    // unreachable. Reclaim helper memory opportunistically without queuing this
    // user action behind an in-flight multi-second projection.
    void this.browseHelper?.invalidatePath(sessionPathKey).catch(() => undefined);
  }

  tree(sessionPath: string): ColdSessionTreeNode[] {
    const opened = this.openManagerWithMigrationLease(sessionPath);
    const tree = (opened.manager as ColdSdkSessionManager).getTree();
    this.leases.assertCurrent(opened.stamp);
    this.stampResult(tree, [opened.stamp]);
    return tree;
  }

  context(sessionPath: string): ColdSessionContext {
    const opened = this.openManagerWithMigrationLease(sessionPath);
    const context = (opened.manager as ColdSdkSessionManager).buildSessionContext();
    this.leases.assertCurrent(opened.stamp);
    this.stampResult(context, [opened.stamp]);
    return context;
  }

  /** Recheck a stamped payload at the actual synchronous writer/publication
   * boundary without wrapping or changing its existing public shape. */
  publishSync<T>(result: T, publish: () => void): T {
    if (result && typeof result === 'object') {
      const catalogStamp = this.catalogPublicationStamps.get(result as object);
      if (catalogStamp) this.assertCatalogPublicationCurrent(catalogStamp);
      for (const stamp of this.resultStamps.get(result as object) ?? []) {
        this.leases.assertCurrent(stamp);
      }
    }
    publish();
    return result;
  }

  ownershipStamp(result: object): readonly ColdSessionOwnershipStamp[] | undefined {
    return this.resultStamps.get(result);
  }

  transferOwnershipStamp(source: object, target: object): void {
    const stamps = this.resultStamps.get(source);
    if (stamps) this.resultStamps.set(target, stamps);
    const catalogStamp = this.catalogPublicationStamps.get(source);
    if (catalogStamp) this.catalogPublicationStamps.set(target, catalogStamp);
  }

  private assertCatalogPublicationCurrent(stamp: ColdSessionCatalogPublicationStamp): void {
    const generationChanged = stamp.coordinatorGeneration !== this.leases.coordinatorGeneration;
    const authorityChanged = stamp.authorityRevision !== this.leases.authorityRevision;
    const mutationChanged = stamp.mutationRevision !== this.catalogMutationRevision;
    if (!generationChanged && !authorityChanged && !mutationChanged) return;
    // Reuse the established stale-publication error contract so event and RPC
    // writers rebuild the catalog through their existing retry paths. The
    // synthetic path is diagnostic only; catalog validity is process-wide.
    throw new StaleColdSessionLeaseError(
      generationChanged ? 'coordinator-generation' : 'ownership-revision',
      {
        coordinatorGeneration: stamp.coordinatorGeneration,
        sessionPath: '<session-catalog>',
        sessionPathKey: '<session-catalog>',
        ownershipRevision: stamp.authorityRevision,
        fingerprint: String(stamp.mutationRevision),
      },
    );
  }

  private buildOpenedPayload(
    browse: SessionBrowseSnapshot,
    stamp: ColdSessionOwnershipStamp,
    options: ColdSessionOpenOptions,
  ): SessionOpenedPayload {
    const payload = buildBrowseSessionOpenedPayload({
      browse,
      modelSettings: options.modelSettings,
      availableModels: options.availableModels,
      selectionToken: options.selectionToken,
      operationId: options.operationId,
      operationAttempt: options.operationAttempt,
      transcript: options.transcript,
      transport: options.transport,
      systemPromptDisabledEntries: options.systemPromptDisabledEntries,
    });
    this.stampResult(payload, [stamp]);
    return payload;
  }

  /** Offload only a header-verified current v3 read. The coordinator owns both
   * sides of the asynchronous lease: it ties the cheap header to fingerprint A
   * before dispatch and rechecks generation, ownership revision, canonical
   * path, and fingerprint immediately after the bounded result returns. */
  private async tryHelperBrowse<T extends object>(
    sessionPath: string,
    operation: (helper: ColdBrowseHelper, stamp: ColdSessionOwnershipStamp) => Promise<T>,
  ): Promise<{ result: T; stamp: ColdSessionOwnershipStamp } | undefined> {
    if (!this.browseHelper) return undefined;
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      const stamp = this.leases.capture(sessionPath);
      if (stamp.fingerprint === MISSING_FINGERPRINT) throw missingSessionError(sessionPath);
      const header = readColdSessionHeaderSync(sessionPath);
      this.leases.assertCurrent(stamp);
      // SessionManager.open owns v1/v2 migration and the empty/malformed-file
      // behavior. Those semantics may write or synthesize state, so the
      // read-only helper must never observe them.
      if (!isCurrentColdSessionHeader(header)) return undefined;
      try {
        const result = await operation(this.browseHelper, stamp);
        this.leases.assertCurrent(stamp);
        return { result, stamp };
      } catch (error) {
        if (error instanceof SessionSnapshotTooLargeError) {
          // The client accepted this typed producer error only after matching
          // the helper response to this exact fingerprint. Recheck the Pie
          // ownership lease at the coordinator boundary, then preserve its
          // stable code/data instead of synchronously reopening the file.
          this.leases.assertCurrent(stamp);
          throw error;
        }
        if (error instanceof ColdBrowseHelperRequestError
          && error.code === 'FINGERPRINT_CHANGED'
          && error.fingerprint === stamp.fingerprint) {
          // The client accepts this signal only when the helper correlated it
          // to this exact request fence. Preserve ownership/generation errors,
          // but treat either a changed durable image or a changed-then-restored
          // image as a helper retry instead of paying the synchronous SDK-open
          // fallback cost on the coordinator event loop.
          try {
            this.leases.assertCurrent(stamp);
          } catch (leaseError) {
            if (!(leaseError instanceof StaleColdSessionLeaseError)
              || leaseError.reason !== 'fingerprint') {
              throw leaseError;
            }
          }
          continue;
        }
        if (error instanceof StaleColdSessionLeaseError) {
          if (error.reason === 'fingerprint') continue;
          throw error;
        }
        // Helper startup, validation, protocol, crash, and projection errors
        // all preserve UX correctness through the existing synchronous SDK
        // path. The persistent client may restart lazily on a later miss.
        return undefined;
      }
    }
    return undefined;
  }

  private async withStableBrowse<T>(
    sessionPath: string,
    project: (browse: SessionBrowseSnapshot, stamp: ColdSessionOwnershipStamp) => Promise<T> | T,
  ): Promise<T> {
    let lastFingerprintError: StaleColdSessionLeaseError | undefined;
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      try {
        const loaded = await this.getBrowseProjection(sessionPath);
        this.leases.assertCurrent(loaded.stamp);
        return await project(loaded.browse, loaded.stamp);
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError && error.reason === 'fingerprint') {
          lastFingerprintError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastFingerprintError
      ?? new Error(`The session changed repeatedly while it was being read: ${sessionPath}`);
  }

  private async getBrowseProjection(sessionPath: string): Promise<LoadedBrowseProjection> {
    this.resetBrowseCacheForGeneration();
    const initialStamp = this.leases.capture(sessionPath);
    if (initialStamp.fingerprint === MISSING_FINGERPRINT) throw missingSessionError(sessionPath);
    const cacheKey = coldBrowseCacheKey(initialStamp);
    // A new fingerprint or ownership revision makes every older projection for
    // the canonical path unreachable. Reclaim it eagerly before lookup.
    this.browseCache.invalidatePath(initialStamp.sessionPathKey, cacheKey);
    const cached = this.browseCache.get(cacheKey);
    if (cached) {
      // Final synchronous fence immediately before the hit is exposed.
      this.leases.assertCurrent(initialStamp);
      return { browse: cached, stamp: initialStamp };
    }

    const flightKey = coldBrowseSingleflightKey(initialStamp);
    const existing = this.browseLoads.get(flightKey);
    if (existing) {
      this.browseCache.recordInflightJoin();
      const joined = await existing;
      // Every waiter rechecks the exact resulting fingerprint/revision rather
      // than trusting the first caller's insertion fence.
      this.leases.assertCurrent(joined.stamp);
      return joined;
    }

    this.browseCache.recordMiss();
    // Register the flight before SDK open/transcript mapping begins. Besides
    // ordinary concurrent RPCs, this also closes a synchronous re-entrancy
    // window through test/SDK seams.
    const loading = Promise.resolve().then(async () => await this.loadBrowseProjection(sessionPath));
    this.browseLoads.set(flightKey, loading);
    try {
      const loaded = await loading;
      this.leases.assertCurrent(loaded.stamp);
      return loaded;
    } finally {
      if (this.browseLoads.get(flightKey) === loading) this.browseLoads.delete(flightKey);
    }
  }

  private async loadBrowseProjection(sessionPath: string): Promise<LoadedBrowseProjection> {
    const opened = this.openManagerWithMigrationLease(sessionPath);
    const browse = await openSessionBrowseSnapshot({
      manager: opened.manager,
      sessionPath,
      startupCwd: this.startupCwd,
    });
    const cacheKey = coldBrowseCacheKey(opened.stamp);
    const sourceBytes = coldSourceBytes(opened.stamp.fingerprint, browse);
    // No await or callback may separate this final exact durable fence from
    // miss insertion.
    this.browseCache.invalidatePath(opened.stamp.sessionPathKey, cacheKey);
    this.leases.assertCurrent(opened.stamp);
    this.browseCache.set({
      key: cacheKey,
      sessionPathKey: opened.stamp.sessionPathKey,
      value: browse,
      sourceBytes,
    });
    return { browse, stamp: opened.stamp };
  }

  private resetBrowseCacheForGeneration(): void {
    const generation = this.leases.coordinatorGeneration;
    if (generation === this.browseCacheGeneration) return;
    this.browseCache.clear();
    this.browseCacheGeneration = generation;
  }

  private invalidateBrowsePath(sessionPath: string): void {
    const sessionPathKey = coldCanonicalPathKey(sessionPath);
    this.browseCache.invalidatePath(sessionPathKey);
    // Ownership/fingerprint fencing already makes the entry unreachable. This
    // notification is prompt memory reclamation in the helper and cannot be a
    // synchronous precondition for coordinator ownership transitions.
    void this.browseHelper?.invalidatePath(sessionPathKey).catch(() => undefined);
  }

  private openManagerWithMigrationLease(sessionPath: string): ColdSessionManagerHandle {
    const before = this.leases.capture(sessionPath);
    if (before.fingerprint === MISSING_FINGERPRINT) throw missingSessionError(sessionPath);
    const originalHeader = readColdSessionHeaderSync(sessionPath);
    // Tie the cheap header observation to fingerprint A before the SDK seam.
    this.leases.assertCurrent(before);
    const manager = this.leases.commitSync(before, () => this.sdk.SessionManager.open(sessionPath));
    try {
      // Current v3 opens are read-only and must retain exact fingerprint A.
      this.leases.assertCurrent(before);
      return { sessionPath, manager, stamp: before };
    } catch (error) {
      if (!(error instanceof StaleColdSessionLeaseError) || error.reason !== 'fingerprint') throw error;
      if (!isLegacyColdSessionHeader(originalHeader)) throw error;

      // A supported one-time v1/v2→v3 migration is the only accepted
      // fingerprint movement across SessionManager.open. Capture fingerprint B,
      // prove the manager exactly represents B's current parsed JSONL, then
      // require B to remain current at C before accepting it.
      const migratedStamp = this.leases.restamp(before);
      if (!managerMatchesCurrentDurableSession(manager, sessionPath)) throw error;
      this.leases.assertCurrent(migratedStamp);
      return { sessionPath, manager, stamp: migratedStamp };
    }
  }

  private createHandle(
    manager: SdkSessionManager,
    stamp: ColdSessionOwnershipStamp,
    restoration: { restoredModel: boolean; restoredThinkingLevel: boolean },
  ): ColdSessionTruncateResult;
  private createHandle(
    manager: SdkSessionManager,
    stamp?: ColdSessionOwnershipStamp,
  ): ColdSessionManagerHandle;
  private createHandle(
    manager: SdkSessionManager,
    stamp?: ColdSessionOwnershipStamp,
    restoration?: { restoredModel: boolean; restoredThinkingLevel: boolean },
  ): ColdSessionManagerHandle | ColdSessionTruncateResult {
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error('The SDK session manager did not allocate a process-local session path.');
    const handleStamp = stamp ?? this.leases.capture(sessionPath);
    const handle = restoration
      ? { sessionPath, manager, stamp: handleStamp, ...restoration }
      : { sessionPath, manager, stamp: handleStamp };
    this.handleStates.set(handle, { status: 'available', stamp: handleStamp });
    return handle;
  }

  private refreshCatalog(): void {
    this.catalogMutationRevision += 1;
    this.catalog.refresh();
  }

  private applyModelSettings(
    manager: SdkSessionManager,
    initialStamp: ColdSessionOwnershipStamp,
    updates: ColdSessionModelSettingsUpdate,
    onRestamp?: (stamp: ColdSessionOwnershipStamp) => void,
  ): {
    result: ColdSessionModelSettingsResult;
    stamp: ColdSessionOwnershipStamp;
  } {
    const coldManager = manager as ColdSdkSessionManager;
    const before = coldManager.buildSessionContext();
    let stamp = initialStamp;
    const modelChanged = updates.model !== undefined
      && (before.model?.provider !== updates.model.provider
        || before.model?.modelId !== updates.model.modelId);
    const thinkingLevelChanged = updates.thinkingLevel !== undefined
      && before.thinkingLevel !== updates.thinkingLevel;
    let committed = false;

    try {
      if (modelChanged || thinkingLevelChanged) {
        if (typeof coldManager.appendPieModelSettingsChange !== 'function') {
          throw new Error('This Pi session manager does not support atomic durable model settings.');
        }
        // Model + reasoning is one user intent. Publish both canonical Pi
        // entries through the SDK's crash-safe batch seam under one ownership
        // fence, then advance the durable fingerprint exactly once. This also
        // keeps a retained create/fork handle promotable without reopening it.
        this.leases.commitSync(stamp, () => appendColdModelSettingsWithAtomicReplaceRetry(
          coldManager,
          modelChanged ? updates.model!.provider : undefined,
          modelChanged ? updates.model!.modelId : undefined,
          thinkingLevelChanged ? updates.thinkingLevel : undefined,
        ));
        committed = true;
        stamp = this.leases.restamp(stamp);
        onRestamp?.(stamp);
      }

      this.leases.assertCurrent(stamp);
      return {
        result: { modelChanged, thinkingLevelChanged },
        stamp,
      };
    } finally {
      if (committed) {
        // A cached browse projection represents the pre-append fingerprint.
        // Retire it eagerly so the host's post-write hydration cannot publish
        // the old model over its optimistic selection.
        this.invalidateBrowsePath(initialStamp.sessionPath);
        this.refreshCatalog();
      }
    }
  }

  private stampResult(result: object, stamps: readonly ColdSessionOwnershipStamp[]): void {
    this.resultStamps.set(result, stamps);
  }
}

function appendColdModelSettingsWithAtomicReplaceRetry(
  manager: ColdSdkSessionManager,
  provider: string | undefined,
  modelId: string | undefined,
  thinkingLevel: string | undefined,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      manager.appendPieModelSettingsChange!(provider, modelId, thinkingLevel);
      return;
    } catch (error) {
      const delayMs = ATOMIC_REPLACE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientAtomicReplaceError(error)) throw error;
      // Windows can transiently deny replacement while an asynchronous stat or
      // scanner still holds the destination. The SDK has not crossed its rename
      // commit point in this case, so retrying the complete staged append is safe.
      Atomics.wait(ATOMIC_REPLACE_RETRY_WAIT, 0, 0, delayMs);
    }
  }
}

function isTransientAtomicReplaceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const filesystemError = error as NodeJS.ErrnoException;
  return filesystemError.syscall === 'rename'
    && (filesystemError.code === 'EPERM'
      || filesystemError.code === 'EACCES'
      || filesystemError.code === 'EBUSY');
}

function missingSessionError(sessionPath: string): NodeJS.ErrnoException {
  const error = new Error(`Session file does not exist: ${sessionPath}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function coldCanonicalPathKey(sessionPath: string): string {
  const absolute = path.resolve(sessionPath);
  let canonicalPath: string;
  try {
    canonicalPath = fsSync.realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const missingSegments: string[] = [];
    let existingAncestor = absolute;
    while (true) {
      missingSegments.unshift(path.basename(existingAncestor));
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        canonicalPath = path.join(parent, ...missingSegments);
        break;
      }
      existingAncestor = parent;
      try {
        canonicalPath = path.join(fsSync.realpathSync.native(existingAncestor), ...missingSegments);
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') throw ancestorError;
      }
    }
  }
  return backendSessionPathKey(canonicalPath);
}

function coldReservationBasenameKey(sessionPath: string): string {
  const basename = path.basename(path.resolve(sessionPath));
  return process.platform === 'win32' ? basename.toLowerCase() : basename;
}

function coldBrowseCacheKey(stamp: ColdSessionOwnershipStamp): string {
  return JSON.stringify([
    stamp.sessionPathKey,
    stamp.coordinatorGeneration,
    stamp.ownershipRevision,
    stamp.fingerprint,
  ]);
}

/** Single-flight follows canonical ownership. Fingerprint changes during a
 * supported SDK migration still share the same physical projection build; all
 * waiters fence the resulting exact fingerprint before using it. */
function coldBrowseSingleflightKey(stamp: ColdSessionOwnershipStamp): string {
  return JSON.stringify([
    stamp.sessionPathKey,
    stamp.coordinatorGeneration,
    stamp.ownershipRevision,
  ]);
}

function coldSourceBytes(fingerprint: string, browse: SessionBrowseSnapshot): number {
  // The production fingerprint is dev:ino:size:mtimeNs:ctimeNs. Read the size
  // from that exact stat observation so cache weighting cannot race a second
  // file stat after the final durable fence.
  const fields = fingerprint.split(':');
  const rawSize = fields.at(-3);
  if (rawSize && /^\d+$/.test(rawSize)) {
    const sourceBytes = Number(rawSize);
    if (Number.isSafeInteger(sourceBytes) && sourceBytes >= 0) return sourceBytes;
  }
  // Custom test fingerprint authorities may not encode source size. Their
  // projections are small; serialize only in that non-production fallback.
  return Buffer.byteLength(JSON.stringify(browse), 'utf8');
}

interface ColdSessionHeaderEvidence {
  readonly type?: unknown;
  readonly version?: unknown;
}

function readColdSessionHeaderSync(sessionPath: string): ColdSessionHeaderEvidence | undefined {
  const descriptor = fsSync.openSync(sessionPath, 'r');
  const chunk = Buffer.allocUnsafe(4096);
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let totalBytes = 0;
  try {
    while (totalBytes < 1024 * 1024) {
      const bytesRead = fsSync.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        buffered += decoder.end();
        break;
      }
      totalBytes += bytesRead;
      buffered += decoder.write(chunk.subarray(0, bytesRead));
      const newline = buffered.indexOf('\n');
      if (newline >= 0) buffered = buffered.slice(0, newline);
      if (newline >= 0) break;
    }
  } finally {
    fsSync.closeSync(descriptor);
  }
  const line = buffered.trim();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as ColdSessionHeaderEvidence;
  } catch {
    return undefined;
  }
}

function isLegacyColdSessionHeader(header: ColdSessionHeaderEvidence | undefined): boolean {
  return header?.type === 'session'
    && (header.version === undefined || header.version === 1 || header.version === 2);
}

function isCurrentColdSessionHeader(header: ColdSessionHeaderEvidence | undefined): boolean {
  return header?.type === 'session' && header.version === 3;
}

function managerMatchesCurrentDurableSession(manager: SdkSessionManager, sessionPath: string): boolean {
  if (typeof manager.getHeader !== 'function' || typeof manager.getEntries !== 'function') return false;
  try {
    const durableRows = fsSync.readFileSync(sessionPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const durableHeader = durableRows[0];
    if (!durableHeader || durableHeader.type !== 'session' || durableHeader.version !== 3) return false;
    // Normalize SDK-owned objects through their durable JSON representation so
    // absent properties and object prototypes cannot create false mismatches.
    const managerHeader = JSON.parse(JSON.stringify(manager.getHeader()));
    const managerEntries = JSON.parse(JSON.stringify(manager.getEntries()));
    return isDeepStrictEqual(managerHeader, durableHeader)
      && isDeepStrictEqual(managerEntries, durableRows.slice(1));
  } catch {
    return false;
  }
}
