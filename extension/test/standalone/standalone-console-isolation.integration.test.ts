import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../../src/shared/protocol';

/**
 * Native Windows integration coverage for standalone console isolation.
 *
 * The start-pie launcher shares its console with the standalone Node host; the
 * host then spawns the backend with `standaloneConsoleIsolation`, which gives
 * the backend a private hidden Windows console (windowsHide / CREATE_NO_WINDOW)
 * instead of the launcher console. These tests run real processes in an OS temp
 * directory and prove, in-kernel:
 *
 *  1. a console-wide stop event (CTRL_C_EVENT + CTRL_BREAK_EVENT generated the
 *     way the console delivers them) reaches the host — which performs the
 *     graceful `backend.stop()` stdin-close drain — while the isolated backend
 *     and its worker survive the event and exit only through the drain;
 *  2. the launcher's kill-on-close Job Object still contains the isolated
 *     backend tree: force-terminating the Job removes backend and worker.
 *
 * The fixtures exercise the real BackendClient spawn path: `client.ts` is
 * bundled with esbuild into the fixture directory (mirroring the production
 * `extension/out` bundles, which the launcher runs as a single plain node
 * process) and the host fixture is exactly one plain node process.
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionRoot = repositoryRoot;
const clientSourcePath = path.join(extensionRoot, 'src', 'host', 'backend', 'client.ts');

const integrationTest = process.platform === 'win32' && process.env.PIE_RUN_INTEGRATION_TESTS === '1'
  ? test
  : test.skip;

const HOST_FIXTURE = `
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const fixtureDir = process.env.PIE_FIXTURE_DIR;
// The bundled client mirrors the production extension/out bundles: a single
// plain node process, so the host's own console stop handlers apply to the
// process the driver actually created.
const require = createRequire(import.meta.url);
const { BackendClient } = require(process.env.PIE_CLIENT_BUNDLE);

// Keep every diagnostic log inside the OS temp fixture directory. The protocol
// version comes from the test (which imports the real shared protocol source).
process.env.PIE_DATA_DIR = fixtureDir;

const client = new BackendClient({
  orphanReaper: async () => ({ candidates: [], reaped: [], failures: [] }),
  standaloneConsoleIsolation: true,
});

await client.start({
  nodePath: process.execPath,
  backendPath: path.join(fixtureDir, 'pie-fixture-backend.mjs'),
  sdkPath: fixtureDir,
  cwd: fixtureDir,
});
fs.writeFileSync(path.join(fixtureDir, 'host.ready'), String(process.pid));

let stopping = false;
const stop = async (signal) => {
  if (stopping) return;
  stopping = true;
  try {
    await client.stop();
  } catch (error) {
    fs.appendFileSync(path.join(fixtureDir, 'host.stop-error'), String(error && error.message ? error.message : error));
  }
  fs.writeFileSync(path.join(fixtureDir, 'host.stopped'), signal);
  process.exit(130);
};
process.on('SIGBREAK', () => { void stop('SIGBREAK'); });
process.on('SIGINT', () => { void stop('SIGINT'); });
setInterval(() => undefined, 1000);
`;

const BACKEND_FIXTURE = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const fixtureDir = process.env.PIE_FIXTURE_DIR;
const protocolVersion = Number(process.env.PIE_FIXTURE_PROTOCOL_VERSION);
if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) {
  process.stderr.write('fixture backend did not receive the host protocol version');
  process.exit(2);
}

const argv = process.argv.slice(2);
if (!argv.includes('--lifetimeFd')) {
  process.stderr.write('fixture backend did not receive --lifetimeFd');
  process.exit(2);
}

// Mirrors the production backend contract: backend.ready on stdout, no signal
// handlers. A console stop event that reaches this process would terminate it
// before the graceful drain and be visible as a missing graceful-exit marker.
process.stdout.write(JSON.stringify({
  event: 'backend.ready',
  payload: {
    sdkPath: fixtureDir,
    agentDir: fixtureDir,
    sdkVersion: '0.0.0-fixture',
    protocolVersion,
  },
}) + '\\n');

fs.writeFileSync(path.join(fixtureDir, 'backend.pid'), String(process.pid));

// Mimic the production worker spawn shape (piped stdio + windowsHide).
const worker = spawn(process.execPath, [path.join(fixtureDir, 'pie-fixture-worker.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
worker.stdout.resume();
worker.stderr.resume();
fs.writeFileSync(path.join(fixtureDir, 'worker.pid'), String(worker.pid));

// stdin EOF is the host's graceful stop signal. The stream must be flowing
// (like the production backend's JSON-RPC read loop) for 'end' to fire: drain
// briefly (simulating in-flight accepted work), then clean up the worker and
// exit gracefully.
process.stdin.resume();
process.stdin.on('end', () => {
  setTimeout(() => {
    try { worker.kill('SIGTERM'); } catch { }
    fs.writeFileSync(path.join(fixtureDir, 'backend.exit.0'), String(process.pid));
    process.exit(0);
  }, 400);
});
process.stdin.on('error', () => { });
setInterval(() => undefined, 1000);
`;

const WORKER_FIXTURE = `
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 1000);
`;

const DRIVER_SOURCE = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$FixtureDir,
  [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'

# Trimmed copy of the supervisor's native containment helper plus the console
# control APIs needed to own a private console and deliver stop events.
$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PieConsoleDriverNative
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
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
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private sealed class STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int infoClass,
        IntPtr jobObjectInformation,
        uint jobObjectInformationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        [In, Out] StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    public delegate bool ConsoleCtrlHandlerDelegate(uint ctrlType);

    private static readonly ConsoleCtrlHandlerDelegate cancelHandler = ctrlType => true;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandlerDelegate handler, bool add);

    public static void InstallCancelHandler()
    {
        if (!SetConsoleCtrlHandler(cancelHandler, true))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetConsoleCtrlHandler failed");
        }
    }

    public static void UninstallCancelHandler()
    {
        SetConsoleCtrlHandler(cancelHandler, false);
    }

    private static Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value == null) throw new ArgumentNullException("value");
        var result = new StringBuilder();
        var backslashes = 0;
        result.Append('"');
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            result.Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    public static IntPtr CreateKillOnCloseJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject failed");
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
            {
                throw LastError("SetInformationJobObject failed");
            }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static PROCESS_INFORMATION CreateSuspended(string applicationName, string[] arguments, string currentDirectory)
    {
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var commandLine = new StringBuilder(QuoteWindowsArgument(applicationName));
        foreach (var argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteWindowsArgument(argument));
        }
        PROCESS_INFORMATION processInformation;
        if (!CreateProcess(
            applicationName,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            CREATE_SUSPENDED,
            IntPtr.Zero,
            currentDirectory,
            startup,
            out processInformation))
        {
            throw LastError("CreateProcess failed");
        }
        return processInformation;
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process)) throw LastError("AssignProcessToJobObject failed");
    }

    public static void Resume(IntPtr thread)
    {
        var result = ResumeThread(thread);
        if (result == UInt32.MaxValue) throw LastError("ResumeThread failed");
    }

    public static uint Wait(IntPtr process, uint milliseconds)
    {
        return WaitForSingleObject(process, milliseconds);
    }

    public static uint ExitCode(IntPtr process)
    {
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode)) throw LastError("GetExitCodeProcess failed");
        return exitCode;
    }

    public static void ForceJob(IntPtr job, uint exitCode)
    {
        if (!TerminateJobObject(job, exitCode)) throw LastError("TerminateJobObject failed");
    }

    public static void Close(IntPtr handle)
    {
        if (handle != IntPtr.Zero && !CloseHandle(handle)) throw LastError("CloseHandle failed");
    }
}
'@
Add-Type -TypeDefinition $nativeSource

function Test-ProcessAlive {
  param([int]$ProcessId)
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

if (-not [PieConsoleDriverNative]::FreeConsole()) { throw "FreeConsole failed" }
if (-not [PieConsoleDriverNative]::AllocConsole()) { throw "AllocConsole failed" }

# The driver must survive the stop events it delivers: a static .NET handler
# that returns true cancels the event for this process (same containment
# pattern as the production supervisor). A PowerShell scriptblock delegate
# cannot be marshaled onto the console control thread, so the handler must be
# a compiled static method.
[PieConsoleDriverNative]::InstallCancelHandler()

$job = [IntPtr]::Zero
$childInfo = $null
$threadClosed = $false
$results = [ordered]@{ scenario = $Scenario }
try {
  # Mirrors the supervisor handoff: suspended create, assign to the
  # kill-on-close Job, then resume. The host (tsx) spawns the backend with
  # standaloneConsoleIsolation from inside this Job.
  $job = [PieConsoleDriverNative]::CreateKillOnCloseJob()
  $hostPath = Join-Path $FixtureDir 'pie-fixture-host.mjs'
  $childInfo = [PieConsoleDriverNative]::CreateSuspended(
    $NodePath,
    @($hostPath),
    $FixtureDir)
  [PieConsoleDriverNative]::Assign($job, $childInfo.hProcess)
  [PieConsoleDriverNative]::Resume($childInfo.hThread)
  [PieConsoleDriverNative]::Close($childInfo.hThread)
  $threadClosed = $true

  $backendPid = 0
  $workerPid = 0
  $markerDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $markerDeadline) {
    $backendWritten = Test-Path (Join-Path $FixtureDir 'backend.pid')
    $workerWritten = Test-Path (Join-Path $FixtureDir 'worker.pid')
    $hostReady = Test-Path (Join-Path $FixtureDir 'host.ready')
    if ($backendWritten -and $workerWritten -and $hostReady) {
      $backendPid = [int](Get-Content (Join-Path $FixtureDir 'backend.pid'))
      $workerPid = [int](Get-Content (Join-Path $FixtureDir 'worker.pid'))
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if ($backendPid -le 0 -or $workerPid -le 0) { throw 'the fixture backend tree did not publish its pids' }
  $results.backendPid = $backendPid
  $results.workerPid = $workerPid

  if ($Scenario -eq 'consoleStop') {
    Start-Sleep -Seconds 1
    # Console-wide stop events, delivered exactly as the console would.
    [void][PieConsoleDriverNative]::GenerateConsoleCtrlEvent(0, 0)   # CTRL_C_EVENT
    [void][PieConsoleDriverNative]::GenerateConsoleCtrlEvent(1, 0)   # CTRL_BREAK_EVENT
    # Probe immediately: an isolated backend must still be alive here (only a
    # short beat is left for event delivery), before its graceful drain from
    # the host's stdin close completes a moment later.
    Start-Sleep -Milliseconds 300
    $results.backendAliveAfterCtrl = Test-ProcessAlive $backendPid
    $results.workerAliveAfterCtrl = Test-ProcessAlive $workerPid

    # The host must react to the console stop signal with the graceful
    # stdin-close backend.stop() drain and exit with the SIGINT exit code.
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $stopDeadline) {
      $wait = [PieConsoleDriverNative]::Wait($childInfo.hProcess, 250)
      if ($wait -eq 0) { break }
      if ($wait -ne 0x00000102) { throw "WaitForSingleObject failed with status $wait" }
    }
    $results.hostStopped = Test-Path (Join-Path $FixtureDir 'host.stopped')
    $results.hostExitCode = [PieConsoleDriverNative]::ExitCode($childInfo.hProcess)
    Start-Sleep -Milliseconds 500
    $results.backendGracefulExit = Test-Path (Join-Path $FixtureDir 'backend.exit.0')
    $results.workerDeadAfterShutdown = -not (Test-ProcessAlive $workerPid)
    $results.backendDeadAfterShutdown = -not (Test-ProcessAlive $backendPid)
  } elseif ($Scenario -eq 'jobForce') {
    Start-Sleep -Seconds 1
    $results.backendAliveBeforeForce = Test-ProcessAlive $backendPid
    $results.workerAliveBeforeForce = Test-ProcessAlive $workerPid
    [PieConsoleDriverNative]::ForceJob($job, 130)
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (-not (Test-ProcessAlive $backendPid) -and -not (Test-ProcessAlive $workerPid)) { break }
      Start-Sleep -Milliseconds 100
    }
    $results.backendDeadAfterForce = -not (Test-ProcessAlive $backendPid)
    $results.workerDeadAfterForce = -not (Test-ProcessAlive $workerPid)
    $hostWait = [PieConsoleDriverNative]::Wait($childInfo.hProcess, 5000)
    $results.hostDeadAfterForce = ($hostWait -eq 0)
  } else {
    throw "unknown scenario $Scenario"
  }
} catch {
  $results.error = $_.Exception.Message
} finally {
  # Closing the sole Job handle removes anything still assigned (kill-on-close).
  if ($job -ne [IntPtr]::Zero) {
    try { [PieConsoleDriverNative]::Close($job) } catch { }
  }
  if ($null -ne $childInfo) {
    if (-not $threadClosed -and $childInfo.hThread -ne [IntPtr]::Zero) {
      try { [PieConsoleDriverNative]::Close($childInfo.hThread) } catch { }
    }
    if ($childInfo.hProcess -ne [IntPtr]::Zero) {
      try { [PieConsoleDriverNative]::Close($childInfo.hProcess) } catch { }
    }
  }
  try { [PieConsoleDriverNative]::UninstallCancelHandler() } catch { }
}

[System.IO.File]::WriteAllText($ResultPath, ($results | ConvertTo-Json -Depth 3))
exit 0
`;

async function runDriver(
  scenario: 'consoleStop' | 'jobForce',
  fixtureDir: string,
): Promise<Record<string, unknown>> {
  // Bundle the real BackendClient source for plain node (mirroring the
  // production extension/out bundles; CJS keeps `__dirname` working).
  const esbuild = await import('esbuild');
  const clientBundlePath = path.join(fixtureDir, 'pie-client-bundle.cjs');
  await esbuild.build({
    entryPoints: [clientSourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    outfile: clientBundlePath,
    logLevel: 'silent',
  });
  const driverPath = path.join(fixtureDir, 'pie-console-driver.ps1');
  const resultPath = path.join(fixtureDir, `driver-result-${scenario}.json`);
  await writeFile(driverPath, DRIVER_SOURCE, 'utf8');
  const driver = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', driverPath,
    '-Scenario', scenario,
    '-NodePath', process.execPath,
    '-FixtureDir', fixtureDir,
    '-ResultPath', resultPath,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PIE_FIXTURE_DIR: fixtureDir,
      PIE_CLIENT_BUNDLE: clientBundlePath,
      PIE_FIXTURE_PROTOCOL_VERSION: String(PROTOCOL_VERSION),
    },
  });
  let stdoutText = '';
  let exitCode: number | null = null;
  driver.stdout.setEncoding('utf8');
  driver.stdout.on('data', (chunk) => { stdoutText += chunk; });
  driver.once('exit', (code) => { exitCode = code; });
  let stderr = '';
  driver.stderr.setEncoding('utf8');
  driver.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<void>((resolve) => driver.once('close', () => resolve()));
  const timeout = setTimeout(() => {
    driver.kill();
  }, 120_000);
  try {
    await closed;
    if (!(await readFile(resultPath, 'utf8').then(() => true).catch(() => false))) {
      throw new Error(`driver exited without a result (exit=${exitCode}); stderr: ${stderr}; stdout: ${stdoutText.slice(-2000)}`);
    }
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
    if (typeof result.error === 'string') {
      throw new Error(`driver failed: ${result.error}; stderr: ${stderr}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

integrationTest('console stop signal reaches the host, not the isolated backend tree', { timeout: 180_000 }, async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'pie-console-iso-'));
  try {
    await writeFile(path.join(fixtureDir, 'pie-fixture-host.mjs'), HOST_FIXTURE, 'utf8');
    await writeFile(path.join(fixtureDir, 'pie-fixture-backend.mjs'), BACKEND_FIXTURE, 'utf8');
    await writeFile(path.join(fixtureDir, 'pie-fixture-worker.mjs'), WORKER_FIXTURE, 'utf8');
    const result = await runDriver('consoleStop', fixtureDir);
    assert.equal(result.scenario, 'consoleStop');
    assert.equal(result.backendAliveAfterCtrl, true, `backend must survive the console stop event: ${JSON.stringify(result)}`);
    assert.equal(result.workerAliveAfterCtrl, true, `the backend worker must survive the console stop event: ${JSON.stringify(result)}`);
    assert.equal(result.hostStopped, true, `the host must react to the console stop signal: ${JSON.stringify(result)}`);
    assert.equal(result.hostExitCode, 130, `the host must exit with the SIGINT code: ${JSON.stringify(result)}`);
    assert.equal(result.backendGracefulExit, true, `the backend must exit through the graceful stdin drain, not the console event: ${JSON.stringify(result)}`);
    assert.equal(result.backendDeadAfterShutdown, true, JSON.stringify(result));
    assert.equal(result.workerDeadAfterShutdown, true, `the worker must be cleaned up by the backend drain: ${JSON.stringify(result)}`);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

integrationTest('the kill-on-close Job still contains the windowsHide-isolated backend tree', { timeout: 180_000 }, async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'pie-console-iso-job-'));
  try {
    await writeFile(path.join(fixtureDir, 'pie-fixture-host.mjs'), HOST_FIXTURE, 'utf8');
    await writeFile(path.join(fixtureDir, 'pie-fixture-backend.mjs'), BACKEND_FIXTURE, 'utf8');
    await writeFile(path.join(fixtureDir, 'pie-fixture-worker.mjs'), WORKER_FIXTURE, 'utf8');
    const result = await runDriver('jobForce', fixtureDir);
    assert.equal(result.scenario, 'jobForce');
    assert.equal(result.backendAliveBeforeForce, true, JSON.stringify(result));
    assert.equal(result.workerAliveBeforeForce, true, JSON.stringify(result));
    assert.equal(result.backendDeadAfterForce, true, `backend must remain inside the owned Job: ${JSON.stringify(result)}`);
    assert.equal(result.workerDeadAfterForce, true, `worker must remain inside the owned Job: ${JSON.stringify(result)}`);
    assert.equal(result.hostDeadAfterForce, true, JSON.stringify(result));
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});