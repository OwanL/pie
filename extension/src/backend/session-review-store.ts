import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  REVIEW_CLOSURE_ACTIONS_FILE,
  type ClosureAction,
  type SessionReview,
  type SessionSummary,
} from '../shared/protocol';

/**
 * Mixed V1/V2 session-review sidecar reader.
 *
 * V1 reviews retain latest-record-per-path semantics. Canonical V2 production
 * reviews are read once-only by stable session-header ID. Explicit closure
 * actions are read from a separate append-only outbox and never interpreted as
 * reviews.
 */

export const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
export const REVIEWS_FILE = 'reviews.jsonl';

interface SessionReviewV2Reference {
  schemaVersion: number;
  kind: 'production';
  reviewId: string;
  sessionId: string;
  sessionPathAtReview: string;
  reviewedAt: string;
  identityFallback?: boolean;
}

export interface SessionReviewSidecar {
  legacyByPath: Map<string, SessionReview>;
  /** First production review wins: later duplicates cannot replace canonical. */
  productionBySessionId: Map<string, SessionReviewV2Reference>;
  /** V1 paths whose current JSONL header could be resolved at cutover/read time. */
  reservedLegacyBySessionId: Map<string, SessionReview>;
  closureActionsBySessionId: Map<string, ClosureAction[]>;
}

export interface SessionIdentity {
  sessionId: string;
  identityFallback: boolean;
}

export function getReviewsDir(): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir || undefined;
}

function getSidecarFilePath(fileName: string): string | undefined {
  const dir = getReviewsDir();
  return dir ? path.join(dir, fileName) : undefined;
}

function readJsonLines(file: string | undefined): unknown[] {
  if (!file) return [];
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const values: unknown[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // A malformed line must not break session listing or outbox draining.
    }
  }
  return values;
}

/** V1 normalized path-hash fallback from plan §14.5. */
export function sessionPathHash(sessionPath: string): string {
  let normalized = sessionPath.trim().replace(/\\/g, '/');
  const wasUnc = normalized.startsWith('//');
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (wasUnc) normalized = `/${normalized}`;
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    normalized = normalized.toLowerCase();
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function readFirstNonEmptyLine(filePath: string): string | undefined {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.allocUnsafe(4096);
  let buffered = '';
  let totalBytes = 0;
  try {
    // Session headers are small. Bound malformed files so identity lookup never
    // reads a multi-megabyte transcript merely because its first newline is bad.
    while (totalBytes < 1024 * 1024) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        buffered += decoder.end();
        const finalLine = buffered.trim();
        return finalLine || undefined;
      }
      totalBytes += bytesRead;
      buffered += decoder.write(chunk.subarray(0, bytesRead));
      let newlineIndex: number;
      while ((newlineIndex = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newlineIndex).trim();
        buffered = buffered.slice(newlineIndex + 1);
        if (line) return line;
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve the stable ID from the first non-empty session JSONL line. */
export function resolveSessionIdentity(sessionPath: string): SessionIdentity {
  try {
    const firstLine = readFirstNonEmptyLine(sessionPath);
    if (firstLine) {
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      if (header.type === 'session' && typeof header.id === 'string' && header.id.trim()) {
        return { sessionId: header.id.trim(), identityFallback: false };
      }
    }
  } catch {
    // Missing, unreadable, or malformed headers use the explicit legacy fallback.
  }
  return { sessionId: sessionPathHash(sessionPath), identityFallback: true };
}

/** Read mixed reviews plus the separate closure-action outbox. */
export function readReviews(): SessionReviewSidecar {
  const legacyByPath = new Map<string, SessionReview>();
  const productionBySessionId = new Map<string, SessionReviewV2Reference>();

  for (const value of readJsonLines(getSidecarFilePath(REVIEWS_FILE))) {
    const v2 = normalizeV2Review(value);
    if (v2) {
      if (!productionBySessionId.has(v2.sessionId)) {
        productionBySessionId.set(v2.sessionId, v2);
      }
      continue;
    }
    const legacy = normalizeLegacyReview(value);
    if (legacy) legacyByPath.set(legacy.sessionPath, legacy);
  }

  const reservedLegacyBySessionId = new Map<string, SessionReview>();
  for (const legacy of legacyByPath.values()) {
    const identity = resolveSessionIdentity(legacy.sessionPath);
    if (!identity.identityFallback) {
      reservedLegacyBySessionId.set(identity.sessionId, legacy);
    }
  }

  const latestActions = new Map<string, ClosureAction>();
  for (const value of readJsonLines(getSidecarFilePath(REVIEW_CLOSURE_ACTIONS_FILE))) {
    const action = normalizeClosureAction(value);
    if (action) latestActions.set(action.actionId, action);
  }
  const closureActionsBySessionId = new Map<string, ClosureAction[]>();
  for (const action of latestActions.values()) {
    if (action.kind === 'closeReviewed') {
      const review = productionBySessionId.get(action.targetSessionId);
      if (!review || review.reviewId !== action.reviewId) continue;
    }
    const actions = closureActionsBySessionId.get(action.targetSessionId) ?? [];
    actions.push(action);
    closureActionsBySessionId.set(action.targetSessionId, actions);
  }

  return { legacyByPath, productionBySessionId, reservedLegacyBySessionId, closureActionsBySessionId };
}

function normalizeV2Review(value: unknown): SessionReviewV2Reference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== 'number' || v.schemaVersion < 2) return undefined;
  if (v.kind !== 'production') return undefined; // calibration is non-canonical
  if (typeof v.reviewId !== 'string' || !v.reviewId.trim()) return undefined;
  if (typeof v.sessionId !== 'string' || !v.sessionId.trim()) return undefined;
  if (typeof v.sessionPathAtReview !== 'string') return undefined;
  if (typeof v.reviewedAt !== 'string') return undefined;
  return {
    schemaVersion: v.schemaVersion,
    kind: 'production',
    reviewId: v.reviewId,
    sessionId: v.sessionId,
    sessionPathAtReview: v.sessionPathAtReview,
    reviewedAt: v.reviewedAt,
    ...(typeof v.identityFallback === 'boolean' ? { identityFallback: v.identityFallback } : {}),
  };
}

function normalizeLegacyReview(value: unknown): SessionReview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionPath !== 'string') return undefined;
  if (typeof v.done !== 'boolean') return undefined;
  if (typeof v.rating !== 'number' || !Number.isFinite(v.rating)) return undefined;
  const completion = v.completion;
  if (completion !== 'fully' && completion !== 'partial' && completion !== 'setback') return undefined;
  const rawBuckets = v.reviewerBuckets;
  const reviewerBuckets = Array.isArray(rawBuckets) && rawBuckets.every((bucket) => typeof bucket === 'string')
    ? rawBuckets as string[]
    : undefined;
  const rawCount = v.reviewerCount;
  const reviewerCount = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : undefined;
  const selfClose = typeof v.selfClose === 'boolean' ? v.selfClose : undefined;
  return {
    sessionPath: v.sessionPath,
    done: v.done,
    rating: v.rating,
    completion,
    reason: typeof v.reason === 'string' ? v.reason : '',
    evaluatedAt: typeof v.evaluatedAt === 'string' ? v.evaluatedAt : new Date(0).toISOString(),
    ...(reviewerBuckets !== undefined ? { reviewerBuckets } : {}),
    ...(reviewerCount !== undefined ? { reviewerCount } : {}),
    ...(selfClose !== undefined ? { selfClose } : {}),
  };
}

function normalizeClosureAction(value: unknown): ClosureAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.actionId !== 'string' || !v.actionId.trim()) return undefined;
  if (v.kind !== 'closeReviewed' && v.kind !== 'closeSelf') return undefined;
  if (typeof v.targetSessionId !== 'string' || !v.targetSessionId.trim()) return undefined;
  if (v.status !== 'pending' && v.status !== 'succeeded' && v.status !== 'failed' && v.status !== 'retrying') return undefined;
  if (typeof v.attempts !== 'number' || !Number.isInteger(v.attempts) || v.attempts < 0) return undefined;
  if (typeof v.requestedAt !== 'string') return undefined;
  if (v.kind === 'closeReviewed' && (typeof v.reviewId !== 'string' || !v.reviewId.trim())) return undefined;
  return {
    actionId: v.actionId,
    kind: v.kind,
    targetSessionId: v.targetSessionId,
    ...(typeof v.targetSessionPath === 'string' ? { targetSessionPath: v.targetSessionPath } : {}),
    ...(typeof v.reviewId === 'string' ? { reviewId: v.reviewId } : {}),
    status: v.status,
    attempts: v.attempts,
    ...(typeof v.lastError === 'string' ? { lastError: v.lastError } : {}),
    requestedAt: v.requestedAt,
    ...(typeof v.settledAt === 'string' ? { settledAt: v.settledAt } : {}),
  };
}

/** Merge V1/V2 review status and outbox actions into a session summary. */
export function mergeReviewIntoSummary(summary: SessionSummary, reviews: SessionReviewSidecar): SessionSummary {
  const identity = resolveSessionIdentity(summary.path);
  const v2 = reviews.productionBySessionId.get(identity.sessionId);
  const exactLegacy = reviews.legacyByPath.get(summary.path);
  const reservedLegacy = reviews.reservedLegacyBySessionId.get(identity.sessionId);
  const legacy = v2 ? undefined : (reservedLegacy ?? exactLegacy);
  const closureActions = reviews.closureActionsBySessionId.get(identity.sessionId);

  return {
    ...summary,
    sessionId: identity.sessionId,
    ...(identity.identityFallback ? { identityFallback: true } : {}),
    ...(v2 ? {
      reviewed: true,
      reviewId: v2.reviewId,
      reviewedAt: v2.reviewedAt,
      ...(v2.identityFallback === true ? { identityFallback: true } : {}),
    } : {}),
    ...(legacy ? {
      reviewed: true,
      legacyReview: true,
      done: legacy.done,
      rating: legacy.rating,
      completion: legacy.completion,
      reviewReason: legacy.reason,
      evaluatedAt: legacy.evaluatedAt,
      ...(legacy.reviewerBuckets !== undefined ? { reviewerBuckets: legacy.reviewerBuckets } : {}),
      ...(legacy.reviewerCount !== undefined ? { reviewerCount: legacy.reviewerCount } : {}),
      ...(legacy.selfClose !== undefined ? { selfClose: legacy.selfClose } : {}),
    } : {}),
    ...(closureActions && closureActions.length > 0 ? { closureActions } : {}),
  };
}

export function ensureReviewsDir(): void {
  const dir = getReviewsDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal; the writer also creates it on first write.
  }
}

/** Append closure-action state and fsync it before reporting success.
 *
 * The host calls this only after the correlated CloseSession/PersistTabs
 * effects complete. A crash or write failure before fsync leaves the prior
 * pending/retrying record authoritative, so the action remains retryable.
 * This function never opens or writes reviews.jsonl. */
export function appendClosureActionRecords(
  reviewsDir: string,
  actions: readonly ClosureAction[],
): void {
  if (actions.length === 0) return;

  fs.mkdirSync(reviewsDir, { recursive: true });
  const filePath = path.join(reviewsDir, REVIEW_CLOSURE_ACTIONS_FILE);
  const bytes = Buffer.from(`${actions.map((action) => JSON.stringify(action)).join('\n')}\n`, 'utf8');
  const fd = fs.openSync(filePath, 'a');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Watch both review records and explicit closure actions. */
export function startReviewWatcher(onChange: () => void): () => void {
  const dir = getReviewsDir();
  if (!dir) return () => {};

  ensureReviewsDir();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_, filename) => {
      if (filename !== REVIEWS_FILE && filename !== REVIEW_CLOSURE_ACTIONS_FILE) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
  } catch {
    return () => {};
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
