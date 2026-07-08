import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { serializeJsonLine } from '../../shared/jsonl';
import { toErrorMessage, parseJsonOrThrow } from '../../shared/error-message';
import { parseCheckpoint, readOptionalText } from '../shared/checkpoint-io';
import { appendPieError, appendPieLog } from '../util/pie-log';
import { workspaceHash } from './helpers';
import {
  readCheckpointFromDisk,
  writeCheckpointToDisk,
  type CheckpointSlot,
} from './persistence';
import {
  exportRunAnalyticsStore,
  queryRunAnalyticsStore,
  type RunAnalyticsExportPayload,
  type RunAnalyticsQueryResult,
} from '../run-analytics/query';
import {
  RUN_ANALYTICS_SCHEMA_VERSION,
  type AgentReviewEntry,
  type OutcomeHistoryLogEntry,
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
  /** Max lines retained per JSONL history file (`run-snapshots` /
   *  `outcome-history` / `agent-reviews`). When a file exceeds
   *  {@link pruneByteThreshold} it is trimmed to the most recent N lines.
   *  `<= 0` disables pruning (unbounded growth). */
  maxRunHistoryEntries?: number;
  /** File size (bytes) at which a JSONL history file is read and considered for
   *  trimming to {@link maxRunHistoryEntries}. Gates the read+rewrite cost so
   *  steady-state persists stay a single `stat`. */
  pruneByteThreshold?: number;
}

export class RunAnalyticsStorage {
  private readonly storageDir: string;
  private readonly legacyStorageDirs: string[];
  private readonly autoExportPath: string;
  private readonly now: () => Date;
  private readonly serializeSessions: () => Record<string, PersistedSessionRunState>;
  private readonly onPersistError?: (error: { message: string; at: string }) => void;
  private readonly maxRunHistoryEntries: number;
  private readonly pruneByteThreshold: number;

  private persistenceQueue: Promise<void> = Promise.resolve();
  private seq = 0;
  private activeSlot: CheckpointSlot = 'a';
  private lastPersistError: { message: string; at: string } | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistIntervalMs = 1000;
  /**
   * Appends staged by `schedulePersist` that have not yet been flushed to disk.
   * A failed JSONL append stays here and is replayed by the next persist
   * instead of being silently dropped, so a scored snapshot/outcome is
   * eventually written or remains pending. Keyed by runId so the newest
   * pending snapshot/outcome per run wins and retries don't double-append.
   */
  private pendingSnapshots: Map<string, RunSnapshot> = new Map();
  private pendingOutcomes: Map<string, OutcomeHistoryLogEntry> = new Map();
  private pendingAgentReviews: Map<string, AgentReviewEntry> = new Map();

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
    this.pruneByteThreshold = options.pruneByteThreshold ?? 5_000_000;
  }

  async start(): Promise<RunCheckpoint | null> {
    await this.migrateLegacyStorage();
    await fs.mkdir(this.storageDir, { recursive: true });
    await this.sweepStaleTempFiles();
    const checkpoint = await this.readCheckpoint();
    this.seq = checkpoint?.seq ?? 0;
    await this.writeAutoExportSafely();
    return checkpoint;
  }

  schedulePersist(snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry): void {
    // Stage this persist's appends into the pending buffers so a failed append
    // is retried by the next persist rather than dropped. Dedup per runId keeps
    // only the newest pending snapshot/outcome so retries don't double-append.
    this.stagePendingAppend(snapshotToAppend, outcomeToAppend);
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

  schedulePersistAgentReview(entry: AgentReviewEntry): void {
    // Stage the latest agent-review entry per runId so a failed append is
    // retried by the next persist, and re-recording for the same run keeps
    // only the newest review (mirrors pendingOutcomes / pendingSnapshots).
    const existing = this.pendingAgentReviews.get(entry.runId);
    if (!existing || this.agentReviewRecencyMs(entry) >= this.agentReviewRecencyMs(existing)) {
      this.pendingAgentReviews.set(entry.runId, entry);
    }
    this.dirty = true;
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
    if (this.dirty || this.pendingSnapshots.size > 0 || this.pendingOutcomes.size > 0 || this.pendingAgentReviews.size > 0) {
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
    this.cancelPersistTimer();
    await this.flush();
  }

  private cancelPersistTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
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
    // Replay any appends still pending from this or a previously failed
    // persist. Clear each entry immediately after its append succeeds so a
    // later failure (e.g. checkpoint write) doesn't trigger a redundant
    // retry-append of something already on disk.
    for (const snapshot of [...this.pendingSnapshots.values()]) {
      await fs.appendFile(
        path.join(this.storageDir, 'run-snapshots.jsonl'),
        serializeJsonLine({
          schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
          kind: 'run_snapshot',
          recordedAt: this.isoNow(),
          run: snapshot,
        } satisfies RunSnapshotLogEntry),
        'utf8',
      );
      this.pendingSnapshots.delete(snapshot.runId);
    }
    for (const outcome of [...this.pendingOutcomes.values()]) {
      await fs.appendFile(
        path.join(this.storageDir, 'outcome-history.jsonl'),
        serializeJsonLine(outcome),
        'utf8',
      );
      this.pendingOutcomes.delete(outcome.runId);
    }
    for (const review of [...this.pendingAgentReviews.values()]) {
      await fs.appendFile(
        path.join(this.storageDir, 'agent-reviews.jsonl'),
        serializeJsonLine(review),
        'utf8',
      );
      this.pendingAgentReviews.delete(review.runId);
    }
    if (needsCheckpoint) {
      const checkpoint = this.buildCheckpoint(++this.seq);
      await this.writeCheckpoint(checkpoint);
    }
    await this.pruneHistoryIfNeeded();
    await this.writeAutoExportSafely();
  }

  async queryRunAnalytics(): Promise<RunAnalyticsQueryResult> {
    await this.flush();
    return await queryRunAnalyticsStore(this.storageDir);
  }

  async exportRunAnalytics(targetPath: string): Promise<RunAnalyticsExportPayload> {
    await this.flush();
    return await exportRunAnalyticsStore(this.storageDir, targetPath, this.now);
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

  private stagePendingAppend(snapshotToAppend?: RunSnapshot, outcomeToAppend?: OutcomeHistoryLogEntry): void {
    if (snapshotToAppend) {
      const existing = this.pendingSnapshots.get(snapshotToAppend.runId);
      // Keep only the newest pending snapshot per runId; drop the older one
      // whether it is the incoming snapshot or the already-pending one.
      if (!existing || this.snapshotRecencyMs(snapshotToAppend) >= this.snapshotRecencyMs(existing)) {
        this.pendingSnapshots.set(snapshotToAppend.runId, snapshotToAppend);
      }
    }
    if (outcomeToAppend) {
      const existing = this.pendingOutcomes.get(outcomeToAppend.runId);
      if (!existing || this.outcomeRecencyMs(outcomeToAppend) >= this.outcomeRecencyMs(existing)) {
        this.pendingOutcomes.set(outcomeToAppend.runId, outcomeToAppend);
      }
    }
  }

  private snapshotRecencyMs(snapshot: RunSnapshot): number {
    const updatedAt = Date.parse(snapshot.updatedAt);
    if (!Number.isNaN(updatedAt)) {
      return updatedAt;
    }
    if (snapshot.finalizedAt) {
      const finalizedAt = Date.parse(snapshot.finalizedAt);
      if (!Number.isNaN(finalizedAt)) {
        return finalizedAt;
      }
    }
    return Date.parse(snapshot.startedAt);
  }

  private outcomeRecencyMs(outcome: OutcomeHistoryLogEntry): number {
    return Date.parse(outcome.recordedAt);
  }

  private agentReviewRecencyMs(entry: AgentReviewEntry): number {
    return Date.parse(entry.recordedAt);
  }

  private buildCheckpoint(seq: number): RunCheckpoint {
    return {
      schemaVersion: RUN_ANALYTICS_SCHEMA_VERSION,
      seq,
      sessions: this.serializeSessions(),
    };
  }

  private async readCheckpoint(): Promise<RunCheckpoint | null> {
    const { checkpoint, activeSlot } = await readCheckpointFromDisk(this.storageDir, parseCheckpoint);
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
    await this.mergeJsonlLogFiles(existingLegacyStorageDirs, 'outcome-history.jsonl');
    await this.mergeJsonlLogFiles(existingLegacyStorageDirs, 'agent-reviews.jsonl');
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
    const tmpPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    try {
      await fs.writeFile(tmpPath, mergedRaw, 'utf8');
      await fs.rename(tmpPath, targetPath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  private async mergeCheckpointStates(legacyStorageDirs: string[]): Promise<void> {
    const currentState = await readCheckpointFromDisk(this.storageDir, parseCheckpoint);
    const legacyStates = await Promise.all(
      legacyStorageDirs.map((legacyStorageDir) => readCheckpointFromDisk(legacyStorageDir, parseCheckpoint)),
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

      if (fileName === 'outcome-history.jsonl'
        && parsed.kind === 'run_outcome'
        && typeof parsed.runId === 'string') {
        return {
          key: `run_outcome:${parsed.runId}`,
          recency: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
        };
      }

      if (fileName === 'agent-reviews.jsonl'
        && parsed.kind === 'agent_review'
        && typeof parsed.runId === 'string') {
        return {
          key: `agent_review:${parsed.runId}`,
          recency: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '',
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
   *  exceeds {@link pruneByteThreshold} it is read and, if it holds more than
   *  {@link maxRunHistoryEntries} lines, rewritten to keep only the most recent
   *  N (atomic temp+rename). Pruning is rare (gated on byte size) so the steady
   *  per-persist cost stays a single `stat`; a failed prune is non-fatal (the
   *  file stays oversized and the next persist retries). */
  private async pruneHistoryIfNeeded(): Promise<void> {
    if (this.maxRunHistoryEntries <= 0) {
      return;
    }
    await Promise.all(
      ['run-snapshots.jsonl', 'outcome-history.jsonl', 'agent-reviews.jsonl'].map(
        (fileName) => this.pruneJsonlFile(fileName, this.maxRunHistoryEntries),
      ),
    );
  }

  private async pruneJsonlFile(fileName: string, maxEntries: number): Promise<void> {
    const filePath = path.join(this.storageDir, fileName);
    let size: number;
    try {
      size = (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (size < this.pruneByteThreshold) {
      return;
    }
    const raw = await readOptionalText(filePath);
    if (!raw) {
      return;
    }
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length <= maxEntries) {
      return;
    }
    const kept = lines.slice(lines.length - maxEntries);
    const tmpPath = path.join(
      this.storageDir,
      `.${fileName}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    try {
      await fs.writeFile(tmpPath, `${kept.join('\n')}\n`, 'utf8');
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => undefined);
      appendPieLog('warn', 'run-analytics', 'failed to prune history file', {
        file: fileName,
        error: toErrorMessage(error),
      });
    }
  }

  private async writeAutoExport(): Promise<void> {
    await exportRunAnalyticsStore(this.storageDir, this.autoExportPath, this.now);
  }

  private async writeAutoExportSafely(): Promise<void> {
    try {
      await this.writeAutoExport();
    } catch (error) {
      const message = toErrorMessage(error);
      appendPieLog('warn', 'run-analytics', 'failed to refresh auto-export', {
        path: this.autoExportPath,
        error: message,
      });
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}
