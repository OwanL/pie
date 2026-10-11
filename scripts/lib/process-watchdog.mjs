import { spawnSync } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import process from 'node:process';

export const DEFAULT_CHILD_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_GRACEFUL_TERMINATION_MS = 500;
export const DEFAULT_FORCED_TERMINATION_MS = 5_000;
const CHILD_PROCESS_TIMEOUT_ENV = 'PIE_TEST_PROCESS_TIMEOUT_MS';

/** Resolve the per-child test/typecheck watchdog. `0` explicitly disables it. */
export function resolveChildProcessTimeoutMs(raw = process.env[CHILD_PROCESS_TIMEOUT_ENV]) {
  if (raw === undefined || raw === '') return DEFAULT_CHILD_PROCESS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CHILD_PROCESS_TIMEOUT_MS;
  return parsed;
}

/** Spawn options required for recursive process-group termination on Unix. */
export function withProcessTreeIsolation(options, platform = process.platform) {
  return { ...options, detached: platform !== 'win32' };
}

function queryProcessRows(platform = process.platform, spawnSyncImpl = spawnSync, rootPid, timeoutMs = 5_000) {
  const unavailable = (reason) => ({ rows: [], available: false, reason });
  try {
    if (platform === 'win32') {
      // Local WMI avoids CIM module/transport startup and projects only the
      // three ownership fields (not command lines or executable paths). Keep
      // CreationDate in its raw DMTF form: PowerShell's DateTime formatting is
      // culture-dependent and discards the provider's sub-second precision.
      const filter = Number.isInteger(rootPid) && rootPid > 0 ? ` WHERE ProcessId=${rootPid}` : '';
      const script = `$ErrorActionPreference='Stop'; $q=[wmisearcher]'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process${filter}'; try { foreach ($p in $q.Get()) { '{0}|{1}|{2}' -f $p.ProcessId,$p.ParentProcessId,$p.CreationDate } } finally { $q.Dispose() }`;
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result?.status !== 0 || typeof result?.stdout !== 'string') {
        const detail = result?.error?.message ?? `status ${String(result?.status)}`;
        return unavailable(detail);
      }
      const rows = result.stdout.split(/\r?\n/u).flatMap((line) => {
        const [pid, ppid, rawCreationDate] = line.trim().split('|');
        if (!(Number(pid) > 0)) return [];
        const creationDate = rawCreationDate?.trim() || null;
        return [{ pid: Number(pid), ppid: Number(ppid), identity: creationDate, creationDate }];
      });
      return { rows, available: true, reason: null };
    }
    const result = spawnSyncImpl('ps', ['-e', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result?.status !== 0 || typeof result?.stdout !== 'string') {
      const detail = result?.error?.message ?? `status ${String(result?.status)}`;
      return unavailable(detail);
    }
    const rows = result.stdout.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] }] : [];
    });
    return { rows, available: true, reason: null };
  } catch (error) {
    return unavailable(error?.message ?? String(error));
  }
}

function processRows(platform = process.platform, spawnSyncImpl = spawnSync) {
  return queryProcessRows(platform, spawnSyncImpl).rows;
}

/** Capture the owned ancestry before termination, including process identities. */
function captureProcessTree(rootPid, options = {}) {
  if (options.platform === 'win32' && options.child) return captureWindowsOwnership(options.child, options);
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { owned: [], enumeration: { available: true } };
  const enumeration = queryProcessRows(options.platform, options.spawnSyncImpl);
  const rows = enumeration.rows;
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid) ?? { pid: rootPid, ppid: 0, identity: null };
  const owned = [root];
  for (let cursor = 0; cursor < owned.length; cursor += 1) {
    owned.push(...(children.get(owned[cursor].pid) ?? []));
  }
  return { owned, enumeration };
}

export function snapshotProcessTree(rootPid, options = {}) {
  return captureProcessTree(rootPid, options).owned;
}

const windowsOwnership = new WeakMap();
const windowsUnprovenOwnership = new WeakMap();
const windowsOwnershipUncertain = new WeakSet();

function windowsBirth(identity) {
  const match = identity?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/u);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offset] = match;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)
    + Number(fraction) / 1000 - (sign === '+' ? 1 : -1) * Number(offset) * 60_000;
}

function childClosed(child) {
  return child.exitCode != null || child.signalCode != null;
}

// One census plus a targeted post-census root check brackets live capture.
// The check observes the root after all ancestry rows, not an early root row
// from another non-atomic global census. No periodic polling.
function captureWindowsOwnership(child, options) {
  const pid = child.pid;
  const retained = windowsOwnership.get(child) ?? [];
  const retainedUnknown = windowsUnprovenOwnership.get(child) ?? [];
  const beforeClosed = childClosed(child);
  const captureDeadline = Date.now() + 5_000;
  const first = options.enumeration ?? queryProcessRows('win32', options.spawnSyncImpl);
  const firstRoot = first.rows.find((row) => row.pid === pid);
  const remainingMs = captureDeadline - Date.now();
  const verification = !options.enumeration && !beforeClosed && firstRoot?.identity != null
    ? remainingMs > 0
      ? queryProcessRows('win32', options.spawnSyncImpl, pid, remainingMs)
      : { rows: [], available: false, reason: 'ownership capture budget exhausted' }
    : first;
  const enumeration = { ...first, available: first.available && verification.available,
    reason: first.reason ?? verification.reason };
  const root = verification.rows.find((row) => row.pid === pid);
  const retainedRoot = retained.find((row) => row.pid === pid);
  const consistent = !options.enumeration && first.available && enumeration.available && !beforeClosed && !childClosed(child)
    && firstRoot?.identity != null && root?.identity === firstRoot.identity
    && (!retainedRoot || root.identity === retainedRoot.identity);
  if (!enumeration.available) windowsOwnershipUncertain.add(child);
  const proven = new Map(retained.map((row) => [row.pid, row]));
  if (consistent) proven.set(pid, firstRoot);
  const rootBirth = windowsBirth(retainedRoot?.identity ?? (consistent ? root.identity : null));
  const pending = [firstRoot ?? { pid, ppid: 0, identity: null }];
  const seen = new Set([pid]);
  const unknown = [];
  // A reused root's new tree is not this ChildProcess's ancestry at all.
  const reused = retainedRoot?.identity != null && firstRoot?.identity != null && retainedRoot.identity !== firstRoot.identity;
  {
    if (reused) pending.length = 0;
    for (const entry of retained) {
      const now = enumeration.rows.find((row) => row.pid === entry.pid);
      if (!seen.has(entry.pid) && (!now || now.identity === entry.identity)) {
        pending.push(entry);
        seen.add(entry.pid);
      }
    }
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const parent = pending[cursor];
      for (const entry of enumeration.rows.filter((row) => row.ppid === parent.pid)) {
        if (seen.has(entry.pid)) continue;
        seen.add(entry.pid);
        const birth = windowsBirth(entry.identity);
        const parentBirth = windowsBirth(proven.get(parent.pid)?.identity);
        // Birth can exclude impossible stale PPID links, never establish
        // ownership of an unseen child after the root has exited.
        if (birth != null && rootBirth != null && birth < rootBirth) continue;
        if (birth != null && parentBirth != null && birth < parentBirth) continue;
        const prior = proven.get(entry.pid);
        // A replacement for a retained generation is not an unknown leak.
        // Do not follow its numeric descendants or replace the retained proof.
        if (prior?.identity != null && entry.identity != null && prior.identity !== entry.identity) continue;
        pending.push(entry);
        if (prior?.identity === entry.identity) continue;
        if (consistent && parentBirth != null && birth != null && birth >= parentBirth) proven.set(entry.pid, entry);
        else unknown.push(entry);
      }
    }
  }
  const owned = [...proven.values()];
  windowsOwnership.set(child, owned);
  if (!proven.has(pid)) unknown.unshift(firstRoot ?? { pid, ppid: 0, identity: null });
  // Once a live census exposed an unproven candidate, a later census cannot
  // prove that candidate extinct: it may have escaped by reparenting. Retain
  // the evidence and uncertainty, but never promote it to a killable identity.
  const observedUnknown = unknown.filter((entry) => enumeration.rows.some((row) => row.pid === entry.pid));
  const unresolved = [...retainedUnknown];
  for (const entry of observedUnknown) {
    if (!unresolved.some((prior) => prior.pid === entry.pid && prior.identity === entry.identity)) unresolved.push(entry);
  }
  if (observedUnknown.length > 0) windowsOwnershipUncertain.add(child);
  windowsUnprovenOwnership.set(child, unresolved);
  for (const entry of retainedUnknown) {
    if (!unknown.some((prior) => prior.pid === entry.pid && prior.identity === entry.identity)) unknown.push(entry);
  }
  return { owned, unknown, enumeration, ownershipUnknown: windowsOwnershipUncertain.has(child) };
}

function isAlive(pid, killImpl = process.kill) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForExtinction(entries, timeoutMs, killImpl) {
  const deadline = Date.now() + timeoutMs;
  let survivors = entries.filter((entry) => isAlive(entry.pid, killImpl));
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    survivors = survivors.filter((entry) => isAlive(entry.pid, killImpl));
  }
  return survivors;
}

function taskkill(pid, force, spawnSyncImpl, timeoutMs) {
  // /T follows numeric PPIDs, including stale links and unproven generations.
  return spawnSyncImpl('taskkill', [...(force ? ['/F'] : []), '/PID', String(pid)], {
    windowsHide: true, stdio: 'ignore', timeout: timeoutMs,
  });
}

/**
 * Terminate one explicitly-owned process tree and verify the captured identities
 * disappear. POSIX children are dedicated process-group leaders. Windows uses
 * individually identity-checked taskkill because numeric /T ancestry is unsafe.
 * Cleanup is bounded: graceful termination is followed by forced termination.
 */
export async function terminateProcessTree(child, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  killImpl = process.kill,
  gracefulMs = DEFAULT_GRACEFUL_TERMINATION_MS,
  forceMs = DEFAULT_FORCED_TERMINATION_MS,
} = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { gone: true, survivors: [], ownedPids: [], ownedProcesses: [], survivorProcesses: [], diagnostics: [] };
  }
  const capture = captureProcessTree(pid, { platform, spawnSyncImpl, child });
  const owned = capture.owned;
  const unknown = capture.unknown ?? [];
  const diagnostics = [];
  let finalEnumerationAvailable = true;
  if (platform === 'win32' && !capture.enumeration.available) {
    diagnostics.push(`Windows process enumeration failed while capturing ownership (${capture.enumeration.reason}); descendant ownership is unknown`);
  }
  if (capture.ownershipUnknown) {
    diagnostics.push('Windows descendant ownership remains unknown after a failed live capture');
  }
  if (platform === 'win32' && unknown.length > 0) {
    diagnostics.push('Windows process ownership is unverified for uncaptured generations; taskkill skipped for unknown PIDs');
  }
  if (platform === 'win32' && childClosed(child) && owned.length === 0
    && capture.enumeration.rows.some((entry) => entry.pid === pid)) {
    diagnostics.push(`Windows root PID ${pid} was present in the initial snapshot after its ChildProcess closed; captured tree ownership is unverified and taskkill skipped`);
    return {
      gone: false,
      survivors: unknown.map((entry) => entry.pid),
      ownedPids: [],
      ownedProcesses: [],
      survivorProcesses: unknown.map((entry) => ({ ...entry })),
      diagnostics,
    };
  }

  try {
    if (platform === 'win32') {
      // Windows has no safe Node API for gracefully signalling an npm/cmd tree:
      // non-forced taskkill can broadcast console termination beyond it. Give
      // the owned tree a bounded natural-exit window, then use /T /F below.
    } else {
      killImpl(-pid, 'SIGTERM');
    }
  } catch (error) {
    diagnostics.push(`graceful termination failed: ${error?.message ?? error}`);
  }

  let survivors = await waitForExtinction([...owned, ...unknown], gracefulMs, killImpl);
  if (survivors.length > 0) {
    let forceDeadline;
    try {
      if (platform === 'win32') {
        const enumeration = queryProcessRows(platform, spawnSyncImpl);
        if (!enumeration.available) {
          diagnostics.push(`Windows process enumeration failed before forced termination (${enumeration.reason}); taskkill skipped for all PIDs`);
          if (owned[0]?.identity == null) {
            diagnostics.push(`Windows root PID ${pid} has no captured creation identity to verify`);
          }
        } else {
          const observed = captureWindowsOwnership(child, { enumeration });
          for (const entry of observed.unknown) {
            if (!survivors.some((row) => row.pid === entry.pid) && isAlive(entry.pid, killImpl)) {
              survivors.push(entry);
              diagnostics.push(`Windows PID ${entry.pid} has unverified descendant ownership; taskkill skipped`);
            }
          }
          const current = new Map(enumeration.rows.map((row) => [row.pid, row]));
          const rootEntry = owned.find((entry) => entry.pid === pid);
          const root = current.get(pid);
          const rootMatches = rootEntry?.identity != null && root?.identity != null && root.identity === rootEntry.identity;
          if (!rootMatches && rootEntry?.identity == null) {
            diagnostics.push(`Windows root PID ${pid} has no captured creation identity; taskkill skipped`);
          } else if (root?.identity == null) {
            diagnostics.push(`Windows root PID ${pid} has no current creation identity; taskkill skipped`);
          } else if (!rootMatches) {
            diagnostics.push(`Windows root PID ${pid} was reused (captured ${rootEntry.identity}, current ${root.identity}); root tree taskkill skipped`);
          }

          {
            // Kill only individually proven generations, never numeric trees.
            forceDeadline = Date.now() + forceMs;
            for (const entry of [...survivors].reverse()) {
              if (!owned.includes(entry)) continue;
              const now = current.get(entry.pid);
              if (entry.identity != null && now?.identity != null && now.identity === entry.identity) {
                const remainingMs = forceDeadline - Date.now();
                if (remainingMs <= 0) {
                  diagnostics.push('Windows forced termination budget exhausted; remaining taskkill calls skipped');
                  break;
                }
                taskkill(entry.pid, true, spawnSyncImpl, remainingMs);
              } else if (entry.identity == null) {
                diagnostics.push(`Windows survivor PID ${entry.pid} has no captured creation identity; taskkill skipped`);
              } else if (now?.identity == null) {
                diagnostics.push(`Windows survivor PID ${entry.pid} has no current creation identity; taskkill skipped`);
              } else {
                diagnostics.push(`Windows survivor PID ${entry.pid} was reused (captured ${entry.identity}, current ${now.identity}); taskkill skipped`);
              }
            }
          }
        }
      } else {
        const current = new Map(processRows(platform, spawnSyncImpl).map((row) => [row.pid, row]));
        const identityStillOwned = survivors.some((entry) => {
          const now = current.get(entry.pid);
          return now && entry.identity && now.identity === entry.identity;
        });
        if (current.size === 0 || identityStillOwned) killImpl(-pid, 'SIGKILL');
        else diagnostics.push('forced group kill skipped because captured identities were gone');
      }
    } catch (error) {
      diagnostics.push(`forced termination failed: ${error?.message ?? error}`);
    }
    if (platform !== 'win32') {
      try { child.kill?.('SIGKILL'); } catch {}
    }
    survivors = await waitForExtinction(survivors, forceDeadline == null ? forceMs : Math.max(0, forceDeadline - Date.now()), killImpl);
  }
  if (platform === 'win32') {
      const verification = queryProcessRows(platform, spawnSyncImpl);
      if (!verification.available) {
        finalEnumerationAvailable = false;
        diagnostics.push(`Windows process enumeration failed during final identity verification (${verification.reason}); live PIDs remain unconfirmed`);
      } else {
        const observed = captureWindowsOwnership(child, { enumeration: verification });
        for (const entry of observed.unknown) {
          if (!survivors.some((row) => row.pid === entry.pid) && isAlive(entry.pid, killImpl)) {
            survivors.push(entry);
            diagnostics.push(`Windows PID ${entry.pid} has unverified descendant ownership in the final census`);
          }
        }
        const current = new Map(verification.rows.map((row) => [row.pid, row]));
        survivors = survivors.filter((entry) => {
          if (!isAlive(entry.pid, killImpl)) return false;
          const now = current.get(entry.pid);
          // A successful census proves a captured identity absent even if a
          // later PID probe is live (e.g. PID reuse after the census).
          // This is distinct from a present row lacking CreationDate, which
          // remains unknown; failed initial capture also remains fail-closed.
          if (owned.includes(entry) && entry.identity != null && !now) {
            diagnostics.push(`Windows captured PID ${entry.pid} identity ${entry.identity} is absent from the final process census`);
            return false;
          }
          if (owned.includes(entry) && entry.identity != null && now?.identity != null && now.identity !== entry.identity) {
            diagnostics.push(`Windows captured PID ${entry.pid} identity ${entry.identity} is gone; current PID identity is ${now.identity}`);
            return false;
          }
          if (entry.identity == null) {
            diagnostics.push(`Windows PID ${entry.pid} remains alive but its captured creation identity is unknown`);
          } else if (now?.identity == null) {
            diagnostics.push(`Windows PID ${entry.pid} remains alive but its current creation identity is unknown`);
          }
          return true;
        });
      }
  }

  return {
    gone: survivors.length === 0 && finalEnumerationAvailable && !capture.ownershipUnknown && !(platform === 'win32' && !capture.enumeration.available),
    survivors: survivors.map((entry) => entry.pid),
    ownedPids: owned.map((entry) => entry.pid),
    ownedProcesses: owned.map((entry) => ({ ...entry })),
    survivorProcesses: survivors.map((entry) => ({ ...entry })),
    diagnostics,
  };
}

/** Backward-compatible trigger. The returned promise settles after verification. */
export function killProcessTree(child, options) {
  return terminateProcessTree(child, options);
}

/** Attach a bounded timeout and optional parent AbortSignal to a spawned child. */
export function watchChildProcess(child, {
  timeoutMs = resolveChildProcessTimeoutMs(), signal, label = 'child process',
  killTree = killProcessTree, onTerminate,
  platform = process.platform, spawnSyncImpl = spawnSync,
  killImpl = process.kill, gracefulMs = DEFAULT_GRACEFUL_TERMINATION_MS,
  forceMs = DEFAULT_FORCED_TERMINATION_MS,
} = {}) {
  const startedAt = Date.now();
  // Capture once while the root is live; retain proven generations through
  // close so cleanup can identify genuine leaks without inferring ancestry.
  if (platform === 'win32' && killTree === killProcessTree && Number.isInteger(child?.pid)) {
    captureWindowsOwnership(child, { spawnSyncImpl });
  }
  let timedOut = false;
  let aborted = false;
  let terminationStarted = false;
  let termination = Promise.resolve({ gone: true, survivors: [] });
  let timer;

  const terminate = (reason) => {
    if (terminationStarted) return termination;
    terminationStarted = true;
    timedOut = reason === 'timeout';
    aborted = reason === 'abort';
    if (reason !== 'settle') try { onTerminate?.({ reason, label, timeoutMs }); } catch {}
    try { termination = Promise.resolve(killTree(child, { platform, spawnSyncImpl, killImpl, gracefulMs, forceMs })); }
    catch (error) { termination = Promise.reject(error); }
    return termination;
  };
  const onAbort = () => { void terminate('abort'); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0 && !terminationStarted) timer = setTimeout(() => { void terminate('timeout'); }, Math.max(1, timeoutMs - (Date.now() - startedAt)));

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    signal?.removeEventListener('abort', onAbort);
  };
  return {
    get timedOut() { return timedOut; },
    get aborted() { return aborted; },
    get terminationStarted() { return terminationStarted; },
    cleanup,
    async settle() {
      cleanup();
      if (!terminationStarted) terminate('settle');
      return termination;
    },
  };
}

/** Abort all active child watchdogs when the runner receives Ctrl+C/termination. */
export function abortOnProcessSignals(target = process, platform = process.platform) {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  const handlers = new Map();
  const events = platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const event of events) {
    const handler = () => controller.abort(new Error(`test runner received ${event}`));
    handlers.set(event, handler);
    target.once(event, handler);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [event, handler] of handlers) target.removeListener(event, handler);
      handlers.clear();
    },
  };
}
