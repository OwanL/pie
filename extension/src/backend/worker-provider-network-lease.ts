import { randomUUID } from 'node:crypto';

import type { WorkerProviderReleaseOutcome } from './worker-protocol';
import { publishProviderTransportObservation } from './provider-progress-bus';

export interface WorkerProviderNetworkLease {
  leaseId: string;
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
 * Installs the Phase 4 conservative cross-worker provider fence at the actual
 * network boundary. Install this before ProviderGate so retries, compaction,
 * tools, and nested agents all acquire independently immediately before the
 * underlying fetch. A permit is retained through response-body settlement.
 */
export function installWorkerProviderNetworkLease(
  client: WorkerProviderNetworkLeaseClient,
  resolveIdentity?: () => { sessionId?: string; provider?: string; model?: string; turnId?: string; attemptId?: string },
): () => void {
  const underlyingFetch = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const fallbackAttemptId = `network:${process.pid}:${++attempt}`;
    const identity = resolveIdentity?.() ?? {};
    const attemptId = identity.attemptId ?? fallbackAttemptId;
    const provider = identity.provider ?? (parsed.host || 'unknown-provider');
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
    let observed = false;
    let progressTerminal = false;
    let rawChunkObserved = false;
    const settleProgress = (kind: 'transport_terminal' | 'transport_error'): void => {
      if (progressTerminal) return;
      progressTerminal = true;
      publishProgress(kind);
    };
    const observe = (observation: { classification: 'success' | 'http-error' | 'transport-error' | 'cancelled'; status?: number; retryable: boolean }): void => {
      if (observed) return;
      observed = true;
      client.observe(lease.leaseId, observation);
    };
    const release = (outcome: WorkerProviderReleaseOutcome): void => {
      if (released) return;
      released = true;
      void client.release(lease.leaseId, outcome).catch(() => undefined);
    };
    try {
      publishProgress('headers_wait');
      const response = await underlyingFetch(input, init);
      publishProgress('headers_received');
      observe({
        classification: response.ok ? 'success' : 'http-error',
        status: response.status,
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      });
      if (!response.body) {
        settleProgress('transport_terminal');
        release(response.ok ? 'completed' : 'failed');
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
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
