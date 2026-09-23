import { access as fsAccess, constants, realpath as fsRealpath } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(nodeExecFile);
const MAX_LINK_DEPTH = 5;
const SAFE_EXECUTABLE_EXTENSIONS = new Set(['.exe']);

function runtimeError(code, message, retryable = false) {
  const error = new Error(message); error.code = code; error.retryable = retryable; return error;
}

function hasPathSeparator(input) {
  return input.includes('/') || input.includes('\\');
}

function extensionOf(filePath) {
  return path.extname(filePath).toLowerCase();
}

async function resolveShortcut(linkPath, deps) {
  const escaped = String(linkPath).replace(/'/g, "''");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut('${escaped}')
  Write-Output $shortcut.TargetPath
} catch {
  Write-Output ''
}`;
  const { stdout } = await deps.execFile('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const target = String(stdout || '').trim();
  if (!target) throw runtimeError('LAUNCH_UNRESOLVED', `Shortcut '${linkPath}' does not resolve to a target executable.`);
  return target;
}

async function searchPath(name, deps) {
  const pathEnv = String(deps.env?.PATH ?? '');
  const pathExtRaw = String(deps.env?.PATHEXT ?? '.EXE');
  const extensions = extensionOf(name)
    ? ['']
    : pathExtRaw.split(';').filter((ext) => SAFE_EXECUTABLE_EXTENSIONS.has(ext.toLowerCase()));
  const directories = pathEnv.split(';').filter(Boolean);
  for (const dir of directories) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try { await deps.access(candidate); return candidate; } catch {}
    }
  }
  return undefined;
}

export async function resolveLaunchExecutable(input, deps = {}) {
  const real = {
    access: (p) => fsAccess(p, constants.F_OK),
    realpath: fsRealpath,
    execFile: execFileAsync,
    env: process.env,
    ...deps,
  };
  return resolveWith(input, real, 0);
}

async function resolveWith(input, deps, depth) {
  if (typeof input !== 'string' || input.trim() === '') throw runtimeError('LAUNCH_UNRESOLVED', 'Launch path is empty.');
  if (depth > MAX_LINK_DEPTH) throw runtimeError('LAUNCH_UNRESOLVED', `Launch path '${input}' resolves through too many links to determine a native executable.`);
  let resolved = input;
  if (!hasPathSeparator(resolved)) {
    const found = await searchPath(resolved, deps);
    if (!found) throw runtimeError('LAUNCH_UNRESOLVED', `Could not find '${input}' on PATH. Provide the absolute path to the native executable (.exe).`);
    resolved = found;
  }
  try { resolved = await deps.realpath(resolved); }
  catch { throw runtimeError('LAUNCH_UNRESOLVED', `Launch path '${input}' does not exist or is not accessible.`); }
  const ext = extensionOf(resolved);
  if (SAFE_EXECUTABLE_EXTENSIONS.has(ext)) return resolved;
  if (ext === '.lnk') {
    const target = await resolveShortcut(resolved, deps);
    return resolveWith(target, deps, depth + 1);
  }
  throw runtimeError('LAUNCH_UNRESOLVED', `Launch path '${input}' resolved to '${resolved}', which is not a native executable (.exe). Shell wrappers, scripts, and non-executable links cannot be correlated by PID/HWND; provide the native .exe path.`);
}
