import * as crypto from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ANALYTICS_ACTIVITY_FILE_NAMES = [
  'run-snapshots.jsonl',
  'open-runs.a.json',
  'open-runs.b.json',
  'open-runs.gen',
] as const;

export interface StorageDirCandidate {
  storageDir: string;
  latestActivityMs: number;
}

export function normalizeFileSystemPathForWorkspaceKey(
  fileSystemPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let normalized = pathApi.normalize(fileSystemPath);

  if (!pathApi.isAbsolute(normalized)) {
    normalized = pathApi.resolve(normalized);
  }

  normalized = normalized.replace(/\\/g, '/');
  if (platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

export function buildWorkspaceAnalyticsIdFromRoot(
  workspaceRootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeFileSystemPathForWorkspaceKey(workspaceRootPath, platform);
  return JSON.stringify({ folders: [`file:${normalized}`] });
}

export function workspaceStorageHash(workspaceAnalyticsId: string): string {
  return crypto.createHash('sha256').update(workspaceAnalyticsId).digest('hex').slice(0, 16);
}

function buildWorkspaceAnalyticsIdFromWorkspaceFile(
  workspaceFilePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeFileSystemPathForWorkspaceKey(workspaceFilePath, platform);
  return JSON.stringify({ workspaceFile: `file:${normalized}` });
}

async function listWorkspaceFilePaths(workspaceRootPath: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(workspaceRootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.code-workspace'))
    .map((entry) => path.join(workspaceRootPath, entry.name));
}

export async function workspaceStorageHashCandidates(
  workspaceRootPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Set<string>> {
  const hashes = new Set<string>();

  hashes.add(workspaceStorageHash(buildWorkspaceAnalyticsIdFromRoot(workspaceRootPath, platform)));

  const workspaceFilePaths = await listWorkspaceFilePaths(workspaceRootPath);
  for (const workspaceFilePath of workspaceFilePaths) {
    hashes.add(workspaceStorageHash(buildWorkspaceAnalyticsIdFromWorkspaceFile(workspaceFilePath, platform)));
  }

  return hashes;
}

async function readLatestActivityMs(storageDir: string): Promise<number | null> {
  let latest: number | null = null;

  for (const fileName of ANALYTICS_ACTIVITY_FILE_NAMES) {
    const filePath = path.join(storageDir, fileName);
    try {
      const stat = await fs.stat(filePath);
      const timestamp = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.parse(stat.mtime.toISOString());
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return latest;
}

export async function listStorageDirCandidates(outcomesRootDir: string): Promise<StorageDirCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(outcomesRootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<StorageDirCandidate | null> => {
      const storageDir = path.join(outcomesRootDir, entry.name);
      const latestActivityMs = await readLatestActivityMs(storageDir);
      if (latestActivityMs === null) {
        return null;
      }
      return { storageDir, latestActivityMs };
    }));

  return candidates
    .filter((candidate): candidate is StorageDirCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.latestActivityMs !== left.latestActivityMs) {
        return right.latestActivityMs - left.latestActivityMs;
      }
      return path.basename(left.storageDir).localeCompare(path.basename(right.storageDir));
    });
}

export async function detectPreferredStorageDir(
  outcomesRootDir: string,
  workspaceRootPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates = await listStorageDirCandidates(outcomesRootDir);
  if (candidates.length === 0) {
    return null;
  }

  const preferredHashes = await workspaceStorageHashCandidates(workspaceRootPath, platform);
  const preferredCandidate = candidates.find((candidate) => preferredHashes.has(path.basename(candidate.storageDir)));
  return preferredCandidate?.storageDir ?? null;
}

export async function detectLatestStorageDir(outcomesRootDir: string): Promise<string | null> {
  const candidates = await listStorageDirCandidates(outcomesRootDir);
  return candidates[0]?.storageDir ?? null;
}

async function readMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.parse(stat.mtime.toISOString());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Latest local run-store, V2 review, catalog, or side-channel input used by local-default loading. */
export async function readLatestLocalAnalyticsInputMs(
  outcomesRootDir: string,
  reviewSidecarPath: string,
  additionalInputPaths: readonly string[] = [],
): Promise<number | null> {
  const candidates = await listStorageDirCandidates(outcomesRootDir);
  const timestamps = [
    candidates[0]?.latestActivityMs ?? null,
    await readMtimeMs(reviewSidecarPath),
    ...await Promise.all(additionalInputPaths.map(readMtimeMs)),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

/** Missing databases and databases older than any local-default input must be rebuilt. */
export async function shouldRebuildLocalDefaultDuckDb(
  dbPath: string,
  outcomesRootDir: string,
  reviewSidecarPath: string,
  additionalInputPaths: readonly string[] = [],
): Promise<boolean> {
  const dbMtimeMs = await readMtimeMs(dbPath);
  if (dbMtimeMs === null) return true;
  const inputMtimeMs = await readLatestLocalAnalyticsInputMs(outcomesRootDir, reviewSidecarPath, additionalInputPaths);
  return inputMtimeMs !== null && inputMtimeMs > dbMtimeMs;
}
