import { createHash } from 'node:crypto';

import { toErrorMessage } from '../shared/error-message.js';
import { BackendError } from './server-io.js';

export interface InterruptOperationResult {
  interrupted: boolean;
  settled?: boolean;
  alreadyStopped?: boolean;
  forcedRecovery?: boolean;
  teardownTimedOut?: boolean;
  recoveryPending?: boolean;
}

export type InterruptOperationStatus =
  | { operationId: string; state: 'pending'; committed: false }
  | ({ operationId: string; state: 'accepted'; committed: boolean } & InterruptOperationResult)
  | {
      operationId: string;
      state: 'failed';
      code: string;
      message: string;
      outcome: 'failed';
      committed: false;
    };

type Entry =
  | { state: 'pending'; intentFingerprint: string; promise: Promise<InterruptOperationResult> }
  | { state: 'accepted'; intentFingerprint: string; result: InterruptOperationResult }
  | { state: 'failed'; intentFingerprint: string; code: string; message: string };

/** Process-generation authority for public Stop. A stable operation identity
 * owns exactly one immutable session intent and one terminal backend outcome;
 * concurrent requests join it and later retries replay it. */
export class InterruptOperationLedger {
  private readonly entries = new Map<string, Entry>();

  run(
    operationId: string,
    intentFingerprint: string,
    execute: () => Promise<InterruptOperationResult>,
  ): Promise<InterruptOperationResult> {
    const existing = this.entries.get(operationId);
    if (existing) {
      this.assertIntent(operationId, existing.intentFingerprint, intentFingerprint);
      if (existing.state === 'pending') return existing.promise;
      if (existing.state === 'accepted') return Promise.resolve(existing.result);
      return Promise.reject(new BackendError(existing.code, existing.message));
    }

    const promise = Promise.resolve().then(execute).then((result) => {
      this.entries.set(operationId, { state: 'accepted', intentFingerprint, result });
      return result;
    }, (error: unknown) => {
      const code = error instanceof BackendError ? error.code : 'MESSAGE_INTERRUPT_FAILED';
      const message = toErrorMessage(error);
      this.entries.set(operationId, { state: 'failed', intentFingerprint, code, message });
      throw error;
    });
    this.entries.set(operationId, { state: 'pending', intentFingerprint, promise });
    return promise;
  }

  status(operationId: string): InterruptOperationStatus | undefined {
    const entry = this.entries.get(operationId);
    if (!entry) return undefined;
    if (entry.state === 'pending') return { operationId, state: 'pending', committed: false };
    if (entry.state === 'failed') {
      return {
        operationId,
        state: 'failed',
        code: entry.code,
        message: entry.message,
        outcome: 'failed',
        committed: false,
      };
    }
    return {
      operationId,
      state: 'accepted',
      committed: entry.result.settled === true,
      ...entry.result,
    };
  }

  private assertIntent(operationId: string, expected: string, actual: string): void {
    if (expected === actual) return;
    throw new BackendError(
      'OPERATION_INTENT_MISMATCH',
      `Operation ${operationId} was already used for a different interrupt intent.`,
    );
  }
}

export function canonicalInterruptIntentFingerprint(sessionPath: string): string {
  return createHash('sha256').update(JSON.stringify({ kind: 'message.interrupt', sessionPath })).digest('hex');
}
