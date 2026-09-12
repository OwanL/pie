param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedImagePath,
    [int]$MaxRequests = 256,
    [int]$MaxActiveHandles = 64,
    [int]$MaxDurationMs = 900000
)

$ErrorActionPreference = 'Stop'

# This is qualification instrumentation. It never starts, kills, or reopens a
# workload process. A handle is opened only for a PID supplied by the harness,
# while that PID is live, and is retained until the matching terminal receipt.
$collectorType = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PieWindowsProcessHandleCollectorR01 {
    private const uint QueryInformation = 0x0400;
    private const uint QueryLimitedInformation = 0x1000;
    private const uint VmRead = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTimeValueStruct {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessMemoryCountersEx {
        public uint Cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
        public UIntPtr PrivateUsage;
    }

    public struct Snapshot {
        public bool MemoryOk;
        public ulong PeakWorkingSetBytes;
        public int MemoryError;
        public bool TimesOk;
        public ulong CreationTime100ns;
        public ulong ExitTime100ns;
        public ulong UserTime100ns;
        public ulong KernelTime100ns;
        public int TimesError;
        public uint ProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr handle,
        out FileTimeValueStruct creationTime,
        out FileTimeValueStruct exitTime,
        out FileTimeValueStruct kernelTime,
        out FileTimeValueStruct userTime);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(
        IntPtr process,
        out ProcessMemoryCountersEx counters,
        uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder imagePath,
        ref uint size);

    private static ulong ToUInt64(FileTimeValueStruct value) {
        return ((ulong)value.High << 32) | value.Low;
    }

    public static IntPtr OpenExact(int processId) {
        return OpenProcess(QueryInformation | QueryLimitedInformation | VmRead, false, processId);
    }

    public static uint ProcessId(IntPtr handle) {
        return GetProcessId(handle);
    }

    public static string ImagePath(IntPtr handle) {
        StringBuilder path = new StringBuilder(1024);
        uint size = (uint)path.Capacity;
        if (!QueryFullProcessImageName(handle, 0, path, ref size)) {
            return "";
        }
        return path.ToString();
    }

    public static Snapshot Read(IntPtr handle) {
        Snapshot snapshot = new Snapshot();
        snapshot.ProcessId = GetProcessId(handle);

        ProcessMemoryCountersEx counters;
        uint counterSize = (uint)Marshal.SizeOf(typeof(ProcessMemoryCountersEx));
        if (GetProcessMemoryInfo(handle, out counters, counterSize)) {
            snapshot.MemoryOk = true;
            snapshot.PeakWorkingSetBytes = counters.PeakWorkingSetSize.ToUInt64();
        } else {
            snapshot.MemoryError = Marshal.GetLastWin32Error();
        }

        FileTimeValueStruct creation;
        FileTimeValueStruct exit;
        FileTimeValueStruct kernel;
        FileTimeValueStruct user;
        if (GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
            snapshot.TimesOk = true;
            snapshot.CreationTime100ns = ToUInt64(creation);
            snapshot.ExitTime100ns = ToUInt64(exit);
            snapshot.KernelTime100ns = ToUInt64(kernel);
            snapshot.UserTime100ns = ToUInt64(user);
        } else {
            snapshot.TimesError = Marshal.GetLastWin32Error();
        }
        return snapshot;
    }

    public static bool CloseExact(IntPtr handle) {
        if (handle == IntPtr.Zero) {
            return true;
        }
        return CloseHandle(handle);
    }
}
'@

function Write-CollectorEvent {
    param([Parameter(Mandatory = $true)]$Event)
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress -Depth 10))
    [Console]::Out.Flush()
}

function Write-UnavailableReceipt {
    param(
        [Parameter(Mandatory = $true)]$Registration,
        [Parameter(Mandatory = $true)][string]$Reason,
        [int]$MemoryError = 0,
        [int]$TimesError = 0,
        [Nullable[bool]]$HandleRetainedThroughExit = $false
    )
    $receipt = [ordered]@{
        type = 'receipt'
        requestKey = $Registration.requestKey
        clientId = $Registration.clientId
        requestId = $Registration.requestId
        identity = [ordered]@{
            instanceId = $Registration.identity.instanceId
            pid = $Registration.identity.pid
            spawnedAtMs = $Registration.identity.spawnedAtMs
        }
        status = 'unavailable'
        reason = $Reason
        memory = $null
        cpu = $null
        registration = [ordered]@{
            spawnWindowStartMs = $Registration.spawnWindowStartMs
            spawnWindowEndMs = $Registration.spawnWindowEndMs
            observedAtMs = $Registration.observedAtMs
            creationTime100ns = $Registration.creationTime100ns
            creationTimeUnixMs = $Registration.creationTimeUnixMs
            creationWindowMatch = $Registration.creationWindowMatch
            imagePath = $Registration.imagePath
        }
        handleRetainedThroughExit = $HandleRetainedThroughExit
        handleClosed = $false
        memoryError = if ($MemoryError -eq 0) { $null } else { $MemoryError }
        timesError = if ($TimesError -eq 0) { $null } else { $TimesError }
    }
    Write-CollectorEvent $receipt
}

function Convert-FileTimeToUnixMilliseconds {
    param([Parameter(Mandatory = $true)][UInt64]$FileTime100ns)
    return ([double]$FileTime100ns / 10000.0) - 11644473600000.0
}

function Test-StringBounded {
    param($Value, [int]$MaximumLength)
    return $Value -is [string] -and $Value.Length -gt 0 -and $Value.Length -le $MaximumLength
}

function Test-Identity {
    param($Identity)
    if ($null -eq $Identity) { return $false }
    if (-not (Test-StringBounded $Identity.instanceId 64)) { return $false }
    if ($Identity.instanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { return $false }
    if ($Identity.pid -isnot [int] -and $Identity.pid -isnot [long] -and $Identity.pid -isnot [double]) { return $false }
    if ([double]$Identity.pid -ne [math]::Floor([double]$Identity.pid) -or [double]$Identity.pid -le 0 -or [double]$Identity.pid -gt 4294967295) { return $false }
    if ($Identity.spawnedAtMs -isnot [int] -and $Identity.spawnedAtMs -isnot [long] -and $Identity.spawnedAtMs -isnot [double]) { return $false }
    if ([double]$Identity.spawnedAtMs -ne [math]::Floor([double]$Identity.spawnedAtMs) -or [double]$Identity.spawnedAtMs -le 0) { return $false }
    return $true
}

function New-Registration {
    param($Message)
    if ($null -eq $Message -or $Message.type -ne 'register') { return $null }
    if (-not (Test-StringBounded $Message.requestKey 256) -or -not (Test-StringBounded $Message.clientId 128)) { return $null }
    if ($Message.requestId -isnot [int] -and $Message.requestId -isnot [long] -and $Message.requestId -isnot [double]) { return $null }
    if ([double]$Message.requestId -ne [math]::Floor([double]$Message.requestId) -or [double]$Message.requestId -le 0) { return $null }
    if (-not (Test-Identity $Message.identity)) { return $null }
    if ($Message.requestKey -ne ("{0}:{1}" -f $Message.clientId, $Message.requestId)) { return $null }
    foreach ($field in @('spawnWindowStartMs', 'spawnWindowEndMs', 'observedAtMs')) {
        $value = $Message.$field
        if (($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double]) -or [double]$value -ne [math]::Floor([double]$value) -or [double]$value -le 0) { return $null }
    }
    if ([double]$Message.spawnWindowStartMs -gt [double]$Message.spawnWindowEndMs) { return $null }
    if ([double]$Message.spawnWindowEndMs -ne [double]$Message.observedAtMs) { return $null }
    # The parent records spawnedAtMs immediately before fork. A collector
    # registration delayed beyond this bounded window is explicitly raced.
    if (([double]$Message.spawnWindowEndMs - [double]$Message.spawnWindowStartMs) -gt 30000) { return $null }
    return [pscustomobject]@{
        requestKey = [string]$Message.requestKey
        clientId = [string]$Message.clientId
        requestId = [int]$Message.requestId
        identity = [pscustomobject]@{
            instanceId = [string]$Message.identity.instanceId
            pid = [int]$Message.identity.pid
            spawnedAtMs = [long]$Message.identity.spawnedAtMs
        }
        spawnWindowStartMs = [long]$Message.spawnWindowStartMs
        spawnWindowEndMs = [long]$Message.spawnWindowEndMs
        observedAtMs = [long]$Message.observedAtMs
        creationTime100ns = $null
        creationTimeUnixMs = $null
        creationWindowMatch = $false
        imagePath = $null
        handle = [IntPtr]::Zero
    }
}

function Complete-Registration {
    param(
        [Parameter(Mandatory = $true)]$Registration,
        [Parameter(Mandatory = $true)]$Message,
        [hashtable]$Registrations
    )
    $handle = $Registration.handle
    try {
        if ($handle -eq [IntPtr]::Zero) {
            Write-UnavailableReceipt $Registration 'missing-retained-handle'
            return
        }
        $snapshot = $null
        for ($attempt = 0; $attempt -lt 6; $attempt += 1) {
            $snapshot = [PieWindowsProcessHandleCollectorR01]::Read($handle)
            if ($snapshot.TimesOk -and $snapshot.ExitTime100ns -ne [UInt64]0) { break }
            Start-Sleep -Milliseconds 50
        }
        if (-not $snapshot.TimesOk) {
            Write-UnavailableReceipt $Registration 'final-process-times-unavailable' 0 $snapshot.TimesError $false
            return
        }
        if ($snapshot.ExitTime100ns -eq [UInt64]0) {
            Write-UnavailableReceipt $Registration 'terminal-process-not-exited' 0 0 $false
            return
        }
        if (-not $snapshot.MemoryOk) {
            Write-UnavailableReceipt $Registration 'final-memory-unavailable' $snapshot.MemoryError 0 $false
            return
        }
        $receipt = [ordered]@{
            type = 'receipt'
            requestKey = $Registration.requestKey
            clientId = $Registration.clientId
            requestId = $Registration.requestId
            identity = [ordered]@{
                instanceId = $Registration.identity.instanceId
                pid = $Registration.identity.pid
                spawnedAtMs = $Registration.identity.spawnedAtMs
            }
            status = 'available'
            reason = $null
            memory = [ordered]@{
                peakWorkingSetBytes = [UInt64]$snapshot.PeakWorkingSetBytes
                units = 'bytes'
            }
            cpu = [ordered]@{
                userCpuTimeMicros = [UInt64]([math]::Floor([double]$snapshot.UserTime100ns / 10.0))
                systemCpuTimeMicros = [UInt64]([math]::Floor([double]$snapshot.KernelTime100ns / 10.0))
                units = 'microseconds'
            }
            registration = [ordered]@{
                spawnWindowStartMs = $Registration.spawnWindowStartMs
                spawnWindowEndMs = $Registration.spawnWindowEndMs
                observedAtMs = $Registration.observedAtMs
                creationTime100ns = ([string]$Registration.creationTime100ns)
                creationTimeUnixMs = $Registration.creationTimeUnixMs
                creationWindowMatch = $Registration.creationWindowMatch
                imagePath = $Registration.imagePath
            }
            final = [ordered]@{
                exitTime100ns = ([string]$snapshot.ExitTime100ns)
                handleRetainedThroughExit = $true
            }
            handleRetainedThroughExit = $true
            handleClosed = $false
            memoryError = $null
            timesError = $null
        }
        Write-CollectorEvent $receipt
    } finally {
        $closed = [PieWindowsProcessHandleCollectorR01]::CloseExact($handle)
        $Registration.handle = [IntPtr]::Zero
        if ($null -ne $Registrations) { $Registrations.Remove($Registration.requestKey) | Out-Null }
        # Emit a small close acknowledgement only after the receipt. The Node
        # wrapper uses it to prove no active native handles remain at shutdown.
        Write-CollectorEvent ([ordered]@{
            type = 'closed'
            requestKey = $Registration.requestKey
            handleCloseOk = [bool]$closed
        })
    }
}

if ($MaxRequests -lt 1 -or $MaxRequests -gt 10000) { throw 'MaxRequests must be between 1 and 10000' }
if ($MaxActiveHandles -lt 1 -or $MaxActiveHandles -gt 256) { throw 'MaxActiveHandles must be between 1 and 256' }
if ($MaxDurationMs -lt 1000 -or $MaxDurationMs -gt 1800000) { throw 'MaxDurationMs must be between 1000 and 1800000' }
$ExpectedImagePath = [IO.Path]::GetFullPath($ExpectedImagePath)
Add-Type -TypeDefinition $collectorType -ErrorAction Stop

$registrations = @{}
$requestCount = 0
$startedAt = [DateTime]::UtcNow
$deadline = $startedAt.AddMilliseconds($MaxDurationMs)
$shutdown = $false
Write-CollectorEvent ([ordered]@{
    type = 'ready'
    version = 'windows-process-handle-collector-r01'
    expectedImagePath = $ExpectedImagePath
    maxRequests = $MaxRequests
    maxActiveHandles = $MaxActiveHandles
    maxDurationMs = $MaxDurationMs
    startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
})

try {
    while (-not $shutdown) {
        if ([DateTime]::UtcNow -ge $deadline) {
            foreach ($registration in @($registrations.Values)) {
                Write-UnavailableReceipt $registration 'collector-duration-expired' 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($registration.handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
            }
            $registrations.Clear()
            Write-CollectorEvent ([ordered]@{ type = 'stopped'; reason = 'duration-expired'; requestCount = $requestCount; activeHandles = 0 })
            break
        }
        $readTask = [Console]::In.ReadLineAsync()
        while (-not $readTask.Wait(100)) {
            if ([DateTime]::UtcNow -ge $deadline) { break }
        }
        if (-not $readTask.IsCompleted) {
            foreach ($registration in @($registrations.Values)) {
                Write-UnavailableReceipt $registration 'collector-duration-expired' 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($registration.handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
            }
            $registrations.Clear()
            Write-CollectorEvent ([ordered]@{ type = 'stopped'; reason = 'duration-expired'; requestCount = $requestCount; activeHandles = 0 })
            break
        }
        $line = $readTask.Result
        if ($null -eq $line) {
            foreach ($registration in @($registrations.Values)) {
                Write-UnavailableReceipt $registration 'collector-input-closed-before-terminal' 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($registration.handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
            }
            $registrations.Clear()
            Write-CollectorEvent ([ordered]@{ type = 'stopped'; reason = 'input-closed'; requestCount = $requestCount; activeHandles = 0 })
            break
        }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $message = $line | ConvertFrom-Json -ErrorAction Stop
        } catch {
            Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'malformed-json' })
            continue
        }
        if ($message.type -eq 'shutdown') {
            foreach ($registration in @($registrations.Values)) {
                Write-UnavailableReceipt $registration 'shutdown-before-terminal' 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($registration.handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
            }
            $registrations.Clear()
            $shutdown = $true
            Write-CollectorEvent ([ordered]@{ type = 'stopped'; reason = 'requested'; requestCount = $requestCount; activeHandles = 0 })
            continue
        }
        if ($message.type -eq 'register') {
            $requestCount += 1
            $registration = New-Registration $message
            if ($requestCount -gt $MaxRequests) {
                if ($null -ne $registration) { Write-UnavailableReceipt $registration 'request-limit-exceeded' }
                else { Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'invalid-registration' }) }
                continue
            }
            if ($null -eq $registration) {
                Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'invalid-registration' })
                continue
            }
            if ($registrations.ContainsKey($registration.requestKey)) {
                Write-UnavailableReceipt $registration 'duplicate-registration'
                continue
            }
            if ($registrations.Count -ge $MaxActiveHandles) {
                Write-UnavailableReceipt $registration 'active-handle-limit'
                continue
            }
            $handle = [PieWindowsProcessHandleCollectorR01]::OpenExact($registration.identity.pid)
            if ($handle -eq [IntPtr]::Zero) {
                Write-UnavailableReceipt $registration 'open-process-failed'
                continue
            }
            $registration.handle = $handle
            $handlePid = [PieWindowsProcessHandleCollectorR01]::ProcessId($handle)
            $imagePath = [PieWindowsProcessHandleCollectorR01]::ImagePath($handle)
            $registration.imagePath = $imagePath
            $snapshot = [PieWindowsProcessHandleCollectorR01]::Read($handle)
            if ($handlePid -ne [uint32]$registration.identity.pid -or [StringComparer]::OrdinalIgnoreCase.Equals($imagePath, $ExpectedImagePath) -eq $false) {
                Write-UnavailableReceipt $registration 'identity-image-mismatch' 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
                continue
            }
            if (-not $snapshot.TimesOk) {
                Write-UnavailableReceipt $registration 'registration-process-times-unavailable' 0 $snapshot.TimesError $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
                continue
            }
            $creationUnixMs = Convert-FileTimeToUnixMilliseconds $snapshot.CreationTime100ns
            $registration.creationTime100ns = [string]$snapshot.CreationTime100ns
            $registration.creationTimeUnixMs = $creationUnixMs
            $registration.creationWindowMatch = $creationUnixMs -ge [double]$registration.spawnWindowStartMs -and $creationUnixMs -le [double]$registration.spawnWindowEndMs
            if (-not $registration.creationWindowMatch -or $snapshot.ExitTime100ns -ne [UInt64]0) {
                $reason = if ($snapshot.ExitTime100ns -ne [UInt64]0) { 'registration-terminal-race' } else { 'creation-time-outside-spawn-window' }
                Write-UnavailableReceipt $registration $reason 0 0 $false
                [PieWindowsProcessHandleCollectorR01]::CloseExact($handle) | Out-Null
                $registration.handle = [IntPtr]::Zero
                continue
            }
            $registrations[$registration.requestKey] = $registration
            Write-CollectorEvent ([ordered]@{
                type = 'registered'
                requestKey = $registration.requestKey
                identity = [ordered]@{ instanceId = $registration.identity.instanceId; pid = $registration.identity.pid; spawnedAtMs = $registration.identity.spawnedAtMs }
                creationTime100ns = $registration.creationTime100ns
                creationTimeUnixMs = $registration.creationTimeUnixMs
                creationWindowMatch = $registration.creationWindowMatch
                imagePath = $registration.imagePath
                activeHandles = $registrations.Count
            })
            continue
        }
        if ($message.type -eq 'terminal') {
            if (-not (Test-StringBounded $message.requestKey 256)) {
                Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'invalid-terminal-key' })
                continue
            }
            $registration = $registrations[$message.requestKey]
            if ($null -eq $registration) {
                if ((Test-StringBounded $message.clientId 128) -and ($message.requestId -is [int] -or $message.requestId -is [long] -or $message.requestId -is [double]) -and (Test-Identity $message.identity) -and $message.requestKey -eq ("{0}:{1}" -f $message.clientId, $message.requestId)) {
                    $fallback = [pscustomobject]@{
                        requestKey = [string]$message.requestKey
                        clientId = [string]$message.clientId
                        requestId = [int]$message.requestId
                        identity = [pscustomobject]@{
                            instanceId = [string]$message.identity.instanceId
                            pid = [int]$message.identity.pid
                            spawnedAtMs = [long]$message.identity.spawnedAtMs
                        }
                        spawnWindowStartMs = [long]$message.identity.spawnedAtMs
                        spawnWindowEndMs = [long]$message.identity.spawnedAtMs
                        observedAtMs = [long]$message.identity.spawnedAtMs
                        creationTime100ns = $null
                        creationTimeUnixMs = $null
                        creationWindowMatch = $false
                        imagePath = $null
                        handle = [IntPtr]::Zero
                    }
                    Write-UnavailableReceipt $fallback 'missing-registration' 0 0 $false
                } else {
                    Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'missing-registration-identity' })
                }
                continue
            }
            if (($null -eq $message.identity) -or (-not (Test-Identity $message.identity)) -or $message.identity.instanceId -ne $registration.identity.instanceId -or [int]$message.identity.pid -ne $registration.identity.pid -or [long]$message.identity.spawnedAtMs -ne $registration.identity.spawnedAtMs) {
                # A malformed terminal is diagnostic evidence only. Keep the
                # validated registration and retained handle so the matching
                # terminal can still produce the sole final receipt.
                Write-CollectorEvent ([ordered]@{
                    type = 'rejection'
                    requestKey = $registration.requestKey
                    reason = 'terminal-identity-mismatch'
                    expectedIdentity = [ordered]@{ instanceId = $registration.identity.instanceId; pid = $registration.identity.pid; spawnedAtMs = $registration.identity.spawnedAtMs }
                    receivedIdentity = $message.identity
                })
                continue
            }
            Complete-Registration $registration $message $registrations
            continue
        }
        Write-CollectorEvent ([ordered]@{ type = 'protocol-error'; reason = 'unsupported-message-type' })
    }
} finally {
    foreach ($registration in @($registrations.Values)) {
        [PieWindowsProcessHandleCollectorR01]::CloseExact($registration.handle) | Out-Null
        $registration.handle = [IntPtr]::Zero
    }
    $registrations.Clear()
}
