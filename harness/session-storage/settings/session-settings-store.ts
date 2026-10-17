import { randomUUID } from 'node:crypto';
import { acquireWindowsRuntimeLock } from '../../../lib/windows-runtime-lock/windows-runtime-lock.cjs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { toErrorMessage } from '../../../lib/structured-logging/error-message';
import { backendTrace } from '../../../lib/structured-logging/backend-log.js';

/** Neutral runtime-data owner for session-scoped settings. */
export const SESSION_SETTINGS_DIR_ENV = 'PIE_SESSION_SETTINGS_DIR';
/** Transitional source used to read and scrub the pre-extraction sidecar. */
export const LEGACY_SESSION_SETTINGS_DIR_ENV = 'PIE_LEGACY_SESSION_SETTINGS_DIR';
export const SESSION_SETTINGS_FILE = 'system-prompt-toggles.json';

/** Preserve process-local admission order. Directory kernel locks provide
 * cross-process exclusion; the two-file migration is not crash atomic. */
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

/** Return undefined only for a missing sidecar. User reads tolerate corrupt or
 * unreadable content; mutation reads reject it to preserve existing bytes. */
async function readSystemPromptTogglesFromFile(file: string, forMutation = false): Promise<Record<string, string[]> | undefined> {
  try {
    const content = await fs.readFile(file, 'utf8');
    try {
      const parsed: unknown = JSON.parse(content);
      // Tolerant session-open reads may discard invalid entries, but a mutation
      // must never replace existing state after silently discarding any of it.
      if (forMutation && (
        !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.entries(parsed).some(([key, raw]) => (
          !key || !Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')
        ))
      )) {
        throw new Error(`Malformed system-prompt toggle sidecar: ${file}`);
      }
      return normalizeMap(parsed);
    } catch (error) {
      if (forMutation) throw error;
      backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
      return {};
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (forMutation) throw error;
    backendTrace('systemPromptToggles', 'read.failed', { level: 'debug', error: toErrorMessage(error), file });
    return {};
  }
}

async function readStoredSystemPromptToggles(
  forMutation: boolean,
  currentFile: string | undefined,
  legacyFile: string | undefined,
): Promise<Record<string, string[]>> {
  if (currentFile) {
    const current = await readSystemPromptTogglesFromFile(currentFile, forMutation);
    if (current !== undefined) return current;
  }
  return legacyFile ? (await readSystemPromptTogglesFromFile(legacyFile, forMutation) ?? {}) : {};
}

/**
 * Read the toggle sidecar and return the disabled-entry map. Returns an empty
 * map when the dir is unset, the file is missing, or the content is malformed
 * (a corrupt file never breaks session open).
 */
export async function readSystemPromptToggles(): Promise<Record<string, string[]>> {
  const currentFile = getSessionSettingsFilePath();
  const legacyFile = getLegacySessionSettingsFilePath();
  await pendingWrite;
  return await readStoredSystemPromptToggles(false, currentFile, legacyFile);
}

/** Read the disabled-entry list for a single session (empty when none). */
export async function readSystemPromptTogglesForSession(sessionPath: string): Promise<string[]> {
  return (await readSystemPromptToggles())[sessionPath] ?? [];
}

async function scrubLegacySessionEntry(
  sessionPath: string,
  existing: Record<string, string[]> | undefined,
  currentFile: string | undefined,
  legacyFile: string | undefined,
): Promise<void> {
  if (!legacyFile || !currentFile || legacyFile === currentFile) return;

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
  strict: boolean,
  currentFile: string | undefined,
  legacyFile: string | undefined,
): Promise<void> {
  let tempFile: string | undefined;
  const releases: Array<() => Promise<void>> = [];
  try {
    const directories = [...new Set([currentFile, legacyFile].filter((entry): entry is string => !!entry)
      .map(entry => path.resolve(path.dirname(entry))))];
    // Qualify existing ancestors before creating any directory: unsupported
    // platforms/storage must fail without changing durable state.
    for (const directory of directories) {
      let ancestor = directory;
      for (;;) {
        try { await fs.stat(ancestor); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          ancestor = parent;
        }
      }
      const release = await acquireWindowsRuntimeLock(ancestor);
      await release();
    }
    for (const directory of directories) await fs.mkdir(directory, { recursive: true });
    // Canonical directory ordering makes reversed current/legacy layouts share
    // the same lock order; aliases deduplicate before acquisition.
    const identities = await Promise.all(directories.map(async directory => {
      const physical = await fs.realpath(directory);
      const stat = await fs.stat(physical, { bigint: true });
      return { directory, physical, key: `${stat.dev}:${stat.ino}` };
    }));
    const canonical = [...new Map(identities.map(entry => [entry.key, entry])).values()]
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    for (const entry of canonical) releases.push(await acquireWindowsRuntimeLock(entry.physical));
    const identityFor = (entry: string) => identities.find(directory => directory.directory === path.resolve(path.dirname(entry)))!.key;
    if (currentFile && legacyFile && identityFor(currentFile) === identityFor(legacyFile)) legacyFile = currentFile;
    // Validate every sidecar we may replace before publishing either one.
    // ENOENT alone permits creating new state; all other read failures abort.
    const legacy = legacyFile && currentFile && legacyFile !== currentFile
      ? await readSystemPromptTogglesFromFile(legacyFile, true)
      : undefined;
    const all = await readStoredSystemPromptToggles(true, currentFile, legacyFile);
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
    await scrubLegacySessionEntry(sessionPath, legacy, currentFile, legacyFile);
  } catch (error) {
    backendTrace('systemPromptToggles', 'write.failed', { level: 'debug', error: toErrorMessage(error), file });
    if (strict) throw error;
    // Non-fatal: in-memory state still drives the live session.
  } finally {
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
    }
    let releaseError: unknown;
    for (const release of releases.reverse()) {
      try { await release(); } catch (error) { releaseError ??= error; }
    }
    if (releaseError) {
      backendTrace('systemPromptToggles', 'write.failed', { level: 'debug', error: toErrorMessage(releaseError), file });
      if (strict) throw releaseError;
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
  const currentFile = getSessionSettingsFilePath();
  const legacyFile = getLegacySessionSettingsFilePath();
  const file = currentFile ?? legacyFile;
  if (!file) return;

  const write = pendingWrite.then(() => (
    persistSystemPromptTogglesForSession(file, sessionPath, disabledEntries, strict, currentFile, legacyFile)
  ));
  // A best-effort persistence failure must not block a later update.
  pendingWrite = write.catch(() => undefined);
  await write;
}
