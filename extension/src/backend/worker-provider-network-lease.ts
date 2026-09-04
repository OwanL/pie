import { randomUUID } from 'node:crypto';

import type { WorkerProviderReleaseOutcome } from './worker-protocol';
import { publishProviderTransportObservation } from './provider-progress-bus';

export interface WorkerProviderNetworkLease {
  leaseId: string;
  headerWaitMs: number;
  streamIdleTimeoutMs: number;
}

export interface WorkerProviderNetworkLeaseOptions {
  /** Classify the actual destination URL before falling back to the root
   * session provider. This keeps local pruning and provider failover in their
   * own coordinator pools. */
  resolveProvider?(url: string, fallbackProvider?: string): string | undefined;
}

export class WorkerProviderHeaderTimeoutError extends Error {
  readonly isRetryable = true;
  readonly httpStatus = 504;
  constructor(provider: string, waitMs: number) {
    super(`Provider "${provider}" did not return response headers within ${waitMs}ms.`);
    this.name = 'WorkerProviderHeaderTimeoutError';
  }
}

export class WorkerProviderStreamIdleTimeoutError extends Error {
  readonly isRetryable = true;
  readonly httpStatus = 504;
  constructor(provider: string, waitMs: number) {
    super(`Provider "${provider}" response stream produced no data for ${waitMs}ms.`);
    this.name = 'WorkerProviderStreamIdleTimeoutError';
  }
}

export interface WorkerProviderNetworkLeaseClient {
  acquire(
    requestId: string,
    request: { provider: string; model: string; turnId: string; attemptId: string },
  ): Promise<WorkerProviderNetworkLease>;
  cancel(requestId: string, reason: string): Promise<void>;
  observe(
    leaseId: string,
    observation: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean },
  ): void;
  release(leaseId: string, outcome: WorkerProviderReleaseOutcome): Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'The provider request was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Installs the conservative cross-worker provider fence at the actual
 * network boundary. Install this before ProviderGate so retries, compaction,
 * tools, and nested agents all acquire independently immediately before the
 * underlying fetch. A permit is retained through response-body settlement.
 */
export function installWorkerProviderNetworkLease(
  client: WorkerProviderNetworkLeaseClient,
  resolveIdentity?: () => { sessionId?: string; provider?: string; model?: string; turnId?: string; attemptId?: string },
  options: WorkerProviderNetworkLeaseOptions = {},
): () => void {
  const underlyingFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const fallbackAttemptId = `network:${process.pid}:${++attempt}`;
    const identity = resolveIdentity?.() ?? {};
    const attemptId = identity.attemptId ?? fallbackAttemptId;
    const provider = options.resolveProvider?.(url, identity.provider)
      ?? identity.provider
      ?? (parsed.host || 'unknown-provider');
    const publishProgress = (
      kind: Parameters<typeof publishProviderTransportObservation>[0]['kind'],
      extra: { occurredAt?: number; queueDurationMs?: number } = {},
    ): void => publishProviderTransportObservation({
      sessionId: identity.sessionId ?? '',
      provider,
      attemptId,
      kind,
      ...extra,
    });
    const admissionId = randomUUID();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw abortError(signal);

    const queuedAt = Date.now();
    publishProgress('gate_queue', { occurredAt: queuedAt });
    const acquire = client.acquire(admissionId, {
      provider,
      model: identity.model ?? (parsed.pathname || 'unknown-model'),
      turnId: identity.turnId ?? attemptId,
      attemptId,
    });
    // Always observe the acquire branch: cancellation can win while the
    // correlated provider.cancelled response settles this promise separately.
    void acquire.catch(() => undefined);
    let removeAbortListener = (): void => undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            void client.cancel(admissionId, 'Fetch AbortSignal fired while provider admission was queued.')
              .then(() => reject(abortError(signal)), reject);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        })
      : undefined;

    let lease: WorkerProviderNetworkLease;
    try {
      lease = await (aborted ? Promise.race([acquire, aborted]) : acquire);
      const acquiredAt = Date.now();
      publishProgress('gate_acquired', {
        occurredAt: acquiredAt,
        queueDurationMs: Math.max(0, acquiredAt - queuedAt),
      });
    } catch (error) {
      publishProgress('gate_rejected');
      throw error;
    } finally {
      removeAbortListener();
    }
    if (signal?.aborted) {
      await client.cancel(admissionId, 'Fetch AbortSignal fired as provider admission was granted.');
      throw abortError(signal);
    }

    let released = false;
    let observation: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean } | undefined;
    let progressTerminal = false;
    let rawChunkObserved = false;
    let removeTransportAbortListener = (): void => undefined;
    const settleProgress = (kind: 'transport_terminal' | 'transport_error'): void => {
      if (progressTerminal) return;
      progressTerminal = true;
      publishProgress(kind);
    };
    const observe = (next: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean }): void => {
      if (observation) {
        // Headers can prove a non-retryable HTTP response while the body later
        // proves the transport unhealthy. Let that stronger terminal evidence
        // replace the provisional header classification before release; all
        // other duplicate observations remain exact-once.
        const supersedesHttpHeaders = observation.classification === 'http-error'
          && next.classification === 'transport-error';
        if (!supersedesHttpHeaders) return;
      }
      observation = next;
      client.observe(lease.leaseId, next);
    };
    const release = (outcome: WorkerProviderReleaseOutcome): void => {
      if (released) return;
      released = true;
      removeTransportAbortListener();
      void client.release(lease.leaseId, outcome).catch(() => undefined);
    };
    try {
      publishProgress('headers_wait');
      const transportController = new AbortController();
      const activeReader: { current?: ReadableStreamDefaultReader<Uint8Array> } = {};
      const onTransportAbort = (): void => {
        const reason = signal ? abortError(signal) : new Error('Provider transport aborted.');
        if (!transportController.signal.aborted) transportController.abort(reason);
        if (activeReader.current) void activeReader.current.cancel(reason).catch(() => undefined);
        settleProgress('transport_error');
        observe({ classification: 'cancelled', retryable: false });
        release('cancelled');
      };
      if (signal) {
        signal.addEventListener('abort', onTransportAbort, { once: true });
        removeTransportAbortListener = () => signal.removeEventListener('abort', onTransportAbort);
        if (signal.aborted) onTransportAbort();
      }
      const headerError = new WorkerProviderHeaderTimeoutError(provider, lease.headerWaitMs);
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      let headerTimedOut = false;
      const upstream = underlyingFetch(input, { ...(init ?? {}), signal: transportController.signal }).then((response) => {
        if (!headerTimedOut) return response;
        void response.body?.cancel(headerError).catch(() => undefined);
        throw headerError;
      });
      const headerDeadline = new Promise<never>((_resolve, reject) => {
        headerTimer = setTimeout(() => {
          headerTimedOut = true;
          if (!transportController.signal.aborted) transportController.abort(headerError);
          reject(headerError);
        }, lease.headerWaitMs);
        headerTimer.unref?.();
      });
      let response: Response;
      try {
        response = await Promise.race([upstream, headerDeadline]);
      } finally {
        if (headerTimer) clearTimeout(headerTimer);
      }
      publishProgress('headers_received');
      // A 2xx header is not yet transport success: a truncated or stalled
      // response body must still contribute retryable circuit evidence. HTTP
      // failures are final at headers and retain their status classification.
      if (!response.ok) {
        observe({
          classification: 'http-error',
          status: response.status,
          retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        });
      }
      if (!response.body) {
        if (response.ok) observe({ classification: 'success', status: response.status, retryable: false });
        settleProgress('transport_terminal');
        release(response.ok ? 'completed' : 'failed');
        return response;
      }
      const reader = response.body.getReader();
      activeReader.current = reader;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const idleError = new WorkerProviderStreamIdleTimeoutError(provider, lease.streamIdleTimeoutMs);
            const result = await Promise.race([
              reader.read(),
              new Promise<never>((_resolve, reject) => {
                idleTimer = setTimeout(() => {
                  // Settle the deadline before cancelling the upstream reader.
                  // Some ReadableStream implementations resolve a pending read
                  // with `{ done: true }` synchronously from cancel(), which
                  // would otherwise make a timed-out stream look like clean EOF.
                  reject(idleError);
                  if (!transportController.signal.aborted) transportController.abort(idleError);
                  void reader.cancel(idleError).catch(() => undefined);
                }, lease.streamIdleTimeoutMs);
                idleTimer.unref?.();
              }),
            ]);
            if (result.done) {
              if (response.ok) observe({ classification: 'success', status: response.status, retryable: false });
              settleProgress('transport_terminal');
              release(response.ok ? 'completed' : 'failed');
              controller.close();
            } else {
              if (!rawChunkObserved) {
                rawChunkObserved = true;
                publishProgress('raw_chunk');
              }
              controller.enqueue(result.value);
            }
          } catch (error) {
            settleProgress('transport_error');
            observe({ classification: signal?.aborted ? 'cancelled' : 'transport-error', retryable: !signal?.aborted });
            release(signal?.aborted ? 'cancelled' : 'failed');
            controller.error(error);
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
        },
        async cancel(reason) {
          settleProgress('transport_terminal');
          observe({ classification: 'cancelled', retryable: false });
          release('cancelled');
          await reader.cancel(reason).catch(() => undefined);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      settleProgress('transport_error');
      observe({ classification: signal?.aborted ? 'cancelled' : 'transport-error', retryable: !signal?.aborted });
      release(signal?.aborted ? 'cancelled' : 'failed');
      throw error;
    }
  }) as typeof globalThis.fetch;
  return () => {
    if (globalThis.fetch !== underlyingFetch) globalThis.fetch = underlyingFetch;
  };
}
