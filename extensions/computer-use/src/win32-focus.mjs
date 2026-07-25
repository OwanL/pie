import { execFile } from 'node:child_process';

const WIN32_FOCUS_TIMEOUT_MS = 2200;

function encodedPowerShell(pid, windowId) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PieComputerFocus {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
}
'@
$hwnd = [IntPtr][Int64]${windowId}
$expectedPid = [uint32]${pid}
if (-not [PieComputerFocus]::IsWindow($hwnd)) { Write-Output 'INVALID_WINDOW'; exit 3 }
$actualPid = [uint32]0
$targetThread = [PieComputerFocus]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
if ($actualPid -ne $expectedPid -or $targetThread -eq 0) { Write-Output 'IDENTITY_MISMATCH'; exit 4 }
if ([PieComputerFocus]::IsIconic($hwnd)) { [void][PieComputerFocus]::ShowWindowAsync($hwnd, 9) }
try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$expectedPid) } catch {}
$foreground = [PieComputerFocus]::GetForegroundWindow()
$foregroundPid = [uint32]0
$foregroundThread = if ($foreground -ne [IntPtr]::Zero) { [PieComputerFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) } else { [uint32]0 }
$currentThread = [PieComputerFocus]::GetCurrentThreadId()
$attachedForeground = $false
$attachedTarget = $false
try {
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
    $attachedForeground = [PieComputerFocus]::AttachThreadInput($currentThread, $foregroundThread, $true)
  }
  if ($targetThread -ne $currentThread) {
    $attachedTarget = [PieComputerFocus]::AttachThreadInput($currentThread, $targetThread, $true)
  }
  [void][PieComputerFocus]::BringWindowToTop($hwnd)
  [void][PieComputerFocus]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x43)
  [void][PieComputerFocus]::SetForegroundWindow($hwnd)
  [void][PieComputerFocus]::SetActiveWindow($hwnd)
  [void][PieComputerFocus]::SetFocus($hwnd)
  Start-Sleep -Milliseconds 30
} finally {
  if ($attachedTarget) { [void][PieComputerFocus]::AttachThreadInput($currentThread, $targetThread, $false) }
  if ($attachedForeground) { [void][PieComputerFocus]::AttachThreadInput($currentThread, $foregroundThread, $false) }
}
if ([PieComputerFocus]::GetForegroundWindow() -eq $hwnd) { Write-Output 'FOCUSED'; exit 0 }
Write-Output 'NOT_FOCUSED'
exit 5
`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function focusWindowNative({ pid, windowId, signal, timeoutMs = WIN32_FOCUS_TIMEOUT_MS, execFileImpl = execFile }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Operation aborted'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; reject(error); return;
    }
    execFileImpl(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedPowerShell(pid, windowId)],
      { windowsHide: true, timeout: timeoutMs, signal, encoding: 'utf8' },
      (error, stdout) => {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') { reject(error); return; }
        resolve(!error && String(stdout).includes('FOCUSED'));
      },
    );
  });
}
