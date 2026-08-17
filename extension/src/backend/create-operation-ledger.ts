/**
 * Coordinator create-operation ledger (backend half of §6.3 idempotent create
 * timeout / late success).
 *
 * The extension host generates an operation identity for each `session.create`
 * / `session.duplicate` and keeps it stable across retries. This ledger is
 * scoped to one backend process (one coordinator generation): it dedupes
 * concurrent and retried RPCs by that `operationId` so a retry can never
 * create a second durable session.
 *
 * Entry lifecycle mirrors the plan's
 * `pending → delayed-awaiting-outcome → succeeded(path) | failed`:
 *
 * - `pending` — a durable attempt is in flight (or a retry is resuming one);
 *   concurrent/retried callers join the same promise instead of starting a
 *   second durable creation.
 * - `succeeded(path)` — the durable result is retained for the generation; a
 *   completed retry reuses the path (and best-effort re-publishes
 *   `session.opened` so a first emission lost inside the host's timeout
 *   window is recovered).
 * - `failed` — a definitive failure before a durable path exists. Once the
 *   SDK create/fork durability barrier has atomically published the file and the
 *   cold manager is retained with its path, later payload publication errors
 *   settle as `succeeded(path)` so the correlated acknowledgement can reconcile
 *   the host without orphaning the committed session.
 *
 * The ledger is intentionally pure coordination: the durable creation and the
 * publication steps stay in the request handlers, which register the durable
 * path only after the SDK-owned durable create barrier succeeds and its exact
 * process-local cold manager is retained (`registerDurablePath`).
 */

import { toErrorMessage } from '../shared/error-message';

/** Outcome of one create/duplicate operation handled through the ledger. */
export interface CreateOperationResult {
  sessionPath: string;
}

export interface CreateOperationRunOptions {
  /** Stable host-generated operation identity. Must be a non-empty string. */
  operationId: string;
  /** Full operation including the SDK-owned atomic durable-header barrier and
   * process-local manager installation. Must call `registerDurablePath`
   * synchronously immediately after both succeed, so a later publication failure cannot create a
   * second session or lose the one-use manager handoff. */
  execute(registerDurablePath: (sessionPath: string) => void): Promise<CreateOperationResult>;
  /** Resume publication for an already-created durable path after a previous
   * attempt retained its manager but failed before the cold snapshot completed. */
  resume(durablePath: string): Promise<CreateOperationResult>;
  /** Best-effort re-publication for a retry of a completed operation: rebuilds
   *  and emits `session.opened` (with the operation identity) so a first
   *  emission the host missed inside its timeout window is recovered. Errors
   *  are swallowed — the durable result is already committed and the retry
   *  must still succeed. */
  republish?(sessionPath: string): Promise<void>;
}

type LedgerEntry =
  | { state: 'pending'; promise: Promise<CreateOperationResult>; durablePath?: string }
  | { state: 'succeeded'; sessionPath: string }
  | { state: 'failed'; error: string; durablePath?: string };

export class CreateOperationLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  run(options: CreateOperationRunOptions): Promise<CreateOperationResult> {
    const existing = this.entries.get(options.operationId);
    if (existing) {
      if (existing.state === 'pending') {
        // Concurrent/retried call while the durable attempt is in flight:
        // join the same operation; it owns the single durable creation and
        // the single publication.
        return existing.promise;
      }
      if (existing.state === 'succeeded') {
        // Completed durable result is reused; a retry cannot create a second
        // session. Re-publish best-effort so a lost first `session.opened`
        // still reconciles late success on the host. `Promise.resolve().then`
        // also converts a synchronous republish throw into a rejection so the
        // retry ack can never fail on re-publication.
        if (options.republish) {
          void Promise.resolve().then(() => options.republish!(existing.sessionPath)).catch(() => undefined);
        }
        return Promise.resolve({ sessionPath: existing.sessionPath });
      }
      // A failed entry is necessarily pre-commit (post-commit failures are
      // converted to succeeded above), so an explicit retry starts anew.
      this.entries.delete(options.operationId);
    }
    return this.startAttempt(options);
  }

  private startAttempt(
    options: CreateOperationRunOptions,
    durablePath?: string,
  ): Promise<CreateOperationResult> {
    const pending: Extract<LedgerEntry, { state: 'pending' }> = {
      state: 'pending',
      promise: undefined as never,
      ...(durablePath !== undefined ? { durablePath } : {}),
    };
    const promise = (async (): Promise<CreateOperationResult> => {
      try {
        const result = durablePath !== undefined
          ? await options.resume(durablePath)
          : await options.execute((path) => { pending.durablePath = path; });
        this.entries.set(options.operationId, { state: 'succeeded', sessionPath: result.sessionPath });
        return result;
      } catch (error) {
        if (pending.durablePath !== undefined) {
          // Durable creation is the commit point. A later runtime/payload/event
          // publication failure is loss of acknowledgement, not proof that the
          // session failed to exist. Return the committed path so the host can
          // reconcile its pending tab from the correlated acknowledgement; a
          // retry may still best-effort republish the full snapshot.
          this.entries.set(options.operationId, {
            state: 'succeeded',
            sessionPath: pending.durablePath,
          });
          return { sessionPath: pending.durablePath };
        }
        this.entries.set(options.operationId, {
          state: 'failed',
          error: toErrorMessage(error),
        });
        throw error;
      }
    })();
    pending.promise = promise;
    this.entries.set(options.operationId, pending);
    return promise;
  }
}
