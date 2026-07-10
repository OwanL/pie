import { execFile } from 'node:child_process';

export interface SessionCompletionEvent {
  sessionPath: string;
}

export interface CompletionNotificationPolicy {
  suppressNotifications: boolean;
  windowFocused: boolean;
}

export interface CompletionTabAttentionPolicy {
  suppressNotifications: boolean;
  sessionIsActive: boolean;
}

export function shouldShowCompletionNotification(policy: CompletionNotificationPolicy): boolean {
  if (policy.suppressNotifications) {
    return false;
  }

  return !policy.windowFocused;
}

export function shouldFlashFinishedTab(policy: CompletionTabAttentionPolicy): boolean {
  if (policy.suppressNotifications) {
    return false;
  }

  return !policy.sessionIsActive;
}

function escapePowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsFlashScript(appName: string, workspaceName?: string): string {
  const trimmedWorkspaceName = workspaceName?.trim();
  const appNameLiteral = escapePowerShellSingleQuoted(appName.trim() || 'Visual Studio Code');
  const workspaceNameLiteral = trimmedWorkspaceName
    ? escapePowerShellSingleQuoted(trimmedWorkspaceName)
    : '$null';

  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class PiWindowFlash {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  public struct FLASHWINFO {',
    '    public uint cbSize;',
    '    public IntPtr hwnd;',
    '    public uint dwFlags;',
    '    public uint uCount;',
    '    public uint dwTimeout;',
    '  }',
    '  [DllImport("user32.dll")]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);',
    '}',
    '"@',
    `$appName = ${appNameLiteral}`,
    `$workspaceName = ${workspaceNameLiteral}`,
    "$windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.Contains($appName) }",
    "if (-not $windows) { $windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like 'Code*' } }",
    "$windows = @($windows)",
    "$workspaceScoped = $null",
    "if ($workspaceName) { $workspaceScoped = @($windows | Where-Object { $_.MainWindowTitle.Contains($workspaceName) }) }",
    'if ($workspaceScoped -and $workspaceScoped.Count -gt 0) { $windows = $workspaceScoped }',
    'foreach ($window in $windows) {',
    "  $info = New-Object PiWindowFlash+FLASHWINFO",
    "  $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'PiWindowFlash+FLASHWINFO')",
    '  $info.hwnd = [IntPtr]$window.MainWindowHandle',
    '  $info.dwFlags = 0x00000003',
    '  $info.uCount = 3',
    '  $info.dwTimeout = 0',
    '  [PiWindowFlash]::FlashWindowEx([ref]$info) | Out-Null',
    '}',
  ].join('\n');
}

/**
 * Best-effort window attention request. VS Code does not expose a direct
 * extension API for flashing the app window, so on Windows we shell out to a
 * tiny PowerShell snippet that asks the OS to flash matching VS Code windows.
 */
export function requestWindowAttention(appName: string, workspaceName?: string): void {
  if (process.platform !== 'win32') {
    return;
  }

  const script = buildWindowsFlashScript(appName, workspaceName);
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 5_000 },
    () => undefined,
  );
}
