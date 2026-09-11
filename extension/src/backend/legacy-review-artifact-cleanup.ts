import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveSessionIdentity } from '../shared/session-identity.js';

const LEGACY_REVIEWS_DIR_ENV = 'PIE_REVIEWS_DIR';
const LEGACY_REVIEW_FILES = ['reviews.jsonl', 'closure-actions.jsonl'] as const;

/**
 * Scrub one forgotten private session from retired review sidecars without
 * restoring review ingestion, decoration, reconciliation, or tooling.
 */
export function forgetLegacyReviewArtifacts(sessionPath: string, sessionId?: string): void {
  const reviewsDir = process.env[LEGACY_REVIEWS_DIR_ENV]?.trim();
  if (!reviewsDir || !sessionPath) return;

  const identity = sessionId ?? resolveSessionIdentity(sessionPath).sessionId;
  let firstFailure: unknown;
  for (const fileName of LEGACY_REVIEW_FILES) {
    const filePath = path.join(reviewsDir, fileName);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') firstFailure ??= error;
      continue;
    }

    const kept: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown> | undefined;
      try {
        const value = JSON.parse(trimmed) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        // Keep malformed records because their ownership cannot be proved.
      }
      const belongsToSession = parsed && (
        parsed.sessionId === identity
        || parsed.targetSessionId === identity
        || parsed.targetSessionPath === sessionPath
      );
      if (!belongsToSession) kept.push(line);
    }

    const next = kept.length > 0 ? `${kept.join('\n')}\n` : '';
    if (next === raw) continue;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, next, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      firstFailure ??= error;
      try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
  }
  if (firstFailure) throw firstFailure;
}
