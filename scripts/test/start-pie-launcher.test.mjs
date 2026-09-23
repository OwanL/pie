import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const batchPath = path.join(repositoryRoot, 'start-pie.bat');
const supervisorPath = path.join(repositoryRoot, 'scripts', 'start-pie-supervisor.ps1');
const integrationTest = process.platform === 'win32' && process.env.PIE_RUN_INTEGRATION_TESTS === '1'
  ? test
  : test.skip;

async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('timed out waiting for the process-tree precondition');
}

test('start-pie.bat delegates without interpolating the prompted workspace', async () => {
  const source = await readFile(batchPath, 'utf8');
  assert.match(source, /DisableDelayedExpansion/);
  assert.match(source, /-File "%~dp0scripts\\start-pie-supervisor\.ps1" %\*/);
  assert.doesNotMatch(source, /%PIE_CWD%/);
  assert.match(source, /endlocal & exit \/b %PIE_EXIT%/);
});

test('the standalone launcher defaults the trusted-LAN prompt to no and passes either explicit choice', async () => {
  const source = await readFile(supervisorPath, 'utf8');
  assert.match(source, /Enable trusted LAN access\? \[y\/N\]/);
  assert.match(source, /\$answer -match '\^\(\?i:y\|yes\)\$'/);
  assert.match(source, /if \(\$enableLan\) \{ \$standaloneArguments \+= '--lan' \}/);
  assert.match(source, /else \{ \$standaloneArguments \+= '--no-lan' \}/);
  assert.match(source, /\[switch\]\$AllowLan/);
});

test('the supervisor uses suspended Job Object containment and delayed force shutdown', async () => {
  const source = await readFile(supervisorPath, 'utf8');
  const assign = source.indexOf('PieStandaloneNative]::Assign');
  const resume = source.indexOf('PieStandaloneNative]::Resume');
  assert.match(source, /CREATE_SUSPENDED = 0x00000004/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000/);
  assert.match(source, /AssignProcessToJobObject/);
  assert.match(source, /CreateSuspendedProbe/);
  assert.match(source, /TerminateJobObject/);
  assert.ok(assign >= 0 && resume > assign, 'the suspended root must be assigned before it resumes');
  assert.match(source, /CancelKeyPress/);
  assert.match(source, /eventArgs\.Cancel = \$true/);
  assert.match(source, /Run 'npm run extension:build'/);
  assert.match(source, /not a \.cmd\/.bat shim/);
  assert.match(source, /QuoteWindowsArgument/);
  assert.doesNotMatch(source, /\btaskkill(?:\.exe)?\s+[-/]/i);
});

/**
 * This is deliberately a native Windows-only check.  It mirrors the launch
 * handoff used by the supervisor, but runs a tiny Node fixture in an OS temp
 * directory rather than starting Pie or touching the real data/session root.
 * The abrupt PowerShell exit verifies KILL_ON_JOB_CLOSE, while the sentinel
 * and marker file verify that ownership is not implemented as broad PID killing
 * or cleanup of unrelated files.
 */
integrationTest('Windows suspended handoff kills only the owned descendant tree on owner crash', { timeout: 60_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pie-start-pie-job-'));
  const grandchildPidFile = path.join(tempDir, 'grandchild.pid');
  const rootPidFile = path.join(tempDir, 'root.pid');
  const preservedFile = path.join(tempDir, 'preserved.txt');
  const fixturePath = path.join(tempDir, 'job-fixture.ps1');
  const fixture = String.raw`param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$GrandchildPidFile,
  [Parameter(Mandatory = $true)][string]$RootPidFile,
  [Parameter(Mandatory = $true)][string]$PreservedFile
)
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class PieJobFixture {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a; public long b; public uint flags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public Io io; public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] sealed class Startup { public int cb; public string a; public string b; public string c; public int d; public int e; public int f; public int g; public int h; public int i; public int j; public int k; public uint l; public short m; public short n; public IntPtr o; public IntPtr input; public IntPtr output; public IntPtr error; }
  [StructLayout(LayoutKind.Sequential)] public struct Info { public IntPtr process; public IntPtr thread; public uint pid; public uint tid; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string b);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr a, int b, IntPtr c, uint d);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string a, [In,Out] StringBuilder b, IntPtr c, IntPtr d, bool e, uint f, IntPtr g, string h, Startup i, out Info j);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr a, IntPtr b);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr a);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr a);
  static string Q(string s) { var b = new StringBuilder(); var n = 0; b.Append('"'); foreach (var c in s) { if (c == '\\') { n++; continue; } if (c == '"') { b.Append('\\', n * 2 + 1); b.Append('"'); n = 0; continue; } b.Append('\\', n); b.Append(c); n = 0; } b.Append('\\', n * 2); b.Append('"'); return b.ToString(); }
  public static IntPtr Job() { var j = CreateJobObject(IntPtr.Zero, null); var x = new Extended(); x.basic.flags = 0x2000; var n = Marshal.SizeOf(typeof(Extended)); var p = Marshal.AllocHGlobal(n); try { Marshal.StructureToPtr(x, p, false); if (!SetInformationJobObject(j, 9, p, (uint)n)) throw new Win32Exception(Marshal.GetLastWin32Error()); return j; } finally { Marshal.FreeHGlobal(p); } }
  public static Info Start(string exe, string[] args) { var s = new Startup(); s.cb = Marshal.SizeOf(typeof(Startup)); var c = new StringBuilder(Q(exe)); foreach (var a in args) { c.Append(' '); c.Append(Q(a)); } Info i; if (!CreateProcess(exe, c, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero, null, s, out i)) throw new Win32Exception(Marshal.GetLastWin32Error()); return i; }
  public static void Assign(IntPtr j, IntPtr p) { if (!AssignProcessToJobObject(j, p)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Resume(IntPtr t) { if (ResumeThread(t) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Close(IntPtr h) { if (h != IntPtr.Zero) CloseHandle(h); }
}
'@
$job = [PieJobFixture]::Job()
$code = "const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.env.PIE_TEST_PIDFILE,String(c.pid));setInterval(()=>{},1000)"
$info = [PieJobFixture]::Start($NodePath, @('-e', $code))
try {
  [PieJobFixture]::Assign($job, $info.process)
  [PieJobFixture]::Resume($info.thread)
  [PieJobFixture]::Close($info.thread)
  Set-Content -LiteralPath $RootPidFile -Value $info.pid -NoNewline
  Set-Content -LiteralPath $PreservedFile -Value 'must survive' -NoNewline
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $GrandchildPidFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 25 }
  if (-not (Test-Path -LiteralPath $GrandchildPidFile)) { throw 'grandchild did not publish its pid' }
  [System.Diagnostics.Process]::GetCurrentProcess().Kill()
} finally {
  [PieJobFixture]::Close($info.process)
  [PieJobFixture]::Close($job)
}
`;
  await writeFile(fixturePath, fixture, 'utf8');
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const fixtureProcess = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fixturePath,
    '-NodePath', process.execPath,
    '-GrandchildPidFile', grandchildPidFile,
    '-RootPidFile', rootPidFile,
    '-PreservedFile', preservedFile,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PIE_TEST_PIDFILE: grandchildPidFile },
  });
  let fixtureStdout = '';
  let fixtureStderr = '';
  fixtureProcess.stdout.setEncoding('utf8');
  fixtureProcess.stdout.on('data', (chunk) => { fixtureStdout += chunk; });
  fixtureProcess.stderr.setEncoding('utf8');
  fixtureProcess.stderr.on('data', (chunk) => { fixtureStderr += chunk; });
  const fixtureClosed = new Promise((resolve) => fixtureProcess.once('close', resolve));
  try {
    try {
      await waitFor(async () => (await access(grandchildPidFile).then(() => true).catch(() => false)));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; fixture stdout: ${fixtureStdout}; fixture stderr: ${fixtureStderr}`);
    }
    const grandchildPid = Number(await readFile(grandchildPidFile, 'utf8'));
    assert.ok(grandchildPid > 0);
    await fixtureClosed;
    await waitFor(async () => !(await isAlive(grandchildPid)));
    assert.equal(await isAlive(sentinel.pid), true, 'the unrelated sentinel must survive owner crash');
    assert.equal(await readFile(preservedFile, 'utf8'), 'must survive');
  } finally {
    if (!fixtureProcess.killed) fixtureProcess.kill();
    if (await isAlive(sentinel.pid)) sentinel.kill();
    await rm(tempDir, { recursive: true, force: true });
  }
});
