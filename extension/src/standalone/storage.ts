import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { updateSettingsJsonObject } from '../shared/settings-json-update';
import type { SessionHostStorage } from '../host/session-service/platform';

/**
 * The standalone host owns only this small key/value document.  Sessions,
 * transcripts, analytics, and SDK configuration continue to use their
 * existing authorities; this file is the standalone equivalent of VS Code's
 * globalState for renderer/session-service preferences and tab checkpoints.
 */
export interface StandaloneHostStorageOptions {
  stateDir: string;
  workspaceCwd: string;
}

function workspaceStorageKey(workspaceCwd: string): string {
  const normalizedPath = path.resolve(workspaceCwd).replaceAll('\\', '/');
  const normalized = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function standaloneHostStoragePath(options: StandaloneHostStorageOptions): string {
  return path.join(
    options.stateDir,
    'host-storage',
    `${workspaceStorageKey(options.workspaceCwd)}.json`,
  );
}

function readDocument(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Standalone host storage is not valid JSON (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Standalone host storage must contain a JSON object (${filePath}).`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * File-backed storage with a read-modify-write lock around every update.
 * `updateSettingsJsonObject` serializes updates within a process and uses the
 * same advisory lock across standalone processes, so two hosts cannot lose a
 * concurrent tab/prefs checkpoint.  The replacement itself is atomic.
 */
export class StandaloneHostStorage implements SessionHostStorage {
  readonly filePath: string;

  constructor(options: StandaloneHostStorageOptions) {
    this.filePath = standaloneHostStoragePath(options);
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
  }

  get<T>(key: string): T | undefined {
    const value = readDocument(this.filePath)[key];
    return value as T | undefined;
  }

  async update<T>(key: string, value: T | undefined): Promise<void> {
    await updateSettingsJsonObject(this.filePath, (current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  /** Test/diagnostic helper; production callers should use the platform seam. */
  async replaceDocument(document: Record<string, unknown>): Promise<void> {
    await updateSettingsJsonObject(this.filePath, () => ({ ...document }));
  }
}

