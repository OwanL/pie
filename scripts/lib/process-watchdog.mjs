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

function processRows(platform = process.platform, spawnSyncImpl = spawnSync) {
  try {
    if (platform === 'win32') {
      // Deliberately query only identity and ancestry: never inspect command lines.
      const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate }";
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result?.status !== 0 || typeof result?.stdout !== 'string') return [];
      return result.stdout.split(/\r?\n/u).flatMap((line) => {
        const [pid, ppid, identity] = line.trim().split('|');
        return Number(pid) > 0 ? [{ pid: Number(pid), ppid: Number(ppid), identity }] : [];
      });
    }
    const result = spawnSyncImpl('ps', ['-e', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result?.status !== 0 || typeof result?.stdout !== 'string') return [];
    return result.stdout.split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] }] : [];
    });
  } catch {
    return [];
  }
}

/** Capture the owned ancestry before termination, including process identities. */
export function snapshotProcessTree(rootPid, options = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const rows = processRows(options.platform, options.spawnSyncImpl);
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
  return owned;
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
  return spawnSyncImpl('taskkill', ['/T', ...(force ? ['/F'] : []), '/PID', String(pid)], {
    windowsHide: true, stdio: 'ignore', timeout: timeoutMs,
  });
}

/**
 * Terminate one explicitly-owned process tree and verify the captured identities
 * disappear. POSIX children are dedicated process-group leaders. Windows uses
 * taskkill /T because npm -> cmd -> node creates a deeper shell topology.
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
  if (!Number.isInteger(pid) || pid <= 0) return { gone: true, survivors: [], ownedPids: [] };
  const owned = snapshotProcessTree(pid, { platform, spawnSyncImpl });
  const diagnostics = [];

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

  let survivors = await waitForExtinction(owned, gracefulMs, killImpl);
  if (survivors.length > 0) {
    try {
      if (platform === 'win32') {
        // Prefer the still-live root tree. If it exited before a stubborn child,
        // only target a captured PID whose creation identity still matches.
        const current = new Map(processRows(platform, spawnSyncImpl).map((row) => [row.pid, row]));
        const root = current.get(pid);
        if ((root && (!owned[0].identity || root.identity === owned[0].identity)) || current.size === 0) {
          taskkill(pid, true, spawnSyncImpl, Math.max(100, forceMs));
        } else {
          for (const entry of survivors) {
            const now = current.get(entry.pid);
            // If enumeration itself failed, the identity captured only one
            // grace window ago is the best bounded fallback available.
            if ((now && entry.identity && now.identity === entry.identity) || (current.size === 0 && entry.identity)) taskkill(entry.pid, true, spawnSyncImpl, Math.max(100, forceMs));
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
    try { child.kill?.('SIGKILL'); } catch {}
    survivors = await waitForExtinction(survivors, forceMs, killImpl);
  }

  return {
    gone: survivors.length === 0,
    survivors: survivors.map((entry) => entry.pid),
    ownedPids: owned.map((entry) => entry.pid),
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
} = {}) {
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
    try { termination = Promise.resolve(killTree(child)); }
    catch (error) { termination = Promise.reject(error); }
    return termination;
  };
  const onAbort = () => { void terminate('abort'); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0 && !terminationStarted) timer = setTimeout(() => { void terminate('timeout'); }, timeoutMs);

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
