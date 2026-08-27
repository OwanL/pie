import type { Dirent, BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveSessionStorageDir } from '../shared/session-storage-paths';

export type BackendSessionDirectoryReader = (directory: string) => Promise<Dirent<string>[]>;
export type BackendSessionStatReader = (filePath: string) => Promise<BigIntStats>;

/** A cheap identity for deciding whether a session file needs incremental
 * metadata reconciliation. Nanosecond timestamps plus file identity distinguish
 * ordinary append/rewrite/replace operations; the metadata reader additionally
 * checks bounded head/tail witnesses before treating a size increase as the
 * normal SDK append path. The witnesses do not hash the whole old prefix. */
export interface BackendSessionFileFingerprint {
  path: string;
  pathKey: string;
  sizeBytes: number;
  modifiedNs: string;
  changedNs: string;
  device: string;
  inode: string;
}

const readBackendSessionDirectory: BackendSessionDirectoryReader = async (directory) =>
  await fs.readdir(directory, { withFileTypes: true });

const readBackendSessionStat: BackendSessionStatReader = async (filePath) =>
  await fs.stat(filePath, { bigint: true });

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

function isMissingFileError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function backendSessionFingerprintKey(
  fingerprint: BackendSessionFileFingerprint,
): string {
  return [
    fingerprint.sizeBytes,
    fingerprint.modifiedNs,
    fingerprint.changedNs,
    fingerprint.device,
    fingerprint.inode,
  ].join(':');
}

export function backendSessionFingerprintsEqual(
  left: BackendSessionFileFingerprint,
  right: BackendSessionFileFingerprint,
): boolean {
  return left.pathKey === right.pathKey
    && backendSessionFingerprintKey(left) === backendSessionFingerprintKey(right);
}

export async function statBackendSessionFile(
  filePath: string,
  statFile: BackendSessionStatReader = readBackendSessionStat,
): Promise<BackendSessionFileFingerprint | undefined> {
  try {
    const stat = await statFile(filePath);
    return {
      path: path.resolve(filePath),
      pathKey: backendSessionPathKey(filePath),
      sizeBytes: Number(stat.size),
      modifiedNs: stat.mtimeNs.toString(),
      changedNs: stat.ctimeNs.toString(),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    };
  } catch (error) {
    // Files can disappear between readdir and stat. That is an ordinary
    // inventory deletion; permission/I/O failures remain visible to callers so
    // they can retain the last complete catalog.
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

/** Enumerate the canonical JSONL scan shape and capture strong stat
 * fingerprints without reading transcript bodies. Stat work is bounded so a
 * large store cannot flood the filesystem request queue. */
export async function readBackendSessionInventory(
  agentDir: string,
  sessionDir: string | undefined,
  readDirectory: BackendSessionDirectoryReader = readBackendSessionDirectory,
  statFile: BackendSessionStatReader = readBackendSessionStat,
): Promise<BackendSessionFileFingerprint[]> {
  const roots = new Map<string, { path: string; includeDirectFiles: boolean }>();
  const addRoot = (root: string, includeDirectFiles: boolean): void => {
    const key = backendSessionPathKey(root);
    const existing = roots.get(key);
    roots.set(key, {
      path: existing?.path ?? root,
      includeDirectFiles: includeDirectFiles || existing?.includeDirectFiles === true,
    });
  };
  if (sessionDir) addRoot(sessionDir, true);
  else addRoot(path.join(agentDir, 'sessions'), false);

  const paths = [...new Set((await Promise.all([...roots.values()]
    .map((root) => readVisibleJsonlPaths(root.path, root.includeDirectFiles, readDirectory))))
    .flat()
    .map((filePath) => path.resolve(filePath)))];

  const results = new Array<BackendSessionFileFingerprint | undefined>(paths.length);
  let nextIndex = 0;
  const workerCount = Math.min(24, paths.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < paths.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await statBackendSessionFile(paths[index]!, statFile);
    }
  }));
  return results
    .filter((value): value is BackendSessionFileFingerprint => value !== undefined)
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
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
