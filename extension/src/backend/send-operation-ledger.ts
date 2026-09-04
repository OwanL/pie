import { createHash } from 'node:crypto';

import type { ComposerInput } from '../shared/protocol.js';
import { BackendError } from './server-io.js';

export interface SendOperationAcceptance {
  operationId: string;
  requestId?: string;
  queued?: boolean;
}

export type MessageOperationFailureOutcome = 'failed' | 'cancelled' | 'superseded' | 'aborted';

export type SendOperationStatus =
  | {
      operationId: string;
      state: 'pending';
      committed: boolean;
    }
  | {
      operationId: string;
      state: 'accepted';
      requestId?: string;
      queued: boolean;
      committed: boolean;
    }
  | {
      operationId: string;
      state: 'failed';
      code: string;
      message: string;
      outcome: MessageOperationFailureOutcome;
      committed: boolean;
    };

type Entry =
  | {
      state: 'pending';
      intentFingerprint: string;
      promise: Promise<SendOperationAcceptance>;
      committed: boolean;
    }
  | {
      state: 'accepted';
      intentFingerprint: string;
      result: SendOperationAcceptance;
      committed: boolean;
    }
  | {
      state: 'failed';
      intentFingerprint: string;
      code: string;
      message: string;
      outcome: MessageOperationFailureOutcome;
      committed: boolean;
    };

/** Generation-scoped idempotency authority for message mutations. Ordinary
 * sends live with the worker SessionContext; compound edits use the same
 * semantics from the coordinator because their mutation deliberately replaces
 * the worker generation. */
export class SendOperationLedger {
  private readonly entries = new Map<string, Entry>();

  run(
    operationId: string,
    intentFingerprint: string,
    execute: () => Promise<SendOperationAcceptance>,
  ): Promise<SendOperationAcceptance> {
    const existing = this.entries.get(operationId);
    if (existing) {
      this.assertIntent(operationId, existing.intentFingerprint, intentFingerprint);
      if (existing.state === 'pending') return existing.promise;
      if (existing.state === 'accepted') return Promise.resolve(existing.result);
      return Promise.reject(new BackendError(existing.code, existing.message));
    }

    const pending: Extract<Entry, { state: 'pending' }> = {
      state: 'pending',
      intentFingerprint,
      promise: undefined as never,
      committed: false,
    };
    // Defer execution by one microtask so the pending entry is installed before
    // an SDK callback can synchronously report commit/failure from execute().
    const promise = Promise.resolve().then(execute).then((result) => {
      // A synchronous SDK callback can report pre-commit failure or commit
      // before execute returns its acknowledgement. Preserve that newer
      // semantic observation rather than overwriting it with acceptance.
      const current = this.entries.get(operationId);
      if (current?.state !== 'failed') {
        this.entries.set(operationId, {
          state: 'accepted',
          intentFingerprint,
          result,
          committed: pending.committed,
        });
      }
      return result;
    }, (error: unknown) => {
      const code = error instanceof BackendError ? error.code : 'MESSAGE_OPERATION_REJECTED';
      const message = error instanceof Error ? error.message : String(error);
      const current = this.entries.get(operationId);
      if (current?.state !== 'failed') {
        this.entries.set(operationId, {
          state: 'failed', intentFingerprint, code, message, outcome: 'failed',
          committed: current?.committed ?? pending.committed,
        });
      }
      throw error;
    });
    pending.promise = promise;
    this.entries.set(operationId, pending);
    return promise;
  }

  markCommitted(operationId: string | undefined): void {
    if (!operationId) return;
    const entry = this.entries.get(operationId);
    if (!entry || entry.state === 'failed') return;
    entry.committed = true;
  }

  markFailed(
    operationId: string | undefined,
    code: string,
    message: string,
    outcome: MessageOperationFailureOutcome = 'failed',
  ): void {
    if (!operationId) return;
    const entry = this.entries.get(operationId);
    if (!entry || entry.state === 'failed' || (entry.state === 'accepted' && entry.committed)) return;
    this.entries.set(operationId, {
      state: 'failed',
      intentFingerprint: entry.intentFingerprint,
      code,
      message,
      outcome,
      committed: entry.committed,
    });
  }

  /** Coordinator compound operations may commit one durable phase before a
   * later accepted worker phase settles. Unlike markFailed(), this explicitly
   * preserves that committed evidence while recording the late failure. */
  markFailedAfterCommit(
    operationId: string,
    code: string,
    message: string,
    outcome: MessageOperationFailureOutcome = 'failed',
  ): void {
    const entry = this.entries.get(operationId);
    if (!entry || entry.state === 'failed') return;
    this.entries.set(operationId, {
      state: 'failed',
      intentFingerprint: entry.intentFingerprint,
      code,
      message,
      outcome,
      committed: entry.committed,
    });
  }

  status(operationId: string): SendOperationStatus | undefined {
    const entry = this.entries.get(operationId);
    if (!entry) return undefined;
    if (entry.state === 'pending') {
      return { operationId, state: 'pending', committed: entry.committed };
    }
    if (entry.state === 'failed') {
      return {
        operationId,
        state: 'failed',
        code: entry.code,
        message: entry.message,
        outcome: entry.outcome,
        committed: entry.committed,
      };
    }
    return {
      operationId,
      state: 'accepted',
      ...(entry.result.requestId ? { requestId: entry.result.requestId } : {}),
      queued: entry.result.queued === true,
      committed: entry.committed,
    };
  }

  private assertIntent(operationId: string, expected: string, actual: string): void {
    if (expected === actual) return;
    throw new BackendError(
      'OPERATION_INTENT_MISMATCH',
      `Operation ${operationId} was already used for a different message mutation intent.`,
    );
  }
}

function canonicalFingerprint(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/** Hash the validated mutation-defining fields in a fixed property order.
 * Transport request IDs and acknowledgement attempts are intentionally absent. */
export function canonicalSendIntentFingerprint(input: {
  sessionPath: string;
  text: string;
  inputs: ComposerInput[];
  localId?: string;
}): string {
  return canonicalFingerprint({
    kind: 'message.send',
    sessionPath: input.sessionPath,
    text: input.text,
    inputs: input.inputs,
    localId: input.localId ?? null,
  });
}

export function canonicalContinueIntentFingerprint(input: { sessionPath: string }): string {
  return canonicalFingerprint({ kind: 'message.continue', sessionPath: input.sessionPath });
}

export function canonicalCompactIntentFingerprint(input: { sessionPath: string; reason: 'manual' }): string {
  return canonicalFingerprint({ kind: 'message.compact', sessionPath: input.sessionPath, reason: input.reason });
}

export function canonicalEditIntentFingerprint(input: {
  sessionPath: string;
  entryId: string;
  text: string;
  inputs: ComposerInput[];
  localId?: string;
}): string {
  return canonicalFingerprint({
    kind: 'message.edit',
    sessionPath: input.sessionPath,
    entryId: input.entryId,
    text: input.text,
    inputs: input.inputs,
    localId: input.localId ?? null,
  });
}
