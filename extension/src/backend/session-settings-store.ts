import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { toErrorMessage } from '../shared/error-message';
import { backendTrace } from './log.js';

/** Neutral runtime-data owner for session-scoped settings. */
export const SESSION_SETTINGS_DIR_ENV = 'PIE_SESSION_SETTINGS_DIR';
/** Transitional source used to read and scrub the pre-extraction sidecar. */
export const LEGACY_SESSION_SETTINGS_DIR_ENV = 'PIE_LEGACY_SESSION_SETTINGS_DIR';
export const SESSION_SETTINGS_FILE = 'system-prompt-toggles.json';

/** Serialize shared-sidecar mutations so concurrent session updates do not
 * overwrite each other. Reads wait for mutations already in progress. */
let pendingWrite: Promise<void> = Promise.resolve();

function getSessionSettingsFilePath(): string | undefined {
  const dir = process.env[SESSION_SETTINGS_DIR_ENV]?.trim();
  return dir ? path.join(dir, SESSION_SETTINGS_FILE) : undefined;
}

function getLegacySessionSettingsFilePath(): string | undefined {
  const dir = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV]?.trim();
  return dir ? path.join(dir, SESSION_SETTINGS_FILE) : undefined;
}

/** Whether this process has a durable sidecar location. Cold configuration
 * writes require it; live runtimes may still use their in-memory state when
 * it is absent, and privacy cleanup has nothing durable to remove in that case. */
export function isSystemPromptTogglePersistenceAvailable(): boolean {
  return getSessionSettingsFilePath() !== undefined || getLegacySessionSettingsFilePath() !== undefined;
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

/** Return undefined only for a missing sidecar; malformed content remains an
 * empty settings map, preserving the existing corrupt-sidecar behavior. */
async function readSystemPromptTogglesFromFile(file: string): Promise<Record<string, string[]> | undefined> {
  try {
    const content = await fs.readFile(file, 'utf8');
    try {
      return normalizeMap(JSON.parse(content));
    } catch (error) {
      backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
      return {};
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
    return {};
  }
}

async function readStoredSystemPromptToggles(): Promise<Record<string, string[]>> {
  const currentFile = getSessionSettingsFilePath();
  if (currentFile) {
    const current = await readSystemPromptTogglesFromFile(currentFile);
    if (current !== undefined) return current;
  }
  const legacyFile = getLegacySessionSettingsFilePath();
  return legacyFile ? (await readSystemPromptTogglesFromFile(legacyFile) ?? {}) : {};
}

/**
 * Read the toggle sidecar and return the disabled-entry map. Returns an empty
 * map when the dir is unset, the file is missing, or the content is malformed
 * (a corrupt file never breaks session open).
 */
export async function readSystemPromptToggles(): Promise<Record<string, string[]>> {
  await pendingWrite;
  return await readStoredSystemPromptToggles();
}

/** Read the disabled-entry list for a single session (empty when none). */
export async function readSystemPromptTogglesForSession(sessionPath: string): Promise<string[]> {
  return (await readSystemPromptToggles())[sessionPath] ?? [];
}

async function scrubLegacySessionEntry(sessionPath: string): Promise<void> {
  const legacyFile = getLegacySessionSettingsFilePath();
  const currentFile = getSessionSettingsFilePath();
  if (!legacyFile || !currentFile || legacyFile === currentFile) return;

  const existing = await readSystemPromptTogglesFromFile(legacyFile);
  if (existing === undefined || !(sessionPath in existing)) return;
  delete existing[sessionPath];
  if (Object.keys(existing).length === 0) {
    await fs.rm(legacyFile, { force: true });
    return;
  }

  const tempFile = `${legacyFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    await fs.rename(tempFile, legacyFile);
  } finally {
    await fs.unlink(tempFile).catch(() => undefined);
  }
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
    const all = await readStoredSystemPromptToggles();
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
    await scrubLegacySessionEntry(sessionPath);
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
  const file = getSessionSettingsFilePath() ?? getLegacySessionSettingsFilePath();
  if (!file) return;

  const write = pendingWrite.then(() => (
    persistSystemPromptTogglesForSession(file, sessionPath, disabledEntries, strict)
  ));
  // A best-effort persistence failure must not block a later update.
  pendingWrite = write.catch(() => undefined);
  await write;
}
