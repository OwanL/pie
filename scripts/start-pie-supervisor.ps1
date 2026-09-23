[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Workspace,

  # Explicitly enable trusted-LAN access without the interactive prompt.
  [switch]$AllowLan,

  # The standalone Node entry performs its own bounded shutdown (currently 12s).
  # Keep this deadline a little longer so a normal Ctrl+C gets to finish before
  # the supervisor applies the final owned-job force termination.
  [ValidateRange(1000, 300000)]
  [int]$ShutdownTimeoutMilliseconds = 15000
)

$ErrorActionPreference = 'Stop'

# This script deliberately uses Windows PowerShell/.NET only.  In particular,
# do not replace the native launch below with Start-Process: Start-Process has no
# suspended-create handoff, leaving a race in which Node can spawn an unowned
# descendant before a Job Object is assigned.
$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PieStandaloneNative
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
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

    private static string BuildCommandLine(string applicationName, string[] arguments)
    {
        var result = new StringBuilder(QuoteWindowsArgument(applicationName));
        foreach (var argument in arguments)
        {
            result.Append(' ');
            result.Append(QuoteWindowsArgument(argument));
        }
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

    private static PROCESS_INFORMATION CreateSuspendedInternal(
        string applicationName,
        string[] arguments,
        string currentDirectory,
        uint creationFlags,
        bool inheritHandles)
    {
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var commandLine = new StringBuilder(BuildCommandLine(applicationName, arguments));
        PROCESS_INFORMATION processInformation;
        if (!CreateProcess(
            applicationName,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            inheritHandles,
            creationFlags,
            IntPtr.Zero,
            currentDirectory,
            startup,
            out processInformation))
        {
            throw LastError("CreateProcess failed");
        }
        return processInformation;
    }

    public static PROCESS_INFORMATION CreateSuspended(string applicationName, string[] arguments, string currentDirectory)
    {
        return CreateSuspendedInternal(applicationName, arguments, currentDirectory, CREATE_SUSPENDED, true);
    }

    public static PROCESS_INFORMATION CreateSuspendedProbe(string applicationName, string currentDirectory)
    {
        return CreateSuspendedInternal(applicationName, new[] { "--version" }, currentDirectory, CREATE_SUSPENDED | CREATE_NO_WINDOW, false);
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

function Ensure-NativeType {
  if ($null -eq ([System.Management.Automation.PSTypeName]'PieStandaloneNative').Type) {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
  }
}

function Resolve-WorkspacePath {
  param([Parameter(Mandatory = $true)][string]$Value)

  $candidate = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    throw 'A workspace path is required.'
  }
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    throw "Workspace path must be absolute: $candidate"
  }
  try {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
  } catch {
    throw "Workspace path is not valid: $candidate ($($_.Exception.Message))"
  }
  if (-not [System.IO.Directory]::Exists($resolved)) {
    throw "Workspace path does not exist or is not a directory: $resolved"
  }
  return $resolved
}

function Read-WorkspacePath {
  Write-Host ''
  Write-Host 'Pie standalone starts a localhost server for one workspace.'
  Write-Host 'Enter an absolute workspace path (Ctrl+C cancels startup).'
  while ($true) {
    try {
      $entered = Read-Host 'Workspace path'
      return Resolve-WorkspacePath -Value $entered
    } catch {
      Write-Warning $_.Exception.Message
    }
  }
}

function Read-LanOptIn {
  Write-Host ''
  Write-Host 'LAN access has no authentication or TLS. Anyone who can reach Pie can execute commands and read or modify files.' -ForegroundColor Yellow
  Write-Host 'Only enable this on a trusted local network. Public/internet access is unsupported.'
  $answer = Read-Host 'Enable trusted LAN access? [y/N]'
  return $answer -match '^(?i:y|yes)$'
}

function Require-BuildOutput {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
  )

  $outputRoot = Join-Path $RepositoryRoot 'extension\out'
  $requiredFiles = @(
    @{ Relative = 'standalone.js'; Label = 'standalone Node entry' },
    @{ Relative = 'backend.js'; Label = 'backend bundle' },
    @{ Relative = 'worker-entry.js'; Label = 'worker bundle' },
    @{ Relative = 'analytics-recorder-worker.js'; Label = 'analytics recorder worker' },
    @{ Relative = 'analytics-query-worker.js'; Label = 'analytics query worker' },
    @{ Relative = 'webview\panel\.vite\manifest.json'; Label = 'webview build manifest' }
  )
  foreach ($required in $requiredFiles) {
    $filePath = Join-Path $outputRoot $required.Relative
    if (-not [System.IO.File]::Exists($filePath)) {
      throw "Pie standalone build is missing the $($required.Label): $filePath. Run 'npm run extension:build' from $RepositoryRoot; the launcher does not install or rebuild dependencies."
    }
  }
  return $outputRoot
}

function Resolve-NodeExecutable {
  $configured = $env:PI_NODE_PATH
  if ([string]::IsNullOrWhiteSpace($configured)) {
    $command = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -eq $command) {
      throw 'Could not find a real node.exe on PATH. Install Node.js or set PI_NODE_PATH to the absolute path of node.exe.'
    }
    $configured = $command.Source
  }

  $nodePath = $configured.Trim()
  if ($nodePath.Length -ge 2 -and $nodePath[0] -eq '"' -and $nodePath[$nodePath.Length - 1] -eq '"') {
    $nodePath = $nodePath.Substring(1, $nodePath.Length - 2)
  }
  try {
    $nodePath = [System.IO.Path]::GetFullPath($nodePath)
  } catch {
    throw "PI_NODE_PATH is not a valid path: $configured"
  }
  if ([System.IO.Path]::GetExtension($nodePath) -ine '.exe' -or
      -not [System.IO.File]::Exists($nodePath)) {
    throw "PI_NODE_PATH must name an existing real node.exe (not a .cmd/.bat shim): $nodePath"
  }

  # A direct PE-header check rejects command shims without starting any Node
  # process outside the owned Job.  The --version execution happens below,
  # after the suspended probe has also been assigned to that Job.
  $header = New-Object byte[] 2
  $stream = $null
  try {
    $stream = [System.IO.File]::OpenRead($nodePath)
    if ($stream.Read($header, 0, 2) -ne 2 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
      throw "file is not a Windows PE executable"
    }
  } catch {
    throw "PI_NODE_PATH is not a usable real node.exe: $nodePath ($($_.Exception.Message))"
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  return $nodePath
}

function Validate-NodeInJob {
  param(
    [Parameter(Mandatory = $true)][IntPtr]$JobHandle,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$CurrentDirectory
  )

  $probeInfo = $null
  $threadClosed = $false
  try {
    $probeInfo = [PieStandaloneNative]::CreateSuspendedProbe($NodePath, $CurrentDirectory)
    [PieStandaloneNative]::Assign($JobHandle, $probeInfo.hProcess)
    [PieStandaloneNative]::Resume($probeInfo.hThread)
    [PieStandaloneNative]::Close($probeInfo.hThread)
    $threadClosed = $true
    $waitResult = [PieStandaloneNative]::Wait($probeInfo.hProcess, [uint32]10000)
    if ($waitResult -ne [uint32]0) {
      throw 'node.exe did not answer --version within 10 seconds.'
    }
    if ([PieStandaloneNative]::ExitCode($probeInfo.hProcess) -ne [uint32]0) {
      throw 'node.exe --version returned a non-zero exit code.'
    }
  } catch {
    throw "Could not validate the real Node.js executable '$NodePath': $($_.Exception.Message)"
  } finally {
    if ($null -ne $probeInfo) {
      if (-not $threadClosed -and $probeInfo.hThread -ne [IntPtr]::Zero) {
        try { [PieStandaloneNative]::Close($probeInfo.hThread) } catch { }
      }
      if ($probeInfo.hProcess -ne [IntPtr]::Zero) {
        try { [PieStandaloneNative]::Close($probeInfo.hProcess) } catch { }
      }
    }
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workspacePath = $null
$jobHandle = [IntPtr]::Zero
$childInfo = $null
$threadClosed = $false
$exitCode = 1
$forced = $false
$cancelHandlerInstalled = $false
$controlState = [hashtable]::Synchronized(@{ CtrlCAt = $null })
$cancelScript = {
  param($sender, $eventArgs)
  if ($null -eq $controlState['CtrlCAt']) {
    $controlState['CtrlCAt'] = [DateTime]::UtcNow
  }
  # Do not let the supervisor consume Ctrl+C.  The Node child shares this
  # console and receives the same event, where standalone.js performs its
  # graceful shutdown.  The supervisor only forces the owned Job after the
  # bounded deadline below.
  $eventArgs.Cancel = $true
}.GetNewClosure()
$cancelHandler = [ConsoleCancelEventHandler]$cancelScript

try {
  Ensure-NativeType
  $workspacePath = if ([string]::IsNullOrWhiteSpace($Workspace)) {
    Read-WorkspacePath
  } else {
    Resolve-WorkspacePath -Value $Workspace
  }
  $outputRoot = Require-BuildOutput -RepositoryRoot $repositoryRoot
  $nodePath = Resolve-NodeExecutable
  $standalonePath = Join-Path $outputRoot 'standalone.js'
  $enableLan = if ($AllowLan) { $true } else { Read-LanOptIn }
  $standaloneArguments = @('--cwd', $workspacePath)
  if ($enableLan) { $standaloneArguments += '--lan' }
  else { $standaloneArguments += '--no-lan' }

  [Console]::add_CancelKeyPress($cancelHandler)
  $cancelHandlerInstalled = $true

  # Both the --version probe and the real root are created suspended, assigned
  # to the private kill-on-close Job, and only then resumed.  No Node process
  # executes outside this containment boundary.
  $jobHandle = [PieStandaloneNative]::CreateKillOnCloseJob()
  Validate-NodeInJob -JobHandle $jobHandle -NodePath $nodePath -CurrentDirectory $workspacePath
  $childInfo = [PieStandaloneNative]::CreateSuspended(
    $nodePath,
    (@($standalonePath) + $standaloneArguments),
    $workspacePath)
  [PieStandaloneNative]::Assign($jobHandle, $childInfo.hProcess)
  [PieStandaloneNative]::Resume($childInfo.hThread)
  [PieStandaloneNative]::Close($childInfo.hThread)
  $threadClosed = $true

  $waitTimeout = [uint32]250
  while ($true) {
    $waitResult = [PieStandaloneNative]::Wait($childInfo.hProcess, $waitTimeout)
    if ($waitResult -eq [uint32]0) { break }
    if ($waitResult -ne [uint32]0x00000102) {
      throw "WaitForSingleObject failed with status 0x$('{0:X8}' -f $waitResult)."
    }

    $ctrlCAt = $controlState['CtrlCAt']
    if ($null -ne $ctrlCAt -and
        ([DateTime]::UtcNow - $ctrlCAt).TotalMilliseconds -ge $ShutdownTimeoutMilliseconds) {
      Write-Warning "Node did not finish graceful Ctrl+C shutdown within $ShutdownTimeoutMilliseconds ms; forcing only the Pie-owned process Job."
      try {
        [PieStandaloneNative]::ForceJob($jobHandle, 130)
      } catch {
        # Closing the Job handle in finally remains the kernel containment path.
        Write-Warning "The owned Job could not be force-terminated directly: $($_.Exception.Message)"
      }
      $forced = $true
      [void][PieStandaloneNative]::Wait($childInfo.hProcess, [uint32]5000)
      break
    }
  }

  if ($forced) {
    $exitCode = 130
  } else {
    $childExitCode = [PieStandaloneNative]::ExitCode($childInfo.hProcess)
    $exitCode = if ($childExitCode -le [uint32]0x7FFFFFFF) { [int]$childExitCode } else { 1 }
  }
} catch {
  [Console]::Error.WriteLine("Pie standalone launcher failed: $($_.Exception.Message)")
  $exitCode = 1
} finally {
  if ($cancelHandlerInstalled) {
    try { [Console]::remove_CancelKeyPress($cancelHandler) } catch { }
  }
  # If startup failed, or if the child crashed, this closes the sole Job handle
  # and KILL_ON_JOB_CLOSE removes any still-running descendants.  No taskkill
  # or broad PID search is used, so unrelated user processes are untouched.
  if ($null -ne $jobHandle -and $jobHandle -ne [IntPtr]::Zero) {
    try { [PieStandaloneNative]::Close($jobHandle) } catch { }
  }
  if ($null -ne $childInfo) {
    if (-not $threadClosed -and $childInfo.hThread -ne [IntPtr]::Zero) {
      try { [PieStandaloneNative]::Close($childInfo.hThread) } catch { }
    }
    if ($childInfo.hProcess -ne [IntPtr]::Zero) {
      try { [PieStandaloneNative]::Close($childInfo.hProcess) } catch { }
    }
  }
}

exit $exitCode
