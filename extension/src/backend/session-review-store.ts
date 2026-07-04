import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SessionReview, SessionSummary } from '../shared/protocol';

/**
 * Session-review sidecar persistence.
 *
 * The SDK owns the session JSONL files and exposes no append path to pie, so
 * agent session reviews (`done` / `rating` / `completion` / `reason`) live in a
 * separate append-only JSONL sidecar: `<PIE_REVIEWS_DIR>/reviews.jsonl`. One
 * JSON object per line; the latest record per `sessionPath` wins.
 *
 * Single-writer / single-reader contract:
 *  - The `session_review` tool (the sole writer) appends a record per review.
 *  - The backend (the sole reader) reads here and merges the latest record per
 *    path back into `SessionSummary` for the host.
 *
 * `PIE_REVIEWS_DIR` is set by the host at backend spawn
 * (`extension/src/host/backend/client.ts`) as a sibling of the sessions dir,
 * so both the backend and the tool (same process) agree on the location.
 */

/** Env var holding the reviews directory. Set by the host at spawn. */
export const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
/** The sidecar filename inside the reviews directory. */
export const REVIEWS_FILE = 'reviews.jsonl';

/** Resolve the reviews directory from the env var, or undefined when unset. */
export function getReviewsDir(): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir || undefined;
}

/** Resolve the reviews file path, or undefined when the dir env is unset. */
function getReviewsFilePath(): string | undefined {
  const dir = getReviewsDir();
  return dir ? path.join(dir, REVIEWS_FILE) : undefined;
}

/**
 * Read the review sidecar and return the latest record per `sessionPath`.
 *
 * The file is small (one line per review; sessions are few), so this is read
 * fresh on every `listSessions`/`buildCurrentSummary` call rather than cached
 * — that keeps the merge correct after the tool appends a record without
 * requiring the backend to maintain a cache synchronized with the writer.
 *
 * Returns an empty map when the dir is unset, the file is missing, or every
 * line fails to parse (a corrupt file never breaks session listing).
 */
export function readReviews(): Map<string, SessionReview> {
  const file = getReviewsFilePath();
  if (!file) return new Map();

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // Missing file (no reviews yet) or unreadable — treat as empty.
    return new Map();
  }

  const latest = new Map<string, SessionReview>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }
    const record = normalizeReview(parsed);
    if (record) {
      latest.set(record.sessionPath, record);
    }
  }
  return latest;
}

/** Coerce a parsed JSONL line into a `SessionReview`, or undefined if invalid. */
function normalizeReview(value: unknown): SessionReview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionPath !== 'string') return undefined;
  if (typeof v.done !== 'boolean') return undefined;
  if (typeof v.rating !== 'number' || !Number.isFinite(v.rating)) return undefined;
  const completion = v.completion;
  if (completion !== 'fully' && completion !== 'partial' && completion !== 'setback') return undefined;
  // Multi-reviewer provenance (optional): validate shape and drop malformed
  // values so a corrupt sidecar line never breaks session listing/review.
  const rawBuckets = v.reviewerBuckets;
  const reviewerBuckets = Array.isArray(rawBuckets) && rawBuckets.every((b) => typeof b === 'string')
    ? (rawBuckets as string[])
    : undefined;
  const rawCount = v.reviewerCount;
  const reviewerCount = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
    ? rawCount
    : undefined;
  return {
    sessionPath: v.sessionPath,
    done: v.done,
    rating: v.rating,
    completion,
    reason: typeof v.reason === 'string' ? v.reason : '',
    evaluatedAt: typeof v.evaluatedAt === 'string' ? v.evaluatedAt : new Date(0).toISOString(),
    ...(reviewerBuckets !== undefined ? { reviewerBuckets } : {}),
    ...(reviewerCount !== undefined ? { reviewerCount } : {}),
  };
}

/**
 * Merge a session's latest review record into a `SessionSummary` (immutable).
 * Returns the original summary unchanged when no review exists for its path.
 */
export function mergeReviewIntoSummary(summary: SessionSummary, reviews: Map<string, SessionReview>): SessionSummary {
  const review = reviews.get(summary.path);
  if (!review) return summary;
  return {
    ...summary,
    done: review.done,
    rating: review.rating,
    completion: review.completion,
    reviewReason: review.reason,
    evaluatedAt: review.evaluatedAt,
    ...(review.reviewerBuckets !== undefined ? { reviewerBuckets: review.reviewerBuckets } : {}),
    ...(review.reviewerCount !== undefined ? { reviewerCount: review.reviewerCount } : {}),
  };
}

/** Ensure the reviews directory exists (best-effort; failures are swallowed). */
export function ensureReviewsDir(): void {
  const dir = getReviewsDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: the tool will also attempt to create it on first write.
  }
}

/**
 * Watch the review sidecar for changes and invoke `onChange` (debounced) so
 * the backend can re-emit `session.list.changed` and the host UI reflects the
 * new `done`/`rating` promptly after the tool appends a record.
 *
 * Robustness: `fs.watch` is platform-flaky and can fire on the same-process
 * write that the tool performs; a 200ms debounce coalesces bursts. If watching
 * fails (unsupported FS / missing dir), the change is still picked up on the
 * next any-cause `session.list.changed`, so freshness degrades only to
 * "next session event" rather than breaking. Returns a disposer.
 */
export function startReviewWatcher(onChange: () => void): () => void {
  const dir = getReviewsDir();
  if (!dir) return () => {};

  ensureReviewsDir();
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, (_, filename) => {
      if (filename !== REVIEWS_FILE) return;
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