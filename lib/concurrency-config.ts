/** Browser-safe concurrency configuration vocabulary shared by preferences,
 * runtime enforcement, and diagnostics. No process/environment reads here. */
export type ConcurrencyLimitSource =
  | 'configured-default'
  | 'saved-preference'
  | 'environment-override'
  | 'safety-fallback';

export interface ResolvedConcurrencyLimit {
  value: number;
  source: ConcurrencyLimitSource;
}

/** Runtime acknowledgement evidence, not a second preference authority.
 * Effective is omitted while workers are unsynchronized or none are running. */
export interface SubagentConcurrencyStatus {
  scope: 'worker-process';
  configured: ResolvedConcurrencyLimit;
  effective?: ResolvedConcurrencyLimit;
  workerCount: number;
  pendingWorkers: number;
}

export const DEFAULT_SUBAGENT_MAX_INFLIGHT = 8;
export const MIN_SUBAGENT_MAX_INFLIGHT = 1;
export const MAX_SUBAGENT_MAX_INFLIGHT = 16;

export function isSubagentConcurrencyLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_SUBAGENT_MAX_INFLIGHT && value <= MAX_SUBAGENT_MAX_INFLIGHT;
}

export function concurrencySourceLabel(source: ConcurrencyLimitSource | undefined): string {
  switch (source) {
    case 'configured-default': return 'Configured default';
    case 'saved-preference': return 'Saved preference';
    case 'environment-override': return 'Environment override';
    case 'safety-fallback': return 'Safety fallback';
    default: return 'Source unavailable';
  }
}
