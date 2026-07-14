export type ProviderTransportObservationKind =
  | 'gate_queue'
  | 'headers_wait'
  | 'headers_received'
  | 'raw_chunk'
  | 'transport_terminal'
  | 'transport_error';

export interface ProviderTransportObservation {
  sessionId: string;
  provider: string;
  kind: ProviderTransportObservationKind;
  occurredAt: number;
}

type Listener = (observation: ProviderTransportObservation) => void;
const listeners = new Set<Listener>();

export function observeProviderTransport(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Best-effort metadata-only signal; observer failure can never affect fetch. */
export function publishProviderTransportObservation(
  observation: Omit<ProviderTransportObservation, 'occurredAt'> & { occurredAt?: number },
): void {
  if (!observation.sessionId) return;
  const value: ProviderTransportObservation = { ...observation, occurredAt: observation.occurredAt ?? Date.now() };
  for (const listener of listeners) {
    try { listener(value); } catch { /* diagnostics/progress must not alter provider traffic */ }
  }
}
