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

async function readMtimeMs(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.parse(stat.mtime.toISOString());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Latest local run-store, catalog, or side-channel input used by local-default loading. */
export async function readLatestLocalAnalyticsInputMs(
  outcomesRootDir: string,
  additionalInputPaths: readonly string[] = [],
): Promise<number | null> {
  const candidates = await listStorageDirCandidates(outcomesRootDir);
  const timestamps = [
    candidates[0]?.latestActivityMs ?? null,
    ...await Promise.all(additionalInputPaths.map(readMtimeMs)),
  ].filter((timestamp): timestamp is number => timestamp !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

/** Missing databases and databases older than any local-default input must be rebuilt. */
export async function shouldRebuildLocalDefaultDuckDb(
  dbPath: string,
  outcomesRootDir: string,
  additionalInputPaths: readonly string[] = [],
): Promise<boolean> {
  const dbMtimeMs = await readMtimeMs(dbPath);
  if (dbMtimeMs === null) return true;
  const inputMtimeMs = await readLatestLocalAnalyticsInputMs(outcomesRootDir, additionalInputPaths);
  return inputMtimeMs !== null && inputMtimeMs > dbMtimeMs;
}

/** Local-default rebuild inputs: the active model catalog, the generated
 *  historical pricing catalog relocated with the tracked analysis workspace
 *  (B6), and the side-channel usage logs under the durable data root. */
export function buildLocalDefaultRebuildInputs(configRoot: string): string[] {
  return [
    path.join(configRoot, 'models.json'),
    path.join(configRoot, 'analytics', 'analysis', 'model-pricing-history.json'),
    path.join(configRoot, 'data', 'pruning.jsonl'),
    path.join(configRoot, 'data', 'tool-result-pruning.jsonl'),
    path.join(configRoot, 'data', 'warm-bash.jsonl'),
  ];
}
