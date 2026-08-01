import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveSessionStorageDir } from '../shared/session-storage-paths';

export type BackendSessionDirectoryReader = (directory: string) => Promise<Dirent<string>[]>;

const readBackendSessionDirectory: BackendSessionDirectoryReader = async (directory) =>
  await fs.readdir(directory, { withFileTypes: true });

export function backendSessionPathKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function resolveBackendSessionDir(
  agentDir: string,
  configured: string | undefined,
): string | undefined {
  return resolveSessionStorageDir(agentDir, configured);
}

function isMissingDirectoryError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readDirectoryOrEmpty(
  directory: string,
  readDirectory: BackendSessionDirectoryReader,
): Promise<Dirent<string>[]> {
  try {
    return await readDirectory(directory);
  } catch (error) {
    if (isMissingDirectoryError(error)) return [];
    throw error;
  }
}

async function readVisibleJsonlPaths(
  root: string,
  includeDirectFiles: boolean,
  readDirectory: BackendSessionDirectoryReader,
): Promise<string[]> {
  const entries = await readDirectoryOrEmpty(root, readDirectory);

  const direct = includeDirectFiles
    ? entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => path.join(root, entry.name))
    : [];
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const directory = path.join(root, entry.name);
      return (await readDirectoryOrEmpty(directory, readDirectory))
        .filter((child) => child.isFile() && child.name.endsWith('.jsonl'))
        .map((child) => path.join(directory, child.name));
    }));
  return [...direct, ...nested.flat()];
}

/** Cheap filename-only signature matching the configured canonical scan shape
 *  (the SDK default `<agentDir>/sessions` root is scanned only while nothing
 *  is configured, so a configured store retires the perpetual legacy scan). */
export async function readBackendSessionInventorySignature(
  agentDir: string,
  sessionDir: string | undefined,
  readDirectory: BackendSessionDirectoryReader = readBackendSessionDirectory,
): Promise<string> {
  const roots = new Map<string, { path: string; includeDirectFiles: boolean }>();
  const addRoot = (root: string, includeDirectFiles: boolean): void => {
    const key = backendSessionPathKey(root);
    const existing = roots.get(key);
    roots.set(key, {
      path: existing?.path ?? root,
      includeDirectFiles: includeDirectFiles || existing?.includeDirectFiles === true,
    });
  };
  if (sessionDir) {
    // Canonical-only: once a session directory is configured, the installer's
    // verified migration is the authority for legacy content, so the legacy
    // `<agentDir>/sessions` root is retired here. `npm run doctor` detects
    // any newly stranded legacy sessions instead of scanning them forever.
    addRoot(sessionDir, true);
  } else {
    // With nothing configured, the embedded SDK keeps its default
    // `<agentDir>/sessions` store; scan that so cache invalidation tracks it.
    addRoot(path.join(agentDir, 'sessions'), false);
  }

  const files = (await Promise.all([...roots.values()]
    .map((root) => readVisibleJsonlPaths(root.path, root.includeDirectFiles, readDirectory))))
    .flat()
    .map(backendSessionPathKey);
  return JSON.stringify([...new Set(files)].sort());
}
