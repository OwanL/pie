import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { serializeJsonLine } from '../../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../../shared/error-message';
import { atomicWriteText as atomicWriteTextImpl } from '../../shared/atomic-write';
import { withTransientFsRetry, defaultFsRetryDelay, type FsRetryDelay } from '../../shared/fs-retry';
import { readOptionalText } from '../shared/checkpoint-io';
import { appendPieError, appendPieLog } from '../util/pie-log';
import { resolveSessionIdentity } from '../../backend/session-review-store';
import { workspaceHash } from './helpers';
import { writeCheckpointToDisk } from './persistence';
import { readCheckpointSlots } from '../run-analytics/checkpoint';
import type { CheckpointSlot } from '../shared/checkpoint-slots';
import {
  exportRunAnalyticsStore,
  queryRunAnalyticsStore,
  type RunAnalyticsExportPayload,
  type RunAnalyticsQueryResult,
} from '../run-analytics/query';
import { forgetGlobalSideChannels, inferGlobalLogRoot } from '../run-analytics/side-channel';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  coerceRunSnapshot,
  runRecencyMs,
  type PersistedSessionRunState,
  type RunCheckpoint,
  type RunSnapshot,
  type RunSnapshotLogEntry,
} from '../run-analytics';

interface RunAnalyticsStorageOptions {
  dataOutcomesRootPath: string;
  legacyUsageDataRootPath?: string;
  workspaceId: string;
  legacyWorkspaceIds?: string[];
  now: () => Date;
  serializeSessions: () => Record<string, PersistedSessionRunState>;
  onPersistError?: (error: { message: string; at: string }) => void;
  /** Max lines retained per JSONL history file (`run-snapshots`).
   *  `<= 0` disables line-based pruning. */
  maxRunHistoryEntries?: number;
  /** Hard max UTF-8 bytes retained per JSONL history file. When either this
   *  limit or {@link maxRunHistoryEntries} is exceeded, the file is rewritten to
   *  keep the newest suffix that satisfies both limits. `<= 0` disables the
   *  byte limit. */
  maxRunHistoryBytes?: number;
  /** Minimum interval between automatic `run-analytics.json` refreshes. */
  autoExportIntervalMs?: number;
  /** Test seam for verifying append batching. */
  appendFile?: typeof fs.appendFile;
  /** Test seam for verifying history-retention read fast paths. */
  readFile?: typeof fs.readFile;
  /** Base delay for automatic export retry after a failure. */
  autoExportRetryBaseMs?: number;
  /** Maximum delay for automatic export retry backoff. */
  autoExportRetryMaxMs?: number;
  /** Consecutive derived-export failures tolerated before notifying the user. */
  autoExportNoticeAfterFailures?: number;
  /** Test seam for verifying auto-export timer delays. */
  autoExportSetTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Test seam for atomic rewrites during pruning. */
  atomicWriteText?: (filePath: string, data: string) => Promise<void>;
  /** Test seam for startup freshness metadata reads. */
  stat?: typeof fs.stat;
  /** Test seam for the delay between transient fs retry attempts. */
  retryDelay?: FsRetryDelay;
}

export class RunAnalyticsStorage {
  private readonly storageDir: string;
  private readonly legacyStorageDirs: string[];
  private readonly autoExportPath: string;
  private readonly now: () => Date;
  private readonly serializeSessions: () => Record<string, PersistedSessionRunState>;
  private readonly onPersistError?: (error: { message: string; at: string }) => void;
  private readonly maxRunHistoryEntries: number;
  private readonly maxRunHistoryBytes: number;
  private readonly atomicWriteText: (filePath: string, data: string) => Promise<void>;
  private readonly stat: typeof fs.stat;
  private readonly autoExportIntervalMs: number;
  private readonly appendFile: typeof fs.appendFile;
  private readonly readFile: typeof fs.readFile;
  private readonly retryDelay: FsRetryDelay;
  private readonly historyMetadata = new Map<string, { bytes: number; validEntries: number }>();
  private readonly autoExportRetryBaseMs: number;
  private readonly autoExportRetryMaxMs: number;
  private readonly autoExportNoticeAfterFailures: number;
  private readonly autoExportSetTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private disposed = false;
  private autoExportFailureCount = 0;

  private persistenceQueue: Promise<void> = Promise.resolve();
  private seq = 0;
  private activeSlot: CheckpointSlot = 'a';
  private lastPersistError: { message: string; at: string } | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private autoExportTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistIntervalMs = 1000;
  private autoExportDirtyVersion = 0;
  private lastAutoExportAtMs = 0;
  /**
   * Appends staged by `schedulePersist` that have not yet been flushed to disk.
   * A failed JSONL append stays here and is replayed by the next persist
   * instead of being silently dropped, so a finalized snapshot is
   * eventually written or remains pending. Keyed by runId so the newest
   * pending snapshot per run wins and retries don't double-append.
   */
  private pendingSnapshots: Map<string, RunSnapshot> = new Map();

  constructor(options: RunAnalyticsStorageOptions) {
    const workspaceIds = [...new Set([options.workspaceId, ...(options.legacyWorkspaceIds ?? [])])];
    const workspaceStorageHashes = workspaceIds.map((workspaceId) => workspaceHash(workspaceId));
    const primaryWorkspaceHash = workspaceStorageHashes[0]!;
    this.storageDir = path.join(
      options.dataOutcomesRootPath,
      primaryWorkspaceHash,
    );

    const legacyRoots = [
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'runs')
        : null,
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'usage-data')
        : null,
      options.legacyUsageDataRootPath
        ? path.join(options.legacyUsageDataRootPath, 'data', 'outcomes')
        : null,
      path.join(options.dataOutcomesRootPath, 'runs'),
      path.join(options.dataOutcomesRootPath, 'usage-data'),
      options.dataOutcomesRootPath,
    ].filter((rootPath): rootPath is string => !!rootPath);

    this.legacyStorageDirs = legacyRoots
      .flatMap((rootPath) => workspaceStorageHashes.map((workspaceHashValue) => (
        path.join(rootPath, workspaceHashValue)
      )))
      .filter((candidate, index, candidates) => (
        candidate !== this.storageDir && candidates.indexOf(candidate) === index
      ));
    this.autoExportPath = path.join(this.storageDir, 'run-analytics.json');
    this.now = options.now;
    this.serializeSessions = options.serializeSessions;
    this.onPersistError = options.onPersistError;
    this.maxRunHistoryEntries = options.maxRunHistoryEntries ?? 2000;
    this.maxRunHistoryBytes = options.maxRunHistoryBytes ?? 5_000_000;
    this.atomicWriteText = options.atomicWriteText ?? atomicWriteTextImpl;
    this.stat = options.stat ?? fs.stat;
    this.autoExportIntervalMs = options.autoExportIntervalMs ?? 30_000;
    this.appendFile = options.appendFile ?? fs.appendFile;
    this.readFile = options.readFile ?? fs.readFile;
    this.retryDelay = options.retryDelay ?? defaultFsRetryDelay;
    this.autoExportRetryBaseMs = options.autoExportRetryBaseMs ?? 1000;
    this.autoExportRetryMaxMs = options.autoExportRetryMaxMs ?? 60_000;
    this.autoExportNoticeAfterFailures = Math.max(1, options.autoExportNoticeAfterFailures ?? 6);
    this.autoExportSetTimeout = options.autoExportSetTimeout ?? setTimeout;
    this.lastAutoExportAtMs = this.now().getTime();
  }

  async start(): Promise<RunCheckpoint | null> {
    // Legacy migration is recoverable. A concurrent Pie/VS Code process or a
    // Windows scanner can briefly hold the destination during the atomic
    // replacement; that must not prevent the rest of Pie from starting.
    try {
      await this.migrateLegacyStorage();
    } catch (error) {
      this.recordPersistError(error);
    }
    await fs.mkdir(this.storageDir, { recursive: true });
    await this.sweepStaleTempFiles();
    const checkpoint = await this.readCheckpoint();
    this.seq = checkpoint?.seq ?? 0;
    this.lastAutoExportAtMs = this.now().getTime();
    // Freshness metadata is advisory for a derived export. Never put its I/O on
    // the startup critical path and never let a stat failure reject start().
    void this.checkAutoExportFreshnessSafely();
    return checkpoint;
  }

  private async checkAutoExportFreshnessSafely(): Promise<void> {
    try {
      await this.checkAutoExportFreshness();
    } catch (error) {
      // Surface/log best-effort, then schedule the normal background export
      // path. Rebuilding is a safe retry when freshness cannot be established.
      this.recordPersistError(error);
      this.markAutoExportDirty();
    }
  }

  /** Compare the derived export mtime to canonical source mtimes. */
  private async checkAutoExportFreshness(): Promise<void> {
    let exportMtime: number | undefined;
    try {
      const exportStat = await this.stat(this.autoExportPath);
      exportMtime = exportStat.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (exportMtime === undefined) {
      this.markAutoExportDirty();
      return;
    }

    const sourceFiles = [
      'run-snapshots.jsonl',
      'open-runs.gen',
      'open-runs.a.json',
      'open-runs.b.json',
    ];
    for (const fileName of sourceFiles) {
      try {
        const stat = await this.stat(path.join(this.storageDir, fileName));
        if (stat.mtimeMs > exportMtime) {
          this.markAutoExportDirty();
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  schedulePersist(snapshotToAppend?: RunSnapshot): void {
    if (this.disposed) return;
    // Stage this persist's append into the pending buffer so a failed append
    // is retried by the next persist rather than dropped. Dedup per runId keeps
    // only the newest pending snapshot so retries don't double-append.
    this.stagePendingAppend(snapshotToAppend);
    this.dirty = true;

    // Coalesce high-frequency analytics events into a single debounced flush
    // instead of chaining a full checkpoint + JSONL write per event.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.schedulePersistJob();
      }, this.persistIntervalMs);
    }
  }

  /** The most recent persistence failure, or null if the last persist succeeded. */
  getPersistError(): { message: string; at: string } | null {
    return this.lastPersistError;
  }

  /** The resolved storage directory (JSONL + checkpoint + auto-export live
   *  here). Exposed so host-side aggregators can stat the files for an mtime
   *  fast-path, skipping a full JSONL re-read when nothing has been persisted. */
  getStorageDir(): string {
    return this.storageDir;
  }

  async flush(): Promise<void> {
    this.cancelPersistTimer();
    if (this.dirty || this.pendingSnapshots.size > 0) {
      this.schedulePersistJob();
    }

    // Surface the most recent persist failure so a caller that reads
    // getPersistError() after flush sees the actual last error, not a stale
    // null (the failure is otherwise only observed by the *next* persist's
    // leading .catch). Never clears a recorded error.
    await this.persistenceQueue.catch((error) => {
      this.recordPersistError(error);
    });
  }

  /**
   * Cancels any pending coalesced flush and performs a final flush. Call this
   * before disposing the storage to ensure no pending analytics data is lost.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPersistTimer();
    this.cancelAutoExportTimer();
    await this.flush();
    await this.queueAutoExport(true);
  }

  private cancelPersistTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private cancelAutoExportTimer(): void {
    if (this.autoExportTimer) {
      clearTimeout(this.autoExportTimer);
      this.autoExportTimer = null;
    }
  }

  private schedulePersistJob(): void {
    this.persistenceQueue = this.persistenceQueue
      .catch((error) => {
        this.recordPersistError(error);
      })
      .then(async () => {
        await this.runPersistJob();
        this.lastPersistError = null;
      });
  }

  private async runPersistJob(): Promise<void> {
    const needsCheckpoint = this.dirty;
    this.dirty = false;
    await fs.mkdir(this.storageDir, { recursive: true });
    // Snapshot each pending map and append one concatenated chunk per file.
    // Entries are removed only after that file append succeeds and only when
    // they were not replaced while I/O was in flight. A failed append leaves
    // the whole batch pending for retry, avoiding partial-batch duplicates.
    const snapshots = [...this.pendingSnapshots.values()];
    if (snapshots.length > 0) {
      const chunk = snapshots.map((snapshot) => serializeJsonLine({
        schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
        kind: 'run_snapshot',
        recordedAt: this.isoNow(),
        run: snapshot,
      } satisfies RunSnapshotLogEntry)).join('');
      await this.appendHistoryChunk('run-snapshots.jsonl', chunk, snapshots.length);
      this.deleteAppendedEntries(this.pendingSnapshots, snapshots);
    }
    if (needsCheckpoint) {
      const checkpoint = this.buildCheckpoint(++this.seq);
      await this.writeCheckpoint(checkpoint);
    }
    try {
      await this.pruneHistoryIfNeeded();
    } finally {
      this.markAutoExportDirty();
    }
  }

  private async appendHistoryChunk(fileName: string, chunk: string, entryCount: number): Promise<void> {
    try {
      await withTransientFsRetry(
        () => this.appendFile(path.join(this.storageDir, fileName), chunk, 'utf8'),
        { delay: this.retryDelay },
      );
    } catch (error) {
      // An append can partially reach disk before rejecting. Its final size and
      // record count are therefore unknown; force the next retention pass to
      // rescan rather than trusting stale under-limit metadata.
      this.historyMetadata.delete(fileName);
      throw error;
    }
    const metadata = this.historyMetadata.get(fileName);
    if (metadata) {
      metadata.bytes += Buffer.byteLength(chunk, 'utf8');
      metadata.validEntries += entryCount;
    }
  }

  private deleteAppendedEntries<T extends { runId: string }>(pending: Map<string, T>, appended: T[]): void {
    for (const entry of appended) {
      if (pending.get(entry.runId) === entry) {
        pending.delete(entry.runId);
      }
    }
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.flush();
    return await queryRunAnalyticsStore(this.storageDir);
  }

  /** Remove every run-analytics footprint for one private session. This is
   * serialized with ordinary analytics writes so a late batched append cannot
   * recreate the record after privacy mode is enabled. */
  async forgetSession(sessionPath: string, sessionId?: string): Promise<void> {
    if (this.disposed || !sessionPath) return;
    this.cancelPersistTimer();
    this.persistenceQueue = this.persistenceQueue
      .catch((error) => this.recordPersistError(error))
      .then(async () => {
        const effectiveSessionId = sessionId ?? (() => {
          try { return resolveSessionIdentity(sessionPath).sessionId; } catch { return undefined; }
        })();
        for (const [runId, snapshot] of this.pendingSnapshots) {
          if (snapshot.sessionPath === sessionPath
            || (effectiveSessionId && snapshot.sessionId === effectiveSessionId)) {
            this.pendingSnapshots.delete(runId);
          }
        }
        await fs.mkdir(this.storageDir, { recursive: true });

        // Legacy stores are re-merged on startup to recover late writes from an
        // old process. Scrub the same private identity from every source now,
        // otherwise restart would resurrect data removed from the canonical
        // store. Both A/B checkpoint slots are rewritten because either can be
        // selected after a crash.
        const storageDirs = [...new Set([this.storageDir, ...this.legacyStorageDirs])];
        for (const storageDir of storageDirs) {
          await this.forgetSessionFromStorageDir(storageDir, sessionPath, effectiveSessionId);
        }
        this.historyMetadata.delete('run-snapshots.jsonl');

        const sideChannelRoots = [...new Set(storageDirs.map(inferGlobalLogRoot))];
        for (const root of sideChannelRoots) {
          await forgetGlobalSideChannels(root, sessionPath, effectiveSessionId);
        }
        this.markAutoExportDirty();
      });
    await this.persistenceQueue;
    await this.queueAutoExport(true, true);
  }

  private async forgetSessionFromStorageDir(
    storageDir: string,
    sessionPath: string,
    sessionId?: string,
  ): Promise<void> {
    const belongsToSession = (run: { sessionPath?: unknown; sessionId?: unknown } | null | undefined): boolean => (
      run?.sessionPath === sessionPath
      || (!!sessionId && run?.sessionId === sessionId)
    );
    const historyPath = path.join(storageDir, 'run-snapshots.jsonl');
    try {
      const raw = await this.readFile(historyPath, 'utf8');
      const kept = raw.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          const parsed = JSON.parse(trimmed) as { run?: { sessionPath?: unknown; sessionId?: unknown } };
          return !belongsToSession(parsed.run);
        } catch {
          // Preserve malformed lines; privacy cleanup must not destroy
          // unrelated diagnostics that cannot be safely classified.
          return true;
        }
      });
      const rewritten = kept.length > 0 ? `${kept.join('\n')}\n` : '';
      if (rewritten !== raw) await this.atomicWriteText(historyPath, rewritten);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    for (const slot of ['a', 'b'] as const) {
      const checkpointPath = path.join(storageDir, `open-runs.${slot}.json`);
      try {
        const raw = await this.readFile(checkpointPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          sessions?: Record<string, {
            currentRun?: { sessionPath?: unknown; sessionId?: unknown } | null;
            lastRun?: { sessionPath?: unknown; sessionId?: unknown } | null;
          }>;
        };
        if (!parsed.sessions) continue;
        let changed = false;
        for (const [storedPath, state] of Object.entries(parsed.sessions)) {
          if (storedPath === sessionPath
            || belongsToSession(state.currentRun)
            || belongsToSession(state.lastRun)) {
            delete parsed.sessions[storedPath];
            changed = true;
          }
        }
        if (changed) await this.atomicWriteText(checkpointPath, JSON.stringify(parsed, null, 2));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  /** Read only data already persisted to disk. Used by the aggregate cache so
   * its one-second live refresh never forces a persistence flush. */
  async queryPersistedRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    return await queryRunAnalyticsStore(this.storageDir);
  }

  /** Finalized snapshots staged for append but not yet durably persisted. */
  getPendingCompletedRuns(): RunSnapshot[] {
    return [...this.pendingSnapshots.values()];
  }

  async exportRunAnalytics(
    targetPath: string,
    excludeSessionPaths?: ReadonlySet<string>,
    excludeSessionIds?: ReadonlySet<string>,
  ): Promise<RunAnalyticsExportPayload> {
    await this.flush();
    const payload = await exportRunAnalyticsStore(this.storageDir, targetPath, this.now, excludeSessionPaths, excludeSessionIds);
    if (path.resolve(targetPath) === path.resolve(this.autoExportPath)) {
      this.autoExportDirtyVersion = 0;
      this.autoExportFailureCount = 0;
      this.lastAutoExportAtMs = this.now().getTime();
      this.cancelAutoExportTimer();
    }
    return payload;
  }

  private recordPersistError(error: unknown): void {
    const message = toErrorMessage(error);
    const at = this.isoNow();
    const previous = this.lastPersistError;
    this.lastPersistError = { message, at };
    appendPieError('run-analytics', 'persist failed', error, { at, storageDir: this.storageDir });
    if (!previous || previous.message !== message) {
      this.onPersistError?.(this.lastPersistError);
    }
  }

  private stagePendingAppend(snapshotToAppend?: RunSnapshot): void {
    if (snapshotToAppend) {
      const existing = this.pendingSnapshots.get(snapshotToAppend.runId);
      // Keep only the newest pending snapshot per runId; drop the older one
      // whether it is the incoming snapshot or the already-pending one.
      if (!existing || runRecencyMs(snapshotToAppend) >= runRecencyMs(existing)) {
        this.pendingSnapshots.set(snapshotToAppend.runId, snapshotToAppend);
      }
    }
  }

  private buildCheckpoint(seq: number): RunCheckpoint {
    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq,
      sessions: this.serializeSessions(),
    };
  }

  private async readCheckpoint(): Promise<RunCheckpoint | null> {
    const { checkpoint, activeSlot } = await readCheckpointSlots(this.storageDir);
    this.activeSlot = activeSlot;
    return checkpoint;
  }

  private async writeCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    this.activeSlot = await writeCheckpointToDisk(this.storageDir, this.activeSlot, checkpoint);
  }

  private async migrateLegacyStorage(): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });

    const existingLegacyStorageDirs: string[] = [];
    for (const legacyStorageDir of this.legacyStorageDirs) {
      try {
        await fs.cp(legacyStorageDir, this.storageDir, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        existingLegacyStorageDirs.push(legacyStorageDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    if (existingLegacyStorageDirs.length === 0) {
      return;
    }

    await this.mergeJsonlLogFiles(existingLegacyStorageDirs, 'run-snapshots.jsonl');
    await this.mergeCheckpointStates(existingLegacyStorageDirs);
  }

  private async mergeJsonlLogFiles(legacyStorageDirs: string[], fileName: string): Promise<void> {
    const targetPath = path.join(this.storageDir, fileName);
    const [currentRaw, ...legacyRaws] = await Promise.all([
      readOptionalText(targetPath),
      ...legacyStorageDirs.map((legacyStorageDir) => readOptionalText(path.join(legacyStorageDir, fileName))),
    ]);
    const existingLegacyRaws = legacyRaws.filter((raw): raw is string => !!raw);

    if (existingLegacyRaws.length === 0) {
      return;
    }

    const mergedRaw = this.mergeJsonlContent(currentRaw, existingLegacyRaws, fileName);
    if (mergedRaw === currentRaw) {
      return;
    }

    // Write to a temp file in the same directory then rename atomically, so a
    // crash mid-write cannot corrupt the JSONL (mirrors exportRunAnalyticsStore).
    await this.atomicWriteText(targetPath, mergedRaw);
  }

  private async mergeCheckpointStates(legacyStorageDirs: string[]): Promise<void> {
    const currentState = await readCheckpointSlots(this.storageDir);
    const legacyStates = await Promise.all(
      legacyStorageDirs.map((legacyStorageDir) => readCheckpointSlots(legacyStorageDir)),
    );
    const checkpoints = [
      ...legacyStates.map((state) => state.checkpoint).filter((checkpoint): checkpoint is RunCheckpoint => !!checkpoint),
      currentState.checkpoint,
    ].filter((checkpoint): checkpoint is RunCheckpoint => !!checkpoint);

    if (checkpoints.length === 0) {
      return;
    }

    const mergedSessions: Record<string, PersistedSessionRunState> = {};
    for (const checkpoint of checkpoints) {
      for (const [sessionPath, sessionState] of Object.entries(checkpoint.sessions)) {
        mergedSessions[sessionPath] = this.mergeCheckpointSessionState(
          mergedSessions[sessionPath],
          sessionState,
        );
      }
    }

    const mergedCheckpoint: RunCheckpoint = {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq: Math.max(...checkpoints.map((checkpoint) => checkpoint.seq)),
      sessions: mergedSessions,
    };

    if (currentState.checkpoint && JSON.stringify(currentState.checkpoint) === JSON.stringify(mergedCheckpoint)) {
      return;
    }

    await writeCheckpointToDisk(this.storageDir, currentState.activeSlot, mergedCheckpoint);
  }

  private mergeJsonlContent(
    currentRaw: string | null,
    legacyRaws: string[],
    fileName?: string,
  ): string {
    const mergedLines = new Map<string, { line: string; recency: string; order: number }>();
    let order = 0;

    for (const raw of [...legacyRaws, currentRaw]) {
      if (!raw) {
        continue;
      }

      for (const line of raw.split(/\r?\n/)) {
        const normalizedLine = line.trim();
        if (!normalizedLine) {
          continue;
        }

        const candidate = this.getJsonlMergeCandidate(fileName, normalizedLine);
        const existing = mergedLines.get(candidate.key);
        if (!existing
          || candidate.recency > existing.recency
          || (candidate.recency === existing.recency && order >= existing.order)) {
          mergedLines.set(candidate.key, {
            line: normalizedLine,
            recency: candidate.recency,
            order,
          });
        }
        order += 1;
      }
    }

    return mergedLines.size > 0
      ? `${[...mergedLines.values()].map((entry) => entry.line).join('\n')}\n`
      : '';
  }

  private mergeCheckpointSessionState(
    existingSessionState: PersistedSessionRunState | undefined,
    incomingSessionState: PersistedSessionRunState | undefined,
  ): PersistedSessionRunState {
    if (!existingSessionState) {
      return incomingSessionState!;
    }
    if (!incomingSessionState) {
      return existingSessionState;
    }

    const existingRecency = this.getSessionStateRecencyKey(existingSessionState);
    const incomingRecency = this.getSessionStateRecencyKey(incomingSessionState);
    if (incomingRecency > existingRecency) {
      return incomingSessionState;
    }
    if (incomingRecency < existingRecency) {
      return existingSessionState;
    }
    if (incomingSessionState.currentRun && !existingSessionState.currentRun) {
      return incomingSessionState;
    }
    return incomingSessionState;
  }

  private getSessionStateRecencyKey(sessionState: PersistedSessionRunState): string {
    return sessionState.currentRun?.updatedAt
      ?? sessionState.currentRun?.startedAt
      ?? sessionState.lastRun?.updatedAt
      ?? sessionState.lastRun?.finalizedAt
      ?? sessionState.busyStartedAt
      ?? '';
  }

  private getJsonlMergeCandidate(
    fileName: string | undefined,
    normalizedLine: string,
  ): { key: string; recency: string } {
    try {
      const parsed = parseJsonOrThrow<{
        kind?: unknown;
        recordedAt?: unknown;
        runId?: unknown;
        run?: { runId?: unknown; updatedAt?: unknown; finalizedAt?: unknown };
      }>(normalizedLine, 'stats line');

      if (fileName === 'run-snapshots.jsonl'
        && parsed.kind === 'run_snapshot'
        && typeof parsed.run?.runId === 'string') {
        return {
          key: `run_snapshot:${parsed.run.runId}`,
          recency:
            typeof parsed.run.updatedAt === 'string'
              ? parsed.run.updatedAt
              : typeof parsed.run.finalizedAt === 'string'
                ? parsed.run.finalizedAt
                : typeof parsed.recordedAt === 'string'
                  ? parsed.recordedAt
                  : '',
        };
      }
    } catch {
      // Fall back to the exact line content below.
    }

    return {
      key: `line:${normalizedLine}`,
      recency: '',
    };
  }

  private async sweepStaleTempFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.storageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    // Match the atomic-write temp naming convention `.<name>.<pid>-<ts>-<rand>.tmp`
    // used by exportRunAnalyticsStore / mergeJsonlLogFiles / pruneJsonlFile, so
    // an unrelated dot-tmp file (if one ever appeared in this pie-managed dir)
    // is never swept. These are normally renamed into place or unlinked on
    // caught errors, but a hard kill can leave them behind.
    const staleTemp = /^\..+\.\d+-\d+-[a-z0-9]+\.tmp$/;
    await Promise.all(
      entries
        .filter((name) => staleTemp.test(name))
        .map(async (name) => {
          try {
            await fs.unlink(path.join(this.storageDir, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              appendPieLog('warn', 'run-analytics', 'failed to remove stale temp file', {
                file: name,
                error: toErrorMessage(error),
              });
            }
          }
        }),
    );
  }

  /** Bound on-disk growth of the append-only JSONL history files. When a file
   *  exceeds {@link maxRunHistoryEntries} or {@link maxRunHistoryBytes}, it is
   *  read and rewritten (atomic temp+rename) to keep the newest suffix that
   *  satisfies both limits. The newest valid record is always retained, even if
   *  it alone exceeds the byte limit. UTF-8 byte size is used instead of string
   *  length. A failed prune is surfaced as a persistence error but remains
   *  non-fatal; the original file is preserved because the rewrite is atomic. */
  private async pruneHistoryIfNeeded(): Promise<void> {
    if (this.maxRunHistoryEntries <= 0 && this.maxRunHistoryBytes <= 0) {
      return;
    }
    await Promise.all(
      ['run-snapshots.jsonl'].map(
        (fileName) => this.pruneJsonlFile(fileName),
      ),
    );
  }

  private async pruneJsonlFile(fileName: string): Promise<void> {
    const filePath = path.join(this.storageDir, fileName);
    const entryLimit = this.maxRunHistoryEntries > 0 ? this.maxRunHistoryEntries : Infinity;
    const byteLimit = this.maxRunHistoryBytes > 0 ? this.maxRunHistoryBytes : Infinity;
    const metadata = this.historyMetadata.get(fileName);
    if (metadata && metadata.validEntries <= entryLimit && metadata.bytes <= byteLimit) {
      return;
    }

    let raw: string;
    try {
      raw = await withTransientFsRetry(
        () => this.readFile(filePath, 'utf8'),
        { delay: this.retryDelay },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.historyMetadata.set(fileName, { bytes: 0, validEntries: 0 });
        return;
      }
      throw error;
    }

    const allLines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (allLines.length === 0) {
      this.historyMetadata.set(fileName, { bytes: Buffer.byteLength(raw, 'utf8'), validEntries: 0 });
      return;
    }

    // Retention is defined over valid records. A malformed/truncated tail must
    // not become the mandatory "newest" exception and evict valid history.
    const lines = allLines.filter((line) => this.isValidHistoryRecord(fileName, line));
    const lineTerminator = raw.includes('\r\n') ? '\r\n' : '\n';
    const terminatorBytes = Buffer.byteLength(lineTerminator, 'utf8');
    const lineBytes = lines.map((line) => Buffer.byteLength(line, 'utf8') + terminatorBytes);
    const totalLines = lines.length;
    const totalBytes = lineBytes.reduce((sum, bytes) => sum + bytes, 0);

    if (allLines.length === lines.length && totalLines <= entryLimit && totalBytes <= byteLimit) {
      this.historyMetadata.set(fileName, { bytes: Buffer.byteLength(raw, 'utf8'), validEntries: totalLines });
      return;
    }

    // Walk newest-to-oldest to retain the largest suffix satisfying both limits.
    let keptCount = 0;
    let keptBytes = 0;
    let start = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const bytes = lineBytes[i]!;
      if (keptCount === 0) {
        // Always retain the newest valid record, even if it alone exceeds the byte limit.
        keptBytes = bytes;
        keptCount = 1;
        start = i;
      } else if (keptCount + 1 <= entryLimit && keptBytes + bytes <= byteLimit) {
        keptBytes += bytes;
        keptCount += 1;
        start = i;
      } else {
        break;
      }
    }

    if (start === 0 && allLines.length === lines.length) {
      this.historyMetadata.set(fileName, { bytes: Buffer.byteLength(raw, 'utf8'), validEntries: totalLines });
      return;
    }

    const kept = lines.slice(start);
    const rewritten = kept.length > 0 ? `${kept.join(lineTerminator)}${lineTerminator}` : '';
    await this.atomicWriteText(filePath, rewritten);
    this.historyMetadata.set(fileName, {
      bytes: Buffer.byteLength(rewritten, 'utf8'),
      validEntries: kept.length,
    });
  }

  private isValidHistoryRecord(fileName: string, line: string): boolean {
    try {
      const parsed = parseJsonOrThrow<unknown>(line, `${fileName} record`);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      if (fileName === 'run-snapshots.jsonl') {
        const entry = parsed as { kind?: unknown; run?: unknown };
        // Match queryRunAnalyticsStore exactly: the envelope kind gates the
        // record and the canonical snapshot coercer validates/coerces its run.
        return entry.kind === 'run_snapshot' && coerceRunSnapshot(entry.run) !== null;
      }
      return false;
    } catch {
      return false;
    }
  }

  private markAutoExportDirty(): void {
    if (this.disposed) return;
    this.autoExportDirtyVersion += 1;
    if (this.autoExportTimer) return;
    let delay: number;
    if (this.autoExportFailureCount > 0) {
      delay = Math.min(
        this.autoExportRetryMaxMs,
        this.autoExportRetryBaseMs * 2 ** (this.autoExportFailureCount - 1),
      );
    } else {
      const elapsed = Math.max(0, this.now().getTime() - this.lastAutoExportAtMs);
      delay = Math.max(0, this.autoExportIntervalMs - elapsed);
    }
    // Never schedule an immediate retry; a zero-ms timer would spin the event
    // loop and, after a failure, the elapsed-based throttle would also drop to 0.
    delay = Math.max(1, delay);
    this.autoExportTimer = this.autoExportSetTimeout(() => {
      this.autoExportTimer = null;
      void this.queueAutoExport(false);
    }, delay);
    this.autoExportTimer.unref?.();
  }

  private async queueAutoExport(force: boolean, failOnError = false): Promise<void> {
    if (this.disposed && !force) return;
    this.cancelAutoExportTimer();
    this.persistenceQueue = this.persistenceQueue
      .catch((error) => this.recordPersistError(error))
      .then(async () => {
        if (this.disposed && !force) return;
        if (!force && this.autoExportDirtyVersion === 0) return;
        const version = this.autoExportDirtyVersion;
        const succeeded = await this.writeAutoExportSafely(force && failOnError);
        if (succeeded) {
          this.lastAutoExportAtMs = this.now().getTime();
          this.lastPersistError = null;
          this.autoExportFailureCount = 0;
          if (this.autoExportDirtyVersion === version) {
            this.autoExportDirtyVersion = 0;
          }
        } else {
          this.autoExportFailureCount += 1;
          if (force && failOnError) throw new Error('Run analytics auto-export cleanup failed.');
        }
        if (this.autoExportDirtyVersion > 0) {
          this.markAutoExportDirty();
        }
      });
    await this.persistenceQueue;
  }

  private async writeAutoExport(): Promise<void> {
    await exportRunAnalyticsStore(this.storageDir, this.autoExportPath, this.now);
  }

  private async writeAutoExportSafely(surfaceImmediately = false): Promise<boolean> {
    try {
      await this.writeAutoExport();
      return true;
    } catch (error) {
      const nextFailureCount = this.autoExportFailureCount + 1;
      if (surfaceImmediately || nextFailureCount >= this.autoExportNoticeAfterFailures) {
        this.recordPersistError(error);
      } else {
        appendPieLog('warn', 'run-analytics', 'derived auto-export temporarily blocked; retry scheduled', {
          attempt: nextFailureCount,
          noticeAfterFailures: this.autoExportNoticeAfterFailures,
          storageDir: this.storageDir,
          error: toErrorMessage(error),
          errorCode: (error as NodeJS.ErrnoException).code,
        });
      }
      return false;
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}
