/**
 * Sidecar + open-tabs I/O for the `session_review` tool.
 *
 * - `PIE_OPEN_TABS` (host→backend push): JSON array of open-tab summaries.
 * - `PIE_REVIEWS_DIR` (host→backend env): directory holding `reviews.jsonl`.
 *
 * The tool is the SOLE writer of `reviews.jsonl` (append-only, latest per path
 * wins); the backend reads it and watches it to refresh the host UI. Here we
 * only read (for listOpen freshness) and append (for setReview).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OpenTabSummary, ReviewRecord, Completion } from './types';

const OPEN_TABS_ENV = 'PIE_OPEN_TABS';
const REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
const REVIEWS_FILE = 'reviews.jsonl';

/** Read the currently-open tab summaries the host pushed via `PIE_OPEN_TABS`. */
export function readOpenTabs(): OpenTabSummary[] {
  const raw = process.env[OPEN_TABS_ENV]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOpenTabSummary);
  } catch {
    return [];
  }
}

function isOpenTabSummary(value: unknown): value is OpenTabSummary {
  return !!value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string';
}

/** Read the latest review record per session path from the sidecar. */
export function readReviews(): Map<string, ReviewRecord> {
  const file = getReviewsFilePath();
  if (!file) return new Map();
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return new Map();
  }
  const latest = new Map<string, ReviewRecord>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = normalizeReview(parsed);
    if (record) latest.set(record.sessionPath, record);
  }
  return latest;
}

function normalizeReview(value: unknown): ReviewRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionPath !== 'string') return undefined;
  if (typeof v.done !== 'boolean') return undefined;
  if (typeof v.rating !== 'number' || !Number.isFinite(v.rating)) return undefined;
  if (v.completion !== 'fully' && v.completion !== 'partial' && v.completion !== 'setback') return undefined;
  return {
    sessionPath: v.sessionPath,
    done: v.done,
    rating: v.rating,
    completion: v.completion as Completion,
    reason: typeof v.reason === 'string' ? v.reason : '',
    evaluatedAt: typeof v.evaluatedAt === 'string' ? v.evaluatedAt : new Date(0).toISOString(),
  };
}

function getReviewsFilePath(): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir ? path.join(dir, REVIEWS_FILE) : undefined;
}

/** Append a review record to the sidecar, creating the dir/file if needed.
 *  Atomic-ish: append with a trailing newline. Returns the file path or throws. */
export function appendReview(record: ReviewRecord): string {
  const file = getReviewsFilePath();
  if (!file) {
    throw new Error('PIE_REVIEWS_DIR is not set — the host has not configured the session-review sidecar.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return file;
}