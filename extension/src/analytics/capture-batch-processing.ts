import {
  AnalyticsSourceConflictError,
  AnalyticsValidationError,
  type AnalyticsObservation,
} from '../../../shared/analytics/contracts.js';
import { AnalyticsReconciliationCapacityError } from './sqlite-recorder.js';
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
  readonly code: 'subject_deleted' | 'source_conflict' | 'invalid_record' | 'reconciliation_capacity';
  readonly error: string;
}

function deletedSubjectError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('Analytics capture subject is deleted:') ? message : undefined;
}

function observationRejection(error: unknown): Omit<ObservationRejection, 'index'> | undefined {
  const deleted = deletedSubjectError(error);
  if (deleted) return { code: 'subject_deleted', error: deleted };
  if (error instanceof AnalyticsSourceConflictError
    || (error instanceof Error
      && /^Analytics source sequence .* (?:is behind contiguous watermark|was already delivered without this source fact)\./u.test(error.message))) {
    return { code: 'source_conflict', error: error instanceof Error ? error.message : String(error) };
  }
  if (error instanceof AnalyticsValidationError) {
    return { code: 'invalid_record', error: error.message };
  }
  if (error instanceof AnalyticsReconciliationCapacityError) {
    return { code: 'reconciliation_capacity', error: error.message };
  }
  return undefined;
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
      // Materialize only the value batch required by the recorder. Avoid the
      // intermediate slice of capture references followed by a second mapped
      // array; the envelopes remain owned by the worker for this request.
      const values = new Array<AnalyticsObservation>(end - start);
      for (let index = start; index < end; index += 1) values[index - start] = captures[index]!.value;
      await retrySqliteLock(
        () => recorder.submitBatch(values),
        lockRetryBudget,
      );
    } catch (error) {
      const batchRejection = observationRejection(error);
      if (!batchRejection) throw error;
      if (batchRejection.code === 'subject_deleted') {
        // Deletion is sink-consumed: the recorder transaction already durably
        // retained each deletion disposition and the thrown error is only the
        // per-batch signal. Replaying would double-count deleted delivery.
        for (let index = start; index < end; index += 1) {
          rejections.push({ index, ...batchRejection });
        }
        start = end;
        continue;
      }

      // The batch transaction could not isolate the individual outcome. Replay
      // the bounded slice record-by-record so a malformed, conflicting, or
      // reconciliation capacity-blocked record is acknowledged as rejected
      // instead of poisoning the immutable queue and making every later flush
      // retry it.
      for (let index = start; index < end; index += 1) {
        try {
          await retrySqliteLock(
            () => recorder.submit(captures[index]!.value),
            lockRetryBudget,
          );
        } catch (recordError) {
          const recordRejection = observationRejection(recordError);
          if (!recordRejection) throw recordError;
          rejections.push({ index, ...recordRejection });
        }
      }
    }
    start = end;
  }

  return rejections;
}
