import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  ANALYTICS_HANDOFF_NONCE_WINDOW_MS,
  assertFreshAnalyticsHandoffRequest,
  type AnalyticsHandoffHostIdentity,
} from '../../../shared/analytics/handoff.js';
import {
  SessionLifecycleConflictError,
  SessionLifecycleStore,
  type AnalyticsHostRecord,
  type AnalyticsWriterFenceAcknowledgement,
  type AnalyticsWriterFencePurpose,
  type AnalyticsWriterFenceRecord,
  type AnalyticsWriterIdentity,
} from '../backend/session-lifecycle-store.js';
import type { SessionManagerFenceRegistry } from '../backend/session-manager-fence.js';
import type { AnalyticsHostDiscoveryResult } from './analytics-handoff-discovery.js';

export const ANALYTICS_WRITER_FENCE_PROTOCOL = 'pie-analytics-writer-fence-v1' as const;
export const ANALYTICS_WRITER_FENCE_SCHEMA = 1 as const;
export const ANALYTICS_WRITER_FENCE_MAX_HOSTS = 512;
export const ANALYTICS_WRITER_FENCE_MAX_KEY_BYTES = 4_096;
export const ANALYTICS_WRITER_FENCE_MAX_TIMEOUT_MS = 10_000;
export const ANALYTICS_WRITER_FENCE_MAX_CENSUS_AGE_MS = 30_000;

export type AnalyticsWriterFenceHostIdentity = AnalyticsWriterIdentity;

export interface AnalyticsWriterFenceRequest {
  readonly protocol: typeof ANALYTICS_WRITER_FENCE_PROTOCOL;
  readonly schema: typeof ANALYTICS_WRITER_FENCE_SCHEMA;
  readonly operation: 'freeze';
  readonly requestId: string;
  readonly nonce: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly purpose: AnalyticsWriterFencePurpose;
  readonly fenceEpoch: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly mac: string;
}

export interface AnalyticsWriterFenceLocalAcknowledgement {
  readonly admissionRevoked: true;
  readonly writersDrained: true;
  readonly activeWriterCount: 0;
}

export interface AnalyticsWriterFenceSuccess {
  readonly protocol: typeof ANALYTICS_WRITER_FENCE_PROTOCOL;
  readonly schema: typeof ANALYTICS_WRITER_FENCE_SCHEMA;
  readonly operation: 'freeze-ack';
  readonly requestId: string;
  readonly nonce: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly fenceEpoch: number;
  readonly host: AnalyticsWriterFenceHostIdentity;
  readonly admissionRevoked: true;
  readonly writersDrained: true;
  readonly activeWriterCount: 0;
  readonly ok: true;
  readonly mac: string;
}

export interface AnalyticsWriterFenceError {
  readonly protocol: typeof ANALYTICS_WRITER_FENCE_PROTOCOL;
  readonly schema: typeof ANALYTICS_WRITER_FENCE_SCHEMA;
  readonly operation: 'error';
  readonly requestId: string;
  readonly ok: false;
  readonly error: string;
  readonly mac: string;
}

export type AnalyticsWriterFenceResponse = AnalyticsWriterFenceSuccess | AnalyticsWriterFenceError;

export interface AnalyticsHostWriterFenceHandler {
  freeze(request: AnalyticsWriterFenceRequest): Promise<AnalyticsWriterFenceLocalAcknowledgement>;
}

export interface AnalyticsHostWriterFenceOptions {
  identity: AnalyticsHandoffHostIdentity;
  registry?: SessionManagerFenceRegistry;
  /** Revokes non-SessionManager writers at the host's own admission seam. */
  revokeAdmission?: (request: AnalyticsWriterFenceRequest) => void;
  isAdmissionRevoked?: () => boolean;
  activeWriterCount?: () => number;
  /** Optional asynchronous drain for non-SessionManager writers. */
  waitForIdle?: (timeoutMs: number) => Promise<number>;
  waitTimeoutMs?: number;
}

export interface AnalyticsAllHostFenceParticipant {
  identity: AnalyticsHandoffHostIdentity;
  /** The per-boot capability distributed out of band with the control pipe. */
  key: string;
  /** Sends one signed freeze request to this host's authenticated endpoint. */
  send(request: AnalyticsWriterFenceRequest): Promise<unknown>;
}

export interface AnalyticsAllHostHandoffOptions {
  workspaceId: string;
  registry: SessionLifecycleStore;
  discover: () => Promise<AnalyticsHostDiscoveryResult>;
  participants: readonly AnalyticsAllHostFenceParticipant[];
  purpose: AnalyticsWriterFencePurpose;
  /** Production coordinators require signed status evidence in addition to
   * registry/runtime/process reconciliation. Test seams may omit this flag. */
  requireAuthenticatedHostStatus?: boolean;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface AnalyticsAllHostHandoffReceipt {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly purpose: AnalyticsWriterFencePurpose;
  readonly fenceEpoch: number;
  readonly status: 'fenced';
  readonly hostInstanceIds: readonly string[];
  readonly acknowledgedHostInstanceIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedKey(key: string): string {
  const bounded = boundedString(key.trim(), 'writer-fence key', ANALYTICS_WRITER_FENCE_MAX_KEY_BYTES);
  if (Buffer.byteLength(bounded, 'utf8') > ANALYTICS_WRITER_FENCE_MAX_KEY_BYTES) {
    throw new Error('writer-fence key is too large.');
  }
  return bounded;
}

function boundedInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedIdentity(value: unknown, name: string): AnalyticsWriterFenceHostIdentity {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  return {
    hostInstanceId: boundedString(value.hostInstanceId, `${name}.hostInstanceId`),
    workspaceId: boundedString(value.workspaceId, `${name}.workspaceId`),
    generationId: boundedString(value.generationId, `${name}.generationId`),
    buildId: boundedString(value.buildId, `${name}.buildId`),
    processId: boundedInteger(value.processId, `${name}.processId`, 1),
  };
}

function identityFromHost(host: AnalyticsHostRecord): AnalyticsWriterFenceHostIdentity {
  return {
    hostInstanceId: host.hostInstanceId,
    workspaceId: host.workspaceId,
    generationId: host.generationId,
    buildId: host.buildId,
    processId: host.processId,
  };
}

function identityFromHandoffHost(host: AnalyticsHandoffHostIdentity): AnalyticsWriterFenceHostIdentity {
  return boundedIdentity(host, 'host identity');
}

function sameIdentity(left: AnalyticsWriterFenceHostIdentity, right: AnalyticsWriterFenceHostIdentity): boolean {
  return left.hostInstanceId === right.hostInstanceId
    && left.workspaceId === right.workspaceId
    && left.generationId === right.generationId
    && left.buildId === right.buildId
    && left.processId === right.processId;
}

function compareHostIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(',')}}`;
}

function macFor(value: string, key: string): string {
  return createHmac('sha256', boundedKey(key)).update(value, 'utf8').digest('base64url');
}

function macEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestSigningBytes(request: Omit<AnalyticsWriterFenceRequest, 'mac'>): string {
  return sortedJson({
    protocol: request.protocol,
    schema: request.schema,
    operation: request.operation,
    requestId: request.requestId,
    nonce: request.nonce,
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    purpose: request.purpose,
    fenceEpoch: request.fenceEpoch,
    issuedAtMs: request.issuedAtMs,
    expiresAtMs: request.expiresAtMs,
  });
}

function successSigningBytes(response: Omit<AnalyticsWriterFenceSuccess, 'mac'>): string {
  return sortedJson({
    protocol: response.protocol,
    schema: response.schema,
    operation: response.operation,
    requestId: response.requestId,
    nonce: response.nonce,
    workspaceId: response.workspaceId,
    operationId: response.operationId,
    fenceEpoch: response.fenceEpoch,
    host: response.host,
    admissionRevoked: response.admissionRevoked,
    writersDrained: response.writersDrained,
    activeWriterCount: response.activeWriterCount,
    ok: response.ok,
  });
}

function errorSigningBytes(response: Omit<AnalyticsWriterFenceError, 'mac'>): string {
  return sortedJson({
    protocol: response.protocol,
    schema: response.schema,
    operation: response.operation,
    requestId: response.requestId,
    ok: response.ok,
    error: response.error,
  });
}

function validatePurpose(value: unknown): AnalyticsWriterFencePurpose {
  if (value !== 'analytics-activation' && value !== 'storage-cutoff') {
    throw new Error('writer-fence purpose is invalid.');
  }
  return value;
}

function validateRequestTimestamps(issuedAtMs: number, expiresAtMs: number): void {
  if (expiresAtMs < issuedAtMs || expiresAtMs - issuedAtMs > ANALYTICS_HANDOFF_NONCE_WINDOW_MS) {
    throw new Error('writer-fence request expiry is invalid.');
  }
}

export function isAnalyticsWriterFenceRequest(value: unknown): boolean {
  return isRecord(value) && value.protocol === ANALYTICS_WRITER_FENCE_PROTOCOL;
}

export function createSignedAnalyticsWriterFenceRequest(
  input: Omit<AnalyticsWriterFenceRequest, 'protocol' | 'schema' | 'operation' | 'mac' | 'requestId' | 'nonce' | 'issuedAtMs' | 'expiresAtMs'>,
  key: string,
  ids: { requestId?: string; nonce?: string; issuedAtMs?: number; expiresAtMs?: number } = {},
): AnalyticsWriterFenceRequest {
  const issuedAtMs = ids.issuedAtMs ?? Date.now();
  const expiresAtMs = ids.expiresAtMs ?? issuedAtMs + ANALYTICS_HANDOFF_NONCE_WINDOW_MS;
  boundedInteger(issuedAtMs, 'issuedAtMs');
  boundedInteger(expiresAtMs, 'expiresAtMs');
  validateRequestTimestamps(issuedAtMs, expiresAtMs);
  const request: Omit<AnalyticsWriterFenceRequest, 'mac'> = {
    protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
    schema: ANALYTICS_WRITER_FENCE_SCHEMA,
    operation: 'freeze',
    requestId: boundedString(ids.requestId ?? randomUUID(), 'requestId', 128),
    nonce: boundedString(ids.nonce ?? randomUUID(), 'nonce', 128),
    workspaceId: boundedString(input.workspaceId, 'workspaceId'),
    operationId: boundedString(input.operationId, 'operationId'),
    purpose: validatePurpose(input.purpose),
    fenceEpoch: boundedInteger(input.fenceEpoch, 'fenceEpoch', 1),
    issuedAtMs,
    expiresAtMs,
  };
  return { ...request, mac: macFor(requestSigningBytes(request), key) };
}

export function verifyAnalyticsWriterFenceRequest(value: unknown, key: string): AnalyticsWriterFenceRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'expiresAtMs', 'fenceEpoch', 'issuedAtMs', 'mac', 'nonce', 'operation',
    'operationId', 'protocol', 'purpose', 'requestId', 'schema', 'workspaceId',
  ])) throw new Error('writer-fence request fields are invalid.');
  if (value.protocol !== ANALYTICS_WRITER_FENCE_PROTOCOL
    || value.schema !== ANALYTICS_WRITER_FENCE_SCHEMA
    || value.operation !== 'freeze') throw new Error('writer-fence request is unsupported.');
  const requestId = boundedString(value.requestId, 'requestId', 128);
  const nonce = boundedString(value.nonce, 'nonce', 128);
  const workspaceId = boundedString(value.workspaceId, 'workspaceId');
  const operationId = boundedString(value.operationId, 'operationId');
  const purpose = validatePurpose(value.purpose);
  const fenceEpoch = boundedInteger(value.fenceEpoch, 'fenceEpoch', 1);
  const issuedAtMs = boundedInteger(value.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = boundedInteger(value.expiresAtMs, 'expiresAtMs');
  validateRequestTimestamps(issuedAtMs, expiresAtMs);
  const mac = boundedString(value.mac, 'writer-fence mac', 256);
  const unsigned: Omit<AnalyticsWriterFenceRequest, 'mac'> = {
    protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
    schema: ANALYTICS_WRITER_FENCE_SCHEMA,
    operation: 'freeze',
    requestId,
    nonce,
    workspaceId,
    operationId,
    purpose,
    fenceEpoch,
    issuedAtMs,
    expiresAtMs,
  };
  if (!macEqual(mac, macFor(requestSigningBytes(unsigned), key))) {
    throw new Error('writer-fence request authentication failed.');
  }
  return { ...unsigned, mac };
}

export function createSignedAnalyticsWriterFenceAcknowledgement(
  request: AnalyticsWriterFenceRequest,
  identity: AnalyticsWriterFenceHostIdentity,
  acknowledgement: AnalyticsWriterFenceLocalAcknowledgement,
  key: string,
): AnalyticsWriterFenceSuccess {
  const host = boundedIdentity(identity, 'host identity');
  const unsigned: Omit<AnalyticsWriterFenceSuccess, 'mac'> = {
    protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
    schema: ANALYTICS_WRITER_FENCE_SCHEMA,
    operation: 'freeze-ack',
    requestId: request.requestId,
    nonce: request.nonce,
    workspaceId: request.workspaceId,
    operationId: request.operationId,
    fenceEpoch: request.fenceEpoch,
    host,
    admissionRevoked: acknowledgement.admissionRevoked,
    writersDrained: acknowledgement.writersDrained,
    activeWriterCount: acknowledgement.activeWriterCount,
    ok: true,
  };
  return { ...unsigned, mac: macFor(successSigningBytes(unsigned), key) };
}

export function createSignedAnalyticsWriterFenceError(
  requestId: string,
  error: string,
  key: string,
): AnalyticsWriterFenceError {
  const unsigned: Omit<AnalyticsWriterFenceError, 'mac'> = {
    protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
    schema: ANALYTICS_WRITER_FENCE_SCHEMA,
    operation: 'error',
    requestId: boundedString(requestId, 'requestId', 128),
    ok: false,
    error: boundedString(error.replaceAll('\u0000', '').slice(0, 1_024), 'writer-fence error', 1_024),
  };
  return { ...unsigned, mac: macFor(errorSigningBytes(unsigned), key) };
}

export function verifyAnalyticsWriterFenceResponse(value: unknown, key: string): AnalyticsWriterFenceResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('writer-fence response is invalid.');
  if (value.ok === false) {
    if (!exactKeys(value, ['error', 'mac', 'ok', 'operation', 'protocol', 'requestId', 'schema'])) {
      throw new Error('writer-fence error fields are invalid.');
    }
    if (value.protocol !== ANALYTICS_WRITER_FENCE_PROTOCOL
      || value.schema !== ANALYTICS_WRITER_FENCE_SCHEMA
      || value.operation !== 'error') throw new Error('writer-fence error is unsupported.');
    const unsigned: Omit<AnalyticsWriterFenceError, 'mac'> = {
      protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
      schema: ANALYTICS_WRITER_FENCE_SCHEMA,
      operation: 'error',
      requestId: boundedString(value.requestId, 'requestId', 128),
      ok: false,
      error: boundedString(value.error, 'writer-fence error', 1_024),
    };
    const mac = boundedString(value.mac, 'writer-fence mac', 256);
    if (!macEqual(mac, macFor(errorSigningBytes(unsigned), key))) throw new Error('writer-fence response authentication failed.');
    return { ...unsigned, mac };
  }
  if (!exactKeys(value, [
    'activeWriterCount', 'admissionRevoked', 'fenceEpoch', 'host', 'mac', 'nonce',
    'ok', 'operation', 'operationId', 'protocol', 'requestId', 'schema',
    'workspaceId', 'writersDrained',
  ])) throw new Error('writer-fence acknowledgement fields are invalid.');
  if (value.protocol !== ANALYTICS_WRITER_FENCE_PROTOCOL
    || value.schema !== ANALYTICS_WRITER_FENCE_SCHEMA
    || value.operation !== 'freeze-ack'
    || value.ok !== true) throw new Error('writer-fence acknowledgement is unsupported.');
  const unsigned: Omit<AnalyticsWriterFenceSuccess, 'mac'> = {
    protocol: ANALYTICS_WRITER_FENCE_PROTOCOL,
    schema: ANALYTICS_WRITER_FENCE_SCHEMA,
    operation: 'freeze-ack',
    requestId: boundedString(value.requestId, 'requestId', 128),
    nonce: boundedString(value.nonce, 'nonce', 128),
    workspaceId: boundedString(value.workspaceId, 'workspaceId'),
    operationId: boundedString(value.operationId, 'operationId'),
    fenceEpoch: boundedInteger(value.fenceEpoch, 'fenceEpoch', 1),
    host: boundedIdentity(value.host, 'host'),
    admissionRevoked: value.admissionRevoked === true ? true : (() => { throw new Error('writer-fence acknowledgement did not revoke admission.'); })(),
    writersDrained: value.writersDrained === true ? true : (() => { throw new Error('writer-fence acknowledgement did not drain writers.'); })(),
    activeWriterCount: value.activeWriterCount === 0 ? 0 : (() => { throw new Error('writer-fence acknowledgement has active writers.'); })(),
    ok: true,
  };
  const mac = boundedString(value.mac, 'writer-fence mac', 256);
  if (!macEqual(mac, macFor(successSigningBytes(unsigned), key))) throw new Error('writer-fence response authentication failed.');
  return { ...unsigned, mac };
}

function boundedWaitTimeout(value: number | undefined): number {
  if (value === undefined) return ANALYTICS_WRITER_FENCE_MAX_TIMEOUT_MS;
  if (!Number.isFinite(value)) return ANALYTICS_WRITER_FENCE_MAX_TIMEOUT_MS;
  return Math.min(ANALYTICS_WRITER_FENCE_MAX_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

/** Host-local freeze implementation. It revokes admission before waiting for
 * already-admitted manager mutations, and it cannot produce an acknowledgement
 * unless the bounded writer census reaches zero. */
export function createAnalyticsHostWriterFence(
  options: AnalyticsHostWriterFenceOptions,
): AnalyticsHostWriterFenceHandler {
  const identity = identityFromHandoffHost(options.identity);
  if (!options.registry && !options.activeWriterCount) {
    throw new Error('An all-host writer fence requires a local writer census.');
  }
  if ((!options.registry && (!options.revokeAdmission || !options.isAdmissionRevoked))
    || (options.revokeAdmission !== undefined && options.isAdmissionRevoked === undefined)) {
    throw new Error('An all-host writer fence requires an observable admission revocation seam.');
  }
  const timeoutMs = boundedWaitTimeout(options.waitTimeoutMs);
  return {
    async freeze(request) {
      if (request.workspaceId !== identity.workspaceId) throw new Error('writer-fence workspace identity does not match.');
      options.revokeAdmission?.(request);
      options.registry?.revoke();
      const managerWriters = options.registry ? await options.registry.waitForIdle(timeoutMs) : 0;
      let externalWriters = options.activeWriterCount?.() ?? 0;
      if (externalWriters > 0 && options.waitForIdle) {
        externalWriters = await options.waitForIdle(timeoutMs);
      }
      if (!Number.isSafeInteger(managerWriters) || managerWriters < 0
        || !Number.isSafeInteger(externalWriters) || externalWriters < 0) {
        throw new Error('writer-fence local writer census is invalid.');
      }
      const activeWriterCount = managerWriters + externalWriters;
      if (!Number.isSafeInteger(activeWriterCount) || activeWriterCount !== 0) {
        throw new Error(`writer-fence writers did not drain (${activeWriterCount} remain).`);
      }
      if (options.registry && !options.registry.isRevoked()) {
        throw new Error('writer-fence manager admission revocation was not observed.');
      }
      if (options.isAdmissionRevoked && !options.isAdmissionRevoked()) {
        throw new Error('writer-fence admission revocation was not observed.');
      }
      return { admissionRevoked: true, writersDrained: true, activeWriterCount: 0 };
    },
  };
}

export { createSessionLifecycleWriterAdmission } from '../backend/session-lifecycle-store.js';
export type { SessionLifecycleWriterAdmission } from '../backend/session-lifecycle-store.js';

function assertOperationId(operationId: string): string {
  return boundedString(operationId, 'operationId');
}

function assertCompleteCensus(
  result: AnalyticsHostDiscoveryResult,
  workspaceId: string,
  nowMs: number,
  requireAuthenticatedHostStatus = false,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !isRecord(result)
    || result.workspaceId !== workspaceId
    || !Number.isSafeInteger(result.observedAtMs)
    || result.observedAtMs < 0
    || result.observedAtMs > nowMs + ANALYTICS_WRITER_FENCE_MAX_CENSUS_AGE_MS
    || nowMs - result.observedAtMs > ANALYTICS_WRITER_FENCE_MAX_CENSUS_AGE_MS
    || result.complete !== true
    || result.registryComplete !== true
    || result.runtimeLeasesComplete !== true
    || result.processOwnersComplete !== true
    || (requireAuthenticatedHostStatus && result.authenticatedHostsComplete !== true)
    || (requireAuthenticatedHostStatus && (!Array.isArray(result.authenticatedHosts)
      || result.authenticatedHosts.length !== result.hosts?.length))
    || !Array.isArray(result.hosts)
    || result.hosts.length === 0
    || result.hosts.length > ANALYTICS_WRITER_FENCE_MAX_HOSTS
    || !Array.isArray(result.unregisteredRuntimeLeases)
    || result.unregisteredRuntimeLeases.length !== 0
    || !Array.isArray(result.unregisteredBackendOwners)
    || result.unregisteredBackendOwners.length !== 0
    || !Array.isArray(result.reasons)
    || result.reasons.length !== 0) {
    throw new SessionLifecycleConflictError('All-host writer census is incomplete or ambiguous; refusing handoff.');
  }
  const hostIds = new Set<string>();
  const processIds = new Set<number>();
  for (const record of result.hosts) {
    if (!isRecord(record)
      || typeof record.hostInstanceId !== 'string'
      || typeof record.processId !== 'number'
      || !Number.isSafeInteger(record.processId)
      || record.processId <= 0
      || record.state !== 'registered'
      || record.status !== 'reconciled'
      || !Array.isArray(record.reasons)
      || record.reasons.length !== 0
      || hostIds.has(record.hostInstanceId)
      || processIds.has(record.processId)) {
      throw new SessionLifecycleConflictError('All-host writer census contains missing, duplicate, or non-reconciled identity evidence.');
    }
    hostIds.add(record.hostInstanceId);
    processIds.add(record.processId);
  }
  if (requireAuthenticatedHostStatus) {
    const authenticatedIds = new Set<string>();
    const authenticatedProcessIds = new Set<number>();
    for (const evidence of result.authenticatedHosts ?? []) {
      if (!isRecord(evidence)
        || typeof evidence.hostInstanceId !== 'string'
        || typeof evidence.processId !== 'number'
        || !Number.isSafeInteger(evidence.processId)
        || !isRecord(evidence.observedHost)
        || evidence.observedHost.hostInstanceId !== evidence.hostInstanceId
        || evidence.observedHost.processId !== evidence.processId
        || authenticatedIds.has(evidence.hostInstanceId)
        || authenticatedProcessIds.has(evidence.processId)) {
        throw new SessionLifecycleConflictError('Authenticated host status evidence contains missing or duplicate identity fields.');
      }
      authenticatedIds.add(evidence.hostInstanceId);
      authenticatedProcessIds.add(evidence.processId);
    }
    if (authenticatedIds.size !== hostIds.size
      || [...hostIds].some((hostId) => !authenticatedIds.has(hostId))) {
      throw new SessionLifecycleConflictError('Authenticated host status evidence does not cover the complete host census.');
    }
  }
}

async function readCompleteRegistry(
  store: SessionLifecycleStore,
  workspaceId: string,
): Promise<AnalyticsHostRecord[]> {
  const hosts: AnalyticsHostRecord[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  for (;;) {
    const page = store.listAnalyticsHosts(workspaceId, { limit: 64, ...(cursor ? { cursor } : {}) });
    hosts.push(...page.hosts);
    if (hosts.length > ANALYTICS_WRITER_FENCE_MAX_HOSTS) {
      throw new SessionLifecycleConflictError('Analytics host registry exceeds the bounded all-host census.');
    }
    if (!page.truncated) return hosts.filter((host) => host.state !== 'stopped');
    if (!page.nextCursor || page.nextCursor === previousCursor) {
      throw new SessionLifecycleConflictError('Analytics host registry pagination is incomplete or ambiguous.');
    }
    previousCursor = page.nextCursor;
    cursor = page.nextCursor;
  }
}

function assertRegistryMatchesCensus(
  registryHosts: readonly AnalyticsHostRecord[],
  discovery: AnalyticsHostDiscoveryResult,
  workspaceId: string,
): AnalyticsWriterFenceHostIdentity[] {
  if (registryHosts.length !== discovery.hosts.length) {
    throw new SessionLifecycleConflictError('All-host writer census does not cover the complete host registry.');
  }
  const discoveryById = new Map(discovery.hosts.map((host) => [host.hostInstanceId, host] as const));
  const expected: AnalyticsWriterFenceHostIdentity[] = [];
  for (const host of registryHosts) {
    if (host.workspaceId !== workspaceId
      || host.state !== 'registered'
      || !host.endpointName
      || !host.capabilities.includes('authenticated-control')
      || !host.capabilities.includes('writer-fence')) {
      throw new SessionLifecycleConflictError('All-host writer census contains a host without authenticated writer-fence capability.');
    }
    const observed = discoveryById.get(host.hostInstanceId);
    if (!observed || observed.processId !== host.processId || observed.status !== 'reconciled') {
      throw new SessionLifecycleConflictError('All-host writer census does not match the registered host identity.');
    }
    expected.push(identityFromHost(host));
  }
  expected.sort((left, right) => compareHostIds(left.hostInstanceId, right.hostInstanceId));
  return expected;
}

function assertParticipants(
  participants: readonly AnalyticsAllHostFenceParticipant[],
  expected: readonly AnalyticsWriterFenceHostIdentity[],
): Map<string, AnalyticsAllHostFenceParticipant> {
  if (!Array.isArray(participants) || participants.length > expected.length) {
    throw new SessionLifecycleConflictError('Authenticated all-host participant census is ambiguous.');
  }
  const byHost = new Map<string, AnalyticsAllHostFenceParticipant>();
  for (const participant of participants) {
    const identity = identityFromHandoffHost(participant.identity);
    if (byHost.has(identity.hostInstanceId) || typeof participant.send !== 'function') {
      throw new SessionLifecycleConflictError('Authenticated all-host participant census contains a duplicate or invalid endpoint.');
    }
    if (typeof participant.key !== 'string' || participant.key.length === 0) {
      throw new SessionLifecycleConflictError(`Authenticated handoff key is missing for host ${identity.hostInstanceId}.`);
    }
    try {
      boundedKey(participant.key);
    } catch (error) {
      throw new SessionLifecycleConflictError(`Authenticated handoff key for host ${identity.hostInstanceId} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const registered = expected.find((host) => host.hostInstanceId === identity.hostInstanceId);
    if (!registered || !sameIdentity(registered, identity)) {
      throw new SessionLifecycleConflictError('Authenticated participant identity is not in the frozen host census.');
    }
    byHost.set(identity.hostInstanceId, participant);
  }
  return byHost;
}

function timeoutPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer-fence endpoint timed out.')), timeoutMs);
    timer.unref?.();
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function receiptFromFence(fence: AnalyticsWriterFenceRecord): AnalyticsAllHostHandoffReceipt {
  if (fence.state !== 'fenced') throw new SessionLifecycleConflictError('Analytics writer fence did not reach the fenced state.');
  return {
    schemaVersion: 1,
    workspaceId: fence.workspaceId,
    operationId: fence.operationId,
    purpose: fence.purpose,
    fenceEpoch: fence.fenceEpoch,
    status: 'fenced',
    hostInstanceIds: [...fence.expectedHosts]
      .map((host) => host.hostInstanceId)
      .sort(compareHostIds),
    acknowledgedHostInstanceIds: [...fence.acknowledgedHostInstanceIds]
      .sort(compareHostIds),
  };
}

/** Durable all-host coordinator. It only establishes the authenticated fence;
 * activation routing and storage cutoff remain separate ordered callers. */
export class AnalyticsAllHostHandoffCoordinator {
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AnalyticsAllHostHandoffOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = boundedWaitTimeout(options.requestTimeoutMs);
  }

  async run(operationId: string): Promise<AnalyticsAllHostHandoffReceipt> {
    const normalizedOperationId = assertOperationId(operationId);
    const existing = this.options.registry.getAnalyticsWriterFence(this.options.workspaceId);
    if (existing && existing.state !== 'open'
      && (existing.operationId !== normalizedOperationId || existing.purpose !== this.options.purpose)) {
      throw new SessionLifecycleConflictError(
        `Analytics writer fence ${existing.operationId} is already ${existing.state}; refusing a competing handoff.`,
      );
    }
    if (existing?.state === 'fenced'
      || (existing?.state === 'fencing'
        && existing.acknowledgedHostInstanceIds.length === existing.expectedHosts.length)) {
      // A completed fence remains valid even if an acknowledged host has since
      // stopped. Durable admission is already closed, so retries need not
      // require a fresh live-host census to repeat the proof.
      return receiptFromFence(this.options.registry.completeAnalyticsWriterFence(
        this.options.workspaceId,
        normalizedOperationId,
        this.now(),
      ));
    }
    const discovery = await this.options.discover();
    const nowMs = this.now();
    assertCompleteCensus(
      discovery,
      this.options.workspaceId,
      nowMs,
      this.options.requireAuthenticatedHostStatus === true,
    );
    const registryHosts = await readCompleteRegistry(this.options.registry, this.options.workspaceId);
    const expected = assertRegistryMatchesCensus(registryHosts, discovery, this.options.workspaceId);
    const participants = assertParticipants(this.options.participants, expected);
    const fence = this.options.registry.beginAnalyticsWriterFence({
      workspaceId: this.options.workspaceId,
      operationId: normalizedOperationId,
      purpose: this.options.purpose,
      expectedHosts: expected,
      nowMs: this.now(),
    });
    const acknowledged = new Set(fence.acknowledgedHostInstanceIds);
    for (const host of expected) {
      if (acknowledged.has(host.hostInstanceId)) continue;
      const participant = participants.get(host.hostInstanceId);
      if (!participant) {
        throw new SessionLifecycleConflictError(`Authenticated participant ${host.hostInstanceId} is missing from the handoff retry.`);
      }
      const request = createSignedAnalyticsWriterFenceRequest({
        workspaceId: this.options.workspaceId,
        operationId: normalizedOperationId,
        purpose: this.options.purpose,
        fenceEpoch: fence.fenceEpoch,
      }, participant.key, { issuedAtMs: this.now() });
      let response: AnalyticsWriterFenceResponse;
      try {
        response = verifyAnalyticsWriterFenceResponse(
          await timeoutPromise(participant.send(request), this.requestTimeoutMs),
          participant.key,
        );
      } catch (error) {
        throw new SessionLifecycleConflictError(`Host ${host.hostInstanceId} did not authenticate a freeze acknowledgement: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok === false) {
        throw new SessionLifecycleConflictError(`Host ${host.hostInstanceId} rejected the writer fence: ${response.error}`);
      }
      const responseHost = boundedIdentity(response.host, 'writer-fence acknowledgement host');
      if (response.requestId !== request.requestId
        || response.nonce !== request.nonce
        || response.workspaceId !== request.workspaceId
        || response.operationId !== request.operationId
        || response.fenceEpoch !== request.fenceEpoch
        || !sameIdentity(responseHost, host)) {
        throw new SessionLifecycleConflictError(`Host ${host.hostInstanceId} returned a stale or mismatched writer-fence acknowledgement.`);
      }
      this.options.registry.acknowledgeAnalyticsWriterFence({
        workspaceId: this.options.workspaceId,
        operationId: normalizedOperationId,
        fenceEpoch: fence.fenceEpoch,
        identity: responseHost,
        activeWriterCount: response.activeWriterCount,
        nowMs: this.now(),
      });
      acknowledged.add(host.hostInstanceId);
    }
    const completed = this.options.registry.completeAnalyticsWriterFence(
      this.options.workspaceId,
      normalizedOperationId,
      this.now(),
    );
    return receiptFromFence(completed);
  }

  async ensureFenced(
    operationId: string,
  ): Promise<AnalyticsAllHostHandoffReceipt & { readonly purpose: 'storage-cutoff' }> {
    if (this.options.purpose !== 'storage-cutoff') {
      throw new SessionLifecycleConflictError('Only a storage-cutoff handoff can authorize storage cutoff.');
    }
    const receipt = await this.run(operationId);
    if (receipt.purpose !== 'storage-cutoff') {
      throw new SessionLifecycleConflictError('Storage cutoff handoff returned the wrong purpose.');
    }
    return receipt as AnalyticsAllHostHandoffReceipt & { readonly purpose: 'storage-cutoff' };
  }
}

/** Shared freshness check used by the host control endpoint before it invokes
 * the local fence. Kept exported so alternate transports cannot skip it. */
export function assertFreshAnalyticsWriterFenceRequest(
  request: Pick<AnalyticsWriterFenceRequest, 'issuedAtMs' | 'expiresAtMs'>,
  nowMs: number,
): void {
  assertFreshAnalyticsHandoffRequest(request, nowMs);
}

export function analyticsWriterFenceAcknowledgementFromStore(
  acknowledgement: AnalyticsWriterFenceAcknowledgement,
): AnalyticsWriterFenceLocalAcknowledgement {
  if (acknowledgement.activeWriterCount !== 0) throw new Error('Durable writer acknowledgement still has active writers.');
  return { admissionRevoked: true, writersDrained: true, activeWriterCount: 0 };
}
