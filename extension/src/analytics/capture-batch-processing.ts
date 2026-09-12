import {
  AnalyticsSourceConflictError,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import {
  retrySqliteLock,
  type SqliteLockRetryBudget,
} from './sqlite-lock-retry.js';

export interface ObservationCapture {
  readonly subject: string;
  readonly value: AnalyticsObservation;
}

export interface ObservationBatchRecorder {
  submitBatch(observations: readonly AnalyticsObservation[]): void;
  submit(observation: AnalyticsObservation): void;
}

export interface ObservationRejection {
  readonly index: number;
  readonly code: 'subject_deleted' | 'source_conflict';
  readonly error: string;
}

function deletedSubjectError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('Analytics capture subject is deleted:') ? message : undefined;
}

/**
 * Process one observation IPC batch while retaining a transaction boundary
 * for each contiguous capture subject. The recorder and retry budget are
 * injected so this orchestration can be exercised against a real SQLite
 * recorder without adding a worker-only test control or changing IPC shape.
 */
export async function processObservationBatch(
  captures: readonly ObservationCapture[],
  recorder: ObservationBatchRecorder,
  lockRetryBudget: SqliteLockRetryBudget,
): Promise<ObservationRejection[]> {
  const rejections: ObservationRejection[] = [];

  // Preserve global queue order while retaining batch transactions for
  // contiguous captures owned by the same subject. A deletion fence can
  // reject that subject without discarding unrelated records in the IPC
  // batch.
  for (let start = 0; start < captures.length;) {
    let end = start + 1;
    while (end < captures.length && captures[end]!.subject === captures[start]!.subject) end += 1;
    try {
      await retrySqliteLock(
        () => recorder.submitBatch(captures.slice(start, end).map((capture) => capture.value)),
        lockRetryBudget,
      );
    } catch (error) {
      const deleted = deletedSubjectError(error);
      if (deleted) {
        for (let index = start; index < end; index += 1) {
          rejections.push({ index, code: 'subject_deleted', error: deleted });
        }
      } else if (error instanceof AnalyticsSourceConflictError) {
        // The batch transaction retained every original row. Replay the
        // bounded slice record-by-record so only changed identities are
        // rejected and unrelated immutable facts still advance.
        for (let index = start; index < end; index += 1) {
          try {
            await retrySqliteLock(
              () => recorder.submit(captures[index]!.value),
              lockRetryBudget,
            );
          } catch (recordError) {
            const recordDeleted = deletedSubjectError(recordError);
            if (recordDeleted) rejections.push({ index, code: 'subject_deleted', error: recordDeleted });
            else if (recordError instanceof AnalyticsSourceConflictError) {
              rejections.push({ index, code: 'source_conflict', error: recordError.message });
            } else throw recordError;
          }
        }
      } else {
        throw error;
      }
    }
    start = end;
  }

  return rejections;
}
