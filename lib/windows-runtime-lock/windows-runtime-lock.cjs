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

// Process-local qualification assumes mounted volumes remain stable for this process.
// Share successful and in-flight probes by device, but never retain failed probes.
const qualifiedVolumes = new Map();
async function qualifyVolume(dev, physical) {
  let probe = qualifiedVolumes.get(dev);
  if (!probe) {
    probe = probeVolume(physical);
    qualifiedVolumes.set(dev, probe);
    probe.catch(() => {
      if (qualifiedVolumes.get(dev) === probe) qualifiedVolumes.delete(dev);
    });
  }
  await probe;
}

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
  await qualifyVolume(before.dev, physical);
  // Revalidate on every acquisition, including qualification cache hits.
  const afterPhysical = await fs.realpath(root);
  const after = await fs.stat(root, { bigint: true });
  if (physical !== afterPhysical || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Runtime lock root changed during qualification');
  }
  const identity = createHash('sha256').update(`${PROTOCOL}\0${before.dev}\0${before.ino}`).digest('hex');
  return `\\\\.\\pipe\\${PROTOCOL}-${identity}`;
}

async function probeVolume(physical) {
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
}

/**
 * Root must remain present and unrenamed for the entire protected operation.
 * Supports only Windows fixed local NTFS volumes, not remote/removable storage.
 * timeoutMs bounds contention retries (volume qualification has a separate 15s cap).
 * Volume qualification is cached per device assuming stable mounted volumes.
 * Unexpected listener errors are retained and reported by awaited release; they
 * do not close the listener or cancel caller work. Unexpected close is likewise
 * reported by release. Callers must always await release.
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
    let releasing = false;
    server.on('close', () => {
      if (owned && !releasing) failure ||= new Error('Runtime lock listener closed unexpectedly');
    });
    const attempt = await new Promise((resolve, reject) => {
      server.on('error', error => {
        if (!owned) {
          if (error.code === 'EADDRINUSE') resolve(false);
          else reject(error);
        } else {
          // An error alone does not relinquish ownership. Keep listening until
          // awaited release, and preserve the first failure for that boundary.
          failure ||= error;
        }
      });
      server.listen({ path: pipe, exclusive: true }, () => { owned = true; resolve(true); });
    });
    if (attempt) {
      return function release() {
        if (!releasePromise) {
          releasing = true;
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
