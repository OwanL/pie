param(
    [Parameter(Mandatory = $true)][string]$Files,
    [int]$PollIntervalMs = 20,
    [int]$MaxEvents = 512,
    [int]$MaxDurationMs = 600000
)

$ErrorActionPreference = 'Stop'

# Cache file I/O observer (P2c evidence). Read-only Restart Manager polling:
# one RM session is opened per monitored file for the whole observation; each
# poll tick's RmGetList reports the processes currently holding an open handle
# on that exact file, including the kernel process start time
# (RM_UNIQUE_PROCESS.ProcessStartTime) that binds an observation to a process
# identity across PID reuse. The observation loop is resident in compiled C#
# because PowerShell's per-tick dynamic marshaling crashed intermittently
# under load, and the collector never opens, writes, locks, or signals any
# process or file. Process identity enrichment is deliberately left to the
# runner's snapshot so no WMI provider is queried inside the polling loop.

$collectorType = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class PieCacheFileIoCollectorR01 {
    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME_VALUE {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public FILETIME_VALUE ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll", SetLastError = false)]
    public static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RmRegisterResources(
        uint pSessionHandle,
        uint nFiles,
        string[] rgsFileNames,
        uint nApplications,
        RM_UNIQUE_PROCESS[] rgApplications,
        uint nServices,
        string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int RmGetList(
        uint dwSessionHandle,
        out uint pnProcInfoNeeded,
        ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps,
        ref uint lpdwRebootReasons);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern uint GetLongPathNameW(
        [MarshalAs(UnmanagedType.LPWStr)] string lpszShortPath,
        System.Text.StringBuilder lpszLongPath,
        uint cchBuffer);

    public static string ExpandLongPath(string candidate) {
        if (string.IsNullOrEmpty(candidate)) return candidate;
        var buffer = new System.Text.StringBuilder(2048);
        var length = GetLongPathNameW(candidate, buffer, (uint)buffer.Capacity);
        if (length > 0 && length < (uint)buffer.Capacity) {
            return buffer.ToString(0, (int)length);
        }
        return candidate;
    }

    public const int ErrorMoreData = 234;
    public const int MaxProcessInfoBuffer = 1024;

    private static string JsonEscape(string value) {
        if (value == null) return string.Empty;
        var builder = new System.Text.StringBuilder(value.Length + 8);
        foreach (var ch in value) {
            switch (ch) {
                case '\\': builder.Append("\\\\"); break;
                case '"': builder.Append("\\\""); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (ch < 32) {
                        builder.Append("\\u").Append(((int)ch).ToString("x4"));
                    } else {
                        builder.Append(ch);
                    }
                    break;
            }
        }
        return builder.ToString();
    }

    private static string Inv(long value) {
        return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    public sealed class FileState {
        public string File;
        public bool Live;
        public int Polls;
        public int FileErrors;
        public int Catches;
        public HashSet<int> UniquePids = new HashSet<int>();
        public Dictionary<int, int> PairEmissions = new Dictionary<int, int>();
    }

    public static long FileTime100nsToUnixMs(long raw100ns) {
        // FILETIME is 100ns ticks since 1601-01-01; the Unix epoch offset is
        // 116444736000000000 ticks. Int64 math avoids double precision loss.
        const long epochOffset100ns = 116444736000000000L;
        return (raw100ns - epochOffset100ns) / 10000L;
    }

    public sealed class ObserveResult {
        public string StopReason = "duration-expired";
        public int PollTicks;
        public long StartedAtMs;
        public long EndedAtMs;
    }

    private static List<FileState> states = new List<FileState>();
    private static Dictionary<FileState, uint> liveHandles = new Dictionary<FileState, uint>();

    // Runs the whole bounded observation and returns the terminal envelope.
    // Streams one JSON line per emitted catch via the stream delegate. Every
    // RM session is closed exactly once in the finally block regardless of
    // the terminal path.
    public static ObserveResult Observe(
        string[] files,
        int pollIntervalMs,
        int maxEvents,
        int maxDurationMs,
        Action<string> stream) {
        var result = new ObserveResult();
        result.StartedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        states = new List<FileState>();
        liveHandles = new Dictionary<FileState, uint>();
        var eventsEmitted = 0;
        try {
            for (var index = 0; index < files.Length; index += 1) {
                var state = new FileState { File = ExpandLongPath(files[index]), Live = false };
                states.Add(state);
                uint sessionHandle;
                var sessionKey = "pie-cache-io-f" + index.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    + "-" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var startError = RmStartSession(out sessionHandle, 0, sessionKey);
                if (startError != 0) {
                    state.FileErrors += 1;
                    continue;
                }
                var registerError = RmRegisterResources(sessionHandle, 1, new[] { state.File }, 0, null, 0, null);
                if (registerError != 0) {
                    state.FileErrors += 1;
                    RmEndSession(sessionHandle);
                    continue;
                }
                state.Live = true;
                liveHandles[state] = sessionHandle;
            }
            var deadline = DateTime.UtcNow.AddMilliseconds(maxDurationMs);
            while (DateTime.UtcNow < deadline) {
                var anyLive = false;
                foreach (var state in states) {
                    if (!liveHandles.ContainsKey(state)) continue;
                    anyLive = true;
                    if (eventsEmitted >= maxEvents) break;
                    state.Polls += 1;
                    uint needed;
                    uint count = 16;
                    uint reasons = 0;
                    var processes = new RM_PROCESS_INFO[16];
                    var listError = RmGetList(liveHandles[state], out needed, ref count, processes, ref reasons);
                    if (listError == ErrorMoreData && needed > 16 && needed <= MaxProcessInfoBuffer) {
                        count = needed;
                        processes = new RM_PROCESS_INFO[count];
                        listError = RmGetList(liveHandles[state], out needed, ref count, processes, ref reasons);
                    }
                    if (listError != 0) {
                        state.FileErrors += 1;
                        continue;
                    }
                    for (var i = 0; i < count; i += 1) {
                        var info = processes[i];
                        var caughtPid = info.Process.dwProcessId;
                        if (caughtPid <= 0) continue;
                        state.Catches += 1;
                        if (!state.UniquePids.Add(caughtPid)) continue;
                        // Bounded emission: the first four sightings per
                        // (file, pid) pair are streamed; later sightings only
                        // update the terminal counters.
                        var emitted = 0;
                        state.PairEmissions.TryGetValue(caughtPid, out emitted);
                        if (emitted >= 4) continue;
                        if (eventsEmitted >= maxEvents) break;
                        state.PairEmissions[caughtPid] = emitted + 1;
                        eventsEmitted += 1;
                        var raw100ns = ((long)info.Process.ProcessStartTime.High << 32) | info.Process.ProcessStartTime.Low;
                        var json = "{\"type\":\"io\",\"file\":\"" + JsonEscape(state.File)
                            + "\",\"pid\":" + Inv(caughtPid)
                            + ",\"processStartTime100ns\":\"" + Inv(raw100ns)
                            + "\",\"processStartTimeUnixMs\":" + Inv(FileTime100nsToUnixMs(raw100ns))
                            + ",\"appName\":\"" + JsonEscape(info.strAppName)
                            + "\",\"applicationType\":" + Inv(info.ApplicationType)
                            + ",\"appStatus\":" + Inv(info.AppStatus)
                            + ",\"tsSessionId\":" + Inv(info.TSSessionId)
                            + ",\"restartable\":" + (info.bRestartable ? "true" : "false")
                            + ",\"observedAtMs\":" + Inv(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                            + ",\"pollTick\":" + Inv(result.PollTicks)
                            + ",\"identity\":null"
                            + "}";
                        stream(json);
                    }
                }
                if (eventsEmitted >= maxEvents || !anyLive) break;
                if (pollIntervalMs > 0) System.Threading.Thread.Sleep(pollIntervalMs);
                result.PollTicks += 1;
            }
            result.StopReason = eventsEmitted >= maxEvents ? "event-limit" : "duration-expired";
        } catch (Exception error) {
            result.StopReason = "duration-expired";
            try {
                stream("{\"type\":\"protocol-error\",\"reason\":\"observer-exception:" + JsonEscape(error.GetType().Name) + "\"}");
            } catch { /* the terminal event still reports state */ }
        } finally {
            result.EndedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            CloseAll();
        }
        return result;
    }

    public static void CloseAll() {
        foreach (var state in states) {
            uint handle;
            if (liveHandles.TryGetValue(state, out handle)) {
                RmEndSession(handle);
                liveHandles.Remove(state);
            }
        }
    }

    public static string[] LastPerFileJson() {
        var rows = new string[states.Count];
        for (var i = 0; i < states.Count; i += 1) {
            var state = states[i];
            var pids = new System.Text.StringBuilder();
            var first = true;
            foreach (var pid in state.UniquePids) {
                if (!first) pids.Append(',');
                pids.Append(Inv(pid));
                first = false;
            }
            rows[i] = "{\"file\":\"" + JsonEscape(state.File)
                + "\",\"polls\":" + Inv(state.Polls)
                + ",\"fileErrors\":" + Inv(state.FileErrors)
                + ",\"catches\":" + Inv(state.Catches)
                + ",\"uniquePids\":[" + pids.ToString() + "]}";
        }
        return rows;
    }
}
'@

Add-Type -TypeDefinition $collectorType

$version = 'cache-file-io-collector-r01'

function Write-CollectorEvent {
    param([Parameter(Mandatory = $true)]$Event)
    [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function Get-CollectorFileList {
    param([Parameter(Mandatory = $true)][string]$Raw)
    $entries = @()
    foreach ($candidate in $Raw -split ';') {
        $trimmed = $candidate.Trim('"').Trim()
        if ($trimmed.Length -gt 0) { $entries += $trimmed }
    }
    return @($entries | Select-Object -Unique)
}

$normalizedFiles = Get-CollectorFileList -Raw $Files
if ($normalizedFiles.Count -eq 0 -or $normalizedFiles.Count -gt 16) {
    [Console]::Error.WriteLine('collector requires between 1 and 16 files')
    exit 2
}

$startedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Write-CollectorEvent ([ordered]@{
    type = 'ready'
    version = $version
    files = @($normalizedFiles)
    pollIntervalMs = $PollIntervalMs
    maxEvents = $MaxEvents
    maxDurationMs = $MaxDurationMs
    startedAtMs = $startedAtMs
})

$exitCode = 0
try {
    $result = [PieCacheFileIoCollectorR01]::Observe(
        [string[]]$normalizedFiles,
        $PollIntervalMs,
        $MaxEvents,
        $MaxDurationMs,
        {
            param($json)
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
        })
    $runStopReason = [string]$result.StopReason
    $runPollTicks = [int]$result.PollTicks
    $runStartedAtMs = [int64]$result.StartedAtMs
    $runEndedAtMs = [int64]$result.EndedAtMs
} catch {
    [Console]::Error.WriteLine(("collector failed: {0}" -f $_.Exception.Message))
    $exitCode = 3
} finally {
    try { [PieCacheFileIoCollectorR01]::CloseAll() } catch { $exitCode = 3 }
}

$perFileRows = @()
try {
    foreach ($row in [PieCacheFileIoCollectorR01]::LastPerFileJson()) {
        $perFileRows += ($row | ConvertFrom-Json)
    }
} catch {
    $perFileRows = @()
}

$totalCatches = 0
$totalEmitted = 0
foreach ($row in $perFileRows) {
    $totalCatches += [int]$row.catches
    $totalEmitted += @($row.uniquePids).Count
}

if ($null -eq $runStopReason -or [string]::IsNullOrEmpty($runStopReason)) { $runStopReason = 'duration-expired' }
Write-CollectorEvent ([ordered]@{
    type = 'stopped'
    reason = $runStopReason
    pollTicks = [int]$runPollTicks
    catches = $totalCatches
    eventsEmitted = $totalEmitted
    identityLookups = 0
    perFile = @($perFileRows)
    startedAtMs = $runStartedAtMs
    endedAtMs = $runEndedAtMs
})
exit $exitCode