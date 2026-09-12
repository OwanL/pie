import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const ANALYTICS_HANDOFF_SCHEMA = 1 as const;
export const ANALYTICS_HANDOFF_MAX_FRAME_BYTES = 64 * 1024;
export const ANALYTICS_HANDOFF_MAX_NONCE_COUNT = 1_024;
/** Requests are short-lived capabilities. The endpoint rejects requests
 * outside this signed window before consulting its replay set. */
export const ANALYTICS_HANDOFF_NONCE_WINDOW_MS = 5 * 60 * 1_000;
export const ANALYTICS_HANDOFF_MAX_STATUS_HOSTS = 64;
export const ANALYTICS_HANDOFF_MAX_STATUS_BYTES = 48 * 1024;

export type AnalyticsHandoffOperation = 'status' | 'heartbeat';

export interface AnalyticsHandoffHostIdentity {
  hostInstanceId: string;
  workspaceId: string;
  generationId: string;
  buildId: string;
  processId: number;
  endpointName?: string;
  capabilities: readonly string[];
}

export interface AnalyticsHandoffInventoryProof {
  kind: 'registered-hosts-only';
  complete: false;
  reason: 'runtime-generation-and-process-reconciliation-unwired';
}

export interface AnalyticsHandoffStatus {
  host: AnalyticsHandoffHostIdentity & {
    state: 'registered' | 'stopping' | 'stopped' | 'unsupported';
    registeredAtMs: string;
    heartbeatAtMs: string;
    updatedAtMs: string;
    stoppedAtMs?: string;
    unsupportedReason?: string;
  };
  hosts: readonly (AnalyticsHandoffHostIdentity & {
    state: 'registered' | 'stopping' | 'stopped' | 'unsupported';
    registeredAtMs: string;
    heartbeatAtMs: string;
    updatedAtMs: string;
    stoppedAtMs?: string;
    unsupportedReason?: string;
  })[];
  truncated: boolean;
  nextCursor?: string;
  inventoryProof: AnalyticsHandoffInventoryProof;
  allHostsHandoffAvailable: false;
}

export interface AnalyticsHandoffControlRequest {
  schema: typeof ANALYTICS_HANDOFF_SCHEMA;
  requestId: string;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  operation: AnalyticsHandoffOperation;
  payload: Record<string, unknown>;
  mac: string;
}

export interface AnalyticsHandoffControlResponse {
  schema: typeof ANALYTICS_HANDOFF_SCHEMA;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  mac: string;
}

function boundedString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedKey(key: string): string {
  return boundedString(key, 'handoff key', 4_096);
}

function boundedTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return ANALYTICS_HANDOFF_MAX_STATUS_HOSTS;
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > ANALYTICS_HANDOFF_MAX_STATUS_HOSTS) {
    throw new Error('status limit is invalid.');
  }
  return value as number;
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(object[key])}`).join(',')}}`;
}

function requestSigningBytes(request: Omit<AnalyticsHandoffControlRequest, 'mac'>): string {
  return sortedJson({
    schema: request.schema,
    requestId: request.requestId,
    nonce: request.nonce,
    issuedAtMs: request.issuedAtMs,
    expiresAtMs: request.expiresAtMs,
    operation: request.operation,
    payload: request.payload,
  });
}

function responseSigningBytes(response: Omit<AnalyticsHandoffControlResponse, 'mac'>): string {
  return sortedJson({
    schema: response.schema,
    requestId: response.requestId,
    ok: response.ok,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.error === undefined ? {} : { error: response.error }),
  });
}

function macFor(value: string, key: string): string {
  return createHmac('sha256', boundedKey(key)).update(value, 'utf8').digest('base64url');
}

function constantTimeMacEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function validatePayload(operation: AnalyticsHandoffOperation, payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('handoff payload is invalid.');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (operation === 'status') {
    const unknownKeys = keys.filter((key) => !['workspaceId', 'limit', 'cursor'].includes(key));
    if (unknownKeys.length > 0 || !keys.includes('workspaceId')) throw new Error('status payload is invalid.');
    boundedString(record.workspaceId, 'workspaceId');
    boundedLimit(record.limit);
    if (record.cursor !== undefined) boundedString(record.cursor, 'status cursor', 128);
  } else {
    if (keys.length !== 0) throw new Error('heartbeat payload is invalid.');
  }
  return record;
}

export function createAnalyticsHandoffPipeName(workspaceId: string, hostInstanceId: string): string {
  const digest = createHash('sha256').update(`${boundedString(workspaceId, 'workspaceId')}\u0000${boundedString(hostInstanceId, 'hostInstanceId')}`).digest('hex').slice(0, 40);
  return `\\\\.\\pipe\\pie-analytics-handoff-${digest}`;
}

export function createSignedAnalyticsHandoffRequest(
  operation: AnalyticsHandoffOperation,
  payload: Record<string, unknown>,
  key: string,
  ids: { requestId?: string; nonce?: string; issuedAtMs?: number; expiresAtMs?: number } = {},
): AnalyticsHandoffControlRequest {
  const issuedAtMs = ids.issuedAtMs ?? Date.now();
  const expiresAtMs = ids.expiresAtMs ?? issuedAtMs + ANALYTICS_HANDOFF_NONCE_WINDOW_MS;
  const request: Omit<AnalyticsHandoffControlRequest, 'mac'> = {
    schema: ANALYTICS_HANDOFF_SCHEMA,
    requestId: boundedString(ids.requestId ?? randomUUID(), 'requestId', 128),
    nonce: boundedString(ids.nonce ?? randomUUID(), 'nonce', 128),
    issuedAtMs: boundedTimestamp(issuedAtMs, 'issuedAtMs'),
    expiresAtMs: boundedTimestamp(expiresAtMs, 'expiresAtMs'),
    operation,
    payload: validatePayload(operation, payload),
  };
  return { ...request, mac: macFor(requestSigningBytes(request), key) };
}

export function verifyAnalyticsHandoffRequest(value: unknown, key: string): AnalyticsHandoffControlRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('handoff request is invalid.');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'expiresAtMs,issuedAtMs,mac,nonce,operation,payload,requestId,schema') {
    throw new Error('handoff request fields are invalid.');
  }
  if (raw.schema !== ANALYTICS_HANDOFF_SCHEMA) throw new Error('handoff request schema is unsupported.');
  const requestId = boundedString(raw.requestId, 'requestId', 128);
  const nonce = boundedString(raw.nonce, 'nonce', 128);
  const issuedAtMs = boundedTimestamp(raw.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = boundedTimestamp(raw.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) {
    throw new Error('handoff request expiry is invalid.');
  }
  const operation = raw.operation;
  if (operation !== 'status' && operation !== 'heartbeat') throw new Error('handoff operation is unsupported.');
  const payload = validatePayload(operation, raw.payload);
  const mac = boundedString(raw.mac, 'handoff mac', 256);
  const unsigned: Omit<AnalyticsHandoffControlRequest, 'mac'> = {
    schema: ANALYTICS_HANDOFF_SCHEMA, requestId, nonce, issuedAtMs, expiresAtMs, operation, payload,
  };
  if (!constantTimeMacEqual(mac, macFor(requestSigningBytes(unsigned), key))) throw new Error('handoff request authentication failed.');
  return { ...unsigned, mac };
}

/** Verify the signed request's short replay window against the endpoint clock.
 * The endpoint may forget only entries that are provably expired, so replay
 * protection remains fail-closed when its bounded set is full. */
export function assertFreshAnalyticsHandoffRequest(
  request: Pick<AnalyticsHandoffControlRequest, 'issuedAtMs' | 'expiresAtMs'>,
  nowMs = Date.now(),
): void {
  const issuedAtMs = boundedTimestamp(request.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = boundedTimestamp(request.expiresAtMs, 'expiresAtMs');
  if (!Number.isSafeInteger(nowMs)
    || expiresAtMs < issuedAtMs
    || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS
    || nowMs < issuedAtMs - 30_000
    || nowMs > expiresAtMs) {
    throw new Error('handoff request has expired or is not yet valid.');
  }
}

export function createSignedAnalyticsHandoffResponse(
  requestId: string,
  key: string,
  response: { ok: true; result: unknown } | { ok: false; error: string },
): AnalyticsHandoffControlResponse {
  const unsigned: Omit<AnalyticsHandoffControlResponse, 'mac'> = {
    schema: ANALYTICS_HANDOFF_SCHEMA,
    requestId: boundedString(requestId, 'requestId', 128),
    ok: response.ok,
    ...(response.ok ? { result: response.result } : { error: boundedString(response.error, 'handoff error', 1_024) }),
  };
  return { ...unsigned, mac: macFor(responseSigningBytes(unsigned), key) };
}

export function verifyAnalyticsHandoffResponse(value: unknown, key: string): AnalyticsHandoffControlResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('handoff response is invalid.');
  const raw = value as Record<string, unknown>;
  const requestId = boundedString(raw.requestId, 'requestId', 128);
  if (raw.schema !== ANALYTICS_HANDOFF_SCHEMA || typeof raw.ok !== 'boolean') throw new Error('handoff response fields are invalid.');
  const mac = boundedString(raw.mac, 'handoff mac', 256);
  const unsigned: Omit<AnalyticsHandoffControlResponse, 'mac'> = raw.ok
    ? { schema: ANALYTICS_HANDOFF_SCHEMA, requestId, ok: true, result: raw.result }
    : { schema: ANALYTICS_HANDOFF_SCHEMA, requestId, ok: false, error: boundedString(raw.error, 'handoff error', 1_024) };
  if (!constantTimeMacEqual(mac, macFor(responseSigningBytes(unsigned), key))) throw new Error('handoff response authentication failed.');
  return { ...unsigned, mac };
}
