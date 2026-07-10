/**
 * `RequestTracker` — promise + timeout + cancel bookkeeping for in-flight
 * JSON-RPC requests, keyed by request id (`req-NN`).
 *
 * Brief B (phase-scoped timers): the tracker timeout owns the **pre-ack**
 * window (the queue-time RPC itself, e.g. `message.send` sized ~10s). Its
 * rejection is the pre-ack failure window (→ `SendResult{ok:false}` /
 * `EditResult{ok:false}` in the effect-runner). The **post-ack, pre-commit**
 * window is owned by a separate send-timer in `EffectRunner` (dispatches
 * `PreflightFailed` on fire). See `docs/STATE_CONTRACT.md` § Optimistic
 * Reconciliation "Timer ownership".
 *
 * Cancellation: `create` accepts an `AbortSignal`. Aborting rejects the request
 * with a cancel error. Brief E (round 3) uses this to cancel an in-flight
 * `message.send` on interrupt; session close / backend stop reject all via
 * `rejectAll`. The signal listener is detached on every settle path
 * (resolve / reject / rejectAll / timeout / cancel) so no listener leaks.
 */

/** Options for an in-flight request. The per-call `timeoutMs` overrides the
 *  caller-supplied method default; `signal` aborts the request cleanly. */
export interface RequestOptions {
  /** Per-call timeout budget (ms). Overrides the method default. */
  timeoutMs?: number;
  /** Abort signal — aborting rejects the request with a cancel error. */
  signal?: AbortSignal;
}

/** A cancel error produced by the tracker's abort path or `cancel`. Carries a
 *  stable `name`/`code` so Brief E/H can distinguish a cancel from a backend
 *  failure when mapping to a user-facing message (cross-realm safe via the
 *  name check, not just `instanceof`). */
export class CancelError extends Error {
  readonly code = 'PIE_CANCELLED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CancelError';
  }
}

/** Build a descriptive cancel error for a request id. Exported so callers
 *  (Brief E) can recognise / construct cancel errors with a stable shape. */
export function cancelledError(id: string, reason?: string): CancelError {
  return new CancelError(reason ? `Request ${id} was cancelled: ${reason}` : `Request ${id} was cancelled.`);
}

export class RequestTracker<TResult = unknown> {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: TResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  create(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const entry: {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = {
        resolve,
        reject,
        // Assigned below; the closures capture `entry` so they read the real
        // timeout once it is scheduled.
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
        signal,
        onAbort: undefined,
      };

      // Abort path: a caller-owned cancel hook (Brief E interrupt / session
      // close via rejectAll is a separate path). Detaches its own listener.
      const onAbort = (): void => {
        if (!this.pending.has(id)) return;
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        entry.reject(cancelledError(id));
      };

      // Timeout path: owns the pre-ack window. On fire, reject + detach.
      entry.timeout = setTimeout(() => {
        this.pending.delete(id);
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
        reject(new Error(`Timed out waiting for response to ${id}`));
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          // Already aborted: reject synchronously without storing the entry.
          clearTimeout(entry.timeout);
          reject(cancelledError(id));
          return;
        }
        entry.onAbort = onAbort;
        signal.addEventListener('abort', onAbort);
      }

      this.pending.set(id, entry);
    });
  }

  resolve(id: string, value: TResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }

    clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    this.pending.delete(id);
    entry.resolve(value);
    return true;
  }

  reject(id: string, error: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }

    clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    this.pending.delete(id);
    entry.reject(error);
    return true;
  }

  /** Cancel a single in-flight request by id (rejects with a cancel error).
   *  Returns true if a pending request was cancelled. The preferred cancel
   *  mechanism is the per-call `AbortSignal` (caller-owned, e.g. Brief E's
   *  interrupt); this is a lower-level escape hatch for callers that hold the
   *  `req-NN` id. */
  cancel(id: string, reason?: string): boolean {
    return this.reject(id, cancelledError(id, reason));
  }

  rejectAll(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timeout);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}
