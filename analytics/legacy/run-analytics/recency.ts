import type { RunSnapshot } from './types';

/**
 * Recency timestamp (ms) used to pick the newest snapshot for a runId:
 * `updatedAt`, then `finalizedAt`, then `startedAt`. Shared by the JSONL
 * history deduplication in `queryRunAnalyticsStore` and the in-memory
 * pending-snapshot map in `RunAnalyticsStorage` — so both rank snapshots
 * identically.
 */
export function runRecencyMs(snapshot: RunSnapshot): number {
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isNaN(updatedAt)) {
    return updatedAt;
  }
  if (snapshot.finalizedAt) {
    const finalizedAt = Date.parse(snapshot.finalizedAt);
    if (!Number.isNaN(finalizedAt)) {
      return finalizedAt;
    }
  }
  return Date.parse(snapshot.startedAt);
}
