import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  AnalyticsDiscoveryReason,
  AnalyticsDiscoveryReasonCode,
} from './analytics-handoff-discovery.js';

const execFileAsync = promisify(execFile);

/** Keep both the collected rows and the serialized process output bounded. */
export const ANALYTICS_PROCESS_CENSUS_MAX_ROWS = 8_192;
export const ANALYTICS_PROCESS_CENSUS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const ANALYTICS_PROCESS_CENSUS_TIMEOUT_MS = 10_000;

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

interface RawWindowsProcessRecord {
  ProcessId?: unknown;
  /** Projected by PowerShell because ConvertTo-Json serializes DateTime as /Date(ms)/. */
  ProcessCreatedAtMs?: unknown;
  /** Retained as a compatibility fallback for injected/older census adapters. */
  CreationDate?: unknown;
  CommandLine?: unknown;
}

interface RawWindowsProcessEnvelope {
  rows?: unknown;
  truncated?: unknown;
}

function reason(
  code: AnalyticsDiscoveryReasonCode,
  details: Partial<AnalyticsDiscoveryReason> = {},
): AnalyticsDiscoveryReason {
  return { code, ...details };
}

function isPositivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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
 * OS process birth evidence; a lease timestamp is not a substitute. */
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

function isBackendCommand(commandLine: string): boolean {
  return /(?:^|[\\/\s"'])backend\.js(?:$|[\\/\s"'])/iu.test(commandLine)
    && parseSafeArgument(commandLine, '--sdkPath') !== undefined;
}

/** Parse a bounded, already-collected process census. Command lines are used
 * only to derive sanitized owner fields and are never returned. */
export function parseWindowsProcessOwnerRows(
  rows: readonly unknown[],
  options: { truncated?: boolean } = {},
): ProcessOwnerReadResult {
  const reasons: AnalyticsDiscoveryReason[] = [];
  const selectedRows = rows.slice(0, ANALYTICS_PROCESS_CENSUS_MAX_ROWS) as RawWindowsProcessRecord[];
  if (options.truncated === true || rows.length > ANALYTICS_PROCESS_CENSUS_MAX_ROWS) {
    reasons.push(reason('process-census-truncated'));
  }
  const processes: ProcessBirthEvidence[] = [];
  for (const candidate of selectedRows) {
    const row = candidate && typeof candidate === 'object' ? candidate : {};
    const processId = Number(row.ProcessId);
    if (!isPositivePid(processId)) continue;
    const projectedBirth = row.ProcessCreatedAtMs;
    const processCreatedAtMs = typeof projectedBirth === 'number'
      && Number.isSafeInteger(projectedBirth) && projectedBirth > 0
      ? projectedBirth
      : parseWindowsProcessCreationDate(row.CreationDate);
    processes.push({ processId, processCreatedAtMs });
  }
  const ambiguousProcessPids = duplicateProcessIds(processes, (entry) => entry.processId);
  for (const processId of ambiguousProcessPids) {
    reasons.push(reason('process-pid-ambiguous', { processId }));
  }
  // Do not let a duplicate PID select whichever census row happened to be
  // visited last. Ambiguous rows remain evidence, but cannot corroborate an
  // owner.
  const byPid = new Map(
    processes
      .filter((entry) => !ambiguousProcessPids.has(entry.processId))
      .map((entry) => [entry.processId, entry] as const),
  );
  const backendOwners: BackendProcessOwnerEvidence[] = [];
  for (const candidate of selectedRows) {
    const row = candidate && typeof candidate === 'object' ? candidate : {};
    const processId = Number(row.ProcessId);
    const commandLine = typeof row.CommandLine === 'string' ? row.CommandLine : undefined;
    if (!isPositivePid(processId) || !commandLine || !isBackendCommand(commandLine)) continue;
    if (ambiguousProcessPids.has(processId)) continue;
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

/** Parse the bounded PowerShell envelope. Arrays remain accepted for injected
 * adapters and older callers, but the production reader uses the envelope so
 * it can report a row beyond the collection cap without collecting it. */
export function parseWindowsProcessCensus(value: unknown): ProcessOwnerReadResult {
  if (Array.isArray(value)) return parseWindowsProcessOwnerRows(value);
  if (!value || typeof value !== 'object') {
    return {
      processes: [],
      backendOwners: [],
      complete: false,
      reasons: [reason('process-census-unavailable')],
    };
  }
  const envelope = value as RawWindowsProcessEnvelope;
  if (!Array.isArray(envelope.rows) || typeof envelope.truncated !== 'boolean') {
    return {
      processes: [],
      backendOwners: [],
      complete: false,
      reasons: [reason('process-census-unavailable')],
    };
  }
  return parseWindowsProcessOwnerRows(envelope.rows, { truncated: envelope.truncated });
}

function unavailableProcessCensus(): ProcessOwnerReadResult {
  return {
    processes: [],
    backendOwners: [],
    complete: false,
    reasons: [reason('process-census-unavailable')],
  };
}

/** Read a bounded, read-only process census from the current operating system.
 * Windows is the production implementation because the runtime's process
 * ownership proof depends on WMI creation timestamps. Other platforms return
 * an explicit unavailable result rather than silently weakening identity. */
export async function readProcessCensus(): Promise<ProcessOwnerReadResult> {
  if (process.platform !== 'win32') return unavailableProcessCensus();
  let stdout: string;
  try {
    const maxRows = ANALYTICS_PROCESS_CENSUS_MAX_ROWS;
    const query = [
      "$ErrorActionPreference='Stop'",
      `$rows=[System.Collections.Generic.List[object]]::new();$truncated=$false;Get-CimInstance Win32_Process | ForEach-Object { if ($rows.Count -lt ${maxRows}) { $created=if ($null -eq $_.CreationDate) {$null} else {([DateTimeOffset]$_.CreationDate).ToUniversalTime().ToUnixTimeMilliseconds()}; [void]$rows.Add([pscustomobject]@{ProcessId=$_.ProcessId;CommandLine=$_.CommandLine;ProcessCreatedAtMs=$created}) } else { $truncated=$true } }`,
      '[pscustomobject]@{rows=$rows;truncated=$truncated} | ConvertTo-Json -Compress -Depth 4',
    ].join(';');
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', query,
    ], {
      windowsHide: true,
      timeout: ANALYTICS_PROCESS_CENSUS_TIMEOUT_MS,
      maxBuffer: ANALYTICS_PROCESS_CENSUS_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch {
    return unavailableProcessCensus();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return unavailableProcessCensus();
  }
  return parseWindowsProcessCensus(parsed);
}

/** Compatibility name retained for the existing discovery seam. */
export const readBoundedProcessCensus = readProcessCensus;
export const readWindowsProcessOwners = readProcessCensus;
