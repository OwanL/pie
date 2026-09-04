export const ACTIVITY_INTERVAL_KINDS = [
  'operation',
  'busy',
  'provider',
  'retry_wait',
  'tool',
  'history_compaction',
  'auxiliary',
] as const;

export type ActivityIntervalKind = typeof ACTIVITY_INTERVAL_KINDS[number];

/** One correlated working-time interval. An absent endedAt is a durable open
 * interval and must be recovered rather than restarted after host replacement. */
export interface ActivityIntervalRecord {
  readonly schemaVersion: 1;
  readonly intervalId: string;
  readonly sessionId: string | null;
  readonly sessionPath: string;
  readonly parentRunId: string | null;
  readonly parentOperationId: string | null;
  readonly invocationId: string | null;
  readonly toolId: string | null;
  readonly kind: ActivityIntervalKind;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
}
