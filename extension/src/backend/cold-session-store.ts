import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  TranscriptMode,
  TranscriptPageDirection,
  TranscriptPagePayload,
} from '../shared/protocol';
import type { LiveSubagentDetailAddress } from '../shared/protocol/subagent-detail';
import type { SessionSnapshotTransport } from '../shared/transcript-window';
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
import type { SdkModule, SdkSessionManager } from './sdk';
import { normalizeDanglingTranscript } from './session-opened';
import { buildPagedTranscriptWindow } from './transcript-window';
import type { SessionEntryLike } from './transcript';

/** Cold session operations stay in the coordinator until measurements show a
 * helper process is necessary. This value is intentionally explicit so the
 * selected Phase 3 placement is testable and cannot silently drift. */
export const COLD_SESSION_STORE_PLACEMENT = 'coordinator-in-process' as const;

const MISSING_FINGERPRINT = 'missing';
const DEFAULT_READ_ATTEMPTS = 3;

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
  appendModelChange?: (provider: string, modelId: string) => string;
  appendThinkingLevelChange?: (thinkingLevel: string) => string;
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
}

/** Coordinator-local lease authority. Capturing a stamp is cheap and does not
 * exclude concurrent cold reads. Promotion, replacement, forget, or any other
 * ownership transition calls invalidate(path); all existing work then fails
 * its synchronous publication/commit check. Replacement reservations use this
 * same authority so a reserved path cannot mint or commit a cold stamp. */
export class ColdSessionLeaseAuthority {
  private readonly ownershipRevisions = new Map<string, number>();
  private readonly pathReservations = new Map<string, ColdSessionPathReservationState>();
  private currentCoordinatorGeneration: number;
  private currentAuthorityRevision = 0;
  private readonly fingerprint: (sessionPath: string) => string;

  constructor(coordinatorGeneration: number, options: ColdSessionLeaseAuthorityOptions = {}) {
    if (!Number.isSafeInteger(coordinatorGeneration) || coordinatorGeneration < 0) {
      throw new Error('coordinatorGeneration must be a non-negative safe integer.');
    }
    this.currentCoordinatorGeneration = coordinatorGeneration;
    this.fingerprint = options.fingerprint ?? readColdSessionFingerprintSync;
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
    const sessionPathKey = coldCanonicalPathKey(sessionPath);
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

  /** Atomically reserve canonical paths in sorted key order. Validation happens
   * before mutation, and rollback/release uses the same deterministic order. */
  reserveCanonicalPaths(
    canonicalPaths: readonly string[],
    reservationId: string,
  ): readonly ColdSessionPathReservationToken[] {
    if (!reservationId) throw new Error('Cold path reservation requires an identity.');
    const ordered = [...new Map(canonicalPaths.map((canonicalPath) => [
      coldCanonicalPathKey(canonicalPath),
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
    const tokens = ordered.map(([sessionPathKey, canonicalPath]) => {
      const nonce = crypto.randomUUID();
      this.pathReservations.set(sessionPathKey, { reservationId, canonicalPath, nonce });
      this.bumpOwnershipRevision(sessionPathKey);
      return { reservationId, canonicalPath, sessionPathKey, nonce };
    });
    return tokens;
  }

  releaseCanonicalPaths(tokens: readonly ColdSessionPathReservationToken[]): void {
    const ordered = [...tokens].sort((left, right) => left.sessionPathKey.localeCompare(right.sessionPathKey));
    for (const token of ordered) {
      const current = this.pathReservations.get(token.sessionPathKey);
      if (!current || current.reservationId !== token.reservationId || current.nonce !== token.nonce) {
        throw new Error(`Cold path reservation is stale: ${token.canonicalPath}`);
      }
    }
    for (const token of ordered) {
      this.pathReservations.delete(token.sessionPathKey);
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
    return this.bumpOwnershipRevision(coldCanonicalPathKey(sessionPath));
  }

  /** Retire every stamp from an old coordinator generation. */
  advanceCoordinatorGeneration(nextGeneration: number): void {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.currentCoordinatorGeneration) {
      throw new Error('The coordinator generation must increase.');
    }
    this.currentCoordinatorGeneration = nextGeneration;
    this.ownershipRevisions.clear();
    this.pathReservations.clear();
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
    if (coldCanonicalPathKey(stamp.sessionPath) !== stamp.sessionPathKey) {
      throw new StaleColdSessionLeaseError('session-path', stamp);
    }
    if ((this.ownershipRevisions.get(stamp.sessionPathKey) ?? 0) !== stamp.ownershipRevision) {
      throw new StaleColdSessionLeaseError('ownership-revision', stamp);
    }
    if (this.pathReservations.has(stamp.sessionPathKey)) {
      throw new StaleColdSessionLeaseError('path-reserved', stamp);
    }
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
}

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

/** Narrow, runtime-free adapter over the SDK SessionManager and Pie's existing
 * browse/catalog/transcript projections. It intentionally has no route or
 * AgentSession ownership; Phase 3 callers can adopt it incrementally. */
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
  private catalogMutationRevision = 0;
  private readonly resultStamps = new WeakMap<object, readonly ColdSessionOwnershipStamp[]>();
  private readonly handleStates = new WeakMap<ColdSessionManagerHandle, HandleState>();
  private readonly promotionGrants = new Map<string, { grant: SerializedColdSessionPromotionGrant; consumed: boolean }>();

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
  }

  async list(liveSummaries: readonly SessionSummary[] = []): Promise<SessionSummary[]> {
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      const generation = this.leases.coordinatorGeneration;
      const authorityRevision = this.leases.authorityRevision;
      const mutationRevision = this.catalogMutationRevision;
      await this.catalog.invalidateIfInventoryChanged(this.agentDir, this.sessionDir);
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
      const stamps = sessions.map((session) => this.leases.capture(session.path));
      if (generation !== this.leases.coordinatorGeneration
        || authorityRevision !== this.leases.authorityRevision
        || mutationRevision !== this.catalogMutationRevision) {
        this.catalog.refresh();
        continue;
      }
      for (const stamp of stamps) this.leases.assertCurrent(stamp);
      this.stampResult(sessions, stamps);
      return sessions;
    }
    throw new Error('The session catalog changed repeatedly while it was being read.');
  }

  async openSnapshot(sessionPath: string, options: ColdSessionOpenOptions): Promise<SessionOpenedPayload> {
    return await this.withStableBrowse(sessionPath, options.availableModels ?? [], async (browse, stamp) => {
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
  ): Promise<TranscriptPagePayload> {
    return await this.withStableBrowse(sessionPath, [], async (browse, stamp) => {
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
   *  ownership lease. This is the paged-durable authority behind Phase 5
   *  `detail.subscribe`: the terminal tool result (already written before the
   *  terminal handoff) is addressed by its stable tool-call id and producer
   *  lineage, and the caller segments it into exact pages. The generic bounded
   *  `loadDetail` remains the single-frame path and is unchanged. */
  async resolveDurableDetail(
    sessionPath: string,
    address: LiveSubagentDetailAddress,
    durableRef?: LazyDetailRef,
  ): Promise<ResolvedDurableDetail> {
    return await this.withStableBrowse(sessionPath, [], async (browse, stamp) => {
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
    return await this.withStableBrowse(sessionPath, [], async (browse, stamp) => {
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
    this.leases.assertCurrent(state.stamp);
    const browse = await openSessionBrowseSnapshot({
      manager: handle.manager,
      sessionPath: handle.sessionPath,
      startupCwd: this.startupCwd,
      availableModels: options.availableModels ?? [],
    });
    this.leases.assertCurrent(state.stamp);
    const payload = this.buildOpenedPayload(browse, state.stamp, options);
    this.leases.assertCurrent(state.stamp);
    return payload;
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
      }
    }
  }

  async truncateAfter(sessionPath: string, entryId: string): Promise<ColdSessionTruncateResult> {
    const opened = this.openManagerWithMigrationLease(sessionPath);
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
      });
      committed = true;
      this.refreshCatalog();
    } finally {
      if (!committed) await this.fileSystem.removeFile(temporaryPath).catch(() => undefined);
    }

    let stamp = this.leases.restamp(opened.stamp);
    const replacement = this.leases.commitSync(stamp, () => this.sdk.SessionManager.open(sessionPath));
    stamp = this.leases.restamp(stamp);
    const coldManager = replacement as ColdSdkSessionManager;
    const afterContext = coldManager.buildSessionContext();

    let restoredModel = false;
    const previousModel = beforeContext.model;
    if (previousModel
      && (afterContext.model?.provider !== previousModel.provider
        || afterContext.model?.modelId !== previousModel.modelId)
      && typeof coldManager.appendModelChange === 'function') {
      try {
        this.leases.commitSync(stamp, () => coldManager.appendModelChange?.(
          previousModel.provider,
          previousModel.modelId,
        ));
        stamp = this.leases.restamp(stamp);
        restoredModel = true;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) throw error;
        // The durable truncate already committed. Preserve the prior best-effort
        // restoration contract rather than reporting the rewrite as failed.
      }
    }

    let restoredThinkingLevel = false;
    if (beforeContext.thinkingLevel
      && afterContext.thinkingLevel !== beforeContext.thinkingLevel
      && typeof coldManager.appendThinkingLevelChange === 'function') {
      try {
        this.leases.commitSync(stamp, () => coldManager.appendThinkingLevelChange?.(
          beforeContext.thinkingLevel,
        ));
        stamp = this.leases.restamp(stamp);
        restoredThinkingLevel = true;
      } catch (error) {
        if (error instanceof StaleColdSessionLeaseError) throw error;
        // See model restoration above.
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
    });
    this.stampResult(payload, [stamp]);
    return payload;
  }

  private async withStableBrowse<T>(
    sessionPath: string,
    availableModels: readonly ModelInfo[],
    project: (browse: SessionBrowseSnapshot, stamp: ColdSessionOwnershipStamp) => Promise<T> | T,
  ): Promise<T> {
    let lastFingerprintError: StaleColdSessionLeaseError | undefined;
    for (let attempt = 0; attempt < this.readAttempts; attempt += 1) {
      const opened = this.openManagerWithMigrationLease(sessionPath);
      try {
        const browse = await openSessionBrowseSnapshot({
          manager: opened.manager,
          sessionPath,
          startupCwd: this.startupCwd,
          availableModels,
        });
        this.leases.assertCurrent(opened.stamp);
        return await project(browse, opened.stamp);
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

  private openManagerWithMigrationLease(sessionPath: string): ColdSessionManagerHandle {
    const before = this.leases.capture(sessionPath);
    if (before.fingerprint === MISSING_FINGERPRINT) throw missingSessionError(sessionPath);
    const manager = this.leases.commitSync(before, () => this.sdk.SessionManager.open(sessionPath));
    // open() may have synchronously migrated v1/v2 and atomically changed the
    // fingerprint. Restamp without crossing an ownership revision.
    const stamp = this.leases.restamp(before);
    return { sessionPath, manager, stamp };
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

  private stampResult(result: object, stamps: readonly ColdSessionOwnershipStamp[]): void {
    this.resultStamps.set(result, stamps);
  }
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

function readColdSessionFingerprintSync(sessionPath: string): string {
  try {
    const stat = fsSync.statSync(sessionPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MISSING_FINGERPRINT;
    throw error;
  }
}
