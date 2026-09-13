import { createConnection, type Socket } from 'node:net';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';

import {
  createSignedAnalyticsHandoffRequest,
  verifyAnalyticsHandoffResponse,
  ANALYTICS_HANDOFF_MAX_FRAME_BYTES,
  ANALYTICS_HANDOFF_MAX_STATUS_HOSTS,
  ANALYTICS_HANDOFF_MAX_STATUS_BYTES,
  type AnalyticsHandoffControlRequest,
  type AnalyticsHandoffHostIdentity,
  type AnalyticsHandoffStatus,
} from '../../../shared/analytics/handoff.js';
import type {
  AnalyticsHostPage,
  AnalyticsHostRecord,
  SessionLifecycleStore,
} from '../backend/session-lifecycle-store.js';
import {
  parseWindowsProcessCensus,
  parseWindowsProcessCreationDate,
  parseWindowsProcessOwnerRows,
  readProcessCensus,
  readWindowsProcessOwners,
  type BackendProcessOwnerEvidence,
  type ProcessOwnerReadResult,
} from './analytics-process-census.js';

export {
  parseWindowsProcessCensus,
  parseWindowsProcessCreationDate,
  parseWindowsProcessOwnerRows,
  readProcessCensus,
  readWindowsProcessOwners,
};
export type { BackendProcessOwnerEvidence, ProcessBirthEvidence, ProcessOwnerReadResult } from './analytics-process-census.js';

const RUNTIME_SCHEMA = 1;
const MAX_LEASE_FILES = 512;
const MAX_LEASE_BYTES = 16 * 1024;
const MAX_REGISTRY_HOSTS = 512;
const MAX_REGISTRY_PAGE = 64;
const LEASE_FILE_PATTERN = /^([0-9a-f]{64})-(\d+)-([0-9a-f]{32})\.json$/u;

export interface RuntimeGenerationIdentity {
  publisher: string;
  name: string;
  version: string;
}

export interface RuntimeLeaseEvidence {
  /** Filename only; the lease payload is never returned or logged. */
  leaseFileName: string;
  runtimeGeneration: string;
  processId: number;
  /** This is the lease write timestamp, not process birth time. */
  leaseCreatedAtMs: number;
  identity: RuntimeGenerationIdentity;
}

export type AnalyticsDiscoveryReasonCode =
  | 'registry-unavailable'
  | 'registry-page-truncated'
  | 'registry-page-invalid-cursor'
  | 'runtime-lease-directory-unavailable'
  | 'runtime-lease-list-truncated'
  | 'runtime-lease-invalid'
  | 'runtime-lease-identity-mismatch'
  | 'process-census-unavailable'
  | 'process-census-truncated'
  | 'process-birth-unavailable'
  | 'host-state-stopping'
  | 'host-state-unsupported'
  | 'host-state-stopped'
  | 'host-process-missing'
  | 'host-process-ambiguous'
  | 'host-runtime-lease-missing'
  | 'host-runtime-lease-ambiguous'
  | 'runtime-lease-process-missing'
  | 'runtime-lease-process-unregistered'
  | 'runtime-lease-birth-after-lease-write'
  | 'host-backend-owner-missing'
  | 'host-backend-owner-ambiguous'
  | 'backend-owner-unregistered'
  | 'backend-process-birth-unavailable'
  | 'backend-process-before-host'
  | 'backend-analytics-descriptor-missing'
  | 'backend-analytics-host-mismatch'
  | 'backend-analytics-generation-unavailable'
  | 'backend-analytics-generation-mismatch'
  | 'backend-owner-identity-invalid'
  | 'backend-process-ambiguous'
  | 'process-pid-ambiguous'
  | 'host-authentication-probe-unwired'
  | 'host-authentication-endpoint-missing'
  | 'host-authentication-key-missing'
  | 'host-authentication-failed'
  | 'host-authentication-identity-mismatch'
  | 'host-authentication-status-invalid';

export interface AnalyticsDiscoveryReason {
  code: AnalyticsDiscoveryReasonCode;
  hostInstanceId?: string;
  processId?: number;
  runtimeGeneration?: string;
}

export interface RuntimeLeaseReadResult {
  leases: readonly RuntimeLeaseEvidence[];
  complete: boolean;
  reasons: readonly AnalyticsDiscoveryReason[];
}

export interface AuthenticatedHostStatusEvidence {
  hostInstanceId: string;
  processId: number;
  /** The identity returned by the host after its response MAC was verified. */
  observedHost: AnalyticsHandoffStatus['host'];
}

export interface AuthenticatedHostStatusReadResult {
  statuses: readonly AuthenticatedHostStatusEvidence[];
  complete: boolean;
  reasons: readonly AnalyticsDiscoveryReason[];
}

export interface AnalyticsHostDiscoveryRecord {
  hostInstanceId: string;
  processId: number;
  state: AnalyticsHostRecord['state'];
  status: 'reconciled' | 'unsupported' | 'unknown';
  runtimeGeneration?: string;
  backendProcessId?: number;
  backendGeneration?: number;
  reasons: readonly AnalyticsDiscoveryReason[];
}

export interface AnalyticsHostDiscoveryOptions {
  workspaceId: string;
  /** Existing lifecycle authority; discovery never opens a second registry. */
  registry: Pick<SessionLifecycleStore, 'listAnalyticsHosts'>;
  /** `<extension>/pie-runtime`, owned by runtime-generations.cjs. */
  runtimeRootPath: string;
  runtimeIdentity: RuntimeGenerationIdentity;
  /** Active analytics generation, when canonical authority has one. The
   * registry's `generationId` is the host process generation and must not be
   * compared with this activation generation. */
  analyticsGenerationId?: string;
  /** True only when the caller has proved from the activation store that no
   * canonical analytics authority exists yet (first-ever activation). A
   * backend without the canonical analytics descriptor is then legitimate;
   * every other host/backend owner and process identity check still applies,
   * and a descriptor that is present remains unreconcilable. */
  allowAbsentAnalyticsDescriptor?: boolean;
  readRuntimeLeases?: () => Promise<RuntimeLeaseReadResult>;
  readProcessOwners?: () => Promise<ProcessOwnerReadResult>;
  /** Production callers set this so registry/process evidence is also
   * corroborated by a signed, per-host status response. The default preserves
   * the older read-only diagnostic seam used by host-local startup reporting. */
  requireAuthenticatedHostStatus?: boolean;
  readAuthenticatedHostStatus?: (host: AnalyticsHostRecord) => Promise<AuthenticatedHostStatusEvidence>;
  /** Terminal rows are retained as durable history. A post-restart or later
   * handoff may explicitly reconcile only current registered hosts, while any
   * live process/lease/backend belonging to a terminal row still remains an
   * unregistered-owner blocker. */
  ignoreStoppedHosts?: boolean;
}

export interface AnalyticsHostDiscoveryResult {
  workspaceId: string;
  observedAtMs: number;
  registryComplete: boolean;
  runtimeLeasesComplete: boolean;
  processOwnersComplete: boolean;
  authenticatedHostsComplete?: boolean;
  authenticatedHosts?: readonly AuthenticatedHostStatusEvidence[];
  hosts: readonly AnalyticsHostDiscoveryRecord[];
  unregisteredRuntimeLeases: readonly RuntimeLeaseEvidence[];
  unregisteredBackendOwners: readonly BackendProcessOwnerEvidence[];
  reasons: readonly AnalyticsDiscoveryReason[];
  /** A proof result for a future producer; this module does not activate it. */
  complete: boolean;
}

function reason(code: AnalyticsDiscoveryReasonCode, details: Partial<AnalyticsDiscoveryReason> = {}): AnalyticsDiscoveryReason {
  return { code, ...details };
}

function isPositivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function boundedIdentity(value: unknown): RuntimeGenerationIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.publisher !== 'string' || candidate.publisher.length === 0 || candidate.publisher.length > 512
    || typeof candidate.name !== 'string' || candidate.name.length === 0 || candidate.name.length > 512
    || typeof candidate.version !== 'string' || candidate.version.length === 0 || candidate.version.length > 512
    || /[\\/\0]/u.test(candidate.publisher) || /[\\/\0]/u.test(candidate.name)
    || /[\\/\0]/u.test(candidate.version)) return undefined;
  return { publisher: candidate.publisher, name: candidate.name, version: candidate.version };
}

function sameRuntimeIdentity(left: RuntimeGenerationIdentity, right: RuntimeGenerationIdentity): boolean {
  return left.publisher === right.publisher && left.name === right.name && left.version === right.version;
}

function duplicateProcessIds<T>(
  entries: readonly T[],
  processIdOf: (entry: T) => number,
): Set<number> {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const entry of entries) {
    const processId = processIdOf(entry);
    if (seen.has(processId)) duplicates.add(processId);
    else seen.add(processId);
  }
  return duplicates;
}

/** Read the runtime-generations lease directory without mutating it. */
export async function readRuntimeLeaseEvidence(
  runtimeRootPath: string,
  expectedIdentity: RuntimeGenerationIdentity,
): Promise<RuntimeLeaseReadResult> {
  const leasesPath = path.join(path.resolve(runtimeRootPath), 'leases');
  const leaseNames: string[] = [];
  let directory;
  try {
    directory = await opendir(leasesPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (leaseNames.length >= MAX_LEASE_FILES) break;
      leaseNames.push(entry.name);
    }
  } catch {
    return {
      leases: [],
      complete: false,
      reasons: [reason('runtime-lease-directory-unavailable')],
    };
  } finally {
    await directory?.close().catch(() => undefined);
  }
  const reasons: AnalyticsDiscoveryReason[] = [];
  // An iterator cannot report a count beyond the cap without reading the next
  // entry; probe only one extra entry so a giant directory is never collected
  // into an unbounded array.
  let entryCountBeyondCap = false;
  try {
    const probe = await opendir(leasesPath);
    let seen = 0;
    for await (const entry of probe) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        seen += 1;
        if (seen > MAX_LEASE_FILES) {
          entryCountBeyondCap = true;
          break;
        }
      }
    }
    await probe.close().catch(() => undefined);
  } catch {
    entryCountBeyondCap = true;
  }
  if (entryCountBeyondCap) reasons.push(reason('runtime-lease-list-truncated'));
  const leases: RuntimeLeaseEvidence[] = [];
  for (const leaseFileName of leaseNames) {
    const match = LEASE_FILE_PATTERN.exec(leaseFileName);
    // Staging files and unrelated metadata are not leases owned by the
    // runtime API; only a lease-shaped JSON file is evidence to reconcile.
    if (!match) continue;
    const runtimeGeneration = match[1]!;
    const processId = Number(match[2]);
    let file;
    try {
      file = await open(path.join(leasesPath, leaseFileName), 'r');
      const bytes = Buffer.allocUnsafe(MAX_LEASE_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const size = (await file.stat()).size;
      if (bytesRead > MAX_LEASE_BYTES || size > MAX_LEASE_BYTES) throw new Error('lease exceeds bound');
      const contents = bytes.subarray(0, bytesRead).toString('utf8');
      const parsed = JSON.parse(contents) as Record<string, unknown>;
      const identity = boundedIdentity(parsed.identity);
      const leaseCreatedAtMs = parsed.createdAt;
      if (parsed.schema !== RUNTIME_SCHEMA || !identity
        || parsed.generation !== runtimeGeneration || !isPositivePid(parsed.pid)
        || parsed.pid !== processId || typeof leaseCreatedAtMs !== 'number'
        || !Number.isSafeInteger(leaseCreatedAtMs) || leaseCreatedAtMs <= 0) {
        reasons.push(reason('runtime-lease-invalid', { processId, runtimeGeneration }));
        continue;
      }
      if (!sameRuntimeIdentity(identity, expectedIdentity)) {
        reasons.push(reason('runtime-lease-identity-mismatch', { processId, runtimeGeneration }));
      }
      leases.push({
        leaseFileName,
        runtimeGeneration,
        processId,
        leaseCreatedAtMs,
        identity,
      });
    } catch {
      reasons.push(reason('runtime-lease-invalid', { processId, runtimeGeneration }));
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  return { leases, complete: reasons.length === 0, reasons };
}

const MAX_AUTHENTICATED_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_AUTHENTICATED_PROBE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedProbeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_AUTHENTICATED_PROBE_TIMEOUT_MS;
  return Math.min(MAX_AUTHENTICATED_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function boundedProbeString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedStatusHost(value: unknown): AnalyticsHandoffStatus['host'] {
  if (!isRecord(value)) throw new Error('authenticated host status identity is invalid.');
  const state = value.state;
  if (state !== 'registered' && state !== 'stopping' && state !== 'stopped' && state !== 'unsupported') {
    throw new Error('authenticated host status state is invalid.');
  }
  const processId = value.processId;
  if (!isPositivePid(processId)) throw new Error('authenticated host status processId is invalid.');
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64
    || value.capabilities.some((capability) => typeof capability !== 'string' || capability.length === 0 || capability.length > 128)) {
    throw new Error('authenticated host status capabilities are invalid.');
  }
  boundedProbeString(value.hostInstanceId, 'authenticated hostInstanceId');
  boundedProbeString(value.workspaceId, 'authenticated workspaceId');
  boundedProbeString(value.generationId, 'authenticated generationId');
  boundedProbeString(value.buildId, 'authenticated buildId');
  boundedProbeString(value.registeredAtMs, 'authenticated registeredAtMs');
  boundedProbeString(value.heartbeatAtMs, 'authenticated heartbeatAtMs');
  boundedProbeString(value.updatedAtMs, 'authenticated updatedAtMs');
  if (value.endpointName !== undefined) boundedProbeString(value.endpointName, 'authenticated endpointName');
  if (value.stoppedAtMs !== undefined) boundedProbeString(value.stoppedAtMs, 'authenticated stoppedAtMs');
  if (value.unsupportedReason !== undefined) boundedProbeString(value.unsupportedReason, 'authenticated unsupportedReason', 1_024);
  return value as unknown as AnalyticsHandoffStatus['host'];
}

function parseAuthenticatedStatus(value: unknown): AnalyticsHandoffStatus {
  if (!isRecord(value)
    || !Array.isArray(value.hosts)
    || value.hosts.length > ANALYTICS_HANDOFF_MAX_STATUS_HOSTS
    || typeof value.truncated !== 'boolean'
    || value.allHostsHandoffAvailable !== false
    || !isRecord(value.inventoryProof)) {
    throw new Error('authenticated host status payload is invalid.');
  }
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > ANALYTICS_HANDOFF_MAX_STATUS_BYTES) {
    throw new Error('authenticated host status payload exceeds its bound.');
  }
  const host = boundedStatusHost(value.host);
  const hosts = value.hosts.map((entry) => boundedStatusHost(entry));
  if (value.nextCursor !== undefined) boundedProbeString(value.nextCursor, 'authenticated status cursor', 128);
  return {
    host,
    hosts,
    truncated: value.truncated,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor as string }),
    inventoryProof: value.inventoryProof as unknown as AnalyticsHandoffStatus['inventoryProof'],
    allHostsHandoffAvailable: false,
  };
}

function sameAuthenticatedHostIdentity(
  expected: AnalyticsHostRecord,
  observed: AnalyticsHandoffHostIdentity & { state: AnalyticsHandoffStatus['host']['state'] },
): boolean {
  return observed.hostInstanceId === expected.hostInstanceId
    && observed.workspaceId === expected.workspaceId
    && observed.generationId === expected.generationId
    && observed.buildId === expected.buildId
    && observed.processId === expected.processId
    && observed.endpointName === expected.endpointName
    && observed.state === expected.state;
}

export class AnalyticsHostProbeError extends Error {
  constructor(
    readonly code: Extract<AnalyticsDiscoveryReasonCode,
      | 'host-authentication-endpoint-missing'
      | 'host-authentication-key-missing'
      | 'host-authentication-failed'
      | 'host-authentication-identity-mismatch'
      | 'host-authentication-status-invalid'>,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyticsHostProbeError';
  }
}

export interface AnalyticsHandoffFrameSender {
  (endpointName: string, request: AnalyticsHandoffControlRequest, timeoutMs: number): Promise<unknown>;
}

export interface AnalyticsBoundedFrameSender {
  (endpointName: string, request: object, timeoutMs: number): Promise<unknown>;
}

/** Send one bounded request frame to a host-owned named pipe. The default is
 * the production transport; tests can inject a sender without opening a live
 * socket. */
export function sendBoundedAnalyticsFrame(
  endpointName: string,
  request: object,
  timeoutMs = DEFAULT_AUTHENTICATED_PROBE_TIMEOUT_MS,
): Promise<unknown> {
  const endpoint = boundedProbeString(endpointName, 'handoff endpoint', 1_024);
  const timeout = boundedProbeTimeout(timeoutMs);
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame, 'utf8') > ANALYTICS_HANDOFF_MAX_FRAME_BYTES) {
    return Promise.reject(new Error('handoff request exceeds its frame bound.'));
  }
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const socket: Socket = createConnection(endpoint);
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
      socket.destroy();
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => finish(new Error('authenticated handoff probe timed out.')));
    socket.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.once('close', () => {
      if (!settled) finish(new Error('authenticated handoff endpoint closed without a response.'));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > ANALYTICS_HANDOFF_MAX_FRAME_BYTES) {
        finish(new Error('authenticated handoff response exceeds its frame bound.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      const trailing = buffer.slice(newline + 1);
      if (trailing.length > 0) {
        finish(new Error('authenticated handoff response contains more than one frame.'));
        return;
      }
      try {
        finish(undefined, JSON.parse(line) as unknown);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('connect', () => {
      try {
        socket.end(frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function sendAuthenticatedAnalyticsHandoffFrame(
  endpointName: string,
  request: AnalyticsHandoffControlRequest,
  timeoutMs = DEFAULT_AUTHENTICATED_PROBE_TIMEOUT_MS,
): Promise<unknown> {
  return sendBoundedAnalyticsFrame(endpointName, request, timeoutMs);
}

export interface AuthenticatedAnalyticsHostProbeOptions {
  timeoutMs?: number;
  now?: () => number;
  send?: AnalyticsHandoffFrameSender;
}

/** Probe one registered host using its out-of-band per-boot key and verify the
 * returned host identity. A registry row or an open pipe without this MAC
 * check is never accepted as host evidence. */
export async function probeAuthenticatedAnalyticsHostStatus(
  host: AnalyticsHostRecord,
  key: string | undefined,
  options: AuthenticatedAnalyticsHostProbeOptions = {},
): Promise<AuthenticatedHostStatusEvidence> {
  if (!host.endpointName) {
    throw new AnalyticsHostProbeError('host-authentication-endpoint-missing', `Host ${host.hostInstanceId} has no authenticated endpoint.`);
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new AnalyticsHostProbeError('host-authentication-key-missing', `Host ${host.hostInstanceId} has no authenticated handoff key.`);
  }
  const now = options.now ?? Date.now;
  const issuedAtMs = now();
  const request = createSignedAnalyticsHandoffRequest('status', {
    workspaceId: host.workspaceId,
    limit: 1,
  }, key, { issuedAtMs });
  let raw: unknown;
  try {
    raw = await (options.send ?? sendAuthenticatedAnalyticsHandoffFrame)(
      host.endpointName,
      request,
      boundedProbeTimeout(options.timeoutMs),
    );
  } catch (error) {
    if (error instanceof AnalyticsHostProbeError) throw error;
    throw new AnalyticsHostProbeError(
      'host-authentication-failed',
      `Host ${host.hostInstanceId} did not answer its authenticated status probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let response;
  try {
    response = verifyAnalyticsHandoffResponse(raw, key);
  } catch {
    throw new AnalyticsHostProbeError(
      'host-authentication-failed',
      `Host ${host.hostInstanceId} returned an unauthenticated status response.`,
    );
  }
  if (response.requestId !== request.requestId || response.ok !== true) {
    throw new AnalyticsHostProbeError(
      'host-authentication-failed',
      `Host ${host.hostInstanceId} returned a rejected or stale status response.`,
    );
  }
  let status: AnalyticsHandoffStatus;
  try {
    status = parseAuthenticatedStatus(response.result);
  } catch (error) {
    throw new AnalyticsHostProbeError(
      'host-authentication-status-invalid',
      `Host ${host.hostInstanceId} returned an invalid status payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sameAuthenticatedHostIdentity(host, status.host)) {
    throw new AnalyticsHostProbeError(
      'host-authentication-identity-mismatch',
      `Host ${host.hostInstanceId} returned a mismatched process or host identity.`,
    );
  }
  return {
    hostInstanceId: host.hostInstanceId,
    processId: host.processId,
    observedHost: status.host,
  };
}

export function createAuthenticatedAnalyticsHostStatusProbe(options: {
  keyForHost: (host: AnalyticsHostRecord) => string | undefined;
  timeoutMs?: number;
  now?: () => number;
  send?: AnalyticsHandoffFrameSender;
}): (host: AnalyticsHostRecord) => Promise<AuthenticatedHostStatusEvidence> {
  return (host) => probeAuthenticatedAnalyticsHostStatus(
    host,
    options.keyForHost(host),
    options,
  );
}

/** Probe every registered host serially. The serial bound avoids opening an
 * unbounded socket fan-out while retaining exact per-host failure evidence. */
export async function readAuthenticatedHostStatuses(
  hosts: readonly AnalyticsHostRecord[],
  probe: ((host: AnalyticsHostRecord) => Promise<AuthenticatedHostStatusEvidence>) | undefined,
): Promise<AuthenticatedHostStatusReadResult> {
  const statuses: AuthenticatedHostStatusEvidence[] = [];
  const reasons: AnalyticsDiscoveryReason[] = [];
  if (!probe) {
    for (const host of hosts) {
      reasons.push(reason('host-authentication-probe-unwired', {
        hostInstanceId: host.hostInstanceId,
        processId: host.processId,
      }));
    }
    return { statuses, complete: hosts.length === 0, reasons };
  }
  for (const host of hosts) {
    try {
      const evidence = await probe(host);
      if (!isRecord(evidence)
        || evidence.hostInstanceId !== host.hostInstanceId
        || evidence.processId !== host.processId
        || !isRecord(evidence.observedHost)
        || !sameAuthenticatedHostIdentity(host, evidence.observedHost as AuthenticatedHostStatusEvidence['observedHost'])) {
        throw new AnalyticsHostProbeError(
          'host-authentication-identity-mismatch',
          `Host ${host.hostInstanceId} returned a mismatched process or host identity.`,
        );
      }
      statuses.push(evidence);
    } catch (error) {
      const code = error instanceof AnalyticsHostProbeError
        ? error.code
        : 'host-authentication-status-invalid';
      reasons.push(reason(code, { hostInstanceId: host.hostInstanceId, processId: host.processId }));
    }
  }
  return { statuses, complete: reasons.length === 0 && statuses.length === hosts.length, reasons };
}

async function readHostRegistry(
  registry: Pick<SessionLifecycleStore, 'listAnalyticsHosts'>,
  workspaceId: string,
): Promise<{ hosts: readonly AnalyticsHostRecord[]; complete: boolean; reasons: readonly AnalyticsDiscoveryReason[] }> {
  const hosts: AnalyticsHostRecord[] = [];
  const reasons: AnalyticsDiscoveryReason[] = [];
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  try {
    for (;;) {
      const page: AnalyticsHostPage = registry.listAnalyticsHosts(workspaceId, {
        limit: MAX_REGISTRY_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const host of page.hosts) {
        if (host.workspaceId !== workspaceId || (hosts.at(-1)?.hostInstanceId ?? '') >= host.hostInstanceId) {
          reasons.push(reason('registry-page-invalid-cursor', { hostInstanceId: host.hostInstanceId }));
          return { hosts, complete: false, reasons };
        }
        hosts.push(host);
      }
      if (!page.truncated) break;
      if (!page.nextCursor || page.nextCursor === previousCursor || hosts.length >= MAX_REGISTRY_HOSTS) {
        reasons.push(reason('registry-page-truncated'));
        return { hosts, complete: false, reasons };
      }
      previousCursor = page.nextCursor;
      cursor = page.nextCursor;
    }
  } catch {
    reasons.push(reason('registry-unavailable'));
    return { hosts, complete: false, reasons };
  }
  return { hosts, complete: true, reasons };
}

function dedupeReasons(reasons: readonly AnalyticsDiscoveryReason[]): AnalyticsDiscoveryReason[] {
  const seen = new Set<string>();
  return reasons.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reconcile the existing host registry with runtime leases and the OS process
 * census. This is a read-only proof helper. It never changes registry state
 * or stops a process. Production callers may additionally opt into signed
 * per-host status probes; the result remains non-authorizing until the durable
 * all-host handoff coordinator consumes it.
 */
export async function discoverAnalyticsHostWriters(
  options: AnalyticsHostDiscoveryOptions,
): Promise<AnalyticsHostDiscoveryResult> {
  const registryResult = await readHostRegistry(options.registry, options.workspaceId);
  const hosts = options.ignoreStoppedHosts
    ? registryResult.hosts.filter((host) => host.state !== 'stopped')
    : registryResult.hosts;
  const [leaseResult, processResult, authenticatedResult] = await Promise.all([
    options.readRuntimeLeases
      ? options.readRuntimeLeases()
      : readRuntimeLeaseEvidence(options.runtimeRootPath, options.runtimeIdentity),
    options.readProcessOwners ? options.readProcessOwners() : readProcessCensus(),
    options.requireAuthenticatedHostStatus
      ? readAuthenticatedHostStatuses(hosts, options.readAuthenticatedHostStatus)
      : Promise.resolve({ statuses: [], complete: true, reasons: [] } satisfies AuthenticatedHostStatusReadResult),
  ]);
  const reasons: AnalyticsDiscoveryReason[] = [
    ...registryResult.reasons,
    ...leaseResult.reasons,
    ...processResult.reasons,
    ...authenticatedResult.reasons,
  ];
  const authenticatedByHostId = new Map(
    authenticatedResult.statuses.map((status) => [status.hostInstanceId, status] as const),
  );
  const authenticatedReasonsByHostId = new Map<string, AnalyticsDiscoveryReason[]>();
  for (const entry of authenticatedResult.reasons) {
    if (!entry.hostInstanceId) continue;
    const entries = authenticatedReasonsByHostId.get(entry.hostInstanceId) ?? [];
    entries.push(entry);
    authenticatedReasonsByHostId.set(entry.hostInstanceId, entries);
  }
  const ambiguousHostPids = duplicateProcessIds(hosts, (entry) => entry.processId);
  for (const processId of ambiguousHostPids) {
    reasons.push(reason('host-process-ambiguous', { processId }));
  }
  const hostsByPid = new Map<number, AnalyticsHostRecord>();
  for (const host of hosts) {
    if (!ambiguousHostPids.has(host.processId)) hostsByPid.set(host.processId, host);
  }
  const leasesByPid = new Map<number, RuntimeLeaseEvidence[]>();
  for (const lease of leaseResult.leases) {
    if (!sameRuntimeIdentity(lease.identity, options.runtimeIdentity)) {
      reasons.push(reason('runtime-lease-identity-mismatch', {
        processId: lease.processId, runtimeGeneration: lease.runtimeGeneration,
      }));
      continue;
    }
    const existing = leasesByPid.get(lease.processId) ?? [];
    existing.push(lease);
    leasesByPid.set(lease.processId, existing);
    if (!hostsByPid.has(lease.processId)) {
      reasons.push(reason('runtime-lease-process-unregistered', {
        processId: lease.processId, runtimeGeneration: lease.runtimeGeneration,
      }));
    }
  }
  const ambiguousProcessPids = duplicateProcessIds(processResult.processes, (entry) => entry.processId);
  for (const processId of ambiguousProcessPids) {
    reasons.push(reason('process-pid-ambiguous', { processId }));
  }
  const processesByPid = new Map(
    processResult.processes
      .filter((entry) => !ambiguousProcessPids.has(entry.processId))
      .map((entry) => [entry.processId, entry] as const),
  );
  const ambiguousBackendPids = duplicateProcessIds(
    processResult.backendOwners,
    (entry) => entry.backendProcessId,
  );
  const ambiguousBackendPidsByHost = new Map<number, Set<number>>();
  for (const backend of processResult.backendOwners) {
    if (!ambiguousBackendPids.has(backend.backendProcessId)) continue;
    const processIds = ambiguousBackendPidsByHost.get(backend.hostProcessId) ?? new Set<number>();
    processIds.add(backend.backendProcessId);
    ambiguousBackendPidsByHost.set(backend.hostProcessId, processIds);
  }
  for (const processId of ambiguousBackendPids) {
    reasons.push(reason('backend-process-ambiguous', { processId }));
  }
  const backendsByHostPid = new Map<number, BackendProcessOwnerEvidence[]>();
  for (const backend of processResult.backendOwners) {
    if (ambiguousBackendPids.has(backend.backendProcessId)) continue;
    const existing = backendsByHostPid.get(backend.hostProcessId) ?? [];
    existing.push(backend);
    backendsByHostPid.set(backend.hostProcessId, existing);
    if (!hostsByPid.has(backend.hostProcessId)) {
      reasons.push(reason('backend-owner-unregistered', {
        processId: backend.backendProcessId,
      }));
    }
  }
  const records: AnalyticsHostDiscoveryRecord[] = [];
  for (const host of hosts) {
    const hostReasons: AnalyticsDiscoveryReason[] = [];
    const addHostReason = (entry: AnalyticsDiscoveryReason): void => {
      hostReasons.push({ ...entry, hostInstanceId: host.hostInstanceId });
      reasons.push({ ...entry, hostInstanceId: host.hostInstanceId });
    };
    if (host.state === 'stopping') addHostReason(reason('host-state-stopping'));
    if (host.state === 'unsupported') addHostReason(reason('host-state-unsupported'));
    if (host.state === 'stopped') addHostReason(reason('host-state-stopped'));
    if (options.requireAuthenticatedHostStatus) {
      const authenticated = authenticatedByHostId.get(host.hostInstanceId);
      if (!authenticated) {
        const authenticationReasons = authenticatedReasonsByHostId.get(host.hostInstanceId) ?? [
          reason('host-authentication-status-invalid'),
        ];
        for (const entry of authenticationReasons) addHostReason(entry);
      } else if (authenticated.processId !== host.processId) {
        addHostReason(reason('host-authentication-identity-mismatch', { processId: host.processId }));
      }
    }
    if (ambiguousHostPids.has(host.processId)) {
      addHostReason(reason('host-process-ambiguous', { processId: host.processId }));
    }

    const process = processesByPid.get(host.processId);
    if (ambiguousProcessPids.has(host.processId)) {
      addHostReason(reason('process-pid-ambiguous', { processId: host.processId }));
    } else if (!process) addHostReason(reason('host-process-missing', { processId: host.processId }));
    else if (process.processCreatedAtMs === null) addHostReason(reason('process-birth-unavailable', { processId: host.processId }));

    const leases = leasesByPid.get(host.processId) ?? [];
    if (leases.length === 0) addHostReason(reason('host-runtime-lease-missing', { processId: host.processId }));
    if (leases.length > 1) addHostReason(reason('host-runtime-lease-ambiguous', { processId: host.processId }));
    const lease = leases.length === 1 ? leases[0] : undefined;
    if (lease && process?.processCreatedAtMs !== null && process?.processCreatedAtMs !== undefined
      && process.processCreatedAtMs > lease.leaseCreatedAtMs) {
      addHostReason(reason('runtime-lease-birth-after-lease-write', {
        processId: host.processId, runtimeGeneration: lease.runtimeGeneration,
      }));
    }

    const backends = backendsByHostPid.get(host.processId) ?? [];
    const ambiguousBackendIds = ambiguousBackendPidsByHost.get(host.processId) ?? new Set<number>();
    for (const processId of ambiguousBackendIds) {
      addHostReason(reason('backend-process-ambiguous', { processId }));
    }
    if (backends.length === 0 && ambiguousBackendIds.size === 0) {
      addHostReason(reason('host-backend-owner-missing', { processId: host.processId }));
    }
    if (backends.length > 1) addHostReason(reason('host-backend-owner-ambiguous', { processId: host.processId }));
    const backend = backends.length === 1 ? backends[0] : undefined;
    if (backend) {
      if (backend.backendCreatedAtMs === null || backend.hostCreatedAtMs === null) {
        addHostReason(reason('backend-process-birth-unavailable', { processId: backend.backendProcessId }));
      } else if (backend.backendCreatedAtMs < backend.hostCreatedAtMs) {
        addHostReason(reason('backend-process-before-host', { processId: backend.backendProcessId }));
      }
      if (!backend.analyticsHostInstanceId || !backend.analyticsGenerationId) {
        // First-ever activation: no canonical authority exists to reconcile a
        // descriptor against, so its absence is legitimate. This is the only
        // waived check; process, lease, backend-owner, and authenticated
        // identity evidence above are still fully required.
        if (options.allowAbsentAnalyticsDescriptor !== true) {
          addHostReason(reason('backend-analytics-descriptor-missing', { processId: backend.backendProcessId }));
        }
      } else {
        if (backend.analyticsHostInstanceId !== host.hostInstanceId) {
          addHostReason(reason('backend-analytics-host-mismatch', { processId: backend.backendProcessId }));
        }
        if (!options.analyticsGenerationId) {
          addHostReason(reason('backend-analytics-generation-unavailable', { processId: backend.backendProcessId }));
        } else if (backend.analyticsGenerationId !== options.analyticsGenerationId) {
          addHostReason(reason('backend-analytics-generation-mismatch', { processId: backend.backendProcessId }));
        }
      }
    }
    const status = hostReasons.length === 0
      ? 'reconciled'
      : host.state === 'stopped' || host.state === 'unsupported' ? 'unsupported' : 'unknown';
    records.push({
      hostInstanceId: host.hostInstanceId,
      processId: host.processId,
      state: host.state,
      status,
      ...(lease ? { runtimeGeneration: lease.runtimeGeneration } : {}),
      ...(backend ? {
        backendProcessId: backend.backendProcessId,
        backendGeneration: backend.backendGeneration,
      } : {}),
      reasons: dedupeReasons(hostReasons),
    });
  }

  const unregisteredRuntimeLeases = leaseResult.leases.filter((lease) => {
    return sameRuntimeIdentity(lease.identity, options.runtimeIdentity) && !hostsByPid.has(lease.processId);
  });
  const unregisteredBackendOwners = processResult.backendOwners.filter((backend) => !hostsByPid.has(backend.hostProcessId));
  const allReasons = dedupeReasons(reasons);
  return {
    workspaceId: options.workspaceId,
    observedAtMs: Date.now(),
    registryComplete: registryResult.complete,
    runtimeLeasesComplete: leaseResult.complete,
    processOwnersComplete: processResult.complete,
    authenticatedHostsComplete: authenticatedResult.complete,
    authenticatedHosts: authenticatedResult.statuses,
    hosts: records,
    unregisteredRuntimeLeases,
    unregisteredBackendOwners,
    reasons: allReasons,
    complete: registryResult.complete && leaseResult.complete && processResult.complete
      && authenticatedResult.complete && allReasons.length === 0,
  };
}
