import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { SessionLifecycleCleaner } from './session-filesystem-lifecycle.js';
import type { SessionLifecycleStore } from './session-lifecycle-store.js';

/** Authorization value that must be present for a cutoff to run.
 *
 * The cutoff closes every Pie-managed session and starts their expiry deadlines,
 * which is irreversible for those sessions, so it is gated on an explicit
 * authorization rather than on a boolean someone could pass by accident. */
export const STORAGE_CUTOFF_AUTHORIZATION_ENV = 'PIE_STORAGE_CUTOFF_AUTHORIZATION' as const;
export const STORAGE_CUTOFF_AUTHORIZATION_VALUE = 'p7b-authorized-v1' as const;

/** Durable record of one storage cutoff, so the outcome is inspectable and the
 * operation is idempotent rather than repeatable. */
export interface StorageCutoffReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly completedAt: string;
  readonly closedSessionIds: readonly string[];
  readonly alreadyClosedSessionIds: readonly string[];
  /** Sessions whose private close deleted their data immediately. */
  readonly deletedSessionIds: readonly string[];
  readonly failures: ReadonlyArray<{ sessionId: string; error: string }>;
}

export interface StorageCutoffOptions {
  store: SessionLifecycleStore;
  cleaner: SessionLifecycleCleaner;
  /** Resolved state directory that owns the receipt. */
  stateDir: string;
  /** Sessions to close. Discovered by the caller from explicitly configured
   * source roots; this module never searches for sessions itself, because
   * guessing ownership is exactly the ambiguity the plan forbids. */
  inventory: readonly string[];
  operationId: string;
  now?: () => number;
}

export const STORAGE_CUTOFF_RECEIPT_FILENAME = 'storage-cutoff-receipt-v1.json';

/** Close every inventoried session through its normal close barrier.
 *
 * This is the bounded storage cutoff's orchestration step. Per the plan it
 * coordinates closure, writer fencing and the expiry deadlines; it does not
 * migrate files. Ordinary closes record the cutoff timestamp and deadline and
 * leave transcripts, settings and artifacts untouched until expiry, while a
 * private close deletes immediately through the existing cleaner, so this adds
 * no new deletion path.
 *
 * Deliberately narrow:
 * - It never invents session identity. Sessions come from the caller's inventory
 *   of explicitly configured roots; an unknown or malformed id is reported as a
 *   failure rather than skipped silently.
 * - It is resumable. A session already closed is recorded as such and not closed
 *   twice, and `resolveClose` is itself idempotent, so an interrupted cutoff can
 *   be re-run and converges.
 * - It returns a receipt rather than throwing on a per-session failure, so one
 *   unresolvable session cannot make the rest appear unclosed. The caller decides
 *   whether a partial cutoff is acceptable; a nonzero failure count is visible.
 */
export async function performStorageCutoff(options: StorageCutoffOptions): Promise<StorageCutoffReceipt> {
  const now = options.now ?? Date.now;
  const closedSessionIds: string[] = [];
  const alreadyClosedSessionIds: string[] = [];
  const deletedSessionIds: string[] = [];
  const failures: Array<{ sessionId: string; error: string }> = [];

  for (const sessionId of options.inventory) {
    let existing;
    try {
      existing = options.store.get(sessionId);
    } catch (error) {
      failures.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!existing) {
      // The inventory named a session the operational store has never seen.
      // Recording it as a failure is what keeps ambiguous ownership visible
      // instead of silently dropping a session that may hold real data.
      failures.push({ sessionId, error: 'Inventory named a session the lifecycle store does not know.' });
      continue;
    }
    if (existing.closedAtMs !== null && existing.closedAtMs !== undefined) {
      alreadyClosedSessionIds.push(sessionId);
      continue;
    }
    try {
      // `user_close` deliberately. The plan states the storage cutoff closes
      // sessions through their normal barriers: ordinary closes record the
      // deadline and leave transcripts, settings and artifacts untouched until
      // expiry, while private closes delete immediately. Using a distinct cause
      // would need a schema migration for the CHECK constraint and would buy
      // nothing, because the receipt already identifies which operation produced
      // these closes.
      //
      // The close operation id must be per session: `close_operation_id` carries a
      // UNIQUE constraint, so reusing one cutoff-wide id fails the second close
      // with a constraint error. The cutoff's own operationId is still recorded in
      // the receipt, which is what ties the set of closes to this operation.
      const closeOperationId = `${options.operationId}:${sessionId}`;
      const resolution = await options.cleaner.closeSession(sessionId, closeOperationId, 'user_close');
      closedSessionIds.push(sessionId);
      if (resolution.disposition === 'delete') deletedSessionIds.push(sessionId);
    } catch (error) {
      failures.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const receipt: StorageCutoffReceipt = {
    schemaVersion: 1,
    operationId: options.operationId,
    completedAt: new Date(now()).toISOString(),
    closedSessionIds,
    alreadyClosedSessionIds,
    deletedSessionIds,
    failures,
  };
  mkdirSync(options.stateDir, { recursive: true });
  writeFileSync(
    path.join(options.stateDir, STORAGE_CUTOFF_RECEIPT_FILENAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  return receipt;
}

/** sha256 of a receipt's exact serialized bytes.
 *
 * The activation manifest records `cutoffReceiptSha256`, which is what ties an
 * active generation to the cutoff it was activated against. Hashing the same
 * serialization the receipt is written with is what makes that link verifiable
 * later rather than merely asserted. */
export function storageCutoffReceiptSha256(receipt: StorageCutoffReceipt): string {
  return createHash('sha256').update(`${JSON.stringify(receipt, null, 2)}\n`).digest('hex');
}
