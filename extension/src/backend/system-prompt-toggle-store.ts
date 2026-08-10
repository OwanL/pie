import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
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
 * session. The backend is the sole reader and writer. Writes are serialized
 * because each one is a read-modify-write of the shared JSON object.
 *
 * `PIE_REVIEWS_DIR` is set by the host at backend spawn
 * (`extension/src/host/backend/client.ts`); when unset, toggles are
 * in-memory only (lost on backend restart).
 */

/** The sidecar filename inside the reviews/data directory. */
const TOGGLES_FILE = 'system-prompt-toggles.json';

/** Serialize shared-sidecar mutations so concurrent session updates do not
 * overwrite each other. Reads wait for mutations already in progress. */
let pendingWrite: Promise<void> = Promise.resolve();

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

async function readSystemPromptTogglesFromFile(file: string): Promise<Record<string, string[]>> {
  try {
    const content = await fs.readFile(file, 'utf8');
    return normalizeMap(JSON.parse(content));
  } catch (error) {
    backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
    return {};
  }
}

/**
 * Read the toggle sidecar and return the disabled-entry map. Returns an empty
 * map when the dir is unset, the file is missing, or the content is malformed
 * (a corrupt file never breaks session open).
 */
export async function readSystemPromptToggles(): Promise<Record<string, string[]>> {
  const file = getTogglesFilePath();
  if (!file) return {};
  await pendingWrite;
  return await readSystemPromptTogglesFromFile(file);
}

/** Read the disabled-entry list for a single session (empty when none). */
export async function readSystemPromptTogglesForSession(sessionPath: string): Promise<string[]> {
  return (await readSystemPromptToggles())[sessionPath] ?? [];
}

async function persistSystemPromptTogglesForSession(
  file: string,
  sessionPath: string,
  disabledEntries: readonly string[],
  strict = false,
): Promise<void> {
  let tempFile: string | undefined;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const all = await readSystemPromptTogglesFromFile(file);
    if (disabledEntries.length === 0) {
      delete all[sessionPath];
    } else {
      all[sessionPath] = [...new Set(disabledEntries)];
    }

    // Replacing a completed temporary file avoids exposing a partially-written
    // JSON document to a concurrent backend/session-open read.
    tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(all, null, 2) + '\n', 'utf8');
    await fs.rename(tempFile, file);
  } catch (error) {
    backendTrace('systemPromptToggles', 'write.failed', { level: 'debug', error: toErrorMessage(error), file });
    if (strict) throw error;
    // Non-fatal: in-memory state still drives the live session.
  } finally {
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
    }
  }
}

/**
 * Persist the disabled-entry list for a single session, leaving other sessions
 * intact. Best-effort: a write failure is swallowed (toggles stay in-memory for
 * the running session; the next successful write re-flushes). The file is
 * replaced atomically where the filesystem supports rename replacement.
 */
export async function writeSystemPromptTogglesForSession(
  sessionPath: string,
  disabledEntries: readonly string[],
  strict = false,
): Promise<void> {
  const file = getTogglesFilePath();
  if (!file) return;

  const write = pendingWrite.then(() => (
    persistSystemPromptTogglesForSession(file, sessionPath, disabledEntries, strict)
  ));
  // A best-effort persistence failure must not block a later update.
  pendingWrite = write.catch(() => undefined);
  await write;
}
