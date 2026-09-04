/**
 * `RequestTracker` — promise + timeout bookkeeping for in-flight
 * JSON-RPC requests, keyed by request id (`req-NN`).
 *
 * Phase-scoped timers: the tracker timeout owns the **pre-ack**
 * window (the queue-time RPC itself, e.g. `message.send` sized ~10s). Its
 * rejection is the pre-ack failure window (→ `SendResult{ok:false}` /
 * `EditResult{ok:false}` in the effect-runner). The **post-ack, pre-commit**
 * window is owned by a separate send-timer in `EffectRunner` (dispatches
 * `PreflightFailed` on fire). See `docs/STATE_CONTRACT.md` § Optimistic
 * Reconciliation "Timer ownership".
 *
 * Cancellation: `create` accepts an `AbortSignal`. Aborting rejects the request
 * with a cancel error. Interrupt uses this to cancel an in-flight
 * `message.send` on interrupt; session close / backend stop reject all via
 * `rejectAll`. The signal listener is detached on every settle path
 * (resolve / reject / rejectAll / timeout) so no listener leaks.
 */

/** Options for an in-flight request. The per-call `timeoutMs` overrides the
 *  caller-supplied method default; `signal` aborts the local waiter cleanly. */
export interface RequestOptions {
  /** Per-call timeout budget (ms). Overrides the method default. */
  timeoutMs?: number;
  /** Abort signal — aborting rejects the local request waiter. */
  signal?: AbortSignal;
  /** Internal transport-settlement hook. When supplied, local cancellation or
   * timeout retains correlation bookkeeping until a backend response, write
   * failure, or backend shutdown proves the physical request has settled. */
  onTransportSettled?: () => void;
}

/** A cancel error produced by the tracker's abort path. Carries a
 *  stable `name`/`code` so the error mapper can distinguish a cancel from a backend
 *  failure when mapping to a user-facing message (cross-realm safe via the
 *  name check, not just `instanceof`). */
export class RequestTimeoutError extends Error {
  readonly code = 'PIE_RPC_TIMEOUT' as const;
  constructor(readonly requestId: string) {
    super(`Timed out waiting for response to ${requestId}`);
    this.name = 'RequestTimeoutError';
  }
}

export class CancelError extends Error {
  readonly code = 'PIE_CANCELLED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CancelError';
  }
}

/** Build a descriptive cancel error for a request id. Exported so callers
 *  can recognise / construct cancel errors with a stable shape. */
export function cancelledError(id: string): CancelError {
  return new CancelError(`Request ${id} was cancelled.`);
}

export class RequestTracker<TResult = unknown> {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: TResult) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      onAbort?: () => void;
      onTransportSettled?: () => void;
      applicationSettled: boolean;
    }
  >();

  create(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onTransportSettled?: () => void,
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const entry: {
        resolve: (value: TResult) => void;
        reject: (error: Error) => void;
        timeout?: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        onAbort?: () => void;
        onTransportSettled?: () => void;
        applicationSettled: boolean;
      } = {
        resolve,
        reject,
        timeout: undefined,
        signal,
        onAbort: undefined,
        onTransportSettled,
        applicationSettled: false,
      };

      const detachAbort = (): void => {
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
      };

      // Abort rejects the caller immediately. For callers that need physical
      // concurrency accounting, retain a correlation tombstone until the
      // backend transport actually settles; JSON-RPC cancellation is local.
      const onAbort = (): void => {
        if (!this.pending.has(id) || entry.applicationSettled) return;
        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = undefined;
        detachAbort();
        entry.applicationSettled = true;
        entry.reject(cancelledError(id));
        if (!entry.onTransportSettled) this.pending.delete(id);
      };

      // Timeout owns the local pre-ack window. A transport-settlement observer
      // keeps a tombstone after timeout for the same physical-slot guarantee.
      entry.timeout = setTimeout(() => {
        entry.timeout = undefined;
        detachAbort();
        entry.applicationSettled = true;
        reject(new RequestTimeoutError(id));
        if (!entry.onTransportSettled) this.pending.delete(id);
      }, timeoutMs);

      if (signal) {
        entry.onAbort = onAbort;
        if (signal.aborted) {
          if (entry.timeout) clearTimeout(entry.timeout);
          entry.timeout = undefined;
          entry.applicationSettled = true;
          reject(cancelledError(id));
          if (onTransportSettled) this.pending.set(id, entry);
          return;
        }
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

    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    this.pending.delete(id);
    if (!entry.applicationSettled) {
      entry.applicationSettled = true;
      entry.resolve(value);
    }
    entry.onTransportSettled?.();
    return true;
  }

  reject(id: string, error: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }

    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    this.pending.delete(id);
    if (!entry.applicationSettled) {
      entry.applicationSettled = true;
      entry.reject(error);
    }
    entry.onTransportSettled?.();
    return true;
  }

  rejectAll(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      this.pending.delete(id);
      if (!entry.applicationSettled) {
        entry.applicationSettled = true;
        entry.reject(error);
      }
      entry.onTransportSettled?.();
    }
  }
}
