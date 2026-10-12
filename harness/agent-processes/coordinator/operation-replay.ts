import { BackendError } from './server-io.js';

type ReplayEntry<Result> = { intentFingerprint: string } & (
  | { state: 'pending'; promise: Promise<Result> }
  | { state: 'accepted'; result: Result }
  | { state: 'failed'; code: string; message: string }
);

/** Join or replay an existing operation without changing its stored outcome.
 * Ledger-specific execution and semantic observations remain with the owner. */
export function replayOperation<Result>(
  operationId: string,
  intentFingerprint: string,
  entry: ReplayEntry<Result>,
  intentDescription: string,
): Promise<Result> {
  if (entry.intentFingerprint !== intentFingerprint) {
    throw new BackendError(
      'OPERATION_INTENT_MISMATCH',
      `Operation ${operationId} was already used for a different ${intentDescription} intent.`,
    );
  }
  if (entry.state === 'pending') return entry.promise;
  if (entry.state === 'accepted') return Promise.resolve(entry.result);
  return Promise.reject(new BackendError(entry.code, entry.message));
}
