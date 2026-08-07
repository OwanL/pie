import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { validateSessionReviewV2 } from '../../../extensions/session-reviewer/src/validation.js';
import {
  REVIEW_CLOSURE_ACTIONS_FILE,
  type ClosureAction,
  type SessionSummary,
} from '../shared/protocol';

export const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
export const REVIEWS_FILE = 'reviews.jsonl';

interface ProductionReviewReference {
  reviewId: string;
  sessionId: string;
  reviewedAt: string;
  identityFallback?: boolean;
}

export interface SessionReviewSidecar {
  /** First production review wins: later duplicates cannot replace canonical. */
  productionBySessionId: Map<string, ProductionReviewReference>;
  closureActionsBySessionId: Map<string, ClosureAction[]>;
}

let cachedReviewsFingerprint: string | undefined;
let cachedReviews: SessionReviewSidecar | undefined;

export interface SessionIdentity {
  sessionId: string;
  identityFallback: boolean;
}

export function getReviewsDir(): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir || undefined;
}

/** Cheap recovery fingerprint for the append-only review/closure sidecars.
 * `fs.watch` is only a latency optimization; the backend poll compares this
 * fingerprint so a missed/coalesced watcher event is repaired within a
 * bounded interval. */
export function getReviewSidecarFingerprint(): string {
  const dir = getReviewsDir();
  if (!dir) return 'disabled';

  const files = [REVIEWS_FILE, REVIEW_CLOSURE_ACTIONS_FILE].map((fileName) => {
    try {
      const stat = fs.statSync(path.join(dir, fileName), { bigint: true });
      return `${fileName}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return `${fileName}:${code === 'ENOENT' ? 'missing' : `unavailable:${code ?? 'unknown'}`}`;
    }
  }).join('|');
  return `${path.resolve(dir)}|${files}`;
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

/** Deterministic normalized-path hash used only when the session header has no stable ID. */
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
    // Missing, unreadable, or malformed headers use the deterministic fallback.
  }
  return { sessionId: sessionPathHash(sessionPath), identityFallback: true };
}

interface ReviewReference {
  kind: 'production' | 'calibration';
  reviewId: string;
  sessionId: string;
  reviewedAt: string;
  identityFallback?: boolean;
}

function normalizeV2Review(value: unknown): ReviewReference | undefined {
  let review;
  try {
    review = validateSessionReviewV2(value);
  } catch {
    return undefined;
  }
  return {
    kind: review.kind,
    reviewId: review.reviewId,
    sessionId: review.sessionId,
    reviewedAt: review.reviewedAt,
    ...(typeof review.identityFallback === 'boolean' ? { identityFallback: review.identityFallback } : {}),
  };
}

/** Read V2 review records and the separate closure-action outbox. Parsed state
 * is immutable-by-convention and cached against the append-only files' cheap
 * fingerprint, so active-action retry lists do not revalidate growing review
 * history every polling interval. */
export function readReviews(): SessionReviewSidecar {
  const fingerprint = getReviewSidecarFingerprint();
  if (cachedReviews && cachedReviewsFingerprint === fingerprint) return cachedReviews;

  const productionBySessionId = new Map<string, ProductionReviewReference>();
  for (const value of readJsonLines(getSidecarFilePath(REVIEWS_FILE))) {
    const review = normalizeV2Review(value);
    if (review?.kind === 'production' && !productionBySessionId.has(review.sessionId)) {
      productionBySessionId.set(review.sessionId, review);
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

  cachedReviewsFingerprint = fingerprint;
  cachedReviews = { productionBySessionId, closureActionsBySessionId };
  return cachedReviews;
}

/** True while at least one valid outbox action still needs host settlement.
 * Polling uses this to retry reconciliation after a transient list failure,
 * even when neither the session inventory nor sidecar fingerprint changes. */
export function hasActiveReviewClosureActions(): boolean {
  for (const actions of readReviews().closureActionsBySessionId.values()) {
    if (actions.some((action) => action.status === 'pending' || action.status === 'retrying')) return true;
  }
  return false;
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

/** Merge canonical V2 review status and outbox actions into a session summary. */
export function mergeReviewIntoSummary(summary: SessionSummary, reviews: SessionReviewSidecar): SessionSummary {
  const identity = resolveSessionIdentity(summary.path);
  const review = reviews.productionBySessionId.get(identity.sessionId);
  const closureActions = reviews.closureActionsBySessionId.get(identity.sessionId);

  return {
    ...summary,
    sessionId: identity.sessionId,
    ...(identity.identityFallback ? { identityFallback: true } : {}),
    ...(review ? {
      reviewed: true,
      reviewId: review.reviewId,
      reviewedAt: review.reviewedAt,
      ...(review.identityFallback === true ? { identityFallback: true } : {}),
    } : {}),
    ...(closureActions && closureActions.length > 0 ? { closureActions } : {}),
  };
}

/** Merge review state and expose active closure targets that are absent from
 * the SDK catalog. Enqueued actions carry the path captured from the reviewed
 * snapshot, so the host can run its idempotent close/persist lifecycle even if
 * the session file disappeared before reconciliation. Terminal actions never
 * create synthetic catalog entries. */
export function mergeReviewsIntoSummaries(
  summaries: readonly SessionSummary[],
  reviews: SessionReviewSidecar,
): SessionSummary[] {
  const merged = summaries.map((summary) => mergeReviewIntoSummary(summary, reviews));
  const representedSessionIds = new Set(merged.map((summary) => summary.sessionId).filter((id): id is string => !!id));
  const representedPaths = new Set(merged.map((summary) => summary.path));

  for (const [sessionId, actions] of reviews.closureActionsBySessionId) {
    if (representedSessionIds.has(sessionId)) continue;
    const activeActions = actions.filter((action) => action.status === 'pending' || action.status === 'retrying');
    const targetPath = activeActions.find((action) => action.targetSessionPath?.trim())?.targetSessionPath;
    if (!targetPath || representedPaths.has(targetPath)) continue;

    const review = reviews.productionBySessionId.get(sessionId);
    merged.push({
      path: targetPath,
      name: path.basename(targetPath, path.extname(targetPath)) || 'Session',
      cwd: path.dirname(targetPath),
      modifiedAt: activeActions.reduce(
        (latest, action) => action.requestedAt > latest ? action.requestedAt : latest,
        activeActions[0]?.requestedAt ?? new Date(0).toISOString(),
      ),
      messageCount: 0,
      sessionId,
      isPlaceholder: true,
      ...(review ? {
        reviewed: true,
        reviewId: review.reviewId,
        reviewedAt: review.reviewedAt,
        ...(review.identityFallback === true ? { identityFallback: true } : {}),
      } : {}),
      closureActions: actions,
    });
    representedSessionIds.add(sessionId);
    representedPaths.add(targetPath);
  }

  return merged;
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
