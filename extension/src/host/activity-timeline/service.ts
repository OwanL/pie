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

/** Durable, cross-process-safe activity timeline. The compact snapshot is
 * rewritten under the same transaction lock as usage, checkpoints, privacy,
 * forget, and exports. Stable interval ids make starts/settlements idempotent. */
export class ActivityTimeline {
  private readonly storageDir: string;
  private readonly lockTarget: string;
  private readonly pendingMutations: Array<(records: ActivityIntervalRecord[]) => ActivityIntervalRecord[]> = [];
  /** Bounds retry-queue flushes so a persistently failing write cannot turn
   *  every projection/export into a full-file rewrite attempt. */
  private lastPendingRetryAt = 0;
  private pendingRetryScheduled = false;
  private readonly now: () => number;
  private static readonly PENDING_RETRY_BACKOFF_MS = 1_000;

  constructor(private readonly filePath: string, options: { now?: () => number } = {}) {
    this.storageDir = path.dirname(filePath);
    this.now = options.now ?? Date.now;
    this.lockTarget = accountingLockTarget(this.storageDir);
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  start(record: ActivityIntervalRecord, options: { durableRequired?: boolean } = {}): void {
    this.mutate((records) => {
      const normalized = normalize(record);
      const existing = records.find((candidate) => candidate.intervalId === normalized.intervalId);
      if (existing) {
        // The matching invocation ledger owns conflict detection. Activity can
        // be replayed later from a lower-fidelity migration source; first
        // correlated evidence remains immutable.
        return records;
      }
      return [...records, normalized];
    }, options.durableRequired === true);
  }

  settle(
    intervalId: string,
    endedAt: string,
    outcome: NonNullable<ActivityIntervalRecord['outcome']>,
  ): void {
    this.mutate((records) => records.map((record) => {
      if (record.intervalId !== intervalId) return record;
      if (record.endedAt) return record;
      return normalize({ ...record, endedAt, outcome });
    }));
  }

  record(record: ActivityIntervalRecord, options: { durableRequired?: boolean } = {}): void {
    this.start(record, options);
  }

  /** Apply many interval records in a single read-modify-write cycle. The
   *  startup heal uses this so re-deriving N intervals costs one file rewrite
   *  instead of N. Idempotent per intervalId, like start(). */
  recordMany(
    records: readonly ActivityIntervalRecord[],
    options: { durableRequired?: boolean } = {},
  ): boolean {
    if (records.length === 0) return false;
    return this.mutate((existing) => {
      const byId = new Map(existing.map((record) => [record.intervalId, record]));
      let changed = false;
      for (const record of records) {
        if (byId.has(record.intervalId)) continue;
        const normalized = normalize(record);
        byId.set(normalized.intervalId, normalized);
        changed = true;
      }
      return changed ? [...byId.values()] : existing;
    }, options.durableRequired === true);
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
    return this.read().filter((record) => record.sessionPath === sessionPath);
  }

  projectAll(): readonly ActivityIntervalRecord[] {
    return this.read();
  }

  forgetSession(sessionPath: string, sessionId?: string): void {
    this.mutate((records) => records.filter((record) => record.sessionPath !== sessionPath
      && (!sessionId || record.sessionId !== sessionId)), true);
  }

  private read(): ActivityIntervalRecord[] {
    this.flushPending();
    return withFileUpdateLockSync(this.lockTarget, () => {
      const privacy = readAccountingPrivacySelectors(this.storageDir);
      return this.readUnlocked().filter((record) => !privacy.some((selector) => (
        (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
        || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
      )));
    });
  }

  private mutate(
    update: (records: ActivityIntervalRecord[]) => ActivityIntervalRecord[],
    durableRequired = false,
  ): boolean {
    // A new best-effort mutation may join the queue, but it must not turn a
    // persistent failure into an immediate full-file rewrite on every event.
    // Durable mutations deliberately bypass this gate and fail synchronously.
    if (!durableRequired && this.pendingMutations.length > 0 && !this.pendingRetryDue()) {
      this.pendingMutations.push(update);
      return false;
    }

    const pending = [...this.pendingMutations, update];
    try {
      const changed = this.applyMutations(pending);
      this.pendingMutations.length = 0;
      this.pendingRetryScheduled = false;
      return changed;
    } catch (error) {
      if (durableRequired) throw error;
      this.pendingMutations.push(update);
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

  private applyMutations(
    updates: readonly ((records: ActivityIntervalRecord[]) => ActivityIntervalRecord[])[],
  ): boolean {
    return withFileUpdateLockSync(this.lockTarget, () => {
      const privacy = readAccountingPrivacySelectors(this.storageDir);
      const permitted = (record: ActivityIntervalRecord): boolean => !privacy.some((selector) => (
        (selector.sessionPath !== undefined && selector.sessionPath === record.sessionPath)
        || (selector.sessionId !== undefined && selector.sessionId === record.sessionId)
      ));
      const loaded = this.readUnlocked();
      const current = loaded.filter(permitted);
      let next = current;
      for (const update of updates) {
        const updated = update(next);
        const filtered = updated.filter(permitted);
        next = filtered.length === updated.length
          && filtered.every((record, index) => record === updated[index])
          ? updated
          : filtered;
      }
      if (next === current && current.length === loaded.length) return false;
      this.writeUnlocked(next);
      return true;
    });
  }

  private readUnlocked(): ActivityIntervalRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      const records: ActivityIntervalRecord[] = [];
      const ids = new Set<string>();
      for (const candidate of parsed) {
        try {
          const record = normalize(candidate);
          if (!ids.has(record.intervalId)) {
            ids.add(record.intervalId);
            records.push(record);
          }
        } catch { /* malformed records do not hide valid siblings */ }
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private writeUnlocked(records: readonly ActivityIntervalRecord[]): void {
    if (records.length === 0) {
      try { fs.unlinkSync(this.filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      const fd = fs.openSync(tempPath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
      throw error;
    }
  }
}

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
    ...(endedAt ? { endedAt } : {}),
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
