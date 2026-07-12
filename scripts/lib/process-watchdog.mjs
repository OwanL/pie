import { spawnSync } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import process from 'node:process';

export const DEFAULT_CHILD_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const CHILD_PROCESS_TIMEOUT_ENV = 'PIE_TEST_PROCESS_TIMEOUT_MS';

/** Resolve the per-child test/typecheck watchdog. `0` explicitly disables it. */
export function resolveChildProcessTimeoutMs(raw = process.env[CHILD_PROCESS_TIMEOUT_ENV]) {
  if (raw === undefined || raw === '') return DEFAULT_CHILD_PROCESS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CHILD_PROCESS_TIMEOUT_MS;
  return parsed;
}

/**
 * Spawn options required for recursive process-group termination on Unix.
 * Windows uses `taskkill /T`, so it must not rely on Node's shallow kill.
 */
export function withProcessTreeIsolation(options, platform = process.platform) {
  return {
    ...options,
    detached: platform !== 'win32',
  };
}

/** Kill the child and all descendants. Safe to call more than once. */
export function killProcessTree(
  child,
  {
    platform = process.platform,
    spawnSyncImpl = spawnSync,
    killImpl = process.kill,
  } = {},
) {
  const pid = child?.pid;
  if (!pid) return;

  try {
    if (platform === 'win32') {
      spawnSyncImpl('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10_000,
      });
    } else {
      // Test children are spawned detached, making the child the leader of a
      // dedicated process group. A negative pid terminates every descendant.
      killImpl(-pid, 'SIGKILL');
    }
  } catch {
    // The group may already have exited between the watchdog and this call.
  }

  // Fallback/direct-root cleanup. On Windows taskkill handles descendants; on
  // Unix this covers callers that accidentally omitted detached process groups.
  try {
    child.kill?.('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Attach a bounded timeout and optional parent AbortSignal to a spawned child.
 * Timeout and abort use the same full-tree termination path. The returned state
 * is read by close handlers so killed children cannot be mistaken for success.
 */
export function watchChildProcess(
  child,
  {
    timeoutMs = resolveChildProcessTimeoutMs(),
    signal,
    label = 'child process',
    killTree = killProcessTree,
    onTerminate,
  } = {},
) {
  let timedOut = false;
  let aborted = false;
  let terminationStarted = false;
  let timer;

  const terminate = (reason) => {
    if (terminationStarted) return;
    terminationStarted = true;
    timedOut = reason === 'timeout';
    aborted = reason === 'abort';
    try {
      onTerminate?.({ reason, label, timeoutMs });
    } catch {
      // Diagnostics must never prevent process-tree termination.
    }
    killTree(child);
  };

  const onAbort = () => terminate('abort');
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  if (timeoutMs > 0 && !terminationStarted) {
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
  }

  return {
    get timedOut() {
      return timedOut;
    },
    get aborted() {
      return aborted;
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Abort all active child watchdogs when the runner receives Ctrl+C/termination. */
export function abortOnProcessSignals(target = process, platform = process.platform) {
  const controller = new AbortController();
  // The full runner intentionally attaches one listener per concurrently active
  // package (currently more than Node's default of 10). They are removed on
  // child settlement, so raise the limit for this short-lived shared signal
  // rather than emitting a false-positive MaxListenersExceededWarning.
  setMaxListeners(0, controller.signal);
  const handlers = new Map();
  const events = platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
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
