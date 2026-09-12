import { execFile } from 'node:child_process';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  AnalyticsHostPage,
  AnalyticsHostRecord,
  SessionLifecycleStore,
} from '../backend/session-lifecycle-store.js';

const execFileAsync = promisify(execFile);
const RUNTIME_SCHEMA = 1;
const MAX_LEASE_FILES = 512;
const MAX_PROCESS_ROWS = 8_192;
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
  | 'backend-owner-identity-invalid';

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

export interface ProcessBirthEvidence {
  processId: number;
  /** Parsed from Windows WMI CreationDate; null means unavailable. */
  processCreatedAtMs: number | null;
}

export interface BackendProcessOwnerEvidence {
  backendProcessId: number;
  hostProcessId: number;
  backendCreatedAtMs: number | null;
  hostCreatedAtMs: number | null;
  backendGeneration: number;
  analyticsGenerationId?: string;
  analyticsHostInstanceId?: string;
}

export interface ProcessOwnerReadResult {
  processes: readonly ProcessBirthEvidence[];
  backendOwners: readonly BackendProcessOwnerEvidence[];
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
  readRuntimeLeases?: () => Promise<RuntimeLeaseReadResult>;
  readProcessOwners?: () => Promise<ProcessOwnerReadResult>;
}

export interface AnalyticsHostDiscoveryResult {
  workspaceId: string;
  observedAtMs: number;
  registryComplete: boolean;
  runtimeLeasesComplete: boolean;
  processOwnersComplete: boolean;
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

function parseSafeArgument(commandLine: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'u').exec(commandLine);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value || value.length > 512 || value.includes('\0')) return undefined;
  return value;
}

function parsePositiveArgument(commandLine: string, name: string): number | undefined {
  const value = parseSafeArgument(commandLine, name);
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return isPositivePid(parsed) ? parsed : undefined;
}

/** Convert WMI's DMTF CreationDate into an epoch timestamp. This is actual
 * OS process birth evidence; runtime lease `createdAt` is deliberately kept
 * separate because it records only when the lease file was written. */
export function parseWindowsProcessCreationDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u.exec(value);
  if (!match) return null;
  const base = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7].slice(0, 3)),
  );
  if (!Number.isFinite(base)) return null;
  const offsetMinutes = Number(match[9]);
  const adjusted = base - (match[8] === '+' ? offsetMinutes : -offsetMinutes) * 60_000;
  return Number.isSafeInteger(adjusted) && adjusted > 0 ? adjusted : null;
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

interface RawWindowsProcessRecord {
  ProcessId?: unknown;
  /** Projected by PowerShell because ConvertTo-Json serializes DateTime as /Date(ms)/. */
  ProcessCreatedAtMs?: unknown;
  /** Retained as a compatibility fallback for injected/older census adapters. */
  CreationDate?: unknown;
  CommandLine?: unknown;
}

function isBackendCommand(commandLine: string): boolean {
  return /(?:^|[\\/\s"'])backend\.js(?:$|[\\/\s"'])/iu.test(commandLine)
    && parseSafeArgument(commandLine, '--sdkPath') !== undefined;
}

/** Parse a bounded, already-collected process census. Command lines are used
 * only here to derive sanitized owner fields and are never returned. */
export function parseWindowsProcessOwnerRows(rows: readonly unknown[]): ProcessOwnerReadResult {
  const reasons: AnalyticsDiscoveryReason[] = [];
  const selectedRows = rows.slice(0, MAX_PROCESS_ROWS) as RawWindowsProcessRecord[];
  if (rows.length > MAX_PROCESS_ROWS) reasons.push(reason('process-census-truncated'));
  const processes: ProcessBirthEvidence[] = [];
  const byPid = new Map<number, ProcessBirthEvidence>();
  for (const row of selectedRows) {
    const processId = Number(row?.ProcessId);
    if (!isPositivePid(processId)) continue;
    const projectedBirth = row.ProcessCreatedAtMs;
    const processCreatedAtMs = typeof projectedBirth === 'number'
      && Number.isSafeInteger(projectedBirth) && projectedBirth > 0
      ? projectedBirth
      : parseWindowsProcessCreationDate(row.CreationDate);
    const evidence = { processId, processCreatedAtMs };
    processes.push(evidence);
    byPid.set(processId, evidence);
  }
  const backendOwners: BackendProcessOwnerEvidence[] = [];
  for (const row of selectedRows) {
    const processId = Number(row?.ProcessId);
    const commandLine = typeof row?.CommandLine === 'string' ? row.CommandLine : undefined;
    if (!isPositivePid(processId) || !commandLine || !isBackendCommand(commandLine)) continue;
    const hostProcessId = parsePositiveArgument(commandLine, '--hostPid');
    const backendGeneration = parsePositiveArgument(commandLine, '--backendGeneration');
    if (!hostProcessId || !backendGeneration) {
      reasons.push(reason('backend-owner-identity-invalid', { processId }));
      continue;
    }
    const backendBirth = byPid.get(processId)?.processCreatedAtMs ?? null;
    const hostBirth = byPid.get(hostProcessId)?.processCreatedAtMs ?? null;
    const analyticsGenerationId = parseSafeArgument(commandLine, '--analyticsGenerationId');
    const analyticsHostInstanceId = parseSafeArgument(commandLine, '--analyticsHostInstanceId');
    backendOwners.push({
      backendProcessId: processId,
      hostProcessId,
      backendCreatedAtMs: backendBirth,
      hostCreatedAtMs: hostBirth,
      backendGeneration,
      ...(analyticsGenerationId ? { analyticsGenerationId } : {}),
      ...(analyticsHostInstanceId ? { analyticsHostInstanceId } : {}),
    });
  }
  return { processes, backendOwners, complete: reasons.length === 0, reasons };
}

/** Read only sanitized process identity/birth evidence. Raw command lines are
 * consumed locally for matching and never appear in the returned result. */
export async function readWindowsProcessOwners(): Promise<ProcessOwnerReadResult> {
  if (process.platform !== 'win32') {
    return { processes: [], backendOwners: [], complete: false, reasons: [reason('process-census-unavailable')] };
  }
  let stdout: string;
  try {
    const query = [
      "$ErrorActionPreference='Stop'",
      "$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,@{Name='ProcessCreatedAtMs';Expression={if ($null -eq $_.CreationDate) {$null} else {([DateTimeOffset]$_.CreationDate).ToUniversalTime().ToUnixTimeMilliseconds()}}})",
      'ConvertTo-Json -InputObject $rows -Compress',
    ].join(';');
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', query,
    ], { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    stdout = result.stdout;
  } catch {
    return { processes: [], backendOwners: [], complete: false, reasons: [reason('process-census-unavailable')] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { processes: [], backendOwners: [], complete: false, reasons: [reason('process-census-unavailable')] };
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return parseWindowsProcessOwnerRows(rows);
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
 * census. This is a read-only proof helper. It never changes registry state,
 * stops a process, or opens a control endpoint; callers must keep the
 * all-host admission flag closed until this result is wired to a real
 * producer and its per-boot capability.
 */
export async function discoverAnalyticsHostWriters(
  options: AnalyticsHostDiscoveryOptions,
): Promise<AnalyticsHostDiscoveryResult> {
  const [registryResult, leaseResult, processResult] = await Promise.all([
    readHostRegistry(options.registry, options.workspaceId),
    options.readRuntimeLeases
      ? options.readRuntimeLeases()
      : readRuntimeLeaseEvidence(options.runtimeRootPath, options.runtimeIdentity),
    options.readProcessOwners ? options.readProcessOwners() : readWindowsProcessOwners(),
  ]);
  const reasons: AnalyticsDiscoveryReason[] = [
    ...registryResult.reasons,
    ...leaseResult.reasons,
    ...processResult.reasons,
  ];
  const hostsByPid = new Map<number, AnalyticsHostRecord>();
  for (const host of registryResult.hosts) hostsByPid.set(host.processId, host);
  const leasesByPid = new Map<number, RuntimeLeaseEvidence[]>();
  for (const lease of leaseResult.leases) {
    if (!sameRuntimeIdentity(lease.identity, options.runtimeIdentity)) {
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
  const processesByPid = new Map(processResult.processes.map((entry) => [entry.processId, entry]));
  const backendsByHostPid = new Map<number, BackendProcessOwnerEvidence[]>();
  for (const backend of processResult.backendOwners) {
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
  for (const host of registryResult.hosts) {
    const hostReasons: AnalyticsDiscoveryReason[] = [];
    const addHostReason = (entry: AnalyticsDiscoveryReason): void => {
      hostReasons.push({ ...entry, hostInstanceId: host.hostInstanceId });
      reasons.push({ ...entry, hostInstanceId: host.hostInstanceId });
    };
    if (host.state === 'stopping') addHostReason(reason('host-state-stopping'));
    if (host.state === 'unsupported') addHostReason(reason('host-state-unsupported'));
    if (host.state === 'stopped') addHostReason(reason('host-state-stopped'));

    const process = processesByPid.get(host.processId);
    if (!process) addHostReason(reason('host-process-missing', { processId: host.processId }));
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
    if (backends.length === 0) addHostReason(reason('host-backend-owner-missing', { processId: host.processId }));
    if (backends.length > 1) addHostReason(reason('host-backend-owner-ambiguous', { processId: host.processId }));
    const backend = backends.length === 1 ? backends[0] : undefined;
    if (backend) {
      if (backend.backendCreatedAtMs === null || backend.hostCreatedAtMs === null) {
        addHostReason(reason('backend-process-birth-unavailable', { processId: backend.backendProcessId }));
      } else if (backend.backendCreatedAtMs < backend.hostCreatedAtMs) {
        addHostReason(reason('backend-process-before-host', { processId: backend.backendProcessId }));
      }
      if (!backend.analyticsHostInstanceId || !backend.analyticsGenerationId) {
        addHostReason(reason('backend-analytics-descriptor-missing', { processId: backend.backendProcessId }));
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
      ...(backend ? { backendProcessId: backend.backendProcessId } : {}),
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
    hosts: records,
    unregisteredRuntimeLeases,
    unregisteredBackendOwners,
    reasons: allReasons,
    complete: registryResult.complete && leaseResult.complete && processResult.complete && allReasons.length === 0,
  };
}
