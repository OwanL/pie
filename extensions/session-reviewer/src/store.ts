/** Mixed V1/V2 review storage and the separate closure-action outbox. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readSessionIdentity } from './evidence.js';
import type { ClosureAction, OpenTabSummary, ReviewRecordV1, SessionReviewV2 } from './types.js';

const OPEN_TABS_ENV = 'PIE_OPEN_TABS';
const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
const REVIEWS_FILE = 'reviews.jsonl';
const CLOSURE_FILE = 'closure-actions.jsonl';
const writeLocks = new Map<string, Promise<void>>();

export function readOpenTabs(): OpenTabSummary[] {
  const raw = process.env[OPEN_TABS_ENV]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isOpenTabSummary) : [];
  } catch {
    return [];
  }
}
function isOpenTabSummary(value: unknown): value is OpenTabSummary {
  return !!value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string';
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

function normalizeV1(value: unknown): ReviewRecordV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionPath !== 'string' || typeof v.done !== 'boolean' || typeof v.rating !== 'number' || !Number.isFinite(v.rating)) return undefined;
  if (v.completion !== 'fully' && v.completion !== 'partial' && v.completion !== 'setback') return undefined;
  const reviewerBuckets = Array.isArray(v.reviewerBuckets) && v.reviewerBuckets.every((b) => typeof b === 'string') ? v.reviewerBuckets as string[] : undefined;
  const reviewerCount = typeof v.reviewerCount === 'number' && Number.isInteger(v.reviewerCount) && v.reviewerCount >= 0 ? v.reviewerCount : undefined;
  const selfClose = typeof v.selfClose === 'boolean' ? v.selfClose : undefined;
  return {
    sessionPath: v.sessionPath,
    done: v.done,
    rating: v.rating,
    completion: v.completion,
    reason: typeof v.reason === 'string' ? v.reason : '',
    evaluatedAt: typeof v.evaluatedAt === 'string' ? v.evaluatedAt : new Date(0).toISOString(),
    ...(reviewerBuckets ? { reviewerBuckets } : {}),
    ...(reviewerCount !== undefined ? { reviewerCount } : {}),
    ...(selfClose !== undefined ? { selfClose } : {}),
  };
}
function looksV2(value: unknown): value is SessionReviewV2 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.schemaVersion === 'number' && v.schemaVersion >= 2 && (v.kind === 'production' || v.kind === 'calibration') && typeof v.reviewId === 'string' && typeof v.sessionId === 'string' && typeof v.sessionPathAtReview === 'string';
}

export interface ReviewStoreSnapshot {
  legacy: ReviewRecordV1[];
  v2: SessionReviewV2[];
  canonicalBySessionId: Map<string, SessionReviewV2>;
  reservedLegacyBySessionId: Map<string, ReviewRecordV1>;
  unresolvedLegacy: ReviewRecordV1[];
}

export function readReviewStore(): ReviewStoreSnapshot {
  const legacy: ReviewRecordV1[] = [];
  const v2: SessionReviewV2[] = [];
  for (const raw of readJsonLines(getReviewsFilePath())) {
    if (looksV2(raw)) v2.push(raw);
    else {
      const record = normalizeV1(raw);
      if (record) legacy.push(record);
    }
  }
  const canonicalBySessionId = new Map<string, SessionReviewV2>();
  for (const review of v2) if (review.kind === 'production' && !canonicalBySessionId.has(review.sessionId)) canonicalBySessionId.set(review.sessionId, review);
  const reservedLegacyBySessionId = new Map<string, ReviewRecordV1>();
  const unresolvedLegacy: ReviewRecordV1[] = [];
  for (const record of legacy) {
    if (record.selfClose) continue;
    const identity = readSessionIdentity(record.sessionPath);
    if (identity.identityFallback) unresolvedLegacy.push(record);
    else reservedLegacyBySessionId.set(identity.sessionId, record);
  }
  return { legacy, v2, canonicalBySessionId, reservedLegacyBySessionId, unresolvedLegacy };
}

/** Backward-compatible V1 latest-by-path reader. V2 is intentionally excluded. */
export function readReviews(): Map<string, ReviewRecordV1> {
  const latest = new Map<string, ReviewRecordV1>();
  for (const record of readReviewStore().legacy) latest.set(record.sessionPath, record);
  return latest;
}

/** Kept only for old fixtures/importers; the V2 tool surface never calls this. */
export function appendReview(record: ReviewRecordV1): string {
  const file = requireConfiguredFile(getReviewsFilePath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the session-review sidecar.');
  appendLine(file, record);
  return file;
}

function requireConfiguredFile(file: string | undefined, message: string): string {
  if (!file) throw new Error(message);
  return file;
}
function appendLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}
function appendLineDurable(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'a');
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
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
  | { written: false; reviewId?: string; legacy: boolean; file: string };

/** Once-only in this runtime: lock, re-read all records, then append exactly once. */
export async function recordReviewOnce(review: SessionReviewV2): Promise<RecordReviewResult> {
  const file = requireConfiguredFile(getReviewsFilePath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the session-review sidecar.');
  return withFileLock(file, () => {
    const snapshot = readReviewStore();
    if (review.kind === 'production') {
      const existing = snapshot.canonicalBySessionId.get(review.sessionId);
      if (existing) return { written: false, reviewId: existing.reviewId, legacy: false, file };
      if (snapshot.reservedLegacyBySessionId.has(review.sessionId)) return { written: false, legacy: true, file };
    }
    appendLine(file, review);
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

export async function enqueueClosure(input: {
  kind: 'closeReviewed' | 'closeSelf'; targetSessionId: string; targetSessionPath?: string; reviewId?: string;
}): Promise<{ action: ClosureAction; existing: boolean; file: string }> {
  const file = requireConfiguredFile(getClosureOutboxPath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the closure-action outbox.');
  return withFileLock(file, () => {
    const actions = readClosureActions();
    const existing = actions.find((a) => a.kind === input.kind && a.targetSessionId === input.targetSessionId && (a.status === 'succeeded' || a.status === 'pending' || a.status === 'retrying'));
    if (existing) return { action: existing, existing: true, file };
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
    return { action, existing: false, file };
  });
}

/** Host/outbox worker appends state transitions; review storage is untouched. */
export async function appendClosureState(action: ClosureAction): Promise<string> {
  const file = requireConfiguredFile(getClosureOutboxPath(), 'PIE_REVIEWS_DIR is not set — the host has not configured the closure-action outbox.');
  await withFileLock(file, () => appendLine(file, action));
  return file;
}
