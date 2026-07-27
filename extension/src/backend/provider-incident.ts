import { toErrorMessage } from '../shared/error-message.js';

export type ProviderIncidentKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'transport_timeout'
  | 'transport_error'
  | 'http_error';

export interface ProviderIncident {
  sessionId: string;
  requestId?: string;
  providerHost: string;
  kind: ProviderIncidentKind;
  occurredAt: number;
  status?: number;
  retryAfterMs?: number;
  retryAt?: number;
  userMessage: string;
  detail: string;
}

type Listener = (incident: ProviderIncident) => void;
const listeners = new Set<Listener>();

export function observeProviderIncidents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishProviderIncident(incident: ProviderIncident): void {
  if (!incident.sessionId) return;
  for (const listener of listeners) {
    try {
      listener(incident);
    } catch {
      // Observability must never alter provider traffic.
    }
  }
}

function providerLabel(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized.includes('githubcopilot.com')) return 'GitHub Copilot';
  if (normalized.includes('umans.ai')) return 'Umans';
  if (normalized.includes('openai.com')) return 'OpenAI';
  if (normalized.includes('anthropic.com')) return 'Anthropic';
  return host || 'The provider';
}

function parseRetryAfterMs(value: string | null | undefined, now: number): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const at = Date.parse(normalized);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function boundedDetail(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_048);
}

export function classifyProviderHttpIncident(input: {
  sessionId: string;
  requestId?: string | null;
  providerHost: string;
  status: number;
  headers: Headers;
  body?: string;
  occurredAt?: number;
}): ProviderIncident {
  const occurredAt = input.occurredAt ?? Date.now();
  const retryHeader = input.headers.get('x-ratelimit-quota-exceeded-retry-after')
    ?? input.headers.get('retry-after');
  const retryAfterMs = parseRetryAfterMs(retryHeader, occurredAt);
  const retryAt = retryAfterMs === undefined ? undefined : occurredAt + retryAfterMs;
  const body = input.body ?? '';
  const exceeded = input.headers.get('x-ratelimit-exceeded')?.toLowerCase();
  const quotaExhausted = input.status === 429 && (
    exceeded === 'quota_exceeded'
    || /\b(?:quota exceeded|insufficient_quota|billing|hard limit)\b/i.test(body)
  );
  const kind: ProviderIncidentKind = quotaExhausted
    ? 'quota_exhausted'
    : input.status === 429 ? 'rate_limited' : 'http_error';
  const provider = providerLabel(input.providerHost);
  const until = retryAt === undefined ? '' : ` until ${new Date(retryAt).toISOString()}`;
  const userMessage = quotaExhausted
    ? `${provider} quota is exhausted${until}. This request cannot succeed on that provider before the quota resets.`
    : input.status === 429
      ? `${provider} rate-limited this request (HTTP 429)${until}.`
      : `${provider} rejected this request (HTTP ${input.status}).`;
  const detailParts = [
    `provider=${input.providerHost}`,
    `status=${input.status}`,
    retryAfterMs === undefined ? undefined : `retryAfterMs=${retryAfterMs}`,
    body ? `response=${boundedDetail(body)}` : undefined,
  ].filter((part): part is string => !!part);
  return {
    sessionId: input.sessionId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    providerHost: input.providerHost,
    kind,
    occurredAt,
    status: input.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAt }),
    userMessage,
    detail: detailParts.join('; '),
  };
}

export function classifyProviderTransportIncident(input: {
  sessionId: string;
  requestId?: string | null;
  providerHost: string;
  error: unknown;
  occurredAt?: number;
}): ProviderIncident {
  const occurredAt = input.occurredAt ?? Date.now();
  const errorMessage = toErrorMessage(input.error);
  const timedOut = /timeout|timed out|header wait|no response headers/i.test(errorMessage)
    || (input.error as { name?: unknown } | null)?.name === 'ProviderGateHeaderTimeoutError';
  const provider = providerLabel(input.providerHost);
  return {
    sessionId: input.sessionId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    providerHost: input.providerHost,
    kind: timedOut ? 'transport_timeout' : 'transport_error',
    occurredAt,
    userMessage: timedOut
      ? `${provider} did not return response headers before Pie's timeout.`
      : `${provider} connection failed before a response was received.`,
    detail: `provider=${input.providerHost}; error=${boundedDetail(errorMessage)}`,
  };
}

export function providerIncidentCode(kind: ProviderIncidentKind): string {
  switch (kind) {
    case 'quota_exhausted': return 'PROVIDER_QUOTA_EXHAUSTED';
    case 'rate_limited': return 'PROVIDER_RATE_LIMITED';
    case 'transport_timeout': return 'PROVIDER_TRANSPORT_TIMEOUT';
    case 'transport_error': return 'PROVIDER_TRANSPORT_ERROR';
    case 'http_error': return 'PROVIDER_HTTP_ERROR';
  }
}
