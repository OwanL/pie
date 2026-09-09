import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Default TTL for the Copilot catalog refresh, shared across sessions and
 * processes. Copilot's account-visible model set changes rarely, so a bounded
 * window avoids a network fetch, reconciliation, and codegen on every session
 * startup while still converging within hours. An explicit command bypasses it.
 */
export const DEFAULT_CATALOG_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
export const COPILOT_CATALOG_SYNC_MARKER = '.copilot-catalog-sync.json';

/**
 * The freshness marker is rebuildable cache state. Keep the catalog and its
 * configuration-writer lock in the agent directory; only the advisory marker
 * follows Pie's canonical cache seam when the backend provides one.
 */
export function resolveCatalogRefreshMarkerPath(
  agentDir: string,
  cacheDir = process.env.PIE_CACHE_DIR,
): string {
  const configured = cacheDir?.trim();
  const markerRoot = configured && path.isAbsolute(configured) ? path.resolve(configured) : agentDir;
  return path.join(markerRoot, COPILOT_CATALOG_SYNC_MARKER);
}

/**
 * Cross-process TTL gate for Copilot catalog refreshes.
 *
 * A successful refresh records its timestamp in a shared marker file (one per
 * agent directory, visible to every VS Code window sharing it). Until the TTL
 * elapses, session startups skip the network fetch, reconciliation, and codegen
 * entirely — the on-disk catalog is already current. The marker is
 * self-healing: a missing, unparseable, or partial file is treated as stale, so
 * a corrupted write simply triggers a refresh rather than locking the process
 * on a stale catalog.
 *
 * The marker is written with a plain `writeFile`: it is advisory and
 * self-healing, so the atomic-rename machinery used for the authoritative
 * `models.yaml` is not required here.
 */
export class FileCatalogRefreshTiming {
  constructor(
    private readonly markerPath: string,
    private readonly ttlMs: number = DEFAULT_CATALOG_REFRESH_TTL_MS,
  ) {}

  async isFresh(): Promise<boolean> {
    let parsed: { lastRefreshMs?: unknown };
    try {
      parsed = JSON.parse(await readFile(this.markerPath, 'utf8')) as { lastRefreshMs?: unknown };
    } catch {
      return false;
    }
    const last = parsed.lastRefreshMs;
    if (typeof last !== 'number' || !Number.isFinite(last)) return false;
    const ageMs = Date.now() - last;
    return ageMs >= 0 && ageMs < this.ttlMs;
  }

  async markRefreshed(): Promise<void> {
    await mkdir(path.dirname(this.markerPath), { recursive: true });
    await writeFile(this.markerPath, `${JSON.stringify({ lastRefreshMs: Date.now() })}\n`, 'utf8');
  }
}
