import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';

// SDK-independent guardian. Like agent-processes' existing guardian this uses
// Windows PowerShell Add-Type, not an installed native executable. Unlike that
// attach-by-PID API, creation and containment both belong to this guardian.
const GUARDIAN = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
# Reflection.Emit needs no compiler process. Put the guardian itself in a
# noninheritable kill-on-close bootstrap Job BEFORE Add-Type can launch csc.
# The guardian keeps this handle until process exit; it is never empty proof.
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('PieBootstrap')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('Native').DefineType('PieBootstrap', [Reflection.TypeAttributes]::Public)
function Add-PInvoke($name, $returnType, $parameters) {
  $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $returnType, [Type[]]$parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Add-PInvoke 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
Add-PInvoke 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Add-PInvoke 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
$native = $type.CreateType()
$bootstrapJob = $native::CreateJobObjectW([IntPtr]::Zero, $null)
if ($bootstrapJob -eq [IntPtr]::Zero) { throw 'Create bootstrap Job failed' }
$limitSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
$limits = [Runtime.InteropServices.Marshal]::AllocHGlobal($limitSize)
try {
  [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $limitSize), 0, $limits, $limitSize)
  [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000)
  if (-not $native::SetInformationJobObject($bootstrapJob, 9, $limits, $limitSize)) { throw 'Configure bootstrap Job failed' }
  $self = [Diagnostics.Process]::GetCurrentProcess()
  try { if (-not $native::AssignProcessToJobObject($bootstrapJob, $self.Handle)) { throw 'Assign guardian to bootstrap Job failed' } } finally { $self.Dispose() }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($limits) }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;

public static class PieOwnedTree {
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long UserTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ProcessLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint Size; public IntPtr Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCOUNTING info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr sa, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSa, IntPtr threadSa, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr handle, byte[] data, uint size, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  static IntPtr Duplicate(IntPtr handle) {
    IntPtr result; Check(DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), out result, 0, true, 2), "DuplicateHandle"); return result;
  }
  // CommandLineToArgvW / CRT escaping, including empty arguments and trailing backslashes.
  static string Quote(string text) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in text) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static uint Active(IntPtr job) {
    ACCOUNTING info;
    Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
    return info.ActiveProcesses;
  }
  static bool Drain(IntPtr job, int timeout, out uint active) {
    // TerminateJobObject is only a request. Keep the handle open while polling.
    Check(TerminateJobObject(job, 1), "TerminateJobObject");
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeout);
    do {
      active = Active(job);
      if (active == 0) return true;
      if (DateTime.UtcNow >= deadline) return false;
      Thread.Sleep(10);
    } while (true);
  }
  static string Diagnostic(Exception error) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(error.ToString())); }

  public static void Run(string pipeName, string invocation, string command, string[] args, string cwd, string environment) {
    IntPtr job = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
    IntPtr childInput = IntPtr.Zero, childOutput = IntPtr.Zero, childError = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, env = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool attributesReady = false, sealedAdmission = false, proven = false, completed = false;
    using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.None)) {
      pipe.Connect(5000);
      using (StreamWriter control = new StreamWriter(pipe, new UTF8Encoding(false))) {
        control.AutoFlush = true;
        Action<string> send = delegate(string body) { control.WriteLine("{\"invocationId\":\"" + invocation + "\"," + body + "}"); };
        try {
          job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
          EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway.
          Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "SetInformationJobObject");
          Check(CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 65536), "CreatePipe");
          childInput = Duplicate(inputRead); childOutput = Duplicate(GetStdHandle(-11)); childError = Duplicate(GetStdHandle(-12));
          Close(ref inputRead);
          IntPtr size = IntPtr.Zero;
          InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
          attributes = Marshal.AllocHGlobal(size);
          Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList"); attributesReady = true;
          handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
          Marshal.WriteIntPtr(handles, 0, childInput); Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childError);
          Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "HANDLE_LIST");
          // Windows 10+ JOB_LIST atomically assigns the private Job at creation.
          // This additionally closes the guardian-crash / startup-abort window
          // between CreateProcess and a traditional AssignProcessToJobObject.
          jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
          Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "JOB_LIST (Windows 10+ required)");
          STARTUPINFOEX startup = new STARTUPINFOEX(); startup.Startup.Size = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
          startup.Startup.Flags = 0x100; startup.Startup.Stdin = childInput; startup.Startup.Stdout = childOutput; startup.Startup.Stderr = childError; startup.Attributes = attributes;
          env = Marshal.StringToHGlobalUni(environment);
          StringBuilder commandLine = new StringBuilder(Quote(command)); foreach (string arg in args) commandLine.Append(" ").Append(Quote(arg));
          // No shell, no PID reopen, no breakaway; the only inherited handles
          // are child stdin/stdout/stderr. The Job and control pipe are private.
          Check(CreateProcess(command, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x80404, env, cwd, ref startup, out process), "CreateProcess suspended in Job");
          bool assigned; Check(IsProcessInJob(process.Process, job, out assigned), "IsProcessInJob original handle");
          Check(assigned, "Root was not assigned to private Job");
          Close(ref childInput); Close(ref childOutput); Close(ref childError);
          // Start the EOF monitor before resume, not after a caller authorization.
          Task<string> read = Task.Factory.StartNew(delegate { return Console.In.ReadLine(); });
          Check(ResumeThread(process.Thread) != UInt32.MaxValue, "ResumeThread"); Close(ref process.Thread);
          send("\"type\":\"ready\",\"rootPid\":" + process.Pid);
          while (true) {
            if (!completed && WaitForSingleObject(process.Process, 0) == 0) {
              uint code; Check(GetExitCodeProcess(process.Process, out code), "GetExitCodeProcess");
              send("\"type\":\"completion\",\"code\":" + code); completed = true;
            }
            if (!read.IsCompleted) { Thread.Sleep(10); continue; }
            string line = read.GetAwaiter().GetResult();
            if (line == null) { sealedAdmission = true; uint ignored; Drain(job, 10000, out ignored); break; }
            string[] fields = line.Split(new char[] {' '}, 3); string request = fields.Length > 1 ? fields[1] : "0";
            // Request IDs are generated by the coordinator; never echo arbitrary JSON.
            long requestId; if (!Int64.TryParse(request, out requestId) || requestId <= 0) throw new InvalidDataException("Invalid control request");
            if (fields[0] == "authorize") {
              if (sealedAdmission || inputWrite == IntPtr.Zero) throw new InvalidOperationException("Startup admission is sealed");
              byte[] bytes = Convert.FromBase64String(fields.Length == 3 ? fields[2] : "");
              if (bytes.Length > 16384) throw new InvalidDataException("Startup authorization exceeds 16 KiB");
              // Exact UTF-8 then close: an empty authorization is represented by
              // closing the handle, never by a zero-length WriteFile call.
              if (bytes.Length > 0) {
                uint written; Check(WriteFile(inputWrite, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length, "Write startup authorization");
              }
              Close(ref inputWrite);
              send("\"type\":\"authorized\",\"requestId\":" + requestId);
            } else if (fields[0] == "stop") {
              sealedAdmission = true; Close(ref inputWrite);
              int timeout; if (fields.Length != 3 || !Int32.TryParse(fields[2], out timeout) || timeout < 0 || timeout > 60000) throw new InvalidDataException("Invalid drain timeout");
              uint active; proven = Drain(job, timeout, out active);
              send("\"type\":\"drain\",\"requestId\":" + requestId + ",\"gone\":" + (proven ? "true" : "false") + ",\"activeProcesses\":" + active);
            } else if (fields[0] == "close") {
              if (!proven || !sealedAdmission) throw new InvalidOperationException("Close requires an open-handle empty proof");
              send("\"type\":\"closed\",\"requestId\":" + requestId); break;
            } else throw new InvalidDataException("Unknown control request");
            read = Task.Factory.StartNew(delegate { return Console.In.ReadLine(); });
          }
        } catch (Exception error) {
          try { send("\"type\":\"failure\",\"diagnosticBase64\":\"" + Diagnostic(error) + "\""); } catch { }
          // A broken control channel is cancellation, never permission or proof.
          if (job != IntPtr.Zero) { try { uint ignored; Drain(job, 10000, out ignored); } catch { } }
        } finally {
          Close(ref inputRead); Close(ref inputWrite); Close(ref childInput); Close(ref childOutput); Close(ref childError);
          Close(ref process.Thread); Close(ref process.Process);
          if (attributesReady) DeleteProcThreadAttributeList(attributes);
          if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
          if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
          if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
          if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
          Close(ref job);
        }
      }
    }
  }
}
'@
$config = ConvertFrom-Json ([Console]::In.ReadLine())
$environment = [string]::Join([char]0, [string[]]@($config.environment)) + [char]0 + [char]0
[PieOwnedTree]::Run($config.pipeName, $config.invocationId, $config.command, [string[]]@($config.args), $config.cwd, $environment)
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;

function milliseconds(value, fallback, name, maximum = 60_000) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new TypeError(`${name} must be an integer from 0 to ${maximum}`);
  return result;
}

function noNul(value, name) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${name} must be a NUL-free string`);
  return value;
}

// Same allowlist as the existing agent-process guardian. Do not forward Node,
// provider, VS Code or arbitrary caller variables into PowerShell/Add-Type.
function guardianEnvironment(source) {
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'temp', 'tmp', 'userprofile', 'localappdata', 'appdata']);
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
  if (Buffer.byteLength(Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join('') + '\0', 'utf16le') > 64 * 1024) {
    throw new Error('Filtered Windows guardian environment exceeds 64 KiB');
  }
  return env;
}

/**
 * Spawn an SDK-independent Windows 10+ owned tree. See windows-owned-tree.md.
 * Child stdin is private; authorizeStartup writes exact UTF-8 text once, then
 * closes it (empty text closes without a zero-length write). Neither root
 * completion nor guardian exit is a tree-empty proof.
 */
export async function spawnWindowsOwnedTree(options) {
  if (process.platform !== 'win32') throw new Error('Windows owned trees require Windows 10 or later');
  const command = noNul(options.command, 'command');
  if (!/^(?:[a-z]:[\\/]|\\\\)/iu.test(command)) throw new TypeError('command must be an absolute executable path (no shell/PATH lookup)');
  const args = (options.args ?? []).map((arg) => noNul(arg, 'argument'));
  const cwd = noNul(options.cwd, 'cwd');
  if (!/^(?:[a-z]:[\\/]|\\\\)/iu.test(cwd)) throw new TypeError('cwd must be absolute');
  const startupTimeoutMs = milliseconds(options.startupTimeoutMs, 15_000, 'startupTimeoutMs');
  const environment = [];
  const keys = new Set();
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value === undefined) continue;
    noNul(key, 'environment key'); noNul(value, 'environment value');
    if (!key || key.includes('=') || keys.has(key.toLowerCase())) throw new TypeError('Child environment keys must be unique (case-insensitive) and contain no equals sign');
    keys.add(key.toLowerCase()); environment.push(`${key}=${value}`);
  }
  // Windows requires case-insensitive Unicode name order, not locale collation
  // (and not full key=value order, which misorders prefix/punctuation keys).
  environment.sort((left, right) => {
    const a = left.slice(0, left.indexOf('=')).toUpperCase();
    const b = right.slice(0, right.indexOf('=')).toUpperCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const guardianEnv = guardianEnvironment(process.env);
  options.signal?.throwIfAborted();
  const invocationId = randomUUID();
  const evidenceDirectory = await mkdtemp(join(tmpdir(), 'pie-windows-owned-tree-'));
  const script = join(evidenceDirectory, 'guardian.ps1');
  await writeFile(script, GUARDIAN, 'utf8');
  const pipeName = `pie-owned-tree-${invocationId}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = createServer();
  let socket;
  let guardian;
  let stderrTail = '';
  const stderr = new Transform({ transform(chunk, encoding, callback) {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16 * 1024);
    callback(null, chunk);
  } });
  let rootPid;
  let lost;
  let proof;
  let sealed = false;
  let authorized = false;
  let requestId = 0;
  let buffer = '';
  let startupResolve;
  let startupReject;
  let resolveCompletion;
  let resolveExit;
  let exited = false;
  const pending = new Map();
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const startup = new Promise((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  // Always installed before a possible asynchronous connection/spawn failure.
  void startup.catch(() => {});
  const record = async (diagnostic) => {
    await writeFile(join(evidenceDirectory, 'diagnostic.json'), JSON.stringify({ invocationId, rootPid, guardianPid: guardian?.pid, diagnostic }, null, 2)).catch(() => {});
  };
  function fail(reason) {
    if (lost) return;
    lost = String(reason);
    startupReject(new Error(lost));
    resolveCompletion({ code: null });
    for (const { reject } of pending.values()) reject(new Error(lost));
    pending.clear();
    void record(lost);
    // Signal EOF even on a protocol failure. Never leave a live helper waiting
    // for a coordinator that has abandoned its control channel.
    guardian?.stdin.end();
  }
  function receive(message) {
    if (message.invocationId !== invocationId) return fail('Guardian invocation mismatch');
    if (message.type === 'ready') {
      if (rootPid || !Number.isSafeInteger(message.rootPid) || message.rootPid <= 0) return fail('Invalid guardian readiness');
      rootPid = message.rootPid; startupResolve(); return;
    }
    if (message.type === 'completion') {
      if (!Number.isSafeInteger(message.code)) return fail('Invalid root completion');
      resolveCompletion({ code: message.code }); return;
    }
    if (message.type === 'failure') return fail(`Guardian failure: ${Buffer.from(message.diagnosticBase64 ?? '', 'base64').toString('utf8')}`);
    const request = pending.get(message.requestId);
    if (!request) return; // A delayed acknowledgement cannot satisfy another request.
    if (message.type !== request.type) return fail('Unexpected guardian response');
    pending.delete(message.requestId);
    request.resolve(message);
  }
  server.on('connection', (candidate) => {
    if (socket) { candidate.destroy(); return; }
    socket = candidate;
    server.close();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return fail('Oversized guardian control frame');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { receive(JSON.parse(line)); } catch (error) { fail(`Invalid guardian response: ${error.message}`); }
      }
    });
    socket.on('error', (error) => fail(`Guardian control error: ${error.message}`));
    socket.on('end', () => {
      // A proven, explicitly requested close may end the control stream before
      // the process exit event. Every other disconnect is uncertain.
      if (!closing) fail('Guardian control channel lost; tree extinction is unknown');
    });
  });
  let closing = false;
  let closePromise;
  let stopPromise;
  let startupTimer;
  const onAbort = () => fail('Windows owned-tree startup aborted');
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath, resolve);
    });
    server.on('error', (error) => fail(`Guardian pipe server error: ${error.message}`));
    guardian = spawn(join(guardianEnv.SystemRoot ?? guardianEnv.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: guardianEnv,
    });
    guardian.stderr.pipe(stderr);
    guardian.on('error', (error) => { fail(`Guardian spawn error: ${error.message}`); if (!guardian.pid) { exited = true; resolveExit(); } });
    guardian.once('exit', (code) => {
      exited = true; resolveExit();
      if (!closing) fail(`Guardian exited (${code}); tree extinction is unknown${rootPid ? '' : `: ${stderrTail}`}`);
      resolveCompletion({ code: null });
    });
    guardian.stdin.on('error', (error) => { if (!closing) fail(`Guardian input error: ${error.message}`); });
    guardian.stdin.write(`${JSON.stringify({ pipeName, invocationId, command, args, cwd, environment })}\n`);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    startupTimer = setTimeout(() => fail(`Windows owned-tree startup timed out after ${startupTimeoutMs} ms`), startupTimeoutMs);
    await startup;
  } catch (error) {
    fail(error.message);
    // EOF lets Add-Type finish and the guardian drain. The atomic JOB_LIST also
    // makes the last-resort hard kill safe at every point of root creation.
    if (guardian) {
      guardian.stdin.end();
      await Promise.race([exit, new Promise((resolve) => { const timer = setTimeout(resolve, 15_000); exit.then(() => clearTimeout(timer)); })]);
      if (!exited) { guardian.kill(); await exit; }
    }
    socket?.destroy(); server.close();
    await record(lost ?? error.message);
    throw Object.assign(new Error(`${lost ?? error.message}; evidence retained at ${evidenceDirectory}`), { evidenceDirectory });
  } finally {
    clearTimeout(startupTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  function request(commandText, type, timeoutMs) {
    if (lost || exited) return Promise.reject(new Error(lost ?? 'Guardian has exited'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Guardian ${type} acknowledgement timed out`));
      }, timeoutMs);
      pending.set(id, {
        type,
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      guardian.stdin.write(`${commandText.replace('{id}', String(id))}\n`, (error) => {
        if (error) fail(`Guardian write failed: ${error.message}`);
      });
    });
  }

  return Object.freeze({
    invocationId, rootPid, guardianPid: guardian.pid, evidenceDirectory,
    stdout: guardian.stdout,
    stderr,
    completion,
    async authorizeStartup(text) {
      noNul(text, 'startup authorization');
      if (Buffer.byteLength(text, 'utf8') > 16384) throw new TypeError('Startup authorization exceeds 16 KiB');
      if (sealed || authorized || closing) throw new Error('Startup admission is sealed or already authorized');
      authorized = true;
      await request(`authorize {id} ${Buffer.from(text, 'utf8').toString('base64')}`, 'authorized', 5_000);
    },
    stopAndDrain({ timeoutMs } = {}) {
      const timeout = milliseconds(timeoutMs, 10_000, 'timeoutMs');
      sealed = true;
      if (proof) return Promise.resolve(proof);
      if (stopPromise) return stopPromise;
      const attempt = (async () => {
        try {
          const response = await request(`stop {id} ${timeout}`, 'drain', timeout + 5_000);
          if (response.gone === true && response.activeProcesses === 0) {
            proof = Object.freeze({ gone: true, activeProcesses: 0, invocationId, rootPid, admissionSealed: true, authority: 'open-windows-job-accounting' });
            return proof;
          }
          const diagnostic = `Job drain did not establish an empty tree (activeProcesses=${response.activeProcesses})`;
          await record(diagnostic);
          return { gone: false, invocationId, rootPid, diagnostic, evidenceDirectory };
        } catch (error) {
          await record(error.message);
          return { gone: false, invocationId, rootPid, diagnostic: error.message, evidenceDirectory };
        }
      })();
      stopPromise = attempt;
      void attempt.finally(() => { if (stopPromise === attempt) stopPromise = undefined; });
      return attempt;
    },
    closeAfterRelease() {
      if (closePromise) return closePromise;
      if (!proof) return Promise.reject(new Error('closeAfterRelease requires a matching tree-empty proof'));
      closePromise = (async () => {
        if (lost || exited) throw new Error(lost ?? 'Guardian exited before release acknowledgement');
        closing = true;
        try {
          await request('close {id}', 'closed', 5_000);
          guardian.stdin.end();
          await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Guardian close timed out')), 5_000); exit.then(() => clearTimeout(timer)); })]);
          socket?.destroy();
          await rm(evidenceDirectory, { recursive: true, force: true });
        } catch (error) {
          guardian.stdin.end();
          if (!exited) guardian.kill();
          await record(error.message);
          throw error;
        }
      })();
      return closePromise;
    },
  });
}
