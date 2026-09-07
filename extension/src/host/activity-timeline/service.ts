import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ACTIVITY_INTERVAL_KINDS,
  type ActivityIntervalRecord,
} from '../../shared/activity-interval';
import { withFileUpdateLockSync } from '../../shared/settings-json-update';
import {
  accountingLockTarget,
  readAccountingPrivacySelectors,
} from '../billable-invocation-ledger/service';

/** Warm-up parsing yields to the extension-host event loop after scanning
 *  this many snapshot bytes, so initializing a very large timeline cannot
 *  monopolize the host. */
const WARM_SCAN_SLICE_BYTES = 256 * 1024;
/** Batched record parse/normalize boundary shared by warm and cold loads. */
const PARSE_BATCH_RECORDS = 2_048;
/** Async serializers yield after bounded record batches so compaction never
 *  performs its expensive stringify work in one extension-host turn. */
const SERIALIZE_BATCH_RECORDS = 512;
const JOURNAL_RESET_MARKER = { __activityTimeline: 'reset' } as const;

interface FileSignature {
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  /** File identity (inode / Windows file id). Used only to distinguish a
   *  safe in-place journal append from an actual replacement; 0 when the
   *  file does not exist or the platform cannot report it. */
  readonly ino: number;
}

/** Cumulative IO/accounting counters for the timeline, consumed by the
 *  StatsService startup-stage metrics (see getDiagnostics()). All fields are
 *  monotonically increasing totals for this instance. */
export type ActivityTimelineDiagnostics = {
  /** Full disk loads (snapshot + journal), including the async warm-up. */
  readonly readCount: number;
  readonly bytesRead: number;
  readonly readDurationMs: number;
  /** Full canonical snapshot rewrites (compaction, privacy/forget scrub). */
  readonly writeCount: number;
  /** Total actual IO bytes written: routine journal appends, canonical
   *  snapshot rewrites, recovery journals, and failed/conflicted staging
   *  attempts. Startup-stage metrics must never report 0 written bytes
   *  while routine journal appends dominate (e.g. migration heals). */
  readonly bytesWritten: number;
  /** Canonical snapshot rewrite bytes only (a subset of bytesWritten). */
  readonly snapshotBytesWritten: number;
  readonly writeDurationMs: number;
  readonly fsyncCount: number;
  readonly fsyncDurationMs: number;
  readonly applyMutationsCount: number;
  readonly applyMutationsDurationMs: number;
  /** Bounded delta-journal append cycles (one fsync each). */
  readonly journalAppendCount: number;
  readonly journalAppendedBytes: number;
  /** Journal compactions back into the canonical snapshot. */
  readonly journalCompactionCount: number;
  readonly journalCompactionBytes: number;
  readonly directoryFsyncCount: number;
  /** Signature revalidations that needed no disk read at all. */
  readonly cacheRevalidationHits: number;
  /** Incremental journal-tail replays: a sibling append on a warmed base
   *  whose snapshot/privacy signatures are unchanged reads only the tail. */
  readonly journalTailReplayCount: number;
  readonly journalTailReplayedBytes: number;
  /** Completed async warm-up loads (initialize()). */
  readonly initializeCount: number;
  readonly initializeDurationMs: number;
}

/** One structured in-memory mutation applied directly against the
 *  id-indexed cache, so routine events cost O(new records) instead of a
 *  full diff over a very large history. */
type TimelineMutation =
  | { readonly kind: 'start'; readonly records: readonly ActivityIntervalRecord[] }
  | { readonly kind: 'settle'; readonly intervalId: string; readonly endedAt: string; readonly outcome: NonNullable<ActivityIntervalRecord['outcome']> }
  | { readonly kind: 'forget'; readonly sessionPath: string; readonly sessionId?: string };

/** Durable, cross-process-safe activity timeline. A canonical compact
 *  snapshot is rewritten only for compaction and privacy/forget scrubs;
 *  routine start/settle/recordMany mutations append a bounded JSONL delta
 *  journal (`<snapshot>.journal.jsonl`) under the same transaction lock as
 *  usage, checkpoints, privacy, forget, and exports. Every access
 *  revalidates the snapshot/journal/privacy signatures before publishing, so
 *  sibling hosts and external replacements are never served stale, and
 *  scrubbed data is never resurrected. When only the journal grew safely in
 *  place (same inode, larger size), revalidation replays just the unconsumed
 *  journal tail instead of rereading the full snapshot. Stable interval ids
 *  make starts/settlements idempotent; journal replay keeps first settlement
 *  immutable. */
export class ActivityTimeline {
  private readonly storageDir: string;
  private readonly journalPath: string;
  private readonly privacyPath: string;
  private readonly lockTarget: string;
  private readonly pendingMutations: TimelineMutation[] = [];
  /** Canonical in-memory projection, already filtered by the durable privacy
   *  fence at load; treated as immutable by callers. */
  /** Mutable internal projection; callers only receive published immutable
   *  snapshots so index updates do not copy a huge history on every event. */
  private records: ActivityIntervalRecord[] = [];
  private publishedRecords: readonly ActivityIntervalRecord[] | null = Object.freeze([]);
  private recordsById = new Map<string, ActivityIntervalRecord>();
  /** intervalId → index into {@link records}; enables O(1) settlements. */
  private indexById = new Map<string, number>();
  private loaded = false;
  private snapshotSignature?: FileSignature;
  private journalSignature?: FileSignature;
  private privacySignature?: FileSignature;
  /** Journal lines represented by the in-memory state; drives compaction. */
  private journalLines = 0;
  /** Journal bytes already replayed into the in-memory state; enables the
   *  incremental tail replay in ensureLoaded(). 0 means the journal prefix
   *  is not trusted (missing journal or a replacement was staged). */
  private journalReplayedBytes = 0;
  /** Set when a signature-gated reload dropped privacy-fenced records that
   *  still exist in the durable snapshot/journal; the next mutation must
   *  scrub them physically even if the mutation itself changed nothing. */
  private pendingScrub = false;
  private initializationPromise: Promise<void> | null = null;
  private compactionPromise: Promise<boolean> | null = null;
  /** Bounds retry-queue flushes so a persistently failing write cannot turn
   *  every projection/export into a full-file rewrite attempt. */
  private lastPendingRetryAt = 0;
  private pendingRetryScheduled = false;
  private readonly now: () => number;
  private static readonly PENDING_RETRY_BACKOFF_MS = 1_000;
  private readonly diagnostics: {
    -readonly [K in keyof ActivityTimelineDiagnostics]: ActivityTimelineDiagnostics[K];
  } = {
    readCount: 0,
    bytesRead: 0,
    readDurationMs: 0,
    writeCount: 0,
    bytesWritten: 0,
    snapshotBytesWritten: 0,
    writeDurationMs: 0,
    fsyncCount: 0,
    fsyncDurationMs: 0,
    applyMutationsCount: 0,
    applyMutationsDurationMs: 0,
    journalAppendCount: 0,
    journalAppendedBytes: 0,
    journalCompactionCount: 0,
    journalCompactionBytes: 0,
    directoryFsyncCount: 0,
    cacheRevalidationHits: 0,
    journalTailReplayCount: 0,
    journalTailReplayedBytes: 0,
    initializeCount: 0,
    initializeDurationMs: 0,
  };

  constructor(private readonly filePath: string, options: { now?: () => number } = {}) {
    this.storageDir = path.dirname(filePath);
    const journalBase = filePath.endsWith('.json') ? filePath.slice(0, -'.json'.length) : filePath;
    this.journalPath = `${journalBase}.journal.jsonl`;
    this.privacyPath = path.join(this.storageDir, 'accounting-private-sessions.json');
    this.now = options.now ?? Date.now;
    this.lockTarget = accountingLockTarget(this.storageDir);
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  start(record: ActivityIntervalRecord, options: { durableRequired?: boolean } = {}): void {
    this.mutate({ kind: 'start', records: [record] }, options.durableRequired === true);
  }

  settle(
    intervalId: string,
    endedAt: string,
    outcome: NonNullable<ActivityIntervalRecord['outcome']>,
  ): void {
    this.mutate({ kind: 'settle', intervalId, endedAt, outcome });
  }

  record(record: ActivityIntervalRecord, options: { durableRequired?: boolean } = {}): void {
    this.start(record, options);
  }

  /** Apply many interval records in a single durable mutation cycle. The
   *  startup heal uses this so re-deriving N intervals costs one journal
   *  append (or one bounded compaction) instead of per-record writes.
   *  Idempotent per intervalId, like start(). */
  recordMany(
    records: readonly ActivityIntervalRecord[],
    options: { durableRequired?: boolean } = {},
  ): boolean {
    if (records.length === 0) return false;
    return this.mutate({ kind: 'start', records }, options.durableRequired === true);
  }

  flush(): void {
    if (this.pendingMutations.length === 0) return;
    // An explicit flush is a caller-requested durability boundary. It must
    // bypass the automatic retry window and surface a failure to its caller.
    try {
      this.applyMutations(this.pendingMutations);
      this.pendingMutations.length = 0;
      this.pendingRetryScheduled = false;
    } catch (error) {
      this.notePendingRetry();
      throw error;
    }
  }

  projectSession(sessionPath: string): readonly ActivityIntervalRecord[] {
    return Object.freeze(this.read().filter((record) => record.sessionPath === sessionPath));
  }

  projectAll(): readonly ActivityIntervalRecord[] {
    return this.read();
  }

  forgetSession(sessionPath: string, sessionId?: string): void {
    this.mutate({ kind: 'forget', sessionPath, sessionId }, true);
  }

  /**
   * Warm the durable timeline without monopolizing the extension host. Reads
   * the legacy snapshot and delta journal with bounded event-loop
   * parsing/normalization (no lock is held across yields), then merges the
   * staged result into memory under the shared workspace lock. The
   * synchronous API remains available for event handlers and uses the
   * signature-gated cache after this initial load.
   */
  async initialize(): Promise<void> {
    if (this.loaded) {
      this.withLock(() => { this.ensureLoaded(); });
      return;
    }
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }
    this.initializationPromise = this.initializeDurable().finally(() => {
      this.initializationPromise = null;
    });
    await this.initializationPromise;
  }

  /** Cumulative IO diagnostics for the StatsService startup-stage metrics. */
  getDiagnostics(): ActivityTimelineDiagnostics {
    return { ...this.diagnostics };
  }

  /** Explicit background compaction boundary. Routine mutations append only;
   *  callers choose a safe lifecycle point for this bounded async rewrite. A
   *  conflicting writer causes a bounded retry, never an automatic retry loop. */
  compact(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.compactionPromise) return this.compactionPromise;
    this.compactionPromise = this.compactDurable(options).finally(() => {
      this.compactionPromise = null;
    });
    return this.compactionPromise;
  }

  private read(): readonly ActivityIntervalRecord[] {
    this.flushPending();
    return this.withLock(() => {
      this.ensureLoaded();
      if (!this.publishedRecords || this.publishedRecords.length !== this.records.length) {
        this.publishedRecords = Object.freeze(this.records.slice());
      }
      return this.publishedRecords;
    });
  }

  private mutate(mutation: TimelineMutation, durableRequired = false): boolean {
    // A new best-effort mutation may join the queue, but it must not turn a
    // persistent failure into an immediate full-file rewrite on every event.
    // Durable mutations deliberately bypass this gate and fail synchronously.
    if (!durableRequired && this.pendingMutations.length > 0 && !this.pendingRetryDue()) {
      this.pendingMutations.push(mutation);
      return false;
    }

    const pending = [...this.pendingMutations, mutation];
    try {
      const changed = this.applyMutations(pending);
      this.pendingMutations.length = 0;
      this.pendingRetryScheduled = false;
      return changed;
    } catch (error) {
      if (durableRequired) throw error;
      this.pendingMutations.push(mutation);
      this.notePendingRetry();
      return false;
    }
  }

  private flushPending(): void {
    if (this.pendingMutations.length === 0 || !this.pendingRetryDue()) return;
    try {
      this.applyMutations(this.pendingMutations);
      this.pendingMutations.length = 0;
      this.pendingRetryScheduled = false;
    } catch {
      // Retry on the next mutation/projection, but never more often than the
      // backoff window so a persistent failure cannot hot-loop full rewrites.
      this.notePendingRetry();
    }
  }

  private pendingRetryDue(): boolean {
    return !this.pendingRetryScheduled
      || this.now() - this.lastPendingRetryAt >= ActivityTimeline.PENDING_RETRY_BACKOFF_MS;
  }

  private notePendingRetry(): void {
    this.lastPendingRetryAt = this.now();
    this.pendingRetryScheduled = true;
  }

  private async compactDurable(options: { signal?: AbortSignal }): Promise<boolean> {
    // A compaction must not strand best-effort mutations behind a staged
    // rewrite. This is an explicit caller boundary, so surface a pending
    // durability failure rather than silently dropping it.
    this.flush();
    const signal = options.signal;
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) return false;
      const stagedInput = this.withLock(() => {
        this.ensureLoaded();
        const snapshotSignature = readFileSignature(this.filePath);
        const journalSignature = readFileSignature(this.journalPath);
        const privacySignature = readFileSignature(this.privacyPath);
        if (!journalSignature.exists && !this.pendingScrub) return null;
        return {
          snapshotSignature,
          journalSignature,
          privacySignature,
          privacy: readAccountingPrivacySelectors(this.storageDir),
        };
      });
      if (!stagedInput) return false;

      let snapshotTemp: string | undefined;
      let journalTemp: string | undefined;
      let snapshotAccounted = 0;
      let journalAccounted = 0;
      let journalRenamed = false;
      try {
        const readStartedAtMs = this.now();
        const [snapshotContent, journalContent] = await Promise.all([
          readTextOrNull(this.filePath),
          readTextOrNull(this.journalPath),
        ]);
        const staged = new Map<string, ActivityIntervalRecord>();
        let bytesRead = 0;
        if (snapshotContent !== null) {
          assertSnapshotShape(snapshotContent);
          bytesRead += await scanSnapshotContentWarm(snapshotContent, staged, signal);
        }
        if (journalContent !== null) {
          bytesRead += (await replayJournalContentWarm(staged, journalContent, signal)).bytes;
        }
        this.diagnostics.bytesRead += bytesRead;
        this.diagnostics.readCount += 1;
        this.diagnostics.readDurationMs += Math.max(0, this.now() - readStartedAtMs);

        const permitted = (record: ActivityIntervalRecord): boolean => !stagedInput.privacy.some((selector) => (
          (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
          || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
        ));
        // Bounded-yield filter pass: filtering a very large staged history
        // must not monopolize the extension-host event loop.
        const { filtered } = await filterRecordsWarm(staged.values(), permitted, signal);
        if (signal?.aborted) return false;

        fs.mkdirSync(this.storageDir, { recursive: true });
        const rewriteStartedAtMs = this.now();
        snapshotTemp = `${this.filePath}.${randomUUID()}.tmp`;
        journalTemp = `${this.journalPath}.${randomUUID()}.tmp`;
        const stagedCache = await buildCacheWarm(filtered, signal);
        const snapshotBytes = await writeTempRecordsFile(snapshotTemp, filtered, 'snapshot', signal);
        snapshotAccounted = snapshotBytes;
        this.diagnostics.bytesWritten += snapshotBytes;
        this.diagnostics.snapshotBytesWritten += snapshotBytes;
        const recoveryJournalBytes = await writeTempRecordsFile(journalTemp, filtered, 'journal', signal);
        journalAccounted = recoveryJournalBytes;
        this.diagnostics.bytesWritten += recoveryJournalBytes;
        await this.fsyncFileAsync(snapshotTemp);
        await this.fsyncFileAsync(journalTemp);

        const committed = this.withLock(() => {
          if (signal?.aborted || this.pendingMutations.length > 0) return false;
          if (!sameFileSignature(stagedInput.snapshotSignature, readFileSignature(this.filePath))
            || !sameFileSignature(stagedInput.journalSignature, readFileSignature(this.journalPath))
            || !sameFileSignature(stagedInput.privacySignature, readFileSignature(this.privacyPath))) {
            return false;
          }
          // Publish the recovery journal first. If the host stops between
          // these renames, replay sees the reset marker and the complete
          // staged state instead of resurrecting an old journal delta.
          fs.renameSync(journalTemp as string, this.journalPath);
          journalTemp = undefined;
          journalRenamed = true;
          this.fsyncDirectory();
          fs.renameSync(snapshotTemp as string, this.filePath);
          snapshotTemp = undefined;
          this.fsyncDirectory();
          this.unlinkJournalDurable();
          this.records = stagedCache.records;
          this.publishedRecords = stagedCache.publishedRecords;
          this.recordsById = stagedCache.recordsById;
          this.indexById = stagedCache.indexById;
          this.loaded = true;
          this.pendingScrub = false;
          this.journalLines = 0;
          this.snapshotSignature = readFileSignature(this.filePath);
          this.journalSignature = readFileSignature(this.journalPath);
          this.privacySignature = readFileSignature(this.privacyPath);
          this.diagnostics.writeCount += 1;
          this.diagnostics.writeDurationMs += Math.max(0, this.now() - rewriteStartedAtMs);
          this.diagnostics.journalCompactionCount += 1;
          this.diagnostics.journalCompactionBytes += recoveryJournalBytes;
          return true;
        });
        if (committed) return true;
      } catch (error) {
        // Failed or conflicted attempts still cost real IO; count staging
        // bytes that never reached the success-path accounting.
        this.accountPartialTempWrites(snapshotTemp, snapshotAccounted, true);
        this.accountPartialTempWrites(journalTemp, journalAccounted, false);
        if (journalRenamed) {
          // The on-disk journal is now a replacement state (reset marker plus
          // records), not an append over the consumed prefix. Force the next
          // revalidation to replay from the marker instead of trusting the
          // consumed-tail offset.
          this.journalReplayedBytes = 0;
        }
        if (signal?.aborted) return false;
        throw error;
      } finally {
        if (snapshotTemp) try { fs.unlinkSync(snapshotTemp); } catch { /* best effort */ }
        if (journalTemp) try { fs.unlinkSync(journalTemp); } catch { /* best effort */ }
      }

      // Conflict is expected under a busy writer. Retry once after yielding,
      // but never schedule another attempt from a mutation/projection.
      if (attempt + 1 < maxAttempts) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return false;
  }

  private applyMutations(updates: readonly TimelineMutation[]): boolean {
    const startedAtMs = this.now();
    this.diagnostics.applyMutationsCount += 1;
    try {
      return this.withLock(() => {
        // Signature revalidation happens before every durable publish, so a
        // stale cache can never append atop or rewrite over sibling-host
        // mutations, privacy fences, or external snapshot replacements.
        this.ensureLoaded();
        const privacy = readAccountingPrivacySelectors(this.storageDir);
        const permitted = (record: ActivityIntervalRecord): boolean => !privacy.some((selector) => (
          (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
          || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
        ));
        const added: ActivityIntervalRecord[] = [];
        const settled: ActivityIntervalRecord[] = [];
        let removalDetected = false;
        // Each applied in-memory change pushes an O(1) revert; a failed
        // durable append (or a malformed record mid-batch) rolls the cache
        // back so it never runs ahead of the canonical disk state.
        const undo: Array<() => void> = [];
        const previousPublishedRecords = this.publishedRecords;
        try {
        for (const mutation of updates) {
          if (mutation.kind === 'start') {
            const batchAdded: ActivityIntervalRecord[] = [];
            const batchSeen = new Set<string>();
            for (const record of mutation.records) {
              const normalized = normalize(record);
              if (this.recordsById.has(normalized.intervalId) || batchSeen.has(normalized.intervalId)) continue;
              // Fenced sessions are never durable (matching the legacy
              // write-time privacy filter); first evidence stays immutable.
              if (!permitted(normalized)) continue;
              batchSeen.add(normalized.intervalId);
              batchAdded.push(normalized);
            }
            if (batchAdded.length > 0) {
              // One array copy per mutation, not per record: a large
              // recordMany must stay O(snapshot + batch), never O(n·k).
              const previousLength = this.records.length;
              for (const normalized of batchAdded) this.records.push(normalized);
              this.publishedRecords = null;
              batchAdded.forEach((normalized, offset) => {
                this.recordsById.set(normalized.intervalId, normalized);
                this.indexById.set(normalized.intervalId, previousLength + offset);
              });
              undo.push(() => {
                this.records.length = previousLength;
                for (const normalized of batchAdded) {
                  this.recordsById.delete(normalized.intervalId);
                  this.indexById.delete(normalized.intervalId);
                }
              });
              for (const normalized of batchAdded) added.push(normalized);
            }
          } else if (mutation.kind === 'settle') {
            const index = this.indexById.get(mutation.intervalId);
            const existing = index === undefined ? undefined : this.records[index];
            if (index === undefined || !existing || existing.endedAt) continue;
            const nextRecord = normalize({ ...existing, endedAt: mutation.endedAt, outcome: mutation.outcome });
            const previousRecord = this.records[index];
            this.records[index] = nextRecord;
            this.publishedRecords = null;
            this.recordsById.set(nextRecord.intervalId, nextRecord);
            undo.push(() => {
              this.records[index] = previousRecord;
              this.recordsById.set(existing.intervalId, existing);
            });
            settled.push(nextRecord);
          } else {
            const kept = this.records.filter((record) => record.sessionPath !== mutation.sessionPath
              && (!mutation.sessionId || record.sessionId !== mutation.sessionId));
            if (kept.length !== this.records.length) {
              const previousRecords = this.records;
              const previousById = this.recordsById;
              const previousIndexById = this.indexById;
              this.replaceCache(kept);
              removalDetected = true;
              undo.push(() => {
                this.records = previousRecords;
                this.recordsById = previousById;
                this.indexById = previousIndexById;
              });
            }
          }
        }
        const scrubDue = this.pendingScrub;
        if (added.length === 0 && settled.length === 0 && !removalDetected && !scrubDue) {
          return false;
        }
        if (removalDetected || scrubDue) {
          // Privacy and forget are synchronous durability boundaries. Routine
          // additions/settlements never rewrite a large canonical snapshot;
          // callers use compact() at an explicit background boundary.
          this.pendingScrub = false;
          try {
            this.writeUnlocked(this.records);
          } catch (error) {
            // A failed durable scrub must not lose the pending flag, or the
            // fenced records would silently remain in the durable files.
            if (scrubDue) this.pendingScrub = true;
            throw error;
          }
          this.journalLines = 0;
          return true;
        }
        const journalLines: ActivityIntervalRecord[] = [];
        for (const record of added) journalLines.push(record);
        for (const record of settled) journalLines.push(record);
        this.appendJournalUnlocked(journalLines);
        return true;
        } catch (error) {
          for (let index = undo.length - 1; index >= 0; index -= 1) undo[index]();
          this.publishedRecords = previousPublishedRecords;
          throw error;
        }
      });
    } finally {
      this.diagnostics.applyMutationsDurationMs += Math.max(0, this.now() - startedAtMs);
    }
  }

  /** Signature-gated cache check; caller holds the workspace lock. A warm
   *  cache whose snapshot/privacy signatures are unchanged and whose journal
   *  only grew safely in place (same file identity/inode, larger size) replays
   *  just the unconsumed journal tail, so sibling appends on a large warmed
   *  base never reread the full snapshot. Every other invalidation — no warm
   *  cache yet (initialize() has not completed), snapshot/privacy change,
   *  journal truncation or replacement — falls back to the full synchronous
   *  load. Remaining limitation: an external writer that rewrites the journal
   *  in place while growing it is indistinguishable from a safe append by
   *  signatures alone; this service itself only ever appends or replaces the
   *  journal by rename paired with a snapshot change or reset-marker
   *  fallback. */
  private ensureLoaded(): void {
    const snapshotSignature = readFileSignature(this.filePath);
    const journalSignature = readFileSignature(this.journalPath);
    const privacySignature = readFileSignature(this.privacyPath);
    if (this.loaded
      && sameFileSignature(this.snapshotSignature as FileSignature, snapshotSignature)
      && sameFileSignature(this.journalSignature as FileSignature, journalSignature)
      && sameFileSignature(this.privacySignature as FileSignature, privacySignature)) {
      this.diagnostics.cacheRevalidationHits += 1;
      return;
    }
    if (this.loaded
      && sameFileSignature(this.snapshotSignature as FileSignature, snapshotSignature)
      && sameFileSignature(this.privacySignature as FileSignature, privacySignature)
      && this.journalTailReplayEligible(this.journalSignature as FileSignature | undefined, journalSignature)) {
      this.replayJournalTail(journalSignature);
      return;
    }
    this.reloadUnlocked();
  }

  /** Full canonical synchronous reload (cold cache, snapshot/privacy change,
   *  journal truncation or replacement). Caller holds the workspace lock. */
  private reloadUnlocked(): void {
    const privacy = readAccountingPrivacySelectors(this.storageDir);
    const permitted = (record: ActivityIntervalRecord): boolean => !privacy.some((selector) => (
      (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
      || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
    ));
    const loaded = this.readUnlocked();
    const filtered = loaded.filter(permitted);
    if (filtered.length !== loaded.length) this.pendingScrub = true;
    this.replaceCache(filtered);
    // Re-stat after reading to narrow the read/race window, mirroring the
    // ledger's reloadDurable signature discipline.
    this.snapshotSignature = readFileSignature(this.filePath);
    this.journalSignature = readFileSignature(this.journalPath);
    this.privacySignature = readFileSignature(this.privacyPath);
    this.journalReplayedBytes = this.journalSignature.exists ? this.journalSignature.size : 0;
  }

  /** A journal tail replay is safe only when the journal grew in place: same
   *  identity/inode (> 0), strictly larger size, and the in-memory state
   *  actually consumed exactly the previous signature's byte prefix. A
   *  truncated, replaced, or not-yet-consumed journal forces the full
   *  synchronous fallback. */
  private journalTailReplayEligible(previous: FileSignature | undefined, current: FileSignature): boolean {
    if (!previous || !previous.exists || !current.exists) return false;
    if (current.size <= previous.size) return false;
    if (previous.ino <= 0 || previous.ino !== current.ino) return false;
    return this.journalReplayedBytes === previous.size;
  }

  /** Replay only the journal bytes after the consumed prefix onto the live
   *  cache. Caller holds the workspace lock. Any anomaly (vanished journal,
   *  short read, reset marker in the tail) falls back to reloadUnlocked().
   *  Fenced tail records are skipped and set pendingScrub, matching the
   *  full-load privacy fence. */
  private replayJournalTail(current: FileSignature): void {
    const startedAtMs = this.now();
    const offset = this.journalReplayedBytes;
    this.diagnostics.readCount += 1;
    let tailBytes = 0;
    let tailContent: string | null = null;
    try {
      const fd = fs.openSync(this.journalPath, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) {
          this.reloadUnlocked();
          return;
        }
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
          const chunk = fs.readSync(fd, buffer, read, length - read, offset + read);
          if (chunk <= 0) break;
          read += chunk;
        }
        if (read !== length) {
          this.reloadUnlocked();
          return;
        }
        tailBytes = length;
        tailContent = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.reloadUnlocked();
        return;
      }
      throw error;
    } finally {
      this.diagnostics.bytesRead += tailBytes;
      this.diagnostics.readDurationMs += Math.max(0, this.now() - startedAtMs);
    }
    if (tailContent === null || tailBytes === 0) {
      this.journalSignature = current;
      return;
    }
    const privacy = readAccountingPrivacySelectors(this.storageDir);
    const permitted = (record: ActivityIntervalRecord): boolean => !privacy.some((selector) => (
      (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
      || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
    ));
    let changed = false;
    let lineCount = 0;
    let sawResetMarker = false;
    const batch: string[] = [];
    const applyBatch = (): void => {
      if (batch.length === 0) return;
      const candidates = parseJournalCandidates(batch.splice(0, batch.length));
      for (const candidate of candidates) {
        if (isJournalResetMarker(candidate)) {
          sawResetMarker = true;
          return;
        }
        try {
          const record = normalize(candidate);
          const index = this.indexById.get(record.intervalId);
          if (index === undefined) {
            if (!permitted(record)) {
              this.pendingScrub = true;
              continue;
            }
            this.records.push(record);
            this.recordsById.set(record.intervalId, record);
            this.indexById.set(record.intervalId, this.records.length - 1);
            changed = true;
          } else {
            const existing = this.records[index];
            if (existing && !existing.endedAt && record.endedAt) {
              this.records[index] = record;
              this.recordsById.set(record.intervalId, record);
              changed = true;
            }
          }
        } catch { /* malformed records do not hide valid siblings */ }
      }
    };
    for (const line of tailContent.split('\n')) {
      if (sawResetMarker) break;
      if (!line.trim()) continue;
      batch.push(line);
      lineCount += 1;
      if (batch.length >= PARSE_BATCH_RECORDS) applyBatch();
    }
    applyBatch();
    if (sawResetMarker) {
      // A reset marker replaces the whole journal state; only a full reload
      // applies its clear semantics correctly.
      this.reloadUnlocked();
      return;
    }
    if (changed) this.publishedRecords = null;
    this.journalLines += lineCount;
    this.diagnostics.journalTailReplayCount += 1;
    this.diagnostics.journalTailReplayedBytes += tailBytes;
    this.journalReplayedBytes = offset + tailBytes;
    this.journalSignature = readFileSignature(this.journalPath);
  }

  private replaceCache(records: readonly ActivityIntervalRecord[]): void {
    const internal = Array.from(records);
    this.records = internal;
    this.publishedRecords = Object.freeze(internal.slice());
    this.recordsById = new Map(internal.map((record) => [record.intervalId, record]));
    this.indexById = new Map(internal.map((record, index) => [record.intervalId, index]));
    this.loaded = true;
  }

  /** Full canonical disk load: legacy snapshot plus delta journal replay.
   *  Caller holds the workspace lock; this is the synchronous cold fallback
   *  (and the reload path when signatures change under a warm cache). */
  private readUnlocked(): ActivityIntervalRecord[] {
    const startedAtMs = this.now();
    this.diagnostics.readCount += 1;
    let bytesRead = 0;
    const byId = new Map<string, ActivityIntervalRecord>();
    try {
      const snapshotContent = readTextSync(this.filePath);
      if (snapshotContent !== null) {
        bytesRead += Buffer.byteLength(snapshotContent, 'utf8');
        assertSnapshotShape(snapshotContent);
        this.scanSnapshotContent(snapshotContent, (record) => absorbRecord(byId, record));
      }
      const journalContent = readTextSync(this.journalPath);
      if (journalContent !== null) {
        bytesRead += Buffer.byteLength(journalContent, 'utf8');
        this.journalLines = replayJournalContent(byId, journalContent);
      } else {
        this.journalLines = 0;
      }
    } finally {
      this.diagnostics.bytesRead += bytesRead;
      this.diagnostics.readDurationMs += Math.max(0, this.now() - startedAtMs);
    }
    return [...byId.values()];
  }

  /** Extract top-level array elements and parse/normalize them in bounded
   *  batches; malformed elements never hide valid siblings. */
  private scanSnapshotContent(
    content: string,
    sink: (record: ActivityIntervalRecord) => void,
  ): void {
    const state = createArrayScanState();
    scanJsonArrayChunk(content, state, content.length, (batch) => {
      parseRecordsBatch(batch, sink);
    });
    if (state.batch.length > 0) {
      const tail = state.batch;
      state.batch = [];
      parseRecordsBatch(tail, sink);
    }
  }

  /** Append canonical journal lines in one fsynced write cycle. Journal lines
   *  are full normalized records; replay is idempotent by intervalId with
   *  first-settlement-wins semantics. */
  private appendJournalUnlocked(lines: readonly ActivityIntervalRecord[]): void {
    if (lines.length === 0) return;
    const payload = `${lines.map((record) => JSON.stringify(record)).join('\n')}\n`;
    fs.mkdirSync(this.storageDir, { recursive: true });
    const fd = fs.openSync(this.journalPath, 'a+');
    let writtenBytes = 0;
    try {
      const size = fs.fstatSync(fd).size;
      let prefix = '';
      if (size > 0) {
        const tail = Buffer.allocUnsafe(1);
        fs.readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      const appendPayload = `${prefix}${payload}`;
      const appendBytes = Buffer.byteLength(appendPayload, 'utf8');
      writtenBytes = writeAllSync(fd, Buffer.from(appendPayload, 'utf8'));
      this.fsyncFd(fd);
      if (size === 0) this.fsyncDirectory();
      // Total written IO includes routine journal appends: startup-stage
      // metrics must not report 0 written bytes during journal-only phases.
      this.diagnostics.bytesWritten += writtenBytes;
      this.diagnostics.journalAppendedBytes += appendBytes;
    } catch (error) {
      this.diagnostics.bytesWritten += writtenBytes;
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    this.journalSignature = readFileSignature(this.journalPath);
    this.journalReplayedBytes = this.journalSignature.exists ? this.journalSignature.size : 0;
    this.journalLines += lines.length;
    this.diagnostics.journalAppendCount += 1;
  }

  /** Full canonical snapshot rewrite (privacy/forget scrub). It publishes a
   *  reset-marker recovery journal before replacing the snapshot, so a crash
   *  cannot resurrect the pre-scrub journal. The normal mutation path never
   *  calls this for periodic compaction; compact() stages the same protocol
   *  outside the shared lock. */
  private writeUnlocked(records: readonly ActivityIntervalRecord[]): void {
    const startedAtMs = this.now();
    this.diagnostics.writeCount += 1;
    const payload = `${JSON.stringify(records, null, 2)}\n`;
    const recoveryJournal = buildRecoveryJournalPayload(records);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const recoveryBytes = Buffer.byteLength(recoveryJournal, 'utf8');
    const snapshotTemp = `${this.filePath}.${randomUUID()}.tmp`;
    const journalTemp = `${this.journalPath}.${randomUUID()}.tmp`;
    let snapshotCounted = 0;
    let journalCounted = 0;
    let journalReplaced = false;
    try {
      fs.writeFileSync(snapshotTemp, payload, { encoding: 'utf8', flag: 'wx' });
      snapshotCounted = payloadBytes;
      this.diagnostics.bytesWritten += payloadBytes;
      this.diagnostics.snapshotBytesWritten += payloadBytes;
      const snapshotFd = fs.openSync(snapshotTemp, 'r+');
      try { this.fsyncFd(snapshotFd); } finally { fs.closeSync(snapshotFd); }
      fs.writeFileSync(journalTemp, recoveryJournal, { encoding: 'utf8', flag: 'wx' });
      journalCounted = recoveryBytes;
      this.diagnostics.bytesWritten += recoveryBytes;
      const journalFd = fs.openSync(journalTemp, 'r+');
      try { this.fsyncFd(journalFd); } finally { fs.closeSync(journalFd); }

      // The marker plus complete replacement state makes either side of the
      // two-file commit recoverable. In particular [] is a durable tombstone,
      // not an unlink-before-journal-reset crash window.
      fs.renameSync(journalTemp, this.journalPath);
      journalReplaced = true;
      this.fsyncDirectory();
      fs.renameSync(snapshotTemp, this.filePath);
      this.fsyncDirectory();
      this.unlinkJournalDurable();
      this.snapshotSignature = readFileSignature(this.filePath);
      this.journalSignature = readFileSignature(this.journalPath);
      this.diagnostics.journalCompactionBytes += recoveryBytes;
    } catch (error) {
      if (journalReplaced) {
        // The on-disk journal is now a replacement state (reset marker plus
        // records), not an append over the consumed prefix. Force the next
        // revalidation to replay from the marker instead of trusting the
        // consumed-tail offset.
        this.journalReplayedBytes = 0;
      }
      // Failed attempts still cost real IO; count bytes that never reached
      // the success-path accounting.
      this.accountPartialTempWrites(snapshotTemp, snapshotCounted, true);
      this.accountPartialTempWrites(journalTemp, journalCounted, false);
      try { fs.unlinkSync(snapshotTemp); } catch { /* best effort */ }
      try { fs.unlinkSync(journalTemp); } catch { /* best effort */ }
      throw error;
    } finally {
      this.diagnostics.writeDurationMs += Math.max(0, this.now() - startedAtMs);
    }
  }

  /** Count staging bytes that were written to disk but never reached the
   *  success-path accounting (partial writes on failed attempts), so
   *  bytesWritten always reflects total actual IO. */
  private accountPartialTempWrites(tempPath: string | undefined, countedBytes: number, snapshot: boolean): void {
    if (!tempPath) return;
    try {
      const unaccounted = fs.statSync(tempPath).size - countedBytes;
      if (unaccounted > 0) {
        this.diagnostics.bytesWritten += unaccounted;
        if (snapshot) this.diagnostics.snapshotBytesWritten += unaccounted;
      }
    } catch { /* the temp file may already be gone */ }
  }

  /** Drop the delta journal after its replacement snapshot is durable. */
  private unlinkJournalDurable(): void {
    try { fs.unlinkSync(this.journalPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.journalLines = 0;
    this.journalReplayedBytes = 0;
    this.fsyncDirectory();
    this.journalSignature = readFileSignature(this.journalPath);
  }

  private fsyncDirectory(): void {
    try {
      const fd = fs.openSync(this.storageDir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.diagnostics.directoryFsyncCount += 1;
    } catch {
      // Some Windows/filesystem combinations cannot fsync directories. The
      // fully-fsynced files and atomic renames remain the strongest primitive.
    }
  }

  private async fsyncFileAsync(filePath: string): Promise<void> {
    const startedAtMs = this.now();
    const handle = await fs.promises.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
      this.diagnostics.fsyncCount += 1;
      this.diagnostics.fsyncDurationMs += Math.max(0, this.now() - startedAtMs);
    }
  }

  private fsyncFd(fd: number): void {
    const startedAtMs = this.now();
    try {
      fs.fsyncSync(fd);
    } finally {
      this.diagnostics.fsyncCount += 1;
      this.diagnostics.fsyncDurationMs += Math.max(0, this.now() - startedAtMs);
    }
  }

  private withLock<T>(action: () => T): T {
    return withFileUpdateLockSync(this.lockTarget, action);
  }

  /** Asynchronous warm-up: bounded incremental snapshot scan and journal
   *  replay with event-loop yields, then one synchronous commit under the
   *  workspace lock. A warm-up superseded by sibling changes or a live
   *  synchronous load never overwrites the live cache. */
  private async initializeDurable(): Promise<void> {
    const startedAtMs = this.now();
    this.diagnostics.initializeCount += 1;
    const snapshotBefore = readFileSignature(this.filePath);
    const journalBefore = readFileSignature(this.journalPath);
    const privacyBefore = readFileSignature(this.privacyPath);
    const privacyBeforeSelectors = readAccountingPrivacySelectors(this.storageDir);
    const [snapshotContent, journalContent] = await Promise.all([
      readTextOrNull(this.filePath),
      readTextOrNull(this.journalPath),
    ]);
    const staged = new Map<string, ActivityIntervalRecord>();
    let journalLineCount = 0;
    let bytesRead = 0;
    const readStartedAtMs = this.now();
    if (snapshotContent !== null) {
      assertSnapshotShape(snapshotContent);
      bytesRead += await scanSnapshotContentWarm(snapshotContent, staged);
    }
    if (journalContent !== null) {
      const replay = await replayJournalContentWarm(staged, journalContent);
      bytesRead += replay.bytes;
      journalLineCount = replay.lines;
    }
    this.diagnostics.bytesRead += bytesRead;
    this.diagnostics.readCount += 1;
    this.diagnostics.readDurationMs += Math.max(0, this.now() - readStartedAtMs);
    const initialPermitted = (record: ActivityIntervalRecord): boolean => !privacyBeforeSelectors.some((selector) => (
      (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
      || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
    ));
    // Bounded-yield privacy filter over the staged history (no full-array
    // copy and no single-turn 200k+ iteration on the host event loop).
    const { filtered: initiallyFiltered, total: stagedTotal } = await filterRecordsWarm(
      staged.values(),
      initialPermitted,
    );
    const initialCache = await buildCacheWarm(initiallyFiltered);

    // Commit under the shared workspace lock; parsing and IO above never
    // hold it. Revalidate every signature before publish.
    this.withLock(() => {
      const snapshotNow = readFileSignature(this.filePath);
      if (!sameFileSignature(snapshotBefore, snapshotNow)) {
        // A loaded cache must immediately revalidate the replacement; a cold
        // cache stays cold so its next synchronous access reads canonical disk.
        if (this.loaded) this.ensureLoaded();
        return;
      }
      const journalNow = readFileSignature(this.journalPath);
      const privacyNow = readFileSignature(this.privacyPath);
      const privacyChanged = !sameFileSignature(privacyBefore, privacyNow);
      if (privacyChanged) {
        // Do not merge a staged parse into a cache loaded under a different
        // privacy fence. Reload a loaded cache; leave a cold cache cold so
        // its next synchronous access reads the exact current disk state.
        if (this.loaded) this.ensureLoaded();
        return;
      }
      const privacy = readAccountingPrivacySelectors(this.storageDir);
      const permitted = (record: ActivityIntervalRecord): boolean => !privacy.some((selector) => (
        (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
        || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
      ));

      if (this.loaded) {
        // A synchronous caller loaded (and possibly mutated) during the
        // warm-up. Filter that live cache before merging staged data: a fence
        // may have been created after the synchronous load but before commit.
        const liveFiltered = this.records.filter(permitted);
        if (liveFiltered.length !== this.records.length) {
          this.replaceCache(liveFiltered);
          this.pendingScrub = true;
        }
        const additions: ActivityIntervalRecord[] = [];
        for (const record of staged.values()) {
          if (this.recordsById.has(record.intervalId) || !permitted(record)) continue;
          additions.push(record);
        }
        if (additions.length > 0) {
          const firstIndex = this.records.length;
          for (const record of additions) this.records.push(record);
          this.publishedRecords = null;
          additions.forEach((record, offset) => {
            this.recordsById.set(record.intervalId, record);
            this.indexById.set(record.intervalId, firstIndex + offset);
          });
        }
      } else {
        this.records = initialCache.records;
        this.publishedRecords = initialCache.publishedRecords;
        this.recordsById = initialCache.recordsById;
        this.indexById = initialCache.indexById;
        this.loaded = true;
        if (initiallyFiltered.length !== stagedTotal) this.pendingScrub = true;
        this.journalLines = journalLineCount;
      }

      if (!sameFileSignature(journalBefore, journalNow)) {
        // A journal append or recovery commit raced the warm-up. Replay the
        // current journal with reset-marker semantics rather than merging a
        // stale detached map; the journal is parsed outside the warm lock on
        // normal warmup and this tail is only the revalidation fallback.
        const currentJournal = readTextSync(this.journalPath);
        if (currentJournal !== null) {
          replayJournalContent(this.recordsById, currentJournal);
          const current = [...this.recordsById.values()].filter(permitted);
          this.replaceCache(current);
          this.journalLines = countJournalLines(currentJournal);
        } else {
          this.journalLines = 0;
        }
      }
      this.snapshotSignature = snapshotNow;
      this.journalSignature = readFileSignature(this.journalPath);
      this.privacySignature = readFileSignature(this.privacyPath);
      this.journalReplayedBytes = this.journalSignature.exists ? this.journalSignature.size : 0;
      this.loaded = true;
    });
    this.diagnostics.initializeDurationMs += Math.max(0, this.now() - startedAtMs);
  }
}

// ---------------------------------------------------------------------------
// Loading helpers (shared by the synchronous fallback and the async warm-up)
// ---------------------------------------------------------------------------

function createArrayScanState(): {
  depth: number;
  inString: boolean;
  escape: boolean;
  elementStart: number;
  offset: number;
  batch: string[];
} {
  return { depth: 0, inString: false, escape: false, elementStart: -1, offset: 0, batch: [] };
}

/** String-aware incremental scanner for a top-level JSON array of objects.
 *  Captures each element (depth-1 object) and hands bounded batches to the
 *  parser, so an 11 MB+ snapshot is never parsed or normalized in one
 *  blocking step during warm-up. */
function scanJsonArrayChunk(
  content: string,
  state: ReturnType<typeof createArrayScanState>,
  end: number,
  onBatch: (batch: string[]) => void,
): void {
  for (; state.offset < end; state.offset += 1) {
    const ch = content[state.offset];
    if (state.inString) {
      if (state.escape) state.escape = false;
      else if (ch === '\\') state.escape = true;
      else if (ch === '"') state.inString = false;
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      continue;
    }
    if (ch === '{') {
      if (state.depth === 1) state.elementStart = state.offset;
      state.depth += 1;
      continue;
    }
    if (ch === '}') {
      state.depth -= 1;
      if (state.depth === 1 && state.elementStart !== -1) {
        state.batch.push(content.slice(state.elementStart, state.offset + 1));
        state.elementStart = -1;
        if (state.batch.length >= PARSE_BATCH_RECORDS) {
          const batch = state.batch;
          state.batch = [];
          onBatch(batch);
        }
      }
      if (state.depth < 0) state.depth = 0;
      continue;
    }
    if (ch === '[' || ch === ']') {
      state.depth = ch === '[' ? state.depth + 1 : Math.max(0, state.depth - 1);
    }
  }
}

async function scanSnapshotContentWarm(
  content: string,
  byId: Map<string, ActivityIntervalRecord>,
  signal?: AbortSignal,
): Promise<number> {
  const state = createArrayScanState();
  const total = content.length;
  let bytes = 0;
  let sliceStart = 0;
  while (sliceStart < total) {
    if (signal?.aborted) throw new Error('Activity timeline compaction cancelled.');
    const end = surrogateSafeSliceEnd(content,
      Math.min(total, sliceStart + WARM_SCAN_SLICE_BYTES));
    // Byte accounting rides the bounded scan slices: a full-content
    // Buffer.byteLength pass over a ~100 MiB snapshot is a single ~100 ms
    // event-loop stall, while a 256 KiB slice costs well under a millisecond.
    bytes += Buffer.byteLength(content.slice(sliceStart, end), 'utf8');
    scanJsonArrayChunk(content, state, end, (batch) => {
      parseRecordsBatch(batch, (record) => absorbRecord(byId, record));
    });
    sliceStart = end;
    if (sliceStart < total) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (state.batch.length > 0) {
    const tail = state.batch;
    state.batch = [];
    parseRecordsBatch(tail, (record) => absorbRecord(byId, record));
  }
  return bytes;
}

/** Extend a slice boundary that would split a UTF-16 surrogate pair, so
 *  per-slice Buffer.byteLength sums exactly to the full-content count. */
function surrogateSafeSliceEnd(content: string, boundary: number): number {
  if (boundary === 0 || boundary >= content.length) return boundary;
  const previous = content.charCodeAt(boundary - 1);
  const next = content.charCodeAt(boundary);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return boundary + 1;
  }
  return boundary;
}

/** Guard preserved from the legacy reader: non-array snapshot content is
 *  corrupt and must fail loudly instead of silently resetting the timeline.
 *  Truncated tails are tolerated (valid elements are kept); only content
 *  that does not start a JSON array fails. */
function assertSnapshotShape(content: string): void {
  for (let offset = 0; offset < content.length; offset += 1) {
    const ch = content[offset];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
    if (ch !== '[') throw new Error('Activity timeline snapshot is not a JSON array.');
    return;
  }
}

function parseRecordsBatch(
  batch: readonly string[],
  sink: (record: ActivityIntervalRecord) => void,
): void {
  let candidates: readonly unknown[];
  try {
    candidates = JSON.parse(`[${batch.join(',')}]`) as unknown[];
  } catch {
    candidates = batch.flatMap((element) => {
      try { return [JSON.parse(element) as unknown]; } catch { return []; }
    });
  }
  for (const candidate of candidates) {
    try {
      sink(normalize(candidate));
    } catch { /* malformed records do not hide valid siblings */ }
  }
}

/** Canonical merge rule shared by snapshot and journal replay: first
 *  correlated evidence wins, and an unsettled record is replaced only by a
 *  later settlement (settlement is immutable, matching settle()). */
function absorbRecord(
  byId: Map<string, ActivityIntervalRecord>,
  record: ActivityIntervalRecord,
): void {
  const existing = byId.get(record.intervalId);
  if (!existing) {
    byId.set(record.intervalId, record);
    return;
  }
  if (!existing.endedAt && record.endedAt) byId.set(record.intervalId, record);
}

/** Replay journal lines over a record map; returns the number of journal
 *  lines (compaction accounting includes torn lines, which are skipped). */
function replayJournalContent(
  byId: Map<string, ActivityIntervalRecord>,
  content: string,
): number {
  const lines = content.split('\n');
  const batch: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    batch.push(line);
    if (batch.length >= PARSE_BATCH_RECORDS) {
      const flush = batch.splice(0, batch.length);
      absorbJournalLines(byId, flush);
    }
  }
  if (batch.length > 0) absorbJournalLines(byId, batch);
  return lines.reduce((count, line) => (line.trim() ? count + 1 : count), 0);
}

function absorbJournalLines(
  byId: Map<string, ActivityIntervalRecord>,
  lines: readonly string[],
): void {
  const candidates = parseJournalCandidates(lines);
  for (const candidate of candidates) {
    if (isJournalResetMarker(candidate)) {
      byId.clear();
      continue;
    }
    try {
      absorbRecord(byId, normalize(candidate));
    } catch { /* malformed records do not hide valid siblings */ }
  }
}

/** Batch-parse journal lines; each line is an independent commit, so a
 *  malformed/torn line never prevents replay of valid siblings. */
function parseJournalCandidates(lines: readonly string[]): readonly unknown[] {
  try {
    return JSON.parse(`[${lines.join(',')}]`) as unknown[];
  } catch {
    return lines.flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
  }
}

function countJournalLines(content: string): number {
  return content.split('\n').reduce((count, line) => (line.trim() ? count + 1 : count), 0);
}

async function replayJournalContentWarm(
  byId: Map<string, ActivityIntervalRecord>,
  content: string,
  signal?: AbortSignal,
): Promise<{ lines: number; bytes: number }> {
  const total = content.length;
  const batch: string[] = [];
  let lineStart = 0;
  let lineCount = 0;
  let bytes = 0;
  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) throw new Error('Activity timeline compaction cancelled.');
    const end = surrogateSafeSliceEnd(content,
      Math.min(total, offset + WARM_SCAN_SLICE_BYTES));
    // Bounded byte accounting, mirroring the snapshot scan.
    bytes += Buffer.byteLength(content.slice(offset, end), 'utf8');
    for (; offset < end; offset += 1) {
      if (content[offset] === '\n') {
        const line = content.slice(lineStart, offset);
        if (line.trim()) {
          batch.push(line);
          lineCount += 1;
        }
        lineStart = offset + 1;
        if (batch.length >= PARSE_BATCH_RECORDS) {
          const flush = batch.splice(0, batch.length);
          absorbJournalLines(byId, flush);
          // Yield between bounded journal batches during warm-up.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
    if (offset < total) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (lineStart < content.length) {
    const line = content.slice(lineStart);
    if (line.trim()) {
      batch.push(line);
      lineCount += 1;
    }
  }
  if (batch.length > 0) absorbJournalLines(byId, batch);
  return { lines: lineCount, bytes };
}

function isJournalResetMarker(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).__activityTimeline === JOURNAL_RESET_MARKER.__activityTimeline;
}

function buildRecoveryJournalPayload(records: readonly ActivityIntervalRecord[]): string {
  const lines = [JSON.stringify(JOURNAL_RESET_MARKER)];
  for (const record of records) lines.push(JSON.stringify(record));
  return `${lines.join('\n')}\n`;
}

/** Bounded-yield filter pass shared by the warm-up and compaction: a very
 *  large staged history is filtered across event-loop turns instead of one
 *  blocking iteration. Returns the kept records and the total scanned count. */
async function filterRecordsWarm(
  records: Iterable<ActivityIntervalRecord>,
  permitted: (record: ActivityIntervalRecord) => boolean,
  signal?: AbortSignal,
): Promise<{ filtered: ActivityIntervalRecord[]; total: number }> {
  const filtered: ActivityIntervalRecord[] = [];
  let total = 0;
  for (const record of records) {
    total += 1;
    if (permitted(record)) filtered.push(record);
    if (total % SERIALIZE_BATCH_RECORDS === 0) {
      if (signal?.aborted) throw new Error('Activity timeline compaction cancelled.');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { filtered, total };
}

async function buildCacheWarm(
  records: readonly ActivityIntervalRecord[],
  signal?: AbortSignal,
): Promise<{
  records: ActivityIntervalRecord[];
  publishedRecords: readonly ActivityIntervalRecord[];
  recordsById: Map<string, ActivityIntervalRecord>;
  indexById: Map<string, number>;
}> {
  const internal = Array.from(records);
  const recordsById = new Map<string, ActivityIntervalRecord>();
  const indexById = new Map<string, number>();
  for (let index = 0; index < internal.length; index += 1) {
    if (signal?.aborted) throw new Error('Activity timeline compaction cancelled.');
    const record = internal[index];
    recordsById.set(record.intervalId, record);
    indexById.set(record.intervalId, index);
    if ((index + 1) % SERIALIZE_BATCH_RECORDS === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return {
    records: internal,
    publishedRecords: Object.freeze(internal.slice()),
    recordsById,
    indexById,
  };
}

async function writeTempRecordsFile(
  filePath: string,
  records: readonly ActivityIntervalRecord[],
  format: 'snapshot' | 'journal',
  signal?: AbortSignal,
): Promise<number> {
  const handle = await fs.promises.open(filePath, 'wx');
  let bytes = 0;
  try {
    const write = async (chunk: string): Promise<void> => {
      await handle.write(chunk, undefined, 'utf8');
      bytes += Buffer.byteLength(chunk, 'utf8');
    };
    if (format === 'snapshot') await write('[\n');
    else await write(`${JSON.stringify(JOURNAL_RESET_MARKER)}\n`);
    const batch: string[] = [];
    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const chunk = batch.splice(0, batch.length).join('');
      await write(chunk);
    };
    for (let index = 0; index < records.length; index += 1) {
      if (signal?.aborted) throw new Error('Activity timeline compaction cancelled.');
      if (format === 'snapshot') {
        const comma = index + 1 < records.length ? ',' : '';
        batch.push(`  ${JSON.stringify(records[index], null, 2)}${comma}\n`);
      } else {
        batch.push(`${JSON.stringify(records[index])}\n`);
      }
      if (batch.length >= SERIALIZE_BATCH_RECORDS) {
        await flushBatch();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    await flushBatch();
    if (format === 'snapshot') await write(']\n');
    return bytes;
  } finally {
    await handle.close();
  }
}

function readTextSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeAllSync(fd: number, buffer: Buffer): number {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
  return offset;
}

function readFileSignature(filePath: string): FileSignature {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { exists: false, size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 };
  }
}

function sameFileSignature(left: FileSignature, right: FileSignature): boolean {
  return left.exists === right.exists
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

// ---------------------------------------------------------------------------
// Record normalization (unchanged canonical form)
// ---------------------------------------------------------------------------

function normalize(value: unknown): ActivityIntervalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Activity interval must be an object.');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error('Unsupported activity interval schema.');
  const intervalId = text(raw.intervalId, 'intervalId');
  const sessionPath = text(raw.sessionPath, 'sessionPath');
  const kind = raw.kind;
  if (!ACTIVITY_INTERVAL_KINDS.includes(kind as ActivityIntervalRecord['kind'])) throw new Error('Invalid activity kind.');
  const startedAt = timestamp(raw.startedAt, 'startedAt');
  const endedAt = raw.endedAt === undefined ? undefined : timestamp(raw.endedAt, 'endedAt');
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('Activity interval ends before it starts.');
  const outcome = raw.outcome;
  if (outcome !== undefined && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(String(outcome))) {
    throw new Error('Invalid activity outcome.');
  }
  return Object.freeze({
    schemaVersion: 1,
    intervalId,
    sessionId: nullableText(raw.sessionId, 'sessionId'),
    sessionPath,
    parentRunId: nullableText(raw.parentRunId, 'parentRunId'),
    parentOperationId: nullableText(raw.parentOperationId, 'parentOperationId'),
    invocationId: nullableText(raw.invocationId, 'invocationId'),
    toolId: nullableText(raw.toolId, 'toolId'),
    kind: kind as ActivityIntervalRecord['kind'],
    startedAt,
    ...(endedAt ? { endedAt: endedAt } : {}),
    ...(outcome ? { outcome: outcome as NonNullable<ActivityIntervalRecord['outcome']> } : {}),
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp.`);
  return new Date(Date.parse(result)).toISOString();
}
