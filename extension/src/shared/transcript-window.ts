export interface TranscriptWindowBudgets {
  /** Initial tail rows loaded on open/preload/create. */
  tailCount: number;
  /** Rows requested per older/newer page fetch. */
  pageSize: number;
  /** Hard cap for rows kept in an active loaded window. */
  maxLoadedCount: number;
  /** Tail rows retained for inactive sessions before hard eviction. */
  inactiveTailCount: number;
  /** Inactive session transcript eviction TTL in milliseconds. */
  inactiveTtlMs: number;
}

/**
 * Central transcript windowing budgets used by backend slicing, host culling,
 * and webview paging behavior.
 */
export const TRANSCRIPT_WINDOW_BUDGETS: TranscriptWindowBudgets = {
  // Keep initial open/preload payloads lean. Older history remains one click or
  // automatic page request away, while 60 rows comfortably covers the recent
  // conversation and cuts cold-tab mapping/serialization/render work by 40%.
  tailCount: 60,
  pageSize: 40,
  maxLoadedCount: 240,
  inactiveTailCount: 40,
  inactiveTtlMs: 2 * 60 * 1000,
};
