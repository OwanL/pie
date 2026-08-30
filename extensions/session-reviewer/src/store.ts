/** V2 review storage and the separate closure-action outbox. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClosureAction, OpenTabSummary, SessionReviewV2 } from './types.js';
import { validateSessionReviewV2 } from './validation.js';

const OPEN_TABS_ENV = 'PIE_OPEN_TABS';
const OPEN_TABS_REVISION_ENV = 'PIE_OPEN_TABS_REVISION';
const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
const REVIEWS_FILE = 'reviews.jsonl';
const CLOSURE_FILE = 'closure-actions.jsonl';
const writeLocks = new Map<string, Promise<void>>();

export interface OpenTabRegistry {
  tabs: OpenTabSummary[];
  /** Monotonic coordinator revision. Older hosts omit it, so consumers must
   * continue to validate the current array even when no revision is present. */
  revision?: number;
}

export function readOpenTabRegistry(): OpenTabRegistry {
  const raw = process.env[OPEN_TABS_ENV]?.trim();
  const revisionRaw = process.env[OPEN_TABS_REVISION_ENV]?.trim();
  const revisionValue = revisionRaw === undefined ? undefined : Number(revisionRaw);
  const revision = revisionValue !== undefined && Number.isSafeInteger(revisionValue) && revisionValue > 0
    ? revisionValue
    : undefined;
  if (!raw) return { tabs: [], ...(revision !== undefined ? { revision } : {}) };
  try {
    const parsed = JSON.parse(raw);
    const tabs = Array.isArray(parsed) ? parsed.filter(isOpenTabSummary) : [];
    return { tabs, ...(revision !== undefined ? { revision } : {}) };
  } catch {
    return { tabs: [], ...(revision !== undefined ? { revision } : {}) };
  }
}
export function readOpenTabs(): OpenTabSummary[] { return readOpenTabRegistry().tabs; }
function isOpenTabSummary(value: unknown): value is OpenTabSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { path?: unknown; pinned?: unknown; isRunning?: unknown };
  // These two booleans are action authority, not optional display metadata.
  // Missing `isRunning` must never be interpreted as an idle target.
  return typeof candidate.path === 'string'
    && candidate.path.trim().length > 0
    && typeof candidate.pinned === 'boolean'
    && typeof candidate.isRunning === 'boolean';
}

function configuredFile(name: string): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir ? path.join(dir, name) : undefined;
}
export function getReviewsFilePath(): string | undefined { return configuredFile(REVIEWS_FILE); }
export function getClosureOutboxPath(): string | undefined { return configuredFile(CLOSURE_FILE); }

function readJsonLines(file: string | undefined): unknown[] {
  if (!file) return [];
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const records: unknown[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* malformed lines are isolated */ }
  }
  return records;
}

function isV2Review(value: unknown): value is SessionReviewV2 {
  try {
    validateSessionReviewV2(value);
    return true;
  } catch {
    return false;
  }
}

export interface ReviewStoreSnapshot {
  v2: SessionReviewV2[];
  canonicalBySessionId: Map<string, SessionReviewV2>;
}

export function readReviewStore(): ReviewStoreSnapshot {
  const v2 = readJsonLines(getReviewsFilePath()).filter(isV2Review);
  const canonicalBySessionId = new Map<string, SessionReviewV2>();
  for (const review of v2) {
    if (review.kind === 'production' && !canonicalBySessionId.has(review.sessionId)) {
      canonicalBySessionId.set(review.sessionId, review);
    }
  }
  return { v2, canonicalBySessionId };
}

function requireConfiguredFile(file: string | undefined, message: string): string {
  if (!file) throw new Error(message);
  return file;
}
function appendLineDurable(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'a');
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
/** In-process write serializer. Each appended line is a single `writeSync` under
 *  `O_APPEND`, so concurrent processes rely on OS append atomicity. Durability
 *  of a canonical record or closure action is guaranteed separately via
 *  `appendLineDurable` before any dependent enqueue resolves. */
async function withFileLock<T>(file: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = writeLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  writeLocks.set(file, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (writeLocks.get(file) === tail) writeLocks.delete(file);
  }
}

export type RecordReviewResult =
  | { written: true; review: SessionReviewV2; file: string }
  | { written: false; reviewId: string; file: string };

/** Once-only in this runtime: lock, re-read all records, then append exactly once. */
export async function recordReviewOnce(review: SessionReviewV2): Promise<RecordReviewResult> {
  const file = requireConfiguredFile(getReviewsFilePath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the session-review sidecar.');
  return withFileLock(file, () => {
    const existing = review.kind === 'production'
      ? readReviewStore().canonicalBySessionId.get(review.sessionId)
      : undefined;
    if (existing) return { written: false, reviewId: existing.reviewId, file };
    appendLineDurable(file, review);
    return { written: true, review, file };
  });
}

function normalizeClosure(value: unknown): ClosureAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.actionId !== 'string' || (v.kind !== 'closeReviewed' && v.kind !== 'closeSelf') || typeof v.targetSessionId !== 'string') return undefined;
  if (v.status !== 'pending' && v.status !== 'succeeded' && v.status !== 'failed' && v.status !== 'retrying') return undefined;
  if (typeof v.attempts !== 'number' || !Number.isInteger(v.attempts) || v.attempts < 0 || typeof v.requestedAt !== 'string') return undefined;
  return value as ClosureAction;
}
export function readClosureActions(): ClosureAction[] {
  const latest = new Map<string, ClosureAction>();
  for (const raw of readJsonLines(getClosureOutboxPath())) {
    const action = normalizeClosure(raw);
    if (action) latest.set(action.actionId, action);
  }
  return [...latest.values()];
}

export interface EnqueueClosureInput {
  kind: 'closeReviewed' | 'closeSelf'; targetSessionId: string; targetSessionPath?: string; reviewId?: string;
}

export interface EnqueueClosureResult { action: ClosureAction; existing: boolean; file: string }
export type EnqueueClosureBatchResult = EnqueueClosureResult | { error: string };

function enqueueClosureFromSnapshot(
  file: string,
  actions: ClosureAction[],
  input: EnqueueClosureInput,
): EnqueueClosureResult {
  // Only an in-flight action is reusable. A succeeded action proves that the
  // tab was absent at settlement time; if a caller has revalidated that the
  // tab is open again, that is a new close generation and needs a new action
  // ID so host reconciliation will execute it again.
  const existing = actions.find((action) => action.kind === input.kind && action.targetSessionId === input.targetSessionId && (action.status === 'pending' || action.status === 'retrying'));
  if (existing) {
    // Reusing an active action remains idempotent by actionId. Wake host
    // reconciliation with a state-neutral record: another process may append
    // a terminal action after our read, so re-appending this stale active
    // snapshot could otherwise make it authoritative again.
    appendLineDurable(file, {
      recordType: 'wake',
      actionId: existing.actionId,
      wokenAt: new Date().toISOString(),
    });
    return { action: existing, existing: true, file };
  }
  const action: ClosureAction = {
    actionId: randomUUID(),
    kind: input.kind,
    targetSessionId: input.targetSessionId,
    ...(input.targetSessionPath ? { targetSessionPath: input.targetSessionPath } : {}),
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    status: 'pending',
    attempts: 0,
    requestedAt: new Date().toISOString(),
  };
  appendLineDurable(file, action);
  actions.push(action);
  return { action, existing: false, file };
}

export async function enqueueClosure(input: EnqueueClosureInput): Promise<EnqueueClosureResult> {
  const file = requireConfiguredFile(getClosureOutboxPath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the closure-action outbox.');
  return withFileLock(file, () => enqueueClosureFromSnapshot(file, readClosureActions(), input));
}

/** Enqueue a validated command batch under one lock and one outbox snapshot.
 * Per-item results are retained so one durable append failure cannot erase the
 * success/error disposition of its siblings. */
export async function enqueueClosureBatch(inputs: EnqueueClosureInput[]): Promise<EnqueueClosureBatchResult[]> {
  const file = requireConfiguredFile(getClosureOutboxPath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the closure-action outbox.');
  return withFileLock(file, () => {
    const actions = readClosureActions();
    return inputs.map((input) => {
      try { return enqueueClosureFromSnapshot(file, actions, input); }
      catch (error) { return { error: (error as Error).message }; }
    });
  });
}
