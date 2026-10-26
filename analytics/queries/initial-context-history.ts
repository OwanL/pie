import type { CanonicalAnalyticsReadModel } from './query-entry.js';

export interface InitialContextHistoryStats {
  medianTokens: number;
  p25Tokens: number;
  p75Tokens: number;
}

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Full observation envelopes live in payload_json, not just their fields.
 * Select the newest bounded sample before deduplication so repeated roots
 * cannot receive extra statistical weight. Invalid token samples never count. */
export const INITIAL_CONTEXT_HISTORY_SQL = `
  SELECT root_session_id,
    json_extract(payload_json, '$.fields.initialContext.tokens') AS tokens
  FROM analytics_feature_observations
  WHERE feature = 'initialContext' AND decision = 'post-pruning'
    AND rule_version = 'request-prefix-v1' AND root_session_id IS NOT NULL
    AND json_extract(payload_json, '$.fields.initialContext.cohortKey') = ?
    AND json_type(payload_json, '$.observedAtMs') IN ('integer', 'text')
    AND CAST(CAST(json_extract(payload_json, '$.observedAtMs') AS INTEGER) AS TEXT)
      = CAST(json_extract(payload_json, '$.observedAtMs') AS TEXT)
    AND CAST(json_extract(payload_json, '$.observedAtMs') AS INTEGER) BETWEEN ? AND ?
  ORDER BY CAST(json_extract(payload_json, '$.observedAtMs') AS INTEGER) DESC,
    observation_registry_key DESC
  LIMIT 1000
`;

export async function readInitialContextHistory(
  reader: Pick<CanonicalAnalyticsReadModel, 'executeQuery'>,
  cohortKey: string,
  nowMs: number = Date.now(),
): Promise<InitialContextHistoryStats | undefined> {
  if (!cohortKey || !Number.isSafeInteger(nowMs)) return undefined;
  const result = await reader.executeQuery({
    sql: INITIAL_CONTEXT_HISTORY_SQL,
    parameters: [cohortKey, nowMs - HISTORY_WINDOW_MS, nowMs],
    maxRows: 1000,
    maxResultBytes: 256 * 1024,
    maxCellBytes: 4096,
  }, undefined, 'background');
  if (result.truncation.byteLimit || result.truncation.cellLimit || result.truncation.rowLimit) return undefined;
  const roots = new Set<string>();
  const tokens: number[] = [];
  for (const row of result.rows) {
    if (typeof row.root_session_id !== 'string' || !row.root_session_id || roots.has(row.root_session_id)) continue;
    // The newest sample owns this root, including when it is invalid.
    roots.add(row.root_session_id);
    if (typeof row.tokens !== 'number' || !Number.isSafeInteger(row.tokens) || row.tokens < 0) continue;
    tokens.push(row.tokens);
  }
  if (tokens.length < 20) return undefined;
  tokens.sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const index = (tokens.length - 1) * p;
    const lower = Math.floor(index);
    return Math.round(tokens[lower]! + (tokens[Math.ceil(index)]! - tokens[lower]!) * (index - lower));
  };
  return { medianTokens: quantile(0.5), p25Tokens: quantile(0.25), p75Tokens: quantile(0.75) };
}
