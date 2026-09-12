/** Maintained canonical execution summary semantics.
 *
 * Root agent-run lifecycle rows are counted independently from provider calls
 * and assistant-turn facets. The recorder owns persistence and scope changes;
 * this module keeps the count/coverage rules pure and shared by its writer and
 * read DTOs.
 */

export type ExecutionSummaryScope =
  | { kind: 'global' }
  | { kind: 'session'; rootSessionId: string };

export type ExecutionSummaryCoverage = 'known' | 'partial' | 'unknown';
export type ExecutionSummaryTimingCoverage = 'known' | 'partial' | 'unknown';
export type ExecutionSummaryDeliveryCoverage = 'complete' | 'retained_only' | 'unknown';
export type ExecutionSummaryRunCoverage = 'complete' | 'partial' | 'unknown' | 'unavailable';
export type ExecutionSummaryAttributionCoverage = 'single' | 'mixed' | 'unknown';

export interface ExecutionSummaryLatest {
  generationId: string;
  executionId: string;
  sourceKey: string | null;
  startedAtMs: number | string | null;
  endedAtMs: number | string | null;
}

/** Source-chronological usage summary for one retained root execution. This
 * is intentionally separate from latestSettled, whose ordering is the
 * recorder delivery revision and remains useful as a diagnostic. */
export interface CanonicalExecutionLatestRun {
  generationId: string;
  executionId: string;
  rootSessionId: string | null;
  sourceKey: string | null;
  outcome: string | null;
  startedAtMs: number | string | null;
  endedAtMs: number | string;
  costUsd: number | null;
  inputTokens: number | string | null;
  outputTokens: number | string | null;
  /** Coverage of known channels among retained provider settlements only. */
  usageCoverage: ExecutionSummaryRunCoverage;
  provider: string | null;
  modelId: string | null;
  attributionCoverage: ExecutionSummaryAttributionCoverage;
  /** Provider settlements currently carry no canonical turn identity. */
  turnSeries: [];
  turnSeriesCoverage: 'unavailable';
}

export interface CanonicalExecutionSummary {
  revision: number | string;
  scope: ExecutionSummaryScope;
  executionCount: number;
  /** Retained captured root lifecycle rows with an explicit begin observation.
   * This does not assert that the producer delivered every execution. */
  begunCount: number;
  settledCount: number;
  lifecycleCoverage: ExecutionSummaryCoverage;
  /** Timing coverage is separate from lifecycle count coverage and is also
   * scoped to retained captured rows. */
  timingCoverage: ExecutionSummaryTimingCoverage;
  /** Recorder delivery-history coverage; this is distinct from the retained
   * row count and prevents an empty legacy projection implying no history. */
  deliveryCoverage: ExecutionSummaryDeliveryCoverage;
  latestSettled: ExecutionSummaryLatest | null;
}

export interface ExecutionSummaryCounts {
  executionCount: number;
  begunCount: number;
  settledCount: number;
  startedAtCount: number;
  endedAtCount: number;
}

export function executionSummaryCoverage(
  executionCount: number,
  begunCount: number,
  settledCount: number,
): ExecutionSummaryCoverage {
  if (!Number.isSafeInteger(executionCount) || executionCount < 0
    || !Number.isSafeInteger(begunCount) || begunCount < 0
    || !Number.isSafeInteger(settledCount) || settledCount < 0
    || begunCount > executionCount || settledCount > executionCount) {
    return 'unknown';
  }
  return begunCount === executionCount && settledCount === executionCount ? 'known' : 'partial';
}

export function executionSummaryTimingCoverage(
  executionCount: number,
  startedAtCount: number,
  endedAtCount: number,
): ExecutionSummaryTimingCoverage {
  if (!Number.isSafeInteger(executionCount) || executionCount < 0
    || !Number.isSafeInteger(startedAtCount) || startedAtCount < 0
    || !Number.isSafeInteger(endedAtCount) || endedAtCount < 0
    || startedAtCount > executionCount || endedAtCount > executionCount) {
    return 'unknown';
  }
  return startedAtCount === executionCount && endedAtCount === executionCount ? 'known' : 'partial';
}

export function applyExecutionSummaryDelta(
  current: ExecutionSummaryCounts,
  delta: ExecutionSummaryCounts,
): ExecutionSummaryCounts {
  const executionCount = current.executionCount + delta.executionCount;
  const begunCount = current.begunCount + delta.begunCount;
  const settledCount = current.settledCount + delta.settledCount;
  const startedAtCount = current.startedAtCount + delta.startedAtCount;
  const endedAtCount = current.endedAtCount + delta.endedAtCount;
  if (!Number.isSafeInteger(executionCount) || executionCount < 0
    || !Number.isSafeInteger(begunCount) || begunCount < 0
    || !Number.isSafeInteger(settledCount) || settledCount < 0
    || !Number.isSafeInteger(startedAtCount) || startedAtCount < 0
    || !Number.isSafeInteger(endedAtCount) || endedAtCount < 0
    || begunCount > executionCount || settledCount > executionCount
    || startedAtCount > executionCount || endedAtCount > executionCount) {
    throw new RangeError('Canonical execution summary counts are outside the safe range.');
  }
  return { executionCount, begunCount, settledCount, startedAtCount, endedAtCount };
}

export function emptyExecutionSummary(
  revision: number | string,
  scope: ExecutionSummaryScope,
  deliveryCoverage: ExecutionSummaryDeliveryCoverage = 'unknown',
): CanonicalExecutionSummary {
  return {
    revision,
    scope,
    executionCount: 0,
    begunCount: 0,
    settledCount: 0,
    lifecycleCoverage: 'known',
    timingCoverage: 'known',
    deliveryCoverage,
    latestSettled: null,
  };
}

export function executionSummaryFromCounts(
  revision: number | string,
  scope: ExecutionSummaryScope,
  counts: ExecutionSummaryCounts,
  latestSettled: ExecutionSummaryLatest | null,
  deliveryCoverage: ExecutionSummaryDeliveryCoverage = 'unknown',
): CanonicalExecutionSummary {
  return {
    revision,
    scope,
    ...counts,
    lifecycleCoverage: executionSummaryCoverage(counts.executionCount, counts.begunCount, counts.settledCount),
    timingCoverage: executionSummaryTimingCoverage(
      counts.executionCount,
      counts.startedAtCount,
      counts.endedAtCount,
    ),
    deliveryCoverage,
    latestSettled,
  };
}
