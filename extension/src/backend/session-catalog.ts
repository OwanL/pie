import { toErrorMessage } from '../shared/error-message';
import type { SessionCatalogProgress, SessionSummary } from '../shared/protocol';
import {
  backendSessionFingerprintsEqual,
  backendSessionPathKey,
  readBackendSessionInventory,
  readBackendSessionInventorySignature,
  type BackendSessionFileFingerprint,
} from './session-directory';
import {
  resolveSessionIndexAuthority,
  resolveSessionIndexPath,
  isSessionIndexBusyError,
  SessionIndexStore,
} from './session-index-store';
import {
  applySessionReviews,
  discoverSessionSummaries,
  readIndexedSessionMetadata,
  type IndexedSessionMetadata,
  type SessionMetadataReadResult,
} from './session-metadata';
import { backendTrace } from './log';
import type { SdkModule } from './sdk';

type SessionIndexStoreFactory = (indexPath: string, authorityKey: string) => SessionIndexStore;
type IndexedMetadataReader = (
  file: BackendSessionFileFingerprint,
  previous?: IndexedSessionMetadata,
) => Promise<SessionMetadataReadResult>;

const INDEX_OPEN_RETRY_BASE_MS = 250;
const INDEX_OPEN_RETRY_MAX_MS = 30_000;
const INDEX_DELETE_RETRY_BASE_MS = 50;
const INDEX_DELETE_RETRY_MAX_MS = 2_000;
const FIRST_BOOTSTRAP_MAX_FILES = 24;
const FIRST_BOOTSTRAP_MAX_BYTES = 16 * 1024 * 1024;
const BACKGROUND_BATCH_MAX_FILES = 128;
const BACKGROUND_BATCH_MAX_BYTES = 64 * 1024 * 1024;

interface IndexOpenFailure {
  authorityKey: string;
  attempts: number;
  retryAfterMs: number;
  busy: boolean;
}

interface FilenameSnapshot {
  signature: string;
  pathKeys: ReadonlySet<string>;
}

function parseFilenameSnapshot(signature: string): FilenameSnapshot {
  const parsed = JSON.parse(signature) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Invalid session inventory filename signature.');
  }
  return { signature, pathKeys: new Set(parsed) };
}

export interface SessionCatalogOptions {
  /** Legacy filename-signature injection. Supplying only this seam keeps the
   * old in-memory discovery path for focused compatibility tests. */
  readInventorySignature?: typeof readBackendSessionInventorySignature;
  readInventory?: typeof readBackendSessionInventory;
  readIndexedMetadata?: IndexedMetadataReader;
  createIndexStore?: SessionIndexStoreFactory;
  usePersistentIndex?: boolean;
  /** Production should supply this so progressive/background reconciliation
   * can publish fresh snapshots without waiting for the 10-second safety poll. */
  onCatalogChanged?: () => void;
  /** Defaults true when `onCatalogChanged` is present, false otherwise. */
  backgroundReconciliation?: boolean;
  /** Deterministic clock seam for bounded index-open retry tests. */
  nowMs?: () => number;
}

interface SessionIndexContext {
  authorityKey: string;
  store: SessionIndexStore;
  records: Map<string, IndexedSessionMetadata>;
  /** Present only while this process is parsing one inventory. Known local
   * tombstones may advance it through their exact checked SQLite transition. */
  reconciliationMutationGeneration?: number;
}

function sortSummaries(summaries: SessionSummary[]): SessionSummary[] {
  return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function summaryProjectionKey(summary: SessionSummary | undefined): string {
  return summary ? JSON.stringify(summary) : '';
}

function newestInventoryFirst(
  inventory: readonly BackendSessionFileFingerprint[],
): BackendSessionFileFingerprint[] {
  return [...inventory].sort((left, right) => {
    const leftNs = BigInt(left.modifiedNs);
    const rightNs = BigInt(right.modifiedNs);
    return leftNs === rightNs ? left.pathKey.localeCompare(right.pathKey) : leftNs > rightNs ? -1 : 1;
  });
}

export class SessionCatalog {
  /** Compatibility discovery cache used only when the persistent sidecar is
   * disabled/unavailable. */
  private basePromise?: Promise<SessionSummary[]>;
  /** null means the initial legacy signature failed, so the next success must refresh. */
  private inventorySignature?: string | null;
  /** Forgotten paths remain excluded even if discovery/reconciliation was
   * already in flight or review merging synthesizes a placeholder. */
  private readonly removedPathKeys = new Set<string>();
  private cacheGeneration = 0;
  private readonly readInventorySignature: typeof readBackendSessionInventorySignature;

  private readonly usePersistentIndex: boolean;
  private readonly readInventory: typeof readBackendSessionInventory;
  private readonly readIndexedMetadata: IndexedMetadataReader;
  private readonly createIndexStore: SessionIndexStoreFactory;
  private readonly onCatalogChanged?: () => void;
  private readonly backgroundReconciliation: boolean;
  private readonly nowMs: () => number;
  private indexContext?: SessionIndexContext;
  private indexOpenFailure?: IndexOpenFailure;
  private indexOpenRetryTimer?: NodeJS.Timeout;
  private readonly pendingIndexDeleteKeys = new Set<string>();
  private indexDeleteRetryTimer?: NodeJS.Timeout;
  private indexDeleteRetryAttempts = 0;
  private currentInventory?: BackendSessionFileFingerprint[];
  private currentInventoryAuthority?: string;
  private inventoryReadPromise?: Promise<void>;
  private inventoryReadGeneration = 0;
  private filenameSnapshotSignature?: string;
  private filenameSnapshotAuthority?: string;
  private filenameReadPromise?: Promise<FilenameSnapshot>;
  private filenameReadAuthority?: string;
  /** Invalid files have reached a durable conclusion but intentionally have
   * no visible row. Their strong fingerprints remain settled until changed. */
  private readonly settledInvalidFingerprints = new Map<string, BackendSessionFileFingerprint>();
  private queuedInventory?: BackendSessionFileFingerprint[];
  private reconcilePromise?: Promise<boolean>;
  private bootstrapReadyPromise?: Promise<void>;
  private resolveBootstrapReady?: () => void;
  private bootstrapContext?: SessionIndexContext;
  private reconciliationNotificationPending = false;
  private notificationScheduled = false;

  constructor(options: SessionCatalogOptions = {}) {
    this.readInventorySignature = options.readInventorySignature ?? readBackendSessionInventorySignature;
    this.readInventory = options.readInventory ?? readBackendSessionInventory;
    this.readIndexedMetadata = options.readIndexedMetadata ?? readIndexedSessionMetadata;
    this.createIndexStore = options.createIndexStore
      ?? ((indexPath, authorityKey) => new SessionIndexStore(indexPath, authorityKey));
    // Existing signature-injection tests intentionally exercise the legacy
    // cache unless they explicitly opt into the persistent index.
    this.usePersistentIndex = options.usePersistentIndex
      ?? options.readInventorySignature === undefined;
    this.onCatalogChanged = options.onCatalogChanged;
    this.backgroundReconciliation = options.backgroundReconciliation
      ?? options.onCatalogChanged !== undefined;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Progress for the latest successfully-read canonical inventory. Event
   * producers read this synchronously after each background batch. */
  getProgress(): SessionCatalogProgress {
    const context = this.indexContext;
    const inventory = context && this.currentInventoryAuthority === context.authorityKey
      ? this.currentInventory
      : undefined;
    if (!context) {
      if (this.indexOpenFailure?.busy) {
        return { complete: false, processed: 0 };
      }
      return { complete: true, processed: 0, total: 0 };
    }
    if (!inventory) {
      return { complete: false, processed: context.records.size };
    }

    const files = inventory.filter((file) => !this.removedPathKeys.has(file.pathKey));
    let processed = 0;
    for (const file of files) {
      const record = context.records.get(file.pathKey);
      const invalid = this.settledInvalidFingerprints.get(file.pathKey);
      if ((record && backendSessionFingerprintsEqual(record.fingerprint, file))
        || (invalid && backendSessionFingerprintsEqual(invalid, file))) {
        processed += 1;
      }
    }
    return { complete: processed === files.length, processed, total: files.length };
  }

  async list(
    sdk: SdkModule,
    sessionDir: string | undefined,
    liveSummaries: readonly SessionSummary[] = [],
    agentDir?: string,
  ): Promise<SessionSummary[]> {
    const context = agentDir ? this.ensureIndexContext(agentDir, sessionDir) : undefined;
    if (!context) {
      if (agentDir && this.hasBusyIndexFailure(agentDir, sessionDir)) {
        return this.projectLiveSummaries(liveSummaries);
      }
      return await this.listLegacy(sdk, sessionDir, liveSummaries, agentDir);
    }

    // A durable projection is useful only while its transcript filename still
    // exists. This cheap, coalesced directory-only fence runs before every
    // publication, so a restart or another backend process cannot resurrect a
    // forgotten row while the stronger stat/content reconciliation remains in
    // the background.
    await this.applyFilenamePublicationBarrier(context, agentDir!, sessionDir);
    if (context !== this.indexContext) return [];

    let inventory = this.currentInventoryAuthority === context.authorityKey
      ? this.currentInventory
      : undefined;
    if (!inventory) {
      if (this.backgroundReconciliation && context.records.size > 0) {
        this.startBackgroundInventoryRead(context, agentDir!, sessionDir);
        return this.projectIndexedSummaries(context, liveSummaries);
      }
      try {
        inventory = await this.readInventory(agentDir!, sessionDir);
        this.currentInventory = inventory;
        this.currentInventoryAuthority = context.authorityKey;
      } catch (error) {
        // A valid durable snapshot remains usable while its directory is
        // temporarily inaccessible. Do not replace it with a truncated list.
        backendTrace('sessionCatalog', 'inventory.readFailed', {
          level: 'warn',
          error: toErrorMessage(error),
        });
      }
    }

    if (inventory) {
      this.dropMissingRecords(context, inventory);
      // Compatibility for embedders/tests that implement bare SDK listAll()
      // without the SDK's default `<agentDir>/sessions/<cwd>/` layout. A real
      // empty default store is cheap to discover, while configured canonical
      // stores always remain index-authoritative.
      if (!sessionDir && inventory.length === 0 && context.records.size === 0) {
        return await this.listLegacy(sdk, sessionDir, liveSummaries, agentDir);
      }
      const reconciliation = this.scheduleReconciliation(context, inventory);
      if (!this.backgroundReconciliation) await reconciliation;
      else if (context.records.size === 0) await this.waitForBootstrapBatch(context);
    }

    return this.projectIndexedSummaries(context, liveSummaries);
  }

  /** Immediately and permanently exclude a forgotten path from this backend's
   * catalog and best-effort delete its durable projection. A successful
   * inventory read on the next process also filters absent transcripts before
   * any stale sidecar row can be projected. */
  remove(sessionPath: string): void {
    const key = backendSessionPathKey(sessionPath);
    this.removedPathKeys.add(key);
    this.settledInvalidFingerprints.delete(key);
    if (this.indexContext) {
      this.indexContext.records.delete(key);
      this.queueIndexDeletes(this.indexContext, [key], sessionPath);
    }
    this.invalidateLegacy();
  }

  async invalidateIfInventoryChanged(agentDir: string, sessionDir: string | undefined): Promise<boolean> {
    const context = this.ensureIndexContext(agentDir, sessionDir);
    if (!context) {
      if (this.hasBusyIndexFailure(agentDir, sessionDir)) return false;
      return await this.invalidateLegacyIfInventoryChanged(agentDir, sessionDir);
    }

    // The explicit safety poll supersedes any older background walk. The
    // generation fence prevents that older result from publishing afterwards.
    this.inventoryReadGeneration += 1;
    this.inventoryReadPromise = undefined;
    const inventory = await this.readInventory(agentDir, sessionDir);
    if (context !== this.indexContext) return false;
    this.currentInventory = inventory;
    this.currentInventoryAuthority = context.authorityKey;
    const removed = this.dropMissingRecords(context, inventory);
    const reconciliation = this.scheduleReconciliation(context, inventory);
    let reconciled = false;
    if (this.backgroundReconciliation) {
      if (context.records.size === 0) await this.waitForBootstrapBatch(context);
    } else {
      reconciled = await reconciliation;
    }
    const pending = this.reconciliationNotificationPending;
    this.reconciliationNotificationPending = false;
    return removed || reconciled || pending;
  }

  /** Explicit cold mutation hint. Strong fingerprints identify the affected
   * path on the next cheap inventory pass; retaining rows here keeps the UI
   * snappy while that low-priority reconcile runs. */
  refresh(): void {
    this.inventoryReadGeneration += 1;
    this.inventoryReadPromise = undefined;
    this.currentInventory = undefined;
    this.currentInventoryAuthority = undefined;
    this.invalidateLegacy();
  }

  /** A nonempty durable sidecar is immediately useful. Discover its canonical
   * inventory behind the returned projection, publish incomplete status now,
   * then publish the reconciled status/list when the walk settles. */
  private startBackgroundInventoryRead(
    context: SessionIndexContext,
    agentDir: string,
    sessionDir: string | undefined,
  ): void {
    if (this.inventoryReadPromise || context !== this.indexContext) return;
    const generation = this.inventoryReadGeneration;
    this.notifyCatalogChanged();

    const scan = (async () => {
      try {
        const inventory = await this.readInventory(agentDir, sessionDir);
        if (context !== this.indexContext || generation !== this.inventoryReadGeneration) return;
        this.currentInventory = inventory;
        this.currentInventoryAuthority = context.authorityKey;
        this.dropMissingRecords(context, inventory);
        this.scheduleReconciliation(context, inventory);
        this.notifyCatalogChanged();
      } catch (error) {
        backendTrace('sessionCatalog', 'inventory.readFailed', {
          level: 'warn',
          error: toErrorMessage(error),
        });
      }
    })().finally(() => {
      if (this.inventoryReadPromise === scan) this.inventoryReadPromise = undefined;
    });
    this.inventoryReadPromise = scan;
  }

  private async applyFilenamePublicationBarrier(
    context: SessionIndexContext,
    agentDir: string,
    sessionDir: string | undefined,
  ): Promise<void> {
    let scan = this.filenameReadAuthority === context.authorityKey
      ? this.filenameReadPromise
      : undefined;
    if (!scan) {
      scan = this.readInventorySignature(agentDir, sessionDir).then(parseFilenameSnapshot);
      this.filenameReadPromise = scan;
      this.filenameReadAuthority = context.authorityKey;
    }

    try {
      const snapshot = await scan;
      if (context !== this.indexContext) return;
      const changed = this.filenameSnapshotAuthority !== context.authorityKey
        || this.filenameSnapshotSignature !== snapshot.signature;
      this.filenameSnapshotAuthority = context.authorityKey;
      this.filenameSnapshotSignature = snapshot.signature;
      this.dropMissingRecordKeys(context, snapshot.pathKeys);
      if (changed) {
        // Supersede an inventory derived from the previous filename set. The
        // normal list path below starts (or awaits, for a new empty index) one
        // strong stat/content reconciliation against this new authority.
        this.inventoryReadGeneration += 1;
        this.inventoryReadPromise = undefined;
        this.currentInventory = undefined;
        this.currentInventoryAuthority = undefined;
      }
    } catch (error) {
      // Permission/sharing failures are not evidence that every transcript was
      // deleted. Retain the last complete projection and try again next list.
      backendTrace('sessionCatalog', 'filenameInventory.readFailed', {
        level: 'warn',
        error: toErrorMessage(error),
      });
    } finally {
      if (this.filenameReadPromise === scan) {
        this.filenameReadPromise = undefined;
        this.filenameReadAuthority = undefined;
      }
    }
  }

  private ensureIndexContext(
    agentDir: string,
    sessionDir: string | undefined,
  ): SessionIndexContext | undefined {
    if (!this.usePersistentIndex || !agentDir) return undefined;
    const authorityKey = backendSessionPathKey(resolveSessionIndexAuthority(agentDir, sessionDir));
    if (this.indexContext?.authorityKey === authorityKey) return this.indexContext;
    if (this.indexOpenFailure && this.indexOpenFailure.authorityKey !== authorityKey) {
      this.indexOpenFailure = undefined;
      this.clearIndexOpenRetryTimer();
    }
    const previousFailure = this.indexOpenFailure?.authorityKey === authorityKey
      ? this.indexOpenFailure
      : undefined;
    if (previousFailure && this.nowMs() < previousFailure.retryAfterMs) return undefined;

    if (this.indexContext) {
      try { this.indexContext.store.close(); } catch { /* process exit remains safe */ }
      this.indexContext = undefined;
      this.pendingIndexDeleteKeys.clear();
      this.indexDeleteRetryAttempts = 0;
      if (this.indexDeleteRetryTimer) clearTimeout(this.indexDeleteRetryTimer);
      this.indexDeleteRetryTimer = undefined;
    }
    this.inventoryReadGeneration += 1;
    this.inventoryReadPromise = undefined;
    this.filenameReadPromise = undefined;
    this.filenameReadAuthority = undefined;
    this.filenameSnapshotSignature = undefined;
    this.filenameSnapshotAuthority = undefined;
    try {
      const store = this.createIndexStore(resolveSessionIndexPath(agentDir, sessionDir), authorityKey);
      const storedRecords = store.readAll();
      const records = new Map(storedRecords
        .filter((record) => !this.removedPathKeys.has(record.fingerprint.pathKey))
        .map((record) => [record.fingerprint.pathKey, record]));
      this.indexContext = { authorityKey, store, records };
      this.settledInvalidFingerprints.clear();
      this.indexOpenFailure = undefined;
      this.clearIndexOpenRetryTimer();
      this.bootstrapReadyPromise = undefined;
      this.resolveBootstrapReady = undefined;
      this.bootstrapContext = undefined;
      this.currentInventory = undefined;
      this.currentInventoryAuthority = undefined;
      const forgottenKeys = storedRecords
        .map((record) => record.fingerprint.pathKey)
        .filter((key) => this.removedPathKeys.has(key));
      if (forgottenKeys.length > 0) this.queueIndexDeletes(this.indexContext, forgottenKeys);
      return this.indexContext;
    } catch (error) {
      // Read-only/unsupported environments preserve the established SDK cache
      // rather than making session.list unavailable. Failures are not sticky:
      // later list/poll calls retry with bounded backoff, so a short lock or
      // mount race cannot strand this backend on the slow legacy scan forever.
      const attempts = (previousFailure?.attempts ?? 0) + 1;
      const delayMs = Math.min(
        INDEX_OPEN_RETRY_MAX_MS,
        INDEX_OPEN_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 16)),
      );
      this.indexOpenFailure = {
        authorityKey,
        attempts,
        retryAfterMs: this.nowMs() + delayMs,
        busy: isSessionIndexBusyError(error),
      };
      if (this.indexOpenFailure.busy) {
        this.scheduleIndexOpenRetry(this.indexOpenFailure);
      } else {
        this.clearIndexOpenRetryTimer();
      }
      backendTrace('sessionCatalog', 'index.unavailable', {
        level: 'warn',
        error: toErrorMessage(error),
        retryAfterMs: delayMs,
      });
      return undefined;
    }
  }

  private projectIndexedSummaries(
    context: SessionIndexContext,
    liveSummaries: readonly SessionSummary[],
  ): SessionSummary[] {
    const byPath = new Map([...context.records.values()]
      .filter((record) => !this.removedPathKeys.has(record.fingerprint.pathKey))
      .map((record) => [record.fingerprint.pathKey, record.summary]));
    for (const summary of liveSummaries) {
      const key = backendSessionPathKey(summary.path);
      if (!this.removedPathKeys.has(key)) byPath.set(key, summary);
    }
    return sortSummaries(applySessionReviews([...byPath.values()])
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path))));
  }

  private projectLiveSummaries(liveSummaries: readonly SessionSummary[]): SessionSummary[] {
    const byPath = new Map(liveSummaries
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path)))
      .map((summary) => [backendSessionPathKey(summary.path), summary]));
    return sortSummaries(applySessionReviews([...byPath.values()])
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path))));
  }

  private hasBusyIndexFailure(agentDir: string, sessionDir: string | undefined): boolean {
    const authorityKey = backendSessionPathKey(resolveSessionIndexAuthority(agentDir, sessionDir));
    return this.indexOpenFailure?.authorityKey === authorityKey
      && this.indexOpenFailure.busy;
  }

  private scheduleIndexOpenRetry(failure: IndexOpenFailure): void {
    if (!this.onCatalogChanged) return;
    this.clearIndexOpenRetryTimer();
    const delayMs = Math.max(0, failure.retryAfterMs - this.nowMs());
    this.indexOpenRetryTimer = setTimeout(() => {
      this.indexOpenRetryTimer = undefined;
      const current = this.indexOpenFailure;
      if (!current?.busy || current.authorityKey !== failure.authorityKey) return;
      const remainingMs = current.retryAfterMs - this.nowMs();
      if (remainingMs > 0) {
        this.scheduleIndexOpenRetry(current);
        return;
      }
      this.notifyCatalogChanged();
    }, delayMs);
    this.indexOpenRetryTimer.unref();
  }

  private clearIndexOpenRetryTimer(): void {
    if (this.indexOpenRetryTimer) clearTimeout(this.indexOpenRetryTimer);
    this.indexOpenRetryTimer = undefined;
  }

  private dropMissingRecords(
    context: SessionIndexContext,
    inventory: readonly BackendSessionFileFingerprint[],
  ): boolean {
    const retained = new Set(inventory
      .filter((file) => !this.removedPathKeys.has(file.pathKey))
      .map((file) => file.pathKey));
    return this.dropMissingRecordKeys(context, retained);
  }

  private dropMissingRecordKeys(
    context: SessionIndexContext,
    retained: ReadonlySet<string>,
  ): boolean {
    let visibleChanged = false;
    const missingKeys: string[] = [];
    for (const key of context.records.keys()) {
      if (retained.has(key)) continue;
      context.records.delete(key);
      missingKeys.push(key);
      visibleChanged = true;
    }
    for (const key of this.settledInvalidFingerprints.keys()) {
      if (!retained.has(key)) this.settledInvalidFingerprints.delete(key);
    }
    if (missingKeys.length === 0) return false;
    this.queueIndexDeletes(context, missingKeys);
    return visibleChanged;
  }

  private queueIndexDeletes(
    context: SessionIndexContext,
    pathKeys: readonly string[],
    sessionPath?: string,
  ): void {
    if (context !== this.indexContext) return;
    for (const key of pathKeys) this.pendingIndexDeleteKeys.add(key);
    try {
      const pendingKeys = [...this.pendingIndexDeleteKeys];
      const canAdvanceActiveReconciliation = context.reconciliationMutationGeneration !== undefined
        && pendingKeys.every((key) => this.removedPathKeys.has(key));
      const expectedGeneration = canAdvanceActiveReconciliation
        ? context.reconciliationMutationGeneration
        : undefined;
      const result = context.store.deletePathsWithGeneration(pendingKeys, expectedGeneration);
      if (expectedGeneration !== undefined) {
        context.reconciliationMutationGeneration = result.mutationGeneration;
      }
      this.pendingIndexDeleteKeys.clear();
      this.indexDeleteRetryAttempts = 0;
      if (this.indexDeleteRetryTimer) clearTimeout(this.indexDeleteRetryTimer);
      this.indexDeleteRetryTimer = undefined;
    } catch (error) {
      // The in-memory tombstone is immediately authoritative. A short,
      // unref'ed retry finishes the durable delete/privacy checkpoint without
      // making the UI wait behind another backend process.
      backendTrace('sessionCatalog', 'index.deleteDeferred', {
        level: 'debug',
        error: toErrorMessage(error),
        ...(sessionPath ? { sessionPath } : {}),
      });
      this.scheduleIndexDeleteRetry(context);
    }
  }

  private scheduleIndexDeleteRetry(context: SessionIndexContext): void {
    if (this.indexDeleteRetryTimer || context !== this.indexContext) return;
    const delayMs = Math.min(
      INDEX_DELETE_RETRY_MAX_MS,
      INDEX_DELETE_RETRY_BASE_MS * (2 ** Math.min(this.indexDeleteRetryAttempts, 16)),
    );
    this.indexDeleteRetryAttempts += 1;
    this.indexDeleteRetryTimer = setTimeout(() => {
      this.indexDeleteRetryTimer = undefined;
      if (context !== this.indexContext || this.pendingIndexDeleteKeys.size === 0) return;
      this.queueIndexDeletes(context, []);
    }, delayMs);
    this.indexDeleteRetryTimer.unref();
  }

  private scheduleReconciliation(
    context: SessionIndexContext,
    inventory: readonly BackendSessionFileFingerprint[],
  ): Promise<boolean> {
    const needsWork = inventory.some((file) => {
      if (this.removedPathKeys.has(file.pathKey)) return false;
      const existing = context.records.get(file.pathKey);
      const invalid = this.settledInvalidFingerprints.get(file.pathKey);
      return (!existing || !backendSessionFingerprintsEqual(existing.fingerprint, file))
        && (!invalid || !backendSessionFingerprintsEqual(invalid, file));
    });
    if (!needsWork) return this.reconcilePromise ?? Promise.resolve(false);

    this.queuedInventory = [...inventory];
    if (this.reconcilePromise) return this.reconcilePromise;
    const activeContext = context;
    if (activeContext.records.size === 0) this.ensureBootstrapBarrier(activeContext);
    const reconciliation = (async () => {
      let changed = false;
      while (this.queuedInventory && this.indexContext === activeContext) {
        const next = this.queuedInventory;
        this.queuedInventory = undefined;
        activeContext.reconciliationMutationGeneration = activeContext.store.readMutationGeneration();
        try {
          changed = await this.reconcileInventory(activeContext, next) || changed;
        } finally {
          activeContext.reconciliationMutationGeneration = undefined;
        }
      }
      this.markBootstrapBatchReady(activeContext);
      return changed;
    })().catch((error) => {
      // SQLITE_BUSY/LOCKED and file races are expected to settle. Keep the last
      // complete projection and let the next list/poll retry.
      backendTrace('sessionCatalog', 'index.reconcileDeferred', {
        level: 'debug',
        error: toErrorMessage(error),
      });
      this.markBootstrapBatchReady(activeContext);
      return false;
    }).finally(() => {
      if (this.reconcilePromise === reconciliation) this.reconcilePromise = undefined;
    });
    this.reconcilePromise = reconciliation;
    return reconciliation;
  }

  private async reconcileInventory(
    context: SessionIndexContext,
    inventory: readonly BackendSessionFileFingerprint[],
  ): Promise<boolean> {
    const changedFiles = newestInventoryFirst(inventory).filter((file) => {
      if (this.removedPathKeys.has(file.pathKey)) return false;
      const existing = context.records.get(file.pathKey);
      const invalid = this.settledInvalidFingerprints.get(file.pathKey);
      return (!existing || !backendSessionFingerprintsEqual(existing.fingerprint, file))
        && (!invalid || !backendSessionFingerprintsEqual(invalid, file));
    });
    if (changedFiles.length === 0) return false;
    // scheduleReconciliation captured the shared cross-process delete fence
    // before entering this parser. Each batch validates and, for its own
    // invalid-row deletes, advances that exact value transactionally.
    if (context.reconciliationMutationGeneration === undefined) {
      throw new Error('Session index reconciliation generation is unavailable.');
    }

    let firstBootstrapBatch = context.records.size === 0;
    let batch: IndexedSessionMetadata[] = [];
    let invalidFiles: BackendSessionFileFingerprint[] = [];
    let attemptedInBatch = 0;
    let attemptedBytesInBatch = 0;
    let changed = false;

    const flush = (): void => {
      if (attemptedInBatch === 0) return;
      // A forget can run while a later file in this batch is awaiting metadata
      // I/O. The tombstone is process-local authority from that synchronous
      // mutation boundary onward, so filter again immediately before the
      // durable transaction: an earlier completed projection must never
      // resurrect private derived bytes after `remove()` deleted its row.
      const committableBatch = batch.filter((record) => (
        !this.removedPathKeys.has(record.fingerprint.pathKey)
      ));
      const committableInvalidFiles = invalidFiles.filter((file) => {
        const retained = !this.removedPathKeys.has(file.pathKey);
        if (!retained) this.settledInvalidFingerprints.delete(file.pathKey);
        return retained;
      });
      const committableInvalidPathKeys = committableInvalidFiles.map((file) => file.pathKey);
      const oldSummaries = new Map<string, string>();
      for (const record of committableBatch) {
        oldSummaries.set(record.fingerprint.pathKey, summaryProjectionKey(context.records.get(record.fingerprint.pathKey)?.summary));
      }
      for (const key of committableInvalidPathKeys) {
        oldSummaries.set(key, summaryProjectionKey(context.records.get(key)?.summary));
      }

      const write = context.store.commitReconciliationBatch(
        committableBatch,
        committableInvalidPathKeys,
        context.reconciliationMutationGeneration!,
      );
      context.reconciliationMutationGeneration = write.mutationGeneration;
      let visibleChanged = false;
      for (const record of committableBatch) {
        const key = record.fingerprint.pathKey;
        context.records.set(key, record);
        visibleChanged = oldSummaries.get(key) !== summaryProjectionKey(record.summary) || visibleChanged;
      }
      for (const file of committableInvalidFiles) {
        this.settledInvalidFingerprints.set(file.pathKey, file);
        context.records.delete(file.pathKey);
        visibleChanged = (oldSummaries.get(file.pathKey)?.length ?? 0) > 0 || visibleChanged;
      }
      batch = [];
      invalidFiles = [];
      attemptedInBatch = 0;
      attemptedBytesInBatch = 0;
      // Readiness means the bounded batch reached a durable conclusion, not
      // that every file produced a visible row. Invalid, moving, or
      // temporarily unreadable newest files must not make first-list callers
      // wait for the entire historical store or starve older valid sessions.
      this.markBootstrapBatchReady(context);
      if (visibleChanged) {
        changed = true;
      }
      // Completion is user-visible even when an invalid file produced no row.
      // Count and source-byte caps avoid both per-file renderer churn and long
      // silent gaps behind a handful of unusually large transcripts.
      if (this.backgroundReconciliation) this.notifyCatalogChanged();
      firstBootstrapBatch = false;
    };

    for (const file of changedFiles) {
      if (this.removedPathKeys.has(file.pathKey)) continue;
      const maxFiles = firstBootstrapBatch ? FIRST_BOOTSTRAP_MAX_FILES : BACKGROUND_BATCH_MAX_FILES;
      const maxBytes = firstBootstrapBatch ? FIRST_BOOTSTRAP_MAX_BYTES : BACKGROUND_BATCH_MAX_BYTES;
      // Always attempt at least one file. Thereafter, flush before the next
      // file would cross either cap; source bytes are a much more stable UX
      // budget than a row count when individual JSONL files span kilobytes to
      // tens of megabytes.
      if (attemptedInBatch > 0
        && (attemptedInBatch >= maxFiles || attemptedBytesInBatch + file.sizeBytes > maxBytes)) {
        flush();
      }
      const previous = context.records.get(file.pathKey);
      try {
        const result = await this.readIndexedMetadata(file, previous);
        if (result.status === 'ok') {
          this.settledInvalidFingerprints.delete(file.pathKey);
          batch.push(result.metadata);
        } else if (result.status === 'invalid') {
          invalidFiles.push(file);
        }
        // A file that moved while being read stays on its last complete row and
        // is retried against a fresh inventory; never commit mismatched metadata.
      } catch (error) {
        // Permission, sharing, and transient I/O failures are local to this
        // transcript. Keep its last complete row and continue through the
        // inventory so one bad newest file cannot suppress every older tab.
        backendTrace('sessionCatalog', 'metadata.readDeferred', {
          level: 'debug',
          error: toErrorMessage(error),
          sessionPath: file.path,
        });
      }
      attemptedInBatch += 1;
      attemptedBytesInBatch += file.sizeBytes;
    }
    flush();
    return changed;
  }

  private ensureBootstrapBarrier(context: SessionIndexContext): void {
    if (this.bootstrapContext === context && this.bootstrapReadyPromise) return;
    this.bootstrapContext = context;
    this.bootstrapReadyPromise = new Promise<void>((resolve) => {
      this.resolveBootstrapReady = resolve;
    });
  }

  private markBootstrapBatchReady(context: SessionIndexContext): void {
    if (this.bootstrapContext !== context) return;
    const resolve = this.resolveBootstrapReady;
    this.resolveBootstrapReady = undefined;
    resolve?.();
  }

  private async waitForBootstrapBatch(context: SessionIndexContext): Promise<void> {
    if (this.bootstrapContext !== context) return;
    await this.bootstrapReadyPromise;
  }

  private notifyCatalogChanged(): void {
    if (!this.onCatalogChanged) {
      this.reconciliationNotificationPending = true;
      return;
    }
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      try {
        this.onCatalogChanged?.();
      } catch (error) {
        backendTrace('sessionCatalog', 'changeListener.failed', {
          level: 'warn',
          error: toErrorMessage(error),
        });
      }
    });
  }

  private async listLegacy(
    sdk: SdkModule,
    sessionDir: string | undefined,
    liveSummaries: readonly SessionSummary[],
    agentDir?: string,
  ): Promise<SessionSummary[]> {
    if (!this.basePromise) {
      const generation = this.cacheGeneration;
      const discovery = (async () => {
        let signature: string | null | undefined;
        if (agentDir) {
          try {
            signature = await this.readInventorySignature(agentDir, sessionDir);
          } catch {
            signature = null;
          }
        }
        const summaries = await discoverSessionSummaries(sdk, sessionDir);
        if (this.cacheGeneration === generation) this.inventorySignature = signature;
        return summaries;
      })().catch((error) => {
        if (this.basePromise === discovery) {
          this.basePromise = undefined;
          this.inventorySignature = undefined;
        }
        throw error;
      });
      this.basePromise = discovery;
    }

    const discovered = await this.basePromise;
    const byPath = new Map(discovered
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path)))
      .map((summary) => [backendSessionPathKey(summary.path), summary]));
    for (const summary of liveSummaries) {
      const key = backendSessionPathKey(summary.path);
      if (!this.removedPathKeys.has(key)) byPath.set(key, summary);
    }
    return sortSummaries(applySessionReviews([...byPath.values()])
      .filter((summary) => !this.removedPathKeys.has(backendSessionPathKey(summary.path))));
  }

  private async invalidateLegacyIfInventoryChanged(
    agentDir: string,
    sessionDir: string | undefined,
  ): Promise<boolean> {
    if (!this.basePromise || this.inventorySignature === undefined) return false;
    const signature = await this.readInventorySignature(agentDir, sessionDir);
    if (this.inventorySignature !== null && signature === this.inventorySignature) return false;
    this.invalidateLegacy();
    return true;
  }

  private invalidateLegacy(): void {
    this.cacheGeneration += 1;
    this.basePromise = undefined;
    this.inventorySignature = undefined;
  }
}
