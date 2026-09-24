/** Durable SDK entry ancestry observed only after the entry was persisted.
 * This is accounting metadata, not a transcript/UI payload. The JSON-safe
 * analytics RPC contract is shared by the harness and hosts. */
export interface AnalyticsBranchObservedPayload {
  sessionPath: string;
  entryId: string;
  parentEntryId?: string | null;
  selectedEntryId: string;
  observedAt: number;
}

/** Validate the runtime payload without importing application protocol code. */
export function isAnalyticsBranchObservedPayload(value: unknown): value is AnalyticsBranchObservedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const isIdentifier = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && !candidate.includes('\0');

  return typeof payload.sessionPath === 'string'
    && payload.sessionPath.length > 0
    && isIdentifier(payload.entryId)
    && (payload.parentEntryId === undefined || payload.parentEntryId === null
      || isIdentifier(payload.parentEntryId))
    && isIdentifier(payload.selectedEntryId)
    && typeof payload.observedAt === 'number'
    && Number.isFinite(payload.observedAt);
}
