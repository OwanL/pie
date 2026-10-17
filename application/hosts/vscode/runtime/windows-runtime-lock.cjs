'use strict';

const fs = require('node:fs/promises');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

// Standalone protocol: do not include application versions or publication namespaces.
const PROTOCOL = 'pie-windows-runtime-lock-v1';
const queryVolume = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RuntimeLockVolume {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumePathName(string p, StringBuilder v, uint n);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string p);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumeInformation(string p, StringBuilder name, uint n, out uint serial, out uint max, out uint flags, StringBuilder fs, uint size);
}
'@
$v = New-Object System.Text.StringBuilder 32768
if (-not [RuntimeLockVolume]::GetVolumePathName($env:PIE_LOCK_ROOT, $v, 32768)) { exit 2 }
if ([RuntimeLockVolume]::GetDriveType($v.ToString()) -ne 3) { exit 3 }
$f = New-Object System.Text.StringBuilder 256
[uint32]$s=0; [uint32]$m=0; [uint32]$flags=0
if (-not [RuntimeLockVolume]::GetVolumeInformation($v.ToString(), $null, 0, [ref]$s, [ref]$m, [ref]$flags, $f, 256)) { exit 4 }
if ($f.ToString() -ne 'NTFS') { exit 5 }
Write-Output 'local-fixed-ntfs'
`;

async function pipeForRoot(root) {
  if (process.platform !== 'win32') throw new Error('Runtime lock requires Windows');
  if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root)) {
    throw new Error('Runtime lock requires an absolute local drive path');
  }
  const physical = await fs.realpath(root);
  if (!/^[a-z]:\\/i.test(physical)) throw new Error('Unsupported runtime lock storage path');
  const before = await fs.stat(physical, { bigint: true });
  if (!before.isDirectory() || before.ino === 0n || before.dev === 0n) {
    throw new Error('Runtime lock requires an existing physical directory identity');
  }
  // Path syntax alone cannot establish locality or filesystem semantics. Qualify
  // through Windows volume APIs; unsupported storage fails closed, with no fallback.
  const { stdout } = await promisify(execFile)(
    `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(queryVolume, 'utf16le').toString('base64')],
    {
      windowsHide: true, timeout: 15000,
      // Add-Type's compiler rejects large inherited VS Code environments. This
      // probe needs only Windows/temp lookup state, never provider credentials.
      env: Object.fromEntries([
        ...Object.entries(process.env).filter(([key, value]) => value !== undefined
          && /^(systemroot|windir|systemdrive|comspec|temp|tmp|userprofile|localappdata|appdata)$/i.test(key)),
        ['PIE_LOCK_ROOT', physical],
      ]),
    },
  );
  if (stdout.trim() !== 'local-fixed-ntfs') throw new Error('Unsupported runtime lock volume');
  const after = await fs.stat(root, { bigint: true });
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Runtime lock root changed during qualification');
  }
  const identity = createHash('sha256').update(`${PROTOCOL}\0${before.dev}\0${before.ino}`).digest('hex');
  return `\\\\.\\pipe\\${PROTOCOL}-${identity}`;
}

/**
 * Root must remain present and unrenamed for the entire protected operation.
 * Supports only Windows fixed local NTFS volumes, not remote/removable storage.
 * timeoutMs bounds contention retries (volume qualification has a separate 15s cap).
 * An unexpected owned-server error is thrown asynchronously: the owner must not
 * suppress uncaught exceptions and continue protected work. This function cannot
 * cancel arbitrary caller work; release also rejects if ownership was compromised.
 */
async function acquireWindowsRuntimeLock(root, { timeoutMs = 30000, retryMs = 50 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new TypeError('Invalid runtime lock retry bounds');
  }
  const pipe = await pipeForRoot(root);
  const deadline = performance.now() + timeoutMs;
  let firstAttempt = true;
  for (;;) {
    if (!firstAttempt && performance.now() >= deadline) {
      const error = new Error('Timed out acquiring Windows runtime lock');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    firstAttempt = false;
    const server = net.createServer(socket => socket.destroy());
    let owned = false;
    let failure;
    let releasePromise;
    const attempt = await new Promise((resolve, reject) => {
      server.on('error', error => {
        if (!owned) {
          if (error.code === 'EADDRINUSE') resolve(false);
          else reject(error);
        } else {
          failure = error;
          // Retain the handler for the entire server lifetime; do not silently
          // convert loss of authority into apparent success.
          queueMicrotask(() => { throw error; });
        }
      });
      server.listen({ path: pipe, exclusive: true }, () => { owned = true; resolve(true); });
    });
    if (attempt) {
      return function release() {
        if (!releasePromise) {
          releasePromise = new Promise((resolve, reject) => {
            server.close(error => {
              if (failure || error) reject(failure || error);
              else resolve();
            });
          });
        }
        return releasePromise;
      };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const error = new Error('Timed out acquiring Windows runtime lock');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    await delay(Math.min(retryMs, remaining));
  }
}

module.exports = { acquireWindowsRuntimeLock };
