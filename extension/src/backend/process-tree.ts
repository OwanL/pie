import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessTreeTerminationOptions {
  signal?: NodeJS.Signals;
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ProcessTreeTerminationResult {
  rootPid: number;
  descendantPids: number[];
}

export interface WindowsProcessTreeGuardian {
  /** Close the kernel Job handle. KILL_ON_JOB_CLOSE synchronously targets every
   * process ever assigned to the worker job, including descendants whose
   * runtime parent has already crashed. */
  terminate(): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function capturePosixDescendants(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const children = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const descendants: number[] = [];
  const visit = (pid: number): void => {
    for (const childPid of children.get(pid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

const WINDOWS_JOB_GUARDIAN_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;

public static class PieWorkerJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
`;

function windowsGuardianScript(rootPid: number): string {
  const source = WINDOWS_JOB_GUARDIAN_SOURCE.replaceAll("'", "''");
  return [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -TypeDefinition '${source}'`,
    '$job = [PieWorkerJob]::CreateJobObject([IntPtr]::Zero, $null)',
    'if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    '$processHandle = [IntPtr]::Zero',
    '$infoPtr = [IntPtr]::Zero',
    'try {',
    '  $info = New-Object PieWorkerJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
    '  $basic = New-Object PieWorkerJob+JOBOBJECT_BASIC_LIMIT_INFORMATION',
    '  $basic.LimitFlags = 0x2000', // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    '  $info.BasicLimitInformation = $basic',
    '  $length = [Runtime.InteropServices.Marshal]::SizeOf($info)',
    '  $infoPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($length)',
    '  [Runtime.InteropServices.Marshal]::StructureToPtr($info, $infoPtr, $false)',
    '  if (-not [PieWorkerJob]::SetInformationJobObject($job, 9, $infoPtr, $length)) { throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    `  $processHandle = [PieWorkerJob]::OpenProcess(0x1101, $false, ${rootPid})`,
    '  if ($processHandle -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    '  if (-not [PieWorkerJob]::AssignProcessToJobObject($job, $processHandle)) { throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }',
    '  [Console]::Out.WriteLine("READY")',
    '  [Console]::Out.Flush()',
    '  [void][Console]::In.ReadLine()',
    '} finally {',
    '  if ($infoPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($infoPtr) }',
    '  if ($processHandle -ne [IntPtr]::Zero) { [void][PieWorkerJob]::CloseHandle($processHandle) }',
    '  if ($job -ne [IntPtr]::Zero) { [void][PieWorkerJob]::CloseHandle($job) }',
    '}',
  ].join('\n');
}

/**
 * Put a newly spawned, still-unbootstrapped Windows worker into a private
 * kernel Job with KILL_ON_JOB_CLOSE. The PowerShell guardian holds the Job
 * handle and blocks on coordinator-owned stdin. Coordinator crash, explicit
 * kill, or normal worker exit closes that handle and the kernel terminates the
 * complete assigned tree without PID snapshots or parent-link races.
 */
export async function establishWindowsProcessTreeGuardian(
  rootPid: number,
  startupTimeoutMs = 10_000,
): Promise<WindowsProcessTreeGuardian | undefined> {
  if (process.platform !== 'win32') return undefined;
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
    throw new Error(`Refusing to guard invalid process-tree root ${rootPid}.`);
  }
  const encoded = Buffer.from(windowsGuardianScript(rootPid), 'utf16le').toString('base64');
  const guardian = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  guardian.stderr.setEncoding('utf8');
  guardian.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16 * 1024);
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guardian.stdout.off('data', onData);
      guardian.off('error', onError);
      guardian.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      stdout += chunk.toString();
      if (stdout.split(/\r?\n/u).includes('READY')) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void => finish(new Error(`Windows worker Job guardian exited before readiness (${code ?? 'unknown'}): ${stderr}`));
    const timer = setTimeout(() => finish(new Error(`Windows worker Job guardian did not become ready within ${startupTimeoutMs} ms: ${stderr}`)), startupTimeoutMs);
    timer.unref?.();
    guardian.stdout.on('data', onData);
    guardian.once('error', onError);
    guardian.once('exit', onExit);
  }).catch(async (error) => {
    guardian.stdin.destroy();
    guardian.kill();
    throw error;
  });

  let termination: Promise<void> | undefined;
  return {
    terminate(): Promise<void> {
      if (termination) return termination;
      const attempt = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          guardian.off('error', onError);
          guardian.off('exit', onExit);
          if (error) reject(error); else resolve();
        };
        const onError = (error: Error): void => finish(error);
        const onExit = (): void => finish();
        const timer = setTimeout(() => {
          // A timed-out kill may still leave the guardian alive. Destroy its
          // coordinator-owned stdin and issue one final hard process kill before
          // reporting failure; callers retain tracking and may retry terminate.
          guardian.stdin.destroy();
          guardian.kill('SIGKILL');
          finish(new Error('Windows worker Job guardian did not close within 5000 ms.'));
        }, 5_000);
        timer.unref?.();
        guardian.once('error', onError);
        guardian.once('exit', onExit);
        // Terminating the sole Job-handle owner closes the handle immediately;
        // KILL_ON_JOB_CLOSE then targets the complete worker tree in-kernel.
        // stdin EOF remains the coordinator-crash path.
        if (!guardian.kill()) guardian.stdin.end();
      });
      termination = attempt;
      void attempt.catch(() => {
        if (termination === attempt) termination = undefined;
      });
      return attempt;
    },
  };
}

async function waitForExit(pids: readonly number[], timeoutMs: number, pollIntervalMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    alive = alive.filter(isAlive);
  }
  return alive;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Kill a worker tree. Windows production workers are additionally protected
 * by a kernel Job guardian; taskkill remains a fallback for pre-guardian spawn
 * failures. POSIX workers are process-group leaders, so group signalling is
 * identity-safe and remains effective after the leader crashes. */
export async function terminateProcessTree(
  rootPid: number,
  options: ProcessTreeTerminationOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) {
    throw new Error(`Refusing to terminate invalid process-tree root ${rootPid}.`);
  }
  const signal = options.signal ?? 'SIGKILL';
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
        windowsHide: true,
        timeout: confirmationTimeoutMs,
      });
    } catch (error) {
      if (isAlive(rootPid)) throw error;
    }
    const survivors = await waitForExit([rootPid], confirmationTimeoutMs, pollIntervalMs);
    if (survivors.length > 0) throw new Error(`Process-tree root did not exit: ${rootPid}.`);
    return { rootPid, descendantPids: [] };
  }

  let descendantPids: number[] = [];
  try {
    descendantPids = await capturePosixDescendants(rootPid);
  } catch {
    // Process-group termination remains authoritative.
  }
  try {
    process.kill(-rootPid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') killPid(rootPid, signal);
  }
  killPid(rootPid, signal);

  // Do not signal captured descendant PIDs separately: the kernel process group
  // is identity-safe, whereas a post-capture PID can be reused by an unrelated
  // process. Captured IDs are diagnostics only.
  const survivors = await waitForExit([rootPid], confirmationTimeoutMs, pollIntervalMs);
  if (survivors.length > 0 && signal !== 'SIGKILL') for (const pid of survivors) killPid(pid, 'SIGKILL');
  const finalSurvivors = await waitForExit(survivors, confirmationTimeoutMs, pollIntervalMs);
  if (finalSurvivors.length > 0) throw new Error(`Process-tree root did not exit: ${finalSurvivors.join(', ')}.`);
  return { rootPid, descendantPids };
}
