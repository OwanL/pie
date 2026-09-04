import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '../../shared/type-guards';

export interface WindowsProcessRecord {
  ProcessId: number;
  CommandLine?: string | null;
  CreationDate?: string | null;
}

export interface OrphanReapResult {
  candidates: number[];
  reaped: number[];
  failures: Array<{ pid: number; error: string }>;
}

const execFileAsync = promisify(execFile);

/** Parse the exact JSON shape emitted by the PowerShell process query.
 * ConvertTo-Json emits either an object or an array depending on cardinality,
 * so both forms are accepted deliberately. Invalid rows are ignored. */
export function parseWindowsProcessRecords(stdout: string): WindowsProcessRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const records: WindowsProcessRecord[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const processId = Number(row.ProcessId);
    if (!Number.isSafeInteger(processId) || processId <= 0) continue;
    records.push({
      ProcessId: processId,
      CommandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      CreationDate: typeof row.CreationDate === 'string' ? row.CreationDate : null,
    });
  }
  return records;
}

export function backendHostPid(commandLine: string): number | undefined {
  const match = /--hostPid(?:"|')?\s+(?:"(\d+)"|'(\d+)'|(\d+))/u.exec(commandLine);
  const pid = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function isPieBackendCoordinator(commandLine: string): boolean {
  return /(?:^|[\\/])backend\.js(?:"|'|\s)/iu.test(commandLine)
    && /--sdkPath(?:"|')?(?:\s|=)/u.test(commandLine)
    && /--backendGeneration(?:"|')?(?:\s|=)/u.test(commandLine)
    && backendHostPid(commandLine) !== undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Reap coordinators whose owning extension-host PID no longer exists.
 * This is a recovery net for old builds and abnormal termination; the
 * inherited lifetime pipe is the primary ownership mechanism. */
export async function reapOrphanedBackends(): Promise<OrphanReapResult> {
  const empty: OrphanReapResult = { candidates: [], reaped: [], failures: [] };
  if (process.platform !== 'win32') return empty;

  let stdout: string;
  try {
    const query = [
      "$ErrorActionPreference='Stop'",
      "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine,CreationDate)",
      'ConvertTo-Json -InputObject $rows -Compress',
    ].join(';');
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', query,
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (error) {
    return {
      ...empty,
      failures: [{ pid: 0, error: error instanceof Error ? error.message : String(error) }],
    };
  }

  const result: OrphanReapResult = { candidates: [], reaped: [], failures: [] };
  for (const record of parseWindowsProcessRecords(stdout)) {
    if (record.ProcessId === process.pid || !record.CommandLine) continue;
    if (!isPieBackendCoordinator(record.CommandLine)) continue;
    const hostPid = backendHostPid(record.CommandLine);
    if (hostPid === undefined || isProcessAlive(hostPid)) continue;
    result.candidates.push(record.ProcessId);
  }

  for (const pid of result.candidates) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000,
        encoding: 'utf8',
      });
      result.reaped.push(pid);
    } catch (error) {
      result.failures.push({ pid, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
