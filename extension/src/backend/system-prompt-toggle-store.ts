import * as fs from 'node:fs';
import * as path from 'node:path';

import { toErrorMessage } from '../shared/error-message';
import { REVIEWS_DIR_ENV } from './session-review-store.js';
import { backendTrace } from './log.js';

/**
 * Per-session system-prompt toggle persistence.
 *
 * The user can toggle individual system-prompt entries (harness, appended
 * prompt, AGENTS.md / project-context files, skills, tools, runtime line) off
 * from the composer toolbar menu. The disabled-entry set is per-session and
 * must survive reopening the session tab, so it lives in a sidecar JSON file
 * sibling to the reviews sidecar: `<PIE_REVIEWS_DIR>/system-prompt-toggles.json`.
 *
 * Shape: `{ [sessionPath]: string[] }` — the disabled entry ids for each
 * session. The backend is the sole reader and writer (no tool touches this),
 * so a plain JSON object (last-write-wins) is sufficient — no append-only
 * JSONL needed.
 *
 * `PIE_REVIEWS_DIR` is set by the host at backend spawn
 * (`extension/src/host/backend/client.ts`); when unset, toggles are
 * in-memory only (lost on backend restart).
 */

/** The sidecar filename inside the reviews/data directory. */
const TOGGLES_FILE = 'system-prompt-toggles.json';

function getTogglesFilePath(): string | undefined {
  const dir = process.env[REVIEWS_DIR_ENV]?.trim();
  return dir ? path.join(dir, TOGGLES_FILE) : undefined;
}

function normalizeMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!key) continue;
    if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
      out[key] = raw as string[];
    }
  }
  return out;
}

/**
 * Read the toggle sidecar and return the disabled-entry map. Returns an empty
 * map when the dir is unset, the file is missing, or the content is malformed
 * (a corrupt file never breaks session open).
 */
export function readSystemPromptToggles(): Record<string, string[]> {
  const file = getTogglesFilePath();
  if (!file) return {};
  try {
    const content = fs.readFileSync(file, 'utf8');
    return normalizeMap(JSON.parse(content));
  } catch (error) {
    backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
    return {};
  }
}

/** Read the disabled-entry list for a single session (empty when none). */
export function readSystemPromptTogglesForSession(sessionPath: string): string[] {
  return readSystemPromptToggles()[sessionPath] ?? [];
}

/**
 * Persist the disabled-entry list for a single session, leaving other sessions
 * intact. Best-effort: a write failure is swallowed (toggles stay in-memory for
 * the running session; the next successful write re-flushes).
 */
export function writeSystemPromptTogglesForSession(
  sessionPath: string,
  disabledEntries: readonly string[],
): void {
  const file = getTogglesFilePath();
  if (!file) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const all = readSystemPromptToggles();
    if (disabledEntries.length === 0) {
      delete all[sessionPath];
    } else {
      all[sessionPath] = [...new Set(disabledEntries)];
    }
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', 'utf8');
  } catch (error) {
    backendTrace('systemPromptToggles', 'write.failed', { level: 'debug', error: toErrorMessage(error), file });
    // Non-fatal: in-memory state still drives the live session.
  }
}
